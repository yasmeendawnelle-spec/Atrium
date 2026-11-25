import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, BrowserActionInput, BrowserSnapshot, Conversation } from '../src/shared/types.ts'
import {
  buildBrowserUserAgent,
  defaultBrowserModeForLocale,
  getBrowserProfile,
  isModeHomeOrSearchUrl,
  normalizeBrowserUrl,
  resolveBrowserInput,
} from '../src/shared/browserUrl.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { KnowledgeBaseManager, tokenizeForSearch } from '../src/core/knowledge.ts'
import { McpManager } from '../src/core/mcp/manager.ts'
import { MemoryStore } from '../src/core/memory.ts'
import { systemPrompt } from '../src/core/prompt.ts'
import { detectSandboxCapabilities } from '../src/core/sandbox.ts'
import { bindSecrets } from '../src/core/secrets.ts'
import { SettingsStore } from '../src/core/settings.ts'
import { transcribeSpeech } from '../src/core/speech.ts'
import { runBrowserTool } from '../src/core/tools/browser_tools.ts'
import { chromeCandidatePaths, pickChromeBinary } from '../src/main/cdp.ts'
import { runCommand } from '../src/core/tools/shell.ts'

// ---- P2-1: OS Command Sandbox ----

test('OS Command Sandbox detects native capabilities and enforces workspace_write vs read_only boundaries', { timeout: 30_000 }, async (t) => {
  const caps = detectSandboxCapabilities()
  assert.equal(caps.platform, process.platform)
  assert.ok(caps.backend.length > 0)

  const root = await mkdtemp(join(tmpdir(), 'atrium-sb-root-'))
  const ws = join(root, 'workspace')
  const outside = join(root, 'outside')
  const dataDir = join(root, 'app-data')
  await mkdir(ws, { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(ws, 'seed.txt'), 'hello-sandbox', 'utf8')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  if (!caps.supported) return

  const ac = new AbortController()
  // 1. workspace_write allows reading & writing inside workspace
  const okCmd = `node -e "const fs=require('fs');const v=fs.readFileSync('seed.txt','utf8');fs.writeFileSync('ok.txt',v+':ok');console.log('WROTE_OK')"`
  const okRes = await runCommand(ws, okCmd, 30, ac.signal, undefined, {
    sandboxMode: 'workspace_write',
    allowNetwork: false,
    dataDir,
  })
  if (
    process.platform === 'win32' &&
    okRes.exitCode === 3221225794 &&
    (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true')
  ) {
    t.skip('Windows non-interactive CI session (Session 0) blocks Low-Integrity user32.dll init (0xC0000142)')
    return
  }
  assert.equal(okRes.isError, false, okRes.output)
  assert.equal(okRes.exitCode, 0)
  assert.match(okRes.output, /WROTE_OK/)
  assert.match(okRes.output, /\[sandbox: workspace_write\]/)
  assert.equal(await readFile(join(ws, 'ok.txt'), 'utf8'), 'hello-sandbox:ok')

  // 2. workspace_write blocks writes outside workspace
  const blockedOutside = join(outside, 'escape.txt')
  const escCmd = `node -e "require('fs').writeFileSync(${JSON.stringify(blockedOutside)}, 'escaped')"`
  const escRes = await runCommand(ws, escCmd, 30, ac.signal, undefined, {
    sandboxMode: 'workspace_write',
    allowNetwork: false,
    dataDir,
  })
  assert.equal(escRes.isError, true)
  assert.equal(existsSync(blockedOutside), false)

  // 3. read_only allows reading workspace files cleanly while blocking writes inside a clean read_only directory
  const roWs = join(root, 'readonly-ws')
  await mkdir(roWs, { recursive: true })
  await writeFile(join(roWs, 'readme.txt'), 'readonly-seed', 'utf8')
  const roReadRes = await runCommand(
    roWs,
    `node -e "console.log(require('fs').readFileSync('readme.txt','utf8'))"`,
    30,
    ac.signal,
    undefined,
    { sandboxMode: 'read_only', allowNetwork: false, dataDir },
  )
  assert.equal(roReadRes.isError, false, roReadRes.output)
  assert.match(roReadRes.output, /readonly-seed/)
  assert.match(roReadRes.output, /\[sandbox: read_only\]/)

  const roTarget = join(roWs, 'nope.txt')
  const roWriteRes = await runCommand(
    roWs,
    `node -e "require('fs').writeFileSync('nope.txt','no')"`,
    30,
    ac.signal,
    undefined,
    { sandboxMode: 'read_only', allowNetwork: false, dataDir },
  )
  assert.equal(roWriteRes.isError, true)
  assert.equal(existsSync(roTarget), false)
})

// ---- P2-2a: Cross-Session Memory & AgentLoop Injection ----

test('MemoryStore persists global & workspace memories, deduplicates, formats prompts, and supports Agent tools', { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-mem-'))
  const wsA = join(dir, 'repo-a')
  const wsB = join(dir, 'repo-b')
  await mkdir(wsA, { recursive: true })
  await mkdir(wsB, { recursive: true })
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

  const store = new MemoryStore(dir)
  await store.load()

  const globalPref = await store.save({
    content: 'Always run `npm run typecheck` after modifying TypeScript.',
    category: 'workflow',
    scope: 'global',
    pinned: true,
  })
  await store.save({
    content: 'Use Vitest inside repo-a.',
    category: 'fact',
    scope: 'workspace',
    workspace: wsA,
  })
  // Near-identical duplicate merges instead of creating duplicate row
  await store.save({
    content: '  use  vitest inside repo-a. ',
    category: 'decision',
    scope: 'workspace',
    workspace: wsA,
  })

  const reloaded = new MemoryStore(dir)
  await reloaded.load()
  assert.equal(reloaded.list(wsA).length, 2)
  assert.equal(reloaded.list(wsB).length, 1) // only globalPref applies to repo-b

  const promptA = reloaded.formatPromptBlock(wsA) ?? ''
  assert.match(promptA, /<user_memories>/)
  assert.match(promptA, /pinned/)
  assert.match(promptA, /Vitest/)

  // Verify mock LLM receives injected <user_memories> and invokes save_memory tool
  let seenSystemPrompt = ''
  let turnRound = 0
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { system?: unknown }
    seenSystemPrompt = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '')
    turnRound++

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (turnRound === 1) {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10 } } })}\n\n`)
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_mem', name: 'save_memory', input: {} } })}\n\n`)
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ content: 'Prefer concise JSDoc comments on exported helpers', category: 'preference', scope: 'workspace' }) } })}\n\n`)
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })}\n\n`)
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
    } else {
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm2', usage: { input_tokens: 12 } } })}\n\n`)
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Noted!' } })}\n\n`)
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}\n\n`)
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
    }
    res.end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => {
    srv.closeAllConnections?.()
    srv.close()
  })
  const addr = srv.address() as { port: number }

  const settings = new SettingsStore(dir)
  await settings.load()
  await settings.saveProvider({
    name: 'Mock',
    protocol: 'anthropic',
    baseUrl: `http://127.0.0.1:${addr.port}`,
    model: 'mock',
    apiKey: 'test-key',
  })
  await settings.update({ workspace: wsA, agentMode: 'auto', memoryEnabled: true })

  const mcp = new McpManager(dir, () => undefined)
  const conv: Conversation = { id: 'conv_mem', title: 'Test', createdAt: 1, updatedAt: 1, workspace: wsA, messages: [] }
  const events: AgentEvent[] = []
  const loop = new AgentLoop({
    settings,
    mcp,
    memory: reloaded,
    emit: (e) => events.push(e),
    save: async () => undefined,
    systemPrompt,
  })
  await loop.run(conv, 'Remember our JSDoc rule.')

  assert.match(seenSystemPrompt, /Always run `npm run typecheck`/)
  assert.ok(reloaded.search('JSDoc', wsA).length >= 1)
  await reloaded.remove(globalPref.id)
  assert.ok(!reloaded.list(wsA).some((m) => m.id === globalPref.id))
})

