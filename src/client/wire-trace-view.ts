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
import { fmtDuration, fmtTime, purposeLabel, sessionLabel, shortSessionId, statusKind, stepBadge, stringify } from './format.js'
import { fmtCount, maxDepthOf } from './json-model.js'
import { parseSseFrames, prettySseText } from './sse.js'
import { mergeSseChunks } from './sse-merge/index.js'
import { createJsonView, type ReactLike as MinimalReactLike } from './json-view.js'
import type { WireRecord, WireRecordSummary } from '../shared/record-shape.js'

/** Minimal shape of the plugin `ctx` this view needs (an `interval` timer helper). */
export interface ViewContext {
  interval(fn: () => void, ms: number): () => void
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
    const applyPage = React.useCallback((result: any, opts: { filtering: boolean, memoryOnly: boolean }) => {
      const nextItems: WireRecordSummary[] = (result && result.items) || []
      const nextMatched = result && typeof result.matched === 'number' ? result.matched : 0
      const nextUnattributed = result && typeof result.unattributed === 'number' ? result.unattributed : 0
      // Nothing of our own, but traffic exists that simply never carried a
      // session id: filtering is useless here, so show everything instead of
      // an empty tab. Only a payload that actually consulted disk can prove
      // this — an in-memory page may just not have reached this session's
      // records yet.
      const decisive = !(result && result.historyPending === true)
      if (opts.filtering && decisive && !fallbackUsed.current
        && nextMatched === 0 && nextUnattributed > 0) {
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
        setItems((prev: WireRecordSummary[]) => {
          const byId = new Map<string, WireRecordSummary>()
          for (const row of prev) byId.set(row.id, row)
          for (const row of nextItems) byId.set(row.id, row)
          return [...byId.values()].sort((a, b) => {
            if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt
            return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
          })
        })
        setError(null)
        return true
      }

      if (!opts.memoryOnly) historyLanded.current = true
      setItems(nextItems)
      setTruncated(result ? result.truncated === true : false)
      setTotal(result ? result.total : 0)
      setMatched(nextMatched)
      setUnattributed(nextUnattributed)
      setTurns((result && result.turns) || [])
      setAuxiliary(result && typeof result.auxiliary === 'number' ? result.auxiliary : 0)
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
            setCurlNotice('已复制，含解析到的真实密钥——它现在在你的剪贴板里，小心历史记录/共享屏幕。')
          } else {
            setCurlNotice('已复制，authorization 引用了 $' + auth.envName + '；先 export ' + auth.envName + '=你的密钥，再运行就不用改命令了。')
          }
        },
        (reason: any) => {
          setCurlBusy(false)
          setCurlNotice('生成失败：' + String((reason && reason.message) || reason))
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

    // What each tab renders in the JSON view.
    //
    // Request always shows the parsed body; when the body isn't parseable
    // JSON there is nothing to parse, so it degrades to a single `__raw__`
    // key holding the exact text rather than pretending otherwise.
    //
    // Response has three shapes: an SSE body is, by default, REASSEMBLED —
    // its scattered delta fragments merged back into the exact shape that
    // provider's own non-streamed response would have had (see
    // `sse-merge/index.ts`) — and shown through the exact same JSON tree
    // Request uses; a JSON body is shown as-is; anything else degrades to
    // `__raw__` the same way. A toggle switches an SSE response to the
    // literal, unmerged bytes on the wire, because those bytes are this
    // plugin's whole point and must stay one click away, even though they
    // are no longer the default (they are close to unreadable directly: one
    // reply is typically dozens to hundreds of frames, each carrying a
    // character or two of content).
    const isSse = detail !== null && detail.response !== null && detail.response.contentType !== null
      && detail.response.contentType.includes('event-stream')
    const requestParsed = detail !== null && detail.request.bodyJson !== null
    const requestBody = detail === null ? null : (requestParsed ? detail.request.bodyJson : { __raw__: detail.request.bodyText })
    const responseBody = React.useMemo(() => {
      if (detail === null || detail.response === null) return null
      if (isSse && sseMerged) return mergeSseChunks(parseSseFrames(detail.response.bodyText))
      if (isSse) return parseSseFrames(detail.response.bodyText)
      if (detail.response.bodyJson !== null) return detail.response.bodyJson
      return { __raw__: detail.response.bodyText }
    }, [detail, isSse, sseMerged])
    const treeValue = tab === 'request' ? requestBody : responseBody

    // Why the JSON view fell back to a single `__raw__` blob.
    //
    // Overwhelmingly the reason is truncation: a body cut at the character
    // cap stops mid-JSON, so it cannot parse. Saying that outright beats
    // showing an unexplained `__raw__` key and letting the reader assume the
    // plugin mangled their request.
    const shownBody = detail === null
      ? null
      : (tab === 'request' ? detail.request : detail.response)
    const bodyTruncated = shownBody !== null && shownBody !== undefined && shownBody.bodyTruncated === true
    const rawFallback = treeValue !== null
      && typeof treeValue === 'object'
      && !Array.isArray(treeValue)
      && Object.keys(treeValue).length === 1
      && Object.prototype.hasOwnProperty.call(treeValue, '__raw__')
    const bodyNotice = !rawFallback
      ? null
      : (bodyTruncated
        ? '原始内容共 ' + fmtCount(shownBody!.bodyChars) + ' 个字符，超出上限，只保留了前 '
          + fmtCount((shownBody!.bodyText || '').length) + ' 个字符。'
          + '被截断的 JSON 无法解析，因此只能按原文显示；调高 maxBodyChars 可以保留更多。'
        : '这段内容不是 JSON，按原文显示。')
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
      const next = Math.max(0, Math.min(contentDepth, depth + delta))
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
            const badge = stepBadge(item)
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
              ? '该请求在线路上没有携带 session 标记。'
              : 'session ' + item.sessionId,
          }, sessionLabel(item.sessionId, currentSessionId)),
        ].filter(Boolean)),
      ],
    ))

    // Insert a sticky group header whenever the turn changes going down the
    // list (which is newest-first, so turns descend). Auxiliary and
    // unattributed calls get their own group rather than being folded into
    // whichever turn happens to sit next to them in time.
    const groupKeyOf = (item: WireRecordSummary) => {
      if (purposeLabel(item.purpose) !== null) return 'aux'
      if (typeof item.turn === 'number') return 'turn:' + item.turn
      return 'none'
    }
    const groupHeader = (item: WireRecordSummary) => {
      const key = groupKeyOf(item)
      if (key === 'aux') return { text: '后台辅助调用', meta: '不属于任何 turn' }
      if (key === 'none') return { text: '无归属调用', meta: '未经过 ctx.llm' }
      const stat = turns.find((entry) => entry.turn === item.turn)
      return {
        text: '第 ' + item.turn + ' 轮',
        meta: stat === undefined
          ? ''
          : stat.calls + ' 次调用' + (stat.steps > 0 ? ' · ' + stat.steps + ' step' : ''),
      }
    }
    const groupedRows: any[] = []
    let lastGroup: string | null = null
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const key = groupKeyOf(item)
      if (key !== lastGroup) {
        const head = groupHeader(item)
        groupedRows.push(h('div', { className: 'wt-turn', key: 'g:' + key }, [
          h('span', { className: 'wt-turn-n', key: 'n' }, head.text),
          head.meta === '' ? null : h('span', { className: 'wt-turn-meta', key: 'm' }, head.meta),
        ].filter(Boolean)))
        lastGroup = key
      }
      groupedRows.push(rows[i])
    }

    return h('div', { className: 'wt-root' }, [
      h('div', { className: 'wt-left', key: 'left' }, [
        h('div', { className: 'wt-bar', key: 'bar' }, [
          h('button', {
            className: 'wt-btn',
            key: 'auto',
            'data-on': auto ? '1' : '0',
            title: auto ? '每 3 秒自动刷新（只读内存中的实时记录，不扫描磁盘）。点击暂停。' : '已暂停刷新。点击恢复并立即刷新一次。',
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
          }, auto ? '自动刷新' : '已暂停'),
          h('button', {
            className: 'wt-btn',
            key: 'scope',
            'data-on': filtering ? '1' : '0',
            disabled: currentSessionId === null,
            title: currentSessionId === null
              ? '拿不到当前 session id，只能显示全部记录。'
              : (filtering
                ? '当前只显示本 session 的 provider 调用。点击查看全部记录（含其他 session 和无 session 标记的调用）。'
                : '当前显示全部记录。点击只看本 session。'),
            onClick: () => {
              if (currentSessionId === null) return
              // An explicit choice ends the automatic fallback for good.
              fallbackUsed.current = true
              setAutoFellBack(false)
              setOnlySession(!onlySession)
            },
          }, filtering ? '当前 Session' : '全部 Session'),
          h('button', {
            className: 'wt-btn',
            key: 'clear',
            title: '清空全部记录（不区分 session），磁盘上的历史记录也会一并删除。',
            onClick: () => {
              apiPost('clear', {}).then(() => {
                setSelected(null)
                setTick((n: number) => n + 1)
                // Clearing deletes files, so the history half must be re-read
                // or the removed records would linger on screen.
                setHistoryTick((n: number) => n + 1)
              }, (reason: any) => setError(String(reason)))
            },
          }, '清空'),
          h('span', {
            className: 'wt-meta',
            key: 'meta',
            title: filtering ? '本 session 命中数 / 全部记录数（含磁盘）' : '已加载 / 全部记录数（含磁盘）',
          }, (filtering ? matched : items.length) + ' / ' + total
            + (turns.length > 0 ? ' · ' + turns.length + ' turn' : '')
            + (auxiliary > 0 ? ' · ' + auxiliary + ' 辅助' : '')),
        ]),
        error === null ? null : h('div', { className: 'wt-err', key: 'err' }, error),
        h('div', { className: 'wt-list', key: 'list' },
          items.length === 0
            ? h('div', { className: 'wt-empty' }, filtering
              ? '本 session 尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。'
              : '尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。')
            : [
              ...groupedRows,
              // Live records are already on screen; the disk half is still
              // arriving. Say so, so an incomplete list is never mistaken for
              // the whole history.
              historyLoading
                ? h('div', { className: 'wt-jnotice', key: '#history' }, '正在后台载入磁盘历史记录…')
                : null,
              // The provider never stamped a session id, so the default
              // filter was dropped. Explain it where it was noticed.
              autoFellBack
                ? h('div', { className: 'wt-jnotice', key: '#fallback' },
                  '本 session 没有可归属的记录（这些调用没有经过 ctx.llm，例如插件重载前就已经发出的请求），已自动显示全部记录。')
                : null,
              // Records with no session identity are hidden by the filter,
              // but never silently: say how many, and where to see them.
              filtering && unattributed > 0
                ? h('div', { className: 'wt-jnotice', key: '#unattributed' },
                  '另有 ' + fmtCount(unattributed) + ' 条无归属记录（没有经过 ctx.llm 的请求），点击「全部 Session」查看。')
                : null,
              // Say so rather than implying the page showed everything: a
              // filtered history read stops at a bounded scan budget.
              truncated
                ? h('div', { className: 'wt-jnotice', key: '#truncated' },
                  '磁盘上还有更早的记录未被扫描（单次查询有读取上限）。')
                : null,
            ].filter(Boolean)),
      ].filter(Boolean)),
      h('div', { className: 'wt-right', key: 'right' }, [
        h('div', { className: 'wt-tabs', key: 'tabs' }, [
          h('button', { className: 'wt-btn', key: 'req', 'data-on': tab === 'request' ? '1' : '0', onClick: () => setTab('request') }, 'Request'),
          h('button', { className: 'wt-btn', key: 'res', 'data-on': tab === 'response' ? '1' : '0', onClick: () => setTab('response') }, 'Response'),
          h('span', { className: 'wt-div', key: 'div' }),
          isSse && tab === 'response'
            ? h('button', {
              className: 'wt-btn',
              key: 'sse',
              'data-on': sseMerged ? '1' : '0',
              title: sseMerged
                ? '当前把分散的 delta 增量合并成完整内容，仍按 JSON 树展示。点击查看线路上的原始 SSE 文本。'
                : '当前显示线路上的原始 SSE 文本（未合并）。点击切回合并后的完整内容。',
              onClick: () => setSseMerged(!sseMerged),
            }, sseMerged ? '优化展示' : '原始 SSE')
            : null,
          h('button', {
            className: 'wt-btn wt-btn-step',
            key: 'less',
            title: '整体折叠一层',
            onClick: () => step(-1),
            disabled: detail === null || showRaw || depth <= 0,
          }, '−'),
          h('button', {
            className: 'wt-btn wt-btn-step',
            key: 'more',
            title: '整体展开一层',
            onClick: () => step(1),
            disabled: detail === null || showRaw || depth >= contentDepth,
          }, '+'),
          h('span', { className: 'wt-meta', key: 'depth' }, showRaw || detail === null ? '' : '深度 ' + depth + '/' + contentDepth),
          h('span', { className: 'wt-meta', key: 'sp' }, detail === null ? '' : detail.id + ' · ' + detail.request.method + ' ' + detail.request.url),
          h('button', {
            className: 'wt-btn',
            key: 'curl',
            disabled: detail === null || curlBusy,
            title: '生成一条可以直接在命令行里跑的 curl 命令并复制到剪贴板。authorization 会尝试补上真实密钥，补不到就留占位符。',
            onClick: copyCurl,
          }, curlBusy ? '生成中…' : '复制 curl'),
          h('button', { className: 'wt-btn', key: 'copy', onClick: () => copy(showRaw ? rawText : text) }, '复制'),
          h('button', { className: 'wt-btn', key: 'dl', onClick: () => { if (detail !== null) download('llm-wire-trace-' + detail.id + '.json', stringify(detail)) } }, '下载'),
        ].filter(Boolean)),
        // Always-visible coordinate strip for the selected record: the
        // harness facts that the wire bytes below can never tell you.
        detail === null ? null : (() => {
          const badge = stepBadge(detail)
          const aux = purposeLabel(detail.purpose)
          const coord = (label: string, value: string, title: string) => h('span', { className: 'wt-coord', key: label, title }, [
            h('span', { key: 'l' }, label),
            h('b', { key: 'v' }, value),
          ])
          const parts: any[] = []
          if (aux !== null) {
            parts.push(coord('用途', aux, '后台辅助调用，不属于任何一次对话 turn。'))
          } else if (typeof detail.turn === 'number') {
            parts.push(coord('Turn', String(detail.turn), '第几轮对话。'))
            parts.push(h('span', { className: 'wt-coord-sep', key: 's1' }))
            parts.push(coord('Step', detail.step === null ? '—' : String(detail.step), '一个 step = 一次模型调用。'))
          } else {
            parts.push(coord('归属', badge.text, badge.title))
          }
          if (detail.provider !== null && detail.provider !== undefined) {
            parts.push(h('span', { className: 'wt-coord-sep', key: 's2' }))
            parts.push(coord('Provider', String(detail.provider), '解析到的 provider 路由。'))
          }
          if (detail.sessionId) {
            parts.push(h('span', { className: 'wt-coord-sep', key: 's3' }))
            parts.push(coord('Session', shortSessionId(detail.sessionId), '完整 session id：' + detail.sessionId))
          }
          return h('div', { className: 'wt-coords', key: 'coords' }, parts)
        })(),
        curlNotice === null ? null : h('div', { className: 'wt-jnotice', key: 'curl-notice', style: { padding: '4px 12px' } }, curlNotice),
        detail === null
          ? h('div', { className: 'wt-empty', key: 'empty' }, '在左侧选择一条记录查看完整请求/响应。')
          : (tab === 'response' && detail.response === null)
            ? h('div', { className: 'wt-empty', key: 'pending' }, '响应尚未到达（连接失败或仍在等待）。')
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
                  ? h('pre', { className: 'wt-sse', key: 'text' }, (treeValue as any).__raw__ || '')
                  : h(JsonView, {
                    key: 'tree',
                    value: treeValue,
                    isOpen,
                    longOpen,
                    onToggle: toggle,
                    onToggleLong: toggleLong,
                  }),
              ].filter(Boolean)),
      ]),
    ])
  }
}
