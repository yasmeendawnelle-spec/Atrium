// Git workspace inspection and isolated Git worktree management.
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FileChangeEntry, GitCommitResult, GitHubIssueSummary, GitPrUrlResult, GitPushResult, GitRepoStatus, WorktreeMergeResult } from '../../shared/types.ts'
import { netFetch } from '../net.ts'
import { buildCompactDiff } from './patch.ts'

const DIFF_CHAR_CAP = 48_000

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 10_000,
  maxBuffer = 4 * 1024 * 1024,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    let settled = false
    const finish = (res: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(res)
    }
    const child = execFile('git', args, { cwd, windowsHide: true, maxBuffer }, (err, out, errOut) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
      finish({ code, stdout: out ?? '', stderr: errOut ?? '' })
    })
    const timer = setTimeout(() => {
      child.kill()
      finish({ code: 1, stdout: '', stderr: 'Git command timed out.' })
    }, timeoutMs)
  })
}

/** Extracts `owner/repo` from HTTPS or SSH GitHub remote URLs. */
export function parseGitHubRepo(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim()
  if (!trimmed) return undefined
  const match = /(?:^|[@/])github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git|\/)?$/i.exec(trimmed)
  if (!match) return undefined
  const owner = match[1]
  const repo = match[2]
  if (!owner || !repo) return undefined
  return `${owner}/${repo}`
}

/** Extracts a specific GitHub issue number from `#123`, `123`, or an issue URL. */
export function parseGitHubIssueQuery(raw?: string): number | undefined {
  const s = (raw ?? '').trim()
  if (!s) return undefined
  const numMatch = /^#?(\d+)$/.exec(s)
  if (numMatch) {
    const n = Number(numMatch[1])
    return Number.isInteger(n) && n > 0 ? n : undefined
  }
  const urlMatch = /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i.exec(s)
  if (urlMatch) {
    const n = Number(urlMatch[1])
    return Number.isInteger(n) && n > 0 ? n : undefined
  }
  return undefined
}

/** Returns quick Git status summary for a workspace directory. */
export async function getGitRepoStatus(dir: string | undefined): Promise<GitRepoStatus> {
  if (!dir) return { isRepo: false, dirtyCount: 0 }
  const top = await runGit(dir, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return { isRepo: false, dirtyCount: 0 }
  const [branchRes, headRes, statusRes, originRes, allRemotesRes] = await Promise.all([
    runGit(dir, ['branch', '--show-current']),
    runGit(dir, ['rev-parse', '--short', 'HEAD']),
    runGit(dir, ['status', '--porcelain=v1']),
    runGit(dir, ['remote', 'get-url', 'origin']),
    runGit(dir, ['remote', '-v']),
  ])
  let githubRepo = originRes.code === 0 ? parseGitHubRepo(originRes.stdout) : undefined
  if (!githubRepo && allRemotesRes.code === 0) {
    for (const line of allRemotesRes.stdout.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/)
      if (parts[1]) {
        githubRepo = parseGitHubRepo(parts[1])
        if (githubRepo) break
      }
    }
  }
  const dirtyCount = statusRes.code === 0 ? statusRes.stdout.split(/\r?\n/).filter((l) => l.trim()).length : 0
  return {
    isRepo: true,
    branch: branchRes.stdout.trim() || undefined,
    head: headRes.code === 0 ? headRes.stdout.trim() || undefined : undefined,
    dirtyCount,
    ...(githubRepo ? { githubRepo } : {}),
  }
}

export async function isLinkedWorktree(dir: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([
    runGit(dir, ['rev-parse', '--git-dir']),
    runGit(dir, ['rev-parse', '--git-common-dir']),
  ])
  if (gitDir.code !== 0 || commonDir.code !== 0) return false
  return resolve(dir, gitDir.stdout.trim()) !== resolve(dir, commonDir.stdout.trim())
}

export interface CreatedWorktree {
  worktreePath: string
  branch: string
  baseBranch?: string
  baseWorkspace: string
}

const SKIP_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist'])

