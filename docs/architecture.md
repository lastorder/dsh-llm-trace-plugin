# Architecture: How This Codebase Is Structured

English | [中文](architecture.zh.md)

This complements [`plugin-development.md`](plugin-development.md), which explains the DSH/Cordis mechanics this plugin uses. This document explains the *internal* design: why the code is split the way it is, how data flows between modules, and what boundary each layer is responsible for. It assumes you have already skimmed the [main README](../README.md) for *what* the plugin does.

## The two-process shape

A DSH plugin with a browser half is really two programs that happen to ship together and never share memory:

```
┌─────────────────────────────┐        HTTP (JSON only)        ┌──────────────────────────────┐
│  src/host/   (Node process) │ ◄─────────────────────────────► │  src/client/  (browser)      │
│  compiled 1:1 by tsc        │                                  │  bundled by esbuild into one  │
│  → dist/host/**             │                                  │  classic script → dist/client.js │
└─────────────────────────────┘                                  └──────────────────────────────┘
              │                                                                 │
              └──────────────────────┬──────────────────────────────────────────┘
                                      │ type-only (erased at build time)
                              ┌───────▼────────┐
                              │  src/shared/    │
                              │  record-shape.ts│
                              └────────────────┘
```

`src/shared/` is the only thing both halves reference, and it contributes **zero runtime bytes** to the client bundle — it is `import type` only (`WireRecord`, `WireRecordSummary`, …), so both sides agree on the field names of a captured record without either side depending on the other's code.

## Host half: capture → store → serve

The host side has one job — turn raw `fetch` traffic into queryable records — done in three layers, each independently testable:

```
fetch-patch.ts ──records──► store.ts ──serves──► routes.ts
     ▲                         │
     │                         ▼
call-context.ts          persistence/ (archive.ts, codec.ts, naming.ts)
step-tracker.ts
     ▲
     │
index.ts (apply) wires everything above into ctx.effect()/ctx.on()
```

- **`fetch-patch.ts`** is the capture layer: it knows how to wrap a `fetch` function and produce a `WireRecord`, and nothing else. It takes its `push`/`finalize` callbacks as parameters rather than importing the store directly — so it can be unit-tested against a fake `fetch` with no store at all.
- **`call-context.ts`** / **`step-tracker.ts`** are the *attribution* layer: they answer "which turn/session/purpose does this call belong to", entirely independent of HTTP or storage. `step-tracker.ts` in particular has zero Cordis or Node dependencies — it is a plain `Map`-based state machine, tested the same way any pure TypeScript module would be.
- **`store.ts`** is the orchestration layer: an in-memory ring merged live with an optional durable `archive`. It depends on `fetch-patch.ts` (to build the wrapped `fetch`) and `persistence/` (to persist/restore), but knows nothing about HTTP.
- **`persistence/`** is its own three-way split, because "store a record" and "name a file" and "reshape a record for disk" are three different concerns that used to live in one 689-line file before this refactor:
  - `naming.ts` — turns a timestamp into a globally-unique, chronologically-sortable filename (no I/O).
  - `codec.ts` — converts between the live record shape and the on-disk JSON shape (no I/O).
  - `archive.ts` — the actual `readdir`/`readFile`/`writeFile` orchestration, built on the two above.
