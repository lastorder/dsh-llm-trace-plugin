import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSseFrames, prettySseText } from '../../src/client/sse.js'

// -- parseSseFrames --

test('parseSseFrames: parses a simple data-only frame with JSON payload', () => {
  const frames = parseSseFrames('data: {"a":1}\n\n')
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].data, { a: 1 })
})

test('parseSseFrames: keeps a non-JSON payload as the raw string, e.g. [DONE]', () => {
  const frames = parseSseFrames('data: [DONE]\n\n')
  assert.equal(frames[0].data, '[DONE]')
})

test('parseSseFrames: event:/id:/retry: fields sit alongside data', () => {
  const frames = parseSseFrames('event: message\nid: 42\ndata: {"a":1}\n\n')
  assert.equal(frames[0].event, 'message')
  assert.equal(frames[0].id, '42')
  assert.deepEqual(frames[0].data, { a: 1 })
})

test('parseSseFrames: comment lines become "comment", multiple comments become an array', () => {
  const single = parseSseFrames(': keep-alive\n\n')
  assert.equal(single[0].comment, 'keep-alive')

  const multiple = parseSseFrames(': one\n: two\ndata: {}\n\n')
  assert.deepEqual(multiple[0].comment, ['one', 'two'])
})

test('parseSseFrames: repeated data: lines within one frame are joined with newlines before parsing', () => {
  const frames = parseSseFrames('data: line1\ndata: line2\n\n')
  assert.equal(frames[0].data, 'line1\nline2')
})

test('parseSseFrames: CRLF line endings are normalized the same as LF', () => {
  const frames = parseSseFrames('data: {"a":1}\r\n\r\n')
  assert.deepEqual(frames[0].data, { a: 1 })
})

test('parseSseFrames: multiple frames in one body are parsed in wire order', () => {
  const frames = parseSseFrames('data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n')
  assert.equal(frames.length, 3)
  assert.deepEqual((frames[0].data as any), { n: 1 })
  assert.deepEqual((frames[1].data as any), { n: 2 })
  assert.equal(frames[2].data, '[DONE]')
})

test('parseSseFrames: empty or non-string input returns an empty array, never throws', () => {
  assert.deepEqual(parseSseFrames(''), [])
  assert.deepEqual(parseSseFrames(undefined as any), [])
  assert.deepEqual(parseSseFrames(null as any), [])
})

// -- prettySseText --

test('prettySseText: re-indents a JSON data: payload, indenting continuation lines', () => {
  const result = prettySseText('data: {"a":1,"b":2}')
  assert.equal(result, 'data: {\n    "a": 1,\n    "b": 2\n  }')
})

test('prettySseText: leaves a non-JSON payload (e.g. [DONE]) completely untouched', () => {
  const result = prettySseText('data: [DONE]\n\n')
  assert.match(result, /^data: \[DONE\]/)
})

test('prettySseText: leaves non-data lines (event:, id:, comments, blank separators) untouched', () => {
  const input = 'event: message\nid: 1\ndata: {"a":1}\n\n: keep-alive\n\n'
  const result = prettySseText(input)
  assert.ok(result.includes('event: message'))
  assert.ok(result.includes('id: 1'))
  assert.ok(result.includes(': keep-alive'))
})

test('prettySseText: empty/non-string input returns an empty string, never throws', () => {
  assert.equal(prettySseText(''), '')
  assert.equal(prettySseText(undefined as any), '')
})
