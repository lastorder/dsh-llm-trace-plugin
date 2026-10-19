import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFetchPatch, requestSignal, wrapFetch } from '../../src/host/fetch-patch.js'
import { bindLlmStream, callContext, type CallIdentity, type SettledCall } from '../../src/host/call-context.js'
import { createStepTracker } from '../../src/host/step-tracker.js'
import type { WireRecord } from '../../src/shared/record-shape.js'

function harness() {
  const records: WireRecord[] = []
  const finalized: WireRecord[] = []
  return {
    records,
    finalized,
    push: (r: WireRecord) => { records.push(r) },
    finalize: (r: WireRecord) => { finalized.push(r) },
  }
}

/** A body stream this test drives by hand, so it can be cut short mid-flight. */
function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
  return { stream, controller }
}

/** Let every pending microtask — the mirror's reader loop among them — run. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('wrapFetch: a non-provider call passes straight through, untouched, unrecorded', async () => {
  const h = harness()
  let sawArgs: any = null
  const real = (async (input: any, init: any) => { sawArgs = { input, init }; return new Response('ok') }) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  const response = await patched('https://example.com', { headers: { 'user-agent': 'curl/8.0' } })
  assert.equal(response.status, 200)
  assert.deepEqual(h.records, [])
  assert.ok(sawArgs.input === 'https://example.com')
})

test('wrapFetch: a deepseek-harness/ call is recorded with request fields, and its response is fully unread by the wrapper before the caller reads it', async () => {
  const h = harness()
  const real = (async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  const response = await patched('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/1.0', 'content-type': 'application/json' },
    body: '{"model":"deepseek-chat"}',
  })

  assert.equal(h.records.length, 1)
  const record = h.records[0]
  assert.equal(record.request.method, 'POST')
  assert.equal(record.request.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(record.model, 'deepseek-chat')
  assert.equal(record.attributed, false) // no callContext bound in this test
  assert.equal(record.status, 'streaming') // not yet finalized synchronously

  // The caller's own read of the response must see the complete original body.
  const body = await response.json()
  assert.deepEqual(body, { ok: true })

  // The background mirror read is async; wait a tick for it to finalize.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.finalized.length, 1)
  assert.equal(h.finalized[0].status, 'ok')
  // The wire TEXT is what capture stores; `bodyJson` is derived later, on
  // read, by store.get() — never parsed on this hot path. See the note on
  // WireRecord.bodyJson.
  assert.equal(h.finalized[0].response!.bodyText, JSON.stringify({ ok: true }))
  assert.equal(h.finalized[0].response!.bodyJson, null)
})

// -- admission: the harness user-agent OR an active model call --
//
// The user-agent alone is not a contract this plugin can rely on: a provider
// plugin that builds its own agent identity rewrites that header at the fetch
// layer — the last layer it still controls — so a request issued inside one of
// its model calls is admitted by the context bound to that call instead.

/** A hand-built bound call identity, as `bindLlmStream` would create. */
function fakeCall(overrides: Partial<CallIdentity> = {}): CallIdentity {
  return {
    sessionId: 'session-1',
    turn: 3,
    step: 1,
    purpose: null,
    provider: 'opencode-zen-free-provider',
    model: 'deepseek-v4.1-flash-free',
    observation: { requests: 0 },
    ...overrides,
  }
}

test('wrapFetch: a request issued inside a model call is recorded even with no harness user-agent', async () => {
  const h = harness()
  const real = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  const call = fakeCall()

  const response = await callContext.run(call, () => patched('https://opencode.ai/inference/v1/responses', {
    method: 'POST',
    // The provider's own identity, per its own fetch layer. Nothing here says
    // "harness", and the harness attribution it replaced is exactly what the
    // old user-agent-only rule keyed on.
    headers: { 'user-agent': 'opencode/1.2.3', 'content-type': 'application/json' },
    body: '{"model":"deepseek-v4.1-flash-free"}',
  }))

  assert.equal(response.status, 200)
  assert.equal(h.records.length, 1)
  const record = h.records[0]
  assert.equal(record.attributed, true)
  assert.equal(record.provider, 'opencode-zen-free-provider')
  assert.equal(record.sessionId, 'session-1')
  assert.equal(record.turn, 3)
  assert.equal(record.step, 1)
  // Two different `model`s, deliberately: the wire body's own id, and the
  // harness route's. Both are kept; neither is used to guess the other.
  assert.equal(record.model, 'deepseek-v4.1-flash-free')
  assert.equal(record.requestedModel, 'deepseek-v4.1-flash-free')
  assert.equal(record.request.headers['user-agent'], 'opencode/1.2.3')
})

