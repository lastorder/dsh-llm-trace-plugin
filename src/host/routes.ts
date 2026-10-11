/**
 * HTTP route handlers for the `/llm-wire-trace` prefix: list, stats, get,
 * curl, clear, config. Kept separate from the store so the store stays free
 * of any Node `http` concerns.
 *
 * @module dsh-llm-trace-plugin/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildCurl, resolveRealApiKey, type CredentialProvider } from './curl.js'
import { CONFIG_FIELDS } from './config.js'
import type { WireTraceStore } from './store.js'

async function readJsonBody(req: IncomingMessage, limit = 262144): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim().length === 0 ? {} : JSON.parse(text)
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Whether a mutating request may proceed, judged by `Sec-Fetch-Site`.
 *
 * `clear` deletes every persisted record (or, scoped, one session's), and
 * `config` rewrites this plugin's own profile configuration — this server
 * listens on localhost with no authentication, so any page the user happens
 * to have open could otherwise trigger either with a single cross-origin
 * request. The browser stamps `Sec-Fetch-Site` itself and a page cannot forge
 * it, which makes it the right signal here.
 *
 * Absent header means the caller is NOT a modern browser (curl, a script, a
 * test), so this fails OPEN: the threat being closed is specifically the
 * drive-by browser request, and refusing every non-browser client would break
 * legitimate scripted use for no security gain.
 */
export function isSameOriginRequest(req: Pick<IncomingMessage, 'headers'>): boolean {
  const site = req.headers['sec-fetch-site']
  if (site === undefined) return true
  const value = Array.isArray(site) ? site[0] : site
  return value === 'same-origin' || value === 'none'
}

/**
 * Opaque identity of the Loader entry this plugin's `apply()` run belongs to.
 * Never inspected, only ever handed back to {@link ConfigEditorLike.edit} —
 * see `PluginContext.fiber` in `index.ts` for where it comes from.
 */
export type LoaderEntryLike = object

/**
 * Structural shape of Cordis's `configEditor` service this plugin needs:
 * "persist complete raw configs and apply them through the normal Loader
 * path". Declared locally (not imported) for the same reason `PluginContext`
 * is: this package carries no host-runtime Cordis dependency.
 */
