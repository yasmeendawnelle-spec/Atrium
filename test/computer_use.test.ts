import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../src/core/agent.ts'
import { McpManager } from '../src/core/mcp/manager.ts'
import { systemPrompt } from '../src/core/prompt.ts'
import { toAnthropicMessages } from '../src/core/providers/anthropic.ts'
import { toOpenAiMessages } from '../src/core/providers/openai.ts'
import { toResponsesInput } from '../src/core/providers/responses.ts'
import { retainRecentToolImages } from '../src/core/providers/types.ts'
import { bindSecrets } from '../src/core/secrets.ts'
import { SettingsStore } from '../src/core/settings.ts'
import { runBrowserTool, type BrowserHostBridge } from '../src/core/tools/browser_tools.ts'
import {
  describeComputerAction,
  formatDesktopSnapshotText,
  runComputerTool,
  type ComputerHostBridge,
} from '../src/core/tools/computer_tools.ts'
import { resolveKeyChord, resolveVirtualKey } from '../src/main/desktopDriver.ts'
import {
  computeScreenshotDimensions,
  mapDipPointToScreenshot,
  mapDipRectToScreenshot,
  mapScreenshotPointToDip,
} from '../src/shared/desktopGeometry.ts'
import type {
  AgentEvent,
  BrowserActionInput,
  BrowserSnapshot,
  ComputerUseHudState,
  Conversation,
  DesktopSnapshot,
  ImageAttachment,
  Message,
} from '../src/shared/types.ts'

const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='

function makeShot(id: string): ImageAttachment {
  return { id, name: `${id}.jpg`, mimeType: 'image/jpeg', dataUrl: TINY_JPEG }
}

function makeDesktopSnap(overrides?: Partial<DesktopSnapshot>): DesktopSnapshot {
  return {
    displayIndex: 0,
    displays: [
      {
        index: 0,
        id: 'disp-0',
        primary: true,
        bounds: { x: 0, y: 0, width: 1536, height: 864 },
        scaleFactor: 1.25,
        shotWidth: 1280,
        shotHeight: 720,
      },
    ],
    shotWidth: 1280,
    shotHeight: 720,
    cursor: { x: 420, y: 180, inDisplay: true },
    windows: [
      {
        hwnd: '10101',
        title: 'Untitled - Notepad',
        processName: 'notepad',
        pid: 4242,
        x: 100,
        y: 60,
        width: 720,
        height: 480,
        minimized: false,
        maximized: false,
        foreground: true,
      },
    ],
    screenshotDataUrl: TINY_JPEG,
    ...overrides,
  }
}

test('desktopGeometry scales displays cleanly and round-trips HiDPI and negative secondary monitor coords', () => {
  assert.deepEqual(computeScreenshotDimensions(2560, 1600, 1280), { width: 1280, height: 800 })
  assert.deepEqual(computeScreenshotDimensions(1920, 1080, 1280), { width: 1280, height: 720 })
  assert.deepEqual(computeScreenshotDimensions(1024, 768, 1280), { width: 1024, height: 768 })

  const secondaryMeta = {
    bounds: { x: -1536, y: 0, width: 1536, height: 864 },
    shotWidth: 1280,
    shotHeight: 720,
  }
  const dip = mapScreenshotPointToDip(640, 360, secondaryMeta)
  assert.equal(dip.x, -767)
  assert.equal(dip.y, 433)

  const back = mapDipPointToScreenshot(dip.x, dip.y, secondaryMeta)
  assert.equal(back.inDisplay, true)
  assert.equal(back.x, 640)
  assert.equal(back.y, 360)

  const clamped = mapScreenshotPointToDip(-99, 9999, secondaryMeta)
  assert.ok(clamped.x >= -1536 && clamped.x < 0)
  assert.ok(clamped.y >= 0 && clamped.y <= 864)

  const rect = mapDipRectToScreenshot(
    { x: -1536 + 768, y: 432, width: 384, height: 216 },
    secondaryMeta,
  )
  assert.deepEqual(rect, { x: 640, y: 360, width: 320, height: 180 })
})

