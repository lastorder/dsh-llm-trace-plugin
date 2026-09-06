import type { RecordArchive } from '../../src/host/persistence/archive.js'
import type { WireRecord } from '../../src/shared/record-shape.js'

/**
 * An in-memory `RecordArchive` fake: no filesystem I/O at all, just a `Map`
 * keyed by record id. Exercises `store.ts`'s archive-merge logic without
 * making its tests depend on `archive.ts`'s own (separately tested) disk
 * behavior.
 */
export function createFakeArchive(): RecordArchive & { saved: WireRecord[] } {
  const byId = new Map<string, WireRecord>()
  const saved: WireRecord[] = []

  return {
    dir: '/fake',
    maxRecords: 300,
    saved,
    async save(record) {
      byId.set(record.id, { ...record })
      saved.push(record)
      return true
    },
    async list(query) {
      const wanted = query?.sessionId
      const all = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt)
      const matching = wanted ? all.filter((r) => r.sessionId === wanted) : all
      const cap = query?.limit ?? 50
      const windowed = matching.slice(Math.max(0, matching.length - cap))
      return { records: windowed, total: all.length, scanned: matching.length, truncated: false }
    },
    async get(id) {
      return byId.get(id) ?? null
    },
    async sweepTemp() {},
    async clear() {
      const count = byId.size
      byId.clear()
      return count
    },
    async sweep() {},
    async stats() {
      return { dir: '/fake', retained: byId.size, maxRecords: 300, writes: saved.length, failures: 0 }
    },
  }
}
