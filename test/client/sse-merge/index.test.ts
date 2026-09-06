import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSseChunks } from '../../../src/client/sse-merge/index.js'
import { parseSseFrames } from '../../../src/client/sse.js'

function sseBody(frames: Array<[string | null, unknown]>): string {
  return frames.map(([event, data]) => {
    const dataLine = 'data: ' + (typeof data === 'string' ? data : JSON.stringify(data))
    return event === null ? dataLine : `event: ${event}\n${dataLine}`
  }).join('\n\n') + '\n\n'
}

function merge(frames: Array<[string | null, unknown]>) {
  return mergeSseChunks(parseSseFrames(sseBody(frames)))
}

// -- OpenAI/DeepSeek Chat Completions --

test('chatCompletion: merges fragmented content, reasoning_content, and tool_calls across frames', () => {
  const result = merge([
    [null, { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant' } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: { reasoning_content: 'Let ' } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: { reasoning_content: 'me think.' } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: { content: 'Hel' } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: { content: 'lo!' } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"weather"}' } }] } }] }],
    [null, { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
    [null, '[DONE]'],
  ])

  assert.equal(result.anthropic, null)
  assert.equal(result.responses, null)
  const choice = result.chatCompletion!.choices[0]
  assert.equal(choice.message.content, 'Hello!')
  assert.equal(choice.message.reasoning_content, 'Let me think.')
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.equal(choice.message.tool_calls![0].function.arguments, '{"q":"weather"}')
  assert.deepEqual(choice.message.tool_calls![0].argumentsJson, { q: 'weather' })
  assert.equal(result.sawDone, true)
})

test('chatCompletion: an unrecognized event and a comment-only frame land in unrecognized, not silently dropped', () => {
  const frames = parseSseFrames([
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] }),
    '',
    ': keep-alive',
    '',
    'event: unknown_event',
    'data: {"weird":true}',
    '',
  ].join('\n'))
  const result = mergeSseChunks(frames)
  assert.equal(result.unrecognized.length, 2)
  assert.ok(result.unrecognized.some((f) => f.event === 'unknown_event'))
})

test('chatCompletion: content stays null (not empty string) when no delta.content fragment ever arrived', () => {
  const result = merge([[null, { choices: [{ index: 0, delta: { reasoning_content: 'x' } }] }]])
  assert.equal(result.chatCompletion!.choices[0].message.content, null)
})

// -- Anthropic Messages API --

test('anthropic: merges text and tool_use blocks into the official non-streamed message shape', () => {
  const result = merge([
    ['message_start', { message: { id: 'msg_1', model: 'claude-x', role: 'assistant', usage: {} } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo!' } }],
    ['content_block_stop', { index: 0 }],
    ['content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } }],
    ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }],
    ['content_block_stop', { index: 1 }],
    ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', {}],
    [null, '[DONE]'],
  ])

  assert.equal(result.chatCompletion, null)
  assert.equal(result.responses, null)
  const message = result.anthropic!
  assert.equal(message.id, 'msg_1')
  assert.equal(message.type, 'message')
  assert.equal(message.content[0].type, 'text')
  assert.equal((message.content[0] as any).text, 'Hello!')
  assert.equal(message.content[1].type, 'tool_use')
  assert.equal((message.content[1] as any).id, 'toolu_1')
  assert.equal((message.content[1] as any).name, 'bash')
  assert.deepEqual((message.content[1] as any).input, { cmd: 'ls' })
  assert.equal(message.stop_reason, 'tool_use')
})

test('anthropic: merges a thinking block including its signature', () => {
  const result = merge([
    ['message_start', { message: { id: 'msg_1' } }],
    ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } }],
    ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'consider this.' } }],
    ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }],
    ['content_block_stop', { index: 0 }],
    ['message_stop', {}],
  ])
  const block = result.anthropic!.content[0] as any
  assert.equal(block.type, 'thinking')
  assert.equal(block.thinking, 'Let me consider this.')
  assert.equal(block.signature, 'sig-abc')
})

test('anthropic: message_delta extras (e.g. a provider-specific usage extension) are preserved alongside official fields', () => {
  const result = merge([
    ['message_start', { message: { id: 'msg_1' } }],
    ['message_delta', { delta: { stop_reason: 'end_turn' }, copilot_usage: { total_nano_aiu: 123 } }],
    ['message_stop', {}],
  ])
  assert.deepEqual((result.anthropic as any).copilot_usage, { total_nano_aiu: 123 })
})

