// End-to-end & unit tests for Atrium's cross-platform CLI (secrets, arg parser, runtime, REPL/one-shot, bundle).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { promisify } from 'node:util'
import { formatHelpText, parseCliArgs } from '../src/cli/args.ts'
import { expandFileMentions } from '../src/cli/commands.ts'
import { filterComposerDropdown, readComposerInput } from '../src/cli/composer.ts'
import { CLI_VERSION, runCli } from '../src/cli/index.ts'
import { createMarkdownStream, renderMarkdown } from '../src/cli/markdown.ts'
import { createPalette, formatColoredDiff } from '../src/cli/render.ts'
import { createCliRuntime } from '../src/cli/runtime.ts'
import { CliSecretStore } from '../src/cli/secrets.ts'
import { parseSelectKey, selectOption, stripAnsi, visibleWidth } from '../src/cli/select.ts'
import { CLI_THEME_IDS, createThemePalette, justifyRow } from '../src/cli/theme.ts'
import { renderAtriumEmblem, renderProgressBar, renderWelcomeScreen } from '../src/cli/ui.ts'
import { createTerminalViewport } from '../src/cli/viewport.ts'

const execFileAsync = promisify(execFile)

type MockReply = { text?: string; tool?: { name: string; args: string } }

async function startMockOpenAiServer(replies: MockReply[]): Promise<{
  server: Server
  baseUrl: string
  requests: Array<Record<string, unknown>>
}> {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      const reply = replies.shift() ?? { text: 'done' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const emitDelta = (delta: object, finishReason: string | null = null) => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      }
      if (reply.tool) {
        const mid = Math.floor(reply.tool.args.length / 2)
        emitDelta({
          tool_calls: [
            {
              index: 0,
              id: 'call_cli_1',
              type: 'function',
              function: { name: reply.tool.name, arguments: reply.tool.args.slice(0, mid) },
            },
          ],
        })
        emitDelta(
          {
            tool_calls: [{ index: 0, function: { arguments: reply.tool.args.slice(mid) } }],
          },
          'tool_calls',
        )
      } else {
        for (const word of (reply.text ?? '').split(' ')) {
          emitDelta({ content: `${word} ` })
        }
        emitDelta({}, 'stop')
      }
      res.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = (server.address() as { port: number }).port
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, requests }
}

function collectStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough()
  const chunks: Buffer[] = []
  stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))))
  return {
    stream,
    text: () => Buffer.concat(chunks).toString('utf8'),
  }
}

test('CliSecretStore encrypts at rest, reloads cleanly, and deletes keys', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-cli-sec-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const secret = 'sk-test-secret-token-value-123456'
  const store1 = new CliSecretStore(dir)
  await store1.load()
  await store1.set('provider:p1:apiKey', secret)
  await store1.set('provider:p2:apiKey', 'second-secret')

  const rawFile = await readFile(join(dir, 'secrets.enc.json'), 'utf8')
  assert.equal(rawFile.includes(secret), false, 'plaintext secret must never appear on disk')

  const store2 = new CliSecretStore(dir)
  await store2.load()
  assert.equal(await store2.get('provider:p1:apiKey'), secret)
  assert.equal(await store2.get('provider:p2:apiKey'), 'second-secret')

  await store2.set('provider:p1:apiKey', 'rotated-secret')
  assert.equal(await store2.get('provider:p1:apiKey'), 'rotated-secret')

  await store2.set('provider:p1:apiKey', null)
  assert.equal(await store2.get('provider:p1:apiKey'), null)
})

test('parseCliArgs handles subcommands, flags, accept_edits mode, resume, and errors', () => {
  const a1 = parseCliArgs(['-C', './repo', '-m', 'gpt-5', '--mode', 'accept_edits', '-y', '--json', '-p', 'fix tests'])
  assert.equal(a1.command, 'chat')
  assert.equal(a1.workspace, './repo')
  assert.equal(a1.model, 'gpt-5')
  assert.equal(a1.mode, 'accept_edits')
  assert.equal(a1.yes, true)
  assert.equal(a1.json, true)
  assert.equal(a1.prompt, 'fix tests')

  const a2 = parseCliArgs(['login', 'user@example.com', '--code', '123456'])
  assert.equal(a2.command, 'login')
  assert.equal(a2.email, 'user@example.com')
  assert.equal(a2.code, '123456')

  const a3 = parseCliArgs(['--resume'])
  assert.equal(a3.resume, true)

  const a4 = parseCliArgs(['--', '--not-a-flag', 'prompt'])
  assert.equal(a4.prompt, '--not-a-flag prompt')

  const a5 = parseCliArgs(['doctor', '--json'])
  assert.equal(a5.command, 'doctor')
  assert.equal(a5.json, true)

  assert.throws(() => parseCliArgs(['--unknown-flag']), /Unknown option/)
  assert.throws(() => parseCliArgs(['--mode', 'invalid']), /Invalid permission mode/)
  assert.ok(formatHelpText(CLI_VERSION).includes('accept_edits'))
  assert.ok(formatHelpText(CLI_VERSION).includes('doctor'))
})

