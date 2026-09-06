import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareRowsNewestFirst,
  describeBodyNotice,
  groupKeyOf,
  groupRows,
  isRawFallback,
  isSseResponse,
  mergeSummaryPages,
  normalizePage,
  RAW_KEY,
  rawWrapper,
  selectRequestBody,
  selectResponseBody,
  shouldFallBackToAllSessions,
  stepDepth,
  turnStatFor,
} from '../../src/client/view-model.js'
import type { WireRecord, WireRecordSummary } from '../../src/shared/record-shape.js'

function row(overrides: Partial<WireRecordSummary> = {}): WireRecordSummary {
  return {
    id: '0000000000001-0000-abcdef',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    status: 'ok',
    method: 'POST',
    url: 'https://api.deepseek.com/v1/chat',
    model: 'deepseek-chat',
    sessionId: 'session-a',
    turn: 1,
    step: 0,
    purpose: null,
    provider: 'deepseek',
    attributed: true,
    responseStatus: 200,
    requestChars: 10,
    responseChars: 20,
    ...overrides,
  }
}

function record(overrides: Partial<WireRecord> = {}): WireRecord {
  return {
    id: 'r1',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    status: 'ok',
    model: 'deepseek-chat',
    sessionId: 'session-a',
    turn: 1,
    step: 0,
    purpose: null,
    provider: 'deepseek',
    requestedModel: 'deepseek-chat',
    attributed: true,
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/v1/chat',
      headers: {},
      bodyText: '{"model":"deepseek-chat"}',
      bodyChars: 25,
      bodyTruncated: false,
      bodyJson: { model: 'deepseek-chat' },
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: {},
      contentType: 'application/json',
      bodyText: '{"ok":true}',
      bodyChars: 11,
      bodyTruncated: false,
      bodyJson: { ok: true },
    },
    error: null,
    ...overrides,
  }
}

// -- compareRowsNewestFirst --

test('compareRowsNewestFirst: newer startedAt sorts first', () => {
  const older = row({ id: 'a', startedAt: 1 })
  const newer = row({ id: 'b', startedAt: 2 })
  assert.deepEqual([older, newer].sort(compareRowsNewestFirst).map((r) => r.id), ['b', 'a'])
})

test('compareRowsNewestFirst: a same-millisecond tie is broken by id, not left arbitrary', () => {
  // Many calls can start inside one millisecond. Without the id tie-break the
  // order is whatever the sort happened to do, which shows up as rows visibly
  // reshuffling between polls.
  const first = row({ id: '0000000000001-0000-aaa', startedAt: 5 })
  const second = row({ id: '0000000000001-0001-bbb', startedAt: 5 })
  const sorted = [first, second].sort(compareRowsNewestFirst)
  assert.deepEqual(sorted.map((r) => r.id), ['0000000000001-0001-bbb', '0000000000001-0000-aaa'])
  // ...and it is stable under a different input order.
  const reversed = [second, first].sort(compareRowsNewestFirst)
  assert.deepEqual(reversed.map((r) => r.id), sorted.map((r) => r.id))
})

test('compareRowsNewestFirst: identical rows compare equal', () => {
  assert.equal(compareRowsNewestFirst(row({ id: 'x' }), row({ id: 'x' })), 0)
})

// -- mergeSummaryPages --

test('mergeSummaryPages: keeps history rows a memory-only page does not know about', () => {
  // The whole point: a late memory response must not erase the disk history
  // that already landed.
  const history = [row({ id: 'old', startedAt: 1 }), row({ id: 'mid', startedAt: 2 })]
  const memory = [row({ id: 'new', startedAt: 3 })]
  const merged = mergeSummaryPages(history, memory)
  assert.deepEqual(merged.map((r) => r.id), ['new', 'mid', 'old'])
})

test('mergeSummaryPages: the incoming (live) copy wins for a shared id', () => {
  // The same record exists in both; the live one is the one still being
  // mutated as its response streams in, so it must be the one kept.
  const previous = [row({ id: 'shared', startedAt: 1, status: 'streaming', responseChars: 0 })]
  const incoming = [row({ id: 'shared', startedAt: 1, status: 'ok', responseChars: 512 })]
  const merged = mergeSummaryPages(previous, incoming)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].status, 'ok')
  assert.equal(merged[0].responseChars, 512)
})

