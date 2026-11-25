// Unit tests for protocol upgrades, workspace helpers, multimodal inputs, and AgentLoop features.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  isEmptyChatStub,
  type AgentEvent,
  type AppSettings,
  type Conversation,
  type ImageAttachment,
  type ProviderConfig,
} from '../src/shared/types.ts'
import { buildAnthropicThinking } from '../src/shared/thinking.ts'
import { AgentLoop, buildAlwaysAllowRule, matchesAllowedRules } from '../src/core/agent.ts'
import { ChatStore, titleFrom } from '../src/core/chats.ts'
import { computeContextBreakdown, estimateModelContextLimit, formatCompactTokens } from '../src/renderer/src/lib/contextUsage.ts'
import { SettingsStore } from '../src/core/settings.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import { chat, endpointFor } from '../src/core/providers/index.ts'
import { toAnthropicMessages } from '../src/core/providers/anthropic.ts'
import { toResponsesInput } from '../src/core/providers/responses.ts'
import { toOpenAiMessages } from '../src/core/providers/openai.ts'
import {
  listWorkspaceFiles,
  loadProjectInstructions,
  readWorkspacePreview,
} from '../src/core/tools/files.ts'

async function startMockHttp(
  t: { after: (fn: () => Promise<void> | void) => void },
  handler: (req: IncomingMessage, body: Record<string, any>, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      handler(req, raw ? (JSON.parse(raw) as Record<string, any>) : {}, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function makeStores(provider: ProviderConfig, workspace?: string) {
  const settingsData: AppSettings = {
    locale: 'en',
    theme: 'light',
    workspace,
    activeProviderId: provider.id,
    reasoningEffort: 'auto',
    onboarded: true,
    proxyMode: 'system',
  }
  const settings = {
    activeProvider: () => provider,
    providerKey: async () => 'sk-test-key',
    get: () => settingsData,
  } as unknown as SettingsStore
  const mcp = {
    tools: () => [],
    findTool: () => undefined,
    callTool: async () => ({ content: [] }),
  } as unknown as McpManager
  return { settings, mcp }
}

const SAMPLE_IMAGE: ImageAttachment = {
  id: 'img_1',
  name: 'diagram.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
}

test('thinking: xhigh maps cleanly for adaptive and legacy budget Claude models', () => {
  const adaptive = buildAnthropicThinking('claude-sonnet-4-6', 16_000, 'xhigh')
  assert.deepEqual(adaptive.thinking, { type: 'adaptive' })
  assert.deepEqual(adaptive.outputConfig, { effort: 'high' })

  // Opus 4.7 supports xhigh natively, so it must not be downgraded.
  const opus47 = buildAnthropicThinking('claude-opus-4-7', 16_000, 'xhigh')
  assert.deepEqual(opus47.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(opus47.outputConfig, { effort: 'xhigh' })

  const budget = buildAnthropicThinking('claude-3-7-sonnet-20250219', 64_000, 'xhigh')
  assert.deepEqual(budget.thinking, { type: 'enabled', budget_tokens: 32768 })
  assert.equal(budget.outputConfig, undefined)
})

test('multimodal images serialize across Anthropic, Responses, and OpenAI Chat protocols', () => {
  const msgs: Conversation['messages'] = [
    { role: 'user', text: 'What is in this image?', images: [SAMPLE_IMAGE] },
  ]

  const anthropicWire = toAnthropicMessages(msgs)
  assert.equal(anthropicWire.length, 1)
  assert.ok(Array.isArray(anthropicWire[0]?.content))
  const aBlocks = anthropicWire[0]!.content as Array<Record<string, any>>
  assert.equal(aBlocks[0]?.type, 'image')
  assert.equal(aBlocks[0]?.source?.type, 'base64')
  assert.equal(aBlocks[0]?.source?.media_type, 'image/png')
  assert.ok(typeof aBlocks[0]?.source?.data === 'string' && aBlocks[0].source.data.length > 10)
  assert.deepEqual(aBlocks[1], { type: 'text', text: 'What is in this image?' })

  const responsesWire = toResponsesInput(msgs)
  assert.equal(responsesWire.length, 1)
  const rContent = responsesWire[0]?.content as Array<Record<string, any>>
  assert.deepEqual(rContent[0], { type: 'input_text', text: 'What is in this image?' })
  assert.deepEqual(rContent[1], { type: 'input_image', image_url: SAMPLE_IMAGE.dataUrl })

  const openAiWire = toOpenAiMessages('sys', msgs)
  assert.equal(openAiWire.length, 2)
  assert.equal(openAiWire[1]?.role, 'user')
  const oContent = openAiWire[1]?.content as Array<Record<string, any>>
  assert.deepEqual(oContent[0], { type: 'text', text: 'What is in this image?' })
  assert.deepEqual(oContent[1], { type: 'image_url', image_url: { url: SAMPLE_IMAGE.dataUrl } })
})

test('chat retries transient 503 pre-stream errors and caches 422 fallback on Anthropic proxies', { timeout: 20_000 }, async (t) => {
  const bodies: Array<Record<string, any>> = []
  let callIndex = 0
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    bodies.push(body)
    callIndex += 1
    if (callIndex === 1) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end('overloaded')
      return
    }
    if (callIndex === 2) {
      res.writeHead(422, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'unknown field output_config' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (d: object) => res.write(`data: ${JSON.stringify(d)}\n\n`)
    emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
    emit({ type: 'content_block_stop', index: 0 })
    emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    res.end()
  })

  const endpoint = { ...endpointFor({ protocol: 'anthropic', baseUrl, presetId: 'anthropic' }, 'sk-test'), anthropicDirect: true }
  const req = {
    model: 'claude-sonnet-4-6',
    system: 'sys',
    messages: [{ role: 'user', text: 'hi' }] as Conversation['messages'],
    tools: [],
    effort: 'xhigh' as const,
    signal: new AbortController().signal,
  }

  let out1 = ''
  await chat('anthropic', endpoint, req, { onText: (d) => (out1 += d) })
  assert.equal(out1, 'ok')
  assert.equal(callIndex, 3)
  assert.ok(bodies[1]?.thinking)
  assert.equal(bodies[2]?.thinking, undefined)
  assert.equal(bodies[2]?.output_config, undefined)

  // Second chat call to the same host+model should remember plain fallback and skip rich fields upfront.
  let out2 = ''
  await chat('anthropic', endpoint, req, { onText: (d) => (out2 += d) })
  assert.equal(out2, 'ok')
  assert.equal(callIndex, 4)
  assert.equal(bodies[3]?.thinking, undefined)
})

test('Responses sends xhigh reasoning effort and falls back cleanly on 400', { timeout: 20_000 }, async (t) => {
  const bodies: Array<Record<string, any>> = []
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    bodies.push(body)
    if (bodies.length === 1) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unsupported store field' }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (type: string, extra: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`)
    emit('response.output_item.added', { output_index: 0, item: { id: 'msg_1', type: 'message' } })
    emit('response.output_text.delta', { item_id: 'msg_1', output_index: 0, delta: 'codex ok' })
    emit('response.completed', { response: { status: 'completed', usage: { input_tokens: 15, output_tokens: 4 } } })
    res.end()
  })

  const endpoint = endpointFor({ protocol: 'responses', baseUrl }, 'sk-test')
  let out = ''
  await chat(
    'responses',
    endpoint,
    {
      model: 'gpt-5.3-codex',
      system: 'sys',
      messages: [{ role: 'user', text: 'go' }],
      tools: [],
      effort: 'xhigh',
      cacheKey: 'conv_1',
      signal: new AbortController().signal,
    },
    { onText: (d) => (out += d) },
  )
  assert.equal(out, 'codex ok')
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0]?.reasoning, { effort: 'xhigh', summary: 'auto' })
  assert.equal(bodies[0]?.store, false)
  assert.equal(bodies[1]?.store, undefined)
  assert.equal(bodies[1]?.prompt_cache_key, undefined)
})