- **`routes.ts`** is the HTTP-facing layer: it knows about `IncomingMessage`/`ServerResponse` and query strings, and calls `store`/`curl.ts` — but the store has no idea an HTTP server exists. This is what lets `createWireTraceStore` be exercised directly (see the smoke tests in this repository's development history) without a running web server.
- **`curl.ts`** is a self-contained feature (render a record as a `curl` command) that only `routes.ts` calls; it does not participate in capture or storage at all.
- **`index.ts`** is the only file that imports Cordis concepts (`ctx.effect`, `ctx.on`, `ctx.get`) — every other host module is plain TypeScript that happens to be *useful to* a Cordis plugin, not *coupled to* one. That separation is what let every layer below be verified with plain Node scripts while developing this plugin, with no running DSH process required.

## Client half: data model → adapters → view

The browser side follows the same "keep the pure computation away from the framework glue" principle, split three ways:

```
sse.ts (parse) ──frames──► sse-merge/ (reassemble) ──merged JSON──► wire-trace-view.ts ──renders──► json-view.ts
                                                                            │
                              view-model.ts (list/detail logic), json-model.ts (flatten),
                              format.ts (labels), strings.ts (text), api-client.ts (fetch)
```

- **`sse.ts`** only knows the SSE wire format (`event:`/`data:`/blank-line framing). It has never heard of OpenAI, Anthropic, or Cordis.
- **`sse-merge/`** is a small adapter registry — see [`plugin-development.md` §5](plugin-development.md#5-what-is-not-ordinary-cordis-the-fetch-patch) for why this exists at all, and the main README's ["Response: merged SSE"](../README.md#response-merged-sse-and-the-raw-wire-text-underneath) section for what it produces. Structurally, each file is a self-contained state machine implementing the same `SseMergeAdapter<TResult>` interface (`shared.ts`):

  | file | recognizes | reassembles into |
  |---|---|---|
  | `anthropic.ts` | `event: message_start` / `content_block_delta` / … | the shape of a non-streamed `POST /v1/messages` response |
  | `openai-responses.ts` | `event: response.output_item.added` / `response.output_text.delta` / … | the shape of a non-streamed `POST /v1/responses` response |
  | `openai-chat-completions.ts` | an object with a top-level `choices` array | the shape of a non-streamed `POST /v1/chat/completions` response |
  | `index.ts` | — | offers every frame to each adapter above in turn; a frame no adapter claims goes to `unrecognized` |

  Adding a fourth provider shape means adding one more file next to these three and registering its factory in `index.ts`'s `ADAPTER_FACTORIES` array — nothing else in the module changes. This is why the split exists: the previous single-file version mixed "how do I recognize this frame" with "how do I render it", which made adding a provider mean editing one growing function instead of adding one new file.
- **`json-model.ts`** is the JSON-tree flattening algorithm (`flattenJq`, collapse/expand bookkeeping) with no DOM and no React — it is what makes the request pane, the merged response pane, and the raw-frame pane all render through the exact same collapsible tree.
- **`format.ts`** is presentation-only string formatting (turn badges, session labels, timestamps) with no state and no side effects.
- **`strings.ts`** holds every user-visible string in the tab, plus the handful of helpers that interpolate values into them. This is not an i18n framework — there is one locale and the table is a plain object — but collecting the text in one place is what makes the tab's full wording reviewable without reading three files, and makes the interpolating helpers testable, which they were not while they were string concatenation inside `React.createElement` calls.
- **`view-model.ts`** is the pure list/detail logic behind the tab: merging the two racing list reads (`mergeSummaryPages`), deciding when the session filter must be abandoned (`shouldFallBackToAllSessions`), grouping rows by turn (`groupRows`), and choosing which body each tab renders (`selectRequestBody`/`selectResponseBody`/`describeBodyNotice`). None of it touches React, `window`, or `document`. It exists because this logic is the subtlest in the client half — the merge is what stops a late poll from erasing already-loaded history — and while it lived inside the component it was covered by nothing at all.
- **`api-client.ts`** is the thin `fetch` wrapper around this plugin's own `/llm-wire-trace/*` routes (mirrors `routes.ts` on the host side) plus two unrelated browser utilities (`download`, `copy`).
- **`json-view.ts`** is the one presentational React component, parameterized over a minimal `ReactLike` interface rather than importing `react` — because, per the classic-script constraint explained in `plugin-development.md`, `react` only exists at runtime through the factory's `require`, never as a static import.
- **`wire-trace-view.ts`** is the only file that owns state (`React.useState`/`useEffect`) and orchestrates all of the above into the tab's actual behavior — polling, filtering, the merged/raw toggle. It is intentionally the largest file in `src/client/`, because state orchestration does not decompose as cleanly as pure computation does; everything that *could* be extracted as pure logic already has been (into `view-model.ts`/`json-model.ts`/`format.ts`/`strings.ts`/`sse-merge/`), so this file is left holding only the parts that are genuinely about "what should this component do right now." What remains is overwhelmingly `React.createElement` trees — which is why extracting the logic shrank the file far less than it grew the tested surface.
- **`entry.ts`** is the only file that touches `window.__ModuleLoader__` or Cordis Slot registration — the same "keep the framework glue in exactly one file" pattern as the host's `index.ts`.

## Why this shape, generally

Two rules run through every split above, and are worth carrying into a new plugin regardless of what that plugin does:

1. **Framework glue lives in exactly one file per half** (`src/host/index.ts`, `src/client/entry.ts`). Every other module is plain TypeScript, testable by importing it and calling its functions — no Cordis context, no DOM, no running DSH process required. This is what made it possible to verify this plugin's entire rewrite (see the development history in this repository) by piping real captured records through the compiled modules directly in `node -e "..."`, rather than only being able to check it by clicking through a live UI. `test/` makes this concrete rather than theoretical: it mirrors the same boundary one file at a time (`test/host/**` against `src/host/**`, `test/client/**` against the DOM-free `src/client/*.ts`), and every module on that side of the line has a real `node:test` file exercising it — see [`AGENTS.md`](../AGENTS.md) for the exact rule and which modules are deliberately excluded.
2. **A concern gets its own file the moment it would otherwise force two unrelated things to change together.** `persistence/naming.ts` versus `archive.ts` is the clearest example: a filename-format change and a retention-sweep change used to require touching the same function; splitting them means either can change without the other's tests even re-running the wrong assertions.

## Where to go next

- [`plugin-development.md`](plugin-development.md) — the DSH/Cordis side of this same codebase (services, events, Slots, why the `fetch` patch requires an installed package).
- [`AGENTS.md`](../AGENTS.md) — the self-verification flow a change must complete, and the module boundaries/hard constraints it enforces.
- [Main README, "Repository layout"](../README.md#repository-layout) — the flat file-by-file listing this document's diagrams summarize.
- [Main README, "How it works"](../README.md#how-it-works) — the runtime behavior these modules implement, independent of how they're split.
