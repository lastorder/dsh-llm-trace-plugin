/**
 * Pure JSON tree model: flattening a parsed JSON value into jq-shaped display
 * lines, with per-container collapse state supplied by the caller. No DOM,
 * no React — this is the reusable, testable computation behind `JsonView`.
 *
 * @module dsh-llm-trace-plugin/client/json-model
 */

import { LONG_STRING, MAX_ROWS, PATH_SEP, ROOT_PATH } from './constants.js'

export type JsonKind = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'other'
export type LabelKind = 'key' | 'index' | 'none'

export function classify(value: unknown): JsonKind {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'object') return 'object'
  if (t === 'string') return 'string'
  if (t === 'number') return 'number'
  if (t === 'boolean') return 'boolean'
  return 'other'
}

export function isContainer(kind: JsonKind): boolean {
  return kind === 'object' || kind === 'array'
}

export function childCount(value: any, kind: JsonKind): number {
  if (kind === 'array') return value.length
  if (kind === 'object') return Object.keys(value).length
  return 0
}

export function isLongString(value: unknown): value is string {
  return typeof value === 'string' && (value.length > LONG_STRING || value.indexOf('\n') >= 0)
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** Collapsed-container placeholder, e.g. `{ … 3 keys }` / `[ … 12 items ]`. */
export function collapsedSummary(kind: JsonKind, count: number): string {
  const noun = kind === 'array' ? (count === 1 ? 'item' : 'items') : (count === 1 ? 'key' : 'keys')
  const open = kind === 'array' ? '[' : '{'
  const close = kind === 'array' ? ']' : '}'
  return open + ' … ' + fmtCount(count) + ' ' + noun + ' ' + close
}

/** One rendered line in the jq-shaped flattening. */
export interface JsonLine {
  type: 'open' | 'close' | 'leaf'
  path: string
  depth: number
  label: string | null
  labelKind: LabelKind
  kind: JsonKind
  value: unknown
  count: number
  container: boolean
  last: boolean
}

export interface FlattenResult {
  lines: JsonLine[]
  truncated: boolean
}

/**
 * Flatten a JSON value into jq-shaped display lines.
 *
 * Unlike a node-per-row tree, this emits the punctuation jq itself would
 * print: an expanded container costs an opening line (`"key": {`), its
 * children, and a closing line (`}`) that carries the trailing comma when the
 * container is not its parent's last entry. A collapsed container is a single
 * line whose value is a `{ … n keys }` placeholder, so the shape of the
 * document stays readable at any depth.
 *
 * A line is one of:
 *   - `open`  : container header; `+`/`-` togglable, has `path`
 *   - `close` : container footer; punctuation only
 *   - `leaf`  : a scalar, an empty container, or a collapsed container
 *
 * @param root - the parsed JSON value to render.
 * @param isOpen - (path, depth) => boolean, decides each container's state.
 */
export function flattenJq(root: unknown, isOpen: (path: string, depth: number) => boolean): FlattenResult {
  const lines: JsonLine[] = []
  let truncated = false

  // `label` is the key/index this value sits under (null at the root).
  // `last` drives whether a comma follows this value.
  const walk = (
    label: string | null,
    labelKind: LabelKind,
    value: any,
    depth: number,
    path: string,
    last: boolean,
  ) => {
    if (lines.length >= MAX_ROWS) {
      truncated = true
      return
    }
    const kind = classify(value)
    const count = childCount(value, kind)
    const container = isContainer(kind) && count > 0
    const open = container && isOpen(path, depth)

    if (!container || !open) {
      // One self-contained line: scalar, empty container, or collapsed.
      lines.push({ type: 'leaf', path, depth, label, labelKind, kind, value, count, container, last })
      return
    }

    lines.push({ type: 'open', path, depth, label, labelKind, kind, value, count, container: true, last })
    const keys: string[] = kind === 'array' ? value.map((_: unknown, i: number) => String(i)) : Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      walk(
        key,
        kind === 'array' ? 'index' : 'key',
        value[key],
        depth + 1,
        path + PATH_SEP + key,
        i === keys.length - 1,
      )
    }
    if (lines.length >= MAX_ROWS) {
      truncated = true
      return
    }
    lines.push({
      type: 'close',
      path: path + '#close',
      depth,
      label: null,
      labelKind: 'none',
      kind,
      value: undefined,
      count: 0,
      container: false,
      last,
    })
  }

  walk(null, 'none', root, 0, ROOT_PATH, true)
  return { lines, truncated }
}

/** Deepest container nesting level present in `root`, capped by `limit`. */
export function maxDepthOf(root: unknown, limit: number): number {
  let deepest = 0
  const walk = (value: any, depth: number) => {
    if (depth > deepest) deepest = depth
    if (deepest >= limit) return
    const kind = classify(value)
    if (!isContainer(kind)) return
    const keys: string[] = kind === 'array' ? value.map((_: unknown, i: number) => String(i)) : Object.keys(value)
    for (const key of keys) walk(value[key], depth + 1)
  }
  walk(root, 0)
  return Math.min(deepest, limit)
}
