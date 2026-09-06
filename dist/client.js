// dsh-llm-trace-plugin: compiled from src/client/**/*.ts — see README.md "Development".
(() => {
  // src/client/constants.ts
  var ROUTE = "/llm-wire-trace";
  var STYLE_ID = "dsh-llm-trace-plugin/wire-trace.css";
  var PATH_SEP = "\0";
  var ROOT_PATH = "$";
  var LONG_STRING = 120;
  var MAX_ROWS = 2e4;

  // src/client/styles.ts
  var CSS = [
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
    ".wt-root{display:flex;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}",
    ".wt-left{width:360px;flex:none;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l2)}",
    ".wt-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
    ".wt-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px}",
    ".wt-btn:hover{color:var(--dsw-alias-label-primary)}",
    '.wt-btn[data-on="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
    ".wt-btn:disabled{opacity:.45;cursor:default}",
    // Depth stepper: square, monospaced glyphs so + and − sit at equal width.
    ".wt-btn-step{font-family:var(--ds-font-family-code);font-weight:600;padding:3px 0;width:26px;text-align:center}",
    ".wt-div{width:1px;height:16px;flex:none;align-self:center;margin:0 8px;background:var(--dsw-alias-border-l2)}",
    ".wt-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-left:auto}",
    ".wt-list{flex:1;min-height:0;overflow-y:auto}",
    ".wt-item{cursor:pointer;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:3px}",
    ".wt-item:hover{background:var(--dsw-alias-bg-layer-2)}",
    '.wt-item[data-sel="1"]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
    ".wt-row{display:flex;align-items:center;gap:6px;min-width:0}",
    ".wt-model{font-weight:500;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;min-width:0;flex:1}",
    ".wt-sub{color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;gap:8px;flex-wrap:wrap}",
    ".wt-tag{font-size:11px;border-radius:999px;padding:0 6px;line-height:16px;flex:none;border:1px solid var(--dsw-alias-border-l2)}",
    '.wt-tag[data-k="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
    '.wt-tag[data-k="err"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
    '.wt-tag[data-k="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
    '.wt-tag[data-k="live"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
    ".wt-right{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}",
    ".wt-tabs{display:flex;align-items:center;gap:4px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
    ".wt-pre{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}",
    ".wt-empty{padding:24px;color:var(--dsw-alias-label-secondary);text-align:center}",
    ".wt-err{padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px}",
    ".wt-json{flex:1;min-height:0;overflow:auto;padding:6px 0;background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:12px;line-height:20px}",
    ".wt-jrow{display:flex;align-items:stretch;padding-right:28px;position:relative;white-space:pre}",
    '.wt-jrow[data-c="1"]{cursor:pointer}',
    ".wt-jrow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    ".wt-jind{display:inline-block;width:14px;flex:none;border-left:1px solid var(--dsw-alias-border-l1)}",
    // The gutter is the per-row +/- affordance: dim until the row is hovered,
    // so a deep document reads as jq output rather than a column of symbols.
    ".wt-jgutter{display:inline-block;width:16px;flex:none;text-align:center;color:var(--shiki-token-punctuation);opacity:.45;font-weight:600}",
    ".wt-jrow:hover .wt-jgutter{opacity:1;color:var(--dsw-alias-label-primary)}",
    ".wt-jbody{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}",
    ".wt-jkey{color:var(--shiki-token-function)}",
    ".wt-jpunct{color:var(--shiki-token-punctuation);opacity:.75}",
    ".wt-jstr{color:var(--shiki-token-string)}",
    ".wt-jnum{color:var(--shiki-token-parameter)}",
    ".wt-jbool{color:var(--shiki-token-constant)}",
    ".wt-jnull{color:var(--shiki-token-comment);font-style:italic}",
    ".wt-jsum{color:var(--shiki-token-comment)}",
    ".wt-jmeta{color:var(--shiki-token-comment)}",
    ".wt-jclip{cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}",
    ".wt-jblock{margin:2px 28px 6px 30px;padding:8px 10px;border-left:2px solid var(--shiki-token-string);background:var(--dsw-alias-bg-layer-2);color:var(--shiki-token-string);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;cursor:pointer}",
    ".wt-jcopy{position:absolute;right:4px;top:0;opacity:0;border:none;background:0 0;color:var(--shiki-token-comment);cursor:pointer;font-size:12px;line-height:20px;padding:0 4px}",
    ".wt-jrow:hover .wt-jcopy{opacity:1}",
    ".wt-jcopy:hover{color:var(--dsw-alias-label-primary)}",
    ".wt-jnotice{padding:6px 12px;color:var(--shiki-token-comment);font-size:11px}",
    ".wt-sse{flex:1;min-height:0;margin:0;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code);font-size:12px;line-height:19px;background:var(--dsw-alias-markdown-code-block)}",
    // ---- turn/step presentation ----
    // A sticky group header so a long list still tells you which turn you
    // are looking at while scrolling.
    ".wt-turn{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}",
    ".wt-turn-n{font-weight:600;color:var(--dsw-alias-label-primary)}",
    ".wt-turn-meta{margin-left:auto}",
    // The step coordinate: monospaced so digits line up down the column.
    ".wt-step{font-family:var(--ds-font-family-code);font-size:11px;flex:none;border-radius:4px;padding:0 5px;line-height:16px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
    '.wt-step[data-k="step"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
    '.wt-step[data-k="aux"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
    '.wt-step[data-k="none"]{opacity:.6}',
    // Detail-pane coordinate strip: the same facts, always visible above the body.
    ".wt-coords{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:11px;color:var(--dsw-alias-label-secondary)}",
    ".wt-coord{display:flex;align-items:baseline;gap:4px}",
    ".wt-coord b{font-weight:600;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);font-size:12px}",
    ".wt-coord-sep{width:1px;height:12px;background:var(--dsw-alias-border-l2)}"
  ].join("\n");
  function insertStyles() {
    const selector = "style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]";
    if (document.querySelector(selector) !== null) return () => {
    };
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-llm-trace-plugin";
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }

  // src/client/api-client.ts
  async function apiGet(method, params) {
    const url = new URL(ROUTE + "/" + method, window.location.origin);
    for (const key of Object.keys(params ?? {})) {
      const value = params[key];
      if (value !== void 0 && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url.toString(), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("llm-wire-trace " + method + " failed: HTTP " + response.status);
    return response.json();
  }
  async function apiPost(method, body) {
    const response = await fetch(ROUTE + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
    if (!response.ok) throw new Error("llm-wire-trace " + method + " failed: HTTP " + response.status);
    return response.json();
  }
  function download(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  }

  // src/client/format.ts
  function fmtTime(ms) {
    if (typeof ms !== "number") return "-";
    const d = new Date(ms);
    const p = (n) => n < 10 ? "0" + n : String(n);
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }
  function fmtDuration(ms) {
    if (typeof ms !== "number") return "-";
    return ms < 1e3 ? ms + "ms" : (ms / 1e3).toFixed(1) + "s";
  }
  function shortSessionId(sessionId) {
    const text = String(sessionId);
    const marker = text.lastIndexOf("session-");
    const distinct = marker === -1 ? text : text.slice(marker + "session-".length);
    const body = distinct.length > 0 ? distinct : text;
    return body.slice(0, 8);
  }
  function sessionLabel(sessionId, currentSessionId) {
    if (sessionId === null || sessionId === void 0 || sessionId === "") return "\u65E0 session";
    if (sessionId === currentSessionId) return "\u672C session";
    return "session " + shortSessionId(sessionId);
  }
  function purposeLabel(purpose) {
    if (purpose === "session-title") return "\u6807\u9898\u751F\u6210";
    if (purpose === "compaction") return "\u4E0A\u4E0B\u6587\u538B\u7F29";
    if (typeof purpose === "string" && purpose.length > 0) return purpose;
    return null;
  }
  function stepBadge(item) {
    const aux = purposeLabel(item.purpose);
    if (aux !== null) {
      return {
        text: aux,
        kind: "aux",
        title: "\u540E\u53F0\u8F85\u52A9\u8C03\u7528\uFF08" + aux + "\uFF09\uFF0C\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u4E00\u6B21\u5BF9\u8BDD turn\uFF0C\u56E0\u6B64\u6CA1\u6709 step \u5750\u6807\u3002"
      };
    }
    if (typeof item.turn === "number" && typeof item.step === "number") {
      return {
        text: "T" + item.turn + "\xB7S" + item.step,
        kind: "step",
        title: "\u7B2C " + item.turn + " \u8F6E\u5BF9\u8BDD\u7684\u7B2C " + item.step + " \u6B65\uFF08\u4E00\u4E2A step = \u4E00\u6B21\u6A21\u578B\u8C03\u7528\uFF09\u3002"
      };
    }
    if (typeof item.turn === "number") {
      return { text: "T" + item.turn, kind: "step", title: "\u7B2C " + item.turn + " \u8F6E\u5BF9\u8BDD\uFF0C\u8C03\u7528\u53D1\u751F\u5728\u4E24\u4E2A step \u4E4B\u95F4\u3002" };
    }
    return {
      text: "\u65E0\u5F52\u5C5E",
      kind: "none",
      title: item.attributed === false ? "\u8FD9\u6B21\u8BF7\u6C42\u6CA1\u6709\u7ECF\u8FC7 ctx.llm\uFF0C\u63D2\u4EF6\u65E0\u6CD5\u786E\u5B9A\u5B83\u5C5E\u4E8E\u54EA\u4E00\u8F6E\u5BF9\u8BDD\u3002" : "\u8FD9\u6B21\u8C03\u7528\u53D1\u751F\u5728\u4EFB\u4F55 turn \u4E4B\u5916\u3002"
    };
  }
  function statusKind(status) {
    if (status === "ok") return "ok";
    if (status === "http-error" || status === "transport-error") return "err";
    if (status === "streaming") return "live";
    return "warn";
  }
  function stringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return "unable to render JSON: " + String(error && error.message || error);
    }
  }

  // src/client/json-model.ts
  function classify(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    const t = typeof value;
    if (t === "object") return "object";
    if (t === "string") return "string";
    if (t === "number") return "number";
    if (t === "boolean") return "boolean";
    return "other";
  }
  function isContainer(kind) {
    return kind === "object" || kind === "array";
  }
  function childCount(value, kind) {
    if (kind === "array") return value.length;
    if (kind === "object") return Object.keys(value).length;
    return 0;
  }
  function isLongString(value) {
    return typeof value === "string" && (value.length > LONG_STRING || value.indexOf("\n") >= 0);
  }
  function oneLine(text, max) {
    const flat = text.replace(/\s+/g, " ");
    return flat.length > max ? flat.slice(0, max) + "\u2026" : flat;
  }
  function fmtCount(n) {
    return n.toLocaleString("en-US");
  }
  function collapsedSummary(kind, count) {
    const noun = kind === "array" ? count === 1 ? "item" : "items" : count === 1 ? "key" : "keys";
    const open = kind === "array" ? "[" : "{";
    const close = kind === "array" ? "]" : "}";
    return open + " \u2026 " + fmtCount(count) + " " + noun + " " + close;
  }
  function flattenJq(root, isOpen) {
    const lines = [];
    let truncated = false;
    const walk = (label, labelKind, value, depth, path, last) => {
      if (lines.length >= MAX_ROWS) {
        truncated = true;
        return;
      }
      const kind = classify(value);
      const count = childCount(value, kind);
      const container = isContainer(kind) && count > 0;
      const open = container && isOpen(path, depth);
      if (!container || !open) {
        lines.push({ type: "leaf", path, depth, label, labelKind, kind, value, count, container, last });
        return;
      }
      lines.push({ type: "open", path, depth, label, labelKind, kind, value, count, container: true, last });
      const keys = kind === "array" ? value.map((_, i) => String(i)) : Object.keys(value);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        walk(
          key,
          kind === "array" ? "index" : "key",
          value[key],
          depth + 1,
          path + PATH_SEP + key,
          i === keys.length - 1
        );
      }
      if (lines.length >= MAX_ROWS) {
        truncated = true;
        return;
      }
      lines.push({
        type: "close",
        path: path + "#close",
        depth,
        label: null,
        labelKind: "none",
        kind,
        value: void 0,
        count: 0,
        container: false,
        last
      });
    };
    walk(null, "none", root, 0, ROOT_PATH, true);
    return { lines, truncated };
  }
  function maxDepthOf(root, limit) {
    let deepest = 0;
    const walk = (value, depth) => {
      if (depth > deepest) deepest = depth;
      if (deepest >= limit) return;
      const kind = classify(value);
      if (!isContainer(kind)) return;
      const keys = kind === "array" ? value.map((_, i) => String(i)) : Object.keys(value);
      for (const key of keys) walk(value[key], depth + 1);
    };
    walk(root, 0);
    return Math.min(deepest, limit);
  }

  // src/client/sse.ts
  function parseSseFrames(text) {
    if (typeof text !== "string" || text.length === 0) return [];
    const frames = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
    for (const block of blocks) {
      if (block.trim() === "") continue;
      const frame = {};
      const dataLines = [];
      const comments = [];
      for (const line of block.split("\n")) {
        if (line === "") continue;
        if (line.startsWith(":")) {
          comments.push(line.slice(1).trim());
          continue;
        }
        const sep = line.indexOf(":");
        const field = sep === -1 ? line : line.slice(0, sep);
        const value = sep === -1 ? "" : line.slice(sep + 1).replace(/^ /, "");
        if (field === "data") dataLines.push(value);
        else frame[field] = value;
      }
      if (comments.length > 0) frame.comment = comments.length === 1 ? comments[0] : comments;
      if (dataLines.length > 0) {
        const payload = dataLines.join("\n");
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          parsed = payload;
        }
        frame.data = parsed;
      }
      if (Object.keys(frame).length > 0) frames.push(frame);
    }
    return frames;
  }
  function prettySseText(text) {
    if (typeof text !== "string" || text.length === 0) return text || "";
    const lines = text.split("\n");
    const out = [];
    for (const line of lines) {
      const match = /^data:\s?(.*)$/.exec(line);
      if (match === null) {
        out.push(line);
        continue;
      }
      const payload = match[1];
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        out.push(line);
        continue;
      }
      const pretty = JSON.stringify(parsed, null, 2);
      const indented = pretty.split("\n").map((l, i) => i === 0 ? l : "  " + l).join("\n");
      out.push("data: " + indented);
    }
    return out.join("\n");
  }

  // src/client/sse-merge/shared.ts
  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function tryParseJson(text) {
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // src/client/sse-merge/anthropic.ts
  function newBlock(index) {
    return { index, type: null, text: "", thinking: "", signature: null, id: null, name: null, inputJsonText: "", extra: {} };
  }
  var ANTHROPIC_EVENTS = /* @__PURE__ */ new Set([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop"
  ]);
  function createAnthropicAdapter() {
    const message = {};
    const blocks = /* @__PURE__ */ new Map();
    let stopReason = null;
    let stopSequence = null;
    let recognizedAny = false;
    const blockAt = (index) => {
      let block = blocks.get(index);
      if (block === void 0) {
        block = newBlock(index);
        blocks.set(index, block);
      }
      return block;
    };
    return {
      name: "anthropic-messages",
      get recognizedAny() {
        return recognizedAny;
      },
      fold(frame) {
        const event = frame.event;
        const data = frame.data;
        if (typeof event !== "string" || !ANTHROPIC_EVENTS.has(event) || !isPlainObject(data)) return false;
        recognizedAny = true;
        if (event === "message_start") {
          if (isPlainObject(data.message)) Object.assign(message, data.message);
          return true;
        }
        if (event === "content_block_start") {
          const index = typeof data.index === "number" ? data.index : 0;
          const block = blockAt(index);
          const raw = isPlainObject(data.content_block) ? data.content_block : {};
          if (typeof raw.type === "string") block.type = raw.type;
          if (typeof raw.id === "string") block.id = raw.id;
          if (typeof raw.name === "string") block.name = raw.name;
          if (typeof raw.text === "string") block.text += raw.text;
          return true;
        }
        if (event === "content_block_delta") {
          const index = typeof data.index === "number" ? data.index : 0;
          const block = blockAt(index);
          const delta = isPlainObject(data.delta) ? data.delta : {};
          if (typeof delta.text === "string") block.text += delta.text;
          if (typeof delta.thinking === "string") block.thinking += delta.thinking;
          if (typeof delta.signature === "string") block.signature = (block.signature ?? "") + delta.signature;
          if (typeof delta.partial_json === "string") block.inputJsonText += delta.partial_json;
          return true;
        }
        if (event === "content_block_stop") {
          return true;
        }
        if (event === "message_delta") {
          if (isPlainObject(data.delta)) {
            if (typeof data.delta.stop_reason === "string") stopReason = data.delta.stop_reason;
            if (typeof data.delta.stop_sequence === "string") stopSequence = data.delta.stop_sequence;
          }
          for (const key of Object.keys(data)) {
            if (key === "delta" || key === "type") continue;
            message[key] = data[key];
          }
          return true;
        }
        return true;
      },
      result() {
        const content = [...blocks.values()].sort((a, b) => a.index - b.index).map((block) => {
          if (block.type === "text") return { type: "text", text: block.text };
          if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, signature: block.signature };
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: tryParseJson(block.inputJsonText),
              inputJsonText: block.inputJsonText
            };
          }
          return { type: block.type, ...block.extra };
        });
        const usage = isPlainObject(message.usage) ? message.usage : null;
        return {
          id: typeof message.id === "string" ? message.id : null,
          type: "message",
          role: typeof message.role === "string" ? message.role : null,
          model: typeof message.model === "string" ? message.model : null,
          content,
          stop_reason: stopReason,
          stop_sequence: stopSequence,
          usage,
          ...Object.fromEntries(Object.entries(message).filter(([key]) => !["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"].includes(key)))
        };
      }
    };
  }

  // src/client/sse-merge/openai-responses.ts
  function newItem(index) {
    return {
      index,
      type: null,
      id: null,
      text: "",
      reasoningSummaryText: "",
      reasoningContentText: "",
      callId: null,
      name: null,
      argumentsText: "",
      extra: {}
    };
  }
  var RESPONSES_API_EVENTS = /* @__PURE__ */ new Set([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_text.delta",
    "response.output_text.done",
    "response.reasoning_text.delta",
    "response.reasoning_text.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.content_part.added",
    "response.content_part.done",
    "response.completed",
    "response.failed",
    "response.incomplete"
  ]);
  function createOpenAiResponsesAdapter() {
    const response = {};
    const items = /* @__PURE__ */ new Map();
    let status = null;
    let recognizedAny = false;
    const itemAt = (index) => {
      let item = items.get(index);
      if (item === void 0) {
        item = newItem(index);
        items.set(index, item);
      }
      return item;
    };
    return {
      name: "openai-responses",
      get recognizedAny() {
        return recognizedAny;
      },
      fold(frame) {
        const event = frame.event;
        const data = frame.data;
        if (typeof event !== "string" || !RESPONSES_API_EVENTS.has(event) || !isPlainObject(data)) return false;
        recognizedAny = true;
        if (event === "response.created" || event === "response.in_progress" || event === "response.completed" || event === "response.failed" || event === "response.incomplete") {
          if (isPlainObject(data.response)) {
            Object.assign(response, data.response);
            if (typeof data.response.status === "string") status = data.response.status;
          }
          return true;
        }
        if (event === "response.output_item.added" || event === "response.output_item.done") {
          const index = typeof data.output_index === "number" ? data.output_index : 0;
          const item = itemAt(index);
          const raw = isPlainObject(data.item) ? data.item : {};
          if (typeof raw.type === "string") item.type = raw.type;
          if (typeof raw.id === "string" && item.id === null) item.id = raw.id;
          if (item.type === "function_call") {
            if (typeof raw.call_id === "string" && item.callId === null) item.callId = raw.call_id;
            if (typeof raw.name === "string" && item.name === null) item.name = raw.name;
            if (typeof raw.arguments === "string" && item.argumentsText.length === 0) item.argumentsText = raw.arguments;
          }
          return true;
        }
        if (event === "response.output_text.delta") {
          const index = typeof data.output_index === "number" ? data.output_index : 0;
          if (typeof data.delta === "string") itemAt(index).text += data.delta;
          return true;
        }
        if (event === "response.reasoning_text.delta") {
          const index = typeof data.output_index === "number" ? data.output_index : 0;
          if (typeof data.delta === "string") itemAt(index).reasoningContentText += data.delta;
          return true;
        }
        if (event === "response.reasoning_summary_text.delta") {
          const index = typeof data.output_index === "number" ? data.output_index : 0;
          if (typeof data.delta === "string") itemAt(index).reasoningSummaryText += data.delta;
          return true;
        }
        if (event === "response.function_call_arguments.delta") {
          const index = typeof data.output_index === "number" ? data.output_index : 0;
          if (typeof data.delta === "string") itemAt(index).argumentsText += data.delta;
          return true;
        }
        return true;
      },
      result() {
        const output = [...items.values()].sort((a, b) => a.index - b.index).map((item) => {
          if (item.type === "message") {
            return {
              type: "message",
              id: item.id,
              role: "assistant",
              content: item.text.length > 0 || item.reasoningSummaryText.length === 0 ? [{ type: "output_text", text: item.text }] : []
            };
          }
          if (item.type === "reasoning") {
            return {
              type: "reasoning",
              id: item.id,
              summary: item.reasoningSummaryText.length > 0 ? [{ type: "summary_text", text: item.reasoningSummaryText }] : [],
              content: item.reasoningContentText.length > 0 ? [{ type: "reasoning_text", text: item.reasoningContentText }] : null
            };
          }
          if (item.type === "function_call") {
            return {
              type: "function_call",
              id: item.id,
              call_id: item.callId,
              name: item.name,
              arguments: item.argumentsText,
              argumentsJson: tryParseJson(item.argumentsText)
            };
          }
          return { type: item.type, ...item.extra };
        });
        const usage = isPlainObject(response.usage) ? response.usage : null;
        return {
          id: typeof response.id === "string" ? response.id : null,
          object: "response",
          model: typeof response.model === "string" ? response.model : null,
          status,
          output,
          usage,
          ...Object.fromEntries(Object.entries(response).filter(([key]) => !["id", "object", "model", "status", "output", "usage"].includes(key)))
        };
      }
    };
  }

  // src/client/sse-merge/openai-chat-completions.ts
  function newChoice(index) {
    return { index, content: "", hasContent: false, reasoningContent: "", hasReasoningContent: false, toolCalls: /* @__PURE__ */ new Map(), finishReason: null };
  }
  function isDeltaChunk(data) {
    return isPlainObject(data) && Array.isArray(data.choices);
  }
  function createOpenAiChatCompletionsAdapter() {
    const envelope = {};
    const choices = /* @__PURE__ */ new Map();
    let recognizedAny = false;
    const choiceAt = (index) => {
      let choice = choices.get(index);
      if (choice === void 0) {
        choice = newChoice(index);
        choices.set(index, choice);
      }
      return choice;
    };
    return {
      name: "openai-chat-completions",
      get recognizedAny() {
        return recognizedAny;
      },
      fold(frame) {
        const data = frame.data;
        if (!isDeltaChunk(data)) return false;
        recognizedAny = true;
        for (const key of Object.keys(data)) {
          if (key === "choices") continue;
          envelope[key] = data[key];
        }
        for (const rawChoice of data.choices) {
          if (!isPlainObject(rawChoice)) continue;
          const index = typeof rawChoice.index === "number" ? rawChoice.index : 0;
          const choice = choiceAt(index);
          const delta = isPlainObject(rawChoice.delta) ? rawChoice.delta : {};
          if (typeof delta.content === "string") {
            choice.content += delta.content;
            choice.hasContent = true;
          }
          if (typeof delta.reasoning_content === "string") {
            choice.reasoningContent += delta.reasoning_content;
            choice.hasReasoningContent = true;
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const rawCall of delta.tool_calls) {
              if (!isPlainObject(rawCall)) continue;
              const callIndex = typeof rawCall.index === "number" ? rawCall.index : 0;
              let call = choice.toolCalls.get(callIndex);
              if (call === void 0) {
                call = { index: callIndex, id: null, name: null, arguments: "" };
                choice.toolCalls.set(callIndex, call);
              }
              if (typeof rawCall.id === "string" && call.id === null) call.id = rawCall.id;
              const fn = isPlainObject(rawCall.function) ? rawCall.function : {};
              if (typeof fn.name === "string" && call.name === null) call.name = fn.name;
              if (typeof fn.arguments === "string") call.arguments += fn.arguments;
            }
          }
          if (typeof rawChoice.finish_reason === "string") choice.finishReason = rawChoice.finish_reason;
        }
        return true;
      },
      result() {
        const merged = [...choices.values()].sort((a, b) => a.index - b.index).map((choice) => {
          const toolCalls = [...choice.toolCalls.values()].sort((a, b) => a.index - b.index).map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
            argumentsJson: tryParseJson(call.arguments)
          }));
          return {
            index: choice.index,
            message: {
              role: "assistant",
              content: choice.hasContent ? choice.content : null,
              reasoning_content: choice.hasReasoningContent ? choice.reasoningContent : null,
              tool_calls: toolCalls.length > 0 ? toolCalls : null
            },
            finish_reason: choice.finishReason
          };
        });
        const usage = isPlainObject(envelope.usage) ? envelope.usage : null;
        return {
          id: typeof envelope.id === "string" ? envelope.id : null,
          object: "chat.completion",
          model: typeof envelope.model === "string" ? envelope.model : null,
          choices: merged,
          usage,
          ...Object.fromEntries(Object.entries(envelope).filter(([key]) => !["id", "object", "model", "choices", "usage"].includes(key)))
        };
      }
    };
  }

  // src/client/sse-merge/index.ts
  var ADAPTER_FACTORIES = [
    createAnthropicAdapter,
    createOpenAiResponsesAdapter,
    createOpenAiChatCompletionsAdapter
  ];
  function mergeSseChunks(frames) {
    const adapters = ADAPTER_FACTORIES.map((factory) => factory());
    const unrecognized = [];
    let recognizedFrameCount = 0;
    let sawDone = false;
    for (const frame of frames) {
      if (frame.data === "[DONE]") {
        sawDone = true;
        continue;
      }
      let recognized = false;
      for (const adapter of adapters) {
        if (adapter.fold(frame)) {
          recognized = true;
          break;
        }
      }
      if (recognized) recognizedFrameCount += 1;
      else unrecognized.push(frame);
    }
    const [anthropicAdapter, responsesAdapter, chatCompletionAdapter] = adapters;
    return {
      anthropic: anthropicAdapter.recognizedAny ? anthropicAdapter.result() : null,
      responses: responsesAdapter.recognizedAny ? responsesAdapter.result() : null,
      chatCompletion: chatCompletionAdapter.recognizedAny ? chatCompletionAdapter.result() : null,
      frameCount: frames.length,
      recognizedFrameCount,
      sawDone,
      unrecognized
    };
  }

  // src/client/json-view.ts
  function createJsonView(React) {
    const h = React.createElement;
    return function JsonView(props) {
      const { value, isOpen, longOpen, onToggle, onToggleLong } = props;
      const flat = React.useMemo(() => flattenJq(value, isOpen), [value, isOpen]);
      const labelParts = (line) => {
        if (line.labelKind === "key") {
          return [
            h("span", { className: "wt-jkey", key: "l" }, JSON.stringify(line.label)),
            h("span", { className: "wt-jpunct", key: "c" }, ": ")
          ];
        }
        return [];
      };
      const elements = [];
      for (const line of flat.lines) {
        const indents = [];
        for (let i = 0; i < line.depth; i += 1) indents.push(h("span", { className: "wt-jind", key: "i" + i }));
        const body = [];
        let togglePath = null;
        if (line.type === "close") {
          body.push(h("span", { className: "wt-jpunct", key: "v" }, (line.kind === "array" ? "]" : "}") + (line.last ? "" : ",")));
        } else if (line.type === "open") {
          togglePath = line.path;
          body.push(...labelParts(line));
          body.push(h("span", { className: "wt-jpunct", key: "v" }, line.kind === "array" ? "[" : "{"));
        } else {
          body.push(...labelParts(line));
          const comma = line.last ? "" : ",";
          if (line.container) {
            togglePath = line.path;
            body.push(h("span", { className: "wt-jsum", key: "v" }, collapsedSummary(line.kind, line.count)));
            if (comma) body.push(h("span", { className: "wt-jpunct", key: "cm" }, comma));
          } else if (line.kind === "object" || line.kind === "array") {
            body.push(h("span", { className: "wt-jpunct", key: "v" }, (line.kind === "array" ? "[]" : "{}") + comma));
          } else if (line.kind === "string") {
            const strValue = line.value;
            if (isLongString(strValue)) {
              body.push(h("span", {
                className: "wt-jstr wt-jclip",
                key: "v",
                onClick: (event) => {
                  event.stopPropagation();
                  onToggleLong(line.path);
                }
              }, '"' + oneLine(strValue, LONG_STRING) + '"'));
              if (comma) body.push(h("span", { className: "wt-jpunct", key: "cm" }, comma));
              body.push(h("span", { className: "wt-jmeta", key: "m" }, "  " + fmtCount(strValue.length) + " chars"));
            } else {
              body.push(h("span", { className: "wt-jstr", key: "v" }, JSON.stringify(strValue)));
              if (comma) body.push(h("span", { className: "wt-jpunct", key: "cm" }, comma));
            }
          } else {
            const cls = line.kind === "number" ? "wt-jnum" : line.kind === "boolean" ? "wt-jbool" : "wt-jnull";
            const rendered = line.kind === "null" ? "null" : String(line.value);
            body.push(h("span", { className: cls, key: "v" }, rendered));
            if (comma) body.push(h("span", { className: "wt-jpunct", key: "cm" }, comma));
          }
        }
        elements.push(h("div", {
          className: "wt-jrow",
          key: line.path + ":" + line.type,
          "data-c": togglePath === null ? "0" : "1",
          onClick: togglePath === null ? void 0 : () => onToggle(togglePath, line.depth)
        }, [
          ...indents,
          h("span", {
            className: "wt-jgutter",
            key: "g"
          }, togglePath === null ? "" : line.type === "open" ? "-" : "+"),
          h("span", { className: "wt-jbody", key: "b" }, body),
          line.type === "close" ? null : h("button", {
            className: "wt-jcopy",
            key: "cp",
            title: "\u590D\u5236\u8BE5\u8282\u70B9",
            onClick: (event) => {
              event.stopPropagation();
              copy(typeof line.value === "string" ? line.value : stringify(line.value));
            }
          }, "\u29C9")
        ].filter(Boolean)));
        if (line.type === "leaf" && line.kind === "string" && isLongString(line.value) && longOpen.has(line.path)) {
          elements.push(h("div", {
            className: "wt-jblock",
            key: line.path + "#full",
            title: "\u70B9\u51FB\u6536\u8D77",
            onClick: () => onToggleLong(line.path)
          }, line.value));
        }
      }
      if (flat.truncated) {
        elements.push(h("div", { className: "wt-jnotice", key: "#truncated" }, "\u5185\u5BB9\u8FC7\u591A\uFF0C\u5DF2\u622A\u65AD\u5230 " + fmtCount(MAX_ROWS) + " \u884C\u3002"));
      }
      return h("div", { className: "wt-json" }, [
        ...elements
      ].filter(Boolean));
    };
  }

  // src/client/wire-trace-view.ts
  function createWireTraceView(React, ctx) {
    const h = React.createElement;
    const JsonView = createJsonView(React);
    return function WireTraceView(props) {
      const currentSessionId = props && props.sessionId ? String(props.sessionId) : null;
      const [auto, setAuto] = React.useState(true);
      const [onlySession, setOnlySession] = React.useState(true);
      const [items, setItems] = React.useState([]);
      const [total, setTotal] = React.useState(0);
      const [matched, setMatched] = React.useState(0);
      const [unattributed, setUnattributed] = React.useState(0);
      const [turns, setTurns] = React.useState([]);
      const [auxiliary, setAuxiliary] = React.useState(0);
      const [selected, setSelected] = React.useState(null);
      const [detail, setDetail] = React.useState(null);
      const [tab, setTab] = React.useState("request");
      const [error, setError] = React.useState(null);
      const [tick, setTick] = React.useState(0);
      const [depth, setDepth] = React.useState(1);
      const [overrides, setOverrides] = React.useState(() => /* @__PURE__ */ new Map());
      const [longOpen, setLongOpen] = React.useState(() => /* @__PURE__ */ new Set());
      const [sseMerged, setSseMerged] = React.useState(true);
      const [curlBusy, setCurlBusy] = React.useState(false);
      const [curlNotice, setCurlNotice] = React.useState(null);
      const [autoFellBack, setAutoFellBack] = React.useState(false);
      const fallbackUsed = React.useRef(false);
      const [truncated, setTruncated] = React.useState(false);
      const [historyLoading, setHistoryLoading] = React.useState(false);
      const [historyTick, setHistoryTick] = React.useState(0);
      const historyLanded = React.useRef(false);
      const inFlight = React.useRef(false);
      const filtering = onlySession && currentSessionId !== null;
      const applyPage = React.useCallback((result, opts) => {
        const nextItems = result && result.items || [];
        const nextMatched = result && typeof result.matched === "number" ? result.matched : 0;
        const nextUnattributed = result && typeof result.unattributed === "number" ? result.unattributed : 0;
        const decisive = !(result && result.historyPending === true);
        if (opts.filtering && decisive && !fallbackUsed.current && nextMatched === 0 && nextUnattributed > 0) {
          fallbackUsed.current = true;
          setAutoFellBack(true);
          setOnlySession(false);
          return false;
        }
        if (opts.memoryOnly && historyLanded.current) {
          setItems((prev) => {
            const byId = /* @__PURE__ */ new Map();
            for (const row of prev) byId.set(row.id, row);
            for (const row of nextItems) byId.set(row.id, row);
            return [...byId.values()].sort((a, b) => {
              if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
              return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
            });
          });
          setError(null);
          return true;
        }
        if (!opts.memoryOnly) historyLanded.current = true;
        setItems(nextItems);
        setTruncated(result ? result.truncated === true : false);
        setTotal(result ? result.total : 0);
        setMatched(nextMatched);
        setUnattributed(nextUnattributed);
        setTurns(result && result.turns || []);
        setAuxiliary(result && typeof result.auxiliary === "number" ? result.auxiliary : 0);
        setError(null);
        return true;
      }, []);
      React.useEffect(() => {
        if (inFlight.current) return void 0;
        let alive = true;
        inFlight.current = true;
        apiGet("list", {
          limit: 100,
          source: "memory",
          sessionId: filtering ? currentSessionId : void 0
        }).then(
          (result) => {
            inFlight.current = false;
            if (!alive) return;
            applyPage(result, { filtering, memoryOnly: true });
          },
          (reason) => {
            inFlight.current = false;
            if (alive) setError(String(reason && reason.message || reason));
          }
        );
        return () => {
          alive = false;
        };
      }, [tick, filtering, currentSessionId, applyPage]);
      React.useEffect(() => {
        let alive = true;
        historyLanded.current = false;
        setHistoryLoading(true);
        apiGet("list", {
          limit: 100,
          sessionId: filtering ? currentSessionId : void 0
        }).then(
          (result) => {
            if (!alive) return;
            setHistoryLoading(false);
            applyPage(result, { filtering, memoryOnly: false });
          },
          (reason) => {
            if (!alive) return;
            setHistoryLoading(false);
            setError(String(reason && reason.message || reason));
          }
        );
        return () => {
          alive = false;
        };
      }, [historyTick, filtering, currentSessionId, applyPage]);
      React.useEffect(() => {
        if (!auto) return void 0;
        return ctx.interval(() => {
          if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
          setTick((n) => n + 1);
        }, 3e3);
      }, [auto]);
      const selectedStatus = React.useMemo(() => {
        const found = items.find((item) => item.id === selected);
        return found ? found.status : null;
      }, [items, selected]);
      const detailTick = selectedStatus === "streaming" ? tick : 0;
      React.useEffect(() => {
        if (selected === null) {
          setDetail(null);
          return void 0;
        }
        let alive = true;
        apiGet("get", { id: selected }).then(
          (result) => {
            if (alive) setDetail(result);
          },
          (reason) => {
            if (alive) setError(String(reason && reason.message || reason));
          }
        );
        return () => {
          alive = false;
        };
      }, [selected, detailTick]);
      React.useEffect(() => {
        setDepth(1);
        setOverrides(/* @__PURE__ */ new Map());
        setLongOpen(/* @__PURE__ */ new Set());
      }, [selected, tab]);
      React.useEffect(() => {
        setCurlNotice(null);
      }, [selected]);
      const copyCurl = () => {
        if (detail === null || curlBusy) return;
        setCurlBusy(true);
        setCurlNotice(null);
        apiGet("curl", { id: detail.id }).then(
          (result) => {
            setCurlBusy(false);
            copy(result.command);
            const auth = result.auth || { kind: "env", envName: "DSH_CURL_KEY" };
            if (auth.kind === "value") {
              setCurlNotice("\u5DF2\u590D\u5236\uFF0C\u542B\u89E3\u6790\u5230\u7684\u771F\u5B9E\u5BC6\u94A5\u2014\u2014\u5B83\u73B0\u5728\u5728\u4F60\u7684\u526A\u8D34\u677F\u91CC\uFF0C\u5C0F\u5FC3\u5386\u53F2\u8BB0\u5F55/\u5171\u4EAB\u5C4F\u5E55\u3002");
            } else {
              setCurlNotice("\u5DF2\u590D\u5236\uFF0Cauthorization \u5F15\u7528\u4E86 $" + auth.envName + "\uFF1B\u5148 export " + auth.envName + "=\u4F60\u7684\u5BC6\u94A5\uFF0C\u518D\u8FD0\u884C\u5C31\u4E0D\u7528\u6539\u547D\u4EE4\u4E86\u3002");
            }
          },
          (reason) => {
            setCurlBusy(false);
            setCurlNotice("\u751F\u6210\u5931\u8D25\uFF1A" + String(reason && reason.message || reason));
          }
        );
      };
      const isOpen = React.useCallback((path, lineDepth) => {
        const override = overrides.get(path);
        if (override !== void 0) return override;
        return lineDepth < depth;
      }, [overrides, depth]);
      const toggle = React.useCallback((path, lineDepth) => {
        setOverrides((current) => {
          const next = new Map(current);
          const shown = current.has(path) ? current.get(path) : lineDepth < depth;
          next.set(path, !shown);
          return next;
        });
      }, [depth]);
      const toggleLong = React.useCallback((path) => {
        setLongOpen((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      }, []);
      const isSse = detail !== null && detail.response !== null && detail.response.contentType !== null && detail.response.contentType.includes("event-stream");
      const requestParsed = detail !== null && detail.request.bodyJson !== null;
      const requestBody = detail === null ? null : requestParsed ? detail.request.bodyJson : { __raw__: detail.request.bodyText };
      const responseBody = React.useMemo(() => {
        if (detail === null || detail.response === null) return null;
        if (isSse && sseMerged) return mergeSseChunks(parseSseFrames(detail.response.bodyText));
        if (isSse) return parseSseFrames(detail.response.bodyText);
        if (detail.response.bodyJson !== null) return detail.response.bodyJson;
        return { __raw__: detail.response.bodyText };
      }, [detail, isSse, sseMerged]);
      const treeValue = tab === "request" ? requestBody : responseBody;
      const shownBody = detail === null ? null : tab === "request" ? detail.request : detail.response;
      const bodyTruncated = shownBody !== null && shownBody !== void 0 && shownBody.bodyTruncated === true;
      const rawFallback = treeValue !== null && typeof treeValue === "object" && !Array.isArray(treeValue) && Object.keys(treeValue).length === 1 && Object.prototype.hasOwnProperty.call(treeValue, "__raw__");
      const bodyNotice = !rawFallback ? null : bodyTruncated ? "\u539F\u59CB\u5185\u5BB9\u5171 " + fmtCount(shownBody.bodyChars) + " \u4E2A\u5B57\u7B26\uFF0C\u8D85\u51FA\u4E0A\u9650\uFF0C\u53EA\u4FDD\u7559\u4E86\u524D " + fmtCount((shownBody.bodyText || "").length) + " \u4E2A\u5B57\u7B26\u3002\u88AB\u622A\u65AD\u7684 JSON \u65E0\u6CD5\u89E3\u6790\uFF0C\u56E0\u6B64\u53EA\u80FD\u6309\u539F\u6587\u663E\u793A\uFF1B\u8C03\u9AD8 maxBodyChars \u53EF\u4EE5\u4FDD\u7559\u66F4\u591A\u3002" : "\u8FD9\u6BB5\u5185\u5BB9\u4E0D\u662F JSON\uFF0C\u6309\u539F\u6587\u663E\u793A\u3002";
      const showRaw = tab === "response" && isSse && !sseMerged;
      const rawText = showRaw ? prettySseText(detail.response.bodyText) : "";
      const text = detail === null ? "" : stringify(tab === "request" ? detail.request : detail.response);
      const contentDepth = React.useMemo(
        () => treeValue === null ? 0 : maxDepthOf(treeValue, 64),
        [treeValue]
      );
      const step = (delta) => {
        const next = Math.max(0, Math.min(contentDepth, depth + delta));
        if (next === depth) return;
        setDepth(next);
        setOverrides(/* @__PURE__ */ new Map());
      };
      const rows = items.map((item) => h(
        "div",
        {
          key: item.id,
          className: "wt-item",
          "data-sel": item.id === selected ? "1" : "0",
          onClick: () => {
            setSelected(item.id);
            setTab("request");
          }
        },
        [
          h("div", { className: "wt-row", key: "r1" }, [
            // The coordinate leads the row: "which call is this" is the first
            // question a reader has, before model or status.
            (() => {
              const badge = stepBadge(item);
              return h("span", { className: "wt-step", "data-k": badge.kind, key: "st", title: badge.title }, badge.text);
            })(),
            h("span", { className: "wt-model", key: "m" }, item.model || item.url),
            h("span", { className: "wt-tag", "data-k": statusKind(item.status), key: "s" }, item.status)
          ]),
          h("div", { className: "wt-sub", key: "r2" }, [
            h("span", { key: "t" }, fmtTime(item.startedAt)),
            h("span", { key: "d" }, fmtDuration(item.durationMs)),
            h("span", { key: "rs" }, item.responseStatus === null ? "HTTP -" : "HTTP " + item.responseStatus),
            h("span", { key: "m2" }, item.method)
          ]),
          h("div", { className: "wt-sub", key: "r3" }, [
            h("span", { key: "req" }, item.requestChars + " req chars"),
            h("span", { key: "res" }, item.responseChars + " resp chars"),
            // Only meaningful while the list mixes sessions; under the filter
            // every row is by definition the current session.
            filtering ? null : h("span", {
              key: "sid",
              title: item.sessionId === null || item.sessionId === void 0 ? "\u8BE5\u8BF7\u6C42\u5728\u7EBF\u8DEF\u4E0A\u6CA1\u6709\u643A\u5E26 session \u6807\u8BB0\u3002" : "session " + item.sessionId
            }, sessionLabel(item.sessionId, currentSessionId))
          ].filter(Boolean))
        ]
      ));
      const groupKeyOf = (item) => {
        if (purposeLabel(item.purpose) !== null) return "aux";
        if (typeof item.turn === "number") return "turn:" + item.turn;
        return "none";
      };
      const groupHeader = (item) => {
        const key = groupKeyOf(item);
        if (key === "aux") return { text: "\u540E\u53F0\u8F85\u52A9\u8C03\u7528", meta: "\u4E0D\u5C5E\u4E8E\u4EFB\u4F55 turn" };
        if (key === "none") return { text: "\u65E0\u5F52\u5C5E\u8C03\u7528", meta: "\u672A\u7ECF\u8FC7 ctx.llm" };
        const stat = turns.find((entry) => entry.turn === item.turn);
        return {
          text: "\u7B2C " + item.turn + " \u8F6E",
          meta: stat === void 0 ? "" : stat.calls + " \u6B21\u8C03\u7528" + (stat.steps > 0 ? " \xB7 " + stat.steps + " step" : "")
        };
      };
      const groupedRows = [];
      let lastGroup = null;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const key = groupKeyOf(item);
        if (key !== lastGroup) {
          const head = groupHeader(item);
          groupedRows.push(h("div", { className: "wt-turn", key: "g:" + key }, [
            h("span", { className: "wt-turn-n", key: "n" }, head.text),
            head.meta === "" ? null : h("span", { className: "wt-turn-meta", key: "m" }, head.meta)
          ].filter(Boolean)));
          lastGroup = key;
        }
        groupedRows.push(rows[i]);
      }
      return h("div", { className: "wt-root" }, [
        h("div", { className: "wt-left", key: "left" }, [
          h("div", { className: "wt-bar", key: "bar" }, [
            h("button", {
              className: "wt-btn",
              key: "auto",
              "data-on": auto ? "1" : "0",
              title: auto ? "\u6BCF 3 \u79D2\u81EA\u52A8\u5237\u65B0\uFF08\u53EA\u8BFB\u5185\u5B58\u4E2D\u7684\u5B9E\u65F6\u8BB0\u5F55\uFF0C\u4E0D\u626B\u63CF\u78C1\u76D8\uFF09\u3002\u70B9\u51FB\u6682\u505C\u3002" : "\u5DF2\u6682\u505C\u5237\u65B0\u3002\u70B9\u51FB\u6062\u590D\u5E76\u7ACB\u5373\u5237\u65B0\u4E00\u6B21\u3002",
              onClick: () => {
                const next = !auto;
                setAuto(next);
                if (next) {
                  setTick((n) => n + 1);
                  setHistoryTick((n) => n + 1);
                }
              }
            }, auto ? "\u81EA\u52A8\u5237\u65B0" : "\u5DF2\u6682\u505C"),
            h("button", {
              className: "wt-btn",
              key: "scope",
              "data-on": filtering ? "1" : "0",
              disabled: currentSessionId === null,
              title: currentSessionId === null ? "\u62FF\u4E0D\u5230\u5F53\u524D session id\uFF0C\u53EA\u80FD\u663E\u793A\u5168\u90E8\u8BB0\u5F55\u3002" : filtering ? "\u5F53\u524D\u53EA\u663E\u793A\u672C session \u7684 provider \u8C03\u7528\u3002\u70B9\u51FB\u67E5\u770B\u5168\u90E8\u8BB0\u5F55\uFF08\u542B\u5176\u4ED6 session \u548C\u65E0 session \u6807\u8BB0\u7684\u8C03\u7528\uFF09\u3002" : "\u5F53\u524D\u663E\u793A\u5168\u90E8\u8BB0\u5F55\u3002\u70B9\u51FB\u53EA\u770B\u672C session\u3002",
              onClick: () => {
                if (currentSessionId === null) return;
                fallbackUsed.current = true;
                setAutoFellBack(false);
                setOnlySession(!onlySession);
              }
            }, filtering ? "\u5F53\u524D Session" : "\u5168\u90E8 Session"),
            h("button", {
              className: "wt-btn",
              key: "clear",
              title: "\u6E05\u7A7A\u5168\u90E8\u8BB0\u5F55\uFF08\u4E0D\u533A\u5206 session\uFF09\uFF0C\u78C1\u76D8\u4E0A\u7684\u5386\u53F2\u8BB0\u5F55\u4E5F\u4F1A\u4E00\u5E76\u5220\u9664\u3002",
              onClick: () => {
                apiPost("clear", {}).then(() => {
                  setSelected(null);
                  setTick((n) => n + 1);
                  setHistoryTick((n) => n + 1);
                }, (reason) => setError(String(reason)));
              }
            }, "\u6E05\u7A7A"),
            h("span", {
              className: "wt-meta",
              key: "meta",
              title: filtering ? "\u672C session \u547D\u4E2D\u6570 / \u5168\u90E8\u8BB0\u5F55\u6570\uFF08\u542B\u78C1\u76D8\uFF09" : "\u5DF2\u52A0\u8F7D / \u5168\u90E8\u8BB0\u5F55\u6570\uFF08\u542B\u78C1\u76D8\uFF09"
            }, (filtering ? matched : items.length) + " / " + total + (turns.length > 0 ? " \xB7 " + turns.length + " turn" : "") + (auxiliary > 0 ? " \xB7 " + auxiliary + " \u8F85\u52A9" : ""))
          ]),
          error === null ? null : h("div", { className: "wt-err", key: "err" }, error),
          h(
            "div",
            { className: "wt-list", key: "list" },
            items.length === 0 ? h("div", { className: "wt-empty" }, filtering ? "\u672C session \u5C1A\u672A\u6355\u83B7\u5230 provider \u8C03\u7528\u3002\u53D1\u4E00\u6761\u6D88\u606F\u540E\u8FD9\u91CC\u4F1A\u51FA\u73B0\u8BB0\u5F55\uFF08\u53EA\u8BB0\u5F55\u5E26 deepseek-harness user-agent \u7684\u8BF7\u6C42\uFF09\u3002" : "\u5C1A\u672A\u6355\u83B7\u5230 provider \u8C03\u7528\u3002\u53D1\u4E00\u6761\u6D88\u606F\u540E\u8FD9\u91CC\u4F1A\u51FA\u73B0\u8BB0\u5F55\uFF08\u53EA\u8BB0\u5F55\u5E26 deepseek-harness user-agent \u7684\u8BF7\u6C42\uFF09\u3002") : [
              ...groupedRows,
              // Live records are already on screen; the disk half is still
              // arriving. Say so, so an incomplete list is never mistaken for
              // the whole history.
              historyLoading ? h("div", { className: "wt-jnotice", key: "#history" }, "\u6B63\u5728\u540E\u53F0\u8F7D\u5165\u78C1\u76D8\u5386\u53F2\u8BB0\u5F55\u2026") : null,
              // The provider never stamped a session id, so the default
              // filter was dropped. Explain it where it was noticed.
              autoFellBack ? h(
                "div",
                { className: "wt-jnotice", key: "#fallback" },
                "\u672C session \u6CA1\u6709\u53EF\u5F52\u5C5E\u7684\u8BB0\u5F55\uFF08\u8FD9\u4E9B\u8C03\u7528\u6CA1\u6709\u7ECF\u8FC7 ctx.llm\uFF0C\u4F8B\u5982\u63D2\u4EF6\u91CD\u8F7D\u524D\u5C31\u5DF2\u7ECF\u53D1\u51FA\u7684\u8BF7\u6C42\uFF09\uFF0C\u5DF2\u81EA\u52A8\u663E\u793A\u5168\u90E8\u8BB0\u5F55\u3002"
              ) : null,
              // Records with no session identity are hidden by the filter,
              // but never silently: say how many, and where to see them.
              filtering && unattributed > 0 ? h(
                "div",
                { className: "wt-jnotice", key: "#unattributed" },
                "\u53E6\u6709 " + fmtCount(unattributed) + " \u6761\u65E0\u5F52\u5C5E\u8BB0\u5F55\uFF08\u6CA1\u6709\u7ECF\u8FC7 ctx.llm \u7684\u8BF7\u6C42\uFF09\uFF0C\u70B9\u51FB\u300C\u5168\u90E8 Session\u300D\u67E5\u770B\u3002"
              ) : null,
              // Say so rather than implying the page showed everything: a
              // filtered history read stops at a bounded scan budget.
              truncated ? h(
                "div",
                { className: "wt-jnotice", key: "#truncated" },
                "\u78C1\u76D8\u4E0A\u8FD8\u6709\u66F4\u65E9\u7684\u8BB0\u5F55\u672A\u88AB\u626B\u63CF\uFF08\u5355\u6B21\u67E5\u8BE2\u6709\u8BFB\u53D6\u4E0A\u9650\uFF09\u3002"
              ) : null
            ].filter(Boolean)
          )
        ].filter(Boolean)),
        h("div", { className: "wt-right", key: "right" }, [
          h("div", { className: "wt-tabs", key: "tabs" }, [
            h("button", { className: "wt-btn", key: "req", "data-on": tab === "request" ? "1" : "0", onClick: () => setTab("request") }, "Request"),
            h("button", { className: "wt-btn", key: "res", "data-on": tab === "response" ? "1" : "0", onClick: () => setTab("response") }, "Response"),
            h("span", { className: "wt-div", key: "div" }),
            isSse && tab === "response" ? h("button", {
              className: "wt-btn",
              key: "sse",
              "data-on": sseMerged ? "1" : "0",
              title: sseMerged ? "\u5F53\u524D\u628A\u5206\u6563\u7684 delta \u589E\u91CF\u5408\u5E76\u6210\u5B8C\u6574\u5185\u5BB9\uFF0C\u4ECD\u6309 JSON \u6811\u5C55\u793A\u3002\u70B9\u51FB\u67E5\u770B\u7EBF\u8DEF\u4E0A\u7684\u539F\u59CB SSE \u6587\u672C\u3002" : "\u5F53\u524D\u663E\u793A\u7EBF\u8DEF\u4E0A\u7684\u539F\u59CB SSE \u6587\u672C\uFF08\u672A\u5408\u5E76\uFF09\u3002\u70B9\u51FB\u5207\u56DE\u5408\u5E76\u540E\u7684\u5B8C\u6574\u5185\u5BB9\u3002",
              onClick: () => setSseMerged(!sseMerged)
            }, sseMerged ? "\u4F18\u5316\u5C55\u793A" : "\u539F\u59CB SSE") : null,
            h("button", {
              className: "wt-btn wt-btn-step",
              key: "less",
              title: "\u6574\u4F53\u6298\u53E0\u4E00\u5C42",
              onClick: () => step(-1),
              disabled: detail === null || showRaw || depth <= 0
            }, "\u2212"),
            h("button", {
              className: "wt-btn wt-btn-step",
              key: "more",
              title: "\u6574\u4F53\u5C55\u5F00\u4E00\u5C42",
              onClick: () => step(1),
              disabled: detail === null || showRaw || depth >= contentDepth
            }, "+"),
            h("span", { className: "wt-meta", key: "depth" }, showRaw || detail === null ? "" : "\u6DF1\u5EA6 " + depth + "/" + contentDepth),
            h("span", { className: "wt-meta", key: "sp" }, detail === null ? "" : detail.id + " \xB7 " + detail.request.method + " " + detail.request.url),
            h("button", {
              className: "wt-btn",
              key: "curl",
              disabled: detail === null || curlBusy,
              title: "\u751F\u6210\u4E00\u6761\u53EF\u4EE5\u76F4\u63A5\u5728\u547D\u4EE4\u884C\u91CC\u8DD1\u7684 curl \u547D\u4EE4\u5E76\u590D\u5236\u5230\u526A\u8D34\u677F\u3002authorization \u4F1A\u5C1D\u8BD5\u8865\u4E0A\u771F\u5B9E\u5BC6\u94A5\uFF0C\u8865\u4E0D\u5230\u5C31\u7559\u5360\u4F4D\u7B26\u3002",
              onClick: copyCurl
            }, curlBusy ? "\u751F\u6210\u4E2D\u2026" : "\u590D\u5236 curl"),
            h("button", { className: "wt-btn", key: "copy", onClick: () => copy(showRaw ? rawText : text) }, "\u590D\u5236"),
            h("button", { className: "wt-btn", key: "dl", onClick: () => {
              if (detail !== null) download("llm-wire-trace-" + detail.id + ".json", stringify(detail));
            } }, "\u4E0B\u8F7D")
          ].filter(Boolean)),
          // Always-visible coordinate strip for the selected record: the
          // harness facts that the wire bytes below can never tell you.
          detail === null ? null : (() => {
            const badge = stepBadge(detail);
            const aux = purposeLabel(detail.purpose);
            const coord = (label, value, title) => h("span", { className: "wt-coord", key: label, title }, [
              h("span", { key: "l" }, label),
              h("b", { key: "v" }, value)
            ]);
            const parts = [];
            if (aux !== null) {
              parts.push(coord("\u7528\u9014", aux, "\u540E\u53F0\u8F85\u52A9\u8C03\u7528\uFF0C\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u4E00\u6B21\u5BF9\u8BDD turn\u3002"));
            } else if (typeof detail.turn === "number") {
              parts.push(coord("Turn", String(detail.turn), "\u7B2C\u51E0\u8F6E\u5BF9\u8BDD\u3002"));
              parts.push(h("span", { className: "wt-coord-sep", key: "s1" }));
              parts.push(coord("Step", detail.step === null ? "\u2014" : String(detail.step), "\u4E00\u4E2A step = \u4E00\u6B21\u6A21\u578B\u8C03\u7528\u3002"));
            } else {
              parts.push(coord("\u5F52\u5C5E", badge.text, badge.title));
            }
            if (detail.provider !== null && detail.provider !== void 0) {
              parts.push(h("span", { className: "wt-coord-sep", key: "s2" }));
              parts.push(coord("Provider", String(detail.provider), "\u89E3\u6790\u5230\u7684 provider \u8DEF\u7531\u3002"));
            }
            if (detail.sessionId) {
              parts.push(h("span", { className: "wt-coord-sep", key: "s3" }));
              parts.push(coord("Session", shortSessionId(detail.sessionId), "\u5B8C\u6574 session id\uFF1A" + detail.sessionId));
            }
            return h("div", { className: "wt-coords", key: "coords" }, parts);
          })(),
          curlNotice === null ? null : h("div", { className: "wt-jnotice", key: "curl-notice", style: { padding: "4px 12px" } }, curlNotice),
          detail === null ? h("div", { className: "wt-empty", key: "empty" }, "\u5728\u5DE6\u4FA7\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u67E5\u770B\u5B8C\u6574\u8BF7\u6C42/\u54CD\u5E94\u3002") : tab === "response" && detail.response === null ? h("div", { className: "wt-empty", key: "pending" }, "\u54CD\u5E94\u5C1A\u672A\u5230\u8FBE\uFF08\u8FDE\u63A5\u5931\u8D25\u6216\u4ECD\u5728\u7B49\u5F85\uFF09\u3002") : showRaw ? h("pre", { className: "wt-sse", key: "raw" }, rawText) : h(React.Fragment, { key: "json" }, [
            // Say why the structure is missing, rather than leaving a bare
            // `__raw__` key for the reader to decipher.
            bodyNotice === null ? null : h("div", { className: "wt-jnotice", key: "notice", style: { padding: "4px 12px" } }, bodyNotice),
            // Non-JSON content is shown as text. Wrapping it in a
            // synthetic `__raw__` object only dressed it up as JSON it is
            // not, and buried it one expand deep.
            rawFallback ? h("pre", { className: "wt-sse", key: "text" }, treeValue.__raw__ || "") : h(JsonView, {
              key: "tree",
              value: treeValue,
              isOpen,
              longOpen,
              onToggle: toggle,
              onToggleLong: toggleLong
            })
          ].filter(Boolean))
        ])
      ]);
    };
  }

  // src/client/entry.ts
  window.__ModuleLoader__.load({
    id: "dsh-llm-trace-plugin",
    factory: (require2) => {
      const module = { exports: {} };
      const React = require2("react");
      const inject = ["slots", "timer"];
      function apply(ctx) {
        ctx.effect(() => insertStyles(), "llm-wire-trace: stylesheet");
        const WireTraceView = createWireTraceView(React, ctx);
        ctx.slots.inject(
          "conversation.view",
          () => ctx.slots.register({
            name: "conversation.view",
            id: "wire-trace",
            priority: 100,
            order: 110,
            label: () => "Wire Trace"
          }, WireTraceView)
        );
      }
      module.exports.apply = apply;
      module.exports.inject = inject;
      return module.exports;
    }
  });
})();
