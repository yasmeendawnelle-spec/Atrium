// Multi-file atomic patch parser and applier.
// Supports both Codex `*** Begin Patch` format and standard unified diffs.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import type { ToolInfo } from '../../shared/types.ts'
import { invalidateWorkspaceFilesCache } from './fileCache.ts'
import { resolveInside, resolveInsideReal, WorkspaceError } from './workspace.ts'

export const APPLY_PATCH_TOOL: ToolInfo = {
  name: 'apply_patch',
  description:
    'Apply an atomic multi-file patch inside the workspace. Supports both Codex "*** Begin Patch" ("*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:") and standard unified diff ("--- a/...", "+++ b/..."). The user must approve the combined diff first.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'Multi-file patch text in Codex Begin Patch or unified diff format.',
      },
    },
    required: ['patch'],
  },
}

interface PatchHunk {
  oldStartHint?: number
  headerContext?: string
  lines: Array<{ kind: 'ctx' | 'del' | 'add'; text: string }>
}

type ParsedPatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: PatchHunk[] }

export interface FilePreImage {
  path: string
  fromPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  beforeExists: boolean
  beforeContent?: string
  afterExists: boolean
  afterContent?: string
  diff: string
}

interface PlannedWriteOp {
  targetAbs: string
  deleteAbs?: string
  writeContent?: string
}

export interface PreparedPatch {
  summary: string
  diff: string
  files: FilePreImage[]
  ops: PlannedWriteOp[]
}

function cleanRelPath(raw: string): string {
  let s = raw.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  s = s.replace(/\\/g, '/')
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2)
  if (s.startsWith('./')) s = s.slice(2)
  return posix.normalize(s).replace(/^\/+/, '')
}

/** Validates existing files or nearest existing ancestor for newly created files inside `workspace`. */
async function resolveTargetInside(workspace: string, requested: string): Promise<string> {
  const lexical = resolveInside(workspace, requested)
  try {
    return await resolveInsideReal(workspace, requested)
  } catch (err) {
    if (err instanceof WorkspaceError) throw err
    // Check nearest existing ancestor via realpath so symlinked parent directories cannot escape.
    let probe = dirname(lexical)
    const rootLex = resolveInside(workspace, '.')
    while (probe.length >= rootLex.length) {
      try {
        await resolveInsideReal(workspace, '.')
        const s = await stat(probe).catch(() => null)
        if (s) {
          await resolveInsideReal(workspace, probe.slice(rootLex.length).replace(/^[\\/]+/, '') || '.')
          break
        }
      } catch (e) {
        if (e instanceof WorkspaceError) throw e
      }
      const parent = dirname(probe)
      if (parent === probe) break
      probe = parent
    }
    return lexical
  }
}

export function buildCompactDiff(
  filePath: string,
  before: string | undefined,
  after: string | undefined,
  fromPath?: string,
): string {
  const aHeader = before === undefined ? '--- /dev/null' : `--- a/${fromPath ?? filePath}`
  const bHeader = after === undefined ? '+++ /dev/null' : `+++ b/${filePath}`
  const aLines = before === undefined ? [] : before.replace(/\r\n/g, '\n').split('\n')
  const bLines = after === undefined ? [] : after.replace(/\r\n/g, '\n').split('\n')

  if (before === undefined) {
    const body = bLines.map((l) => `+${l}`).join('\n')
    return `${aHeader}\n${bHeader}\n@@ -0,0 +1,${bLines.length} @@\n${body}`
  }
  if (after === undefined) {
    const body = aLines.map((l) => `-${l}`).join('\n')
    return `${aHeader}\n${bHeader}\n@@ -1,${aLines.length} +0,0 @@\n${body}`
  }

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
  if (midA.length === 0 && midB.length === 0 && fromPath && fromPath !== filePath) {
    return `${aHeader}\n${bHeader}\n@@ -1,0 +1,0 @@\n (renamed)`
  }
  const ctxBeforeStart = Math.max(0, prefix - 3)
  const ctxAfterEndA = Math.min(aLines.length, aLines.length - suffix + 3)
  const oldCount = ctxAfterEndA - ctxBeforeStart
  const newCount = prefix - ctxBeforeStart + midB.length + (ctxAfterEndA - (aLines.length - suffix))
  const header = `${aHeader}\n${bHeader}\n@@ -${ctxBeforeStart + 1},${oldCount} +${ctxBeforeStart + 1},${newCount} @@`
  const out: string[] = [header]
  for (let i = ctxBeforeStart; i < prefix; i++) out.push(` ${aLines[i]}`)
  for (const l of midA) out.push(`-${l}`)
  for (const l of midB) out.push(`+${l}`)
  for (let i = aLines.length - suffix; i < ctxAfterEndA; i++) out.push(` ${aLines[i]}`)
  return out.join('\n')
}