test('workspace helpers sort files, skip build/venv dirs, preview text cleanly, and prioritize AGENTS.override.md', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-ws-'))
  t.after(() => rm(ws, { recursive: true, force: true }))

  await mkdir(join(ws, 'src'), { recursive: true })
  await mkdir(join(ws, '.venv/lib'), { recursive: true })
  await mkdir(join(ws, '__pycache__'), { recursive: true })
  await writeFile(join(ws, 'src/b.ts'), 'export const b = 2\n', 'utf8')
  await writeFile(join(ws, 'src/a.ts'), 'export const a = 1\n', 'utf8')
  await writeFile(join(ws, '.venv/lib/ignored.py'), 'x = 1', 'utf8')
  await writeFile(join(ws, '__pycache__/ignored.pyc'), '\u0000\u0001', 'utf8')
  await writeFile(join(ws, 'AGENTS.md'), 'Base instructions', 'utf8')
  await writeFile(join(ws, 'AGENTS.override.md'), 'Override instructions', 'utf8')
  await writeFile(join(ws, 'bin.dat'), Buffer.from([0, 1, 2, 3]))

  const files = await listWorkspaceFiles(ws)
  assert.deepEqual(files, ['AGENTS.md', 'AGENTS.override.md', 'bin.dat', 'src/a.ts', 'src/b.ts'])

  const preview = await readWorkspacePreview(ws, 'src/a.ts')
  assert.equal(preview.content, 'export const a = 1\n')
  assert.equal(preview.truncated, false)

  await assert.rejects(() => readWorkspacePreview(ws, 'bin.dat'), /Binary file cannot be previewed/)

  const notes = await loadProjectInstructions(ws)
  assert.match(notes, /^# Workspace Instructions\n## AGENTS\.override\.md\n/)
})

