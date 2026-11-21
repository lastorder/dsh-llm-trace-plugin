/**
 * `PluginManageView`: this plugin's own content inside DSH's "Plugins"
 * management page (the `plugins.bundle.config` Slot, keyed by this package's
 * npm name — see `entry.ts`). Two blocks:
 *
 *   - Local storage: how many records are saved, how much disk they use
 *     against the budget, the oldest one, and a "Clear all history" button
 *     (the Wire Trace tab's own "Clear" is scoped to its session, so a
 *     page-wide wipe needs its own home). A capture-gap warning appears here
 *     when a provider's model calls reached no captured request.
 *   - Settings: the three {@link PluginConfig} fields, read from and written
 *     through the `config` route, which degrades to a read-only report when
 *     the host exposes no profile-config writer service (`editable: false`).
 *
 * Written against the same minimal React-like interface as
 * `wire-trace-view.ts`, for the same classic-script reason.
 *
 * @module dsh-llm-trace-plugin/client/plugin-manage-view
 */

import { apiGet, apiPost } from './api-client.js'
import { fmtBytes, fmtDateTime } from './format.js'
import { fmtCount } from './json-model.js'
import type { ViewContext, WireTraceReact } from './wire-trace-view.js'

/** How a config field's draft text is interpreted and sent. */
export type ConfigFieldType = 'number' | 'boolean' | 'string'

export interface ConfigFieldSpec {
  key: string
  type: ConfigFieldType
}

/**
 * Every editable {@link PluginConfig} field, in the order the panel renders
 * them. Mirrors `CONFIG_FIELDS` in `src/host/config.ts` — duplicated rather
 * than imported for the same no-cross-boundary-import reason `ROUTE` is
 * duplicated in `constants.ts`; pinned by `test/client/plugin-manage-view.test.ts`.
 */
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  { key: 'persist', type: 'boolean' },
  { key: 'maxDiskMB', type: 'number' },
  { key: 'traceDir', type: 'string' },
]

/**
 * Each field's documented default, as draft text — shown when the `config`
 * route cannot be read at all, so the panel always shows something concrete.
 * Pinned against `src/host/config.ts`'s `resolveEffectiveConfig` by the same
 * test. `traceDir` depends on `$DSH_HOME`, so it shows blank (its hint says
 * what blank means).
 */
export const CONFIG_FIELD_DEFAULTS: Readonly<Record<string, string>> = {
  persist: 'true',
  maxDiskMB: '1024',
  traceDir: '',
}

/** The owner props DSH's Plugins page renders `plugins.bundle.config` with. */
export interface PluginManageViewProps {
  view: 'summary' | 'page'
}