// ---- P2-2b: Project Knowledge Base BM25 Index ----

test('KnowledgeBaseManager tokenizes EN/CJK text, indexes Markdown/notes, and serves ranked search hits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-kb-'))
  const ws = join(dir, 'ws')
  await mkdir(ws, { recursive: true })
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  const cjkTokens = tokenizeForSearch('检查点回滚机制 CheckpointStore')
  assert.ok(cjkTokens.includes('检查'))
  assert.ok(cjkTokens.includes('回滚'))
  assert.ok(cjkTokens.includes('checkpointstore'))

  const specPath = join(ws, 'ARCHITECTURE.md')
  await writeFile(
    specPath,
    '# Architecture Overview\n\n## Checkpoint Rollback\nAtrium captures file pre-images in CheckpointStore so any turn edits can be reverted cleanly.\n\n## 搜索与索引架构\n项目知识库通过双语分词器和 BM25 打分实现本地高精度检索，无需外部向量数据库。\n',
    'utf8',
  )

  const kb = new KnowledgeBaseManager(dir)
  await kb.addFiles([specPath], ws)
  await kb.addNote('API Invariants', 'All REST pagination endpoints must use opaque cursor tokens and structured JSON error envelopes.', ws)

  const stats = await kb.status(ws)
  assert.equal(stats.sourceCount, 2)
  assert.ok(stats.chunkCount >= 2)

  // Verify persistence + CJK query + EN query
  const kbReloaded = new KnowledgeBaseManager(dir)
  const zhHits = await kbReloaded.search('本地 BM25 双语分词 检索', ws)
  assert.ok(zhHits.length >= 1)
  assert.match(zhHits[0]!.snippet, /BM25/)

  const enHits = await kbReloaded.search('opaque cursor pagination', ws)
  assert.ok(enHits.length >= 1)
  assert.equal(enHits[0]!.title, 'API Invariants')

  const hint = await kbReloaded.formatPromptHint(ws)
  assert.ok(hint && hint.includes('<project_knowledge'))

  const afterRemove = await kbReloaded.remove(stats.sources[0]!.id, ws)
  assert.equal(afterRemove.sourceCount, 1)
})

