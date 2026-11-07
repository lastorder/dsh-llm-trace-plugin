/**
 * `CompareView`: the body of the Wire Trace "Compare" tab — a baseline picker
 * plus a grouped, readable list of what changed between two request bodies.
 *
 * All the decisions live elsewhere: which baseline applies and what state the
 * comparison is in come from `view-model.ts`, and the diff itself comes from
 * `body-diff.ts`. This file only turns them into elements, which is why — like
 * `json-view.ts` — it takes a minimal React-like interface instead of
 * importing `react` (see `entry.ts` for the classic-script constraint).
 *
 * @module dsh-llm-trace-plugin/client/compare-view
 */

import { collapseContext, diffString, formatPath, type BodyDiff, type Change, type ChangeKind, type DiffGroup } from './body-diff.js'
import { fmtTime, stepBadge, stringify, type Translate } from './format.js'
import { fmtCount, isLongString, oneLine } from './json-model.js'
import type { CompareStatus, RowGroup } from './view-model.js'
import type { WireRecordSummary } from '../shared/record-shape.js'
import type { ReactLike } from './json-view.js'

/** The React surface this component needs. */
export interface CompareReact extends ReactLike {
  useState: <T>(initial: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void]
}

export interface CompareViewProps {
  status: CompareStatus
  diff: BodyDiff | null
  /** Rows the reader may pick as the baseline (the selected record excluded), grouped by turn. */
  candidates: RowGroup[]
  baselineId: string | null
  /** The default baseline, so the picker can tag it. */
  defaultId: string | null
  /** True when the reader's own pick is in force rather than the default. */
  overridden: boolean
  /** `null` means "go back to the default". */
  onPick: (id: string | null) => void
  t: Translate
}

/** Changes drawn per group before a "show more" button; keeps a rewritten history from flooding the DOM. */
export const GROUP_PAGE = 50
/** Rows drawn for one multi-line text diff. */
const MAX_DIFF_ROWS = 400
/** Characters of a value shown on its one-line preview. */
const PREVIEW_CHARS = 200

const MARK: Record<ChangeKind, string> = { added: '+', removed: '−', changed: '~' }

