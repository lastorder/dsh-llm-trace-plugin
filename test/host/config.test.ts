import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { CONFIG_FIELDS, Config, LEGACY_CONFIG_FIELDS, resolveEffectiveConfig } from '../../src/host/config.js'
import { DEFAULT_MAX_DISK_MB, MIN_MAX_DISK_MB } from '../../src/host/persistence/constants.js'

test('resolveEffectiveConfig: an absent config resolves every field to its documented default', () => {
  const resolved = resolveEffectiveConfig(undefined, { DSH_HOME: '/dsh' })
  assert.deepEqual(resolved, {
    persist: true,
    maxDiskMB: DEFAULT_MAX_DISK_MB,
    traceDir: join('/dsh', 'llm-wire-trace', 'records'),
  })
  assert.equal(DEFAULT_MAX_DISK_MB, 1024)
})

test('resolveEffectiveConfig: explicit values win; a budget below the minimum is raised to it', () => {
  assert.deepEqual(resolveEffectiveConfig({ persist: false, maxDiskMB: 256, traceDir: '/tmp/x' }, {}), {
    persist: false,
    maxDiskMB: 256,
    traceDir: '/tmp/x',
  })
  assert.equal(resolveEffectiveConfig({ maxDiskMB: 1 }, {}).maxDiskMB, MIN_MAX_DISK_MB)
  assert.equal(resolveEffectiveConfig({ maxDiskMB: 100.7 }, {}).maxDiskMB, 100)
  assert.equal(resolveEffectiveConfig({ maxDiskMB: Number.NaN }, {}).maxDiskMB, DEFAULT_MAX_DISK_MB)
})

test('resolveEffectiveConfig: options from earlier versions are ignored', () => {
  const resolved = resolveEffectiveConfig({ maxPersistedRecords: 3, maxRecords: 1 } as any, {})
  assert.deepEqual(Object.keys(resolved).sort(), ['maxDiskMB', 'persist', 'traceDir'])
})

test('Config: fills defaults and accepts valid values', () => {
  assert.deepEqual(Config({}), { persist: true, maxDiskMB: DEFAULT_MAX_DISK_MB })
  assert.equal(Config({ maxDiskMB: 64 }).maxDiskMB, 64)
})

test('Config: rejects a budget below the minimum, and a non-boolean persist', () => {
  assert.throws(() => Config({ maxDiskMB: MIN_MAX_DISK_MB - 1 }))
  assert.throws(() => Config({ persist: 'yes' as any }))
})

test('Config: a profile still carrying options from earlier versions activates', () => {
  assert.doesNotThrow(() => Config({ maxPersistedRecords: 300, prettyBodyLimit: 1 } as any))
})

test('CONFIG_FIELDS lists exactly the PluginConfig keys, and none of the legacy ones', () => {
  assert.deepEqual([...CONFIG_FIELDS], ['persist', 'maxDiskMB', 'traceDir'])
  for (const key of LEGACY_CONFIG_FIELDS) assert.ok(!(CONFIG_FIELDS as readonly string[]).includes(key))
})
