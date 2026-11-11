// Runs the real agent loop against a local mock of an OpenAI-compatible
// streaming API, with real workspace file tools and approvals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Conversation } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import type { SettingsStore } from '../src/core/settings.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'

type Reply = { text?: string; tool?: { name: string; args: string } }

async function mockModel(replies: Reply[]): Promise<{ server: Server; url: string; requests: any[] }> {
  const requests: any[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      const reply = replies.shift() ?? { text: 'out of replies' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (reply.tool) {
        // Arguments arrive split across chunks, as real servers send them.
        const half = Math.floor(reply.tool.args.length / 2)
        send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: reply.tool.name, arguments: reply.tool.args.slice(0, half) } }] })
        send({ tool_calls: [{ index: 0, function: { arguments: reply.tool.args.slice(half) } }] }, 'tool_calls')
      } else {
        for (const word of (reply.text ?? '').split(' ')) send({ content: `${word} ` })
        send({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/v1`, requests }
}

function makeLoop(baseUrl: string, workspace: string, onEvent: (e: AgentEvent, loop: AgentLoop) => void) {
  const settings = {
    activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl, model: 'mock-1', hasKey: true }),
    providerKey: async () => 'test-key',
    get: () => ({ workspace }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
  const events: AgentEvent[] = []
  const loop: AgentLoop = new AgentLoop({
    settings,
    mcp,
    emit: (e) => {
      events.push(e)
      onEvent(e, loop)
    },
    save: async () => undefined,
    systemPrompt: () => 'test',
  })
  return { loop, events }
}

const conversation = (): Conversation => ({ id: 'c1', title: '', createdAt: 0, updatedAt: 0, messages: [] })

test('reads a workspace file with a tool, then answers', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-agent-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'hello.txt'), 'hi there')
  const mock = await mockModel([{ tool: { name: 'read_file', args: '{"path":"hello.txt"}' } }, { text: 'The file says hi there' }])
  t.after(() => mock.server.close())

  const { loop, events } = makeLoop(mock.url, ws, () => undefined)
  const conv = conversation()
  await loop.run(conv, 'what is in hello.txt?')

  assert.deepEqual(conv.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant'])
  const toolMsg = conv.messages[2] as Extract<Conversation['messages'][number], { role: 'tool' }>
  assert.equal(toolMsg.output, 'hi there')
  assert.equal(toolMsg.isError, false)
  // The second request carried the tool result back to the model.
  assert.equal(mock.requests[1].messages.at(-1).role, 'tool')
  assert.equal(mock.requests[0].headers, undefined)
  assert.ok(mock.requests[0].tools.some((tool: any) => tool.function.name === 'write_file'))
  const streamed = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')
  assert.equal(streamed.trim(), 'The file says hi there')
  assert.deepEqual(events.at(-1), { type: 'turn_end', conversationId: 'c1', reason: 'done' })
})

test('writing a file waits for approval and happens only when allowed', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-agent-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  const args = JSON.stringify({ path: 'notes/out.txt', content: 'written by atrium' })
  const mock = await mockModel([{ tool: { name: 'write_file', args } }, { text: 'Done.' }])
  t.after(() => mock.server.close())

  const { loop, events } = makeLoop(mock.url, ws, (e, l) => {
    if (e.type === 'approval') {
      assert.equal(e.request.kind, 'write')
      assert.equal(e.request.summary, 'Write notes/out.txt')
      l.approve(e.request.approvalId, 'allow')
    }
  })
  await loop.run(conversation(), 'write a note')
  assert.equal(await readFile(join(ws, 'notes', 'out.txt'), 'utf8'), 'written by atrium')
  assert.ok(events.some((e) => e.type === 'tool_status' && e.status === 'awaiting_approval'))
})

test('a denied command is not run and the model is told', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-agent-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  const args = JSON.stringify({ command: 'echo should-not-run > ran.txt' })
  const mock = await mockModel([{ tool: { name: 'run_command', args } }, { text: 'Understood.' }])
  t.after(() => mock.server.close())

  const { loop } = makeLoop(mock.url, ws, (e, l) => {
    if (e.type === 'approval') l.approve(e.request.approvalId, 'deny')
  })
  const conv = conversation()
  await loop.run(conv, 'run it')
  const toolMsg = conv.messages.find((m) => m.role === 'tool') as { output: string; isError: boolean }
  assert.deepEqual([toolMsg.output, toolMsg.isError], ['The user denied this action.', true])
  await assert.rejects(readFile(join(ws, 'ran.txt')))
})

test('stopping a turn while it waits for approval ends it cleanly', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-agent-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  const mock = await mockModel([{ tool: { name: 'run_command', args: '{"command":"echo hi"}' } }])
  t.after(() => mock.server.close())

  const { loop, events } = makeLoop(mock.url, ws, (e, l) => {
    if (e.type === 'approval') l.stop('c1')
  })
  await loop.run(conversation(), 'run it')
  assert.equal(loop.busy('c1'), false)
  assert.deepEqual(events.at(-1), { type: 'turn_end', conversationId: 'c1', reason: 'aborted' })
})

test('Responses (Codex): streams reasoning & function_call, approves edit_file diff, and replays encrypted_content', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-resp-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'app.ts'), 'const mode = "dev"\nconsole.log(mode)\n')

  const requests: any[] = []
  let turn = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (type: string, payload: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
      if (turn++ === 0) {
        emit('response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } })
        emit('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, delta: 'Need to update mode.' })
        emit('response.output_item.done', {
          output_index: 0,
          item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need to update mode.' }], encrypted_content: 'enc_xyz' },
        })
        const editArgs = JSON.stringify({ path: 'app.ts', old_string: '"dev"', new_string: '"prod"' })
        emit('response.output_item.added', { output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_edit_1', name: 'edit_file', arguments: '' } })
        emit('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: editArgs })
        emit('response.output_item.done', { output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_edit_1', name: 'edit_file', arguments: editArgs } })
        emit('response.completed', { response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 0 } } } })
      } else {
        emit('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message' } })
        emit('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: 'Updated to prod.' })
        emit('response.completed', { response: { status: 'completed', usage: { input_tokens: 200, output_tokens: 10, input_tokens_details: { cached_tokens: 150 } } } })
      }
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const port = (server.address() as { port: number }).port

  const settings = {
    activeProvider: () => ({ id: 'p', name: 'OpenAI', protocol: 'responses', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'gpt-5-codex', hasKey: true }),
    providerKey: async () => 'test-key',
    get: () => ({ workspace: ws, reasoningEffort: 'high' as const }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
  const approvals: any[] = []
  const loop: AgentLoop = new AgentLoop({
    settings,
    mcp,
    emit: (e) => {
      if (e.type === 'approval') {
        approvals.push(e.request)
        loop.approve(e.request.approvalId, 'allow')
      }
    },
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })

  const conv = conversation()
  await loop.run(conv, 'switch mode to prod')

  assert.equal(await readFile(join(ws, 'app.ts'), 'utf8'), 'const mode = "prod"\nconsole.log(mode)\n')
  assert.equal(approvals[0].kind, 'edit')
  assert.match(approvals[0].detail, /-const mode = "dev"/)
  assert.match(approvals[0].detail, /\+const mode = "prod"/)

  assert.equal(requests[0].store, false)
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content'])
  assert.equal(requests[0].prompt_cache_key, 'c1')
  assert.deepEqual(requests[0].reasoning, { effort: 'high', summary: 'auto' })
  assert.equal(requests[1].input.find((x: any) => x.type === 'reasoning').encrypted_content, 'enc_xyz')
  assert.equal(requests[1].input.at(-1).type, 'function_call_output')
  assert.equal((conv.messages.at(-1) as any).usage.cacheReadTokens, 150)
})

test('Anthropic (Claude): sends prompt cache breakpoints, loads CLAUDE.md, and preserves redacted_thinking', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-claude-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'CLAUDE.md'), 'Always respond tersely.')

  const requests: any[] = []
  let turn = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emit = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`)
      if (turn++ === 0) {
        emit({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 400, output_tokens: 1 } } })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'redacted_secret' } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_dir' } })
        emit({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } })
        emit({ type: 'content_block_stop', index: 1 })
        emit({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 25 } })
      } else {
        emit({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 500, output_tokens: 1 } } })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })
      }
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const port = (server.address() as { port: number }).port

  const settings = {
    activeProvider: () => ({ id: 'p', name: 'Anthropic', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, model: 'claude-sonnet-5-5', presetId: 'anthropic', hasKey: true }),
    providerKey: async () => 'test-key',
    get: () => ({ workspace: ws, reasoningEffort: 'medium' as const }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
  const loop = new AgentLoop({
    settings,
    mcp,
    emit: () => undefined,
    save: async () => undefined,
    systemPrompt: (_ws, notes) => `base\n${notes ?? ''}`,
  })

  const conv = conversation()
  await loop.run(conv, 'list workspace')

  assert.match(requests[0].system[0].text, /Always respond tersely\./)
  assert.deepEqual(requests[0].system[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(requests[0].tools.at(-1).cache_control, { type: 'ephemeral' })
  assert.deepEqual(requests[0].thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(requests[0].output_config, { effort: 'medium' })
  assert.equal(requests[1].messages[1].content[0].type, 'redacted_thinking')
  assert.equal(requests[1].messages[1].content[0].data, 'redacted_secret')
  assert.deepEqual((conv.messages.at(-1) as any).usage, { inputTokens: 520, outputTokens: 8, cacheReadTokens: 500 })
})
