import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import type { AgentEvent, Conversation, TerminalEvent } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { AutomationManager, nextCronRun, parseCronExpr, previewCronRuns } from '../src/core/automations.ts'
import { ChatStore } from '../src/core/chats.ts'
import { McpManager } from '../src/core/mcp/manager.ts'
import { bindSecrets } from '../src/core/secrets.ts'
import { SettingsStore } from '../src/core/settings.ts'
import { TerminalManager } from '../src/core/terminal.ts'
import { runReadBackground, runStartBackground, runStopBackground } from '../src/core/tools/terminal_tools.ts'
import { extractConversationArtifacts, splitMessageSegments, suggestedFilename } from '../src/renderer/src/lib/artifacts.ts'
import { buildReactArtifactHtml } from '../src/renderer/src/lib/reactArtifactHost.ts'

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('Timed out waiting for condition.')
}

// ---- P1-1: TerminalManager & background process tools ----

test('TerminalManager spawns interactive shell, streams output, handles clear, and stops cleanly', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-term-'))
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  const events: TerminalEvent[] = []
  const tm = new TerminalManager({
    emit: (e) => events.push(e),
    getDefaultWorkspace: () => ws,
  })
  t.after(() => tm.shutdown())

  const sess = tm.create({ workspace: ws, title: 'Workspace Shell' })
  assert.equal(sess.status, 'running')
  assert.ok(tm.list().some((s) => s.id === sess.id))

  tm.write(sess.id, 'echo ATRIUM_P1_TERM_OK\r')
  await waitFor(() => tm.read(sess.id).output.includes('ATRIUM_P1_TERM_OK'))

  tm.clear(sess.id)
  assert.equal(tm.read(sess.id).output.includes('ATRIUM_P1_TERM_OK'), false)

  tm.close(sess.id)
  assert.equal(tm.list().length, 0)
  assert.ok(events.some((e) => e.type === 'closed' && e.id === sess.id))
})

test('Background process tools start, monitor, and terminate persistent Node commands cleanly', { timeout: 20_000 }, async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-bg-'))
  t.after(() => rm(ws, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  const tm = new TerminalManager({
    emit: () => undefined,
    getDefaultWorkspace: () => ws,
  })
  t.after(() => tm.shutdown())

  const started = await runStartBackground(
    tm,
    ws,
    {
      command: 'node -e "let i=0; console.log(\'BG_READY\'); setInterval(()=>console.log(\'TICK_\'+(++i)), 120)"',
      title: 'Ticker',
      waitMs: 500,
    },
    new AbortController().signal,
  )
  assert.equal(started.isError, false)
  assert.match(started.output, /sessionId:\s*(term_[^\s,]+)/)
  assert.match(started.output, /BG_READY/)

  const match = /sessionId:\s*(term_[^\s,)]+)/.exec(started.output)
  assert.ok(match)
  const sessionId = match[1]!

  await new Promise((r) => setTimeout(r, 280))
  const log = runReadBackground(tm, { sessionId })
  assert.equal(log.isError, false)
  assert.match(log.output, /status:\s*running/)
  assert.match(log.output, /TICK_/)

  const stopped = runStopBackground(tm, { sessionId })
  assert.equal(stopped.isError, false)
  assert.equal(tm.get(sessionId), undefined)
})

// ---- P1-2: Offline React + JSX/TSX + Recharts Artifact Runtime ----

