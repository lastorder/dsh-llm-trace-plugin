import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classify,
  childCount,
  collapsedSummary,
  fmtCount,
  flattenJq,
  isContainer,
  isLongString,
  maxDepthOf,
  oneLine,
} from '../../src/client/json-model.js'

// -- classify / isContainer / childCount --

test('classify: identifies every JSON kind', () => {
  assert.equal(classify(null), 'null')
  assert.equal(classify([1, 2]), 'array')
  assert.equal(classify({ a: 1 }), 'object')
  assert.equal(classify('x'), 'string')
  assert.equal(classify(1), 'number')
  assert.equal(classify(true), 'boolean')
})

test('isContainer: true only for object/array', () => {
  assert.equal(isContainer('object'), true)
  assert.equal(isContainer('array'), true)
  assert.equal(isContainer('string'), false)
  assert.equal(isContainer('null'), false)
})

test('childCount: array length, object key count, zero for scalars', () => {
  assert.equal(childCount([1, 2, 3], 'array'), 3)
  assert.equal(childCount({ a: 1, b: 2 }, 'object'), 2)
  assert.equal(childCount('x', 'string'), 0)
})

// -- isLongString / oneLine / collapsedSummary / fmtCount --

test('isLongString: true past the length threshold or when it contains a newline', () => {
  assert.equal(isLongString('short'), false)
  assert.equal(isLongString('x'.repeat(200)), true)
  assert.equal(isLongString('a\nb'), true)
})

test('oneLine: collapses whitespace and truncates with an ellipsis past max', () => {
  assert.equal(oneLine('a\nb   c', 100), 'a b c')
  assert.equal(oneLine('x'.repeat(20), 5), 'xxxxx…')
})

test('collapsedSummary: singular/plural noun for both array and object', () => {
  assert.equal(collapsedSummary('array', 1), '[ … 1 item ]')
  assert.equal(collapsedSummary('array', 3), '[ … 3 items ]')
  assert.equal(collapsedSummary('object', 1), '{ … 1 key }')
  assert.equal(collapsedSummary('object', 3), '{ … 3 keys }')
})

test('fmtCount: formats with locale thousands separators', () => {
  assert.equal(fmtCount(1234567), '1,234,567')
})

// -- flattenJq --

test('flattenJq: a fully-collapsed object yields exactly one leaf line', () => {
  const { lines } = flattenJq({ a: 1, b: 2 }, () => false)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].type, 'leaf')
  assert.equal(lines[0].container, true)
})

test('flattenJq: a fully-expanded object emits open, one leaf per key, then close', () => {
  const { lines } = flattenJq({ a: 1, b: 2 }, () => true)
  assert.equal(lines.length, 4) // open + 2 leaves + close
  assert.equal(lines[0].type, 'open')
  assert.equal(lines[1].label, 'a')
  assert.equal(lines[2].label, 'b')
  assert.equal(lines[3].type, 'close')
})

test('flattenJq: the last entry in a container is marked last:true, so no trailing comma', () => {
  const { lines } = flattenJq({ a: 1, b: 2 }, () => true)
  assert.equal(lines[1].last, false) // 'a' is not the last key
  assert.equal(lines[2].last, true) // 'b' is
})

test('flattenJq: an empty array/object is a single leaf line, never opened', () => {
  const { lines } = flattenJq([], () => true)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].type, 'leaf')
  assert.equal(lines[0].container, false) // container:false because count is 0
})

test('flattenJq: nested containers respect isOpen independently per path', () => {
  const value = { outer: { inner: 1 } }
  // Open the root and 'outer', but nothing past it — 'inner' is a scalar
  // leaf regardless, so this only tests that 'outer' itself got expanded.
  const { lines } = flattenJq(value, (path) => path === '$' || path.endsWith('outer'))
  assert.ok(lines.some((l) => l.type === 'open' && l.label === 'outer'))
})

test('flattenJq: array entries carry labelKind "index", object entries carry "key"', () => {
  const { lines: arrayLines } = flattenJq([1, 2], () => false)
  assert.equal(arrayLines[0].labelKind, 'none') // root has no label
  const { lines: nestedArrayLines } = flattenJq({ list: [1] }, () => true)
  const indexLine = nestedArrayLines.find((l) => l.label === '0')
  assert.equal(indexLine!.labelKind, 'index')
})

test('flattenJq: truncates at MAX_ROWS and reports truncated:true', () => {
  const big: Record<string, number> = {}
  for (let i = 0; i < 25000; i += 1) big[`k${i}`] = i
  const { truncated } = flattenJq(big, () => true)
  assert.equal(truncated, true)
})

test('flattenJq: a scalar root is a single leaf line with no open/close', () => {
  const { lines } = flattenJq(42, () => true)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].kind, 'number')
})

// -- maxDepthOf --

test('maxDepthOf: zero for a scalar', () => {
  assert.equal(maxDepthOf('x', 64), 0)
})

test('maxDepthOf: counts the deepest nesting level present', () => {
  assert.equal(maxDepthOf({ a: { b: { c: 1 } } }, 64), 3)
})

test('maxDepthOf: caps at the given limit even for deeper structures', () => {
  let value: any = 1
  for (let i = 0; i < 200; i += 1) value = { nested: value }
  assert.equal(maxDepthOf(value, 10), 10)
})
