import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCurl,
  CURL_OVERRIDE_ENV,
  CURL_SKIP_HEADERS,
  dqEscape,
  KNOWN_HOST_CREDENTIAL_ENV,
  resolveRealApiKey,
  shQuote,
} from '../../src/host/curl.js'
import { makeRecord } from './fixtures.js'

// -- shQuote / dqEscape --

test('shQuote: wraps in single quotes and escapes embedded single quotes', () => {
  assert.equal(shQuote('hello'), "'hello'")
  assert.equal(shQuote("it's"), "'it'\\''s'")
})

test('dqEscape: escapes backslash, double-quote, backtick, and dollar', () => {
  assert.equal(dqEscape('a"b`c$d\\e'), 'a\\"b\\`c\\$d\\\\e')
})

// -- resolveRealApiKey --

test('resolveRealApiKey: DSH_CURL_KEY env override wins over everything else', async () => {
  process.env[CURL_OVERRIDE_ENV] = 'override-key'
  try {
    const result = await resolveRealApiKey('https://api.deepseek.com/v1/chat', undefined)
    assert.deepEqual(result, { value: 'override-key' })
  } finally {
    delete process.env[CURL_OVERRIDE_ENV]
  }
})

test('resolveRealApiKey: unknown host with no override resolves to undefined', async () => {
  delete process.env[CURL_OVERRIDE_ENV]
  const result = await resolveRealApiKey('https://unknown-gateway.example.com/v1/chat', undefined)
  assert.equal(result, undefined)
})

test('resolveRealApiKey: known host resolves via the credentials provider first', async () => {
  delete process.env[CURL_OVERRIDE_ENV]
  assert.ok(KNOWN_HOST_CREDENTIAL_ENV.has('api.deepseek.com'))
  const credentials = { resolve: async () => ({ value: 'from-credentials' }) }
  const result = await resolveRealApiKey('https://api.deepseek.com/v1/chat', credentials)
  assert.deepEqual(result, { value: 'from-credentials' })
})

test('resolveRealApiKey: known host falls back to the ambient environment variable when credentials has nothing', async () => {
  delete process.env[CURL_OVERRIDE_ENV]
  process.env.DEEPSEEK_API_KEY = 'ambient-key'
  try {
    const credentials = { resolve: async () => undefined }
    const result = await resolveRealApiKey('https://api.deepseek.com/v1/chat', credentials)
    assert.deepEqual(result, { value: 'ambient-key' })
  } finally {
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('resolveRealApiKey: a throwing credentials provider falls through to the ambient environment, never rejects', async () => {
  delete process.env[CURL_OVERRIDE_ENV]
  process.env.DEEPSEEK_API_KEY = 'ambient-key-2'
  try {
    const credentials = { resolve: async () => { throw new Error('boom') } }
    const result = await resolveRealApiKey('https://api.deepseek.com/v1/chat', credentials)
    assert.deepEqual(result, { value: 'ambient-key-2' })
  } finally {
    delete process.env.DEEPSEEK_API_KEY
  }
})

test('resolveRealApiKey: an unparseable URL resolves to undefined rather than throwing', async () => {
  delete process.env[CURL_OVERRIDE_ENV]
  const result = await resolveRealApiKey('not a url', undefined)
  assert.equal(result, undefined)
})

// -- buildCurl --

test('buildCurl: inlines a resolved credential directly, single-quoted', () => {
  const record = makeRecord()
  const command = buildCurl(record, { value: 'sk-real-secret' })
  assert.ok(command.includes(shQuote('authorization: Bearer sk-real-secret')))
  assert.ok(!command.includes('***redacted***'))
  assert.ok(!command.includes('DSH_CURL_KEY'))
})

test('buildCurl: falls back to a shell-expanded $DSH_CURL_KEY reference when nothing was resolved', () => {
  const record = makeRecord()
  const command = buildCurl(record, undefined)
  assert.ok(command.includes(`$${CURL_OVERRIDE_ENV}`))
  assert.ok(!command.includes('***redacted***'))
})

test('buildCurl: skips content-length/host/connection headers', () => {
  const record = makeRecord({
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/v1/chat',
      headers: { 'content-length': '123', host: 'api.deepseek.com', connection: 'keep-alive', 'x-keep': 'yes' },
      bodyText: '{}',
      bodyChars: 2,
      bodyTruncated: false,
      bodyJson: {},
    },
  })
  const command = buildCurl(record, undefined)
  for (const skipped of CURL_SKIP_HEADERS) assert.ok(!command.includes(`${skipped}:`), `should skip ${skipped}`)
  assert.ok(command.includes('x-keep: yes'))
})

test('buildCurl: omits --data-raw and the trailing backslash when there is no request body', () => {
  const record = makeRecord({
    request: {
      method: 'GET',
      url: 'https://api.deepseek.com/v1/models',
      headers: {},
      bodyText: '',
      bodyChars: 0,
      bodyTruncated: false,
      bodyJson: null,
    },
  })
  const command = buildCurl(record, undefined)
  assert.ok(!command.includes('--data-raw'))
  assert.ok(!command.trimEnd().endsWith('\\'))
})

test('buildCurl: includes --data-raw, single-quoted, when a request body is present', () => {
  const record = makeRecord()
  const command = buildCurl(record, undefined)
  assert.ok(command.includes(`--data-raw ${shQuote(record.request.bodyText)}`))
})
