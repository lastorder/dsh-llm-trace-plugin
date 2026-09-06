/**
 * Record ⇄ persisted-JSON conversions.
 *
 * Every record is stripped down to what is worth persisting, and — critically
 * — to plain owned data, before it is written to disk; and rebuilt back into
 * the viewer's shape when it is read.
 *
 * @module dsh-llm-trace-plugin/host/persistence/codec
 */

import type { WireRecord, WireRecordMeta } from '../../shared/record-shape.js'
import { DEFAULT_PRETTY_BODY_LIMIT } from './constants.js'

/** Best-effort parse used only to make a stored body readable. Never throws. */
function parseForDisplay(text: string | null | undefined): unknown {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    const value = JSON.parse(text)
    // Only a container is worth expanding; a bare string or number would just
    // duplicate `bodyText` with no readability gain.
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/** Whether a body is too large for the readability copy to be worth its bytes. */
function tooBigToPrettify(text: string | null | undefined, limit: number): boolean {
  return typeof text === 'string' && text.length > limit
}

/** Wrap a parsed body so an absent parse contributes no key at all. */
function withBodyJson(value: unknown): { bodyJson?: unknown } {
  return value === null ? {} : { bodyJson: value }
}

function isEventStream(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.includes('event-stream')
}

/**
 * Strip a live in-memory record down to its persisted, plain-JSON form.
 *
 * `bodyText` is the authoritative form: the literal bytes on the wire, which
 * is the whole point of this plugin. But it is a JSON *string*, so on disk it
 * is one long escaped line that no editor can render usefully. So a parsed
 * `bodyJson` is written ALONGSIDE it, purely so the file is readable — the
 * request's `messages`, tools, and the response object expand as real nested
 * JSON instead of `\"role\":\"user\"` noise.
 *
 * It is a derived convenience copy, never the source of truth: reading
 * re-derives `bodyJson` from `bodyText` regardless (see `fromPersisted`), so a
 * stored parse that is absent, stale, or malformed cannot corrupt what the
 * viewer shows. The cost is roughly double the body bytes on disk, which is
 * why `bodyJson` is omitted whenever it would add nothing.
 */
export function toPersisted(record: WireRecord, prettyLimit?: number): Record<string, unknown> {
  const request = record.request ?? ({} as WireRecord['request'])
  const response = record.response ?? null
  const limit = typeof prettyLimit === 'number' ? prettyLimit : DEFAULT_PRETTY_BODY_LIMIT
  return {
    v: 1,
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
      bodyText: request.bodyText ?? null,
      bodyChars: request.bodyChars ?? 0,
      bodyTruncated: request.bodyTruncated === true,
      // Readability copy; see this function's note above. Omitted when it
      // would not help (unparseable, truncated mid-JSON, or not a container).
      ...(request.bodyTruncated === true || tooBigToPrettify(request.bodyText, limit)
        ? {}
        : withBodyJson(parseForDisplay(request.bodyText))),
    },
    response: response === null ? null : {
      status: response.status ?? null,
      statusText: response.statusText ?? null,
      headers: response.headers ?? {},
      contentType: response.contentType ?? null,
      bodyText: response.bodyText ?? null,
      bodyChars: response.bodyChars ?? 0,
      bodyTruncated: response.bodyTruncated === true,
      // An SSE body is a sequence of frames, not one JSON value, so it is
      // never parsed as a whole — matching the capture-time rule exactly.
      ...(response.bodyTruncated === true
        || isEventStream(response.contentType)
        || tooBigToPrettify(response.bodyText, limit)
        ? {}
        : withBodyJson(parseForDisplay(response.bodyText))),
    },
    error: record.error ?? null,
    recorderError: record.recorderError ?? null,
  }
}

/**
 * Rebuild a viewer-shaped record from its persisted form, restoring the
 * `bodyJson` parses that `toPersisted` dropped so a restored record is
 * indistinguishable from a live one to every consumer.
 *
 * @param stored - parsed file contents.
 * @param parseJson - best-effort JSON parser.
 */
export function fromPersisted(stored: any, parseJson: (text: string | null) => unknown): WireRecord {
  const response = stored.response ?? null
  const contentType = response && response.contentType
  return {
    ...stored,
    persisted: true,
    request: {
      ...stored.request,
      // Always re-derived from `bodyText`, which OVERWRITES any `bodyJson`
      // spread in from the file. That copy exists only to make the file
      // readable; the wire text stays the single source of truth, so a stale
      // or hand-edited parse on disk can never change what the viewer shows.
      bodyJson: parseJson(stored.request ? stored.request.bodyText : null),
    },
    response: response === null ? null : {
      ...response,
      // SSE bodies are a frame sequence, never one JSON value — matching the
      // capture-time rule so a restored record parses exactly as it did live.
      bodyJson: contentType && contentType.includes('event-stream')
        ? null
        : parseJson(response.bodyText),
    },
  }
}

/**
 * Project a stored record down to exactly the fields a LIST row needs,
 * without ever touching the body text.
 *
 * This mirrors `summarizeRecord` in page-grouping.ts: those are the only
 * fields a list row can display. Everything omitted here — `bodyText`,
 * `bodyJson`, headers — is precisely the bulk of the file, and skipping it is
 * what makes listing cheap enough not to block the shared event loop.
 *
 * `bodyText` is carried through as an explicit `null` rather than dropped, so
 * a consumer that spreads this record still sees the key with a defined shape;
 * `bodyChars` (already a stored scalar) supplies the size the list displays.
 * The return type says all of this outright — see {@link WireRecordMeta}.
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
