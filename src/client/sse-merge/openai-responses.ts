/**
 * OpenAI Responses API adapter: reassembles a stream framed by `event:` type
 * (`response.created` / `response.output_item.added` /
 * `response.output_text.delta` / `response.function_call_arguments.delta` /
 * `response.reasoning_text.delta` / `response.reasoning_summary_text.delta` /
 * … / `response.completed`) into the exact shape OpenAI's own non-streamed
 * `POST /v1/responses` response has — a top-level `Response` object whose
 * `output[]` array holds `message` / `reasoning` / `function_call` items,
 * each shaped exactly like the SDK's own `ResponseOutputMessage` /
 * `ResponseReasoningItem` / `ResponseFunctionToolCall` types — so a reader
 * who already knows that shape needs no new vocabulary.
 *
 * @module dsh-llm-trace-plugin/client/sse-merge/openai-responses
 */

import { isPlainObject, tryParseJson, type SseMergeAdapter } from './shared.js'

/** `output[]` message content, matching `ResponseOutputText` for the text case. */
export interface ResponsesOutputText {
  type: 'output_text'
  text: string
}

/** A `message` output item, shaped like `ResponseOutputMessage`. */
export interface ResponsesMessageItem {
  type: 'message'
  id: string | null
  role: 'assistant'
  content: ResponsesOutputText[]
}

/** A `reasoning` output item, shaped like `ResponseReasoningItem`: `summary[]` holds `summary_text` parts, `content[]` holds verbatim `reasoning_text` parts — exactly one of the two wire events feeds each, matching which one a real response actually carries. */
export interface ResponsesReasoningItem {
  type: 'reasoning'
  id: string | null
  summary: { type: 'summary_text', text: string }[]
  content: { type: 'reasoning_text', text: string }[] | null
}

/** A `function_call` output item, shaped like `ResponseFunctionToolCall`. */
export interface ResponsesFunctionCallItem {
  type: 'function_call'
  id: string | null
  call_id: string | null
  name: string | null
  arguments: string
  /** Convenience parse of `arguments`; not part of the official shape, appended because a reader almost always wants it. `null` while incomplete/malformed. */
  argumentsJson: unknown
}

/** Any other item type this plugin does not have a specific shape for, kept as accumulated raw fields. */
export interface ResponsesUnknownItem {
  type: string | null
  [key: string]: unknown
}

export type ResponsesOutputItem = ResponsesMessageItem | ResponsesReasoningItem | ResponsesFunctionCallItem | ResponsesUnknownItem

/** The reassembled result, shaped like OpenAI's own non-streamed `Response` object. */
export interface ResponsesMergedResult {
  id: string | null
  object: 'response'
  model: string | null
  status: string | null
  output: ResponsesOutputItem[]
  usage: Record<string, unknown> | null
  /** Any other top-level field the `response.*` envelope events supplied, preserved verbatim. */
  [extra: string]: unknown
}

interface ItemState {
  index: number
  type: string | null
  id: string | null
  text: string
  /** Two independent accumulators: exactly one of these ever fills for a given response — see the module doc. */
  reasoningSummaryText: string
  reasoningContentText: string
  callId: string | null
  name: string | null
  argumentsText: string
  extra: Record<string, unknown>
}

function newItem(index: number): ItemState {
  return {
    index,
    type: null,
    id: null,
    text: '',
    reasoningSummaryText: '',
    reasoningContentText: '',
    callId: null,
    name: null,
    argumentsText: '',
    extra: {},
  }
}

const RESPONSES_API_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.completed',
  'response.failed',
  'response.incomplete',
])

