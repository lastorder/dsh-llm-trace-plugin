/**
 * @deepseek-ai/dsh LLM wire trace plugin — durable record store.
 *
 * Records live in a process-global ring buffer that dies with the process,
 * which is exactly wrong for a debugging tool: the traces you most want are
 * the ones from the run that just crashed. This module gives them a disk
 * home, under a deliberate constraint — NO SHARED MUTABLE FILE.
 *
 * Every record is one self-contained JSON file, written once and never
 * rewritten:
 *
 *     <dir>/<startedAt-ms>-<random>.json
 *
 * That single choice removes concurrency control entirely. The alternative —
 * one appended JSONL file — is safe for the appends themselves (line-sized
 * writes land intact) but NOT for the periodic rewrite that enforces the
 * retention cap: two processes compacting one file can drop each other's
 * records. With a file per record there is nothing to compact, so:
 *
 *   - Writing is `write temp` + `rename`, which is atomic on POSIX. A reader
 *     sees a complete file or no file, never a half-written one.
 *   - Retention is `unlink` of the oldest names. Two processes racing to
 *     delete the same file is harmless: the loser gets ENOENT, which is
 *     ignored. No lock, no per-process files, no merge-on-read.
 *   - A hard kill leaves at worst an orphan `.tmp` file, swept on next start.
 *     There is no truncated trailing line to detect and skip.
 *
 * The filename carries the timestamp so that ordering and retention are pure
 * NAME operations: listing the newest page is a `readdir` + sort + slice that
 * opens no files at all. Only the records actually shown get read.
 *
 * The cost of this design is that there is no index, so listing a page costs
 * one read per record on that page (not per record retained). That is the
 * deliberate trade: a bounded per-page cost in exchange for never
 * reintroducing shared mutable state.
 *
 * @module dsh-llm-trace-plugin/persistence
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'

/**
 * Retained record files.
 *
 * Balanced against `maxBodyChars`: bodies large enough to matter make each
 * record heavy, so the count is what keeps the directory bounded.
 */
export const DEFAULT_MAX_PERSISTED = 300

/**
 * Above this body size, the readability copy (`bodyJson`) is not written.
 *
 * That copy exists so a stored record is browsable in a text editor — but no
 * editor renders a multi-megabyte body usefully anyway, so past this point it
 * buys nothing while still doubling the bytes on disk. Small bodies, which are
 * the ones actually worth opening by hand, keep it.
 */
export const DEFAULT_PRETTY_BODY_LIMIT = 500000

/**
 * How many files a single listing page may read. Listing is one read per
 * shown record, so this bounds the cost of any one request regardless of how
 * many records are retained.
 */
export const DEFAULT_PAGE_LIMIT = 50

/**
 * Only files this module wrote are ever read or deleted.
 *
 * The optional middle group accepts records written before the intra-ms
 * ordinal existed, so an upgrade keeps reading them instead of ignoring the
 * user's existing history.
 */
const RECORD_FILE = /^(\d{13,})-(?:[0-9a-f]{4}-)?[0-9a-f]{6,}\.json$/
const TEMP_FILE = /\.tmp$/

/**
 * Intra-millisecond ordering state for `buildRecordName`. Module-level
 * because ordering only has to hold within one process: across processes the
 * random tail guarantees uniqueness, and two processes' records interleave by
 * timestamp anyway.
 */
let lastStampMs = -1
let intraMs = 0

/**
 * Resolve the directory records are stored in, honouring `$DSH_HOME` so trace
 * data sits beside the harness's own data rather than in a second location.
 * @param {string} [explicit] - caller-configured directory, which wins outright.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {string} absolute directory path.
 */
export function resolveTraceDir(explicit, env) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const source = env ?? process.env
  const home = typeof source.DSH_HOME === 'string' && source.DSH_HOME.length > 0
    ? source.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'llm-wire-trace', 'records')
}

/**
 * Build the storage name for a record.
 *
 * The name must be globally unique AND sort chronologically, because it is
 * the only ordering key the archive has — nothing is read to sort a page.
 *
 * Uniqueness matters more than it looks: the in-memory id was a PER-PROCESS
 * counter (`w1`, `w2`, ...), so two harness processes would collide on
 * `w7.json` and silently overwrite each other's records — reintroducing, as
 * data loss, the very cross-process problem the file-per-record layout
 * removes.
 *
 * The name has three parts, in sort-significant order:
 *
 *   <13-digit ms> - <4-hex intra-ms counter> - <8-hex random>
 *
 * The millisecond alone is not enough: a burst can start many calls inside
 * one millisecond, and a purely random suffix would then order them
 * ARBITRARILY — losing real ordering exactly when calls are densest. The
 * counter restores order within a millisecond; the random tail keeps names
 * unique across processes, which a counter alone cannot do.
 *
 * Zero-padding keeps plain lexicographic sort equal to chronological sort,
 * which is what lets retention and paging work on names alone.
 *
 * @param {number} startedAt - epoch milliseconds the call began.
 * @returns {string} the file name, including extension.
 */
