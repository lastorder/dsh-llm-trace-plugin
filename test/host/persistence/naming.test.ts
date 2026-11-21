import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  buildRecordId,
  buildSegmentStem,
  LEGACY_RECORD_FILE,
  LEGACY_TEMP_FILE,
  parseSegmentFile,
  resolveTraceDir,
} from '../../../src/host/persistence/naming.js'

test('buildRecordId: 13-digit ms, 4-hex ordinal, 8-hex random', () => {
  assert.match(buildRecordId(1700000000000), /^1700000000000-[0-9a-f]{4}-[0-9a-f]{8}$/)
})

test('buildRecordId: two calls in the same millisecond get an increasing ordinal; a later one resets it', () => {
  const first = buildRecordId(1700000000123)
  const second = buildRecordId(1700000000123)
  assert.ok(first < second)
  assert.equal(buildRecordId(1700000000124).split('-')[1], '0000')
})

test('buildRecordId: ids sort lexicographically in timestamp order, and a negative time clamps to zero', () => {
  assert.ok(buildRecordId(1700000000300) < buildRecordId(1700000000400))
  assert.match(buildRecordId(-5), /^0000000000000-/)
})

test('buildSegmentStem/parseSegmentFile: round-trip both file kinds and recover the start time', () => {
  const stem = buildSegmentStem(1700000000000)
  assert.match(stem, /^1700000000000-[0-9a-f]{8}$/)
  assert.deepEqual(parseSegmentFile(`${stem}.dat`), { stem, kind: 'dat', startMs: 1700000000000 })
  assert.deepEqual(parseSegmentFile(`${stem}.idx`), { stem, kind: 'idx', startMs: 1700000000000 })
})

test('parseSegmentFile: ignores everything else in the directory', () => {
  for (const name of ['1700000000000-0000-aaaaaaaa.json', '1700000000000-abc.dat', 'notes.txt', '1700000000000-aaaaaaaa.dat.tmp']) {
    assert.equal(parseSegmentFile(name), null, name)
  }
})

test('LEGACY_RECORD_FILE/LEGACY_TEMP_FILE: recognize files earlier versions wrote, and not segments', () => {
  assert.ok(LEGACY_RECORD_FILE.test('1700000000000-0000-aaaaaaaa.json'))
  assert.ok(LEGACY_RECORD_FILE.test('1700000000000-aaaaaaaa.json'))
  assert.ok(!LEGACY_RECORD_FILE.test('1700000000000-aaaaaaaa.dat'))
  assert.ok(LEGACY_TEMP_FILE.test('1700000000000-0000-aaaaaaaa.json.1a2b3c4d.tmp'))
})

test('resolveTraceDir: an explicit directory wins; otherwise $DSH_HOME, then ~/.dsh', () => {
  assert.equal(resolveTraceDir('/custom', { DSH_HOME: '/dsh' }), '/custom')
  assert.equal(resolveTraceDir(undefined, { DSH_HOME: '/dsh' }), join('/dsh', 'llm-wire-trace', 'records'))
  assert.ok(resolveTraceDir(undefined, {}).endsWith(join('.dsh', 'llm-wire-trace', 'records')))
})