async function copyLocalEnvFiles(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const ent of entries) {
    if (!ent.isFile()) continue
    const name = ent.name
    if (name !== '.env' && !name.startsWith('.env.')) continue
    if (SKIP_ENV_EXAMPLES.has(name.toLowerCase())) continue
    const src = join(sourceDir, name)
    const dst = join(targetDir, name)
    if (existsSync(dst)) continue
    const info = await stat(src).catch(() => null)
    if (!info || info.size > 512 * 1024) continue
    await copyFile(src, dst).catch(() => undefined)
  }
}

/** Creates an isolated git worktree under `<dataDir>/worktrees/<chatId>`. */
export async function createGitWorktree(
  baseWorkspace: string,
  dataDir: string,
  chatId: string,
  branchHint?: string,
  opts?: { copyEnv?: boolean },
): Promise<CreatedWorktree> {
  const status = await getGitRepoStatus(baseWorkspace)
  if (!status.isRepo) {
    throw new Error('Selected workspace is not a Git repository.')
  }
  const headCheck = await runGit(baseWorkspace, ['rev-parse', '--verify', 'HEAD'])
  if (headCheck.code !== 0) {
    throw new Error('Git repository has no commits yet. Make an initial commit before creating a worktree.')
  }
  const topRes = await runGit(baseWorkspace, ['rev-parse', '--show-toplevel'])
  const repoRoot = topRes.code === 0 && topRes.stdout.trim() ? topRes.stdout.trim() : baseWorkspace
  const slug = (branchHint || chatId).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || chatId
  const branch = branchHint ? slug : `atrium/${slug}`
  const worktreesDir = join(dataDir, 'worktrees')
  await mkdir(worktreesDir, { recursive: true })
  const worktreePath = join(worktreesDir, chatId)

  const add = await runGit(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], 20_000)
  if (add.code !== 0) {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(add.stderr.trim() || add.stdout.trim() || 'Could not create Git worktree.')
  }
  if (opts?.copyEnv !== false) {
    await copyLocalEnvFiles(repoRoot, worktreePath)
  }
  return {
    worktreePath,
    branch,
    baseBranch: status.branch || status.head,
    baseWorkspace: repoRoot,
  }
}

/** Safely removes an Atrium-created Git worktree when its conversation is deleted. */
export async function removeGitWorktree(
  baseWorkspace: string | undefined,
  worktreePath: string,
  branch?: string,
  forceDeleteMergedBranch = false,
): Promise<void> {
  if (baseWorkspace) {
    await runGit(baseWorkspace, ['worktree', 'remove', '--force', worktreePath], 15_000)
    await runGit(baseWorkspace, ['worktree', 'prune'], 10_000)
    if (branch && (forceDeleteMergedBranch || branch.startsWith('atrium/'))) {
      // `branch -d` safely deletes only if fully merged, preventing accidental unmerged loss.
      await runGit(baseWorkspace, ['branch', '-d', branch], 5_000)
    }
  }
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
}

