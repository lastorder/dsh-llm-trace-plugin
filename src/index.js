/**
 * @deepseek-ai/dsh LLM wire trace plugin — host half.
 *
 * Captures the literal HTTP request and response every LLM provider call
 * makes, by patching the process-global `fetch`. This observes a lower layer
 * than a harness-level tracer would: instead of the normalized
 * `GenerateOptions` / `StreamChunk` objects the harness builds
 * (provider-neutral, session/turn aware), it observes the actual bytes on the
 * wire (provider-native JSON field names, raw SSE frames).
 *
 * Those bytes carry almost no harness identity — `dsh-llm-deepseek` puts the
 * session id on the wire and nothing else, and `dsh-llm-pi-ai` puts nothing at
 * all. So the harness coordinates a reader actually wants (which turn? which
 * step? was this a real conversation call or a background title generation?)
 * are ATTACHED here rather than read off the wire, by observing two harness
 * channels and binding them to the exact call in flight:
 *
 *   - `llm/stream` — the waterfall around every model call. Its `options`
 *     carries `sessionId`, `provider`, `model`, and `purpose`. The listener
 *     pulls the inner stream inside an `AsyncLocalStorage.run`, ON EVERY PULL,
 *     so the adapter's `fetch` — which happens on the first pull — observes
 *     exactly the context of its own call. Wrapping only the construction of
 *     the iterable would NOT work: an async generator's body runs on the
 *     consumer's tick, so the context would be gone by the time the body ran.
 *   - `session/event` — `step/start` / `step/end` / `turn/start` / `turn/end`
 *     give the current turn and step per session. The loop appends
 *     `step/start` before the model call and `step/end` after it, so the
 *     step in force when a call begins is that call's step.
 *
 * The binding is exact, not a time-window guess: concurrent calls (a live turn
 * plus a background `session-title` request on the SAME session) each see
 * their own context, because each rides its own async-context branch. A call
 * that reaches the wire with no such context — anything not made through
 * `ctx.llm` — is recorded with null coordinates and reported as unattributed,
 * never assigned a plausible-looking owner.
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
 * @module dsh-llm-trace-plugin
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { buildRecordName, createRecordArchive } from './persistence.js'

/** Marks every provider request via dsh-llm's attributionHeaders(); see APP_IDENTITY.product. */
const USER_AGENT_PREFIX = 'deepseek-harness/'

/**
 * Request header `dsh-llm-deepseek` stamps with the harness SessionId of the
 * request's owning session — the ONLY harness identity that reaches the wire.
 *
 * It remains a useful fallback, but it is no longer the primary source: the
 * `llm/stream` listener supplies the session id (plus turn, step, provider,
 * model, and purpose) for every call made through `ctx.llm`, including
 * `dsh-llm-pi-ai` calls, which put nothing on the wire at all. This header is
 * read only when that context is absent.
 */
const SESSION_HEADER = 'x-deepseek-harness-session-id'

/**
 * Async-context channel carrying the harness identity of the model call
 * currently in flight, so the patched `fetch` can stamp a wire record with
 * coordinates that never appear on the wire itself. Written by the
 * `llm/stream` listener, read by `wrapFetch`. Empty for any request not made
 * through `ctx.llm`.
 */
const callContext = new AsyncLocalStorage()

/**
 * Track the live turn/step of every session by following the loop's own
 * boundary events.
 *
 * The loop appends `step/start` immediately before a model call and `step/end`
 * immediately after it (`dsh-agent-loop`), so a call that begins while a step
 * is open belongs to that step. Between steps — and during auxiliary calls
 * made outside any turn — the session has no open step, and this reports null
 * rather than the most recently seen one: "the last step we saw" is exactly
 * the kind of plausible-looking wrong answer this plugin must never give.
 *
 * @returns {{ observe: (sessionId: string, event: object) => void, current: (sessionId: string) => { turn: number | null, step: number | null }, forget: (sessionId: string) => void, size: () => number }}
 */