test('runCli executes BYOK streaming turn, tool calls, piped stdin, status/models, and --json NDJSON', { timeout: 25_000 }, async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), 'atrium-cli-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'atrium-cli-ws-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  t.after(() => rm(workspace, { recursive: true, force: true }))

  await writeFile(join(workspace, 'note.txt'), 'secret cliff note', 'utf8')

  const mock = await startMockOpenAiServer([
    { tool: { name: 'read_file', args: '{"path":"note.txt"}' } },
    { text: 'Read note successfully' },
    { text: 'NDJSON streamed ok' },
  ])
  t.after(() => {
    mock.server.closeAllConnections?.()
    mock.server.close()
  })

  // 1. Before provider/login exists, one-shot fails cleanly with exit code 1 and no internal gateway leaks.
  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['-p', 'hello'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 1)
    assert.match(err.text(), /atrium login/i)
    assert.equal(/rpulse|relaypulse/i.test(err.text()), false)
  }

  // 2. Seed a BYOK provider using CliRuntime directly (verifies BYOK works without Atrium Cloud login).
  {
    const rt = await createCliRuntime({ homeDir, workspace })
    try {
      const saved = await rt.settings.saveProvider({
        name: 'Local Mock OpenAI',
        protocol: 'openai',
        baseUrl: mock.baseUrl,
        model: 'mock-gpt',
        models: ['mock-gpt', 'mock-gpt-mini'],
        apiKey: 'mock-api-key',
      })
      await rt.settings.update({ activeProviderId: saved.id })
    } finally {
      await rt.dispose()
    }
  }

  // 3. `status --json` & `models --json`
  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['status', '--json'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const parsed = JSON.parse(out.text()) as { activeProvider: { model: string } | null }
    assert.equal(parsed.activeProvider?.model, 'mock-gpt')
  }

  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['models', '--json'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const parsed = JSON.parse(out.text()) as { providers: Array<{ models: string[] }> }
    assert.deepEqual(parsed.providers[0]?.models, ['mock-gpt', 'mock-gpt-mini'])
  }

  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['doctor', '--json', '-C', workspace], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const doc = JSON.parse(out.text()) as {
      version: string
      platform: string
      homeDir: string
      providerCount: number
      activeProvider: { model: string } | null
    }
    assert.equal(doc.version, CLI_VERSION)
    assert.equal(doc.platform, process.platform)
    assert.equal(doc.providerCount, 1)
    assert.equal(doc.activeProvider?.model, 'mock-gpt')
  }

  // 4. One-shot turn with read_file tool call + piped stdin context
  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['-C', workspace, '-y', '-p', 'check note.txt'], {
      homeDir,
      stdin: Readable.from(['From stdin pipe']),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    assert.match(out.text(), /Read note successfully/)
    assert.ok(mock.requests.length >= 2)
    const firstMsgs = mock.requests[0]!.messages as Array<{ role: string; content: string }>
    const userMsg = firstMsgs.find((m) => m.role === 'user')
    assert.ok(userMsg?.content.includes('From stdin pipe'))
    assert.ok(userMsg?.content.includes('check note.txt'))
  }

  // 5. `--json` NDJSON event stream + `-m` model override
  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['-C', workspace, '-m', 'mock-gpt-mini', '--json', '-p', 'ping'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const events = out
      .text()
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string })
    assert.ok(events.some((e) => e.type === 'turn_start'))
    assert.ok(events.some((e) => e.type === 'text_delta'))
    assert.equal(events.at(-1)?.type, 'turn_end')
    assert.equal(mock.requests.at(-1)?.model, 'mock-gpt-mini')
  }
})

test('built CJS bundle executes --version and --help cleanly when present', async () => {
  const bundlePath = resolve(process.cwd(), 'dist-cli/atrium.cjs')
  let exists = true
  try {
    await access(bundlePath)
  } catch {
    exists = false
  }
  if (!exists) return

  const ver = await execFileAsync(process.execPath, [bundlePath, '--version'])
  assert.match(ver.stdout, new RegExp(`^atrium v${CLI_VERSION.replace(/\./g, '\\.')}`))

  const help = await execFileAsync(process.execPath, [bundlePath, '--help'])
  assert.match(help.stdout, /Usage:/)
  assert.match(help.stdout, /Interactive Slash Commands/)

  const pkgBinPath = resolve(process.cwd(), 'packages/cli/bin/atrium.cjs')
  let pkgBinExists = true
  try {
    await access(pkgBinPath)
  } catch {
    pkgBinExists = false
  }
  if (pkgBinExists) {
    const [distContent, pkgContent] = await Promise.all([readFile(bundlePath, 'utf8'), readFile(pkgBinPath, 'utf8')])
    assert.equal(pkgContent, distContent)
  }
})

test('@atrium-ai/cli package metadata declares bin.atrium and zero runtime deps', async () => {
  const rootPkg = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }
  const cliPkg = JSON.parse(await readFile(resolve(process.cwd(), 'packages/cli/package.json'), 'utf8')) as {
    version: string
    bin?: Record<string, string>
    dependencies?: Record<string, string>
  }
  assert.equal(cliPkg.version, rootPkg.version)
  assert.equal(cliPkg.bin?.atrium, './bin/atrium.cjs')
  assert.deepEqual(cliPkg.dependencies ?? {}, {})
})

