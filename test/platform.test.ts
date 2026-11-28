// Unit and integration tests for Atrium Platform (adapters, localhost MCP/HTTP Agent-Bus, cross-agent delegation, depth guardrails, and cancellation).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformEvent } from '../src/shared/platform.ts'
import {
  buildAgentCommandSpec,
  detectLocalAgentEndpoint,
  detectLocalDefaultEffort,
  detectLocalDefaultModel,
  extractSafeEndpointLabel,
  inferEffortFromModelName,
  parseAgentStreamLine,
  parseAgyModelsOutput,
  probeClaudeCodeModels,
  probeCodexModels,
  resolveAgyCliModelArg,
  resolveAgyVariantForEffort,
  resolveCliConfigModelValue,
  resolveSpawnSpec,
  writeLocalDefaultEffort,
  writeLocalDefaultModel,
} from '../src/core/platform/adapters.ts'
import { resolveAtriumProviderAndModel } from '../src/core/platform/atriumRunner.ts'
import { PlatformBusServer } from '../src/core/platform/bus.ts'
import { PlatformManager } from '../src/core/platform/manager.ts'
import { bindSecrets } from '../src/core/secrets.ts'
import { SettingsStore } from '../src/core/settings.ts'

test('platform adapters: buildAgentCommandSpec supports claude-code, agy, codex, gemini-cli, and custom placeholders', () => {
  const claudeSpec = buildAgentCommandSpec({
    profile: {
      id: 'claude-code',
      kind: 'claude-code',
      name: 'Claude Code',
      shortName: 'Claude',
      description: '',
      available: true,
      binaryPath: '/usr/bin/claude',
      detectedAt: 0,
      supportsMcpInjection: true,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'commander',
      permissionMode: 'accept_edits',
      accentColor: '#d97757',
    },
    prompt: 'Refactor module X',
    cwd: '/repo',
    permissionMode: 'plan',
    model: 'claude-sonnet-4-6',
    resumeSessionId: 'sess-123',
    systemPrompt: 'Commander instructions',
    mcpConfigPath: '/tmp/mcp.json',
  })
  assert.ok(claudeSpec.args.includes('--mcp-config'))
  assert.ok(claudeSpec.args.includes('/tmp/mcp.json'))
  assert.ok(claudeSpec.args.includes('--resume'))
  assert.ok(claudeSpec.args.includes('sess-123'))
  assert.ok(claudeSpec.args.includes('--permission-mode'))
  assert.ok(claudeSpec.args.includes('plan'))
  assert.equal(claudeSpec.stdinText, 'Refactor module X')

  const agySpec = buildAgentCommandSpec({
    profile: {
      id: 'agy',
      kind: 'agy',
      name: 'Antigravity (AGY)',
      shortName: 'AGY',
      description: '',
      available: true,
      binaryPath: '/usr/bin/agy',
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'worker',
      permissionMode: 'full_auto',
      accentColor: '#4f7df3',
    },
    prompt: 'Implement login form',
    cwd: '/repo',
    permissionMode: 'full_auto',
    resumeSessionId: 'conv-456',
  })
  assert.ok(agySpec.args.includes('--print'))
  assert.ok(agySpec.args.includes('--conversation'))
  assert.ok(agySpec.args.includes('conv-456'))
  assert.ok(agySpec.args.includes('--dangerously-skip-permissions'))

  const codexSpec = buildAgentCommandSpec({
    profile: {
      id: 'codex',
      kind: 'codex',
      name: 'Codex',
      shortName: 'Codex',
      description: '',
      available: true,
      binaryPath: '/usr/bin/codex',
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'worker',
      permissionMode: 'accept_edits',
      accentColor: '#10a37f',
    },
    prompt: 'Write unit tests',
    cwd: '/repo',
    permissionMode: 'accept_edits',
  })
  assert.deepEqual(codexSpec.args.slice(0, 3), ['exec', '--json', '-'])
  assert.ok(codexSpec.args.includes('--sandbox'))
  assert.ok(codexSpec.args.includes('workspace-write'))

  const customSpec = buildAgentCommandSpec({
    profile: {
      id: 'custom-one',
      kind: 'custom',
      name: 'Custom',
      shortName: 'Custom',
      description: '',
      available: true,
      binaryPath: '/bin/mycli',
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: false,
      supportsResume: false,
      role: 'worker',
      permissionMode: 'accept_edits',
      customArgs: ['run', '--dir', '{{cwd}}', '--msg', '{{prompt}}'],
      accentColor: '#7c6f64',
    },
    prompt: 'Hello world',
    cwd: '/proj',
    permissionMode: 'accept_edits',
  })
  assert.deepEqual(customSpec.args, ['run', '--dir', '/proj', '--msg', 'Hello world'])
  assert.equal(customSpec.stdinText, undefined)

  const winPs1 = resolveSpawnSpec('C:\\Users\\test\\gemini.cmd', ['-v'])
  assert.ok(winPs1.args.length > 0)
})

