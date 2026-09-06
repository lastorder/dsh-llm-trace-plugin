import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindLlmStream, callContext } from '../../src/host/call-context.js'
import { createStepTracker } from '../../src/host/step-tracker.js'

/**
 * Build a fake inner stream whose `next()` (standing in for the adapter's own
 * `fetch` call, which happens synchronously within one pull) records whatever
 * async context is active AT THAT MOMENT — this is the only point in the
 * pipeline `bindLlmStream` actually promises a bound context to, matching
 * where `fetch-patch.ts` reads `callContext.getStore()` for real.
 */
function fakeInnerStream<T>(values: T[]): { stream: AsyncIterable<T>, contextsSeenDuringNext: unknown[] } {
  const contextsSeenDuringNext: unknown[] = []
  let i = 0
  const stream: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          contextsSeenDuringNext.push(callContext.getStore())
          if (i >= values.length) return { done: true, value: undefined as any }
          const value = values[i]
          i += 1
          return { done: false, value }
        },
      }
    },
  }
  return { stream, contextsSeenDuringNext }
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of stream) values.push(value)
  return values
}

test('yields every chunk from the inner stream, in order, untouched', async () => {
  const tracker = createStepTracker()
  const { stream } = fakeInnerStream([1, 2, 3])
  const bound = bindLlmStream({ sessionId: 's1' }, () => stream, tracker)
  const values = await drain(bound)
  assert.deepEqual(values, [1, 2, 3])
})

test('binds session/provider/model identity, visible from inside the inner stream\'s own next() — where the adapter\'s fetch actually runs', async () => {
  const tracker = createStepTracker()
  const { stream, contextsSeenDuringNext } = fakeInnerStream(['a'])
  const bound = bindLlmStream({ sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat' }, () => stream, tracker)
  await drain(bound)
  assert.deepEqual(contextsSeenDuringNext[0], {
    sessionId: 's1',
    turn: null,
    step: null,
    purpose: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
  })
})

test('reads the OPEN turn/step from the tracker at call time', async () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 4 } })
  tracker.observe('s1', { type: 'step/start', data: { turn: 4, step: 2 } })
  const { stream, contextsSeenDuringNext } = fakeInnerStream(['x'])
  const bound = bindLlmStream({ sessionId: 's1' }, () => stream, tracker)
  await drain(bound)
  assert.equal((contextsSeenDuringNext[0] as any).turn, 4)
  assert.equal((contextsSeenDuringNext[0] as any).step, 2)
})

test('a purposed call takes no turn/step even while a turn is open on the same session', async () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 4 } })
  tracker.observe('s1', { type: 'step/start', data: { turn: 4, step: 2 } })
  const { stream, contextsSeenDuringNext } = fakeInnerStream(['x'])
  const bound = bindLlmStream({ sessionId: 's1', purpose: 'session-title' }, () => stream, tracker)
  await drain(bound)
  assert.equal((contextsSeenDuringNext[0] as any).turn, null)
  assert.equal((contextsSeenDuringNext[0] as any).step, null)
  assert.equal((contextsSeenDuringNext[0] as any).purpose, 'session-title')
})

test('an absent sessionId takes no turn/step and is reported as null, not stringified "undefined"', async () => {
  const tracker = createStepTracker()
  const { stream, contextsSeenDuringNext } = fakeInnerStream(['x'])
  const bound = bindLlmStream({}, () => stream, tracker)
  await drain(bound)
  assert.equal((contextsSeenDuringNext[0] as any).sessionId, null)
  assert.equal((contextsSeenDuringNext[0] as any).turn, null)
})

test('two concurrent bound streams never contaminate each other\'s context', async () => {
  const tracker = createStepTracker()
  tracker.observe('a', { type: 'turn/start', data: { turn: 1 } })
  tracker.observe('a', { type: 'step/start', data: { turn: 1, step: 0 } })
  tracker.observe('b', { type: 'turn/start', data: { turn: 9 } })
  tracker.observe('b', { type: 'step/start', data: { turn: 9, step: 3 } })

  const fakeA = fakeInnerStream(['a1', 'a2'])
  const fakeB = fakeInnerStream(['b1', 'b2'])
  const streamA = bindLlmStream({ sessionId: 'a' }, () => fakeA.stream, tracker)
  const streamB = bindLlmStream({ sessionId: 'b' }, () => fakeB.stream, tracker)

  await Promise.all([drain(streamA), drain(streamB)])
  assert.equal((fakeA.contextsSeenDuringNext[0] as any).sessionId, 'a')
  assert.equal((fakeA.contextsSeenDuringNext[0] as any).turn, 1)
  assert.equal((fakeB.contextsSeenDuringNext[0] as any).sessionId, 'b')
  assert.equal((fakeB.contextsSeenDuringNext[0] as any).turn, 9)
})

test('early consumer termination (break) still runs inside the bound context via iterator.return', async () => {
  const tracker = createStepTracker()
  let returnCalledWithContext: unknown = 'not-called'
  const inner: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          i += 1
          return i <= 3 ? { done: false, value: 'v' + i } : { done: true, value: undefined }
        },
        async return(value) {
          returnCalledWithContext = callContext.getStore()
          return { done: true, value }
        },
      }
    },
  }
  const bound = bindLlmStream({ sessionId: 's1' }, () => inner, tracker)
  const seen: string[] = []
  for await (const v of bound) {
    seen.push(v)
    if (seen.length === 1) break
  }
  assert.deepEqual(seen, ['v1'])
  assert.notEqual(returnCalledWithContext, 'not-called')
  assert.equal((returnCalledWithContext as any).sessionId, 's1')
})
