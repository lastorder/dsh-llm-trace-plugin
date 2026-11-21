/**
 * Record ⇄ disk conversions. No I/O and no compression — `archive.ts` owns
 * both; this module decides WHAT is written.
 *
 * Three things live here:
 *
 *   - Which records are worth persisting at all (`shouldPersist`).
 *   - The stored payload of one record (`encodeRecord` / `decodeRecord`),
 *     including the delta encoding of its request body against the previous
 *     request of the same conversation (`planDelta` / `applyDelta`).
 *   - The index line that lets the archive list records without reading any
 *     payload (`toIndexLine` / `toMeta`), and the import of records written by
 *     earlier versions (`fromLegacyFile`).
 *
 * Bodies stay verbatim: compression is lossless and a delta is rebuilt to the
 * exact original string (`applyDelta` verifies the length), so what the
 * viewer shows — and what curl replay sends — is byte-for-byte what was
 * captured.
 *
 * @module dsh-llm-trace-plugin/host/persistence/codec
 */

import type { AnyWireRecord, WireRecord, WireRecordMeta } from '../../shared/record-shape.js'
import { MIN_DELTA_CHARS } from './constants.js'

/** Payload format version written by this module. Version 1 was one indented JSON file per record. */
export const PAYLOAD_VERSION = 2

/**
 * Whether a finished record is worth a place on disk.
 *
 * A request that carries no body and was not made inside a model call is
 * provider housekeeping — the harness polls `GET /models`, for example — not
 * a model call anyone will want to read after a restart. Measured on a live
 * profile, such polls were 304 of the 307 records the old 300-record cap kept,
 * which is precisely how real calls vanished across restarts. They stay
 * visible live, in memory; they just never displace history.
 */
export function shouldPersist(record: WireRecord): boolean {
  if (record.attributed === true) return true
  const request = record.request
  return request !== null && request !== undefined && (request.bodyChars > 0 || (request.bodyText ?? '').length > 0)
}

/** A request body stored as the difference from an earlier one. */
export interface BodyDelta {
  /** Id of the record whose request body this one is based on. */
  base: string
  /** Characters shared with the start of the base body. */
  prefix: number
  /** Characters shared with the end of the base body. */
  suffix: number
  /** Everything in between, verbatim. */
  middle: string
  /** Length of the rebuilt body, checked on decode. */
  length: number
}

/**
 * Plan a delta of `text` against `baseText`, or null when one is not worth it.
 *
 * Consecutive requests of one conversation repeat the whole history and add a
 * little at the end, while the fields after the message list (tools, stream
 * flags) stay put — so a common prefix plus a common suffix capture nearly
 * all of it. Measured on real agent traffic: 97–99.7% of a 1.6 MB request was
 * shared with the previous step. Anything that disturbs both ends (a provider
 * that rewrites the system prompt AND reorders trailing fields) simply falls
 * back to a full copy.
 */
