// Comprehensive tests for Agent Skills, Plan Mode, Parallel Subagents, and OpenAI/DeepSeek telemetry.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAgentMode, type AgentEvent, type AgentMode, type Conversation } from '../src/shared/types.ts'
import { supportsDeepSeekThinking } from '../src/shared/thinking.ts'
import { AgentLoop, isDangerousShellCommand } from '../src/core/agent.ts'
import { systemPrompt } from '../src/core/prompt.ts'
import type { SettingsStore } from '../src/core/settings.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import { buildOpenAiBody, openAiAdapter } from '../src/core/providers/openai.ts'
import { CheckpointStore } from '../src/core/tools/changes.ts'
import { parseSkillMarkdown, SkillsManager } from '../src/core/tools/skills.ts'

async function withTempDirs(fn: (dirs: { appDir: string; homeDir: string; workspace: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'atrium-sps-'))
  const appDir = join(root, 'app')
  const homeDir = join(root, 'home')
  const workspace = join(root, 'workspace')
  await Promise.all([mkdir(appDir, { recursive: true }), mkdir(homeDir, { recursive: true }), mkdir(workspace, { recursive: true })])
  try {
    await fn({ appDir, homeDir, workspace })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

interface MockToolCall {
  id?: string
  name: string
  args: string
}

interface MockResponsePlan {
  text?: string
  toolCalls?: MockToolCall[]
  delayMs?: number
  usage?: Record<string, unknown>
}

async function mockChatServer(
  responder: (reqBody: any, index: number) => Promise<MockResponsePlan> | MockResponsePlan,
): Promise<{ server: Server; url: string; requests: any[] }> {
  const requests: any[] = []
  let counter = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      void (async () => {
        const idx = counter++
        const parsed = JSON.parse(raw)
        requests.push(parsed)
        const plan = await responder(parsed, idx)
        if (plan.delayMs) await new Promise((r) => setTimeout(r, plan.delayMs))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (delta: object, finish: string | null = null) =>
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
        if (plan.toolCalls?.length) {
          plan.toolCalls.forEach((tc, i) => {
            send({
              tool_calls: [
                {
                  index: i,
                  id: tc.id ?? `call_${idx}_${i}`,
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
        if (plan.usage) {
          res.write(`data: ${JSON.stringify({ id: 'u', choices: [], usage: plan.usage })}\n\n`)
        }
        res.end('data: [DONE]\n\n')
      })()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, url: `http://127.0.0.1:${port}/v1`, requests }
}

const makeConv = (workspace: string): Conversation => ({
  id: 'conv_test',
  title: 'Test',
  workspace,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
})

test('SkillsManager discovers skills by precedence, parses frontmatter, prevents traversal, and manages lifecycle', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace }) => {
    // Same skill in user global and workspace `.agents/skills` -> workspace wins.
    const userReviewDir = join(homeDir, '.claude', 'skills', 'code-review')
    const wsReviewDir = join(workspace, '.agents', 'skills', 'code-review')
    const codexSkillDir = join(workspace, '.codex', 'skills', 'deploy-check')
    await Promise.all([
      mkdir(userReviewDir, { recursive: true }),
      mkdir(join(wsReviewDir, 'references'), { recursive: true }),
      mkdir(join(wsReviewDir, 'scripts'), { recursive: true }),
      mkdir(codexSkillDir, { recursive: true }),
    ])
    await writeFile(join(userReviewDir, 'SKILL.md'), '---\nname: code-review\ndescription: Global review\n---\nGlobal body')
    await writeFile(
      join(wsReviewDir, 'SKILL.md'),
      '---\nname: code-review\ndescription: |\n  Strict workspace review\n  with checklists.\n---\n# Review\nFollow steps.\n',
    )
    await writeFile(join(wsReviewDir, 'references', 'checklist.md'), 'Verify SQL & auth bounds.')
    await writeFile(join(wsReviewDir, 'scripts', 'lint.sh'), '#!/usr/bin/env bash\necho ok')
    await writeFile(join(codexSkillDir, 'SKILL.md'), '# Deploy Check\nVerify build before tagging release.')

    const secretOutside = join(workspace, 'secret.txt')
    await writeFile(secretOutside, 'TOP_SECRET')

    let disabled: string[] = []
    const mgr = new SkillsManager({
      appDir,
      homeDir,
      getDisabled: () => disabled,
      setDisabled: (next) => {
        disabled = next
      },
    })

    const list = await mgr.list(workspace)
    assert.equal(list.length, 2)
    const review = list.find((s) => s.name === 'code-review')!
    assert.equal(review.scope, 'workspace')
    assert.equal(review.source, '.agents/skills')
    assert.match(review.description, /Strict workspace review/)
    assert.equal(review.hasReferences, true)
    assert.equal(review.hasScripts, true)

    const deploy = list.find((s) => s.name === 'deploy-check')!
    assert.equal(deploy.source, '.codex/skills')
    assert.match(deploy.description, /Verify build before tagging release/)

    // Progressive-disclosure summary & loader.
    const promptBlock = await mgr.formatAvailableSkillsPrompt(workspace)
    assert.match(promptBlock, /<available_skills>/)
    assert.match(promptBlock, /code-review/)

    const mainDoc = await mgr.runLoadSkill(workspace, 'code-review')
    assert.equal(mainDoc.isError, false)
    assert.match(mainDoc.output, /Follow steps\./)

    const refDoc = await mgr.runLoadSkill(workspace, 'code-review', 'references/checklist.md')
    assert.equal(refDoc.isError, false)
    assert.match(refDoc.output, /Verify SQL/)

    // Traversal attack outside skill directory must fail.
    const traversal = await mgr.runLoadSkill(workspace, 'code-review', '../../../secret.txt')
    assert.equal(traversal.isError, true)

    // Disabling hides skill from prompt & blocks loading.
    await mgr.setEnabled('code-review', false, workspace)
    assert.doesNotMatch(await mgr.formatAvailableSkillsPrompt(workspace), /code-review/)
    const disabledLoad = await mgr.runLoadSkill(workspace, 'code-review')
    assert.equal(disabledLoad.isError, true)
    assert.match(disabledLoad.output, /disabled/)

    // Create & remove custom skill.
    const created = await mgr.create(
      { name: 'My Release Notes', description: 'Generate changelogs', content: '# Notes\nGroup by feature.', scope: 'user' },
      workspace,
    )
    assert.equal(created.name, 'my-release-notes')
    assert.equal(created.scope, 'user')
    const detail = await mgr.get('my-release-notes', workspace)
    assert.ok(detail)
    assert.match(detail.content, /Generate changelogs/)

    await mgr.remove('my-release-notes', workspace)
    assert.equal(await mgr.get('my-release-notes', workspace), null)

    // CRLF frontmatter parsing edge check.
    const crlf = parseSkillMarkdown('---\r\nname: win-skill\r\ndescription: "Windows CRLF"\r\n---\r\nBody text', 'fallback')
    assert.equal(crlf.name, 'win-skill')
    assert.equal(crlf.description, 'Windows CRLF')
  })
})

test('Plan mode strips mutating/MCP tools, blocks spoofed writes, forces explorer subagents, and tags message mode', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace }) => {
    await writeFile(join(workspace, 'app.ts'), 'export const v = 1\n')
    await mkdir(join(workspace, '.agents', 'skills', 'arch'), { recursive: true })
    await writeFile(join(workspace, '.agents', 'skills', 'arch', 'SKILL.md'), '---\nname: arch\ndescription: Architecture rules\n---\nAlways diagram modules.')

    let round = 0
    const { server, url, requests } = await mockChatServer(() => {
      round++
      if (round === 1) {
        // Model ignores schema and tries to mutate a file AND call worker subagent in Plan mode.
        return {
          toolCalls: [
            { id: 'c_edit', name: 'edit_file', args: JSON.stringify({ path: 'app.ts', old_string: '1', new_string: '2' }) },
            { id: 'c_mcp', name: 'mcp__gh__create_issue', args: '{}' },
            { id: 'c_sub', name: 'run_subagent', args: JSON.stringify({ role: 'worker', task: 'inspect app.ts' }) },
          ],
        }
      }
      if (round === 2) {
        // Child subagent turn: must have NO write tools and NO run_subagent.
        return { text: 'Inspected app.ts safely.' }
      }
      return { text: 'Here is the read-only implementation plan.' }
    })

    try {
      let agentMode: AgentMode = 'plan'
      let disabled: string[] = []
      const skills = new SkillsManager({
        appDir,
        homeDir,
        getDisabled: () => disabled,
        setDisabled: (n) => {
          disabled = n
        },
      })
      const settings = {
        activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl: url, model: 'gpt-5', hasKey: true }),
        providerKey: async () => 'k',
        get: () => ({ workspace, agentMode, webEnabled: true }),
      } as unknown as SettingsStore
      const mcp = {
        tools: () => [{ exposedName: 'mcp__gh__create_issue', serverId: 'gh', serverName: 'GitHub', tool: { name: 'create_issue', description: 'Create issue', inputSchema: {} } }],
        findTool: (n: string) => (n === 'mcp__gh__create_issue' ? { exposedName: n, serverId: 'gh', serverName: 'GitHub', tool: { name: 'create_issue', description: '', inputSchema: {} } } : undefined),
        callTool: async () => {
          throw new Error('MCP mutating tool must not execute in plan mode')
        },
      } as unknown as McpManager

      let approvalAsked = false
      const events: AgentEvent[] = []
      const loop = new AgentLoop({
        settings,
        mcp,
        skills,
        emit: (e) => {
          if (e.type === 'approval') approvalAsked = true
          events.push(e)
        },
        save: async () => undefined,
        systemPrompt,
      })

      const conv = makeConv(workspace)
      await loop.run(conv, 'Plan changes')

      assert.equal(approvalAsked, false)
      assert.equal(await readFile(join(workspace, 'app.ts'), 'utf8'), 'export const v = 1\n')

      // Check parent request exposed ONLY read-only tools + <plan_mode> + <available_skills>.
      const parentToolNames = (requests[0].tools as any[]).map((t) => t.function.name)
      assert.ok(parentToolNames.includes('read_file'))
      assert.ok(parentToolNames.includes('load_skill'))
      assert.ok(parentToolNames.includes('run_subagent'))
      assert.ok(!parentToolNames.includes('edit_file'))
      assert.ok(!parentToolNames.includes('write_file'))
      assert.ok(!parentToolNames.includes('apply_patch'))
      assert.ok(!parentToolNames.includes('run_command'))
      assert.ok(!parentToolNames.includes('mcp__gh__create_issue'))
      assert.match(requests[0].messages[0].content, /<plan_mode>/)
      assert.match(requests[0].messages[0].content, /<available_skills>/)

      // Verify child subagent ran in explorer mode (no worker tools, no recursion).
      const childToolNames = (requests[1].tools as any[]).map((t) => t.function.name)
      assert.ok(!childToolNames.includes('run_subagent'))
      assert.ok(!childToolNames.includes('edit_file'))
      assert.match(requests[1].messages[0].content, /Explorer subagent/)

      // Verify spoofed edit_file and mcp tool calls were rejected cleanly.
      const editToolMsg = conv.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c_edit')
      assert.ok(editToolMsg && editToolMsg.role === 'tool' && editToolMsg.isError)
      assert.match(editToolMsg.output, /Plan Mode/i)

      const mcpToolMsg = conv.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c_mcp')
      assert.ok(mcpToolMsg && mcpToolMsg.role === 'tool' && mcpToolMsg.isError)

      const subToolMsg = conv.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c_sub')
      assert.ok(subToolMsg && subToolMsg.role === 'tool' && !subToolMsg.isError)
      assert.match(subToolMsg.output, /\[Subagent \(explorer\)/)

      // Final assistant message preserves mode: 'plan' and switching back to auto restores write tools.
      const last = conv.messages.at(-1)
      assert.ok(last && last.role === 'assistant' && last.mode === 'plan')
      agentMode = 'auto'
      assert.equal(last.mode, 'plan')
    } finally {
      server.close()
    }
  })
})

