/**
 * The `globalThis.fetch` patch: provider calls are recorded; every other call
 * passes through completely untouched — same arguments, same return value,
 * same thrown errors.
 *
 * "Provider call" is decided by TWO independent signals, and either one is
 * sufficient:
 *
 *   - the outgoing `user-agent` starts with `deepseek-harness/`, the value
 *     `attributionHeaders()` stamps on every harness-issued provider request;
 *   - the request is issued inside an active `llm/stream` call, i.e.
 *     `callContext.getStore()` is bound (see call-context.ts).
 *
 * The second signal exists because the user-agent is not something this plugin
 * can rely on a third-party provider plugin leaving alone. A provider that
 * builds its own agent identity rewrites the header at the fetch layer — the
 * only layer it still controls once the harness has merged its own attribution
 * in — and a provider that reaches the wire from inside a model call is by
 * construction provider traffic whatever it calls itself. A request issued
 * inside such a call is therefore recorded even when nothing about its headers
 * says "harness".
 *
 * This ONLY works as an installed package. A dynamic Cordis Host package runs
 * its code inside an isolated `node:vm` realm whose `globalThis` is not the
 * process's real `globalThis`, and whose `fetch` is hard-wired to a throwing
 * redirect trap — so a dynamic package cannot reach, let alone patch, the real
 * fetch that `@deepseek-ai/dsh-llm-deepseek` and `@deepseek-ai/dsh-llm-pi-ai`
 * resolve at call time. Both of those adapters call the bare `fetch`
 * identifier with no local import, so they read whatever `globalThis.fetch`
 * resolves to at the moment of the call.
 *
 * That "at the moment of the call" is exactly what a provider plugin can opt
 * out of, by snapshotting `globalThis.fetch` at module-evaluation time and
 * injecting the copy into its SDK. Such a provider is invisible here no matter
 * how this patch is written — the requests never enter this function at all —
 * which is why `coverage.ts` counts model calls that produced no captured
 * request, and `index.ts` warns about them instead of leaving a silently empty
 * trace. See the README's "Known limitation" section.
 *
 * @module dsh-llm-trace-plugin/host/fetch-patch
 */

import { USER_AGENT_PREFIX, SESSION_HEADER } from './constants.js'
import { clip, describeRequest, outgoingUserAgent, redactedHeaders, tryParseJson } from './http-utils.js'
import { callContext } from './call-context.js'
import { buildRecordName } from './persistence/naming.js'
import type { WireRecord } from '../shared/record-shape.js'

// TEMP-DIAGNOSE begin — remove before committing.
type DiagSink = (line: string) => void
let diagSink: DiagSink | null = null
let diagSeen = 0
export function setFetchPatchDiagnostics(sink: DiagSink | null): void {
  diagSink = sink
}
let lastPatched: unknown = null
export function isFetchPatchActive(): boolean {
  return lastPatched !== null && globalThis.fetch === lastPatched
}
function diag(line: string): void {
  if (diagSink === null || diagSeen > 1000) return
  diagSeen += 1
  try {
    diagSink(line)
  } catch {
    // never let the diagnostic disturb the request path
  }
}
// TEMP-DIAGNOSE end

export interface FetchPatchDeps {
  maxBodyChars: number
  push(record: WireRecord): void
  finalize(record: WireRecord): void
}

/**
 * The call's own request signal, whichever fetch calling form carries it.
 *
 * Both forms have one: `fetch(url, init)` puts it on `init`, `fetch(new
 * Request(url, init))` on the Request itself (`init` overriding it, as the
 * fetch spec says). A provider adapter aborts that signal the moment it stops
 * reading the response — `dsh-llm-deepseek`'s `generate()` aborts its consumer
 * controller in a `finally` — so "the signal is aborted" is how a streamed
 * provider call normally ends, not an error. See `mirrorBody`.
 */
export function requestSignal(input: unknown, init: RequestInit | undefined): AbortSignal | null {
  const fromInit = init === undefined || init === null ? undefined : init.signal
  if (fromInit) return fromInit
  const candidate = input as { signal?: AbortSignal } | null | undefined
  if (candidate === null || candidate === undefined || typeof candidate !== 'object') return null
  const signal = candidate.signal
  return signal === undefined || signal === null ? null : signal
}