test('ChatStore binds workspace & provider and ignores summary turns in titleFrom', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-chats-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const store = new ChatStore(dir)
  await store.load()
  const c = await store.create({ workspace: 'D:/proj/alpha', providerId: 'p1' })
  assert.equal(c.workspace, 'D:/proj/alpha')
  assert.equal(c.providerId, 'p1')

  c.messages.push(
    { role: 'user', text: '[Compacted conversation context]\nsummary...', isSummary: true },
    { role: 'user', text: 'Real question about tests' },
  )
  await store.save(c)

  let meta = store.list().find((m) => m.id === c.id)!
  assert.equal(meta.title, 'Real question about tests')
  assert.equal(meta.workspace, 'D:/proj/alpha')

  const emptyUnbound = await store.create({ providerId: 'p1' })
  const metaBound = await store.setWorkspace(emptyUnbound.id, 'D:/proj/beta')
  assert.equal(metaBound.workspace, 'D:/proj/beta')

  // Once workspace is fixed on a conversation, changing it to another folder must be rejected.
  await assert.rejects(
    () => store.setWorkspace(emptyUnbound.id, 'D:/proj/gamma'),
    /already fixed/,
  )

  // Once a conversation has messages, changing its workspace must also be rejected.
  await assert.rejects(
    () => store.setWorkspace(c.id, 'D:/proj/beta'),
    /already has content/,
  )
  meta = await store.setProvider(c.id, 'p2')
  assert.equal(meta.providerId, 'p2')
})

