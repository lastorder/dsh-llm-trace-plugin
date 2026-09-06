/**
 * Dispatches every frame of a parsed SSE stream to each registered
 * per-provider adapter, and assembles the unified merge result.
 *
 * Adding support for another provider's stream shape means adding one new
 * adapter file (see `anthropic.ts` / `openai-responses.ts` /
 * `openai-chat-completions.ts` for the pattern) and registering it in
 * {@link ADAPTERS} below — nothing else in this module needs to change.
 *
 * @module dsh-llm-trace-plugin/client/sse-merge/index
 */

import type { SseMergeAdapter } from './shared.js'
import { createAnthropicAdapter, type AnthropicMergedMessage } from './anthropic.js'
import { createOpenAiResponsesAdapter, type ResponsesMergedResult } from './openai-responses.js'
import { createOpenAiChatCompletionsAdapter, type ChatCompletionMergedResult } from './openai-chat-completions.js'

export type {
  AnthropicMergedMessage,
  AnthropicContentBlock,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
} from './anthropic.js'
export type {
  ResponsesMergedResult,
  ResponsesOutputItem,
  ResponsesMessageItem,
  ResponsesReasoningItem,
  ResponsesFunctionCallItem,
} from './openai-responses.js'
export type {
  ChatCompletionMergedResult,
  ChatCompletionMergedChoice,
  ChatCompletionMergedMessage,
  ChatCompletionToolCall,
} from './openai-chat-completions.js'

/**
 * One factory per recognized provider shape. A frame is offered to each
 * adapter, in this order, until one recognizes it; a frame no adapter
 * recognizes is reported back to the caller untouched (see
 * `mergeSseChunks`). Order does not affect correctness — no two adapters
 * recognize the same frame shape — so this list is purely a registry, not a
 * priority chain.
 */
const ADAPTER_FACTORIES: (() => SseMergeAdapter<unknown>)[] = [
  createAnthropicAdapter,
  createOpenAiResponsesAdapter,
  createOpenAiChatCompletionsAdapter,
]

export interface MergedSseResult {
  /** Present when the Anthropic Messages API adapter recognized at least one frame. */
  anthropic: AnthropicMergedMessage | null
  /** Present when the OpenAI Responses API adapter recognized at least one frame. */
  responses: ResponsesMergedResult | null
  /** Present when the OpenAI/DeepSeek Chat Completions adapter recognized at least one frame. */
  chatCompletion: ChatCompletionMergedResult | null
  frameCount: number
  /** How many frames were recognized by any adapter and folded into one of the results above. */
  recognizedFrameCount: number
  /** Whether a `data: [DONE]` sentinel frame was seen. */
  sawDone: boolean
  /**
   * Every frame no adapter recognized — an unrecognized `event:` type, a
   * payload none of the registered shapes match, the `[DONE]` sentinel, an
   * unparseable payload. Kept verbatim so nothing this plugin doesn't
   * understand is ever silently dropped; it stays inspectable right
   * alongside the merged result.
   */
  unrecognized: Record<string, unknown>[]
}

/**
 * Reassemble the fragmented delta chunks of a streamed chat completion into
 * one complete, readable structure — the SAME shape that provider's own
 * non-streamed response would have had, reconstructed from the increments
 * instead of read off the wire whole. See the module docs on each adapter
 * (`anthropic.ts` / `openai-responses.ts` / `openai-chat-completions.ts`)
 * for the exact shape each one targets and why.
 *
 * A raw SSE stream is close to unreadable directly: a single reply is
 * typically split across dozens to hundreds of frames, each carrying only a
 * character or two of text. Every frame is offered to every registered
 * adapter; a frame that matches none of them is never guessed at or forced
 * into any shape — it is collected into `unrecognized` so it stays fully
 * visible rather than being silently dropped by a merge rule that doesn't
 * apply to it.
 *
 * @param frames - the frame sequence produced by `parseSseFrames`.
 */
export function mergeSseChunks(frames: Record<string, unknown>[]): MergedSseResult {
  const adapters = ADAPTER_FACTORIES.map((factory) => factory())
  const unrecognized: Record<string, unknown>[] = []
  let recognizedFrameCount = 0
  let sawDone = false

  for (const frame of frames) {
    if (frame.data === '[DONE]') {
      sawDone = true
      continue
    }
    let recognized = false
    for (const adapter of adapters) {
      if (adapter.fold(frame)) {
        recognized = true
        break
      }
    }
    if (recognized) recognizedFrameCount += 1
    else unrecognized.push(frame)
  }

  const [anthropicAdapter, responsesAdapter, chatCompletionAdapter] = adapters
  return {
    anthropic: anthropicAdapter.recognizedAny ? (anthropicAdapter.result() as AnthropicMergedMessage) : null,
    responses: responsesAdapter.recognizedAny ? (responsesAdapter.result() as ResponsesMergedResult) : null,
    chatCompletion: chatCompletionAdapter.recognizedAny ? (chatCompletionAdapter.result() as ChatCompletionMergedResult) : null,
    frameCount: frames.length,
    recognizedFrameCount,
    sawDone,
    unrecognized,
  }
}