export function buildRecordName(startedAt) {
  const ms = Math.max(0, Math.floor(startedAt))
  if (ms === lastStampMs) {
    // Saturate rather than wrap: wrapping would sort a later record earlier.
    intraMs = Math.min(intraMs + 1, 0xffff)
  } else {
    lastStampMs = ms
    intraMs = 0
  }
  const stamp = String(ms).padStart(13, '0')
  const ordinal = intraMs.toString(16).padStart(4, '0')
  return `${stamp}-${ordinal}-${randomBytes(4).toString('hex')}.json`
}

/** Recover the record id (the name without extension) from a file name. */
function idFromName(name) {
  return name.slice(0, -'.json'.length)
}

/**
 * Best-effort parse used only to make a stored body readable. Never throws.
 * @param {string | null | undefined} text - candidate JSON text.
 */
function parseForDisplay(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    const value = JSON.parse(text)
    // Only a container is worth expanding; a bare string or number would just
    // duplicate `bodyText` with no readability gain.
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * Whether a body is too large for the readability copy to be worth its bytes.
 * @param {string | null | undefined} text
 * @param {number} limit
 */
function tooBigToPrettify(text, limit) {
  return typeof text === 'string' && text.length > limit
}

/** Wrap a parsed body so an absent parse contributes no key at all. */
function withBodyJson(value) {
  return value === null ? {} : { bodyJson: value }
}

/** @param {string | null | undefined} contentType */
function isEventStream(contentType) {
  return typeof contentType === 'string' && contentType.includes('event-stream')
}

/**
 * Strip a record down to what is worth persisting, and — critically — to
 * plain owned data.
 *
 * `bodyText` is the authoritative form: the literal bytes on the wire, which
 * is the whole point of this plugin. But it is a JSON *string*, so on disk it
 * is one long escaped line that no editor can render usefully. So a parsed
 * `bodyJson` is written ALONGSIDE it, purely so the file is readable — the
 * request's `messages`, tools, and the response object expand as real nested
 * JSON instead of `\"role\":\"user\"` noise.
 *
 * It is a derived convenience copy, never the source of truth: reading
 * re-derives `bodyJson` from `bodyText` regardless, so a stored parse that is
 * absent, stale, or malformed cannot corrupt what the viewer shows. The cost
 * is roughly double the body bytes on disk, which is why `bodyJson` is
 * omitted whenever it would add nothing.
 *
 * @param {object} record - a live in-memory record.
 * @returns {object} an owned, serializable copy.
 */
export function toPersisted(record, prettyLimit) {
  const request = record.request ?? {}
  const response = record.response ?? null
  const limit = typeof prettyLimit === 'number' ? prettyLimit : DEFAULT_PRETTY_BODY_LIMIT
  return {
    v: 1,
    id: record.id,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    durationMs: record.durationMs ?? null,
    status: record.status ?? null,
    model: record.model ?? null,
    sessionId: record.sessionId ?? null,
    turn: typeof record.turn === 'number' ? record.turn : null,
    step: typeof record.step === 'number' ? record.step : null,
    purpose: record.purpose ?? null,
    provider: record.provider ?? null,
    requestedModel: record.requestedModel ?? null,
    attributed: record.attributed === true,
    request: {
      method: request.method ?? null,
      url: request.url ?? null,
      headers: request.headers ?? {},
      bodyText: request.bodyText ?? null,
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
      // Readability copy; see toPersisted's note. Omitted when it would not
      // help (unparseable, truncated mid-JSON, or not a container).
      ...(request.bodyTruncated === true || tooBigToPrettify(request.bodyText, limit)
        ? {}
        : withBodyJson(parseForDisplay(request.bodyText))),
    },
    response: response === null ? null : {
      status: response.status ?? null,
      statusText: response.statusText ?? null,
      headers: response.headers ?? {},
      contentType: response.contentType ?? null,
      bodyText: response.bodyText ?? null,
      bodyChars: response.bodyChars ?? 0,
      bodyTruncated: response.bodyTruncated === true,
      // An SSE body is a sequence of frames, not one JSON value, so it is
      // never parsed as a whole — matching the capture-time rule exactly.
      ...(response.bodyTruncated === true
        || isEventStream(response.contentType)
        || tooBigToPrettify(response.bodyText, limit)
        ? {}
        : withBodyJson(parseForDisplay(response.bodyText))),
    },
    error: record.error ?? null,
    recorderError: record.recorderError ?? null,
  }
}

/**
 * Rebuild a viewer-shaped record from its persisted form, restoring the
 * `bodyJson` parses that `toPersisted` dropped so a restored record is
 * indistinguishable from a live one to every consumer.
 *
 * @param {object} stored - parsed file contents.
 * @param {(text: string | null) => unknown} parseJson - best-effort JSON parser.
 * @returns {object} a record in the same shape the in-memory store holds.
 */
export function fromPersisted(stored, parseJson) {
  const response = stored.response ?? null
  const contentType = response && response.contentType
  return {
    ...stored,
    persisted: true,
    request: {
      ...stored.request,
      // Always re-derived from `bodyText`, which OVERWRITES any `bodyJson`
      // spread in from the file. That copy exists only to make the file
      // readable; the wire text stays the single source of truth, so a stale
      // or hand-edited parse on disk can never change what the viewer shows.
      bodyJson: parseJson(stored.request ? stored.request.bodyText : null),
    },
    response: response === null ? null : {
      ...response,
      // SSE bodies are a frame sequence, never one JSON value — matching the
      // capture-time rule so a restored record parses exactly as it did live.
      bodyJson: contentType && contentType.includes('event-stream')
        ? null
        : parseJson(response.bodyText),
    },
  }
}

/**
 * Create the durable store.
 *
 * Every method resolves rather than rejects on I/O failure: persistence is a
 * convenience layered under a debugging tool, and must never be able to break
 * capture or the viewer. Failures are counted and surfaced via `stats()`.
 *
 * @param {{ dir?: string, maxRecords?: number, pageLimit?: number, prettyBodyLimit?: number, onError?: (error: Error) => void }} [options]
 */
export function createRecordArchive(options) {
  const settings = options ?? {}
  const dir = resolveTraceDir(settings.dir)
  const maxRecords = settings.maxRecords ?? DEFAULT_MAX_PERSISTED
  const pageLimit = settings.pageLimit ?? DEFAULT_PAGE_LIMIT
  const prettyLimit = settings.prettyBodyLimit ?? DEFAULT_PRETTY_BODY_LIMIT
  const onError = typeof settings.onError === 'function' ? settings.onError : () => {}

  let ready = null
  let writes = 0
  let failures = 0
  /** Serializes retention passes within this process; cross-process is safe by construction. */
  let sweeping = false
  let sinceSweep = 0

  function fail(error) {
    failures += 1
    try {
      onError(error instanceof Error ? error : new Error(String(error)))
    } catch {
      // A reporting failure must not escalate into a capture failure.
    }
  }

  /** Create the directory once, and remember the attempt (success or not). */
  function ensureDir() {
    if (ready === null) {
      ready = mkdir(dir, { recursive: true }).then(() => true).catch((error) => {
        fail(error)
        return false
      })
    }
    return ready
  }

  /**
   * Names of every stored record, oldest first. Sorting by name is sorting by
   * time, so this opens no files.
   * @returns {Promise<string[]>}
   */
  async function listNames() {
    try {
      const entries = await readdir(dir)
      return entries.filter((name) => RECORD_FILE.test(name)).sort()
    } catch (error) {
      // A missing directory simply means nothing has been persisted yet.
      if (error && error.code === 'ENOENT') return []
      fail(error)
      return []
    }
  }

  /**
   * Read and rehydrate one record by id, or null when it is absent or
   * unreadable (a torn file from an unclean kill is skipped, not fatal).
   */
  async function readRecord(id, parseJson) {
    if (!RECORD_FILE.test(`${id}.json`)) return null
    try {
      const text = await readFile(join(dir, `${id}.json`), 'utf8')
      return fromPersisted(JSON.parse(text), parseJson)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') fail(error)
      return null
    }
  }

  /**
   * Enforce the retention cap by deleting the oldest names.
   *
   * Racing another process here is harmless: both compute an overlapping
   * oldest set, and a double delete surfaces as ENOENT, which is ignored.
   */
  async function sweep(force) {
    if (sweeping) return
    // Amortize: a readdir per record would dominate the cost of writing one.
    if (!force && sinceSweep < 50) return
    sweeping = true
    sinceSweep = 0
    try {
      const names = await listNames()
      const excess = names.length - maxRecords
      if (excess > 0) {
        await Promise.all(names.slice(0, excess).map(async (name) => {
          try {
            await unlink(join(dir, name))
          } catch (error) {
            if (!error || error.code !== 'ENOENT') fail(error)
          }
        }))
      }
    } finally {
      sweeping = false
    }
  }

  return {
    dir,
    maxRecords,

    /**
     * Persist one finished record. Resolves even on failure.
     *
     * Written to a unique temp name then renamed, so a concurrent reader
     * never observes a partial file and an interrupted write leaves only an
     * orphan temp file rather than a corrupt record.
     *
     * @param {object} record - the live record, in its final state.
     */
    async save(record) {
      if (!(await ensureDir())) return false
      const name = `${record.id}.json`
      if (!RECORD_FILE.test(name)) {
        fail(new Error(`refusing to persist malformed record id "${record.id}"`))
        return false
      }
      const target = join(dir, name)
      const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`
      try {
        // Indented so the file is readable when opened in an editor. The
        // extra whitespace is cheap next to the bodies themselves.
        await writeFile(temp, JSON.stringify(toPersisted(record, prettyLimit), null, 2), 'utf8')
        await rename(temp, target)
        writes += 1
        sinceSweep += 1
        // Retention runs behind the write; never block the caller on it.
        void sweep(false)
        return true
      } catch (error) {
        fail(error)
        try {
          await unlink(temp)
        } catch {
          // Best-effort cleanup; a leftover temp file is swept at next start.
        }
        return false
      }
    },

    /**
     * Read one page of records, newest first, optionally narrowed to a session.
     *
     * The session filter is applied BEFORE the page window, matching the
     * in-memory store: windowing first would let a busy neighbouring
     * session's traffic push a quiet session's records out of the page.
     *
     * Because filtering needs fields that live inside the files, a filtered
     * read scans backwards from the newest, reading until the page is full or
     * a bounded scan budget is exhausted. That keeps a single request's cost
     * bounded rather than proportional to everything retained.
     *
     * @param {{ limit?: number, sessionId?: string, parseJson?: (text: string | null) => unknown }} [query]
     */
    async list(query) {
      const request = query ?? {}
      const parseJson = request.parseJson ?? (() => null)
      const wanted = typeof request.sessionId === 'string' && request.sessionId.length > 0
        ? request.sessionId
        : null
      const cap = typeof request.limit === 'number' && request.limit > 0
        ? Math.min(request.limit, pageLimit)
        : pageLimit

      const names = await listNames()
      const total = names.length
      // Bound the work of a filtered scan: at most this many files are opened
      // even when the filter matches nothing.
      const budget = Math.max(cap, Math.min(total, pageLimit * 4))

      const found = []
      let scanned = 0
      for (let i = names.length - 1; i >= 0 && found.length < cap && scanned < budget; i -= 1) {
        scanned += 1
        const record = await readRecord(idFromName(names[i]), parseJson)
        if (record === null) continue
        if (wanted !== null && record.sessionId !== wanted) continue
        found.push(record)
      }

      return {
        records: found,
        total,
        scanned,
        // True when older records exist that this bounded scan did not reach,
        // so the viewer can say so rather than implying it showed everything.
        truncated: scanned >= budget && found.length < cap && scanned < total,
      }
    },

    get(id, parseJson) {
      return readRecord(id, parseJson ?? (() => null))
    },

    /**
     * Load the newest records back into memory at startup, and sweep away any
     * orphan temp files left by an unclean shutdown.
     * @param {{ limit?: number, parseJson?: (text: string | null) => unknown }} [query]
     */
    async restore(query) {
      const request = query ?? {}
      await ensureDir()
      void this.sweepTemp()
      const page = await this.list({ limit: request.limit, parseJson: request.parseJson })
      // Oldest first: the in-memory ring is chronological, newest at the end.
      return page.records.slice().reverse()
    },

    /** Remove temp files stranded by a crash mid-write. */
    async sweepTemp() {
      try {
        const entries = await readdir(dir)
        await Promise.all(entries.filter((name) => TEMP_FILE.test(name)).map(async (name) => {
          try {
            await unlink(join(dir, name))
          } catch {
            // ignore
          }
        }))
      } catch {
        // Nothing to sweep when the directory is absent.
      }
    },

    /** Delete every persisted record. Returns how many files were removed. */
    async clear() {
      const names = await listNames()
      let removed = 0
      await Promise.all(names.map(async (name) => {
        try {
          await unlink(join(dir, name))
          removed += 1
        } catch (error) {
          if (!error || error.code !== 'ENOENT') fail(error)
        }
      }))
      await this.sweepTemp()
      return removed
    },

    /** Force a retention pass; exposed for tests and shutdown. */
    sweep() {
      return sweep(true)
    },

    async stats() {
      const names = await listNames()
      return { dir, retained: names.length, maxRecords, writes, failures }
    },
  }
}