test('mergeSummaryPages: empty inputs are handled from either side', () => {
  assert.deepEqual(mergeSummaryPages([], []), [])
  assert.deepEqual(mergeSummaryPages([], [row({ id: 'a' })]).map((r) => r.id), ['a'])
  assert.deepEqual(mergeSummaryPages([row({ id: 'a' })], []).map((r) => r.id), ['a'])
})

test('mergeSummaryPages: does not mutate either input array', () => {
  const previous = [row({ id: 'a', startedAt: 1 })]
  const incoming = [row({ id: 'b', startedAt: 2 })]
  mergeSummaryPages(previous, incoming)
  assert.equal(previous.length, 1)
  assert.equal(incoming.length, 1)
})

// -- shouldFallBackToAllSessions --

const fallbackBase = { filtering: true, decisive: true, alreadyUsed: false, matched: 0, unattributed: 3 }

test('shouldFallBackToAllSessions: fires when a decisive filtered read finds only unattributed traffic', () => {
  assert.equal(shouldFallBackToAllSessions(fallbackBase), true)
})

test('shouldFallBackToAllSessions: never fires on a memory-only page', () => {
  // An in-memory page may simply not have reached this session's records yet,
  // so it can never justify abandoning the filter.
  assert.equal(shouldFallBackToAllSessions({ ...fallbackBase, decisive: false }), false)
})

test('shouldFallBackToAllSessions: never fires twice', () => {
  assert.equal(shouldFallBackToAllSessions({ ...fallbackBase, alreadyUsed: true }), false)
})

test('shouldFallBackToAllSessions: never fires when the filter is already off', () => {
  assert.equal(shouldFallBackToAllSessions({ ...fallbackBase, filtering: false }), false)
})

test('shouldFallBackToAllSessions: never fires when this session has records of its own', () => {
  assert.equal(shouldFallBackToAllSessions({ ...fallbackBase, matched: 2 }), false)
})

test('shouldFallBackToAllSessions: an empty store is not a reason to drop the filter', () => {
  // Nothing captured at all yet — the empty-state message is the right answer,
  // not silently switching the user's scope.
  assert.equal(shouldFallBackToAllSessions({ ...fallbackBase, unattributed: 0 }), false)
})

// -- normalizePage --

test('normalizePage: a null or empty payload yields fully-defaulted state', () => {
  for (const input of [null, undefined, {}]) {
    assert.deepEqual(normalizePage(input as any), {
      items: [],
      total: 0,
      matched: 0,
      unattributed: 0,
      auxiliary: 0,
      turns: [],
      truncated: false,
      historyPending: false,
    })
  }
})

test('normalizePage: non-array items/turns degrade to empty arrays rather than propagating', () => {
  const page = normalizePage({ items: 'nope', turns: 7 } as any)
  assert.deepEqual(page.items, [])
  assert.deepEqual(page.turns, [])
})

test('normalizePage: passes real values through unchanged', () => {
  const items = [row({ id: 'a' })]
  const turns = [{ turn: 1, calls: 2, steps: 2 }]
  const page = normalizePage({
    items, turns, total: 9, matched: 4, unattributed: 1, auxiliary: 2, truncated: true, historyPending: true,
  })
  assert.deepEqual(page.items, items)
  assert.deepEqual(page.turns, turns)
  assert.equal(page.total, 9)
  assert.equal(page.matched, 4)
  assert.equal(page.unattributed, 1)
  assert.equal(page.auxiliary, 2)
  assert.equal(page.truncated, true)
  assert.equal(page.historyPending, true)
})

// -- groupKeyOf / groupRows / turnStatFor --

test('groupKeyOf: a purposed call is auxiliary regardless of its turn', () => {
  // An auxiliary call must never be folded into a turn it merely overlaps in
  // time — that misattribution is what the host's coordinate tracking exists
  // to avoid.
  assert.equal(groupKeyOf({ purpose: 'session-title', turn: 4 }), 'aux')
  assert.equal(groupKeyOf({ purpose: 'compaction', turn: null }), 'aux')
})