test('desktopDriver resolves virtual keys, extended flags, and hotkey chords cleanly', () => {
  assert.equal(resolveVirtualKey('Enter')?.vk, 0x0d)
  assert.equal(resolveVirtualKey('F12')?.vk, 0x7b)
  assert.equal(resolveVirtualKey('Delete')?.extended, true)
  assert.equal(resolveVirtualKey('ArrowDown')?.vk, 0x28)
  assert.equal(resolveVirtualKey('ArrowDown')?.extended, true)

  const chord = resolveKeyChord(['ctrl', 'shift', 's'])
  assert.deepEqual(
    chord.map((c) => c.vk),
    [0x11, 0x10, 0x53],
  )
  const combined = resolveKeyChord(['win+r'])
  assert.deepEqual(
    combined.map((c) => ({ vk: c.vk, ext: c.extended })),
    [
      { vk: 0x5b, ext: true },
      { vk: 0x52, ext: false },
    ],
  )
  assert.throws(() => resolveKeyChord(['unknown_weird_key']), /Unsupported key/)
})

test('runComputerTool and runBrowserTool attach visual screenshots and support coordinate click & scroll', async () => {
  const seenCalls: string[] = []
  const computerBridge: ComputerHostBridge = {
    screenshot: async () => {
      seenCalls.push('screenshot')
      return makeDesktopSnap()
    },
    mouse: async (input) => {
      seenCalls.push(`mouse:${input.action}:${input.x},${input.y}`)
      return makeDesktopSnap({ cursor: { x: input.x, y: input.y, inDisplay: true } })
    },
    keyboard: async (input) => {
      seenCalls.push(`keyboard:${input.action}:${input.text ?? input.key ?? input.keys?.join('+')}`)
      return makeDesktopSnap()
    },
    window: async (input) => {
      seenCalls.push(`window:${input.action}`)
      return makeDesktopSnap({ screenshotDataUrl: input.action === 'list' ? undefined : TINY_JPEG })
    },
    wait: async () => {
      seenCalls.push('wait')
      return makeDesktopSnap()
    },
    setHud: async () => undefined,
  }

  const shotRes = await runComputerTool(computerBridge, 'desktop_screenshot', {})
  assert.equal(shotRes.isError, false)
  assert.equal(shotRes.images?.length, 1)
  assert.match(shotRes.output, /1280x720/)
  assert.match(shotRes.output, /Untitled - Notepad/)

  const mouseRes = await runComputerTool(computerBridge, 'desktop_mouse', { action: 'click', x: 512, y: 310 })
  assert.equal(mouseRes.isError, false)
  assert.equal(mouseRes.images?.length, 1)
  assert.equal(seenCalls.includes('mouse:click:512,310'), true)

  const kbRes = await runComputerTool(computerBridge, 'desktop_keyboard', { action: 'hotkey', keys: ['ctrl', 's'] })
  assert.equal(kbRes.isError, false)
  assert.equal(seenCalls.includes('keyboard:hotkey:ctrl+s'), true)
  assert.match(describeComputerAction('desktop_keyboard', { action: 'hotkey', keys: ['ctrl', 's'] }), /Hotkey ctrl\+s/)
  assert.match(formatDesktopSnapshotText(makeDesktopSnap()), /\[ACTIVE\]/)

  const badMouse = await runComputerTool(computerBridge, 'desktop_mouse', { action: 'fly', x: 1, y: 1 })
  assert.equal(badMouse.isError, true)

  const browserActions: BrowserActionInput[] = []
  const browserSnap = (overrides?: Partial<BrowserSnapshot>): BrowserSnapshot => ({
    open: true,
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    screenshotDataUrl: TINY_JPEG,
    screenshotWidth: 800,
    screenshotHeight: 600,
    elements: [],
    consoleLogs: [],
    ...overrides,
  })
  const browserBridge: BrowserHostBridge = {
    open: async () => browserSnap(),
    action: async (act) => {
      browserActions.push(act)
      return browserSnap()
    },
    capture: async () => browserSnap(),
    evalScript: async () => ({ value: 'ok' }),
    state: async () => browserSnap(),
  }

  const clickPt = await runBrowserTool(browserBridge, 'browser_click', { x: 400, y: 300 })
  assert.equal(clickPt.isError, false)
  assert.equal(clickPt.images?.length, 1)
  assert.equal(browserActions[0]?.kind, 'clickPoint')
  assert.equal(browserActions[0]?.xRatio, 0.5)
  assert.equal(browserActions[0]?.yRatio, 0.5)

  const scrollRes = await runBrowserTool(browserBridge, 'browser_scroll', { deltaY: -240 })
  assert.equal(scrollRes.isError, false)
  assert.equal(scrollRes.images?.length, 1)
  assert.equal(browserActions[1]?.kind, 'scroll')
  assert.equal(browserActions[1]?.deltaY, -240)
})

