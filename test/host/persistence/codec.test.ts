import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromPersisted, toMeta, toPersisted } from '../../../src/host/persistence/codec.js'
import { makeRecord } from '../fixtures.js'

test('toPersisted: writes a readability bodyJson copy alongside bodyText for a small parseable body', () => {
  const record = makeRecord()
  const persisted = toPersisted(record)
  assert.equal((persisted.request as any).bodyText, record.request.bodyText)
  assert.deepEqual((persisted.request as any).bodyJson, { model: 'test-model' })
})

test('toPersisted: omits bodyJson when the request body was truncated', () => {
  const record = makeRecord({
    request: { ...makeRecord().request, bodyText: '{"a":1}', bodyTruncated: true },
  })
  const persisted = toPersisted(record)
  assert.equal(Object.prototype.hasOwnProperty.call(persisted.request, 'bodyJson'), false)
})

test('toPersisted: omits bodyJson when the body exceeds the pretty-print limit', () => {
  const record = makeRecord({
    request: { ...makeRecord().request, bodyText: JSON.stringify({ a: 'x'.repeat(100) }) },
  })
  const persisted = toPersisted(record, 10)
  assert.equal(Object.prototype.hasOwnProperty.call(persisted.request, 'bodyJson'), false)
})

test('toPersisted: never parses an SSE response body as a whole, regardless of size', () => {
  const record = makeRecord({
    response: { ...makeRecord().response!, contentType: 'text/event-stream', bodyText: 'data: {"a":1}\n\n' },
  })
  const persisted = toPersisted(record)
  assert.equal(Object.prototype.hasOwnProperty.call(persisted.response, 'bodyJson'), false)
})

test('toPersisted: response is null when the record has none (e.g. a transport error)', () => {
  const record = makeRecord({ response: null, status: 'transport-error' })
  const persisted = toPersisted(record)
  assert.equal(persisted.response, null)
})

test('toPersisted: is a plain, JSON-serializable object (no live references leak through)', () => {
  const record = makeRecord()
  const persisted = toPersisted(record)
  assert.doesNotThrow(() => JSON.stringify(persisted))
})

test('fromPersisted: always re-derives bodyJson from bodyText via the supplied parser, ignoring any stored bodyJson', () => {
  const stored = {
    id: 'r1',
    request: { method: 'POST', url: 'https://x', bodyText: '{"real":true}', bodyJson: { stale: 'garbage' } },
    response: null,
  }
  const record = fromPersisted(stored, (text) => (text ? JSON.parse(text) : null))
  assert.deepEqual(record.request.bodyJson, { real: true })
})

test('fromPersisted: marks the record as persisted', () => {
  const stored = { id: 'r1', request: { bodyText: null }, response: null }
  const record = fromPersisted(stored, () => null)
  assert.equal(record.persisted, true)
})

test('fromPersisted: never parses an SSE response body as a whole even if a stored bodyJson exists', () => {
  const stored = {
    id: 'r1',
    request: { bodyText: null },
    response: { contentType: 'text/event-stream', bodyText: 'data: {"a":1}\n\n', bodyJson: { should: 'not-appear' } },
  }
  const record = fromPersisted(stored, (text) => (text ? JSON.parse(text) : null))
  assert.equal(record.response!.bodyJson, null)
})

test('fromPersisted: a null response stays null', () => {
  const stored = { id: 'r1', request: { bodyText: null }, response: null }
  const record = fromPersisted(stored, () => null)
  assert.equal(record.response, null)
})

test('toMeta: never touches bodyText/bodyJson, both come out null', () => {
  const stored = {
    id: 'r1',
    request: { method: 'POST', url: 'https://x', bodyText: '{"a":1}', bodyChars: 7, bodyJson: { a: 1 } },
    response: { status: 200, bodyText: '{"ok":true}', bodyChars: 11, bodyJson: { ok: true } },
  }
  const meta = toMeta(stored)
  assert.equal(meta.request.bodyText, null)
  assert.equal(meta.request.bodyJson, null)
  assert.equal(meta.response!.bodyText, null)
  assert.equal(meta.response!.bodyJson, null)
  // Scalar sizes are preserved: the list row still shows how big the body was.
  assert.equal(meta.request.bodyChars, 7)
  assert.equal(meta.response!.bodyChars, 11)
})

test('toMeta: omits headers entirely, the other bulky field a list row never shows', () => {
  // The narrow WireRecordMeta return type is what lets a consumer see, from
  // the type alone, that a list row cannot show a body or headers — instead of
  // discovering it as an unexpected null at runtime, which is what the old
  // `as unknown as WireRecord` cast hid.
  const meta = toMeta({
    id: 'r1',
    request: { method: 'POST', url: 'https://x', headers: { authorization: 'Bearer x' }, bodyChars: 7 },
    response: { status: 200, statusText: 'OK', contentType: 'application/json', bodyChars: 11 },
  })
  assert.equal(Object.prototype.hasOwnProperty.call(meta.request, 'headers'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(meta.response, 'headers'), false)
})

test('toMeta: a record with no response projects response as null, not a stub', () => {
  const meta = toMeta({ id: 'r1', request: { method: 'GET', url: 'https://x' }, response: null })
  assert.equal(meta.response, null)
})

test('toMeta: marks the record as both persisted and meta', () => {
  const stored = { id: 'r1', request: {}, response: null }
  const meta = toMeta(stored)
  assert.equal(meta.persisted, true)
  assert.equal((meta as any).meta, true)
})

test('toPersisted -> fromPersisted round-trips the wire-authoritative fields exactly', () => {
  const record = makeRecord()
  const persisted = toPersisted(record)
  const restored = fromPersisted(persisted, (text) => (text ? JSON.parse(text) : null))
  assert.equal(restored.id, record.id)
  assert.equal(restored.request.bodyText, record.request.bodyText)
  assert.deepEqual(restored.request.bodyJson, record.request.bodyJson)
  assert.equal(restored.response!.bodyText, record.response!.bodyText)
})
