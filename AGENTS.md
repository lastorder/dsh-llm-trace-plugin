# AGENTS.md

This file is for an AI agent (or a human contributor) making a change in this repository. It states the exact self-verification flow every change must complete, the module boundaries the codebase already relies on, and the hard constraints that protect properties this project has deliberately chosen. See [`docs/architecture.md`](docs/architecture.md) before restructuring anything under `src/`, and [`docs/plugin-development.md`](docs/plugin-development.md) before changing anything that touches Cordis/DSH extension points.

## Commands

```sh
pnpm install
pnpm run build       # tsc -> dist/host/**, esbuild -> dist/client.js
pnpm run typecheck    # host + client, no emit
pnpm run test         # tsc -> .test-build, node --test
pnpm run verify        # build + typecheck + test, in that order — the full self-check
pnpm run clean          # remove dist/ and .test-build/
```

## Every change ends with the full self-verification flow

There is no partial-check shortcut for a change that touches `src/`. Before considering any change done:

1. **`pnpm run verify`** (build + typecheck + test) must pass with no errors and no failing tests.
2. If the change touches `src/host/**`, `src/shared/**`, or a pure-logic client module (`src/client/{constants,format,json-model,sse}.ts`, `src/client/sse-merge/**`): add or update the matching file under `test/` in the **same change** — see "Test coverage is mandatory for pure logic" below. Do not land a logic change and a test change as separate steps.
3. If the change touches `src/client/sse-merge/**` (a new or modified provider-format adapter): additionally smoke-test against at least one **real** captured record, not only synthetic fixtures. Connect to a running `dsh web`, fetch a real record from `/llm-wire-trace/list` and `/llm-wire-trace/get`, and feed its `response.bodyText` through the compiled `dist` modules directly (`node -e "import('./dist/...').then(...)"`). Synthetic test fixtures are deliberately minimal and have already missed field combinations real provider traffic exposes — see the regression test in `test/client/sse-merge/index.test.ts` for the exact bug this caught once (a `message` item's own `id` being misread as a tool-call id).
4. If the change alters any behavior the READMEs describe: update **both** `README.md` and `README.zh.md` in the same change, then refresh `README.i18n.yaml`:
   ```sh
   git hash-object README.md README.zh.md   # paste the two hashes into README.i18n.yaml
   ```
5. If the change alters a module's responsibility or the boundary between modules: update `docs/architecture.md` and `docs/architecture.zh.md`.
6. If the change alters how this plugin uses a Cordis/DSH extension point (a new service dependency, a new event, a new Slot): update `docs/plugin-development.md` and `docs/plugin-development.zh.md`.

A change that only touches `docs/`, `AGENTS.md`, or comments needs `pnpm run typecheck` at most — `pnpm run verify` is for anything that changes `src/` behavior.

## Module boundaries (see `docs/architecture.md` for the full explanation)

- **Framework glue lives in exactly one file per half**: `src/host/index.ts` (Cordis: `ctx.effect`, `ctx.on`, `ctx.get`) and `src/client/entry.ts` (`window.__ModuleLoader__`, Cordis Slots). Every other module must stay plain TypeScript with no Cordis/`window` dependency — that is what makes it directly unit-testable. Adding a Cordis or `window.__ModuleLoader__` reference to any other module is a regression; extract the new capability into `index.ts`/`entry.ts` instead and call into the plain module from there.
- **A new SSE provider format gets its own file** under `src/client/sse-merge/`, registered in `index.ts`'s `ADAPTER_FACTORIES` array. Do not add provider-specific branching to an existing adapter file or to `index.ts` itself.
- **`src/host/persistence/` stays three-way split**: `naming.ts` (filename generation, no I/O), `codec.ts` (record ⇄ disk-JSON conversion, no I/O), `archive.ts` (the actual file I/O, built on the two above). A change to naming or codec logic must not require touching `archive.ts`, and vice versa.
- **The host does not import `@deepseek-ai/cordis`.** It declares its own minimal `PluginContext` structural type in `src/host/index.ts` (see the doc comment on that interface) so the published package carries no host-runtime type dependency. Do not "fix" this by adding the real import.
- **`src/shared/record-shape.ts` is type-only.** It must never gain a runtime export — the client bundle imports it purely as `import type`, and any runtime code there would silently inflate `dist/client.js`.

## Test coverage is mandatory for pure logic

Every module listed as testable in `docs/architecture.md` (all of `src/host/**`, `src/shared/**`, and the DOM-free client modules: `constants.ts`, `format.ts`, `json-model.ts`, `sse.ts`, `sse-merge/**`) has a corresponding file under `test/`, mirroring the `src/` path. Adding a new file to any of those directories means adding its test file in the same change; adding a new exported function to an existing file means adding its test cases to the existing test file.

**Deliberately excluded from unit tests** — do not add jsdom or any other DOM-emulation dependency to force coverage here; this is a considered choice, not a gap:

- `src/host/index.ts`, `src/client/entry.ts` — pure Cordis/`ModuleLoader` glue; verified by `pnpm run typecheck` and `pnpm run build` succeeding, not by mocking an entire Cordis `Context`.
- `src/client/api-client.ts`, `src/client/styles.ts`, `src/client/json-view.ts`, `src/client/wire-trace-view.ts` — depend on real DOM/React. Verify these by hand using the "fake React + fake `window.__ModuleLoader__` + real compiled `dist/client.js`" pattern already exercised in this project's development history: build a minimal `ReactLike` object with `useState`/`useEffect`/etc. as plain JS, capture the factory's exports, and call `apply(ctx)` with a fake `ctx`. State the exact steps taken when reporting the change.

## Releasing

Staging is automated by [`.github/workflows/release.yml`](.github/workflows/release.yml): pushing a `vX.Y.Z` tag (the same `git tag -a vX.Y.Z -m "..."` convention every release commit already uses) triggers `pnpm run verify`, then `npm stage publish` (via npm's Trusted Publisher OIDC flow — no token; the existing `prepublishOnly` script still builds `dist/` fresh from that exact tagged commit), then creates a matching GitHub Release **marked as a pre-release** with the `npm pack` tarball attached. The workflow fails closed before staging if `pnpm run verify` fails, or if the tag doesn't match `package.json`'s `version`.

The npm Trusted Publisher for this package is configured **stage-only** (no "publish directly" permission) — this is deliberate, not a temporary state to later relax. `npm publish` from CI would be rejected outright; only `npm stage publish` is accepted. **A maintainer must separately approve the staged version on npmjs.com (2FA required) before it actually becomes installable** — that manual step is the whole point: even a compromised workflow or repository can only get a malicious version as far as the stage queue, never onto the registry, without a human's explicit approval. After approving, edit the GitHub Release and uncheck "pre-release" so it reads as the real, installable release.

A version bump is still a manual decision: edit `package.json`'s `version`, commit as `Release vX.Y.Z: <summary>` (this commit message becomes the GitHub Release body verbatim), tag, and push the tag. Do not run `npm publish`/`npm stage publish` by hand except to recover from a CI outage — and even then, run `pnpm run verify` first.

## Hard constraints (do not undo these deliberately-made decisions)

- **npm is the only install path that gets a build for free.** `prepublishOnly` (`pnpm run clean && pnpm run build`) runs as part of `npm stage publish`/`npm publish`, so the tarball npm receives always carries a fresh `dist/` built from the exact source being staged. Do **not** add a `prepare` script to try to extend this to git-spec/`link:` installs: pnpm ≥10 requires an explicit `allowBuilds` approval before a git dependency's `prepare` script may run at all, which reopens exactly the "permission to execute this package's code on your machine at install time" prompt this project avoids. A git checkout or local `link:` install gets source only and must run `pnpm run build` itself — see the README's "Install" section for the exact steps that path documents to users.
- **`dist/` and `.test-build/` are gitignored build artifacts, not repository content.** Never commit them and never remove them from `.gitignore` — regenerate with `pnpm run build` (or let `prepublishOnly` regenerate `dist/` when staging). A stale committed `dist/` would silently diverge from `src/` the moment someone forgot to rebuild before committing; not tracking it removes that failure mode entirely.
- **`README.md` and `README.zh.md` are a hard-synced pair.** Never edit one without the other, and never let `README.i18n.yaml`'s recorded hashes go stale — a mismatch there means a translation gap slipped through review.
- **Bodies are stored verbatim in `src/host/persistence/`.** Do not add any transformation that summarizes, redacts beyond `authorization`, or otherwise mutates a captured request/response body before it reaches disk; that guarantee (see the main README's "Persistence" section) is what makes the curl-replay feature and the merged-SSE view trustworthy.
- **The release workflow is the only thing that stages an npm release, and the npm Trusted Publisher stays stage-only.** Do not add a second publish path (a different workflow, a script a contributor runs locally as routine practice), and do not flip the Trusted Publisher's npmjs.com configuration to allow direct `npm publish` from CI — the human approval step on npmjs.com is the deliberate control that limits what a compromised workflow or repository could actually ship.

## Editing this file

`AGENTS.md` has no Chinese counterpart by design — unlike the READMEs and `docs/`, it is not user-facing product documentation, and is expected to be read primarily by tooling and English-first contributors. Keep this file scoped to what an agent needs to decide *where a change goes* and *how to verify it*; move anything that explains *why* a design choice was made into `docs/architecture.md` or the module's own doc comment, and link to it instead of duplicating it here.
