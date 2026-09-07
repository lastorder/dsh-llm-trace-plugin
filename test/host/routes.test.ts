import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouteHandler, isSameOriginRequest } from '../../src/host/routes.js'
import { fakePostRequest, fakeRequest, fakeResponse } from './fake-http.js'
import { makeRecord } from './fixtures.js'
import { ROUTE_PREFIX } from '../../src/host/constants.js'
import type { WireTraceStore } from '../../src/host/store.js'

function fakeStore(overrides: Partial<WireTraceStore> = {}): WireTraceStore {
  return {
    records: [],
    wrapFetch: (real) => real,
    list: () => ({ items: [], unattributed: 0, turns: [], auxiliary: 0, total: 0, matched: 0 }),
    listAll: async () => ({ items: [], unattributed: 0, turns: [], auxiliary: 0, total: 0, matched: 0, persistence: false, truncated: false, historyPending: false }),
    stats: async () => ({ persistence: false, memory: 0, coverage: { since: 0, providers: [] } }),
    get: async () => null,
    clear: async () => ({ removed: 0, removedFiles: 0 }),
    ...overrides,
  }
}


test('list: forwards limit/sessionId/source=memory to store.listAll', async () => {
  let seenOptions: any = null
  const store = fakeStore({
    listAll: async (options) => {
      seenOptions = options
      return { items: [], unattributed: 0, turns: [], auxiliary: 0, total: 0, matched: 0, persistence: false, truncated: false, historyPending: false }
    },
  })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/list?limit=25&sessionId=s1&source=memory`), res)
  assert.equal(captured.status, 200)
  assert.deepEqual(seenOptions, { limit: 25, sessionId: 's1', memoryOnly: true })
})

test('list: an absent sessionId degrades to the empty-string filter (no filter), not undefined', async () => {
  let seenOptions: any = null
  const store = fakeStore({
    listAll: async (options) => { seenOptions = options; return { items: [], unattributed: 0, turns: [], auxiliary: 0, total: 0, matched: 0, persistence: false, truncated: false, historyPending: false } },
  })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/list`), res)
  assert.equal(seenOptions.sessionId, '')
})

test('stats: returns store.stats() as-is', async () => {
  const store = fakeStore({ stats: async () => ({ persistence: true, memory: 3, coverage: { since: 0, providers: [] } }) })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/stats`), res)
  assert.equal(captured.status, 200)
  assert.deepEqual(captured.json(), { persistence: true, memory: 3, coverage: { since: 0, providers: [] } })
})

test('get: returns store.get(id) for the given id', async () => {
  const record = makeRecord({ id: 'r1' })
  const store = fakeStore({ get: async (id) => (id === 'r1' ? record : null) })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/get?id=r1`), res)
  assert.equal((captured.json() as any).id, 'r1')
})

test('curl: 404s with no such record when the id does not exist', async () => {
  const store = fakeStore({ get: async () => null })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/curl?id=nope`), res)
  assert.equal(captured.status, 404)
})

test('curl: reports auth.kind=env when no credential was resolved', async () => {
  delete process.env.DSH_CURL_KEY
  const record = makeRecord()
  const store = fakeStore({ get: async () => record })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/curl?id=${record.id}`), res)
  const body = captured.json() as any
  assert.equal(body.auth.kind, 'env')
  assert.ok(typeof body.command === 'string' && body.command.startsWith('curl '))
})

test('curl: reports auth.kind=value when DSH_CURL_KEY resolves a real credential', async () => {
  process.env.DSH_CURL_KEY = 'sk-test'
  try {
    const record = makeRecord()
    const store = fakeStore({ get: async () => record })
    const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
    const { res, captured } = fakeResponse()
    await handler(fakeRequest(`${ROUTE_PREFIX}/curl?id=${record.id}`), res)
    const body = captured.json() as any
    assert.equal(body.auth.kind, 'value')
  } finally {
    delete process.env.DSH_CURL_KEY
  }
})

