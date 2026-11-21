/**
 * The record store: an in-memory ring, merged live with an optional durable
 * archive, plus the fetch wrapper that feeds it.
 *
 * @module dsh-llm-trace-plugin/host/store
 */

import type { AnyWireRecord, GroupedPage, ListAllPage, ListPage, WireRecord } from '../shared/record-shape.js'
import { DEFAULT_MAX_BODY_CHARS, LIST_PAGE_CEILING, MEMORY_RING_SIZE } from './constants.js'
import { wrapFetch } from './fetch-patch.js'
import { capacity, summarizePage, summarizeRecord } from './page-grouping.js'
import { tryParseJson } from './http-utils.js'
import { createCoverageTracker, providerKeyForModelCall, providerKeyForRecord, type CoverageSnapshot, type UntracedModelCallNotice } from './coverage.js'
import type { RecordArchive } from './persistence/archive.js'
import { withParsedBodies } from './persistence/codec.js'

export interface WireTraceStoreOptions {
  /** Records held in memory at most; see MEMORY_RING_SIZE. */
  memoryRing?: number
  maxBodyChars?: number
  /** Optional durable half. When absent the store behaves as a pure in-memory ring. */
  archive?: RecordArchive | null
  /**
   * Called once per provider the first time one of its model calls reaches no
   * captured request; see `coverage.ts`. The store only reports it — deciding
   * what to say and where is the host glue's job.
   */
  onUntracedModelCall?: (notice: UntracedModelCallNotice) => void
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
  /** Narrow the clear to one session's records; absent/empty clears everything. */
  sessionId?: string
}

export interface StoreStats {
  persistence: boolean
  /** Records currently held in memory (in flight, unpersisted, or everything with persistence off). */
  memory: number
  dir?: string
  /** Records on disk. */
  retained?: number
  diskBytes?: number
  maxDiskBytes?: number
  oldestAt?: number | null
  writes?: number
  failures?: number
  legacyPending?: number
  /** Per-provider capture-health counters since process start; see coverage.ts. */
  coverage: CoverageSnapshot
}

export interface WireTraceStore {
  records: WireRecord[]
  wrapFetch(real: typeof fetch): typeof fetch
  /**
   * Report one settled model call (see `call-context.ts`'s `SettledCall`):
   * `traced` says whether any request belonging to it was captured. Fed from
   * the host glue's `llm/stream` observer; it never creates a record.
   */
  recordModelCall(provider: string | null, traced: boolean, model?: string | null): void
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
  const memoryRing = storeOptions?.memoryRing || MEMORY_RING_SIZE
  const maxBodyChars = storeOptions?.maxBodyChars || DEFAULT_MAX_BODY_CHARS
  const archive = storeOptions?.archive ?? null
  const records: WireRecord[] = []
  const coverage = createCoverageTracker({ onFirstUntracedCall: storeOptions?.onUntracedModelCall })

  function push(record: WireRecord) {
    coverage.record(providerKeyForRecord(record.provider, record.request.url), record.attributed)
    records.push(record)
    while (records.length > memoryRing) records.shift()
  }

  /**
   * Stamp a record's end time and hand it to the archive.
   *
   * Persistence happens ONCE, here, at the record's final state — never at
   * push time: a record is mutated after it is pushed (the response body is
   * mirrored asynchronously), so writing on push would persist an empty body.
   *
   * Once the archive has it, the record leaves memory: the archive's index
   * serves it from then on, and a ring of finished multi-megabyte bodies is
   * exactly the memory this avoids holding. A record the archive declines
   * (housekeeping requests, or a failed write) stays in the ring.
   *
   * Never awaited by the caller: capturing must not add latency to a model
   * call, and a failing disk must not fail a request.
   */
  function finalize(record: WireRecord) {
    record.endedAt = Date.now()
    record.durationMs = record.endedAt - record.startedAt
    if (archive === null) return
    void archive.save(record).then((saved) => {
      if (!saved) return
      const at = records.indexOf(record)
      if (at !== -1) records.splice(at, 1)
    })
  }

  /**
   * Apply the session filter and page window to the in-memory ring.
   *
   * The filter runs BEFORE the window, not after: windowing first would let a
   * busy neighbouring session's traffic push this session's records out of
   * the page, so a quiet session could show an empty list while its records
   * were still held in the store.
   */
  function collectMemory(settings: ListOptions): { page: WireRecord[], matching: WireRecord[] } {
    const wanted = typeof settings.sessionId === 'string' && settings.sessionId.length > 0
      ? settings.sessionId
      : null
    const matching = wanted === null ? records : records.filter((record) => record.sessionId === wanted)
    const cap = capacity(settings.limit, LIST_PAGE_CEILING)
    return { page: matching.slice(Math.max(0, matching.length - cap)), matching }
  }

