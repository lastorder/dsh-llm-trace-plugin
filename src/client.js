/**
 * @deepseek-ai/dsh LLM wire trace plugin — browser half.
 *
 * Registers a "Wire Trace" tab in the session view ring, listing the literal
 * HTTP request/response of every LLM provider call (provider-native JSON field
 * names, raw SSE frames) captured by the host half's `globalThis.fetch` patch.
 * No harness concepts here (no sessionId/turn/step) — this is the wire layer,
 * not the harness-level view a `GenerateOptions`/`StreamChunk` tracer shows.
 *
 * Hand-authored in the client-bundle wire format: the file is served as a
 * classic script that only REGISTERS a factory; the body runs at
 * materialization. No JSX, no bundler.
 */
window.__ModuleLoader__.load({
  id: 'dsh-llm-trace-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const ROUTE = '/llm-wire-trace'
    const STYLE_ID = 'dsh-llm-trace-plugin/wire-trace.css'

    const PATH_SEP = '\u0000'
    const ROOT_PATH = '$'
    const LONG_STRING = 120
    const MAX_ROWS = 20000

    const CSS = [
      // ---- fix for the shell's own layout: in the "active" phase (any open,
      // non-blank session — i.e. always, for us) the shipped ConversationRoot
      // CSS sets the ancestor it calls `viewArea` to `flex:1 0 auto;
      // min-height:auto`, intentionally so Chat's message list can grow past
      // the visible area and let the whole page (`[data-conversation-scroll]`,
      // a stable framework attribute) scroll with a sticky composer. That same
      // rule unavoidably reaches every `conversation.view` entry, including
      // ours, which breaks OUR internal two-pane independent scrolling: with
      // no bounded height to overflow against, .wt-root grows to its content
      // and the whole page scrolls as one instead of the list and detail panes
      // scrolling on their own. `viewArea` has no stable selector of its own
      // (a build-hashed class), but it IS structurally exactly the parent of
      // the slot outlet's `[data-slot="conversation.view"]` marker (itself a
      // stable, non-hashed attribute the slot renderer always adds) — so it
      // can be targeted by that relationship alone, scoped narrowly to only
      // when OUR tab is the one currently mounted inside it via :has(.wt-root),
      // never touching Chat/Trajectory/other tabs' own instances of the exact
      // same ancestor.
      'div:has(>[data-slot="conversation.view"]):has(.wt-root){min-height:0!important;overflow:hidden!important;flex:1 1 0!important}',
      '.wt-root{display:flex;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.wt-left{width:360px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}',
      '.wt-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.wt-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px}',
      '.wt-btn:hover{color:var(--dsw-alias-label-primary)}',
      '.wt-btn[data-on="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.wt-btn:disabled{opacity:.45;cursor:default}',
      // Depth stepper: square, monospaced glyphs so + and − sit at equal width.
      '.wt-btn-step{font-family:var(--ds-font-family-code);font-weight:600;padding:3px 0;width:26px;text-align:center}',
      '.wt-div{width:1px;height:16px;flex:none;align-self:center;margin:0 8px;background:var(--dsw-alias-border-l2)}',
      '.wt-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-left:auto}',
      '.wt-list{flex:1;min-height:0;overflow-y:auto}',
      '.wt-item{cursor:pointer;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px}',
      '.wt-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.wt-item[data-sel="1"]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.wt-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.wt-model{font-weight:500;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;min-width:0;flex:1}',
      '.wt-sub{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;gap:8px;flex-wrap:wrap}',
      '.wt-tag{font-size:11px;border-radius:999px;padding:0 6px;line-height:16px;flex:none;border:1px solid var(--dsw-alias-border-l2)}',
      '.wt-tag[data-k="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.wt-tag[data-k="err"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.wt-tag[data-k="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.wt-tag[data-k="live"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.wt-right{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}',
      '.wt-tabs{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.wt-pre{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}',
      '.wt-empty{padding:24px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.wt-err{padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.wt-json{flex:1;min-height:0;overflow:auto;padding:6px 0;background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:12px;line-height:20px}',
      '.wt-jrow{display:flex;align-items:stretch;padding-right:28px;position:relative;white-space:pre}',
      '.wt-jrow[data-c="1"]{cursor:pointer}',
      '.wt-jrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.wt-jind{display:inline-block;width:14px;flex:none;border-left:1px solid var(--dsw-alias-border-l1)}',
      // The gutter is the per-row +/- affordance: dim until the row is hovered,
      // so a deep document reads as jq output rather than a column of symbols.
      '.wt-jgutter{display:inline-block;width:16px;flex:none;text-align:center;color:var(--shiki-token-punctuation);opacity:.45;font-weight:600}',
      '.wt-jrow:hover .wt-jgutter{opacity:1;color:var(--dsw-alias-label-primary)}',
      '.wt-jbody{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}',
      '.wt-jkey{color:var(--shiki-token-function)}',
      '.wt-jpunct{color:var(--shiki-token-punctuation);opacity:.75}',
      '.wt-jstr{color:var(--shiki-token-string)}',
      '.wt-jnum{color:var(--shiki-token-parameter)}',
      '.wt-jbool{color:var(--shiki-token-constant)}',
      '.wt-jnull{color:var(--shiki-token-comment);font-style:italic}',
      '.wt-jsum{color:var(--shiki-token-comment)}',
      '.wt-jmeta{color:var(--shiki-token-comment)}',
      '.wt-jclip{cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}',
      '.wt-jblock{margin:2px 28px 6px 30px;padding:8px 10px;border-left:2px solid var(--shiki-token-string);background:var(--dsw-alias-bg-layer-2);color:var(--shiki-token-string);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;cursor:pointer}',
      '.wt-jcopy{position:absolute;right:4px;top:0;opacity:0;border:none;background:0 0;color:var(--shiki-token-comment);cursor:pointer;font-size:12px;line-height:20px;padding:0 4px}',
      '.wt-jrow:hover .wt-jcopy{opacity:1}',
      '.wt-jcopy:hover{color:var(--dsw-alias-label-primary)}',
      '.wt-jnotice{padding:6px 12px;color:var(--shiki-token-comment);font-size:11px}',
      '.wt-sse{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}',
    ].join('\n')

    function insertStyles() {
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-llm-trace-plugin'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }

    // ------------------------------------------------------------------
    // JSON tree model (a collapsible, syntax-coloured tree over parsed JSON)
    // ------------------------------------------------------------------

    function classify(value) {
      if (value === null) return 'null'
      if (Array.isArray(value)) return 'array'
      const t = typeof value
      if (t === 'object') return 'object'
      if (t === 'string') return 'string'
      if (t === 'number') return 'number'
      if (t === 'boolean') return 'boolean'
      return 'other'
    }

    function isContainer(kind) {
      return kind === 'object' || kind === 'array'
    }

    function childCount(value, kind) {
      if (kind === 'array') return value.length
      if (kind === 'object') return Object.keys(value).length
      return 0
    }

    function isLongString(value) {
      return typeof value === 'string' && (value.length > LONG_STRING || value.indexOf('\n') >= 0)
    }

    function oneLine(text, max) {
      const flat = text.replace(/\s+/g, ' ')
      return flat.length > max ? flat.slice(0, max) + '…' : flat
    }

    /** Collapsed-container placeholder, e.g. `{ … 3 keys }` / `[ … 12 items ]`. */
    function collapsedSummary(kind, count) {
      const noun = kind === 'array' ? (count === 1 ? 'item' : 'items') : (count === 1 ? 'key' : 'keys')
      const open = kind === 'array' ? '[' : '{'
      const close = kind === 'array' ? ']' : '}'
      return open + ' … ' + fmtCount(count) + ' ' + noun + ' ' + close
    }

    /**
     * Flatten a JSON value into jq-shaped display lines.
     *
     * Unlike a node-per-row tree, this emits the punctuation jq itself would
     * print: an expanded container costs an opening line (`"key": {`), its
     * children, and a closing line (`}`) that carries the trailing comma when
     * the container is not its parent's last entry. A collapsed container is a
     * single line whose value is a `{ … n keys }` placeholder, so the shape of
     * the document stays readable at any depth.
     *
     * A line is one of:
     *   - `open`  : container header; `+`/`-` togglable, has `path`
     *   - `close` : container footer; punctuation only
     *   - `leaf`  : a scalar, an empty container, or a collapsed container
     *
     * @param root - the parsed JSON value to render.
     * @param isOpen - (path, depth) => boolean, decides each container's state.
     * @returns {{ lines: object[], truncated: boolean }}
     */
    function flattenJq(root, isOpen) {
      const lines = []
      let truncated = false

      // `label` is the key/index this value sits under (null at the root).
      // `last` drives whether a comma follows this value.
      const walk = (label, labelKind, value, depth, path, last) => {
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

        lines.push({ type: 'open', path, depth, label, labelKind, kind, value, count, last })
        const keys = kind === 'array' ? value.map((_, i) => String(i)) : Object.keys(value)
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
        lines.push({ type: 'close', path: path + '#close', depth, kind, last })
      }

      walk(null, 'none', root, 0, ROOT_PATH, true)
      return { lines, truncated }
    }

    /** Deepest container nesting level present in `root`, capped by `limit`. */
    function maxDepthOf(root, limit) {
      let deepest = 0
      const walk = (value, depth) => {
        if (depth > deepest) deepest = depth
        if (deepest >= limit) return
        const kind = classify(value)
        if (!isContainer(kind)) return
        const keys = kind === 'array' ? value.map((_, i) => String(i)) : Object.keys(value)
        for (const key of keys) walk(value[key], depth + 1)
      }
      walk(root, 0)
      return Math.min(deepest, limit)
    }

    function fmtTime(ms) {
      if (typeof ms !== 'number') return '-'
      const d = new Date(ms)
      const p = (n) => (n < 10 ? '0' + n : String(n))
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0')
    }

    function fmtDuration(ms) {
      if (typeof ms !== 'number') return '-'
      return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'
    }

    function fmtCount(n) {
      return n.toLocaleString('en-US')
    }

    function statusKind(status) {
      if (status === 'ok') return 'ok'
      if (status === 'http-error' || status === 'transport-error') return 'err'
      if (status === 'streaming') return 'live'
      return 'warn'
    }

    function stringify(value) {
      try {
        return JSON.stringify(value, null, 2)
      } catch (error) {
        return 'unable to render JSON: ' + String((error && error.message) || error)
      }
    }

    /**
     * Parse a raw SSE body into one plain object per frame, so the whole
     * stream can be read with the same JSON view as a request body.
     *
     * Frames are separated by blank lines. Every SSE field becomes a key under
     * its protocol name: `data:` holds the parsed JSON when the payload is
     * parseable and the raw string otherwise (so `[DONE]` survives as
     * `"data": "[DONE]"`), and `event:` / `id:` / `retry:` sit alongside it.
     * Comment lines (`: keep-alive`) become `"comment"`. Nothing is dropped —
     * an unparseable or unexpected line is still visible in the result.
     *
     * A frame carrying repeated `data:` lines follows the SSE spec and joins
     * them with newlines before the JSON parse is attempted.
     *
     * @param {string} text - the raw event-stream body.
     * @returns {object[]} one object per frame, in wire order.
     */
    function parseSseFrames(text) {
      if (typeof text !== 'string' || text.length === 0) return []
      const frames = []
      // Normalize CRLF so frame splitting works on either line ending.
      const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
      for (const block of blocks) {
        if (block.trim() === '') continue
        const frame = {}
        const dataLines = []
        const comments = []
        for (const line of block.split('\n')) {
          if (line === '') continue
          if (line.startsWith(':')) {
            comments.push(line.slice(1).trim())
            continue
          }
          const sep = line.indexOf(':')
          const field = sep === -1 ? line : line.slice(0, sep)
          // Per the SSE spec a single leading space after the colon is stripped.
          const value = sep === -1 ? '' : line.slice(sep + 1).replace(/^ /, '')
          if (field === 'data') dataLines.push(value)
          else frame[field] = value
        }
        if (comments.length > 0) frame.comment = comments.length === 1 ? comments[0] : comments
        if (dataLines.length > 0) {
          const payload = dataLines.join('\n')
          // Keep the raw string when the payload isn't JSON, so sentinels like
          // `[DONE]` stay visible instead of being silently dropped.
          let parsed
          try {
            parsed = JSON.parse(payload)
          } catch {
            parsed = payload
          }
          frame.data = parsed
        }
        if (Object.keys(frame).length > 0) frames.push(frame)
      }
      return frames
    }

    /**
     * jq-style pretty-print of a raw SSE body: reformats only the JSON payload
     * of each `data:` line, leaving frame structure — blank separators,
     * `event:`/`id:`/`retry:` fields, comment lines, and non-JSON sentinels
     * like `data: [DONE]` — completely untouched. A `data:` payload that isn't
     * parseable JSON passes through verbatim; a malformed body is never
     * silently rewritten into something that looks valid.
     * @param {string} text - the raw SSE body.
     * @returns {string} the same frame sequence with JSON payloads re-indented.
     */
    function prettySseText(text) {
      if (typeof text !== 'string' || text.length === 0) return text || ''
      const lines = text.split('\n')
      const out = []
      for (const line of lines) {
        const match = /^data:\s?(.*)$/.exec(line)
        if (match === null) {
          out.push(line)
          continue
        }
        const payload = match[1]
        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          out.push(line)
          continue
        }
        const pretty = JSON.stringify(parsed, null, 2)
        // Re-indent every continuation line so the frame's payload still
        // reads as one visually distinct block under its own "data: " lead-in.
        const indented = pretty.split('\n').map((l, i) => (i === 0 ? l : '  ' + l)).join('\n')
        out.push('data: ' + indented)
      }
      return out.join('\n')
    }

    async function apiGet(method, params) {
      const url = new URL(ROUTE + '/' + method, window.location.origin)
      for (const key of Object.keys(params ?? {})) {
        const value = params[key]
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
      }
      const response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('llm-wire-trace ' + method + ' failed: HTTP ' + response.status)
      return response.json()
    }

    async function apiPost(method, body) {
      const response = await fetch(ROUTE + '/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error('llm-wire-trace ' + method + ' failed: HTTP ' + response.status)
      return response.json()
    }

    function download(name, text) {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    }

    function copy(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text)
    }

    /**
     * Render one jq-shaped JSON document.
     *
     * Every line is a real DOM row (not preformatted text), so containers stay
     * individually togglable and long strings keep their expandable block —
     * but the punctuation, indentation, and trailing commas are exactly what
     * `jq .` would print, which is the point of this view.
     */
    function JsonView(props) {
      const { value, isOpen, longOpen, onToggle, onToggleLong } = props
      const flat = React.useMemo(() => flattenJq(value, isOpen), [value, isOpen])

      /** `"key": ` / `` (array elements carry no label in jq output). */
      const labelParts = (line) => {
        if (line.labelKind === 'key') {
          return [
            h('span', { className: 'wt-jkey', key: 'l' }, JSON.stringify(line.label)),
            h('span', { className: 'wt-jpunct', key: 'c' }, ': '),
          ]
        }
        return []
      }

      const elements = []
      for (const line of flat.lines) {
        const indents = []
        for (let i = 0; i < line.depth; i += 1) indents.push(h('span', { className: 'wt-jind', key: 'i' + i }))

        const body = []
        let togglePath = null

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
            if (isLongString(line.value)) {
              body.push(h('span', {
                className: 'wt-jstr wt-jclip',
                key: 'v',
                onClick: (event) => { event.stopPropagation(); onToggleLong(line.path) },
              }, '"' + oneLine(line.value, LONG_STRING) + '"'))
              if (comma) body.push(h('span', { className: 'wt-jpunct', key: 'cm' }, comma))
              body.push(h('span', { className: 'wt-jmeta', key: 'm' }, '  ' + fmtCount(line.value.length) + ' chars'))
            } else {
              body.push(h('span', { className: 'wt-jstr', key: 'v' }, JSON.stringify(line.value)))
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
          onClick: togglePath === null ? undefined : () => onToggle(togglePath, line.depth),
        }, [
          ...indents,
          h('span', {
            className: 'wt-jgutter',
            key: 'g',
          }, togglePath === null ? '' : (line.type === 'open' ? '-' : '+')),
          h('span', { className: 'wt-jbody', key: 'b' }, body),
          line.type === 'close' ? null : h('button', {
            className: 'wt-jcopy',
            key: 'cp',
            title: '复制该节点',
            onClick: (event) => {
              event.stopPropagation()
              copy(typeof line.value === 'string' ? line.value : stringify(line.value))
            },
          }, '⧉'),
        ].filter(Boolean)))

        if (line.type === 'leaf' && line.kind === 'string' && isLongString(line.value) && longOpen.has(line.path)) {
          elements.push(h('div', {
            className: 'wt-jblock',
            key: line.path + '#full',
            title: '点击收起',
            onClick: () => onToggleLong(line.path),
          }, line.value))
        }
      }

      if (flat.truncated) {
        elements.push(h('div', { className: 'wt-jnotice', key: '#truncated' }, '内容过多，已截断到 ' + fmtCount(MAX_ROWS) + ' 行。'))
      }

      return h('div', { className: 'wt-json' }, [
        ...elements,
      ].filter(Boolean))
    }

    // ------------------------------------------------------------------
    // the tab
    // ------------------------------------------------------------------

    function createWireTraceView(ctx) {
      return function WireTraceView() {
        const [auto, setAuto] = React.useState(true)
        const [items, setItems] = React.useState([])
        const [total, setTotal] = React.useState(0)
        const [selected, setSelected] = React.useState(null)
        const [detail, setDetail] = React.useState(null)
        const [tab, setTab] = React.useState('request')
        const [error, setError] = React.useState(null)
        const [tick, setTick] = React.useState(0)
        // Container open/closed state is a global baseline depth plus per-path
        // manual overrides. The global +/- buttons reset the baseline and drop
        // every override (agreed rule): letting the two stack would make "why
        // didn't that branch move?" unanswerable.
        const [depth, setDepth] = React.useState(1)
        const [overrides, setOverrides] = React.useState(() => new Map())
        const [longOpen, setLongOpen] = React.useState(() => new Set())
        const [sseRaw, setSseRaw] = React.useState(false)
        const [curlBusy, setCurlBusy] = React.useState(false)
        const [curlNotice, setCurlNotice] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          apiGet('list', { limit: 300 }).then(
            (result) => {
              if (!alive) return
              setItems((result && result.items) || [])
              setTotal(result ? result.total : 0)
              setError(null)
            },
            (reason) => { if (alive) setError(String((reason && reason.message) || reason)) },
          )
          return () => { alive = false }
        }, [tick])

        React.useEffect(() => {
          if (!auto) return undefined
          return ctx.interval(() => { setTick((n) => n + 1) }, 2000)
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
            (result) => { if (alive) setDetail(result) },
            (reason) => { if (alive) setError(String((reason && reason.message) || reason)) },
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
            (result) => {
              setCurlBusy(false)
              copy(result.command)
              const auth = result.auth || { kind: 'env', envName: 'DSH_CURL_KEY' }
              if (auth.kind === 'value') {
                setCurlNotice('已复制，含解析到的真实密钥——它现在在你的剪贴板里，小心历史记录/共享屏幕。')
              } else {
                setCurlNotice('已复制，authorization 引用了 $' + auth.envName + '；先 export ' + auth.envName + '=你的密钥，再运行就不用改命令了。')
              }
            },
            (reason) => {
              setCurlBusy(false)
              setCurlNotice('生成失败：' + String((reason && reason.message) || reason))
            },
          )
        }

        // A container is open when an explicit override says so, else when its
        // nesting level is within the global baseline depth.
        const isOpen = React.useCallback((path, lineDepth) => {
          const override = overrides.get(path)
          if (override !== undefined) return override
          return lineDepth < depth
        }, [overrides, depth])

        // Per-row toggle records an override that is the negation of whatever
        // the row currently shows, so one click always flips what you see.
        const toggle = React.useCallback((path, lineDepth) => {
          setOverrides((current) => {
            const next = new Map(current)
            const shown = current.has(path) ? current.get(path) : lineDepth < depth
            next.set(path, !shown)
            return next
          })
        }, [depth])

        const toggleLong = React.useCallback((path) => {
          setLongOpen((current) => {
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
        // Response has three shapes: an SSE body becomes one object per frame
        // (so the stream reads as a JSON array), a JSON body is shown as-is,
        // and anything else degrades to `__raw__` the same way. SSE keeps a
        // raw-text toggle because the literal bytes are this plugin's whole
        // point; it just is no longer the default.
        const isSse = detail !== null && detail.response && detail.response.contentType && detail.response.contentType.includes('event-stream')
        const requestParsed = detail !== null && detail.request.bodyJson !== null
        const requestBody = detail === null ? null : (requestParsed ? detail.request.bodyJson : { __raw__: detail.request.bodyText })
        const responseBody = React.useMemo(() => {
          if (detail === null || detail.response === null) return null
          if (isSse) return parseSseFrames(detail.response.bodyText)
          if (detail.response.bodyJson !== null) return detail.response.bodyJson
          return { __raw__: detail.response.bodyText }
        }, [detail, isSse])
        const treeValue = tab === 'request' ? requestBody : responseBody
        const showRaw = tab === 'response' && isSse && sseRaw
        // The raw view is now reachable only for SSE. Frame structure stays
        // verbatim and only each `data:` payload is re-indented, so what you
        // read still matches the bytes on the wire frame-for-frame.
        const rawText = showRaw ? prettySseText(detail.response.bodyText) : ''
        const text = detail === null ? '' : stringify(tab === 'request' ? detail.request : detail.response)

        // Deepest nesting actually present, so `+` can stop at the point where
        // it would no longer change anything (and the button can disable).
        const contentDepth = React.useMemo(
          () => (treeValue === null ? 0 : maxDepthOf(treeValue, 64)),
          [treeValue],
        )

        // Global depth stepper: reset the baseline and drop manual overrides.
        const step = (delta) => {
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
            ]),
          ],
        ))

        return h('div', { className: 'wt-root' }, [
          h('div', { className: 'wt-left', key: 'left' }, [
            h('div', { className: 'wt-bar', key: 'bar' }, [
              h('button', {
                className: 'wt-btn',
                key: 'auto',
                'data-on': auto ? '1' : '0',
                title: auto ? '每 2 秒自动刷新。点击暂停。' : '已暂停刷新。点击恢复并立即刷新一次。',
                onClick: () => {
                  const next = !auto
                  setAuto(next)
                  if (next) setTick((n) => n + 1)
                },
              }, auto ? '自动刷新' : '已暂停'),
              h('button', {
                className: 'wt-btn',
                key: 'clear',
                onClick: () => {
                  apiPost('clear', {}).then(() => {
                    setSelected(null)
                    setTick((n) => n + 1)
                  }, (reason) => setError(String(reason)))
                },
              }, '清空'),
              h('span', { className: 'wt-meta', key: 'meta' }, items.length + ' / ' + total),
            ]),
            error === null ? null : h('div', { className: 'wt-err', key: 'err' }, error),
            h('div', { className: 'wt-list', key: 'list' },
              items.length === 0
                ? h('div', { className: 'wt-empty' }, '尚未捕获到 provider 调用。发一条消息后这里会出现记录（只记录带 deepseek-harness user-agent 的请求）。')
                : rows),
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
                  'data-on': sseRaw ? '1' : '0',
                  title: sseRaw ? '当前显示线路上的原始 SSE 文本。点击切回按帧解析的 JSON 列表。' : '当前把每个 SSE 帧解析成一个 JSON 对象。点击查看线路上的原始文本。',
                  onClick: () => setSseRaw(!sseRaw),
                }, sseRaw ? 'SSE 原始文本' : 'SSE 解析后')
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
            curlNotice === null ? null : h('div', { className: 'wt-jnotice', key: 'curl-notice', style: { padding: '4px 12px' } }, curlNotice),
            detail === null
              ? h('div', { className: 'wt-empty', key: 'empty' }, '在左侧选择一条记录查看完整请求/响应。')
              : (tab === 'response' && detail.response === null)
                ? h('div', { className: 'wt-empty', key: 'pending' }, '响应尚未到达（连接失败或仍在等待）。')
                : showRaw
                  ? h('pre', { className: 'wt-sse', key: 'raw' }, rawText)
                  : h(JsonView, {
                    key: 'json',
                    value: treeValue,
                    isOpen,
                    longOpen,
                    onToggle: toggle,
                    onToggleLong: toggleLong,
                  }),
          ]),
        ])
      }
    }

    const inject = ['slots', 'timer']

    /**
     * @param ctx - client root context.
     *
     * conversation.view sorts by priority first, order only as a tie-break;
     * the shipped Chat and Trajectory tabs carry no priority so they sit at 0.
     * priority: 100 with a slightly higher order than a harness-level "API
     * Trace" tab keeps a stable left-to-right order when such a plugin is also
     * installed: Chat, Trajectory, API Trace, Wire Trace.
     */
    function apply(ctx) {
      ctx.effect(() => insertStyles(), 'llm-wire-trace: stylesheet')
      const WireTraceView = createWireTraceView(ctx)
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register({
          name: 'conversation.view',
          id: 'wire-trace',
          priority: 100,
          order: 110,
          label: () => 'Wire Trace',
        }, WireTraceView),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
