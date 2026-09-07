import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCoverageTracker, providerKeyForRecord } from '../../src/host/coverage.js'

// -- providerKeyForRecord --

test('providerKeyForRecord: uses the harness-resolved provider when present', () => {
  assert.equal(providerKeyForRecord('anthropic', 'https://api.anthropic.com/v1/messages'), 'anthropic')
})

test('providerKeyForRecord: falls back to the URL hostname when unattributed', () => {
  assert.equal(providerKeyForRecord(null, 'https://api.anthropic.com/v1/messages'), 'api.anthropic.com')
})

test('providerKeyForRecord: falls back to "unknown" for a malformed URL with no provider', () => {
  assert.equal(providerKeyForRecord(null, 'not a url'), 'unknown')
})

test('providerKeyForRecord: an empty-string provider is treated as absent', () => {
  assert.equal(providerKeyForRecord('', 'https://api.deepseek.com/x'), 'api.deepseek.com')
})

// -- createCoverageTracker --

test('createCoverageTracker: accumulates calls per provider, separating attributed from total', () => {
  const tracker = createCoverageTracker()
  tracker.record('anthropic', true)
  tracker.record('anthropic', true)
  tracker.record('anthropic', false)
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.providers.length, 1)
  assert.equal(snapshot.providers[0].provider, 'anthropic')
  assert.equal(snapshot.providers[0].calls, 3)
  assert.equal(snapshot.providers[0].attributedCalls, 2)
})

test('createCoverageTracker: buckets distinct provider keys separately', () => {
  const tracker = createCoverageTracker()
  tracker.record('anthropic', true)
  tracker.record('api.example.com', false)
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.providers.length, 2)
})

test('createCoverageTracker: snapshot sorts busiest provider first, ties broken by name', () => {
  const tracker = createCoverageTracker()
  tracker.record('zzz', true)
  tracker.record('zzz', true)
  tracker.record('aaa', true)
  tracker.record('bbb', true)
  const snapshot = tracker.snapshot()
  assert.deepEqual(snapshot.providers.map((p) => p.provider), ['zzz', 'aaa', 'bbb'])
})

test('createCoverageTracker: snapshot.since is stable across repeated snapshots', () => {
  const tracker = createCoverageTracker()
  const a = tracker.snapshot().since
  tracker.record('x', true)
  const b = tracker.snapshot().since
  assert.equal(a, b)
})

test('createCoverageTracker: an empty tracker snapshots to an empty provider list', () => {
  const tracker = createCoverageTracker()
  assert.deepEqual(tracker.snapshot().providers, [])
})