test('platform adapters: parseAgentStreamLine decodes Claude, Codex, Gemini/AGY, and plain text', () => {
  const claudeMsg = parseAgentStreamLine(
    'claude-code',
    JSON.stringify({
      type: 'assistant',
      session_id: 'c-sess-1',
      message: {
        content: [
          { type: 'thinking', thinking: 'Checking deps' },
          { type: 'text', text: 'Delegating now.' },
          { type: 'tool_use', name: 'mcp__atrium-platform__platform_delegate', input: { target_agent: 'agy' } },
        ],
      },
    }),
  )
  assert.equal(claudeMsg.nativeSessionId, 'c-sess-1')
  assert.equal(claudeMsg.thinkingDelta, 'Checking deps')
  assert.equal(claudeMsg.textDelta, 'Delegating now.')
  assert.equal(claudeMsg.toolCall?.name, 'mcp__atrium-platform__platform_delegate')

  const codexMsg = parseAgentStreamLine(
    'codex',
    JSON.stringify({
      type: 'item.completed',
      thread_id: 't-1',
      item: { type: 'agent_message', text: 'Tests passing.' },
    }),
  )
  assert.equal(codexMsg.nativeSessionId, 't-1')
  assert.equal(codexMsg.textDelta, 'Tests passing.')

  const agyMsg = parseAgentStreamLine(
    'agy',
    JSON.stringify({ type: 'message', role: 'assistant', conversation_id: 'agy-7', content: 'Updated UI.' }),
  )
  assert.equal(agyMsg.nativeSessionId, 'agy-7')
  assert.equal(agyMsg.textDelta, 'Updated UI.')

  const plain = parseAgentStreamLine('dsh', 'Plain line output')
  assert.equal(plain.textDelta, 'Plain line output\n')
})

test('PlatformBusServer: enforces Bearer token auth and handles MCP JSON-RPC + REST /api/call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-bus-test-'))
  const bus = new PlatformBusServer({
    sessionId: 'sess-bus-1',
    runtimeDir: join(root, 'runtime'),
    dispatcher: async (toolName, args, ctx) => ({ echoTool: toolName, args, callerTaskId: ctx.callerTaskId }),
  })
  t.after(async () => {
    await bus.close()
    await rm(root, { recursive: true, force: true })
  })

  await bus.start()

  const unauthRes = await fetch(`${bus.baseUrl}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: 'platform_list_agents' }),
  })
  assert.equal(unauthRes.status, 401)

  const initRes = await fetch(bus.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bus.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  })
  assert.equal(initRes.status, 200)
  const initJson = (await initRes.json()) as { result: { serverInfo: { name: string } } }
  assert.equal(initJson.result.serverInfo.name, 'atrium-platform')

  const listRes = await fetch(bus.mcpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bus.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
  assert.ok(listJson.result.tools.some((tool) => tool.name === 'platform_delegate'))

  const callRes = await fetch(`${bus.baseUrl}/api/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bus.token}`,
      'X-Atrium-Task-Id': 'task-abc',
    },
    body: JSON.stringify({ tool: 'platform_board_read', args: { limit: 5 } }),
  })
  const callJson = (await callRes.json()) as { ok: boolean; result: { echoTool: string; callerTaskId: string } }
  assert.equal(callJson.ok, true)
  assert.equal(callJson.result.echoTool, 'platform_board_read')
  assert.equal(callJson.result.callerTaskId, 'task-abc')
})

test('PlatformManager E2E: mock Commander delegates to mock Worker via MCP bus, updates blackboard, and enforces maxDepth', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-plat-e2e-'))
  const dir = join(root, 'config')
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(dir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(workspace, { recursive: true })

  // Mock Worker script: reads prompt from stdin. If prompt requests nested delegation, tries MCP call to assert depth guard.
  const workerScript = join(root, 'mock-worker.mjs')
  await writeFile(
    workerScript,
    `import { readFileSync } from 'node:fs'