/** Build the `PluginManageView` component bound to one React runtime and plugin ctx. */
export function createPluginManageView(React: WireTraceReact, ctx: ViewContext) {
  const h = React.createElement

  return function PluginManageView(props: PluginManageViewProps) {
    const { t } = ctx
    const [, forceLocaleRefresh] = React.useState(0)
    React.useEffect(() => ctx.subscribeLocale(() => forceLocaleRefresh((n: number) => n + 1)), [])

    const [stats, setStats] = React.useState<any>(null)
    const [statsError, setStatsError] = React.useState<string | null>(null)
    const [statsTick, setStatsTick] = React.useState(0)

    const [configState, setConfigState] = React.useState<{ editable: boolean, values: Record<string, unknown> } | null>(null)
    // True whenever `GET config` could not be read at all (an older host
    // build, a network hiccup): the panel then shows each field's default
    // rather than an error the reader can do nothing about.
    const [configUsingDefaults, setConfigUsingDefaults] = React.useState(false)
    const [configTick, setConfigTick] = React.useState(0)
    const [drafts, setDrafts] = React.useState<Record<string, string>>({})
    const [savingField, setSavingField] = React.useState<string | null>(null)
    const [fieldNotice, setFieldNotice] = React.useState<{ field: string, kind: 'ok' | 'err', text: string } | null>(null)

    const [clearBusy, setClearBusy] = React.useState(false)
    const [clearNotice, setClearNotice] = React.useState<string | null>(null)

    React.useEffect(() => {
      let alive = true
      apiGet('stats').then(
        (result: any) => { if (alive) { setStats(result); setStatsError(null) } },
        (reason: any) => { if (alive) setStatsError(String((reason && reason.message) || reason)) },
      )
      return () => { alive = false }
    }, [statsTick])

    // While an earlier version's records are being imported the numbers move,
    // so follow them until the import is done.
    React.useEffect(() => {
      if (stats === null || !(Number(stats.legacyPending) > 0)) return undefined
      return ctx.interval(() => setStatsTick((n: number) => n + 1), 1500)
    }, [stats])

    React.useEffect(() => {
      let alive = true
      apiGet('config').then(
        (result: any) => {
          if (!alive) return
          const values = (result && result.values) || {}
          setConfigState({ editable: result && result.editable === true, values })
          setConfigUsingDefaults(false)
          const nextDrafts: Record<string, string> = {}
          for (const field of CONFIG_FIELDS) {
            const value = values[field.key]
            nextDrafts[field.key] = value === undefined || value === null ? '' : String(value)
          }
          setDrafts(nextDrafts)
        },
        () => {
          if (!alive) return
          setConfigState(null)
          setConfigUsingDefaults(true)
          setDrafts({ ...CONFIG_FIELD_DEFAULTS })
        },
      )
      return () => { alive = false }
    }, [configTick])

    if (props.view !== 'page') return null

    /** The value currently in effect for a field, as draft text. */
    const savedText = (key: string): string => {
      const value = configState === null ? undefined : configState.values[key]
      return value === undefined || value === null ? '' : String(value)
    }

    /** Parse one field's draft and `POST` it; empty text unsets the field (back to its default). */
    function saveField(field: ConfigFieldSpec, raw: string | boolean): void {
      // Leaving a field without changing it must not write anything — least of
      // all the resolved default directory as an explicit setting.
      if (field.type !== 'boolean' && String(raw) === savedText(field.key)) return
      let value: unknown
      if (field.type === 'boolean') {
        value = raw as boolean
      } else if (field.type === 'number') {
        const trimmed = String(raw).trim()
        if (trimmed === '') {
          value = null
        } else {
          const parsed = Number(trimmed)
          if (!Number.isFinite(parsed)) {
            setFieldNotice({ field: field.key, kind: 'err', text: t('manage.fieldSaveFailed', { message: trimmed + ' is not a number' }) })
            return
          }
          value = parsed
        }
      } else {
        value = String(raw).trim() === '' ? null : String(raw).trim()
      }
      setSavingField(field.key)
      setFieldNotice(null)
      apiPost('config', { [field.key]: value }).then(
        () => {
          setSavingField(null)
          setFieldNotice({ field: field.key, kind: 'ok', text: t('manage.fieldSaved') })
          setConfigTick((n: number) => n + 1)
          // A new budget or directory changes what the storage block reports.
          setStatsTick((n: number) => n + 1)
        },
        (reason: any) => {
          setSavingField(null)
          setFieldNotice({ field: field.key, kind: 'err', text: t('manage.fieldSaveFailed', { message: String((reason && reason.message) || reason) }) })
        },
      )
    }

    function clearAll(): void {
      if (clearBusy) return
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('manage.clearAllConfirm'))) return
      setClearBusy(true)
      setClearNotice(null)
      // No `sessionId`: this is the page-wide wipe, distinct from the Wire
      // Trace tab's own session-scoped "Clear" button.
      apiPost('clear', {}).then(
        () => {
          setClearBusy(false)
          setClearNotice(t('manage.clearAllDone'))
          setStatsTick((n: number) => n + 1)
        },
        (reason: any) => {
          setClearBusy(false)
          setClearNotice(t('manage.clearAllFailed', { message: String((reason && reason.message) || reason) }))
        },
      )
    }

    // ---- storage block ---------------------------------------------------
    const persisted = stats !== null && stats.persistence === true
    const retained = persisted ? Number(stats.retained) || 0 : 0
    const used = persisted ? Number(stats.diskBytes) || 0 : 0
    const budget = persisted ? Number(stats.maxDiskBytes) || 0 : 0
    const ratio = budget > 0 ? Math.min(1, used / budget) : 0

    const summary = stats === null
      ? t('manage.statsLoading')
      : (!persisted
        ? t('manage.memoryOnlyLine', { memory: fmtCount(Number(stats.memory) || 0) })
        : (retained === 0
          ? t('manage.storageEmpty')
          : t('manage.storageLine', { retained: fmtCount(retained), oldest: fmtDateTime(stats.oldestAt) })))

    const usage = !persisted || budget <= 0 ? null : h('div', { className: 'wt-usage', key: 'usage', title: t('manage.storageUsageTitle') }, [
      h('div', { className: 'wt-usage-bar', key: 'bar', 'data-high': ratio >= 0.9 ? '1' : '0' }, [
        h('div', { className: 'wt-usage-fill', key: 'fill', style: { width: (ratio * 100).toFixed(1) + '%' } }),
      ]),
      h('span', { className: 'wt-usage-text', key: 'text' }, t('manage.storageUsage', { used: fmtBytes(used), budget: fmtBytes(budget) })),
    ])

    const legacy = stats !== null && Number(stats.legacyPending) > 0
      ? h('div', { className: 'wt-jnotice', key: 'legacy' }, t('manage.legacyPending', { count: fmtCount(Number(stats.legacyPending)) }))
      : null

    /**
     * A provider whose model calls produced NO captured request: the
     * difference between a trace that is empty because nothing happened and
     * one that is empty because the provider's transport never reached the
     * fetch patch (see the README's "Known limitation"). Scans rather than
     * indexes, so an older host build simply shows nothing.
     */
    const untracedProvider = stats === null || stats.coverage === undefined || !Array.isArray(stats.coverage.providers)
      ? null
      : stats.coverage.providers.find((entry: any) => Number(entry && entry.untracedCalls) > 0) ?? null
    const captureWarning = untracedProvider === null
      ? null
      : h('div', { className: 'wt-err', key: 'capture-warning' }, t('manage.captureWarning', {
        provider: untracedProvider.provider,
        untraced: untracedProvider.untracedCalls,
        modelCalls: untracedProvider.modelCalls,
      }))

    // ---- settings block --------------------------------------------------
    const fieldRows = CONFIG_FIELDS.map((field) => {
      const draft = drafts[field.key] ?? ''
      const disabled = configUsingDefaults || configState === null || configState.editable === false || savingField === field.key
      let input: any
      if (field.type === 'boolean') {
        input = h('label', { className: 'wt-switch', key: 'input', 'data-on': draft === 'true' ? '1' : '0', 'data-disabled': disabled ? '1' : '0' }, [
          h('input', {
            key: 'box',
            type: 'checkbox',
            checked: draft === 'true',
            disabled,
            onChange: (event: any) => {
              const checked = !!(event && event.target && event.target.checked)
              setDrafts((prev: Record<string, string>) => ({ ...prev, [field.key]: String(checked) }))
              saveField(field, checked)
            },
          }),
          h('span', { className: 'wt-switch-track', key: 'track', 'aria-hidden': 'true' }),
        ])
      } else {
        const box = h('input', {
          key: 'box',
          type: field.type === 'number' ? 'number' : 'text',
          className: 'wt-mfield-input',
          value: draft,
          disabled,
          spellCheck: false,
          min: field.key === 'maxDiskMB' ? 16 : undefined,
          step: field.key === 'maxDiskMB' ? 128 : undefined,
          onChange: (event: any) => {
            const value = event && event.target ? event.target.value : ''
            setDrafts((prev: Record<string, string>) => ({ ...prev, [field.key]: value }))
          },
          onBlur: () => saveField(field, draft),
          onKeyDown: (event: any) => {
            if (event && event.key === 'Enter' && event.target && typeof event.target.blur === 'function') event.target.blur()
          },
        })
        input = field.key === 'maxDiskMB'
          ? h('span', { className: 'wt-mfield-unit', key: 'input' }, [box, h('span', { key: 'u' }, t('manage.field.maxDiskMB.unit'))])
          : box
      }
      const notice = fieldNotice !== null && fieldNotice.field === field.key ? fieldNotice : null
      return h('div', { className: 'wt-mfield', key: field.key, 'data-k': field.type }, [
        h('div', { className: 'wt-mfield-text', key: 'text' }, [
          h('div', { className: 'wt-mfield-label', key: 'l' }, t(`manage.field.${field.key}.label`)),
          h('div', { className: 'wt-mfield-hint', key: 'h' }, t(`manage.field.${field.key}.hint`)),
          notice === null ? null : h('div', { className: 'wt-mfield-notice', 'data-k': notice.kind, key: 'n' }, notice.text),
        ].filter(Boolean)),
        input,
      ])
    })

    const settingsNotice = configUsingDefaults
      ? h('div', { className: 'wt-jnotice', key: 'defaults' }, t('manage.fieldsUsingDefaults'))
      : (configState === null
        ? h('div', { className: 'wt-jnotice', key: 'loading' }, t('manage.fieldsLoading'))
        : (configState.editable === false
          ? h('div', { className: 'wt-jnotice', key: 'ro' }, t('manage.fieldsReadOnlyNotice'))
          : null))

    return h('div', { className: 'wt-manage' }, [
      h('section', { className: 'wt-msection', key: 'storage' }, [
        h('div', { className: 'wt-msection-head', key: 'head' }, [
          h('span', { className: 'wt-msection-title', key: 't' }, t('manage.statsLabel')),
          h('button', {
            className: 'wt-btn wt-btn-danger',
            key: 'clear',
            title: t('manage.clearAllTitle'),
            disabled: clearBusy,
            onClick: clearAll,
          }, t('manage.clearAllButton')),
        ]),
        h('div', { className: 'wt-msummary', key: 'summary' }, summary),
        usage,
        legacy,
        statsError === null ? null : h('div', { className: 'wt-err', key: 'stats-err' }, t('manage.statsError', { message: statsError })),
        captureWarning,
        clearNotice === null ? null : h('div', { className: 'wt-jnotice', key: 'clear-notice' }, clearNotice),
      ].filter(Boolean)),
      h('section', { className: 'wt-msection', key: 'settings' }, [
        h('div', { className: 'wt-msection-head', key: 'head' }, [
          h('span', { className: 'wt-msection-title', key: 't' }, t('manage.fieldsLabel')),
        ]),
        settingsNotice,
        ...fieldRows,
      ].filter(Boolean)),
    ])
  }
}
