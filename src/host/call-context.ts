/**
 * Async-context channel carrying the harness identity of the model call
 * currently in flight, so the patched `fetch` can stamp a wire record with
 * coordinates that never appear on the wire itself.
 *
 * Written by `bindLlmStream` (the `llm/stream` waterfall listener), read by
 * the fetch patch in fetch-patch.ts. Empty for any request not made through
 * `ctx.llm`.
 *
 * The identity also carries a mutable per-call receipt (see
 * {@link CallObservation}), which turns this module into the place where
 * "this model call was seen" and "a request for it was captured" meet: that
 * is what lets `coverage.ts` report a provider whose model calls never reach
 * the fetch patch at all.
 *
 * @module dsh-llm-trace-plugin/host/call-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { StepTracker } from './step-tracker.js'

/**
 * Mutable per-call receipt of what the fetch patch actually captured.
 *
 * It rides on {@link CallIdentity} rather than living in a side map so the
 * fetch patch needs ONE lookup (`callContext.getStore()`) to learn both who is
 * calling and whether anything has been captured for them yet.
 *
 * A receipt that stays at zero is the one failure this plugin cannot observe
 * from the fetch side at all — the request never reached the patch, so no
 * record and no error exist to inspect — which is why the settled call below
 * reports it.
 */
export interface CallObservation {
  /** Requests captured inside this call's async context so far. */
  requests: number
}

export interface CallIdentity {
  sessionId: string | null
  turn: number | null
  step: number | null
  purpose: string | null
  provider: string | null
  model: string | null
  /** See {@link CallObservation}. */
  observation: CallObservation
}

/**
 * One `llm/stream` call, reported once when its stream settles: drained,
 * errored, or abandoned by the consumer.
 */
export interface SettledCall {
  sessionId: string | null
  purpose: string | null
  provider: string | null
  model: string | null
  /**
   * Captured requests issued inside this call. `0` means no request belonging
   * to this call reached this plugin — either that adapter's transport
   * bypasses `globalThis.fetch` entirely, or the call never went to the wire.
   */
  requests: number
}

/** Receives one {@link SettledCall} per model call; see {@link bindLlmStream}. */
export type CallObserver = (call: SettledCall) => void

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
 * @param observer - optional sink for this call's settle report; see
 *   {@link SettledCall}. It runs exactly once per call whose stream was
 *   actually pulled, and never at all for a call whose stream was created and
 *   then abandoned — nothing was sent on the wire in that case either.
 */
export function bindLlmStream<T>(
  options: LlmStreamOptions,
  next: () => AsyncStream<T>,
  tracker: StepTracker,
  observer?: CallObserver,
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
    observation: { requests: 0 },
  }

  const inner = next()

  return (async function* boundStream() {
    const iterator = inner[Symbol.asyncIterator]()
    let reported = false
    /**
     * Report the settled call, at most once, and never let the report break
     * the stream: it is a health signal about the capture, not part of the
     * model call. Same stance as the `session/event` listener in index.ts.
     */
    const report = () => {
      if (reported) return
      reported = true
      try {
        observer?.({
          sessionId: bound.sessionId,
          purpose: bound.purpose,
          provider: bound.provider,
          model: bound.model,
          requests: bound.observation.requests,
        })
      } catch {
        // Observation must never destabilize the model stream.
      }
    }
    try {
      while (true) {
        const result = await callContext.run(bound, () => iterator.next())
        if (result.done) return
        yield result.value
      }
    } finally {
      // Report BEFORE tearing the inner stream down: an adapter that aborts
      // its own transport in `return()` cannot then be mistaken for one that
      // never reached the wire.
      report()
      // Propagate early consumer termination to the wrapped stream, so
      // aborting a turn still tears the provider stream down.
      if (typeof iterator.return === 'function') {
        await callContext.run(bound, () => iterator.return!(undefined))
      }
    }
  })()
}
