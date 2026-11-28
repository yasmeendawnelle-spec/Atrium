import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { ChatStore } from '../src/core/chats.ts'
import { SettingsStore } from '../src/core/settings.ts'
import {
  discoverExternalSessions,
  importExternalSessions,
  normalizeImportedMessages,
  parseDshLogFilename,
  scanZstdFrames,
} from '../src/core/sessionImport.ts'
import { toAnthropicMessages } from '../src/core/providers/anthropic.ts'
import { toResponsesInput } from '../src/core/providers/responses.ts'
import { runCli } from '../src/cli/index.ts'

function jsonLines(items: unknown[]): string {
  return items.map((x) => JSON.stringify(x)).join('\n') + '\n'
}

test('normalizeImportedMessages strips foreign signatures/encrypted payloads and repairs tool pairing', () => {
  const normalized = normalizeImportedMessages([
    { role: 'tool', toolCallId: 'orphan_0', name: 'old', output: 'ignored', isError: false },
    { role: 'user', text: '   ' },
    { role: 'user', text: 'Fix bug' },
    {
      role: 'assistant',
      text: 'Checking now',
      toolCalls: [{ id: 'call:weird/id!1', name: 'read file', input: { path: 'a.ts' } }],
      thinking: [{ type: 'thinking', thinking: 'Inspecting a.ts', signature: 'sig-secret-123' }],
      reasoningItems: [{ id: 'rs_1', summary: 'Reasoning step', encryptedContent: 'enc-xyz' }],
    },
    // Intentionally omit tool result to test synthesis, plus orphan afterward
    { role: 'tool', toolCallId: 'stray', name: 'stray', output: 'drop me', isError: false },
    {
      role: 'assistant',
      text: 'Running second tool',
      toolCalls: [{ id: 'call_2', name: 'bash', input: { cmd: 'ls' } }],
    },
    { role: 'tool', toolCallId: 'call_2', name: 'bash', output: 'x'.repeat(25_000), isError: false },
  ])

  assert.equal(normalized.length, 5)
  assert.equal(normalized[0]!.role, 'user')
  const a1 = normalized[1]!
  assert.equal(a1.role, 'assistant')
  assert.equal(a1.thinking, undefined)
  assert.equal(a1.reasoningItems, undefined)
  assert.match(a1.reasoning ?? '', /Inspecting a\.ts/)
  assert.match(a1.reasoning ?? '', /Reasoning step/)
  assert.match(a1.toolCalls[0]!.id, /^[a-zA-Z0-9_-]{1,64}$/)
  assert.equal(a1.toolCalls[0]!.name, 'read_file')

  const t1 = normalized[2]!
  assert.equal(t1.role, 'tool')
  assert.equal(t1.toolCallId, a1.toolCalls[0]!.id)
  assert.match(t1.output, /imported without recorded output/)

  const t2 = normalized[4]!
  assert.equal(t2.role, 'tool')
  assert.match(t2.output, /\(truncated during import\)/)

  // Both provider serializers must handle normalized history cleanly without foreign blobs.
  const anthropic = toAnthropicMessages(normalized, { cache: true })
  assert.ok(anthropic.length >= 4)
  assert.equal(JSON.stringify(anthropic).includes('sig-secret-123'), false)

  const responses = toResponsesInput(normalized)
  assert.ok(responses.length >= 5)
  assert.equal(JSON.stringify(responses).includes('enc-xyz'), false)
})

