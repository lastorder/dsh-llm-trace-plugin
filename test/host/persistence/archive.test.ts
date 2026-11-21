import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordArchive, segmentTargetBytes, type RecordArchive } from '../../../src/host/persistence/archive.js'
import { MAX_DELTA_CHAIN, MAX_SEGMENT_BYTES, MIN_SEGMENT_BYTES } from '../../../src/host/persistence/constants.js'
import { buildRecordId } from '../../../src/host/persistence/naming.js'
import type { WireRecord } from '../../../src/shared/record-shape.js'
import { makeRecord } from '../fixtures.js'

const parse = (text: string | null) => (text ? JSON.parse(text) : null)

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-trace-plugin-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function using(archive: RecordArchive, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } finally {
    await archive.close()
  }
}

/** One agent step: the request repeats the whole history so far, like a real one. */
function step(at: number, sessionId: string, messages: number, extra: Partial<WireRecord> = {}): WireRecord {
  const history = Array.from({ length: messages }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${sessionId} message ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(30) }))
  const bodyText = JSON.stringify({ model: 'm', messages: history, tools: [{ name: 'read', description: 'd'.repeat(2000) }], stream: true })
  const base = makeRecord()
  return makeRecord({
    id: buildRecordId(at),
    startedAt: at,
    sessionId,
    request: { ...base.request, bodyText, bodyChars: bodyText.length },
    response: { ...base.response!, contentType: 'text/event-stream', bodyText: `data: {"n":${messages}}\n\n`, bodyChars: 20 },
    ...extra,
  })
}

/** A record whose body does not compress, to fill segments predictably. */
function bulky(at: number, sessionId: string, bytes: number): WireRecord {
  const bodyText = JSON.stringify({ blob: randomBytes(bytes).toString('base64') })
  return makeRecord({ id: buildRecordId(at), startedAt: at, sessionId, request: { ...makeRecord().request, bodyText, bodyChars: bodyText.length } })
}

async function files(dir: string, ext: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith(ext))
}

async function diskBytes(dir: string): Promise<number> {
  let total = 0
  for (const name of await readdir(dir)) total += (await stat(join(dir, name))).size
  return total
}

test('segmentTargetBytes: a sixteenth of the budget, clamped', () => {
  assert.equal(segmentTargetBytes(1024 * 1024 * 1024), 64 * 1024 * 1024)
  assert.equal(segmentTargetBytes(16 * 1024 * 1024), MIN_SEGMENT_BYTES)
  assert.equal(segmentTargetBytes(1024 * 1024 * 1024 * 1024), MAX_SEGMENT_BYTES)
})

test('save then get round-trips a record exactly, with parsed bodies attached', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      const record = makeRecord({ id: buildRecordId(Date.now()) })
      assert.equal(await archive.save(record), true)
      const found = await archive.get(record.id, parse)
      assert.ok(found !== null)
      assert.equal(found!.persisted, true)
      assert.equal(found!.request.bodyText, record.request.bodyText)
      assert.deepEqual(found!.request.headers, record.request.headers)
      assert.deepEqual(found!.request.bodyJson, { model: 'test-model' })
      assert.equal(found!.response!.bodyText, record.response!.bodyText)
      assert.equal(archive.has(record.id), true)
    })
  })
})

test('save writes one compressed segment: a .dat and an .idx, no body text in plain sight', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      const record = step(1000, 's', 10)
      await archive.save(record)
      assert.equal((await files(dir, '.dat')).length, 1)
      assert.equal((await files(dir, '.idx')).length, 1)
      const data = await readFile(join(dir, (await files(dir, '.dat'))[0]))
      assert.ok(!data.toString('latin1').includes('lorem ipsum'))
      assert.ok(data.length < record.request.bodyText.length / 5)
    })
  })
})

