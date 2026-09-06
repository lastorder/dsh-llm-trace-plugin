/**
 * OpenAI/DeepSeek Chat Completions adapter: reassembles a stream shaped like
 * `POST /v1/chat/completions?stream=true` — an object with a top-level
 * `choices` array, each entry carrying `delta.content` /
 * `delta.reasoning_content` (DeepSeek's own extension) /
 * `delta.tool_calls[]` fragments and (eventually) a `finish_reason` — into
 * the exact shape the non-streamed response has: `choices[].message` with
 * `role`, `content`, and a fully reassembled `tool_calls[]`.
 *
 * @module dsh-llm-trace-plugin/client/sse-merge/openai-chat-completions
 */

import { isPlainObject, tryParseJson, type SseMergeAdapter } from './shared.js'

/** A reassembled tool call, matching `ChatCompletionMessageToolCall`. */
export interface ChatCompletionToolCall {
  id: string | null
  type: 'function'
  function: {
    name: string | null
    arguments: string
  }
  /** Convenience parse of `function.arguments`; not part of the official shape, appended because a reader almost always wants it. `null` while incomplete/malformed. */
  argumentsJson: unknown
}

/** The reassembled message, matching `ChatCompletionMessage`. */
export interface ChatCompletionMergedMessage {
  role: 'assistant'
  content: string | null
  /** DeepSeek's own extension field; `null` when the provider never sent one. */
  reasoning_content: string | null
  tool_calls: ChatCompletionToolCall[] | null
}

/** One reassembled `choices[]` entry, matching `ChatCompletion.Choice`. */
export interface ChatCompletionMergedChoice {
  index: number
  message: ChatCompletionMergedMessage
  finish_reason: string | null
}

/** The reassembled result, shaped like OpenAI's own non-streamed `ChatCompletion` object. */
export interface ChatCompletionMergedResult {
  id: string | null
  object: 'chat.completion'
  model: string | null
  choices: ChatCompletionMergedChoice[]
  usage: Record<string, unknown> | null
  /** Any other top-level field a chunk supplied, preserved verbatim. */
  [extra: string]: unknown
}

interface ToolCallState {
  index: number
  id: string | null
  name: string | null
  arguments: string
}

interface ChoiceState {
  index: number
  content: string
  hasContent: boolean
  reasoningContent: string
  hasReasoningContent: boolean
  toolCalls: Map<number, ToolCallState>
  finishReason: string | null
}

function newChoice(index: number): ChoiceState {
  return { index, content: '', hasContent: false, reasoningContent: '', hasReasoningContent: false, toolCalls: new Map(), finishReason: null }
}

function isDeltaChunk(data: unknown): data is Record<string, unknown> & { choices: unknown[] } {
  return isPlainObject(data) && Array.isArray(data.choices)
}

export function createOpenAiChatCompletionsAdapter(): SseMergeAdapter<ChatCompletionMergedResult> {
  const envelope: Record<string, unknown> = {}
  const choices = new Map<number, ChoiceState>()
  let recognizedAny = false

  const choiceAt = (index: number): ChoiceState => {
    let choice = choices.get(index)
    if (choice === undefined) {
      choice = newChoice(index)
      choices.set(index, choice)
    }
    return choice
  }

  return {
    name: 'openai-chat-completions',
    get recognizedAny() {
      return recognizedAny
    },
    fold(frame) {
      const data = frame.data
      if (!isDeltaChunk(data)) return false
      recognizedAny = true

      // Envelope fields (id/model/…) are the same shape on every chunk;
      // later chunks simply overwrite earlier ones, which is harmless since
      // they never legitimately differ mid-stream.
      for (const key of Object.keys(data)) {
        if (key === 'choices') continue
        envelope[key] = data[key]
      }

      for (const rawChoice of data.choices) {
        if (!isPlainObject(rawChoice)) continue
        const index = typeof rawChoice.index === 'number' ? rawChoice.index : 0
        const choice = choiceAt(index)

        const delta = isPlainObject(rawChoice.delta) ? rawChoice.delta : {}
        if (typeof delta.content === 'string') {
          choice.content += delta.content
          choice.hasContent = true
        }
        if (typeof delta.reasoning_content === 'string') {
          choice.reasoningContent += delta.reasoning_content
          choice.hasReasoningContent = true
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const rawCall of delta.tool_calls) {
            if (!isPlainObject(rawCall)) continue
            const callIndex = typeof rawCall.index === 'number' ? rawCall.index : 0
            let call = choice.toolCalls.get(callIndex)
            if (call === undefined) {
              call = { index: callIndex, id: null, name: null, arguments: '' }
              choice.toolCalls.set(callIndex, call)
            }
            if (typeof rawCall.id === 'string' && call.id === null) call.id = rawCall.id
            const fn = isPlainObject(rawCall.function) ? rawCall.function : {}
            if (typeof fn.name === 'string' && call.name === null) call.name = fn.name
            if (typeof fn.arguments === 'string') call.arguments += fn.arguments
          }
        }
        if (typeof rawChoice.finish_reason === 'string') choice.finishReason = rawChoice.finish_reason
      }
      return true
    },
    result() {
      const merged: ChatCompletionMergedChoice[] = [...choices.values()]
        .sort((a, b) => a.index - b.index)
        .map((choice) => {
          const toolCalls: ChatCompletionToolCall[] = [...choice.toolCalls.values()]
            .sort((a, b) => a.index - b.index)
            .map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
              argumentsJson: tryParseJson(call.arguments),
            }))
          return {
            index: choice.index,
            message: {
              role: 'assistant',
              content: choice.hasContent ? choice.content : null,
              reasoning_content: choice.hasReasoningContent ? choice.reasoningContent : null,
              tool_calls: toolCalls.length > 0 ? toolCalls : null,
            },
            finish_reason: choice.finishReason,
          }
        })

      const usage = isPlainObject(envelope.usage) ? envelope.usage : null
      return {
        id: typeof envelope.id === 'string' ? envelope.id : null,
        object: 'chat.completion',
        model: typeof envelope.model === 'string' ? envelope.model : null,
        choices: merged,
        usage,
        ...Object.fromEntries(Object.entries(envelope).filter(([key]) =>
          !['id', 'object', 'model', 'choices', 'usage'].includes(key))),
      }
    },
  }
}
