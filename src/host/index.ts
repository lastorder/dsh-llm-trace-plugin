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
import { createWireTraceStore } from './store.js'
import { createRouteHandler } from './routes.js'
import { installFetchPatch } from './fetch-patch.js'
import { createRecordArchive } from './persistence/archive.js'
import type { CredentialProvider } from './curl.js'

export { createStepTracker } from './step-tracker.js'
export { createWireTraceStore } from './store.js'
export { buildRecordName, createRecordArchive } from './persistence/index.js'

export interface PluginConfig {
  maxRecords?: number
  maxBodyChars?: number
  routePrefix?: string
  persist?: boolean
  traceDir?: string
  maxPersistedRecords?: number
  historyPageLimit?: number
  prettyBodyLimit?: number
}

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
  webServer: {
    register(route: { kind: 'prefix', path: string, handler: (req: any, res: any) => Promise<void> }): () => void
  }
}

export const name = 'llm-trace-plugin'
export const inject = ['webServer']

export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const settings = config ?? {}
  const routePrefix = typeof settings.routePrefix === 'string' ? settings.routePrefix : '/llm-wire-trace'

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

  const store = createWireTraceStore({ ...settings, archive })

  // Deliberately NOT loading disk records into the in-memory ring. The list
  // already merges memory and disk, so preloading would only duplicate what
  // the merge provides — and it was what made an earlier "live vs history"
  // toggle show identical content in both modes.
  if (archive !== null) {
    void archive.sweepTemp().catch(() => {})
  }

  ctx.effect(() => installFetchPatch((real) => store.wrapFetch(real)), 'llm-wire-trace: fetch patch')

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
  if (ctx.get('sessions') !== undefined) {
    ctx.on('session/event', (session: { id: unknown }, event: any) => {
      try {
        tracker.observe(String(session.id), event)
      } catch {
        // Observation must never destabilize the session feed.
      }
    })
    ctx.on('session/disposed', (session: { id: unknown }) => {
      try {
        tracker.forget(String(session.id))
      } catch {
        // ignore
      }
    })
  }

  // Bind each model call's identity to its own async-context branch.
  if (ctx.get('llm') !== undefined) {
    ctx.on('llm/stream', (options: LlmStreamOptions, next: () => AsyncIterable<unknown>) =>
      bindLlmStream(options, next, tracker))
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: routePrefix,
      handler: createRouteHandler({
        store,
        routePrefix,
        getCredentials: () => ctx.get('credentials') as CredentialProvider | undefined,
      }),
    }),
  )

  console.log('llm-wire-trace: fetch patched, listening on /llm-wire-trace')
}
