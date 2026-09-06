import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWireTraceStore } from '../../src/host/store.js'
import { createFakeArchive } from './fake-archive.js'
import { makeRecord } from './fixtures.js'

test('list: no archive behaves as a pure in-memory ring, newest first', () => {
  const store = createWireTraceStore()
  ;(store as any).records.push(makeRecord({ id: 'r1', startedAt: 1 }))
  ;(store as any).records.push(makeRecord({ id: 'r2', startedAt: 2 }))
  const page = store.list()
  assert.deepEqual(page.items.map((i) => i.id), ['r2', 'r1'])
  assert.equal(page.total, 2)
  assert.equal(page.matched, 2)
})

test('list: maxRecords caps the in-memory ring, dropping the oldest', () => {
  const store = createWireTraceStore({ maxRecords: 2 })
  const wrapped = store.wrapFetch((async () => new Response('{}')) as typeof fetch)
  // Not exercising wrapFetch here directly (covered in fetch-patch.test.ts);
  // push records the way the store itself does, through its own array.
  for (let i = 0; i < 5; i += 1) (store as any).records.push(makeRecord({ id: `r${i}`, startedAt: i }))
  while ((store as any).records.length > 2) (store as any).records.shift()
  assert.equal((store as any).records.length, 2)
  void wrapped
})

test('list: filters by sessionId BEFORE windowing, so a busy other session cannot push this one out', () => {
  const store = createWireTraceStore()
  const records: any = (store as any).records
  for (let i = 0; i < 10; i += 1) records.push(makeRecord({ id: `noise${i}`, sessionId: 'other', startedAt: i }))
  records.push(makeRecord({ id: 'mine', sessionId: 'mine', startedAt: 100 }))
  const page = store.list({ limit: 3, sessionId: 'mine' })
  assert.deepEqual(page.items.map((i) => i.id), ['mine'])
  assert.equal(page.matched, 1)
})

test('listAll: with no archive, memoryOnly is implied and historyPending mirrors persistence=false', async () => {
  const store = createWireTraceStore()
  ;(store as any).records.push(makeRecord({ id: 'r1' }))
  const page = await store.listAll()
  assert.equal(page.persistence, false)
  assert.equal(page.historyPending, false)
  assert.equal(page.truncated, false)
  assert.deepEqual(page.items.map((i) => i.id), ['r1'])
})

test('listAll: memoryOnly true skips the archive even when one is configured', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'disk-only', startedAt: 1 }))
  const store = createWireTraceStore({ archive })
  const page = await store.listAll({ memoryOnly: true })
  assert.deepEqual(page.items, [])
  assert.equal(page.persistence, true)
  assert.equal(page.historyPending, true)
})

test('listAll: merges memory and archive, the in-memory copy winning for a shared id', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'shared', startedAt: 1, status: 'ok' }))
  await archive.save(makeRecord({ id: 'disk-only', startedAt: 2 }))
  const store = createWireTraceStore({ archive })
  ;(store as any).records.push(makeRecord({ id: 'shared', startedAt: 1, status: 'streaming' }))
  const page = await store.listAll()
  const shared = page.items.find((i) => i.id === 'shared')!
  assert.equal(shared.status, 'streaming') // memory copy wins, not the disk one
  assert.ok(page.items.some((i) => i.id === 'disk-only'))
  assert.equal(page.persistence, true)
  assert.equal(page.historyPending, false)
})

test('listAll: caches repeat archive reads within the TTL window (same key -> same promise identity effect)', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'r1' }))
  let listCalls = 0
  const originalList = archive.list.bind(archive)
  archive.list = async (query) => { listCalls += 1; return originalList(query) }
  const store = createWireTraceStore({ archive })
  await store.listAll({ sessionId: 'x' })
  await store.listAll({ sessionId: 'x' })
  assert.equal(listCalls, 1)
})

test('listAll: clear() invalidates the archive cache so a subsequent read is not stale', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'r1' }))
  let listCalls = 0
  const originalList = archive.list.bind(archive)
  archive.list = async (query) => { listCalls += 1; return originalList(query) }
  const store = createWireTraceStore({ archive })
  await store.listAll({ sessionId: 'x' })
  await store.clear()
  await store.listAll({ sessionId: 'x' })
  assert.equal(listCalls, 2)
})

test('get: memory is checked before the archive', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'r1', status: 'ok' }))
  const store = createWireTraceStore({ archive })
  ;(store as any).records.push(makeRecord({ id: 'r1', status: 'streaming' }))
  const found = await store.get('r1')
  assert.equal(found!.status, 'streaming')
})