test('parseSelectKey decodes arrows, vim navigation, confirm, cancel, digits, and shortcuts', () => {
  assert.deepEqual(parseSelectKey('\x1b[A'), { kind: 'up' })
  assert.deepEqual(parseSelectKey('\x1bOA'), { kind: 'up' })
  assert.deepEqual(parseSelectKey('k'), { kind: 'up' })
  assert.deepEqual(parseSelectKey('\x1b[B'), { kind: 'down' })
  assert.deepEqual(parseSelectKey('\x1bOB'), { kind: 'down' })
  assert.deepEqual(parseSelectKey('j'), { kind: 'down' })
  assert.deepEqual(parseSelectKey('\r'), { kind: 'confirm' })
  assert.deepEqual(parseSelectKey('\x1b'), { kind: 'cancel' })
  assert.deepEqual(parseSelectKey('\u0003'), { kind: 'cancel' })
  assert.deepEqual(parseSelectKey('2'), { kind: 'digit', index: 1 })

  const approvalOpts = [
    { value: 'allow', label: 'Allow once', shortcut: 'y' },
    { value: 'allow_session', label: 'Session', shortcut: 's' },
    { value: 'deny', label: 'Deny', shortcut: 'n' },
  ] as const
  assert.deepEqual(parseSelectKey('S', approvalOpts), { kind: 'shortcut', index: 1 })
})

test('selectOption supports TTY arrow-key navigation, wrap-around, shortcuts, Esc cancel, and non-TTY fallback', async () => {
  const makeMockTtyInput = () => {
    const rawCalls: boolean[] = []
    const stream = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: (mode: boolean) => {
        rawCalls.push(mode)
        return stream
      },
    })
    return { stream, rawCalls }
  }

  // 1. Down -> Down -> Enter picks 3rd item and restores cursor/raw mode.
  {
    const { stream: inStream, rawCalls } = makeMockTtyInput()
    const out = collectStream()
    const outStream = Object.assign(out.stream, { isTTY: true, columns: 80 })
    const promise = selectOption({
      title: 'Pick provider',
      options: [
        { value: 'openai', label: 'OpenAI' },
        { value: 'anthropic', label: 'Anthropic' },
        { value: 'responses', label: 'Responses' },
      ],
      stdin: inStream,
      stdout: outStream,
    })
    inStream.write('\x1b[B')
    inStream.write('\x1b[B')
    inStream.write('\r')
    const picked = await promise
    assert.equal(picked, 'responses')
    assert.deepEqual(rawCalls, [true, false])
    assert.ok(out.text().includes('\x1b[?25h'))
  }

  // 2. Up wrap-around picks last option.
  {
    const { stream: inStream } = makeMockTtyInput()
    const out = collectStream()
    const outStream = Object.assign(out.stream, { isTTY: true, columns: 80 })
    const promise = selectOption({
      title: 'Pick mode',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
        { value: 'c', label: 'Gamma' },
      ],
      stdin: inStream,
      stdout: outStream,
    })
    inStream.write('\x1b[A\r')
    assert.equal(await promise, 'c')
  }

  // 3. Shortcut key selects immediately; Esc cancels cleanly.
  {
    const { stream: inStream } = makeMockTtyInput()
    const out = collectStream()
    const outStream = Object.assign(out.stream, { isTTY: true, columns: 80 })
    const p1 = selectOption({
      title: 'Approval',
      options: [
        { value: 'allow', label: 'Allow', shortcut: 'y' },
        { value: 'allow_session', label: 'Session', shortcut: 's' },
        { value: 'deny', label: 'Deny', shortcut: 'n' },
      ],
      stdin: inStream,
      stdout: outStream,
    })
    inStream.write('s')
    assert.equal(await p1, 'allow_session')

    const { stream: cancelStream } = makeMockTtyInput()
    const out2 = collectStream()
    const outStream2 = Object.assign(out2.stream, { isTTY: true, columns: 80 })
    const p2 = selectOption({
      title: 'Cancel test',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      stdin: cancelStream,
      stdout: outStream2,
    })
    cancelStream.write('\x1b')
    assert.equal(await p2, null)
    assert.ok(out2.text().includes('\x1b[?25h'))
  }

  // 4. Non-TTY fallback reads numbered selection cleanly.
  {
    const out = collectStream()
    const picked = await selectOption({
      title: 'Fallback select',
      options: [
        { value: 'first', label: 'First' },
        { value: 'second', label: 'Second' },
      ],
      stdin: Readable.from(['2\n']),
      stdout: out.stream,
    })
    assert.equal(picked, 'second')
  }
})