test('provider serializers attach recent tool screenshots cleanly and cap retained frames', () => {
  const messages: Message[] = [
    { role: 'user', text: 'Inspect desktop', images: [makeShot('u1')] },
    { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'desktop_screenshot', input: {} }] },
    { role: 'tool', toolCallId: 't1', name: 'desktop_screenshot', output: 'frame 1', isError: false, images: [makeShot('f1')] },
    { role: 'assistant', text: '', toolCalls: [{ id: 't2', name: 'desktop_mouse', input: { action: 'click', x: 10, y: 10 } }] },
    { role: 'tool', toolCallId: 't2', name: 'desktop_mouse', output: 'frame 2', isError: false, images: [makeShot('f2')] },
    { role: 'assistant', text: '', toolCalls: [{ id: 't3', name: 'desktop_mouse', input: { action: 'click', x: 20, y: 20 } }] },
    { role: 'tool', toolCallId: 't3', name: 'desktop_mouse', output: 'frame 3', isError: false, images: [makeShot('f3')] },
    { role: 'assistant', text: '', toolCalls: [{ id: 't4', name: 'desktop_mouse', input: { action: 'click', x: 30, y: 30 } }] },
    { role: 'tool', toolCallId: 't4', name: 'desktop_mouse', output: 'frame 4', isError: false, images: [makeShot('f4')] },
  ]

  const retained = retainRecentToolImages(messages, 2)
  assert.equal((retained[2] as Extract<Message, { role: 'tool' }>).images, undefined)
  assert.equal((retained[4] as Extract<Message, { role: 'tool' }>).images, undefined)
  assert.equal((retained[6] as Extract<Message, { role: 'tool' }>).images?.length, 1)
  assert.equal((retained[8] as Extract<Message, { role: 'tool' }>).images?.length, 1)
  assert.equal((retained[0] as Extract<Message, { role: 'user' }>).images?.length, 1)

  const anthropicWire = toAnthropicMessages(messages)
  const latestToolUser = anthropicWire[anthropicWire.length - 1]!
  const lastBlock = latestToolUser.content[latestToolUser.content.length - 1] as { type: string; content: unknown[] }
  assert.equal(lastBlock.type, 'tool_result')
  assert.equal(Array.isArray(lastBlock.content), true)
  assert.equal(lastBlock.content.some((b) => (b as { type: string }).type === 'image'), true)

  const openAiWire = toOpenAiMessages('sys', messages)
  assert.equal(openAiWire[openAiWire.length - 2]?.role, 'tool')
  assert.equal(openAiWire[openAiWire.length - 1]?.role, 'user')
  assert.ok(Array.isArray((openAiWire[openAiWire.length - 1] as { content: unknown }).content))

  const responsesWire = toResponsesInput(messages)
  const lastResp = responsesWire[responsesWire.length - 1] as { type?: string; role?: string; content?: Array<{ type: string }> }
  assert.equal(lastResp.type, 'message')
  assert.equal(lastResp.role, 'user')
  assert.equal(lastResp.content?.some((p) => p.type === 'input_image'), true)
})

