import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDelta,
  decodeRecord,
  encodeRecord,
  fromLegacyFile,
  parseIndexLine,
  planDelta,
  shouldPersist,
  toIndexLine,
  toMeta,
  withParsedBodies,
} from '../../../src/host/persistence/codec.js'
import { makeRecord } from '../fixtures.js'

const history = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(40) }))
const requestOf = (messages: unknown[]) => JSON.stringify({ model: 'm', system: 'You are helpful.', messages, tools: [{ name: 'read', description: 'x'.repeat(500) }], stream: true })

// -- shouldPersist --

test('shouldPersist: keeps model calls and any request with a body', () => {
  assert.equal(shouldPersist(makeRecord()), true)
  assert.equal(shouldPersist(makeRecord({ attributed: false })), true)
  // Attributed calls are kept even without a body.
  assert.equal(shouldPersist(makeRecord({ request: { ...makeRecord().request, method: 'GET', bodyText: '', bodyChars: 0 } })), true)
})

test('shouldPersist: drops bodiless housekeeping requests made outside any model call (e.g. GET /models polls)', () => {
  const poll = makeRecord({
    attributed: false,
    sessionId: null,
    request: { ...makeRecord().request, method: 'GET', url: 'https://api.deepseek.com/models', bodyText: '', bodyChars: 0 },
  })
  assert.equal(shouldPersist(poll), false)
})

// -- delta --

test('planDelta: a request that appends to the history is stored as a small middle', () => {
  const base = requestOf(history(30))
  const next = requestOf(history(32))
  const delta = planDelta(next, base)
  assert.ok(delta !== null)
  assert.ok(delta!.middle.length < next.length / 10, `middle ${delta!.middle.length} of ${next.length}`)
  assert.equal(applyDelta(base, delta!), next)
})

test('planDelta: declines short bodies and bodies that share less than half', () => {
  assert.equal(planDelta('{"a":1}', '{"a":2}'), null)
  const a = 'x'.repeat(10000)
  const b = 'y'.repeat(10000)
  assert.equal(planDelta(b, a), null)
  assert.equal(planDelta(a, ''), null)
})

test('planDelta/applyDelta: exact for identical, shrinking, and edited-in-the-middle bodies', () => {
  const base = requestOf(history(20))
  for (const text of [base, requestOf(history(19)), base.replace('message 7 ', 'MESSAGE 7 ')]) {
    const delta = planDelta(text, base)
    assert.ok(delta !== null)
    assert.equal(applyDelta(base, delta!), text)
  }
})

test('applyDelta: rebuilds a body whose shared prefix ends inside a surrogate pair', () => {
  const pad = 'p'.repeat(5000)
  const base = pad + '\u{1F600}' + pad
  const text = pad + '\u{1F601}' + pad
  const delta = planDelta(text, base)
  assert.ok(delta !== null)
  // Survives the JSON round trip the payload takes.
  const stored = JSON.parse(JSON.stringify(delta))
  assert.equal(applyDelta(base, stored), text)
})

test('applyDelta: refuses a delta that does not fit its base or rebuilds the wrong length', () => {
  assert.throws(() => applyDelta('short', { prefix: 4, suffix: 4, middle: '', length: 8 }))
  assert.throws(() => applyDelta('abcdef', { prefix: 2, suffix: 2, middle: 'X', length: 99 }))
})

// -- payload --

test('encodeRecord/decodeRecord: round-trips every wire field exactly, without bodyJson', () => {
  const record = makeRecord({ recorderError: 'mirror failed' })
  const { record: restored, delta } = decodeRecord(encodeRecord(record))
  assert.equal(delta, null)
  assert.equal(restored.persisted, true)
  assert.equal(restored.request.bodyText, record.request.bodyText)
  assert.deepEqual(restored.request.headers, record.request.headers)
  assert.equal(restored.response!.bodyText, record.response!.bodyText)
  assert.equal(restored.request.bodyJson, null)
  assert.equal(restored.response!.bodyJson, null)
  assert.equal(restored.recorderError, 'mirror failed')
  for (const key of ['id', 'startedAt', 'endedAt', 'durationMs', 'status', 'model', 'sessionId', 'turn', 'step', 'purpose', 'provider', 'requestedModel', 'attributed', 'error'] as const) {
    assert.deepEqual(restored[key], record[key], key)
  }
  assert.ok(!('v' in restored))
})

