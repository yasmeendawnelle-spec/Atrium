// Tests for P0 capabilities: Queue/Steer, Fork branches, Git Commit & Merge Worktree, Diff Review Parser, and PDF/DOCX/XLSX/PPTX extraction.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type { AgentEvent, Conversation, Message } from '../src/shared/types.ts'
import { AgentLoop } from '../src/core/agent.ts'
import { ChatStore } from '../src/core/chats.ts'
import type { McpManager } from '../src/core/mcp/manager.ts'
import type { SettingsStore } from '../src/core/settings.ts'
import { toAnthropicMessages } from '../src/core/providers/anthropic.ts'
import { toOpenAiMessages } from '../src/core/providers/openai.ts'
import { toResponsesInput } from '../src/core/providers/responses.ts'
import { CheckpointStore, snapshotExistingFile } from '../src/core/tools/changes.ts'
import { classifyDocumentExt, extractDocument } from '../src/core/tools/documents.ts'
import { runReadTool } from '../src/core/tools/files.ts'
import {
  checkoutGitBranch,
  commitGitChanges,
  createGitWorktree,
  getGitChanges,
  getGitRepoStatus,
  listGitBranches,
  mergeWorktreeToBase,
  stageGitFiles,
} from '../src/core/tools/git.ts'
import { buildSplitDiffRows, formatReviewPrompt, parseUnifiedDiff } from '../src/renderer/src/lib/diff.ts'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('git', args, { cwd, windowsHide: true }, (err, out, errOut) => {
      if (err) rejectPromise(new Error(errOut || out || err.message))
      else resolvePromise(out.trim())
    })
  })
}

function makeMinimalPdf(text: string): Buffer {
  const safe = text.replace(/([()\\])/g, '\\$1')
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${safe}) Tj\nET`
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

function makeMinimalDocx(paragraphs: string[]): Buffer {
  const pXml = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${pXml}</w:body></w:document>`,
    ),
  }
  return Buffer.from(zipSync(files))
}

function makeMinimalXlsx(sheetName: string, rows: string[][]): Buffer {
  const rowXml = rows
    .map((r, rIdx) => {
      const cells = r
        .map((val, cIdx) => {
          const col = String.fromCharCode(65 + cIdx)
          return `<c r="${col}${rIdx + 1}" t="inlineStr"><is><t>${val}</t></is></c>`
        })
        .join('')
      return `<row r="${rIdx + 1}">${cells}</row>`
    })
    .join('')

  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
    ),
  }
  return Buffer.from(zipSync(files))
}