test('AgentLoop gates desktop_* via computer approval, updates HUD, streams tool screenshots, and respects settings/plan mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-cu-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  const secretMap = new Map<string, string>()
  bindSecrets(async (method, ...args) => {
    const [key, val] = args
    if (method === 'secrets.get') return (secretMap.get(String(key)) ?? null) as never
    if (method === 'secrets.set') {
      if (val === null) secretMap.delete(String(key))
      else secretMap.set(String(key), String(val))
    }
    return undefined as never
  })

  const capturedRequests: Array<{ tools?: Array<{ function: { name: string } }>; messages?: unknown[] }> = []
  let turnIdx = 0
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tools?: Array<{ function: { name: string } }>
      messages?: unknown[]
    }
    capturedRequests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    turnIdx++
    if (turnIdx === 1) {
      res.end(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_cu_1', type: 'function', function: { name: 'desktop_screenshot', arguments: '{}' } }],
              },
            },
          ],
        })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    if (turnIdx === 2) {
      res.end(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_cu_2',
                    type: 'function',
                    function: { name: 'desktop_mouse', arguments: '{"action":"click","x":400,"y":250}' },
                  },
                ],
              },
            },
          ],
        })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Done clicking on the desktop window.' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => {
    srv.closeAllConnections?.()
    srv.close()
  })
  const addr = srv.address() as { port: number }

  const settings = new SettingsStore(dir)
  await settings.load()
  await settings.update({ agentMode: 'auto', computerUseEnabled: true, webEnabled: false })
  await settings.saveProvider({
    name: 'MockVision',
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    model: 'gpt-4o',
    apiKey: 'test-key',
  })

  const hudStates: ComputerUseHudState[] = []
  const computerBridge: ComputerHostBridge = {
    screenshot: async () => makeDesktopSnap(),
    mouse: async (input) => makeDesktopSnap({ cursor: { x: input.x, y: input.y, inDisplay: true } }),
    keyboard: async () => makeDesktopSnap(),
    window: async () => makeDesktopSnap(),
    wait: async () => makeDesktopSnap(),
    setHud: async (s) => {
      hudStates.push(s)
    },
  }

  const events: AgentEvent[] = []
  let approvalCount = 0
  const loop = new AgentLoop({
    settings,
    mcp: new McpManager(dir, () => undefined),
    computer: computerBridge,
    emit: (ev) => {
      events.push(ev)
      if (ev.type === 'approval') {
        approvalCount++
        assert.equal(ev.request.kind, 'computer')
        assert.equal(ev.request.serverName, 'Computer Use')
        assert.equal(ev.request.alwaysRuleLabel, 'Computer Use')
        loop.approve(ev.request.approvalId, 'allow_always')
      }
    },
    save: async () => undefined,
    systemPrompt,
  })

  const conv: Conversation = {
    id: 'cu-chat-1',
    title: 'Desktop Test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspace: dir,
    messages: [],
  }
  await loop.run(conv, 'Click on the desktop window')

  // First call prompts approval even in Auto mode; choosing allow_always persists tool:computer
  // so second call (desktop_mouse) runs cleanly without re-prompting.
  assert.equal(approvalCount, 1)
  assert.deepEqual(settings.allowedRulesFor(dir), ['tool:computer'])
  assert.ok(hudStates.some((h) => h.active === true))
  assert.equal(hudStates[hudStates.length - 1]?.active, false)

  const toolMsgs = conv.messages.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool')
  assert.equal(toolMsgs.length, 2)
  assert.equal(toolMsgs[0]?.images?.length, 1)
  assert.equal(toolMsgs[1]?.images?.length, 1)
  assert.ok(events.some((e) => e.type === 'tool_status' && e.status === 'done' && Boolean(e.images?.length)))

  // Second request payload sent to the OpenAI model contains the desktop screenshot image!
  const secondReqJson = JSON.stringify(capturedRequests[1]?.messages ?? [])
  assert.match(secondReqJson, /image_url/)

  // Verify disabling computerUseEnabled omits desktop_* tools cleanly.
  await settings.update({ computerUseEnabled: false })
  await loop.run(conv, 'Another turn')
  const latestToolNames = (capturedRequests[capturedRequests.length - 1]?.tools ?? []).map((x) => x.function.name)
  assert.equal(latestToolNames.some((n) => n.startsWith('desktop_')), false)

  // Verify stopAll() clears HUD cleanly.
  loop.stopAll()
  assert.equal(hudStates[hudStates.length - 1]?.active, false)
})

