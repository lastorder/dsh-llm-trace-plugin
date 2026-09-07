/**
 * `WireTraceView`: the "Wire Trace" session tab. A two-pane list/detail view
 * over the host's captured wire records, with live polling of the in-memory
 * ring and a slower merged read of on-disk history.
 *
 * Written against a minimal React-like interface (see json-view.ts) rather
 * than importing `react` directly, matching this plugin's classic-script
 * client convention.
 *
 * @module dsh-llm-trace-plugin/client/wire-trace-view
 */

import { apiGet, apiPost, copy, download } from './api-client.js'
import { fmtDuration, fmtTime, purposeLabel, sessionLabel, shortSessionId, statusKind, stepBadge, stringify, type Translate } from './format.js'
import { fmtCount, maxDepthOf } from './json-model.js'
import { parseSseFrames, prettySseText } from './sse.js'
import { mergeSseChunks } from './sse-merge/index.js'
import { createJsonView, type ReactLike as MinimalReactLike } from './json-view.js'
import {
  describeBodyNotice,
  groupRows,
  isRawFallback,
  isSseResponse,
  mergeSummaryPages,
  normalizePage,
  RAW_KEY,
  selectRequestBody,
  selectResponseBody,
  shouldFallBackToAllSessions,
  stepDepth,
  turnStatFor,
  type ListPayload,
} from './view-model.js'
import type { WireRecord, WireRecordSummary } from '../shared/record-shape.js'

/**
 * Minimal shape of the plugin `ctx` this view needs: an `interval` timer
 * helper, plus the locale seat — `t` translates this plugin's own namespace
 * (see `strings.ts`), and `subscribeLocale` re-renders this component when
 * the user flips DSH's language setting while the tab is already mounted
 * (mirrors the pattern `@deepseek-ai/dsh-client-ui-conversation` uses for the
 * same purpose).
 */
export interface ViewContext {
  interval(fn: () => void, ms: number): () => void
  t: Translate
  subscribeLocale(fn: () => void): () => void
}

/** The full React runtime surface this component tree needs. */
export interface WireTraceReact extends MinimalReactLike {
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void]
  useEffect: (fn: () => (void | (() => void)), deps: any[]) => void
  useRef: <T>(initial: T) => { current: T }
  useCallback: <T extends (...args: any[]) => any>(fn: T, deps: any[]) => T
  Fragment: any
}

export interface WireTraceViewProps {
  sessionId?: string | number
}

