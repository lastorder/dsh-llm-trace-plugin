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
  const seen = contextsSeenDuringNext[0] as any
  assert.equal(seen.sessionId, 's1')
  assert.equal(seen.turn, null)
  assert.equal(seen.step, null)
  assert.equal(seen.purpose, null)
  assert.equal(seen.provider, 'deepseek')
  assert.equal(seen.model, 'deepseek-chat')
  // The receipt rides along and is fresh and untouched until a request is
  // captured; see the settle-report tests below.
  assert.deepEqual(seen.observation, { requests: 0 })
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

// -- settle reports (what coverage.ts counts) --
//
// A call that settles with zero captured requests is the only evidence this
// plugin can ever have that a provider's traffic never reached the fetch
// patch at all: there is no record and no error to look at.

/** An inner stream that also lets a test mutate the bound call's receipt, standing in for the fetch patch. */
function fakeInnerStreamWithRequests<T>(values: T[], requestsPerPull: number): AsyncIterable<T> & { pulls: number } {
  let i = 0
  const stream = {
    pulls: 0,
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          stream.pulls += 1
          const call = callContext.getStore()
          // Only a pull that actually yields a chunk stands in for adapter work
          // (the fetch); the terminal pull sends nothing, exactly as it would
          // not on the wire.
          if (call !== undefined && i < values.length) call.observation.requests += requestsPerPull
          if (i >= values.length) return { done: true, value: undefined as any }
          const value = values[i]
          i += 1
          return { done: false, value }
        },
      }
    },
  }
  return stream as AsyncIterable<T> & { pulls: number }
}

test('reports one settled call per model call, carrying the identity a reader needs', async () => {
  const tracker = createStepTracker()
  tracker.observe('s1', { type: 'turn/start', data: { turn: 4 } })
  tracker.observe('s1', { type: 'step/start', data: { turn: 4, step: 2 } })
  const reported: any[] = []
  const { stream } = fakeInnerStream(['a', 'b'])
  await drain(bindLlmStream({ sessionId: 's1', provider: 'deepseek', model: 'deepseek-chat' }, () => stream, tracker, (call) => {
    reported.push(call)
  }))
  assert.equal(reported.length, 1)
  assert.deepEqual(reported[0], {
    sessionId: 's1',
    purpose: null,
    provider: 'deepseek',
    model: 'deepseek-chat',
    requests: 0,
  })
})

test('reports how many requests the call produced, so zero is a diagnosis rather than a guess', async () => {
  const tracker = createStepTracker()
  const reported: any[] = []
  const stream = fakeInnerStreamWithRequests(['a', 'b'], 1)
  await drain(bindLlmStream({ sessionId: 's1', provider: 'opencode-zen' }, () => stream, tracker, (call) => {
    reported.push(call)
  }))
  // Two pulls → two captured requests (the adapter fetches once per attempt).
  assert.equal(reported.length, 1)
  assert.equal(reported[0].requests, 2)
  assert.equal(reported[0].provider, 'opencode-zen')
})

test('reports a call whose adapter never reached the patched fetch with requests 0', async () => {
  const tracker = createStepTracker()
  const reported: any[] = []
  const stream = fakeInnerStreamWithRequests(['a'], 0)
  await drain(bindLlmStream({ sessionId: 's1', provider: 'bypassing-provider' }, () => stream, tracker, (call) => {
    reported.push(call)
  }))
  assert.equal(reported[0].requests, 0)
})

test('reports on early consumer termination too, before the inner stream is torn down', async () => {
  const tracker = createStepTracker()
  const reported: any[] = []
  const stream = fakeInnerStreamWithRequests(['a', 'b', 'c'], 1)
  const bound = bindLlmStream({ sessionId: 's1' }, () => stream, tracker, (call) => {
    reported.push(call)
  })
  for await (const _value of bound) break
  assert.equal(reported.length, 1)
  assert.equal(reported[0].requests, 1)
})

test('reports exactly once even when the consumer abandons the stream mid-flight', async () => {
  const tracker = createStepTracker()
  let reports = 0
  const stream = fakeInnerStreamWithRequests(['a', 'b', 'c'], 0)
  const bound = bindLlmStream({ sessionId: 's1' }, () => stream, tracker, () => {
    reports += 1
  })
  const iterator = bound[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return!(undefined)
  await iterator.return!(undefined)
  assert.equal(reports, 1)
})

test('does not report a call whose stream was created and never pulled (nothing was sent)', async () => {
  const tracker = createStepTracker()
  const reported: any[] = []
  const stream = fakeInnerStreamWithRequests(['a'], 1)
  const bound = bindLlmStream({ sessionId: 's1' }, () => stream, tracker, (call) => {
    reported.push(call)
  })
  // Constructing the stream runs `next()` and nothing else; an async
  // generator's body — including its `finally` — only runs on a pull.
  assert.equal(typeof bound[Symbol.asyncIterator], 'function')
  assert.deepEqual(reported, [])
})

test('a throwing observer cannot break the model stream or its chunks', async () => {
  const tracker = createStepTracker()
  const { stream } = fakeInnerStream([1, 2, 3])
  const bound = bindLlmStream({ sessionId: 's1' }, () => stream, tracker, () => {
    throw new Error('observer exploded')
  })
  assert.deepEqual(await drain(bound), [1, 2, 3])
})

test('concurrent calls each report their own receipt, never a shared one', async () => {
  const tracker = createStepTracker()
  const reportedA: any[] = []
  const reportedB: any[] = []
  const streamA = fakeInnerStreamWithRequests(['a1', 'a2'], 1)
  const streamB = fakeInnerStreamWithRequests(['b1'], 0)
  await Promise.all([
    drain(bindLlmStream({ sessionId: 'a', provider: 'pa' }, () => streamA, tracker, (call) => reportedA.push(call))),
    drain(bindLlmStream({ sessionId: 'b', provider: 'pb' }, () => streamB, tracker, (call) => reportedB.push(call))),
  ])
  assert.equal(reportedA[0].requests, 2)
  assert.equal(reportedA[0].provider, 'pa')
  assert.equal(reportedB[0].requests, 0)
  assert.equal(reportedB[0].provider, 'pb')
})