// ---- P2-3a: Voice Dictation Speech Engine ----

test('Speech engine sends PCM WAV multipart audio to Whisper /audio/transcriptions cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-speech-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 80 }))

  let receivedPath = ''
  let receivedAuth = ''
  let receivedBody = ''
  const srv = createServer(async (req, res) => {
    receivedPath = req.url ?? ''
    receivedAuth = String(req.headers.authorization ?? '')
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    receivedBody = Buffer.concat(chunks).toString('utf8')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: 'Atrium voice check passed' }))
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => {
    srv.closeAllConnections?.()
    srv.close()
  })
  const addr = srv.address() as { port: number }

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

  const settings = new SettingsStore(dir)
  await settings.load()
  await settings.update({
    voiceMode: 'whisper',
    voiceEndpoint: `http://127.0.0.1:${addr.port}/v1`,
    voiceModel: 'whisper-1',
    voiceLanguage: 'en-US',
  })

  // Construct valid minimal 64+ byte RIFF WAV buffer
  const wav = Buffer.alloc(96)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(88, 4)
  wav.write('WAVE', 8)
  const result = await transcribeSpeech(settings, { wavBase64: wav.toString('base64') })

  assert.equal(result.backend, 'whisper')
  assert.equal(result.text, 'Atrium voice check passed')
  assert.equal(receivedPath, '/v1/audio/transcriptions')
  assert.equal(receivedAuth, '')
  assert.match(receivedBody, /filename="dictation\.wav"/)
  assert.match(receivedBody, /whisper-1/)
})

// ---- P2-3b: Built-in Chromium Browser Tools ----

