import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BLOB_PREFIX, BLOB_THRESHOLD_CHARS, BlobStore } from '../src/core/blobs.ts'
import { ChatStore } from '../src/core/chats.ts'
import { invalidateWorkspaceHookCache, loadWorkspaceHookSource } from '../src/core/hooks.ts'
import { McpManager } from '../src/core/mcp/manager.ts'
import { PluginManager } from '../src/core/plugins.ts'
import { TerminalManager } from '../src/core/terminal.ts'
import { invalidateWorkspaceFilesCache, listWorkspaceFiles, writeApproved } from '../src/core/tools/files.ts'
import { getGitChanges, splitUnifiedGitDiff, unquoteGitPath } from '../src/core/tools/git.ts'
import { applyPreparedPatch, preparePatch } from '../src/core/tools/patch.ts'
import { splitStreamingMarkdownBlocks } from '../src/renderer/src/lib/markdownBlocks.ts'
import type { Conversation, TerminalEvent } from '../src/shared/types.ts'

const execFileAsync = promisify(execFile)

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000, stepMs = 40): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
}

test('P1: splitStreamingMarkdownBlocks splits blocks at blank lines without breaking code fences', () => {
  const md = [
    '# Heading',
    '',
    'First paragraph line 1',
    'line 2',
    '',
    '```ts',
    'const a = 1',
    '',
    'const b = 2',
    '```',
    '',
    '- item 1',
    '',
    '- item 2',
    '',
    '~~~python',
    'def unfinished():',
    '',
    '    return 42',
  ].join('\n')

  const blocks = splitStreamingMarkdownBlocks(md)
  assert.equal(blocks.length, 5)
  assert.equal(blocks[0], '# Heading')
  assert.equal(blocks[1], 'First paragraph line 1\nline 2')
  assert.equal(blocks[2], '```ts\nconst a = 1\n\nconst b = 2\n```')
  assert.equal(blocks[3], '- item 1\n\n- item 2')
  assert.equal(blocks[4], '~~~python\ndef unfinished():\n\n    return 42')
})

test('P3: unquoteGitPath & splitUnifiedGitDiff handle modified, added, deleted, renamed, empty & UTF-8 paths', () => {
  assert.equal(unquoteGitPath('"src/\\344\\270\\255\\346\\226\\207 file.ts"'), 'src/中文 file.ts')
  assert.equal(unquoteGitPath('src/plain.ts'), 'src/plain.ts')

  const rawDiff = [
    'diff --git a/src/mod.ts b/src/mod.ts',
    'index 1111111..2222222 100644',
    '--- a/src/mod.ts',
    '+++ b/src/mod.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/src/old_name.ts b/src/new_name.ts',
    'similarity index 100%',
    'rename from src/old_name.ts',
    'rename to src/new_name.ts',
    'diff --git a/src/empty.ts b/src/empty.ts',
    'new file mode 100644',
    'index 0000000..e69de29',
    'diff --git "a/src/\\344\\270\\255\\346\\226\\207.ts" "b/src/\\344\\270\\255\\346\\226\\207.ts"',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ "b/src/\\344\\270\\255\\346\\226\\207.ts"',
    '@@ -0,0 +1 @@',
    '+export const ok = true',
  ].join('\n')

  const map = splitUnifiedGitDiff(rawDiff)
  assert.equal(map.size, 5)
  assert.ok(map.get('src/mod.ts')?.includes('+new'))
  assert.ok(map.get('src/deleted.ts')?.includes('-bye'))
  assert.ok(map.get('src/new_name.ts')?.includes('rename to src/new_name.ts'))
  assert.ok(map.get('src/empty.ts')?.includes('new file mode 100644'))
  assert.ok(map.get('src/中文.ts')?.includes('+export const ok = true'))
})