test('renderMarkdown and createMarkdownStream format headings, lists, code frames, and tables', () => {
  const colorPalette = createPalette(true)
  const plainPalette = createPalette(false)
  const sample = [
    '# Heading',
    '',
    '- item with **bold** and `code`',
    '',
    '| ColA | ColB |',
    '| --- | --- |',
    '| val1 | val2 |',
    '',
    '```ts',
    'const x = 1',
    '```',
  ].join('\n')

  const rendered = renderMarkdown(sample, colorPalette, 80)
  const plainRendered = stripAnsi(rendered)
  assert.ok(plainRendered.includes('Heading'))
  assert.ok(plainRendered.includes('•'))
  assert.ok(plainRendered.includes('┌'))
  assert.ok(plainRendered.includes('┬'))
  assert.ok(plainRendered.includes('┴'))
  assert.ok(plainRendered.includes('┘'))
  assert.ok(rendered.includes('╭─'))
  assert.ok(rendered.includes('ts'))
  assert.ok(plainRendered.includes('const x = 1'))
  assert.notEqual(rendered, plainRendered)
  assert.ok(rendered.includes('\x1b['))
  assert.ok(rendered.includes('╰'))
  assert.ok(rendered.includes('│'))

  const chunks: string[] = []
  const stream = createMarkdownStream({ write: (s) => chunks.push(s), palette: plainPalette })
  for (const ch of ['# Streamed\n', '- bullet ', 'item\n', '```js\ncon', 'sole.log(1)']) {
    stream.push(ch)
  }
  stream.flush()
  const out = chunks.join('')
  assert.ok(out.includes('Streamed'))
  assert.ok(out.includes('• bullet item'))
  assert.ok(out.includes('console.log(1)'))
  assert.ok(out.includes('╰'))
})

test('expandFileMentions attaches valid workspace files while ignoring emails and path traversal', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-cli-mentions-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  await writeFile(join(ws, 'app.ts'), 'export const hello = "world"\n', 'utf8')

  const out = collectStream()
  const palette = createPalette(false)
  const prompt = 'Contact user@example.com and inspect @app.ts and @../secret.txt'
  const expanded = await expandFileMentions(prompt, ws, out.stream, palette)

  assert.ok(expanded.includes('<attached_file path="app.ts">'))
  assert.ok(expanded.includes('export const hello = "world"'))
  assert.equal(expanded.includes('secret.txt</attached_file>'), false)
  assert.match(out.text(), /Attached app\.ts/)
})

test('renderProgressBar and renderWelcomeScreen align columns and sanitize internal brand names', () => {
  const palette = createPalette(true)
  const bar = renderProgressBar(0.5, 10, palette)
  assert.ok(bar.includes('50%'))

  for (const cols of [100, 66]) {
    const screen = renderWelcomeScreen({
      version: CLI_VERSION,
      model: 'gpt-5',
      providerName: 'OpenAI',
      protocol: 'responses',
      mode: 'auto',
      scene: 'code',
      effort: 'medium',
      workspace: '~/project',
      accountLabel: 'BYOK / Local',
      mcpConnected: 1,
      mcpTotal: 2,
      skillCount: 3,
      gitBranch: 'main',
      gitDirty: 2,
      contextUsed: 24_000,
      contextLimit: 200_000,
      cols,
      palette,
    })
    assert.equal(/rpulse|relaypulse/i.test(screen), false)
    const plain = stripAnsi(screen)
    assert.ok(plain.includes(`Atrium v${CLI_VERSION}`))
    assert.ok(plain.includes('gpt-5'))
    assert.ok(plain.includes('OpenAI'))
    assert.ok(plain.includes('~/project'))
    assert.ok(plain.includes('/model'))
    for (const line of screen.split('\n')) {
      assert.ok(visibleWidth(line) <= cols, `Line exceeded cols=${cols}: ${visibleWidth(line)}`)
    }
  }
})