test('consecutive requests of one session are delta-encoded, and every body rebuilds exactly', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      const saved: WireRecord[] = []
      for (let i = 0; i < 12; i += 1) {
        const record = step(1000 + i, 'conversation', 20 + i * 2)
        saved.push(record)
        await archive.save(record)
      }
      const raw = saved.reduce((sum, record) => sum + record.request.bodyText.length, 0)
      assert.ok(await diskBytes(dir) < raw / 20, `stored ${await diskBytes(dir)} for ${raw} raw`)
      const lines = (await readFile(join(dir, (await files(dir, '.idx'))[0]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      assert.equal(lines[0].b, undefined)
      assert.equal(lines[1].b, saved[0].id)
      // Read newest first, so each read walks the chain rather than hitting the cache.
      for (let i = saved.length - 1; i >= 0; i -= 1) {
        const record = saved[i]
        const fresh = createRecordArchive({ dir, migrateLegacy: false })
        assert.equal((await fresh.get(record.id))!.request.bodyText, record.request.bodyText)
        await fresh.close()
      }
    })
  })
})

test('delta chains are capped: a full copy is written every MAX_DELTA_CHAIN steps', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      const saved: WireRecord[] = []
      for (let i = 0; i < MAX_DELTA_CHAIN + 3; i += 1) {
        const record = step(1000 + i, 'long', 10 + i)
        saved.push(record)
        await archive.save(record)
      }
      const lines = (await readFile(join(dir, (await files(dir, '.idx'))[0]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      const keyframes = lines.filter((line) => line.b === undefined).length
      assert.equal(keyframes, 2)
      const reopened = createRecordArchive({ dir })
      assert.equal((await reopened.get(saved[saved.length - 1].id))!.request.bodyText, saved[saved.length - 1].request.bodyText)
      await reopened.close()
    })
  })
})

test('different sessions never delta against each other', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      await archive.save(step(1000, 'a', 20))
      await archive.save(step(1001, 'b', 20))
      const lines = (await readFile(join(dir, (await files(dir, '.idx'))[0]), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      assert.deepEqual(lines.map((line) => line.b), [undefined, undefined])
    })
  })
})

test('housekeeping requests (no body, outside any model call) are not persisted', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      const poll = makeRecord({
        id: buildRecordId(1000),
        attributed: false,
        sessionId: null,
        request: { ...makeRecord().request, method: 'GET', url: 'https://api.deepseek.com/models', bodyText: '', bodyChars: 0 },
      })
      assert.equal(await archive.save(poll), false)
      assert.equal((await archive.list()).total, 0)
    })
  })
})

test('list: newest first, session filter with exact matched/total, limit applies after the filter', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      await archive.save(step(3000, 'a', 3))
      await archive.save(step(1000, 'a', 1))
      await archive.save(step(2000, 'b', 2))
      const all = await archive.list()
      assert.deepEqual(all.records.map((r) => r.startedAt), [3000, 2000, 1000])
      assert.equal(all.total, 3)
      assert.equal(all.matched, 3)
      assert.equal(all.records[0].request.bodyText, null)
      const mine = await archive.list({ sessionId: 'a', limit: 1 })
      assert.deepEqual(mine.records.map((r) => r.startedAt), [3000])
      assert.equal(mine.matched, 2)
      assert.equal(mine.total, 3)
    })
  })
})

test('a fresh archive on the same directory loads the index and reads every record', async () => {
  await withTempDir(async (dir) => {
    const first = createRecordArchive({ dir })
    const saved = [step(1000, 'a', 10), step(1001, 'a', 12), step(1002, 'b', 5)]
    for (const record of saved) await first.save(record)
    await first.close()

    const second = createRecordArchive({ dir })
    await using(second, async () => {
      assert.equal((await second.list()).total, 3)
      for (const record of saved) assert.equal((await second.get(record.id))!.request.bodyText, record.request.bodyText)
      // A new process writes its own segment rather than appending to another's.
      await second.save(step(1003, 'a', 14))
      assert.equal((await files(dir, '.dat')).length, 2)
    })
  })
})

test('a torn last index line (crash mid-append) is skipped, the rest still loads', async () => {
  await withTempDir(async (dir) => {
    const first = createRecordArchive({ dir })
    await first.save(step(1000, 'a', 3))
    await first.save(step(1001, 'a', 4))
    await first.close()
    await appendFile(join(dir, (await files(dir, '.idx'))[0]), '{"id":"1700000000000-0000-deadbeef","o":')
    const second = createRecordArchive({ dir })
    await using(second, async () => {
      assert.equal((await second.list()).total, 2)
    })
  })
})