const prompt = readFileSync(0, 'utf8')
if (prompt.includes('TRY_NESTED_DELEGATE')) {
  const busUrl = process.env.ATRIUM_PLATFORM_BUS_URL
  const token = process.env.ATRIUM_PLATFORM_BUS_TOKEN
  const taskId = process.env.ATRIUM_PLATFORM_TASK_ID
  const res = await fetch(busUrl + '/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Atrium-Task-Id': taskId },
    body: JSON.stringify({ tool: 'platform_delegate', args: { target_agent: 'mock-worker', task: 'too deep' } })
  })
  const data = await res.json()
  console.log('NESTED_GUARD=' + JSON.stringify(data))
} else if (prompt.includes('WAIT_FOREVER')) {
  console.log('STARTED_LONG_TASK')
  setInterval(() => {}, 1000)
} else {
  const tail = prompt.split('---').pop() || prompt
  console.log('WORKER_DONE:' + tail.trim())
}
`,
    'utf8',
  )

  // Mock Commander script: connects to MCP /mcp endpoint, posts a blackboard note, delegates to mock-worker, prints summary.
  const commanderScript = join(root, 'mock-commander.mjs')
  await writeFile(
    commanderScript,
    `import { readFileSync } from 'node:fs'
const prompt = readFileSync(0, 'utf8')
const busUrl = process.env.ATRIUM_PLATFORM_BUS_URL
const token = process.env.ATRIUM_PLATFORM_BUS_TOKEN
const taskId = process.env.ATRIUM_PLATFORM_TASK_ID

