/**
 * Async-context channel carrying the harness identity of the model call
 * currently in flight, so the patched `fetch` can stamp a wire record with
 * coordinates that never appear on the wire itself.
 *
 * Written by `bindLlmStream` (the `llm/stream` waterfall listener), read by
 * the fetch patch in fetch-patch.ts. Empty for any request not made through
 * `ctx.llm`.
 *
 * @module dsh-llm-trace-plugin/host/call-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { StepTracker } from './step-tracker.js'

export interface CallIdentity {
  sessionId: string | null
  turn: number | null
  step: number | null
  purpose: string | null
  provider: string | null
  model: string | null
}

export const callContext = new AsyncLocalStorage<CallIdentity>()

/** Minimal shape of the `llm/stream` waterfall's `options` argument. */
export interface LlmStreamOptions {
  sessionId?: string | number
  provider?: string
  model?: string
  purpose?: string
}

/** An async-iterable stream, as produced and consumed by the `llm/stream` waterfall. */
export type AsyncStream<T> = AsyncIterable<T>

/**
 * Bind one `llm/stream` call to its own async-context branch, so the
 * adapter's `fetch` — which happens on the first pull — observes exactly the
 * context of its own call, and nothing else.
 *
 * Re-enters the context on EVERY pull, not just around the construction of
 * the returned iterable: an async generator's body runs on the consumer's
 * tick, so binding only the construction would leave the context gone by the
 * time the body actually ran.
 *
 * A purposed call (background title generation, compaction) is NOT part of
 * the conversation loop even when it happens to overlap a live turn on the
 * same session, so it deliberately takes no turn/step. Letting it inherit the
 * ambient turn is precisely the misattribution this design exists to avoid.
 *
 * @param options - the waterfall's call options.
 * @param next - the waterfall's `next()`, producing the inner stream.
 * @param tracker - the session step tracker to read the open turn/step from.
 */
export function bindLlmStream<T>(
  options: LlmStreamOptions,
  next: () => AsyncStream<T>,
  tracker: StepTracker,
): AsyncStream<T> {
  const sessionId = options.sessionId === undefined ? null : String(options.sessionId)
  const purpose = options.purpose ?? null
  // Read the OPEN step at call time, not at chunk time: by the time later
  // chunks arrive the step may already have closed.
  const at = sessionId === null || purpose !== null
    ? { turn: null, step: null }
    : tracker.current(sessionId)
  const bound: CallIdentity = {
    sessionId,
    turn: at.turn,
    step: at.step,
    purpose,
    provider: options.provider ?? null,
    model: options.model ?? null,
  }

  const inner = next()

  return (async function* boundStream() {
    const iterator = inner[Symbol.asyncIterator]()
    try {
      while (true) {
        const result = await callContext.run(bound, () => iterator.next())
        if (result.done) return
        yield result.value
      }
    } finally {
      // Propagate early consumer termination to the wrapped stream, so
      // aborting a turn still tears the provider stream down.
      if (typeof iterator.return === 'function') {
        await callContext.run(bound, () => iterator.return!(undefined))
      }
    }
  })()
}
