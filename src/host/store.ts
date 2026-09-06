/**
 * The record store: an in-memory ring, merged live with an optional durable
 * archive, plus the fetch wrapper that feeds it.
 *
 * @module dsh-llm-trace-plugin/host/store
 */

import type { AnyWireRecord, GroupedPage, ListAllPage, ListPage, WireRecord } from '../shared/record-shape.js'
import { ARCHIVE_CACHE_TTL_MS, DEFAULT_MAX_BODY_CHARS, DEFAULT_MAX_RECORDS, LIST_PAGE_CEILING } from './constants.js'
import { wrapFetch } from './fetch-patch.js'
import { capacity, summarizePage, summarizeRecord } from './page-grouping.js'
import { tryParseJson } from './http-utils.js'
import type { ArchiveListResult, RecordArchive } from './persistence/archive.js'

export interface WireTraceStoreOptions {
  maxRecords?: number
  maxBodyChars?: number
  /** Optional durable half. When absent the store behaves as a pure in-memory ring. */
  archive?: RecordArchive | null
}

export interface ListOptions {
  limit?: number
  sessionId?: string
}

export interface ListAllOptions extends ListOptions {
  /** Read the in-memory ring only, skipping the (slower) archive read. */
  memoryOnly?: boolean
}

export interface ClearOptions {
  keepPersisted?: boolean
}

export interface StoreStats {
  persistence: boolean
  memory: number
  dir?: string
  retained?: number
  maxRecords?: number
  writes?: number
  failures?: number
}

export interface WireTraceStore {
  records: WireRecord[]
  wrapFetch(real: typeof fetch): typeof fetch
  list(options?: ListOptions | number): ListPage
  listAll(options?: ListAllOptions): Promise<ListAllPage>
  stats(): Promise<StoreStats>
  get(id: string): Promise<WireRecord | null>
  clear(options?: ClearOptions): Promise<{ removed: number, removedFiles: number }>
}

/**
 * Create the record store and the fetch wrapper that feeds it. Kept
 * dependency-free of any web/route concerns so it can be unit-tested against
 * a fake `fetch`.
 */