/** Build the `WireTraceView` component bound to one React runtime and plugin ctx. */
export function createWireTraceView(React: WireTraceReact, ctx: ViewContext) {
  const h = React.createElement
  const JsonView = createJsonView(React)

  /**
   * `conversation.view` is a session-scoped slot, so the framework passes the
   * current session's id as a standard prop (the same channel ui-trajectory
   * reads). That id is what the session filter matches against the
   * `x-deepseek-harness-session-id` header the host half captured off the
   * wire.
   */
  return function WireTraceView(props: WireTraceViewProps) {
    const currentSessionId = (props && props.sessionId) ? String(props.sessionId) : null
    const { t } = ctx
    // Bumped by ctx.locale's subscribe whenever the active locale changes, so
    // an already-mounted tab re-renders with the new language immediately
    // instead of only after the next remount.
    const [, forceLocaleRefresh] = React.useState(0)
    React.useEffect(() => ctx.subscribeLocale(() => forceLocaleRefresh((n: number) => n + 1)), [])
    const [auto, setAuto] = React.useState(true)
    // Default to the current session: a wire trace opened from inside a
    // session is almost always being read about THAT session. The toggle
    // switches to the full store, which is the only place unattributed
    // records and other sessions' records are visible.
    const [onlySession, setOnlySession] = React.useState(true)
    const [items, setItems] = React.useState<WireRecordSummary[]>([])
    const [total, setTotal] = React.useState(0)
    const [matched, setMatched] = React.useState(0)
    const [unattributed, setUnattributed] = React.useState(0)
    const [turns, setTurns] = React.useState<{ turn: number, calls: number, steps: number }[]>([])
    const [auxiliary, setAuxiliary] = React.useState(0)
    const [selected, setSelected] = React.useState<string | null>(null)
    const [detail, setDetail] = React.useState<WireRecord | null>(null)
    const [tab, setTab] = React.useState<'request' | 'response'>('request')
    const [error, setError] = React.useState<string | null>(null)
    const [tick, setTick] = React.useState(0)
    // Container open/closed state is a global baseline depth plus per-path
    // manual overrides. The global +/- buttons reset the baseline and drop
    // every override (agreed rule): letting the two stack would make "why
    // didn't that branch move?" unanswerable.
    const [depth, setDepth] = React.useState(1)
    const [overrides, setOverrides] = React.useState<Map<string, boolean>>(() => new Map())
    const [longOpen, setLongOpen] = React.useState<Set<string>>(() => new Set())
    // Default view for an SSE response: the merged, reassembled reply (see
    // below), which is far more readable than dozens/hundreds of raw delta
    // frames. Toggled off to see the literal bytes on the wire instead.
    const [sseMerged, setSseMerged] = React.useState(true)
    const [curlBusy, setCurlBusy] = React.useState(false)
    const [curlNotice, setCurlNotice] = React.useState<string | null>(null)
    // One-shot escape hatch for a provider that never stamps the session
    // header at all (pi-ai puts the id only in an SDK-local option, never on
    // the wire). Under such a provider the default filter would match
    // nothing forever, so the FIRST filtered load that finds no records of
    // its own while unattributed ones exist falls back to the full list and
    // says why. It fires at most once, and any manual use of the toggle
    // disables it, so it can never fight the user's own choice.
    const [autoFellBack, setAutoFellBack] = React.useState(false)
    const fallbackUsed = React.useRef(false)

    // The host serves memory and disk as one merged page, so there is no
    // live-vs-history distinction to expose here: `truncated` only tells us
    // whether even older records exist beyond the read budget.
    const [truncated, setTruncated] = React.useState(false)
    // True while the on-disk history for the current filter has not been
    // folded in yet. The live records are already on screen at that point,
    // so this drives a quiet hint rather than a blocking spinner.
    const [historyLoading, setHistoryLoading] = React.useState(false)
    // Bumped to request a fresh history read: mount, manual refresh, or a
    // filter change. Polling deliberately does NOT bump it.
    const [historyTick, setHistoryTick] = React.useState(0)
    // True once a history payload has landed for the CURRENT filter.
    //
    // The two reads race by design: the memory read is fast and the history
    // read is slow, so a poll's memory response can land after history has
    // already arrived. Without this guard that late response would replace
    // the full list with a memory-only one and the older records would
    // visibly disappear. Reset on every filter change, because history for
    // the new filter has not arrived yet.
    const historyLanded = React.useRef(false)
    // Guards against request pile-up: when a poll is still in flight the next
    // tick is skipped instead of queueing another fetch behind it.
    const inFlight = React.useRef(false)

    // A missing session id (shouldn't happen in a session-scoped slot)
    // degrades to the unfiltered list rather than filtering against nothing
    // and showing a permanently empty tab.
    const filtering = onlySession && currentSessionId !== null

    /**
     * Apply one list payload to state.
     *
     * Shared by the fast in-memory read and the full history read so both
     * land identically — including the one-shot fallback for providers that
     * never stamp a session id on the wire.
     *
     * @returns false when the payload triggered the fallback and should
     *   therefore not be rendered.
     */
    const applyPage = React.useCallback((result: ListPayload | null, opts: { filtering: boolean, memoryOnly: boolean }) => {
      const page = normalizePage(result)
      if (shouldFallBackToAllSessions({
        filtering: opts.filtering,
        // Only a payload that actually consulted disk can prove there is
        // nothing of ours: an in-memory page may just not have reached this
        // session's records yet.
        decisive: !page.historyPending,
        alreadyUsed: fallbackUsed.current,
        matched: page.matched,
        unattributed: page.unattributed,
      })) {
        fallbackUsed.current = true
        setAutoFellBack(true)
        setOnlySession(false)
        return false
      }
      // A memory-only page is a partial view of the truth: it holds the live
      // records but none of the history. Once history has landed, fold live
      // rows INTO the existing list (by id, live copy winning) instead of
      // replacing it — otherwise a poll would erase history.
      if (opts.memoryOnly && historyLanded.current) {
        setItems((prev: WireRecordSummary[]) => mergeSummaryPages(prev, page.items))
        setError(null)
        return true
      }

      if (!opts.memoryOnly) historyLanded.current = true
      setItems(page.items)
      setTruncated(page.truncated)
      setTotal(page.total)
      setMatched(page.matched)
      setUnattributed(page.unattributed)
      setTurns(page.turns)
      setAuxiliary(page.auxiliary)
      setError(null)
      return true
    }, [])

    // Fast path. Reads the host's in-memory ring only — no file is opened, so
    // this stays cheap enough to run on every poll without ever stalling the
    // event loop the rest of the UI shares.
    React.useEffect(() => {
      if (inFlight.current) return undefined
      let alive = true
      inFlight.current = true
      apiGet('list', {
        limit: 100,
        source: 'memory',
        sessionId: filtering ? currentSessionId : undefined,
      }).then(
        (result: any) => {
          inFlight.current = false
          if (!alive) return
          applyPage(result, { filtering, memoryOnly: true })
        },
        (reason: any) => {
          inFlight.current = false
          if (alive) setError(String((reason && reason.message) || reason))
        },
      )
      return () => { alive = false }
    }, [tick, filtering, currentSessionId, applyPage])

    // Slow path, run only when the visible history could actually change:
    // opening the tab, changing the filter, or an explicit refresh. This is
    // the one that touches disk, and it is deliberately kept out of the
    // polling loop.
    React.useEffect(() => {
      let alive = true
      // History for this filter has not arrived yet, so a memory page is
      // once again allowed to define the list.
      historyLanded.current = false
      setHistoryLoading(true)
      apiGet('list', {
        limit: 100,
        sessionId: filtering ? currentSessionId : undefined,
      }).then(
        (result: any) => {
          if (!alive) return
          setHistoryLoading(false)
          applyPage(result, { filtering, memoryOnly: false })
        },
        (reason: any) => {
          if (!alive) return
          setHistoryLoading(false)
          setError(String((reason && reason.message) || reason))
        },
      )
      return () => { alive = false }
    }, [historyTick, filtering, currentSessionId, applyPage])

    React.useEffect(() => {
      if (!auto) return undefined
      return ctx.interval(() => {
        // A hidden tab has no reader, so polling it only burns work on a
        // shared event loop.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
        setTick((n: number) => n + 1)
      }, 3000)
    }, [auto])

    const selectedStatus = React.useMemo(() => {
      const found = items.find((item) => item.id === selected)
      return found ? found.status : null
    }, [items, selected])
    const detailTick = selectedStatus === 'streaming' ? tick : 0

    React.useEffect(() => {
      if (selected === null) {
        setDetail(null)
        return undefined
      }
      let alive = true
      apiGet('get', { id: selected }).then(
        (result: any) => { if (alive) setDetail(result) },
        (reason: any) => { if (alive) setError(String((reason && reason.message) || reason)) },
      )
      return () => { alive = false }
    }, [selected, detailTick])

    React.useEffect(() => {
      setDepth(1)
      setOverrides(new Map())
      setLongOpen(new Set())
    }, [selected, tab])

    React.useEffect(() => {
      setCurlNotice(null)
    }, [selected])

    const copyCurl = () => {
      if (detail === null || curlBusy) return
      setCurlBusy(true)
      setCurlNotice(null)
      apiGet('curl', { id: detail.id }).then(
        (result: any) => {
          setCurlBusy(false)
          copy(result.command)
          const auth = result.auth || { kind: 'env', envName: 'DSH_CURL_KEY' }
          if (auth.kind === 'value') {
            setCurlNotice(t('curl.copiedWithKey'))
          } else {
            setCurlNotice(t('curl.copiedWithEnvRef', { envName: auth.envName }))
          }
        },
        (reason: any) => {
          setCurlBusy(false)
          setCurlNotice(t('curl.failed', { message: String((reason && reason.message) || reason) }))
        },
      )
    }

    // A container is open when an explicit override says so, else when its
    // nesting level is within the global baseline depth.
    const isOpen = React.useCallback((path: string, lineDepth: number) => {
      const override = overrides.get(path)
      if (override !== undefined) return override
      return lineDepth < depth
    }, [overrides, depth])

    // Per-row toggle records an override that is the negation of whatever the
    // row currently shows, so one click always flips what you see.
    const toggle = React.useCallback((path: string, lineDepth: number) => {
      setOverrides((current: Map<string, boolean>) => {
        const next = new Map(current)
        const shown = current.has(path) ? current.get(path) : lineDepth < depth
        next.set(path, !shown)
        return next
      })
    }, [depth])

    const toggleLong = React.useCallback((path: string) => {
      setLongOpen((current: Set<string>) => {
        const next = new Set(current)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
    }, [])

    // What each tab renders in the JSON view; see `view-model.ts` for the
    // exact rules and why each shape was chosen.
    const isSse = isSseResponse(detail)
    const requestBody = selectRequestBody(detail)
    const responseBody = React.useMemo(
      () => selectResponseBody({
        detail,
        merged: sseMerged,
        parseFrames: parseSseFrames,
        mergeFrames: mergeSseChunks,
      }),
      [detail, sseMerged],
    )
    const treeValue = tab === 'request' ? requestBody : responseBody

    // Why the JSON view fell back to a single `__raw__` blob — overwhelmingly
    // because a body cut at the character cap stops mid-JSON and cannot parse.
    const shownBody = detail === null
      ? null
      : (tab === 'request' ? detail.request : detail.response)
    const rawFallback = isRawFallback(treeValue)
    const notice = describeBodyNotice({ treeValue, shown: shownBody })
    const bodyNotice = notice.kind === 'none'
      ? null
      : (notice.kind === 'truncated'
        ? t('notice.truncatedBody', { totalChars: fmtCount(notice.totalChars), keptChars: fmtCount(notice.keptChars) })
        : t('notice.notJson'))
    // The raw view shows the literal bytes only when the reader explicitly
    // asked to see them (`!sseMerged`); the merged view — including the
    // frame-list fallback if merging ever needed one — stays on the JSON
    // tree path above.
    const showRaw = tab === 'response' && isSse && !sseMerged
    // Frame structure stays verbatim and only each `data:` payload is
    // re-indented, so what you read still matches the bytes on the wire
    // frame-for-frame.
    const rawText = showRaw ? prettySseText(detail!.response!.bodyText) : ''
    const text = detail === null ? '' : stringify(tab === 'request' ? detail.request : detail.response)

    // Deepest nesting actually present, so `+` can stop at the point where it
    // would no longer change anything (and the button can disable).
    const contentDepth = React.useMemo(
      () => (treeValue === null ? 0 : maxDepthOf(treeValue, 64)),
      [treeValue],
    )

    // Global depth stepper: reset the baseline and drop manual overrides.
    const step = (delta: number) => {
      const next = stepDepth(depth, delta, contentDepth)
      if (next === depth) return
      setDepth(next)
      setOverrides(new Map())
    }

    const rows = items.map((item) => h(
      'div',
      {
        key: item.id,
        className: 'wt-item',
        'data-sel': item.id === selected ? '1' : '0',
        onClick: () => { setSelected(item.id); setTab('request') },
      },
      [
        h('div', { className: 'wt-row', key: 'r1' }, [
          // The coordinate leads the row: "which call is this" is the first
          // question a reader has, before model or status.
          (() => {
            const badge = stepBadge(item, t)
            return h('span', { className: 'wt-step', 'data-k': badge.kind, key: 'st', title: badge.title }, badge.text)
          })(),
          h('span', { className: 'wt-model', key: 'm' }, item.model || item.url),
          h('span', { className: 'wt-tag', 'data-k': statusKind(item.status), key: 's' }, item.status),
        ]),
        h('div', { className: 'wt-sub', key: 'r2' }, [
          h('span', { key: 't' }, fmtTime(item.startedAt)),
          h('span', { key: 'd' }, fmtDuration(item.durationMs)),
          h('span', { key: 'rs' }, item.responseStatus === null ? 'HTTP -' : 'HTTP ' + item.responseStatus),
          h('span', { key: 'm2' }, item.method),
        ]),
        h('div', { className: 'wt-sub', key: 'r3' }, [
          h('span', { key: 'req' }, item.requestChars + ' req chars'),
          h('span', { key: 'res' }, item.responseChars + ' resp chars'),
          // Only meaningful while the list mixes sessions; under the filter
          // every row is by definition the current session.
          filtering ? null : h('span', {
            key: 'sid',
            title: item.sessionId === null || item.sessionId === undefined
              ? t('session.noneTitle')
              : t('session.title', { sessionId: item.sessionId }),
          }, sessionLabel(item.sessionId, currentSessionId, t)),
        ].filter(Boolean)),
      ],
    ))

    // A sticky group header is emitted wherever the group changes going down
    // the list (newest-first, so turns descend). Grouping rules live in
    // `view-model.ts`; this only renders them.
    const groupHeaderContent = (group: { key: string, turn: number | null }) => {
      if (group.key === 'aux') return { text: t('group.auxiliary'), meta: t('group.auxiliaryMeta') }
      if (group.key === 'none') return { text: t('group.unattributed'), meta: t('group.unattributedMeta') }
      const stat = turnStatFor(turns, group.turn)
      return {
        text: t('turn.groupLabel', { turn: group.turn as number }),
        meta: stat === null ? '' : (stat.steps > 0
          ? t('turn.groupMetaWithSteps', { calls: stat.calls, steps: stat.steps })
          : t('turn.groupMetaNoSteps', { calls: stat.calls })),
      }
    }
    const groupedRows: any[] = []
    for (const group of groupRows(items)) {
      const head = groupHeaderContent(group)
      groupedRows.push(h('div', { className: 'wt-turn', key: 'g:' + group.key }, [
        h('span', { className: 'wt-turn-n', key: 'n' }, head.text),
        head.meta === '' ? null : h('span', { className: 'wt-turn-meta', key: 'm' }, head.meta),
      ].filter(Boolean)))
      for (let i = 0; i < group.items.length; i += 1) groupedRows.push(rows[group.start + i])
    }

    return h('div', { className: 'wt-root' }, [
      h('div', { className: 'wt-left', key: 'left' }, [
        h('div', { className: 'wt-bar', key: 'bar' }, [
          h('button', {
            className: 'wt-btn',
            key: 'auto',
            'data-on': auto ? '1' : '0',
            title: auto ? t('toolbar.autoOnTitle') : t('toolbar.autoOffTitle'),
            onClick: () => {
              const next = !auto
              setAuto(next)
              // A manual resume is the user asking to see everything now, so
              // it re-reads history too, not just the live ring.
              if (next) {
                setTick((n: number) => n + 1)
                setHistoryTick((n: number) => n + 1)
              }
            },
          }, auto ? t('toolbar.autoOn') : t('toolbar.autoOff')),
          h('button', {
            className: 'wt-btn',
            key: 'scope',
            'data-on': filtering ? '1' : '0',
            disabled: currentSessionId === null,
            title: currentSessionId === null
              ? t('toolbar.scopeUnavailableTitle')
              : (filtering ? t('toolbar.scopeFilteringTitle') : t('toolbar.scopeAllTitle')),
            onClick: () => {
              if (currentSessionId === null) return
              // An explicit choice ends the automatic fallback for good.
              fallbackUsed.current = true
              setAutoFellBack(false)
              setOnlySession(!onlySession)
            },
          }, filtering ? t('toolbar.scopeSession') : t('toolbar.scopeAll')),
          h('button', {
            className: 'wt-btn',
            key: 'clear',
            title: t('toolbar.clearTitle'),
            onClick: () => {
              apiPost('clear', {}).then(() => {
                setSelected(null)
                setTick((n: number) => n + 1)
                // Clearing deletes files, so the history half must be re-read
                // or the removed records would linger on screen.
                setHistoryTick((n: number) => n + 1)
              }, (reason: any) => setError(String(reason)))
            },
          }, t('toolbar.clear')),
          h('span', {
            className: 'wt-meta',
            key: 'meta',
            title: filtering ? t('toolbar.metaFilteredTitle') : t('toolbar.metaAllTitle'),
          }, (filtering ? matched : items.length) + ' / ' + total
            + (turns.length > 0 ? ' · ' + turns.length + ' turn' : '')
            + (auxiliary > 0 ? ' · ' + auxiliary + t('toolbar.auxiliarySuffix') : '')),
        ]),
        error === null ? null : h('div', { className: 'wt-err', key: 'err' }, error),
        h('div', { className: 'wt-list', key: 'list' },
          items.length === 0
            ? h('div', { className: 'wt-empty' }, filtering ? t('empty.filtered') : t('empty.all'))
            : [
              ...groupedRows,
              // Live records are already on screen; the disk half is still
              // arriving. Say so, so an incomplete list is never mistaken for
              // the whole history.
              historyLoading
                ? h('div', { className: 'wt-jnotice', key: '#history' }, t('notice.historyLoading'))
                : null,
              // The provider never stamped a session id, so the default
              // filter was dropped. Explain it where it was noticed.
              autoFellBack
                ? h('div', { className: 'wt-jnotice', key: '#fallback' }, t('notice.autoFellBack'))
                : null,
              // Records with no session identity are hidden by the filter,
              // but never silently: say how many, and where to see them.
              filtering && unattributed > 0
                ? h('div', { className: 'wt-jnotice', key: '#unattributed' }, t('notice.hiddenUnattributed', { count: fmtCount(unattributed), scopeAll: t('toolbar.scopeAll') }))
                : null,
              // Say so rather than implying the page showed everything: a
              // filtered history read stops at a bounded scan budget.
              truncated
                ? h('div', { className: 'wt-jnotice', key: '#truncated' }, t('notice.truncatedHistory'))
                : null,
            ].filter(Boolean)),
      ].filter(Boolean)),
      h('div', { className: 'wt-right', key: 'right' }, [
        h('div', { className: 'wt-tabs', key: 'tabs' }, [
          h('button', { className: 'wt-btn', key: 'req', 'data-on': tab === 'request' ? '1' : '0', onClick: () => setTab('request') }, t('tabs.request')),
          h('button', { className: 'wt-btn', key: 'res', 'data-on': tab === 'response' ? '1' : '0', onClick: () => setTab('response') }, t('tabs.response')),
          h('span', { className: 'wt-div', key: 'div' }),
          isSse && tab === 'response'
            ? h('button', {
              className: 'wt-btn',
              key: 'sse',
              // No data-on here, unlike this toolbar's other toggles.
              // Those (auto-refresh, session scope, Request/Response) keep a
              // FIXED label and use the highlight to show which state is
              // active. This button's label already IS the state indicator
              // — it always names the mode you'd switch TO — so a highlight
              // on top would just be redundant with the text, with no
              // stable "on" state to anchor it to.
              title: sseMerged ? t('tabs.sseShowRawTitle') : t('tabs.sseShowMergedTitle'),
              onClick: () => setSseMerged(!sseMerged),
            }, sseMerged ? t('tabs.sseShowRaw') : t('tabs.sseShowMerged'))
            : null,
          h('button', {
            className: 'wt-btn wt-btn-step',
            key: 'less',
            title: t('tabs.collapseTitle'),
            onClick: () => step(-1),
            disabled: detail === null || showRaw || depth <= 0,
          }, t('tabs.collapse')),
          h('button', {
            className: 'wt-btn wt-btn-step',
            key: 'more',
            title: t('tabs.expandTitle'),
            onClick: () => step(1),
            disabled: detail === null || showRaw || depth >= contentDepth,
          }, t('tabs.expand')),
          h('span', { className: 'wt-meta', key: 'depth' }, showRaw || detail === null ? '' : t('depth.label', { depth, contentDepth })),
          h('span', { className: 'wt-meta', key: 'sp' }, detail === null ? '' : detail.id + ' · ' + detail.request.method + ' ' + detail.request.url),
          h('button', {
            className: 'wt-btn',
            key: 'curl',
            disabled: detail === null || curlBusy,
            title: t('tabs.curlTitle'),
            onClick: copyCurl,
          }, curlBusy ? t('tabs.curlBusy') : t('tabs.curl')),
          h('button', { className: 'wt-btn', key: 'copy', onClick: () => copy(showRaw ? rawText : text) }, t('tabs.copy')),
          h('button', { className: 'wt-btn', key: 'dl', onClick: () => { if (detail !== null) download('llm-wire-trace-' + detail.id + '.json', stringify(detail)) } }, t('tabs.download')),
        ].filter(Boolean)),
        // Always-visible coordinate strip for the selected record: the
        // harness facts that the wire bytes below can never tell you.
        detail === null ? null : (() => {
          const badge = stepBadge(detail, t)
          const aux = purposeLabel(detail.purpose, t)
          const coord = (label: string, value: string, title: string) => h('span', { className: 'wt-coord', key: label, title }, [
            h('span', { key: 'l' }, label),
            h('b', { key: 'v' }, value),
          ])
          const parts: any[] = []
          if (aux !== null) {
            parts.push(coord(t('coord.purpose'), aux, t('coord.purposeTitle')))
          } else if (typeof detail.turn === 'number') {
            parts.push(coord(t('coord.turn'), String(detail.turn), t('coord.turnTitle')))
            parts.push(h('span', { className: 'wt-coord-sep', key: 's1' }))
            parts.push(coord(t('coord.step'), detail.step === null ? t('coord.none') : String(detail.step), t('coord.stepTitle')))
          } else {
            parts.push(coord(t('coord.attribution'), badge.text, badge.title))
          }
          if (detail.provider !== null && detail.provider !== undefined) {
            parts.push(h('span', { className: 'wt-coord-sep', key: 's2' }))
            parts.push(coord(t('coord.provider'), String(detail.provider), t('coord.providerTitle')))
          }
          if (detail.sessionId) {
            parts.push(h('span', { className: 'wt-coord-sep', key: 's3' }))
            parts.push(coord(t('coord.session'), shortSessionId(detail.sessionId), t('session.fullIdTitle', { sessionId: detail.sessionId })))
          }
          return h('div', { className: 'wt-coords', key: 'coords' }, parts)
        })(),
        curlNotice === null ? null : h('div', { className: 'wt-jnotice', key: 'curl-notice', style: { padding: '4px 12px' } }, curlNotice),
        detail === null
          ? h('div', { className: 'wt-empty', key: 'empty' }, t('empty.noSelection'))
          : (tab === 'response' && detail.response === null)
            ? h('div', { className: 'wt-empty', key: 'pending' }, t('empty.responsePending'))
            : showRaw
              ? h('pre', { className: 'wt-sse', key: 'raw' }, rawText)
              : h(React.Fragment, { key: 'json' }, [
                // Say why the structure is missing, rather than leaving a bare
                // `__raw__` key for the reader to decipher.
                bodyNotice === null
                  ? null
                  : h('div', { className: 'wt-jnotice', key: 'notice', style: { padding: '4px 12px' } }, bodyNotice),
                // Non-JSON content is shown as text. Wrapping it in a
                // synthetic `__raw__` object only dressed it up as JSON it is
                // not, and buried it one expand deep.
                rawFallback
                  ? h('pre', { className: 'wt-sse', key: 'text' }, (treeValue as Record<string, string>)[RAW_KEY] || '')
                  : h(JsonView, {
                    key: 'tree',
                    value: treeValue,
                    isOpen,
                    longOpen,
                    onToggle: toggle,
                    onToggleLong: toggleLong,
                    t,
                  }),
              ].filter(Boolean)),
      ]),
    ])
  }
}