export function createStepTracker() {
  /** sessionId -> the currently OPEN coordinates (never a stale, closed one). */
  const open = new Map()
  const at = (sessionId) => open.get(sessionId) ?? { turn: null, step: null }

  return {
    observe(sessionId, event) {
      if (typeof sessionId !== 'string') return
      if (event === null || typeof event !== 'object') return
      const data = event.data ?? {}
      switch (event.type) {
        case 'turn/start':
          open.set(sessionId, { turn: data.turn ?? null, step: null })
          break
        case 'step/start':
          open.set(sessionId, { turn: data.turn ?? null, step: data.step ?? null })
          break
        case 'step/end':
          // Keep the still-open turn, drop the closed step, so a call landing
          // between two steps is not misattributed to the one that just ended.
          open.set(sessionId, { turn: at(sessionId).turn, step: null })
          break
        case 'turn/end':
          open.delete(sessionId)
          break
        default:
          break
      }
    },
    current(sessionId) {
      return at(sessionId)
    },
    forget(sessionId) {
      open.delete(sessionId)
    },
    size() {
      return open.size
    },
  }
}

const DEFAULT_MAX_RECORDS = 200
const DEFAULT_MAX_BODY_CHARS = 200000

/**
 * Clip a string to a character budget, reporting whether it was cut.
 * @param {string} text - candidate text.
 * @param {number} max - character cap.
 * @returns {{ text: string, chars: number, truncated: boolean }}
 */
function clip(text, max) {
  if (text.length <= max) return { text, chars: text.length, truncated: false }
  return { text: text.slice(0, max), chars: text.length, truncated: true }
}

/**
 * Normalize a Headers-like value (Headers instance, plain object, or entry
 * array) into a plain lowercase-keyed object, redacting `authorization`.
 * @param {unknown} headers - the header container to read.
 * @returns {Record<string, string>} owned, redacted header map.
 */
function redactedHeaders(headers) {
  const out = {}
  const set = (key, value) => {
    const k = String(key).toLowerCase()
    out[k] = k === 'authorization' ? 'Bearer ***redacted***' : String(value)
  }
  if (headers === null || headers === undefined) return out
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => set(key, value))
    return out
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) if (Array.isArray(entry) && entry.length === 2) set(entry[0], entry[1])
    return out
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) set(key, headers[key])
    return out
  }
  return out
}

/**
 * Read the outgoing user-agent from a fetch call's normalized headers, or
 * from a `Request` instance when the caller passed one instead of a plain init.
 * @param {unknown} input - the fetch `input` argument.
 * @param {unknown} init - the fetch `init` argument.
 * @returns {string} the user-agent value, or an empty string when absent.
 */
function outgoingUserAgent(input, init) {
  const fromInit = init && init.headers ? redactedHeaders(init.headers)['user-agent'] : undefined
  if (typeof fromInit === 'string') return fromInit
  if (input !== null && typeof input === 'object' && typeof input.headers !== 'undefined') {
    const fromRequest = redactedHeaders(input.headers)['user-agent']
    if (typeof fromRequest === 'string') return fromRequest
  }
  return ''
}

/**
 * Extract method, URL, and body text from a fetch call, supporting both the
 * `fetch(url, init)` and `fetch(new Request(url, init))` calling forms.
 * @param {unknown} input - the fetch `input` argument.
 * @param {unknown} init - the fetch `init` argument.
 * @returns {{ method: string, url: string, headers: Record<string,string>, bodyText: string | null }}
 */
function describeRequest(input, init) {
  const isRequestLike = input !== null && typeof input === 'object' && typeof input.url === 'string'
  const url = isRequestLike ? input.url : String(input)
  const method = (init && init.method) || (isRequestLike ? input.method : undefined) || 'GET'
  const headers = redactedHeaders((init && init.headers) || (isRequestLike ? input.headers : undefined))
  let bodyText = null
  const body = init ? init.body : undefined
  if (typeof body === 'string') bodyText = body
  // Request-object bodies and streamed/binary bodies are deliberately left
  // unread here: reading them would consume the only copy. Both shipped
  // adapters pass a JSON string body directly, which is the case this
  // plugin exists to capture.
  return { method: String(method), url, headers, bodyText }
}

