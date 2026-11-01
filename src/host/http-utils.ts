/**
 * Wire-level HTTP parsing helpers: header redaction, request description, and
 * safe JSON/body clipping. Kept free of any store/persistence concerns so it
 * can be unit-tested in isolation.
 *
 * @module dsh-llm-trace-plugin/host/http-utils
 */

import type { HeaderMap } from '../shared/record-shape.js'
import { BEARER_HEADERS, REDACTED_HEADERS, REDACTED_QUERY_PARAMS, REDACTED_VALUE } from './constants.js'

export interface ClippedText {
  text: string
  chars: number
  truncated: boolean
}

/** Clip a string to a character budget, reporting whether it was cut. */
export function clip(text: string, max: number): ClippedText {
  if (text.length <= max) return { text, chars: text.length, truncated: false }
  return { text: text.slice(0, max), chars: text.length, truncated: true }
}

/**
 * Redact one header value when its name carries a credential.
 *
 * A bearer-scheme header keeps its scheme (`Bearer ***redacted***`) so the
 * record still shows HOW the call authenticated; a bare-key header
 * (`x-api-key`, `api-key`, …) becomes the placeholder alone, because there is
 * no scheme to preserve and inventing one would misrepresent the wire.
 */
export function redactHeaderValue(name: string, value: unknown): string {
  if (!REDACTED_HEADERS.has(name)) return String(value)
  return BEARER_HEADERS.has(name) ? `Bearer ${REDACTED_VALUE}` : REDACTED_VALUE
}

/**
 * Normalize a Headers-like value (Headers instance, plain object, or entry
 * array) into a plain lowercase-keyed object, redacting every credential
 * header named in {@link REDACTED_HEADERS}.
 */
export function redactedHeaders(headers: unknown): HeaderMap {
  const out: HeaderMap = {}
  const set = (key: unknown, value: unknown) => {
    const k = String(key).toLowerCase()
    out[k] = redactHeaderValue(k, value)
  }
  if (headers === null || headers === undefined) return out
  // Array MUST be checked before the forEach duck-type below: every array
  // has its own `.forEach`, so an entry array would otherwise be routed into
  // the Headers-style branch and iterated as (value, index) pairs instead of
  // (key, value) pairs — silently producing numeric-index keys ("0", "1", …)
  // instead of the real header names.
  if (Array.isArray(headers)) {
    for (const entry of headers) if (Array.isArray(entry) && entry.length === 2) set(entry[0], entry[1])
    return out
  }
  const maybeForEach = (headers as { forEach?: unknown }).forEach
  if (typeof maybeForEach === 'function') {
    ;(headers as Headers).forEach((value, key) => set(key, value))
    return out
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers as Record<string, unknown>)) set(key, (headers as Record<string, unknown>)[key])
    return out
  }
  return out
}

/**
 * Read the outgoing user-agent from a fetch call's normalized headers, or
 * from a `Request` instance when the caller passed one instead of a plain init.
 */
export function outgoingUserAgent(input: unknown, init: RequestInit | undefined): string {
  const fromInit = init && init.headers ? redactedHeaders(init.headers)['user-agent'] : undefined
  if (typeof fromInit === 'string') return fromInit
  if (input !== null && typeof input === 'object' && typeof (input as Request).headers !== 'undefined') {
    const fromRequest = redactedHeaders((input as Request).headers)['user-agent']
    if (typeof fromRequest === 'string') return fromRequest
  }
  return ''
}

/**
 * Redact every query-string parameter named in {@link REDACTED_QUERY_PARAMS}
 * (matched case-insensitively) from a URL, replacing its value with
 * {@link REDACTED_VALUE} while leaving every other parameter, the path, and
 * parameter order untouched.
 *
 * Falls back to returning the input unchanged if it fails to parse as a URL
 * — this runs on the capture hot path, and a malformed/relative URL must
 * never throw out of it. A parameter repeated more than once (`?key=a&key=b`)
 * has every occurrence redacted, not just the first.
 */
export function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  let changed = false
  // A plain array copy of the names, not a live iteration over the iterator:
  // this loop mutates `parsed.searchParams` while iterating, and iterating a
  // URLSearchParams while calling .set()/.append() on it is unspecified.
  const names = Array.from(parsed.searchParams.keys())
  for (const name of names) {
    if (!REDACTED_QUERY_PARAMS.has(name.toLowerCase())) continue
    changed = true
    const count = parsed.searchParams.getAll(name).length
    parsed.searchParams.set(name, REDACTED_VALUE)
    for (let i = 1; i < count; i += 1) parsed.searchParams.append(name, REDACTED_VALUE)
  }
  return changed ? parsed.toString() : url
}