test('groupKeyOf: an ordinary call groups by turn, an unattributed one by none', () => {
  assert.equal(groupKeyOf({ purpose: null, turn: 3 }), 'turn:3')
  assert.equal(groupKeyOf({ purpose: null, turn: null }), 'none')
  assert.equal(groupKeyOf({ purpose: '', turn: null }), 'none')
})

test('groupRows: consecutive rows of one turn form a single group', () => {
  const items = [
    row({ id: 'a', turn: 2 }),
    row({ id: 'b', turn: 2 }),
    row({ id: 'c', turn: 1 }),
  ]
  const groups = groupRows(items)
  assert.deepEqual(groups.map((g) => g.key), ['turn:2', 'turn:1'])
  assert.deepEqual(groups[0].items.map((r) => r.id), ['a', 'b'])
  assert.deepEqual(groups[0].start, 0)
  assert.deepEqual(groups[1].start, 2)
  assert.equal(groups[0].turn, 2)
})

test('groupRows: a turn interrupted by an auxiliary call yields three groups, not two', () => {
  // Grouping is positional, matching what the reader actually sees scrolling
  // down; it must not silently re-bucket rows into a different order.
  const items = [
    row({ id: 'a', turn: 2 }),
    row({ id: 'aux', turn: null, purpose: 'session-title' }),
    row({ id: 'b', turn: 2 }),
  ]
  const groups = groupRows(items)
  assert.deepEqual(groups.map((g) => g.key), ['turn:2', 'aux', 'turn:2'])
  assert.deepEqual(groups.map((g) => g.start), [0, 1, 2])
})

test('groupRows: an empty list yields no groups', () => {
  assert.deepEqual(groupRows([]), [])
})

test('groupRows: every source row lands in exactly one group, in order', () => {
  const items = [
    row({ id: 'a', turn: 3 }),
    row({ id: 'b', turn: null, purpose: null, attributed: false }),
    row({ id: 'c', turn: 1 }),
    row({ id: 'd', turn: 1 }),
  ]
  const flattened = groupRows(items).flatMap((g) => g.items.map((r) => r.id))
  assert.deepEqual(flattened, ['a', 'b', 'c', 'd'])
})

test('turnStatFor: finds the matching turn, and returns null for none or a miss', () => {
  const turns = [{ turn: 2, calls: 3, steps: 3 }, { turn: 1, calls: 1, steps: 1 }]
  assert.deepEqual(turnStatFor(turns, 2), { turn: 2, calls: 3, steps: 3 })
  assert.equal(turnStatFor(turns, 9), null)
  assert.equal(turnStatFor(turns, null), null)
})

// -- raw-body handling --

test('rawWrapper / isRawFallback: round-trip, and a real body is not mistaken for one', () => {
  assert.deepEqual(rawWrapper('hello'), { [RAW_KEY]: 'hello' })
  assert.equal(isRawFallback(rawWrapper('hello')), true)
  assert.equal(isRawFallback({ model: 'x' }), false)
  // A body that legitimately has one key must not be misread as the fallback.
  assert.equal(isRawFallback({ onlyKey: 'x' }), false)
  assert.equal(isRawFallback(null), false)
  assert.equal(isRawFallback([1, 2]), false)
  assert.equal(isRawFallback('text'), false)
})

test('rawWrapper: a null/undefined body becomes an empty string, never "null"', () => {
  assert.deepEqual(rawWrapper(null), { [RAW_KEY]: '' })
  assert.deepEqual(rawWrapper(undefined), { [RAW_KEY]: '' })
})

// -- isSseResponse --

test('isSseResponse: detects an event-stream content type, tolerating parameters', () => {
  assert.equal(isSseResponse(record({
    response: { ...record().response!, contentType: 'text/event-stream; charset=utf-8' },
  })), true)
  assert.equal(isSseResponse(record()), false)
  assert.equal(isSseResponse(record({ response: null })), false)
  assert.equal(isSseResponse(null), false)
})

test('isSseResponse: a null content type is not an SSE stream', () => {
  assert.equal(isSseResponse(record({
    response: { ...record().response!, contentType: null },
  })), false)
})

// -- selectRequestBody --

test('selectRequestBody: shows the parsed body when there is one', () => {
  assert.deepEqual(selectRequestBody(record()), { model: 'deepseek-chat' })
})

