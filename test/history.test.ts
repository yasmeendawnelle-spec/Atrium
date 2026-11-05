import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from '../src/shared/types.ts'
import { repairHistory } from '../src/core/providers/types.ts'
import { toAnthropicMessages } from '../src/core/providers/anthropic.ts'
import { toOpenAiMessages } from '../src/core/providers/openai.ts'
import { toResponsesInput } from '../src/core/providers/responses.ts'
import { buildAnthropicThinking, needsSummarizedDisplay, supportsResponsesReasoning, thinkingMode } from '../src/shared/thinking.ts'
import { parseChromiumProxy } from '../src/core/net.ts'

const call = (id: string) => ({ id, name: 'read_file', input: { path: 'a.txt' } })

test('repairHistory adds a result for each tool call left unanswered', () => {
  const messages: Message[] = [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: '', toolCalls: [call('1'), call('2')] },
    { role: 'tool', toolCallId: '1', name: 'read_file', output: 'ok', isError: false },
    { role: 'user', text: 'stop' },
  ]
  const fixed = repairHistory(messages)
  assert.equal(fixed.length, 5)
  assert.deepEqual(fixed[3], { role: 'tool', toolCallId: '2', name: 'read_file', output: 'Cancelled by the user.', isError: true })
  assert.deepEqual(fixed[4], { role: 'user', text: 'stop' })
})

test('Anthropic: tool results become user blocks and thinking is replayed first', () => {
  const wire = toAnthropicMessages([
    { role: 'user', text: 'read it' },
    {
      role: 'assistant',
      text: 'Reading.',
      toolCalls: [call('t1')],
      thinking: [
        { thinking: 'plan', signature: 'sig' },
        { thinking: 'unsigned', signature: '' },
      ],
    },
    { role: 'tool', toolCallId: 't1', name: 'read_file', output: 'contents', isError: false },
    { role: 'user', text: 'thanks' },
  ])
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'user'])
  assert.deepEqual(wire[1]!.content.map((b) => b.type), ['thinking', 'text', 'tool_use'])
  // The unsigned block is dropped; the API would reject it.
  assert.equal(wire[1]!.content.filter((b) => b.type === 'thinking').length, 1)
  // The tool result and the next user text merge into one user turn.
  assert.deepEqual(wire[2]!.content.map((b) => b.type), ['tool_result', 'text'])
})

test('OpenAI: reasoning is echoed only on tool-call turns', () => {
  const wire = toOpenAiMessages('sys', [
    { role: 'user', text: 'q' },
    { role: 'assistant', text: '', toolCalls: [call('c1')], reasoning: 'r1' },
    { role: 'tool', toolCallId: 'c1', name: 'read_file', output: 'x', isError: false },
    { role: 'assistant', text: 'done', toolCalls: [], reasoning: 'r2' },
  ])
  assert.equal(wire[0]!.role, 'system')
  const withTools = wire[2] as { reasoning_content?: string; tool_calls?: unknown[] }
  assert.equal(withTools.reasoning_content, 'r1')
  assert.equal(withTools.tool_calls?.length, 1)
  assert.equal((wire[4] as { reasoning_content?: string }).reasoning_content, undefined)
})

test('thinking parameters match adaptive, budget, and responses models', () => {
  assert.equal(thinkingMode('claude-opus-5-5'), 'adaptive')
  assert.equal(thinkingMode('claude-sonnet-4-6'), 'adaptive')
  assert.equal(thinkingMode('claude-haiku-4-5'), 'budget')
  assert.equal(thinkingMode('claude-sonnet-4-5-20250929'), 'budget')
  assert.equal(thinkingMode('claude-3-7-sonnet-20250219'), 'budget')
  assert.equal(thinkingMode('deepseek-chat'), 'none')
  assert.equal(needsSummarizedDisplay('claude-opus-5-5'), true)
  assert.equal(needsSummarizedDisplay('claude-sonnet-4-6'), false)
  assert.equal(needsSummarizedDisplay('claude-fable-5-2'), true)

  assert.deepEqual(buildAnthropicThinking('claude-opus-5-5', 64_000, 'high'), {
    thinking: { type: 'adaptive', display: 'summarized' },
    outputConfig: { effort: 'high' },
  })
  assert.deepEqual(buildAnthropicThinking('claude-sonnet-4-6', 64_000, 'auto'), {
    thinking: { type: 'adaptive' },
    outputConfig: undefined,
  })
  assert.deepEqual(buildAnthropicThinking('claude-opus-4-5', 64_000, 'low'), {
    thinking: { type: 'enabled', budget_tokens: 4096 },
  })
  assert.deepEqual(buildAnthropicThinking('claude-opus-5-5', 16, 'high'), {})

  assert.equal(supportsResponsesReasoning('gpt-5-codex'), true)
  assert.equal(supportsResponsesReasoning('o3'), true)
  assert.equal(supportsResponsesReasoning('gpt-4o'), false)
})

test('Anthropic: redacted_thinking replays intact and cache breakpoints tag recent user turns', () => {
  const wire = toAnthropicMessages(
    [
      { role: 'user', text: 'turn 1' },
      {
        role: 'assistant',
        text: 'ok',
        toolCalls: [],
        thinking: [
          { type: 'redacted_thinking', thinking: '', signature: '', data: 'enc_blob' },
          { type: 'thinking', thinking: 'step', signature: 'sig1' },
        ],
      },
      { role: 'user', text: 'turn 2' },
    ],
    { cache: true },
  )
  assert.deepEqual(wire[1]!.content.map((b) => b.type), ['redacted_thinking', 'thinking', 'text'])
  assert.deepEqual((wire[0]!.content[0] as { cache_control?: unknown }).cache_control, { type: 'ephemeral' })
  assert.deepEqual((wire[2]!.content[0] as { cache_control?: unknown }).cache_control, { type: 'ephemeral' })
})

test('Responses: reasoning items, output_text, function_call, and function_call_output convert accurately', () => {
  const input = toResponsesInput([
    { role: 'user', text: 'edit app.ts' },
    {
      role: 'assistant',
      text: 'Applying change.',
      toolCalls: [{ id: 'call_1', itemId: 'fc_1', name: 'edit_file', input: { path: 'app.ts', old_string: 'a', new_string: 'b' } }],
      reasoningItems: [{ id: 'rs_1', summary: 'Check app.ts', encryptedContent: 'enc_payload' }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'edit_file', output: 'Edited app.ts (1 replacement).', isError: false },
  ])
  assert.deepEqual(input.map((x) => x.type), ['message', 'reasoning', 'message', 'function_call', 'function_call_output'])
  assert.equal(input[1]!.encrypted_content, 'enc_payload')
  assert.equal((input[2]!.content as { type: string }[])[0]!.type, 'output_text')
  assert.equal(input[3]!.id, 'fc_1')
  assert.equal(input[3]!.call_id, 'call_1')
  assert.equal(input[4]!.call_id, 'call_1')
})

test('parseChromiumProxy picks the first usable proxy', () => {
  assert.equal(parseChromiumProxy('PROXY 127.0.0.1:7897; DIRECT'), 'http://127.0.0.1:7897')
  assert.equal(parseChromiumProxy('DIRECT'), null)
  assert.equal(parseChromiumProxy('SOCKS5 127.0.0.1:1080; PROXY 10.0.0.1:8080'), 'http://10.0.0.1:8080')
  assert.equal(parseChromiumProxy('HTTPS proxy.example:443'), 'https://proxy.example:443')
})