/** Stages changes (all or scoped paths; respects already-staged selection when `paths` is omitted) and creates a Git commit in `dir`. */
export async function commitGitChanges(dir: string, message: string, paths?: string[]): Promise<GitCommitResult> {
  const cleanMsg = message.trim()
  if (!cleanMsg) throw new Error('Commit message is required.')
  const status = await getGitRepoStatus(dir)
  if (!status.isRepo) throw new Error('Workspace is not a Git repository.')

  const cleanPaths = (paths ?? []).map((p) => p.trim()).filter(Boolean)
  if (cleanPaths.length > 0) {
    const addRes = await runGit(dir, ['add', '-A', '--', ...cleanPaths], 15_000)
    if (addRes.code !== 0) {
      throw new Error(addRes.stderr.trim() || addRes.stdout.trim() || 'Could not stage changes for commit.')
    }
  } else {
    const preStaged = await runGit(dir, ['diff', '--cached', '--quiet'])
    if (preStaged.code === 0) {
      const addRes = await runGit(dir, ['add', '-A'], 15_000)
      if (addRes.code !== 0) {
        throw new Error(addRes.stderr.trim() || addRes.stdout.trim() || 'Could not stage changes for commit.')
      }
    }
  }

  const diffCheck = await runGit(dir, ['diff', '--cached', '--quiet'])
  if (diffCheck.code === 0) {
    throw new Error('No staged changes to commit.')
  }

  const commitRes = await runGit(dir, ['commit', '-m', cleanMsg], 20_000)
  if (commitRes.code !== 0) {
    throw new Error(commitRes.stderr.trim() || commitRes.stdout.trim() || 'Git commit failed.')
  }

  const [hashRes, summaryRes, branchRes] = await Promise.all([
    runGit(dir, ['rev-parse', '--short', 'HEAD']),
    runGit(dir, ['log', '-1', '--pretty=%s']),
    runGit(dir, ['branch', '--show-current']),
  ])
  return {
    commitHash: hashRes.stdout.trim() || 'HEAD',
    summary: summaryRes.stdout.trim() || cleanMsg.split('\n')[0] || cleanMsg,
    branch: branchRes.stdout.trim() || status.branch,
  }
}

export async function stageGitFiles(dir: string, paths: string[], staged: boolean): Promise<void> {
  const cleanPaths = paths.map((p) => p.trim()).filter(Boolean)
  if (staged) {
    const args = cleanPaths.length > 0 ? ['add', '-A', '--', ...cleanPaths] : ['add', '-A']
    const res = await runGit(dir, args, 15_000)
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || 'Could not stage file(s).')
    }
    return
  }
  const hasHead = await runGit(dir, ['rev-parse', '--verify', 'HEAD'])
  if (hasHead.code === 0) {
    const args = cleanPaths.length > 0 ? ['reset', 'HEAD', '--', ...cleanPaths] : ['reset', 'HEAD']
    const res = await runGit(dir, args, 15_000)
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || 'Could not unstage file(s).')
    }
    return
  }
  const args =
    cleanPaths.length > 0
      ? ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...cleanPaths]
      : ['rm', '--cached', '-r', '--ignore-unmatch', '.']
  await runGit(dir, args, 15_000)
}

export async function listGitBranches(dir: string): Promise<string[]> {
  const res = await runGit(dir, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads'])
  if (res.code !== 0) return []
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
}

export async function getGitAheadBehind(dir: string): Promise<{ ahead: number; behind: number }> {
  const res = await runGit(dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  if (res.code !== 0) return { ahead: 0, behind: 0 }
  const parts = res.stdout.trim().split(/\s+/)
  const behind = Number(parts[0]) || 0
  const ahead = Number(parts[1]) || 0
  return { ahead, behind }
}

export async function checkoutGitBranch(dir: string, branch: string, createNew = false): Promise<GitRepoStatus> {
  const clean = branch.trim()
  if (!clean || clean.startsWith('-')) throw new Error('Invalid branch name.')
  const valid = await runGit(dir, ['check-ref-format', '--branch', clean])
  if (valid.code !== 0) throw new Error(`Invalid Git branch name "${clean}".`)
  const args = createNew ? ['checkout', '-b', clean] : ['checkout', clean]
  const res = await runGit(dir, args, 15_000)
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `Could not switch to branch "${clean}".`)
  }
  return getGitRepoStatus(dir)
}

export async function pushGitBranch(dir: string): Promise<GitPushResult> {
  const status = await getGitRepoStatus(dir)
  if (!status.isRepo) throw new Error('Workspace is not a Git repository.')
  if (!status.branch) throw new Error('Cannot push from a detached HEAD. Checkout a branch first.')
  const remoteRes = await runGit(dir, ['remote'])
  const remotes = remoteRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) throw new Error('No Git remote configured to push to.')
  const pushRes = await runGit(dir, ['push', '-u', remote, status.branch], 30_000)
  if (pushRes.code !== 0) {
    throw new Error(pushRes.stderr.trim() || pushRes.stdout.trim() || 'Git push failed.')
  }
  return { branch: status.branch, remote }
}