test('AgentLoop scopes sessionAllows per workspace and supports regenerate, compact, and refusal persistence', { timeout: 20_000 }, async (t) => {
  const wsA = await mkdtemp(join(tmpdir(), 'atrium-wsa-'))
  const wsB = await mkdtemp(join(tmpdir(), 'atrium-wsb-'))
  t.after(async () => {
    await rm(wsA, { recursive: true, force: true })
    await rm(wsB, { recursive: true, force: true })
  })

  let mode: 'write' | 'chat' | 'compact' | 'refusal' = 'write'
  let replyCount = 0
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = (d: object) => res.write(`data: ${JSON.stringify(d)}\n\n`)
    if (mode === 'write') {
      const last = body.messages?.[body.messages.length - 1]
      const hasToolRes = Array.isArray(last?.content) && last.content.some((b: any) => b.type === 'tool_result')
      if (!hasToolRes) {
        emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu_${Date.now()}`, name: 'write_file' } })
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'out.txt', content: 'hi' }) } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })
      } else {
        emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'wrote it' } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })
      }
      res.end()
      return
    }
    if (mode === 'compact') {
      emit({ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } })
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Goal: build widget.' } })
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      res.end()
      return
    }
    if (mode === 'refusal') {
      emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
      emit({ type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 1 } })
      res.end()
      return
    }
    replyCount += 1
    emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })
    emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `answer #${replyCount}` } })
    emit({ type: 'content_block_stop', index: 0 })
    emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })
    res.end()
  })

  const provider: ProviderConfig = {
    id: 'p_test',
    name: 'TestClaude',
    protocol: 'anthropic',
    baseUrl,
    model: 'claude-sonnet-4-6',
    hasKey: true,
  }
  const { settings, mcp } = makeStores(provider, wsA)
  let approvalsSeen = 0
  let saveCalls = 0
  const saved: Conversation[] = []
  const events: AgentEvent[] = []
  let loop!: AgentLoop
  loop = new AgentLoop({
    settings,
    mcp,
    emit: (e: AgentEvent) => {
      events.push(e)
      if (e.type === 'approval') {
        approvalsSeen += 1
        loop.approve(e.request.approvalId, 'allow_session')
      }
    },
    save: async (c) => {
      saveCalls += 1
      saved.push(structuredClone(c))
    },
    systemPrompt: () => 'sys',
  })

  // 1. Write in wsA asks once for allow_session, then caches for wsA only.
  const convA1: Conversation = { id: 'a1', title: '', createdAt: 0, updatedAt: 0, workspace: wsA, messages: [] }
  await loop.run(convA1, 'write 1')
  assert.equal(approvalsSeen, 1)
  assert.deepEqual(loop.sessionAllowsFor(wsA), ['write'])

  // Second write in wsA skips approval prompt.
  const convA2: Conversation = { id: 'a2', title: '', createdAt: 0, updatedAt: 0, workspace: wsA, messages: [] }
  await loop.run(convA2, 'write 2')
  assert.equal(approvalsSeen, 1)

  // Write in wsB STILL asks for approval!
  const convB: Conversation = { id: 'b1', title: '', createdAt: 0, updatedAt: 0, workspace: wsB, messages: [] }
  await loop.run(convB, 'write in B')
  assert.equal(approvalsSeen, 2)

  // Revoking wsA trust makes next write in wsA prompt again.
  loop.clearSessionAllows(wsA)
  assert.deepEqual(loop.sessionAllowsFor(wsA), [])
  await loop.run(convA2, 'write 3')
  assert.equal(approvalsSeen, 3)

  // 2. Regenerate replaces the last assistant answer cleanly.
  mode = 'chat'
  const convRegen: Conversation = { id: 'r1', title: '', createdAt: 0, updatedAt: 0, workspace: wsA, messages: [] }
  await loop.run(convRegen, 'hello')
  assert.equal((convRegen.messages[1] as { text?: string })?.text, 'answer #1')
  await loop.regenerate(convRegen)
  assert.equal(convRegen.messages.length, 2)
  assert.equal((convRegen.messages[1] as { text?: string })?.text, 'answer #2')

  // 3. Compact summarizes earlier turns into an isSummary card while keeping recent turns.
  await loop.run(convRegen, 'second q')
  await loop.run(convRegen, 'third q')
  mode = 'compact'
  await loop.compact(convRegen)
  assert.equal(convRegen.messages[0]?.role, 'user')
  assert.equal((convRegen.messages[0] as { isSummary?: boolean }).isSummary, true)
  assert.match((convRegen.messages[0] as { text: string }).text, /Goal: build widget\./)
  assert.equal(convRegen.messages.some((m) => m.role === 'user' && m.text === 'second q'), true)

  // 4. Refusal saves the conversation via save() and emits the refusal error event.
  mode = 'refusal'
  const beforeSaves = saveCalls
  const convRefusal: Conversation = { id: 'ref1', title: '', createdAt: 0, updatedAt: 0, workspace: wsA, messages: [] }
  await loop.run(convRefusal, 'blocked prompt')
  assert.ok(saveCalls > beforeSaves)
  assert.equal(convRefusal.messages[0]?.role, 'user')
  assert.equal(convRefusal.messages[convRefusal.messages.length - 1]?.role, 'assistant')
  const refusalErr = events.find((e) => e.type === 'error' && e.conversationId === 'ref1')
  assert.ok(refusalErr && refusalErr.type === 'error')
  assert.match(refusalErr.message, /declined/i)
})

