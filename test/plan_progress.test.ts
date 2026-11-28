// Unit & integration tests for native `update_plan` tool, Plan Mode allowlist, AgentLoop events, fork derivation, and prompt guidance.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { AgentEvent, AppSettings, Conversation, Message, ProviderConfig } from '../src/shared/types.ts'
import {
  derivePlanFromMessages,
  formatPlanToolOutput,
  getPlanStats,
  MAX_PLAN_STEPS,
  normalizePlanStatus,
  parsePlanInput,
  UPDATE_PLAN_TOOL_NAME,
} from '../src/shared/plan.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { ChatStore } from '../src/core/chats.ts'
import { orchestratorDirective } from '../src/core/orchestrator.ts'
import { systemPrompt } from '../src/core/prompt.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import type { SettingsStore } from '../src/core/settings.ts'

async function startMockOpenAi(
  t: { after: (fn: () => Promise<void> | void) => void },
  responder: (reqBody: any, index: number) => { text?: string; toolCalls?: Array<{ id?: string; name: string; args: string }> },
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
      const reply = responder(body, callIdx)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (reply.toolCalls?.length) {
        reply.toolCalls.forEach((tc, i) => {
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
        if (reply.text) send({ content: reply.text })
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

function makeLoop(provider: ProviderConfig, appSettings: AppSettings) {
  const settings = {
    activeProvider: () => provider,
    getProvider: (id: string) => (id === provider.id ? provider : undefined),
    listProviders: () => [provider],
    providerKey: async () => 'test-key',
    get: () => appSettings,
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined, resources: () => [] } as unknown as McpManager
  const events: AgentEvent[] = []
  let approvalsAsked = 0
  const loop = new AgentLoop({
    settings,
    mcp,
    enableAutoTitle: false,
    emit: (e) => {
      if (e.type === 'approval') approvalsAsked++
      events.push(e)
    },
    save: async () => undefined,
    systemPrompt,
  })
  return { loop, events, getApprovalsAsked: () => approvalsAsked }
}

test('plan helpers: normalizePlanStatus, parsePlanInput, getPlanStats & formatPlanToolOutput', () => {
  assert.equal(normalizePlanStatus('pending'), 'pending')
  assert.equal(normalizePlanStatus('COMPLETED'), 'done')
  assert.equal(normalizePlanStatus('in-progress'), 'in_progress')
  assert.equal(normalizePlanStatus('cancelled'), 'skipped')
  assert.equal(normalizePlanStatus('error'), 'failed')
  assert.equal(normalizePlanStatus('unknown_state'), null)

  const missingSteps = parsePlanInput({})
  assert.equal(missingSteps.ok, false)

  const badStatus = parsePlanInput({ steps: [{ title: 'Step 1', status: 'bogus' }] })
  assert.equal(badStatus.ok, false)

  const cleared = parsePlanInput({ steps: [] })
  assert.deepEqual(cleared, { ok: true, plan: null })

  const manySteps = Array.from({ length: 20 }, (_, i) => ({
    title: `  Task   ${i + 1} `,
    status: i === 0 ? 'completed' : i === 1 ? 'running' : 'todo',
  }))
  const parsed = parsePlanInput({ focus: '  Running   checks  ', explanation: 'Re-ordered steps', steps: manySteps }, 1234)
  assert.equal(parsed.ok, true)
  if (parsed.ok && parsed.plan) {
    assert.equal(parsed.plan.steps.length, MAX_PLAN_STEPS)
    assert.equal(parsed.plan.focus, 'Running checks')
    assert.equal(parsed.plan.explanation, 'Re-ordered steps')
    assert.equal(parsed.plan.updatedAt, 1234)
    const stats = getPlanStats(parsed.plan)
    assert.equal(stats.total, MAX_PLAN_STEPS)
    assert.equal(stats.done, 1)
    assert.equal(stats.inProgress, 1)
    assert.equal(stats.pending, MAX_PLAN_STEPS - 2)
    assert.equal(stats.activeStep?.title, 'Task 2')
    assert.equal(stats.isAllDone, false)
    const txt = formatPlanToolOutput(parsed.plan)
    assert.match(txt, /1\/15 done · Running checks/)
    assert.match(txt, /1\. \[done\] Task 1/)
  }
  assert.equal(formatPlanToolOutput(null), 'Plan cleared.')
})

test('derivePlanFromMessages: picks latest valid non-error plan and handles explicit clear', () => {
  const msgs: Message[] = [
    { role: 'user', text: 'do task' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 'tc_1',
          name: UPDATE_PLAN_TOOL_NAME,
          input: { steps: [{ title: 'Step A', status: 'done' }, { title: 'Step B', status: 'in_progress' }] },
        },
      ],
    },
    { role: 'tool', toolCallId: 'tc_1', name: UPDATE_PLAN_TOOL_NAME, output: 'ok', isError: false },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 'tc_2',
          name: UPDATE_PLAN_TOOL_NAME,
          input: { steps: [{ title: 'Bad Step', status: 'invalid_status' }] },
        },
      ],
    },
    { role: 'tool', toolCallId: 'tc_2', name: UPDATE_PLAN_TOOL_NAME, output: 'err', isError: true },
  ]
  const derived = derivePlanFromMessages(msgs)
  assert.ok(derived)
  assert.equal(derived.steps.length, 2)
  assert.equal(derived.steps[1]?.status, 'in_progress')

  const clearedMsgs: Message[] = [
    ...msgs,
    {
      role: 'assistant',
      text: '',
      toolCalls: [{ id: 'tc_3', name: UPDATE_PLAN_TOOL_NAME, input: { steps: [] } }],
    },
    { role: 'tool', toolCallId: 'tc_3', name: UPDATE_PLAN_TOOL_NAME, output: 'Plan cleared.', isError: false },
  ]
  assert.equal(derivePlanFromMessages(clearedMsgs), undefined)
})