export async function buildGitHubPrUrl(dir: string, title?: string): Promise<GitPrUrlResult> {
  const status = await getGitRepoStatus(dir)
  if (!status.isRepo) throw new Error('Workspace is not a Git repository.')
  if (!status.githubRepo) throw new Error('This repository does not have a GitHub remote.')
  if (!status.branch) throw new Error('Checkout a branch before creating a Pull Request.')
  const symRes = await runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const defaultBase =
    symRes.code === 0 && symRes.stdout.trim()
      ? symRes.stdout.trim().replace(/^origin\//, '')
      : 'main'
  let pushed = false
  const aheadRes = await getGitAheadBehind(dir)
  const upstreamCheck = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (upstreamCheck.code !== 0 || aheadRes.ahead > 0) {
    await pushGitBranch(dir)
    pushed = true
  }
  const baseBranch = status.branch === defaultBase ? defaultBase : defaultBase
  const query = new URLSearchParams({ expand: '1' })
  if (title?.trim()) query.set('title', title.trim())
  const url =
    status.branch === baseBranch
      ? `https://github.com/${status.githubRepo}/pulls`
      : `https://github.com/${status.githubRepo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(status.branch)}?${query.toString()}`
  return { url, branch: status.branch, baseBranch, pushed }
}

/** Merges an isolated worktree branch back into `baseWorkspace` safely with conflict protection. */
export async function mergeWorktreeToBase(opts: {
  baseWorkspace: string
  worktreePath: string
  branch: string
  baseBranch?: string
  commitMessage?: string
  cleanupWorktree?: boolean
}): Promise<WorktreeMergeResult> {
  const baseStatus = await getGitRepoStatus(opts.baseWorkspace)
  if (!baseStatus.isRepo) {
    throw new Error('Base workspace is no longer a valid Git repository.')
  }
  if (baseStatus.dirtyCount > 0) {
    throw new Error(
      `Main workspace has ${baseStatus.dirtyCount} uncommitted change(s). Commit or revert them before merging "${opts.branch}".`,
    )
  }

  const wtStatus = await getGitRepoStatus(opts.worktreePath)
  let autoCommitted = false
  if (wtStatus.isRepo && wtStatus.dirtyCount > 0) {
    const fallbackMsg = opts.commitMessage?.trim() || `chore(worktree): merge ${opts.branch}`
    await commitGitChanges(opts.worktreePath, fallbackMsg)
    autoCommitted = true
  }

  let targetBranch = baseStatus.branch
  if (opts.baseBranch && opts.baseBranch !== baseStatus.branch) {
    const refCheck = await runGit(opts.baseWorkspace, ['show-ref', '--verify', '--quiet', `refs/heads/${opts.baseBranch}`])
    if (refCheck.code === 0) {
      const co = await runGit(opts.baseWorkspace, ['checkout', opts.baseBranch], 15_000)
      if (co.code !== 0) {
        throw new Error(co.stderr.trim() || co.stdout.trim() || `Could not switch to base branch "${opts.baseBranch}".`)
      }
      targetBranch = opts.baseBranch
    }
  }

  const mergeRes = await runGit(opts.baseWorkspace, ['merge', '--no-edit', opts.branch], 25_000)
  if (mergeRes.code !== 0) {
    await runGit(opts.baseWorkspace, ['merge', '--abort'], 10_000)
    const detail = (mergeRes.stderr || mergeRes.stdout).trim()
    throw new Error(
      detail
        ? `Merge conflict when merging "${opts.branch}". Merge was aborted cleanly to keep the base repository untouched:\n${detail}`
        : `Could not merge "${opts.branch}" cleanly; aborted.`,
    )
  }

  const headRes = await runGit(opts.baseWorkspace, ['rev-parse', '--short', 'HEAD'])
  const cleanedUp = opts.cleanupWorktree !== false
  if (cleanedUp) {
    await removeGitWorktree(opts.baseWorkspace, opts.worktreePath, opts.branch, true).catch(() => undefined)
  }
  return {
    baseWorkspace: opts.baseWorkspace,
    baseBranch: targetBranch,
    branch: opts.branch,
    mergedCommit: headRes.stdout.trim() || undefined,
    autoCommitted,
    cleanedUp,
  }
}

const BATCH_DIFF_MAX_BUFFER = 16 * 1024 * 1024

/** Decodes a Git C-quoted or octal-escaped relative path token into UTF-8. */
export function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed
  const inner = trimmed.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch === '\\' && i + 1 < inner.length) {
      const oct = inner.slice(i + 1, i + 4)
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8))
        i += 3
        continue
      }
      const next = inner[i + 1]!
      i += 1
      switch (next) {
        case 'a': bytes.push(7); break
        case 'b': bytes.push(8); break
        case 't': bytes.push(9); break
        case 'n': bytes.push(10); break
        case 'v': bytes.push(11); break
        case 'f': bytes.push(12); break
        case 'r': bytes.push(13); break
        case '\\': bytes.push(92); break
        case '"': bytes.push(34); break
        default: bytes.push(...Buffer.from(next, 'utf8')); break
      }
      continue
    }
    bytes.push(...Buffer.from(ch, 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

function stripDiffPrefix(token: string, prefix: 'a/' | 'b/'): string {
  const clean = unquoteGitPath(token)
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean
}

function parseDiffGitHeader(line: string): string | null {
  if (!line.startsWith('diff --git ')) return null
  const rest = line.slice(11)
  if (rest.startsWith('"')) {
    let i = 1
    while (i < rest.length) {
      if (rest[i] === '\\') {
        i += 2
        continue
      }
      if (rest[i] === '"') break
      i++
    }
    const bToken = rest.slice(i + 1).trim()
    return bToken ? stripDiffPrefix(bToken, 'b/') : null
  }
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2
    if (rest.startsWith('a/') && rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) {
      return rest.slice(2, half)
    }
  }
  const quotedIdx = rest.lastIndexOf(' "b/')
  if (quotedIdx >= 0) return stripDiffPrefix(rest.slice(quotedIdx + 1), 'b/')
  const bIdx = rest.lastIndexOf(' b/')
  return bIdx >= 0 ? rest.slice(bIdx + 3) : null
}

function extractPathFromDiffBlock(block: string): string | null {
  let renameTo: string | null = null
  let plusPath: string | null = null
  let minusPath: string | null = null
  let headerPath: string | null = null

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith('@@ ') || line.startsWith('GIT binary patch')) break
    if (!headerPath && line.startsWith('diff --git ')) {
      headerPath = parseDiffGitHeader(line)
      continue
    }
    if (line.startsWith('rename to ')) {
      renameTo = unquoteGitPath(line.slice(10))
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4)
      if (p.trim() !== '/dev/null') plusPath = stripDiffPrefix(p, 'b/')
      continue
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4)
      if (p.trim() !== '/dev/null') minusPath = stripDiffPrefix(p, 'a/')
    }
  }
  const resolved = plusPath ?? renameTo ?? minusPath ?? headerPath
  return resolved ? resolved.replace(/\\/g, '/') : null
}

