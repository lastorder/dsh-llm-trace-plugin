/**
 * Pure, DOM-free computation behind the Wire Trace tab.
 *
 * `wire-trace-view.ts` is deliberately excluded from unit tests (it needs a
 * real React runtime and a real DOM — see `docs/architecture.md`), but a large
 * part of what it did was not view code at all: merging two racing list
 * payloads, deciding when the session filter must be abandoned, grouping rows
 * by turn, and working out which body a tab should render. That logic is the
 * subtlest in the client half and had no coverage while it lived inside the
 * component.
 *
 * Everything here is a plain function over plain data: no React, no `window`,
 * no `document`. The component keeps state and builds elements; it calls into
 * this module for every decision.
 *
 * @module dsh-llm-trace-plugin/client/view-model
 */

import type { WireRecord, WireRecordSummary } from '../shared/record-shape.js'

/** The `list` payload shape both the memory and history reads return. */
export interface ListPayload {
  items?: WireRecordSummary[]
  total?: number
  matched?: number
  unattributed?: number
  auxiliary?: number
  turns?: TurnStatView[]
  truncated?: boolean
  historyPending?: boolean
}

export interface TurnStatView {
  turn: number
  calls: number
  steps: number
}

/**
 * Order two list rows for display: newest first, ties broken by id descending.
 *
 * Many calls can start inside the same millisecond, and a timestamp-only
 * comparison leaves their order arbitrary — which shows up as rows visibly
 * reshuffling between polls. Record ids are `<ms>-<ordinal>-<random>`, built
 * precisely to sort chronologically, so they settle what the timestamp cannot.
 */
export function compareRowsNewestFirst(a: WireRecordSummary, b: WireRecordSummary): number {
  if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * Fold a fresh in-memory page into the list already on screen, keyed by id.
 *
 * The memory read is fast and the history read is slow, so they race by
 * design. Once history has landed, a later memory-only response must NOT
 * replace the list — it holds the live records but none of the history, so
 * replacing would make older rows visibly disappear. Merging by id keeps both,
 * with the incoming (live) copy winning for a shared id because that is the
 * one still being mutated as its response streams in.
 */
export function mergeSummaryPages(
  previous: readonly WireRecordSummary[],
  incoming: readonly WireRecordSummary[],
): WireRecordSummary[] {
  const byId = new Map<string, WireRecordSummary>()
  for (const row of previous) byId.set(row.id, row)
  for (const row of incoming) byId.set(row.id, row)
  return [...byId.values()].sort(compareRowsNewestFirst)
}

export interface FallbackInput {
  /** Whether the session filter is currently applied. */
  filtering: boolean
  /** Whether this payload already consulted disk (a memory-only page proves nothing). */
  decisive: boolean
  /** Whether the one-shot fallback has already been spent. */
  alreadyUsed: boolean
  matched: number
  unattributed: number
}

/**
 * Whether the session filter should be dropped automatically, once.
 *
 * Some providers never stamp a session id on the wire at all (`pi-ai` keeps it
 * in an SDK-local option), so the default "current session" filter would match
 * nothing forever and the tab would look permanently empty. When a filtered
 * read that actually consulted disk finds none of its own records but does see
 * unattributed ones, showing everything is strictly more useful than showing
 * nothing.
 *
 * Deliberately at most once, and disabled the moment the user touches the
 * toggle: an automatic correction that keeps fighting an explicit choice is
 * worse than no correction at all.
 */
export function shouldFallBackToAllSessions(input: FallbackInput): boolean {
  if (!input.filtering) return false
  // A memory-only page may simply not have reached this session's records yet,
  // so it can never justify abandoning the filter.
  if (!input.decisive) return false
  if (input.alreadyUsed) return false
  return input.matched === 0 && input.unattributed > 0
}

/** Normalized view of one list payload, with every field defaulted. */
export interface NormalizedPage {
  items: WireRecordSummary[]
  total: number
  matched: number
  unattributed: number
  auxiliary: number
  turns: TurnStatView[]
  truncated: boolean
  historyPending: boolean
}

/**
 * Coerce a raw payload into fully-defaulted state values.
 *
 * The component previously did this inline with a different guard per field,
 * so a malformed or partial response could leave some state updated and some
 * not. One function means one consistent answer.
 */
export function normalizePage(result: ListPayload | null | undefined): NormalizedPage {
  const payload = result ?? {}
  return {
    items: Array.isArray(payload.items) ? payload.items : [],
    total: typeof payload.total === 'number' ? payload.total : 0,
    matched: typeof payload.matched === 'number' ? payload.matched : 0,
    unattributed: typeof payload.unattributed === 'number' ? payload.unattributed : 0,
    auxiliary: typeof payload.auxiliary === 'number' ? payload.auxiliary : 0,
    turns: Array.isArray(payload.turns) ? payload.turns : [],
    truncated: payload.truncated === true,
    historyPending: payload.historyPending === true,
  }
}

// ---------------------------------------------------------------------------
// Row grouping
// ---------------------------------------------------------------------------

export type GroupKey = string

/**
 * Which group a row belongs to.
 *
 * Auxiliary (purposed) and unattributed calls get their own groups rather than
 * being folded into whichever turn happens to sit next to them in time — that
 * misattribution is exactly what the host's coordinate tracking exists to
 * avoid, and undoing it in the viewer would be the same mistake.
 */
export function groupKeyOf(item: Pick<WireRecordSummary, 'purpose' | 'turn'>): GroupKey {
  if (typeof item.purpose === 'string' && item.purpose.length > 0) return 'aux'
  if (typeof item.turn === 'number') return 'turn:' + item.turn
  return 'none'
}

export interface RowGroup {
  key: GroupKey
  /** Index into the source list where this group's rows begin. */
  start: number
  /** Rows in this group, in source order. */
  items: WireRecordSummary[]
  /** The turn number, when this group is a turn; null otherwise. */
  turn: number | null
}

/**
 * Split a newest-first row list into consecutive groups.
 *
 * Grouping is positional, not a global bucketing: a header is emitted wherever
 * the group changes going down the list. Since the list is newest-first and
 * turns descend, that yields one header per turn without reordering anything
 * the server decided.
 */
export function groupRows(items: readonly WireRecordSummary[]): RowGroup[] {
  const groups: RowGroup[] = []
  let current: RowGroup | null = null
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const key = groupKeyOf(item)
    if (current === null || current.key !== key) {
      current = {
        key,
        start: i,
        items: [],
        turn: key.startsWith('turn:') ? item.turn : null,
      }
      groups.push(current)
    }
    current.items.push(item)
  }
  return groups
}

