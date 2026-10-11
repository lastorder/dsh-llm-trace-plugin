import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_FIELDS as CLIENT_FIELDS } from '../../src/client/plugin-manage-view.js'
import { CONFIG_FIELDS as HOST_FIELDS } from '../../src/host/config.js'

// Duplicated across the host/client boundary for the same reason `ROUTE` and
// `PACKAGE_NAME` are (see `test/client/constants.test.ts`): the two builds
// never share runtime code. Drift here would not be a compile error — it
// would be a management-panel field silently never rendered, or a save that
// 400s as "unknown config field" because the client sent a key the host
// schema never declared.

test('client CONFIG_FIELDS lists exactly the same keys as the host schema, in the same order', () => {
  assert.deepEqual(CLIENT_FIELDS.map((field) => field.key), [...HOST_FIELDS])
})

test('every client config field declares a recognized type', () => {
  for (const field of CLIENT_FIELDS) {
    assert.ok(['number', 'boolean', 'string'].includes(field.type), `${field.key} has an unrecognized type "${field.type}"`)
  }
})

test('persist is the only boolean field; every other field is number or string', () => {
  for (const field of CLIENT_FIELDS) {
    if (field.key === 'persist') assert.equal(field.type, 'boolean')
    else assert.notEqual(field.type, 'boolean')
  }
})

test('traceDir is the only string field; every other non-boolean field is a number', () => {
  for (const field of CLIENT_FIELDS) {
    if (field.key === 'traceDir') assert.equal(field.type, 'string')
    else if (field.key !== 'persist') assert.equal(field.type, 'number')
  }
})