/** Splits a multi-file `git diff` output into a map keyed by normalized relative path. */
export function splitUnifiedGitDiff(raw: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!raw.trim()) return out
  const chunks = raw.split(/^(?=diff --git )/m)
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue
    const path = extractPathFromDiffBlock(chunk)
    if (!path) continue
    out.set(path, chunk.replace(/\s+$/, '').slice(0, DIFF_CHAR_CAP))
  }
  return out
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function run(): Promise<void> {
    while (next < items.length) {
      const idx = next++
      results[idx] = await worker(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()))
  return results
}

async function batchDiffMap(
  dir: string,
  refArgs: string[],
  fallbackPaths: string[],
  fallbackRef: string,
): Promise<Map<string, string>> {
  if (fallbackPaths.length === 0) return new Map()
  const batch = await runGit(dir, ['diff', '--no-ext-diff', '-M', ...refArgs], 15_000, BATCH_DIFF_MAX_BUFFER)
  if (batch.code === 0) return splitUnifiedGitDiff(batch.stdout)

  // Unborn repo has no HEAD yet: staged files can still be diffed via --cached.
  if (refArgs.length === 1 && refArgs[0] === 'HEAD') {
    const cached = await runGit(dir, ['diff', '--no-ext-diff', '-M', '--cached'], 15_000, BATCH_DIFF_MAX_BUFFER)
    if (cached.code === 0) return splitUnifiedGitDiff(cached.stdout)
  }

  // Fallback for oversized combined diffs (>16MB) or odd repo states: bounded per-file diff.
  const entries = await mapWithConcurrency(fallbackPaths, 8, async (relPath) => {
    const res = await runGit(dir, ['diff', '--no-ext-diff', fallbackRef, '--', relPath])
    return [relPath, res.code === 0 ? res.stdout.slice(0, DIFF_CHAR_CAP) : ''] as const
  })
  return new Map(entries)
}