test('AgentLoop runs explorer subagents concurrently, streams live child steps, isolates history, and supports worker CheckpointStore revert', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace }) => {
    await writeFile(join(workspace, 'note.txt'), 'before\n')

    let activeChildFetches = 0
    let maxParallelChildren = 0
    let parentCallCount = 0

    const { server, url } = await mockChatServer(async (reqBody) => {
      const sys = String(reqBody.messages?.[0]?.content ?? '')
      if (sys.includes('<subagent_role>')) {
        const userTask = String(reqBody.messages?.[1]?.content ?? '')
        if (sys.includes('Explorer subagent')) {
          // Parallel concurrency test: wait briefly and track overlap.
          activeChildFetches++
          maxParallelChildren = Math.max(maxParallelChildren, activeChildFetches)
          await new Promise((r) => setTimeout(r, 45))
          activeChildFetches--
          if (reqBody.messages.length === 2) {
            return { toolCalls: [{ id: 'sub_read', name: 'read_file', args: JSON.stringify({ path: 'note.txt' }) }] }
          }
          return { text: `Explorer finding for "${userTask}"` }
        }
        // Worker branch: edits workspace file via CheckpointStore.
        if (reqBody.messages.length === 2) {
          return {
            toolCalls: [
              { id: 'w_edit', name: 'edit_file', args: JSON.stringify({ path: 'note.txt', old_string: 'before', new_string: 'after' }) },
            ],
          }
        }
        return { text: 'Worker updated note.txt cleanly.' }
      }

      parentCallCount++
      if (parentCallCount === 1) {
        return {
          toolCalls: [
            { id: 'ex_1', name: 'run_subagent', args: JSON.stringify({ role: 'explorer', task: 'check A' }) },
            { id: 'ex_2', name: 'run_subagent', args: JSON.stringify({ role: 'explorer', task: 'check B' }) },
          ],
        }
      }
      if (parentCallCount === 2) {
        return {
          toolCalls: [{ id: 'wk_1', name: 'run_subagent', args: JSON.stringify({ role: 'worker', task: 'update note.txt' }) }],
        }
      }
      return { text: 'All subagents completed.' }
    })

    try {
      const checkpoints = new CheckpointStore(appDir)
      const skills = new SkillsManager({ appDir, homeDir, getDisabled: () => [], setDisabled: () => undefined })
      const settings = {
        activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl: url, model: 'gpt-5', hasKey: true }),
        providerKey: async () => 'k',
        get: () => ({ workspace, agentMode: 'manual', webEnabled: true }),
      } as unknown as SettingsStore
      const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager

      const liveSubUpdates: string[] = []
      let workerApprovalConvId = ''
      const loop = new AgentLoop({
        settings,
        mcp,
        checkpoints,
        skills,
        emit: (ev) => {
          if (ev.type === 'tool_status' && ev.output && ev.output.includes('subagent')) {
            liveSubUpdates.push(ev.output)
          }
          if (ev.type === 'approval') {
            workerApprovalConvId = ev.request.conversationId
            loop.approve(ev.request.approvalId, 'allow')
          }
        },
        save: async () => undefined,
        systemPrompt,
      })

      const conv = makeConv(workspace)
      await loop.run(conv, 'Research in parallel then apply edit')

      // Two explorer subagents actually executed in parallel!
      assert.equal(maxParallelChildren, 2)
      assert.ok(liveSubUpdates.some((s) => s.includes('Explorer subagent researching')))
      assert.ok(liveSubUpdates.some((s) => s.includes('read_file(note.txt)')))
      assert.equal(workerApprovalConvId, conv.id)
      assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'after\n')

      // Parent conversation history stays uncluttered (no child internal read/edit messages leaked).
      assert.ok(!conv.messages.some((m) => m.role === 'tool' && m.name === 'edit_file'))

      // CheckpointStore recorded worker file edit under parent conv.id and can revert cleanly!
      const cpEntries = await checkpoints.entries(conv.id, workspace)
      assert.equal(cpEntries.length, 1)
      await checkpoints.revertAll(conv.id, workspace)
      assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), 'before\n')
    } finally {
      server.close()
    }
  })
})

