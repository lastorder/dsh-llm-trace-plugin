import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordArchive } from '../../../src/host/persistence/archive.js'
import { buildRecordName } from '../../../src/host/persistence/naming.js'
import { makeRecord } from '../fixtures.js'

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-trace-plugin-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('save then get round-trips a record, marking it persisted', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    const record = makeRecord({ id: buildRecordName(Date.now()).slice(0, -5) })
    const ok = await archive.save(record)
    assert.equal(ok, true)

    const found = await archive.get(record.id, (text) => (text ? JSON.parse(text) : null))
    assert.ok(found !== null)
    assert.equal(found!.id, record.id)
    assert.equal(found!.persisted, true)
    assert.equal(found!.request.bodyText, record.request.bodyText)
  })
})

test('save writes via temp-file-then-rename, leaving no partial file at the target name', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    const record = makeRecord({ id: buildRecordName(Date.now()).slice(0, -5) })
    await archive.save(record)
    const entries = await readdir(dir)
    assert.ok(entries.includes(`${record.id}.json`))
    assert.ok(!entries.some((name) => name.endsWith('.tmp')))
  })
})

test('save refuses a malformed id and counts it as a failure rather than throwing', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    const record = makeRecord({ id: '../escape-attempt' })
    const ok = await archive.save(record)
    assert.equal(ok, false)
    const stats = await archive.stats()
    assert.equal(stats.failures, 1)
  })
})

test('get returns null for a record that was never saved', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    const found = await archive.get('1700000000000-0000-deadbeef')
    assert.equal(found, null)
  })
})

test('get skips a torn/corrupt file rather than throwing, and counts it as a failure', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await archive.save(makeRecord({ id: buildRecordName(Date.now()).slice(0, -5) }))
    // Corrupt an existing valid-named file directly.
    const entries = await readdir(dir)
    const target = entries.find((n) => n.endsWith('.json'))!
    await writeFile(join(dir, target), '{not valid json', 'utf8')
    const found = await archive.get(target.slice(0, -5))
    assert.equal(found, null)
    const stats = await archive.stats()
    assert.equal(stats.failures, 1)
  })
})

test('list returns records newest-first, filtered by sessionId before the page window', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await archive.save(makeRecord({ id: buildRecordName(1000).slice(0, -5), sessionId: 'a', startedAt: 1000 }))
    await archive.save(makeRecord({ id: buildRecordName(2000).slice(0, -5), sessionId: 'b', startedAt: 2000 }))
    await archive.save(makeRecord({ id: buildRecordName(3000).slice(0, -5), sessionId: 'a', startedAt: 3000 }))

    const page = await archive.list({ sessionId: 'a' })
    assert.equal(page.records.length, 2)
    assert.ok(page.records.every((r) => r.sessionId === 'a'))
    // Newest first.
    assert.ok(page.records[0].startedAt > page.records[1].startedAt)
  })
})

test('list defaults to metadata-only records (no bodyText/bodyJson) unless full:true is requested', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await archive.save(makeRecord({ id: buildRecordName(Date.now()).slice(0, -5) }))
    const metaPage = await archive.list()
    assert.equal(metaPage.records[0].request.bodyText, null)

    const fullPage = await archive.list({ full: true })
    assert.notEqual(fullPage.records[0].request.bodyText, null)
  })
})

test('sweep enforces maxRecords by deleting the oldest files first', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir, maxRecords: 2 })
    await archive.save(makeRecord({ id: buildRecordName(1000).slice(0, -5), startedAt: 1000 }))
    await archive.save(makeRecord({ id: buildRecordName(2000).slice(0, -5), startedAt: 2000 }))
    await archive.save(makeRecord({ id: buildRecordName(3000).slice(0, -5), startedAt: 3000 }))
    await archive.sweep()
    const stats = await archive.stats()
    assert.equal(stats.retained, 2)
    const page = await archive.list({ limit: 10 })
    assert.ok(page.records.every((r) => r.startedAt >= 2000))
  })
})

test('sweepTemp removes orphan .tmp files left by an unclean shutdown', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await archive.save(makeRecord({ id: buildRecordName(Date.now()).slice(0, -5) })) // ensures dir exists
    await writeFile(join(dir, 'orphan.json.deadbeef.tmp'), 'partial', 'utf8')
    await archive.sweepTemp()
    const entries = await readdir(dir)
    assert.ok(!entries.some((name) => name.endsWith('.tmp')))
  })
})

test('clear removes every persisted record and reports the count', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await archive.save(makeRecord({ id: buildRecordName(1000).slice(0, -5), startedAt: 1000 }))
    await archive.save(makeRecord({ id: buildRecordName(2000).slice(0, -5), startedAt: 2000 }))
    const removed = await archive.clear()
    assert.equal(removed, 2)
    const stats = await archive.stats()
    assert.equal(stats.retained, 0)
  })
})

test('stats reports dir/retained/maxRecords/writes/failures', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir, maxRecords: 5 })
    await archive.save(makeRecord({ id: buildRecordName(Date.now()).slice(0, -5) }))
    const stats = await archive.stats()
    assert.equal(stats.dir, dir)
    assert.equal(stats.maxRecords, 5)
    assert.equal(stats.retained, 1)
    assert.equal(stats.writes, 1)
    assert.equal(stats.failures, 0)
  })
})
