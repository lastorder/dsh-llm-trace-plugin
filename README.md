# dsh-llm-trace-plugin

<img width="3024" height="1898" alt="20260907141152_27_365" src="https://github.com/user-attachments/assets/ad398625-d9c6-4b46-99e9-49b0177ad2ec" />


English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that records the **literal HTTP request and response** of every LLM provider call — the exact bytes on the wire, provider-native field names, raw SSE frames — and lets you browse them in a **Wire Trace** session tab.

It works at the wire layer: it sees only what actually left the process and what came back, and labels each call with the session, turn and step it belongs to.

## Install

Install from npm. The published package ships a prebuilt `dist/`, so no local toolchain is needed:

```sh
dsh plugin --profile web add dsh-llm-trace-plugin     # append @<version> to pin a version
dsh plugin --profile web update dsh-llm-trace-plugin
dsh plugin --profile web remove dsh-llm-trace-plugin
```

**From a source checkout** (`link:` or a git spec) you get source only: `dist/` is not committed and nothing builds it for you. Build first, and rebuild after every update that pulls new commits:

```sh
cd /path/to/dsh-llm-trace-plugin && pnpm install && pnpm run build
dsh plugin --profile web add link:/path/to/dsh-llm-trace-plugin
# or: dsh plugin --profile web add git+https://github.com/lastorder/dsh-llm-trace-plugin.git#v<version>
```

- **Restart `dsh web` (or DSH) after installing or updating.** The plugin manager applies a new version at once, but an older version's `fetch` wrapper can stay loaded — and keep recording duplicates — until a restart.
- It must be an installed package, not a dynamic Cordis plugin: dynamic plugins run in an isolated realm that cannot reach the process's real `fetch`.
- The package was renamed from `dsh-llm-wire-trace-plugin`. If you installed it under that name, remove it first: `dsh plugin --profile web remove dsh-llm-wire-trace-plugin`.

## What gets captured

A request is recorded when **either** its `user-agent` starts with `deepseek-harness/` (stamped on every provider request the harness issues) **or** it is issued inside a model call (`llm/stream`) — the second catches providers that rewrite their own user-agent. Everything else (`web_fetch`, `web_search`, MCP transports, …) passes through untouched and unrecorded.

