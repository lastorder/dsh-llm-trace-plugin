# dsh-llm-trace-plugin

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that captures the **literal HTTP request and response** of every LLM provider call — the exact bytes on the wire, provider-native field names, raw SSE frames — and lets you browse them in a **Wire Trace** session tab.

This works at the *wire* layer. A harness-level tracer observes the normalized `GenerateOptions` / `StreamChunk` objects the harness builds: provider-neutral, aware of `sessionId` / `turn` / `step`. This plugin has no harness concepts at all — it only sees what actually left the process and what actually came back.

## Install

Install straight from npm:

```sh
dsh plugin --profile web add dsh-llm-trace-plugin
```

Pin an exact version:

```sh
dsh plugin --profile web add dsh-llm-trace-plugin@0.1.1
```

Or install straight from git:

```sh
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git
```

Pin a branch or tag with a fragment:

```sh
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#main
dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v0.1.1
```

For local development, link a checkout (a relative path is anchored to the directory you ran `dsh` from, not the profile directory):

```sh
dsh plugin --profile web add link:.
```

Then update or remove it by **package name**:

```sh
dsh plugin --profile web update dsh-llm-trace-plugin
dsh plugin --profile web remove dsh-llm-trace-plugin
```

Notes:

- `dsh plugin` forwards to pnpm and then reconciles `dsh.profile.bundles` in `$DSH_HOME/profiles/web/package.json` from the *installed* state, so a git spec registers under this package's real name, `dsh-llm-trace-plugin`.
- **Restart `dsh web` after installing.** An installed package is not a dev checkout, so there is no client-plugin HMR watcher.
- This plugin ships plain JavaScript and declares **no `prepare` script**, so a git install needs no `allowBuilds` entry in the profile's `pnpm-workspace.yaml` — the build-approval prompt that git-hosted plugins usually trigger does not apply here.
- The package name changed from `dsh-llm-wire-trace-plugin` to `dsh-llm-trace-plugin`. If you installed it under the old name, remove that first: `dsh plugin --profile web remove dsh-llm-wire-trace-plugin`.

## Configuration

The host row lives in [`cordis.patch.yml`](cordis.patch.yml) and takes three optional keys:

| Key | Default | Meaning |
|---|---|---|
| `maxRecords` | `200` | Ring-buffer size; only the most recent N records are kept. |
| `maxBodyChars` | `200000` | Per-field character cap before a body is truncated. |
| `routePrefix` | `/llm-wire-trace` | Prefix for the plugin's own HTTP routes. |

```yaml
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      config:
        maxRecords: 500
        maxBodyChars: 500000
```

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
- `authorization` is always redacted to `Bearer ***redacted***` before it is stored or displayed; no other header is touched.
- Re-activating the plugin cannot double-wrap an already-patched `fetch` (it throws loudly instead); stopping restores the exact original reference.

## What it captures

Each record:

```
{
  id, startedAt, endedAt, durationMs,
  status: 'ok' | 'http-error' | 'transport-error' | 'streaming',
  model,                          // best-effort, read from the parsed request body
  request:  { method, url, headers /* redacted */, bodyText, bodyJson, bodyTruncated },
  response: { status, statusText, headers, contentType, bodyText, bodyJson, bodyTruncated } | null,
  error: { name, message } | null,
}
```

