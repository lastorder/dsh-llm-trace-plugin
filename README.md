# dsh-llm-trace-plugin

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that captures the **literal HTTP request and response** of every LLM provider call — the exact bytes on the wire, provider-native field names, raw SSE frames — and lets you browse them in a **Wire Trace** session tab.

This works at the *wire* layer. A harness-level tracer observes the normalized `GenerateOptions` / `StreamChunk` objects the harness builds: provider-neutral, aware of `sessionId` / `turn` / `step`. This plugin has no harness concepts at all — it only sees what actually left the process and what actually came back.

## Install

**npm is the supported install path.** The published package ships a prebuilt `dist/` (compiled by `pnpm run build` at publish time), so this works with no local toolchain:

```sh
dsh plugin --profile web add dsh-llm-trace-plugin
```

Pin an exact version:

```sh
dsh plugin --profile web add dsh-llm-trace-plugin@0.2.0
```

Then update or remove it by **package name**:

```sh
dsh plugin --profile web update dsh-llm-trace-plugin
dsh plugin --profile web remove dsh-llm-trace-plugin
```

### Installing from a source checkout (git or `link:`)

The repository ships TypeScript source, **not** a committed `dist/` — a git-spec install or a local `link:` checkout gets only source, and this plugin declares no `prepare` script, so nothing builds it for you automatically. (That is deliberate: a `prepare` script on a git dependency requires an explicit `allowBuilds` approval from pnpm ≥10 before it may run, i.e. "permission to execute this package's code on your machine at install time" — worth avoiding for a plugin most users install from npm.) Build once yourself, from the checkout, before installing:

```sh
cd /path/to/dsh-llm-trace-plugin
pnpm install
pnpm run build      # produces dist/host/** and dist/client.js
```

Then install the checkout the same way as any local plugin:

```sh
dsh plugin --profile web add link:/path/to/dsh-llm-trace-plugin
# or, from a git remote pinned to a branch/tag/commit:
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v0.2.0
```

A git-spec install still fetches source only — rebuild (`pnpm run build`) after every `update` that pulls in new commits, since nothing runs it for you.

Notes:

- `dsh plugin` forwards to pnpm and then reconciles `dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json` from the *installed* state, so a git spec registers under this package's real name, `dsh-llm-trace-plugin`.
- **Restart `dsh web` after installing.** An installed package is not a dev checkout, so there is no client-plugin HMR watcher.
- The package name changed from `dsh-llm-wire-trace-plugin` to `dsh-llm-trace-plugin`. If you installed it under the old name, remove that first: `dsh plugin --profile web remove dsh-llm-wire-trace-plugin`.

## Configuration

The host row lives in [`cordis.patch.yml`](cordis.patch.yml) and takes these optional keys:

| Key | Default | Meaning |
|---|---|---|
| `maxRecords` | `200` | In-memory ring size; only the most recent N records are held live. Bodies are held in memory too, so lower this if you routinely send very large requests. |
| `maxBodyChars` | `8000000` | Per-field character cap before a body is truncated. Sized to hold a full 1M-token context (~4M characters) with 2x headroom; a body cut mid-JSON cannot be parsed, so the viewer can only show it as text. |
| `persist` | `true` | Write records to disk so they survive a restart. Set `false` for memory only. |
| `traceDir` | `$DSH_HOME/llm-wire-trace/records` | Where record files are stored. |
| `maxPersistedRecords` | `300` | Retained record files; the oldest are deleted past this. |
| `historyPageLimit` | `50` | Max record files read to build one list page from disk. |
| `prettyBodyLimit` | `500000` | Above this size, the readability copy of a body is not written to disk. |

```yaml
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      config:
        maxRecords: 500
        maxBodyChars: 2000000
        maxPersistedRecords: 5000
```

## Persistence

The in-memory ring dies with the process, which is backwards for a debugging tool: the traces you most want are the ones from the run that just crashed. So records are also written to disk.

**There is no "live vs history" mode to choose.** The list always merges both: memory supplies liveness (in-flight `streaming` calls, which have no final file yet), disk supplies depth (everything older than the small ring, and everything from before the last restart). Records near the head exist in both, so they are keyed by id and the in-memory copy wins — it is the same record, but the one still being mutated as its body streams in. Where a record happens to be stored is an implementation detail, and the viewer deliberately does not expose it.

### One file per record, and why

Every record is a single self-contained JSON file, written once and never rewritten:

