// Comprehensive tests for Improvement #1 & #2 core capabilities:
// apply_patch, ripgrep search, CheckpointStore rollback, Git worktrees,
// AgentLoop auto-compaction & overflow recovery, and SSRF-safe web_search / web_fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import type { AgentEvent, AppSettings, Conversation, ProviderConfig } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { SettingsStore } from '../src/core/settings.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import { CheckpointStore, snapshotExistingFile } from '../src/core/tools/changes.ts'
import { runReadTool, saveArtifactFile } from '../src/core/tools/files.ts'
import {
  createGitWorktree,
  getGitChanges,
  getGitRepoStatus,
  parseGitHubIssueQuery,
  parseGitHubRepo,
  removeGitWorktree,
} from '../src/core/tools/git.ts'
import { applyPreparedPatch, preparePatch } from '../src/core/tools/patch.ts'
import {
  assertSafePublicUrl,
  htmlToReadableText,
  isFakeIpBenchmarkRange,
  parseDuckDuckGoHtml,
  webFetch,
  webSearch,
} from '../src/core/tools/web.ts'

const execFileAsync = promisify(execFile)

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
  t.after(() => {
    server.closeAllConnections?.()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

function makeDeps(provider: ProviderConfig, settingsPatch?: Partial<AppSettings>) {
  const settingsData: AppSettings = {
    locale: 'en',
    theme: 'light',
    activeProviderId: provider.id,
    reasoningEffort: 'auto',
    onboarded: true,
    proxyMode: 'none',
    autoCompact: true,
    webEnabled: true,
    ...settingsPatch,
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

test('apply_patch supports Codex Begin Patch (add, update, move, delete) and unified diff', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-patch-'))
  t.after(() => rm(ws, { recursive: true, force: true }))

  await mkdir(join(ws, 'src'), { recursive: true })
  await writeFile(join(ws, 'src', 'hello.ts'), 'export function greet() {\n  return "hi"\n}\n', 'utf8')
  await writeFile(join(ws, 'old.txt'), 'remove me\n', 'utf8')

  const codexPatch = [
    '*** Begin Patch',
    '*** Add File: src/math.ts',
    '+export const add = (a: number, b: number) => a + b',
    '*** Update File: src/hello.ts',
    '*** Move to: src/greet.ts',
    '@@',
    ' export function greet() {',
    '-  return "hi"',
    '+  return "hello world"',
    ' }',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n')

  const prepared = await preparePatch(ws, { patch: codexPatch })
  assert.equal(prepared.files.length, 3)
  assert.match(prepared.diff, /\+\+\+ b\/src\/math\.ts/)
  assert.match(prepared.diff, /--- a\/src\/hello\.ts/)
  assert.match(prepared.diff, /\+\+\+ b\/src\/greet\.ts/)

  await applyPreparedPatch(prepared)

  assert.equal(await readFile(join(ws, 'src', 'math.ts'), 'utf8'), 'export const add = (a: number, b: number) => a + b')
  assert.equal(await readFile(join(ws, 'src', 'greet.ts'), 'utf8'), 'export function greet() {\n  return "hello world"\n}\n')
  await assert.rejects(() => stat(join(ws, 'src', 'hello.ts')))
  await assert.rejects(() => stat(join(ws, 'old.txt')))

  // Unified diff format also works cleanly
  const unifiedPatch = [
    '--- a/src/math.ts',
    '+++ b/src/math.ts',
    '@@ -1,1 +1,2 @@',
    ' export const add = (a: number, b: number) => a + b',
    '+export const mul = (a: number, b: number) => a * b',
  ].join('\n')
  const preparedUni = await preparePatch(ws, { patch: unifiedPatch })
  await applyPreparedPatch(preparedUni)
  assert.match(await readFile(join(ws, 'src', 'math.ts'), 'utf8'), /export const mul/)

  // Rejects escaping outside workspace
  await assert.rejects(
    () =>
      preparePatch(ws, {
        patch: '*** Begin Patch\n*** Add File: ../../outside.txt\n+bad\n*** End Patch',
      }),
    /workspace/i,
  )
})

test('apply_patch rolls back earlier operations cleanly if any later write fails', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-patch-rb-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'a.txt'), 'original A', 'utf8')
  await writeFile(join(ws, 'b.txt'), 'original B', 'utf8')

  const prepared = await preparePatch(ws, {
    patch: [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-original A',
      '+updated A',
      '*** Update File: b.txt',
      '@@',
      '-original B',
      '+updated B',
      '*** End Patch',
    ].join('\n'),
  })

  // Force the second op's target path to become a directory mid-flight to induce write failure.
  await rm(join(ws, 'b.txt'))
  await mkdir(join(ws, 'b.txt'))

  await assert.rejects(() => applyPreparedPatch(prepared))
  // First file must be automatically rolled back to "original A"!
  assert.equal(await readFile(join(ws, 'a.txt'), 'utf8'), 'original A')
})

test('search handles globs, case sensitivity, context lines, and skips node_modules', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-search-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await mkdir(join(ws, 'src'), { recursive: true })
  await mkdir(join(ws, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(ws, 'src', 'app.ts'), 'line1\nconst TargetToken = 42\nline3\n', 'utf8')
  await writeFile(join(ws, 'src', 'notes.md'), 'targettoken in docs\n', 'utf8')
  await writeFile(join(ws, 'node_modules', 'pkg', 'index.ts'), 'const TargetToken = 0\n', 'utf8')

  const tsOnly = await runReadTool(ws, 'search', { query: 'TargetToken', glob: '*.ts', case_sensitive: true, context_lines: 1 })
  assert.equal(tsOnly.isError, false)
  assert.match(tsOnly.output, /src\/app\.ts:2: const TargetToken = 42/)
  assert.doesNotMatch(tsOnly.output, /node_modules/)
  assert.doesNotMatch(tsOnly.output, /notes\.md/)

  // Invalid regex literal falls back cleanly to literal search without throwing
  const literal = await runReadTool(ws, 'search', { query: 'TargetToken[' })
  assert.equal(literal.isError, false)
})

test('CheckpointStore tracks file mutations and supports per-file and full revert + saveArtifactFile', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-cp-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'atrium-cp-data-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  await writeFile(join(ws, 'existing.txt'), 'hello\nworld\n', 'utf8')
  const store = new CheckpointStore(dataDir)

  const snap1 = await snapshotExistingFile(ws, 'existing.txt')
  await writeFile(join(ws, 'existing.txt'), 'hello\nupdated world\n', 'utf8')
  const snap2 = await snapshotExistingFile(ws, 'new-file.txt')
  await writeFile(join(ws, 'new-file.txt'), 'brand new\nline 2\n', 'utf8')

  await store.record('chat_1', [snap1, snap2])
  // Subsequent edits keep original pre-image!
  const snap1Again = await snapshotExistingFile(ws, 'existing.txt')
  await writeFile(join(ws, 'existing.txt'), 'hello\nthird version\n', 'utf8')
  await store.record('chat_1', [snap1Again])

  const entries = await store.entries('chat_1', ws)
  assert.equal(entries.length, 2)
  const mod = entries.find((e) => e.path === 'existing.txt')!
  const add = entries.find((e) => e.path === 'new-file.txt')!
  assert.equal(mod.status, 'modified')
  assert.equal(mod.additions, 1)
  assert.equal(mod.deletions, 1)
  assert.equal(add.status, 'added')

  // Revert created file -> removes it completely
  await store.revertFile('chat_1', ws, 'new-file.txt')
  await assert.rejects(() => stat(join(ws, 'new-file.txt')))
  // Revert existing file -> restores original first pre-image ("world")
  await store.revertAll('chat_1', ws)
  assert.equal(await readFile(join(ws, 'existing.txt'), 'utf8'), 'hello\nworld\n')

  // saveArtifactFile writes cleanly inside workspace and rejects outside
  const saved = await saveArtifactFile(ws, 'notes/diagram.html', '<h1>Hi</h1>')
  assert.equal(saved, 'notes/diagram.html')
  assert.equal(await readFile(join(ws, 'notes', 'diagram.html'), 'utf8'), '<h1>Hi</h1>')
  await assert.rejects(() => saveArtifactFile(ws, '../escape.html', 'bad'), /workspace/i)
})