export function parsePatchText(rawPatch: string): ParsedPatchOp[] {
  const normalized = rawPatch.replace(/\r\n/g, '\n').trim()
  if (!normalized) throw new Error('Patch text cannot be empty.')
  if (normalized.includes('*** Begin Patch') || /^\*\*\* (?:Add|Update|Delete) File:/m.test(normalized)) {
    return parseCodexPatch(normalized)
  }
  if (/^--- .+\n\+\+\+ /m.test(normalized)) {
    return parseUnifiedDiff(normalized)
  }
  throw new Error('Unrecognized patch format. Use Codex "*** Begin Patch" or unified diff ("--- a/... / +++ b/...").')
}

function parseCodexPatch(text: string): ParsedPatchOp[] {
  const lines = text.split('\n')
  let idx = lines.findIndex((l) => l.trim() === '*** Begin Patch')
  idx = idx >= 0 ? idx + 1 : 0

  const ops: ParsedPatchOp[] = []
  while (idx < lines.length) {
    const line = lines[idx]!
    if (line.trim() === '*** End Patch') break
    if (!line.trim()) {
      idx++
      continue
    }
    if (line.startsWith('*** Add File:')) {
      const path = cleanRelPath(line.slice('*** Add File:'.length))
      if (!path) throw new Error('Missing path in "*** Add File:".')
      idx++
      const added: string[] = []
      while (idx < lines.length && !lines[idx]!.startsWith('*** ')) {
        const l = lines[idx]!
        if (l === '\\ No newline at end of file') {
          idx++
          continue
        }
        added.push(l.startsWith('+') ? l.slice(1) : l)
        idx++
      }
      ops.push({ kind: 'add', path, content: added.join('\n') })
      continue
    }
    if (line.startsWith('*** Delete File:')) {
      const path = cleanRelPath(line.slice('*** Delete File:'.length))
      if (!path) throw new Error('Missing path in "*** Delete File:".')
      ops.push({ kind: 'delete', path })
      idx++
      continue
    }
    if (line.startsWith('*** Update File:')) {
      const path = cleanRelPath(line.slice('*** Update File:'.length))
      if (!path) throw new Error('Missing path in "*** Update File:".')
      idx++
      let moveTo: string | undefined
      if (idx < lines.length && lines[idx]!.startsWith('*** Move to:')) {
        moveTo = cleanRelPath(lines[idx]!.slice('*** Move to:'.length))
        idx++
      }
      const hunks: PatchHunk[] = []
      let current: PatchHunk | null = null
      while (idx < lines.length) {
        const l = lines[idx]!
        if (l === '*** End of File') {
          idx++
          continue
        }
        if (l.startsWith('*** ')) break
        if (l.startsWith('@@')) {
          if (current && current.lines.length > 0) hunks.push(current)
          const parsedHeader = /^@@\s*(?:-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@)?\s*(.*)$/.exec(l)
          current = {
            oldStartHint: parsedHeader?.[1] ? Number(parsedHeader[1]) : undefined,
            headerContext: parsedHeader?.[3]?.trim() || l.slice(2).trim() || undefined,
            lines: [],
          }
          idx++
          continue
        }
        if (!current) current = { lines: [] }
        if (l.startsWith('+')) current.lines.push({ kind: 'add', text: l.slice(1) })
        else if (l.startsWith('-')) current.lines.push({ kind: 'del', text: l.slice(1) })
        else if (l.startsWith(' ')) current.lines.push({ kind: 'ctx', text: l.slice(1) })
        else current.lines.push({ kind: 'ctx', text: l })
        idx++
      }
      if (current && current.lines.length > 0) hunks.push(current)
      if (hunks.length === 0 && !moveTo) {
        throw new Error(`No hunks specified for "${path}".`)
      }
      ops.push({ kind: 'update', path, moveTo, hunks })
      continue
    }
    throw new Error(`Unexpected line in patch at line ${idx + 1}: "${line}"`)
  }
  if (ops.length === 0) throw new Error('Patch contains no file operations.')
  return ops
}

