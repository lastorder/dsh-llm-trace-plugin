/**
 * @deepseek-ai/dsh LLM wire trace plugin — browser half entry point.
 *
 * Registers a "Wire Trace" tab in the session view ring, listing the literal
 * HTTP request/response of every LLM provider call (provider-native JSON
 * field names, raw SSE frames) captured by the host half's `globalThis.fetch`
 * patch. No harness concepts here (no sessionId/turn/step) — this is the wire
 * layer, not the harness-level view a `GenerateOptions`/`StreamChunk` tracer
 * shows.
 *
 * Compiled to the client-bundle wire format: a classic script that only
 * REGISTERS a factory via `window.__ModuleLoader__.load`; the body runs at
 * materialization. No JSX at the source level either — every element is built
 * through `React.createElement`, matching the runtime constraint that this
 * file is loaded as-is, with no bundler-driven JSX transform.
 *
 * Locale: this is the ONE file that binds `strings.ts`'s bilingual
 * dictionaries to DSH's own `@deepseek-ai/dsh-client-locale` service
 * (`ctx.locale`) — the same "framework glue lives in exactly one file per
 * half" rule this file already follows for Slots. Every other client module
 * receives a plain `t(key, params?)` function as a parameter and has no idea
 * `ctx.locale` exists, so the tab's language now follows DSH's own Settings →
 * General → Language switch instead of always rendering Chinese.
 *
 * @module dsh-llm-trace-plugin/client/entry
 */

import { insertStyles } from './styles.js'
import { createWireTraceView, type WireTraceReact, type ViewContext } from './wire-trace-view.js'
import { zh, en } from './strings.js'

declare const window: any

/** Minimal shape of a CommonJS-style `require` the module loader hands the factory. */
type Require = (id: string) => any

/** Minimal shape of the client `slots` service this plugin registers into. */
interface SlotsService {
  inject(name: string, register: () => (() => void)): void
  register(meta: { name: string, id: string, priority?: number, order?: number, label: () => string }, component: any): () => void
}

/** Translate a dictionary key with optional `{name}` template params. */
type Translate = (key: string, params?: Record<string, unknown>) => string

/** Minimal shape of the client `locale` service (`@deepseek-ai/dsh-client-locale`). */
interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): Translate
  subscribe(fn: () => void): () => void
}

/** Minimal shape of the plugin root context. */
interface RootContext {
  effect<T>(fn: () => T, label?: string): T
  slots: SlotsService
  locale: LocaleService
  interval(fn: () => void, ms: number): () => void
}

/**
 * Namespace this plugin registers its dictionaries under. Must not collide
 * with any other plugin's namespace; matches this plugin's own route prefix
 * slug for consistency (`ROUTE_PREFIX` in the host half's constants.ts).
 */
const NS = 'llm-wire-trace'

window.__ModuleLoader__.load({
  id: 'dsh-llm-trace-plugin',
  factory: (require: Require) => {
    const module = { exports: {} as any }

    const React: WireTraceReact = require('react')

    const inject = ['slots', 'timer', 'locale']

    /**
     * @param ctx - client root context.
     *
     * conversation.view sorts by priority first, order only as a tie-break;
     * the shipped Chat and Trajectory tabs carry no priority so they sit at
     * 0. priority: 100 with a slightly higher order than a harness-level
     * "API Trace" tab keeps a stable left-to-right order when such a plugin
     * is also installed: Chat, Trajectory, API Trace, Wire Trace.
     */
    function apply(ctx: RootContext & ViewContext) {
      ctx.effect(() => insertStyles(), 'llm-wire-trace: stylesheet')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'llm-wire-trace: locale dictionaries')
      // Bound once and reused: the locale service resolves the ACTIVE locale
      // at call time, so this single reference stays correct across a
      // language switch — nothing needs to re-bind when the user flips it.
      const t = ctx.locale.bind(NS)
      // Built as an object literal referencing `ctx` by closure, NOT a
      // `{ ...ctx }` spread: Cordis exposes services like `interval` through
      // the context's prototype chain, so a shallow spread (own enumerable
      // properties only) silently drops them, leaving `ctx.interval` (and
      // anything else the view needs from the real ctx) undefined at
      // runtime — the "not a function" crash this shape exists to avoid.
      const viewCtx: ViewContext = {
        interval: (fn: () => void, ms: number) => ctx.interval(fn, ms),
        t,
        subscribeLocale: (fn: () => void) => ctx.locale.subscribe(fn),
      }
      const WireTraceView = createWireTraceView(React, viewCtx)
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

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})