test('Browser tools format snapshots, elements, console logs and enforce actions cleanly', async () => {
  const actions: BrowserActionInput[] = []
  const sampleSnap: BrowserSnapshot = {
    open: true,
    url: 'http://localhost:5173',
    title: 'Demo Dashboard',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    screenshotDataUrl: 'data:image/jpeg;base64,/9j/',
    elements: [
      { ref: 'e1', tag: 'button', role: 'button', text: 'Run Build' },
      { ref: 'e2', tag: 'input', role: 'input', type: 'text', placeholder: 'Search modules', text: '' },
    ],
    consoleLogs: [{ level: 'log', text: 'App mounted cleanly', at: 1 }],
  }

  const bridge = {
    open: async (url: string) => ({ ...sampleSnap, url }),
    action: async (act: BrowserActionInput) => {
      actions.push(act)
      return sampleSnap
    },
    capture: async () => sampleSnap,
    evalScript: async (script: string) => ({ value: `eval(${script}) => 42` }),
  }

  const openRes = await runBrowserTool(bridge, 'browser_open', { url: 'http://localhost:5173' })
  assert.equal(openRes.isError, false)
  assert.match(openRes.output, /Title: Demo Dashboard/)
  assert.match(openRes.output, /\[e1\] <button> button: "Run Build"/)
  assert.match(openRes.output, /\[log\] App mounted cleanly/)

  const clickRes = await runBrowserTool(bridge, 'browser_click', { ref: 'e1' })
  assert.equal(clickRes.isError, false)
  assert.equal(actions[0]?.kind, 'click')
  assert.equal(actions[0]?.ref, 'e1')

  const typeRes = await runBrowserTool(bridge, 'browser_type', { ref: 'e2', text: 'sandbox' })
  assert.equal(typeRes.isError, false)
  assert.equal(actions[1]?.kind, 'type')
  assert.equal(actions[1]?.text, 'sandbox')

  const evalRes = await runBrowserTool(bridge, 'browser_eval', { script: 'document.links.length' })
  assert.equal(evalRes.isError, false)
  assert.match(evalRes.output, /42/)
})

test('normalizeBrowserUrl defaults localhost/dev-ports to http:// and public hosts to https:// while blocking unsafe schemes', () => {
  assert.equal(normalizeBrowserUrl('localhost:8000'), 'http://localhost:8000/')
  assert.equal(normalizeBrowserUrl('localhost:8000/notes/hello.md'), 'http://localhost:8000/notes/hello.md')
  assert.equal(normalizeBrowserUrl('127.0.0.1:5173'), 'http://127.0.0.1:5173/')
  assert.equal(normalizeBrowserUrl('[::1]:3000'), 'http://[::1]:3000/')
  assert.equal(normalizeBrowserUrl('192.168.1.42:8080/app'), 'http://192.168.1.42:8080/app')
  assert.equal(normalizeBrowserUrl('app.local'), 'http://app.local/')
  assert.equal(normalizeBrowserUrl('example.com'), 'https://example.com/')
  assert.equal(normalizeBrowserUrl('https://localhost:8443/api'), 'https://localhost:8443/api')
  assert.throws(() => normalizeBrowserUrl('file:///etc/passwd'), /Blocked browser protocol/)
  assert.throws(() => normalizeBrowserUrl('javascript:alert(1)'), /Blocked browser protocol/)
  assert.throws(() => normalizeBrowserUrl('http://169.254.169.254/latest'), /Blocked cloud metadata host/)
  assert.throws(() => normalizeBrowserUrl('   '), /Please enter a browser URL/)
})

test('chromeCandidatePaths prioritizes ATRIUM_CHROME_PATH and Google Chrome over Edge fallback', () => {
  const winCands = chromeCandidatePaths('win32', {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
  })
  assert.equal(winCands[0]?.engine, 'chrome-cdp')
  assert.match(winCands[0]?.path ?? '', /Chrome\\Application\\chrome\.exe$/)

  const pickedEdgeOnly = pickChromeBinary(winCands, (p) => p.endsWith('msedge.exe'))
  assert.equal(pickedEdgeOnly?.engine, 'edge-cdp')
  assert.equal(pickedEdgeOnly?.label, 'Microsoft Edge')

  const overridden = chromeCandidatePaths('win32', {
    ATRIUM_CHROME_PATH: 'D:\\Custom\\chrome.exe',
  })
  const pickedCustom = pickChromeBinary(overridden, (p) => p === 'D:\\Custom\\chrome.exe')
  assert.equal(pickedCustom?.path, 'D:\\Custom\\chrome.exe')
  assert.equal(pickedCustom?.engine, 'chrome-cdp')

  const preferEdgeCands = chromeCandidatePaths(
    'win32',
    {
      PROGRAMFILES: 'C:\\Program Files',
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    },
    'edge-cdp',
  )
  assert.equal(preferEdgeCands[0]?.engine, 'edge-cdp')
  assert.match(preferEdgeCands[0]?.path ?? '', /msedge\.exe$/)
})

