# Developing a DSH Plugin, Explained Through This Repository

English | [中文](plugin-development.zh.md)

This is a companion to the [main README](../README.md): where that document explains *what this plugin does*, this one explains *how DSH/Cordis plugin development works*, using this repository's actual code as the running example. It is intentionally brief — for the full concept walkthroughs, follow the official docs linked throughout.

**Primary references** (start here for anything not covered below):

- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) — source of truth for the framework.
- [Your first Harness plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) — the shortest path to a working plugin.
- [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) — the bundle/profile mechanics this repository's `package.json` and `cordis.patch.yml` follow.
- [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service) / [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events) — the two extension points this plugin uses (`ctx.on('llm/stream', ...)`, `ctx.on('session/event', ...)`).
- [Cordis tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.md) — Cordis itself, the plugin runtime underneath Harness, taught hands-on from scratch.

## 1. A plugin is a bundle: `package.json` + `cordis.patch.yml`

Per [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish), an installable plugin is an npm package (a **bundle**) whose manifest declares `dsh.bundle.patch`, pointing at a YAML file that inserts one or more rows into the composed configuration:

```jsonc
// package.json (this repository)
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

```yaml
# cordis.patch.yml (this repository)
- insert:
    - id: llm-wire-trace
      name: dsh-llm-trace-plugin
      # config:
      #   maxRecords: 200
```

`name` here is the **package name** — Node resolution finds the installed code — not a file path. A user installs it with `dsh plugin --profile <name> add dsh-llm-trace-plugin` (or `link:.` for local development, or a git spec); see the README's [Install](../README.md#install) section for every supported form.

The optional `dsh.client` block is how a package tells the loader it *also* has a browser half; see §3.

## 2. Host half: a plugin is `apply(ctx, config)`

Every Cordis plugin — dynamic or file-based — is, at minimum, a module exporting `name` and `apply`:

```ts
// src/host/index.ts (abridged)
export const name = 'llm-trace-plugin'
export const inject = ['webServer']

export function apply(ctx: PluginContext, config?: PluginConfig): void {
  // ...
}
```

- **`inject`** declares hard dependencies. This plugin requires `webServer` (it registers an HTTP route), so Cordis waits for that service before calling `apply`. See [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service).
- **Optional services** are read with `ctx.get(name)` instead, so absence degrades gracefully rather than blocking load. This plugin's turn/step attribution needs `sessions` and `llm`, but works without them:

  ```ts
  // src/host/index.ts
  if (ctx.get('sessions') !== undefined) {
    ctx.on('session/event', (session, event) => tracker.observe(String(session.id), event))
  }
  if (ctx.get('llm') !== undefined) {
    ctx.on('llm/stream', (options, next) => bindLlmStream(options, next, tracker))
  }
  ```

- **`ctx.effect(fn, label?)`** registers a side effect with an automatic disposer, so stopping or updating the plugin cleanly undoes it. This plugin uses it for both the `fetch` patch and the HTTP route:

  ```ts
  // src/host/index.ts
  ctx.effect(() => installFetchPatch((real) => store.wrapFetch(real)), 'llm-wire-trace: fetch patch')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routePrefix, handler: ... }))
  ```

This repository additionally defines its own `PluginContext` type (a minimal structural subset of the real `Context`) instead of importing `@deepseek-ai/cordis` — see the doc comment on that interface in `src/host/index.ts` for why: it keeps the published package free of a host-runtime type dependency. A plugin developed inside the monorepo (following the official tutorials) would instead `import type { Context } from '@deepseek-ai/cordis'` directly, which is simpler and is what you should do unless you have the same "ship standalone, no monorepo" constraint.

## 3. Client half: Slots and the classic-script bundle format

The browser side of a plugin registers into a **Slot** — a named extension point the shell's React tree renders. This plugin injects one tab into the session view ring:

```ts
// src/client/entry.ts (abridged)
function apply(ctx) {
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({ name: 'conversation.view', id: 'wire-trace', priority: 100, label: () => 'Wire Trace' }, WireTraceView),
  )
}
```

Two things about this half are specific to *this* plugin's distribution constraints, not general requirements:

- **No JSX, no `import`.** The compiled `dist/client.js` is loaded as a classic script via `window.__ModuleLoader__.load({ id, factory })`, so every element is built with `React.createElement` and `react` itself arrives through the factory's `require`, not an ES import. A plugin developed from a monorepo checkout, following the official tutorials, typically does not need this — check the current client-plugin authoring guide in the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) for the supported approach there.
- **Host↔Client is Package-private JSON RPC**, not shared memory: the two halves run in different processes (Node vs. browser) and communicate only through `harness.handle(method, handler)` (host) / `host.call(method, args)` (client) — or, for this plugin specifically, through the ordinary HTTP routes `src/host/routes.ts` registers, fetched by `src/client/api-client.ts`. Either channel only ever carries lossless JSON.

For Slot registration details beyond this example (exact prop shapes, other extension points, theme tokens), inspect the live Slot tree and its registration contract rather than guessing — that is what the `cordis-plugin-development` Skill and its Inspect Providers are for when working inside a DSH session.

## 4. Events used by this plugin: `llm/stream` and `session/event`

Per [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events), an event can be a plain broadcast or a **waterfall** — a chain where each listener wraps the next and can transform what passes through. `llm/stream` is a waterfall around every model call; this plugin's listener rewraps the returned stream to bind async-context identity around every pull:

```ts
// src/host/call-context.ts (abridged)
export function bindLlmStream(options, next, tracker) {
  const bound = { sessionId: ..., turn: ..., step: ..., purpose: ..., provider: ..., model: ... }
  const inner = next()
  return (async function* boundStream() {
    const iterator = inner[Symbol.asyncIterator]()
    while (true) {
      const result = await callContext.run(bound, () => iterator.next())
      if (result.done) return
      yield result.value
    }
  })()
}
```

The doc comment right above this function in `src/host/call-context.ts` explains *why* the re-entry happens on every pull rather than once around construction — a subtlety worth reading if you ever wrap a streamed waterfall yourself.

`session/event` is an ordinary broadcast carrying `turn/start` / `step/start` / `step/end` / `turn/end`; `src/host/step-tracker.ts` folds those into "what turn/step is open right now, per session" — a small, independently testable state machine with no Cordis dependency at all.

## 5. What is *not* ordinary Cordis: the `fetch` patch

Everything above is standard extension-point usage. The one deliberately unusual thing this plugin does — patching `globalThis.fetch` in the real Node process — is **not** something a dynamic Cordis plugin (defined at runtime through `cordis_define`) can do at all: a dynamic package runs inside an isolated `node:vm` realm whose `globalThis` is not the process's real one, and whose `fetch` is a throwing trap by design. This only works because the plugin ships as an **installed package**, loaded into the real process. See the module doc at the top of `src/host/fetch-patch.ts` for the full reasoning — it is the one place in this repository where the plugin steps outside what the framework's own extension points offer, and it explains exactly why that step is safe and why it must be a real package rather than a runtime-defined one.

## Where to go next

- Building your own first plugin: [Your first Harness plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/).
- Deeper on services, isolation, and dependency behavior: [Services and dependencies](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/service).
- Deeper on events, waterfalls, and short-circuiting: [Event system](https://deepseek-harness.github.io/deepseek-harness/en/develop/framework/events).
- Cordis itself, from a scratch directory with no API key needed: [Cordis tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/index.md).
- [`architecture.md`](architecture.md) — why this repository's own modules are split the way they are, and how data flows between them.
- This repository's own module-by-module layout and design rationale: the [main README](../README.md), particularly its "Repository layout" and "How it works" sections.