async function mcpCall(name, args) {
  const res = await fetch(busUrl + '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'X-Atrium-Task-Id': taskId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const rpc = await res.json()
  return JSON.parse(rpc.result.content[0].text)
}

await mcpCall('platform_board_post', {
  title: 'Architecture Plan',
  content: 'Delegating subtask to mock-worker.',
  kind: 'plan',
})

const nestedFlag = prompt.includes('DEEP') ? ' TRY_NESTED_DELEGATE' : ''
const workerResult = await mcpCall('platform_delegate', {
  target_agent: 'mock-worker',
  task: 'Execute part A' + nestedFlag,
  wait: true,
})
console.log('COMMANDER_SUMMARY=' + workerResult.output.trim())
`,
    'utf8',
  )

  const secretMem = new Map<string, string>()
  bindSecrets((async (method: string, key: string, value?: string | null) => {
    if (method === 'secrets.get') return secretMem.get(key) ?? null
    if (method === 'secrets.set') {
      if (value == null) secretMem.delete(key)
      else secretMem.set(key, value)
    }
    return undefined
  }) as unknown as Parameters<typeof bindSecrets>[0])

  const settings = new SettingsStore(dir)
  await settings.load()

  const events: PlatformEvent[] = []
  const manager = new PlatformManager({
    dir,
    dataDir,
    settings,
    emit: (ev) => events.push(ev),
  })
  t.after(async () => {
    manager.shutdown()
    await new Promise((r) => setTimeout(r, 150))
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => undefined)
  })

  await manager.load()
  await manager.saveCustomAgent({
    id: 'mock-commander',
    name: 'Mock Commander',
    command: process.execPath,
    args: [commanderScript],
    permissionMode: 'full_auto',
  })
  await manager.saveCustomAgent({
    id: 'mock-worker',
    name: 'Mock Worker',
    command: process.execPath,
    args: [workerScript],
    permissionMode: 'full_auto',
  })
  await manager.updateAgent('mock-commander', { role: 'commander' })
  await manager.updateAgent('mock-worker', { role: 'worker' })

  const waitForCompletion = (sessionId: string) =>
    new Promise<NonNullable<ReturnType<typeof manager.getSession>>>((resolveDone, rejectDone) => {
      const deadline = Date.now() + 15_000
      const poll = () => {
        const cur = manager.getSession(sessionId)
        if (cur && cur.status !== 'running') {
          resolveDone(cur)
          return
        }
        if (Date.now() > deadline) {
          rejectDone(new Error('Timed out waiting for mock platform session'))
          return
        }
        setTimeout(poll, 40)
      }
      poll()
    })

  // Case 1: Normal cross-agent delegation + blackboard coordination
  const started = await manager.startSession({
    workspace,
    prompt: 'Build feature alpha',
    commanderId: 'mock-commander',
    workerIds: ['mock-worker'],
    maxDepth: 2,
  })
  const finished = await waitForCompletion(started.id)
  assert.equal(finished.status, 'completed')
  assert.equal(finished.tasks.length, 2)
  const rootTask = finished.tasks.find((task) => task.id === finished.rootTaskId)!
  const childTask = finished.tasks.find((task) => task.id !== finished.rootTaskId)!
  assert.equal(childTask.agentId, 'mock-worker')
  assert.equal(childTask.fromAgentId, 'mock-commander')
  assert.equal(childTask.depth, 1)
  assert.match(childTask.output, /WORKER_DONE:.*Execute part A/)
  assert.match(rootTask.output, /COMMANDER_SUMMARY=WORKER_DONE:/)
  assert.ok(finished.board.some((note) => note.title === 'Architecture Plan' && note.authorName === 'Mock Commander'))
  assert.ok(events.some((ev) => ev.type === 'task_delta'))

  // Case 2: Depth guardrail blocks delegation beyond maxDepth=1
  const deepStarted = await manager.startSession({
    workspace,
    prompt: 'DEEP test',
    commanderId: 'mock-commander',
    workerIds: ['mock-worker'],
    maxDepth: 1,
  })
  const deepFinished = await waitForCompletion(deepStarted.id)
  assert.equal(deepFinished.status, 'completed')
  const deepChild = deepFinished.tasks.find((task) => task.id !== deepFinished.rootTaskId)!
  assert.match(deepChild.output, /Delegation depth limit reached \(1\)/)

  // Case 3: stopSession cleanly aborts a long-running worker
  const longSess = await manager.startSession({
    workspace,
    prompt: 'WAIT_FOREVER',
    commanderId: 'mock-worker',
    workerIds: [],
  })
  await new Promise((r) => setTimeout(r, 250))
  await manager.stopSession(longSess.id)
  const stoppedSess = await waitForCompletion(longSess.id)
  assert.equal(stoppedSess.status, 'stopped')
})

test('platform adapters: parseAgyModelsOutput and detectLocalDefaultModel read local configs accurately', async (t) => {
  const parsed = parseAgyModelsOutput(
    [
      'Fetching available models...',
      'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
      'gemini-4-argon-medium\tDuplicate Ignored',
      '',
    ].join('\n'),
  )
  assert.deepEqual(parsed, [
    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  ])

  const fakeHome = await mkdtemp(join(tmpdir(), 'atrium-plat-home-'))
  t.after(async () => {
    await rm(fakeHome, { recursive: true, force: true })
  })

  await mkdir(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
  await mkdir(join(fakeHome, '.claude'), { recursive: true })
  await mkdir(join(fakeHome, '.codex'), { recursive: true })

  await writeFile(
    join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json'),
    JSON.stringify({ model: 'Gemini 4 Argon (Medium)' }),
    'utf8',
  )
  await writeFile(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({ model: 'sonnet' }),
    'utf8',
  )
  await writeFile(
    join(fakeHome, '.codex', 'config.toml'),
    'model = "gpt-5.6-sol"\n[model_providers.custom]\nmodel = "ignored-section"\n',
    'utf8',
  )

  assert.equal(await detectLocalDefaultModel('agy', fakeHome), 'Gemini 4 Argon (Medium)')
  assert.equal(await detectLocalDefaultModel('claude-code', fakeHome), 'sonnet')
  assert.equal(await detectLocalDefaultModel('codex', fakeHome), 'gpt-5.6-sol')
  assert.equal(await detectLocalDefaultModel('dsh', fakeHome), undefined)
})

test('platform adapters: writeLocalDefaultModel updates local CLI configs safely and resolves AGY + DSH flags', async (t) => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'atrium-plat-write-'))
  t.after(async () => {
    await rm(fakeHome, { recursive: true, force: true })
  })

  await mkdir(join(fakeHome, '.gemini', 'antigravity-cli'), { recursive: true })
  await mkdir(join(fakeHome, '.claude'), { recursive: true })
  await mkdir(join(fakeHome, '.codex'), { recursive: true })

  // Preserve hooks/env in Claude settings.json
  const claudePath = join(fakeHome, '.claude', 'settings.json')
  await writeFile(
    claudePath,
    JSON.stringify({ model: 'haiku', env: { FOO: 'bar' }, hooks: { PreToolUse: [] } }, null, 2),
    'utf8',
  )
  await writeLocalDefaultModel('claude-code', 'claude-sonnet-4-6', fakeHome)
  const claudeAfter = JSON.parse(await readFile(claudePath, 'utf8')) as Record<string, unknown>
  assert.equal(claudeAfter.model, 'claude-sonnet-4-6')
  assert.deepEqual(claudeAfter.env, { FOO: 'bar' })
  assert.deepEqual(claudeAfter.hooks, { PreToolUse: [] })

  // Preserve sibling keys in AGY settings.json and round-trip ID <-> display label
  const agyPath = join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json')
  await writeFile(agyPath, JSON.stringify({ model: 'Gemini 4 Argon (Medium)', telemetry: false }, null, 2), 'utf8')
  const agyModels = [
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
  ]
  const agyConfigVal = resolveCliConfigModelValue('agy', 'gemini-4-argon-high', agyModels)
  assert.equal(agyConfigVal, 'Gemini 4 Argon (High)')
  await writeLocalDefaultModel('agy', agyConfigVal, fakeHome)
  const agyAfter = JSON.parse(await readFile(agyPath, 'utf8')) as Record<string, unknown>
  assert.equal(agyAfter.model, 'Gemini 4 Argon (High)')
  assert.equal(agyAfter.telemetry, false)
  assert.equal(resolveAgyCliModelArg('Gemini 4 Argon (High)', agyModels), 'gemini-4-argon-high')

  const agySpec = buildAgentCommandSpec({
    profile: {
      id: 'agy',
      kind: 'agy',
      name: 'Antigravity (AGY)',
      shortName: 'AGY',
      description: '',
      available: true,
      binaryPath: '/usr/bin/agy',
      availableModels: agyModels,
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'worker',
      permissionMode: 'accept_edits',
      accentColor: '#4f7df3',
    },
    prompt: 'Fix lint',
    cwd: '/repo',
    permissionMode: 'accept_edits',
    model: 'Claude Opus 5.5 (High)',
  })
  assert.ok(agySpec.args.includes('--model'))
  assert.equal(agySpec.args[agySpec.args.indexOf('--model') + 1], 'claude-opus-5-5-high')

  // Preserve object form model: { name } in Gemini CLI settings.json
  const geminiPath = join(fakeHome, '.gemini', 'settings.json')
  await writeFile(geminiPath, JSON.stringify({ model: { name: 'gemini-2.5-flash' }, theme: 'dark' }, null, 2), 'utf8')
  await writeLocalDefaultModel('gemini-cli', 'gemini-2.5-pro', fakeHome)
  const geminiAfter = JSON.parse(await readFile(geminiPath, 'utf8')) as { model: { name: string }; theme: string }
  assert.equal(geminiAfter.model.name, 'gemini-2.5-pro')
  assert.equal(geminiAfter.theme, 'dark')
  assert.equal(await detectLocalDefaultModel('gemini-cli', fakeHome), 'gemini-2.5-pro')

  // Surgical TOML update for Codex: leave [model_providers.custom] and tokens untouched
  const codexPath = join(fakeHome, '.codex', 'config.toml')
  const tailSection =
    '\n[model_providers.custom]\nbase_url = "https://example.invalid"\nexperimental_bearer_token = "tok_secret_preserve_me"\n'
  await writeFile(codexPath, `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"${tailSection}`, 'utf8')
  await writeLocalDefaultModel('codex', 'gpt-5.4', fakeHome)
  const codexRaw = await readFile(codexPath, 'utf8')
  assert.equal(codexRaw, `model = "gpt-5.4"\nmodel_reasoning_effort = "high"${tailSection}`)

  // DSH passes --model when set
  const dshSpec = buildAgentCommandSpec({
    profile: {
      id: 'dsh',
      kind: 'dsh',
      name: 'DeepSeek Harness (DSH)',
      shortName: 'DSH',
      description: '',
      available: true,
      binaryPath: '/usr/bin/dsh',
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: false,
      supportsResume: false,
      role: 'worker',
      permissionMode: 'accept_edits',
      accentColor: '#3b82f6',
    },
    prompt: 'Check diff',
    cwd: '/repo',
    permissionMode: 'accept_edits',
    model: 'deepseek-reasoner',
  })
  assert.deepEqual(dshSpec.args, ['-p', '--model', 'deepseek-reasoner'])
})