export function createWireTraceStore(storeOptions?: WireTraceStoreOptions): WireTraceStore {
  const maxRecords = storeOptions?.maxRecords || DEFAULT_MAX_RECORDS
  const maxBodyChars = storeOptions?.maxBodyChars || DEFAULT_MAX_BODY_CHARS
  const archive = storeOptions?.archive ?? null
  const records: WireRecord[] = []

  function push(record: WireRecord) {
    records.push(record)
    while (records.length > maxRecords) records.shift()
  }

  /**
   * Stamp a record's end time and hand it to the archive.
   *
   * Persistence happens ONCE, here, at the record's final state — never at
   * push time. A record is mutated after it is pushed (the response body is
   * mirrored asynchronously), so writing on push would persist a record whose
   * body is still empty, and the file-per-record layout deliberately has no
   * rewrite step that could later fix it up.
   *
   * Never awaited by the caller: capturing must not add latency to a model
   * call, and a failing disk must not fail a request.
   */
  function finalize(record: WireRecord) {
    record.endedAt = Date.now()
    record.durationMs = record.endedAt - record.startedAt
    if (archive !== null) void archive.save(record)
  }

  /**
   * Apply the session filter and page window to the in-memory ring.
   *
   * The filter runs BEFORE the window, not after: windowing first would let a
   * busy neighbouring session's traffic push this session's records out of
   * the page, so a quiet session could show an empty list while its records
   * were still held in the store.
   */
  function collectMemory(settings: ListOptions): { page: WireRecord[], matched: number } {
    const wanted = typeof settings.sessionId === 'string' && settings.sessionId.length > 0
      ? settings.sessionId
      : null
    const matching = wanted === null ? records : records.filter((record) => record.sessionId === wanted)
    const cap = capacity(settings.limit, LIST_PAGE_CEILING)
    return { page: matching.slice(Math.max(0, matching.length - cap)), matched: matching.length }
  }

  /**
   * Read a page from the archive, collapsing repeat reads within a short
   * window onto one disk scan.
   *
   * Two callers make this worth having: a viewer that refreshes, and several
   * browser tabs watching at once. Both otherwise re-scan the same files
   * seconds apart for a result that cannot have meaningfully changed.
   *
   * Only the ARCHIVE half is cached, never the merged page. In-flight records
   * live in memory and are re-collected on every call, then layered over this
   * result, so a streaming response still updates at full speed — the cache
   * can only ever delay a record already finalised and written.
   *
   * The promise is cached rather than its value, so concurrent callers share
   * one scan instead of each starting their own.
   */
  let archiveCache: { key: string, at: number, promise: Promise<ArchiveListResult> } | null = null

  function listArchive(settings: ListOptions): Promise<ArchiveListResult> {
    const key = `${settings.sessionId ?? ''}|${capacity(settings.limit, LIST_PAGE_CEILING)}`
    const now = Date.now()
    if (archiveCache !== null && archiveCache.key === key && now - archiveCache.at < ARCHIVE_CACHE_TTL_MS) {
      return archiveCache.promise
    }
    const promise = archive!.list({
      limit: settings.limit,
      sessionId: settings.sessionId,
      parseJson: tryParseJson,
    }).catch((error) => {
      // Never serve one failure for the rest of the TTL.
      if (archiveCache !== null && archiveCache.promise === promise) archiveCache = null
      throw error
    })
    archiveCache = { key, at: now, promise }
    return promise
  }

  /** Drop the cached page so the next read sees disk as it is now. */
  function invalidateArchiveCache() {
    archiveCache = null
  }

  /**
   * Attach the `bodyJson` parses a detail view needs, derived from the record's
   * own `bodyText`.
   *
   * In-memory records carry `bodyJson: null` by design (see fetch-patch.ts):
   * parsing at capture time cost a multi-megabyte `JSON.parse` on the hot path
   * and then held the result for the life of the ring, for a field only the
   * detail view ever reads. Deriving it here means exactly the records a
   * reader actually opens get parsed, one at a time.
   *
   * This mirrors `fromPersisted` in the persistence codec, so a live record
   * and a restored one are indistinguishable to every consumer — including the
   * rule that an SSE body is a frame sequence and never one JSON value.
   */
  function hydrateBodies(record: WireRecord): WireRecord {
    const contentType = record.response === null ? null : record.response.contentType
    const isEventStream = typeof contentType === 'string' && contentType.includes('event-stream')
    return {
      ...record,
      request: { ...record.request, bodyJson: tryParseJson(record.request.bodyText) },
      response: record.response === null ? null : {
        ...record.response,
        bodyJson: isEventStream ? null : tryParseJson(record.response.bodyText),
      },
    }
  }

  return {
    records,

    wrapFetch(real) {
      return wrapFetch(real, { maxBodyChars, push, finalize })
    },

    /**
     * List record summaries, newest first, optionally narrowed to one session.
     * `total` is every record held; `matched` is how many passed the filter
     * (equal to `total` when unfiltered).
     */
    list(options) {
      const settings: ListOptions = typeof options === 'number' ? { limit: options } : (options ?? {})
      const memory = collectMemory(settings)
      const grouped: GroupedPage = summarizePage(memory.page, summarizeRecord)
      return { ...grouped, total: records.length, matched: memory.matched }
    },

    /**
     * List records from memory AND disk as one seamless page, newest first.
     *
     * Where a record happens to be stored is an implementation detail, not
     * something a reader should have to think about — so this merges the two
     * rather than exposing them as separate views. Memory supplies liveness
     * (in-flight `streaming` records that no final file exists for yet); disk
     * supplies depth (everything older than the small in-memory ring, and
     * everything from before the last restart).
     *
     * A record near the head exists in BOTH, so the two are keyed by id and
     * the in-memory copy wins: it is the same record, but it is the one still
     * being mutated as its response body streams in.
     *
     * `memoryOnly` serves the viewer's fast path: reading the ring touches no
     * disk at all, so the tab can paint immediately and poll cheaply, then
     * fold in history from a second, slower call. `persistence` still reports
     * whether an archive exists, so a caller can tell "history has not
     * arrived yet" apart from "persistence is off".
     */
    async listAll(options): Promise<ListAllPage> {
      const settings = options ?? {}
      const memory = collectMemory(settings)

      if (archive === null || settings.memoryOnly === true) {
        const grouped = summarizePage(memory.page, summarizeRecord)
        return {
          ...grouped,
          total: records.length,
          matched: memory.matched,
          persistence: archive !== null,
          // The ring is the whole world here, so nothing was skipped.
          truncated: false,
          historyPending: archive !== null,
        }
      }

      const page = await listArchive(settings)

      // Disk first so the live copy of a shared id overwrites the stored one.
      const merged = new Map<string, AnyWireRecord>()
      for (const record of page.records) merged.set(record.id, record)
      for (const record of memory.page) merged.set(record.id, record)

      // Chronological, oldest first — the order summarizePage expects.
      // Sort by id, not by `startedAt` alone: many calls can start within one
      // millisecond, and a millisecond-only comparison leaves their order
      // arbitrary. The id is `<ms>-<ordinal>-<random>`, built precisely to
      // sort chronologically, so it settles ties the timestamp cannot.
      const ordered = [...merged.values()].sort((a, b) => {
        if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const cap = capacity(settings.limit, LIST_PAGE_CEILING)
      const windowed = ordered.slice(Math.max(0, ordered.length - cap))

      const grouped = summarizePage(windowed, summarizeRecord)
      return {
        ...grouped,
        // Disk holds every record that memory does, so its count is the total.
        total: Math.max(page.total, records.length),
        matched: merged.size,
        persistence: true,
        truncated: page.truncated,
        historyPending: false,
      }
    },

    async stats() {
      if (archive === null) return { persistence: false, memory: records.length }
      return { persistence: true, memory: records.length, ...(await archive.stats()) }
    },

    /**
     * Look up one record: memory first, then disk. The disk fallback is what
     * makes a restored row's detail view, and its curl command, keep working
     * after the record has aged out of the ring.
     *
     * A memory hit is hydrated on the way out (see `hydrateBodies`); the
     * archive path already re-derives its own parses in `fromPersisted`.
     */
    async get(id) {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].id === id) return hydrateBodies(records[i])
      }
      if (archive === null) return null
      return archive.get(id, tryParseJson)
    },

    /**
     * Clear memory, and by default the persisted copies too — otherwise
     * "clear" would visibly un-clear itself on the next restart.
     */
    async clear(options) {
      const removed = records.length
      records.length = 0
      let removedFiles = 0
      if (archive !== null && !(options && options.keepPersisted)) {
        removedFiles = await archive.clear()
      }
      // A cached page would otherwise keep serving records that no longer
      // exist, making "clear" look like it silently failed.
      invalidateArchiveCache()
      return { removed, removedFiles }
    },
  }
}