/** Build the `CompareView` component bound to one React runtime. */
export function createCompareView(React: CompareReact) {
  const h = React.createElement

  return function CompareView(props: CompareViewProps) {
    const { status, diff, candidates, baselineId, defaultId, overridden, onPick, t } = props
    // Opened full values, collapsed groups and expanded groups are all local
    // reading state: nothing outside this tab cares about them.
    const [openValues, setOpenValues] = React.useState<Set<string>>(() => new Set())
    const [closedGroups, setClosedGroups] = React.useState<Set<string>>(() => new Set())
    const [extraRows, setExtraRows] = React.useState<Record<string, number>>(() => ({}))

    const flip = (setter: (next: (prev: Set<string>) => Set<string>) => void, key: string) => setter((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

    // ---- baseline picker -------------------------------------------------
    const groupLabel = (group: RowGroup) => {
      if (group.key === 'aux') return t('group.auxiliary')
      if (group.key === 'none') return t('group.unattributed')
      return t('turn.groupLabel', { turn: group.turn as number })
    }
    const optionLabel = (item: WireRecordSummary) => {
      const parts = [stepBadge(item, t).text, fmtTime(item.startedAt), item.model || item.url]
      if (item.id === defaultId) parts.push(t('compare.previousTag'))
      return parts.join(' · ')
    }
    const candidateCount = candidates.reduce((sum, group) => sum + group.items.length, 0)

    const picker = candidateCount === 0 ? null : h('div', { className: 'wt-cmp-bar', key: 'bar' }, [
      h('label', { className: 'wt-cmp-label', key: 'l', title: t('compare.baselineTitle') }, t('compare.baseline')),
      h('select', {
        className: 'wt-select',
        key: 's',
        value: baselineId === null ? '' : baselineId,
        title: t('compare.baselineTitle'),
        onChange: (event: any) => onPick(event.target.value === '' ? null : event.target.value),
      }, [
        baselineId === null ? h('option', { key: '#none', value: '' }, '—') : null,
        ...candidates.map((group) => h('optgroup', { key: group.key, label: groupLabel(group) },
          group.items.map((item) => h('option', { key: item.id, value: item.id }, optionLabel(item))))),
      ].filter(Boolean)),
      overridden
        ? h('button', { className: 'wt-btn', key: 'r', title: t('compare.resetTitle'), onClick: () => onPick(null) }, t('compare.reset'))
        : (defaultId === null ? null : h('span', { className: 'wt-cmp-note', key: 'n' }, t('compare.defaultNote'))),
    ])

    // ---- value rendering -------------------------------------------------
    const previewOf = (value: unknown): string => {
      if (typeof value === 'string') return '"' + oneLine(value, PREVIEW_CHARS) + '"'
      return oneLine(JSON.stringify(value) ?? 'undefined', PREVIEW_CHARS)
    }
    const fullOf = (value: unknown): string => (typeof value === 'string' ? value : stringify(value))
    const isExpandable = (value: unknown): boolean => {
      if (typeof value === 'string') return isLongString(value)
      if (value !== null && typeof value === 'object') return (JSON.stringify(value) ?? '').length > PREVIEW_CHARS
      return false
    }

    /** One `+ value` / `− value` line, expandable to the full value. */
    const valueLine = (side: 'add' | 'del', value: unknown, rowKey: string) => {
      const open = openValues.has(rowKey)
      const expandable = isExpandable(value)
      return [
        h('div', { className: 'wt-cv', 'data-k': side, key: rowKey }, [
          h('span', { className: 'wt-cv-mark', key: 'm' }, side === 'add' ? '+' : '−'),
          h('span', {
            className: 'wt-cv-text' + (expandable ? ' wt-cv-click' : ''),
            key: 't',
            title: expandable ? t('compare.valueToggle') : undefined,
            onClick: expandable ? () => flip(setOpenValues, rowKey) : undefined,
          }, previewOf(value)),
          typeof value === 'string' && value.length > PREVIEW_CHARS
            ? h('span', { className: 'wt-cv-meta', key: 'c' }, t('compare.chars', { count: fmtCount(value.length) }))
            : null,
        ].filter(Boolean)),
        open ? h('pre', { className: 'wt-cv-full', 'data-k': side, key: rowKey + '#full', onClick: () => flip(setOpenValues, rowKey) }, fullOf(value)) : null,
      ]
    }

    /** A changed string: the edit highlighted in place, or a line diff for multi-line text. */
    const stringChange = (before: string, after: string, rowKey: string) => {
      const diffed = diffString(before, after)
      if (diffed.mode === 'inline') {
        return h('div', { className: 'wt-cv wt-cv-inline', 'data-k': 'chg', key: rowKey }, [
          h('span', { className: 'wt-cv-mark', key: 'm' }, '~'),
          h('span', { className: 'wt-cv-text wt-cv-wrap', key: 't' }, [
            diffed.prefixClipped ? '…' : null,
            diffed.prefix,
            diffed.before === '' ? null : h('del', { key: 'd' }, diffed.before),
            diffed.after === '' ? null : h('ins', { key: 'i' }, diffed.after),
            diffed.suffix,
            diffed.suffixClipped ? '…' : null,
          ].filter((part) => part !== null && part !== '')),
        ])
      }
      const rows = collapseContext(diffed.ops, 2)
      const shown = rows.slice(0, MAX_DIFF_ROWS)
      return h('div', { className: 'wt-ld', key: rowKey }, [
        ...shown.map((row, index) => row.type === 'skip'
          ? h('div', { className: 'wt-ld-skip', key: index }, t('compare.skipLines', { count: fmtCount(row.count) }))
          : h('div', { className: 'wt-ld-row', 'data-k': row.op.op, key: index }, [
            h('span', { className: 'wt-ld-mark', key: 'm' }, row.op.op === 'add' ? '+' : row.op.op === 'del' ? '−' : ' '),
            h('span', { className: 'wt-ld-text', key: 't' }, row.op.text === '' ? ' ' : row.op.text),
          ])),
        rows.length > MAX_DIFF_ROWS ? h('div', { className: 'wt-ld-skip', key: '#cap' }, t('compare.linesCapped', { rows: fmtCount(MAX_DIFF_ROWS) })) : null,
      ].filter(Boolean))
    }

    const changeRow = (group: DiffGroup, change: Change, index: number) => {
      const rowKey = group.key + '#' + index
      const where = formatPath(change.path, group.key === '' ? 0 : 1)
      let body: any[]
      if (change.kind === 'added') body = valueLine('add', change.after, rowKey)
      else if (change.kind === 'removed') body = valueLine('del', change.before, rowKey)
      else if (typeof change.before === 'string' && typeof change.after === 'string') body = [stringChange(change.before, change.after, rowKey)]
      else body = [...valueLine('del', change.before, rowKey + ':b'), ...valueLine('add', change.after, rowKey + ':a')]
      return h('div', { className: 'wt-cr', 'data-k': change.kind, key: rowKey }, [
        where === '' ? null : h('div', { className: 'wt-cr-path', key: 'p' }, where),
        ...body.filter(Boolean),
      ].filter(Boolean))
    }

    const chip = (kind: ChangeKind, count: number, withLabel: boolean) => count === 0 ? null : h('span', {
      className: 'wt-chip',
      'data-k': kind,
      key: kind,
      title: t('compare.' + kind + 'Title'),
    }, MARK[kind] + count + (withLabel ? ' ' + t('compare.' + kind) : ''))

    const groupCounts = (group: DiffGroup) => {
      const counts = { added: 0, removed: 0, changed: 0 }
      for (const change of group.changes) counts[change.kind] += 1
      return counts
    }

    const groupSection = (group: DiffGroup) => {
      const closed = closedGroups.has(group.key)
      const counts = groupCounts(group)
      const limit = GROUP_PAGE + (extraRows[group.key] ?? 0)
      const visible = group.changes.slice(0, limit)
      const remaining = group.changes.length - visible.length
      return h('section', { className: 'wt-cg', key: group.key === '' ? '#root' : 'k:' + group.key }, [
        h('button', {
          className: 'wt-cg-head',
          key: 'h',
          type: 'button',
          title: t('compare.groupToggle'),
          'aria-expanded': closed ? 'false' : 'true',
          onClick: () => flip(setClosedGroups, group.key),
        }, [
          h('span', { className: 'wt-cg-caret', key: 'c' }, closed ? '▸' : '▾'),
          h('span', { className: 'wt-cg-key', key: 'k' }, group.key === '' ? t('compare.rootLabel') : group.key),
          group.lengthBefore !== null && group.lengthAfter !== null
            ? h('span', { className: 'wt-cg-meta', key: 'm' }, t('compare.groupItems', { before: group.lengthBefore, after: group.lengthAfter }))
            : null,
          h('span', { className: 'wt-cg-counts', key: 'n' }, [chip('added', counts.added, false), chip('removed', counts.removed, false), chip('changed', counts.changed, false)].filter(Boolean)),
        ].filter(Boolean)),
        closed ? null : h('div', { className: 'wt-cg-body', key: 'b' }, [
          ...visible.map((change, index) => changeRow(group, change, index)),
          remaining > 0
            ? h('button', {
              className: 'wt-btn wt-cg-more',
              key: '#more',
              onClick: () => setExtraRows((prev: Record<string, number>) => ({ ...prev, [group.key]: (prev[group.key] ?? 0) + 200 })),
            }, t('compare.showMore', { count: fmtCount(Math.min(200, remaining)) }))
            : null,
        ].filter(Boolean)),
      ])
    }

    // ---- content by state ------------------------------------------------
    const message = (key: string, text: string, className = 'wt-cmp-msg') => h('div', { className, key }, text)

    let content: any
    if (status.kind === 'no-others') content = message('msg', t('compare.noOthers'))
    else if (status.kind === 'no-baseline') content = message('msg', t('compare.noBaseline'))
    else if (status.kind === 'loading') content = message('msg', t('compare.loading'))
    else if (status.kind === 'error') content = message('msg', t('compare.loadFailed', { message: status.message }), 'wt-err')
    else if (status.kind === 'not-json') content = message('msg', status.side === 'base' ? t('compare.notJsonBase') : t('compare.notJsonHead'))
    else if (status.kind === 'ready' && diff !== null) {
      const unchanged = diff.unchanged.length === 0
        ? null
        : h('details', { className: 'wt-unch', key: 'unch' }, [
          h('summary', { key: 's' }, t('compare.unchanged', { count: diff.unchanged.length })),
          h('div', { className: 'wt-unch-list', key: 'l' }, diff.unchanged.map((key) => h('span', { className: 'wt-unch-key', key }, key))),
        ])
      const hasRemovedIndex = diff.groups.some((group) => group.changes.some((change) => change.kind === 'removed' && typeof change.path[change.path.length - 1] === 'number'))
      content = h(React.Fragment ?? 'div', { key: 'ready' }, [
        diff.identical
          ? message('same', t('compare.identical'))
          : h('div', { className: 'wt-cmp-sum', key: 'sum' }, [
            chip('added', diff.counts.added, true),
            chip('removed', diff.counts.removed, true),
            chip('changed', diff.counts.changed, true),
          ].filter(Boolean)),
        h('div', { className: 'wt-cmp-body', key: 'body' }, [
          ...diff.groups.map(groupSection),
          hasRemovedIndex ? h('div', { className: 'wt-jnotice', key: 'idx' }, t('compare.indexNote')) : null,
          unchanged,
        ].filter(Boolean)),
      ])
    } else content = null

    return h('div', { className: 'wt-cmp' }, [picker, content].filter(Boolean))
  }
}
