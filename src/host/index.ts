/**
 * @deepseek-ai/dsh LLM wire trace plugin — host half.
 *
 * Captures the literal HTTP request and response every LLM provider call
 * makes, by patching the process-global `fetch`. This observes a lower layer
 * than a harness-level tracer would: instead of the normalized
 * `GenerateOptions` / `StreamChunk` objects the harness builds
 * (provider-neutral, session/turn aware), it observes the actual bytes on the
 * wire (provider-native JSON field names, raw SSE frames).
 *
 * Those bytes carry almost no harness identity — `dsh-llm-deepseek` puts the
 * session id on the wire and nothing else, and `dsh-llm-pi-ai` puts nothing at
 * all. So the harness coordinates a reader actually wants (which turn? which
 * step? was this a real conversation call or a background title generation?)
 * are ATTACHED here rather than read off the wire, by observing two harness
 * channels and binding them to the exact call in flight:
 *
 *   - `llm/stream` — the waterfall around every model call (see
 *     `call-context.ts`). Its `options` carries `sessionId`, `provider`,
 *     `model`, and `purpose`. The listener pulls the inner stream inside an
 *     `AsyncLocalStorage.run`, ON EVERY PULL, so the adapter's `fetch` — which
 *     happens on the first pull — observes exactly the context of its own
 *     call.
 *   - `session/event` — `step/start` / `step/end` / `turn/start` / `turn/end`
 *     give the current turn and step per session (see `step-tracker.ts`).
 *
 * The binding is exact, not a time-window guess: concurrent calls (a live turn
 * plus a background `session-title` request on the SAME session) each see
 * their own context, because each rides its own async-context branch. A call
 * that reaches the wire with no such context — anything not made through
 * `ctx.llm` — is recorded with null coordinates and reported as unattributed,
 * never assigned a plausible-looking owner.
 *
 * This ONLY works as an installed package; see `fetch-patch.ts` for why.
 *
 * @module dsh-llm-trace-plugin
 */

import { createStepTracker } from './step-tracker.js'
import { bindLlmStream, type LlmStreamOptions } from './call-context.js'
import { ROUTE_PREFIX } from './constants.js'
import { createWireTraceStore } from './store.js'
import { createRouteHandler, type ConfigEditorLike, type LoaderEntryLike } from './routes.js'
import { installFetchPatch } from './fetch-patch.js'
import { createRecordArchive } from './persistence/archive.js'
import type { CredentialProvider } from './curl.js'
import { Config, resolveEffectiveConfig, type PluginConfig } from './config.js'

export { createStepTracker } from './step-tracker.js'
export { createWireTraceStore } from './store.js'
export { buildRecordName, createRecordArchive } from './persistence/index.js'
export { Config, resolveEffectiveConfig, type PluginConfig, type ResolvedPluginConfig } from './config.js'

/**
 * Minimal shape this plugin needs from the Cordis context. The real `Context`
 * type from `@deepseek-ai/cordis` is intentionally not imported so this
 * package has no host-runtime type dependency; any object satisfying this
 * shape works.
 */
export interface PluginContext {
  effect<T>(fn: () => T, label?: string): T
  get(name: string): unknown
  on(event: string, handler: (...args: any[]) => any): void
  /**
   * Run `callback` once every named service exists, in a child fiber tied to
   * this plugin's own lifetime.
   *
   * This is how every service this plugin uses is reached — and deliberately
   * NOT through this plugin's own top-level `inject`, which would hold the
   * whole `apply()` back (see the note on {@link name}). Service-by-service
   * injection keeps a late or absent service from delaying the fetch patch,
   * while still degrading exactly as before when a service never arrives.
   */
  inject(deps: string[], callback: (ctx: PluginContext) => void): unknown
  webServer: {
    register(route: { kind: 'prefix', path: string, handler: (req: any, res: any) => Promise<void> }): () => void
  }
  /**
   * The Loader fiber owning this very `apply()` call, when the host exposes
   * one (every Cordis host does; a dynamic/test harness may not). Its
   * `entry` is what `ctx.get('configEditor')` needs to edit THIS plugin's
   * own row — see the `config` route in `routes.ts` for why that is safe:
   * it only ever targets the entry this exact `apply()` run was given.
   */
  fiber?: { entry?: LoaderEntryLike }
}

export const name = 'llm-trace-plugin'

/**
 * NOTE: this plugin deliberately declares NO top-level `inject`.
 *
 * A Cordis fiber with injected services stays INACTIVE until every one of
 * them exists, so `apply()` — and therefore `installFetchPatch()` — would wait
 * for the `webServer` service. What that costs is not a few microseconds: the
 * Loader starts every entry concurrently at mount and imports an entry's
 * module when that entry starts, so by the time a gated `apply()` runs, the
 * modules of ALL other entries have usually finished evaluating. Any provider
 * plugin that reads `globalThis.fetch` once at module-evaluation time (see the
 * README's "Known limitation") has already snapshotted the UNPATCHED fetch by
 * then, and this plugin can never see its traffic — in the case this was
 * diagnosed on, the patch landed ~400 ms after the tree mounted, long after
 * the snapshotting provider's module body had run.
 *
 * So the patch is installed first and unconditionally, and each service is
 * reached through `ctx.inject([...])` where it is actually needed.
 */
