/**
 * Pure structural diff between two parsed request bodies — the computation
 * behind the Wire Trace "Compare" tab. No DOM, no React.
 *
 * Why structural rather than a line diff of the pretty-printed JSON: an LLM
 * request body is dominated by one growing array (`messages` / `input`) plus a
 * handful of scalars. Between two steps of a turn the array usually just grows
 * at the end; between two turns, or after a compaction, it can be rewritten.
 * A structural diff says "message 6 was appended" and "`temperature` went from
 * 0.7 to 0.2" directly, where a line diff would bury that in bracket noise and
 * re-indentation. Long strings (system prompts, tool results) get a text diff
 * of their own so an edit inside one is visible as an edit, not a whole-value
 * replacement.
 *
 * Path convention: a change's `path` addresses the value in the HEAD (newer /
 * selected) body, except for a `removed` change, whose array indices refer to
 * the BASE body — the item does not exist in head to point at.
 *
 * @module dsh-llm-trace-plugin/client/body-diff
 */

export type PathSeg = string | number
export type ChangeKind = 'added' | 'removed' | 'changed'

/** One leaf-level difference. `before` is set for removed/changed, `after` for added/changed. */
export interface Change {
  path: PathSeg[]
  kind: ChangeKind
  before?: unknown
  after?: unknown
}

/** All the changes under one top-level key of the body, in document order. */
export interface DiffGroup {
  /** The top-level key; `''` when the body root is not an object. */
  key: string
  kind: ChangeKind
  changes: Change[]
  /** Set when the value is an array on that side (null otherwise). */
  lengthBefore: number | null
  lengthAfter: number | null
}

export interface DiffCounts {
  added: number
  removed: number
  changed: number
}

export interface BodyDiff {
  groups: DiffGroup[]
  /** Top-level keys present on both sides with identical values. */
  unchanged: string[]
  counts: DiffCounts
  identical: boolean
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

const canonCache = new WeakMap<object, string>()

/**
 * Canonical string form: object keys sorted, so a mere key reorder is not a
 * difference. Memoized per object identity because every level of a recursive
 * diff asks again about the same subtrees.
 */
function canon(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    return text === undefined ? 'undefined' : text
  }
  const cached = canonCache.get(value)
  if (cached !== undefined) return cached
  let text: string
  if (Array.isArray(value)) {
    text = '[' + value.map(canon).join(',') + ']'
  } else {
    const record = value as Record<string, unknown>
    text = '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canon(record[key])).join(',') + '}'
  }
  canonCache.set(value, text)
  return text
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return a === b || canon(a) === canon(b)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const has = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key)

// ---------------------------------------------------------------------------
// Longest common subsequence
// ---------------------------------------------------------------------------

/** Above this many table cells, alignment is skipped (the caller degrades). */
export const LCS_CELL_LIMIT = 4_000_000

/**
 * Matched index pairs of a longest common subsequence of two key lists, or
 * `null` when the table would exceed {@link LCS_CELL_LIMIT}.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] | null {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) return []
  if ((n + 1) * (m + 1) > LCS_CELL_LIMIT) return null
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Value diff
// ---------------------------------------------------------------------------

/**
 * Whether two unmatched values are "the same thing, edited" and so deserve a
 * nested diff, rather than being reported as one removal plus one addition.
 *
 * Objects pair when at least half of their keys carry an identical value: two
 * chat messages with the same `role` and different `content` are an edit; a
 * tool result and an unrelated tool result (same `role`, different id AND
 * content) are two different things.
 */
function canPair(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return true
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    const total = Math.max(keysA.length, keysB.length)
    if (total === 0) return true
    let same = 0
    for (const key of keysA) if (has(b, key) && canon(a[key]) === canon(b[key])) same += 1
    return same * 2 >= total
  }
  if (a === null || b === null) return false
  return typeof a === typeof b && typeof a !== 'object'
}