test('parseCliArgs and runCli support --effort, usage --json, and mcp --json subcommands', async (t) => {
  const a1 = parseCliArgs(['--effort', 'high', '-p', 'test'])
  assert.equal(a1.effort, 'high')
  assert.equal(parseCliArgs(['usage', '--json']).command, 'usage')
  assert.equal(parseCliArgs(['mcp', '--json']).command, 'mcp')
  assert.throws(() => parseCliArgs(['--effort', 'turbo']), /Invalid --effort/)

  const homeDir = await mkdtemp(join(tmpdir(), 'atrium-cli-subcmds-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))

  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['usage', '--json'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const parsed = JSON.parse(out.text()) as { summary: { conversations: number }; contextLimitTokens: number }
    assert.equal(parsed.summary.conversations, 0)
    assert.ok(parsed.contextLimitTokens > 0)
  }

  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['mcp', '--json'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    assert.deepEqual(JSON.parse(out.text()), [])
  }
})

test('filterComposerDropdown and readComposerInput handle live slash/file dropdowns, Shift+Tab, paste, and Ctrl+C', async () => {
  const commands = [
    { cmd: '/help', hint: 'Help' },
    { cmd: '/model', hint: 'Select model' },
    { cmd: '/mode', hint: 'Select mode' },
    { cmd: '/mcp', hint: 'Manage MCP' },
  ]
  const files = ['src/cli/index.ts', 'src/cli/composer.ts', 'README.md']

  const slashDd = filterComposerDropdown('/mo', 3, commands, files)
  assert.equal(slashDd?.kind, 'command')
  assert.deepEqual(slashDd?.items.map((i) => i.label), ['/model', '/mode'])

  const fileDd = filterComposerDropdown('inspect @comp', 13, commands, files)
  assert.equal(fileDd?.kind, 'file')
  assert.equal(fileDd?.items[0]?.label, '@src/cli/composer.ts')

  const makeMockTty = () => {
    const rawCalls: boolean[] = []
    const stream = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: (m: boolean) => {
        rawCalls.push(m)
        return stream
      },
    })
    return { stream, rawCalls }
  }

  // 1. Live `/` filter -> Down -> Enter submits `/mode` cleanly and disables bracketed paste.
  {
    const { stream: inStream, rawCalls } = makeMockTty()
    const out = collectStream()
    const outStream = Object.assign(out.stream, { isTTY: true, columns: 90 })
    const promise = readComposerInput({
      stdin: inStream,
      stdout: outStream,
      commands,
      getWorkspaceFiles: () => files,
      getStatusMeta: () => ({ mode: 'auto', model: 'gpt-5', effort: 'auto', contextUsed: 1000, contextLimit: 200000 }),
      history: [],
    })
    inStream.write('/mo')
    inStream.write('\x1b[B')
    inStream.write('\r')
    const res = await promise
    assert.deepEqual(res, { kind: 'submit', text: '/mode' })
    assert.deepEqual(rawCalls, [true, false])
    assert.ok(out.text().includes('\x1b[?2004l'))
  }

  // 2. Shift+Tab triggers mode cycle + bracketed paste preserves newlines without early submit.
  {
    const { stream: inStream } = makeMockTty()
    const out = collectStream()
    const outStream = Object.assign(out.stream, { isTTY: true, columns: 90 })
    let cycled = 0
    const promise = readComposerInput({
      stdin: inStream,
      stdout: outStream,
      commands,
      getWorkspaceFiles: () => files,
      getStatusMeta: () => ({ mode: cycled ? 'accept_edits' : 'auto', model: 'gpt-5', effort: 'auto', contextUsed: 0, contextLimit: 200000 }),
      history: [],
      onCycleMode: () => {
        cycled += 1
        return 'accept_edits'
      },
    })
    inStream.write('\x1b[Z')
    await new Promise((r) => setTimeout(r, 10))
    inStream.write('\x1b[200~line1\r\nline2\x1b[201~')
    inStream.write('\r')
    const res = await promise
    assert.equal(cycled, 1)
    assert.deepEqual(res, { kind: 'submit', text: 'line1\nline2' })
  }

  // 3. Ctrl+C clears non-empty draft first, then double Ctrl+C exits cleanly.
  {
    const { stream: inStream } = makeMockTty()
    const out = collectStream()
    const outStream = Object.assign(out.stream, { isTTY: true, columns: 90 })
    const promise = readComposerInput({
      stdin: inStream,
      stdout: outStream,
      commands,
      getWorkspaceFiles: () => files,
      getStatusMeta: () => ({ mode: 'auto', model: 'gpt-5', effort: 'auto', contextUsed: 0, contextLimit: 200000 }),
      history: [],
    })
    inStream.write('draft')
    inStream.write('\u0003')
    inStream.write('\u0003')
    inStream.write('\u0003')
    const res = await promise
    assert.deepEqual(res, { kind: 'exit' })
  }
})