```
$DSH_HOME/llm-wire-trace/records/<startedAt-ms>-<intra-ms ordinal>-<random>.json
```

That one choice removes concurrency control entirely. The obvious alternative — one appended JSONL file — is safe for the *appends* (line-sized writes land intact) but **not** for the periodic rewrite that enforces the retention cap: two harness processes compacting one file can drop each other's records. With a file per record there is nothing to compact:

- **Writing** is `write temp` + `rename`, atomic on POSIX. A reader sees a complete file or no file, never a half-written one.
- **Retention** is `unlink` of the oldest names. Two processes racing to delete the same file is harmless — the loser gets `ENOENT`, ignored. No lock, no per-process files, no merge-on-read.
- **A hard kill** leaves at worst an orphan `.tmp` file, swept at next start. There is no truncated trailing line to detect and skip, and a torn file is skipped rather than failing the whole load.

Verified by four processes writing 600 records into one directory concurrently with retention sweeps racing throughout: zero corrupt files, zero id collisions, zero temp leftovers, and the cap landed exactly.

The filename carries the timestamp so ordering and retention are pure **name** operations — listing the newest page is a `readdir` + sort + slice that opens no files. Only records actually shown get read.

> The record id doubles as the filename, so it is a sortable string rather than the old per-process counter (`w1`, `w2`, …). A counter would make two harness processes collide on the same filename and silently overwrite each other's records — reintroducing as data loss the very problem this layout removes.
>
> The millisecond alone is not a sufficient key: a burst can start many calls inside one millisecond, and a purely random suffix would then order them **arbitrarily** — losing real ordering exactly when calls are densest (observed, and fixed, during testing). The intra-ms ordinal restores order within a millisecond; the random tail keeps names unique across processes, which a counter alone cannot do. Files written before the ordinal existed are still read, so upgrading keeps your existing history.

### Readable on disk

Files are written indented, and each body is stored twice: the verbatim `bodyText` from the wire, plus a parsed `bodyJson` beside it. `bodyText` alone is a JSON *string*, so on disk it is one long escaped line (`\"role\":\"user\"`) that no editor renders usefully — the parsed copy lets `messages`, tool definitions, and the response object expand as real nested JSON.

`bodyJson` is a derived convenience copy, never the source of truth: reading always re-derives it from `bodyText`, so a stale or hand-edited parse on disk cannot change what the viewer shows. It is omitted where it would add nothing — a truncated body, a non-container value, or an SSE response (a frame sequence, never one JSON value, matching the capture-time rule). The cost is roughly double the body bytes.

> **Upgrading from 0.1.2.** That release capped bodies at 200k characters, which a real agent request exceeds, so it stored them cut mid-JSON — the viewer could only show such a body as raw text. Records already written that way stay truncated (the missing bytes were never captured); calls made after upgrading are stored whole.

### Disk footprint

Bodies are sized for a 1M-token context, so a record can be large. Two things keep the directory bounded: the 300-record cap, and `prettyBodyLimit` — past 500k characters the parsed readability copy is skipped, since no editor renders a multi-megabyte body usefully anyway and writing it would double the bytes for nothing. The viewer is unaffected either way: it re-parses from `bodyText`.

In practice a typical request (a few hundred thousand characters) lands around 250MB across 300 records. The worst case — 300 consecutive full 1M-token requests — is roughly 1.3GB. Lower `maxPersistedRecords`, `maxBodyChars`, or both if that matters on your machine.

### The cost, stated plainly

There is no index, so building a history page costs one file read per record *on that page* (bounded by `historyPageLimit`), not per record retained. Those reads run in concurrent batches and yield to the event loop between batches, because this plugin's routes share a process — and so an event loop — with the harness's own web UI. A list read parses only the fields a row displays and never touches body text, which is the bulk of a record. A filtered history scan stops at a bounded budget and the viewer says so rather than implying it showed everything.

This is the deliberate trade: a bounded per-page cost in exchange for never reintroducing shared mutable state.

### Startup

Nothing is preloaded into the ring on `apply`: the list already merges memory and disk, so a restart opens on the recent past regardless. (Preloading was in fact what made an earlier live/history toggle show identical content in both modes — the ring had been filled with the very history the other mode read.)