export interface ConfigEditorLike {
  entries(): readonly LoaderEntryLike[]
  edit(
    entry: LoaderEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

export interface RouteDeps {
  store: WireTraceStore
  routePrefix: string
  getCredentials(): CredentialProvider | undefined
  /** The resolved (defaulted) config currently in effect, for `GET config`'s `values`. */
  currentConfig(): Record<string, unknown>
  /** Validates a prospective merged config; throws with a readable message when invalid. */
  schema(data: unknown): unknown
  /** The profile-config writer service, when the host exposes one. */
  getConfigEditor(): ConfigEditorLike | undefined
  /** This plugin's own Loader entry, when the host exposes one. */
  getSelfEntry(): LoaderEntryLike | undefined
}

/**
 * Build the `webServer.register` prefix handler for every `llm-wire-trace`
 * route: `list`, `stats`, `get`, `curl`, `clear`, `config`.
 */
export function createRouteHandler(deps: RouteDeps) {
  const { store, routePrefix, getCredentials, currentConfig, schema, getConfigEditor, getSelfEntry } = deps

  /** Whether a live, persisted config write is actually possible right now. */
  function editable(): boolean {
    return getConfigEditor() !== undefined && getSelfEntry() !== undefined
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = url.pathname.slice(routePrefix.length).replace(/^\//, '')
    try {
      if (method === 'list') {
        const limitRaw = Number(url.searchParams.get('limit'))
        // An absent or empty `sessionId` means "no filter", so a client
        // that has no session id yet degrades to the full list rather
        // than silently matching nothing.
        const sessionId = url.searchParams.get('sessionId') ?? ''
        // `source=memory` is the viewer's fast path: the in-memory ring
        // only, reading no files at all. The tab uses it to paint
        // immediately and to poll, so neither opening the tab nor
        // watching it live costs a disk scan on the shared event loop.
        const memoryOnly = url.searchParams.get('source') === 'memory'
        // Memory and disk as one page: where a record is stored is an
        // implementation detail the viewer should never have to expose.
        sendJson(res, 200, await store.listAll({
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          sessionId,
          memoryOnly,
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
        const credentials = getCredentials()
        const resolved = await resolveRealApiKey(record.request.url, credentials)
        sendJson(res, 200, {
          command: buildCurl(record, resolved),
          // 'value': a real key was inlined (from DSH_CURL_KEY or a known
          // provider's own credential); 'env': nothing was found, the
          // command references $DSH_CURL_KEY and needs that exported first.
          auth: resolved !== undefined ? { kind: 'value' } : { kind: 'env', envName: 'DSH_CURL_KEY' },
        })
        return
      }
      if (method === 'clear') {
        // Destructive, so it is POST-only and same-origin-only. A bare
        // `GET /llm-wire-trace/clear` used to delete every persisted record,
        // which any cross-origin page could trigger as a plain navigation or
        // image load without ever reading the response.
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { error: 'clear requires POST' })
          return
        }
        if (!isSameOriginRequest(req)) {
          sendJson(res, 403, { error: 'clear requires a same-origin request' })
          return
        }
        const body = await readJsonBody(req)
        // An absent/empty sessionId clears everything (the management page's
        // "clear all history" button); a non-empty one scopes the clear to
        // that session only (the Wire Trace tab's own "Clear" button).
        const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0
          ? body.sessionId
          : undefined
        sendJson(res, 200, await store.clear({ keepPersisted: body.keepPersisted === true, sessionId }))
        return
      }
      if (method === 'config') {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            editable: editable(),
            values: currentConfig(),
            fields: CONFIG_FIELDS,
          })
          return
        }
        // Rewriting this plugin's own profile config is just as destructive
        // to its own settings as `clear` is to its records, and the same
        // drive-by cross-origin risk applies.
        if (req.method !== 'POST') {
          res.setHeader('allow', 'GET, POST')
          sendJson(res, 405, { error: 'config writes require POST' })
          return
        }
        if (!isSameOriginRequest(req)) {
          sendJson(res, 403, { error: 'config writes require a same-origin request' })
          return
        }
        const editor = getConfigEditor()
        const entry = getSelfEntry()
        if (editor === undefined || entry === undefined) {
          sendJson(res, 409, { error: 'live config editing is unavailable in this environment; edit cordis.patch.yml\'s config: block instead' })
          return
        }
        const patch = await readJsonBody(req)
        const unknownKeys = Object.keys(patch).filter((key) => !(CONFIG_FIELDS as readonly string[]).includes(key))
        if (unknownKeys.length > 0) {
          sendJson(res, 400, { error: `unknown config field(s): ${unknownKeys.join(', ')}` })
          return
        }
        try {
          await editor.edit(entry, (current) => {
            const next: Record<string, unknown> = { ...current }
            for (const key of CONFIG_FIELDS) {
              if (!Object.hasOwn(patch, key)) continue
              const value = (patch as Record<string, unknown>)[key]
              if (value === null) delete next[key]
              else next[key] = value
            }
            // Validate the WHOLE merged config, not just the patched fields:
            // a field's bounds can depend on nothing else here today, but
            // re-validating the full object is what keeps that true even if
            // a future field adds a cross-field constraint.
            schema(next)
            return next
          })
        } catch (error: any) {
          sendJson(res, 400, { error: String((error && error.message) || error) })
          return
        }
        // Not `currentConfig()` here: a successful edit can hot-reload the
        // whole plugin (a fresh `apply()` run replaces this very route
        // table), so THIS closure's captured config may already be stale by
        // the time `edit()` resolves. The client re-reads with `GET config`
        // for the values actually now in effect.
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: `unknown llm-wire-trace method "${method}"` })
    } catch (error: any) {
      sendJson(res, 500, { error: String((error && error.message) || error) })
    }
  }
}
