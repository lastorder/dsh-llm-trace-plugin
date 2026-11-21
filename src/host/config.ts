/**
 * Plugin configuration: the user-facing shape, its runtime-validated schema,
 * and resolving a (possibly partial) config into the effective values the
 * rest of the host half actually uses.
 *
 * Split out of `index.ts` deliberately: this module has no Cordis dependency
 * at all (it is plain `@deepseek-ai/schemastery` usage plus arithmetic), so
 * it is directly unit-testable — unlike `index.ts`, which stays Cordis glue
 * only (see `docs/architecture.md`).
 *
 * @module dsh-llm-trace-plugin/host/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_DISK_MB, MIN_MAX_DISK_MB } from './persistence/constants.js'
import { resolveTraceDir } from './persistence/naming.js'

/** User-facing plugin configuration; every field is optional. */
export interface PluginConfig {
  /** Write records to disk under `traceDir`. `false` keeps the most recent records in memory only. */
  persist?: boolean
  /** Disk budget in megabytes; the oldest records are deleted beyond it. */
  maxDiskMB?: number
  /** Directory records are persisted under. Defaults to `$DSH_HOME/llm-wire-trace/records` (or `~/.dsh/llm-wire-trace/records`). */
  traceDir?: string
}

/**
 * Options earlier versions accepted. Their values are ignored; a config save
 * from the management page drops them so the profile does not keep carrying
 * settings that no longer do anything.
 */
export const LEGACY_CONFIG_FIELDS = [
  'maxRecords',
  'maxBodyChars',
  'maxPersistedRecords',
  'historyPageLimit',
  'prettyBodyLimit',
] as const

/**
 * Runtime schema for {@link PluginConfig}, validated by Cordis at activation
 * and readable through the `Config` Inspect provider (`Config.listConfigs`).
 * Unknown keys (including {@link LEGACY_CONFIG_FIELDS}) pass through
 * untouched, so an older profile config still activates.
 */
export const Config: z<PluginConfig> = z.object({
  persist: z.boolean().default(true)
    .description('Write records to disk under traceDir. Disable to keep the most recent records in memory only.'),
  maxDiskMB: z.number().step(1).min(MIN_MAX_DISK_MB).default(DEFAULT_MAX_DISK_MB)
    .description('Disk budget in megabytes. Beyond it the oldest records are deleted.'),
  traceDir: z.string()
    .description('Directory records are persisted under. Defaults to $DSH_HOME/llm-wire-trace/records (or ~/.dsh/llm-wire-trace/records).'),
})

/** Every {@link PluginConfig} field, fully resolved to the value actually in effect. */
export interface ResolvedPluginConfig {
  persist: boolean
  maxDiskMB: number
  traceDir: string
}

/**
 * Resolve a (possibly partial, possibly absent) config to the values the rest
 * of the host half uses, in one place, so `index.ts` and the `config` route's
 * `GET` agree on what "the config currently in effect" means.
 * @param config - raw plugin config, or undefined for an unconfigured plugin.
 * @param env - environment to resolve `traceDir`'s default against; defaults to `process.env`.
 */
export function resolveEffectiveConfig(
  config: PluginConfig | undefined,
  env?: Record<string, string | undefined>,
): ResolvedPluginConfig {
  const settings = config ?? {}
  const budget = typeof settings.maxDiskMB === 'number' && Number.isFinite(settings.maxDiskMB)
    ? Math.max(MIN_MAX_DISK_MB, Math.floor(settings.maxDiskMB))
    : DEFAULT_MAX_DISK_MB
  return {
    persist: settings.persist !== false,
    maxDiskMB: budget,
    traceDir: resolveTraceDir(settings.traceDir, env),
  }
}

/** Every editable field name, in the order the management UI renders them. */
export const CONFIG_FIELDS = [
  'persist',
  'maxDiskMB',
  'traceDir',
] as const satisfies readonly (keyof PluginConfig)[]
