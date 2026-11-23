import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentLoop } from '../src/core/agent.ts'
import { McpManager } from '../src/core/mcp/manager.ts'
import { MemoryStore } from '../src/core/memory.ts'
import { PluginManager } from '../src/core/plugins.ts'
import { SettingsStore } from '../src/core/settings.ts'
import { TerminalManager } from '../src/core/terminal.ts'
import type { AgentEvent, AppSettings, Conversation, Message } from '../src/shared/types.ts'

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '')
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000, stepMs = 80): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
}

type MockReply = {
  text?: string
  tool?: { id?: string; name: string; args: string }
}

async function mockOpenAiServer(
  handler: (reqBody: any, index: number) => MockReply | Promise<MockReply>,
): Promise<{ server: Server; url: string; requests: any[] }> {
  const requests: any[] = []
  let idx = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const parsed = JSON.parse(body)
      requests.push(parsed)
      const reply = await handler(parsed, idx++)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (reply.tool) {
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: reply.tool.id ?? `call_${idx}`,
                type: 'function',
                function: { name: reply.tool.name, arguments: reply.tool.args },
              },
            ],
          },
          'tool_calls',
        )
      } else {
        send({ content: reply.text ?? 'ok' }, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/v1`, requests }
}

function makeFakeSettings(baseUrl: string, overrides: Partial<AppSettings> = {}): SettingsStore {
  const cur: AppSettings = {
    locale: 'en',
    theme: 'light',
    onboarded: true,
    proxyMode: 'none',
    agentMode: 'auto',
    autoCompact: false,
    webEnabled: false,
    memoryEnabled: true,
    autoExtractMemory: false,
    enablePluginHooks: false,
    maxAgentRounds: 40,
    ...overrides,
  }
  return {
    activeProvider: () => ({
      id: 'mock',
      name: 'Mock',
      protocol: 'openai' as const,
      baseUrl,
      model: 'mock-gpt',
      hasKey: true,
    }),
    providerKey: async () => 'test-key',
    get: () => cur,
    allowedRulesFor: () => [],
  } as unknown as SettingsStore
}

// ---- Track 1A: Real PTY / ConPTY ----

test('Track 1A: TerminalManager runs real resizeable PTY and handles SIGINT cleanly', { timeout: 25_000 }, async (t) => {
  if (process.platform !== 'win32') return
  const dir = await mkdtemp(join(tmpdir(), 'atrium-pty-test-'))
  let out = ''
  const tm = new TerminalManager({
    emit: (ev) => {
      if (ev.type === 'data') out += ev.chunk
    },
    getDefaultWorkspace: () => dir,
    dataDir: dir,
  })
  t.after(async () => {
    tm.shutdown()
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  })

  const session = tm.create({ cols: 92, rows: 26 })
  assert.equal(session.pty, true)
  assert.equal(session.cols, 92)
  assert.equal(session.rows, 26)

  await waitFor(() => stripAnsi(out).includes('PS '), 10_000)

  tm.write(session.id, 'Write-Host ("W1=" + $Host.UI.RawUI.WindowSize.Width)\r')
  await waitFor(() => stripAnsi(out).includes('W1=92'), 6_000)

  tm.resize(session.id, 114, 34)
  assert.equal(tm.get(session.id)?.cols, 114)
  assert.equal(tm.get(session.id)?.rows, 34)
  await new Promise((r) => setTimeout(r, 250))

  tm.write(session.id, 'Write-Host ("W2=" + $Host.UI.RawUI.WindowSize.Width)\r')
  await waitFor(() => stripAnsi(out).includes('W2=114'), 6_000)

  tm.write(session.id, 'Start-Sleep 8; Write-Host ("SLEEP_" + "DONE")\r')
  await new Promise((r) => setTimeout(r, 400))
  tm.signal(session.id, 'SIGINT')
  await new Promise((r) => setTimeout(r, 400))
  tm.write(session.id, 'Write-Host ("ALIVE_" + "NOW")\r')
  await waitFor(() => stripAnsi(out).includes('ALIVE_NOW'), 6_000)

  assert.equal(tm.get(session.id)?.status, 'running')
  assert.equal(stripAnsi(out).includes('SLEEP_DONE'), false)

  tm.close(session.id)
  assert.equal(tm.get(session.id), undefined)
})

// ---- Track 1B: Full MCP (Image forwarding, MIME guard, Resources, Prompts, Plan mode) ----

test('Track 1B: MCP client and AgentLoop forward images, resources, and prompts', { timeout: 30_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-mcp-v03-'))
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined))

  const serverScript = fileURLToPath(new URL('./fixtures/rich-server.mjs', import.meta.url))

  const mcp = new McpManager(dir, () => undefined)
  t.after(() => mcp.shutdown())

  const saved = await mcp.save({
    name: 'RichServer',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [serverScript],
    cwd: process.cwd(),
  })

  await waitFor(() => mcp.statuses().some((s) => s.id === saved.id && s.state === 'connected'), 10_000)

  const resources = mcp.resources()
  assert.equal(resources.length, 1)
  assert.equal(resources[0]?.uri, 'atrium://docs/spec')
  assert.equal(resources[0]?.serverName, 'RichServer')

  const prompts = mcp.prompts()
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]?.name, 'review_patch')

  const readRes = await mcp.readResource(saved.id, 'atrium://docs/spec')
  assert.match(readRes.text ?? '', /Use ConPTY cleanly/)

  const gotPrompt = await mcp.getPrompt(saved.id, 'review_patch', { target: 'auth.ts' })
  assert.equal(gotPrompt.text, 'Please review changes in auth.ts')

  const exposedTool = mcp.tools()[0]!.exposedName
  const callRes = await mcp.callTool(exposedTool, { page: 'home' }, new AbortController().signal)
  assert.equal(callRes.isError, false)
  assert.match(callRes.output, /UI inspection complete/)
  assert.match(callRes.output, /atrium:\/\/inline\/note/)
  assert.match(callRes.output, /inline secret note/)
  assert.match(callRes.output, /image omitted/i)
  assert.equal(callRes.images?.length, 1)
  assert.equal(callRes.images?.[0]?.mimeType, 'image/png')
  assert.ok(callRes.images?.[0]?.dataUrl.startsWith(`data:image/png;base64,${TINY_PNG_B64}`))

  // Verify AgentLoop exposes mcp_list_resources / mcp_read_resource in Plan mode AND forwards tool images to model
  const mock = await mockOpenAiServer((_body, idx) => {
    if (idx === 0) return { tool: { name: 'mcp_list_resources', args: '{}' } }
    if (idx === 1) {
      return {
        tool: {
          name: 'mcp_read_resource',
          args: JSON.stringify({ server_id: saved.id, uri: 'atrium://docs/spec' }),
        },
      }
    }
    if (idx === 2) return { text: 'Plan summarized architecture spec.' }
    if (idx === 3) return { tool: { name: exposedTool, args: '{"page":"home"}' } }
    return { text: 'Saw the PNG screenshot clearly.' }
  })
  t.after(() => mock.server.close())

  const settings = makeFakeSettings(mock.url, { workspace: dir, agentMode: 'plan' })
  const loop = new AgentLoop({
    settings,
    mcp,
    emit: () => undefined,
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })

  const planConv: Conversation = { id: 'c_plan', title: '', createdAt: 0, updatedAt: 0, messages: [] }
  await loop.run(planConv, 'Inspect connected MCP specs')
  const planTools = mock.requests[0].tools.map((x: any) => x.function.name)
  assert.ok(planTools.includes('mcp_list_resources'))
  assert.ok(planTools.includes('mcp_read_resource'))
  assert.ok(!planTools.includes(exposedTool), 'mutating MCP tool stays hidden in plan mode')
  assert.ok(planConv.messages.some((m) => m.role === 'tool' && m.output.includes('Use ConPTY cleanly')))

  const autoSettings = makeFakeSettings(mock.url, {
    workspace: dir,
    agentMode: 'bypass',
    allowBypassPermissions: true,
  })
  const autoLoop = new AgentLoop({
    settings: autoSettings,
    mcp,
    emit: () => undefined,
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })
  const autoConv: Conversation = { id: 'c_auto', title: '', createdAt: 0, updatedAt: 0, messages: [] }
  await autoLoop.run(autoConv, 'Run inspect_ui and inspect the image')
  const imgToolMsg = autoConv.messages.find((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool')
  assert.equal(imgToolMsg?.images?.length, 1)
  // Next request after the tool call must carry a multimodal image_url part for the model
  const followUpUserMsgs = mock.requests[4].messages.filter(
    (m: any) => m.role === 'user' && Array.isArray(m.content) && m.content.some((p: any) => p.type === 'image_url'),
  )
  assert.equal(followUpUserMsgs.length, 1)
})

// ---- Track 1C: Plugin Lifecycle Hooks Engine ----

test('Track 1C: Plugin Hooks enforce PreToolUse block, PostToolUse context, Stop check, and toggle opt-in', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-hooks-v03-'))
  t.after(() => rm(root, { recursive: true, force: true }).catch(() => undefined))

  const appDir = join(root, 'app')
  const wsDir = join(root, 'ws')
  const srcPluginDir = join(root, 'guard-plugin')
  await mkdir(join(appDir, 'data'), { recursive: true })
  await mkdir(wsDir, { recursive: true })
  await mkdir(join(srcPluginDir, '.claude-plugin'), { recursive: true })
  await mkdir(join(srcPluginDir, 'hooks'), { recursive: true })

  await writeFile(join(wsDir, 'protected.ts'), 'export const LOCKED = true;\n', 'utf8')
  await writeFile(
    join(srcPluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'guard-plugin', version: '1.0.0', description: 'Lifecycle hook test' }),
    'utf8',
  )

  const preScript = `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);if(String(j.tool_input?.path||'').includes('protected.ts')){console.error('Cannot edit protected.ts');process.exit(2);}})"`
  const postScript = `node -e "process.stdin.resume();console.log(JSON.stringify({additionalContext:'POST_HOOK_VERIFIED'}))"`
  const stopScript = `node -e "const fs=require('fs');const p='stop-once.flag';if(!fs.existsSync(p)){fs.writeFileSync(p,'1');console.error('Run final check');process.exit(2);}"`

  await writeFile(
    join(srcPluginDir, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: preScript }] }],
        PostToolUse: [{ matcher: 'write_file', hooks: [{ type: 'command', command: postScript }] }],
        Stop: [{ hooks: [{ type: 'command', command: stopScript }] }],
      },
    }),
    'utf8',
  )

  const mcp = {
    list: () => [],
    save: async () => ({} as any),
    remove: async () => undefined,
    setEnabled: async () => undefined,
    tools: () => [],
    resources: () => [],
    findTool: () => undefined,
  } as unknown as PluginManager['deps']['mcp'] & McpManager

  const plugins = new PluginManager({ dir: appDir, mcp })
  await plugins.load()
  await plugins.importFolder(srcPluginDir)

  let hooksEnabled = false
  const mock = await mockOpenAiServer((_body, idx) => {
    if (idx === 0) {
      return { tool: { name: 'edit_file', args: JSON.stringify({ path: 'protected.ts', old_string: 'true', new_string: 'false' }) } }
    }
    if (idx === 1) return { text: 'Disabled hooks allowed edit.' }
    if (idx === 2) {
      return { tool: { name: 'edit_file', args: JSON.stringify({ path: 'protected.ts', old_string: 'false', new_string: 'true' }) } }
    }
    if (idx === 3) {
      return { tool: { name: 'write_file', args: JSON.stringify({ path: 'notes.txt', content: 'hello hook' }) } }
    }
    if (idx === 4) return { text: 'Initial draft before Stop hook.' }
    return { text: 'Final verified reply after Stop hook.' }
  })
  t.after(() => mock.server.close())

  const settings = makeFakeSettings(mock.url, { workspace: wsDir, agentMode: 'bypass' })
  ;(settings as any).get = () => ({
    workspace: wsDir,
    agentMode: 'bypass',
    allowBypassPermissions: true,
    enablePluginHooks: hooksEnabled,
    autoCompact: false,
    webEnabled: false,
    maxAgentRounds: 40,
  })

  const events: AgentEvent[] = []
  const loop = new AgentLoop({
    settings,
    mcp,
    plugins,
    emit: (e) => events.push(e),
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })

  // 1) With enablePluginHooks = false, edit succeeds and Stop does not re-trigger
  const cOff: Conversation = { id: 'hooks_off', title: '', createdAt: 0, updatedAt: 0, messages: [] }
  await loop.run(cOff, 'Edit protected.ts cleanly')
  assert.match(await readFile(join(wsDir, 'protected.ts'), 'utf8'), /LOCKED = false/)
  assert.equal(mock.requests.length, 2)

  // 2) With enablePluginHooks = true, PreToolUse blocks Edit (alias), PostToolUse adds context, Stop re-triggers once
  hooksEnabled = true
  const cOn: Conversation = { id: 'hooks_on', title: '', createdAt: 0, updatedAt: 0, messages: [] }
  await loop.run(cOn, 'Edit protected, write notes, finish')

  assert.match(await readFile(join(wsDir, 'protected.ts'), 'utf8'), /LOCKED = false/)
  const toolMsgs = cOn.messages.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool')
  assert.equal(toolMsgs[0]?.isError, true)
  assert.match(toolMsgs[0]?.output ?? '', /Blocked by plugin hook: Cannot edit protected\.ts/)
  assert.equal(toolMsgs[1]?.isError, false)
  assert.match(toolMsgs[1]?.output ?? '', /POST_HOOK_VERIFIED/)
  assert.ok(events.some((e) => e.type === 'hook_event' && e.decision === 'block' && e.event === 'PreToolUse'))
  assert.ok(events.some((e) => e.type === 'hook_event' && e.decision === 'block' && e.event === 'Stop'))
  assert.ok(cOn.messages.some((m) => m.role === 'user' && m.text.includes('Run final check')))
  assert.equal(cOn.messages.at(-1)?.role, 'assistant')
  assert.match((cOn.messages.at(-1) as any).text, /Final verified reply/)

  // 3) Infinite Stop hook is capped cleanly at 2 continuations so turns always terminate
  const loopStopDir = await mkdtemp(join(tmpdir(), 'atrium-stopcap-'))
  t.after(() => rm(loopStopDir, { recursive: true, force: true }).catch(() => undefined))
  await mkdir(join(loopStopDir, '.atrium'), { recursive: true })
  await writeFile(
    join(loopStopDir, '.atrium', 'hooks.json'),
    JSON.stringify({
      Stop: [{ hooks: [{ type: 'command', command: `node -e "console.error('Always block stop');process.exit(2);"` }] }],
    }),
    'utf8',
  )
  let capCalls = 0
  const capMock = await mockOpenAiServer(() => {
    capCalls++
    return { text: `Attempt ${capCalls}` }
  })
  t.after(() => capMock.server.close())
  const capSettings = makeFakeSettings(capMock.url, {
    workspace: loopStopDir,
    agentMode: 'bypass',
    enablePluginHooks: true,
  })
  const capLoop = new AgentLoop({
    settings: capSettings,
    mcp,
    emit: () => undefined,
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })
  const capConv: Conversation = { id: 'stop_cap', title: '', createdAt: 0, updatedAt: 0, messages: [] }
  await capLoop.run(capConv, 'Test stop hook cap')
  // Initial turn + up to 2 Stop hook continuations = 3 model calls total
  assert.equal(capCalls, 3)
})