export function planDelta(text: string, baseText: string): Omit<BodyDelta, 'base'> | null {
  if (text.length < MIN_DELTA_CHARS || baseText.length === 0) return null
  const limit = Math.min(text.length, baseText.length)
  let prefix = 0
  while (prefix < limit && text.charCodeAt(prefix) === baseText.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  const room = limit - prefix
  while (suffix < room && text.charCodeAt(text.length - 1 - suffix) === baseText.charCodeAt(baseText.length - 1 - suffix)) suffix += 1
  // Only worth an indirection when it saves at least half of the body.
  if ((prefix + suffix) * 2 < text.length) return null
  return { prefix, suffix, middle: text.slice(prefix, text.length - suffix), length: text.length }
}

/**
 * Rebuild a body from its base and delta. Exact at the UTF-16 level: a cut
 * inside a surrogate pair is rejoined by the concatenation.
 * @throws when the result does not have the recorded length (a corrupt or mismatched base).
 */
export function applyDelta(baseText: string, delta: Omit<BodyDelta, 'base'>): string {
  if (delta.prefix + delta.suffix > baseText.length) throw new Error('delta does not fit its base body')
  const text = baseText.slice(0, delta.prefix) + delta.middle + baseText.slice(baseText.length - delta.suffix)
  if (text.length !== delta.length) throw new Error('delta rebuilt a body of the wrong length')
  return text
}

/**
 * Serialize one finished record to its stored payload (JSON text).
 *
 * The payload is self-contained — every field of the record, so a corrupt
 * index line can never make a payload unreadable — except that the request
 * body is replaced by `delta` when one is given. Derived `bodyJson` parses are
 * never stored: they are re-derived on read.
 */
export function encodeRecord(record: WireRecord, delta?: BodyDelta | null): string {
  const request = record.request
  const response = record.response ?? null
  return JSON.stringify({
    v: PAYLOAD_VERSION,
    id: record.id,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    durationMs: record.durationMs ?? null,
    status: record.status ?? null,
    model: record.model ?? null,
    sessionId: record.sessionId ?? null,
    turn: typeof record.turn === 'number' ? record.turn : null,
    step: typeof record.step === 'number' ? record.step : null,
    purpose: record.purpose ?? null,
    provider: record.provider ?? null,
    requestedModel: record.requestedModel ?? null,
    attributed: record.attributed === true,
    request: {
      method: request.method ?? null,
      url: request.url ?? null,
      headers: request.headers ?? {},
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
      ...(delta ? { delta } : { bodyText: request.bodyText ?? '' }),
    },
    response: response === null ? null : {
      status: response.status ?? null,
      statusText: response.statusText ?? null,
      headers: response.headers ?? {},
      contentType: response.contentType ?? null,
      bodyText: response.bodyText ?? '',
      bodyChars: response.bodyChars ?? 0,
      bodyTruncated: response.bodyTruncated === true,
    },
    error: record.error ?? null,
    recorderError: record.recorderError ?? null,
  })
}

/**
 * Parse a stored payload. When the request body was delta-encoded, the
 * returned record's `request.bodyText` is empty and `delta` says how to
 * rebuild it; the archive resolves the base and calls {@link applyDelta}.
 */
export function decodeRecord(json: string): { record: WireRecord, delta: BodyDelta | null } {
  const stored = JSON.parse(json)
  const request = stored.request ?? {}
  const delta: BodyDelta | null = request.delta ?? null
  const record: WireRecord = {
    ...stored,
    persisted: true,
    request: {
      method: request.method,
      url: request.url,
      headers: request.headers ?? {},
      bodyText: delta === null ? (request.bodyText ?? '') : '',
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
      bodyJson: null,
    },
    response: stored.response === null || stored.response === undefined ? null : { ...stored.response, bodyJson: null },
  }
  delete (record as any).v
  if (record.recorderError === null) delete record.recorderError
  return { record, delta }
}

/** Where a record's payload sits in its segment, and what its body is based on. */
export interface IndexLocation {
  /** Byte offset of the compressed payload in the segment's data file. */
  offset: number
  /** Compressed payload length in bytes. */
  length: number
  /** Id of the delta base, when the request body is delta-encoded. */
  base: string | null
}

/**
 * Build one index line: exactly the fields a list row needs (see
 * {@link toMeta}), plus where the payload is. Never carries a body or headers,
 * so the whole index stays small enough to hold in memory.
 */
export function toIndexLine(record: AnyWireRecord, location: IndexLocation): string {
  const request = record.request
  const response = record.response ?? null
  return JSON.stringify({
    id: record.id,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    durationMs: record.durationMs ?? null,
    status: record.status ?? null,
    model: record.model ?? null,
    sessionId: record.sessionId ?? null,
    turn: typeof record.turn === 'number' ? record.turn : null,
    step: typeof record.step === 'number' ? record.step : null,
    purpose: record.purpose ?? null,
    provider: record.provider ?? null,
    requestedModel: record.requestedModel ?? null,
    attributed: record.attributed === true,
    request: {
      method: request.method ?? null,
      url: request.url ?? null,
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
    },
    response: response === null ? null : {
      status: response.status ?? null,
      statusText: response.statusText ?? null,
      contentType: response.contentType ?? null,
      bodyChars: response.bodyChars ?? 0,
      bodyTruncated: response.bodyTruncated === true,
    },
    error: record.error ?? null,
    recorderError: record.recorderError ?? null,
    o: location.offset,
    n: location.length,
    ...(location.base === null ? {} : { b: location.base }),
  }) + '\n'
}

/**
 * Read an index line back. Null for anything malformed — a line torn by a
 * crash mid-append is skipped, never fatal.
 */
export function parseIndexLine(line: string): { meta: WireRecordMeta, location: IndexLocation } | null {
  if (line.trim().length === 0) return null
  let stored: any
  try {
    stored = JSON.parse(line)
  } catch {
    return null
  }
  if (stored === null || typeof stored !== 'object' || typeof stored.id !== 'string' || stored.id.length === 0) return null
  if (!Number.isInteger(stored.o) || !Number.isInteger(stored.n) || stored.o < 0 || stored.n <= 0) return null
  return {
    meta: toMeta(stored),
    location: { offset: stored.o, length: stored.n, base: typeof stored.b === 'string' ? stored.b : null },
  }
}

/**
 * Project a stored record down to exactly the fields a LIST row needs. Mirrors
 * `summarizeRecord` in page-grouping.ts. `bodyText`/`bodyJson` come out as an
 * explicit `null`, so a consumer that spreads this record still sees the keys
 * — see {@link WireRecordMeta}.
 */
export function toMeta(stored: any): WireRecordMeta {
  const request = stored.request ?? {}
  const response = stored.response ?? null
  return {
    id: stored.id,
    startedAt: stored.startedAt ?? null,
    endedAt: stored.endedAt ?? null,
    durationMs: stored.durationMs ?? null,
    status: stored.status ?? null,
    model: stored.model ?? null,
    sessionId: stored.sessionId ?? null,
    turn: typeof stored.turn === 'number' ? stored.turn : null,
    step: typeof stored.step === 'number' ? stored.step : null,
    purpose: stored.purpose ?? null,
    provider: stored.provider ?? null,
    requestedModel: stored.requestedModel ?? null,
    attributed: stored.attributed === true,
    persisted: true,
    meta: true,
    request: {
      method: request.method ?? null,
      url: request.url ?? null,
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
      bodyText: null,
      bodyJson: null,
    },
    response: response === null ? null : {
      status: response.status ?? null,
      statusText: response.statusText ?? null,
      contentType: response.contentType ?? null,
      bodyChars: response.bodyChars ?? 0,
      bodyTruncated: response.bodyTruncated === true,
      bodyText: null,
      bodyJson: null,
    },
    error: stored.error ?? null,
    recorderError: stored.recorderError ?? null,
  }
}

/**
 * Attach the `bodyJson` parses a detail view needs, derived from each body's
 * own text. An SSE response is a frame sequence, never one JSON value, so it
 * is never parsed as a whole — matching the capture-time rule, so a stored
 * record and a live one are indistinguishable to every consumer.
 */
export function withParsedBodies(record: WireRecord, parseJson: (text: string | null) => unknown): WireRecord {
  const contentType = record.response === null ? null : record.response.contentType
  const isEventStream = typeof contentType === 'string' && contentType.includes('event-stream')
  return {
    ...record,
    request: { ...record.request, bodyJson: parseJson(record.request.bodyText) },
    response: record.response === null ? null : {
      ...record.response,
      bodyJson: isEventStream ? null : parseJson(record.response.bodyText),
    },
  }
}

/**
 * Convert one record file written by an earlier version (one indented JSON
 * document per record, with a `bodyJson` readability copy) into a live record
 * for re-import. The readability copy is dropped: `bodyText` was always the
 * authoritative form.
 * @returns null when the document is not a record.
 */
export function fromLegacyFile(stored: any): WireRecord | null {
  if (stored === null || typeof stored !== 'object' || typeof stored.id !== 'string' || stored.request === null || typeof stored.request !== 'object') return null
  const request = stored.request
  const response = stored.response ?? null
  return {
    id: stored.id,
    startedAt: typeof stored.startedAt === 'number' ? stored.startedAt : 0,
    endedAt: stored.endedAt ?? null,
    durationMs: stored.durationMs ?? null,
    status: stored.status ?? 'ok',
    model: stored.model ?? null,
    sessionId: stored.sessionId ?? null,
    turn: typeof stored.turn === 'number' ? stored.turn : null,
    step: typeof stored.step === 'number' ? stored.step : null,
    purpose: stored.purpose ?? null,
    provider: stored.provider ?? null,
    requestedModel: stored.requestedModel ?? null,
    attributed: stored.attributed === true,
    request: {
      method: request.method ?? 'GET',
      url: request.url ?? '',
      headers: request.headers ?? {},
      bodyText: typeof request.bodyText === 'string' ? request.bodyText : '',
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
      bodyJson: null,
    },
    response: response === null || typeof response !== 'object' ? null : {
      status: response.status ?? 0,
      statusText: response.statusText ?? '',
      headers: response.headers ?? {},
      contentType: response.contentType ?? null,
      bodyText: typeof response.bodyText === 'string' ? response.bodyText : '',
      bodyChars: response.bodyChars ?? 0,
      bodyTruncated: response.bodyTruncated === true,
      bodyJson: null,
    },
    error: stored.error ?? null,
    ...(typeof stored.recorderError === 'string' ? { recorderError: stored.recorderError } : {}),
  }
}