test('anthropic: a lone ping frame is the only thing left unrecognized (real-world heartbeat)', () => {
  const result = merge([
    ['message_start', { message: { id: 'msg_1' } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['ping', { type: 'ping' }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }],
    ['content_block_stop', { index: 0 }],
    ['message_stop', {}],
  ])
  assert.equal(result.unrecognized.length, 1)
  assert.equal(result.unrecognized[0].event, 'ping')
  assert.equal((result.anthropic!.content[0] as any).text, 'hi')
})

// -- OpenAI Responses API --

test('responses: merges a message item\'s output_text.delta fragments', () => {
  const result = merge([
    ['response.created', { response: { id: 'resp_1', model: 'gpt-5', status: 'in_progress' } }],
    ['response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message' } }],
    ['response.output_text.delta', { output_index: 0, delta: 'Hel' }],
    ['response.output_text.delta', { output_index: 0, delta: 'lo!' }],
    ['response.output_item.done', { output_index: 0, item: { id: 'msg_1', type: 'message' } }],
    ['response.completed', { response: { id: 'resp_1', model: 'gpt-5', status: 'completed' } }],
  ])
  assert.equal(result.anthropic, null)
  assert.equal(result.chatCompletion, null)
  const item = result.responses!.output[0] as any
  assert.equal(item.type, 'message')
  assert.deepEqual(item.content, [{ type: 'output_text', text: 'Hello!' }])
  assert.equal(result.responses!.status, 'completed')
})

test('responses: merges a reasoning item\'s summary text and a function_call item\'s arguments', () => {
  const result = merge([
    ['response.created', { response: { id: 'resp_1' } }],
    ['response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning' } }],
    ['response.reasoning_summary_text.delta', { output_index: 0, delta: 'Thinking ' }],
    ['response.reasoning_summary_text.delta', { output_index: 0, delta: 'about it.' }],
    ['response.output_item.done', { output_index: 0, item: { id: 'rs_1', type: 'reasoning' } }],
    ['response.output_item.added', { output_index: 1, item: { id: 'fc_1', call_id: 'fc_1', type: 'function_call', name: 'search' } }],
    ['response.function_call_arguments.delta', { output_index: 1, delta: '{"q":' }],
    ['response.function_call_arguments.delta', { output_index: 1, delta: '"weather"}' }],
    ['response.output_item.done', { output_index: 1, item: { id: 'fc_1', call_id: 'fc_1', type: 'function_call', name: 'search', arguments: '{"q":"weather"}' } }],
    ['response.completed', { response: { id: 'resp_1', status: 'completed' } }],
  ])
  const reasoning = result.responses!.output[0] as any
  const call = result.responses!.output[1] as any
  assert.deepEqual(reasoning.summary, [{ type: 'summary_text', text: 'Thinking about it.' }])
  assert.equal(reasoning.content, null)
  assert.equal(call.type, 'function_call')
  assert.equal(call.call_id, 'fc_1')
  assert.equal(call.name, 'search')
  assert.equal(call.arguments, '{"q":"weather"}')
  assert.deepEqual(call.argumentsJson, { q: 'weather' })
})

test('responses: REGRESSION — a message item\'s own id is never misread as a function-call id', () => {
  // This is the exact bug this project fixed once: response.output_item.done's
  // fallback whole-value read applied unconditionally, so a message item's own
  // `id` field leaked into `callId`. It must only ever populate callId for a
  // function_call item.
  const result = merge([
    ['response.output_item.added', { output_index: 0, item: { id: 'msg_should_not_leak', type: 'message' } }],
    ['response.output_text.delta', { output_index: 0, delta: 'hello' }],
    ['response.output_item.done', { output_index: 0, item: { id: 'msg_should_not_leak', type: 'message' } }],
  ])
  const item = result.responses!.output[0] as any
  assert.equal(item.type, 'message')
  assert.equal(item.callId, undefined) // message items carry no callId field at all
})

test('responses: reasoning_text.delta (verbatim) and reasoning_summary_text.delta (summary) are two independent fields', () => {
  const verbatimOnly = merge([
    ['response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning' } }],
    ['response.reasoning_text.delta', { output_index: 0, delta: 'raw reasoning' }],
  ])
  const reasoningItem = verbatimOnly.responses!.output[0] as any
  assert.deepEqual(reasoningItem.content, [{ type: 'reasoning_text', text: 'raw reasoning' }])
  assert.deepEqual(reasoningItem.summary, [])
})

test('responses: an unrecognized event type is collected verbatim into unrecognized', () => {
  const frames = parseSseFrames([
    'event: response.created',
    'data: ' + JSON.stringify({ response: { id: 'resp_1' } }),
    '',
    'event: response.some_future_event_type',
    'data: {"whatever":true}',
    '',
  ].join('\n'))
  const result = mergeSseChunks(frames)
  assert.equal(result.unrecognized.length, 1)
  assert.equal(result.unrecognized[0].event, 'response.some_future_event_type')
})

// -- Cross-format isolation --

test('a stream with only one recognized shape never produces a non-null result for the other two', () => {
  const openAiOnly = merge([[null, { choices: [{ index: 0, delta: { content: 'hi' } }] }]])
  assert.equal(openAiOnly.anthropic, null)
  assert.equal(openAiOnly.responses, null)
  assert.notEqual(openAiOnly.chatCompletion, null)
})

test('frameCount always equals the total frames offered, including [DONE] and unrecognized ones', () => {
  const result = merge([
    [null, { choices: [{ index: 0, delta: { content: 'hi' } }] }],
    ['unknown_event', { x: 1 }],
    [null, '[DONE]'],
  ])
  assert.equal(result.frameCount, 3)
  assert.equal(result.recognizedFrameCount, 1)
})
