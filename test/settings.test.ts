import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Conversation } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { ChatStore } from '../src/core/chats.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/settings.ts'

async function mockToolModel(toolName: string, args: string): Promise<{ server: Server; url: string }> {
  let turn = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      turn++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (turn === 1) {
        send({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: args } }] }, 'tool_calls')
      } else {
        send({ content: 'done' }, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/v1` }
}

test('SettingsStore persists, sanitizes, and clamps appearance & code settings', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const store = new SettingsStore(dir)
  await store.load()
  assert.equal(store.get().transcriptWidth, DEFAULT_SETTINGS.transcriptWidth)
  assert.equal(store.get().defaultTranscriptView, 'normal')
  assert.equal(store.get().codeFontSize, 13)
  assert.equal(store.get().allowBypassPermissions, true)

  const updated = await store.update({
    transcriptWidth: 'wide',
    defaultTranscriptView: 'verbose',
    codeFont: '  JetBrains Mono  ',
    codeFontSize: 28,
    codeThemeLight: 'github',
    codeThemeDark: 'nord',
  })
  assert.equal(updated.transcriptWidth, 'wide')
  assert.equal(updated.defaultTranscriptView, 'verbose')
  assert.equal(updated.codeFont, 'JetBrains Mono')
  assert.equal(updated.codeFontSize, 16)
  assert.equal(updated.codeThemeLight, 'github')
  assert.equal(updated.codeThemeDark, 'nord')

  const clampedLow = await store.update({
    codeFont: '   ',
    codeFontSize: 4,
    transcriptWidth: 'bogus' as 'default',
    codeThemeDark: 'bogus' as 'atrium',
  })
  assert.equal(clampedLow.codeFont, undefined)
  assert.equal(clampedLow.codeFontSize, 12)
  assert.equal(clampedLow.transcriptWidth, 'default')
  assert.equal(clampedLow.codeThemeDark, 'atrium')

  const reloaded = new SettingsStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get().codeFontSize, 12)
  assert.equal(reloaded.get().codeThemeLight, 'github')
})

test('disabling allowBypassPermissions demotes bypass mode and blocks bypass in AgentLoop', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-bypass-'))
  const ws = await mkdtemp(join(tmpdir(), 'atrium-bypass-ws-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(ws, { recursive: true, force: true }))

  const store = new SettingsStore(dir)
  await store.load()
  await store.update({ workspace: ws, agentMode: 'bypass', allowBypassPermissions: true })
  assert.equal(store.get().agentMode, 'bypass')

  const demoted = await store.update({ allowBypassPermissions: false })
  assert.equal(demoted.allowBypassPermissions, false)
  assert.equal(demoted.agentMode, 'auto')
  assert.equal(demoted.lastExecMode, 'auto')

  const mock = await mockToolModel('write_file', JSON.stringify({ path: 'check.txt', content: 'hi' }))
  t.after(() => mock.server.close())

  const settingsMock = {
    activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl: mock.url, model: 'mock-1', hasKey: true }),
    providerKey: async () => 'k',
    get: () => ({ workspace: ws, agentMode: 'bypass' as const, allowBypassPermissions: false }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager

  const events: AgentEvent[] = []
  let loop!: AgentLoop
  loop = new AgentLoop({
    settings: settingsMock,
    mcp,
    emit: (e) => {
      events.push(e)
      if (e.type === 'approval') loop.approve(e.request.approvalId, 'deny')
    },
    save: async () => undefined,
    systemPrompt: () => 'test',
    forcedMode: 'bypass',
  })

  const conv: Conversation = { id: 'c1', title: 'test', createdAt: 0, updatedAt: 0, messages: [] }
  await loop.run(conv, 'write file')
  assert.equal(events.filter((e) => e.type === 'approval').length, 1)
})

test('ChatStore.summarizeUsage aggregates messages, tokens, caches, and providers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-usage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const chats = new ChatStore(dir)
  await chats.load()

  const c1 = await chats.create()
  c1.providerId = 'p_claude'
  c1.messages.push(
    { role: 'user', text: 'compacted', isSummary: true },
    { role: 'user', text: 'hello' },
    {
      role: 'assistant',
      text: 'hi',
      toolCalls: [],
      usage: { inputTokens: 1200, outputTokens: 350, cacheReadTokens: 800, cacheWriteTokens: 200 },
    },
  )
  await chats.save(c1)

  const c2 = await chats.create()
  c2.providerId = 'p_openai'
  c2.messages.push(
    { role: 'user', text: 'question 1' },
    { role: 'assistant', text: 'answer 1', toolCalls: [], usage: { inputTokens: 400, outputTokens: 100 } },
    { role: 'user', text: 'question 2' },
    { role: 'assistant', text: 'answer 2', toolCalls: [], usage: { inputTokens: 500, outputTokens: 150 } },
  )
  await chats.save(c2)

  const summary = await chats.summarizeUsage()
  assert.equal(summary.conversations, 2)
  assert.equal(summary.userMessages, 3)
  assert.equal(summary.assistantMessages, 3)
  assert.equal(summary.inputTokens, 2100)
  assert.equal(summary.outputTokens, 600)
  assert.equal(summary.cacheReadTokens, 800)
  assert.equal(summary.cacheWriteTokens, 200)
  assert.equal(summary.byProvider[0]?.providerId, 'p_claude')
  assert.equal(summary.byProvider[0]?.inputTokens, 1200)
  assert.equal(summary.byProvider[1]?.providerId, 'p_openai')
  assert.equal(summary.byProvider[1]?.outputTokens, 250)
  assert.equal(summary.untaggedSceneMessages, 3)
  assert.equal(summary.byScene.code.totalTokens, 2700)
  assert.equal(summary.byScene.work.totalTokens, 0)
})

test('ChatStore.summarizeUsage splits tokens across work and code scenes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-scene-usage-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const chats = new ChatStore(dir)
  await chats.load()

  const mixed = await chats.create()
  mixed.providerId = 'p_mix'
  mixed.messages.push(
    { role: 'user', text: 'summarize quarterly sheet' },
    {
      role: 'assistant',
      text: 'summary ready',
      toolCalls: [],
      workScene: 'work',
      usage: { inputTokens: 1500, outputTokens: 450, cacheReadTokens: 600, cacheWriteTokens: 120 },
    },
    { role: 'user', text: 'now fix the build script' },
    {
      role: 'assistant',
      text: 'fixed',
      toolCalls: [],
      workScene: 'code',
      usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 200 },
    },
    {
      role: 'assistant',
      text: 'legacy reply without scene tag',
      toolCalls: [],
      usage: { inputTokens: 250, outputTokens: 50 },
    },
  )
  await chats.save(mixed)

  const summary = await chats.summarizeUsage()
  assert.equal(summary.untaggedSceneMessages, 1)
  assert.equal(summary.byScene.work.scene, 'work')
  assert.equal(summary.byScene.work.messages, 1)
  assert.equal(summary.byScene.work.inputTokens, 1500)
  assert.equal(summary.byScene.work.outputTokens, 450)
  assert.equal(summary.byScene.work.cacheReadTokens, 600)
  assert.equal(summary.byScene.work.cacheWriteTokens, 120)
  assert.equal(summary.byScene.work.totalTokens, 1950)

  assert.equal(summary.byScene.code.scene, 'code')
  assert.equal(summary.byScene.code.messages, 2)
  assert.equal(summary.byScene.code.inputTokens, 1150)
  assert.equal(summary.byScene.code.outputTokens, 350)
  assert.equal(summary.byScene.code.cacheReadTokens, 200)
  assert.equal(summary.byScene.code.totalTokens, 1500)
})

test('AgentLoop stamps active workScene onto persisted assistant messages', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-scene-agent-'))
  t.after(() => rm(ws, { recursive: true, force: true }))

  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 8 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => server.close())
  const addr = server.address() as { port: number }
  const url = `http://127.0.0.1:${addr.port}`

  let activeScene: 'work' | 'code' = 'work'
  const settingsMock = {
    activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl: url, model: 'mock-1', hasKey: true }),
    providerKey: async () => 'k',
    get: () => ({ ...DEFAULT_SETTINGS, workspace: ws, workScene: activeScene }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager

  const loop = new AgentLoop({
    settings: settingsMock,
    mcp,
    emit: () => undefined,
    save: async () => undefined,
    systemPrompt: () => 'test',
  })

  const conv: Conversation = { id: 'c_scene', title: 'scene test', createdAt: 0, updatedAt: 0, messages: [] }
  await loop.run(conv, 'draft agenda')
  activeScene = 'code'
  await loop.run(conv, 'write parser')

  const assistantMsgs = conv.messages.filter((m) => m.role === 'assistant')
  assert.equal(assistantMsgs.length, 2)
  assert.equal(assistantMsgs[0]?.workScene, 'work')
  assert.equal(assistantMsgs[1]?.workScene, 'code')
})