function makeMinimalPptx(slides: Array<{ text: string[]; notes?: string }>): Buffer {
  const files: Record<string, Uint8Array> = {}
  slides.forEach((s, idx) => {
    const n = idx + 1
    const pXml = s.text.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join('')
    files[`ppt/slides/slide${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${pXml}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    )
    if (s.notes) {
      files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${s.notes}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      )
    }
  })
  return Buffer.from(zipSync(files))
}

test('AgentLoop supports queueing follow-up messages while busy and steering interruption', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-queue-'))
  const promptsSeen: string[] = []
  let reqCount = 0
  const turn1Gate: { release?: () => void } = {}

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      reqCount++
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> }
      const userMsgs = parsed.messages.filter((m) => m.role === 'user').map((m) => m.content)
      promptsSeen.push(userMsgs[userMsgs.length - 1] ?? '')

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (reqCount === 1) {
        // Hold turn 1 open until test enqueues follow-ups and releases it.
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'First ' }, finish_reason: null }] })}\n\n`)
        turn1Gate.release = () => {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'done.' }, finish_reason: 'stop' }] })}\n\n`)
          res.end('data: [DONE]\n\n')
        }
        return
      }
      if (reqCount === 2) {
        // Turn 2 also stays open momentarily so steerQueued can test interrupting an active turn.
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Second started ' }, finish_reason: null }] })}\n\n`)
        setTimeout(() => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'end' }, finish_reason: 'stop' }] })}\n\n`)
            res.end('data: [DONE]\n\n')
          }
        }, 400)
        return
      }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `Reply #${reqCount}` }, finish_reason: 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })

  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
    const settings = {
      activeProvider: () => ({ id: 'p', name: 'Mock', protocol: 'openai', baseUrl, model: 'mock', hasKey: true }),
      providerKey: async () => 'k',
      get: () => ({ workspace: dir }),
    } as unknown as SettingsStore
    const mcp = { tools: () => [], findTool: () => undefined } as unknown as McpManager
    const events: AgentEvent[] = []
    let turnEnds = 0
    let doneResolver: (() => void) | null = null

    const loop = new AgentLoop({
      settings,
      mcp,
      emit: (e) => {
        events.push(e)
        if (e.type === 'turn_end') {
          turnEnds++
          doneResolver?.()
        }
      },
      save: async () => undefined,
      systemPrompt: () => 'test',
    })

    const conv: Conversation = {
      id: 'chat_q1',
      title: 'Queue test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }

    const runPromise = loop.run(conv, 'First task')
    while (!turn1Gate.release) await new Promise((r) => setTimeout(r, 15))
    assert.equal(loop.busy(conv.id), true)

    const qAfterAdd = loop.enqueue(conv, 'Second queued')
    const q3 = loop.enqueue(conv, 'Third steered')
    assert.equal(qAfterAdd.length, 1)
    assert.equal(q3.length, 2)
    assert.equal(loop.queuedFor(conv.id).length, 2)

    const waitTurnEnd = (target: number) =>
      new Promise<void>((resolveWait) => {
        if (turnEnds >= target) return resolveWait()
        doneResolver = () => {
          if (turnEnds >= target) resolveWait()
        }
      })

    turn1Gate.release()
    await runPromise
    // Turn 2 ('Second queued') should start automatically via queue drain.
    while (reqCount < 2) await new Promise((r) => setTimeout(r, 15))
    assert.equal(promptsSeen[1], 'Second queued')

    // Now steer the remaining item ('Third steered') to interrupt turn 2 and execute immediately.
    const remaining = loop.queuedFor(conv.id)
    assert.equal(remaining.length, 1)
    loop.steerQueued(conv, remaining[0]!.id)
    await waitTurnEnd(3)
    assert.equal(promptsSeen[2], 'Third steered')
    assert.equal(loop.queuedFor(conv.id).length, 0)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('ChatStore.fork clones history cleanly up to any message without worktree ownership collision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-fork-'))
  try {
    const store = new ChatStore(dir)
    await store.load()
    const orig = await store.create({
      id: 'chat_parent',
      workspace: join(dir, 'wt'),
      providerId: 'prov_1',
      worktreeBaseWorkspace: dir,
      worktreeBranch: 'atrium/feat',
      worktreeBaseBranch: 'main',
    })
    orig.title = 'Original thread'
    orig.messages = [
      { role: 'user', text: 'Step 1' },
      { role: 'assistant', text: 'Answer 1', toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'tc1', name: 'read_file', output: 'ok', isError: false },
      { role: 'user', text: 'Step 2' },
      { role: 'assistant', text: 'Answer 2', toolCalls: [] },
    ]
    await store.save(orig)

    // Fork at assistant message index 1 -> should automatically keep trailing tool result at index 2.
    const partial = await store.fork(orig.id, 1, 'branch')
    assert.equal(partial.title, 'Original thread (branch)')
    assert.equal(partial.forkedFromId, 'chat_parent')
    assert.equal(partial.forkedFromTitle, 'Original thread')
    assert.equal(partial.messages.length, 3)
    assert.equal(partial.worktreeBaseWorkspace, undefined)
    assert.equal(partial.worktreeBranch, undefined)
    assert.equal(partial.providerId, 'prov_1')

    // Full fork + mutation isolation check
    const full = await store.fork(orig.id, undefined, 'copy')
    assert.equal(full.messages.length, 5)
    ;(full.messages[0] as Extract<Message, { role: 'user' }>).text = 'Mutated'
    const reloadedOrig = await store.get(orig.id)
    assert.equal((reloadedOrig?.messages[0] as Extract<Message, { role: 'user' }>).text, 'Step 1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Git commit, CheckpointStore.markCommitted, worktree merge & conflict abort protection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-gitp0-'))
  const repo = join(root, 'repo')
  const dataDir = join(root, 'data')
  await mkdir(repo, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  try {
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['config', 'user.email', 'test@atrium.local'])
    await git(repo, ['config', 'user.name', 'Atrium Test'])
    await writeFile(join(repo, 'app.txt'), 'line1\nline2\n', 'utf8')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'chore: initial'])

    // Test direct commit + CheckpointStore.markCommitted
    const cp = new CheckpointStore(dataDir)
    const snap = await snapshotExistingFile(repo, 'app.txt')
    await writeFile(join(repo, 'app.txt'), 'line1\nline2-edited\n', 'utf8')
    await cp.record('chat_c', [snap])
    assert.equal((await cp.entries('chat_c', repo)).length, 1)

    const committed = await commitGitChanges(repo, 'feat: update app.txt')
    assert.equal(committed.branch, 'main')
    assert.match(committed.summary, /feat: update app\.txt/)
    await cp.markCommitted('chat_c', ['app.txt'])
    assert.equal((await cp.entries('chat_c', repo)).length, 0)
    assert.equal((await getGitRepoStatus(repo)).dirtyCount, 0)

    // Test clean worktree auto-commit + merge back + cleanup
    const wt = await createGitWorktree(repo, dataDir, 'chat_wt1', 'feat-clean')
    await writeFile(join(wt.worktreePath, 'feature.txt'), 'hello from worktree\n', 'utf8')
    const merged = await mergeWorktreeToBase({
      baseWorkspace: wt.baseWorkspace,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseBranch: wt.baseBranch,
      commitMessage: 'feat: worktree feature',
      cleanupWorktree: true,
    })
    assert.equal(merged.autoCommitted, true)
    assert.equal(merged.cleanedUp, true)
    assert.equal(existsSync(wt.worktreePath), false)
    assert.equal((await readFile(join(repo, 'feature.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'hello from worktree\n')

    // Test conflict abort safety: conflicting edits must abort cleanly without leaving MERGE_HEAD dirty.
    const wtConflict = await createGitWorktree(repo, dataDir, 'chat_wt2', 'feat-conflict')
    await writeFile(join(wtConflict.worktreePath, 'app.txt'), 'from worktree\n', 'utf8')
    await commitGitChanges(wtConflict.worktreePath, 'wt change')

    await writeFile(join(repo, 'app.txt'), 'from main\n', 'utf8')
    await commitGitChanges(repo, 'main conflicting change')

    await assert.rejects(
      () =>
        mergeWorktreeToBase({
          baseWorkspace: repo,
          worktreePath: wtConflict.worktreePath,
          branch: wtConflict.branch,
          baseBranch: wtConflict.baseBranch,
        }),
      /Merge conflict|aborted cleanly/i,
    )
    assert.equal((await getGitRepoStatus(repo)).dirtyCount, 0)
    assert.equal((await readFile(join(repo, 'app.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'from main\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseUnifiedDiff & formatReviewPrompt compute accurate line numbers and prompt text', () => {
  const diff = [
    '--- a/src/foo.ts',
    '+++ b/src/foo.ts',
    '@@ -10,3 +10,4 @@ function demo() {',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
    ' return a + b',
  ].join('\n')

  const parsed = parseUnifiedDiff(diff)
  const addLine = parsed.find((l) => l.text === '+const c = 4')
  const delLine = parsed.find((l) => l.text === '-const b = 2')
  assert.equal(addLine?.side, 'new')
  assert.equal(addLine?.line, 12)
  assert.equal(delLine?.side, 'old')
  assert.equal(delLine?.line, 11)

  const prompt = formatReviewPrompt('Please address these comments:', [
    { id: '1', path: 'src/foo.ts', side: 'new', line: 12, snippet: '+const c = 4', body: 'Rename c to total' },
  ])
  assert.match(prompt, /src\/foo\.ts:12/)
  assert.match(prompt, /Rename c to total/)

  const split = buildSplitDiffRows(parsed)
  const pairRows = split.filter((r) => r.kind === 'pair')
  assert.ok(pairRows.some((r) => r.left?.text === '-const b = 2' && r.right?.text === '+const b = 3'))
  assert.ok(pairRows.some((r) => !r.left && r.right?.text === '+const c = 4'))
})

test('git stageGitFiles commits only staged subset, switches/creates branches, and copies local .env into worktrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-git-stage-'))
  const repo = join(root, 'repo')
  const dataDir = join(root, 'data')
  await mkdir(repo, { recursive: true })
  try {
    await git(repo, ['init'])
    await git(repo, ['config', 'user.email', 'test@atrium.local'])
    await git(repo, ['config', 'user.name', 'Atrium Test'])
    await writeFile(join(repo, 'a.txt'), 'a0\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b0\n', 'utf8')
    await writeFile(join(repo, '.env.example'), 'API_KEY=\n', 'utf8')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'init'])
    await writeFile(join(repo, '.env'), 'SECRET=12345\n', 'utf8')

    await writeFile(join(repo, 'a.txt'), 'a1\n', 'utf8')
    await writeFile(join(repo, 'b.txt'), 'b1\n', 'utf8')
    await stageGitFiles(repo, ['a.txt'], true)
    const changes = await getGitChanges(repo)
    assert.equal(changes.find((c) => c.path === 'a.txt')?.staged, true)
    assert.equal(changes.find((c) => c.path === 'b.txt')?.staged, false)

    // Selective commit commits staged a.txt while leaving b.txt dirty in working tree
    await commitGitChanges(repo, 'feat: commit a only')
    const afterChanges = await getGitChanges(repo)
    assert.equal(afterChanges.some((c) => c.path === 'a.txt'), false)
    assert.equal(afterChanges.some((c) => c.path === 'b.txt'), true)
    await stageGitFiles(repo, ['b.txt'], true)
    await commitGitChanges(repo, 'feat: commit b')

    await checkoutGitBranch(repo, 'feat/demo', true)
    const branches = await listGitBranches(repo)
    assert.ok(branches.includes('feat/demo'))

    const wt = await createGitWorktree(repo, dataDir, 'chat_env_1', 'wt-env')
    assert.equal(await readFile(join(wt.worktreePath, '.env'), 'utf8'), 'SECRET=12345\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Document extractor parses PDF, DOCX, XLSX, and PPTX cleanly and integrates with read_file + providers', async () => {
  const ws = await mkdtemp(join(tmpdir(), 'atrium-docs-'))
  try {
    assert.equal(classifyDocumentExt('report.PDF'), 'pdf')
    assert.equal(classifyDocumentExt('legacy.xls'), 'legacy_office')

    const pdfBuf = makeMinimalPdf('Hello Atrium PDF')
    const pdfRes = await extractDocument('sample.pdf', pdfBuf)
    assert.equal(pdfRes.docKind, 'pdf')
    assert.equal(pdfRes.pageCount, 1)
    assert.match(pdfRes.content, /Hello Atrium PDF/)

    const docxBuf = makeMinimalDocx(['Quarterly Summary Heading', 'Revenue grew by 25 percent.'])
    const docxRes = await extractDocument('memo.docx', docxBuf)
    assert.equal(docxRes.docKind, 'docx')
    assert.match(docxRes.content, /Quarterly Summary Heading/)
    assert.match(docxRes.content, /Revenue grew by 25 percent/)

    const xlsxBuf = makeMinimalXlsx('Budget', [
      ['Item', 'Cost'],
      ['Cloud', '1200'],
    ])
    const xlsxRes = await extractDocument('budget.xlsx', xlsxBuf)
    assert.equal(xlsxRes.docKind, 'xlsx')
    assert.equal(xlsxRes.sheetCount, 1)
    assert.deepEqual(xlsxRes.sheetNames, ['Budget'])
    assert.match(xlsxRes.content, /\| Item \| Cost \|/)
    assert.match(xlsxRes.content, /\| Cloud \| 1200 \|/)

    const pptxBuf = makeMinimalPptx([
      { text: ['Slide One Title', 'Bullet A &amp; B'], notes: 'Remember Q4 target' },
      { text: ['Slide Two Roadmap'] },
    ])
    const pptxRes = await extractDocument('deck.pptx', pptxBuf)
    assert.equal(pptxRes.docKind, 'pptx')
    assert.equal(pptxRes.slideCount, 2)
    assert.match(pptxRes.content, /## Slide 1/)
    assert.match(pptxRes.content, /Bullet A & B/)
    assert.match(pptxRes.content, /Remember Q4 target/)
    assert.match(pptxRes.content, /## Slide 2/)

    // Verify workspace `read_file` seamlessly extracts PPTX & warns cleanly on legacy binary `.doc`
    await writeFile(join(ws, 'deck.pptx'), pptxBuf)
    await writeFile(join(ws, 'old.doc'), Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))
    const toolRes = await runReadTool(ws, 'read_file', { path: 'deck.pptx' })
    assert.equal(toolRes.isError, false)
    assert.match(toolRes.output, /\[Extracted PPTX · 2 slides\]/)
    assert.match(toolRes.output, /Slide Two Roadmap/)

    const legacyRes = await runReadTool(ws, 'read_file', { path: 'old.doc' })
    assert.equal(legacyRes.isError, true)
    assert.match(legacyRes.output, /Legacy binary Office/i)

    // Verify providers serialize attached `documents` cleanly across all 3 protocols
    const msgs: Message[] = [
      {
        role: 'user',
        text: 'Summarize the attached deck.',
        documents: [{ id: 'd1', name: 'deck.pptx', docKind: 'pptx', slideCount: 2, content: pptxRes.content }],
      },
    ]
    const anth = toAnthropicMessages(msgs)
    const oai = toOpenAiMessages('sys', msgs)
    const resp = toResponsesInput(msgs)
    assert.match(JSON.stringify(anth), /attached_document name=\\"deck\.pptx\\" kind=\\"pptx\\" slides=\\"2\\"/)
    assert.match(JSON.stringify(oai), /Slide Two Roadmap/)
    assert.match(JSON.stringify(resp), /Summarize the attached deck/)
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
