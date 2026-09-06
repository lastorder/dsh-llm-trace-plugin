import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStepTracker } from '../../src/host/step-tracker.js'

test('reports null turn/step for a session never observed', () => {
  const tracker = createStepTracker()
  assert.deepEqual(tracker.current('s1'), { turn: null, step: null })
})

test('turn/start opens a turn with no step yet', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 1 } })
  assert.deepEqual(tracker.current('s1'), { turn: 1, step: null })
})

test('step/start opens a step under the current turn', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 1 } })
  tracker.observe('s1', { type: 'step/start', data: { turn: 1, step: 0 } })
  assert.deepEqual(tracker.current('s1'), { turn: 1, step: 0 })
})

test('step/end closes the step but keeps the turn open', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 2 } })
  tracker.observe('s1', { type: 'step/start', data: { turn: 2, step: 0 } })
  tracker.observe('s1', { type: 'step/end', data: {} })
  // Between steps, step is null but the turn is still reported — never the
  // step that just closed, which would misattribute a call landing here.
  assert.deepEqual(tracker.current('s1'), { turn: 2, step: null })
})

test('turn/end forgets the session entirely', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 1 } })
  tracker.observe('s1', { type: 'step/start', data: { turn: 1, step: 0 } })
  tracker.observe('s1', { type: 'turn/end', data: {} })
  assert.deepEqual(tracker.current('s1'), { turn: null, step: null })
  assert.equal(tracker.size(), 0)
})

test('forget removes a session outside the normal turn/end path', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 1 } })
  tracker.forget('s1')
  assert.deepEqual(tracker.current('s1'), { turn: null, step: null })
  assert.equal(tracker.size(), 0)
})

test('two sessions never contaminate each other', () => {
  const tracker = createStepTracker()
  tracker.observe('a', { type: 'turn/start', data: { turn: 1 } })
  tracker.observe('a', { type: 'step/start', data: { turn: 1, step: 0 } })
  tracker.observe('b', { type: 'turn/start', data: { turn: 9 } })
  tracker.observe('b', { type: 'step/start', data: { turn: 9, step: 3 } })
  assert.deepEqual(tracker.current('a'), { turn: 1, step: 0 })
  assert.deepEqual(tracker.current('b'), { turn: 9, step: 3 })
  assert.equal(tracker.size(), 2)
})

test('unrecognized event types and malformed input are ignored, not thrown', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 1 } })
  tracker.observe('s1', { type: 'some/unknown/event' })
  assert.deepEqual(tracker.current('s1'), { turn: 1, step: null })
  // @ts-expect-error deliberately malformed input, must not throw
  tracker.observe(123, { type: 'turn/start' })
  // @ts-expect-error deliberately malformed input, must not throw
  tracker.observe('s2', null)
  assert.equal(tracker.size(), 1)
})

test('missing turn/step fields on an event fall back to null, not undefined', () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start' })
  assert.deepEqual(tracker.current('s1'), { turn: null, step: null })
})