  return {
    records,

    wrapFetch(real) {
      return wrapFetch(real, { maxBodyChars, push, finalize })
    },

    recordModelCall(provider, traced, model = null) {
      coverage.recordModelCall(providerKeyForModelCall(provider), traced, model)
    },

    /**
     * List record summaries from memory only, newest first, optionally
     * narrowed to one session.
     */
    list(options) {
      const settings: ListOptions = typeof options === 'number' ? { limit: options } : (options ?? {})
      const memory = collectMemory(settings)
      const grouped: GroupedPage = summarizePage(memory.page, summarizeRecord)
      return { ...grouped, total: records.length, matched: memory.matching.length }
    },

    /**
     * List records from memory AND disk as one seamless page, newest first.
     *
     * Where a record happens to be stored is an implementation detail, not
     * something a reader should have to think about. Memory supplies
     * liveness (calls still streaming); the archive's in-memory index
     * supplies everything finished — so merging costs no disk read at all.
     * The two are keyed by id and the live copy wins.
     *
     * `memoryOnly` is the viewer's fast path. It only differs from a full
     * read while the archive's index is still loading at startup: then it
     * answers from memory at once and says history is pending, instead of
     * waiting for the index.
     */
    async listAll(options): Promise<ListAllPage> {
      const settings = options ?? {}
      const memory = collectMemory(settings)

      if (archive === null || (settings.memoryOnly === true && !archive.isReady())) {
        const grouped = summarizePage(memory.page, summarizeRecord)
        return {
          ...grouped,
          total: records.length,
          matched: memory.matching.length,
          persistence: archive !== null,
          truncated: false,
          historyPending: archive !== null,
        }
      }

      const cap = capacity(settings.limit, LIST_PAGE_CEILING)
      const page = await archive.list({ limit: cap, sessionId: settings.sessionId })

      // Archive first so the live copy of a shared id overwrites the stored one.
      const merged = new Map<string, AnyWireRecord>()
      for (const record of page.records) merged.set(record.id, record)
      for (const record of memory.page) merged.set(record.id, record)

      // Chronological, oldest first — the order summarizePage expects. Ids
      // settle ties within one millisecond (see `buildRecordId`).
      const ordered = [...merged.values()].sort((a, b) => {
        if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      const windowed = ordered.slice(Math.max(0, ordered.length - cap))

      // Memory records the archive does not hold (in flight, or never
      // persisted) add to its counts.
      const onlyInMemory = (list: WireRecord[]) => list.reduce((n, record) => n + (archive.has(record.id) ? 0 : 1), 0)
      const grouped = summarizePage(windowed, summarizeRecord)
      return {
        ...grouped,
        total: page.total + onlyInMemory(records),
        matched: page.matched + onlyInMemory(memory.matching),
        persistence: true,
        truncated: false,
        historyPending: false,
      }
    },

    async stats() {
      if (archive === null) return { persistence: false, memory: records.length, coverage: coverage.snapshot() }
      return { persistence: true, memory: records.length, ...(await archive.stats()), coverage: coverage.snapshot() }
    },

    /**
     * Look up one record: memory first, then disk. Both come out with their
     * `bodyJson` parses attached (see `withParsedBodies`): in-memory records
     * carry `bodyJson: null` by design (see fetch-patch.ts), so exactly the
     * records a reader actually opens get parsed, one at a time.
     */
    async get(id) {
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].id === id) return withParsedBodies(records[i], tryParseJson)
      }
      if (archive === null) return null
      return archive.get(id, tryParseJson)
    },

    /**
     * Clear memory, and by default the persisted copies too — otherwise
     * "clear" would visibly un-clear itself on the next restart.
     *
     * `sessionId` narrows both halves to one session's records, for the Wire
     * Trace tab's own "Clear" button; absent/empty clears everything, for
     * the plugin management page's "clear all history" button.
     */
    async clear(options) {
      const sessionId = typeof options?.sessionId === 'string' && options.sessionId.length > 0
        ? options.sessionId
        : null
      let removed: number
      if (sessionId === null) {
        removed = records.length
        records.length = 0
      } else {
        const before = records.length
        for (let i = records.length - 1; i >= 0; i -= 1) {
          if (records[i].sessionId === sessionId) records.splice(i, 1)
        }
        removed = before - records.length
      }
      let removedFiles = 0
      if (archive !== null && !(options && options.keepPersisted)) {
        removedFiles = await archive.clear(sessionId === null ? undefined : { sessionId })
      }
      return { removed, removedFiles }
    },
  }
}