/**
 * Best-effort JSON parse for display; never throws.
 * @param {string | null} text - candidate JSON text.
 * @returns {unknown} the parsed value, or `null` on any failure.
 */
function tryParseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Create the record store and the fetch wrapper that feeds it. Kept
 * dependency-free so it can be unit-tested against a fake `fetch`.
 * @param {{ maxRecords?: number, maxBodyChars?: number }} [options]
 * @returns {{ records: object[], wrapFetch: (real: typeof fetch) => typeof fetch }}
 */
export function createWireTraceStore(options) {
  const maxRecords = (options && options.maxRecords) || DEFAULT_MAX_RECORDS
  const maxBodyChars = (options && options.maxBodyChars) || DEFAULT_MAX_BODY_CHARS
  // Optional durable half. When absent the store behaves exactly as before:
  // an in-memory ring that dies with the process.
  const archive = (options && options.archive) || null
  const records = []

  function push(record) {
    records.push(record)
    while (records.length > maxRecords) records.shift()
  }

  /**
   * Stamp a record's end time and hand it to the archive.
   *
   * Persistence happens ONCE, here, at the record's final state — never at
   * push time. A record is mutated after it is pushed (the response body is
   * mirrored asynchronously), so writing on push would persist a record whose
   * body is still empty, and the file-per-record layout deliberately has no
   * rewrite step that could later fix it up.
   *
   * Never awaited by the caller: capturing must not add latency to a model
   * call, and a failing disk must not fail a request.
   *
   * @param {object} record - the record to close out.
   */
  function finalize(record) {
    record.endedAt = Date.now()
    record.durationMs = record.endedAt - record.startedAt
    if (archive !== null) void archive.save(record)
  }

  /**
   * Apply the session filter and page window to the in-memory ring.
   *
   * The filter runs BEFORE the window, not after: windowing first would let a
   * busy neighbouring session's traffic push this session's records out of
   * the page, so a quiet session could show an empty list while its records
   * were still held in the store.
   *
   * @param {{ limit?: number, sessionId?: string }} settings
   * @returns {{ page: object[], matched: number }} `page` is oldest-first.
   */
  function collectMemory(settings) {
    const wanted = typeof settings.sessionId === 'string' && settings.sessionId.length > 0
      ? settings.sessionId
      : null
    const matching = wanted === null ? records : records.filter((record) => record.sessionId === wanted)
    const cap = capacity(settings.limit)
    return { page: matching.slice(Math.max(0, matching.length - cap)), matched: matching.length }
  }

  function summary(record) {
    return {
      id: record.id,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      status: record.status,
      method: record.request.method,
      url: record.request.url,
      model: record.model,
      sessionId: record.sessionId,
      turn: record.turn,
      step: record.step,
      purpose: record.purpose,
      provider: record.provider,
      attributed: record.attributed,
      responseStatus: record.response ? record.response.status : null,
      requestChars: record.request.bodyChars,
      responseChars: record.response ? record.response.bodyChars : 0,
    }
  }

  /**
   * Wrap the real `fetch` so only provider calls (identified by the
   * `deepseek-harness/` user-agent every adapter sends) are recorded; every
   * other call passes through completely untouched — same arguments, same
   * return value, same thrown errors.
   * @param {typeof fetch} real - the fetch implementation to wrap.
   * @returns {typeof fetch} the wrapped fetch.
   */
  function wrapFetch(real) {
    return async function patchedFetch(input, init) {
      const ua = outgoingUserAgent(input, init)
      if (!ua.startsWith(USER_AGENT_PREFIX)) return real(input, init)

      const info = describeRequest(input, init)
      const bodyClip = clip(info.bodyText || '', maxBodyChars)
      // Harness identity of the call this fetch belongs to. Present for every
      // call made through `ctx.llm`; absent for anything else, which is then
      // honestly recorded as unattributed rather than guessed at.
      const call = callContext.getStore() ?? null
      const headerSessionId = info.headers[SESSION_HEADER] ?? null
      const startedAt = Date.now()
      const record = {
        // Globally unique and chronologically sortable, because it doubles as
        // the storage file name. A per-process counter (`w1`, `w2`, ...) would
        // make two harness processes collide on the same file and silently
        // overwrite each other's records.
        id: buildRecordName(startedAt).slice(0, -'.json'.length),
        startedAt,
        endedAt: null,
        durationMs: null,
        status: 'streaming',
        model: (tryParseJson(info.bodyText) || {}).model ?? null,
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
          bodyJson: tryParseJson(info.bodyText),
        },
        response: null,
        error: null,
      }
      push(record)

      let response
      try {
        response = await real(input, init)
      } catch (error) {
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
      let mirror
      try {
        mirror = response.clone()
      } catch (error) {
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
          record.response.bodyText = bodyClipResp.text
          record.response.bodyChars = bodyClipResp.chars
          record.response.bodyTruncated = bodyClipResp.truncated
          if (!record.response.contentType || !record.response.contentType.includes('event-stream')) {
            record.response.bodyJson = tryParseJson(text)
          }
          record.status = response.ok ? 'ok' : 'http-error'
        } catch (error) {
          record.recorderError = 'mirror read failed: ' + String((error && error.message) || error)
          record.status = response.ok ? 'ok' : 'http-error'
        } finally {
          finalize(record)
        }
      })()

      return response
    }
  }

  return {
    records,
    wrapFetch,
    /**
     * List record summaries, newest first, optionally narrowed to one session.
     *
     * The filter is applied BEFORE the `limit` window, not after: windowing
     * first would let a busy neighbouring session's traffic push this
     * session's records out of the page, so a quiet session could show an
     * empty list while its records were still held in the store.
     *
     * @param {{ limit?: number, sessionId?: string }} [options]
     * @returns {{ items: object[], total: number, matched: number, unattributed: number }}
     *   `total` is every record held; `matched` is how many passed the filter
     *   (equal to `total` when unfiltered); `unattributed` counts records that
     *   reached the wire with no session identity, so the caller can report
     *   them instead of letting them vanish silently behind the filter.
     */
    list(options) {
      const settings = typeof options === 'number' ? { limit: options } : (options ?? {})
      const memory = collectMemory(settings)
      const grouped = summarizePage(memory.page, summary)
      return { ...grouped, total: records.length, matched: memory.matched }
    },
    /**
     * List records from memory AND disk as one seamless page, newest first.
     *
     * Where a record happens to be stored is an implementation detail, not
     * something a reader should have to think about — so this merges the two
     * rather than exposing them as separate views. Memory supplies liveness
     * (in-flight `streaming` records that no final file exists for yet); disk
     * supplies depth (everything older than the small in-memory ring, and
     * everything from before the last restart).
     *
     * A record near the head exists in BOTH, so the two are keyed by id and
     * the in-memory copy wins: it is the same record, but it is the one still
     * being mutated as its response body streams in.
     *
     * @param {{ limit?: number, sessionId?: string }} [options]
     */
    async listAll(options) {
      const settings = options ?? {}
      const memory = collectMemory(settings)

      if (archive === null) {
        const grouped = summarizePage(memory.page, summary)
        return { ...grouped, total: records.length, matched: memory.matched, persistence: false, truncated: false }
      }

      const page = await archive.list({
        limit: settings.limit,
        sessionId: settings.sessionId,
        parseJson: tryParseJson,
      })

      // Disk first so the live copy of a shared id overwrites the stored one.
      const merged = new Map()
      for (const record of page.records) merged.set(record.id, record)
      for (const record of memory.page) merged.set(record.id, record)

      // Chronological, oldest first — the order summarizePage expects.
      const ordered = [...merged.values()].sort((a, b) => a.startedAt - b.startedAt)
      const cap = capacity(settings.limit)
      const windowed = ordered.slice(Math.max(0, ordered.length - cap))

      const grouped = summarizePage(windowed, summary)
      return {
        ...grouped,
        // Disk holds every record that memory does, so its count is the total.
        total: Math.max(page.total, records.length),
        matched: merged.size,
        persistence: true,
        truncated: page.truncated,
      }
    },

    async stats() {
      if (archive === null) return { persistence: false, memory: records.length }
      return { persistence: true, memory: records.length, ...(await archive.stats()) }
    },

    /**
     * Look up one record: memory first, then disk. The disk fallback is what
     * makes a restored row's detail view, and its curl command, keep working
     * after the record has aged out of the ring.
     */
    async get(id) {
      for (let i = records.length - 1; i >= 0; i -= 1) if (records[i].id === id) return records[i]
      if (archive === null) return null
      return archive.get(id, tryParseJson)
    },

    /**
     * Clear memory, and by default the persisted copies too — otherwise
     * "clear" would visibly un-clear itself on the next restart.
     * @param {{ keepPersisted?: boolean }} [options]
     */
    async clear(options) {
      const removed = records.length
      records.length = 0
      let removedFiles = 0
      if (archive !== null && !(options && options.keepPersisted)) {
        removedFiles = await archive.clear()
      }
      return { removed, removedFiles }
    },
  }
}