test('wrapFetch: each recorded request credits the model call it belongs to, once per attempt', async () => {
  const h = harness()
  const real = (async () => new Response('{}')) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  const call = fakeCall()

  await callContext.run(call, () => patched('https://opencode.ai/inference/v1/responses', { headers: { 'user-agent': 'opencode/1' } }))
  assert.equal(call.observation.requests, 1)
  // A retry is a second request for the same call: the receipt counts requests,
  // so "the provider sent something" cannot be mistaken for "nothing was sent".
  await callContext.run(call, () => patched('https://opencode.ai/inference/v1/responses', { headers: { 'user-agent': 'opencode/1' } }))
  assert.equal(call.observation.requests, 2)
  assert.equal(h.records.length, 2)
})

test('wrapFetch: a request outside any model call still needs the harness user-agent', async () => {
  const h = harness()
  const real = (async () => new Response('{}')) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  // No bound context, foreign agent: untouched, exactly as before.
  await patched('https://opencode.ai/inference/v1/responses', { headers: { 'user-agent': 'opencode/1' } })
  assert.deepEqual(h.records, [])
})

test('the receipt and the patch agree end to end: a fetches-inside-the-call provider reports requests > 0', async () => {
  const h = harness()
  const real = (async () => new Response('{}', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  const reported: SettledCall[] = []
  // The adapter fetches on the first pull, inside the bound context — the real
  // shape of every provider call this plugin captures.
  const inner: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          await patched('https://api.deepseek.com/anthropic/v1/messages', {
            method: 'POST',
            headers: { 'user-agent': 'deepseek-harness/1.0' },
            body: '{"model":"deepseek-chat"}',
          })
          return { done: true, value: undefined as any }
        },
      }
    },
  }

  for await (const _chunk of bindLlmStream({ sessionId: 's1', provider: 'deepseek' }, () => inner, createStepTracker(), (call) => {
    reported.push(call)
  })) { /* drain */ }

  assert.equal(reported.length, 1)
  assert.equal(reported[0].requests, 1)
  assert.equal(h.records.length, 1)
})

test('the receipt and the patch agree end to end: a provider that never reaches the patch reports requests 0', async () => {
  const h = harness()
  const real = (async () => new Response('{}')) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  const reported: SettledCall[] = []
  // The provider's SDK was handed a `globalThis.fetch` snapshot taken before
  // this patch existed, so the request never enters `patched` at all. Nothing
  // on the fetch side can see that; the call's own receipt is what can.
  //
  // Sanity-check the patch first, so the empty record list below proves the
  // request went AROUND it rather than that the patch is broken.
  await patched('https://api.deepseek.com/probe', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  assert.equal(h.records.length, 1, 'the patch is live in this process')
  h.records.length = 0
  h.finalized.length = 0
  const inner: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          await real('https://opencode.ai/inference/v1/responses', { headers: { 'user-agent': 'opencode/1' } })
          return { done: true, value: undefined as any }
        },
      }
    },
  }

  for await (const _chunk of bindLlmStream({ sessionId: 's1', provider: 'opencode-zen-free-provider', model: 'zen-free' }, () => inner, createStepTracker(), (call) => {
    reported.push(call)
  })) { /* drain */ }

  assert.equal(reported.length, 1)
  assert.equal(reported[0].requests, 0)
  assert.equal(reported[0].provider, 'opencode-zen-free-provider')
  assert.deepEqual(h.records, [])
})

test('wrapFetch: bodies are never parsed into the ring — only `model` is read, once', async () => {
  // Capture used to JSON.parse the request body twice (once for `model`, once
  // to store `request.bodyJson`) and then hold the parsed result for the life
  // of the ring. With maxBodyChars sized for a 1M-token context that is two
  // multi-megabyte synchronous parses in front of every model call, plus a
  // retained copy several times the size of the text, for a field only the
  // detail view ever reads.
  const h = harness()
  const real = (async () => new Response('{"ok":true}', {
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/1.0' },
    body: '{"model":"deepseek-chat","messages":[]}',
  })
  await new Promise((resolve) => setImmediate(resolve))

  const record = h.records[0]
  // `model` still comes through: it is the one field a list row needs and the
  // wire URL cannot supply.
  assert.equal(record.model, 'deepseek-chat')
  // ...but nothing parsed is retained on either side.
  assert.equal(record.request.bodyJson, null)
  assert.equal(record.request.bodyText, '{"model":"deepseek-chat","messages":[]}')
  assert.equal(record.response!.bodyJson, null)
})

test('wrapFetch: an unparseable request body still records, with a null model', async () => {
  const h = harness()
  const real = (async () => new Response('{}')) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/1.0' },
    body: 'not json at all',
  })
  assert.equal(h.records[0].model, null)
  assert.equal(h.records[0].request.bodyText, 'not json at all')
})

