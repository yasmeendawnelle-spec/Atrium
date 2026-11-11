import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type RequestListener, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Conversation, Protocol } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { describeNetworkError } from '../src/core/net.ts'
import { anthropicAdapter } from '../src/core/providers/anthropic.ts'
import { buildOpenAiBody, openAiAdapter } from '../src/core/providers/openai.ts'
import { responsesAdapter } from '../src/core/providers/responses.ts'
import type { SettingsStore } from '../src/core/settings.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'

function baseConversation(): Conversation {
  return { id: 'c_trunc', title: 'trunc', createdAt: 1, updatedAt: 1, messages: [] }
}

function makeLoop(protocol: Protocol, baseUrl: string, workspace: string, onEvent?: (e: AgentEvent, loop: AgentLoop) => void) {
  const settings = {
    activeProvider: () => ({ id: 'p1', name: 'Mock', protocol, baseUrl, model: 'mock-model', hasKey: true }),
    providerKey: async () => 'test-key',
    get: () => ({ workspace }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
  const events: AgentEvent[] = []
  const saves: Conversation[] = []
  const loop: AgentLoop = new AgentLoop({
    settings,
    mcp,
    emit: (e) => {
      events.push(e)
      onEvent?.(e, loop)
    },
    save: async (c) => {
      saves.push(structuredClone(c))
    },
    systemPrompt: () => 'sys',
  })
  return { loop, events, saves }
}

async function startServer(
  handler: RequestListener,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    req.resume()
    handler(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

test('buildOpenAiBody forwards explicit maxTokens when specified', () => {
  const body = buildOpenAiBody(
    { baseUrl: 'https://api.example.com/v1', apiKey: 'k' },
    { model: 'm', system: 's', messages: [], tools: [], signal: new AbortController().signal, maxTokens: 2048 },
    true,
  )
  assert.equal(body.max_tokens, 2048)
})

test('provider adapters mark premature SSE EOF without terminal marker as incompleteStream', { timeout: 20_000 }, async (t) => {
  const { server: oaiServer, port: oaiPort } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Half OpenAI' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: null }] })}\n\n`)
    res.end()
  })
  t.after(() => oaiServer.close())

  const oaiRes = await openAiAdapter.chat(
    { baseUrl: `http://127.0.0.1:${oaiPort}/v1`, apiKey: 'k' },
    { model: 'm', system: '', messages: [{ role: 'user', text: 'hi' }], tools: [], signal: new AbortController().signal },
    { onText: () => undefined },
  )
  assert.equal(oaiRes.text, 'Half OpenAI')
  assert.equal(oaiRes.incompleteStream, true)
  assert.equal(oaiRes.stopReason, 'incomplete_stream')
  assert.deepEqual(oaiRes.toolCalls, [])

  const { server: antServer, port: antPort } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half Claude' } })}\n\n`)
    res.end()
  })
  t.after(() => antServer.close())

  const antRes = await anthropicAdapter.chat(
    { baseUrl: `http://127.0.0.1:${antPort}`, apiKey: 'k' },
    { model: 'claude', system: '', messages: [{ role: 'user', text: 'hi' }], tools: [], signal: new AbortController().signal },
    { onText: () => undefined },
  )
  assert.equal(antRes.text, 'Half Claude')
  assert.equal(antRes.incompleteStream, true)
  assert.equal(antRes.stopReason, 'incomplete_stream')

  const { server: respServer, port: respPort } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Half Codex' })}\n\n`)
    res.end()
  })
  t.after(() => respServer.close())

  const respRes = await responsesAdapter.chat(
    { baseUrl: `http://127.0.0.1:${respPort}/v1`, apiKey: 'k' },
    { model: 'gpt-5-codex', system: '', messages: [{ role: 'user', text: 'hi' }], tools: [], signal: new AbortController().signal },
    { onText: () => undefined },
  )
  assert.equal(respRes.text, 'Half Codex')
  assert.equal(respRes.incompleteStream, true)
  assert.equal(respRes.stopReason, 'incomplete_stream')
})

test('AgentLoop emits truncated(token_limit) when OpenAI finish_reason is length', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-trunc-len-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Truncated by length' }, finish_reason: 'length' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  t.after(() => server.close())

  const { loop, events } = makeLoop('openai', `http://127.0.0.1:${port}/v1`, ws)
  const conv = baseConversation()
  await loop.run(conv, 'write long prose')

  const last = conv.messages.at(-1)
  assert.equal(last?.role, 'assistant')
  if (last?.role === 'assistant') {
    assert.equal(last.text, 'Truncated by length')
    assert.equal(last.incomplete, 'token_limit')
  }
  assert.deepEqual(events.at(-1), {
    type: 'turn_end',
    conversationId: conv.id,
    reason: 'truncated',
    truncation: 'token_limit',
  })
})

