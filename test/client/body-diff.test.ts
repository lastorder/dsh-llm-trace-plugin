import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collapseContext,
  deepEqual,
  diffBodies,
  diffString,
  formatDiffText,
  formatPath,
  INLINE_CONTEXT,
  lcsPairs,
  LCS_CELL_LIMIT,
} from '../../src/client/body-diff.js'

const msg = (role: string, content: string) => ({ role, content })

// -- equality --

test('deepEqual ignores object key order but not array order', () => {
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true)
  assert.equal(deepEqual([1, 2], [2, 1]), false)
  assert.equal(deepEqual(null, null), true)
  assert.equal(deepEqual(1, '1'), false)
})

// -- lcs --

test('lcsPairs returns a longest common subsequence as index pairs', () => {
  assert.deepEqual(lcsPairs(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e']), [[0, 0], [2, 1], [3, 2]])
  assert.deepEqual(lcsPairs([], ['a']), [])
  assert.deepEqual(lcsPairs(['a'], ['b']), [])
})

test('lcsPairs declines inputs whose table would exceed the cap', () => {
  const side = Math.ceil(Math.sqrt(LCS_CELL_LIMIT)) + 1
  const big = Array.from({ length: side }, () => 'x')
  assert.equal(lcsPairs(big, big), null)
})

// -- diffBodies: top level --

test('identical bodies produce no groups and report identical', () => {
  const body = { model: 'm', messages: [msg('user', 'hi')] }
  const diff = diffBodies(body, structuredClone(body))
  assert.equal(diff.identical, true)
  assert.deepEqual(diff.groups, [])
  assert.deepEqual(diff.unchanged, ['model', 'messages'])
})

test('a reordered object is identical', () => {
  assert.equal(diffBodies({ a: 1, b: 2 }, { b: 2, a: 1 }).identical, true)
})

test('scalar changes, added keys and removed keys are grouped per top-level key in head order', () => {
  const diff = diffBodies(
    { model: 'a', temperature: 0.7, stop: ['x'] },
    { model: 'b', temperature: 0.7, stream: true },
  )
  assert.deepEqual(diff.groups.map((g) => [g.key, g.kind]), [['model', 'changed'], ['stream', 'added'], ['stop', 'removed']])
  assert.deepEqual(diff.unchanged, ['temperature'])
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1 })
  assert.deepEqual(diff.groups[0].changes, [{ path: ['model'], kind: 'changed', before: 'a', after: 'b' }])
  assert.deepEqual(diff.groups[1].changes, [{ path: ['stream'], kind: 'added', after: true }])
  assert.deepEqual(diff.groups[2].changes, [{ path: ['stop'], kind: 'removed', before: ['x'] }])
})

test('a non-object root is reported as one change under the empty key', () => {
  const diff = diffBodies([1], [1, 2])
  assert.equal(diff.groups.length, 1)
  assert.equal(diff.groups[0].key, '')
  assert.equal(diffBodies('a', 'a').identical, true)
})

// -- diffBodies: arrays --

