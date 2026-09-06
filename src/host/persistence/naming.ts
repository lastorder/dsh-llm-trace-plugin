/**
 * Storage naming and directory resolution: turning a `startedAt` timestamp
 * into a globally unique, chronologically sortable file name, and resolving
 * where those files live.
 *
 * @module dsh-llm-trace-plugin/host/persistence/naming
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
 * Build the storage name for a record.
 *
 * The name must be globally unique AND sort chronologically, because it is
 * the only ordering key the archive has — nothing is read to sort a page.
 *
 * Uniqueness matters more than it looks: an in-memory id built from a
 * per-process counter would let two harness processes collide on the same
 * name and silently overwrite each other's records — reintroducing, as data
 * loss, the very cross-process problem the file-per-record layout removes.
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
 * @param startedAt - epoch milliseconds the call began.
 * @returns the file name, including extension.
 */
export function buildRecordName(startedAt: number): string {
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
export function idFromName(name: string): string {
  return name.slice(0, -'.json'.length)
}