function parseUnifiedDiff(text: string): ParsedPatchOp[] {
  const lines = text.split('\n')
  const ops: ParsedPatchOp[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.startsWith('--- ')) {
      i++
      continue
    }
    const oldRaw = line.slice(4).split('\t')[0]!.trim()
    i++
    if (i >= lines.length || !lines[i]!.startsWith('+++ ')) {
      throw new Error(`Expected "+++ " line after "${line}".`)
    }
    const newRaw = lines[i]!.slice(4).split('\t')[0]!.trim()
    i++

    const isAdd = oldRaw === '/dev/null'
    const isDelete = newRaw === '/dev/null'
    const oldPath = isAdd ? '' : cleanRelPath(oldRaw)
    const newPath = isDelete ? '' : cleanRelPath(newRaw)
    const hunks: PatchHunk[] = []

    while (i < lines.length && !lines[i]!.startsWith('--- ') && !lines[i]!.startsWith('diff --git ')) {
      const hLine = lines[i]!
      if (!hLine.startsWith('@@')) {
        i++
        continue
      }
      const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(hLine)
      const hunk: PatchHunk = {
        oldStartHint: m?.[1] ? Number(m[1]) : undefined,
        headerContext: m?.[3]?.trim() || undefined,
        lines: [],
      }
      i++
      while (
        i < lines.length &&
        !lines[i]!.startsWith('@@') &&
        !lines[i]!.startsWith('--- ') &&
        !lines[i]!.startsWith('diff --git ')
      ) {
        const bl = lines[i]!
        if (bl === '\\ No newline at end of file') {
          i++
          continue
        }
        if (bl.startsWith('+')) hunk.lines.push({ kind: 'add', text: bl.slice(1) })
        else if (bl.startsWith('-')) hunk.lines.push({ kind: 'del', text: bl.slice(1) })
        else if (bl.startsWith(' ')) hunk.lines.push({ kind: 'ctx', text: bl.slice(1) })
        else if (bl === '') hunk.lines.push({ kind: 'ctx', text: '' })
        else break
        i++
      }
      hunks.push(hunk)
    }

    if (isAdd) {
      const addedLines = hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'del').map((l) => l.text))
      ops.push({ kind: 'add', path: newPath, content: addedLines.join('\n') })
    } else if (isDelete) {
      ops.push({ kind: 'delete', path: oldPath })
    } else {
      ops.push({
        kind: 'update',
        path: oldPath,
        ...(newPath && newPath !== oldPath ? { moveTo: newPath } : {}),
        hunks,
      })
    }
  }
  if (ops.length === 0) throw new Error('Unified diff contains no valid file hunks.')
  return ops
}

function matchesAt(lines: string[], start: number, target: string[], loose: boolean): boolean {
  if (start < 0 || start + target.length > lines.length) return false
  for (let i = 0; i < target.length; i++) {
    const a = lines[start + i]!
    const b = target[i]!
    if (loose ? a.trimEnd() !== b.trimEnd() : a !== b) return false
  }
  return true
}