/**
 * Page size for a list request, clamped so one call cannot ask for the world.
 * @param {number | undefined} limit - requested size.
 */
function capacity(limit) {
  return typeof limit === 'number' && limit > 0 ? Math.min(limit, 1000) : 300
}

/**
 * Group an oldest-first page of records into the viewer's list payload.
 *
 * Shared by the in-memory and on-disk list paths so both label turns, count
 * auxiliary calls, and report unattributed records by exactly the same rules.
 *
 * @param {object[]} page - records, oldest first.
 * @param {(record: object) => object} summarize - record-to-summary mapper.
 */
function summarizePage(page, summarize) {
  const items = []
  for (let i = page.length - 1; i >= 0; i -= 1) items.push(summarize(page[i]))

  let unattributed = 0
  for (const record of page) if (record.sessionId === null) unattributed += 1

  const turnMap = new Map()
  let auxiliary = 0
  for (const record of page) {
    if (record.turn === null) {
      if (record.purpose !== null) auxiliary += 1
      continue
    }
    const entry = turnMap.get(record.turn) ?? { turn: record.turn, calls: 0, steps: new Set() }
    entry.calls += 1
    if (record.step !== null) entry.steps.add(record.step)
    turnMap.set(record.turn, entry)
  }
  const turns = [...turnMap.values()]
    .sort((a, b) => b.turn - a.turn)
    .map((entry) => ({ turn: entry.turn, calls: entry.calls, steps: entry.steps.size }))

  return { items, unattributed, turns, auxiliary }
}

