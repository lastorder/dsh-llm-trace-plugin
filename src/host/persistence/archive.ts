/**
 * Durable record store: compressed, append-only segments plus an in-memory
 * index of every record they hold.
 *
 * Layout under the trace directory — each segment is a pair of files sharing
 * a stem (see naming.ts):
 *
 *     <start-ms>-<random>.dat   compressed payloads, back to back
 *     <start-ms>-<random>.idx   one JSON line per record: list fields + where its payload is
 *
 * Why this shape:
 *
 *   - Small. Each payload is brotli-compressed, and a request body is stored
 *     as a delta against the previous request of the same conversation (see
 *     `planDelta` in codec.ts). An agent request repeats the whole history,
 *     so a 1.6 MB body typically costs a few kilobytes.
 *   - Fast to list. The `.idx` files are read once at startup into memory, so
 *     listing, filtering by session and counting never touch the disk;
 *     opening a record is one positioned read and one decompression (plus its
 *     delta base, usually already cached).
 *   - Cheap retention. The budget is enforced by deleting whole segments,
 *     oldest content first. Delta chains never cross a segment, so deleting
 *     one can never orphan a record in another.
 *   - No shared mutable file. Every process appends only to segments it
 *     created, and picks up other processes' segments by re-scanning the
 *     directory. A writer whose segment disappears (another process cleared
 *     it) simply starts a new one.
 *
 * Every method resolves rather than rejects on I/O failure: persistence is a
 * convenience under a debugging tool and must never break capture or the
 * viewer. Failures are counted and surfaced via `stats()`.
 *
 * @module dsh-llm-trace-plugin/host/persistence/archive
 */

import { mkdir, open, readdir, readFile, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, brotliDecompress, constants as zlib } from 'node:zlib'
import type { WireRecord, WireRecordMeta } from '../../shared/record-shape.js'
import {
  BODY_CACHE_ENTRIES,
  BROTLI_QUALITY,
  BROTLI_WINDOW_BITS,
  DEFAULT_MAX_DISK_MB,
  MAX_DELTA_CHAIN,
  MAX_DELTA_LANES,
  MAX_SEGMENT_BYTES,
  MIN_SEGMENT_BYTES,
  RESCAN_INTERVAL_MS,
  SEGMENTS_PER_BUDGET,
} from './constants.js'
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
  type BodyDelta,
} from './codec.js'
import { buildSegmentStem, LEGACY_RECORD_FILE, LEGACY_TEMP_FILE, parseSegmentFile, resolveTraceDir } from './naming.js'

const compress = promisify(brotliCompress)
const decompress = promisify(brotliDecompress)

/** Yield to the event loop so the UI's own requests get a turn during long passes. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Segment size for a budget: small enough that whole-segment retention stays close to the budget. */
export function segmentTargetBytes(maxDiskBytes: number): number {
  return Math.max(MIN_SEGMENT_BYTES, Math.min(MAX_SEGMENT_BYTES, Math.floor(maxDiskBytes / SEGMENTS_PER_BUDGET)))
}

export interface ArchiveOptions {
  dir?: string
  /** Disk budget for all segments, in bytes. Defaults to DEFAULT_MAX_DISK_MB. */
  maxDiskBytes?: number
  /** Import record files written by versions before 0.6.0. Defaults to true. */
  migrateLegacy?: boolean
  onError?: (error: Error) => void
}

export interface ArchiveListQuery {
  limit?: number
  sessionId?: string
}

export interface ArchiveListResult {
  /** Newest first, at most `limit`. Metadata only — no bodies, no headers. */
  records: WireRecordMeta[]
  /** Every record held. */
  total: number
  /** Records matching the session filter (equal to `total` without one). */
  matched: number
}