The Wire Trace tab is mounted only while it is the active tab, so an unopened tab reads nothing at all. Opening it paints the live in-memory ring first and folds the on-disk history in behind that, saying so while the history is still in flight. Auto-refresh then polls the ring only, so watching a live session never re-scans the disk.

Capture starts immediately, and a slow or failing disk cannot delay the fetch patch or fail a request. Persistence errors are counted and reported via `GET /llm-wire-trace/stats`, never thrown into the capture path.

### Privacy: bodies are stored verbatim

Credential headers are redacted on disk exactly as in memory — `authorization`, `proxy-authorization`, `x-api-key` (Anthropic), `api-key` (Azure OpenAI), `x-goog-api-key` (Google), `cookie`, and `set-cookie`. **Request and response bodies are not** — they are stored as captured, so your prompts, code, and any file contents in context land in plaintext files under `traceDir`. That is inherent to persisting full bodies, and is a deliberate choice for a local debugging tool. The levers are `persist: false`, a smaller `maxPersistedRecords`, or a lower `maxBodyChars`.

Clearing from the viewer deletes the persisted copies too — otherwise "clear" would visibly un-clear itself on the next restart.

## Why this must be an installed package, not a dynamic Cordis plugin

A dynamic Cordis Host package's code runs inside an isolated `node:vm` realm. That realm's `globalThis` is **not** the process's real `globalThis`, and its `fetch` is hard-wired to a trap that throws, redirecting authors to `ctx.web` — by design, a dynamic package cannot reach, let alone replace, the real `fetch` that `@deepseek-ai/dsh-llm-deepseek` and `@deepseek-ai/dsh-llm-pi-ai` resolve at call time. Only code loaded as an ordinary module in the real process — an installed package, like this one — shares that real `globalThis`.

## How it works

1. On `apply`, replace `globalThis.fetch` with a wrapper, keeping the original reference. `ctx.effect` ties the disposer (which restores the original reference) to the plugin's fiber, so a stop, uninstall, or failed reactivation cannot leave a dangling patched `fetch`.
2. Every call is inspected for an outgoing `user-agent` header starting with `deepseek-harness/` — the value `attributionHeaders()` stamps on *every* provider request regardless of which adapter sends it (see `@deepseek-ai/dsh-llm`'s `APP_IDENTITY`). Anything else (the `web_fetch` tool, `web_search`, MCP transports, …) passes through completely untouched: not recorded, not cloned, same arguments, same return value.
3. For a matched call, the real `fetch` runs first. The **original, unread** `response` goes back to the adapter exactly as it would have otherwise — its SSE parsing, timing, and error handling are completely unaffected.
4. A `response.clone()` is mirrored in the background (never `await`-ed on the hot path) to capture the response body without disturbing the original stream the adapter is reading.

Both shipped adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) call the bare `fetch` identifier with no local import, so they resolve whatever `globalThis.fetch` is at call time — which is exactly what makes this patch effective regardless of module load order.

## Safety properties

The wrapper is written to hold these properties:

- A non-provider call passes straight through: not recorded, not cloned, body fully intact for its own caller.
- A provider call's caller still reads the complete, unmodified response body — the mirror never contends with it.
- A transport failure (the underlying `fetch` throws) is recorded and **rethrown unchanged** — never swallowed.
- Every credential header is redacted before it is stored or displayed: `authorization` and `proxy-authorization` become `Bearer ***redacted***`, while bare-key headers (`x-api-key`, `api-key`, `x-goog-api-key`, `cookie`, `set-cookie`) become `***redacted***` with no invented scheme. No other header is touched.
- The destructive `clear` route is `POST`-only and rejects a cross-origin request (`Sec-Fetch-Site`), so a page open elsewhere in your browser cannot wipe your trace history.
- Re-activating the plugin cannot double-wrap an already-patched `fetch` (it throws loudly instead); stopping restores the exact original reference.

## What it captures

Each record:

```
{
  id,                            // '<ms>-<ordinal>-<random>'; doubles as the storage filename
  startedAt, endedAt, durationMs,
  status: 'ok' | 'http-error' | 'transport-error' | 'streaming',
  model,                          // best-effort, read from the parsed request body
  sessionId,                      // owning session, or null when unattributable
  turn, step,                     // harness coordinates; null when not applicable
  purpose,                        // 'session-title' | 'compaction' | null
  provider, requestedModel,       // resolved harness route
  attributed,                     // whether this call came through ctx.llm at all
  request:  { method, url, headers /* redacted */, bodyText, bodyJson, bodyTruncated },
  response: { status, statusText, headers, contentType, bodyText, bodyJson, bodyTruncated } | null,
  error: { name, message } | null,
}
```