test('discovers and imports sessions across Claude Code, Codex, Antigravity, Cursor, Gemini CLI, Cline, OpenCode, and Aider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-session-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const homeDir = join(root, 'home')
  const appDataDir = join(root, 'appdata')
  const xdgConfigDir = join(root, 'xdg-config')
  const xdgDataDir = join(root, 'xdg-data')
  const workspaceReal = join(root, 'workspace-alpha')
  const atriumData = join(root, 'atrium-data')
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(appDataDir, { recursive: true }),
    mkdir(xdgConfigDir, { recursive: true }),
    mkdir(xdgDataDir, { recursive: true }),
    mkdir(workspaceReal, { recursive: true }),
    mkdir(atriumData, { recursive: true }),
  ])

  // 1. Claude Code
  const claudeDir = join(homeDir, '.claude', 'projects', 'alpha')
  await mkdir(claudeDir, { recursive: true })
  await writeFile(
    join(claudeDir, 'cc-session-1.jsonl'),
    jsonLines([
      {
        type: 'user',
        sessionId: 'cc-1',
        cwd: workspaceReal,
        timestamp: '2026-11-20T10:00:00.000Z',
        message: { role: 'user', content: 'Refactor auth middleware' },
      },
      {
        type: 'user',
        sessionId: 'cc-1',
        isMeta: true,
        message: { role: 'user', content: 'Hidden meta prompt' },
      },
      {
        type: 'assistant',
        sessionId: 'cc-1',
        timestamp: '2026-11-20T10:00:05.000Z',
        message: {
          id: 'msg_cc_1',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking auth.ts first', signature: 'anthropic-sig-abc' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        sessionId: 'cc-1',
        timestamp: '2026-11-20T10:00:06.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export function verify() {}' }],
        },
      },
      {
        type: 'assistant',
        sessionId: 'cc-1',
        timestamp: '2026-11-20T10:00:10.000Z',
        message: {
          id: 'msg_cc_2',
          role: 'assistant',
          content: [{ type: 'text', text: 'Auth middleware looks clean!' }],
        },
      },
      { type: 'custom-title', sessionId: 'cc-1', customTitle: 'Auth Refactor Session' },
    ]),
  )

  // 2. OpenAI Codex
  const codexDir = join(homeDir, '.codex', 'sessions', '2026', '11')
  await mkdir(codexDir, { recursive: true })
  await writeFile(
    join(codexDir, 'rollout-codex-1.jsonl'),
    jsonLines([
      {
        timestamp: '2026-11-21T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-1', cwd: workspaceReal, timestamp: '2026-11-21T08:00:00.000Z' },
      },
      {
        timestamp: '2026-11-21T08:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Dev system prompt' }] },
      },
      {
        timestamp: '2026-11-21T08:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>skip</environment_context>' }] },
      },
      {
        timestamp: '2026-11-21T08:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Write unit tests for parser' }] },
      },
      {
        timestamp: '2026-11-21T08:00:03.500Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Write unit tests for parser' },
      },
      {
        timestamp: '2026-11-21T08:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'rs_cx',
          summary: [{ type: 'summary_text', text: 'Inspecting parser exports' }],
          encrypted_content: 'gAAAAAB-secret',
        },
      },
      {
        timestamp: '2026-11-21T08:00:05.000Z',
        type: 'response_item',
        payload: { type: 'function_call', call_id: 'call_cx_1', name: 'shell_command', arguments: '{"command":"npm test"}' },
      },
      {
        timestamp: '2026-11-21T08:00:06.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_cx_1', output: '177 passing' },
      },
      {
        timestamp: '2026-11-21T08:00:08.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added 5 unit tests and verified.' }] },
      },
    ]),
  )

  // 3. Antigravity (both transcript.jsonl and transcript_full.jsonl)
  const agyLogs = join(homeDir, '.gemini', 'antigravity', 'brain', 'agy-conv-42', '.system_generated', 'logs')
  await mkdir(agyLogs, { recursive: true })
  await writeFile(
    join(agyLogs, 'transcript.jsonl'),
    jsonLines([
      { step_index: 1, type: 'EPHEMERAL_MESSAGE', content: 'ephemeral noise' },
      { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-22T09:00:00.000Z', content: '<USER_REQUEST>\nBuild dark mode toggle\n</USER_REQUEST>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T09:00:02.000Z', thinking: 'Look at theme CSS', tool_calls: [{ name: 'view_file', args: { Path: 'base.css' } }] },
      { step_index: 4, type: 'VIEW_FILE', created_at: '2026-11-22T09:00:03.000Z', content: 'truncated...' },
      { step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T09:00:05.000Z', content: 'Done building dark mode!' },
    ]),
  )
  await writeFile(
    join(agyLogs, 'transcript_full.jsonl'),
    jsonLines([
      { step_index: 1, type: 'USER_INPUT', created_at: '2026-11-22T09:00:00.000Z', content: '<USER_REQUEST>\nBuild dark mode toggle\n</USER_REQUEST>' },
      { step_index: 2, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T09:00:02.000Z', thinking: 'Look at theme CSS', tool_calls: [{ name: 'view_file', args: { Path: 'base.css' } }] },
      { step_index: 3, type: 'VIEW_FILE', created_at: '2026-11-22T09:00:03.000Z', content: 'full CSS content :root[data-theme=dark]' },
      { step_index: 4, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T09:00:05.000Z', content: 'Done building dark mode!' },
    ]),
  )

  // 4. Cursor SQLite state.vscdb + workspaceStorage
  const sqliteSpec = ['node', 'sqlite'].join(':')
  const { DatabaseSync } = (await import(sqliteSpec)) as { DatabaseSync: any }
  const cursorGlobalDir = join(appDataDir, 'Cursor', 'User', 'globalStorage')
  const cursorWsDir = join(appDataDir, 'Cursor', 'User', 'workspaceStorage', 'ws1')
  await Promise.all([mkdir(cursorGlobalDir, { recursive: true }), mkdir(cursorWsDir, { recursive: true })])
  await writeFile(join(cursorWsDir, 'workspace.json'), JSON.stringify({ folder: pathToFileURL(workspaceReal).href }))
  const wdb = new DatabaseSync(join(cursorWsDir, 'state.vscdb'))
  wdb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);')
  wdb
    .prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    .run('composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'cur-comp-1' }] }))
  wdb.close()

  const gdb = new DatabaseSync(join(cursorGlobalDir, 'state.vscdb'))
  gdb.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);')
  gdb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'composerData:cur-comp-1',
    JSON.stringify({
      composerId: 'cur-comp-1',
      name: 'Cursor SQLite Chat',
      createdAt: 1795000000000,
      lastUpdatedAt: 1795000060000,
      fullConversationHeadersOnly: [
        { bubbleId: 'b1', type: 1 },
        { bubbleId: 'b2', type: 2 },
        { bubbleId: 'b3', type: 2 },
      ],
    }),
  )
  gdb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:cur-comp-1:b1',
    JSON.stringify({ type: 1, text: 'Explain event loop' }),
  )
  gdb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:cur-comp-1:b2',
    JSON.stringify({ type: 2, text: '', thinking: { text: 'Breaking down phases', signature: 'cur-sig' } }),
  )
  gdb.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:cur-comp-1:b3',
    JSON.stringify({ type: 2, text: 'The Node.js event loop runs timers, poll, check phases.' }),
  )
  gdb.close()

  // 5. Gemini CLI (.json + .project_root)
  const gemDir = join(homeDir, '.gemini', 'tmp', 'proj1', 'chats')
  await mkdir(gemDir, { recursive: true })
  await writeFile(join(homeDir, '.gemini', 'tmp', 'proj1', '.project_root'), workspaceReal)
  await writeFile(
    join(gemDir, 'session-2026-11-23.json'),
    JSON.stringify({
      sessionId: 'gem-1',
      startTime: '2026-11-23T12:00:00.000Z',
      lastUpdated: '2026-11-23T12:01:00.000Z',
      messages: [
        { type: 'user', content: 'Summarize README' },
        { type: 'gemini', thoughts: [{ description: 'Reading README sections' }], content: 'Atrium is a desktop coding agent.' },
      ],
    }),
  )

  // 6. Cline / Roo Code
  const clineTaskDir = join(appDataDir, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks', '1795100000000')
  await mkdir(clineTaskDir, { recursive: true })
  await writeFile(
    join(clineTaskDir, 'api_conversation_history.json'),
    JSON.stringify([
      { role: 'user', content: [{ type: 'text', text: '<task>\nFix CSS grid layout\n</task>' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Updated grid-template-columns.' }] },
    ]),
  )

  // 7. OpenCode
  const ocSessionDir = join(xdgDataDir, 'opencode', 'storage', 'session', 'projA')
  const ocMsgDir = join(xdgDataDir, 'opencode', 'storage', 'message', 'oc-1')
  const ocPartUser = join(xdgDataDir, 'opencode', 'storage', 'part', 'ocm-1')
  const ocPartAsst = join(xdgDataDir, 'opencode', 'storage', 'part', 'ocm-2')
  await Promise.all([
    mkdir(ocSessionDir, { recursive: true }),
    mkdir(ocMsgDir, { recursive: true }),
    mkdir(ocPartUser, { recursive: true }),
    mkdir(ocPartAsst, { recursive: true }),
  ])
  await writeFile(
    join(ocSessionDir, 'ses_oc1.json'),
    JSON.stringify({ id: 'oc-1', title: 'OpenCode DB Audit', directory: workspaceReal, time: { created: 1795200000000, updated: 1795200100000 } }),
  )
  await writeFile(join(ocMsgDir, 'msg_1.json'), JSON.stringify({ id: 'ocm-1', role: 'user', time: { created: 1795200001000 } }))
  await writeFile(join(ocMsgDir, 'msg_2.json'), JSON.stringify({ id: 'ocm-2', role: 'assistant', time: { created: 1795200002000 } }))
  await writeFile(join(ocPartUser, 'prt_1.json'), JSON.stringify({ type: 'text', text: 'Audit SQL queries' }))
  await writeFile(join(ocPartAsst, 'prt_1.json'), JSON.stringify({ type: 'text', text: 'All queries parameterized.' }))

  // 8. Aider
  await writeFile(
    join(workspaceReal, '.aider.chat.history.md'),
    `# aider chat started at 2026-11-24 10:00:00\n\n> /add main.ts\n\n#### Add healthcheck route\nAdded \`/healthz\` endpoint returning 200.\n`,
  )

  const chats = new ChatStore(atriumData)
  await chats.load()
  const settings = new SettingsStore(atriumData)
  await settings.load()

  const scan = await discoverExternalSessions({
    chats,
    workspace: workspaceReal,
    envOverrides: { homeDir, appDataDir, xdgConfigDir, xdgDataDir },
  })

  const foundSources = new Set(scan.sessions.map((s) => s.source))
  for (const expected of ['claude-code', 'codex', 'antigravity', 'cursor', 'gemini-cli', 'cline', 'opencode', 'aider'] as const) {
    assert.ok(foundSources.has(expected), `Expected source "${expected}" to be discovered`)
  }
  assert.equal(scan.sessions.length, 8)
  const claudeCand = scan.sessions.find((s) => s.source === 'claude-code')!
  assert.equal(claudeCand.title, 'Auth Refactor Session')
  assert.equal(claudeCand.workspace, workspaceReal)
  assert.equal(claudeCand.alreadyImported, false)

  // Import all 8 sessions
  const importRes = await importExternalSessions({
    chats,
    settings,
    items: scan.sessions.map((s) => ({
      key: s.key,
      source: s.source,
      externalId: s.externalId,
      sourcePath: s.sourcePath,
    })),
  })
  assert.equal(importRes.imported.length, 8)
  assert.equal(importRes.skipped.length, 0)

  // Reload ChatStore from disk and verify provenance, dedupe, and full transcript fidelity
  const reloadedChats = new ChatStore(atriumData)
  await reloadedChats.load()
  assert.equal(reloadedChats.list().length, 8)

  const agyMeta = reloadedChats.findByExternalOrigin('antigravity', 'agy-conv-42')
  assert.ok(agyMeta)
  const agyConv = await reloadedChats.get(agyMeta.id)
  assert.ok(agyConv)
  // Full import should prefer transcript_full.jsonl over truncated transcript.jsonl
  assert.match(JSON.stringify(agyConv.messages), /full CSS content :root\[data-theme=dark\]/)

  const codexMeta = reloadedChats.findByExternalOrigin('codex', 'codex-1')
  assert.ok(codexMeta)
  const codexConv = await reloadedChats.get(codexMeta.id)
  assert.ok(codexConv)
  assert.equal(codexConv.messages.filter((m) => m.role === 'user').length, 1) // no duplicate user message or boilerplate

  const curMeta = reloadedChats.findByExternalOrigin('cursor', 'cur-comp-1')
  assert.ok(curMeta)
  assert.equal(curMeta.title, 'Cursor SQLite Chat')
  assert.equal(curMeta.workspace, workspaceReal)
  const curConv = await reloadedChats.get(curMeta.id)
  assert.ok(curConv)
  assert.equal(curConv.messages[1]?.role, 'assistant')
  if (curConv.messages[1]?.role === 'assistant') {
    assert.match(curConv.messages[1].reasoning ?? '', /Breaking down phases/)
    assert.match(curConv.messages[1].text, /event loop runs timers/)
  }

  // Every imported conversation must serialize cleanly for both Anthropic and OpenAI Responses!
  for (const meta of reloadedChats.list()) {
    const conv = await reloadedChats.get(meta.id)
    assert.ok(conv)
    const ant = toAnthropicMessages(conv.messages, { cache: true })
    const rsp = toResponsesInput(conv.messages)
    assert.ok(ant.length > 0)
    assert.ok(rsp.length > 0)
  }

  // recentWorkspaces updated without hijacking active workspace
  assert.ok((settings.get().recentWorkspaces ?? []).includes(workspaceReal))

  // Re-scanning marks all 8 as alreadyImported and re-importing skips them
  const rescan = await discoverExternalSessions({
    chats: reloadedChats,
    workspace: workspaceReal,
    envOverrides: { homeDir, appDataDir, xdgConfigDir, xdgDataDir },
  })
  assert.ok(rescan.sessions.every((s) => s.alreadyImported && Boolean(s.importedChatId)))
  const dupImport = await importExternalSessions({
    chats: reloadedChats,
    settings,
    items: rescan.sessions.map((s) => ({
      key: s.key,
      source: s.source,
      externalId: s.externalId,
      sourcePath: s.sourcePath,
    })),
  })
  assert.equal(dupImport.imported.length, 0)
  assert.equal(dupImport.skipped.length, 8)
})

test('supports custom folder auto-detection and CLI `atrium import sessions --path --all --json`', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-custom-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const folder = join(root, 'backup-chats')
  const cliHome = join(root, 'cli-home')
  await Promise.all([mkdir(folder, { recursive: true }), mkdir(cliHome, { recursive: true })])

  await writeFile(
    join(folder, 'exported-chat.json'),
    JSON.stringify({
      id: 'ext-custom-1',
      title: 'Custom JSON Export',
      messages: [
        { role: 'user', text: 'Explain LRU cache' },
        { role: 'assistant', text: 'Uses hash map + doubly linked list.', reasoning: 'O(1) get/put' },
      ],
    }),
  )
  await writeFile(
    join(folder, 'notes-chat.md'),
    '# Markdown Chat Title\n\n## User\n\nHow to center a div?\n\n## Assistant\n\nUse `display: grid; place-items: center;`.\n',
  )

  const chats = new ChatStore(join(root, 'chats-data'))
  await chats.load()
  const customScan = await discoverExternalSessions({ chats, folderPath: folder })
  assert.equal(customScan.sessions.length, 2)
  assert.ok(customScan.sessions.every((s) => s.source === 'custom'))

  // Run headless CLI subcommand against the same custom folder with isolated HOME
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (d) => (out += String(d)))
  stderr.on('data', (d) => (err += String(d)))

  const code = await runCli(['import', 'sessions', '--path', folder, '--all', '--json'], {
    homeDir: cliHome,
    requireAccount: false,
    stdin: new PassThrough(),
    stdout,
    stderr,
  })
  assert.equal(code, 0, `stderr: ${err}`)
  const parsed = JSON.parse(out) as { imported: Array<{ id: string; title: string }>; skipped: unknown[] }
  assert.equal(parsed.imported.length, 2)
  assert.deepEqual(
    parsed.imported.map((c) => c.title).sort(),
    ['Custom JSON Export', 'Markdown Chat Title'],
  )
})