/** Look up the server-computed stats for one turn group. */
export function turnStatFor(turns: readonly TurnStatView[], turn: number | null): TurnStatView | null {
  if (turn === null) return null
  return turns.find((entry) => entry.turn === turn) ?? null
}

// ---------------------------------------------------------------------------
// Detail-pane body selection
// ---------------------------------------------------------------------------

/** Whether this record's response is a Server-Sent-Events stream. */
export function isSseResponse(detail: WireRecord | null): boolean {
  if (detail === null || detail.response === null) return false
  const contentType = detail.response.contentType
  return typeof contentType === 'string' && contentType.includes('event-stream')
}

/**
 * The synthetic key a non-JSON body is wrapped in so the JSON view has
 * something to render. Exported so the fallback can be detected structurally
 * rather than by re-testing the body.
 */
export const RAW_KEY = '__raw__'

/** Wrap text that could not be parsed as JSON. */
export function rawWrapper(text: string | null | undefined): Record<string, string> {
  return { [RAW_KEY]: typeof text === 'string' ? text : '' }
}

/**
 * Whether a rendered value is the `__raw__` fallback rather than real
 * structure — i.e. an object with exactly that one own key.
 */
export function isRawFallback(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value as Record<string, unknown>)
  return keys.length === 1 && keys[0] === RAW_KEY
}

/**
 * What the Request tab renders: the parsed body, or the raw text when the body
 * is not parseable JSON (overwhelmingly, because it was truncated mid-JSON).
 */
export function selectRequestBody(detail: WireRecord | null): unknown {
  if (detail === null) return null
  if (detail.request.bodyJson !== null) return detail.request.bodyJson
  return rawWrapper(detail.request.bodyText)
}

export interface ResponseBodyInput {
  detail: WireRecord | null
  /** True when the reader wants SSE deltas reassembled rather than raw. */
  merged: boolean
  /** Injected so this module stays free of the sse/sse-merge import graph. */
  parseFrames: (text: string) => Record<string, unknown>[]
  mergeFrames: (frames: Record<string, unknown>[]) => unknown
}

/**
 * What the Response tab renders.
 *
 * Three shapes: an SSE body is reassembled by default into the exact shape
 * that provider's own non-streamed response would have had; a JSON body shows
 * as-is; anything else degrades to the raw wrapper. The literal bytes stay one
 * click away (`merged: false`) because those bytes are this plugin's whole
 * point — they are just close to unreadable directly, one reply being dozens
 * to hundreds of frames carrying a character or two each.
 */
export function selectResponseBody(input: ResponseBodyInput): unknown {
  const { detail, merged, parseFrames, mergeFrames } = input
  if (detail === null || detail.response === null) return null
  if (isSseResponse(detail)) {
    const frames = parseFrames(detail.response.bodyText)
    return merged ? mergeFrames(frames) : frames
  }
  if (detail.response.bodyJson !== null) return detail.response.bodyJson
  return rawWrapper(detail.response.bodyText)
}

export interface BodyNoticeInput {
  /** The value the JSON tree is about to render. */
  treeValue: unknown
  /** The request or response half currently shown. */
  shown: { bodyChars: number, bodyText: string, bodyTruncated: boolean } | null
}

/** Why the JSON view fell back to raw text, if it did. */
export type BodyNoticeKind = 'none' | 'truncated' | 'not-json'

export interface BodyNotice {
  kind: BodyNoticeKind
  /** Original length in characters; only meaningful when `kind` is `truncated`. */
  totalChars: number
  /** How many characters survived the cap; only meaningful when `truncated`. */
  keptChars: number
}

/**
 * Classify why the body is being shown as raw text.
 *
 * Overwhelmingly the reason is truncation: a body cut at the character cap
 * stops mid-JSON, so it cannot parse. Saying that outright beats showing an
 * unexplained `__raw__` key and letting the reader assume the plugin mangled
 * their request.
 */
export function describeBodyNotice(input: BodyNoticeInput): BodyNotice {
  const empty: BodyNotice = { kind: 'none', totalChars: 0, keptChars: 0 }
  if (!isRawFallback(input.treeValue)) return empty
  const shown = input.shown
  if (shown === null || shown === undefined) return { kind: 'not-json', totalChars: 0, keptChars: 0 }
  if (shown.bodyTruncated !== true) return { kind: 'not-json', totalChars: 0, keptChars: 0 }
  return {
    kind: 'truncated',
    totalChars: shown.bodyChars,
    keptChars: (shown.bodyText || '').length,
  }
}

/**
 * Clamp a depth stepper move to what the content can actually show, so `+`
 * stops where it would no longer change anything and the button can disable.
 */
export function stepDepth(current: number, delta: number, contentDepth: number): number {
  return Math.max(0, Math.min(contentDepth, current + delta))
}
