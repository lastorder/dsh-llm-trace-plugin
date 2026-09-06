/**
 * Durable, file-per-record store for wire trace records.
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
 * @module dsh-llm-trace-plugin/host/persistence/archive
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MAX_PERSISTED, DEFAULT_PAGE_LIMIT, DEFAULT_PRETTY_BODY_LIMIT, RECORD_FILE, SCAN_BATCH, TEMP_FILE, } from './constants.js';
import { fromPersisted, toMeta, toPersisted } from './codec.js';
import { idFromName, resolveTraceDir } from './naming.js';
/**
 * Yield to the event loop so pending I/O callbacks (the UI's own requests)
 * get a turn. `setImmediate` runs after the poll phase, so anything already
 * readable is serviced before the next batch starts.
 */
function yieldToLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
/**
 * Create the durable store.
 *
 * Every method resolves rather than rejects on I/O failure: persistence is a
 * convenience layered under a debugging tool, and must never be able to break
 * capture or the viewer. Failures are counted and surfaced via `stats()`.
 */
export function createRecordArchive(options) {
    const settings = options ?? {};
    const dir = resolveTraceDir(settings.dir);
    const maxRecords = settings.maxRecords ?? DEFAULT_MAX_PERSISTED;
    const pageLimit = settings.pageLimit ?? DEFAULT_PAGE_LIMIT;
    const prettyLimit = settings.prettyBodyLimit ?? DEFAULT_PRETTY_BODY_LIMIT;
    const onError = typeof settings.onError === 'function' ? settings.onError : () => { };
    let ready = null;
    let writes = 0;
    let failures = 0;
    /** Serializes retention passes within this process; cross-process is safe by construction. */
    let sweeping = false;
    let sinceSweep = 0;
    function fail(error) {
        failures += 1;
        try {
            onError(error instanceof Error ? error : new Error(String(error)));
        }
        catch {
            // A reporting failure must not escalate into a capture failure.
        }
    }
    /** Create the directory once, and remember the attempt (success or not). */
    function ensureDir() {
        if (ready === null) {
            ready = mkdir(dir, { recursive: true }).then(() => true).catch((error) => {
                fail(error);
                return false;
            });
        }
        return ready;
    }
    /**
     * Names of every stored record, oldest first. Sorting by name is sorting by
     * time, so this opens no files.
     */
    async function listNames() {
        try {
            const entries = await readdir(dir);
            return entries.filter((name) => RECORD_FILE.test(name)).sort();
        }
        catch (error) {
            // A missing directory simply means nothing has been persisted yet.
            if (error && error.code === 'ENOENT')
                return [];
            fail(error);
            return [];
        }
    }
    /**
     * Read one record by id, or null when it is absent or unreadable (a torn
     * file from an unclean kill is skipped, not fatal).
     *
     * `metaOnly` exists because listing and detail want very different things
     * from the same file. A list row is built by `summary()` from ~17 scalars
     * and touches neither `bodyText` nor `bodyJson` — but the full rehydrate
     * runs `JSON.parse` over every body a SECOND time (once for the file, once
     * inside `fromPersisted`) only to throw the result away. Bodies are the
     * bulk of a record and `JSON.parse` is synchronous, so on the event loop
     * this process shares with the web UI that second parse is what stalls the
     * page. `metaOnly` skips it and never touches the body text at all.
     *
     * Detail reads keep the full path: `get()` genuinely needs `bodyJson`.
     */
    async function readRecord(id, parseJson, metaOnly) {
        if (!RECORD_FILE.test(`${id}.json`))
            return null;
        try {
            const text = await readFile(join(dir, `${id}.json`), 'utf8');
            const stored = JSON.parse(text);
            return metaOnly === true ? toMeta(stored) : fromPersisted(stored, parseJson);
        }
        catch (error) {
            if (!error || error.code !== 'ENOENT')
                fail(error);
            return null;
        }
    }
    /**
     * Enforce the retention cap by deleting the oldest names.
     *
     * Racing another process here is harmless: both compute an overlapping
     * oldest set, and a double delete surfaces as ENOENT, which is ignored.
     */
    async function sweep(force) {
        if (sweeping)
            return;
        // Amortize: a readdir per record would dominate the cost of writing one.
        if (!force && sinceSweep < 50)
            return;
        sweeping = true;
        sinceSweep = 0;
        try {
            const names = await listNames();
            const excess = names.length - maxRecords;
            if (excess > 0) {
                await Promise.all(names.slice(0, excess).map(async (name) => {
                    try {
                        await unlink(join(dir, name));
                    }
                    catch (error) {
                        if (!error || error.code !== 'ENOENT')
                            fail(error);
                    }
                }));
            }
        }
        finally {
            sweeping = false;
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
         */
        async save(record) {
            if (!(await ensureDir()))
                return false;
            const name = `${record.id}.json`;
            if (!RECORD_FILE.test(name)) {
                fail(new Error(`refusing to persist malformed record id "${record.id}"`));
                return false;
            }
            const target = join(dir, name);
            const temp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
            try {
                // Indented so the file is readable when opened in an editor. The
                // extra whitespace is cheap next to the bodies themselves.
                await writeFile(temp, JSON.stringify(toPersisted(record, prettyLimit), null, 2), 'utf8');
                await rename(temp, target);
                writes += 1;
                sinceSweep += 1;
                // Retention runs behind the write; never block the caller on it.
                void sweep(false);
                return true;
            }
            catch (error) {
                fail(error);
                try {
                    await unlink(temp);
                }
                catch {
                    // Best-effort cleanup; a leftover temp file is swept at next start.
                }
                return false;
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
         * Two properties matter more than raw speed, because this runs on the
         * same event loop that serves the web UI:
         *
         *   - Files are read in CONCURRENT BATCHES, not one await at a time.
         *   - Between batches the loop YIELDS via `setImmediate`. Without that, a
         *     large page is one uninterrupted block of synchronous parsing and
         *     the whole page — every session, plus the `/api` channel — freezes
         *     until it finishes.
         *
         * Reads default to metadata only: a list row never displays a body, and
         * parsing them is what made this expensive. `full: true` opts back in.
         */
        async list(query) {
            const request = query ?? {};
            const parseJson = request.parseJson ?? (() => null);
            const metaOnly = request.full !== true;
            const wanted = typeof request.sessionId === 'string' && request.sessionId.length > 0
                ? request.sessionId
                : null;
            const cap = typeof request.limit === 'number' && request.limit > 0
                ? Math.min(request.limit, pageLimit)
                : pageLimit;
            const names = await listNames();
            const total = names.length;
            // Unfiltered, every record read is a record shown, so reading past the
            // page is pure waste. Only a filtered scan needs to look further to
            // find enough matches — and even then the overshoot is bounded.
            const budget = wanted === null
                ? Math.min(cap, total)
                : Math.max(cap, Math.min(total, pageLimit * 2));
            const found = [];
            let scanned = 0;
            let cursor = names.length - 1;
            while (cursor >= 0 && found.length < cap && scanned < budget) {
                const batch = [];
                while (batch.length < SCAN_BATCH && cursor >= 0 && scanned + batch.length < budget) {
                    batch.push(names[cursor]);
                    cursor -= 1;
                }
                if (batch.length === 0)
                    break;
                scanned += batch.length;
                // Newest-first order is preserved because the batch keeps its own
                // order and batches are consumed in order.
                const read = await Promise.all(batch.map((name) => readRecord(idFromName(name), parseJson, metaOnly)));
                for (const record of read) {
                    if (found.length >= cap)
                        break;
                    if (record === null)
                        continue;
                    if (wanted !== null && record.sessionId !== wanted)
                        continue;
                    found.push(record);
                }
                // Hand the event loop back so the UI and `/api` can be served between
                // batches instead of after the entire page.
                if (cursor >= 0 && found.length < cap && scanned < budget)
                    await yieldToLoop();
            }
            return {
                records: found,
                total,
                scanned,
                // True when older records exist that this bounded scan did not reach,
                // so the viewer can say so rather than implying it showed everything.
                truncated: scanned >= budget && found.length < cap && scanned < total,
            };
        },
        get(id, parseJson) {
            return readRecord(id, parseJson ?? (() => null), false);
        },
        /**
         * Load the newest records back into memory at startup, and sweep away any
         * orphan temp files left by an unclean shutdown.
         */
        async restore(query) {
            const request = query ?? {};
            await ensureDir();
            void this.sweepTemp();
            // Full records: these repopulate the in-memory ring, whose consumers
            // (detail view, curl) expect real bodies.
            const page = await this.list({ limit: request.limit, parseJson: request.parseJson, full: true });
            // Oldest first: the in-memory ring is chronological, newest at the end.
            return page.records.slice().reverse();
        },
        /** Remove temp files stranded by a crash mid-write. */
        async sweepTemp() {
            try {
                const entries = await readdir(dir);
                await Promise.all(entries.filter((name) => TEMP_FILE.test(name)).map(async (name) => {
                    try {
                        await unlink(join(dir, name));
                    }
                    catch {
                        // ignore
                    }
                }));
            }
            catch {
                // Nothing to sweep when the directory is absent.
            }
        },
        /** Delete every persisted record. Returns how many files were removed. */
        async clear() {
            const names = await listNames();
            let removed = 0;
            await Promise.all(names.map(async (name) => {
                try {
                    await unlink(join(dir, name));
                    removed += 1;
                }
                catch (error) {
                    if (!error || error.code !== 'ENOENT')
                        fail(error);
                }
            }));
            await this.sweepTemp();
            return removed;
        },
        /** Force a retention pass; exposed for tests and shutdown. */
        sweep() {
            return sweep(true);
        },
        async stats() {
            const names = await listNames();
            return { dir, retained: names.length, maxRecords, writes, failures };
        },
    };
}
