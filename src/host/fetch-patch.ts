/**
 * The `globalThis.fetch` patch: only provider calls (identified by the
 * `deepseek-harness/` user-agent every adapter sends) are recorded; every
 * other call passes through completely untouched — same arguments, same
 * return value, same thrown errors.
 *
 * This ONLY works as an installed package. A dynamic Cordis Host package runs
 * its code inside an isolated `node:vm` realm whose `globalThis` is not the
 * process's real `globalThis`, and whose `fetch` is hard-wired to a throwing
 * redirect trap — so a dynamic package cannot reach, let alone patch, the real
 * fetch that `@deepseek-ai/dsh-llm-deepseek` and `@deepseek-ai/dsh-llm-pi-ai`
 * resolve at call time. Both of those adapters call the bare `fetch`
 * identifier with no local import, so they read whatever `globalThis.fetch`
 * resolves to at the moment of the call — which is exactly what makes patching
 * it here, in the real process realm, effective regardless of load order.
 *
 * @module dsh-llm-trace-plugin/host/fetch-patch
 */

import { USER_AGENT_PREFIX, SESSION_HEADER } from './constants.js'
import { clip, describeRequest, outgoingUserAgent, redactedHeaders, tryParseJson } from './http-utils.js'
import { callContext } from './call-context.js'
import { buildRecordName } from './persistence/naming.js'
import type { WireRecord } from '../shared/record-shape.js'

export interface FetchPatchDeps {
  maxBodyChars: number
  push(record: WireRecord): void
  finalize(record: WireRecord): void
}

/**
 * Wrap the real `fetch` so only provider calls are recorded.
 * @param real - the fetch implementation to wrap.
 * @param deps - the store operations the patch feeds records into.
 */
export function wrapFetch(real: typeof fetch, deps: FetchPatchDeps): typeof fetch {
  const { maxBodyChars, push, finalize } = deps
  return async function patchedFetch(input: any, init?: any): Promise<Response> {
    const ua = outgoingUserAgent(input, init)
    if (!ua.startsWith(USER_AGENT_PREFIX)) return real(input, init)

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
    // Harness identity of the call this fetch belongs to. Present for every
    // call made through `ctx.llm`; absent for anything else, which is then
    // honestly recorded as unattributed rather than guessed at.
    const call = callContext.getStore() ?? null
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
    ;(async () => {
      try {
        const text = await mirror.text()
        const bodyClipResp = clip(text, maxBodyChars)
        record.response!.bodyText = bodyClipResp.text
        record.response!.bodyChars = bodyClipResp.chars
        record.response!.bodyTruncated = bodyClipResp.truncated
        // `bodyJson` stays null here for the same reason it does on the
        // request: it is derived on read from `bodyText`, never retained.
        // That also removes a full parse of every non-SSE response body from
        // the mirroring path.
        record.status = response.ok ? 'ok' : 'http-error'
      } catch (error: any) {
        record.recorderError = 'mirror read failed: ' + String((error && error.message) || error)
        record.status = response.ok ? 'ok' : 'http-error'
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
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    delete marked[PATCH_MARK]
  }
}
