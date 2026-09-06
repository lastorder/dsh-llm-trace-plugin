import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auxiliaryBadgeTitle,
  curlCopiedWithEnvRef,
  curlFailed,
  depthLabel,
  foreignSessionLabel,
  fullSessionIdTitle,
  hiddenUnattributedNotice,
  jsonTruncatedNotice,
  sessionTitle,
  stepBadgeTitle,
  truncatedBodyNotice,
  turnGroupLabel,
  turnGroupMeta,
  turnOnlyBadgeTitle,
  UI,
} from '../../src/client/strings.js'

/** Walk the nested UI table, yielding every leaf as `path -> value`. */
function leaves(node: unknown, path: string[] = []): [string, unknown][] {
  if (typeof node !== 'object' || node === null) return [[path.join('.'), node]]
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => leaves(value, [...path, key]))
}

test('UI: every entry is a non-empty string', () => {
  // A blank label renders as an invisible button or an empty tooltip, which is
  // indistinguishable from a broken build at a glance.
  for (const [path, value] of leaves(UI)) {
    assert.equal(typeof value, 'string', `${path} must be a string`)
    assert.notEqual((value as string).trim(), '', `${path} must not be blank`)
  }
})

test('UI: covers every group the view renders', () => {
  // Pins the table's shape so a section cannot be dropped without a test
  // failure — the view reads these by path.
  for (const group of ['toolbar', 'tabs', 'empty', 'notice', 'group', 'coord', 'badge', 'session', 'purpose', 'json', 'curl']) {
    assert.ok(Object.prototype.hasOwnProperty.call(UI, group), `missing UI.${group}`)
  }
})

test('UI: the two SSE toggle labels are distinct, as are the two auto-refresh labels', () => {
  // These pairs are toggle states: identical text would make the button look
  // dead even though it is working.
  assert.notEqual(UI.tabs.sseMerged, UI.tabs.sseRaw)
  assert.notEqual(UI.tabs.sseMergedTitle, UI.tabs.sseRawTitle)
  assert.notEqual(UI.toolbar.autoOn, UI.toolbar.autoOff)
  assert.notEqual(UI.toolbar.scopeSession, UI.toolbar.scopeAll)
})

// -- interpolating helpers --

test('foreignSessionLabel / sessionTitle / fullSessionIdTitle embed the id', () => {
  assert.equal(foreignSessionLabel('abc12345'), 'session abc12345')
  assert.ok(sessionTitle('session-xyz').includes('session-xyz'))
  assert.ok(fullSessionIdTitle('session-xyz').includes('session-xyz'))
})

test('turnGroupLabel embeds the turn number', () => {
  assert.ok(turnGroupLabel(3).includes('3'))
})

test('turnGroupMeta: the step count is omitted entirely when there are none', () => {
  const withSteps = turnGroupMeta(4, 3)
  assert.ok(withSteps.includes('4'))
  assert.ok(withSteps.includes('3'))
  assert.ok(withSteps.includes('step'))
  const withoutSteps = turnGroupMeta(2, 0)
  assert.ok(withoutSteps.includes('2'))
  assert.ok(!withoutSteps.includes('step'), 'a zero step count must not render " · 0 step"')
})

test('badge titles embed their coordinates', () => {
  assert.ok(auxiliaryBadgeTitle('标题生成').includes('标题生成'))
  const stepTitle = stepBadgeTitle(2, 5)
  assert.ok(stepTitle.includes('2'))
  assert.ok(stepTitle.includes('5'))
  assert.ok(turnOnlyBadgeTitle(7).includes('7'))
})

test('truncatedBodyNotice reports both the original and kept lengths', () => {
  const notice = truncatedBodyNotice('9,000', '5')
  assert.ok(notice.includes('9,000'))
  assert.ok(notice.includes('5'))
  // It must also name the knob, or the reader has no action to take.
  assert.ok(notice.includes('maxBodyChars'))
})

test('hiddenUnattributedNotice names the count and the toggle that reveals them', () => {
  const notice = hiddenUnattributedNotice('12')
  assert.ok(notice.includes('12'))
  assert.ok(notice.includes(UI.toolbar.scopeAll))
})

test('jsonTruncatedNotice reports the row cap', () => {
  assert.ok(jsonTruncatedNotice('20,000').includes('20,000'))
})

test('curlCopiedWithEnvRef names the env var twice: what it references and what to export', () => {
  const notice = curlCopiedWithEnvRef('DSH_CURL_KEY')
  assert.ok(notice.includes('$DSH_CURL_KEY'))
  assert.ok(notice.includes('export DSH_CURL_KEY'))
})

test('curlFailed carries the underlying message through', () => {
  assert.ok(curlFailed('HTTP 500').includes('HTTP 500'))
})

test('depthLabel renders the current depth over the maximum', () => {
  assert.ok(depthLabel(2, 5).includes('2'))
  assert.ok(depthLabel(2, 5).includes('5'))
})