/** Module-level guard so re-activating the plugin cannot double-wrap an already-patched fetch. */
const PATCH_MARK = Symbol.for('dsh-llm-trace-plugin/patched')

/**
 * Install the fetch patch on `globalThis`, returning a disposer that restores
 * the exact previous `fetch` reference. Idempotent: a second install while one
 * is already active throws loudly instead of silently double-wrapping.
 * @param {ReturnType<typeof createWireTraceStore>} store
 * @returns {() => void} disposer.
 */
function installFetchPatch(store) {
  if (globalThis[PATCH_MARK]) {
    throw new Error('llm-wire-trace: fetch is already patched by another instance of this plugin')
  }
  const original = globalThis.fetch
  const patched = store.wrapFetch(original)
  globalThis.fetch = patched
  globalThis[PATCH_MARK] = true
  return () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    delete globalThis[PATCH_MARK]
  }
}

async function readJsonBody(req, limit = 262144) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim().length === 0 ? {} : JSON.parse(text)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Single-quote one shell argument, POSIX-safe (bash/zsh/sh): close the quote,
 * emit an escaped literal quote, reopen — the standard `'\''` trick. Handles
 * embedded quotes and newlines without any character being interpreted.
 * @param {string} value - literal value to embed.
 * @returns {string} a shell-safe single-quoted token.
 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Headers never worth putting on an explicit `-H` line: curl derives
 * content-length itself, and host-hop-by-hop fields don't belong on a replay.
 */
