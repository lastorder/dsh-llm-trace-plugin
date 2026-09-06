/**
 * HTTP route handlers for the `/llm-wire-trace` prefix: list, stats, get,
 * curl, clear. Kept separate from the store so the store stays free of any
 * Node `http` concerns.
 *
 * @module dsh-llm-trace-plugin/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildCurl, resolveRealApiKey, type CredentialProvider } from './curl.js'
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

export interface RouteDeps {
  store: WireTraceStore
  routePrefix: string
  getCredentials(): CredentialProvider | undefined
}

/**
 * Build the `webServer.register` prefix handler for every `llm-wire-trace`
 * route: `list`, `stats`, `get`, `curl`, `clear`.
 */
export function createRouteHandler(deps: RouteDeps) {
  const { store, routePrefix, getCredentials } = deps

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
        const body = await readJsonBody(req)
        sendJson(res, 200, await store.clear({ keepPersisted: body.keepPersisted === true }))
        return
      }
      sendJson(res, 404, { error: `unknown llm-wire-trace method "${method}"` })
    } catch (error: any) {
      sendJson(res, 500, { error: String((error && error.message) || error) })
    }
  }
}
