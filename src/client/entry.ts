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
 * @module dsh-llm-trace-plugin/client/entry
 */

import { insertStyles } from './styles.js'
import { createWireTraceView, type WireTraceReact, type ViewContext } from './wire-trace-view.js'

declare const window: any

/** Minimal shape of a CommonJS-style `require` the module loader hands the factory. */
type Require = (id: string) => any

/** Minimal shape of the client `slots` service this plugin registers into. */
interface SlotsService {
  inject(name: string, register: () => (() => void)): void
  register(meta: { name: string, id: string, priority?: number, order?: number, label: () => string }, component: any): () => void
}

/** Minimal shape of the plugin root context. */
interface RootContext {
  effect<T>(fn: () => T, label?: string): T
  slots: SlotsService
}

window.__ModuleLoader__.load({
  id: 'dsh-llm-trace-plugin',
  factory: (require: Require) => {
    const module = { exports: {} as any }

    const React: WireTraceReact = require('react')

    const inject = ['slots', 'timer']

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
      const WireTraceView = createWireTraceView(React, ctx)
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