export interface ArchiveStats {
  dir: string
  /** Records held. */
  retained: number
  /** Bytes used by all segment files. */
  diskBytes: number
  maxDiskBytes: number
  /** `startedAt` of the oldest record held, or null when empty. */
  oldestAt: number | null
  segments: number
  writes: number
  failures: number
  /** Record files from an earlier version still waiting to be imported. */
  legacyPending: number
}

export interface ArchiveClearOptions {
  /** Narrow deletion to one session's records; absent/empty deletes everything. */
  sessionId?: string
}

export interface RecordArchive {
  dir: string
  maxDiskBytes: number
  /** Load the index (idempotent). Every other method awaits it. */
  open(): Promise<void>
  /** Whether the index has finished loading. */
  isReady(): boolean
  /** Whether a record is on disk (per the in-memory index). */
  has(id: string): boolean
  /** Persist one finished record; false when it was not (by policy, see `shouldPersist`, or on failure). */
  save(record: WireRecord): Promise<boolean>
  list(query?: ArchiveListQuery): Promise<ArchiveListResult>
  get(id: string, parseJson?: (text: string | null) => unknown): Promise<WireRecord | null>
  /** @returns how many records were removed. */
  clear(options?: ArchiveClearOptions): Promise<number>
  stats(): Promise<ArchiveStats>
  /** Resolves once the startup import and every queued write have finished. */
  idle(): Promise<void>
  /** Finish pending writes and release file handles. Stops an unfinished import; it resumes next start. */
  close(): Promise<void>
}

interface Segment {
  stem: string
  startMs: number
  dataBytes: number
  idxBytes: number
  /** How much of the `.idx` file has been parsed (for segments another process is still appending to). */
  idxRead: number
  /** Newest `startedAt` of any record in it: retention deletes the segment whose newest content is oldest. */
  lastAt: number
  /** Created by this archive instance, so its index entries are already in memory. */
  own: boolean
}

interface Entry {
  meta: WireRecordMeta
  segment: Segment
  offset: number
  length: number
  base: string | null
}

interface Lane {
  id: string
  text: string
  depth: number
}

interface Writer {
  segment: Segment
  data: FileHandle
  idx: FileHandle
  /** Previous request per conversation, for delta encoding. Insertion order doubles as LRU order. */
  lanes: Map<string, Lane>
}

const byAge = (a: Entry, b: Entry) => {
  if (a.meta.startedAt !== b.meta.startedAt) return a.meta.startedAt - b.meta.startedAt
  return a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0
}

/**
 * Which conversation a request continues, for delta encoding: same session,
 * same purpose, same endpoint. Calls with no session have nothing reliable to
 * chain to and are stored whole.
 */
function laneOf(record: WireRecord): string | null {
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) return null
  return `${record.sessionId}\u0000${record.purpose ?? ''}\u0000${record.request.method} ${record.request.url}`
}