interface ParsedStatusEntry {
  relPath: string
  fromPath?: string
  status: FileChangeEntry['status']
  staged: boolean
  unstaged: boolean
  isUntracked: boolean
}

/** Reads uncommitted working tree diffs (or commits vs baseBranch in worktree mode). */
export async function getGitChanges(dir: string, baseBranch?: string): Promise<FileChangeEntry[]> {
  const statusRes = await runGit(dir, ['status', '--porcelain=v1', '-uall'])
  if (statusRes.code !== 0) return []

  const items = new Map<string, FileChangeEntry>()
  const parsed: ParsedStatusEntry[] = []

  for (const line of statusRes.stdout.split(/\r?\n/).filter(Boolean).slice(0, 60)) {
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    const rawPath = line.slice(3).trim()
    if (!rawPath) continue
    const renamed = rawPath.includes(' -> ') ? rawPath.split(' -> ') : null
    const relPath = unquoteGitPath(renamed ? renamed[1]! : rawPath).replace(/\\/g, '/')
    const fromPath = renamed ? unquoteGitPath(renamed[0]!).replace(/\\/g, '/') : undefined

    let status: FileChangeEntry['status'] = 'modified'
    if (x === '?' || y === '?') status = 'added'
    else if (x === 'D' || y === 'D') status = 'deleted'
    else if (x === 'A' || y === 'A') status = 'added'
    else if (renamed) status = 'renamed'

    parsed.push({
      relPath,
      fromPath,
      status,
      staged: x !== ' ' && x !== '?',
      unstaged: x === '?' || y !== ' ',
      isUntracked: status === 'added' && x === '?',
    })
  }

  const untrackedEntries = parsed.filter((e) => e.isUntracked)
  const trackedPaths = parsed.filter((e) => !e.isUntracked).map((e) => e.relPath)

  const [untrackedDiffs, trackedDiffMap] = await Promise.all([
    mapWithConcurrency(untrackedEntries, 8, async (entry) => {
      try {
        const raw = await readFile(join(dir, entry.relPath), 'utf8')
        if (!raw.includes('\u0000')) {
          return [entry.relPath, buildCompactDiff(entry.relPath, undefined, raw.slice(0, DIFF_CHAR_CAP))] as const
        }
      } catch {
        /* ignore unreadable untracked file */
      }
      return [entry.relPath, ''] as const
    }),
    batchDiffMap(dir, ['HEAD'], trackedPaths, 'HEAD'),
  ])
  const untrackedMap = new Map(untrackedDiffs)

  for (const entry of parsed) {
    const diff = entry.isUntracked ? (untrackedMap.get(entry.relPath) ?? '') : (trackedDiffMap.get(entry.relPath) ?? '')
    const { additions, deletions } = countDiffLines(diff)
    items.set(entry.relPath, {
      path: entry.relPath,
      ...(entry.fromPath ? { fromPath: entry.fromPath } : {}),
      status: entry.status,
      additions,
      deletions,
      diff,
      revertible: false,
      staged: entry.staged,
      unstaged: entry.unstaged,
    })
  }

  // If running in a worktree with committed work on the worktree branch relative to baseBranch, include committed changes too.
  if (baseBranch) {
    const commitStatus = await runGit(dir, ['diff', '--name-status', `${baseBranch}...HEAD`])
    if (commitStatus.code === 0) {
      const committed: Array<{ rel: string; code: string }> = []
      for (const line of commitStatus.stdout.split(/\r?\n/).filter(Boolean).slice(0, 40)) {
        const parts = line.split('\t')
        const code = parts[0]?.[0] ?? 'M'
        const rel = unquoteGitPath(parts[parts.length - 1] ?? '').replace(/\\/g, '/')
        if (!rel || items.has(rel)) continue
        committed.push({ rel, code })
      }
      if (committed.length > 0) {
        const commitDiffs = await batchDiffMap(
          dir,
          [`${baseBranch}...HEAD`],
          committed.map((c) => c.rel),
          `${baseBranch}...HEAD`,
        )
        for (const { rel, code } of committed) {
          const diff = commitDiffs.get(rel) ?? ''
          const { additions, deletions } = countDiffLines(diff)
          items.set(rel, {
            path: rel,
            status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified',
            additions,
            deletions,
            diff,
            revertible: false,
          })
        }
      }
    }
  }

  return [...items.values()]
}

