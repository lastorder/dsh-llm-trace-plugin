/**
 * Persistence-layer constants for the durable record archive.
 *
 * @module dsh-llm-trace-plugin/host/persistence/constants
 */

/**
 * Default disk budget, in megabytes, for everything under the trace directory.
 *
 * A budget rather than a record count, because record sizes differ by four
 * orders of magnitude (a 2 KB title call next to a 1.6 MB agent request) — a
 * count either wastes the disk or evicts real history. With delta encoding
 * (see codec.ts) a typical agent step costs tens of kilobytes, so 1 GB holds
 * tens of thousands of calls.
 */
export const DEFAULT_MAX_DISK_MB = 1024

/** Smallest budget the config accepts; below this the segment granularity stops making sense. */
export const MIN_MAX_DISK_MB = 16

/**
 * Segment size bounds. The target is `budget / SEGMENTS_PER_BUDGET`, clamped
 * to these, so retention — which deletes whole segments — never overshoots
 * the budget by more than a small fraction of it.
 */
export const MIN_SEGMENT_BYTES = 1 * 1024 * 1024
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024
export const SEGMENTS_PER_BUDGET = 16

/**
 * Longest delta chain a request body may sit at the end of.
 *
 * Reading a delta-encoded body means reading its base first, recursively, so
 * the chain length bounds the cost of opening one record. A fresh full copy
 * (a "keyframe") every this many steps keeps that cost flat, at the price of
 * one full body per this many calls of a session.
 */
export const MAX_DELTA_CHAIN = 32

/** Below this many characters a body is stored whole: a delta would save nothing worth the indirection. */
export const MIN_DELTA_CHARS = 4096

/**
 * Conversations whose previous request is kept for delta encoding, per
 * writer. Each holds one request body in memory, so this bounds that cost.
 */
export const MAX_DELTA_LANES = 8

/** Reconstructed request bodies kept for sequential reads (the viewer opens neighbours). */
export const BODY_CACHE_ENTRIES = 6

/** Brotli settings: quality 5 is ~10x faster than the maximum for a few percent more bytes. */
export const BROTLI_QUALITY = 5
export const BROTLI_WINDOW_BITS = 24

/** How often a list call may re-scan the directory for segments other processes wrote. */
export const RESCAN_INTERVAL_MS = 5000