test('browser Edge/Google dual-mode resolves China-friendly defaults, omnibox search, UA, and SettingsStore persistence', async (t) => {
  assert.equal(defaultBrowserModeForLocale('zh-CN'), 'edge')
  assert.equal(defaultBrowserModeForLocale('zh'), 'edge')
  assert.equal(defaultBrowserModeForLocale('en-US'), 'google')

  const edgeProfile = getBrowserProfile('edge')
  const googleProfile = getBrowserProfile('google')
  assert.equal(edgeProfile.homeUrl, 'https://cn.bing.com/')
  assert.equal(googleProfile.homeUrl, 'https://www.google.com/')

  // Explicit URLs and local dev hosts resolve cleanly in both modes
  assert.equal(resolveBrowserInput('localhost:5173', 'edge'), 'http://localhost:5173/')
  assert.equal(resolveBrowserInput('github.com/trending', 'edge'), 'https://github.com/trending')
  // Search phrases route to Bing in Edge mode and Google in Google mode
  assert.equal(resolveBrowserInput('Electron WebContentsView', 'edge'), 'https://cn.bing.com/search?q=Electron%20WebContentsView')
  assert.equal(resolveBrowserInput('Electron WebContentsView', 'google'), 'https://www.google.com/search?q=Electron%20WebContentsView')
  assert.equal(resolveBrowserInput('github', 'edge'), 'https://cn.bing.com/search?q=github')
  // Safety blocks remain enforced in resolveBrowserInput
  assert.throws(() => resolveBrowserInput('javascript:alert(1)', 'edge'), /Blocked browser protocol/)
  assert.throws(() => resolveBrowserInput('169.254.169.254/latest', 'edge'), /Blocked cloud metadata host/)

  // Home/search detection preserves non-home app pages when toggling mode
  assert.equal(isModeHomeOrSearchUrl(''), true)
  assert.equal(isModeHomeOrSearchUrl('https://www.google.com/'), true)
  assert.equal(isModeHomeOrSearchUrl('https://cn.bing.com/search?q=hello'), true)
  assert.equal(isModeHomeOrSearchUrl('http://localhost:5173/'), false)
  assert.equal(isModeHomeOrSearchUrl('https://docs.google.com/document/d/123'), false)

  // Mode-specific User-Agent strips Atrium/Electron wrappers cleanly
  const electronUa =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Atrium/0.2.2 Chrome/134.0.6998.179 Electron/35.1.5 Safari/537.36'
  const edgeUa = buildBrowserUserAgent(electronUa, 'edge')
  const googleUa = buildBrowserUserAgent(electronUa, 'google')
  assert.doesNotMatch(edgeUa, /Electron|Atrium/)
  assert.match(edgeUa, /Chrome\/134\.0\.6998\.179 Safari\/537\.36 Edg\/134\.0\.6998\.179$/)
  assert.doesNotMatch(googleUa, /Electron|Atrium|Edg\//)
  assert.match(googleUa, /Chrome\/134\.0\.6998\.179 Safari\/537\.36$/)

  // SettingsStore persists browserMode across save & reload
  const dir = await mkdtemp(join(tmpdir(), 'atrium-browser-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new SettingsStore(dir)
  await store.load()
  assert.equal(store.get().browserMode, undefined)
  await store.update({ browserMode: 'edge' })
  const reloaded = new SettingsStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get().browserMode, 'edge')
  await reloaded.update({ browserMode: 'google' })
  assert.equal(reloaded.get().browserMode, 'google')
})