test('parseCliArgs and runCli support Claude-Code flags, --output-format json, -c --fork-session, and auth/mcp/plugin subcommands', async (t) => {
  const parsed = parseCliArgs([
    '-c',
    '--fork-session',
    '-n',
    'Refactor session',
    '-w',
    'feat-cli',
    '--permission-mode',
    'acceptEdits',
    '--dangerously-skip-permissions',
    '--output-format',
    'json',
    '--max-turns',
    '7',
    '--system-prompt',
    'Custom system',
    '-p',
    'hello',
  ])
  assert.equal(parsed.continueWorkspace, true)
  assert.equal(parsed.forkSession, true)
  assert.equal(parsed.sessionName, 'Refactor session')
  assert.equal(parsed.worktree, 'feat-cli')
  assert.equal(parsed.mode, 'bypass')
  assert.equal(parsed.yes, true)
  assert.equal(parsed.outputFormat, 'json')
  assert.equal(parsed.maxTurns, 7)
  assert.equal(parsed.systemPrompt, 'Custom system')
  assert.equal(parseCliArgs(['auth', 'status', '--json']).command, 'auth')
  assert.equal(parseCliArgs(['plugin', 'list']).command, 'plugin')
  assert.equal(parseCliArgs(['mcp', 'add', 'srv', '--transport', 'http', 'http://127.0.0.1:1/mcp']).command, 'mcp')

  const homeDir = await mkdtemp(join(tmpdir(), 'atrium-cli-cc-home-'))
  const ws = await mkdtemp(join(tmpdir(), 'atrium-cli-cc-ws-'))
  t.after(() => rm(homeDir, { recursive: true, force: true }))
  t.after(() => rm(ws, { recursive: true, force: true }))

  const mock = await startMockOpenAiServer([{ text: 'Single JSON output ok' }, { text: 'Forked answer' }])
  t.after(() => {
    mock.server.closeAllConnections?.()
    mock.server.close()
  })

  // Seed BYOK provider.
  {
    const rt = await createCliRuntime({ homeDir, workspace: ws })
    try {
      const saved = await rt.settings.saveProvider({
        name: 'Mock Provider',
        protocol: 'openai',
        baseUrl: mock.baseUrl,
        model: 'mock-gpt',
        models: ['mock-gpt'],
        apiKey: 'test-key',
      })
      await rt.settings.update({ activeProviderId: saved.id })
    } finally {
      await rt.dispose()
    }
  }

  // 1. `--output-format json` emits single JSON result object.
  let firstSessionId = ''
  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['-C', ws, '-p', 'hi json', '--output-format', 'json'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const obj = JSON.parse(out.text()) as { session_id: string; result: string; reason: string; model: string }
    firstSessionId = obj.session_id
    assert.ok(firstSessionId)
    assert.equal(obj.result, 'Single JSON output ok')
    assert.equal(obj.reason, 'done')
    assert.equal(obj.model, 'mock-gpt')
  }

  // 2. `-c --fork-session -n "Branched"` creates a new forked session ID instead of overwriting.
  {
    const out = collectStream()
    const err = collectStream()
    const code = await runCli(['-C', ws, '-c', '--fork-session', '-n', 'Branched', '-p', 'follow up', '--output-format', 'json'], {
      homeDir,
      stdin: Readable.from([]),
      stdout: out.stream,
      stderr: err.stream,
    })
    assert.equal(code, 0, err.text())
    const obj = JSON.parse(out.text()) as { session_id: string; result: string }
    assert.notEqual(obj.session_id, firstSessionId)
    assert.equal(obj.result, 'Forked answer')
  }

  // 3. `mcp add` -> `mcp list --json` -> `mcp remove` round-trip.
  {
    const outAdd = collectStream()
    const errAdd = collectStream()
    assert.equal(
      await runCli(['mcp', 'add', 'my-http', '--transport', 'http', 'http://127.0.0.1:1/mcp'], {
        homeDir,
        stdin: Readable.from([]),
        stdout: outAdd.stream,
        stderr: errAdd.stream,
      }),
      0,
      errAdd.text(),
    )

    const outList = collectStream()
    assert.equal(
      await runCli(['mcp', 'list', '--json'], {
        homeDir,
        stdin: Readable.from([]),
        stdout: outList.stream,
        stderr: collectStream().stream,
      }),
      0,
    )
    const listed = JSON.parse(outList.text()) as Array<{ name: string; transport: string }>
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.name, 'my-http')
    assert.equal(listed[0]?.transport, 'http')

    assert.equal(
      await runCli(['mcp', 'remove', 'my-http'], {
        homeDir,
        stdin: Readable.from([]),
        stdout: collectStream().stream,
        stderr: collectStream().stream,
      }),
      0,
    )
  }

  // 4. `auth status --json` and `plugin list --json`.
  {
    const outAuth = collectStream()
    assert.equal(
      await runCli(['auth', 'status', '--json'], {
        homeDir,
        stdin: Readable.from([]),
        stdout: outAuth.stream,
        stderr: collectStream().stream,
      }),
      0,
    )
    assert.equal((JSON.parse(outAuth.text()) as { connected: boolean }).connected, false)

    const outPlugin = collectStream()
    assert.equal(
      await runCli(['plugin', 'list', '--json'], {
        homeDir,
        stdin: Readable.from([]),
        stdout: outPlugin.stream,
        stderr: collectStream().stream,
      }),
      0,
    )
    assert.deepEqual(JSON.parse(outPlugin.text()), [])
  }
})