test('SettingsStore prepends new workspaces and keeps order stable when switching back to existing ones', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const store = new SettingsStore(dir)
  await store.load()

  await store.update({ workspace: 'D:/ws/alpha' })
  await store.update({ workspace: 'D:/ws/beta' })
  await store.update({ workspace: 'D:/ws/gamma' })
  assert.deepEqual(store.get().recentWorkspaces, ['D:/ws/gamma', 'D:/ws/beta', 'D:/ws/alpha'])

  // Switching back to alpha must preserve sidebar workspace group order!
  await store.update({ workspace: 'D:/ws/alpha' })
  assert.equal(store.get().workspace, 'D:/ws/alpha')
  assert.deepEqual(store.get().recentWorkspaces, ['D:/ws/gamma', 'D:/ws/beta', 'D:/ws/alpha'])

  // Prepending a brand new workspace adds it at the top.
  await store.update({ workspace: 'D:/ws/delta' })
  assert.deepEqual(store.get().recentWorkspaces, ['D:/ws/delta', 'D:/ws/gamma', 'D:/ws/beta', 'D:/ws/alpha'])
})

test('ChatStore.load prunes legacy empty stubs, backfills messageCount, and titleFrom skips fences', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-prune-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'chats'), { recursive: true })

  await writeFile(
    join(dir, 'chats.json'),
    JSON.stringify([
      { id: 'c_empty', title: '', createdAt: 1, updatedAt: 10 },
      { id: 'c_empty_zh', title: '新对话', createdAt: 2, updatedAt: 20 },
      { id: 'c_wt', title: '', worktreeBranch: 'atrium/feat', createdAt: 3, updatedAt: 30 },
      { id: 'c_real', title: 'Real chat', createdAt: 4, updatedAt: 40 },
      { id: 'c_missing', title: 'Ghost', createdAt: 5, updatedAt: 50 },
    ]),
  )
  await writeFile(join(dir, 'chats', 'c_empty.json'), JSON.stringify({ id: 'c_empty', title: '', createdAt: 1, updatedAt: 10, messages: [] }))
  await writeFile(join(dir, 'chats', 'c_empty_zh.json'), JSON.stringify({ id: 'c_empty_zh', title: '新对话', createdAt: 2, updatedAt: 20, messages: [] }))
  await writeFile(
    join(dir, 'chats', 'c_wt.json'),
    JSON.stringify({ id: 'c_wt', title: '', worktreeBranch: 'atrium/feat', createdAt: 3, updatedAt: 30, messages: [] }),
  )
  await writeFile(
    join(dir, 'chats', 'c_real.json'),
    JSON.stringify({
      id: 'c_real',
      title: 'Real chat',
      createdAt: 4,
      updatedAt: 40,
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi', toolCalls: [] },
      ],
    }),
  )

  const store = new ChatStore(dir)
  await store.load()

  const list = store.list()
  assert.deepEqual(
    list.map((c) => c.id),
    ['c_real', 'c_wt'],
  )
  assert.equal(list.find((c) => c.id === 'c_real')?.messageCount, 2)
  assert.equal(existsSync(join(dir, 'chats', 'c_empty.json')), false)
  assert.equal(existsSync(join(dir, 'chats', 'c_empty_zh.json')), false)

  assert.equal(isEmptyChatStub({ messageCount: 0 }), true)
  assert.equal(isEmptyChatStub({ messageCount: 0 }, true), false)
  assert.equal(isEmptyChatStub({ messageCount: 0, worktreeBranch: 'atrium/feat' }), false)
  assert.equal(isEmptyChatStub({ messageCount: 2 }), false)

  assert.equal(
    titleFrom({
      id: 't1',
      title: '',
      createdAt: 0,
      updatedAt: 0,
      messages: [{ role: 'user', text: '```ts\nconst x = 1\n```\nExplain closure scope\nMore lines' }],
    }),
    'Explain closure scope',
  )
  assert.equal(
    titleFrom({
      id: 't2',
      title: '',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        {
          role: 'user',
          text: '',
          images: [{ id: 'img1', name: 'screen-capture.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AA==' }],
        },
      ],
    }),
    'screen-capture.png',
  )
})