test('AgentLoop abort propagates from parent turn into running subagent immediately', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace }) => {
    let signalSeenAborted = false
    let childRequestStarted = false
    let stopParent: (() => void) | null = null
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const parsed = JSON.parse(raw)
        const sys = String(parsed.messages?.[0]?.content ?? '')
        if (!sys.includes('<subagent_role>')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: 0, id: 'sub_abort', type: 'function', function: { name: 'run_subagent', arguments: '{"role":"explorer","task":"slow"}' } }] },
                  finish_reason: 'tool_calls',
                },
              ],
            })}\n\n`,
          )
          res.end('data: [DONE]\n\n')
          return
        }
        // Hang child stream until aborted.
        childRequestStarted = true
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
        const markAborted = () => {
          signalSeenAborted = true
        }
        req.on('close', markAborted)
        res.on('close', markAborted)
        setTimeout(() => stopParent?.(), 10)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`

    try {
      const settings = {
        activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl: url, model: 'gpt-5', hasKey: true }),
        providerKey: async () => 'k',
        get: () => ({ workspace, agentMode: 'auto' }),
      } as unknown as SettingsStore
      const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
      const skills = new SkillsManager({ appDir, homeDir, getDisabled: () => [], setDisabled: () => undefined })

      let endReason = ''
      const loop = new AgentLoop({
        settings,
        mcp,
        skills,
        emit: (ev) => {
          if (ev.type === 'turn_end') endReason = ev.reason
        },
        save: async () => undefined,
        systemPrompt,
      })
      stopParent = () => loop.stop('conv_test')

      const conv = makeConv(workspace)
      await loop.run(conv, 'Abort me')
      assert.equal(childRequestStarted, true)
      assert.equal(endReason, 'aborted')
      const deadline = Date.now() + 1000
      while (!signalSeenAborted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 15))
      }
      assert.equal(signalSeenAborted, true)
    } finally {
      server.closeAllConnections?.()
      server.close()
    }
  })
})