/**
 * Mirror a cloned response body into a record's body fields.
 *
 * Read through a reader and accumulate as chunks arrive, instead of awaiting
 * `mirror.text()`.
 *
 * `text()` is all-or-nothing: it buffers every chunk internally and resolves
 * only once the mirrored stream CLOSES. A terminal stream error therefore
 * throws away the entire body — including chunks that had already been read.
 * That is not a corner case here, it is the normal path: the adapter aborts
 * the request signal as soon as it is done with the stream, the abort errors
 * the mirror branch, and a provider SSE socket routinely outlives the last
 * event the adapter consumed. Every streamed provider call was consequently
 * recorded with `bodyText: ''` and `recorderError: 'mirror read failed: This
 * operation was aborted'` — 349 of 349 captured `text/event-stream` responses,
 * while all 19 non-streaming ones were fine.
 *
 * Accumulating per chunk keeps every byte the mirror actually delivered, which
 * is what this plugin exists to store. A terminal failure on a request the
 * caller has itself aborted is then the ordinary end of a streamed call rather
 * than a recorder failure; anything else that ends the read early is still
 * reported on the record, alongside the prefix that did arrive.
 *
 * `chars` counts the WHOLE body even when `text` is clipped, matching `clip()`
 * on a fully read body, so `bodyChars` keeps meaning "how big was the body".
 */
async function mirrorBody(
  mirror: Response,
  response: Response,
  record: WireRecord,
  signal: AbortSignal | null,
  maxBodyChars: number,
): Promise<void> {
  let text = ''
  let chars = 0
  const keep = (piece: string) => {
    if (piece.length === 0) return
    chars += piece.length
    const room = maxBodyChars - text.length
    if (room > 0) text += piece.length <= room ? piece : piece.slice(0, room)
  }
  try {
    if (mirror.body !== null) {
      const reader = mirror.body.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) keep(decoder.decode(value, { stream: true }))
      }
      // Flush a trailing multi-byte sequence the same way `text()` would.
      keep(decoder.decode())
    }
  } catch (error: any) {
    // Everything read before the failure is still a verbatim prefix of the
    // wire body; the body fields below are written from it either way.
    //
    // Read the signal HERE, not when the mirror was started: the adapter
    // aborts it at the end of the call, which is exactly what surfaces as the
    // terminal read error this catch sees. The error's own NAME is
    // deliberately not consulted — the same teardown arrives as an
    // `AbortError` when undici's abort path raises it and as
    // `TypeError: terminated` when the socket is destroyed underneath it, and
    // both mean "the caller stopped reading this response". A read that dies
    // while the call is still live is the genuine failure this field reports.
    if (signal === null || !signal.aborted) {
      record.recorderError = 'mirror read failed: ' + String((error && error.message) || error)
    }
  }
  if (record.response !== null) {
    record.response.bodyText = text
    record.response.bodyChars = chars
    record.response.bodyTruncated = chars > text.length
  }
  record.status = response.ok ? 'ok' : 'http-error'
}

/**
 * Wrap the real `fetch` so only provider calls are recorded.
 * @param real - the fetch implementation to wrap.
 * @param deps - the store operations the patch feeds records into.
 */