function applyHunksToContent(path: string, currentRaw: string, hunks: PatchHunk[]): string {
  const eol = currentRaw.includes('\r\n') ? '\r\n' : '\n'
  const lines = currentRaw.replace(/\r\n/g, '\n').split('\n')
  let cursor = 0

  for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
    const hunk = hunks[hIdx]!
    const pattern = hunk.lines.filter((l) => l.kind !== 'add').map((l) => l.text)
    const replacement = hunk.lines.filter((l) => l.kind !== 'del').map((l) => l.text)

    if (pattern.length === 0) {
      const insertAt = hunk.oldStartHint ? Math.min(lines.length, Math.max(0, hunk.oldStartHint - 1)) : lines.length
      lines.splice(insertAt, 0, ...replacement)
      cursor = insertAt + replacement.length
      continue
    }

    let matchPos = -1
    if (hunk.oldStartHint && hunk.oldStartHint > 0) {
      const hinted = hunk.oldStartHint - 1
      if (matchesAt(lines, hinted, pattern, false)) matchPos = hinted
    }

    if (matchPos < 0) {
      const exactHits: number[] = []
      for (let i = cursor; i <= lines.length - pattern.length; i++) {
        if (matchesAt(lines, i, pattern, false)) exactHits.push(i)
      }
      if (exactHits.length === 1) {
        matchPos = exactHits[0]!
      } else if (exactHits.length > 1) {
        // Also try searching above cursor just in case, still failing if ambiguous.
        throw new Error(
          `Hunk #${hIdx + 1} in "${path}" matched ${exactHits.length} locations. Include more context lines.`,
        )
      }
    }

    if (matchPos < 0) {
      // Retry across the entire file cleanly (handles out-of-order hunks or shifted offsets).
      const allExact: number[] = []
      for (let i = 0; i <= lines.length - pattern.length; i++) {
        if (matchesAt(lines, i, pattern, false)) allExact.push(i)
      }
      if (allExact.length === 1) matchPos = allExact[0]!
      else if (allExact.length > 1) {
        throw new Error(`Hunk #${hIdx + 1} in "${path}" matched ${allExact.length} places. Add more context lines.`)
      }
    }

    if (matchPos < 0) {
      const looseHits: number[] = []
      for (let i = 0; i <= lines.length - pattern.length; i++) {
        if (matchesAt(lines, i, pattern, true)) looseHits.push(i)
      }
      if (looseHits.length === 1) matchPos = looseHits[0]!
    }

    if (matchPos < 0) {
      throw new Error(`Hunk #${hIdx + 1} in "${path}" could not find target context lines:\n${pattern.slice(0, 4).join('\n')}`)
    }

    lines.splice(matchPos, pattern.length, ...replacement)
    cursor = matchPos + replacement.length
  }

  return lines.join(eol)
}