/** Create the durable store. Nothing touches the disk until the first call. */
export function createRecordArchive(options?: ArchiveOptions): RecordArchive {
  const settings = options ?? {}
  const dir = resolveTraceDir(settings.dir)
  const maxDiskBytes = settings.maxDiskBytes ?? DEFAULT_MAX_DISK_MB * 1024 * 1024
  const targetBytes = segmentTargetBytes(maxDiskBytes)
  const onError = typeof settings.onError === 'function' ? settings.onError : () => {}

  const entries = new Map<string, Entry>()
  /** Every entry, oldest first. */
  let ordered: Entry[] = []
  const sessionCounts = new Map<string | null, number>()
  const segments = new Map<string, Segment>()
  /** Request bodies already rebuilt, newest last. */
  const bodyCache = new Map<string, string>()

  let writer: Writer | null = null
  let opening: Promise<void> | null = null
  let ready = false
  let scanning: Promise<void> | null = null
  let lastScanAt = 0
  let migrating: Promise<void> = Promise.resolve()
  let legacyPending = 0
  let closed = false
  let writes = 0
  let failures = 0
  /** Serializes every mutation (writes, clears, retention) within this process. */
  let queue: Promise<unknown> = Promise.resolve()

  function fail(error: unknown) {
    failures += 1
    try {
      onError(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // A reporting failure must not escalate into a capture failure.
    }
  }

  function enqueue<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    const run = queue.then(task).catch((error) => {
      fail(error)
      return fallback
    })
    queue = run
    return run
  }

  const pathOf = (segment: Segment, kind: 'dat' | 'idx') => join(dir, `${segment.stem}.${kind}`)

  // -- index bookkeeping ----------------------------------------------------

  function addEntry(entry: Entry) {
    if (entries.has(entry.meta.id)) return
    entries.set(entry.meta.id, entry)
    const last = ordered[ordered.length - 1]
    if (last === undefined || byAge(last, entry) <= 0) {
      ordered.push(entry)
    } else {
      // Calls finish out of order (a long stream started earlier ends later).
      let lo = 0
      let hi = ordered.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (byAge(ordered[mid], entry) <= 0) lo = mid + 1
        else hi = mid
      }
      ordered.splice(lo, 0, entry)
    }
    const session = entry.meta.sessionId ?? null
    sessionCounts.set(session, (sessionCounts.get(session) ?? 0) + 1)
    if (entry.meta.startedAt > entry.segment.lastAt) entry.segment.lastAt = entry.meta.startedAt
  }

  function removeEntries(drop: (entry: Entry) => boolean): number {
    let removed = 0
    ordered = ordered.filter((entry) => {
      if (!drop(entry)) return true
      entries.delete(entry.meta.id)
      bodyCache.delete(entry.meta.id)
      const session = entry.meta.sessionId ?? null
      const left = (sessionCounts.get(session) ?? 1) - 1
      if (left > 0) sessionCounts.set(session, left)
      else sessionCounts.delete(session)
      removed += 1
      return false
    })
    return removed
  }

  function forgetSegment(segment: Segment): number {
    segments.delete(segment.stem)
    return removeEntries((entry) => entry.segment === segment)
  }

  // -- reading segments -----------------------------------------------------

  /** Parse the not-yet-read tail of a segment's index, up to its last complete line. */
  async function readIndexTail(segment: Segment, idxSize: number, dataSize: number): Promise<void> {
    if (idxSize <= segment.idxRead) return
    const handle = await open(pathOf(segment, 'idx'), 'r')
    let text: string
    try {
      const buffer = Buffer.alloc(idxSize - segment.idxRead)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, segment.idxRead)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    const complete = text.lastIndexOf('\n') + 1
    segment.idxRead += Buffer.byteLength(text.slice(0, complete))
    for (const line of text.slice(0, complete).split('\n')) {
      const parsed = parseIndexLine(line)
      // A payload that does not fit the data file was never fully written.
      if (parsed === null || parsed.location.offset + parsed.location.length > dataSize) continue
      addEntry({ meta: parsed.meta, segment, ...parsed.location })
    }
  }

  /**
   * Reconcile the in-memory index with the directory: load segments not seen
   * yet, read what other processes appended to theirs, and drop segments that
   * are gone. This process's own segments are already authoritative in memory.
   */
  function scan(): Promise<void> {
    if (scanning !== null) return scanning
    scanning = (async () => {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch (error: any) {
        if (!error || error.code !== 'ENOENT') fail(error)
        return
      }
      const present = new Map<string, { startMs: number, dat: boolean, idx: boolean }>()
      for (const name of names) {
        const parsed = parseSegmentFile(name)
        if (parsed === null) continue
        const slot = present.get(parsed.stem) ?? { startMs: parsed.startMs, dat: false, idx: false }
        slot[parsed.kind] = true
        present.set(parsed.stem, slot)
      }
      // A copy: forgetting a segment deletes it from the map being walked.
      for (const segment of Array.from(segments.values())) {
        const slot = present.get(segment.stem)
        if (slot === undefined || !slot.dat || !slot.idx) {
          if (writer === null || writer.segment !== segment) forgetSegment(segment)
        }
      }
      const stems = [...present.keys()].sort()
      for (const stem of stems) {
        const slot = present.get(stem)!
        if (!slot.dat || !slot.idx) continue
        let segment = segments.get(stem)
        if (segment !== undefined && segment.own) continue
        try {
          const [dataStat, idxStat] = await Promise.all([
            stat(join(dir, `${stem}.dat`)),
            stat(join(dir, `${stem}.idx`)),
          ])
          if (segment === undefined) {
            segment = { stem, startMs: slot.startMs, dataBytes: 0, idxBytes: 0, idxRead: 0, lastAt: slot.startMs, own: false }
            segments.set(stem, segment)
          }
          segment.dataBytes = dataStat.size
          segment.idxBytes = idxStat.size
          await readIndexTail(segment, idxStat.size, dataStat.size)
        } catch (error: any) {
          if (!error || error.code !== 'ENOENT') fail(error)
        }
        // Loading a large index parses synchronously; let the UI in between.
        if (segment !== undefined && segment.idxRead > 0) await yieldToLoop()
      }
      lastScanAt = Date.now()
    })().finally(() => {
      scanning = null
    })
    return scanning
  }

  async function readPayload(entry: Entry): Promise<{ record: WireRecord, delta: BodyDelta | null }> {
    const handle = await open(pathOf(entry.segment, 'dat'), 'r')
    try {
      const buffer = Buffer.alloc(entry.length)
      const { bytesRead } = await handle.read(buffer, 0, entry.length, entry.offset)
      if (bytesRead !== entry.length) throw new Error(`short read for record ${entry.meta.id}`)
      return decodeRecord((await decompress(buffer)).toString('utf8'))
    } finally {
      await handle.close()
    }
  }

  function remember(id: string, text: string) {
    bodyCache.delete(id)
    bodyCache.set(id, text)
    while (bodyCache.size > BODY_CACHE_ENTRIES) bodyCache.delete(bodyCache.keys().next().value as string)
  }

  /** A record's request body, rebuilding its delta chain as needed. */
  async function requestBody(id: string, hops: number): Promise<string> {
    const cached = bodyCache.get(id)
    if (cached !== undefined) {
      remember(id, cached)
      return cached
    }
    // A chain longer than any this module writes means corrupt data, not a deep chain.
    if (hops > MAX_DELTA_CHAIN + 1) throw new Error(`delta chain too long at record ${id}`)
    const entry = entries.get(id)
    if (entry === undefined) throw new Error(`delta base ${id} is missing`)
    const { record, delta } = await readPayload(entry)
    const text = delta === null ? record.request.bodyText : applyDelta(await requestBody(delta.base, hops + 1), delta)
    remember(id, text)
    return text
  }

  // -- writing --------------------------------------------------------------

  async function seal(): Promise<void> {
    const current = writer
    writer = null
    if (current === null) return
    await Promise.allSettled([current.data.close(), current.idx.close()])
  }

  async function ensureWriter(): Promise<Writer> {
    if (writer !== null) {
      let exists = true
      try {
        await stat(pathOf(writer.segment, 'dat'))
      } catch {
        exists = false
      }
      if (!exists) {
        // Another process cleared or trimmed it: what we wrote there is gone.
        const gone = writer.segment
        await seal()
        forgetSegment(gone)
      } else if (writer.segment.dataBytes >= targetBytes) {
        await seal()
      }
    }
    if (writer === null) {
      const startMs = Date.now()
      const segment: Segment = { stem: buildSegmentStem(startMs), startMs, dataBytes: 0, idxBytes: 0, idxRead: 0, lastAt: startMs, own: true }
      const data = await open(pathOf(segment, 'dat'), 'a')
      let idx: FileHandle
      try {
        idx = await open(pathOf(segment, 'idx'), 'a')
      } catch (error) {
        await data.close()
        throw error
      }
      segments.set(segment.stem, segment)
      writer = { segment, data, idx, lanes: new Map() }
    }
    return writer
  }

  async function deleteFiles(stem: string): Promise<void> {
    await Promise.all(['dat', 'idx'].map(async (kind) => {
      try {
        await unlink(join(dir, `${stem}.${kind}`))
      } catch (error: any) {
        if (!error || error.code !== 'ENOENT') fail(error)
      }
    }))
  }

  /** Delete whole segments, the one whose newest record is oldest first, until under budget. */
  async function enforceBudget(): Promise<void> {
    let total = 0
    for (const segment of segments.values()) total += segment.dataBytes + segment.idxBytes
    if (total <= maxDiskBytes) return
    const candidates = [...segments.values()]
      .filter((segment) => writer === null || segment !== writer.segment)
      .sort((a, b) => a.lastAt - b.lastAt || a.startMs - b.startMs)
    for (const segment of candidates) {
      if (total <= maxDiskBytes) break
      total -= segment.dataBytes + segment.idxBytes
      forgetSegment(segment)
      await deleteFiles(segment.stem)
    }
  }

  async function write(record: WireRecord): Promise<boolean> {
    if (entries.has(record.id)) return true
    const target = await ensureWriter()
    const text = record.request.bodyText ?? ''
    const laneKey = laneOf(record)
    const lane = laneKey === null ? undefined : target.lanes.get(laneKey)
    let delta: BodyDelta | null = null
    if (lane !== undefined && lane.depth < MAX_DELTA_CHAIN) {
      const plan = planDelta(text, lane.text)
      if (plan !== null) delta = { base: lane.id, ...plan }
    }

    const payload = await compress(Buffer.from(encodeRecord(record, delta), 'utf8'), {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.BROTLI_PARAM_LGWIN]: BROTLI_WINDOW_BITS,
      },
    })
    const segment = target.segment
    const offset = segment.dataBytes
    const line = Buffer.from(toIndexLine(record, { offset, length: payload.length, base: delta === null ? null : delta.base }), 'utf8')
    try {
      // Payload first, index line second: an index line only ever points at
      // bytes that are already on disk.
      await target.data.write(payload)
      segment.dataBytes += payload.length
      await target.idx.write(line)
      segment.idxBytes += line.length
      segment.idxRead = segment.idxBytes
    } catch (error) {
      // The segment's tail is now unknown; continue in a fresh one.
      await seal()
      throw error
    }

    addEntry({ meta: toMeta(record), segment, offset, length: payload.length, base: delta === null ? null : delta.base })
    if (laneKey !== null) {
      target.lanes.delete(laneKey)
      target.lanes.set(laneKey, { id: record.id, text, depth: delta === null ? 0 : (lane as Lane).depth + 1 })
      while (target.lanes.size > MAX_DELTA_LANES) target.lanes.delete(target.lanes.keys().next().value as string)
    }
    // The viewer usually opens what just finished, and Compare reads its predecessor.
    remember(record.id, text)
    writes += 1
    await enforceBudget()
    return true
  }

  /** Rewrite a segment keeping only `keep`, copying their compressed payloads as-is. */
  async function rewriteSegment(segment: Segment, keep: Entry[]): Promise<void> {
    const replacement: Segment = {
      stem: buildSegmentStem(segment.startMs),
      startMs: segment.startMs,
      dataBytes: 0,
      idxBytes: 0,
      idxRead: 0,
      lastAt: segment.startMs,
      own: true,
    }
    const source = await open(pathOf(segment, 'dat'), 'r')
    const data = await open(pathOf(replacement, 'dat'), 'w')
    const idx = await open(pathOf(replacement, 'idx'), 'w')
    const moved: { entry: Entry, offset: number }[] = []
    try {
      for (const entry of [...keep].sort((a, b) => a.offset - b.offset)) {
        const buffer = Buffer.alloc(entry.length)
        await source.read(buffer, 0, entry.length, entry.offset)
        const offset = replacement.dataBytes
        await data.write(buffer)
        replacement.dataBytes += buffer.length
        const line = Buffer.from(toIndexLine(entry.meta, { offset, length: entry.length, base: entry.base }), 'utf8')
        await idx.write(line)
        replacement.idxBytes += line.length
        moved.push({ entry, offset })
      }
    } catch (error) {
      await Promise.allSettled([source.close(), data.close(), idx.close()])
      await deleteFiles(replacement.stem)
      throw error
    }
    await Promise.allSettled([source.close(), data.close(), idx.close()])
    replacement.idxRead = replacement.idxBytes
    segments.set(replacement.stem, replacement)
    for (const { entry, offset } of moved) {
      entry.segment = replacement
      entry.offset = offset
      if (entry.meta.startedAt > replacement.lastAt) replacement.lastAt = entry.meta.startedAt
    }
    segments.delete(segment.stem)
    await deleteFiles(segment.stem)
  }

  // -- importing records written by earlier versions ------------------------

  /**
   * Whether a legacy record is a second copy of a call this version already
   * captured. Upgrading in place (without restarting DSH) can leave the old
   * version's fetch wrapper buried in the fetch chain — a wrapper installed
   * after it cannot be unlinked — where it keeps recording every call as an
   * unattributed old-format file until the next restart. Those files then
   * look like history to import. They are recognizable: unattributed, same
   * endpoint and same body size as an attributed record started within a
   * second of it.
   */
  function isEchoOfIndexed(record: WireRecord): boolean {
    if (record.attributed === true) return false
    let lo = 0
    let hi = ordered.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ordered[mid].meta.startedAt < record.startedAt - 1000) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < ordered.length && ordered[i].meta.startedAt <= record.startedAt + 1000; i += 1) {
      const meta = ordered[i].meta
      if (meta.attributed && meta.request.url === record.request.url && meta.request.bodyChars === record.request.bodyChars) return true
    }
    return false
  }

  async function migrateLegacy(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names.filter((entry) => LEGACY_TEMP_FILE.test(entry))) {
      try {
        await unlink(join(dir, name))
      } catch {
        // Best effort.
      }
    }
    const legacy = names.filter((entry) => LEGACY_RECORD_FILE.test(entry)).sort()
    legacyPending = legacy.length
    for (const name of legacy) {
      if (closed) return
      const path = join(dir, name)
      let record: WireRecord | null = null
      try {
        record = fromLegacyFile(JSON.parse(await readFile(path, 'utf8')))
      } catch (error: any) {
        if (error && error.code === 'ENOENT') {
          legacyPending -= 1
          continue
        }
        // Unreadable: leave the file alone rather than destroy what cannot be read.
        fail(error)
        legacyPending -= 1
        continue
      }
      // Oldest first, through the normal write path, so deltas and the budget apply.
      const kept = record === null || !shouldPersist(record) || isEchoOfIndexed(record) || await enqueue(() => write(record!), false)
      if (kept) {
        try {
          await unlink(path)
        } catch {
          // Already gone.
        }
      }
      legacyPending -= 1
      await yieldToLoop()
    }
  }

  // -- public surface -------------------------------------------------------

  function openIndex(): Promise<void> {
    if (opening === null) {
      opening = (async () => {
        try {
          await mkdir(dir, { recursive: true })
        } catch (error) {
          fail(error)
        }
        await scan()
        ready = true
        // A lowered budget takes effect at once, not at the next write.
        await enqueue(enforceBudget, undefined)
        if (settings.migrateLegacy !== false) migrating = migrateLegacy().catch(fail)
      })()
    }
    return opening
  }

  return {
    dir,
    maxDiskBytes,

    open: openIndex,

    isReady() {
      return ready
    },

    has(id) {
      return entries.has(id)
    },

    async save(record) {
      if (closed || !shouldPersist(record)) return false
      await openIndex()
      return enqueue(() => write(record), false)
    },

    async list(query) {
      await openIndex()
      if (Date.now() - lastScanAt >= RESCAN_INTERVAL_MS) await scan()
      const request = query ?? {}
      const wanted = typeof request.sessionId === 'string' && request.sessionId.length > 0 ? request.sessionId : null
      const cap = typeof request.limit === 'number' && request.limit > 0 ? request.limit : ordered.length
      const records: WireRecordMeta[] = []
      for (let i = ordered.length - 1; i >= 0 && records.length < cap; i -= 1) {
        const meta = ordered[i].meta
        if (wanted === null || meta.sessionId === wanted) records.push(meta)
      }
      return {
        records,
        total: ordered.length,
        matched: wanted === null ? ordered.length : (sessionCounts.get(wanted) ?? 0),
      }
    },

    async get(id, parseJson) {
      await openIndex()
      let entry = entries.get(id)
      if (entry === undefined) {
        // Possibly written by another process since the last scan.
        await scan()
        entry = entries.get(id)
      }
      if (entry === undefined) return null
      try {
        const { record, delta } = await readPayload(entry)
        if (delta !== null) {
          record.request.bodyText = applyDelta(await requestBody(delta.base, 1), delta)
        }
        remember(id, record.request.bodyText)
        return withParsedBodies(record, parseJson ?? (() => null))
      } catch (error: any) {
        if (!error || error.code !== 'ENOENT') fail(error)
        return null
      }
    },

    async clear(clearOptions) {
      await openIndex()
      // Let the one-time import finish first, or it would re-add what was just cleared.
      await migrating
      const sessionId = typeof clearOptions?.sessionId === 'string' && clearOptions.sessionId.length > 0
        ? clearOptions.sessionId
        : null
      return enqueue(async () => {
        // Seal our own segment so every segment is safe to delete or rewrite.
        await seal()
        if (sessionId === null) {
          const removed = ordered.length
          let names: string[] = []
          try {
            names = await readdir(dir)
          } catch {
            // Nothing on disk.
          }
          const stems = new Set(names.map((name) => parseSegmentFile(name)).filter((parsed) => parsed !== null).map((parsed) => parsed!.stem))
          for (const segment of segments.values()) stems.add(segment.stem)
          await Promise.all([...stems].map((stem) => deleteFiles(stem)))
          segments.clear()
          removeEntries(() => true)
          bodyCache.clear()
          return removed
        }
        let removed = 0
        // A copy: rewriting a segment replaces it in the map being walked.
        for (const segment of Array.from(segments.values())) {
          const inSegment = ordered.filter((entry) => entry.segment === segment)
          const keep = inSegment.filter((entry) => entry.meta.sessionId !== sessionId)
          if (keep.length === inSegment.length) continue
          // Deltas only ever chain within one session, so dropping a whole
          // session cannot orphan any record that is kept.
          if (keep.length === 0) {
            forgetSegment(segment)
            await deleteFiles(segment.stem)
          } else {
            await rewriteSegment(segment, keep)
            removeEntries((entry) => entry.segment === segment)
          }
          removed += inSegment.length - keep.length
        }
        return removed
      }, 0)
    },

    async stats() {
      await openIndex()
      let diskBytes = 0
      for (const segment of segments.values()) diskBytes += segment.dataBytes + segment.idxBytes
      return {
        dir,
        retained: ordered.length,
        diskBytes,
        maxDiskBytes,
        oldestAt: ordered.length === 0 ? null : ordered[0].meta.startedAt,
        segments: segments.size,
        writes,
        failures,
        legacyPending,
      }
    },

    async idle() {
      await openIndex()
      await migrating
      await queue.catch(() => {})
    },

    async close() {
      closed = true
      await migrating
      await queue.catch(() => {})
      await seal()
    },
  }
}
