/**
 * @deepseek-ai/dsh LLM wire trace plugin — host half.
 *
 * Captures the literal HTTP request and response every LLM provider call
 * makes, by patching the process-global `fetch`. This observes a lower layer
 * than a harness-level tracer would: instead of the normalized
 * `GenerateOptions` / `StreamChunk` objects the harness builds
 * (provider-neutral, session/turn aware), it observes the actual bytes on the
 * wire (provider-native JSON field names, raw SSE frames), with no harness
 * concepts at all.
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

/** Marks every provider request via dsh-llm's attributionHeaders(); see APP_IDENTITY.product. */
const USER_AGENT_PREFIX = 'deepseek-harness/'

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
  const records = []
  let seq = 0

  function push(record) {
    records.push(record)
    while (records.length > maxRecords) records.shift()
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

      seq += 1
      const info = describeRequest(input, init)
      const bodyClip = clip(info.bodyText || '', maxBodyChars)
      const record = {
        id: `w${seq}`,
        startedAt: Date.now(),
        endedAt: null,
        durationMs: null,
        status: 'streaming',
        model: (tryParseJson(info.bodyText) || {}).model ?? null,
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
        record.endedAt = Date.now()
        record.durationMs = record.endedAt - record.startedAt
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
        record.endedAt = Date.now()
        record.durationMs = record.endedAt - record.startedAt
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
          record.endedAt = Date.now()
          record.durationMs = record.endedAt - record.startedAt
        }
      })()

      return response
    }
  }

  return {
    records,
    wrapFetch,
    list(limit) {
      const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, 1000) : 300
      const page = records.slice(Math.max(0, records.length - cap))
      const items = []
      for (let i = page.length - 1; i >= 0; i -= 1) items.push(summary(page[i]))
      return { items, total: records.length }
    },
    get(id) {
      for (let i = records.length - 1; i >= 0; i -= 1) if (records[i].id === id) return records[i]
      return null
    },
    clear() {
      const removed = records.length
      records.length = 0
      return { removed }
    },
  }
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
 * @param {{ maxRecords?: number, maxBodyChars?: number, routePrefix?: string }} [config]
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const routePrefix = typeof settings.routePrefix === 'string' ? settings.routePrefix : '/llm-wire-trace'
  const store = createWireTraceStore(settings)

  ctx.effect(() => installFetchPatch(store), 'llm-wire-trace: fetch patch')

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
            sendJson(res, 200, store.list(Number.isFinite(limitRaw) ? limitRaw : undefined))
            return
          }
          if (method === 'get') {
            sendJson(res, 200, store.get(url.searchParams.get('id') ?? ''))
            return
          }
          if (method === 'curl') {
            const record = store.get(url.searchParams.get('id') ?? '')
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
            await readJsonBody(req)
            sendJson(res, 200, store.clear())
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