test('clear: reads keepPersisted from the JSON body and forwards it', async () => {
  let seenOptions: any = null
  const store = fakeStore({ clear: async (options) => { seenOptions = options; return { removed: 1, removedFiles: 0 } } })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakePostRequest(`${ROUTE_PREFIX}/clear`, ['{"keepPersisted":true}']), res)
  assert.deepEqual(seenOptions, { keepPersisted: true })
  assert.deepEqual(captured.json(), { removed: 1, removedFiles: 0 })
})

test('clear: an empty body defaults keepPersisted to false', async () => {
  let seenOptions: any = null
  const store = fakeStore({ clear: async (options) => { seenOptions = options; return { removed: 0, removedFiles: 0 } } })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res } = fakeResponse()
  await handler(fakePostRequest(`${ROUTE_PREFIX}/clear`, []), res)
  assert.deepEqual(seenOptions, { keepPersisted: false })
})

// -- clear: method and origin guards --
//
// `clear` deletes every persisted record and this server has no auth, so a
// bare `GET /llm-wire-trace/clear` was a drive-by wipe: any page open in the
// user's browser could trigger it as a navigation or image load and never
// need to read the response.

test('clear: a GET is refused with 405 and never reaches the store', async () => {
  let called = false
  const store = fakeStore({ clear: async () => { called = true; return { removed: 0, removedFiles: 0 } } })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/clear`), res)
  assert.equal(captured.status, 405)
  assert.equal(captured.setHeaders.allow, 'POST')
  assert.equal(called, false, 'store.clear must not run for a GET')
})

test('clear: a cross-site POST is refused with 403 and never reaches the store', async () => {
  let called = false
  const store = fakeStore({ clear: async () => { called = true; return { removed: 0, removedFiles: 0 } } })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakePostRequest(`${ROUTE_PREFIX}/clear`, [], { 'sec-fetch-site': 'cross-site' }), res)
  assert.equal(captured.status, 403)
  assert.equal(called, false, 'store.clear must not run for a cross-site request')
})

test('clear: a same-origin POST from the viewer is allowed', async () => {
  const store = fakeStore({ clear: async () => ({ removed: 3, removedFiles: 2 }) })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakePostRequest(`${ROUTE_PREFIX}/clear`, [], { 'sec-fetch-site': 'same-origin' }), res)
  assert.equal(captured.status, 200)
  assert.deepEqual(captured.json(), { removed: 3, removedFiles: 2 })
})

test('clear: a POST with no Sec-Fetch-Site header is allowed, so curl and scripts keep working', async () => {
  // Fails OPEN deliberately: the header is browser-stamped and unforgeable, so
  // its absence means the caller is not a browser at all. Refusing those would
  // break legitimate scripted use for no security gain.
  const store = fakeStore({ clear: async () => ({ removed: 1, removedFiles: 1 }) })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakePostRequest(`${ROUTE_PREFIX}/clear`, []), res)
  assert.equal(captured.status, 200)
})

test('isSameOriginRequest: same-origin and none pass, cross-site and same-site do not', () => {
  assert.equal(isSameOriginRequest({ headers: {} }), true)
  assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-origin' } }), true)
  // `none` is a direct user navigation (address bar), not a page-driven request.
  assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'none' } }), true)
  assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isSameOriginRequest({ headers: { 'sec-fetch-site': 'same-site' } }), false)
})

test('read routes are unaffected by the mutating-route guards', async () => {
  // Only `clear` is guarded; a cross-origin read still cannot leak anything
  // because the browser blocks the response, and guarding reads would break
  // the viewer's own polling.
  const store = fakeStore()
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/stats`, [], { headers: { 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(captured.status, 200)
})

test('unknown method: 404s with a descriptive error', async () => {
  const store = fakeStore()
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/bogus`), res)
  assert.equal(captured.status, 404)
  assert.match((captured.json() as any).error, /bogus/)
})

test('a thrown store error becomes a 500 with its message, never an unhandled rejection', async () => {
  const store = fakeStore({ stats: async () => { throw new Error('disk exploded') } })
  const handler = createRouteHandler({ store, routePrefix: ROUTE_PREFIX, getCredentials: () => undefined })
  const { res, captured } = fakeResponse()
  await handler(fakeRequest(`${ROUTE_PREFIX}/stats`), res)
  assert.equal(captured.status, 500)
  assert.equal((captured.json() as any).error, 'disk exploded')
})