const CURL_SKIP_HEADERS = new Set(['content-length', 'host', 'connection'])

/**
 * Plugin-owned, provider-neutral override: export this once and every copied
 * curl command references it, whatever provider or host the record is for.
 * Deliberately not named after any one provider's own key — a wire record can
 * be a self-hosted gateway, `pi-ai`'s fully user-configured routes, or
 * anything else this plugin has no fixed mapping for, and the point of this
 * variable is to work identically in every one of those cases.
 */
const CURL_OVERRIDE_ENV = 'DSH_CURL_KEY'

/**
 * Known fixed provider endpoints this plugin can map to the conventional
 * credential env-var name their shipped adapter defaults to, purely as an
 * automatic convenience when that provider's own key is already configured.
 * Anything else (self-hosted gateways, pi-ai's fully user-configured routes)
 * has no entry here — correlating a wire record back to whichever `apiKeyEnv`
 * a user's settings configured for it isn't reliable from the URL alone, so
 * this stays a narrow, explicit allowlist rather than a guess. Those hosts
 * still get the universal `DSH_CURL_KEY` override below.
 */
const KNOWN_HOST_CREDENTIAL_ENV = new Map([
  ['api.deepseek.com', 'DEEPSEEK_API_KEY'],
])

/**
 * Resolve the real credential value for one request's host, checking two
 * independent sources and preferring the more explicit one:
 *
 * 1. `DSH_CURL_KEY` in the process environment — a manual, provider-neutral
 *    override that works for ANY host, including ones this plugin has no
 *    fixed mapping for. Checked first so an explicit override always wins.
 * 2. The host's known provider credential (`ctx.credentials` first, so a
 *    stored/UI-configured key is honored, then the plain environment
 *    variable) — the same two layers `dsh-llm-deepseek`'s own `resolveApiKey`
 *    checks — only when the host is in {@link KNOWN_HOST_CREDENTIAL_ENV}.
 *
 * The curl command always references `$DSH_CURL_KEY` when no value was found
 * by either path (never a provider-specific name the user may not recognize
 * or that may not even be the variable their own settings actually use), so
 * exporting that one variable and re-running the copied command works
 * regardless of which of these two paths would have supplied it.
 *
 * @param {string} url - the recorded request URL.
 * @param {import('@deepseek-ai/dsh-credentials').CredentialProvider | undefined} credentials
 * @returns {Promise<{ value: string } | undefined>} a real value, when found by either path.
 */
async function resolveRealApiKey(url, credentials) {
  const override = process.env[CURL_OVERRIDE_ENV]
  if (typeof override === 'string' && override.length > 0) return { value: override }

  let host
  try {
    host = new URL(url).host
  } catch {
    return undefined
  }
  const providerEnvName = KNOWN_HOST_CREDENTIAL_ENV.get(host)
  if (providerEnvName === undefined) return undefined
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve(providerEnvName)
      if (hit !== undefined && hit.value.length > 0) return { value: hit.value }
    } catch {
      // fall through to the ambient environment
    }
  }
  const ambient = process.env[providerEnvName]
  if (typeof ambient === 'string' && ambient.length > 0) return { value: ambient }
  return undefined
}

/**
 * Double-quote one shell argument, escaping only the characters double quotes
 * still give special meaning to (`\`, `"`, `` ` ``, `$`). Unlike {@link shQuote}
 * this permits `$VAR`-style expansion to survive inside the result — which is
 * the point: {@link buildCurl} uses it only for the one header line that must
 * let a real environment variable expand at run time, building the literal
 * text through this escaper and splicing in the variable reference itself
 * unescaped (env var names are safe, argument-free identifiers by construction).
 * @param {string} value - literal text to embed (not itself a `$VAR` reference).
 * @returns {string} the escaped literal, without surrounding quotes.
 */