test('wrapFetch: authorization is redacted in the recorded request headers', async () => {
  const h = harness()
  const real = (async () => new Response('{}')) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', {
    headers: { 'user-agent': 'deepseek-harness/1.0', authorization: 'Bearer sk-real-secret' },
  })
  assert.equal(h.records[0].request.headers.authorization, 'Bearer ***redacted***')
})

test('wrapFetch: a transport failure is recorded and rethrown unchanged, never swallowed', async () => {
  const h = harness()
  const boom = new Error('network unreachable')
  const real = (async () => { throw boom }) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  await assert.rejects(
    () => patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } }),
    (error: unknown) => error === boom,
  )
  assert.equal(h.finalized.length, 1)
  assert.equal(h.finalized[0].status, 'transport-error')
  assert.equal(h.finalized[0].error!.message, 'network unreachable')
})

test('wrapFetch: an HTTP error response is still recorded and returned to the caller', async () => {
  const h = harness()
  const real = (async () => new Response('bad request', { status: 400, statusText: 'Bad Request' })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  const response = await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  assert.equal(response.status, 400)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.finalized[0].status, 'http-error')
})

test('wrapFetch: the response body is clipped to maxBodyChars and reports truncation', async () => {
  const h = harness()
  const longBody = 'x'.repeat(100)
  const real = (async () => new Response(longBody, { headers: { 'content-type': 'text/plain' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 10, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.finalized[0].response!.bodyChars, 100)
  assert.equal(h.finalized[0].response!.bodyText.length, 10)
  assert.equal(h.finalized[0].response!.bodyTruncated, true)
})

test('wrapFetch: an SSE response body is stored verbatim as text and never parsed', async () => {
  const h = harness()
  const real = (async () => new Response('data: {"a":1}\n\n', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.finalized[0].response!.bodyJson, null)
  // The frames themselves are the point of this plugin, so the text is kept
  // exactly as it arrived; store.get() is what decides never to parse it.
  assert.equal(h.finalized[0].response!.bodyText, 'data: {"a":1}\n\n')
})

// -- the streaming-body regression --
//
// `mirror.text()` is all-or-nothing: it resolves only once the mirrored stream
// CLOSES, so a terminal error discards every chunk it had already buffered.
// Provider adapters abort the request signal the moment they are done reading
// (`dsh-llm-deepseek`'s `generate()` aborts its consumer controller in a
// `finally`), and a provider SSE socket outlives the last event it consumed —
// so the mirror branch errored on EVERY streamed call and each one was stored
// with `bodyText: ''` plus a `recorderError`. 349 of 349 captured
// `text/event-stream` responses were empty this way; all 19 non-streaming ones
// were fine. The tests below lock in the per-chunk accumulation that fixed it.

test('wrapFetch: an SSE body cut short by the call\'s own abort keeps every chunk that arrived', async () => {
  const h = harness()
  const { stream, controller } = controllableBody()
  const ac = new AbortController()
  const real = (async () => {
    // The adapter is finished with the call and aborts it, exactly as
    // dsh-llm-deepseek's generate() does in its `finally`.
    ac.abort()
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  await patched('https://api.deepseek.com/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'user-agent': 'deepseek-harness/1.0', accept: 'text/event-stream' },
    signal: ac.signal,
  })

  const encoder = new TextEncoder()
  const first = 'event: content_block_delta\ndata: {"n":1}\n\n'
  const second = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  // Let the mirror actually read each chunk before the next arrives, which is
  // what the two-branch tee does in production (the mirror lags the caller by
  // at most a queue depth, never by a whole body).
  controller.enqueue(encoder.encode(first))
  await flush()
  controller.enqueue(encoder.encode(second))
  await flush()
  // The abort reaches the mirror branch as a terminal AbortError.
  controller.error(new DOMException('This operation was aborted', 'AbortError'))
  await flush()

  assert.equal(h.finalized.length, 1)
  const record = h.finalized[0]
  assert.equal(record.response!.bodyText, first + second)
  assert.equal(record.response!.bodyChars, (first + second).length)
  // The abort is the call's own end, not a failure of this plugin.
  assert.equal(record.recorderError, undefined)
  assert.equal(record.status, 'ok')
})

test('wrapFetch: a body read that fails for any other reason keeps the prefix AND reports it', async () => {
  const h = harness()
  const { stream, controller } = controllableBody()
  const real = (async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })

  controller.enqueue(new TextEncoder().encode('event: a\ndata: {"n":1}\n\n'))
  await flush()
  controller.error(new TypeError('terminated'))
  await flush()

  const record = h.finalized[0]
  // What did arrive is still stored: a partial body beats no body.
  assert.equal(record.response!.bodyText, 'event: a\ndata: {"n":1}\n\n')
  // ...but a read that died mid-stream is not silently presented as complete.
  assert.equal(record.recorderError, 'mirror read failed: terminated')
  assert.equal(record.status, 'ok')
})

test('wrapFetch: an AbortError is only excused when the call\'s own signal was aborted', async () => {
  const h = harness()
  const { stream, controller } = controllableBody()
  // No signal on the call at all, so nothing about this abort is the caller's.
  const real = (async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })

  controller.error(new DOMException('This operation was aborted', 'AbortError'))
  await flush()

  assert.equal(h.finalized[0].recorderError, 'mirror read failed: This operation was aborted')
})

test('wrapFetch: the excused teardown is judged by the call\'s signal, not by the error\'s name', async () => {
  // A destroyed socket surfaces as `TypeError: terminated` rather than an
  // `AbortError`, which is the shape a caller-side cancel takes. The rule is
  // "was this call aborted by its own caller", so both shapes are excused.
  const h = harness()
  const { stream, controller } = controllableBody()
  const ac = new AbortController()
  const real = (async () => {
    ac.abort()
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })

  await patched('https://api.deepseek.com/v1/chat', {
    headers: { 'user-agent': 'deepseek-harness/1.0' },
    signal: ac.signal,
  })

  const chunk = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  controller.enqueue(new TextEncoder().encode(chunk))
  await flush()
  controller.error(new TypeError('terminated'))
  await flush()

  assert.equal(h.finalized[0].response!.bodyText, chunk)
  assert.equal(h.finalized[0].recorderError, undefined)
})

test('wrapFetch: a multi-chunk body is clipped incrementally but still reports its full character count', async () => {
  const h = harness()
  const real = (async () => new Response('abcdefghij', { headers: { 'content-type': 'text/plain' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 4, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  await flush()
  // Same contract `clip()` gave a fully read body: `bodyChars` is how big the
  // body was, `bodyText` is what fits.
  assert.equal(h.finalized[0].response!.bodyText, 'abcd')
  assert.equal(h.finalized[0].response!.bodyChars, 10)
  assert.equal(h.finalized[0].response!.bodyTruncated, true)
})

// -- requestSignal --

test('requestSignal: reads the signal off init, off a Request, and prefers init', () => {
  const fromInit = new AbortController()
  assert.equal(requestSignal('https://api.deepseek.com/v1/chat', { signal: fromInit.signal }), fromInit.signal)

  // `new Request(url, { signal })` wraps the signal in a follow signal, so the
  // Request form is checked by identity of its effect, not by reference.
  const requestAc = new AbortController()
  const request = new Request('https://api.deepseek.com/v1/chat', { signal: requestAc.signal })
  const followed = requestSignal(request, undefined)
  assert.notEqual(followed, null)
  assert.equal(followed!.aborted, false)
  requestAc.abort()
  assert.equal(followed!.aborted, true)

  // `init` overrides the Request's own signal, as the fetch spec says.
  assert.equal(requestSignal(request, { signal: fromInit.signal }), fromInit.signal)
  // A Request with no explicit signal still carries one; a bare URL does not.
  assert.notEqual(requestSignal(new Request('https://api.deepseek.com/v1/chat'), undefined), null)
  assert.equal(requestSignal('https://api.deepseek.com/v1/chat', undefined), null)
  assert.equal(requestSignal(undefined, undefined), null)
})


// -- installFetchPatch --

test('installFetchPatch: installs the wrapper, and the disposer restores the exact original reference', () => {
  const original = globalThis.fetch
  let wrapperCalled = false
  const dispose = installFetchPatch((real) => {
    return (async (...args: any[]) => { wrapperCalled = true; return real(...(args as [any, any])) }) as typeof fetch
  })
  assert.notEqual(globalThis.fetch, original)
  dispose()
  assert.equal(globalThis.fetch, original)
  assert.equal(wrapperCalled, false)
})

test('installFetchPatch: installing twice without disposing the first throws loudly', () => {
  const dispose1 = installFetchPatch((real) => real)
  try {
    assert.throws(() => installFetchPatch((real) => real), /already patched/)
  } finally {
    dispose1()
  }
})

test('installFetchPatch: disposer is a no-op if fetch was reassigned by someone else in between', () => {
  const original = globalThis.fetch
  const dispose = installFetchPatch((real) => real)
  const somethingElse = (async () => new Response('x')) as typeof fetch
  globalThis.fetch = somethingElse
  dispose()
  // Disposer only restores when the current fetch is still the one it installed.
  assert.equal(globalThis.fetch, somethingElse)
  globalThis.fetch = original
})