test('OpenAI / DeepSeek adapter sends stream_options & dynamic thinking, parses empty-choices usage chunk + cache hit tokens, and falls back on 400', async () => {
  assert.equal(supportsDeepSeekThinking('https://api.deepseek.com', 'deepseek-chat'), true)
  assert.equal(supportsDeepSeekThinking('https://api.deepseek.com', 'deepseek-reasoner'), false)
  assert.equal(supportsDeepSeekThinking('https://api.openai.com/v1', 'gpt-4o'), false)

  const signal = new AbortController().signal
  const dsBodyRich = buildOpenAiBody(
    { baseUrl: 'https://api.deepseek.com', apiKey: 'k' },
    { model: 'deepseek-chat', system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], effort: 'high', signal },
    true,
  )
  assert.deepEqual(dsBodyRich.stream_options, { include_usage: true })
  assert.deepEqual(dsBodyRich.thinking, { type: 'enabled' })

  const dsBodyLow = buildOpenAiBody(
    { baseUrl: 'https://api.deepseek.com', apiKey: 'k' },
    { model: 'deepseek-chat', system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], effort: 'low', signal },
    true,
  )
  assert.equal(dsBodyLow.thinking, undefined)

  // Server 1: returns DeepSeek trailing usage chunk where choices === [].
  const { server, url, requests } = await mockChatServer(() => ({
    text: 'Pong!',
    usage: { prompt_tokens: 1500, completion_tokens: 220, prompt_cache_hit_tokens: 1024 },
  }))
  try {
    const result = await openAiAdapter.chat(
      { baseUrl: url, apiKey: 'k' },
      { model: 'deepseek-chat', system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], effort: 'medium', signal },
      { onText: () => undefined },
    )
    assert.deepEqual(requests[0].stream_options, { include_usage: true })
    assert.deepEqual(requests[0].thinking, { type: 'enabled' })
    assert.deepEqual(result.usage, { inputTokens: 1500, outputTokens: 220, cacheReadTokens: 1024 })
  } finally {
    server.close()
  }

  // Server 2: rejects `stream_options` / `thinking` with 400 once, caches host fallback cleanly.
  const seen: any[] = []
  const strictServer = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const parsed = JSON.parse(raw)
      seen.push(parsed)
      if (parsed.stream_options || parsed.thinking) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => strictServer.listen(0, '127.0.0.1', r))
  const strictUrl = `http://localhost:${(strictServer.address() as { port: number }).port}/v1`
  try {
    const r1 = await openAiAdapter.chat(
      { baseUrl: strictUrl, apiKey: 'k' },
      { model: 'deepseek-chat', system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [], effort: 'high', signal },
      { onText: () => undefined },
    )
    assert.equal(seen.length, 2)
    assert.equal(seen[1].stream_options, undefined)
    assert.equal(seen[1].thinking, undefined)
    assert.deepEqual(r1.usage, { inputTokens: 50, outputTokens: 5, cacheReadTokens: 20 })

    // Second request remembers host in plainFallbackHosts and skips straight to plain body.
    await openAiAdapter.chat(
      { baseUrl: strictUrl, apiKey: 'k' },
      { model: 'deepseek-chat', system: 'sys', messages: [{ role: 'user', text: 'hi2' }], tools: [], effort: 'high', signal },
      { onText: () => undefined },
    )
    assert.equal(seen.length, 3)
  } finally {
    strictServer.close()
  }
})