test('selectRequestBody: degrades to the raw wrapper when the body did not parse', () => {
  const value = selectRequestBody(record({
    request: { ...record().request, bodyJson: null, bodyText: 'not json' },
  }))
  assert.deepEqual(value, { [RAW_KEY]: 'not json' })
})

test('selectRequestBody: null detail yields null', () => {
  assert.equal(selectRequestBody(null), null)
})

// -- selectResponseBody --

const parseFrames = (text: string) => (text.length === 0 ? [] : [{ data: { chunk: text } }])
const mergeFrames = (frames: Record<string, unknown>[]) => ({ merged: frames.length })

test('selectResponseBody: an SSE body is reassembled by default', () => {
  const detail = record({
    response: { ...record().response!, contentType: 'text/event-stream', bodyText: 'data: {}\n\n' },
  })
  assert.deepEqual(
    selectResponseBody({ detail, merged: true, parseFrames, mergeFrames }),
    { merged: 1 },
  )
})

test('selectResponseBody: merged:false yields the literal frames, not the merge', () => {
  // The raw bytes are this plugin's whole point and must stay one click away.
  const detail = record({
    response: { ...record().response!, contentType: 'text/event-stream', bodyText: 'data: {}\n\n' },
  })
  assert.deepEqual(
    selectResponseBody({ detail, merged: false, parseFrames, mergeFrames }),
    [{ data: { chunk: 'data: {}\n\n' } }],
  )
})

test('selectResponseBody: a plain JSON response is shown as-is, never run through the SSE path', () => {
  assert.deepEqual(
    selectResponseBody({ detail: record(), merged: true, parseFrames, mergeFrames }),
    { ok: true },
  )
})

test('selectResponseBody: a non-JSON, non-SSE response degrades to the raw wrapper', () => {
  const detail = record({
    response: { ...record().response!, contentType: 'text/plain', bodyText: 'oops', bodyJson: null },
  })
  assert.deepEqual(
    selectResponseBody({ detail, merged: true, parseFrames, mergeFrames }),
    { [RAW_KEY]: 'oops' },
  )
})

test('selectResponseBody: a record with no response yields null', () => {
  assert.equal(selectResponseBody({ detail: record({ response: null }), merged: true, parseFrames, mergeFrames }), null)
  assert.equal(selectResponseBody({ detail: null, merged: true, parseFrames, mergeFrames }), null)
})

// -- describeBodyNotice --

test('describeBodyNotice: real structure needs no notice', () => {
  assert.equal(describeBodyNotice({ treeValue: { model: 'x' }, shown: null }).kind, 'none')
})

test('describeBodyNotice: a truncated body reports both lengths', () => {
  // This is the overwhelmingly common case: a body cut at the cap stops
  // mid-JSON and cannot parse, and saying so beats an unexplained __raw__ key.
  const notice = describeBodyNotice({
    treeValue: rawWrapper('{"a":'),
    shown: { bodyChars: 9000, bodyText: '{"a":', bodyTruncated: true },
  })
  assert.equal(notice.kind, 'truncated')
  assert.equal(notice.totalChars, 9000)
  assert.equal(notice.keptChars, 5)
})

test('describeBodyNotice: an untruncated unparseable body is reported as not-json', () => {
  const notice = describeBodyNotice({
    treeValue: rawWrapper('hello'),
    shown: { bodyChars: 5, bodyText: 'hello', bodyTruncated: false },
  })
  assert.equal(notice.kind, 'not-json')
})

test('describeBodyNotice: a raw fallback with no shown half still explains itself', () => {
  assert.equal(describeBodyNotice({ treeValue: rawWrapper('x'), shown: null }).kind, 'not-json')
})

// -- stepDepth --

test('stepDepth: clamps to [0, contentDepth]', () => {
  assert.equal(stepDepth(1, 1, 5), 2)
  assert.equal(stepDepth(5, 1, 5), 5, 'cannot expand past the deepest nesting present')
  assert.equal(stepDepth(0, -1, 5), 0, 'cannot collapse below the root')
  assert.equal(stepDepth(3, -1, 5), 2)
})

test('stepDepth: content with no nesting pins the stepper at zero', () => {
  assert.equal(stepDepth(0, 1, 0), 0)
})