test('platform runner & manager: resolveAtriumProviderAndModel routes cross-provider and syncs default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-plat-prov-'))
  const dir = join(root, 'config')
  const dataDir = join(root, 'data')
  await mkdir(dir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 }).catch(() => undefined)
  })

  const secretMem = new Map<string, string>()
  bindSecrets((async (method: string, key: string, value?: string | null) => {
    if (method === 'secrets.get') return secretMem.get(key) ?? null
    if (method === 'secrets.set') {
      if (value == null) secretMem.delete(key)
      else secretMem.set(key, value)
    }
    return undefined
  }) as unknown as Parameters<typeof bindSecrets>[0])

  const settings = new SettingsStore(dir)
  await settings.load()
  const provA = await settings.saveProvider({
    name: 'Provider A',
    protocol: 'openai',
    baseUrl: 'https://a.invalid/v1',
    model: 'qwen-max',
    models: ['qwen-max', 'shared-model'],
    apiKey: 'key-a',
  })
  const provB = await settings.saveProvider({
    name: 'Provider B',
    protocol: 'anthropic',
    baseUrl: 'https://b.invalid',
    model: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'shared-model'],
    apiKey: 'key-b',
  })

  // Explicit override to non-active provB model resolves provB
  const resolvedCross = resolveAtriumProviderAndModel(settings, 'claude-sonnet-4-6')
  assert.equal(resolvedCross.provider.id, provB.id)
  assert.equal(resolvedCross.model, 'claude-sonnet-4-6')

  // Explicit providerId breaks ties when both providers offer the same model
  const resolvedTie = resolveAtriumProviderAndModel(settings, 'shared-model', provB.id)
  assert.equal(resolvedTie.provider.id, provB.id)
  assert.equal(resolvedTie.model, 'shared-model')

  // Default returns active provider provA
  const resolvedDefault = resolveAtriumProviderAndModel(settings)
  assert.equal(resolvedDefault.provider.id, provA.id)
  assert.equal(resolvedDefault.model, 'qwen-max')

  const manager = new PlatformManager({
    dir,
    dataDir,
    settings,
    emit: () => undefined,
  })
  t.after(() => manager.shutdown())
  await manager.load()

  const updated = await manager.updateAgent('atrium', {
    modelOverride: 'claude-sonnet-4-6',
    modelProviderOverride: provB.id,
  })
  const atriumAfterOverride = updated.find((a) => a.id === 'atrium')!
  assert.equal(atriumAfterOverride.modelOverride, 'claude-sonnet-4-6')
  assert.equal(atriumAfterOverride.modelProviderOverride, provB.id)

  // Syncing to Atrium default updates activeProvider & clears override
  const synced = await manager.updateAgent('atrium', {
    modelOverride: 'claude-sonnet-4-6',
    modelProviderOverride: provB.id,
    syncToCliConfig: true,
  })
  const atriumAfterSync = synced.find((a) => a.id === 'atrium')!
  assert.equal(atriumAfterSync.modelOverride, undefined)
  assert.equal(atriumAfterSync.modelProviderOverride, undefined)
  assert.equal(settings.activeProvider()?.id, provB.id)
  assert.equal(settings.activeProvider()?.model, 'claude-sonnet-4-6')
})

