import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFetchPatch, wrapFetch } from '../../src/host/fetch-patch.js'
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
  assert.deepEqual(h.finalized[0].response!.bodyJson, { ok: true })
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

test('wrapFetch: an SSE content-type response body is never JSON-parsed as a whole', async () => {
  const h = harness()
  const real = (async () => new Response('data: {"a":1}\n\n', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const patched = wrapFetch(real, { maxBodyChars: 1000, push: h.push, finalize: h.finalize })
  await patched('https://api.deepseek.com/v1/chat', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.finalized[0].response!.bodyJson, null)
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