export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const settings = config ?? {}

  // Durable half. On by default — surviving a restart is the entire point —
  // but fully switchable off with `persist: false`, which returns the plugin
  // to a pure in-memory ring that writes nothing to disk.
  //
  // NOTE: request and response bodies are stored VERBATIM, so prompts, code,
  // and any file contents in context land in plaintext files under this
  // directory. That is inherent to persisting full bodies; `persist: false`
  // or a shorter `maxPersistedRecords` are the levers.
  const archive = settings.persist === false ? null : createRecordArchive({
    dir: settings.traceDir,
    maxRecords: settings.maxPersistedRecords,
    pageLimit: settings.historyPageLimit,
    prettyBodyLimit: settings.prettyBodyLimit,
    onError: (error) => console.warn('llm-wire-trace: persistence error:', error.message),
  })

  const store = createWireTraceStore({
    ...settings,
    archive,
    // A model call that reaches NO captured request is the one failure this
    // plugin cannot see from the fetch side: the request never entered the
    // patch, so there is no record, no error, and nothing on disk to notice.
    // Say it out loud — once per provider — instead of serving a silently
    // empty trace. See `coverage.ts` and the README's "Known limitation".
    onUntracedModelCall: (notice) => console.warn(
      `llm-wire-trace: model call for provider "${notice.provider}"`
      + (notice.model === null ? '' : ` (model "${notice.model}")`)
      + ' reached no captured request. Either that provider\'s transport bypasses globalThis.fetch'
      + ' (e.g. it snapshotted the fetch slot at import time and injects it into its SDK),'
      + ' or the call never went to the wire. See the README\'s "Known limitation" section;'
      + ' GET /llm-wire-trace/stats shows the per-provider counts.',
    ),
  })

  // The patch goes in before anything else this plugin does — including the
  // startup sweep below — because installing it is the one thing that has to
  // happen before another plugin's module body can run. See the note on
  // `name` above.
  ctx.effect(() => installFetchPatch((real) => store.wrapFetch(real)), 'llm-wire-trace: fetch patch')

  // Deliberately NOT loading disk records into the in-memory ring. The list
  // already merges memory and disk, so preloading would only duplicate what
  // the merge provides — and it was what made an earlier "live vs history"
  // toggle show identical content in both modes.
  if (archive !== null) {
    void archive.sweepTemp().catch(() => {})
  }

  // ------------------------------------------------------------------
  // Harness-coordinate correlation (turn / step / purpose / provider).
  //
  // Nothing here modifies dsh: both channels are ordinary, publicly
  // documented plugin extension points, and both are strictly observational.
  // The `llm/stream` listener is a waterfall member that MUST pass the stream
  // through untouched — it yields exactly the chunks it receives, in order,
  // and adds only an async-context binding around each pull.
  // ------------------------------------------------------------------

  const tracker = createStepTracker()

  // Follow turn/step boundaries. Optional service: with no `sessions` service
  // the plugin still records everything, just without turn/step coordinates.
  ctx.inject(['sessions'], (sessions) => {
    sessions.on('session/event', (session: { id: unknown }, event: any) => {
      try {
        tracker.observe(String(session.id), event)
      } catch {
        // Observation must never destabilize the session feed.
      }
    })
    sessions.on('session/disposed', (session: { id: unknown }) => {
      try {
        tracker.forget(String(session.id))
      } catch {
        // ignore
      }
    })
  })

  // Bind each model call's identity to its own async-context branch, and hand
  // the call's receipt to the store when it settles. The receipt is how a
  // provider whose transport never reaches this patch stops being invisible:
  // `requests === 0` for a call the harness definitely made is a diagnosis,
  // not a guess.
  ctx.inject(['llm'], (llm) => {
    llm.on('llm/stream', (options: LlmStreamOptions, next: () => AsyncIterable<unknown>) =>
      bindLlmStream(options, next, tracker, (call) => {
        store.recordModelCall(call.provider, call.requests > 0, call.model)
      }))
  })

  ctx.inject(['webServer'], (web) => {
    web.effect(() =>
      web.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: createRouteHandler({
          store,
          routePrefix: ROUTE_PREFIX,
          // Still read off the OUTER context: `ctx.fiber` is this plugin's own
          // Loader entry, which is what `configEditor` needs. The injected
          // context would report the throwaway child fiber instead.
          getCredentials: () => ctx.get('credentials') as CredentialProvider | undefined,
          // Live config editing (the "Clear all history" button's neighboring
          // parameter form; see `plugin-manage-view.ts`) needs both: the
          // generic profile-config writer service, and the EXACT Loader entry
          // this `apply()` run belongs to, so a write can only ever retarget
          // this plugin's own row. Either being absent (a non-Cordis host, or
          // one with no configEditor plugin loaded) degrades to a read-only
          // report rather than failing the whole route table.
          getConfigEditor: () => ctx.get('configEditor') as ConfigEditorLike | undefined,
          getSelfEntry: () => ctx.fiber?.entry,
          currentConfig: () => resolveEffectiveConfig(config) as unknown as Record<string, unknown>,
          schema: Config,
        }),
      }),
    )
    console.log(`llm-wire-trace: serving ${ROUTE_PREFIX}`)
  })

  console.log('llm-wire-trace: fetch patched')
}
