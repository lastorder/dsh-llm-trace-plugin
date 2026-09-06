/**
 * Shared types and helpers for every per-provider SSE-merge adapter.
 *
 * Each adapter (see `anthropic.ts`, `openai-responses.ts`,
 * `openai-chat-completions.ts`) takes the frame sequence produced by
 * `parseSseFrames` and reassembles it into the shape that provider's OWN
 * non-streaming response would have had — not an invented intermediate
 * format. That is a deliberate design choice: a reader who already knows
 * what a normal (non-streamed) Anthropic or OpenAI response looks like can
 * read the merged result with zero new vocabulary to learn, and any tool
 * that already understands the official response shape can consume it
 * unchanged.
 *
 * @module dsh-llm-trace-plugin/client/sse-merge/shared
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * An adapter's verdict on one frame: either it recognized the frame's shape
 * and folded it into its own accumulator (`true`), or the frame is none of
 * its business and must be tried against the next adapter, or ultimately
 * land in the caller's `unrecognized` list (`false`).
 *
 * Adapters never partially recognize a frame: a frame is either fully this
 * adapter's shape or entirely not, so there is no notion of "half-folded"
 * state to reconcile later.
 */
export type FoldResult = boolean

/**
 * One provider's merge adapter: a small state machine fed one frame at a
 * time, producing its provider-shaped result only once every frame has been
 * offered to it.
 *
 * @template TResult - the shape this adapter reassembles (the provider's own non-streamed response shape).
 */
export interface SseMergeAdapter<TResult> {
  /** Human-readable name, used only for diagnostics/labeling — never for branching logic elsewhere. */
  readonly name: string
  /**
   * Offer one frame to this adapter. Returns `true` when the frame matched
   * this adapter's shape and was folded in; `false` when it is not this
   * adapter's concern at all (the frame is left completely untouched and
   * the caller must try it elsewhere).
   */
  fold(frame: Record<string, unknown>): FoldResult
  /**
   * True once at least one frame has been folded — i.e. this adapter's
   * `result()` is worth reading at all. An adapter that recognized nothing
   * contributes nothing to the merged output rather than an empty stub.
   */
  readonly recognizedAny: boolean
  /** Build the final, provider-shaped result from everything folded so far. */
  result(): TResult
}

/**
 * Best-effort whole-value JSON parse used when an accumulated fragment
 * string needs to become a real value (a tool call's arguments, a
 * `partial_json` blob). Never throws; `null` means "not (yet, or ever)
 * valid JSON" — never a guess at a partial value.
 */
export function tryParseJson(text: string): unknown {
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