test('AgentLoop executes update_plan in auto mode with live plan_update events & zero approval prompts', async (t) => {
  const { url, requests } = await startMockOpenAi(t, (_body, idx) => {
    if (idx === 0) {
      return {
        toolCalls: [
          {
            name: UPDATE_PLAN_TOOL_NAME,
            args: JSON.stringify({
              focus: 'Inspecting project files',
              steps: [
                { title: 'Read config', status: 'in_progress' },
                { title: 'Edit handler', status: 'pending' },
                { title: 'Verify build', status: 'pending' },
              ],
            }),
          },
        ],
      }
    }
    if (idx === 1) {
      return {
        toolCalls: [
          {
            name: UPDATE_PLAN_TOOL_NAME,
            args: JSON.stringify({
              focus: 'Completed',
              steps: [
                { title: 'Read config', status: 'done' },
                { title: 'Edit handler', status: 'done' },
                { title: 'Verify build', status: 'done' },
              ],
            }),
          },
        ],
      }
    }
    return { text: 'All 3 steps completed.' }
  })

  const provider: ProviderConfig = {
    id: 'p_mock',
    name: 'Mock',
    protocol: 'openai',
    baseUrl: url,
    model: 'mock-model',
    hasKey: true,
  }
  const appSettings: AppSettings = {
    locale: 'en',
    theme: 'light',
    onboarded: true,
    proxyMode: 'none',
    activeProviderId: provider.id,
    agentMode: 'auto',
    recentWorkspaces: [],
  }
  const { loop, events, getApprovalsAsked } = makeLoop(provider, appSettings)
  const conv: Conversation = {
    id: 'chat_plan_auto',
    title: 'Plan Auto',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }

  await loop.run(conv, 'Implement multi-step feature')
  const turnEnd = events.find((e): e is Extract<AgentEvent, { type: 'turn_end' }> => e.type === 'turn_end')
  assert.equal(turnEnd?.reason, 'done')
  assert.equal(getApprovalsAsked(), 0)
  const sentTools = (requests[0]?.tools ?? []).map((x: any) => x.function?.name)
  assert.ok(sentTools.includes(UPDATE_PLAN_TOOL_NAME))

  const planUpdates = events.filter((e): e is Extract<AgentEvent, { type: 'plan_update' }> => e.type === 'plan_update')
  assert.equal(planUpdates.length, 2)
  assert.equal(planUpdates[0]?.plan?.steps[0]?.status, 'in_progress')
  assert.equal(planUpdates[1]?.plan?.steps[2]?.status, 'done')
  assert.ok(conv.plan)
  assert.equal(getPlanStats(conv.plan).done, 3)
})

test('AgentLoop allows update_plan inside read-only plan mode without blocking', async (t) => {
  const { url, requests } = await startMockOpenAi(t, (_body, idx) => {
    if (idx === 0) {
      return {
        toolCalls: [
          {
            name: UPDATE_PLAN_TOOL_NAME,
            args: JSON.stringify({
              focus: 'Drafting architecture plan',
              steps: [
                { title: 'Map API routes', status: 'done' },
                { title: 'Design schema', status: 'in_progress' },
                { title: 'Write migration plan', status: 'pending' },
              ],
            }),
          },
        ],
      }
    }
    return { text: 'Plan ready for review.' }
  })

  const provider: ProviderConfig = {
    id: 'p_mock_plan',
    name: 'Mock',
    protocol: 'openai',
    baseUrl: url,
    model: 'mock-model',
    hasKey: true,
  }
  const appSettings: AppSettings = {
    locale: 'en',
    theme: 'light',
    onboarded: true,
    proxyMode: 'none',
    activeProviderId: provider.id,
    agentMode: 'plan',
    recentWorkspaces: [],
  }
  const { loop, events, getApprovalsAsked } = makeLoop(provider, appSettings)
  const conv: Conversation = {
    id: 'chat_plan_mode',
    title: 'Plan Readonly',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }

  await loop.run(conv, 'Plan refactor')
  const turnEnd = events.find((e): e is Extract<AgentEvent, { type: 'turn_end' }> => e.type === 'turn_end')
  assert.equal(turnEnd?.reason, 'done')
  assert.equal(getApprovalsAsked(), 0)
  const sentTools = (requests[0]?.tools ?? []).map((x: any) => x.function?.name)
  assert.ok(sentTools.includes(UPDATE_PLAN_TOOL_NAME))
  assert.equal(conv.plan?.focus, 'Drafting architecture plan')
  const toolResult = conv.messages.find((m) => m.role === 'tool')
  assert.ok(toolResult && toolResult.role === 'tool')
  assert.equal(toolResult.isError, false)
})