test('AgentLoop refines first-turn title cleanly when enabled and respects manual renames', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-autotitle-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  let calls = 0
  const baseUrl = await startMockHttp(t, (_req, _body, res) => {
    calls++
    res.setHeader('Content-Type', 'text/event-stream')
    const content = calls === 2 ? 'Closure Scope Summary' : 'Here is the explanation.'
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })

  const chats = new ChatStore(dir)
  await chats.load()
  const conv = await chats.create({ providerId: 'p1' })

  const { settings, mcp } = makeStores({
    id: 'p1',
    name: 'Mock',
    protocol: 'openai',
    baseUrl: `${baseUrl}/v1`,
    model: 'gpt-4o',
    hasKey: true,
  })

  const loop = new AgentLoop({
    settings,
    mcp,
    emit: () => undefined,
    save: (c) => chats.save(c),
    enableAutoTitle: true,
    onAutoTitle: async (id, title) => {
      await chats.setAutoTitle(id, title)
    },
    systemPrompt: () => 'sys',
  })

  await loop.run(conv, 'Can you explain JavaScript closure scoping in detail please?')
  for (let i = 0; i < 40; i++) {
    if (chats.list().find((m) => m.id === conv.id)?.titleSource === 'ai') break
    await new Promise((r) => setTimeout(r, 25))
  }
  const updated = chats.list().find((m) => m.id === conv.id)!
  assert.equal(updated.title, 'Closure Scope Summary')
  assert.equal(updated.titleSource, 'ai')

  // Manual user rename must never be overwritten by auto-title.
  const conv2 = await chats.create({ providerId: 'p1' })
  await chats.rename(conv2.id, 'My Pinned Title')
  const conv2Reloaded = (await chats.get(conv2.id))!
  const callsBefore = calls
  await loop.run(conv2Reloaded, 'Another prompt here')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls, callsBefore + 1)
  assert.equal(chats.list().find((m) => m.id === conv2.id)?.title, 'My Pinned Title')
  assert.equal(chats.list().find((m) => m.id === conv2.id)?.titleSource, 'user')
})

