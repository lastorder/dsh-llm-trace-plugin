/**
 * Storage naming and directory resolution: record ids, segment file names,
 * recognizing files from earlier versions, and resolving where it all lives.
 * No I/O.
 *
 * @module dsh-llm-trace-plugin/host/persistence/naming
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Intra-millisecond ordering state for `buildRecordId`. Module-level because
 * ordering only has to hold within one process: across processes the random
 * tail guarantees uniqueness, and two processes' records interleave by
 * timestamp anyway.
 */
let lastStampMs = -1
let intraMs = 0

/**
 * Resolve the directory records are stored in, honouring `$DSH_HOME` so trace
 * data sits beside the harness's own data rather than in a second location.
 * @param explicit - caller-configured directory, which wins outright.
 * @param env - environment to read.
 */
export function resolveTraceDir(explicit?: string, env?: Record<string, string | undefined>): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const source = env ?? process.env
  const home = typeof source.DSH_HOME === 'string' && source.DSH_HOME.length > 0
    ? source.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'llm-wire-trace', 'records')
}

/**
 * Build a record id: `<13-digit ms>-<4-hex intra-ms counter>-<8-hex random>`.
 *
 * The id must be globally unique AND sort chronologically: the viewer orders
 * rows that started in the same millisecond by id. The counter keeps a burst
 * of calls inside one millisecond in order; the random tail keeps ids unique
 * across processes, which a counter alone cannot do. Zero-padding keeps plain
 * lexicographic order equal to chronological order.
 *
 * @param startedAt - epoch milliseconds the call began.
 */
export function buildRecordId(startedAt: number): string {
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
  return `${stamp}-${ordinal}-${randomBytes(4).toString('hex')}`
}

/** A segment's data and index files share this stem: `<13-digit start ms>-<8-hex random>`. */
export const SEGMENT_FILE = /^(\d{13})-([0-9a-f]{8})\.(dat|idx)$/

export type SegmentFileKind = 'dat' | 'idx'

/**
 * Build a new segment's file stem. The start time leads so sorting stems is
 * sorting segments by age, which is the order retention deletes them in; the
 * random tail keeps two processes (or two segments in one millisecond) apart.
 */
export function buildSegmentStem(startMs: number): string {
  const stamp = String(Math.max(0, Math.floor(startMs))).padStart(13, '0')
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

/** Recognize a segment file, or null for anything else in the directory. */
export function parseSegmentFile(name: string): { stem: string, kind: SegmentFileKind, startMs: number } | null {
  const match = SEGMENT_FILE.exec(name)
  if (match === null) return null
  return { stem: `${match[1]}-${match[2]}`, kind: match[3] as SegmentFileKind, startMs: Number(match[1]) }
}

/**
 * One record per JSON file: the layout every version before 0.6.0 wrote. Only
 * read to import them once (see archive.ts). The optional middle group
 * matches files written before ids carried the intra-ms counter.
 */
export const LEGACY_RECORD_FILE = /^(\d{13,})-(?:[0-9a-f]{4}-)?[0-9a-f]{6,}\.json$/

/** Temp files that version's atomic write could strand on a crash. */
export const LEGACY_TEMP_FILE = /\.json\.[0-9a-f]+\.tmp$/
