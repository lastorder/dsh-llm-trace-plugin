/**
 * `PluginManageView`: this plugin's own content inside DSH's "Plugins"
 * management page (the `plugins.bundle.config` Slot, keyed by this package's
 * npm name — see `entry.ts`). Two things live here, because neither fits
 * anywhere else in this plugin's own Wire Trace tab:
 *
 *   - Local cache stats (the in-memory ring count, and the persisted count
 *     when disk storage is on) plus a "Clear all history" button that wipes
 *     every session's records at once — the Wire Trace tab's own "Clear"
 *     button is scoped to the session it is opened from (see
 *     `wire-trace-view.ts`), so a page-wide wipe needs its own home.
 *   - Every {@link PluginConfig} parameter, read from and written through the
 *     `config` route (`GET`/`POST /llm-wire-trace/config`), which itself
 *     degrades to a read-only report when the host exposes no profile-config
 *     writer service (`editable: false`) — see the module doc on that route
 *     in `routes.ts` for why writes can only ever target this plugin's own
 *     row.
 *
 * Written against the same minimal React-like interface as
 * `wire-trace-view.ts`, for the same classic-script reason (see that file's
 * doc comment).
 *
 * @module dsh-llm-trace-plugin/client/plugin-manage-view
 */

import { apiGet, apiPost } from './api-client.js'
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
 * than imported for the same classic-script/no-cross-boundary-import reason
 * `ROUTE`/`PACKAGE_NAME` are duplicated in `constants.ts`; pinned by
 * `test/client/plugin-manage-view.test.ts`.
 */
export const CONFIG_FIELDS: readonly ConfigFieldSpec[] = [
  { key: 'maxRecords', type: 'number' },
  { key: 'maxBodyChars', type: 'number' },
  { key: 'persist', type: 'boolean' },
  { key: 'traceDir', type: 'string' },
  { key: 'maxPersistedRecords', type: 'number' },
  { key: 'historyPageLimit', type: 'number' },
  { key: 'prettyBodyLimit', type: 'number' },
]

/**
 * Each field's documented default, as the draft text it would render —
 * shown when the `config` route cannot be read at all (an older host build
 * with no such route, a network hiccup, anything), so the panel always has
 * SOMETHING concrete to show instead of an error with no further action.
 * Mirrors the defaults `src/host/config.ts`'s `Config` schema declares;
 * pinned alongside `CONFIG_FIELDS` by `test/client/plugin-manage-view.test.ts`.
 * `traceDir` has no fixed default (it depends on `$DSH_HOME`), so its row
 * shows blank here — the field's hint already explains what blank means.
 */
export const CONFIG_FIELD_DEFAULTS: Readonly<Record<string, string>> = {
  maxRecords: '200',
  maxBodyChars: '8000000',
  persist: 'true',
  traceDir: '',
  maxPersistedRecords: '300',
  historyPageLimit: '50',
  prettyBodyLimit: '500000',
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
    // True whenever `GET config` could not be read at all, for ANY reason —
    // an older host build with no such route (installing/updating a plugin
    // does not hot-reload host code; see the README's "Install" notes on
    // restarting `dsh web`), a network hiccup, anything. Rather than
    // surfacing that failure as an error with no action the reader can take,
    // the panel falls back to each field's documented default
    // (`CONFIG_FIELD_DEFAULTS`) so there is always something concrete shown.
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

    /** Parse one field's draft text and `POST` it; empty text unsets the field (reverts to default). */
    function saveField(field: ConfigFieldSpec, raw: string | boolean): void {
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
        value = raw === '' ? null : raw
      }
      setSavingField(field.key)
      setFieldNotice(null)
      apiPost('config', { [field.key]: value }).then(
        () => {
          setSavingField(null)
          setFieldNotice({ field: field.key, kind: 'ok', text: t('manage.fieldSaved') })
          setConfigTick((n: number) => n + 1)
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

    const statsLine = stats === null
      ? t('manage.statsLoading')
      : (stats.persistence
        ? t('manage.statsLine', { memory: stats.memory, retained: stats.retained ?? 0, maxRecords: stats.maxRecords ?? '—' })
        : t('manage.statsLineNoPersist', { memory: stats.memory }))

    const fieldRows = CONFIG_FIELDS.map((field) => {
      const draft = drafts[field.key] ?? ''
      const disabled = configUsingDefaults || configState === null || configState.editable === false || savingField === field.key
      const input = field.type === 'boolean'
        ? h('input', {
          key: 'input',
          type: 'checkbox',
          checked: draft === 'true',
          disabled,
          onChange: (event: any) => {
            const checked = !!(event && event.target && event.target.checked)
            setDrafts((prev: Record<string, string>) => ({ ...prev, [field.key]: String(checked) }))
            saveField(field, checked)
          },
        })
        : h('input', {
          key: 'input',
          type: field.type === 'number' ? 'number' : 'text',
          className: 'wt-mfield-input',
          value: draft,
          disabled,
          onChange: (event: any) => {
            const value = event && event.target ? event.target.value : ''
            setDrafts((prev: Record<string, string>) => ({ ...prev, [field.key]: value }))
          },
          onBlur: () => saveField(field, draft),
          onKeyDown: (event: any) => {
            if (event && event.key === 'Enter' && event.target && typeof event.target.blur === 'function') event.target.blur()
          },
        })
      const notice = fieldNotice !== null && fieldNotice.field === field.key ? fieldNotice : null
      return h('div', { className: 'wt-mfield', key: field.key }, [
        h('label', { className: 'wt-mfield-label', key: 'l' }, t(`manage.field.${field.key}.label`)),
        input,
        h('div', { className: 'wt-mfield-hint', key: 'h' }, t(`manage.field.${field.key}.hint`)),
        notice === null ? null : h('div', { className: 'wt-mfield-notice', 'data-k': notice.kind, key: 'n' }, notice.text),
      ].filter(Boolean))
    })

    return h('div', { className: 'wt-manage' }, [
      h('div', { className: 'wt-manage-stats', key: 'stats' }, [
        h('span', { className: 'wt-manage-stats-label', key: 'l' }, t('manage.statsLabel')),
        h('span', { className: 'wt-manage-stats-line', key: 'v' }, statsLine),
        h('button', {
          className: 'wt-btn',
          key: 'clear',
          title: t('manage.clearAllTitle'),
          disabled: clearBusy,
          onClick: clearAll,
        }, t('manage.clearAllButton')),
      ]),
      statsError === null ? null : h('div', { className: 'wt-err', key: 'stats-err' }, t('manage.statsError', { message: statsError })),
      clearNotice === null ? null : h('div', { className: 'wt-jnotice', key: 'clear-notice' }, clearNotice),
      h('div', { className: 'wt-manage-fields', key: 'fields' }, [
        h('div', { className: 'wt-manage-fields-label', key: 'label' }, t('manage.fieldsLabel')),
        configUsingDefaults
          ? h('div', { className: 'wt-jnotice', key: 'defaults' }, t('manage.fieldsUsingDefaults'))
          : (configState === null
            ? h('div', { className: 'wt-jnotice', key: 'loading' }, t('manage.fieldsLoading'))
            : (configState.editable === false
              ? h('div', { className: 'wt-jnotice', key: 'ro' }, t('manage.fieldsReadOnlyNotice'))
              : null)),
        ...fieldRows,
      ].filter(Boolean)),
    ].filter(Boolean))
  }
}
