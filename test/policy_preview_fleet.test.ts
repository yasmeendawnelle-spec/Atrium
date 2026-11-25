import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { parseCliArgs } from '../src/cli/args.ts'
import { runCli } from '../src/cli/index.ts'
import { createCliRuntime } from '../src/cli/runtime.ts'
import type { AgentEvent, BrowserSnapshot } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { ChatStore } from '../src/core/chats.ts'
import { WorktreeFleetManager } from '../src/core/fleet.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import {
  evaluateCommandPolicy,
  evaluateFileReadPolicy,
  evaluateFileWritePolicy,
  inspectWorkspacePolicy,
  invalidatePolicyCache,
  matchPolicyGlob,
  resolveEffectiveSandbox,
  saveWorkspacePolicy,
} from '../src/core/policy.ts'
import { PreviewServerManager, extractLocalServerUrl, probeLocalHttpUrl } from '../src/core/preview.ts'
import type { SettingsStore } from '../src/core/settings.ts'
import type { BrowserHostBridge } from '../src/core/tools/browser_tools.ts'
import { CheckpointStore } from '../src/core/tools/changes.ts'
import { prepareEdit, prepareWriteDiff, runReadTool, writeApproved } from '../src/core/tools/files.ts'
import { preparePatch } from '../src/core/tools/patch.ts'
import { runPreviewTool } from '../src/core/tools/preview_tools.ts'

const execFileAsync = promisify(execFile)

