/**
 * Shared record shapes between the host (capture, persistence, HTTP routes)
 * and the client (the Wire Trace viewer).
 *
 * This module is TYPE-ONLY: nothing here has a runtime representation. The
 * client bundle imports these as `import type`, so none of it adds bytes to
 * the shipped browser script.
 *
 * @module dsh-llm-trace-plugin/shared/record-shape
 */

/** Redacted, lowercase-keyed header map (see host/http-utils.ts). */
export type HeaderMap = Record<string, string>

export type WireStatus = 'streaming' | 'ok' | 'http-error' | 'transport-error'

export interface WireRequest {
  method: string
  url: string
  headers: HeaderMap
  bodyText: string
  bodyChars: number
  bodyTruncated: boolean
  bodyJson: unknown
}

export interface WireResponse {
  status: number
  statusText: string
  headers: HeaderMap
  contentType: string | null
  bodyText: string
  bodyChars: number
  bodyTruncated: boolean
  bodyJson: unknown
}

export interface WireError {
  name: string
  message: string
}

/**
 * One captured wire-level call, in the shape the in-memory store, the
 * persisted-file codec, and the client detail view all agree on.
 *
 * `turn`/`step`/`purpose`/`provider` are harness coordinates that never
 * appear on the wire itself — see host/call-context.ts for how they are
 * attached. `null` always means "not known"; it is never a stale carried-over
 * value.
 */
export interface WireRecord {
  id: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: WireStatus
  model: string | null
  sessionId: string | null
  turn: number | null
  step: number | null
  purpose: string | null
  provider: string | null
  requestedModel: string | null
  /** True when this call was made through `ctx.llm` and so carries real coordinates. */
  attributed: boolean
  request: WireRequest
  response: WireResponse | null
  error: WireError | null
  /** Set only when this plugin itself failed to mirror the body; never a wire-level error. */
  recorderError?: string
  /** True once a record has been read back from a persisted file. */
  persisted?: boolean
  /** True when this is a list-row projection with body fields nulled out (see persistence/codec.ts). */
  meta?: boolean
}

/** The fields a list row actually displays; see host/store.ts `summary()`. */
export interface WireRecordSummary {
  id: string
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  status: WireStatus
  method: string
  url: string
  model: string | null
  sessionId: string | null
  turn: number | null
  step: number | null
  purpose: string | null
  provider: string | null
  attributed: boolean
  responseStatus: number | null
  requestChars: number
  responseChars: number
}

export interface TurnStat {
  turn: number
  calls: number
  steps: number
}

/** Shared shape of a `list`/`listAll` page payload, before the async-history fields are added. */
export interface GroupedPage {
  items: WireRecordSummary[]
  unattributed: number
  turns: TurnStat[]
  auxiliary: number
}

export interface ListPage extends GroupedPage {
  total: number
  matched: number
}

export interface ListAllPage extends GroupedPage {
  total: number
  matched: number
  persistence: boolean
  truncated: boolean
  historyPending: boolean
}