test('git.ts creates isolated worktree, inspects diffs, and removes worktree cleanly', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'atrium-git-repo-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'atrium-git-data-'))
  t.after(() => rm(repo, { recursive: true, force: true }))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.email', 'test@atrium.dev'], { cwd: repo })
  await execFileAsync('git', ['config', 'user.name', 'Atrium Test'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), '# Repo\n', 'utf8')
  await execFileAsync('git', ['add', '.'], { cwd: repo })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo })

  const repoStatus = await getGitRepoStatus(repo)
  assert.equal(repoStatus.isRepo, true)
  assert.equal(repoStatus.branch, 'main')

  const wt = await createGitWorktree(repo, dataDir, 'chat_wt_1')
  assert.equal(wt.branch, 'atrium/chat_wt_1')
  assert.equal(wt.baseBranch, 'main')

  await writeFile(join(wt.worktreePath, 'README.md'), '# Repo\nEdited in worktree\n', 'utf8')
  const wtChanges = await getGitChanges(wt.worktreePath, wt.baseBranch)
  assert.equal(wtChanges.length, 1)
  assert.match(wtChanges[0]!.diff, /\+Edited in worktree/)
  // Original repository stays untouched!
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# Repo\n')

  await removeGitWorktree(wt.baseWorkspace, wt.worktreePath, wt.branch)
  await assert.rejects(() => stat(wt.worktreePath))
})

