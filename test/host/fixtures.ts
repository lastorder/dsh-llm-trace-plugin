import type { WireRecord } from '../../src/shared/record-shape.js'

/**
 * Build a minimal, valid `WireRecord` for tests, with sane defaults for every
 * field a test doesn't care about. Callers override only what a given test
 * asserts on.
 */
export function makeRecord(overrides: Partial<WireRecord> = {}): WireRecord {
  return {
    id: '1700000000000-0000-aaaaaaaa',
    startedAt: 1700000000000,
    endedAt: 1700000000500,
    durationMs: 500,
    status: 'ok',
    model: 'test-model',
    sessionId: 'session-test',
    turn: 1,
    step: 0,
    purpose: null,
    provider: 'deepseek',
    requestedModel: 'test-model',
    attributed: true,
    request: {
      method: 'POST',
      url: 'https://api.deepseek.com/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ***redacted***' },
      bodyText: '{"model":"test-model"}',
      bodyChars: 23,
      bodyTruncated: false,
      bodyJson: { model: 'test-model' },
    },
    response: {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      contentType: 'application/json',
      bodyText: '{"ok":true}',
      bodyChars: 11,
      bodyTruncated: false,
      bodyJson: { ok: true },
    },
    error: null,
    ...overrides,
  }
}