test('platform effort & cache: detects/writes effort configs, pairs AGY variants, passes CLI flags, and persists model cache', async (t) => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'atrium-plat-effort-'))
  t.after(async () => {
    await rm(fakeHome, { recursive: true, force: true })
  })

  await mkdir(join(fakeHome, '.claude'), { recursive: true })
  await mkdir(join(fakeHome, '.codex'), { recursive: true })

  // 1. Infer effort from AGY labels/slugs & find sibling variants
  assert.equal(inferEffortFromModelName('Gemini 4 Argon (Medium)'), 'medium')
  assert.equal(inferEffortFromModelName('gemini-4-neon-xhigh'), 'xhigh')
  assert.equal(inferEffortFromModelName('gpt-5.4'), undefined)

  const agyModels = [
    { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
  ]
  const paired = resolveAgyVariantForEffort('Gemini 4 Argon (Medium)', 'high', agyModels)
  assert.equal(paired?.id, 'gemini-4-argon-high')

  const agySpec = buildAgentCommandSpec({
    profile: {
      id: 'agy',
      kind: 'agy',
      name: 'Antigravity (AGY)',
      shortName: 'AGY',
      description: '',
      available: true,
      binaryPath: '/usr/bin/agy',
      defaultModel: 'Gemini 4 Argon (Medium)',
      availableModels: agyModels,
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'worker',
      permissionMode: 'accept_edits',
      accentColor: '#4f7df3',
    },
    prompt: 'Refactor',
    cwd: '/repo',
    permissionMode: 'accept_edits',
    reasoningEffort: 'high',
  })
  assert.equal(agySpec.args[agySpec.args.indexOf('--model') + 1], 'gemini-4-argon-high')
  assert.equal(agySpec.args[agySpec.args.indexOf('--effort') + 1], 'high')

  // 2. Claude Code effortLevel read/write + --effort flag
  const claudePath = join(fakeHome, '.claude', 'settings.json')
  await writeFile(claudePath, JSON.stringify({ model: 'sonnet', effortLevel: 'high', hooks: { Stop: [] } }), 'utf8')
  assert.equal(await detectLocalDefaultEffort('claude-code', undefined, fakeHome), 'high')
  await writeLocalDefaultEffort('claude-code', 'xhigh', fakeHome)
  const claudeAfter = JSON.parse(await readFile(claudePath, 'utf8')) as { effortLevel: string; hooks: unknown }
  assert.equal(claudeAfter.effortLevel, 'xhigh')
  assert.deepEqual(claudeAfter.hooks, { Stop: [] })

  const claudeSpec = buildAgentCommandSpec({
    profile: {
      id: 'claude-code',
      kind: 'claude-code',
      name: 'Claude Code',
      shortName: 'Claude',
      description: '',
      available: true,
      binaryPath: '/usr/bin/claude',
      detectedAt: 0,
      supportsMcpInjection: true,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'commander',
      permissionMode: 'accept_edits',
      accentColor: '#d97757',
    },
    prompt: 'Plan architecture',
    cwd: '/repo',
    permissionMode: 'plan',
    reasoningEffort: 'xhigh',
  })
  assert.equal(claudeSpec.args[claudeSpec.args.indexOf('--effort') + 1], 'xhigh')

  // 3. Codex surgical TOML effort update preserving tokens + -c override flag
  const codexPath = join(fakeHome, '.codex', 'config.toml')
  const tail = '\n[model_providers.custom]\nexperimental_bearer_token = "tok_keep_intact"\n'
  await writeFile(codexPath, `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"${tail}`, 'utf8')
  assert.equal(await detectLocalDefaultEffort('codex', undefined, fakeHome), 'medium')
  await writeLocalDefaultEffort('codex', 'high', fakeHome)
  assert.equal(await readFile(codexPath, 'utf8'), `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"${tail}`)

  const codexSpec = buildAgentCommandSpec({
    profile: {
      id: 'codex',
      kind: 'codex',
      name: 'Codex',
      shortName: 'Codex',
      description: '',
      available: true,
      binaryPath: '/usr/bin/codex',
      detectedAt: 0,
      supportsMcpInjection: false,
      supportsStreamJson: true,
      supportsResume: true,
      role: 'worker',
      permissionMode: 'accept_edits',
      accentColor: '#10a37f',
    },
    prompt: 'Write tests',
    cwd: '/repo',
    permissionMode: 'accept_edits',
    reasoningEffort: 'xhigh',
  })
  assert.ok(codexSpec.args.includes('-c'))
  assert.equal(codexSpec.args[codexSpec.args.indexOf('-c') + 1], 'model_reasoning_effort="xhigh"')

  // 4. PlatformManager persists cachedModelsByAgent & syncs Atrium effort to SettingsStore
  const mgrRoot = join(fakeHome, 'mgr')
  const dir = join(mgrRoot, 'config')
  const dataDir = join(mgrRoot, 'data')
  await mkdir(dir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  const settings = new SettingsStore(dir)
  await settings.load()
  await writeFile(
    join(dir, 'platform-config.json'),
    JSON.stringify({
      prefs: {},
      customAgents: [],
      cachedModelsByAgent: { agy: agyModels },
    }),
    'utf8',
  )

  const manager = new PlatformManager({ dir, dataDir, settings, emit: () => undefined })
  t.after(() => manager.shutdown())
  await manager.load()
  const agents = await manager.getAgents()
  const loadedAgy = agents.find((a) => a.id === 'agy')!
  assert.equal(loadedAgy.availableModels?.length, 4)

  const afterEffort = await manager.updateAgent('atrium', {
    reasoningEffortOverride: 'high',
    syncToCliConfig: true,
  })
  const atrium = afterEffort.find((a) => a.id === 'atrium')!
  assert.equal(atrium.reasoningEffortOverride, undefined)
  assert.equal(atrium.defaultReasoningEffort, 'high')
  assert.equal(settings.get().reasoningEffort, 'high')
})