- `bodyText` is always the raw string (SSE frames verbatim, or a JSON error body). `bodyJson` is a best-effort parse for the JSON view; SSE bodies are never JSON-parsed as a whole (they're a frame sequence, not one JSON value).
- `sessionId` / `turn` / `step` / `purpose` are **not read off the wire** — the wire barely carries them. They are attached by observing two harness channels; see [Harness coordinates](#harness-coordinates-turn--step).
- Body fields are capped and the ring buffer holds only the most recent records; both are configurable (see [Configuration](#configuration)). Records also outlive the process on disk — see [Persistence](#persistence).

## The viewer

A `jq`-shaped JSON view: the brackets, commas, and indentation `jq .` would print, syntax-coloured from the product's own shiki palette so it tracks the light/dark theme for free. Keys, strings, numbers, booleans, and `null` each get their own colour. Unlike preformatted text, every line is a real row, so containers stay foldable.

Folding works two ways, and they compose:

- **A global depth stepper** (`−` / `+` in the toolbar) opens or closes the whole document one level at a time, with the current level shown beside it as `深度 2/5`. `+` stops once the deepest nesting present is reached.
- **A per-row `+` / `-`** in the gutter folds one individual container, for when you want a single branch open without expanding its whole level.

Using the global stepper resets the baseline and clears any per-row folds, so the depth readout always describes what you actually see.

A folded container collapses to a one-line placeholder that keeps its trailing comma, e.g. `"messages": [ … 12 items ],`. Fully expanded, the view is valid JSON: it round-trips through `JSON.parse` to exactly the captured value.

Two tabs, Request and Response. Request always shows the parsed body. Response adapts to the content type: a JSON body is shown as-is, and an `event-stream` body is, by default, *reassembled* — its scattered delta fragments merged back into one complete, readable structure — and shown through the same JSON view (see below).

> The in-app button labels are currently Chinese; the English names below are given alongside them.

### Harness coordinates (turn / step)

The wire tells you *what bytes were sent*. It does not tell you **which turn of the conversation this was, which step within that turn, or whether the user ever asked for this call at all**. Those are the questions a reader actually has, and almost none of that reaches the wire: `dsh-llm-deepseek` sends only a session-id header, and `dsh-llm-pi-ai` sends nothing.

So this plugin *attaches* them, using two ordinary, public plugin extension points. **No dsh source is modified.** Both channels are strictly observational.

**1. `llm/stream` — which call is this?**
A waterfall around every model call, whose `options` carry `sessionId`, `provider`, `model`, and `purpose`. The listener pulls the wrapped stream inside an `AsyncLocalStorage.run` **on every pull**, so the adapter's `fetch` observes exactly its own call's identity. It yields the chunks it receives, in order, and changes nothing else.

> Wrapping only the *construction* of the stream would capture nothing: an async generator's body runs on the consumer's tick, so the context would already be gone by the time the adapter's `fetch` ran. This is verified behaviour, not an assumption.

**2. `session/event` — which turn and step?**
The loop appends `step/start` immediately *before* a model call and `step/end` immediately *after* it, so the step open when a call begins is that call's step. Between steps the plugin reports `null` rather than the step that just closed.

### Why this is exact, not a guess

Each call rides its own async-context branch, so **concurrent calls never contaminate each other** — including the case that defeats naive time-window correlation: a background `session-title` request firing on the *same session* while a turn is live. A purposed call (`session-title`, `compaction`) is deliberately given **no turn/step at all**, because it is not part of the conversation loop even when it overlaps one.

A call that never went through `ctx.llm` is recorded with `attributed: false` and null coordinates — reported as unattributed, never given a plausible-looking owner.

### What you see

- Each row leads with its coordinate: `T1·S0`, or a purpose label (后台辅助调用), or 无归属.
- Rows are grouped under sticky per-turn headers showing that turn's call and step counts.
- The selected record shows a coordinate strip (Turn / Step / Provider / Session) above the body.
- The toolbar summarises `… · N turn · N 辅助`.

### Requirements

Needs the `sessions` and `llm` services. Both are optional: without them capture still works, just without coordinates.

## Filtering by session

The tab opens showing only the current session's calls. A toolbar button switches between **当前 Session** (current session) and **全部 Session** (all records).

The filter matches the record's `sessionId`, which comes from the `llm/stream` context described above (falling back to the `x-deepseek-harness-session-id` header when a call did not go through `ctx.llm`). Because the primary source is the harness call itself rather than the wire, **this works for every provider, including pi-ai routes that put nothing on the wire at all.** Filtering happens on the host side, so other sessions' request and response bodies are never sent to the browser.

Two consequences worth knowing:

- **Not every call is attributable.** A request that never went through `ctx.llm` has no session. Those records are hidden under the filter, but never silently: the list footer reports how many exist and points at **全部 Session**. There, each row is tagged 本 session / session `<id prefix>` / 无 session.
- **Subagents are separate sessions.** A subagent's LLM calls carry its own session id, so they do not appear in the parent session's filtered view. Switch to **全部 Session** to see them.

**清空** (Clear) is unaffected by the filter — it always empties the whole store.

As a safety net, if the first load finds nothing attributable to this session while unattributed records exist, the tab falls back to **全部 Session** and says why. This fires at most once, and touching the toggle yourself disables it.

### Response: merged SSE, and the raw wire text underneath

A raw SSE stream is close to unreadable directly: one reply is typically split across dozens to hundreds of frames, each carrying only a character or two of text. So by default this plugin *reassembles* an `event-stream` response before showing it — folding every delta fragment back into **the exact shape that provider's own non-streamed response would have had**, then rendering that structure through the exact same JSON tree Request uses (same folding, same copy/download). Reusing the official shape is deliberate: a reader who already knows what a normal Anthropic or OpenAI response looks like needs no new vocabulary to read the merged result.

One small adapter module per provider shape (`sse-merge/anthropic.ts`, `sse-merge/openai-responses.ts`, `sse-merge/openai-chat-completions.ts`) is offered every frame in turn; whichever one recognizes a frame's shape folds it in. Adding a fourth provider shape means adding one more adapter file — nothing else changes. Three shapes are recognized today, auto-detected per frame so a stream never has to be told which provider it came from:

**OpenAI/DeepSeek Chat Completions** (an object with a top-level `choices` array) reassembles into `chatCompletion`, shaped like the SDK's own `ChatCompletion`:

```json
{
  "anthropic": null,
  "responses": null,
  "chatCompletion": {
    "id": "chatcmpl-...",
    "object": "chat.completion",
    "model": "deepseek-...",
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "the complete reply text, concatenated from every delta.content fragment",
          "reasoning_content": "the complete reasoning text, if the provider sent one (DeepSeek's own extension)",
          "tool_calls": [
            { "id": "call_1", "type": "function", "function": { "name": "search", "arguments": "{\"q\":\"...\"}" }, "argumentsJson": { "q": "..." } }
          ]
        },
        "finish_reason": "stop"
      }
    ],
    "usage": { }
  },
  "frameCount": 137,
  "recognizedFrameCount": 135,
  "sawDone": true,
  "unrecognized": []
}
```

Content and reasoning-content fragments are concatenated in wire order; a tool call's fragmented `function.arguments` is concatenated the same way and then parsed once as a whole into the (non-standard, but almost always what a reader wants next) `argumentsJson` convenience field — never a per-fragment partial parse.

**Anthropic Messages API** (framed by `event:` type — `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`) reassembles into `anthropic`, shaped like a non-streamed `POST /v1/messages` response:

```json
{
  "anthropic": {
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "model": "claude-...",
    "content": [
      { "type": "text", "text": "the complete reply text, concatenated from every text_delta fragment" },
      { "type": "thinking", "thinking": "the complete extended-thinking text, if the model used it", "signature": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "bash", "input": { "command": "..." }, "inputJsonText": "{\"command\":\"...\"}" }
    ],
    "stop_reason": "tool_use",
    "stop_sequence": null,
    "usage": { }
  },
  "responses": null,
  "chatCompletion": null,
  "frameCount": 19,
  "recognizedFrameCount": 17,
  "sawDone": true,
  "unrecognized": []
}
```

Each content block's `text` / `thinking` / `partial_json` fragments are concatenated in wire order, addressed by the block's own index; a `tool_use` block's fragmented `partial_json` is parsed once, as a whole, into `input` (the official field), with the raw accumulated text kept alongside as `inputJsonText` for when parsing fails. `message_start`'s top-level fields (id, model, role, usage, …) are captured, and anything `message_delta` adds (including provider-specific extras) is folded in alongside them — so a real record's `copilot_usage` or similar extension still shows up, just as an extra field beside the official ones.

**OpenAI Responses API** (also framed by `event:` type, but a different set of names — `response.created` / `response.output_item.added` / `response.output_text.delta` / `response.function_call_arguments.delta` / `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` / … / `response.completed`) reassembles into `responses`, shaped like a non-streamed `POST /v1/responses` response:

```json
{
  "anthropic": null,
  "responses": {
    "id": "resp_...",
    "object": "response",
    "model": "gpt-5...",
    "status": "completed",
    "output": [
      { "type": "reasoning", "id": "rs_...", "summary": [ { "type": "summary_text", "text": "..." } ], "content": null },
      { "type": "message", "id": "msg_...", "role": "assistant", "content": [ { "type": "output_text", "text": "the complete reply text" } ] },
      { "type": "function_call", "id": "fc_...", "call_id": "call_...", "name": "search", "arguments": "{\"q\":\"...\"}", "argumentsJson": { "q": "..." } }
    ],
    "usage": { }
  },
  "chatCompletion": null,
  "frameCount": 11,
  "recognizedFrameCount": 11,
  "sawDone": true,
  "unrecognized": []
}
```

Each output item is addressed by its own `output_index` and reassembled into the matching official item shape (`message` / `reasoning` / `function_call`). A `reasoning` item's `summary[]` (from `response.reasoning_summary_text.delta`) and `content[]` (from `response.reasoning_text.delta`) are two independent, official fields — which one actually fills in depends on model/account, and only the one the provider actually sent is populated; the other stays `null`/`[]` rather than being invented. A `function_call`'s `arguments` is concatenated in wire order and parsed once, as a whole, into the `argumentsJson` convenience field; `response.output_item.done` additionally supplies a fallback whole-value read for any field this plugin's delta handling might have missed, so a call still comes through complete either way.

Nothing recognizable is guessed at: a frame that fits none of these three shapes — an error event, an unrecognized `event:` type, the `[DONE]` sentinel, an unparseable payload — is never forced into any of them, and lands verbatim in `unrecognized` instead, so nothing this plugin doesn't understand is ever silently dropped.

A toggle (`原始 SSE` / `优化展示`) switches to the literal frame sequence on the wire — one object per SSE frame, keyed by its own SSE field names, exactly as captured — for when the raw bytes themselves are what you need:

```json
[
  { "comment": "keep-alive" },
  { "data": { "id": "chatcmpl-1", "choices": [ ] } },
  { "event": "message", "id": "42", "data": { } },
  { "data": "[DONE]" }
]
```

`data:` holds the parsed JSON when the payload is parseable and the raw string otherwise, so sentinels like `[DONE]` stay visible rather than being dropped; `event:` / `id:` / `retry:` sit alongside it, and comment lines (`: keep-alive`) become `comment`. Repeated `data:` lines within one frame are joined with newlines first, as the SSE spec requires. Nothing is discarded — a malformed payload is kept verbatim as a string. Only each frame's `data:` payload is re-indented there; frame structure is left completely untouched.

### Copy as curl

The copy-curl button (`复制 curl`) asks the host for a ready-to-run `curl` command reconstructed from the record (`GET /llm-wire-trace/curl?id=`) and copies it. Every argument is single-quoted with the standard POSIX `'\''` escape, so the command is safe to paste into bash/zsh/sh as-is, including bodies containing quotes, `$(...)`, and backticks.

Whichever credential header the record carried is always the redacted placeholder — this plugin never keeps a real secret at rest — so that header is rebuilt fresh for the curl command, one of two ways:

- **A real value was resolved**, checked in this order:
  1. `DSH_CURL_KEY` in the process environment — a manual, plugin-owned, provider-neutral override that works for **any** request regardless of which provider or host it went to. Checked first so an explicit override always wins.
  2. For a host with a known conventional key — `https://api.deepseek.com` (`DEEPSEEK_API_KEY`) and `https://api.anthropic.com` (`ANTHROPIC_API_KEY`) — the same way that provider's own adapter resolves it: `ctx.credentials` first, then the ambient environment variable.

  Either way, the key is inlined directly, single-quoted like every other header — paste and run, no editing needed.
- **Nothing was found by either path**: the header references `$DSH_CURL_KEY` — double-quoted so the shell expands the variable at run time, and always this one name regardless of which provider or host the record is for. `export DSH_CURL_KEY=...` once, and the copied command then runs as-is for **any** record; this is the case the feature is mainly for.

The header's original scheme is preserved either way: `authorization` is rebuilt as `Bearer <key>`, while a bare-key header such as Anthropic's `x-api-key` is rebuilt as the key alone. Sending a bare key behind a `Bearer` prefix (or the reverse) would be rejected by the provider, which would make the copied command look broken rather than the credential look missing.

The client tells you which of the two happened after each copy. Inlining a real secret means **it is now on your clipboard** (and possibly in shell history once pasted) — worth knowing before sharing a screen or pasting into a chat. The `$DSH_CURL_KEY` case avoids that by design, since the secret value never leaves your shell's environment.

### Copy and download

Copy (`复制`) puts the complete record half — the whole `request` or `response` object, headers included — on the clipboard as formatted JSON, matching what the view shows. Download (`下载`) exports the complete record, both halves, as `llm-wire-trace-<id>.json`.

### Independent scrolling: a shell CSS quirk this plugin corrects

The left record list and the right detail pane are meant to scroll independently, but the shell's own `ConversationRoot` CSS gets in the way: for any open, non-blank session (`data-phase="active"` — i.e. always, for us) it sets the ancestor it calls `viewArea` to `flex:1 0 auto; min-height:auto`. That's intentional for Chat — it lets the message list grow past the visible area so the *whole page* scrolls with a sticky composer pinned at the bottom — but the same rule reaches every `conversation.view` entry, including this one, and breaks a two-pane layout: with no bounded height to overflow against, the root grows to fit its content and the whole page scrolls as one.

`viewArea` has no stable selector of its own (a build-hashed CSS-module class), so this plugin's stylesheet targets it structurally, through two attributes the framework itself always adds and treats as stable: every slot's `SlotOutlet` wrapper carries `data-slot="<slot key>"`, which makes `viewArea` exactly `div:has(>[data-slot="conversation.view"])` regardless of its own class name. Scoping that with `:has(.wt-root)` re-asserts `min-height:0; overflow:hidden; flex:1 1 0` only when *this* tab is the one currently mounted inside it — Chat, Trajectory, and any other tab's instance of the same ancestor are untouched.

## Known limitation

This plugin depends on the implementation detail that every current provider adapter calls the bare, unimported `fetch`. A future adapter that instead uses its own HTTP client (e.g. an SDK bundling its own `undici` instance) would be invisible to this patch — silently, not as an error. That is an inherent limit of the fetch-patch approach, not a bug in this plugin.

## Repository layout

Source is TypeScript, organized by concern; `dist/` holds the compiled, plain-JavaScript output that is actually installed and loaded — see [Development](#development) below.

```
src/host/                    host half (Node ESM, compiled 1:1 by tsc)
  index.ts                   apply(ctx, config) — wires everything together
  constants.ts                shared constants (user-agent prefix, header name, defaults)
  http-utils.ts               header redaction, request description, JSON/body clipping
  call-context.ts             AsyncLocalStorage binding for llm/stream (turn/step/purpose/provider)
  step-tracker.ts              turn/step tracking from session/event
  fetch-patch.ts               the globalThis.fetch patch itself
  curl.ts                      curl-command rendering + credential resolution
  store.ts                     in-memory ring merged with the durable archive
  page-grouping.ts             list-page grouping (turns, auxiliary, unattributed)
  routes.ts                    HTTP route handlers (list/stats/get/curl/clear)
  persistence/                 durable, file-per-record store
    naming.ts                  file-name generation and trace-dir resolution
    codec.ts                   record ⇄ persisted-JSON conversions
    archive.ts                 the actual file I/O (save/list/get/sweep/clear)
    constants.ts
src/client/                  browser half (bundled by esbuild into one classic script)
  entry.ts                    window.__ModuleLoader__.load({ id, factory }) wrapper
  wire-trace-view.ts           the WireTraceView component (state + rendering)
  view-model.ts                pure list/detail logic behind the view (no DOM, unit-tested)
  strings.ts                   every user-visible string in one place
  json-view.ts                 the collapsible JSON tree component
  json-model.ts                 pure JSON-flattening data model (no DOM)
  format.ts                     labels/formatters (turn badge, session label, timestamps)
  sse.ts                        raw SSE frame parsing/pretty-printing
  sse-merge/                     per-provider adapters that merge SSE deltas into that provider's own non-streamed shape
    shared.ts                    shared adapter interface + JSON-parse helper
    anthropic.ts                  Anthropic Messages API adapter
    openai-responses.ts           OpenAI Responses API adapter
    openai-chat-completions.ts    OpenAI/DeepSeek Chat Completions adapter
    index.ts                      dispatches frames to every adapter, assembles the unified result
  api-client.ts                  fetch wrappers for this plugin's own routes
  styles.ts                      the tab's CSS
  constants.ts
src/shared/
  record-shape.ts             type-only record shapes shared by both halves
dist/                        compiled output — what actually ships and loads
  host/**                     tsc output, one file per source module
  client.js                    esbuild bundle of src/client/**, single IIFE
cordis.patch.yml             the host composition row (dsh.bundle.patch)
package.json                 dsh.bundle + dsh.client declarations
test/                        node:test suites mirroring src/host/** and the DOM-free src/client/*.ts
AGENTS.md                     self-verification flow, module boundaries, and hard constraints for agents/contributors
docs/plugin-development.md   how this codebase uses the DSH/Cordis plugin framework
docs/architecture.md         why this codebase's own modules are split the way they are
```

## Development

```sh
pnpm install
pnpm run build       # tsc -> dist/host/** (+ .d.ts), esbuild -> dist/client.js
pnpm run typecheck   # host + client, no emit
pnpm run test        # tsc -> .test-build, node --test
pnpm run lint        # oxlint over src/ and test/
pnpm run verify       # build + typecheck + test + lint — the full self-check before calling a change done
```

Requires **Node >= 22.6** (the test script uses glob patterns as test-runner arguments, which the runner gained in 22.6) and builds with **TypeScript 7**, the native compiler.

`dist/` is **not** committed to the repository — it is a build artifact, gitignored like any other, produced by `pnpm run build` and produced fresh at publish time by the `prepublishOnly` script (so `npm publish` always ships a build matching the exact source at that commit). Only the *published npm package* carries a prebuilt `dist/`; a git checkout or `link:` install never does. See "[Installing from a source checkout](#installing-from-a-source-checkout-git-or-link)" above for what that means for those install paths.

For local development, run `pnpm run build` after every source change (needed for the plugin to run at all from this checkout — there is no committed `dist/` to fall back on), then reinstall the `link:.` checkout (or just restart `dsh web`, since a linked package's `dist/` is not covered by the client-plugin HMR watcher).

### Tests

`test/` mirrors `src/host/**`, `src/shared/**`, and the DOM-free client modules (`constants.ts`, `format.ts`, `json-model.ts`, `sse.ts`, `strings.ts`, `view-model.ts`, `sse-merge/**`) one file at a time, using Node's built-in test runner (`node:test`) — no test framework dependency. Coverage includes the in-memory store merged with a fake archive, real temp-directory file I/O for the persistence layer, `AsyncLocalStorage` context binding for turn/step attribution, every SSE-merge adapter against both synthetic fixtures and the exact shape of a bug this project fixed once (a `message` item's own id being misread as a tool-call id), and the viewer's own list/detail logic — the merge of the racing memory and history reads, the one-shot session-filter fallback, turn grouping, and body selection.

Deliberately not unit-tested: `src/host/index.ts` / `src/client/entry.ts` (pure Cordis/`ModuleLoader` glue, covered by `build`+`typecheck` succeeding) and the DOM/React-dependent client modules (`api-client.ts`, `styles.ts`, `json-view.ts`, `wire-trace-view.ts`), verified instead by the "fake React + fake `ModuleLoader` + real `dist/client.js`" pattern this project's development used throughout.

See [`AGENTS.md`](AGENTS.md) for the exact self-verification flow a change must complete before it's done, the module boundaries the test layout depends on, and the hard constraints (no `prepare` script, `dist/` stays a gitignored build artifact, bodies stay verbatim) that protect this project's deliberate design choices.

See [`docs/plugin-development.md`](docs/plugin-development.md) for a short walkthrough of how this codebase uses the DSH/Cordis plugin framework itself — services, events, Slots, and the one thing (patching `fetch`) that only an installed package can do. See [`docs/architecture.md`](docs/architecture.md) for why this codebase's own modules are split the way they are and how data flows between them.

## License

[MIT](LICENSE)