test('retention deletes whole segments, oldest content first, to stay within the disk budget', async () => {
  await withTempDir(async (dir) => {
    const budget = 3 * 1024 * 1024
    const archive = createRecordArchive({ dir, maxDiskBytes: budget })
    await using(archive, async () => {
      const saved: WireRecord[] = []
      for (let i = 0; i < 24; i += 1) {
        const record = bulky(1000 + i, `s${i}`, 300 * 1024)
        saved.push(record)
        await archive.save(record)
      }
      assert.ok(await diskBytes(dir) <= budget, `disk ${await diskBytes(dir)} over budget ${budget}`)
      const listed = await archive.list()
      assert.ok(listed.total < saved.length && listed.total > 0)
      // What is left is the newest, and it is readable.
      assert.equal(listed.records[0].id, saved[saved.length - 1].id)
      assert.equal(await archive.get(saved[0].id), null)
      assert.equal((await archive.get(saved[saved.length - 1].id))!.request.bodyText, saved[saved.length - 1].request.bodyText)
      const stats = await archive.stats()
      assert.ok(stats.diskBytes <= budget)
      assert.equal(stats.retained, listed.total)
    })
  })
})

test('a lowered budget is enforced when the archive opens, not only at the next write', async () => {
  await withTempDir(async (dir) => {
    const first = createRecordArchive({ dir, maxDiskBytes: 64 * 1024 * 1024 })
    for (let i = 0; i < 12; i += 1) await first.save(bulky(1000 + i, `s${i}`, 300 * 1024))
    await first.close()
    // Force several segments by reopening between writes.
    for (let i = 0; i < 3; i += 1) {
      const again = createRecordArchive({ dir, maxDiskBytes: 64 * 1024 * 1024 })
      await again.save(bulky(2000 + i, `t${i}`, 300 * 1024))
      await again.close()
    }
    const small = createRecordArchive({ dir, maxDiskBytes: 1024 * 1024 })
    await using(small, async () => {
      await small.open()
      await small.idle()
      assert.ok(await diskBytes(dir) <= 1024 * 1024)
    })
  })
})

test('clear() with no session removes every segment, and writing continues afterwards', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      await archive.save(step(1000, 'a', 3))
      await archive.save(step(1001, 'b', 3))
      assert.equal(await archive.clear(), 2)
      assert.deepEqual(await readdir(dir), [])
      assert.equal((await archive.list()).total, 0)
      const after = step(1002, 'a', 4)
      assert.equal(await archive.save(after), true)
      assert.equal((await archive.get(after.id))!.request.bodyText, after.request.bodyText)
    })
  })
})

test('clear({ sessionId }) rewrites segments without that session; other sessions (and their deltas) survive', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    const keep: WireRecord[] = []
    await using(archive, async () => {
      for (let i = 0; i < 6; i += 1) {
        await archive.save(step(1000 + i * 2, 'drop', 10 + i))
        const kept = step(1001 + i * 2, 'keep', 10 + i)
        keep.push(kept)
        await archive.save(kept)
      }
      assert.equal(await archive.clear({ sessionId: 'drop' }), 6)
      const listed = await archive.list()
      assert.equal(listed.total, 6)
      assert.ok(listed.records.every((r) => r.sessionId === 'keep'))
      for (const record of keep) assert.equal((await archive.get(record.id))!.request.bodyText, record.request.bodyText)
    })
    const reopened = createRecordArchive({ dir })
    await using(reopened, async () => {
      assert.equal((await reopened.list()).total, 6)
      assert.equal((await reopened.get(keep[5].id))!.request.bodyText, keep[5].request.bodyText)
      assert.equal((await reopened.list({ sessionId: 'drop' })).matched, 0)
    })
  })
})

test('clear({ sessionId }) deletes a segment outright when nothing in it is kept', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      await archive.save(step(1000, 'only', 3))
      assert.equal(await archive.clear({ sessionId: 'only' }), 1)
      assert.deepEqual(await readdir(dir), [])
    })
  })
})

