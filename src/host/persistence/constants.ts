/**
 * Persistence-layer constants for the durable record archive.
 *
 * @module dsh-llm-trace-plugin/host/persistence/constants
 */

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
export const DEFAULT_PRETTY_BODY_LIMIT = 500_000

/**
 * How many files a single listing page may read. Listing is one read per
 * shown record, so this bounds the cost of any one request regardless of how
 * many records are retained.
 */
export const DEFAULT_PAGE_LIMIT = 50

/**
 * Files read concurrently per batch while scanning a page.
 *
 * Large enough that the per-file I/O round trips overlap instead of running
 * end to end, small enough that the synchronous parsing between two yields
 * stays short — this is the knob that keeps one listing from monopolising
 * the event loop the web UI shares.
 */
export const SCAN_BATCH = 16

/**
 * Only files this module wrote are ever read or deleted.
 *
 * The optional middle group accepts records written before the intra-ms
 * ordinal existed, so an upgrade keeps reading them instead of ignoring the
 * user's existing history.
 */
export const RECORD_FILE = /^(\d{13,})-(?:[0-9a-f]{4}-)?[0-9a-f]{6,}\.json$/
export const TEMP_FILE = /\.tmp$/