test('artifacts parser detects React/TSX artifacts cleanly and host escapes </script> tags', async () => {
  const md = [
    'Here is your chart dashboard:',
    '<artifact type="application/vnd.ant.react" identifier="rev-chart" title="Revenue Dashboard">',
    'import { BarChart, Bar } from "recharts";',
    'export default function App() { return <div><h2>Q1 Revenue</h2><BarChart width={300} height={150} data={[{n:"A",v:10}]}><Bar dataKey="v" /></BarChart></div>; }',
    '</artifact>',
    'And a fenced TSX snippet:',
    '```tsx',
    'import { Sparkles } from "lucide-react"',
    'export default function CounterCard() {',
    '  return <button><Sparkles size={14} /> Click me</button>',
    '}',
    '```',
  ].join('\n')

  const segs = splitMessageSegments(md, 'm0')
  assert.equal(segs[1]?.kind, 'artifact')
  if (segs[1]?.kind === 'artifact') {
    assert.equal(segs[1].artifact.kind, 'react')
    assert.equal(suggestedFilename(segs[1].artifact), 'revenue-dashboard.tsx')
  }

  const msgs: Conversation['messages'] = [{ role: 'assistant', text: md, toolCalls: [] }]
  const list = extractConversationArtifacts(msgs)
  assert.equal(list.length, 2)
  assert.equal(list[0]?.kind, 'react')
  assert.equal(list[1]?.kind, 'react')
  assert.equal(list[1]?.title, 'CounterCard')

  const bundle = await readFile(join(process.cwd(), 'src/renderer/src/generated/artifact-runtime.bundle.txt'), 'utf8')
  assert.ok(bundle.length > 50_000)
  const html = buildReactArtifactHtml('const s = "</script><script>alert(1)"; export default function A(){return <div>{s}</div>}', bundle, true)
  assert.match(html, /data-theme="dark"/)
  assert.match(html, /<\\\/script>/)

  // Verify the built bundle initializes in a sandboxed VM window & compiles JSX + resolves Recharts/Lucide cleanly.
  const win: Record<string, any> = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    navigator: { userAgent: 'node' },
    performance: globalThis.performance,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  win.window = win
  win.self = win
  win.globalThis = win
  const noopEl = (): Record<string, any> => ({
    nodeType: 1,
    tagName: 'DIV',
    style: {},
    children: [] as any[],
    childNodes: [] as any[],
    ownerDocument: null as any,
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    appendChild(child: any) {
      this.children.push(child)
      this.childNodes.push(child)
      return child
    },
    insertBefore(child: any) {
      this.children.push(child)
      this.childNodes.push(child)
      return child
    },
    removeChild: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ width: 400, height: 200, top: 0, left: 0 }),
  })
  win.Element = function Element() {}
  win.HTMLElement = function HTMLElement() {}
  win.SVGElement = function SVGElement() {}
  win.Node = function Node() {}
  win.DocumentFragment = function DocumentFragment() {}
  const doc: Record<string, any> = {
    documentElement: noopEl(),
    body: noopEl(),
    createElement: (tag: string) => ({ ...noopEl(), tagName: tag.toUpperCase(), ownerDocument: doc }),
    createElementNS: (_ns: string, tag: string) => ({ ...noopEl(), tagName: tag.toUpperCase(), ownerDocument: doc }),
    createTextNode: (text: string) => ({ nodeType: 3, nodeValue: text }),
    createComment: (text: string) => ({ nodeType: 8, nodeValue: text }),
    getElementById: () => noopEl(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  doc.documentElement.ownerDocument = doc
  doc.body.ownerDocument = doc
  win.document = doc
  const openedPorts: Array<{ close(): void; unref?: () => void }> = []
  class UnrefMessageChannel {
    port1: { close(): void; unref?: () => void }
    port2: { close(): void; unref?: () => void }
    constructor() {
      const ch = new globalThis.MessageChannel()
      const p1 = ch.port1 as unknown as { close(): void; unref?: () => void }
      const p2 = ch.port2 as unknown as { close(): void; unref?: () => void }
      p1.unref?.()
      p2.unref?.()
      openedPorts.push(p1, p2)
      this.port1 = p1
      this.port2 = p2
    }
  }
  const StubClass = function StubClass() {}
  const ctx = vm.createContext({
    window: win,
    self: win,
    document: doc,
    navigator: win.navigator,
    Element: StubClass,
    HTMLElement: StubClass,
    SVGElement: StubClass,
    Node: StubClass,
    DocumentFragment: StubClass,
    console,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    queueMicrotask: globalThis.queueMicrotask,
    performance: globalThis.performance,
    MessageChannel: UnrefMessageChannel,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  })
  try {
    vm.runInContext(bundle, ctx)
    assert.equal(typeof win.__ATRIUM_REACT_RUNTIME__?.renderArtifact, 'function')
    assert.equal(typeof win.__ATRIUM_REACT_RUNTIME__?.compileArtifactComponent, 'function')

    const Comp = win.__ATRIUM_REACT_RUNTIME__.compileArtifactComponent(
      [
        'import React from "react"',
        'import { BarChart, Bar } from "recharts"',
        'import { Sparkles, CustomUnknownIcon } from "lucide-react"',
        'interface Props { count?: number }',
        'export default function Demo({ count = 3 }: Props) {',
        '  return <div className="p-4"><Sparkles size={16} /><CustomUnknownIcon /><span>{count}</span><BarChart width={200} height={100} data={[{x:1,y:2}]}><Bar dataKey="y" /></BarChart></div>',
        '}',
      ].join('\n'),
    )
    assert.equal(typeof Comp, 'function')
    const element = Comp({})
    assert.ok(element && typeof element === 'object')
  } finally {
    for (const port of openedPorts) port.close()
  }
})