export function wrapFetch(real: typeof fetch, deps: FetchPatchDeps): typeof fetch {
  const { maxBodyChars, push, finalize } = deps
  return async function patchedFetch(input: any, init?: any): Promise<Response> {
    // Harness identity of the call this fetch belongs to. Present for every
    // call made through `ctx.llm`; absent for anything else, which is then
    // honestly recorded as unattributed rather than guessed at.
    //
    // Read BEFORE the admission test, because it IS half of that test: a
    // request issued inside a model call is provider traffic even when its
    // headers carry another agent's identity (see this module's doc).
    const call = callContext.getStore() ?? null
    const ua = outgoingUserAgent(input, init)
    // TEMP-DIAGNOSE begin
    {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as any)?.url ?? String(input)
      let host = '?'
      try {
        host = new URL(raw).host
      } catch {
        // keep '?'
      }
      const admitted = call !== null || ua.startsWith(USER_AGENT_PREFIX)
      diag(`fetch ${admitted ? 'ADMIT ' : 'reject'} host=${host} inCall=${call !== null} ua=${String(ua).slice(0, 28)}`)
    }
    // TEMP-DIAGNOSE end
    if (call === null && !ua.startsWith(USER_AGENT_PREFIX)) return real(input, init)

    const info = describeRequest(input, init)
    const bodyClip = clip(info.bodyText || '', maxBodyChars)
    // ONE parse of the request body, and only to read `model` off it — which
    // is the one field a list row needs and the wire URL cannot supply.
    //
    // This used to happen twice per call (once for `model`, once to store
    // `request.bodyJson`), synchronously, in front of every model call. With
    // `maxBodyChars` sized for a 1M-token context that is two multi-megabyte
    // `JSON.parse` runs on the event loop the web UI shares.
    //
    // The parsed value is deliberately NOT kept: see `bodyJson` below.
    const requestJson = tryParseJson(info.bodyText)
    const headerSessionId = info.headers[SESSION_HEADER] ?? null
    const startedAt = Date.now()
    const record: WireRecord = {
      // Globally unique and chronologically sortable, because it doubles as
      // the storage file name. A per-process counter (`w1`, `w2`, ...) would
      // make two harness processes collide on the same file and silently
      // overwrite each other's records.
      id: buildRecordName(startedAt).slice(0, -'.json'.length),
      startedAt,
      endedAt: null,
      durationMs: null,
      status: 'streaming',
      model: (requestJson as any)?.model ?? null,
      // Prefer the async-context session id (works for every provider,
      // including pi-ai) and fall back to the wire header.
      sessionId: (call && call.sessionId) ?? headerSessionId,
      // Harness coordinates that are NOT on the wire. `null` means "not
      // known", never "0" and never a carried-over previous value.
      turn: call && typeof call.turn === 'number' ? call.turn : null,
      step: call && typeof call.step === 'number' ? call.step : null,
      // Why this call was made: an ordinary conversation step, or a
      // background auxiliary call the user never asked for directly.
      purpose: (call && call.purpose) ?? null,
      // Harness-side route identity, which the wire URL alone cannot give.
      provider: (call && call.provider) ?? null,
      requestedModel: (call && call.model) ?? null,
      // True when this call came through `ctx.llm` at all — the difference
      // between "we know it had no turn" and "we know nothing about it".
      attributed: call !== null,
      request: {
        method: info.method,
        url: info.url,
        headers: info.headers,
        bodyText: bodyClip.text,
        bodyChars: bodyClip.chars,
        bodyTruncated: bodyClip.truncated,
        // Left null ON PURPOSE, and hydrated on read by `store.get()`.
        //
        // A parsed body is several times the size of its source text, and the
        // ring holds up to `maxRecords` of them — so storing it here meant the
        // process could sit on gigabytes that nothing on the list path ever
        // reads (`summarizeRecord` touches no body field) and that the
        // persistence codec re-derives from `bodyText` anyway.
        //
        // `bodyText` is the single source of truth; see the note on
        // `WireRecord.bodyJson`. The archive path already worked exactly this
        // way (`fromPersisted`), so live and restored records stay identical
        // to every consumer.
        bodyJson: null,
      },
      response: null,
      error: null,
    }
    push(record)
    // Credit this request to the model call it belongs to, so a call that ends
    // with a zero receipt is provably one whose traffic never got here — the
    // signal `coverage.ts` reports and `index.ts` warns about. Counted on
    // ADMISSION, not on a successful response: a provider error still proves
    // the request reached the wire, which is what the receipt answers.
    if (call !== null) call.observation.requests += 1

    let response: Response
    try {
      response = await real(input, init)
    } catch (error: any) {
      record.status = 'transport-error'
      record.error = { name: String(error && error.name), message: String((error && error.message) || error) }
      finalize(record)
      throw error
    }

    record.response = {
      status: response.status,
      statusText: response.statusText,
      headers: redactedHeaders(response.headers),
      contentType: (response.headers && response.headers.get) ? response.headers.get('content-type') : null,
      bodyText: '',
      bodyChars: 0,
      bodyTruncated: false,
      bodyJson: null,
    }
    record.status = response.ok ? 'streaming' : 'http-error'

    // Mirror the body from a CLONE so the caller's own read of `response`
    // (SSE parsing, `.json()`, whatever) is never touched by this plugin.
    let mirror: Response
    try {
      mirror = response.clone()
    } catch (error: any) {
      record.recorderError = 'clone failed: ' + String((error && error.message) || error)
      finalize(record)
      return response
    }

    // Deliberately not awaited: capturing must never add latency or block
    // the response the adapter is about to consume.
    //
    // `bodyJson` stays null here for the same reason it does on the request:
    // it is derived on read from `bodyText`, never retained. That also removes
    // a full parse of every non-SSE response body from this path.
    const signal = requestSignal(input, init)
    void (async () => {
      try {
        await mirrorBody(mirror, response, record, signal, maxBodyChars)
      } finally {
        finalize(record)
      }
    })()

    return response
  }
}

/** Module-level guard so re-activating the plugin cannot double-wrap an already-patched fetch. */
const PATCH_MARK = Symbol.for('dsh-llm-trace-plugin/patched')

/**
 * Install the fetch patch on `globalThis`, returning a disposer that restores
 * the exact previous `fetch` reference. Idempotent: a second install while one
 * is already active throws loudly instead of silently double-wrapping.
 *
 * @param buildWrapped - given the real `fetch`, returns the wrapped replacement.
 */
export function installFetchPatch(buildWrapped: (real: typeof fetch) => typeof fetch): () => void {
  const marked = globalThis as unknown as Record<symbol, boolean>
  if (marked[PATCH_MARK]) {
    throw new Error('llm-wire-trace: fetch is already patched by another instance of this plugin')
  }
  const original = globalThis.fetch
  const patched = buildWrapped(original)
  globalThis.fetch = patched
  marked[PATCH_MARK] = true
  lastPatched = patched // TEMP-DIAGNOSE
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    delete marked[PATCH_MARK]
  }
}
