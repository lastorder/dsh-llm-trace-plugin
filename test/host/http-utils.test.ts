import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clip, describeRequest, outgoingUserAgent, redactedHeaders, redactHeaderValue, tryParseJson } from '../../src/host/http-utils.js'

// -- clip --

test('clip: leaves a string under the budget untouched', () => {
  const result = clip('hello', 10)
  assert.deepEqual(result, { text: 'hello', chars: 5, truncated: false })
})

test('clip: cuts a string over the budget and reports the original length', () => {
  const result = clip('hello world', 5)
  assert.deepEqual(result, { text: 'hello', chars: 11, truncated: true })
})

// -- redactedHeaders --

test('redactedHeaders: redacts authorization from a plain object, lowercases keys', () => {
  const result = redactedHeaders({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' })
  assert.equal(result.authorization, 'Bearer ***redacted***')
  assert.equal(result['content-type'], 'application/json')
})

test('redactedHeaders: redacts authorization from a Headers instance', () => {
  const headers = new Headers({ authorization: 'Bearer secret', 'x-foo': 'bar' })
  const result = redactedHeaders(headers)
  assert.equal(result.authorization, 'Bearer ***redacted***')
  assert.equal(result['x-foo'], 'bar')
})

test('redactedHeaders: redacts authorization from an entry array', () => {
  const result = redactedHeaders([['authorization', 'Bearer secret'], ['x-foo', 'bar']])
  assert.equal(result.authorization, 'Bearer ***redacted***')
  assert.equal(result['x-foo'], 'bar')
})

test('redactedHeaders: null/undefined/non-object input returns an empty map, never throws', () => {
  assert.deepEqual(redactedHeaders(null), {})
  assert.deepEqual(redactedHeaders(undefined), {})
  assert.deepEqual(redactedHeaders('not headers'), {})
})

// Every one of these carries a credential, and every captured header is
// written verbatim to disk — so a name missing from REDACTED_HEADERS is a
// plaintext secret in a file under the user's trace directory. Anthropic
// (x-api-key) is the case that matters most in practice: this plugin already
// ships an adapter that merges Anthropic's SSE stream.
test('redactedHeaders: redacts bare-key credential headers without inventing a Bearer scheme', () => {
  const result = redactedHeaders({
    'x-api-key': 'sk-ant-secret',
    'api-key': 'azure-secret',
    'x-goog-api-key': 'google-secret',
  })
  assert.equal(result['x-api-key'], '***redacted***')
  assert.equal(result['api-key'], '***redacted***')
  assert.equal(result['x-goog-api-key'], '***redacted***')
})

test('redactedHeaders: redacts cookie and proxy-authorization', () => {
  const result = redactedHeaders({
    cookie: 'session=secret',
    'set-cookie': 'session=secret',
    'proxy-authorization': 'Bearer proxy-secret',
  })
  assert.equal(result.cookie, '***redacted***')
  assert.equal(result['set-cookie'], '***redacted***')
  // proxy-authorization is bearer-scheme, so the scheme survives.
  assert.equal(result['proxy-authorization'], 'Bearer ***redacted***')
})

test('redactedHeaders: a header that merely LOOKS credential-ish is left untouched', () => {
  // Guards against over-redaction: only the exact names in the set are hidden,
  // so ordinary request metadata stays readable in the trace.
  const result = redactedHeaders({
    'x-api-version': '2023-06-01',
    'anthropic-version': '2023-06-01',
    'user-agent': 'deepseek-harness/1.0',
  })
  assert.equal(result['x-api-version'], '2023-06-01')
  assert.equal(result['anthropic-version'], '2023-06-01')
  assert.equal(result['user-agent'], 'deepseek-harness/1.0')
})

test('redactHeaderValue: redaction is keyed on the name, independent of the value shape', () => {
  assert.equal(redactHeaderValue('authorization', 'Bearer abc'), 'Bearer ***redacted***')
  assert.equal(redactHeaderValue('x-api-key', 'abc'), '***redacted***')
  assert.equal(redactHeaderValue('content-type', 'application/json'), 'application/json')
  // A credential header with an empty value is still redacted, never echoed.
  assert.equal(redactHeaderValue('x-api-key', ''), '***redacted***')
})

// -- outgoingUserAgent --

test('outgoingUserAgent: reads from init.headers', () => {
  const ua = outgoingUserAgent('https://api.example.com', { headers: { 'user-agent': 'deepseek-harness/1.0' } })
  assert.equal(ua, 'deepseek-harness/1.0')
})

test('outgoingUserAgent: reads from a Request instance when input carries headers', () => {
  const request = new Request('https://api.example.com', { headers: { 'user-agent': 'deepseek-harness/2.0' } })
  const ua = outgoingUserAgent(request, undefined)
  assert.equal(ua, 'deepseek-harness/2.0')
})

test('outgoingUserAgent: returns empty string when no user-agent is present anywhere', () => {
  const ua = outgoingUserAgent('https://api.example.com', undefined)
  assert.equal(ua, '')
})

// -- describeRequest --

test('describeRequest: fetch(url, init) form', () => {
  const result = describeRequest('https://api.example.com/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"model":"x"}',
  })
  assert.equal(result.method, 'POST')
  assert.equal(result.url, 'https://api.example.com/v1/chat')
  assert.equal(result.headers['content-type'], 'application/json')
  assert.equal(result.bodyText, '{"model":"x"}')
})

test('describeRequest: fetch(new Request(url, init)) form', () => {
  const request = new Request('https://api.example.com/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  const result = describeRequest(request, undefined)
  assert.equal(result.method, 'POST')
  assert.equal(result.url, 'https://api.example.com/v1/chat')
  assert.equal(result.headers['content-type'], 'application/json')
})

test('describeRequest: defaults to GET when no method is given anywhere', () => {
  const result = describeRequest('https://api.example.com', undefined)
  assert.equal(result.method, 'GET')
})

test('describeRequest: a non-string body (e.g. a stream) is left unread, bodyText stays null', () => {
  const result = describeRequest('https://api.example.com', { method: 'POST', body: new Uint8Array([1, 2, 3]) as any })
  assert.equal(result.bodyText, null)
})

// -- tryParseJson --

test('tryParseJson: parses valid JSON', () => {
  assert.deepEqual(tryParseJson('{"a":1}'), { a: 1 })
})

test('tryParseJson: returns null for invalid JSON, empty string, and non-string input', () => {
  assert.equal(tryParseJson('{not json'), null)
  assert.equal(tryParseJson(''), null)
  assert.equal(tryParseJson(null), null)
  assert.equal(tryParseJson(undefined), null)
})