test('normalizeAgentMode, isDangerousShellCommand, and systemPrompt support 5 permission modes and work/code scenes', () => {
  assert.equal(normalizeAgentMode('agent'), 'auto')
  assert.equal(normalizeAgentMode('auto'), 'auto')
  assert.equal(normalizeAgentMode('manual'), 'manual')
  assert.equal(normalizeAgentMode('accept_edits'), 'accept_edits')
  assert.equal(normalizeAgentMode('plan'), 'plan')
  assert.equal(normalizeAgentMode('bypass'), 'bypass')
  assert.equal(normalizeAgentMode('unknown_mode', 'manual'), 'manual')
  assert.equal(normalizeAgentMode(undefined), 'auto')

  assert.equal(isDangerousShellCommand('rm -rf dist'), true)
  assert.equal(isDangerousShellCommand('Remove-Item -Recurse -Force build'), true)
  assert.equal(isDangerousShellCommand('git reset --hard HEAD~1'), true)
  assert.equal(isDangerousShellCommand('git push origin main --force'), true)
  assert.equal(isDangerousShellCommand('sudo apt update'), true)
  assert.equal(isDangerousShellCommand('echo hello'), false)
  assert.equal(isDangerousShellCommand('git status'), false)
  assert.equal(isDangerousShellCommand('npm test'), false)

  const workPrompt = systemPrompt('/tmp/ws', undefined, { mode: 'auto', workScene: 'work' })
  const codePrompt = systemPrompt('/tmp/ws', undefined, { mode: 'accept_edits', workScene: 'code' })
  assert.notEqual(workPrompt, codePrompt)
  assert.ok(workPrompt.length > 50 && codePrompt.length > 50)
})

