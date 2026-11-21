/**
 * Public surface of the persistence layer.
 *
 * @module dsh-llm-trace-plugin/host/persistence
 */

export { DEFAULT_MAX_DISK_MB, MIN_MAX_DISK_MB } from './constants.js'
export { resolveTraceDir, buildRecordId } from './naming.js'
export { shouldPersist, encodeRecord, decodeRecord, planDelta, applyDelta, toIndexLine, parseIndexLine, toMeta, withParsedBodies, fromLegacyFile } from './codec.js'
export { createRecordArchive, segmentTargetBytes } from './archive.js'
export type { ArchiveOptions, ArchiveListQuery, ArchiveListResult, ArchiveStats, RecordArchive } from './archive.js'
