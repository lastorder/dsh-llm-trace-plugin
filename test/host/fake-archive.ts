import type { RecordArchive } from '../../src/host/persistence/archive.js'
import { shouldPersist, toMeta } from '../../src/host/persistence/codec.js'
import type { WireRecord } from '../../src/shared/record-shape.js'

/**
 * An in-memory `RecordArchive` fake: no filesystem I/O at all, just a `Map`
 * keyed by record id. Exercises `store.ts`'s merge logic without making its
 * tests depend on `archive.ts`'s own (separately tested) disk behavior.
 */
export function createFakeArchive(options: { ready?: boolean } = {}): RecordArchive & { saved: WireRecord[], ready: boolean } {
  const byId = new Map<string, WireRecord>()
  const saved: WireRecord[] = []

  const fake = {
    dir: '/fake',
    maxDiskBytes: 1024 * 1024 * 1024,
    saved,
    ready: options.ready ?? true,
    async open() {},
    isReady() {
      return fake.ready
    },
    has(id: string) {
      return byId.has(id)
    },
    async save(record: WireRecord) {
      if (!shouldPersist(record)) return false
      byId.set(record.id, { ...record })
      saved.push(record)
      return true
    },
    async list(query?: { limit?: number, sessionId?: string }) {
      const wanted = query?.sessionId
      const all = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
      const matching = wanted ? all.filter((r) => r.sessionId === wanted) : all
      return { records: matching.slice(0, query?.limit ?? matching.length).map(toMeta), total: all.length, matched: matching.length }
    },
    async get(id: string) {
      return byId.get(id) ?? null
    },
    async clear(scope?: { sessionId?: string }) {
      const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId.length > 0 ? scope.sessionId : null
      let removed = 0
      for (const [id, record] of byId) {
        if (sessionId === null || record.sessionId === sessionId) {
          byId.delete(id)
          removed += 1
        }
      }
      return removed
    },
    async stats() {
      return { dir: '/fake', retained: byId.size, diskBytes: 0, maxDiskBytes: fake.maxDiskBytes, oldestAt: null, segments: 0, writes: saved.length, failures: 0, legacyPending: 0 }
    },
    async idle() {},
    async close() {},
  }
  return fake
}
