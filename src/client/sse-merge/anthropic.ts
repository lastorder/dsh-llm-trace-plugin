/**
 * Anthropic Messages API adapter: reassembles a stream framed by `event:`
 * type (`message_start` / `content_block_start` / `content_block_delta` /
 * `content_block_stop` / `message_delta` / `message_stop`) into the exact
 * shape Anthropic's own non-streamed `POST /v1/messages` response has —
 * `{ id, type, role, model, content: [...], stop_reason, stop_sequence,
 * usage }` — so a reader who already knows that shape needs no new
 * vocabulary, and the result can be handed to anything that already
 * understands a normal Anthropic response.
 *
 * @module dsh-llm-trace-plugin/client/sse-merge/anthropic
 */

import { isPlainObject, tryParseJson, type SseMergeAdapter } from './shared.js'

/** A `text` content block, exactly as Anthropic's non-streamed response shapes it. */
export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

/** A `thinking` content block. `signature` arrives once the block closes. */
export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string | null
}

/** A `tool_use` content block. `input` is the fully reassembled, parsed call arguments. */
export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string | null
  name: string | null
  input: unknown
  /** The raw, possibly-still-fragmentary JSON text `input` was parsed from; kept alongside for when parsing fails. */
  inputJsonText: string
}

/** Any other block type this plugin does not have a specific shape for, kept as accumulated raw fields. */
export interface AnthropicUnknownBlock {
  type: string | null
  [key: string]: unknown
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock | AnthropicUnknownBlock

/** The reassembled result, shaped exactly like Anthropic's own non-streamed Messages response. */
export interface AnthropicMergedMessage {
  id: string | null
  type: 'message'
  role: string | null
  model: string | null
  content: AnthropicContentBlock[]
  stop_reason: string | null
  stop_sequence: string | null
  usage: Record<string, unknown> | null
  /** Any other top-level field `message_start`/`message_delta` supplied, preserved verbatim (e.g. provider-specific extras). */
  [extra: string]: unknown
}

interface BlockState {
  index: number
  type: string | null
  text: string
  thinking: string
  signature: string | null
  id: string | null
  name: string | null
  inputJsonText: string
  extra: Record<string, unknown>
}

function newBlock(index: number): BlockState {
  return { index, type: null, text: '', thinking: '', signature: null, id: null, name: null, inputJsonText: '', extra: {} }
}

const ANTHROPIC_EVENTS = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
])

export function createAnthropicAdapter(): SseMergeAdapter<AnthropicMergedMessage> {
  const message: Record<string, unknown> = {}
  const blocks = new Map<number, BlockState>()
  let stopReason: string | null = null
  let stopSequence: string | null = null
  let recognizedAny = false

  const blockAt = (index: number): BlockState => {
    let block = blocks.get(index)
    if (block === undefined) {
      block = newBlock(index)
      blocks.set(index, block)
    }
    return block
  }

  return {
    name: 'anthropic-messages',
    get recognizedAny() {
      return recognizedAny
    },
    fold(frame) {
      const event = frame.event
      const data = frame.data
      if (typeof event !== 'string' || !ANTHROPIC_EVENTS.has(event) || !isPlainObject(data)) return false
      recognizedAny = true

      if (event === 'message_start') {
        if (isPlainObject(data.message)) Object.assign(message, data.message)
        return true
      }
      if (event === 'content_block_start') {
        const index = typeof data.index === 'number' ? data.index : 0
        const block = blockAt(index)
        const raw = isPlainObject(data.content_block) ? data.content_block : {}
        if (typeof raw.type === 'string') block.type = raw.type
        if (typeof raw.id === 'string') block.id = raw.id
        if (typeof raw.name === 'string') block.name = raw.name
        if (typeof raw.text === 'string') block.text += raw.text
        // Anything else on the starting block (a tool_use's echoed empty
        // `input: {}`, etc.) is not this plugin's business to reinterpret —
        // it is superseded by the deltas that follow.
        return true
      }
      if (event === 'content_block_delta') {
        const index = typeof data.index === 'number' ? data.index : 0
        const block = blockAt(index)
        const delta = isPlainObject(data.delta) ? data.delta : {}
        if (typeof delta.text === 'string') block.text += delta.text
        if (typeof delta.thinking === 'string') block.thinking += delta.thinking
        if (typeof delta.signature === 'string') block.signature = (block.signature ?? '') + delta.signature
        if (typeof delta.partial_json === 'string') block.inputJsonText += delta.partial_json
        return true
      }
      if (event === 'content_block_stop') {
        // Nothing further to accumulate; the block's final parse happens
        // once, in result(), after every frame has been folded in.
        return true
      }
      if (event === 'message_delta') {
        if (isPlainObject(data.delta)) {
          if (typeof data.delta.stop_reason === 'string') stopReason = data.delta.stop_reason
          if (typeof data.delta.stop_sequence === 'string') stopSequence = data.delta.stop_sequence
        }
        // message_delta may also carry top-level fields (e.g. usage) worth
        // folding into the message envelope alongside message_start's.
        for (const key of Object.keys(data)) {
          if (key === 'delta' || key === 'type') continue
          message[key] = data[key]
        }
        return true
      }
      // message_stop carries no further content.
      return true
    },
    result() {
      const content: AnthropicContentBlock[] = [...blocks.values()]
        .sort((a, b) => a.index - b.index)
        .map((block): AnthropicContentBlock => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, signature: block.signature }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: tryParseJson(block.inputJsonText),
              inputJsonText: block.inputJsonText,
            }
          }
          return { type: block.type, ...block.extra }
        })

      const usage = isPlainObject(message.usage) ? message.usage : null
      return {
        id: typeof message.id === 'string' ? message.id : null,
        type: 'message',
        role: typeof message.role === 'string' ? message.role : null,
        model: typeof message.model === 'string' ? message.model : null,
        content,
        stop_reason: stopReason,
        stop_sequence: stopSequence,
        usage,
        ...Object.fromEntries(Object.entries(message).filter(([key]) =>
          !['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage'].includes(key))),
      }
    },
  }
}
