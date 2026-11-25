// Built-in file tools. Reads are free; writes wait for the user's approval.
import { execFile, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { ToolInfo, WorkspaceFilePreview } from '../../shared/types.ts'
import { classifyDocumentExt, extractDocument, MAX_DOCUMENT_BYTES } from './documents.ts'
import { getCachedWorkspaceFiles, invalidateWorkspaceFilesCache, setCachedWorkspaceFiles } from './fileCache.ts'
import { APPLY_PATCH_TOOL } from './patch.ts'
import { isDirectory, resolveInsideReal, WorkspaceError } from './workspace.ts'

export { invalidateWorkspaceFilesCache }

const READ_LIMIT = 200_000
const MAX_RESULTS = 200

export const FILE_TOOLS: ToolInfo[] = [
  {
    name: 'list_dir',
    description: 'List files and folders inside the workspace. Path is relative to the workspace root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' } },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file or extract text from PDF, DOCX, XLSX, or PPTX documents inside the workspace. Returns at most 200 KB.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        offset: { type: 'number', description: 'Line number to start at (1-based).' },
        limit: { type: 'number', description: 'Maximum number of lines.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Fast workspace search (uses ripgrep when available) for text or regular expressions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.ts".' },
        case_sensitive: { type: 'boolean', description: 'Match case strictly. Defaults to false.' },
        context_lines: { type: 'number', description: 'Optional lines of surrounding context (0-5).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact string in an existing text file inside the workspace. Prefer this over write_file when modifying existing files. The user must approve the diff first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a single unique match.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file inside the workspace. The user must approve it first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        content: { type: 'string', description: 'The full new contents of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  APPLY_PATCH_TOOL,
]

export interface FileToolResult {
  output: string
  isError: boolean
}

function str(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

export async function runReadTool(workspace: string, name: string, input: Record<string, unknown>): Promise<FileToolResult> {
  try {
    if (name === 'list_dir') return { output: await listDir(workspace, str(input, 'path')), isError: false }
    if (name === 'read_file') return { output: await readText(workspace, input), isError: false }
    if (name === 'search') return { output: await search(workspace, input), isError: false }
    return { output: `Unknown tool: ${name}`, isError: true }
  } catch (err) {
    return { output: err instanceof WorkspaceError ? err.message : (err as Error).message, isError: true }
  }
}

async function listDir(workspace: string, requested: string): Promise<string> {
  const dir = await resolveInsideReal(workspace, requested || '.')
  if (!(await isDirectory(dir))) return `"${requested || '.'}" is not a directory.`
  const entries = await readdir(dir, { withFileTypes: true })
  const lines = entries
    .slice(0, MAX_RESULTS)
    .map((e) => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`)
  if (entries.length > MAX_RESULTS) lines.push(`… and ${entries.length - MAX_RESULTS} more`)
  return lines.join('\n') || '(empty directory)'
}

async function loadReadableContent(
  file: string,
  size: number,
  maxTextBytes: number,
): Promise<{ text: string; kind: 'text' | 'document' }> {
  const docKind = classifyDocumentExt(file)
  if (docKind === 'legacy_office') {
    throw new WorkspaceError('Legacy binary Office formats (.doc/.xls/.ppt) are not supported. Save as .docx/.xlsx/.pptx or PDF.')
  }
  if (docKind) {
    if (size > MAX_DOCUMENT_BYTES) {
      throw new WorkspaceError(`Document is ${Math.round(size / (1024 * 1024))} MB, exceeding the 25 MB limit.`)
    }
    const buf = await readFile(file)
    const extracted = await extractDocument(file, buf)
    const details = [
      extracted.docKind.toUpperCase(),
      extracted.pageCount ? `${extracted.pageCount} pages` : '',
      extracted.sheetCount ? `${extracted.sheetCount} sheets (${extracted.sheetNames?.join(', ') ?? ''})` : '',
      extracted.slideCount ? `${extracted.slideCount} slides` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      text: `[Extracted ${details}]\n\n${extracted.content}`,
      kind: 'document',
    }
  }
  if (size > maxTextBytes) {
    throw new WorkspaceError(`File is ${size} bytes, too large to read whole. Narrow it with offset and limit.`)
  }
  const text = await readFile(file, 'utf8')
  if (text.includes('\u0000')) {
    throw new WorkspaceError('Binary file cannot be previewed or read as text.')
  }
  return { text, kind: 'text' }
}

async function readText(workspace: string, input: Record<string, unknown>): Promise<string> {
  const file = await resolveInsideReal(workspace, str(input, 'path'))
  const info = await stat(file)
  if (info.isDirectory()) return `"${str(input, 'path')}" is a directory. Use list_dir.`
  const loaded = await loadReadableContent(file, info.size, 5_000_000)
  const all = loaded.text.split(/\r?\n/)
  const offset = Math.max(1, Number(input.offset) || 1)
  const limit = Math.min(all.length, Number(input.limit) || all.length)
  const slice = all.slice(offset - 1, offset - 1 + limit).join('\n')
  return slice.length > READ_LIMIT ? `${slice.slice(0, READ_LIMIT)}\n… truncated` : slice
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache', 'coverage'])

async function search(workspace: string, input: Record<string, unknown>): Promise<string> {
  const query = str(input, 'query')
  if (!query) return 'A query is required.'
  const root = await resolveInsideReal(workspace, str(input, 'path') || '.')
  const glob = str(input, 'glob')
  const caseSensitive = input.case_sensitive === true
  const rawCtx = Number(input.context_lines)
  const contextLines = Number.isFinite(rawCtx) ? Math.min(5, Math.max(0, Math.floor(rawCtx))) : 0

  const rgResult = await searchWithRipgrep(workspace, root, query, glob, caseSensitive, contextLines)
  if (rgResult !== null) return rgResult

  return searchFallback(workspace, root, query, glob, caseSensitive)
}

async function runRg(args: string[], cwd: string, maxChars = 150_000): Promise<{ code: number | null; stdout: string; enoent?: boolean }> {
  return new Promise((done) => {
    let stdout = ''
    const child = spawn('rg', args, { cwd, windowsHide: true })
    const timer = setTimeout(() => child.kill(), 8000)
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxChars) stdout += d.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
      done({ code: null, stdout: '', enoent })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout })
    })
  })
}

async function searchWithRipgrep(
  workspace: string,
  root: string,
  query: string,
  glob: string,
  caseSensitive: boolean,
  contextLines: number,
): Promise<string | null> {
  const baseArgs = ['--line-number', '--no-heading', '--color', 'never', '--max-filesize', '2M']
  baseArgs.push(caseSensitive ? '--case-sensitive' : '--ignore-case')
  if (contextLines > 0) baseArgs.push('--context', String(contextLines))
  for (const dir of SKIP_DIRS) baseArgs.push('--glob', `!${dir}/**`)
  if (glob) baseArgs.push('--glob', glob)

  let res = await runRg([...baseArgs, '--', query, root], workspace)
  if (res.enoent) return null
  if (res.code === 2) {
    // Invalid regex syntax: retry cleanly as literal substring search.
    res = await runRg([...baseArgs, '--fixed-strings', '--', query, root], workspace)
    if (res.enoent) return null
  }
  if (res.code !== 0 && res.code !== 1) return null
  if (res.code === 1 || !res.stdout.trim()) return 'No matches.'

  const wsReal = await resolveInsideReal(workspace, '.').catch(() => resolve(workspace))
  const out: string[] = []
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    if (!rawLine) continue
    if (rawLine === '--') {
      out.push('--')
      continue
    }
    // rg emits `<absPath>:<line>:<text>` or `<absPath>-<line>-<text>` (context).
    const m = /^(.+?)([:-])(\d+)\2(.*)$/.exec(rawLine)
    if (m) {
      const rel = relative(wsReal, m[1]!).replace(/\\/g, '/')
      out.push(`${rel}${m[2]}${m[3]}${m[2]} ${m[4]!.trim().slice(0, 200)}`)
    } else {
      out.push(rawLine.slice(0, 220))
    }
    if (out.length >= MAX_RESULTS) {
      out.push(`… (limited to ${MAX_RESULTS} matches)`)
      break
    }
  }
  return out.join('\n') || 'No matches.'
}

async function searchFallback(
  workspace: string,
  root: string,
  query: string,
  glob: string,
  caseSensitive: boolean,
): Promise<string> {
  const flags = caseSensitive ? '' : 'i'
  let pattern: RegExp
  try {
    pattern = new RegExp(query, flags)
  } catch {
    pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }
  const hits: string[] = []
  await walk(root, async (file) => {
    if (hits.length >= MAX_RESULTS) return
    if (glob && !matchGlob(file.slice(root.length), glob)) return
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return
    }
    if (text.includes('\u0000')) return
    text.split(/\r?\n/).forEach((line, i) => {
      if (hits.length < MAX_RESULTS && pattern.test(line)) {
        hits.push(`${relative(resolve(workspace), file).replace(/\\/g, '/')}:${i + 1}: ${line.trim().slice(0, 200)}`)
      }
    })
  })
  return hits.join('\n') || 'No matches.'
}

async function walk(dir: string, visit: (file: string) => Promise<void>, shouldStop?: () => boolean): Promise<void> {
  if (shouldStop?.()) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (shouldStop?.()) return
    if (SKIP_DIRS.has(entry.name)) continue
    const full = `${dir}${sep}${entry.name}`
    if (entry.isDirectory()) await walk(full, visit, shouldStop)
    else if (entry.isFile()) await visit(full)
  }
}

function hasSkipDir(rel: string): boolean {
  return rel.split('/').some((seg) => SKIP_DIRS.has(seg))
}

async function listFilesWithRg(root: string, limit: number): Promise<{ files: string[]; truncated: boolean } | null> {
  const skipGlobs: string[] = []
  for (const dir of SKIP_DIRS) skipGlobs.push('--glob', `!${dir}/**`)

  const RG_FILES_MAX_CHARS = 1_500_000
  let res = await runRg(['--files', '--hidden', '--no-require-git', ...skipGlobs], root, RG_FILES_MAX_CHARS)
  if (res.enoent) return null
  if (res.code === 2) {
    res = await runRg(['--files', '--hidden', ...skipGlobs], root, RG_FILES_MAX_CHARS)
    if (res.enoent) return null
  }
  if (res.code !== 0 && res.code !== 1) return null
  if (res.code === 1 && !res.stdout.trim()) return { files: [], truncated: false }

  let stdout = res.stdout
  let truncatedByCap = false
  if (stdout.length >= RG_FILES_MAX_CHARS) {
    truncatedByCap = true
    const lastNl = stdout.lastIndexOf('\n')
    if (lastNl >= 0) stdout = stdout.slice(0, lastNl)
  }

  const raw = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !hasSkipDir(p))
  const sorted = raw.sort((a, b) => a.localeCompare(b))
  return { files: sorted.slice(0, limit), truncated: truncatedByCap || sorted.length > limit }
}

async function listFilesWithGit(root: string, limit: number): Promise<{ files: string[]; truncated: boolean } | null> {
  const out = await new Promise<{ code: number | null; stdout: string }>((done) => {
    let settled = false
    const finish = (res: { code: number | null; stdout: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(res)
    }
    const child = execFile(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
        finish({ code, stdout: stdout ?? '' })
      },
    )
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: 1, stdout: '' })
    }, 8000)
  })
  if (out.code !== 0) return null
  const unique = Array.from(
    new Set(
      out.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((p) => p.replace(/\\/g, '/'))
        .filter((p) => !hasSkipDir(p)),
    ),
  )
  unique.sort((a, b) => a.localeCompare(b))
  return { files: unique.slice(0, limit), truncated: unique.length > limit }
}

/** Lists relative file paths inside the workspace for composer @-mentions and file drawer. */
export async function listWorkspaceFiles(workspace: string | undefined, limit = 1500): Promise<string[]> {
  if (!workspace) return []
  try {
    const root = await resolveInsideReal(workspace, '.')
    if (!(await isDirectory(root))) return []
    const cached = getCachedWorkspaceFiles(root, workspace, limit)
    if (cached) return cached

    let listed = await listFilesWithRg(root, limit)
    if (!listed) listed = await listFilesWithGit(root, limit)
    if (!listed) {
      const files: string[] = []
      await walk(
        root,
        async (file) => {
          if (files.length <= limit) files.push(relative(root, file).replace(/\\/g, '/'))
        },
        () => files.length > limit,
      )
      const truncated = files.length > limit
      const sorted = files.slice(0, limit).sort((a, b) => a.localeCompare(b))
      listed = { files: sorted, truncated }
    }

    setCachedWorkspaceFiles(root, workspace, limit, listed.files, listed.truncated)
    return listed.files
  } catch {
    return []
  }
}

const PREVIEW_CHAR_LIMIT = 200_000

/** Reads a workspace file safely for UI preview inside the file viewer modal. */
export async function readWorkspacePreview(workspace: string | undefined, requested: string): Promise<WorkspaceFilePreview> {
  if (!workspace) throw new WorkspaceError('No workspace folder is set.')
  const file = await resolveInsideReal(workspace, requested)
  const info = await stat(file)
  if (info.isDirectory()) throw new WorkspaceError(`"${requested}" is a directory.`)
  const docKind = classifyDocumentExt(file)
  if (!docKind && info.size > 4_000_000) {
    return {
      path: requested,
      content: `File is ${Math.round(info.size / 1024)} KB, too large to preview in full.`,
      truncated: true,
      size: info.size,
    }
  }
  const loaded = await loadReadableContent(file, info.size, 4_000_000)
  const truncated = loaded.text.length > PREVIEW_CHAR_LIMIT
  return {
    path: requested,
    content: truncated ? `${loaded.text.slice(0, PREVIEW_CHAR_LIMIT)}\n…(truncated)` : loaded.text,
    truncated,
    size: info.size,
  }
}

function matchGlob(filePath: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE::')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/::DOUBLE::/g, '.*')
  return new RegExp(`${escaped}$`, 'i').test(filePath.replace(/\\/g, '/'))
}

/** Writes a file. Caller must already have the user's approval. */
export async function writeApproved(workspace: string, requested: string, content: string): Promise<void> {
  const file = await resolveInsideReal(workspace, requested)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  invalidateWorkspaceFilesCache(workspace)
}

/** Saves a generated artifact cleanly inside the active workspace after validating path containment. */
export async function saveArtifactFile(workspace: string | undefined, requested: string, content: string): Promise<string> {
  if (!workspace) throw new WorkspaceError('No workspace folder is set.')
  const clean = requested.trim().replace(/^[/\\]+/, '')
  if (!clean) throw new WorkspaceError('A file path is required.')
  const file = await resolveInsideReal(workspace, clean)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  invalidateWorkspaceFilesCache(workspace)
  const root = await realpath(resolve(workspace)).catch(() => resolve(workspace))
  return relative(root, file).replace(/\\/g, '/')
}

export interface PreparedEdit {
  path: string
  nextContent: string
  diff: string
  replacements: number
}

/** Builds a compact unified diff for approval review. */
export function buildUnifiedDiff(filePath: string, before: string, after: string): string {
  const aLines = before.replace(/\r\n/g, '\n').split('\n')
  const bLines = after.replace(/\r\n/g, '\n').split('\n')
  let prefix = 0
  while (prefix < aLines.length && prefix < bLines.length && aLines[prefix] === bLines[prefix]) prefix++
  let suffix = 0
  while (
    suffix < aLines.length - prefix &&
    suffix < bLines.length - prefix &&
    aLines[aLines.length - 1 - suffix] === bLines[bLines.length - 1 - suffix]
  ) {
    suffix++
  }
  const midA = aLines.slice(prefix, aLines.length - suffix)
  const midB = bLines.slice(prefix, bLines.length - suffix)
  const ctxBeforeStart = Math.max(0, prefix - 3)
  const ctxAfterEndA = Math.min(aLines.length, aLines.length - suffix + 3)
  const header = `--- a/${filePath}\n+++ b/${filePath}\n@@ -${ctxBeforeStart + 1},${ctxAfterEndA - ctxBeforeStart} +${ctxBeforeStart + 1},${ctxBeforeStart + (prefix - ctxBeforeStart) + midB.length + (ctxAfterEndA - (aLines.length - suffix))} @@`
  const out: string[] = [header]
  for (let i = ctxBeforeStart; i < prefix; i++) out.push(` ${aLines[i]}`)
  for (const l of midA) out.push(`-${l}`)
  for (const l of midB) out.push(`+${l}`)
  for (let i = aLines.length - suffix; i < ctxAfterEndA; i++) out.push(` ${aLines[i]}`)
  return out.join('\n')
}

/** Validates an exact-match edit before asking the user for approval. */
export async function prepareEdit(workspace: string, input: Record<string, unknown>): Promise<PreparedEdit> {
  const requested = str(input, 'path')
  const oldString = typeof input.old_string === 'string' ? input.old_string : ''
  const newString = typeof input.new_string === 'string' ? input.new_string : ''
  const replaceAll = input.replace_all === true

  if (!requested) throw new Error('File path is required.')
  if (!oldString) throw new Error('old_string must be a non-empty string.')
  if (oldString === newString) throw new Error('new_string must differ from old_string.')

  const file = await resolveInsideReal(workspace, requested)
  const info = await stat(file)
  if (info.isDirectory()) throw new Error(`"${requested}" is a directory.`)
  const current = await readFile(file, 'utf8')

  let matchOld = oldString
  let matchNew = newString
  if (!current.includes(matchOld) && current.includes('\r\n') && !oldString.includes('\r\n')) {
    const crlfOld = oldString.replace(/\n/g, '\r\n')
    if (current.includes(crlfOld)) {
      matchOld = crlfOld
      matchNew = newString.replace(/\n/g, '\r\n')
    }
  }

  const count = current.split(matchOld).length - 1
  if (count === 0) throw new Error(`old_string was not found in "${requested}". Read the file and copy the exact text.`)
  if (!replaceAll && count > 1) {
    throw new Error(`old_string matched ${count} places in "${requested}". Include more context lines or set replace_all: true.`)
  }

  const nextContent = replaceAll ? current.split(matchOld).join(matchNew) : current.replace(matchOld, () => matchNew)
  return {
    path: requested,
    nextContent,
    diff: buildUnifiedDiff(requested, current, nextContent),
    replacements: replaceAll ? count : 1,
  }
}

/** Returns a unified diff if overwriting an existing file, or raw content for new files. */
export async function prepareWriteDiff(workspace: string, requested: string, newContent: string): Promise<string> {
  try {
    const file = await resolveInsideReal(workspace, requested)
    const info = await stat(file)
    if (!info.isFile() || info.size > 500_000) return newContent
    const before = await readFile(file, 'utf8')
    if (before === newContent) return newContent
    return buildUnifiedDiff(requested, before, newContent)
  } catch {
    return newContent
  }
}

const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md']
const INSTRUCTION_CHAR_LIMIT = 12_000

/** Loads project instructions (AGENTS.md / CLAUDE.md) inside the active workspace. */
export async function loadProjectInstructions(workspace: string | undefined): Promise<string> {
  if (!workspace) return ''
  const parts: string[] = []
  let total = 0
  for (const rel of INSTRUCTION_FILES) {
    if (total >= INSTRUCTION_CHAR_LIMIT) break
    try {
      const file = await resolveInsideReal(workspace, rel)
      const info = await stat(file)
      if (!info.isFile() || info.size > 200_000) continue
      const content = (await readFile(file, 'utf8')).trim()
      if (!content) continue
      const remaining = INSTRUCTION_CHAR_LIMIT - total
      const slice = content.length > remaining ? `${content.slice(0, remaining)}\n…(truncated)` : content
      parts.push(`## ${rel}\n${slice}`)
      total += slice.length
    } catch {
      /* optional file */
    }
  }
  return parts.length ? `# Workspace Instructions\n${parts.join('\n\n')}` : ''
}
