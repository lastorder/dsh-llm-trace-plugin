/**
 * `JsonView`: renders one jq-shaped JSON document as real DOM rows (not
 * preformatted text), so containers stay individually togglable and long
 * strings keep their expandable block — but the punctuation, indentation, and
 * trailing commas are exactly what `jq .` would print.
 *
 * Written against a minimal React-like interface rather than importing
 * `react` directly, matching this plugin's classic-script client convention:
 * the real `React` module is handed in by the bundle's factory wrapper (see
 * entry.ts), never imported by a bundler-transformed `import` statement.
 *
 * @module dsh-llm-trace-plugin/client/json-view
 */

import { LONG_STRING, MAX_ROWS } from './constants.js'
import { flattenJq, isLongString, oneLine, collapsedSummary, fmtCount, type JsonLine } from './json-model.js'
import { stringify, type Translate } from './format.js'

/** The subset of the React runtime this module needs. */
export interface ReactLike {
  createElement: (type: any, props: any, ...children: any[]) => any
  useMemo: <T>(factory: () => T, deps: any[]) => T
  Fragment?: any
}

export interface JsonViewProps {
  value: unknown
  isOpen: (path: string, depth: number) => boolean
  longOpen: Set<string>
  onToggle: (path: string, depth: number) => void
  onToggleLong: (path: string) => void
  /** Copy one node's value; `path` identifies the row so it can show the confirmation. */
  onCopy: (path: string, text: string) => void
  /** The row whose copy was just confirmed (null when none). */
  copiedPath: string | null
  t: Translate
}

/** Build the `JsonView` component bound to one React runtime. */
export function createJsonView(React: ReactLike) {
  const h = React.createElement

  return function JsonView(props: JsonViewProps) {
    const { value, isOpen, longOpen, onToggle, onToggleLong, onCopy, copiedPath, t } = props
    const flat = React.useMemo(() => flattenJq(value, isOpen), [value, isOpen])

    /** `"key": ` / `` (array elements carry no label in jq output). */
    const labelParts = (line: JsonLine) => {
      if (line.labelKind === 'key') {
        return [
          h('span', { className: 'wt-jkey', key: 'l' }, JSON.stringify(line.label)),
          h('span', { className: 'wt-jpunct', key: 'c' }, ': '),
        ]
      }
      return []
    }

    const elements: any[] = []
    for (const line of flat.lines) {
      const indents: any[] = []
      for (let i = 0; i < line.depth; i += 1) indents.push(h('span', { className: 'wt-jind', key: 'i' + i }))

      const body: any[] = []
      let togglePath: string | null = null

      if (line.type === 'close') {
        body.push(h('span', { className: 'wt-jpunct', key: 'v' }, (line.kind === 'array' ? ']' : '}') + (line.last ? '' : ',')))
      } else if (line.type === 'open') {
        togglePath = line.path
        body.push(...labelParts(line))
        body.push(h('span', { className: 'wt-jpunct', key: 'v' }, line.kind === 'array' ? '[' : '{'))
      } else {
        // leaf: scalar, empty container, or collapsed container
        body.push(...labelParts(line))
        const comma = line.last ? '' : ','
        if (line.container) {
          togglePath = line.path
          body.push(h('span', { className: 'wt-jsum', key: 'v' }, collapsedSummary(line.kind, line.count)))
          if (comma) body.push(h('span', { className: 'wt-jpunct', key: 'cm' }, comma))
        } else if (line.kind === 'object' || line.kind === 'array') {
          body.push(h('span', { className: 'wt-jpunct', key: 'v' }, (line.kind === 'array' ? '[]' : '{}') + comma))
        } else if (line.kind === 'string') {
          const strValue = line.value as string
          if (isLongString(strValue)) {
            body.push(h('span', {
              className: 'wt-jstr wt-jclip',
              key: 'v',
              onClick: (event: any) => { event.stopPropagation(); onToggleLong(line.path) },
            }, '"' + oneLine(strValue, LONG_STRING) + '"'))
            if (comma) body.push(h('span', { className: 'wt-jpunct', key: 'cm' }, comma))
            body.push(h('span', { className: 'wt-jmeta', key: 'm' }, '  ' + fmtCount(strValue.length) + ' chars'))
          } else {
            body.push(h('span', { className: 'wt-jstr', key: 'v' }, JSON.stringify(strValue)))
            if (comma) body.push(h('span', { className: 'wt-jpunct', key: 'cm' }, comma))
          }
        } else {
          const cls = line.kind === 'number' ? 'wt-jnum' : line.kind === 'boolean' ? 'wt-jbool' : 'wt-jnull'
          const rendered = line.kind === 'null' ? 'null' : String(line.value)
          body.push(h('span', { className: cls, key: 'v' }, rendered))
          if (comma) body.push(h('span', { className: 'wt-jpunct', key: 'cm' }, comma))
        }
      }

      elements.push(h('div', {
        className: 'wt-jrow',
        key: line.path + ':' + line.type,
        'data-c': togglePath === null ? '0' : '1',
        onClick: togglePath === null ? undefined : () => onToggle(togglePath as string, line.depth),
      }, [
        ...indents,
        h('span', {
          className: 'wt-jgutter',
          key: 'g',
        }, togglePath === null ? '' : (line.type === 'open' ? '-' : '+')),
        h('span', { className: 'wt-jbody', key: 'b' }, body),
        // Sits right after the value rather than at the far edge of the pane,
        // so the pointer that is already on the value barely has to move; it
        // shows a confirmation in place, because a copy otherwise looks like
        // nothing happened.
        line.type === 'close' ? null : (() => {
          const done = copiedPath === line.path
          return h('button', {
            className: 'wt-jcopy',
            key: 'cp',
            type: 'button',
            'data-done': done ? '1' : '0',
            title: t('json.copyNode'),
            onClick: (event: any) => {
              event.stopPropagation()
              onCopy(line.path, typeof line.value === 'string' ? line.value : stringify(line.value))
            },
          }, [
            h('span', { className: 'wt-jcopy-icon', key: 'i', 'aria-hidden': 'true' }, done ? '✓' : '⧉'),
            h('span', { key: 't' }, done ? t('json.copied') : t('json.copy')),
          ])
        })(),
      ].filter(Boolean)))

      if (line.type === 'leaf' && line.kind === 'string' && isLongString(line.value) && longOpen.has(line.path)) {
        elements.push(h('div', {
          className: 'wt-jblock',
          key: line.path + '#full',
          title: t('json.collapseBlock'),
          onClick: () => onToggleLong(line.path),
        }, line.value))
      }
    }

    if (flat.truncated) {
      elements.push(h('div', { className: 'wt-jnotice', key: '#truncated' }, t('json.truncatedNotice', { rows: fmtCount(MAX_ROWS) })))
    }

    return h('div', { className: 'wt-json' }, [
      ...elements,
    ].filter(Boolean))
  }
}