test('discovers and imports DeepSeek Harness (dsh) multi-frame zstd JSONL, SQLite segments, and custom folders', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-dsh-import-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const homeDir = join(root, 'home')
  const appDataDir = join(root, 'appdata')
  const xdgConfigDir = join(root, 'xdg-config')
  const xdgDataDir = join(root, 'xdg-data')
  const workspaceReal = join(root, 'dsh-proj')
  const atriumData = join(root, 'atrium-data')
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(appDataDir, { recursive: true }),
    mkdir(xdgConfigDir, { recursive: true }),
    mkdir(xdgDataDir, { recursive: true }),
    mkdir(workspaceReal, { recursive: true }),
    mkdir(atriumData, { recursive: true }),
  ])

  // 1. Filename and multi-frame Zstd frame scanner checks
  assert.deepEqual(parseDshLogFilename('session.jsonl'), { version: 0, compressed: false })
  assert.deepEqual(parseDshLogFilename('session.v4.jsonl.zstd'), { version: 4, compressed: true })
  assert.equal(parseDshLogFilename('session.v0.jsonl'), null)

  const frameA = zstdCompressSync(Buffer.from('{"a":1}\n'))
  const frameB = zstdCompressSync(Buffer.from('{"b":2}\n'))
  const concat = Buffer.concat([frameA, frameB])
  const fullScan = scanZstdFrames(concat)
  assert.equal(fullScan.frames.length, 2)
  assert.equal(fullScan.tornStart, undefined)
  const tornScan = scanZstdFrames(Buffer.concat([concat, frameA.subarray(0, 6)]))
  assert.equal(tornScan.frames.length, 2)
  assert.equal(tornScan.tornStart, concat.length)

  // 2. DSH JSONL multi-frame Zstd session + older generation in same dir + subagent dir
  const dshSessionDir = join(homeDir, '.dsh', 'sessions', '--dsh-proj--', 'dsh-jsonl-1')
  const dshSubDir = join(homeDir, '.dsh', 'sessions', '--dsh-proj--', 'dsh-sub-1')
  await Promise.all([mkdir(dshSessionDir, { recursive: true }), mkdir(dshSubDir, { recursive: true })])

  // Older v0 plaintext file that must be superseded by v4.jsonl.zstd
  await writeFile(
    join(dshSessionDir, 'session.jsonl'),
    jsonLines([
      { type: 'session', version: 0, id: 'dsh-old-shadow', createdAt: 1795000000000, cwd: workspaceReal, isSeeded: false, delegationDepth: 0 },
      { type: 'user/message', seq: 0, time: 1795000001000, data: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'Old shadow' }], source: { kind: 'user' } } },
    ]),
  )

  const v4Frame1 = zstdCompressSync(
    Buffer.from(
      jsonLines([
        {
          type: 'session',
          version: 4,
          id: 'dsh-jsonl-1',
          createdAt: 1795300000000,
          cwd: workspaceReal,
          isSeeded: false,
          delegationDepth: 0,
        },
        {
          type: 'user/message',
          seq: 0,
          time: 1795300001000,
          data: {
            id: 'u1',
            role: 'user',
            content: [{ type: 'text', text: 'Inspect router.ts and fix rate limit' }],
            source: { kind: 'user' },
          },
        },
        {
          type: 'user/message',
          seq: 1,
          time: 1795300002000,
          data: {
            id: 'u-inject',
            role: 'user',
            content: [{ type: 'text', text: 'Synthetic notice should be skipped' }],
            source: { kind: 'system-inject', form: 'notice' },
          },
        },
      ]),
    ),
  )
  const v4Frame2 = zstdCompressSync(
    Buffer.from(
      jsonLines([
        {
          type: 'assistant/message',
          seq: 2,
          time: 1795300005000,
          data: {
            turn: 0,
            step: 0,
            message: {
              id: 'a1',
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'Checking rate limit bucket logic' },
                { type: 'tool-call', id: 'tc_dsh_1', name: 'read_file', arguments: '{"path":"router.ts"}' },
              ],
              source: { kind: 'model', provider: 'deepseek', model: 'deepseek-reasoner', replayState: { opaque: 'drop' } },
            },
            stream: [],
          },
        },
        {
          type: 'tool/result',
          seq: 3,
          time: 1795300006000,
          data: {
            turn: 0,
            step: 0,
            message: {
              id: 't1',
              role: 'tool',
              content: [{ type: 'text', text: 'export const limit = 60' }],
              isError: false,
              source: { kind: 'tool', callId: 'tc_dsh_1' },
            },
          },
        },
        {
          type: 'assistant/message',
          seq: 4,
          time: 1795300009000,
          data: {
            turn: 0,
            step: 1,
            message: {
              id: 'a2',
              role: 'assistant',
              content: [{ type: 'text', text: 'Updated router rate limit cleanly.' }],
              source: { kind: 'model', provider: 'deepseek', model: 'deepseek-reasoner' },
            },
            stream: [],
          },
        },
        {
          type: 'session/title',
          seq: 5,
          time: 1795300010000,
          data: { title: 'DSH Zstd Router Fix', messageSeqs: [0], source: { kind: 'fallback' } },
        },
      ]),
    ),
  )
  await writeFile(join(dshSessionDir, 'session.v4.jsonl.zstd'), Buffer.concat([v4Frame1, v4Frame2]))

  // Subagent session that must be skipped by default auto-discovery
  await writeFile(
    join(dshSubDir, 'session.v4.jsonl'),
    jsonLines([
      {
        type: 'session',
        version: 4,
        id: 'dsh-sub-1',
        createdAt: 1795300020000,
        cwd: workspaceReal,
        parentSession: 'dsh-jsonl-1',
        origin: 'subagent',
        isSeeded: false,
        delegationDepth: 1,
      },
      { type: 'user/message', seq: 0, time: 1795300021000, data: { id: 'su', role: 'user', content: [{ type: 'text', text: 'Subagent task' }], source: { kind: 'user' } } },
    ]),
  )

  // 3. DSH SQLite Segment backend (.dsh/sessions/.segments/sessions.sqlite)
  const sqliteSpec = ['node', 'sqlite'].join(':')
  const { DatabaseSync } = (await import(sqliteSpec)) as { DatabaseSync: any }
  const segmentsDir = join(homeDir, '.dsh', 'sessions', '.segments')
  await mkdir(segmentsDir, { recursive: true })
  const dshDb = new DatabaseSync(join(segmentsDir, 'sessions.sqlite'))
  dshDb.exec(`
    CREATE TABLE segments (segment_uuid TEXT PRIMARY KEY, parent_segment_uuid TEXT, parent_end_seq INTEGER, base_seq INTEGER NOT NULL);
    CREATE TABLE frames (segment_uuid TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL, codec INTEGER NOT NULL, payload BLOB NOT NULL);
    CREATE TABLE traces (trace_uuid TEXT PRIMARY KEY, header TEXT NOT NULL, tail_segment_uuid TEXT NOT NULL, inherited_count INTEGER NOT NULL);
  `)
  dshDb
    .prepare('INSERT INTO segments (segment_uuid, parent_segment_uuid, parent_end_seq, base_seq) VALUES (?, ?, ?, ?)')
    .run('seg-parent', null, null, 0)
  dshDb
    .prepare('INSERT INTO segments (segment_uuid, parent_segment_uuid, parent_end_seq, base_seq) VALUES (?, ?, ?, ?)')
    .run('seg-child', 'seg-parent', 0, 1)

  const parentFrameUtf8 = Buffer.from(
    JSON.stringify({
      type: 'user/message',
      seq: 0,
      time: 1795400001000,
      data: { id: 'su1', role: 'user', content: [{ type: 'text', text: 'Explain SQLite segments' }], source: { kind: 'user' } },
    }),
    'utf8',
  )
  const childFrameZstd = zstdCompressSync(
    Buffer.from(
      [
        JSON.stringify({
          type: 'assistant/message',
          seq: 1,
          time: 1795400005000,
          data: {
            turn: 0,
            step: 0,
            message: {
              id: 'sa1',
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'Tracing fork parent segment' },
                { type: 'text', text: 'Segments chain via parent_segment_uuid.' },
              ],
              source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
            },
            stream: [],
          },
        }),
        JSON.stringify({
          type: 'session/title',
          seq: 2,
          time: 1795400006000,
          data: { title: 'DSH SQLite Segment Chat', messageSeqs: [0], source: { kind: 'user' } },
        }),
      ].join('\n'),
      'utf8',
    ),
  )

  dshDb
    .prepare('INSERT INTO frames (segment_uuid, start_seq, end_seq, codec, payload) VALUES (?, ?, ?, ?, ?)')
    .run('seg-parent', 0, 1, 0, parentFrameUtf8)
  dshDb
    .prepare('INSERT INTO frames (segment_uuid, start_seq, end_seq, codec, payload) VALUES (?, ?, ?, ?, ?)')
    .run('seg-child', 1, 3, 1, childFrameZstd)
  dshDb
    .prepare('INSERT INTO traces (trace_uuid, header, tail_segment_uuid, inherited_count) VALUES (?, ?, ?, ?)')
    .run(
      'trace-sqlite-1',
      JSON.stringify({
        version: 4,
        id: 'dsh-sqlite-1',
        createdAt: 1795400000000,
        cwd: workspaceReal,
        isSeeded: false,
        delegationDepth: 0,
      }),
      'seg-child',
      0,
    )
  dshDb.close()

  // Auto-discover across DSH home
  const chats = new ChatStore(atriumData)
  await chats.load()
  const settings = new SettingsStore(atriumData)
  await settings.load()

  const scan = await discoverExternalSessions({
    chats,
    workspace: workspaceReal,
    envOverrides: { homeDir, appDataDir, xdgConfigDir, xdgDataDir },
  })
  const dshSessions = scan.sessions.filter((s) => s.source === 'dsh')
  assert.equal(dshSessions.length, 2)
  assert.ok(dshSessions.some((s) => s.externalId === 'dsh-jsonl-1' && s.title === 'DSH Zstd Router Fix'))
  assert.ok(dshSessions.some((s) => s.externalId === 'dsh-sqlite-1' && s.title === 'DSH SQLite Segment Chat'))
  assert.equal(dshSessions.some((s) => s.externalId === 'dsh-sub-1'), false)

  // Import both DSH sessions + verify replay safety
  const importRes = await importExternalSessions({
    chats,
    settings,
    items: dshSessions.map((s) => ({
      key: s.key,
      source: s.source,
      externalId: s.externalId,
      sourcePath: s.sourcePath,
    })),
  })
  assert.equal(importRes.imported.length, 2)

  const zstdConv = await chats.get(importRes.imported.find((c) => c.importedFrom?.externalId === 'dsh-jsonl-1')!.id)
  assert.ok(zstdConv)
  assert.equal(zstdConv.messages.filter((m) => m.role === 'user').length, 1) // skipped synthetic notice
  assert.equal(zstdConv.messages[1]?.role, 'assistant')
  if (zstdConv.messages[1]?.role === 'assistant') {
    assert.match(zstdConv.messages[1].reasoning ?? '', /rate limit bucket/)
    assert.equal(zstdConv.messages[1].toolCalls.length, 1)
  }
  assert.ok(toAnthropicMessages(zstdConv.messages, { cache: true }).length > 0)
  assert.ok(toResponsesInput(zstdConv.messages).length > 0)

  const sqliteConv = await chats.get(importRes.imported.find((c) => c.importedFrom?.externalId === 'dsh-sqlite-1')!.id)
  assert.ok(sqliteConv)
  assert.equal(sqliteConv.messages.length, 2)
  assert.match(sqliteConv.messages[1]?.role === 'assistant' ? sqliteConv.messages[1].reasoning ?? '' : '', /Tracing fork parent segment/)

  // Custom folder scan directly against dshSessionDir
  const customScan = await discoverExternalSessions({ chats, folderPath: dshSessionDir })
  const customDsh = customScan.sessions.find((s) => s.externalId === 'dsh-jsonl-1')
  assert.ok(customDsh)
  assert.equal(customDsh.alreadyImported, true)
})
