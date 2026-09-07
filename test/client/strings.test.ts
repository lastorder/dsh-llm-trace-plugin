import { test } from 'node:test'
import assert from 'node:assert/strict'
import { en, zh } from '../../src/client/strings.js'

// -- bilingual completeness --
//
// `ctx.locale.register`'s typed form already enforces this at the call site
// (a missing key in either dictionary is a compile error in entry.ts), but a
// hand-edit to either dictionary that adds/removes a key while forgetting the
// other side would not be caught by that alone if the type were ever loosened
// — so the same property is checked again here, at the data level.

test('zh/en declare exactly the same key set', () => {
  const zhKeys = new Set(Object.keys(zh))
  const enKeys = new Set(Object.keys(en))
  const onlyInZh = [...zhKeys].filter((k) => !enKeys.has(k))
  const onlyInEn = [...enKeys].filter((k) => !zhKeys.has(k))
  assert.deepEqual(onlyInZh, [], 'keys present in zh but missing from en')
  assert.deepEqual(onlyInEn, [], 'keys present in en but missing from zh')
})

test('every entry in both dictionaries is a non-empty string', () => {
  // A blank label renders as an invisible button or an empty tooltip, which is
  // indistinguishable from a broken build at a glance.
  for (const [dict, name] of [[zh, 'zh'], [en, 'en']] as const) {
    for (const [key, value] of Object.entries(dict)) {
      assert.equal(typeof value, 'string', `${name}.${key} must be a string`)
      assert.notEqual(value.trim(), '', `${name}.${key} must not be blank`)
    }
  }
})

test('covers every section the view renders', () => {
  // Pins the key set's shape so a whole section cannot be dropped without a
  // test failure — the view reads these by exact key.
  const prefixes = ['toolbar', 'tabs', 'empty', 'notice', 'group', 'coord', 'badge', 'session', 'purpose', 'json', 'curl', 'turn', 'depth']
  for (const prefix of prefixes) {
    const hit = Object.keys(en).some((key) => key === prefix || key.startsWith(prefix + '.'))
    assert.ok(hit, `missing any key under "${prefix}"`)
  }
})

test('the two SSE toggle labels are distinct, as are the two auto-refresh labels, in both locales', () => {
  // These pairs are toggle states: identical text would make the button look
  // dead even though it is working.
  for (const dict of [zh, en]) {
    assert.notEqual(dict['tabs.sseShowRaw'], dict['tabs.sseShowMerged'])
    assert.notEqual(dict['tabs.sseShowRawTitle'], dict['tabs.sseShowMergedTitle'])
    assert.notEqual(dict['toolbar.autoOn'], dict['toolbar.autoOff'])
    assert.notEqual(dict['toolbar.scopeSession'], dict['toolbar.scopeAll'])
  }
})

// -- interpolated templates: placeholder presence --
//
// A key used with `t(key, params)` must actually carry every placeholder the
// call site supplies, in both languages, or the interpolated value silently
// never appears in one of the two locales.

test('session.foreignLabel/title/fullIdTitle carry their placeholder in both locales', () => {
  for (const dict of [zh, en]) {
    assert.ok(dict['session.foreignLabel'].includes('{shortId}'))
    assert.ok(dict['session.title'].includes('{sessionId}'))
    assert.ok(dict['session.fullIdTitle'].includes('{sessionId}'))
  }
})

test('turn.groupLabel carries {turn} in both locales', () => {
  for (const dict of [zh, en]) assert.ok(dict['turn.groupLabel'].includes('{turn}'))
})

test('turn.groupMetaWithSteps carries both {calls} and {steps}; turn.groupMetaNoSteps carries only {calls}', () => {
  for (const dict of [zh, en]) {
    assert.ok(dict['turn.groupMetaWithSteps'].includes('{calls}'))
    assert.ok(dict['turn.groupMetaWithSteps'].includes('{steps}'))
    assert.ok(dict['turn.groupMetaNoSteps'].includes('{calls}'))
    assert.ok(!dict['turn.groupMetaNoSteps'].includes('{steps}'), 'the no-steps variant must not reference {steps}')
  }
})

test('badge title templates carry their coordinates in both locales', () => {
  for (const dict of [zh, en]) {
    assert.ok(dict['badge.auxiliaryTitle'].includes('{label}'))
    assert.ok(dict['badge.stepTitle'].includes('{turn}'))
    assert.ok(dict['badge.stepTitle'].includes('{step}'))
    assert.ok(dict['badge.turnOnlyTitle'].includes('{turn}'))
  }
})

test('notice.truncatedBody reports both lengths and names the knob, in both locales', () => {
  for (const dict of [zh, en]) {
    const notice = dict['notice.truncatedBody']
    assert.ok(notice.includes('{totalChars}'))
    assert.ok(notice.includes('{keptChars}'))
    // It must also name the knob, or the reader has no action to take.
    assert.ok(notice.includes('maxBodyChars'))
  }
})

test('notice.hiddenUnattributed names the count and the toggle placeholder, in both locales', () => {
  for (const dict of [zh, en]) {
    const notice = dict['notice.hiddenUnattributed']
    assert.ok(notice.includes('{count}'))
    assert.ok(notice.includes('{scopeAll}'))
  }
})

test('json.truncatedNotice reports the row cap placeholder in both locales', () => {
  for (const dict of [zh, en]) assert.ok(dict['json.truncatedNotice'].includes('{rows}'))
})

test('curl.copiedWithEnvRef names the env var twice: what it references and what to export, in both locales', () => {
  for (const dict of [zh, en]) {
    const notice = dict['curl.copiedWithEnvRef']
    assert.ok(notice.includes('${envName}'))
    assert.ok(notice.includes('export {envName}'))
  }
})

test('curl.failed carries the message placeholder in both locales', () => {
  for (const dict of [zh, en]) assert.ok(dict['curl.failed'].includes('{message}'))
})

test('depth.label carries both depth placeholders in both locales', () => {
  for (const dict of [zh, en]) {
    assert.ok(dict['depth.label'].includes('{depth}'))
    assert.ok(dict['depth.label'].includes('{contentDepth}'))
  }
})