export function createOpenAiResponsesAdapter(): SseMergeAdapter<ResponsesMergedResult> {
  const response: Record<string, unknown> = {}
  const items = new Map<number, ItemState>()
  let status: string | null = null
  let recognizedAny = false

  const itemAt = (index: number): ItemState => {
    let item = items.get(index)
    if (item === undefined) {
      item = newItem(index)
      items.set(index, item)
    }
    return item
  }

  return {
    name: 'openai-responses',
    get recognizedAny() {
      return recognizedAny
    },
    fold(frame) {
      const event = frame.event
      const data = frame.data
      if (typeof event !== 'string' || !RESPONSES_API_EVENTS.has(event) || !isPlainObject(data)) return false
      recognizedAny = true

      if (event === 'response.created' || event === 'response.in_progress' || event === 'response.completed'
        || event === 'response.failed' || event === 'response.incomplete') {
        if (isPlainObject(data.response)) {
          Object.assign(response, data.response)
          if (typeof data.response.status === 'string') status = data.response.status
        }
        return true
      }
      if (event === 'response.output_item.added' || event === 'response.output_item.done') {
        const index = typeof data.output_index === 'number' ? data.output_index : 0
        const item = itemAt(index)
        const raw = isPlainObject(data.item) ? data.item : {}
        if (typeof raw.type === 'string') item.type = raw.type
        if (typeof raw.id === 'string' && item.id === null) item.id = raw.id
        // A function_call item's id/name/complete arguments are all present
        // directly on `response.output_item.done` — filled in here as a
        // fallback for a stream that never sent (or that this plugin missed)
        // the per-fragment delta events, so the call still comes through
        // whole either way. Gated on the item actually BEING a
        // function_call: a message item's own `id` is its message id, never
        // a tool-call id, and must never be misread as one.
        if (item.type === 'function_call') {
          if (typeof raw.call_id === 'string' && item.callId === null) item.callId = raw.call_id
          if (typeof raw.name === 'string' && item.name === null) item.name = raw.name
          if (typeof raw.arguments === 'string' && item.argumentsText.length === 0) item.argumentsText = raw.arguments
        }
        return true
      }
      if (event === 'response.output_text.delta') {
        const index = typeof data.output_index === 'number' ? data.output_index : 0
        if (typeof data.delta === 'string') itemAt(index).text += data.delta
        return true
      }
      if (event === 'response.reasoning_text.delta') {
        const index = typeof data.output_index === 'number' ? data.output_index : 0
        if (typeof data.delta === 'string') itemAt(index).reasoningContentText += data.delta
        return true
      }
      if (event === 'response.reasoning_summary_text.delta') {
        const index = typeof data.output_index === 'number' ? data.output_index : 0
        if (typeof data.delta === 'string') itemAt(index).reasoningSummaryText += data.delta
        return true
      }
      if (event === 'response.function_call_arguments.delta') {
        const index = typeof data.output_index === 'number' ? data.output_index : 0
        if (typeof data.delta === 'string') itemAt(index).argumentsText += data.delta
        return true
      }
      // response.output_text.done / response.reasoning_text.done /
      // response.reasoning_summary_text.done / response.function_call_arguments.done
      // carry the same complete value the deltas already accumulated — no
      // further accumulation needed. response.content_part.added/.done carry
      // no text of their own in this API (the text lives on the item
      // directly, addressed by output_index, not content_index).
      return true
    },
    result() {
      const output: ResponsesOutputItem[] = [...items.values()]
        .sort((a, b) => a.index - b.index)
        .map((item): ResponsesOutputItem => {
          if (item.type === 'message') {
            return {
              type: 'message',
              id: item.id,
              role: 'assistant',
              content: item.text.length > 0 || item.reasoningSummaryText.length === 0
                ? [{ type: 'output_text', text: item.text }]
                : [],
            }
          }
          if (item.type === 'reasoning') {
            return {
              type: 'reasoning',
              id: item.id,
              summary: item.reasoningSummaryText.length > 0
                ? [{ type: 'summary_text', text: item.reasoningSummaryText }]
                : [],
              content: item.reasoningContentText.length > 0
                ? [{ type: 'reasoning_text', text: item.reasoningContentText }]
                : null,
            }
          }
          if (item.type === 'function_call') {
            return {
              type: 'function_call',
              id: item.id,
              call_id: item.callId,
              name: item.name,
              arguments: item.argumentsText,
              argumentsJson: tryParseJson(item.argumentsText),
            }
          }
          return { type: item.type, ...item.extra }
        })

      const usage = isPlainObject(response.usage) ? response.usage : null
      return {
        id: typeof response.id === 'string' ? response.id : null,
        object: 'response',
        model: typeof response.model === 'string' ? response.model : null,
        status,
        output,
        usage,
        ...Object.fromEntries(Object.entries(response).filter(([key]) =>
          !['id', 'object', 'model', 'status', 'output', 'usage'].includes(key))),
      }
    },
  }
}