test('AgentLoop enforces 5 permission modes (auto, accept_edits, manual, bypass) accurately on file edits and shell commands', async () => {
  await withTempDirs(async ({ appDir, homeDir, workspace }) => {
    await writeFile(join(workspace, 'target.txt'), 'init\n')

    const modesToTest: Array<{
      mode: AgentMode
      command: string
      expectedEditPrompts: number
      expectedCmdPrompts: number
      expectedDeny?: boolean
    }> = [
      { mode: 'auto', command: 'echo safe-auto', expectedEditPrompts: 0, expectedCmdPrompts: 0 },
      { mode: 'auto', command: 'rm -rf ./nonexistent-dir', expectedEditPrompts: 0, expectedCmdPrompts: 1, expectedDeny: true },
      { mode: 'accept_edits', command: 'echo safe-accept', expectedEditPrompts: 0, expectedCmdPrompts: 1 },
      { mode: 'manual', command: 'echo safe-manual', expectedEditPrompts: 1, expectedCmdPrompts: 1 },
      { mode: 'bypass', command: 'rm -rf ./nonexistent-dir', expectedEditPrompts: 0, expectedCmdPrompts: 0 },
    ]

    for (const scenario of modesToTest) {
      await writeFile(join(workspace, 'target.txt'), 'init\n')
      let step = 0
      const { server, url } = await mockChatServer(() => {
        step++
        if (step === 1) {
          return {
            toolCalls: [{ id: `e_${scenario.mode}`, name: 'edit_file', args: JSON.stringify({ path: 'target.txt', old_string: 'init', new_string: `updated-${scenario.mode}` }) }],
          }
        }
        if (step === 2) {
          return {
            toolCalls: [{ id: `c_${scenario.mode}`, name: 'run_command', args: JSON.stringify({ command: scenario.command }) }],
          }
        }
        return { text: `done:${scenario.mode}` }
      })

      try {
        const promptedTools: string[] = []
        const checkpoints = new CheckpointStore(appDir)
        const skills = new SkillsManager({ appDir, homeDir, getDisabled: () => [], setDisabled: () => undefined })
        const settings = {
          activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl: url, model: 'gpt-5', hasKey: true }),
          providerKey: async () => 'k',
          get: () => ({ workspace, agentMode: scenario.mode }),
        } as unknown as SettingsStore
        const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager

        const loop = new AgentLoop({
          settings,
          mcp,
          checkpoints,
          skills,
          emit: (ev) => {
            if (ev.type === 'approval') {
              promptedTools.push(ev.request.toolName)
              loop.approve(ev.request.approvalId, scenario.expectedDeny ? 'deny' : 'allow')
            }
          },
          save: async () => undefined,
          systemPrompt,
        })

        const conv = makeConv(workspace)
        conv.id = `conv_${scenario.mode}_${scenario.command.slice(0, 6)}`
        await loop.run(conv, `test ${scenario.mode}`)

        const editPrompts = promptedTools.filter((t) => t === 'edit_file').length
        const cmdPrompts = promptedTools.filter((t) => t === 'run_command').length
        assert.equal(editPrompts, scenario.expectedEditPrompts, `mode=${scenario.mode} cmd=${scenario.command} edit prompts`)
        assert.equal(cmdPrompts, scenario.expectedCmdPrompts, `mode=${scenario.mode} cmd=${scenario.command} cmd prompts`)

        if (scenario.expectedDeny) {
          const cmdToolMsg = conv.messages.find((m) => m.role === 'tool' && m.name === 'run_command')
          assert.ok(cmdToolMsg && cmdToolMsg.role === 'tool' && cmdToolMsg.isError)
        }
      } finally {
        server.close()
      }
    }
  })
})