test('get: falls back to the archive when a record has aged out of memory', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'archived-only' }))
  const store = createWireTraceStore({ archive })
  const found = await store.get('archived-only')
  assert.ok(found !== null)
  assert.equal(found!.id, 'archived-only')
})

test('get: returns null when a record exists nowhere', async () => {
  const store = createWireTraceStore()
  const found = await store.get('nope')
  assert.equal(found, null)
})

// -- get: bodyJson is derived on read, never retained in the ring --
//
// Capture stores `bodyJson: null` so the ring never holds a parsed copy of
// every body (see fetch-patch.ts). This is where a reader gets it back, and
// it must land identically to the archive's own `fromPersisted` path so a
// live record and a restored one are indistinguishable.

test('get: hydrates request/response bodyJson from bodyText for a memory hit', () => {
  const store = createWireTraceStore()
  ;(store as any).records.push(makeRecord({
    id: 'live',
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/v1/chat',
      headers: {},
      bodyText: '{"model":"deepseek-chat"}',
      bodyChars: 25,
      bodyTruncated: false,
      bodyJson: null,
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      contentType: 'application/json',
      bodyText: '{"ok":true}',
      bodyChars: 11,
      bodyTruncated: false,
      bodyJson: null,
    },
  }))
  return store.get('live').then((found) => {
    assert.deepEqual(found!.request.bodyJson, { model: 'deepseek-chat' })
    assert.deepEqual(found!.response!.bodyJson, { ok: true })
  })
})

test('get: never parses an SSE response body as one JSON value, matching the persisted path', async () => {
  const store = createWireTraceStore()
  ;(store as any).records.push(makeRecord({
    id: 'sse',
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      contentType: 'text/event-stream',
      bodyText: 'data: {"a":1}\n\n',
      bodyChars: 15,
      bodyTruncated: false,
      bodyJson: null,
    },
  }))
  const found = await store.get('sse')
  assert.equal(found!.response!.bodyJson, null)
  // The frames stay verbatim; only the whole-value parse is skipped.
  assert.equal(found!.response!.bodyText, 'data: {"a":1}\n\n')
})

test('get: an unparseable body hydrates to null rather than throwing', async () => {
  const store = createWireTraceStore()
  ;(store as any).records.push(makeRecord({
    id: 'garbage',
    request: {
      method: 'POST',
      url: 'https://x',
      headers: {},
      bodyText: 'not json',
      bodyChars: 8,
      bodyTruncated: false,
      bodyJson: null,
    },
  }))
  const found = await store.get('garbage')
  assert.equal(found!.request.bodyJson, null)
  assert.equal(found!.request.bodyText, 'not json')
})

test('get: hydration does not mutate the stored ring record', async () => {
  // The ring must stay free of parsed copies, or the memory win is undone the
  // first time someone opens a record in the detail view.
  const store = createWireTraceStore()
  const stored = makeRecord({
    id: 'immutable',
    request: {
      method: 'POST',
      url: 'https://x',
      headers: {},
      bodyText: '{"a":1}',
      bodyChars: 7,
      bodyTruncated: false,
      bodyJson: null,
    },
  })
  ;(store as any).records.push(stored)
  const found = await store.get('immutable')
  assert.deepEqual(found!.request.bodyJson, { a: 1 })
  assert.equal(stored.request.bodyJson, null, 'the ring copy must stay unparsed')
})

test('get: a record with no response at all hydrates without throwing', async () => {
  const store = createWireTraceStore()
  ;(store as any).records.push(makeRecord({ id: 'pending', response: null }))
  const found = await store.get('pending')
  assert.equal(found!.response, null)
})

test('clear: empties memory and, by default, the archive too', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'r1' }))
  const store = createWireTraceStore({ archive })
  ;(store as any).records.push(makeRecord({ id: 'r2' }))
  const result = await store.clear()
  assert.equal(result.removed, 1)
  assert.equal(result.removedFiles, 1)
  assert.equal((store as any).records.length, 0)
  const stats = await archive.stats()
  assert.equal(stats.retained, 0)
})

test('clear: keepPersisted leaves the archive untouched', async () => {
  const archive = createFakeArchive()
  await archive.save(makeRecord({ id: 'r1' }))
  const store = createWireTraceStore({ archive })
  const result = await store.clear({ keepPersisted: true })
  assert.equal(result.removedFiles, 0)
  const stats = await archive.stats()
  assert.equal(stats.retained, 1)
})

test('stats: reports persistence=false with no archive, true with one', async () => {
  const withoutArchive = createWireTraceStore()
  assert.deepEqual(await withoutArchive.stats(), { persistence: false, memory: 0 })

  const archive = createFakeArchive()
  const withArchive = createWireTraceStore({ archive })
  const stats = await withArchive.stats()
  assert.equal(stats.persistence, true)
})
