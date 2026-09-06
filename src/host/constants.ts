/**
 * Shared constants for the host half of the LLM wire trace plugin.
 *
 * @module dsh-llm-trace-plugin/host/constants
 */

/** Marks every provider request via dsh-llm's attributionHeaders(); see APP_IDENTITY.product. */
export const USER_AGENT_PREFIX = 'deepseek-harness/'

/**
 * The single route prefix this plugin serves on, shared by the host's
 * `webServer.register` call and the browser half's `api-client.ts`.
 *
 * Deliberately NOT configurable. It was once a `routePrefix` config option,
 * but only the host ever read it: the client bundle hardcoded the default, so
 * setting it made every request from the viewer 404 with no diagnostic at all.
 * The path is part of the host/client contract, not a user-facing knob.
 */
export const ROUTE_PREFIX = '/llm-wire-trace'

/**
 * Request/response header names whose value is a credential and must never
 * reach disk.
 *
 * `authorization` alone is not enough. Providers this plugin already
 * understands authenticate other ways — Anthropic sends `x-api-key`, Azure
 * OpenAI sends `api-key`, Google sends `x-goog-api-key` — and every captured
 * header is persisted verbatim under the trace directory. A name missing from
 * this set is a plaintext secret in a file on the user's disk.
 *
 * `cookie`/`set-cookie` are here for the same reason: a session cookie is a
 * bearer credential in everything but name.
 */
export const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
])

/**
 * Headers whose value is a `Bearer <token>` scheme rather than a bare key.
 * These keep the scheme visible in the placeholder so a reader can still see
 * HOW the request authenticated, and so `curl.ts` can rebuild the header line
 * in the same shape the provider originally received.
 */
export const BEARER_HEADERS = new Set(['authorization', 'proxy-authorization'])

/** Stand-in written in place of a redacted credential. */
export const REDACTED_VALUE = '***redacted***'

/**
 * Request header `dsh-llm-deepseek` stamps with the harness SessionId of the
 * request's owning session — the ONLY harness identity that reaches the wire.
 *
 * It remains a useful fallback, but it is no longer the primary source: the
 * `llm/stream` listener (see call-context.ts) supplies the session id (plus
 * turn, step, provider, model, and purpose) for every call made through
 * `ctx.llm`, including `dsh-llm-pi-ai` calls, which put nothing on the wire at
 * all. This header is read only when that context is absent.
 */
export const SESSION_HEADER = 'x-deepseek-harness-session-id'

export const DEFAULT_MAX_RECORDS = 200

/**
 * Per-field body cap.
 *
 * Sized against the context window rather than a round number: a 1M-token
 * request is roughly 4M characters (~4 chars/token for English and code, less
 * for CJK), so 8M holds a full 1M-token context with 2x headroom for
 * mixed-language content and future growth.
 *
 * Getting this wrong is not a cosmetic problem. A body cut mid-JSON cannot be
 * parsed at all, so the viewer loses the entire structure and can only show
 * raw text — which is exactly what a 200k cap did to every real agent request.
 */
export const DEFAULT_MAX_BODY_CHARS = 8_000_000

/** Page size ceiling for a list request, so one call cannot ask for the world. */
export const LIST_PAGE_CEILING = 300

/** How long a cached archive page read stays valid; see store.ts `listArchive`. */
export const ARCHIVE_CACHE_TTL_MS = 1000