/** Validates and previews an atomic multi-file patch without writing to disk. */
export async function preparePatch(workspace: string, input: Record<string, unknown>): Promise<PreparedPatch> {
  const patchText = typeof input.patch === 'string' ? input.patch : ''
  const parsed = parsePatchText(patchText)
  const touched = new Set<string>()
  const files: FilePreImage[] = []
  const ops: PlannedWriteOp[] = []

  for (const op of parsed) {
    if (op.kind === 'add') {
      if (touched.has(op.path)) throw new Error(`Duplicate patch operation on "${op.path}".`)
      touched.add(op.path)
      const targetAbs = await resolveTargetInside(workspace, op.path)
      let beforeExists = false
      let beforeContent: string | undefined
      try {
        const s = await stat(targetAbs)
        if (s.isDirectory()) throw new Error(`"${op.path}" is a directory.`)
        beforeExists = true
        beforeContent = await readFile(targetAbs, 'utf8')
      } catch (err) {
        if (err instanceof Error && err.message.includes('is a directory')) throw err
      }
      files.push({
        path: op.path,
        status: beforeExists ? 'modified' : 'added',
        beforeExists,
        beforeContent,
        afterExists: true,
        afterContent: op.content,
        diff: buildCompactDiff(op.path, beforeContent, op.content),
      })
      ops.push({ targetAbs, writeContent: op.content })
      continue
    }

    if (op.kind === 'delete') {
      if (touched.has(op.path)) throw new Error(`Duplicate patch operation on "${op.path}".`)
      touched.add(op.path)
      const srcAbs = await resolveInsideReal(workspace, op.path)
      const s = await stat(srcAbs)
      if (s.isDirectory()) throw new Error(`"${op.path}" is a directory and cannot be deleted as a file.`)
      const beforeContent = await readFile(srcAbs, 'utf8')
      files.push({
        path: op.path,
        status: 'deleted',
        beforeExists: true,
        beforeContent,
        afterExists: false,
        diff: buildCompactDiff(op.path, beforeContent, undefined),
      })
      ops.push({ targetAbs: srcAbs, deleteAbs: srcAbs })
      continue
    }

    // Update (optionally with Move to)
    if (touched.has(op.path)) throw new Error(`Duplicate patch operation on "${op.path}".`)
    touched.add(op.path)
    const srcAbs = await resolveInsideReal(workspace, op.path)
    const s = await stat(srcAbs)
    if (s.isDirectory()) throw new Error(`"${op.path}" is a directory.`)
    const beforeContent = await readFile(srcAbs, 'utf8')
    const afterContent = op.hunks.length > 0 ? applyHunksToContent(op.path, beforeContent, op.hunks) : beforeContent

    if (op.moveTo && op.moveTo !== op.path) {
      const destAbs = await resolveTargetInside(workspace, op.moveTo)
      touched.add(op.moveTo)
      files.push({
        path: op.moveTo,
        fromPath: op.path,
        status: 'renamed',
        beforeExists: true,
        beforeContent,
        afterExists: true,
        afterContent,
        diff: buildCompactDiff(op.moveTo, beforeContent, afterContent, op.path),
      })
      ops.push({ targetAbs: destAbs, deleteAbs: srcAbs, writeContent: afterContent })
    } else {
      files.push({
        path: op.path,
        status: 'modified',
        beforeExists: true,
        beforeContent,
        afterExists: true,
        afterContent,
        diff: buildCompactDiff(op.path, beforeContent, afterContent),
      })
      ops.push({ targetAbs: srcAbs, writeContent: afterContent })
    }
  }

  const labelList = files.map((f) => f.path).slice(0, 3).join(', ')
  const extra = files.length > 3 ? ` +${files.length - 3} more` : ''
  return {
    summary: `Apply patch (${files.length} file${files.length === 1 ? '' : 's'}: ${labelList}${extra})`,
    diff: files.map((f) => f.diff).join('\n\n'),
    files,
    ops,
  }
}

/** Executes a prepared patch atomically, rolling back on error. */
export async function applyPreparedPatch(prepared: PreparedPatch): Promise<void> {
  const rollback: Array<() => Promise<void>> = []
  try {
    for (let i = 0; i < prepared.ops.length; i++) {
      const op = prepared.ops[i]!
      const meta = prepared.files[i]!
      if (op.deleteAbs && op.writeContent === undefined) {
        await rm(op.deleteAbs, { force: true })
        rollback.push(async () => {
          await mkdir(dirname(op.deleteAbs!), { recursive: true })
          await writeFile(op.deleteAbs!, meta.beforeContent ?? '', 'utf8')
        })
      } else if (op.writeContent !== undefined) {
        await mkdir(dirname(op.targetAbs), { recursive: true })
        await writeFile(op.targetAbs, op.writeContent, 'utf8')
        if (op.deleteAbs && op.deleteAbs !== op.targetAbs) {
          await rm(op.deleteAbs, { force: true })
          rollback.push(async () => {
            await rm(op.targetAbs, { force: true }).catch(() => undefined)
            await mkdir(dirname(op.deleteAbs!), { recursive: true })
            await writeFile(op.deleteAbs!, meta.beforeContent ?? '', 'utf8')
          })
        } else {
          rollback.push(async () => {
            if (meta.beforeExists) {
              await writeFile(op.targetAbs, meta.beforeContent ?? '', 'utf8')
            } else {
              await rm(op.targetAbs, { force: true })
            }
          })
        }
      }
    }
  } catch (err) {
    for (let j = rollback.length - 1; j >= 0; j--) {
      await rollback[j]!().catch(() => undefined)
    }
    throw err
  } finally {
    for (const op of prepared.ops) {
      invalidateWorkspaceFilesCache(op.targetAbs)
      if (op.deleteAbs) invalidateWorkspaceFilesCache(op.deleteAbs)
    }
  }
}