test('P3: batch getGitChanges accurately reports 20+ tracked, deleted, staged, and untracked files', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-v031-git-'))
  try {
    await runGit(ws, ['init'])
    await runGit(ws, ['config', 'user.email', 'test@atrium.local'])
    await runGit(ws, ['config', 'user.name', 'Atrium Test'])

    await mkdir(join(ws, 'src'), { recursive: true })
    for (let i = 0; i < 12; i++) {
      await writeFile(join(ws, 'src', `file_${i}.ts`), `export const n = ${i}\n`, 'utf8')
    }
    await runGit(ws, ['add', '.'])
    await runGit(ws, ['commit', '-m', 'init'])

    // Modify 10 files, delete 2 files, stage 1 added file, leave 8 untracked files = 21 total entries
    for (let i = 0; i < 10; i++) {
      await writeFile(join(ws, 'src', `file_${i}.ts`), `export const n = ${i + 100}\nexport const added = true\n`, 'utf8')
    }
    await rm(join(ws, 'src', 'file_10.ts'))
    await rm(join(ws, 'src', 'file_11.ts'))
    await writeFile(join(ws, 'src', 'staged_added.ts'), 'export const s = 1\n', 'utf8')
    await runGit(ws, ['add', 'src/staged_added.ts'])
    for (let i = 0; i < 8; i++) {
      await writeFile(join(ws, 'src', `untracked_${i}.ts`), `// untracked ${i}\nconst u = ${i}\n`, 'utf8')
    }

    const changes = await getGitChanges(ws)
    assert.equal(changes.length, 21)

    const mod0 = changes.find((c) => c.path === 'src/file_0.ts')
    assert.equal(mod0?.status, 'modified')
    assert.equal(mod0?.additions, 2)
    assert.equal(mod0?.deletions, 1)

    const del10 = changes.find((c) => c.path === 'src/file_10.ts')
    assert.equal(del10?.status, 'deleted')
    assert.equal(del10?.deletions, 1)

    const staged = changes.find((c) => c.path === 'src/staged_added.ts')
    assert.equal(staged?.status, 'added')
    assert.equal(staged?.staged, true)
    assert.equal(staged?.additions, 1)

    const untracked0 = changes.find((c) => c.path === 'src/untracked_0.ts')
    assert.equal(untracked0?.status, 'added')
    assert.equal(untracked0?.additions, 3)
    assert.ok(untracked0?.diff.includes('+const u = 0'))
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})

test('P3: listWorkspaceFiles honors .gitignore, hits 5s cache, and invalidates on writeApproved & applyPreparedPatch', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-v031-files-'))
  try {
    invalidateWorkspaceFilesCache()
    await runGit(ws, ['init'])
    await writeFile(join(ws, '.gitignore'), '*.log\nignored_dir/\n', 'utf8')
    await mkdir(join(ws, 'src'), { recursive: true })
    await mkdir(join(ws, 'ignored_dir'), { recursive: true })
    await writeFile(join(ws, 'src', 'index.ts'), 'export {}\n', 'utf8')
    await writeFile(join(ws, 'debug.log'), 'noise\n', 'utf8')
    await writeFile(join(ws, 'ignored_dir', 'secret.txt'), 'hidden\n', 'utf8')

    const initial = await listWorkspaceFiles(ws)
    assert.ok(initial.includes('src/index.ts'))
    assert.ok(!initial.includes('debug.log'))
    assert.ok(!initial.includes('ignored_dir/secret.txt'))

    // External FS write hits 5s cache until invalidated
    await writeFile(join(ws, 'external.ts'), 'export const ext = 1\n', 'utf8')
    const cached = await listWorkspaceFiles(ws)
    assert.ok(!cached.includes('external.ts'))

    // writeApproved invalidates cache automatically
    await writeApproved(ws, 'approved.ts', 'export const ok = 1\n')
    const afterWrite = await listWorkspaceFiles(ws)
    assert.ok(afterWrite.includes('approved.ts'))
    assert.ok(afterWrite.includes('external.ts'))

    // applyPreparedPatch invalidates cache automatically too
    const prepared = await preparePatch(ws, {
      patch: [
        '*** Begin Patch',
        '*** Add File: patched.ts',
        '+export const patched = true',
        '*** End Patch',
      ].join('\n'),
    })
    await applyPreparedPatch(prepared)
    const afterPatch = await listWorkspaceFiles(ws)
    assert.ok(afterPatch.includes('patched.ts'))
  } finally {
    invalidateWorkspaceFilesCache()
    await rm(ws, { recursive: true, force: true })
  }
})

