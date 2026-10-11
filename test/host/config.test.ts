import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_FIELDS, Config, resolveEffectiveConfig } from '../../src/host/config.js'
import { DEFAULT_MAX_BODY_CHARS, DEFAULT_MAX_RECORDS } from '../../src/host/constants.js'
import { DEFAULT_MAX_PERSISTED, DEFAULT_PAGE_LIMIT, DEFAULT_PRETTY_BODY_LIMIT } from '../../src/host/persistence/constants.js'

// -- resolveEffectiveConfig: every field defaults exactly like the modules
// that used to apply these fallbacks individually (store.ts, archive.ts) --

test('resolveEffectiveConfig: an absent config resolves every field to its documented default', () => {
  const resolved = resolveEffectiveConfig(undefined, {})
  assert.equal(resolved.maxRecords, DEFAULT_MAX_RECORDS)
  assert.equal(resolved.maxBodyChars, DEFAULT_MAX_BODY_CHARS)
  assert.equal(resolved.persist, true)
  assert.equal(resolved.maxPersistedRecords, DEFAULT_MAX_PERSISTED)
  assert.equal(resolved.historyPageLimit, DEFAULT_PAGE_LIMIT)
  assert.equal(resolved.prettyBodyLimit, DEFAULT_PRETTY_BODY_LIMIT)
  assert.ok(resolved.traceDir.endsWith('llm-wire-trace/records') || resolved.traceDir.endsWith('llm-wire-trace\\records'))
})

test('resolveEffectiveConfig: persist is true unless explicitly false', () => {
  assert.equal(resolveEffectiveConfig({ persist: false }, {}).persist, false)
  assert.equal(resolveEffectiveConfig({}, {}).persist, true)
})

test('resolveEffectiveConfig: an explicit traceDir wins over $DSH_HOME', () => {
  const resolved = resolveEffectiveConfig({ traceDir: '/custom/dir' }, { DSH_HOME: '/dsh-home' })
  assert.equal(resolved.traceDir, '/custom/dir')
})

test('resolveEffectiveConfig: explicit values override every default', () => {
  const resolved = resolveEffectiveConfig({
    maxRecords: 1,
    maxBodyChars: 2,
    maxPersistedRecords: 3,
    historyPageLimit: 4,
    prettyBodyLimit: 5,
  }, {})
  assert.equal(resolved.maxRecords, 1)
  assert.equal(resolved.maxBodyChars, 2)
  assert.equal(resolved.maxPersistedRecords, 3)
  assert.equal(resolved.historyPageLimit, 4)
  assert.equal(resolved.prettyBodyLimit, 5)
})

// -- Config: the runtime schema accepts a valid config and fills defaults --

test('Config: an empty object validates, filling every default', () => {
  const resolved = Config({})
  assert.equal(resolved.maxRecords, DEFAULT_MAX_RECORDS)
  assert.equal(resolved.maxBodyChars, DEFAULT_MAX_BODY_CHARS)
  assert.equal(resolved.persist, true)
  assert.equal(resolved.maxPersistedRecords, DEFAULT_MAX_PERSISTED)
  assert.equal(resolved.historyPageLimit, DEFAULT_PAGE_LIMIT)
  assert.equal(resolved.prettyBodyLimit, DEFAULT_PRETTY_BODY_LIMIT)
})

test('Config: explicit values pass through unchanged', () => {
  const resolved = Config({ maxRecords: 50, persist: false, traceDir: '/tmp/x' })
  assert.equal(resolved.maxRecords, 50)
  assert.equal(resolved.persist, false)
  assert.equal(resolved.traceDir, '/tmp/x')
})

test('Config: rejects a non-positive maxRecords', () => {
  assert.throws(() => Config({ maxRecords: 0 }))
  assert.throws(() => Config({ maxRecords: -1 }))
})

test('Config: rejects historyPageLimit above the list page ceiling', () => {
  assert.throws(() => Config({ historyPageLimit: 100000 }))
})

test('Config: rejects a non-boolean persist', () => {
  assert.throws(() => Config({ persist: 'yes' as any }))
})

// -- CONFIG_FIELDS: the field list the config route validates patches against --

test('CONFIG_FIELDS lists exactly the PluginConfig keys the schema declares', () => {
  assert.deepEqual([...CONFIG_FIELDS].sort(), [
    'historyPageLimit',
    'maxBodyChars',
    'maxPersistedRecords',
    'maxRecords',
    'persist',
    'prettyBodyLimit',
    'traceDir',
  ])
})