// ---- Track 1D: Configurable Max Rounds & Silent Auto-Memory ----

test('Track 1D: maxAgentRounds cap and silent auto-memory extraction work safely', { timeout: 25_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-round-mem-'))
  t.after(() => rm(dir, { recursive: true, force: true }).catch(() => undefined))
  await writeFile(join(dir, 'a.txt'), 'alpha', 'utf8')

  let mode: 'loop' | 'chat' = 'loop'
  let extractCalls = 0
  const mock = await mockOpenAiServer((body) => {
    if (mode === 'loop') {
      return { tool: { name: 'read_file', args: '{"path":"a.txt"}' } }
    }
    if (JSON.stringify(body.messages ?? []).includes('Existing memories:')) {
      extractCalls++
      return {
        text: JSON.stringify([
          { content: 'Always validate TypeScript with npm run typecheck.', category: 'workflow', scope: 'workspace' },
        ]),
      }
    }
    return { text: 'Sure, noted!' }
  })
  t.after(() => mock.server.close())

  const memory = new MemoryStore(dir)
  await memory.load()
  const settings = makeFakeSettings(mock.url, {
    workspace: dir,
    maxAgentRounds: 10,
    memoryEnabled: true,
    autoExtractMemory: true,
  })
  const mcp = { tools: () => [], resources: () => [], findTool: () => undefined } as unknown as McpManager
  const events: AgentEvent[] = []
  const loop = new AgentLoop({
    settings,
    mcp,
    memory,
    emit: (e) => events.push(e),
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })

  // 1) Custom maxAgentRounds = 10 stops after 10 rounds with max_rounds
  const cLoop: Conversation = { id: 'c_rounds', title: '', createdAt: 0, updatedAt: 0, messages: [] }
  await loop.run(cLoop, 'Keep reading a.txt forever')
  assert.equal(mock.requests.length, 10)
  assert.deepEqual(events.at(-1), { type: 'turn_end', conversationId: 'c_rounds', reason: 'max_rounds' })

  // 2) After 2 user/assistant exchanges (= 4 substantive messages), autoExtractMemory fires in background
  mode = 'chat'
  const cMem: Conversation = { id: 'c_mem', title: '', createdAt: 0, updatedAt: 0, workspace: dir, messages: [] }
  await loop.run(cMem, 'First message')
  assert.equal(memory.list(dir).length, 0)
  await loop.run(cMem, 'Please always validate TypeScript with npm run typecheck after edits.')

  await waitFor(() => memory.list(dir).length === 1, 6_000)
  assert.match(memory.list(dir)[0]!.content, /npm run typecheck/)
  assert.equal(extractCalls, 1)

  // Immediate follow-up (< 4 new substantive messages) does not re-trigger extraction
  await loop.run(cMem, 'One more short reply')
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(extractCalls, 1)
})
