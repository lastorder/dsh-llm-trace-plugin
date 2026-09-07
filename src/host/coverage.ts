/**
 * Coverage health tracker: a cheap, in-memory counter of captured calls per
 * provider, so a reader can tell "this provider produced zero captures"
 * apart from "this provider is simply quiet right now" — the difference
 * between an assumed-complete trace and a verified one.
 *
 * This exists because the fetch patch's coverage is only as good as the
 * `globalThis.fetch` slot it patched staying the ACTIVE one for the whole
 * process lifetime (see fetch-patch.ts's module doc and the README's "Known
 * limitation" section): a later `import('undici')`/dispatcher swap, or a
 * second fetch-patching plugin, can silently steal the slot with no error at
 * all. There is no way to detect that failure mode from the inside — but a
 * provider that should be producing traffic and shows zero captures is the
 * practical, verifiable symptom of it.
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
  calls: number
  attributedCalls: number
  lastSeenAt: number
}

export interface CoverageSnapshot {
  since: number
  providers: ProviderCoverage[]
}

export interface CoverageTracker {
  /**
   * Record one captured call.
   * @param providerKey - see {@link providerKeyForRecord}; the bucket this call counts against.
   * @param attributed - whether this call carried real harness coordinates (came through `ctx.llm`).
   */
  record(providerKey: string, attributed: boolean): void
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

/** Create a fresh, empty coverage tracker. */
export function createCoverageTracker(): CoverageTracker {
  const since = Date.now()
  const providers = new Map<string, ProviderCoverage>()

  return {
    record(providerKey, attributed) {
      const entry = providers.get(providerKey) ?? {
        provider: providerKey,
        calls: 0,
        attributedCalls: 0,
        lastSeenAt: 0,
      }
      entry.calls += 1
      if (attributed) entry.attributedCalls += 1
      entry.lastSeenAt = Date.now()
      providers.set(providerKey, entry)
    },

    snapshot() {
      return {
        since,
        // Busiest provider first — the common reading order for a health
        // check ("what fired the most") — ties broken by name for a stable
        // display order across snapshots.
        providers: [...providers.values()].sort((a, b) =>
          b.calls !== a.calls ? b.calls - a.calls : a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0),
      }
    },
  }
}