test('createThemePalette, justifyRow, searchable selectOption, paste folding, Ctrl+G, and framed diff/welcome UI work cleanly', async () => {
  // 1. All 5 themes close foreground colors cleanly with \x1b[39m and align justifyRow to exact width.
  for (const themeId of CLI_THEME_IDS) {
    const p = createThemePalette(true, themeId)
    assert.equal(p.themeId, themeId)
    assert.ok(p.accent('hello').endsWith('\x1b[39m'))
    assert.ok(p.cyan('code').endsWith('\x1b[39m'))
    const line = p.surfaceLine(`❯ ${p.cyan('nested')}`, 40)
    assert.equal(visibleWidth(line), 40)
    assert.equal(visibleWidth(justifyRow(p.bold('Left'), p.cyan('Right'), 36)), 36)
  }

  const makeMockTty = () => {
    const stream = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: () => stream,
    })
    return stream
  }

  // 2. Searchable selectOption narrows via typing, recovers with Backspace, and Esc clears filter before cancel.
  {
    const in1 = makeMockTty()
    const out1 = Object.assign(collectStream().stream, { isTTY: true, columns: 84 })
    const p1 = selectOption({
      title: 'Search models',
      searchable: true,
      options: [
        { value: 'openai', label: 'OpenAI GPT-5' },
        { value: 'claude', label: 'Anthropic Claude' },
        { value: 'deepseek', label: 'DeepSeek Reasoner' },
      ],
      stdin: in1,
      stdout: out1,
    })
    in1.write('clau\r')
    assert.equal(await p1, 'claude')

    const in2 = makeMockTty()
    const out2 = Object.assign(collectStream().stream, { isTTY: true, columns: 84 })
    const p2 = selectOption({
      title: 'Search recovery',
      searchable: true,
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
      stdin: in2,
      stdout: out2,
    })
    in2.write('zzz\x7f\x7f\x7fbet\r')
    assert.equal(await p2, 'b')

    const in3 = makeMockTty()
    const out3 = Object.assign(collectStream().stream, { isTTY: true, columns: 84 })
    const p3 = selectOption({
      title: 'Esc filter then cancel',
      searchable: true,
      options: [
        { value: 'x', label: 'Xray' },
        { value: 'y', label: 'Yankee' },
      ],
      stdin: in3,
      stdout: out3,
    })
    in3.write('x')
    in3.write('\x1b')
    in3.write('\x1b')
    assert.equal(await p3, null)
  }

  // 3. Composer folds large >=5-line bracketed pastes into pills and expands them cleanly on submit.
  {
    const inPaste = makeMockTty()
    const colPaste = collectStream()
    const outPaste = Object.assign(colPaste.stream, { isTTY: true, columns: 90 })
    const pPaste = readComposerInput({
      stdin: inPaste,
      stdout: outPaste,
      commands: [{ cmd: '/help', hint: 'Help' }],
      getWorkspaceFiles: () => [],
      getStatusMeta: () => ({ mode: 'auto', model: 'gpt-5', effort: 'auto', contextUsed: 0, contextLimit: 200000 }),
      history: [],
    })
    inPaste.write('Explain:\n')
    inPaste.write('\x1b[200~line1\nline2\nline3\nline4\nline5\nline6\x1b[201~')
    assert.ok(colPaste.text().includes('[Pasted text #1 +6 lines]'))
    inPaste.write('\r')
    assert.deepEqual(await pPaste, {
      kind: 'submit',
      text: 'Explain:\nline1\nline2\nline3\nline4\nline5\nline6',
    })
  }

  // 4. Ctrl+G invokes onOpenEditor and submits returned buffer cleanly.
  {
    const inEd = makeMockTty()
    const outEd = Object.assign(collectStream().stream, { isTTY: true, columns: 90 })
    let editorInputSeen = ''
    const pEd = readComposerInput({
      stdin: inEd,
      stdout: outEd,
      commands: [{ cmd: '/help', hint: 'Help' }],
      getWorkspaceFiles: () => [],
      getStatusMeta: () => ({ mode: 'plan', model: 'gpt-5', effort: 'high', contextUsed: 1000, contextLimit: 200000 }),
      history: [],
      onOpenEditor: async (cur) => {
        editorInputSeen = cur
        return 'edited from external editor'
      },
    })
    inEd.write('draft')
    inEd.write('\x07')
    await new Promise((r) => setTimeout(r, 15))
    inEd.write('\r')
    const res = await pEd
    assert.equal(editorInputSeen, 'draft')
    assert.deepEqual(res, { kind: 'submit', text: 'edited from external editor' })
  }

  // 5. Diff rendering includes parsed hunk line numbers; hero welcome aligns with recentSessions at cols=100 & cols=66.
  {
    const palette = createThemePalette(true, 'agy')
    const diffOut = formatColoredDiff(
      ['@@ -12,2 +12,2 @@', ' const a = 1', '-const b = 2', '+const b = 3'].join('\n'),
      palette,
      20,
      70,
    )
    const plainDiff = stripAnsi(diffOut)
    assert.ok(plainDiff.includes('12'))
    assert.ok(plainDiff.includes('- const b = 2'))
    assert.ok(plainDiff.includes('+ const b = 3'))

    for (const cols of [100, 66]) {
      const screen = renderWelcomeScreen({
        version: CLI_VERSION,
        model: 'gpt-5',
        providerName: 'OpenAI',
        protocol: 'responses',
        mode: 'accept_edits',
        scene: 'code',
        effort: 'high',
        workspace: '~/repo',
        accountLabel: 'user@example.com',
        userName: 'Alex',
        mcpConnected: 2,
        mcpTotal: 2,
        skillCount: 5,
        pluginCount: 2,
        instructionFiles: ['AGENTS.md'],
        recentSessions: [
          { title: 'Refactor terminal composer', updatedAt: Date.now() - 180_000, messageCount: 6 },
          { title: 'Debug SSE retry logic', updatedAt: Date.now() - 7_200_000, messageCount: 12 },
        ],
        themeName: 'AGY Cobalt',
        gitBranch: 'feat/tui',
        gitDirty: 1,
        contextUsed: 42_000,
        contextLimit: 200_000,
        cols,
        palette,
      })
      assert.equal(/rpulse|relaypulse/i.test(screen), false)
      const plain = stripAnsi(screen)
      assert.ok(plain.includes(`Atrium v${CLI_VERSION}`))
      assert.ok(plain.includes('Using gpt-5 (OpenAI) · /model'))
      assert.ok(plain.includes('AGENTS.md'))
      for (const line of screen.split('\n')) {
        assert.ok(visibleWidth(line) <= cols, `Header exceeded cols=${cols}: ${visibleWidth(line)}`)
      }
    }
  }

  // 6. Atrium prism emblem renders a 7x14 half-block silhouette across all themes and plain/minimal modes.
  {
    const plainRows = renderAtriumEmblem(createThemePalette(false))
    assert.deepEqual(plainRows, [
      '    ▄▄██▄▄    ',
      ' ▄▄▄▀▀▀▀▀██▄▄ ',
      ' ██▀  ▄▄  ▀█▀ ',
      ' ██  ████  ▄▄ ',
      ' ██▄ ▀██▀ ▄██ ',
      ' ▀▀██ ▄▄▄██▀▀ ',
      '      ██▀▀    ',
    ])
    for (const row of plainRows) {
      assert.equal(visibleWidth(row), 14)
      assert.equal(stripAnsi(row), row)
    }

    const minimalRows = renderAtriumEmblem(createThemePalette(true, 'minimal'))
    assert.equal(minimalRows.length, 7)
    assert.equal(/\x1b\[48;/.test(minimalRows.join('\n')), false)
    for (let i = 0; i < minimalRows.length; i += 1) {
      assert.equal(visibleWidth(minimalRows[i]!), 14)
      assert.equal(stripAnsi(minimalRows[i]!), plainRows[i])
    }

    const maskShape = (row: string) => stripAnsi(row).replace(/[█▀▄]/g, '#')
    for (const themeId of CLI_THEME_IDS) {
      const themedRows = renderAtriumEmblem(createThemePalette(true, themeId))
      assert.equal(themedRows.length, 7)
      for (let i = 0; i < themedRows.length; i += 1) {
        assert.equal(visibleWidth(themedRows[i]!), 14)
        assert.equal(maskShape(themedRows[i]!), maskShape(plainRows[i]!))
      }
    }

    const warmRows = renderAtriumEmblem(createThemePalette(true, 'warm-studio'))
    assert.ok(/\x1b\[38;/.test(warmRows.join('\n')))
    assert.ok(/\x1b\[48;/.test(warmRows.join('\n')))
  }
})

test('createTerminalViewport DECSTBM scroll region, dock shrink restore, effort row, and ? shortcuts drawer work cleanly', async () => {
  // 1. Mock TTY with rows=30, cols=100 activates DECSTBM scroll region and restores tail rows on shrink.
  {
    const col = collectStream()
    const rawOut = Object.assign(col.stream, { isTTY: true, columns: 100, rows: 30 })
    const vp = createTerminalViewport(rawOut)
    assert.equal(vp.enabled, true)

    vp.init(5)
    assert.ok(col.text().includes('\x1b[2J\x1b[H'))
    assert.ok(col.text().includes('\x1b[1;25r'))

    const transcriptLines = Array.from({ length: 24 }, (_, idx) => `Transcript line ${idx + 1}`).join('\n') + '\n'
    vp.transcriptStream.write(transcriptLines)

    const tallDock = Array.from({ length: 12 }, (_, idx) => `Dock row ${idx + 1}`)
    vp.renderDock(tallDock, { row: 2, col: 4 })
    assert.ok(col.text().includes('\x1b[19;1H'))
    assert.ok(col.text().includes('\x1b[21;5H\x1b[?25h'))

    const shortDock = ['effort', '---', '❯ ', '---', 'mode']
    vp.renderDock(shortDock, { row: 2, col: 2 })
    // Collapsing from row 19 -> row 26 must explicitly repaint rows 19..25 from transcript tail.
    assert.ok(col.text().includes('\x1b[19;1H\x1b[2KTranscript line 19'))
    assert.ok(col.text().includes('\x1b[24;1H\x1b[2KTranscript line 24'))

    vp.dispose()
    assert.ok(col.text().includes('\x1b[r\x1b[30;1H\x1b[?25h'))
  }

  // 2. Composer shows `◐ medium · /effort`, `?` toggles shortcuts only when empty, and `why?` types `?`.
  {
    const inStream = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: () => inStream,
    })
    const col = collectStream()
    const outStream = Object.assign(col.stream, { isTTY: true, columns: 96 })
    const promise = readComposerInput({
      stdin: inStream,
      stdout: outStream,
      commands: [{ cmd: '/help', hint: 'Show help' }],
      getWorkspaceFiles: () => [],
      getStatusMeta: () => ({ mode: 'manual', model: 'gpt-5', effort: 'medium', contextUsed: 0, contextLimit: 200000 }),
      history: [],
    })

    inStream.write('?')
    const afterOpen = stripAnsi(col.text())
    assert.ok(afterOpen.includes('◐ medium · /effort'))
    assert.ok(afterOpen.includes('for bash mode'))
    assert.ok(afterOpen.includes('for commands'))

    inStream.write('why?')
    inStream.write('\r')
    const res = await promise
    assert.deepEqual(res, { kind: 'submit', text: 'why?' })
  }
})