test('P4: BlobStore deduplicates large images, writes compact JSON, preserves inline legacy & rejects traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-v031-blobs-'))
  try {
    const bigBytes = Buffer.alloc(7_200, 0x42) // > 9,600 chars base64
    const bigDataUrl = `data:image/png;base64,${bigBytes.toString('base64')}`
    assert.ok(bigDataUrl.length > BLOB_THRESHOLD_CHARS)
    const smallDataUrl = 'data:image/png;base64,AAAA'

    const store = new ChatStore(dir)
    await store.load()

    const c1 = await store.create({ providerId: 'anthropic' })
    c1.messages.push({
      role: 'user',
      text: 'Analyze screenshot',
      images: [
        { id: 'img1', name: 'big.png', mimeType: 'image/png', dataUrl: bigDataUrl },
        { id: 'img2', name: 'small.png', mimeType: 'image/png', dataUrl: smallDataUrl },
      ],
    })
    await store.save(c1)

    // In-memory conversation object passed to save() must NOT be mutated
    assert.equal(c1.messages[0]?.role, 'user')
    if (c1.messages[0]?.role === 'user') {
      assert.equal(c1.messages[0].images?.[0]?.dataUrl, bigDataUrl)
    }

    // Persisted JSON must be compact and contain atrium-blob:// for the large image
    const rawC1 = await readFile(join(dir, 'chats', `${c1.id}.json`), 'utf8')
    assert.ok(!rawC1.includes('\n  '), 'Conversation JSON should be compact without pretty indentation')
    assert.ok(rawC1.includes(BLOB_PREFIX))
    assert.ok(!rawC1.includes(bigBytes.toString('base64').slice(0, 64)))
    assert.ok(rawC1.includes(smallDataUrl))

    // Second chat with identical large image deduplicates to 1 blob file
    const c2 = await store.create({ providerId: 'openai' })
    c2.messages.push({
      role: 'user',
      text: 'Same screenshot elsewhere',
      images: [{ id: 'img3', name: 'dup.png', mimeType: 'image/png', dataUrl: bigDataUrl }],
    })
    await store.save(c2)

    const blobFiles = await readdir(join(dir, 'blobs'))
    assert.equal(blobFiles.filter((f) => !f.endsWith('.tmp')).length, 1)

    // Removing c1 does NOT delete shared blob so c2 still hydrates transparently
    await store.remove(c1.id)
    const hydratedC2 = await store.get(c2.id)
    assert.ok(hydratedC2)
    assert.equal(hydratedC2.messages[0]?.role, 'user')
    if (hydratedC2.messages[0]?.role === 'user') {
      assert.equal(hydratedC2.messages[0].images?.[0]?.dataUrl, bigDataUrl)
    }

    // Path traversal rejection in BlobStore + 64-entry LRU eviction check
    const secretFile = join(dir, 'secret.txt')
    await writeFile(secretFile, 'top-secret', 'utf8')
    const bs = new BlobStore(dir)
    const badRef = `${BLOB_PREFIX}../../secret.txt`
    assert.equal(await bs.hydrateDataUrl(badRef, 'image/png'), badRef)

    for (let i = 0; i < 70; i++) {
      const buf = Buffer.alloc(6_600, i + 1)
      await bs.offloadDataUrl(`data:image/png;base64,${buf.toString('base64')}`, 'image/png')
    }
    assert.ok(bs.cacheSize <= 64, `Expected LRU <= 64 entries, got ${bs.cacheSize}`)

    // Legacy inline image conversation JSON still loads untouched
    const legacyId = 'chat_legacy_inline'
    const legacyConv: Conversation = {
      id: legacyId,
      title: 'Legacy inline',
      createdAt: 1000,
      updatedAt: 1000,
      providerId: 'legacy',
      messages: [
        {
          role: 'user',
          text: 'Old inline image',
          images: [{ id: 'leg', name: 'leg.png', mimeType: 'image/png', dataUrl: bigDataUrl }],
        },
        {
          role: 'assistant',
          text: 'Done',
          toolCalls: [],
          workScene: 'work',
          usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 5 },
        },
      ],
    }
    await writeFile(join(dir, 'chats', `${legacyId}.json`), JSON.stringify(legacyConv, null, 2), 'utf8')
    const idxRaw = JSON.parse(await readFile(join(dir, 'chats.json'), 'utf8'))
    idxRaw.push({
      id: legacyId,
      title: 'Legacy inline',
      createdAt: 1000,
      updatedAt: 1000,
      providerId: 'legacy',
      messageCount: 2,
    })
    await writeFile(join(dir, 'chats.json'), JSON.stringify(idxRaw, null, 2), 'utf8')

    const reloaded = new ChatStore(dir)
    await reloaded.load()
    const gotLegacy = await reloaded.get(legacyId)
    assert.ok(gotLegacy)
    if (gotLegacy.messages[0]?.role === 'user') {
      assert.equal(gotLegacy.messages[0].images?.[0]?.dataUrl, bigDataUrl)
    }

    // summarizeUsage backfills legacy index entry once & aggregates accurately
    const summary = await reloaded.summarizeUsage()
    assert.equal(summary.conversations, 2)
    assert.equal(summary.userMessages, 2)
    assert.equal(summary.assistantMessages, 1)
    assert.equal(summary.inputTokens, 120)
    assert.equal(summary.outputTokens, 30)
    assert.equal(summary.cacheReadTokens, 10)
    assert.equal(summary.cacheWriteTokens, 5)
    assert.equal(summary.byScene.work.messages, 1)
    assert.equal(summary.byScene.work.totalTokens, 150)

    const backfilledIdx = JSON.parse(await readFile(join(dir, 'chats.json'), 'utf8'))
    const legacyMeta = backfilledIdx.find((m: { id: string }) => m.id === legacyId)
    assert.ok(legacyMeta?.usageTotals, 'Legacy chat meta should be backfilled with usageTotals')

    // Indexed chats no longer read per-chat files during summarizeUsage
    await rm(join(dir, 'chats', `${legacyId}.json`))
    const secondSummary = await reloaded.summarizeUsage()
    assert.equal(secondSummary.inputTokens, 120)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('P5: TerminalManager batches bursting stdout, enforces 200k ring buffer, supports clear & clean shutdown', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-v031-term-'))
  const events: TerminalEvent[] = []
  const tm = new TerminalManager({
    emit: (ev) => events.push(ev),
    getDefaultWorkspace: () => ws,
    dataDir: ws,
  })
  try {
    const burstScript =
      'let i = 0; function step(){ process.stdout.write("chunk-" + i++ + " "); if (i < 30) setTimeout(step, 0); else process.stdout.write("\\nALL_DONE"); } step();'
    const s1 = tm.create({
      workspace: ws,
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(burstScript)}`,
    })

    await waitFor(
      () => events.some((e) => e.type === 'state' && e.session.id === s1.id && e.session.status === 'exited'),
      10_000,
    )

    const dataEvents = events.filter((e) => e.type === 'data' && e.id === s1.id)
    const combined = dataEvents.map((e) => (e.type === 'data' ? e.chunk : '')).join('')
    assert.ok(combined.includes('ALL_DONE'))
    assert.ok(combined.includes('chunk-0 ') && combined.includes('chunk-29 '))
    assert.ok(dataEvents.length < 30, `Expected output batching (< 30 events), got ${dataEvents.length}`)

    // 260,000 chars should cap at 200,000 while keeping exact tail
    events.length = 0
    const bigScript = 'process.stdout.write("X".repeat(260000) + "TAIL_END_MARKER");'
    const s2 = tm.create({
      workspace: ws,
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(bigScript)}`,
    })
    await waitFor(
      () => events.some((e) => e.type === 'state' && e.session.id === s2.id && e.session.status === 'exited'),
      10_000,
    )
    const fullRead = tm.read(s2.id)
    assert.ok(fullRead.output.length <= 200_000, `Ring buffer exceeded 200k: ${fullRead.output.length}`)
    assert.ok(fullRead.output.includes('TAIL_END_MARKER'))
    const tailRead = tm.read(s2.id, 15)
    assert.equal(tailRead.output.length, 15)
    assert.equal(tailRead.output.includes('TAIL_END_MARKER') || fullRead.output.endsWith(tailRead.output), true)

    tm.clear(s2.id)
    assert.equal(tm.read(s2.id).output, '')
    tm.close(s1.id)
    tm.close(s2.id)
  } finally {
    tm.shutdown()
    await rm(ws, { recursive: true, force: true })
  }
})