// ---- P1-3: Cron & Local Automations ----

test('Cron parser computes exact future occurrences and rejects malformed expressions', () => {
  parseCronExpr('*/15 9-17 * * 1-5')
  assert.throws(() => parseCronExpr('invalid cron'))
  assert.throws(() => parseCronExpr('65 * * * *'))

  // Reference: 2026-06-15 08:50 local (Monday)
  const ref = new Date(2026, 5, 15, 8, 50, 0, 0).getTime()
  const next = nextCronRun('30 9 * * 1-5', ref)
  const nextDate = new Date(next)
  assert.equal(nextDate.getFullYear(), 2026)
  assert.equal(nextDate.getMonth(), 5)
  assert.equal(nextDate.getDate(), 15)
  assert.equal(nextDate.getHours(), 9)
  assert.equal(nextDate.getMinutes(), 30)

  const sundayPreview = previewCronRuns('0 10 * * 7', 2, ref)
  assert.equal(sundayPreview.valid, true)
  assert.equal(new Date(sundayPreview.nextRuns[0]!).getDay(), 0)
})

test('AutomationManager schedules, executes due rules unattended, saves conversation & notifies', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-auto-dir-'))
  const ws = await mkdtemp(join(tmpdir(), 'atrium-auto-ws-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.after(() => rm(ws, { recursive: true, force: true }))

  const secretBag = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretBag.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const k = String(args[0])
      if (args[1] === null) secretBag.delete(k)
      else secretBag.set(k, String(args[1]))
      return undefined
    }
    return 'DIRECT'
  }) as Parameters<typeof bindSecrets>[0])

  const mockModel = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Daily summary: all checks green.' }, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((r) => mockModel.listen(0, '127.0.0.1', r))
  t.after(() => {
    mockModel.closeAllConnections?.()
    mockModel.close()
  })
  const port = (mockModel.address() as { port: number }).port

  const settings = new SettingsStore(dir)
  await settings.load()
  await settings.update({ workspace: ws, onboarded: true })
  await settings.saveProvider({
    name: 'Mock',
    protocol: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'mock-1',
    apiKey: 'sk-test',
  })

  const chats = new ChatStore(join(dir, 'data'))
  await chats.load()
  const mcp = new McpManager(dir, () => undefined)
  const notifications: Array<{ title: string; body: string; conversationId?: string }> = []
  const bgStates: boolean[] = []

  const mgr = new AutomationManager({
    dir,
    dataDir: join(dir, 'data'),
    settings,
    chats,
    mcp,
    emitAgent: (_e: AgentEvent) => undefined,
    onChange: () => undefined,
    onChatsChanged: () => undefined,
    notify: (n) => {
      notifications.push(n)
    },
    onBackgroundActiveChange: (active) => bgStates.push(active),
  })
  await mgr.load()

  const rule = await mgr.save({
    name: 'Repo Digest',
    prompt: 'Summarize repo status',
    workspace: ws,
    agentMode: 'plan',
    schedule: { kind: 'interval', minutes: 60 },
    enabled: true,
    notifyOnComplete: true,
  })
  assert.equal(bgStates.at(-1), true)
  assert.ok(rule.nextRunAt && rule.nextRunAt > Date.now())

  await mgr.executeRule(rule.id)

  const updated = mgr.list().find((r) => r.id === rule.id)!
  assert.equal(updated.lastStatus, 'done')
  assert.match(updated.lastSummary ?? '', /Daily summary/)
  assert.ok(updated.lastConversationId)
  assert.equal(updated.history?.length, 1)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.conversationId, updated.lastConversationId)

  const createdChat = await chats.get(updated.lastConversationId!)
  assert.equal(createdChat?.title, '[Auto] Repo Digest')

  await mgr.setEnabled(rule.id, false)
  assert.equal(bgStates.at(-1), false)
})

// ---- P1-4: MCP OAuth 2.1 Discovery, DCR, PKCE Loopback Flow & Refresh ----

