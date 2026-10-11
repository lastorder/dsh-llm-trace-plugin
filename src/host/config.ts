/**
 * Plugin configuration: the user-facing shape, its runtime-validated schema,
 * and resolving a (possibly partial) config into the effective values the
 * rest of the host half actually uses.
 *
 * Split out of `index.ts` deliberately: this module has no Cordis dependency
 * at all (it is plain `@deepseek-ai/schemastery` usage plus arithmetic), so
 * it is directly unit-testable the same way `persistence/naming.ts` is —
 * unlike `index.ts`, which stays Cordis glue only (see `docs/architecture.md`).
 *
 * @module dsh-llm-trace-plugin/host/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_BODY_CHARS, DEFAULT_MAX_RECORDS, LIST_PAGE_CEILING } from './constants.js'
import { DEFAULT_MAX_PERSISTED, DEFAULT_PAGE_LIMIT, DEFAULT_PRETTY_BODY_LIMIT } from './persistence/constants.js'
import { resolveTraceDir } from './persistence/naming.js'

/** User-facing plugin configuration; every field is optional and defaults as documented below. */
export interface PluginConfig {
  /** In-memory ring-buffer size: how many recent records stay resident regardless of persistence. */
  maxRecords?: number
  /** Per-field character cap on a captured request/response body before truncation. */
  maxBodyChars?: number
  /** Write records to disk under `traceDir`. `false` keeps a pure in-memory ring with nothing written to disk. */
  persist?: boolean
  /** Directory records are persisted under. Defaults to `$DSH_HOME/llm-wire-trace/records` (or `~/.dsh/llm-wire-trace/records`). */
  traceDir?: string
  /** Retained record files on disk before the oldest are swept. */
  maxPersistedRecords?: number
  /** Files read per archive listing page. */
  historyPageLimit?: number
  /** Above this body size, the pretty-printed on-disk readability copy is not written. */
  prettyBodyLimit?: number
}

/**
 * Runtime schema for {@link PluginConfig}, validated by Cordis at activation
 * and readable through the `Config` Inspect provider (`Config.listConfigs`).
 * Every field carries the same default this module's own fallbacks already
 * applied, so declaring this schema changes no runtime behavior — it only
 * makes every parameter discoverable and editable through DSH's own plugin
 * configuration surfaces instead of requiring a reader to open this source.
 */
export const Config: z<PluginConfig> = z.object({
  maxRecords: z.number().step(1).min(1).default(DEFAULT_MAX_RECORDS)
    .description('In-memory ring-buffer size: how many recent records stay resident regardless of persistence.'),
  maxBodyChars: z.number().step(1).min(1).default(DEFAULT_MAX_BODY_CHARS)
    .description('Per-field character cap on a captured request/response body before truncation.'),
  persist: z.boolean().default(true)
    .description('Write records to disk under traceDir. Disable for a pure in-memory ring with nothing written to disk.'),
  traceDir: z.string()
    .description('Directory records are persisted under. Defaults to $DSH_HOME/llm-wire-trace/records (or ~/.dsh/llm-wire-trace/records).'),
  maxPersistedRecords: z.number().step(1).min(1).default(DEFAULT_MAX_PERSISTED)
    .description('Retained record files on disk before the oldest are swept.'),
  historyPageLimit: z.number().step(1).min(1).max(LIST_PAGE_CEILING).default(DEFAULT_PAGE_LIMIT)
    .description('Files read per archive listing page.'),
  prettyBodyLimit: z.number().step(1).min(1).default(DEFAULT_PRETTY_BODY_LIMIT)
    .description('Above this body size, the pretty-printed on-disk readability copy is not written.'),
})

/** Every {@link PluginConfig} field, fully resolved to the value actually in effect. */
export interface ResolvedPluginConfig {
  maxRecords: number
  maxBodyChars: number
  persist: boolean
  traceDir: string
  maxPersistedRecords: number
  historyPageLimit: number
  prettyBodyLimit: number
}

/**
 * Resolve a (possibly partial, possibly absent) config to the values the rest
 * of the host half uses. Mirrors the fallbacks `index.ts`/`store.ts`/
 * `persistence/archive.ts` already apply individually, collected in one place
 * so a reader (and the `config` route's `GET`) can see the effective values
 * without re-deriving them per module.
 * @param config - raw plugin config, or undefined for an unconfigured plugin.
 * @param env - environment to resolve `traceDir`'s default against; defaults to `process.env`.
 */
export function resolveEffectiveConfig(
  config: PluginConfig | undefined,
  env?: Record<string, string | undefined>,
): ResolvedPluginConfig {
  const settings = config ?? {}
  return {
    maxRecords: settings.maxRecords || DEFAULT_MAX_RECORDS,
    maxBodyChars: settings.maxBodyChars || DEFAULT_MAX_BODY_CHARS,
    persist: settings.persist !== false,
    traceDir: resolveTraceDir(settings.traceDir, env),
    maxPersistedRecords: settings.maxPersistedRecords ?? DEFAULT_MAX_PERSISTED,
    historyPageLimit: settings.historyPageLimit ?? DEFAULT_PAGE_LIMIT,
    prettyBodyLimit: settings.prettyBodyLimit ?? DEFAULT_PRETTY_BODY_LIMIT,
  }
}

/** Every editable field name, in the order the management UI renders them. */
export const CONFIG_FIELDS = [
  'maxRecords',
  'maxBodyChars',
  'persist',
  'traceDir',
  'maxPersistedRecords',
  'historyPageLimit',
  'prettyBodyLimit',
] as const satisfies readonly (keyof PluginConfig)[]