test('platform gateway discovery: probes Claude Code (cc-switch) and Codex third-party endpoints without leaking tokens', async (t) => {
  const { createServer } = await import('node:http')
  const fakeHome = await mkdtemp(join(tmpdir(), 'atrium-plat-gw-'))
  let seenAuth = ''
  const server = createServer((req, res) => {
    seenAuth = String(req.headers['x-api-key'] || req.headers.authorization || '')
    if (req.url?.startsWith('/v1/models') && !req.url.includes('fail')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', owned_by: 'anthropic' },
            { id: 'deepseek-v4', owned_by: 'deepseek' },
            { id: 'glm-5.3', owned_by: 'zhipu' },
          ],
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const addr = server.address() as { port: number }
  const gwUrl = `http://127.0.0.1:${addr.port}`

  t.after(async () => {
    await new Promise<void>((done) => server.close(() => done()))
    await rm(fakeHome, { recursive: true, force: true })
  })

  // Official hosts produce undefined endpointLabel; custom hosts strip path/creds safely
  assert.equal(extractSafeEndpointLabel('https://api.anthropic.com', ['api.anthropic.com']), undefined)
  assert.equal(extractSafeEndpointLabel('https://user:secret@proxy.example.com:8443/v1?x=1', ['api.anthropic.com']), 'proxy.example.com:8443')

  await mkdir(join(fakeHome, '.claude'), { recursive: true })
  await mkdir(join(fakeHome, '.codex'), { recursive: true })

  await writeFile(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'sonnet',
      env: {
        ANTHROPIC_BASE_URL: gwUrl,
        ANTHROPIC_AUTH_TOKEN: 'sk-ccswitch-secret',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3',
      },
      modelSettings: {
        'custom/router-model': {},
      },
    }),
    'utf8',
  )

  const claudeEndpoint = await detectLocalAgentEndpoint('claude-code', fakeHome)
  assert.equal(claudeEndpoint, `127.0.0.1:${addr.port}`)

  const claudeProbe = await probeClaudeCodeModels(fakeHome, {}, fetch)
  assert.equal(claudeProbe.endpointLabel, `127.0.0.1:${addr.port}`)
  assert.equal(seenAuth, 'sk-ccswitch-secret')
  const sonnetAlias = claudeProbe.models.find((m) => m.id === 'sonnet')!
  assert.equal(sonnetAlias.hint, '→ deepseek-v4')
  assert.ok(claudeProbe.models.some((m) => m.id === 'custom/router-model'))
  assert.ok(claudeProbe.models.some((m) => m.id === 'deepseek-v4'))
  assert.ok(claudeProbe.models.some((m) => m.id === 'glm-5.3'))
  assert.ok(!JSON.stringify(claudeProbe).includes('sk-ccswitch-secret'))

  // Graceful fallback when gateway endpoint is unreachable
  await writeFile(
    join(fakeHome, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'haiku',
      env: {
        ANTHROPIC_BASE_URL: `${gwUrl}/fail`,
        ANTHROPIC_AUTH_TOKEN: 'sk-fail-secret',
        ANTHROPIC_MODEL: 'fallback-gw-model',
      },
    }),
    'utf8',
  )
  const fallbackProbe = await probeClaudeCodeModels(fakeHome, {}, fetch)
  assert.ok(fallbackProbe.models.some((m) => m.id === 'fallback-gw-model'))
  assert.ok(!JSON.stringify(fallbackProbe).includes('sk-fail-secret'))

  // Codex third-party [model_providers.custom] discovery
  await writeFile(
    join(fakeHome, '.codex', 'config.toml'),
    `model = "gpt-5.6-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "${gwUrl}/v1"\nexperimental_bearer_token = "tok_codex_secret"\n`,
    'utf8',
  )
  const codexProbe = await probeCodexModels(fakeHome, {}, fetch)
  assert.equal(codexProbe.endpointLabel, `127.0.0.1:${addr.port}`)
  assert.equal(seenAuth, 'Bearer tok_codex_secret')
  assert.ok(codexProbe.models.some((m) => m.id === 'gpt-5.6-sol'))
  assert.ok(codexProbe.models.some((m) => m.id === 'claude-sonnet-4-6'))
  assert.ok(!JSON.stringify(codexProbe).includes('tok_codex_secret'))
})