Each record holds the method, URL, headers, full request and response bodies, HTTP status, timing, model and provider, plus the session, turn, step and purpose of the call (see [Turn and step coordinates](#turn-and-step-coordinates)). Credentials are redacted — see [Privacy](#privacy).

## How it works

- On start, the plugin wraps `globalThis.fetch`; stopping or uninstalling restores the original.
- The provider adapter gets the original, unread response back, so its streaming, timing and error handling are unaffected. A clone is read in the background to capture the body — including streams the adapter aborts after its last event.
- Request bodies are captured in whatever form they reach `fetch` (string, bytes, `Blob`, stream, `Request`). A form that can't be copied without consuming it (`FormData`, async iterables) is sent untouched and flagged in the record.
- A transport error is recorded and rethrown unchanged.

Module structure and design rationale: [`docs/architecture.md`](docs/architecture.md).

## The Wire Trace tab

Open the **Wire Trace** tab in any session. Its labels and notices follow DSH's language setting (Settings → General → Language).

### Call list

- The list shows **only the current session's calls**. Filtering happens on the host, so other sessions' bodies never reach the browser. Subagents are separate sessions and don't appear in the parent's list.
- Rows are grouped under sticky per-turn headers. Each row starts with its coordinate: `T1·S0`, a background-call label (session title, compaction), or *unattributed*.
- Calls that can't be tied to a session are hidden, and the list footer says how many there are. If the first load finds nothing for this session but unattributed records exist, the tab falls back to showing all records (at most once per opening) and says why.
- The toolbar shows matching records over all records held, plus turn and background-call counts; click it for the details.
- New calls appear and streaming ones refresh on their own (the tab polls every 3 s while visible).
- **Clear** deletes only the current session's records. To wipe everything, use **Clear all history** on the [management panel](#management-panel).

### Request and Response

The detail pane shows the call's model, status, start time, duration, HTTP status, method and URL, a coordinate strip (turn / step / provider / session), and three tabs: **Request**, **Response** and **Compare**.

Bodies render as a `jq`-style JSON tree in DSH's theme colours. Fold the whole document one level at a time with the depth stepper (`−` / `+`), or a single node with its row's `+` / `-`. Fully expanded, the view is valid JSON.

A streamed (`text/event-stream`) response is **merged by default**: its delta fragments are reassembled into the shape that provider's non-streamed response would have had.

- **Anthropic Messages** → a `/v1/messages` message: text, thinking and `tool_use` blocks, with tool input parsed.
- **OpenAI Responses** → a `/v1/responses` response: `message`, `reasoning` and `function_call` output items.
- **OpenAI / DeepSeek Chat Completions** → a `chat.completion`: content, `reasoning_content` and tool calls, with arguments parsed into `argumentsJson`.

The format is detected per frame. Frames that fit none of these (errors, `[DONE]`, unknown events) are kept verbatim under `unrecognized`. **Show raw SSE** switches to the literal frame sequence, one object per frame.

### Compare

**Compare** shows what changed in the request body relative to another call — the usual question when consecutive calls send nearly identical, very large requests.

- The default baseline is the previous call of the same kind (same session, same purpose); background calls in between are skipped. Pick any other call under **Compare against** (grouped by turn; the baseline row is tagged `Base`); **Reset to previous** goes back. Compare stays open as you select other rows, so you can step through a turn.
- Changes are grouped by top-level key (`messages`, `tools`, …) with counts. Edited strings are highlighted in place; multi-line text such as a system prompt is shown as a line diff. Unchanged top-level fields are listed collapsed. Key order does not count as a change.
- **Copy** copies the change list as plain text. Both bodies must be valid JSON; if one was truncated, the tab says which side.

### Copy, download and curl

- Hover any row of the JSON tree for a **Copy** pill. It copies that value: a string without quotes, an object or array (even folded) as formatted JSON.
- **Copy** copies the whole request or response half, headers included, as JSON. **Download** saves the full record as `llm-wire-trace-<id>.json`.
- **Copy as curl** copies a ready-to-run, shell-safe `curl` command. Stored credentials are redacted, so the credential header is rebuilt:
  - from `DSH_CURL_KEY` in DSH's environment, if set; otherwise, for `api.deepseek.com` / `api.anthropic.com`, from that provider's own credential (`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`). The key is inlined — and is then on your clipboard.
  - if nothing is found, the command references `"$DSH_CURL_KEY"`, so one `export DSH_CURL_KEY=...` in your shell makes every copied command runnable.

  The header's scheme (`Bearer <key>` or a bare key) is preserved, and the tab tells you which case applied.

### Turn and step coordinates

The wire barely carries any of this, so it is attached by observing two harness channels:

- **Session, provider, model and purpose** come from the `llm/stream` event around each model call, bound to that call's async context — concurrent calls never mix, even a background title request in the same session.
- **Turn and step** come from `session/event`: the step open when a call starts is that call's step.
- Background calls (`session-title`, `compaction`) get no turn or step. A call that didn't go through the harness's model API is marked unattributed (its session, if any, comes from the `x-deepseek-harness-session-id` header) — never guessed.
- This needs the `sessions` and `llm` services. Without them capture still works, just without coordinates.

## Persistence

Records are saved to disk so they survive restarts; the tab shows live and saved records as one list. Design and file format: [`docs/persistence.md`](docs/persistence.md).

- **Location**: `traceDir`, default `$DSH_HOME/llm-wire-trace/records` (falls back to `~/.dsh/llm-wire-trace/records`).
- **Format**: compact, append-only segment files — `<start-ms>-<random>.dat` holding brotli-compressed records, plus a small `.idx` JSONL index per segment. They are not meant to be opened by hand; browse records in the Wire Trace tab.
- **Small on disk**: consecutive requests in a conversation repeat almost the whole history, so each request body is stored as a delta against the previous request of the same session (common prefix and suffix), then compressed. On real traffic, a 1.6 MB request typically takes 3–30 KB. Bodies are still reconstructed byte-for-byte, so curl replay and the merged SSE view stay exact.
- **Retention**: a disk budget, `maxDiskMB` (default 1024, i.e. 1 GB). When it is exceeded, the oldest segments are deleted whole. At typical usage that is tens of thousands of calls, versus 300 records before.
- **Not saved**: requests with no body that were not made inside a model call, such as the periodic `GET /models` polling (they used to crowd real calls out of the old 300-record cap). They still appear live in the tab until restart.
- **Fast reads**: an in-memory index of all saved records (metadata only) is loaded at startup, so the list, session filter and counts never scan the disk. Opening a record reads and decompresses just that record.
- **Memory**: only in-flight and recent unsaved records are held in memory (at most 100); a record leaves memory once it is safely on disk.
- **Clearing**: the tab's **Clear** removes the current session's records (segments are rewritten without them); **Clear all history** on the management panel deletes everything.
- **Upgrading**: on first start, records from earlier versions (the old `*.json` files in the trace directory) are imported into the new format automatically, and the old files are removed.
- **Several DSH processes** sharing one `$DSH_HOME` are safe: each writes its own segment files.
- **`persist: false`** keeps everything in memory only (the last 100 records); nothing is written to disk.

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `persist` | `true` | Save records to disk. `false` keeps only the last 100 records in memory. |
| `maxDiskMB` | `1024` | Disk budget in MB (minimum 16). Past it, the oldest segments are deleted. |
| `traceDir` | `$DSH_HOME/llm-wire-trace/records` | Storage directory (falls back to `~/.dsh/llm-wire-trace/records`). |

Edit them on DSH's Plugins page (this plugin's [management panel](#management-panel)), or in the profile's `cordis.patch.yml`, in the `config:` block of this plugin's row:

```yaml
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      config:
        maxDiskMB: 4096
```

Options from earlier versions (`maxRecords`, `maxBodyChars`, `maxPersistedRecords`, `historyPageLimit`, `prettyBodyLimit`) are ignored, and are dropped the next time settings are saved from the management panel. Each captured body is capped at a fixed 8,000,000 characters — enough for a 1M-token context — which is no longer configurable.

### Management panel

On DSH's Plugins page (Settings → Plugins → `dsh-llm-trace-plugin`), this plugin's panel shows:

- **Storage usage**: records kept, disk used against the budget (with a small usage bar), and the time of the oldest record.
- **Clear all history**: deletes every session's records, in memory and on disk.
- **The three settings**, pre-filled with the values in effect. Changes are saved to the profile and apply without a restart.
- **A capture-gap warning** when a provider's model calls produced no captured request — see [Known limitation](#known-limitation).

If the host has no service for writing plugin config, the settings are shown read-only. If the panel says it is showing defaults, the running host is still an older build of this plugin — restart `dsh web`.

## Privacy

- **Bodies are stored in full.** Prompts, code and any file contents in context are saved as captured under `traceDir` — compressed, not encrypted. That is deliberate for a local debugging tool; use `persist: false` or **Clear** if it matters.
- **Credential headers are redacted** before anything is stored or shown: `authorization` and `proxy-authorization` become `Bearer ***redacted***`; `x-api-key`, `api-key`, `x-goog-api-key`, `x-dsh-auth-token`, `cookie` and `set-cookie` become `***redacted***`. No other header is touched.
- **Credential query parameters** in the URL (`key`, `api_key`, `access_token`, `token`, `secret`, `signature`, … — see `REDACTED_QUERY_PARAMS` in [`src/host/constants.ts`](src/host/constants.ts)) are redacted the same way, case-insensitively.
- The clear endpoint accepts only same-origin `POST` requests, so another web page cannot wipe your history.

## Known limitation

Capture only sees requests that go through the patched `globalThis.fetch`. The bundled adapters (`dsh-llm-deepseek`, `dsh-llm-pi-ai`) look up `fetch` at request time, so they are always captured. A provider is invisible — no record, no error — if it:

1. **uses its own HTTP client**, such as a bundled `undici` instance, instead of the global `fetch`;
2. **snapshots `globalThis.fetch` when its module is imported** and hands that copy to its SDK — `@jiesou/dsh-opencode-zen-free-provider` does this. If the snapshot is taken before this plugin installs its wrapper, none of its calls are seen. **Fix: list this plugin before such a provider in `dsh.profile.bundles`** (in the profile's `package.json`, e.g. `$DSH_HOME/profiles/web/package.json`) and restart DSH. Check again after installing other plugins: DSH's plugin manager appends new bundles to the end of that list;
3. **runs alongside something else that replaces `globalThis.fetch`** or the global `undici` dispatcher. Whichever patch is installed last wins, so don't combine this plugin with another fetch-patching plugin.

**Noticing it**: per provider, the plugin counts model calls that produced no captured request. When that happens, the management panel shows a capture-gap warning, the host logs one warning per provider, and `GET /llm-wire-trace/stats` reports it under `coverage` (`untracedCalls`). These counters cover the current process only.

Treat this plugin as part of a debugging profile, and be deliberate about anything else in that profile that touches `fetch`.

## Development

```sh
pnpm install
pnpm run build       # tsc -> dist/host/**, esbuild -> dist/client.js
pnpm run typecheck   # host + client, no emit
pnpm run test        # node:test suites under test/
pnpm run lint        # oxlint over src/ and test/
pnpm run verify      # build + typecheck + test + lint — the full self-check
```

Requires **Node >= 22.6** and builds with TypeScript 7. `dist/` is a gitignored build artifact (only the npm package ships one), so run `pnpm run build` after every source change and restart `dsh web` to load it.

- [`docs/architecture.md`](docs/architecture.md) — module structure, data flow and design rationale.
- [`docs/plugin-development.md`](docs/plugin-development.md) — how this plugin uses DSH/Cordis services, events and Slots.
- [`AGENTS.md`](AGENTS.md) — the verification flow, module boundaries and hard constraints every change must respect.

## License

[MIT](LICENSE)
