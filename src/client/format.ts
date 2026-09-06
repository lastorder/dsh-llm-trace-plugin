/**
 * Small formatting/labeling helpers used by the list rows and detail header.
 *
 * @module dsh-llm-trace-plugin/client/format
 */

import type { WireRecordSummary, WireStatus } from '../shared/record-shape.js'
import {
  auxiliaryBadgeTitle,
  foreignSessionLabel,
  stepBadgeTitle,
  turnOnlyBadgeTitle,
  UI,
} from './strings.js'

export function fmtTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number') return '-'
  const d = new Date(ms)
  const p = (n: number) => (n < 10 ? '0' + n : String(n))
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

export function fmtDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number') return '-'
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'
}

/**
 * Reduce a session id to its shortest still-distinguishing form.
 *
 * Session ids are `session-<uuid>` (and, from the agent loop,
 * `<id>-session-<uuid>`), so a naive `slice(0, 8)` returns the literal
 * constant `session-` — identical for every session, which is exactly the
 * opposite of what a short label is for. Drop the boilerplate prefix, then
 * keep the leading part of what actually varies.
 */
export function shortSessionId(sessionId: string): string {
  const text = String(sessionId)
  // Take whatever follows the LAST 'session-' marker, which handles both
  // `session-<uuid>` and the loop's `<id>-session-<uuid>`.
  const marker = text.lastIndexOf('session-')
  const distinct = marker === -1 ? text : text.slice(marker + 'session-'.length)
  // Fall back to the raw id if stripping left nothing to show.
  const body = distinct.length > 0 ? distinct : text
  return body.slice(0, 8)
}

/**
 * Short attribution marker for a row in the unfiltered list: which session
 * this wire call belonged to, relative to the one being viewed. A foreign
 * session shows a truncated id purely so two different foreign sessions stay
 * visibly distinct — it is a label, never something to match on.
 */
export function sessionLabel(sessionId: string | null | undefined, currentSessionId: string | null): string {
  if (sessionId === null || sessionId === undefined || sessionId === '') return UI.session.none
  if (sessionId === currentSessionId) return UI.session.current
  return foreignSessionLabel(shortSessionId(sessionId))
}

/**
 * Human label for a call's `purpose`: why the harness made this request at
 * all. An ordinary conversation step has none.
 */
export function purposeLabel(purpose: string | null | undefined): string | null {
  if (purpose === 'session-title') return UI.purpose.sessionTitle
  if (purpose === 'compaction') return UI.purpose.compaction
  if (typeof purpose === 'string' && purpose.length > 0) return purpose
  return null
}

export interface StepBadge {
  text: string
  kind: 'step' | 'aux' | 'none'
  title: string
}

/**
 * The compact turn/step coordinate shown on a list row.
 *
 * Three distinct states, deliberately never collapsed into one another:
 *   - an ordinary loop call     -> `T1·S0`
 *   - a purposed auxiliary call -> its purpose label (it has no step, by
 *     design: it is not part of the conversation loop)
 *   - a call the plugin could not attribute at all -> `无归属`
 */
export function stepBadge(item: Pick<WireRecordSummary, 'purpose' | 'turn' | 'step' | 'attributed'>): StepBadge {
  const aux = purposeLabel(item.purpose)
  if (aux !== null) {
    return { text: aux, kind: 'aux', title: auxiliaryBadgeTitle(aux) }
  }
  if (typeof item.turn === 'number' && typeof item.step === 'number') {
    return {
      text: 'T' + item.turn + '·S' + item.step,
      kind: 'step',
      title: stepBadgeTitle(item.turn, item.step),
    }
  }
  if (typeof item.turn === 'number') {
    return { text: 'T' + item.turn, kind: 'step', title: turnOnlyBadgeTitle(item.turn) }
  }
  return {
    text: UI.badge.unattributed,
    kind: 'none',
    title: item.attributed === false
      ? UI.badge.unattributedNoLlm
      : UI.badge.unattributedOutsideTurn,
  }
}

export function statusKind(status: WireStatus | string | null | undefined): 'ok' | 'err' | 'live' | 'warn' {
  if (status === 'ok') return 'ok'
  if (status === 'http-error' || status === 'transport-error') return 'err'
  if (status === 'streaming') return 'live'
  return 'warn'
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error: any) {
    return 'unable to render JSON: ' + String((error && error.message) || error)
  }
}