test('contextUsage computes scaled breakdown matching reported API usage and formats compact tokens', () => {
  assert.equal(formatCompactTokens(420), '420')
  assert.equal(formatCompactTokens(173_100), '173.1k')
  assert.equal(formatCompactTokens(128_000), '128k')
  assert.equal(formatCompactTokens(12_340), '12.3k')
  assert.equal(formatCompactTokens(1_000_000), '1M')
  assert.equal(estimateModelContextLimit('claude-opus-5-5'), 1_000_000)
  assert.equal(estimateModelContextLimit('deepseek-chat'), 128_000)

  const breakdown = computeContextBreakdown({
    model: 'claude-opus-5-5',
    hasWorkspace: true,
    mcpToolCount: 6,
    skillCount: 2,
    conversation: {
      messages: [
        { role: 'user', text: 'Summarize the project files and check tests.' },
        {
          role: 'assistant',
          text: 'Sure, here is the repository summary and test status.',
          reasoning: 'Checking workspace structure and package scripts first.',
          toolCalls: [{ id: 'tc1', name: 'list_dir', input: { path: '.' } }],
          usage: { inputTokens: 1840, outputTokens: 420, cacheReadTokens: 1200 },
        },
        { role: 'tool', toolCallId: 'tc1', name: 'list_dir', output: 'src/\npackage.json\nREADME.md', isError: false },
      ],
    },
  })

  assert.equal(breakdown.limitTokens, 1_000_000)
  assert.equal(breakdown.totalTokens, 2260)
  assert.equal(breakdown.cacheReadTokens, 1200)
  assert.equal(
    breakdown.systemTokens +
      breakdown.toolsTokens +
      breakdown.messagesTokens +
      breakdown.toolOutputsTokens +
      breakdown.reasoningTokens,
    2260,
  )
})

test('SettingsStore preserves recentWorkspaces custom order/deduplication and retains up to 24 entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-settings-ws-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const store = new SettingsStore(dir)
  await store.load()

  const list = Array.from({ length: 28 }, (_, i) => `D:/ws-${i + 1}`)
  const updated = await store.update({
    recentWorkspaces: ['D:/ws-3', ...list, 'D:/ws-3'],
  })

  assert.equal(updated.recentWorkspaces?.length, 24)
  assert.equal(updated.recentWorkspaces?.[0], 'D:/ws-3')
  assert.equal(updated.recentWorkspaces?.[1], 'D:/ws-1')
  assert.equal(updated.recentWorkspaces?.filter((p) => p === 'D:/ws-3').length, 1)

  const reordered = ['D:/ws-2', 'D:/ws-1', 'D:/ws-3']
  const afterReorder = await store.update({ recentWorkspaces: reordered })
  assert.deepEqual(afterReorder.recentWorkspaces, reordered)
})

test('ChatStore persists pinned, archived, and batch archive flags across reload', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-chats-pin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const store = new ChatStore(dir)
  await store.load()
  const c1 = await store.create({ workspace: 'D:/proj/a' })
  const c2 = await store.create({ workspace: 'D:/proj/a' })
  c1.messages.push({ role: 'user', text: 'first' })
  c2.messages.push({ role: 'user', text: 'second' })
  await store.save(c1)
  await store.save(c2)

  await store.setPinned(c1.id, true)
  await store.setArchived(c2.id, true)

  const reloaded = new ChatStore(dir)
  await reloaded.load()
  const m1 = reloaded.list().find((x) => x.id === c1.id)!
  const m2 = reloaded.list().find((x) => x.id === c2.id)!
  assert.equal(m1.pinned, true)
  assert.equal(m1.archived, undefined)
  assert.equal(m2.archived, true)

  await reloaded.setArchivedBatch([c1.id, c2.id], false)
  assert.equal(reloaded.list().every((x) => !x.archived), true)
})