test('CheckpointStore records per-turn snapshots and rewindToTurn restores files and prunes future turn records', async () => {
  await withTempDirs(async ({ appDir, workspace }) => {
    const checkpoints = new CheckpointStore(appDir)
    const convId = 'conv_rewind'
    const aPath = join(workspace, 'a.txt')
    const bPath = join(workspace, 'b.txt')

    // Turn 0 creates a.txt
    await writeFile(aPath, 'v1\n')
    const snap0 = [{ path: 'a.txt', beforeExists: false }]
    await checkpoints.record(convId, snap0)
    await checkpoints.recordTurn(convId, 0, snap0)

    // Turn 2 modifies a.txt and creates b.txt
    await writeFile(aPath, 'v2\n')
    const snap2a = [{ path: 'a.txt', beforeExists: true, beforeContent: 'v1\n' }]
    await checkpoints.record(convId, snap2a)
    await checkpoints.recordTurn(convId, 2, snap2a)

    await writeFile(bPath, 'new-b\n')
    const snap2b = [{ path: 'b.txt', beforeExists: false }]
    await checkpoints.record(convId, snap2b)
    await checkpoints.recordTurn(convId, 2, snap2b)

    const beforeEntries = await checkpoints.entries(convId, workspace)
    assert.equal(beforeEntries.length, 2)

    const revertedFiles = await checkpoints.rewindToTurn(convId, workspace, 2)
    assert.equal(revertedFiles.includes('a.txt'), true)
    assert.equal(revertedFiles.includes('b.txt'), true)
    assert.equal(await readFile(aPath, 'utf8'), 'v1\n')
    await assert.rejects(() => access(bPath))

    // Turn 0 checkpoint remains intact; Turn 2 records were pruned.
    const afterEntries = await checkpoints.entries(convId, workspace)
    assert.equal(afterEntries.length, 1)
    assert.equal(afterEntries[0]?.path, 'a.txt')
  })
})