test('AgentLoop emits truncated(stream_interrupted) on premature EOF and error on empty EOF', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-trunc-eof-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  let reqNum = 0
  const { server, port } = await startServer((_req, res) => {
    reqNum++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (reqNum === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Partial SSE' }, finish_reason: null }] })}\n\n`)
    }
    res.end()
  })
  t.after(() => server.close())

  const { loop, events } = makeLoop('openai', `http://127.0.0.1:${port}/v1`, ws)
  const conv1 = baseConversation()
  await loop.run(conv1, 'hello')
  const last = conv1.messages.at(-1)
  assert.equal(last?.role, 'assistant')
  if (last?.role === 'assistant') {
    assert.equal(last.text, 'Partial SSE')
    assert.equal(last.incomplete, 'stream_interrupted')
  }
  assert.deepEqual(events.at(-1), {
    type: 'turn_end',
    conversationId: conv1.id,
    reason: 'truncated',
    truncation: 'stream_interrupted',
  })

  const conv2 = { ...baseConversation(), id: 'c_empty_eof' }
  await loop.run(conv2, 'hello')
  assert.equal(conv2.messages.length, 1)
  const lastEvt = events.at(-1)
  assert.equal(lastEvt?.type, 'turn_end')
  if (lastEvt?.type === 'turn_end') assert.equal(lastEvt.reason, 'error')
})

test('AgentLoop preserves streamed partial text when socket drops or turn aborts mid-stream', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-drop-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  let mode: 'drop' | 'abort' = 'drop'
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Thought ', content: 'Keep me' }, finish_reason: null }] })}\n\n`)
    if (mode === 'drop') {
      setTimeout(() => res.socket?.destroy(new Error('reset')), 15)
    }
  })
  t.after(() => server.close())

  const { loop, events } = makeLoop('openai', `http://127.0.0.1:${port}/v1`, ws, (e, l) => {
    if (mode === 'abort' && e.type === 'text_delta') {
      l.stop(e.conversationId)
    }
  })

  const convDrop = baseConversation()
  await loop.run(convDrop, 'stream and drop')
  const droppedMsg = convDrop.messages.at(-1)
  assert.equal(droppedMsg?.role, 'assistant')
  if (droppedMsg?.role === 'assistant') {
    assert.equal(droppedMsg.text, 'Keep me')
    assert.equal(droppedMsg.reasoning, 'Thought ')
    assert.equal(droppedMsg.incomplete, 'error')
  }
  assert.ok(events.some((e) => e.type === 'error'))
  assert.deepEqual(events.at(-1), { type: 'turn_end', conversationId: convDrop.id, reason: 'error' })

  mode = 'abort'
  events.length = 0
  const convAbort = { ...baseConversation(), id: 'c_abort_partial' }
  await loop.run(convAbort, 'stream and abort')
  const abortedMsg = convAbort.messages.at(-1)
  assert.equal(abortedMsg?.role, 'assistant')
  if (abortedMsg?.role === 'assistant') {
    assert.equal(abortedMsg.text, 'Keep me')
    assert.equal(abortedMsg.incomplete, 'aborted')
  }
  assert.deepEqual(events.at(-1), { type: 'turn_end', conversationId: convAbort.id, reason: 'aborted' })
})

test('AgentLoop does not execute a malformed tool call alongside badArguments when JSON was cut off', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-badargs-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'keep.txt'), 'original')

  let round = 0
  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    round++
    if (round === 1) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: 'write_file', arguments: '{"path":"keep.txt","content":"broken' } }] },
              finish_reason: 'length',
            },
          ],
        })}\n\n`,
      )
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Fixed.' }, finish_reason: 'stop' }] })}\n\n`)
    }
    res.end('data: [DONE]\n\n')
  })
  t.after(() => server.close())

  const { loop } = makeLoop('openai', `http://127.0.0.1:${port}/v1`, ws)
  const conv = baseConversation()
  await loop.run(conv, 'write file')

  const toolResults = conv.messages.filter((m) => m.role === 'tool')
  assert.equal(toolResults.length, 1)
  assert.equal(toolResults[0]?.isError, true)
  assert.match(toolResults[0]?.output ?? '', /output token limit/i)
  assert.equal(await readFile(join(ws, 'keep.txt'), 'utf8'), 'original')
})

test('describeNetworkError explains body timeout and mid-stream socket drops clearly', () => {
  const timeoutMsg = describeNetworkError(
    { message: 'fetch failed', cause: { code: 'UND_ERR_BODY_TIMEOUT', message: 'Body Timeout Error' } },
    'https://api.example.com/v1',
  )
  assert.match(timeoutMsg, /api\.example\.com/)
  assert.match(timeoutMsg, /UND_ERR_BODY_TIMEOUT/)

  const droppedMsg = describeNetworkError(new Error('terminated'), 'https://api.example.com/v1')
  assert.match(droppedMsg, /dropped mid-response/)
})
