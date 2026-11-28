// Unit and integration tests for Dual-Model Orchestrator (model resolution, replay sanitizer, AgentLoop state machine, and CLI parity).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { AddressInfo } from 'node:net'
import type { AgentEvent, AppSettings, Conversation, Message, ProviderConfig } from '../src/shared/types.ts'
import { resolveOrchestratorExecutor } from '../src/shared/orchestrator.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { prepareMessagesForModel } from '../src/core/orchestrator.ts'
import { systemPrompt } from '../src/core/prompt.ts'
import { SettingsStore } from '../src/core/settings.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import { parseCliArgs } from '../src/cli/args.ts'
import { handleOrchestratorCommand } from '../src/cli/commands.ts'
import { createPalette } from '../src/cli/render.ts'
import { CliRuntime } from '../src/cli/runtime.ts'

interface MockToolCall {
  id?: string
  name: string
  args: string
}

interface MockPlan {
  text?: string
  toolCalls?: MockToolCall[]
  reasoning?: string
}

async function startMockOpenAi(
  t: { after: (fn: () => Promise<void> | void) => void },
  responder: (reqBody: any, index: number) => MockPlan,
): Promise<{ url: string; requests: any[] }> {
  const requests: any[] = []
  let idx = 0
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : {}
      const callIdx = idx++
      requests.push(body)
      const plan = responder(body, callIdx)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (plan.reasoning) send({ reasoning_content: plan.reasoning })
      if (plan.toolCalls?.length) {
        plan.toolCalls.forEach((tc, i) => {
          send({
            tool_calls: [
              {
                index: i,
                id: tc.id ?? `call_${callIdx}_${i}`,
                type: 'function',
                function: { name: tc.name, arguments: tc.args },
              },
            ],
          })
        })
        send({}, 'tool_calls')
      } else {
        if (plan.text) send({ content: plan.text })
        send({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/v1`, requests }
}

function makeProvidersLoopDeps(
  providers: ProviderConfig[],
  appSettings: AppSettings,
  onBeforeModelCall?: (provider: ProviderConfig, model: string) => Promise<void>,
) {
  const activeId = appSettings.activeProviderId ?? providers[0]?.id
  const settings = {
    activeProvider: () => providers.find((p) => p.id === activeId) ?? providers[0],
    getProvider: (id: string) => providers.find((p) => p.id === id),
    listProviders: () => providers,
    providerKey: async () => 'test-key',
    get: () => appSettings,
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined, resources: () => [] } as unknown as McpManager
  const events: AgentEvent[] = []
  const loop = new AgentLoop({
    settings,
    mcp,
    enableAutoTitle: false,
    onBeforeModelCall,
    emit: (e) => events.push(e),
    save: async () => undefined,
    systemPrompt,
  })
  return { loop, events }
}

test('resolveOrchestratorExecutor: auto-picks same-vendor fast models, skips embeddings/heavy, honors pinned & fallback', () => {
  const claudeProv: ProviderConfig = {
    id: 'p_claude',
    name: 'Claude',
    protocol: 'openai',
    baseUrl: 'https://example.com/v1',
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'text-embedding-3-large', 'whisper-1'],
    hasKey: true,
  }
  const openaiProv: ProviderConfig = {
    id: 'p_openai',
    name: 'OpenAI',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    models: ['gpt-5.4', 'gpt-5.4-mini'],
    hasKey: true,
  }
  const geminiProv: ProviderConfig = {
    id: 'p_gemini',
    name: 'Gemini',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-pro',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    hasKey: true,
  }

  // Same-vendor fast model preference over cross-provider mini models
  const claudeChoice = resolveOrchestratorExecutor([claudeProv, openaiProv], claudeProv, {})
  assert.equal(claudeChoice.model, 'claude-sonnet-4-6')
  assert.equal(claudeChoice.provider.id, 'p_claude')
  assert.equal(claudeChoice.source, 'auto')
  assert.equal(claudeChoice.isSameAsPlanner, false)

  const gptChoice = resolveOrchestratorExecutor([openaiProv, claudeProv], openaiProv, {})
  assert.equal(gptChoice.model, 'gpt-5.4-mini')
  assert.equal(gptChoice.provider.id, 'p_openai')

  const gemChoice = resolveOrchestratorExecutor([geminiProv, claudeProv], geminiProv, {})
  assert.equal(gemChoice.model, 'gemini-2.5-flash')

  // Cross-provider auto-pick when active BYOK provider only has 1 flagship model
  const soleFlagship: ProviderConfig = {
    id: 'p_solo',
    name: 'Solo',
    protocol: 'openai',
    baseUrl: 'https://solo.example/v1',
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'text-embedding-3-large'],
    hasKey: true,
  }
  const crossChoice = resolveOrchestratorExecutor([soleFlagship, openaiProv], soleFlagship, {})
  assert.equal(crossChoice.provider.id, 'p_openai')
  assert.equal(crossChoice.model, 'gpt-5.4-mini')

  // Pinned cross-provider executor
  const pinned = resolveOrchestratorExecutor([claudeProv, openaiProv], claudeProv, {
    orchestratorExecutorProviderId: 'p_openai',
    orchestratorExecutorModel: 'gpt-5.4-mini',
  })
  assert.equal(pinned.provider.id, 'p_openai')
  assert.equal(pinned.model, 'gpt-5.4-mini')
  assert.equal(pinned.source, 'pinned')

  // Single-model fallback
  const onlyOne: ProviderConfig = {
    id: 'p_one',
    name: 'One',
    protocol: 'openai',
    baseUrl: 'https://one.example/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat'],
    hasKey: true,
  }
  const fallback = resolveOrchestratorExecutor([onlyOne], onlyOne, {})
  assert.equal(fallback.model, 'deepseek-chat')
  assert.equal(fallback.source, 'fallback_planner')
  assert.equal(fallback.isSameAsPlanner, true)
})

test('prepareMessagesForModel: strips foreign signatures/encrypted payloads without mutating history', () => {
  const original: Message[] = [
    { role: 'user', text: 'Plan and edit' },
    {
      role: 'assistant',
      text: 'Planning complete',
      model: 'claude-opus-4-6',
      providerId: 'p_planner',
      thinking: [{ type: 'thinking', thinking: 'secret trace', signature: 'sig_abc' }],
      reasoningItems: [{ id: 'rs_1', summary: 's', encryptedContent: 'enc_xyz' }],
      reasoning: 'raw chain',
      toolCalls: [{ id: 'call_1', itemId: 'fc_1', name: 'exit_plan_mode', input: { plan: 'Step 1' } }],
    },
    { role: 'tool', toolCallId: 'call_1', name: 'exit_plan_mode', output: 'ok', isError: false },
  ]

  const sameModel = prepareMessagesForModel(original, 'p_planner', 'claude-opus-4-6')
  assert.equal((sameModel[1] as Extract<Message, { role: 'assistant' }>).thinking?.[0]?.signature, 'sig_abc')
  assert.equal((sameModel[1] as Extract<Message, { role: 'assistant' }>).toolCalls[0]?.itemId, 'fc_1')

  const otherModel = prepareMessagesForModel(original, 'p_executor', 'gpt-5.4-mini')
  const sanitized = otherModel[1] as Extract<Message, { role: 'assistant' }>
  assert.equal(sanitized.thinking, undefined)
  assert.equal(sanitized.reasoningItems, undefined)
  assert.equal(sanitized.reasoning, undefined)
  assert.equal(sanitized.toolCalls[0]?.itemId, undefined)
  assert.equal(sanitized.toolCalls[0]?.id, 'call_1')
  assert.equal(sanitized.toolCalls[0]?.name, 'exit_plan_mode')

  // Original remains intact
  assert.equal((original[1] as Extract<Message, { role: 'assistant' }>).thinking?.[0]?.signature, 'sig_abc')
})

test('AgentLoop orchestrator: pure question stays on Planner without calling Executor', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-orch-q-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  const mock = await startMockOpenAi(t, () => ({ text: '42 is the answer.' }))

  const provider: ProviderConfig = {
    id: 'p1',
    name: 'Cloud',
    protocol: 'openai',
    baseUrl: mock.url,
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    hasKey: true,
  }
  const settings: AppSettings = {
    locale: 'en',
    theme: 'dark',
    onboarded: true,
    proxyMode: 'none',
    workspace: ws,
    agentMode: 'auto',
    orchestratorEnabled: true,
  }
  const { loop, events } = makeProvidersLoopDeps([provider], settings)
  const conv: Conversation = { id: 'c_q', title: 'Q', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }

  await loop.run(conv, 'What is 6 * 7?')

  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0].model, 'claude-opus-4-6')
  const assistant = conv.messages[1] as Extract<Message, { role: 'assistant' }>
  assert.equal(assistant.model, 'claude-opus-4-6')
  assert.equal(assistant.orchestratorPhase, 'plan')
  assert.equal(assistant.mode, undefined, 'must not stamp manual plan-mode badge on orchestrator Q&A')
  const phaseEvents = events.filter((e) => e.type === 'orchestrator_phase')
  assert.equal(phaseEvents.length, 1)
})

test('AgentLoop orchestrator: read-only planning guard + exit_plan_mode handoff to fast executor', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-orch-exec-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'note.txt'), 'before')

  const modelCalls: string[] = []
  const mock = await startMockOpenAi(t, (body, i) => {
    if (i === 0) {
      // Planner reads first and also tries illegal write (or check plan tools do not include write_file)
      return { toolCalls: [{ name: 'read_file', args: '{"path":"note.txt"}' }] }
    }
    if (i === 1) {
      return {
        toolCalls: [
          {
            name: 'exit_plan_mode',
            args: JSON.stringify({ plan: '1. Write "after" into note.txt.', summary: 'Update note.txt' }),
          },
        ],
      }
    }
    if (i === 2) {
      assert.equal(body.model, 'gpt-5.4-mini')
      return {
        toolCalls: [{ name: 'write_file', args: JSON.stringify({ path: 'note.txt', content: 'after' }) }],
      }
    }
    return { text: 'Updated note.txt to after.' }
  })

  const plannerProv: ProviderConfig = {
    id: 'p_plan',
    name: 'PlannerProv',
    protocol: 'openai',
    baseUrl: mock.url,
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6'],
    hasKey: true,
  }
  const execProv: ProviderConfig = {
    id: 'p_exec',
    name: 'ExecProv',
    protocol: 'openai',
    baseUrl: mock.url,
    model: 'gpt-5.4-mini',
    models: ['gpt-5.4-mini'],
    hasKey: true,
  }
  const settings: AppSettings = {
    locale: 'en',
    theme: 'dark',
    onboarded: true,
    proxyMode: 'none',
    workspace: ws,
    agentMode: 'bypass',
    orchestratorEnabled: true,
  }
  const { loop, events } = makeProvidersLoopDeps([plannerProv, execProv], settings, async (p, m) => {
    modelCalls.push(`${p.id}:${m}`)
  })
  const conv: Conversation = { id: 'c_exec', title: 'Exec', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }

  await loop.run(conv, 'Update note.txt to after')

  assert.equal(await readFile(join(ws, 'note.txt'), 'utf8'), 'after')
  assert.deepEqual(modelCalls, ['p_plan:claude-opus-4-6', 'p_exec:gpt-5.4-mini'])
  // Planner round must NOT expose mutating tools; Executor round MUST expose write_file + request_plan_review
  const plannerToolNames = mock.requests[0].tools.map((x: any) => x.function.name)
  assert.ok(plannerToolNames.includes('exit_plan_mode'))
  assert.ok(!plannerToolNames.includes('write_file'))
  const execToolNames = mock.requests[2].tools.map((x: any) => x.function.name)
  assert.ok(execToolNames.includes('write_file'))
  assert.ok(execToolNames.includes('request_plan_review'))

  const phaseEvents = events.filter((e) => e.type === 'orchestrator_phase')
  assert.deepEqual(
    phaseEvents.map((e: any) => `${e.phase}:${e.model}`),
    ['plan:claude-opus-4-6', 'execute:gpt-5.4-mini'],
  )
})

test('AgentLoop orchestrator: plan review hand-back loop and maxHandoffs guardrail', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-orch-rev-'))
  t.after(() => rm(ws, { recursive: true, force: true }))

  const mock = await startMockOpenAi(t, (_body, i) => {
    if (i === 0) {
      return { toolCalls: [{ name: 'exit_plan_mode', args: JSON.stringify({ plan: 'Step 1' }) }] }
    }
    if (i === 1) {
      return {
        toolCalls: [{ name: 'request_plan_review', args: JSON.stringify({ reason: 'Missing schema', report: 'Blocked on schema' }) }],
      }
    }
    if (i === 2) {
      return { toolCalls: [{ name: 'exit_plan_mode', args: JSON.stringify({ plan: 'Revised Step 1' }) }] }
    }
    if (i === 3) {
      // Second hand-back exceeds orchestratorMaxHandoffs: 1
      return {
        toolCalls: [{ name: 'request_plan_review', args: JSON.stringify({ reason: 'Still blocked', report: 'Attempt 2' }) }],
      }
    }
    return { text: 'Wrapped up cleanly after cap.' }
  })

  const provider: ProviderConfig = {
    id: 'p1',
    name: 'Prov',
    protocol: 'openai',
    baseUrl: mock.url,
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'claude-haiku-4-5'],
    hasKey: true,
  }
  const settings: AppSettings = {
    locale: 'en',
    theme: 'dark',
    onboarded: true,
    proxyMode: 'none',
    workspace: ws,
    agentMode: 'bypass',
    orchestratorEnabled: true,
    orchestratorMaxHandoffs: 1,
  }
  const { loop, events } = makeProvidersLoopDeps([provider], settings)
  const conv: Conversation = { id: 'c_rev', title: 'Rev', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }

  await loop.run(conv, 'Build schema')

  const phaseEvents = events.filter((e) => e.type === 'orchestrator_phase') as Array<
    Extract<AgentEvent, { type: 'orchestrator_phase' }>
  >
  assert.deepEqual(
    phaseEvents.map((e) => `${e.phase}:${e.handoffCount}:${e.model}`),
    [
      'plan:0:claude-opus-4-6',
      'execute:0:claude-haiku-4-5',
      'review:1:claude-opus-4-6',
      'execute:1:claude-haiku-4-5',
    ],
  )
  // Review request prompt must contain [plan review]
  assert.match(mock.requests[2].messages[0].content, /\[plan review\]/)
  // Capped second request_plan_review keeps executor on round 4 instead of transitioning again
  assert.equal(mock.requests[4].model, 'claude-haiku-4-5')
})

test('AgentLoop orchestrator: respects manual plan mode and routes subagents to fast executor', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-orch-sub-'))
  t.after(() => rm(ws, { recursive: true, force: true }))

  // 1. Manual plan mode must not activate orchestrator
  const planMock = await startMockOpenAi(t, () => ({ text: 'Manual plan output' }))
  const prov1: ProviderConfig = {
    id: 'p1',
    name: 'Prov',
    protocol: 'openai',
    baseUrl: planMock.url,
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'claude-haiku-4-5'],
    hasKey: true,
  }
  const { loop: planLoop } = makeProvidersLoopDeps([prov1], {
    locale: 'en',
    theme: 'dark',
    onboarded: true,
    proxyMode: 'none',
    workspace: ws,
    agentMode: 'plan',
    orchestratorEnabled: true,
  })
  await planLoop.run({ id: 'c_man', title: 'M', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }, 'Plan only')
  assert.ok(!planMock.requests[0].tools.some((x: any) => x.function.name === 'exit_plan_mode'))

  // 2. Subagent inherits fast executor model when Orchestrator + orchestratorSubagentsUseExecutor are enabled
  const subMock = await startMockOpenAi(t, (body, i) => {
    if (i === 0) {
      return { toolCalls: [{ name: 'run_subagent', args: JSON.stringify({ role: 'explorer', task: 'Inspect repo' }) }] }
    }
    if (i === 1) {
      assert.equal(body.model, 'claude-haiku-4-5', 'explorer subagent must use fast executor model')
      return { text: 'Subagent found nothing missing.' }
    }
    return { text: 'Planner answered using fast subagent findings.' }
  })
  const prov2: ProviderConfig = { ...prov1, baseUrl: subMock.url }
  const { loop: subLoop } = makeProvidersLoopDeps([prov2], {
    locale: 'en',
    theme: 'dark',
    onboarded: true,
    proxyMode: 'none',
    workspace: ws,
    agentMode: 'auto',
    orchestratorEnabled: true,
    orchestratorSubagentsUseExecutor: true,
  })
  await subLoop.run({ id: 'c_sub', title: 'S', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }, 'Explain repo')
  assert.deepEqual(
    subMock.requests.map((r) => r.model),
    ['claude-opus-4-6', 'claude-haiku-4-5', 'claude-opus-4-6'],
  )
})

test('CLI parity: parses orchestrator flags and /orchestrator slash command updates SettingsStore', async (t) => {
  const onParsed = parseCliArgs(['--orchestrator', '--executor-model', 'gpt-5.4-mini', '-p', 'ship it'])
  assert.equal(onParsed.orchestrator, true)
  assert.equal(onParsed.executorModel, 'gpt-5.4-mini')

  const offParsed = parseCliArgs(['--no-orchestrator', '--fast-model=claude-haiku-4-5'])
  assert.equal(offParsed.orchestrator, false)
  assert.equal(offParsed.executorModel, 'claude-haiku-4-5')

  const homeDir = await mkdtemp(join(tmpdir(), 'atrium-cli-orch-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  const runtime = new CliRuntime({ homeDir, connectMcp: false, requireAccount: false })
  t.after(() => runtime.dispose())
  await runtime.init()

  await runtime.settings.saveProvider({
    name: 'Mock',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'claude-opus-4-6',
    models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    apiKey: 'sk-test',
  })

  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  stdout.on('data', (c) => (out += c.toString()))
  const io = { stdin, stdout, stderr, palette: createPalette(false), isTty: false }

  await handleOrchestratorCommand(runtime, 'on', io)
  assert.equal(runtime.settings.get().orchestratorEnabled, true)

  await handleOrchestratorCommand(runtime, 'haiku', io)
  assert.equal(runtime.settings.get().orchestratorExecutorModel, 'claude-haiku-4-5')

  await handleOrchestratorCommand(runtime, 'subagents off', io)
  assert.equal(runtime.settings.get().orchestratorSubagentsUseExecutor, false)

  await handleOrchestratorCommand(runtime, 'auto', io)
  assert.equal(runtime.settings.get().orchestratorExecutorModel, undefined)

  await handleOrchestratorCommand(runtime, 'off', io)
  assert.equal(runtime.settings.get().orchestratorEnabled, false)
  assert.match(out, /Orchestrator:/)
})
