import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capacity, summarizePage, summarizeRecord } from '../../src/host/page-grouping.js'
import { makeRecord } from './fixtures.js'

// -- capacity --

test('capacity: a positive limit under the ceiling is used as-is', () => {
  assert.equal(capacity(50, 300), 50)
})

test('capacity: a limit over the ceiling is clamped to the ceiling', () => {
  assert.equal(capacity(1000, 300), 300)
})

test('capacity: zero, negative, or absent limit falls back to the ceiling', () => {
  assert.equal(capacity(0, 300), 300)
  assert.equal(capacity(-5, 300), 300)
  assert.equal(capacity(undefined, 300), 300)
})

// -- summarizeRecord --

test('summarizeRecord: projects exactly the list-row fields, reading nested request/response', () => {
  const record = makeRecord({ status: 'ok' })
  const summary = summarizeRecord(record)
  assert.equal(summary.id, record.id)
  assert.equal(summary.method, record.request.method)
  assert.equal(summary.url, record.request.url)
  assert.equal(summary.requestChars, record.request.bodyChars)
  assert.equal(summary.responseChars, record.response!.bodyChars)
  assert.equal(summary.responseStatus, record.response!.status)
})

test('summarizeRecord: responseStatus/responseChars degrade gracefully when response is null', () => {
  const record = makeRecord({ response: null, status: 'transport-error' })
  const summary = summarizeRecord(record)
  assert.equal(summary.responseStatus, null)
  assert.equal(summary.responseChars, 0)
})

// -- summarizePage --

test('summarizePage: reverses an oldest-first page into newest-first items', () => {
  const page = [
    makeRecord({ id: 'r1', startedAt: 1 }),
    makeRecord({ id: 'r2', startedAt: 2 }),
    makeRecord({ id: 'r3', startedAt: 3 }),
  ]
  const grouped = summarizePage(page, summarizeRecord)
  assert.deepEqual(grouped.items.map((i) => i.id), ['r3', 'r2', 'r1'])
})

test('summarizePage: counts unattributed records (null sessionId)', () => {
  const page = [
    makeRecord({ id: 'r1', sessionId: null }),
    makeRecord({ id: 'r2', sessionId: 's1' }),
    makeRecord({ id: 'r3', sessionId: null }),
  ]
  const grouped = summarizePage(page, summarizeRecord)
  assert.equal(grouped.unattributed, 2)
})

test('summarizePage: counts purposed auxiliary calls separately from turn stats', () => {
  const page = [
    makeRecord({ id: 'r1', turn: null, purpose: 'session-title' }),
    makeRecord({ id: 'r2', turn: null, purpose: null }), // no turn AND no purpose: neither counted
    makeRecord({ id: 'r3', turn: 1, step: 0 }),
  ]
  const grouped = summarizePage(page, summarizeRecord)
  assert.equal(grouped.auxiliary, 1)
  assert.equal(grouped.turns.length, 1)
  assert.equal(grouped.turns[0].turn, 1)
})

test('summarizePage: groups by turn, counts calls, and counts distinct steps (not calls)', () => {
  const page = [
    makeRecord({ id: 'r1', turn: 1, step: 0 }),
    makeRecord({ id: 'r2', turn: 1, step: 0 }), // same step as r1: steps set stays size 1
    makeRecord({ id: 'r3', turn: 1, step: 1 }),
    makeRecord({ id: 'r4', turn: 2, step: 0 }),
  ]
  const grouped = summarizePage(page, summarizeRecord)
  const turn1 = grouped.turns.find((t) => t.turn === 1)!
  const turn2 = grouped.turns.find((t) => t.turn === 2)!
  assert.equal(turn1.calls, 3)
  assert.equal(turn1.steps, 2)
  assert.equal(turn2.calls, 1)
  assert.equal(turn2.steps, 1)
})

test('summarizePage: turns are sorted newest-turn-first', () => {
  const page = [
    makeRecord({ id: 'r1', turn: 1, step: 0 }),
    makeRecord({ id: 'r2', turn: 3, step: 0 }),
    makeRecord({ id: 'r3', turn: 2, step: 0 }),
  ]
  const grouped = summarizePage(page, summarizeRecord)
  assert.deepEqual(grouped.turns.map((t) => t.turn), [3, 2, 1])
})

test('summarizePage: a call with turn but no step is still counted, contributing no step', () => {
  const page = [makeRecord({ id: 'r1', turn: 1, step: null })]
  const grouped = summarizePage(page, summarizeRecord)
  assert.equal(grouped.turns[0].calls, 1)
  assert.equal(grouped.turns[0].steps, 0)
})