test('encodeRecord: a delta replaces the request body; decodeRecord hands it back with an empty body', () => {
  const record = makeRecord()
  const delta = { base: 'b1', prefix: 1, suffix: 1, middle: 'x', length: 3 }
  const json = encodeRecord(record, delta)
  assert.ok(!json.includes(JSON.stringify(record.request.bodyText)))
  const decoded = decodeRecord(json)
  assert.deepEqual(decoded.delta, delta)
  assert.equal(decoded.record.request.bodyText, '')
})

test('encodeRecord: a record without a response stores null and drops an absent recorderError', () => {
  const { record } = decodeRecord(encodeRecord(makeRecord({ response: null })))
  assert.equal(record.response, null)
  assert.ok(!('recorderError' in record))
})

// -- index lines --

test('toIndexLine/parseIndexLine: one line, no bodies or headers, location preserved', () => {
  const record = makeRecord()
  const line = toIndexLine(record, { offset: 10, length: 20, base: 'b1' })
  assert.ok(line.endsWith('\n'))
  assert.equal(line.indexOf('\n'), line.length - 1)
  assert.ok(!line.includes('bodyText') && !line.includes('headers'))
  const parsed = parseIndexLine(line)!
  assert.deepEqual(parsed.location, { offset: 10, length: 20, base: 'b1' })
  assert.equal(parsed.meta.id, record.id)
  assert.equal(parsed.meta.meta, true)
  assert.equal(parsed.meta.request.bodyChars, record.request.bodyChars)
  assert.equal(parsed.meta.response!.status, 200)
})

test('parseIndexLine: a line without a base has base null', () => {
  assert.equal(parseIndexLine(toIndexLine(makeRecord(), { offset: 0, length: 5, base: null }))!.location.base, null)
})

test('parseIndexLine: torn, blank, or invalid lines are skipped, never thrown', () => {
  assert.equal(parseIndexLine(''), null)
  assert.equal(parseIndexLine('{"id":"x","o":0'), null)
  assert.equal(parseIndexLine('{"id":"x"}'), null)
  assert.equal(parseIndexLine('{"id":"","o":0,"n":1}'), null)
  assert.equal(parseIndexLine('{"id":"x","o":-1,"n":1}'), null)
  assert.equal(parseIndexLine('{"id":"x","o":0,"n":0}'), null)
  assert.equal(parseIndexLine('null'), null)
})

test('toMeta: never touches bodyText/bodyJson, both come out null; a missing response stays null', () => {
  const meta = toMeta(makeRecord())
  assert.equal(meta.request.bodyText, null)
  assert.equal(meta.response!.bodyJson, null)
  assert.equal(meta.persisted, true)
  assert.equal(toMeta({ id: 'r1', request: { method: 'GET', url: 'https://x' }, response: null }).response, null)
})

// -- hydration --

test('withParsedBodies: parses both bodies, but never an SSE response as one JSON value', () => {
  const parse = (text: string | null) => (text ? JSON.parse(text) : null)
  const plain = withParsedBodies(makeRecord(), parse)
  assert.deepEqual(plain.request.bodyJson, { model: 'test-model' })
  assert.deepEqual(plain.response!.bodyJson, { ok: true })
  const sse = withParsedBodies(makeRecord({ response: { ...makeRecord().response!, contentType: 'text/event-stream', bodyText: 'data: {}\n\n' } }), parse)
  assert.equal(sse.response!.bodyJson, null)
})

// -- legacy import --

test('fromLegacyFile: converts a version-1 record file, dropping the readability copy', () => {
  const legacy = { v: 1, ...makeRecord(), request: { ...makeRecord().request, bodyJson: { stale: true } } }
  const record = fromLegacyFile(JSON.parse(JSON.stringify(legacy)))!
  assert.equal(record.id, legacy.id)
  assert.equal(record.request.bodyText, legacy.request.bodyText)
  assert.equal(record.request.bodyJson, null)
  assert.equal(record.response!.bodyText, legacy.response!.bodyText)
  assert.ok(!('v' in record))
})

test('fromLegacyFile: rejects documents that are not records', () => {
  assert.equal(fromLegacyFile(null), null)
  assert.equal(fromLegacyFile({}), null)
  assert.equal(fromLegacyFile({ id: 'x' }), null)
})
