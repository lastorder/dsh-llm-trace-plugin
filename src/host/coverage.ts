/**
 * Coverage health tracker: a cheap, in-memory counter of captured calls and of
 * model calls seen per provider, so a reader can tell "this provider produced
 * zero captures" apart from "this provider is simply quiet right now" — the
 * difference between an assumed-complete trace and a verified one.
 *
 * The two halves answer the question from opposite sides, and BOTH are needed:
 *
 *   - `record()` counts wire records that WERE captured (fed by the store's
 *     `push`). A provider you know is busy that shows zero captures here is the
 *     observable symptom of this patch having lost the `globalThis.fetch` slot
 *     to a later `import('undici')`/dispatcher swap or to a second
 *     fetch-patching plugin (see fetch-patch.ts's module doc and the README's
 *     "Known limitation" section). There is no way to detect that from inside
 *     the patch — the swap happens silently.
 *   - `recordModelCall()` counts model calls the HARNESS started (fed by
 *     `llm/stream` settling), and how many of them produced no captured request
 *     at all. This is what covers the provider whose transport never reaches
 *     `globalThis.fetch` in the first place (an SDK handed a `fetch` snapshot
 *     taken at module-evaluation time): such a provider does not appear as
 *     "zero captures", it appears as model calls with nothing to show for them,
 *     which is a signal the capture side alone can never produce.
 *
 * Process-lifetime only, deliberately not persisted and NOT reset by
 * `store.clear()`: clearing trace history is a different operation from
 * resetting a coverage signal, and re-zeroing counts on every "清空" click
 * would make the signal useless for exactly the session that just generated
 * it.
 *
 * @module dsh-llm-trace-plugin/host/coverage
 */

export interface ProviderCoverage {
  provider: string
  /** Wire records captured for this bucket since process start. */
  calls: number
  /** Of {@link calls}, how many carried real harness coordinates. */
  attributedCalls: number
  /** Model calls the harness started for this provider (one per `llm/stream`). */
  modelCalls: number
  /**
   * Of {@link modelCalls}, how many settled with NO captured request — either
   * that provider's transport bypasses the fetch patch, or the call never went
   * to the wire (replay, an early failure, an abandoned stream is not counted
   * at all).
   */
  untracedCalls: number
  lastSeenAt: number
}

export interface CoverageSnapshot {
  since: number
  providers: ProviderCoverage[]
}

/** What {@link CoverageTrackerOptions.onFirstUntracedCall} reports. */
export interface UntracedModelCallNotice {
  provider: string
  /** The route's model id, when the call named one. */
  model: string | null
  /** Untraced model calls for this provider so far, including this one. */
  untracedCalls: number
}

export interface CoverageTrackerOptions {
  /**
   * Called once per provider, on its FIRST model call that reaches no captured
   * request. Once — not per call — because the point is to name a provider
   * whose traffic this plugin cannot see, and a busy one would otherwise repeat
   * the same line forever. Never throws into the caller.
   */
  onFirstUntracedCall?: (notice: UntracedModelCallNotice) => void
}

export interface CoverageTracker {
  /**
   * Record one captured call.
   * @param providerKey - see {@link providerKeyForRecord}; the bucket this call counts against.
   * @param attributed - whether this call carried real harness coordinates (came through `ctx.llm`).
   */
  record(providerKey: string, attributed: boolean): void
  /**
   * Record one settled model call.
   * @param providerKey - see {@link providerKeyForModelCall}.
   * @param traced - whether any request belonging to that call was captured.
   * @param model - the route's model id, for the untraced notice.
   */
  recordModelCall(providerKey: string, traced: boolean, model?: string | null): void
  snapshot(): CoverageSnapshot
}

/**
 * Derive the coverage bucket key for one captured record: the harness-
 * resolved provider name when attributed (the same value the record already
 * shows as `provider`), falling back to the request URL's hostname when not
 * — so an unattributed call (never routed through `ctx.llm`) is still
 * bucketed usefully instead of vanishing into one undifferentiated total.
 * A URL this plugin cannot parse at all (should not happen for a real fetch
 * call) buckets under the literal `'unknown'` key, so every captured call is
 * still counted somewhere and the totals never silently under-report.
 */
export function providerKeyForRecord(provider: string | null, url: string): string {
  if (provider !== null && provider.length > 0) return provider
  try {
    return new URL(url).hostname || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Derive the coverage bucket key for one model call. There is no URL to fall
 * back to here — `llm/stream` names the provider — so a call that somehow
 * carries none buckets under `'unknown'`, which is itself worth seeing rather
 * than dropping.
 */
export function providerKeyForModelCall(provider: string | null): string {
  return provider !== null && provider.length > 0 ? provider : 'unknown'
}

/** Create a fresh, empty coverage tracker. */
export function createCoverageTracker(options?: CoverageTrackerOptions): CoverageTracker {
  const since = Date.now()
  const providers = new Map<string, ProviderCoverage>()
  const notified = new Set<string>()

  function bucket(providerKey: string): ProviderCoverage {
    const existing = providers.get(providerKey)
    if (existing !== undefined) return existing
    const created: ProviderCoverage = {
      provider: providerKey,
      calls: 0,
      attributedCalls: 0,
      modelCalls: 0,
      untracedCalls: 0,
      lastSeenAt: 0,
    }
    providers.set(providerKey, created)
    return created
  }

  return {
    record(providerKey, attributed) {
      const entry = bucket(providerKey)
      entry.calls += 1
      if (attributed) entry.attributedCalls += 1
      entry.lastSeenAt = Date.now()
    },

    recordModelCall(providerKey, traced, model = null) {
      const entry = bucket(providerKey)
      entry.modelCalls += 1
      if (!traced) {
        entry.untracedCalls += 1
        if (!notified.has(providerKey)) {
          notified.add(providerKey)
          try {
            options?.onFirstUntracedCall?.({
              provider: providerKey,
              model: model === null || model.length === 0 ? null : model,
              untracedCalls: entry.untracedCalls,
            })
          } catch {
            // A health signal must never break the call it reports on.
          }
        }
      }
      entry.lastSeenAt = Date.now()
    },

    snapshot() {
      return {
        since,
        // Untraced model calls first — that is the row a reader is looking for
        // when capture looks broken — then busiest captured provider, ties
        // broken by name so the order is stable across snapshots. A healthy
        // process has no untraced calls at all, so this reduces exactly to the
        // previous busiest-first order.
        providers: [...providers.values()].sort((a, b) =>
          b.untracedCalls !== a.untracedCalls
            ? b.untracedCalls - a.untracedCalls
            : b.calls !== a.calls
              ? b.calls - a.calls
              : a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
      }
    },
  }
}