test('McpManager executes full MCP OAuth 2.1 discovery, DCR, PKCE loopback sign-in, and connects cleanly', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-oauth-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const secretBag = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretBag.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const k = String(args[0])
      if (args[1] === null) secretBag.delete(k)
      else secretBag.set(k, String(args[1]))
      return undefined
    }
    return 'DIRECT'
  }) as Parameters<typeof bindSecrets>[0])

  let serverBase = ''
  const authCodes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>()
  let registeredClientId = ''
  let validToken = ''

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', serverBase)
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (reqUrl.pathname === '/.well-known/oauth-protected-resource' || reqUrl.pathname === '/.well-known/oauth-protected-resource/mcp') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ resource: `${serverBase}/mcp`, authorization_servers: [serverBase] }))
        return
      }
      if (reqUrl.pathname === '/.well-known/oauth-authorization-server') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            issuer: serverBase,
            authorization_endpoint: `${serverBase}/authorize`,
            token_endpoint: `${serverBase}/token`,
            registration_endpoint: `${serverBase}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
          }),
        )
        return
      }
      if (reqUrl.pathname === '/register' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}')
        registeredClientId = 'dyn_client_1'
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            client_id: registeredClientId,
            redirect_uris: body.redirect_uris,
            token_endpoint_auth_method: 'none',
          }),
        )
        return
      }
      if (reqUrl.pathname === '/authorize' && req.method === 'GET') {
        const redirectUri = reqUrl.searchParams.get('redirect_uri')!
        const state = reqUrl.searchParams.get('state')!
        const challenge = reqUrl.searchParams.get('code_challenge')!
        const clientId = reqUrl.searchParams.get('client_id')!
        const code = 'auth_code_xyz'
        authCodes.set(code, { challenge, redirectUri, clientId })
        const dest = new URL(redirectUri)
        dest.searchParams.set('code', code)
        dest.searchParams.set('state', state)
        res.writeHead(302, { location: dest.href })
        res.end()
        return
      }
      if (reqUrl.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(raw)
        const code = params.get('code') ?? ''
        const verifier = params.get('code_verifier') ?? ''
        const rec = authCodes.get(code)
        const expectedChallenge = createHash('sha256').update(verifier).digest('base64url')
        if (!rec || expectedChallenge !== rec.challenge) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        validToken = 'tok_secret_123'
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            access_token: validToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: 'ref_456',
          }),
        )
        return
      }
      if (reqUrl.pathname === '/mcp') {
        if (req.headers.authorization !== `Bearer ${validToken}` || !validToken) {
          res.writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${serverBase}/.well-known/oauth-protected-resource/mcp"`,
            'content-type': 'application/json',
          })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const rpc = JSON.parse(raw || '{}')
        if (rpc.method === 'notifications/initialized') {
          res.writeHead(202)
          res.end()
          return
        }
        if (rpc.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                protocolVersion: rpc.params?.protocolVersion ?? '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'mock-oauth-mcp', version: '1.0.0' },
              },
            }),
          )
          return
        }
        if (rpc.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {
                tools: [{ name: 'oauth_ping', description: 'Ping behind OAuth', inputSchema: { type: 'object' } }],
              },
            }),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const port = (server.address() as { port: number }).port
  serverBase = `http://127.0.0.1:${port}`

  const manager = new McpManager(
    dir,
    () => undefined,
    async (authUrl) => {
      // Simulate the system browser visiting the authorization endpoint & following redirect to loopback callback.
      await fetch(authUrl, { redirect: 'follow' })
    },
  )
  t.after(() => manager.shutdown())

  const saved = await manager.save({
    name: 'OAuth Test MCP',
    enabled: true,
    transport: 'http',
    url: `${serverBase}/mcp`,
    authMode: 'oauth',
  })

  // Wait for initial unauthenticated connect attempt to discover 401 -> needsAuth
  await waitFor(() => {
    const st = manager.statuses().find((s) => s.id === saved.id)
    return st?.state === 'error' && st.needsAuth === true
  })

  // Trigger OAuth 2.1 browser flow -> DCR + PKCE + loopback redirect + auto reconnect!
  const finalStatus = await manager.oauthStart(saved.id)
  assert.equal(finalStatus.state, 'connected')
  assert.equal(finalStatus.needsAuth, false)
  assert.equal(registeredClientId, 'dyn_client_1')
  assert.deepEqual(
    finalStatus.tools.map((tool) => tool.name),
    ['oauth_ping'],
  )
  assert.ok(secretBag.get(`mcp:${saved.id}:__oauth__`))

  // Revoke clears stored OAuth secrets cleanly
  const afterRevoke = await manager.oauthRevoke(saved.id)
  assert.equal(secretBag.has(`mcp:${saved.id}:__oauth__`), false)
  assert.equal(afterRevoke.needsAuth, true, JSON.stringify(afterRevoke))
})