- `bodyText` is always the raw string (SSE frames verbatim, or a JSON error body). `bodyJson` is a best-effort parse for the JSON view; SSE bodies are never JSON-parsed as a whole (they're a frame sequence, not one JSON value).
- No `sessionId` / `turn` / `step` — this layer doesn't have them. Records are ordered purely by time.
- Body fields are capped and the ring buffer holds only the most recent records; both are configurable (see [Configuration](#configuration)).

## The viewer

A `jq`-shaped JSON view: the brackets, commas, and indentation `jq .` would print, syntax-coloured from the product's own shiki palette so it tracks the light/dark theme for free. Keys, strings, numbers, booleans, and `null` each get their own colour. Unlike preformatted text, every line is a real row, so containers stay foldable.

Folding works two ways, and they compose:

- **A global depth stepper** (`−` / `+` in the toolbar) opens or closes the whole document one level at a time, with the current level shown beside it as `深度 2/5`. `+` stops once the deepest nesting present is reached.
- **A per-row `+` / `-`** in the gutter folds one individual container, for when you want a single branch open without expanding its whole level.

Using the global stepper resets the baseline and clears any per-row folds, so the depth readout always describes what you actually see.

A folded container collapses to a one-line placeholder that keeps its trailing comma, e.g. `"messages": [ … 12 items ],`. Fully expanded, the view is valid JSON: it round-trips through `JSON.parse` to exactly the captured value.

Two tabs, Request and Response. Request always shows the parsed body. Response adapts to the content type: a JSON body is shown as-is, and an `event-stream` body is parsed into one object per SSE frame so the whole stream reads as a JSON array (see below).

> The in-app button labels are currently Chinese; the English names below are given alongside them.

### Response: SSE as a JSON array

An `event-stream` body is parsed frame by frame into a JSON array and shown with the same view as any other body. Each frame becomes one object keyed by its own SSE field names:

```json
[
  { "comment": "keep-alive" },
  { "data": { "id": "chatcmpl-1", "choices": [ ] } },
  { "event": "message", "id": "42", "data": { } },
  { "data": "[DONE]" }
]
```

`data:` holds the parsed JSON when the payload is parseable and the raw string otherwise, so sentinels like `[DONE]` stay visible rather than being dropped; `event:` / `id:` / `retry:` sit alongside it, and comment lines (`: keep-alive`) become `comment`. Repeated `data:` lines within one frame are joined with newlines first, as the SSE spec requires. Nothing is discarded — a malformed payload is kept verbatim as a string.

An `SSE 原始文本` toggle switches to the literal frame sequence on the wire, which is what this plugin exists to show. Only each frame's `data:` payload is re-indented there; frame structure (`event:` / `id:` / `retry:` fields, comment lines, blank separators, and non-JSON sentinels) is left completely untouched.

### Copy as curl

The copy-curl button (`复制 curl`) asks the host for a ready-to-run `curl` command reconstructed from the record (`GET <routePrefix>/curl?id=`) and copies it. Every argument is single-quoted with the standard POSIX `'\''` escape, so the command is safe to paste into bash/zsh/sh as-is, including bodies containing quotes, `$(...)`, and backticks.

The stored `authorization` header is always the redacted placeholder — this plugin never keeps a real secret at rest — so the header is rebuilt fresh for the curl command, one of two ways:

- **A real value was resolved**, checked in this order:
  1. `DSH_CURL_KEY` in the process environment — a manual, plugin-owned, provider-neutral override that works for **any** request regardless of which provider or host it went to. Checked first so an explicit override always wins.
  2. For `https://api.deepseek.com` specifically, the same way `dsh-llm-deepseek`'s own adapter resolves its key: `ctx.credentials` first, then the ambient `DEEPSEEK_API_KEY` environment variable.

  Either way, the key is inlined directly, single-quoted like every other header — paste and run, no editing needed.
- **Nothing was found by either path**: the header becomes `"authorization: Bearer $DSH_CURL_KEY"` — double-quoted so the shell expands the variable at run time, and always this one name regardless of which provider or host the record is for. `export DSH_CURL_KEY=...` once, and the copied command then runs as-is for **any** record; this is the case the feature is mainly for.

The client tells you which of the two happened after each copy. Inlining a real secret means **it is now on your clipboard** (and possibly in shell history once pasted) — worth knowing before sharing a screen or pasting into a chat. The `$DSH_CURL_KEY` case avoids that by design, since the secret value never leaves your shell's environment.

### Copy and download

Copy (`复制`) puts the complete record half — the whole `request` or `response` object, headers included — on the clipboard as formatted JSON, matching what the view shows. Download (`下载`) exports the complete record, both halves, as `llm-wire-trace-<id>.json`.

### Independent scrolling: a shell CSS quirk this plugin corrects

The left record list and the right detail pane are meant to scroll independently, but the shell's own `ConversationRoot` CSS gets in the way: for any open, non-blank session (`data-phase="active"` — i.e. always, for us) it sets the ancestor it calls `viewArea` to `flex:1 0 auto; min-height:auto`. That's intentional for Chat — it lets the message list grow past the visible area so the *whole page* scrolls with a sticky composer pinned at the bottom — but the same rule reaches every `conversation.view` entry, including this one, and breaks a two-pane layout: with no bounded height to overflow against, the root grows to fit its content and the whole page scrolls as one.

`viewArea` has no stable selector of its own (a build-hashed CSS-module class), so this plugin's stylesheet targets it structurally, through two attributes the framework itself always adds and treats as stable: every slot's `SlotOutlet` wrapper carries `data-slot="<slot key>"`, which makes `viewArea` exactly `div:has(>[data-slot="conversation.view"])` regardless of its own class name. Scoping that with `:has(.wt-root)` re-asserts `min-height:0; overflow:hidden; flex:1 1 0` only when *this* tab is the one currently mounted inside it — Chat, Trajectory, and any other tab's instance of the same ancestor are untouched.

## Known limitation

This plugin depends on the implementation detail that every current provider adapter calls the bare, unimported `fetch`. A future adapter that instead uses its own HTTP client (e.g. an SDK bundling its own `undici` instance) would be invisible to this patch — silently, not as an error. That is an inherent limit of the fetch-patch approach, not a bug in this plugin.

## Repository layout

```
src/index.js       host half — the fetch patch, record store, and HTTP routes
src/client.js      browser half — the Wire Trace tab, hand-authored bundle format
cordis.patch.yml   the host composition row (dsh.bundle.patch)
package.json       dsh.bundle + dsh.client declarations
```

There is no build step: both halves are plain JavaScript, served and loaded as-is.

## License

[MIT](LICENSE)