test('P5: Workspace & Plugin hook caches reuse parsed configs on unchanged mtime and invalidate on updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-v031-hooks-'))
  try {
    invalidateWorkspaceHookCache()
    const ws = join(dir, 'workspace')
    await mkdir(join(ws, '.atrium'), { recursive: true })
    assert.equal(await loadWorkspaceHookSource(ws), null)

    const hookFile = join(ws, '.atrium', 'hooks.json')
    await writeFile(
      hookFile,
      JSON.stringify({ PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'echo v1' }] }] }),
      'utf8',
    )
    const ws1 = await loadWorkspaceHookSource(ws)
    const ws2 = await loadWorkspaceHookSource(ws)
    assert.ok(ws1)
    assert.strictEqual(ws1, ws2, 'Workspace hook cache should return same cached object on unchanged mtime')
    assert.equal(ws1.hooks.PreToolUse?.[0]?.hooks[0]?.command, 'echo v1')

    await writeFile(
      hookFile,
      JSON.stringify({ PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: 'echo v2' }] }] }),
      'utf8',
    )
    const future = new Date(Date.now() + 5_000)
    await utimes(hookFile, future, future)
    const ws3 = await loadWorkspaceHookSource(ws)
    assert.ok(ws3)
    assert.notStrictEqual(ws3, ws1)
    assert.equal(ws3.hooks.PreToolUse?.[0]?.hooks[0]?.command, 'echo v2')

    await rm(hookFile)
    assert.equal(await loadWorkspaceHookSource(ws), null)

    // PluginManager hook cache
    const dataDir = join(dir, 'data')
    const pluginSrc = join(dir, 'sample-plugin')
    await mkdir(join(pluginSrc, '.claude-plugin'), { recursive: true })
    await mkdir(join(pluginSrc, 'hooks'), { recursive: true })
    await writeFile(
      join(pluginSrc, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'hook-cache-test', version: '1.0.0', description: 'test' }),
      'utf8',
    )
    await writeFile(
      join(pluginSrc, 'hooks', 'hooks.json'),
      JSON.stringify({ PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo p1' }] }] }),
      'utf8',
    )

    const mcp = new McpManager(dataDir, () => undefined)
    await mcp.load()
    const pm = new PluginManager({ dir: dataDir, mcp })
    await pm.load()
    const imported = await pm.importFolder(pluginSrc)
    assert.equal(imported.installed.length, 1)
    const plugin = imported.installed[0]!

    const p1 = await pm.activeHookSources()
    const p2 = await pm.activeHookSources()
    assert.strictEqual(p1, p2, 'PluginManager.activeHookSources should return cached array when mtime & state unchanged')
    assert.equal(p1[0]?.hooks.PostToolUse?.[0]?.hooks[0]?.command, 'echo p1')

    const installedHookFile = join(plugin.installDir, 'hooks', 'hooks.json')
    await writeFile(
      installedHookFile,
      JSON.stringify({ PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo p2' }] }] }),
      'utf8',
    )
    const later = new Date(Date.now() + 10_000)
    await utimes(installedHookFile, later, later)
    const p3 = await pm.activeHookSources()
    assert.notStrictEqual(p3, p1)
    assert.equal(p3[0]?.hooks.PostToolUse?.[0]?.hooks[0]?.command, 'echo p2')

    await pm.setEnabled(plugin.id, false)
    assert.deepEqual(await pm.activeHookSources(), [])
    await pm.setEnabled(plugin.id, true)
    const p4 = await pm.activeHookSources()
    assert.equal(p4[0]?.hooks.PostToolUse?.[0]?.hooks[0]?.command, 'echo p2')
  } finally {
    invalidateWorkspaceHookCache()
    await rm(dir, { recursive: true, force: true })
  }
})