test('a pure append reports only the new tail items, with length bookkeeping', () => {
  const base = { messages: [msg('user', 'a'), msg('assistant', 'b')] }
  const head = { messages: [msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c'), msg('assistant', 'd')] }
  const diff = diffBodies(base, head)
  const group = diff.groups[0]
  assert.equal(group.lengthBefore, 2)
  assert.equal(group.lengthAfter, 4)
  assert.deepEqual(group.changes.map((c) => [c.kind, c.path]), [['added', ['messages', 2]], ['added', ['messages', 3]]])
  assert.deepEqual(diff.counts, { added: 2, removed: 0, changed: 0 })
})

test('an edited message is reported as a nested change, not a remove plus an add', () => {
  const base = { messages: [msg('user', 'a'), msg('assistant', 'b')] }
  const head = { messages: [msg('user', 'a'), msg('assistant', 'B')] }
  assert.deepEqual(diffBodies(base, head).groups[0].changes, [
    { path: ['messages', 1, 'content'], kind: 'changed', before: 'b', after: 'B' },
  ])
})

test('an insertion in the middle keeps the surrounding items unchanged', () => {
  const base = { xs: [1, 2, 4, 5] }
  const head = { xs: [1, 2, 3, 4, 5] }
  assert.deepEqual(diffBodies(base, head).groups[0].changes, [{ path: ['xs', 2], kind: 'added', after: 3 }])
})

test('a removal reports the item with its index in the BASE array', () => {
  const base = { xs: [1, 2, 3, 4] }
  const head = { xs: [1, 4] }
  assert.deepEqual(diffBodies(base, head).groups[0].changes, [
    { path: ['xs', 1], kind: 'removed', before: 2 },
    { path: ['xs', 2], kind: 'removed', before: 3 },
  ])
})

test('unrelated objects at the same position are a removal plus an addition', () => {
  // Same role, but neither content nor id matches: two different tool results.
  const base = { m: [{ role: 'tool', id: 'a', content: 'x' }] }
  const head = { m: [{ role: 'tool', id: 'b', content: 'y' }] }
  assert.deepEqual(diffBodies(base, head).groups[0].changes.map((c) => c.kind), ['removed', 'added'])
})

test('similar objects at the same position are diffed field by field', () => {
  const base = { m: [{ role: 'user', content: 'x' }] }
  const head = { m: [{ role: 'user', content: 'y' }] }
  assert.deepEqual(diffBodies(base, head).groups[0].changes, [
    { path: ['m', 0, 'content'], kind: 'changed', before: 'x', after: 'y' },
  ])
})

test('a compacted history is many removals and the replacement', () => {
  const old = Array.from({ length: 6 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'turn ' + i))
  const base = { messages: old }
  const head = { messages: [msg('system', 'summary'), old[5]] }
  const counts = diffBodies(base, head).counts
  assert.equal(counts.removed + counts.changed >= 5, true)
  assert.equal(diffBodies(base, head).groups[0].lengthAfter, 2)
})

test('nested objects recurse and report added/removed keys inside', () => {
  const diff = diffBodies(
    { metadata: { user: 'u', keep: 1 } },
    { metadata: { keep: 1, trace: 't' } },
  )
  assert.deepEqual(diff.groups[0].changes, [
    { path: ['metadata', 'trace'], kind: 'added', after: 't' },
    { path: ['metadata', 'user'], kind: 'removed', before: 'u' },
  ])
})

test('a type change is one changed leaf', () => {
  assert.deepEqual(diffBodies({ a: 'x' }, { a: { b: 1 } }).groups[0].changes, [
    { path: ['a'], kind: 'changed', before: 'x', after: { b: 1 } },
  ])
})

// -- paths --

test('formatPath renders jq-style and can drop the group key', () => {
  assert.equal(formatPath(['messages', 6, 'content', 0, 'text']), 'messages[6].content[0].text')
  assert.equal(formatPath(['messages', 6, 'content', 0, 'text'], 1), '[6].content[0].text')
  assert.equal(formatPath(['metadata', 'user_id'], 1), 'user_id')
  assert.equal(formatPath(['headers', 'x-api', 'k'], 1), '["x-api"].k')
  assert.equal(formatPath(['a']), 'a')
  assert.equal(formatPath(['a'], 1), '')
  assert.equal(formatPath([]), '')
})

// -- string diff --

test('a single-line edit is highlighted between its shared prefix and suffix', () => {
  assert.deepEqual(diffString('the quick brown fox', 'the quick red fox'), {
    mode: 'inline',
    prefix: 'the quick ',
    prefixClipped: false,
    before: 'brown',
    after: 'red',
    suffix: ' fox',
    suffixClipped: false,
  })
})

test('inline context is clipped to INLINE_CONTEXT characters on both sides', () => {
  const lead = 'a'.repeat(100)
  const trail = 'z'.repeat(100)
  const diff = diffString(lead + 'X' + trail, lead + 'Y' + trail)
  assert.equal(diff.mode, 'inline')
  if (diff.mode !== 'inline') return
  assert.equal(diff.prefix.length, INLINE_CONTEXT)
  assert.equal(diff.suffix.length, INLINE_CONTEXT)
  assert.equal(diff.prefixClipped, true)
  assert.equal(diff.suffixClipped, true)
})

test('a pure insertion has an empty before side', () => {
  const diff = diffString('abc', 'abXc')
  assert.equal(diff.mode, 'inline')
  if (diff.mode !== 'inline') return
  assert.equal(diff.before, '')
  assert.equal(diff.after, 'X')
})

test('inline diff never splits a surrogate pair', () => {
  const a = diffString('x😀y', 'x😁y')
  assert.equal(a.mode, 'inline')
  if (a.mode !== 'inline') return
  assert.equal(a.before, '😀')
  assert.equal(a.after, '😁')
})

test('multi-line text gets a line diff with context-preserving order', () => {
  const diff = diffString('one\ntwo\nthree\nfour', 'one\n2\nthree\nfour\nfive')
  assert.equal(diff.mode, 'lines')
  if (diff.mode !== 'lines') return
  assert.deepEqual(diff.ops, [
    { op: 'equal', text: 'one' },
    { op: 'del', text: 'two' },
    { op: 'add', text: '2' },
    { op: 'equal', text: 'three' },
    { op: 'equal', text: 'four' },
    { op: 'add', text: 'five' },
  ])
})

test('collapseContext keeps context around changes and folds the rest', () => {
  const ops = [
    ...Array.from({ length: 10 }, (_, i) => ({ op: 'equal' as const, text: 'l' + i })),
    { op: 'add' as const, text: 'new' },
    ...Array.from({ length: 10 }, (_, i) => ({ op: 'equal' as const, text: 'm' + i })),
  ]
  const rows = collapseContext(ops, 2)
  assert.deepEqual(rows.map((r) => (r.type === 'skip' ? 'skip:' + r.count : r.op.text)), [
    'skip:8', 'l8', 'l9', 'new', 'm0', 'm1', 'skip:8',
  ])
})

test('collapseContext folds a diff with no change into one skip', () => {
  const rows = collapseContext([{ op: 'equal', text: 'a' }, { op: 'equal', text: 'b' }])
  assert.deepEqual(rows, [{ type: 'skip', count: 2 }])
})

// -- text export --

test('formatDiffText lists every change under its group key', () => {
  const diff = diffBodies(
    { model: 'a', messages: [msg('user', 'x')], stop: 1 },
    { model: 'b', messages: [msg('user', 'x'), msg('assistant', 'y')] },
  )
  assert.equal(formatDiffText(diff), [
    'model',
    '  ~ "a" → "b"',
    'messages',
    '  + [1]: {"role":"assistant","content":"y"}',
    'stop',
    '  - 1',
  ].join('\n'))
})

test('formatDiffText is empty for identical bodies and clips long values', () => {
  assert.equal(formatDiffText(diffBodies({ a: 1 }, { a: 1 })), '')
  const text = formatDiffText(diffBodies({ a: 'x' }, { a: 'y'.repeat(500) }), 20)
  assert.ok(text.includes('…'))
})