function normalizeGitHubIssue(item: Record<string, unknown>): GitHubIssueSummary {
  const labels = Array.isArray(item.labels)
    ? item.labels
        .map((l) => (l && typeof l === 'object' && 'name' in l ? String((l as { name?: unknown }).name ?? '') : ''))
        .filter(Boolean)
    : []
  const userObj = item.user && typeof item.user === 'object' ? (item.user as { login?: unknown }) : undefined
  return {
    number: Number(item.number ?? 0),
    title: String(item.title ?? ''),
    url: String(item.html_url ?? ''),
    state: String(item.state ?? 'open'),
    ...(userObj?.login ? { author: String(userObj.login) } : {}),
    labels,
    body: String(item.body ?? ''),
    updatedAt: String(item.updated_at ?? ''),
  }
}

/** Fetches open GitHub issues (or a specific `#number` / issue URL) for the workspace's GitHub remote. */
export async function fetchGitHubIssues(dir: string | undefined, query?: string): Promise<GitHubIssueSummary[]> {
  const status = await getGitRepoStatus(dir)
  if (!status.githubRepo) {
    throw new Error('This folder does not have a GitHub remote.')
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Atrium-Desktop',
  }
  const issueNum = parseGitHubIssueQuery(query)
  if (issueNum) {
    const res = await netFetch(`https://api.github.com/repos/${status.githubRepo}/issues/${issueNum}`, {
      headers,
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      throw new Error(res.status === 404 ? `Issue #${issueNum} not found in ${status.githubRepo}.` : `GitHub API returned HTTP ${res.status}.`)
    }
    const raw = (await res.json()) as Record<string, unknown>
    return [normalizeGitHubIssue(raw)]
  }

  const res = await netFetch(
    `https://api.github.com/repos/${status.githubRepo}/issues?state=open&per_page=15&sort=updated`,
    { headers, signal: AbortSignal.timeout(12_000) },
  )
  if (!res.ok) {
    throw new Error(
      res.status === 403 || res.status === 429
        ? 'GitHub API rate limit reached. Try entering a specific #issue number or retrying shortly.'
        : `GitHub API returned HTTP ${res.status}.`,
    )
  }
  const list = (await res.json()) as Array<Record<string, unknown>>
  const needle = (query ?? '').trim().toLowerCase()
  return list
    .filter((item) => !item.pull_request)
    .map(normalizeGitHubIssue)
    .filter((item) => !needle || item.title.toLowerCase().includes(needle) || String(item.number).includes(needle))
}