function dqEscape(value) {
  return String(value).replace(/[\\"`$]/g, '\\$&')
}

/**
 * Render one wire-trace record as a runnable `curl` command.
 *
 * The stored `authorization` header is always the redacted placeholder (this
 * plugin never keeps a real secret at rest), so the header line is rebuilt
 * fresh here, one of two ways:
 *
 * - a real value was resolved (from `DSH_CURL_KEY` or a known provider's own
 *   credential): inline it directly, single-quoted like every other header —
 *   paste-and-run.
 * - nothing was found: render `"authorization: Bearer $DSH_CURL_KEY"` —
 *   double-quoted so the shell expands the variable at run time, and always
 *   this one plugin-owned name regardless of which provider or host the
 *   record is for, so `export DSH_CURL_KEY=...` then re-running the copied
 *   command needs no manual edit no matter what the record was.
 *
 * Never the literal `***redacted***` text, which would not even look like a
 * plausible key.
 *
 * @param {object} record - a full record as returned by `store.get`.
 * @param {{ value: string } | undefined} resolved - the credential lookup outcome.
 * @returns {string} a multi-line, shell-escaped curl command.
 */
function buildCurl(record, resolved) {
  const lines = [`curl ${shQuote(record.request.url)} \\`, `  -X ${shQuote(record.request.method)} \\`]
  for (const [key, value] of Object.entries(record.request.headers)) {
    if (CURL_SKIP_HEADERS.has(key)) continue
    if (key === 'authorization') {
      if (resolved !== undefined) {
        lines.push(`  -H ${shQuote(`authorization: Bearer ${resolved.value}`)} \\`)
      } else {
        lines.push(`  -H "${dqEscape(`authorization: Bearer `)}$${CURL_OVERRIDE_ENV}" \\`)
      }
      continue
    }
    lines.push(`  -H ${shQuote(`${key}: ${value}`)} \\`)
  }
  if (record.request.bodyText) {
    lines.push(`  --data-raw ${shQuote(record.request.bodyText)}`)
  } else {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '')
  }
  return lines.join('\n')
}

export const name = 'llm-trace-plugin'
export const inject = ['webServer']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ maxRecords?: number, maxBodyChars?: number, routePrefix?: string, persist?: boolean, traceDir?: string, maxPersistedRecords?: number, historyPageLimit?: number }} [config]
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const routePrefix = typeof settings.routePrefix === 'string' ? settings.routePrefix : '/llm-wire-trace'

  // Durable half. On by default — surviving a restart is the entire point —
  // but fully switchable off with `persist: false`, which returns the plugin
  // to a pure in-memory ring that writes nothing to disk.
  //
  // NOTE: request and response bodies are stored VERBATIM, so prompts, code,
  // and any file contents in context land in plaintext files under this
  // directory. That is inherent to persisting full bodies; `persist: false`
  // or a shorter `maxPersistedRecords` are the levers.
  const archive = settings.persist === false ? null : createRecordArchive({
    dir: settings.traceDir,
    maxRecords: settings.maxPersistedRecords,
    pageLimit: settings.historyPageLimit,
    onError: (error) => console.warn('llm-wire-trace: persistence error:', error.message),
  })

  const store = createWireTraceStore({ ...settings, archive })

  // Deliberately NOT loading disk records into the in-memory ring. The list
  // already merges memory and disk, so preloading would only duplicate what
  // the merge provides — and it was what made an earlier "live vs history"
  // toggle show identical content in both modes.
  if (archive !== null) {
    void archive.sweepTemp().catch(() => {})
  }

  ctx.effect(() => installFetchPatch(store), 'llm-wire-trace: fetch patch')

  // ------------------------------------------------------------------
  // Harness-coordinate correlation (turn / step / purpose / provider).
  //
  // Nothing here modifies dsh: both channels are ordinary, publicly
  // documented plugin extension points, and both are strictly observational.
  // The `llm/stream` listener is a waterfall member that MUST pass the stream
  // through untouched — it yields exactly the chunks it receives, in order,
  // and adds only an async-context binding around each pull.
  // ------------------------------------------------------------------

  const tracker = createStepTracker()

  // Follow turn/step boundaries. Optional service: with no `sessions` service
  // the plugin still records everything, just without turn/step coordinates.
  if (ctx.get('sessions') !== undefined) {
    ctx.on('session/event', (session, event) => {
      try {
        tracker.observe(String(session.id), event)
      } catch {
        // Observation must never destabilize the session feed.
      }
    })
    ctx.on('session/disposed', (session) => {
      try {
        tracker.forget(String(session.id))
      } catch {
        // ignore
      }
    })
  }

  // Bind each model call's identity to its own async-context branch.
  if (ctx.get('llm') !== undefined) {
    ctx.on('llm/stream', (options, next) => {
      const sessionId = options.sessionId === undefined ? null : String(options.sessionId)
      const purpose = options.purpose ?? null
      // Read the OPEN step at call time, not at chunk time: by the time later
      // chunks arrive the step may already have closed.
      //
      // A purposed call (background title generation, compaction) is NOT part
      // of the conversation loop even when it happens to overlap a live turn
      // on the same session, so it deliberately takes no turn/step. Letting it
      // inherit the ambient turn is precisely the misattribution this design
      // exists to avoid.
      const at = sessionId === null || purpose !== null
        ? { turn: null, step: null }
        : tracker.current(sessionId)
      const bound = {
        sessionId,
        turn: at.turn,
        step: at.step,
        purpose,
        provider: options.provider ?? null,
        model: options.model ?? null,
      }

      const inner = next()
      // Re-enter the context on EVERY pull. Wrapping only `next()` would bind
      // nothing useful: an async generator's body runs on the consumer's tick,
      // so the adapter's fetch — which happens on the first pull — would see
      // an empty context. Verified behaviour, not an assumption.
      return (async function* boundStream() {
        const iterator = inner[Symbol.asyncIterator]()
        try {
          while (true) {
            const result = await callContext.run(bound, () => iterator.next())
            if (result.done) return
            yield result.value
          }
        } finally {
          // Propagate early consumer termination to the wrapped stream, so
          // aborting a turn still tears the provider stream down.
          if (typeof iterator.return === 'function') {
            await callContext.run(bound, () => iterator.return(undefined))
          }
        }
      })()
    })
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: routePrefix,
      async handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const method = url.pathname.slice(routePrefix.length).replace(/^\//, '')
        try {
          if (method === 'list') {
            const limitRaw = Number(url.searchParams.get('limit'))
            // An absent or empty `sessionId` means "no filter", so a client
            // that has no session id yet degrades to the full list rather
            // than silently matching nothing.
            const sessionId = url.searchParams.get('sessionId') ?? ''
            // Memory and disk as one page: where a record is stored is an
            // implementation detail the viewer should never have to expose.
            sendJson(res, 200, await store.listAll({
              limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
              sessionId,
            }))
            return
          }
          if (method === 'stats') {
            sendJson(res, 200, await store.stats())
            return
          }
          if (method === 'get') {
            sendJson(res, 200, await store.get(url.searchParams.get('id') ?? ''))
            return
          }
          if (method === 'curl') {
            const record = await store.get(url.searchParams.get('id') ?? '')
            if (record === null) {
              sendJson(res, 404, { error: 'no such record' })
              return
            }
            const credentials = ctx.get('credentials')
            const resolved = await resolveRealApiKey(record.request.url, credentials)
            sendJson(res, 200, {
              command: buildCurl(record, resolved),
              // 'value': a real key was inlined (from DSH_CURL_KEY or a known
              // provider's own credential); 'env': nothing was found, the
              // command references $DSH_CURL_KEY and needs that exported first.
              auth: resolved !== undefined ? { kind: 'value' } : { kind: 'env', envName: CURL_OVERRIDE_ENV },
            })
            return
          }
          if (method === 'clear') {
            const body = await readJsonBody(req)
            sendJson(res, 200, await store.clear({ keepPersisted: body.keepPersisted === true }))
            return
          }
          sendJson(res, 404, { error: `unknown llm-wire-trace method "${method}"` })
        } catch (error) {
          sendJson(res, 500, { error: String((error && error.message) || error) })
        }
      },
    }),
  )

  console.log('llm-wire-trace: fetch patched, listening on /llm-wire-trace')
}