function diffArray(path: PathSeg[], a: unknown[], b: unknown[], out: Change[]): void {
  const keysA = a.map(canon)
  const keysB = b.map(canon)
  // Trim the shared head and tail first: the overwhelmingly common case (an
  // append) is then settled without building a table at all.
  let head = 0
  while (head < a.length && head < b.length && keysA[head] === keysB[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && keysA[a.length - 1 - tail] === keysB[b.length - 1 - tail]) tail += 1

  const midA = a.length - head - tail
  const midB = b.length - head - tail
  const pairs = lcsPairs(keysA.slice(head, head + midA), keysB.slice(head, head + midB)) ?? []

  // Unmatched stretches between anchors: pair them up positionally where the
  // two sides look like the same thing, otherwise report removal + addition.
  const emitGap = (fromA: number, toA: number, fromB: number, toB: number) => {
    const lenA = toA - fromA
    const lenB = toB - fromB
    for (let k = 0; k < Math.max(lenA, lenB); k += 1) {
      const inA = k < lenA
      const inB = k < lenB
      if (inA && inB && canPair(a[fromA + k], b[fromB + k])) {
        diffValue([...path, fromB + k], a[fromA + k], b[fromB + k], out)
        continue
      }
      if (inA) out.push({ path: [...path, fromA + k], kind: 'removed', before: a[fromA + k] })
      if (inB) out.push({ path: [...path, fromB + k], kind: 'added', after: b[fromB + k] })
    }
  }

  let nextA = head
  let nextB = head
  for (const [relA, relB] of [...pairs, [midA, midB] as [number, number]]) {
    const matchA = head + relA
    const matchB = head + relB
    emitGap(nextA, matchA, nextB, matchB)
    nextA = matchA + 1
    nextB = matchB + 1
  }
}

function diffObject(path: PathSeg[], a: Record<string, unknown>, b: Record<string, unknown>, out: Change[]): void {
  for (const key of Object.keys(b)) {
    if (!has(a, key)) out.push({ path: [...path, key], kind: 'added', after: b[key] })
    else diffValue([...path, key], a[key], b[key], out)
  }
  for (const key of Object.keys(a)) {
    if (!has(b, key)) out.push({ path: [...path, key], kind: 'removed', before: a[key] })
  }
}

function diffValue(path: PathSeg[], a: unknown, b: unknown, out: Change[]): void {
  if (deepEqual(a, b)) return
  if (Array.isArray(a) && Array.isArray(b)) diffArray(path, a, b, out)
  else if (isPlainObject(a) && isPlainObject(b)) diffObject(path, a, b, out)
  else out.push({ path, kind: 'changed', before: a, after: b })
}

function tally(changes: readonly Change[]): DiffCounts {
  const counts: DiffCounts = { added: 0, removed: 0, changed: 0 }
  for (const change of changes) counts[change.kind] += 1
  return counts
}

const lengthOf = (value: unknown) => (Array.isArray(value) ? value.length : null)

/**
 * Diff two parsed bodies, grouped by top-level key.
 *
 * Groups come out in head's key order, followed by keys only the base had, so
 * the reader meets the fields in the order they appear in the request.
 */
export function diffBodies(base: unknown, head: unknown): BodyDiff {
  if (!isPlainObject(base) || !isPlainObject(head)) {
    if (deepEqual(base, head)) return { groups: [], unchanged: [], counts: { added: 0, removed: 0, changed: 0 }, identical: true }
    const change: Change = { path: [], kind: 'changed', before: base, after: head }
    return {
      groups: [{ key: '', kind: 'changed', changes: [change], lengthBefore: lengthOf(base), lengthAfter: lengthOf(head) }],
      unchanged: [],
      counts: { added: 0, removed: 0, changed: 1 },
      identical: false,
    }
  }

  const groups: DiffGroup[] = []
  const unchanged: string[] = []
  for (const key of Object.keys(head)) {
    if (!has(base, key)) {
      groups.push({ key, kind: 'added', changes: [{ path: [key], kind: 'added', after: head[key] }], lengthBefore: null, lengthAfter: lengthOf(head[key]) })
      continue
    }
    if (deepEqual(base[key], head[key])) {
      unchanged.push(key)
      continue
    }
    const changes: Change[] = []
    diffValue([key], base[key], head[key], changes)
    groups.push({ key, kind: 'changed', changes, lengthBefore: lengthOf(base[key]), lengthAfter: lengthOf(head[key]) })
  }
  for (const key of Object.keys(base)) {
    if (!has(head, key)) {
      groups.push({ key, kind: 'removed', changes: [{ path: [key], kind: 'removed', before: base[key] }], lengthBefore: lengthOf(base[key]), lengthAfter: null })
    }
  }

  const counts: DiffCounts = { added: 0, removed: 0, changed: 0 }
  for (const group of groups) {
    const part = tally(group.changes)
    counts.added += part.added
    counts.removed += part.removed
    counts.changed += part.changed
  }
  return { groups, unchanged, counts, identical: groups.length === 0 }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Render a path jq/JS-style: `messages[6].content[0].text`. Keys that are not
 * plain identifiers use bracket-string form. With `skip: 1` the first segment
 * is dropped, for display under a group header that already names it.
 */
export function formatPath(path: readonly PathSeg[], skip = 0): string {
  let text = ''
  for (let i = skip; i < path.length; i += 1) {
    const seg = path[i]
    if (typeof seg === 'number') text += '[' + seg + ']'
    else if (IDENTIFIER.test(seg)) text += (text === '' ? '' : '.') + seg
    else text += '[' + JSON.stringify(seg) + ']'
  }
  return text
}

// ---------------------------------------------------------------------------
// String diff
// ---------------------------------------------------------------------------

export type LineOp = { op: 'equal' | 'add' | 'del', text: string }

export type StringDiff =
  | {
    mode: 'inline'
    /** Shared leading text, clipped to its last {@link INLINE_CONTEXT} characters. */
    prefix: string
    prefixClipped: boolean
    before: string
    after: string
    /** Shared trailing text, clipped to its first {@link INLINE_CONTEXT} characters. */
    suffix: string
    suffixClipped: boolean
  }
  | { mode: 'lines', ops: LineOp[] }

export const INLINE_CONTEXT = 40

function splitSurrogateSafe(text: string, index: number): number {
  // Never cut between the two halves of a surrogate pair.
  if (index > 0 && index < text.length) {
    const code = text.charCodeAt(index - 1)
    if (code >= 0xD800 && code <= 0xDBFF) return index - 1
  }
  return index
}

function diffLines(before: string, after: string): LineOp[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1

  const ops: LineOp[] = []
  for (let i = 0; i < head; i += 1) ops.push({ op: 'equal', text: a[i] })

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const pairs = lcsPairs(midA, midB)
  if (pairs === null) {
    for (const text of midA) ops.push({ op: 'del', text })
    for (const text of midB) ops.push({ op: 'add', text })
  } else {
    let i = 0
    let j = 0
    for (const [matchA, matchB] of [...pairs, [midA.length, midB.length] as [number, number]]) {
      while (i < matchA) ops.push({ op: 'del', text: midA[i++] })
      while (j < matchB) ops.push({ op: 'add', text: midB[j++] })
      if (matchA < midA.length) ops.push({ op: 'equal', text: midA[matchA] })
      i = matchA + 1
      j = matchB + 1
    }
  }

  for (let i = a.length - tail; i < a.length; i += 1) ops.push({ op: 'equal', text: a[i] })
  return ops
}

/**
 * Diff two strings for display. Multi-line text gets a line diff (the shape a
 * system prompt or a tool result edit has); single-line text gets the changed
 * middle highlighted between its shared prefix and suffix.
 */
export function diffString(before: string, after: string): StringDiff {
  if (before.includes('\n') || after.includes('\n')) return { mode: 'lines', ops: diffLines(before, after) }

  let prefix = 0
  const limit = Math.min(before.length, after.length)
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1
  prefix = splitSurrogateSafe(before, prefix)
  let suffix = 0
  while (suffix < limit - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix += 1
  // Keep a trailing low surrogate with its high half.
  if (suffix > 0) {
    const code = before.charCodeAt(before.length - suffix)
    if (code >= 0xDC00 && code <= 0xDFFF) suffix -= 1
  }

  const lead = before.slice(0, prefix)
  const trail = suffix === 0 ? '' : before.slice(before.length - suffix)
  return {
    mode: 'inline',
    prefix: lead.length > INLINE_CONTEXT ? lead.slice(-INLINE_CONTEXT) : lead,
    prefixClipped: lead.length > INLINE_CONTEXT,
    before: before.slice(prefix, before.length - suffix),
    after: after.slice(prefix, after.length - suffix),
    suffix: trail.length > INLINE_CONTEXT ? trail.slice(0, INLINE_CONTEXT) : trail,
    suffixClipped: trail.length > INLINE_CONTEXT,
  }
}

export type LineRow = { type: 'op', op: LineOp } | { type: 'skip', count: number }

/**
 * Collapse long unchanged runs of a line diff, keeping `context` lines either
 * side of every change. A diff with no change at all collapses to one skip.
 */
export function collapseContext(ops: readonly LineOp[], context = 2): LineRow[] {
  const keep = Array.from({ length: ops.length }, () => false)
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].op === 'equal') continue
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k += 1) keep[k] = true
  }
  const rows: LineRow[] = []
  let skipped = 0
  for (let i = 0; i < ops.length; i += 1) {
    if (keep[i]) {
      if (skipped > 0) rows.push({ type: 'skip', count: skipped })
      skipped = 0
      rows.push({ type: 'op', op: ops[i] })
    } else {
      skipped += 1
    }
  }
  if (skipped > 0) rows.push({ type: 'skip', count: skipped })
  return rows
}

// ---------------------------------------------------------------------------
// Plain-text export
// ---------------------------------------------------------------------------

function previewValue(value: unknown, max: number): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? 'undefined')
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * The diff as plain text, one change per line (`+ path: value`, `- path: value`,
 * `~ path: before → after`) under its top-level key, for pasting elsewhere.
 */
export function formatDiffText(diff: BodyDiff, maxValueChars = 240): string {
  if (diff.identical) return ''
  const lines: string[] = []
  for (const group of diff.groups) {
    lines.push(group.key === '' ? '(root)' : group.key)
    for (const change of group.changes) {
      const where = formatPath(change.path, group.key === '' ? 0 : 1)
      const label = where === '' ? '' : where + ': '
      if (change.kind === 'added') lines.push('  + ' + label + previewValue(change.after, maxValueChars))
      else if (change.kind === 'removed') lines.push('  - ' + label + previewValue(change.before, maxValueChars))
      else lines.push('  ~ ' + label + previewValue(change.before, maxValueChars) + ' → ' + previewValue(change.after, maxValueChars))
    }
  }
  return lines.join('\n')
}