test('records written by an earlier version are imported once, oldest first, and their files removed', async () => {
  await withTempDir(async (dir) => {
    const legacy = [step(1000, 'old', 10), step(2000, 'old', 12)]
    for (const record of legacy) {
      await writeFile(join(dir, `${record.id}.json`), JSON.stringify({ v: 1, ...record, request: { ...record.request, bodyJson: JSON.parse(record.request.bodyText) } }, null, 2))
    }
    const poll = makeRecord({ id: buildRecordId(1500), attributed: false, sessionId: null, request: { ...makeRecord().request, method: 'GET', bodyText: '', bodyChars: 0 } })
    await writeFile(join(dir, `${poll.id}.json`), JSON.stringify(poll))
    const corrupt = `${buildRecordId(1600)}.json`
    await writeFile(join(dir, corrupt), '{"id":')
    await writeFile(join(dir, `${buildRecordId(1700)}.json.1a2b3c4d.tmp`), 'partial')

    const errors: Error[] = []
    const archive = createRecordArchive({ dir, onError: (error) => errors.push(error) })
    await using(archive, async () => {
      await archive.open()
      await archive.idle()
      const listed = await archive.list()
      assert.deepEqual(listed.records.map((r) => r.id), [legacy[1].id, legacy[0].id])
      for (const record of legacy) assert.equal((await archive.get(record.id))!.request.bodyText, record.request.bodyText)
      // Imported and housekeeping files are gone; the unreadable one is left alone.
      assert.deepEqual(await files(dir, '.json'), [corrupt])
      assert.deepEqual(await files(dir, '.tmp'), [])
      assert.equal((await archive.stats()).legacyPending, 0)
      assert.equal(errors.length, 1)
    })
  })
})

test('legacy files that merely echo a call already captured (an in-place upgrade) are not imported twice', async () => {
  await withTempDir(async (dir) => {
    const captured = step(5000, 'live', 8)
    const first = createRecordArchive({ dir })
    await first.save(captured)
    await first.close()
    // The old version, still buried in the fetch chain, wrote its own unattributed copy.
    const echo = { ...captured, id: buildRecordId(5004), startedAt: 5004, attributed: false, sessionId: null, turn: null, step: null }
    const genuine = { ...step(9000, 'old', 3), attributed: false, sessionId: null }
    await writeFile(join(dir, `${echo.id}.json`), JSON.stringify({ v: 1, ...echo }))
    await writeFile(join(dir, `${genuine.id}.json`), JSON.stringify({ v: 1, ...genuine }))
    const archive = createRecordArchive({ dir })
    await using(archive, async () => {
      await archive.idle()
      assert.deepEqual((await archive.list()).records.map((r) => r.id), [genuine.id, captured.id])
      assert.deepEqual(await files(dir, '.json'), [])
    })
  })
})

test('two processes on one directory: each writes its own segment and sees the other\'s records', async () => {
  await withTempDir(async (dir) => {
    const a = createRecordArchive({ dir })
    const b = createRecordArchive({ dir })
    try {
      await b.open()
      const fromA = step(1000, 'a', 5)
      await a.save(fromA)
      // An id b has never seen triggers a re-scan.
      assert.equal((await b.get(fromA.id))!.request.bodyText, fromA.request.bodyText)
      assert.equal((await b.list()).total, 1)
      await b.save(step(1001, 'b', 5))
      assert.equal((await files(dir, '.dat')).length, 2)

      // b wipes everything; a notices its segment is gone and starts a new one.
      await b.clear()
      const later = step(1002, 'a', 6)
      assert.equal(await a.save(later), true)
      assert.equal((await a.get(later.id))!.request.bodyText, later.request.bodyText)
      assert.equal((await files(dir, '.dat')).length, 1)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

test('stats reports records, disk use against the budget, and the oldest record', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir, maxDiskBytes: 32 * 1024 * 1024 })
    await using(archive, async () => {
      await archive.save(step(5000, 'a', 3))
      await archive.save(step(4000, 'a', 4))
      const stats = await archive.stats()
      assert.equal(stats.dir, dir)
      assert.equal(stats.retained, 2)
      assert.equal(stats.maxDiskBytes, 32 * 1024 * 1024)
      assert.equal(stats.diskBytes, await diskBytes(dir))
      assert.equal(stats.oldestAt, 4000)
      assert.equal(stats.writes, 2)
      assert.equal(stats.failures, 0)
      assert.equal(stats.segments, 1)
    })
  })
})

test('get returns null for an unknown id, and save after close is refused', async () => {
  await withTempDir(async (dir) => {
    const archive = createRecordArchive({ dir })
    assert.equal(await archive.get('1700000000000-0000-deadbeef'), null)
    await archive.close()
    assert.equal(await archive.save(step(1000, 'a', 2)), false)
  })
})