export interface DescribedRequest {
  method: string
  url: string
  headers: HeaderMap
  /**
   * The request body as text when it is available SYNCHRONOUSLY (a string, a
   * byte buffer, or a `URLSearchParams`); `null` otherwise. A body that can
   * only be read asynchronously is handled by {@link deferBodyCapture}.
   */
  bodyText: string | null
}

/** Decode a byte view / buffer as UTF-8 without throwing on malformed input. */
function decodeBytes(body: ArrayBuffer | ArrayBufferView): string {
  const view = ArrayBuffer.isView(body)
    ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : new Uint8Array(body)
  return new TextDecoder().decode(view)
}

/**
 * Read a request body that is available without consuming anything: a string,
 * `ArrayBuffer`, any typed array / `Buffer` / `DataView`, or `URLSearchParams`.
 * Returns `null` for everything else (streams, `Blob`, `FormData`, …).
 */
function readSyncBody(body: unknown): string | null {
  if (typeof body === 'string') return body
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return decodeBytes(body)
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return body.toString()
  return null
}

/**
 * Extract method, URL, and body text from a fetch call, supporting both the
 * `fetch(url, init)` and `fetch(new Request(url, init))` calling forms.
 *
 * Only reads what needs no I/O. A string, byte-buffer or `URLSearchParams`
 * body is returned in `bodyText`; every other shape (a `Request` object's own
 * body, a `Blob`, a `ReadableStream`) is left for {@link deferBodyCapture},
 * because reading it here would be asynchronous and — for a stream — would
 * consume the only copy.
 */
export function describeRequest(input: unknown, init: RequestInit | undefined): DescribedRequest {
  const isRequestLike = input !== null && typeof input === 'object' && typeof (input as Request).url === 'string'
  const url = redactUrl(isRequestLike ? (input as Request).url : String(input))
  const method = (init && init.method) || (isRequestLike ? (input as Request).method : undefined) || 'GET'
  const headers = redactedHeaders((init && init.headers) || (isRequestLike ? (input as Request).headers : undefined))
  const bodyText = init ? readSyncBody(init.body) : null
  return { method: String(method), url, headers, bodyText }
}

/** A request body that has to be read asynchronously, plus the fetch args to send. */
export interface DeferredBody {
  /**
   * Resolves with the body text, or `null` when it could not be read. Never
   * rejects: a failure to mirror the body must not surface as a failed call.
   */
  text: Promise<string | null>
  /** The `init` to pass to the real `fetch` in place of the caller's. */
  init: RequestInit | undefined
}

/** Drain a stream into text, resolving with whatever was read if it fails midway. */
async function drainToText(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) text += typeof value === 'string' ? value : decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } catch {
    return text.length > 0 ? text : null
  }
}

/**
 * Start capturing a request body that {@link describeRequest} could not read
 * synchronously, WITHOUT consuming the copy the real `fetch` will send.
 *
 * - `init.body` is a `ReadableStream`: tee it. One branch replaces the body in
 *   the returned `init`; the other is drained here.
 * - `init.body` is a `Blob`: `Blob.text()` is non-consuming.
 * - no `init.body`, and `input` is a `Request` carrying a body: read from
 *   `input.clone()`, which leaves `input` itself unread.
 *
 * Returns `null` when there is nothing to capture or the shape cannot be
 * mirrored without consuming it (an async-iterable or `FormData` body).
 * Every path is best-effort and never throws.
 */
export function deferBodyCapture(input: unknown, init: RequestInit | undefined): DeferredBody | null {
  try {
    const body = init ? init.body : undefined
    if (body !== undefined && body !== null) {
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        const [forWire, forCapture] = body.tee()
        return { text: drainToText(forCapture), init: { ...init, body: forWire } }
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return { text: body.text().catch(() => null), init }
      }
      return null
    }
    const isRequest = typeof Request !== 'undefined' && input instanceof Request
    if (isRequest && (input as Request).body !== null && !(input as Request).bodyUsed) {
      const copy = (input as Request).clone()
      return { text: copy.text().catch(() => null), init }
    }
  } catch {
    // A body that cannot be mirrored is recorded as empty rather than failing the call.
  }
  return null
}

/** Name the shape of a request body this plugin cannot mirror, for the record's note. */
export function describeUnmirroredBody(init: RequestInit | undefined): string | null {
  const body = init ? init.body : undefined
  if (body === undefined || body === null) return null
  if (readSyncBody(body) !== null) return null
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return null
  if (typeof Blob !== 'undefined' && body instanceof Blob) return null
  if (typeof FormData !== 'undefined' && body instanceof FormData) return 'FormData'
  return Object.prototype.toString.call(body).slice(8, -1)
}

/** Best-effort JSON parse for display; never throws. */
export function tryParseJson(text: string | null | undefined): unknown {
  if (typeof text !== 'string' || text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
