import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  fmtDuration,
  fmtTime,
  purposeLabel,
  sessionLabel,
  shortSessionId,
  statusKind,
  stepBadge,
  stringify,
  type Translate,
} from '../../src/client/format.js'
import { en, zh } from '../../src/client/strings.js'

/** Build a fake `t` from a flat dictionary, doing the same `{name}` substitution the real locale service does. */
function fakeT(dict: Record<string, string>): Translate {
  return (key, params) => {
    const template = dict[key]
    if (template === undefined) throw new Error(`fakeT: missing key "${key}"`)
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}

const tZh = fakeT(zh)
const tEn = fakeT(en)

// -- fmtTime / fmtDuration --

test('fmtTime: formats a timestamp as HH:MM:SS.mmm, "-" for non-numbers', () => {
  assert.equal(fmtTime(null), '-')
  assert.equal(fmtTime(undefined), '-')
  assert.match(fmtTime(Date.now()), /^\d{2}:\d{2}:\d{2}\.\d{3}$/)
})

test('fmtDuration: milliseconds under 1000 are shown as ms, seconds otherwise', () => {
  assert.equal(fmtDuration(500), '500ms')
  assert.equal(fmtDuration(1500), '1.5s')
  assert.equal(fmtDuration(null), '-')
})

// -- shortSessionId --

test('shortSessionId: drops the session- boilerplate prefix and keeps what varies', () => {
  const id = shortSessionId('session-abcdef1234567890')
  assert.equal(id, 'abcdef12')
  assert.notEqual(id, 'session-')
})

test('shortSessionId: handles the agent loop\'s <id>-session-<uuid> form by using the LAST marker', () => {
  const id = shortSessionId('loop123-session-deadbeef00')
  assert.equal(id, 'deadbeef')
})

test('shortSessionId: falls back to the raw id when there is no session- marker', () => {
  assert.equal(shortSessionId('plain-id-12345678'), 'plain-id')
})

// -- sessionLabel --

test('sessionLabel: null/undefined/empty sessionId reports the locale\'s "no session" label', () => {
  assert.equal(sessionLabel(null, 'current', tZh), '无 session')
  assert.equal(sessionLabel(undefined, 'current', tZh), '无 session')
  assert.equal(sessionLabel('', 'current', tZh), '无 session')
  assert.equal(sessionLabel(null, 'current', tEn), 'No session')
})

test('sessionLabel: the current session is labeled with the locale\'s "this session" text', () => {
  assert.equal(sessionLabel('session-abc', 'session-abc', tZh), '本 session')
  assert.equal(sessionLabel('session-abc', 'session-abc', tEn), 'This session')
})

test('sessionLabel: a foreign session shows a short id, distinguishable from another foreign session', () => {
  const a = sessionLabel('session-aaaaaaaa', 'session-current', tZh)
  const b = sessionLabel('session-bbbbbbbb', 'session-current', tZh)
  assert.notEqual(a, b)
  assert.ok(a.startsWith('session '))
})

test('sessionLabel: switching the passed-in t changes the output language, proving the threading works', () => {
  const zhResult = sessionLabel(null, 'current', tZh)
  const enResult = sessionLabel(null, 'current', tEn)
  assert.notEqual(zhResult, enResult)
})

// -- purposeLabel --

test('purposeLabel: known purposes get a human label per locale, unknown purposes pass through, absent returns null', () => {
  assert.equal(purposeLabel('session-title', tZh), '标题生成')
  assert.equal(purposeLabel('session-title', tEn), 'Title generation')
  assert.equal(purposeLabel('compaction', tZh), '上下文压缩')
  assert.equal(purposeLabel('compaction', tEn), 'Context compaction')
  assert.equal(purposeLabel('custom-purpose', tZh), 'custom-purpose')
  assert.equal(purposeLabel(null, tZh), null)
  assert.equal(purposeLabel(undefined, tZh), null)
  assert.equal(purposeLabel('', tZh), null)
})

// -- stepBadge --

test('stepBadge: a purposed call always reports "aux", regardless of turn/step', () => {
  const badge = stepBadge({ purpose: 'session-title', turn: 1, step: 0, attributed: true }, tZh)
  assert.equal(badge.kind, 'aux')
  assert.equal(badge.text, '标题生成')
})

test('stepBadge: an ordinary call with turn and step reports "T{turn}·S{step}"', () => {
  const badge = stepBadge({ purpose: null, turn: 2, step: 3, attributed: true }, tZh)
  assert.equal(badge.kind, 'step')
  assert.equal(badge.text, 'T2·S3')
})

test('stepBadge: a turn with no step (between steps) still reports the turn alone', () => {
  const badge = stepBadge({ purpose: null, turn: 2, step: null, attributed: true }, tZh)
  assert.equal(badge.kind, 'step')
  assert.equal(badge.text, 'T2')
})

test('stepBadge: no turn at all reports the locale\'s "unattributed" label, distinguishing attributed:false from attributed:true', () => {
  const unattributed = stepBadge({ purpose: null, turn: null, step: null, attributed: false }, tZh)
  assert.equal(unattributed.kind, 'none')
  assert.match(unattributed.title, /没有经过 ctx\.llm/)

  const attributedButNoTurn = stepBadge({ purpose: null, turn: null, step: null, attributed: true }, tZh)
  assert.equal(attributedButNoTurn.kind, 'none')
  assert.match(attributedButNoTurn.title, /任何 turn 之外/)
})

test('stepBadge: badge text and title switch language with the passed-in t', () => {
  const zhBadge = stepBadge({ purpose: null, turn: null, step: null, attributed: false }, tZh)
  const enBadge = stepBadge({ purpose: null, turn: null, step: null, attributed: false }, tEn)
  assert.notEqual(zhBadge.text, enBadge.text)
  assert.notEqual(zhBadge.title, enBadge.title)
})

// -- statusKind --

test('statusKind: maps every known status, defaults unknown to "warn"', () => {
  assert.equal(statusKind('ok'), 'ok')
  assert.equal(statusKind('http-error'), 'err')
  assert.equal(statusKind('transport-error'), 'err')
  assert.equal(statusKind('streaming'), 'live')
  assert.equal(statusKind('something-else'), 'warn')
  assert.equal(statusKind(null), 'warn')
})

// -- stringify --

test('stringify: pretty-prints JSON with 2-space indentation', () => {
  assert.equal(stringify({ a: 1 }), '{\n  "a": 1\n}')
})

test('stringify: never throws, even for a value JSON.stringify cannot serialize (a circular reference)', () => {
  const circular: any = {}
  circular.self = circular
  const result = stringify(circular)
  assert.match(result, /unable to render JSON/)
})