test('persistent allow rules support safe prefix matching, reject shell chaining, and persist in SettingsStore', async (t) => {
  const built = buildAlwaysAllowRule({ id: '1', name: 'run_command', input: { command: 'npm test -- --grep foo' } }, 'shell')
  assert.equal(built.rule, 'cmd-prefix:npm test')
  assert.equal(matchesAllowedRules({ id: '2', name: 'run_command', input: { command: 'npm test' } }, 'shell', undefined, [built.rule]), true)
  assert.equal(
    matchesAllowedRules({ id: '3', name: 'run_command', input: { command: 'npm test && whoami' } }, 'shell', undefined, [built.rule]),
    false,
  )

  const chained = buildAlwaysAllowRule({ id: '4', name: 'run_command', input: { command: 'echo hi && ls' } }, 'shell')
  assert.equal(chained.rule, 'cmd-exact:echo hi && ls')
  assert.equal(matchesAllowedRules({ id: '5', name: 'run_command', input: { command: 'echo hi && rm -rf /' } }, 'shell', undefined, [chained.rule]), false)

  const dir = await mkdtemp(join(tmpdir(), 'atrium-allow-rules-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const settings = new SettingsStore(dir)
  await settings.load()
  await settings.addAllowedRule('D:/repo/a', built.rule)
  assert.deepEqual(settings.allowedRulesFor('D:/repo/a'), [built.rule])
  await settings.removeAllowedRule('D:/repo/a', built.rule)
  assert.deepEqual(settings.allowedRulesFor('D:/repo/a'), [])
})

test('computeContextBreakdown reports autocompact buffer when enabled and zero when disabled', () => {
  const enabled = computeContextBreakdown({ model: 'claude-sonnet-4-6', autoCompact: true })
  const disabled = computeContextBreakdown({ model: 'claude-sonnet-4-6', autoCompact: false })
  assert.ok(enabled.autocompactBufferTokens > 0)
  assert.equal(disabled.autocompactBufferTokens, 0)
})

test('adjustable context window updates model defaults, custom cap override, and SettingsStore clamping', async (t) => {
  // Newer model series resolve to updated defaults while legacy series keep 128k
  assert.equal(estimateModelContextLimit('deepseek-v4.1-flash'), 200_000)
  assert.equal(estimateModelContextLimit('glm-5.1'), 200_000)
  assert.equal(estimateModelContextLimit('kimi-k2.5'), 200_000)
  assert.equal(estimateModelContextLimit('qwen3-coder'), 200_000)
  assert.equal(estimateModelContextLimit('deepseek-chat'), 128_000)

  // Custom contextWindowTokens override overrides auto-detected limit and scales autocompact buffer (20%)
  const boosted = computeContextBreakdown({
    model: 'deepseek-chat',
    contextWindowTokens: 400_000,
    autoCompact: true,
  })
  assert.equal(boosted.limitTokens, 400_000)
  assert.equal(boosted.autocompactBufferTokens, 80_000)

  const huge = computeContextBreakdown({
    model: 'gpt-4o',
    contextWindowTokens: 1_000_000,
    autoCompact: true,
  })
  assert.equal(huge.limitTokens, 1_000_000)
  assert.equal(huge.autocompactBufferTokens, 200_000)

  // SettingsStore persists & clamps contextWindowTokens cleanly
  const dir = await mkdtemp(join(tmpdir(), 'atrium-ctx-limit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new SettingsStore(dir)
  await store.load()
  assert.equal(store.get().contextWindowTokens, 0)

  await store.update({ contextWindowTokens: 256_000 })
  const reloaded = new SettingsStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get().contextWindowTokens, 256_000)

  // Out-of-range values clamp safely within [32_000, 2_000_000] or reset to 0 for non-positive
  assert.equal((await reloaded.update({ contextWindowTokens: 10_000 })).contextWindowTokens, 32_000)
  assert.equal((await reloaded.update({ contextWindowTokens: 9_999_999 })).contextWindowTokens, 2_000_000)
  assert.equal((await reloaded.update({ contextWindowTokens: 0 })).contextWindowTokens, 0)
})
