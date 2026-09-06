/**
 * Public surface of the persistence layer.
 *
 * @module dsh-llm-trace-plugin/host/persistence
 */
export { DEFAULT_MAX_PERSISTED, DEFAULT_PRETTY_BODY_LIMIT, DEFAULT_PAGE_LIMIT } from './constants.js';
export { resolveTraceDir, buildRecordName } from './naming.js';
export { toPersisted, fromPersisted, toMeta } from './codec.js';
export { createRecordArchive } from './archive.js';
