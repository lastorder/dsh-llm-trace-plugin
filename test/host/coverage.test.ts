import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCoverageTracker, providerKeyForModelCall, providerKeyForRecord } from '../../src/host/coverage.js'

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

// -- providerKeyForModelCall --

test('providerKeyForModelCall: passes a named provider through unchanged', () => {
  assert.equal(providerKeyForModelCall('opencode-zen-free-provider'), 'opencode-zen-free-provider')
})

test('providerKeyForModelCall: a missing or empty provider buckets under "unknown" rather than vanishing', () => {
  assert.equal(providerKeyForModelCall(null), 'unknown')
  assert.equal(providerKeyForModelCall(''), 'unknown')
})

// -- model calls: the half of the health signal the capture side cannot see --
//
// A provider whose transport never reaches the fetch patch produces no record
// and no error, so `record()` alone can only ever report it as absent. Counting
// the harness's own model calls is what turns that absence into a number.

test('createCoverageTracker: a traced model call counts as a model call, not as untraced', () => {
  const tracker = createCoverageTracker()
  tracker.recordModelCall('deepseek', true, 'deepseek-chat')
  const entry = tracker.snapshot().providers[0]
  assert.equal(entry.provider, 'deepseek')
  assert.equal(entry.modelCalls, 1)
  assert.equal(entry.untracedCalls, 0)
  assert.equal(entry.calls, 0)
})

test('createCoverageTracker: an untraced model call counts on both numbers', () => {
  const tracker = createCoverageTracker()
  tracker.recordModelCall('zen', false, 'zen-free')
  tracker.recordModelCall('zen', false, 'zen-free')
  tracker.recordModelCall('zen', true, 'zen-free')
  const entry = tracker.snapshot().providers[0]
  assert.equal(entry.modelCalls, 3)
  assert.equal(entry.untracedCalls, 2)
})

test('createCoverageTracker: captured records and model calls share one row per provider', () => {
  const tracker = createCoverageTracker()
  tracker.record('deepseek', true)
  tracker.recordModelCall('deepseek', true, 'deepseek-chat')
  const providers = tracker.snapshot().providers
  assert.equal(providers.length, 1)
  assert.equal(providers[0].calls, 1)
  assert.equal(providers[0].attributedCalls, 1)
  assert.equal(providers[0].modelCalls, 1)
})

test('createCoverageTracker: reports the first untraced call of a provider once, with its model', () => {
  const notices: any[] = []
  const tracker = createCoverageTracker({ onFirstUntracedCall: (notice) => { notices.push(notice) } })
  tracker.recordModelCall('zen', false, 'zen-free')
  tracker.recordModelCall('zen', false, 'zen-free')
  tracker.recordModelCall('zen', false, 'zen-free')
  tracker.recordModelCall('other', false, null)
  assert.deepEqual(notices, [
    { provider: 'zen', model: 'zen-free', untracedCalls: 1 },
    { provider: 'other', model: null, untracedCalls: 1 },
  ])
})

test('createCoverageTracker: a traced call never triggers the notice, and a later untraced one still does', () => {
  const notices: any[] = []
  const tracker = createCoverageTracker({ onFirstUntracedCall: (notice) => { notices.push(notice) } })
  tracker.recordModelCall('zen', true, 'zen-free')
  assert.deepEqual(notices, [])
  tracker.recordModelCall('zen', false, 'zen-free')
  assert.equal(notices.length, 1)
})

test('createCoverageTracker: an empty-string model is reported as null, never as an empty name', () => {
  const notices: any[] = []
  const tracker = createCoverageTracker({ onFirstUntracedCall: (notice) => { notices.push(notice) } })
  tracker.recordModelCall('zen', false, '')
  assert.equal(notices[0].model, null)
})

test('createCoverageTracker: a throwing notice sink cannot break the call it reports on', () => {
  const tracker = createCoverageTracker({ onFirstUntracedCall: () => { throw new Error('sink exploded') } })
  tracker.recordModelCall('zen', false, 'zen-free')
  assert.equal(tracker.snapshot().providers[0].untracedCalls, 1)
})

test('createCoverageTracker: snapshot puts untraced model calls first, then busiest, then name', () => {
  const tracker = createCoverageTracker()
  // Healthy, busy: three captures, nothing untraced.
  tracker.record('busy', true)
  tracker.record('busy', true)
  tracker.record('busy', true)
  // The one row a broken-capture reader is looking for.
  tracker.recordModelCall('silent', false, 'm')
  // Quiet and healthy.
  tracker.record('quiet', true)
  assert.deepEqual(tracker.snapshot().providers.map((p) => p.provider), ['silent', 'busy', 'quiet'])
})