async function runGitTest(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

test('Policy engine: built-in sensitive-file shield, exceptions, search filtering, and overrides', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-policy-'))
  t.after(async () => {
    invalidatePolicyCache(ws)
    await rm(ws, { recursive: true, force: true })
  })

  await mkdir(join(ws, 'certs'), { recursive: true })
  await mkdir(join(ws, 'src'), { recursive: true })
  await mkdir(join(ws, '.atrium'), { recursive: true })

  await writeFile(join(ws, '.env'), 'SECRET_TOKEN=super-secret-value-123\n', 'utf8')
  await writeFile(join(ws, '.env.example'), 'SECRET_TOKEN=\nSAFE_TEMPLATE_MARKER=1\n', 'utf8')
  await writeFile(join(ws, 'certs', 'server.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n', 'utf8')
  await writeFile(join(ws, 'certs', 'deploy.pub'), 'ssh-ed25519 AAAA_PUBLIC_KEY\n', 'utf8')
  await writeFile(join(ws, 'src', 'app.ts'), 'export const appSecretMarker = "ok"\n', 'utf8')
  await writeFile(join(ws, '.atrium', 'secrets.json'), '{"apiKey":"topsecret"}\n', 'utf8')

  // Glob checks
  assert.equal(matchPolicyGlob('.env', '**/.env'), true)
  assert.equal(matchPolicyGlob('apps/web/.env', '**/.env'), true)
  assert.equal(matchPolicyGlob('.env.local', '**/.env.*'), true)
  assert.equal(matchPolicyGlob('src/app.ts', '**/.env'), false)

  // Default read blocks on secret files, allows safe templates/code
  const readEnv = await runReadTool(ws, 'read_file', { path: '.env' })
  assert.equal(readEnv.isError, true)
  assert.match(readEnv.output, /sensitive-file shield|policy/i)

  const readPem = await runReadTool(ws, 'read_file', { path: 'certs/server.pem' })
  assert.equal(readPem.isError, true)

  const readSecrets = await runReadTool(ws, 'read_file', { path: '.atrium/secrets.json' })
  assert.equal(readSecrets.isError, true)

  const readExample = await runReadTool(ws, 'read_file', { path: '.env.example' })
  assert.equal(readExample.isError, false)
  assert.match(readExample.output, /SAFE_TEMPLATE_MARKER/)

  const readPub = await runReadTool(ws, 'read_file', { path: 'certs/deploy.pub' })
  assert.equal(readPub.isError, false)
  assert.match(readPub.output, /AAAA_PUBLIC_KEY/)

  // list_dir marks protected files
  const listed = await runReadTool(ws, 'list_dir', { path: '.' })
  assert.equal(listed.isError, false)
  assert.match(listed.output, /file \.env \[protected\]/)
  assert.doesNotMatch(listed.output, /\.env\.example \[protected\]/)

  // search never leaks .env content even when searching SECRET_TOKEN
  const searchSecret = await runReadTool(ws, 'search', { query: 'super-secret-value-123' })
  assert.equal(searchSecret.isError, false)
  assert.equal(searchSecret.output, 'No matches.')

  const searchSafe = await runReadTool(ws, 'search', { query: 'appSecretMarker' })
  assert.equal(searchSafe.isError, false)
  assert.match(searchSafe.output, /src\/app\.ts/)

  // Write/edit/patch guards block .env and self-modification of .atrium/policy.json
  await assert.rejects(() => prepareEdit(ws, { path: '.env', old_string: 'SECRET', new_string: 'X' }), /shield|policy/i)
  await assert.rejects(() => prepareWriteDiff(ws, '.env', 'OVERWRITE=1'), /shield|policy/i)
  await assert.rejects(() => writeApproved(ws, '.env', 'OVERWRITE=1'), /shield|policy/i)
  await assert.rejects(() => writeApproved(ws, '.atrium/policy.json', '{}'), /policy integrity guard|policy/i)
  await assert.rejects(
    () =>
      preparePatch(ws, {
        patch: '*** Begin Patch\n*** Add File: .env.production\n+FOO=BAR\n*** End Patch',
      }),
    /shield|policy/i,
  )

  // Command policy checks: blocks reading secrets, avoids false positives on NODE_ENV / .env.example
  const cmdBlockEnv = await evaluateCommandPolicy(ws, 'cat .env')
  assert.equal(cmdBlockEnv.allowed, false)
  const cmdBlockSsh = await evaluateCommandPolicy(ws, 'cat ~/.ssh/id_rsa')
  assert.equal(cmdBlockSsh.allowed, false)
  const cmdAllowEnvVar = await evaluateCommandPolicy(ws, 'NODE_ENV=production npm test')
  assert.equal(cmdAllowEnvVar.allowed, true)
  const cmdAllowExample = await evaluateCommandPolicy(ws, 'cat .env.example')
  assert.equal(cmdAllowExample.allowed, true)

  // Save project + local policies and verify merge/override semantics
  await saveWorkspacePolicy(ws, 'project', {
    denyRead: ['docs/internal/**'],
    denyWrite: ['src/locked.ts'],
    denyCommands: ['terraform destroy'],
    sandboxMode: 'workspace_write',
    allowNetwork: false,
  })
  await mkdir(join(ws, 'docs', 'internal'), { recursive: true })
  await writeFile(join(ws, 'docs', 'internal', 'plan.md'), 'secret roadmap', 'utf8')
  await writeFile(join(ws, 'src', 'locked.ts'), 'export const v = 1\n', 'utf8')

  const projDenied = await runReadTool(ws, 'read_file', { path: 'docs/internal/plan.md' })
  assert.equal(projDenied.isError, true)

  await assert.rejects(() => prepareWriteDiff(ws, 'src/locked.ts', 'export const v = 2'), /denyWrite/i)
  const cmdProjDeny = await evaluateCommandPolicy(ws, 'terraform destroy -auto-approve')
  assert.equal(cmdProjDeny.allowed, false)

  // Sandbox floor enforcement
  const inspection = await inspectWorkspacePolicy(ws)
  const eff = resolveEffectiveSandbox('off', true, inspection)
  assert.equal(eff.sandboxMode, 'workspace_write')
  assert.equal(eff.allowNetwork, false)

  // Local override allowRead takes precedence over project denyRead & defaults
  await saveWorkspacePolicy(ws, 'local', {
    allowRead: ['docs/internal/**'],
  })
  const localAllowed = await runReadTool(ws, 'read_file', { path: 'docs/internal/plan.md' })
  assert.equal(localAllowed.isError, false)
  assert.match(localAllowed.output, /secret roadmap/)

  const checkBlocked = await evaluateFileWritePolicy(ws, 'src/locked.ts')
  assert.equal(checkBlocked.allowed, false)
  const checkAllowedRead = await evaluateFileReadPolicy(ws, 'docs/internal/plan.md')
  assert.equal(checkAllowedRead.allowed, true)
})

test('Preview engine: extracts URLs, launches real local server, opens mock Chromium, captures logs, and stops cleanly', { timeout: 25_000 }, async (t) => {
  // Pure URL extraction checks
  assert.deepEqual(extractLocalServerUrl('\x1b[32m➜\x1b[0m  Local:   http://0.0.0.0:5173/app'), {
    url: 'http://127.0.0.1:5173/app',
    port: 5173,
  })
  assert.deepEqual(extractLocalServerUrl('Listening on port 8080'), {
    url: 'http://127.0.0.1:8080',
    port: 8080,
  })

  const ws = await mkdtemp(join(tmpdir(), 'atrium-preview-'))
  const manager = new PreviewServerManager()
  t.after(async () => {
    manager.shutdown()
    await new Promise((r) => setTimeout(r, 150))
    await rm(ws, { recursive: true, force: true })
  })

  // Write a tiny local Node HTTP server script listening on ephemeral port 0
  await writeFile(
    join(ws, 'dev-server.mjs'),
    [
      "import http from 'node:http';",
      "const srv = http.createServer((_req, res) => {",
      "  console.log('served request');",
      "  res.writeHead(200, { 'content-type': 'text/html' });",
      "  res.end('<h1>Atrium Preview OK</h1>');",
      '});',
      "srv.listen(0, '127.0.0.1', () => {",
      "  const port = srv.address().port;",
      "  console.log('Local: http://0.0.0.0:' + port + '/');",
      '});',
    ].join('\n'),
    'utf8',
  )

  const openedUrls: Array<{ url: string; cid?: string }> = []
  let reloadCount = 0
  const fakeImg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  const fakeBridge: BrowserHostBridge = {
    open: async (url, cid) => {
      openedUrls.push({ url, cid })
      return {
        conversationId: cid,
        open: true,
        url,
        title: 'Atrium Preview App',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        screenshotDataUrl: fakeImg,
        screenshotWidth: 800,
        screenshotHeight: 600,
        elements: [{ ref: 'e1', tag: 'button', role: 'button', text: 'Click me' }],
        consoleLogs: [{ level: 'error', text: 'Uncaught ReferenceError: demoErr', at: Date.now() }],
      } satisfies BrowserSnapshot
    },
    action: async (act, cid) => {
      if (act.kind === 'reload') reloadCount++
      return {
        conversationId: cid,
        open: true,
        url: openedUrls[0]?.url ?? 'http://127.0.0.1',
        title: 'Atrium Preview App (Reloaded)',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        screenshotDataUrl: fakeImg,
        elements: [],
        consoleLogs: [],
      }
    },
    capture: async (cid) => ({
      conversationId: cid,
      open: true,
      url: openedUrls[0]?.url ?? 'http://127.0.0.1',
      title: 'Atrium Preview App',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      screenshotDataUrl: fakeImg,
      elements: [],
      consoleLogs: [],
    }),
    evalScript: async () => ({ value: 'ok' }),
  }

  const startRes = await runPreviewTool(
    manager,
    fakeBridge,
    'preview_start',
    { command: 'node dev-server.mjs', readyTimeoutSeconds: 10 },
    { workspace: ws, conversationId: 'chat_prev_1' },
  )

  assert.equal(startRes.isError, false)
  assert.match(startRes.output, /Ready: yes/)
  assert.match(startRes.output, /Atrium Preview App/)
  assert.match(startRes.output, /Uncaught ReferenceError: demoErr/)
  assert.equal(startRes.images?.length, 1)
  assert.equal(openedUrls.length, 1)
  assert.equal(openedUrls[0]!.cid, 'chat_prev_1')
  const detectedUrl = openedUrls[0]!.url
  assert.equal(await probeLocalHttpUrl(detectedUrl, 1000), true)

  // Inspect preview_logs with reload
  const logsRes = await runPreviewTool(
    manager,
    fakeBridge,
    'preview_logs',
    { reloadBrowser: true },
    { workspace: ws, conversationId: 'chat_prev_1' },
  )
  assert.equal(logsRes.isError, false)
  assert.equal(reloadCount, 1)
  assert.match(logsRes.output, /http:\/\/127\.0\.0\.1:/)
  assert.equal(logsRes.images?.length, 1)

  // Stop preview server and confirm port is no longer listening
  const stopRes = await runPreviewTool(
    manager,
    fakeBridge,
    'preview_stop',
    {},
    { workspace: ws, conversationId: 'chat_prev_1' },
  )
  assert.equal(stopRes.isError, false)
  assert.match(stopRes.output, /Stopped 1 preview server/)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(await probeLocalHttpUrl(detectedUrl, 400), false)

  // Fast-failing server command returns immediately with error instead of waiting timeout
  const failRes = await runPreviewTool(
    manager,
    fakeBridge,
    'preview_start',
    { command: 'node -e "console.error(\'boom\'); process.exit(2)"', readyTimeoutSeconds: 10 },
    { workspace: ws, conversationId: 'chat_prev_2' },
  )
  assert.equal(failRes.isError, true)
  assert.match(failRes.output, /exited with code 2|boom/)
})

test('Worktree Fleet: launches parallel worktree agents, tracks diffs, merges cleanly, and discards sibling', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-fleet-'))
  const repo = join(root, 'repo')
  const dataDir = join(root, 'data')
  await mkdir(repo, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // Initialize a temporary Git repo with an initial commit
  await runGitTest(repo, ['init'])
  await runGitTest(repo, ['config', 'user.email', 'test@atrium.local'])
  await runGitTest(repo, ['config', 'user.name', 'Atrium Test'])
  await writeFile(join(repo, 'README.md'), '# Base Repo\n', 'utf8')
  await runGitTest(repo, ['add', '-A'])
  await runGitTest(repo, ['commit', '-m', 'init'])

  // Mock OpenAI SSE model handling two concurrent conversations independently
  const turnSeenByChat = new Map<string, number>()
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content?: string }>
      }
      const firstUser = parsed.messages?.find((m) => m.role === 'user')?.content ?? ''
      const isAlpha = String(firstUser).includes('ALPHA_FILE')
      const key = isAlpha ? 'alpha' : 'beta'
      const step = (turnSeenByChat.get(key) ?? 0) + 1
      turnSeenByChat.set(key, step)
      const targetFile = isAlpha ? 'alpha.txt' : 'beta.txt'
      const targetText = isAlpha ? 'from alpha worktree\n' : 'from beta worktree\n'

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta: object, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)

      if (step === 1) {
        const args = JSON.stringify({ path: targetFile, content: targetText })
        send({
          tool_calls: [{ index: 0, id: `call_${key}`, type: 'function', function: { name: 'write_file', arguments: args } }],
        })
        send({}, 'tool_calls')
      } else {
        send({ content: `Completed ${targetFile}` })
        send({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const port = (server.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}/v1`

  const settings = {
    activeProvider: () => ({ id: 'mock', name: 'Mock', protocol: 'openai', baseUrl, model: 'mock-1', hasKey: true }),
    providerKey: async () => 'test-key',
    get: () => ({ workspace: repo, agentMode: 'accept_edits', copyEnvOnWorktree: true }),
  } as unknown as SettingsStore
  const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
  const chats = new ChatStore(dataDir)
  await chats.load()
  const checkpoints = new CheckpointStore(dataDir)

  const finished = new Set<string>()
  const events: AgentEvent[] = []
  const agent = new AgentLoop({
    settings,
    mcp,
    dataDir,
    checkpoints,
    emit: (e) => {
      events.push(e)
      if (e.type === 'turn_end') finished.add(e.conversationId)
    },
    save: async (conv) => {
      await chats.save(conv)
    },
    systemPrompt: () => 'test fleet agent',
  })

  const fleet = new WorktreeFleetManager({
    chats,
    agent,
    settings,
    checkpoints,
    dataDir,
    onChatsChanged: () => undefined,
    emitAgent: () => undefined,
  })

  const launchRes = await fleet.launch({
    baseWorkspace: repo,
    tasks: [
      { prompt: 'Create ALPHA_FILE', title: 'Alpha Task' },
      { prompt: 'Create BETA_FILE', title: 'Beta Task' },
    ],
  })

  assert.equal(launchRes.errors.length, 0)
  assert.equal(launchRes.launched.length, 2)
  const [alpha, beta] = launchRes.launched

  // Wait for both parallel worktree runs to complete
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && (!finished.has(alpha!.conversationId) || !finished.has(beta!.conversationId))) {
    await new Promise((r) => setTimeout(r, 40))
  }
  assert.equal(finished.has(alpha!.conversationId), true)
  assert.equal(finished.has(beta!.conversationId), true)

  // Verify isolation: neither file exists in base repo yet, each exists only in its own worktree
  assert.equal(existsSync(join(repo, 'alpha.txt')), false)
  assert.equal(existsSync(join(repo, 'beta.txt')), false)
  assert.equal(await readFile(join(alpha!.worktreePath, 'alpha.txt'), 'utf8'), 'from alpha worktree\n')
  assert.equal(await readFile(join(beta!.worktreePath, 'beta.txt'), 'utf8'), 'from beta worktree\n')

  // List & inspect diff
  const listed = await fleet.list(repo)
  assert.equal(listed.length, 2)
  const alphaCard = listed.find((w) => w.conversationId === alpha!.conversationId)!
  assert.equal(alphaCard.status, 'idle')
  assert.ok(alphaCard.changedFiles >= 1)
  assert.ok(alphaCard.additions >= 1)

  const diffRes = await fleet.inspectDiff(alpha!.conversationId)
  assert.ok(diffRes.files.some((f) => f.path === 'alpha.txt'))

  // Merge Alpha cleanly back into base repo
  const mergeRes = await fleet.merge(alpha!.conversationId, { cleanupWorktree: true })
  assert.equal(mergeRes.cleanedUp, true)
  const mergedContent = (await readFile(join(repo, 'alpha.txt'), 'utf8')).replace(/\r\n/g, '\n')
  assert.equal(mergedContent, 'from alpha worktree\n')
  assert.equal(existsSync(alpha!.worktreePath), false)

  // Discard Beta cleanly
  await fleet.discard(beta!.conversationId)
  assert.equal(existsSync(beta!.worktreePath), false)
  const remaining = await fleet.list(repo)
  assert.equal(remaining.length, 0)
})

async function captureCliRun(
  argv: string[],
  homeDir: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdin = new PassThrough()
  stdin.end()
  const stdoutStream = new PassThrough()
  const stderrStream = new PassThrough()
  let out = ''
  let err = ''
  stdoutStream.setEncoding('utf8')
  stderrStream.setEncoding('utf8')
  stdoutStream.on('data', (chunk: string) => {
    out += chunk
  })
  stderrStream.on('data', (chunk: string) => {
    err += chunk
  })
  const code = await runCli(argv, {
    stdin,
    stdout: stdoutStream,
    stderr: stderrStream,
    homeDir,
    requireAccount: false,
  })
  return { code, stdout: out, stderr: err }
}

test('CLI parity: atrium policy, fleet subcommands, and runtime PreviewServerManager cleanup', { timeout: 25_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-cli-parity-'))
  const ws = join(root, 'workspace')
  const homeDir = join(root, 'home')
  await mkdir(ws, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  t.after(async () => {
    invalidatePolicyCache(ws)
    await rm(root, { recursive: true, force: true })
  })

  // Parser checks
  const parsedPolicy = parseCliArgs(['policy', 'check', '.env', '--json', '-C', ws])
  assert.equal(parsedPolicy.command, 'policy')
  assert.equal(parsedPolicy.json, true)
  assert.equal(parsedPolicy.workspace, ws)
  assert.deepEqual(parsedPolicy.subArgs, ['check', '.env'])

  const parsedFleet = parseCliArgs(['fleet', 'list', '--json', '-C', ws])
  assert.equal(parsedFleet.command, 'fleet')
  assert.equal(parsedFleet.json, true)
  assert.deepEqual(parsedFleet.subArgs, ['list'])

  // `atrium policy status --json`
  const stRes = await captureCliRun(['policy', 'status', '--json', '-C', ws], homeDir)
  assert.equal(stRes.code, 0)
  const stJson = JSON.parse(stRes.stdout) as { protectSensitiveFiles: boolean }
  assert.equal(stJson.protectSensitiveFiles, true)

  // `atrium policy check .env --json` vs `.env.example`
  const blockRes = await captureCliRun(['policy', 'check', '.env', '--json', '-C', ws], homeDir)
  assert.equal(blockRes.code, 0)
  assert.equal(JSON.parse(blockRes.stdout).allowed, false)

  const allowRes = await captureCliRun(['policy', 'check', '.env.example', '--json', '-C', ws], homeDir)
  assert.equal(allowRes.code, 0)
  assert.equal(JSON.parse(allowRes.stdout).allowed, true)

  // `atrium policy deny-read` + verify enforcement
  const addRuleRes = await captureCliRun(['policy', 'deny-read', 'internal/**', '-C', ws], homeDir)
  assert.equal(addRuleRes.code, 0)
  const customBlock = await captureCliRun(['policy', 'check', 'internal/secret.txt', '--json', '-C', ws], homeDir)
  assert.equal(customBlock.code, 0)
  assert.equal(JSON.parse(customBlock.stdout).allowed, false)

  // `atrium fleet list --json` on non-worktree workspace returns empty list
  const fleetRes = await captureCliRun(['fleet', 'list', '--json', '-C', ws], homeDir)
  assert.equal(fleetRes.code, 0)
  assert.deepEqual(JSON.parse(fleetRes.stdout), [])

  // CliRuntime wires previews and cleans them up cleanly on dispose()
  await writeFile(
    join(ws, 'cli-preview.mjs'),
    [
      "import http from 'node:http';",
      "const s = http.createServer((_q, r) => { r.writeHead(200); r.end('ok'); });",
      "s.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + s.address().port));",
    ].join('\n'),
    'utf8',
  )
  const rt = await createCliRuntime({
    homeDir,
    workspace: ws,
    requireAccount: false,
    connectMcp: false,
  })
  const started = await rt.previews.start({
    workspace: ws,
    command: 'node cli-preview.mjs',
    readyTimeoutMs: 10_000,
  })
  assert.equal(started.ready, true)
  assert.ok(started.server.url)
  assert.equal(await probeLocalHttpUrl(started.server.url!, 1000), true)

  await rt.dispose()
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(await probeLocalHttpUrl(started.server.url!, 400), false)
})
