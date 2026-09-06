/**
 * Group an oldest-first page of records into the viewer's list payload.
 *
 * Shared by the in-memory and on-disk list paths so both label turns, count
 * auxiliary calls, and report unattributed records by exactly the same rules.
 *
 * @module dsh-llm-trace-plugin/host/page-grouping
 */

import type { GroupedPage, TurnStat, WireRecord, WireRecordSummary } from '../shared/record-shape.js'

/** Page size for a list request, clamped so one call cannot ask for the world. */
export function capacity(limit: number | undefined, ceiling: number): number {
  return typeof limit === 'number' && limit > 0 ? Math.min(limit, ceiling) : ceiling
}

export function summarizeRecord(record: WireRecord): WireRecordSummary {
  return {
    id: record.id,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    status: record.status,
    method: record.request.method,
    url: record.request.url,
    model: record.model,
    sessionId: record.sessionId,
    turn: record.turn,
    step: record.step,
    purpose: record.purpose,
    provider: record.provider,
    attributed: record.attributed,
    responseStatus: record.response ? record.response.status : null,
    requestChars: record.request.bodyChars,
    responseChars: record.response ? record.response.bodyChars : 0,
  }
}

/**
 * @param page - records, oldest first.
 * @param summarize - record-to-summary mapper.
 */
export function summarizePage(page: WireRecord[], summarize: (record: WireRecord) => WireRecordSummary): GroupedPage {
  const items: WireRecordSummary[] = []
  for (let i = page.length - 1; i >= 0; i -= 1) items.push(summarize(page[i]))

  let unattributed = 0
  for (const record of page) if (record.sessionId === null) unattributed += 1

  const turnMap = new Map<number, { turn: number, calls: number, steps: Set<number> }>()
  let auxiliary = 0
  for (const record of page) {
    if (record.turn === null) {
      if (record.purpose !== null) auxiliary += 1
      continue
    }
    const entry = turnMap.get(record.turn) ?? { turn: record.turn, calls: 0, steps: new Set<number>() }
    entry.calls += 1
    if (record.step !== null) entry.steps.add(record.step)
    turnMap.set(record.turn, entry)
  }
  const turns: TurnStat[] = [...turnMap.values()]
    .sort((a, b) => b.turn - a.turn)
    .map((entry) => ({ turn: entry.turn, calls: entry.calls, steps: entry.steps.size }))

  return { items, unattributed, turns, auxiliary }
}
