import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRecordName, idFromName, resolveTraceDir } from '../../../src/host/persistence/naming.js'

test('buildRecordName: matches the file-record regex shape (13-digit ms, 4-hex ordinal, 8-hex random)', () => {
  const name = buildRecordName(1700000000000)
  assert.match(name, /^\d{13}-[0-9a-f]{4}-[0-9a-f]{8}\.json$/)
})

test('buildRecordName: two calls at the same millisecond get an increasing intra-ms ordinal', () => {
  const first = buildRecordName(1700000000123)
  const second = buildRecordName(1700000000123)
  const firstOrdinal = first.split('-')[1]
  const secondOrdinal = second.split('-')[1]
  assert.ok(parseInt(secondOrdinal, 16) > parseInt(firstOrdinal, 16))
})

test('buildRecordName: a later millisecond resets the intra-ms ordinal to zero', () => {
  buildRecordName(1700000000200)
  buildRecordName(1700000000200)
  const nextMs = buildRecordName(1700000000201)
  assert.equal(nextMs.split('-')[1], '0000')
})

test('buildRecordName: names sort lexicographically in the same order as their timestamps', () => {
  const a = buildRecordName(1700000000300)
  const b = buildRecordName(1700000000400)
  assert.ok(a < b)
})

test('buildRecordName: a negative/fractional startedAt is floored and clamped to zero, never negative', () => {
  const name = buildRecordName(-5)
  assert.match(name, /^0000000000000-/)
})

test('idFromName: strips exactly the .json extension', () => {
  assert.equal(idFromName('1700000000000-0000-aaaaaaaa.json'), '1700000000000-0000-aaaaaaaa')
})

test('resolveTraceDir: an explicit directory always wins', () => {
  assert.equal(resolveTraceDir('/explicit/dir', { DSH_HOME: '/home' }), '/explicit/dir')
})

test('resolveTraceDir: falls back to $DSH_HOME/llm-wire-trace/records', () => {
  const dir = resolveTraceDir(undefined, { DSH_HOME: '/custom/home' })
  assert.equal(dir, '/custom/home/llm-wire-trace/records')
})

test('resolveTraceDir: falls back to homedir()/.dsh when DSH_HOME is unset', () => {
  const dir = resolveTraceDir(undefined, {})
  assert.ok(dir.endsWith('/.dsh/llm-wire-trace/records'))
})