test('Built-in Browser Computer Use takes priority by default, tracks Atrium virtual cursor, isolates per-conversation sessions, and allows explicit OS desktop opt-in', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-browser-cu-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  const secretMap = new Map<string, string>()
  bindSecrets(async (method, ...args) => {
    const [key, val] = args
    if (method === 'secrets.get') return (secretMap.get(String(key)) ?? null) as never
    if (method === 'secrets.set') {
      if (val === null) secretMap.delete(String(key))
      else secretMap.set(String(key), String(val))
    }
    return undefined as never
  })

  const capturedRequests: Array<{ tools?: Array<{ function: { name: string } }> }> = []
  let reqCount = 0
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tools?: Array<{ function: { name: string } }>
    }
    capturedRequests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    reqCount++
    if (reqCount === 1) {
      res.end(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_b_open',
                    type: 'function',
                    function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' },
                  },
                ],
              },
            },
          ],
        })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    if (reqCount === 2) {
      res.end(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_b_mouse',
                    type: 'function',
                    function: { name: 'browser_mouse', arguments: '{"action":"move","x":400,"y":150}' },
                  },
                ],
              },
            },
          ],
        })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      )
      return
    }
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Completed in per-chat built-in browser.' } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    )
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => {
    srv.closeAllConnections?.()
    srv.close()
  })
  const addr = srv.address() as { port: number }

  const settings = new SettingsStore(dir)
  await settings.load()
  // Defaults should prioritize built-in browser with direct OS desktop control disabled
  assert.equal(settings.get().computerUseEnabled, true)
  assert.equal(settings.get().computerUseMode, 'browser')
  assert.equal(settings.get().desktopControlEnabled, false)

  await settings.saveProvider({
    name: 'MockVision',
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    model: 'gpt-4o',
    apiKey: 'test-key',
  })

  const browserCalls: Array<{ op: string; cid?: string; act?: BrowserActionInput }> = []
  let osDesktopCalls = 0
  const makeSnap = (cid?: string, cursor?: BrowserSnapshot['cursor']): BrowserSnapshot => ({
    ...(cid ? { conversationId: cid } : {}),
    open: true,
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    screenshotDataUrl: TINY_JPEG,
    screenshotWidth: 800,
    screenshotHeight: 600,
    ...(cursor ? { cursor } : {}),
    elements: [],
    consoleLogs: [],
  })

  const browserBridge: BrowserHostBridge = {
    open: async (_url, cid) => {
      browserCalls.push({ op: 'open', cid })
      return makeSnap(cid)
    },
    action: async (act, cid) => {
      browserCalls.push({ op: 'action', cid, act })
      return makeSnap(cid, {
        x: Math.round((act.xRatio ?? 0.5) * 800),
        y: Math.round((act.yRatio ?? 0.25) * 600),
        xRatio: act.xRatio ?? 0.5,
        yRatio: act.yRatio ?? 0.25,
        action: act.kind === 'movePoint' ? 'hover' : 'click',
        targetLabel: act.key,
        updatedAt: Date.now(),
      })
    },
    capture: async (cid) => {
      browserCalls.push({ op: 'capture', cid })
      return makeSnap(cid)
    },
    evalScript: async (_s, cid) => ({ value: `ok:${cid}` }),
    state: async (cid) => makeSnap(cid),
  }
  const computerBridge: ComputerHostBridge = {
    screenshot: async () => {
      osDesktopCalls++
      return makeDesktopSnap()
    },
    mouse: async () => {
      osDesktopCalls++
      return makeDesktopSnap()
    },
    keyboard: async () => {
      osDesktopCalls++
      return makeDesktopSnap()
    },
    window: async () => {
      osDesktopCalls++
      return makeDesktopSnap()
    },
    wait: async () => {
      osDesktopCalls++
      return makeDesktopSnap()
    },
    setHud: async () => undefined,
  }

  // Test standalone runBrowserTool virtual cursor & key helpers
  const moveRes = await runBrowserTool(browserBridge, 'browser_mouse', { action: 'move', x: 200, y: 150 }, { conversationId: 'chat-a' })
  assert.equal(moveRes.isError, false)
  assert.match(moveRes.output, /Atrium Cursor: \(200, 150\) \[hover\]/)

  const keyRes = await runBrowserTool(browserBridge, 'browser_key', { key: 'Enter' }, { conversationId: 'chat-a' })
  assert.equal(keyRes.isError, false)
  assert.match(keyRes.output, /Enter/)

  const loop = new AgentLoop({
    settings,
    mcp: new McpManager(dir, () => undefined),
    browser: browserBridge,
    computer: computerBridge,
    emit: () => undefined,
    save: async () => undefined,
    systemPrompt,
  })

  const convB: Conversation = {
    id: 'chat-browser-b',
    title: 'Browser Session B',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    workspace: dir,
    messages: [],
  }
  await loop.run(convB, 'Open example.com and move cursor')

  // Default mode exposes browser_* tools and hides desktop_* tools when browser bridge is active
  const defaultTools = (capturedRequests[0]?.tools ?? []).map((x) => x.function.name)
  assert.equal(defaultTools.includes('browser_open'), true)
  assert.equal(defaultTools.includes('browser_mouse'), true)
  assert.equal(defaultTools.includes('browser_key'), true)
  assert.equal(defaultTools.some((n) => n.startsWith('desktop_')), false)
  assert.equal(osDesktopCalls, 0)

  // Every browser call is tagged with the active conversationId for strict session isolation
  const bCalls = browserCalls.filter((c) => c.cid === 'chat-browser-b')
  assert.equal(bCalls.some((c) => c.op === 'open'), true)
  assert.equal(bCalls.some((c) => c.op === 'action' && c.act?.kind === 'movePoint' && c.act.conversationId === 'chat-browser-b'), true)

  // Enabling Direct OS Desktop Control restores desktop_* alongside browser_*
  await settings.update({ desktopControlEnabled: true })
  assert.equal(settings.get().computerUseMode, 'desktop')
  await loop.run(convB, 'Check available tools with desktop control opted in')
  const hybridTools = (capturedRequests[capturedRequests.length - 1]?.tools ?? []).map((x) => x.function.name)
  assert.equal(hybridTools.includes('browser_mouse'), true)
  assert.equal(hybridTools.includes('desktop_screenshot'), true)
  assert.equal(hybridTools.includes('desktop_mouse'), true)
})