test('systemPrompt & orchestratorDirective document update_plan and ChatStore.fork derives sliced plan', async (t) => {
  const prompt = systemPrompt(undefined)
  assert.match(prompt, /update_plan/)
  assert.match(
    orchestratorDirective({
      phase: 'execute',
      plannerModel: 'opus',
      executorModel: 'sonnet',
      handoffCount: 0,
      maxHandoffs: 3,
      execMode: 'auto',
    }),
    /update_plan/,
  )

  const dir = await mkdtemp(join(tmpdir(), 'atrium-plan-fork-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const chats = new ChatStore(dir)
  await chats.load()
  const conv = await chats.create()
  conv.messages = [
    { role: 'user', text: 'step 1' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 'tc_early',
          name: UPDATE_PLAN_TOOL_NAME,
          input: { steps: [{ title: 'Step 1', status: 'in_progress' }, { title: 'Step 2', status: 'pending' }] },
        },
      ],
    },
    { role: 'tool', toolCallId: 'tc_early', name: UPDATE_PLAN_TOOL_NAME, output: 'ok', isError: false },
    { role: 'assistant', text: 'First checkpoint', toolCalls: [] },
    { role: 'user', text: 'finish' },
    {
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          id: 'tc_final',
          name: UPDATE_PLAN_TOOL_NAME,
          input: { steps: [{ title: 'Step 1', status: 'done' }, { title: 'Step 2', status: 'done' }] },
        },
      ],
    },
    { role: 'tool', toolCallId: 'tc_final', name: UPDATE_PLAN_TOOL_NAME, output: 'ok', isError: false },
    { role: 'assistant', text: 'Done!', toolCalls: [] },
  ]
  await chats.save(conv)

  // Fork right after first checkpoint (index 3) -> should carry early 0/2 plan, not final 2/2 plan!
  const forked = await chats.fork(conv.id, 3)
  assert.ok(forked.plan)
  assert.equal(getPlanStats(forked.plan).done, 0)
  assert.equal(forked.plan.steps[0]?.status, 'in_progress')
})

test('AgentLoop.regenerate recomputes/clears stale plan from trimmed turns', async (t) => {
  const { url } = await startMockOpenAi(t, () => ({ text: 'Clean direct answer without update_plan.' }))
  const provider: ProviderConfig = {
    id: 'p_regen',
    name: 'Mock',
    protocol: 'openai',
    baseUrl: url,
    model: 'mock-model',
    hasKey: true,
  }
  const appSettings: AppSettings = {
    locale: 'en',
    theme: 'light',
    onboarded: true,
    proxyMode: 'none',
    activeProviderId: provider.id,
    agentMode: 'auto',
    recentWorkspaces: [],
  }
  const { loop, events } = makeLoop(provider, appSettings)
  const conv: Conversation = {
    id: 'chat_regen_plan',
    title: 'Regen Plan',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plan: {
      focus: 'Stale reply plan',
      updatedAt: 100,
      steps: [
        { title: 'Old step 1', status: 'done' },
        { title: 'Old step 2', status: 'in_progress' },
      ],
    },
    messages: [
      { role: 'user', text: 'Answer directly please' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            id: 'tc_stale',
            name: UPDATE_PLAN_TOOL_NAME,
            input: {
              focus: 'Stale reply plan',
              steps: [
                { title: 'Old step 1', status: 'done' },
                { title: 'Old step 2', status: 'in_progress' },
              ],
            },
          },
        ],
      },
      { role: 'tool', toolCallId: 'tc_stale', name: UPDATE_PLAN_TOOL_NAME, output: 'ok', isError: false },
      { role: 'assistant', text: 'Old reply', toolCalls: [] },
    ],
  }

  await loop.regenerate(conv)
  assert.equal(conv.plan, undefined)
  const syncEvent = events.find((e) => e.type === 'conversation_sync')
  assert.ok(syncEvent && syncEvent.type === 'conversation_sync')
  assert.equal(syncEvent.conversation.plan, undefined)
})