test('AgentLoop auto-compacts above threshold and retries once on context-length overflow', async (t) => {
  let step = 0
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    step++
    // Compact call has summary system instruction (array or string in Anthropic)
    if (JSON.stringify(body.system ?? '').includes('Summarize the earlier conversation')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Summary of earlier work.' } })}\n\n`)
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })}\n\n`)
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      return
    }
    if (step === 1) {
      // Simulate context overflow error from upstream API on first attempt
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'prompt is too long: maximum context length exceeded' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Recovered after auto-compact!' } })}\n\n`)
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })}\n\n`)
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
  })

  const provider: ProviderConfig = {
    id: 'p_ant',
    name: 'Claude',
    protocol: 'anthropic',
    baseUrl,
    model: 'claude-sonnet-4-6',
    hasKey: true,
  }
  const { settings, mcp } = makeDeps(provider)
  const events: AgentEvent[] = []
  const loop = new AgentLoop({
    settings,
    mcp,
    emit: (e) => events.push(e),
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })

  const conv: Conversation = {
    id: 'c_auto',
    title: 'Long chat',
    createdAt: 0,
    updatedAt: 0,
    messages: [
      { role: 'user', text: 'Turn 1 question' },
      { role: 'assistant', text: 'Turn 1 answer', toolCalls: [] },
      { role: 'user', text: 'Turn 2 question' },
      { role: 'assistant', text: 'Turn 2 answer', toolCalls: [] },
    ],
  }
  await loop.run(conv, 'Turn 3 question')

  assert.equal((conv.messages[0] as { isSummary?: boolean }).isSummary, true)
  assert.match((conv.messages[0] as { text: string }).text, /Summary of earlier work/)
  assert.equal(events.some((e) => e.type === 'compacting' && e.active && e.auto), true)
  const last = conv.messages[conv.messages.length - 1] as { text?: string }
  assert.equal(last.text, 'Recovered after auto-compact!')

  // Also test proactive token-threshold auto-compaction
  step = 10
  const { settings: s2, mcp: m2 } = makeDeps(provider)
  const events2: AgentEvent[] = []
  const loop2 = new AgentLoop({
    settings: s2,
    mcp: m2,
    compactThresholdTokens: 50,
    emit: (e) => events2.push(e),
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })
  const conv2: Conversation = {
    id: 'c_thresh',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    messages: [
      { role: 'user', text: 'A'.repeat(200) },
      { role: 'assistant', text: 'B'.repeat(200), toolCalls: [], usage: { inputTokens: 80, outputTokens: 20 } },
      { role: 'user', text: 'C'.repeat(200) },
      { role: 'assistant', text: 'D'.repeat(200), toolCalls: [] },
      { role: 'user', text: 'E'.repeat(200) },
    ],
  }
  await loop2.run(conv2, 'Next prompt')
  assert.equal(events2.some((e) => e.type === 'compacting' && e.active && e.auto), true)
  assert.equal((conv2.messages[0] as { isSummary?: boolean }).isSummary, true)
})

test('web tools enforce SSRF guard, parse DuckDuckGo results, and extract clean HTML text', async () => {
  await assert.rejects(() => assertSafePublicUrl('http://127.0.0.1:8080/secret'), /Blocked/)
  await assert.rejects(() => assertSafePublicUrl('http://localhost/admin'), /Blocked/)
  await assert.rejects(() => assertSafePublicUrl('http://169.254.169.254/latest/meta-data/'), /Blocked/)
  await assert.rejects(() => assertSafePublicUrl('http://10.0.0.5/'), /Blocked/)
  await assert.rejects(() => assertSafePublicUrl('http://198.18.0.1/'), /Blocked/)
  await assert.rejects(() => assertSafePublicUrl('http://[::1]/'), /Blocked/)
  await assert.rejects(() => assertSafePublicUrl('file:///C:/Windows/win.ini'), /Blocked/)
  assert.equal(isFakeIpBenchmarkRange('198.18.0.58'), true)
  assert.equal(isFakeIpBenchmarkRange('93.184.216.34'), false)

  const sampleDdg = `
    <div class="result results_links">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=1">Example &amp; Docs</a>
      <a class="result__snippet">Read concise <b>guide</b> &amp; examples.</a>
    </div>
  `
  const hits = parseDuckDuckGoHtml(sampleDdg, 5)
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0], {
    title: 'Example & Docs',
    url: 'https://example.com/docs',
    snippet: 'Read concise guide & examples.',
  })

  const md = htmlToReadableText(
    '<html><head><title>Page Title</title><script>alert(1)</script></head><body><h1>Hello</h1><p>Visit <a href="https://atrium.dev">Atrium</a></p><ul><li>One</li></ul></body></html>',
    'text/html',
    'https://atrium.dev',
  )
  assert.match(md, /# Page Title/)
  assert.match(md, /\[Atrium\]\(https:\/\/atrium\.dev\)/)
  assert.doesNotMatch(md, /alert\(1\)/)

  // webSearch & webFetch with mocked fetcher + redirect SSRF protection
  const searchRes = await webSearch('atrium', 3, {
    fetchImpl: async () => new Response(sampleDdg, { status: 200, headers: { 'content-type': 'text/html' } }),
  })
  assert.equal(searchRes.isError, false)
  assert.match(searchRes.output, /https:\/\/example\.com\/docs/)

  const redirectToLocal = await webFetch('https://93.184.216.34/page', 5000, {
    checkDns: false,
    fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/internal' } }),
  })
  assert.equal(redirectToLocal.isError, true)
  assert.match(redirectToLocal.output, /Blocked/)
})

test('AgentLoop gates web tools via webEnabled, approves apply_patch, and records CheckpointStore rollback', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-loop-ws-'))
  const dataDir = await mkdtemp(join(tmpdir(), 'atrium-loop-cp-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  await mkdir(join(ws, 'src'), { recursive: true })
  await writeFile(join(ws, 'src', 'app.ts'), 'export const x = 1\n', 'utf8')

  const seenToolNames: string[][] = []
  let turn = 0
  const baseUrl = await startMockHttp(t, (_req, body, res) => {
    seenToolNames.push((body.tools ?? []).map((tool: { name: string }) => tool.name))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    turn++
    if (seenToolNames.length === 1) {
      // First call runs with webEnabled: false -> simply finish
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done without web.' } })}\n\n`)
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })}\n\n`)
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      return
    }
    if (turn === 2) {
      const patchText = [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-export const x = 1',
        '+export const x = 2',
        '*** Add File: src/helper.ts',
        '+export const y = 42',
        '*** End Patch',
      ].join('\n')
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_patch_1', name: 'apply_patch', input: {} } })}\n\n`)
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ patch: patchText }) } })}\n\n`)
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } })}\n\n`)
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
      return
    }
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Patched successfully.' } })}\n\n`)
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } })}\n\n`)
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
  })

  const provider: ProviderConfig = {
    id: 'p_loop',
    name: 'Mock',
    protocol: 'anthropic',
    baseUrl,
    model: 'claude-sonnet-4-5',
    hasKey: true,
  }

  // 1. webEnabled: false hides web_search and web_fetch
  const { settings: sOff, mcp: mOff } = makeDeps(provider, { webEnabled: false })
  const loopOff = new AgentLoop({ settings: sOff, mcp: mOff, emit: () => undefined, save: async () => undefined, systemPrompt: () => 'sys' })
  await loopOff.run({ id: 'c_off', title: '', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }, 'Hello')
  assert.equal(seenToolNames[0]!.includes('apply_patch'), true)
  assert.equal(seenToolNames[0]!.includes('web_search'), false)
  assert.equal(seenToolNames[0]!.includes('web_fetch'), false)

  // 2. webEnabled: true exposes web tools, apply_patch prompts diff & records checkpoints
  const checkpoints = new CheckpointStore(dataDir)
  const { settings: sOn, mcp: mOn } = makeDeps(provider, { webEnabled: true })
  const askDiffs: string[] = []
  let loopOn!: AgentLoop
  loopOn = new AgentLoop({
    settings: sOn,
    mcp: mOn,
    checkpoints,
    emit: (ev) => {
      if (ev.type === 'approval') {
        askDiffs.push(ev.request.detail ?? '')
        loopOn.approve(ev.request.approvalId, 'allow')
      }
    },
    save: async () => undefined,
    systemPrompt: () => 'sys',
  })
  const conv: Conversation = { id: 'c_patch', title: '', createdAt: 0, updatedAt: 0, workspace: ws, messages: [] }
  await loopOn.run(conv, 'Patch app.ts')

  assert.equal(seenToolNames[1]!.includes('web_search'), true)
  assert.equal(seenToolNames[1]!.includes('web_fetch'), true)
  assert.equal(askDiffs.length, 1)
  assert.match(askDiffs[0]!, /\+export const x = 2/)
  assert.equal(await readFile(join(ws, 'src', 'app.ts'), 'utf8'), 'export const x = 2\n')
  assert.equal(await readFile(join(ws, 'src', 'helper.ts'), 'utf8'), 'export const y = 42')

  const cpEntries = await checkpoints.entries('c_patch', ws)
  assert.deepEqual(cpEntries.map((e) => e.path).sort(), ['src/app.ts', 'src/helper.ts'])
  await checkpoints.revertAll('c_patch', ws)
  assert.equal(await readFile(join(ws, 'src', 'app.ts'), 'utf8'), 'export const x = 1\n')
  await assert.rejects(() => stat(join(ws, 'src', 'helper.ts')))

  // 3. webFetch returns clean error object on direct private IP rather than throwing uncaught
  const directPrivate = await webFetch('http://127.0.0.1:8080/secret')
  assert.equal(directPrivate.isError, true)
  assert.match(directPrivate.output, /Blocked/)
})

test('parseGitHubRepo, parseGitHubIssueQuery, and getGitRepoStatus detect GitHub remotes cleanly', async (t) => {
  assert.equal(parseGitHubRepo('https://github.com/anthropics/claude-code.git'), 'anthropics/claude-code')
  assert.equal(parseGitHubRepo('git@github.com:openai/codex.git'), 'openai/codex')
  assert.equal(parseGitHubRepo('ssh://git@github.com/user_1/repo.name'), 'user_1/repo.name')
  assert.equal(parseGitHubRepo('https://gitlab.com/org/proj.git'), undefined)
  assert.equal(parseGitHubRepo(''), undefined)

  assert.equal(parseGitHubIssueQuery('#42'), 42)
  assert.equal(parseGitHubIssueQuery('128'), 128)
  assert.equal(parseGitHubIssueQuery('https://github.com/org/repo/issues/905'), 905)
  assert.equal(parseGitHubIssueQuery('fix chart layout'), undefined)

  const dir = await mkdtemp(join(tmpdir(), 'atrium-gh-remote-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await execFileAsync('git', ['init'], { cwd: dir })
  const noRemote = await getGitRepoStatus(dir)
  assert.equal(noRemote.isRepo, true)
  assert.equal(noRemote.githubRepo, undefined)

  await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:rpulse/atrium.git'], { cwd: dir })
  const withGithub = await getGitRepoStatus(dir)
  assert.equal(withGithub.githubRepo, 'rpulse/atrium')
})
