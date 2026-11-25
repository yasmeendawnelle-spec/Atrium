// Multi-agent parallel Git worktree orchestrator (Codex-style Fleet Command Center).
import { resolve } from 'node:path'
import type {
  AgentEvent,
  Conversation,
  ConversationMeta,
  FileChangeEntry,
  WorktreeMergeResult,
} from '../shared/types.ts'
import type {
  FleetDiffResult,
  FleetLaunchResult,
  FleetTaskDraft,
  FleetWorkerSnapshot,
  FleetWorkerStatus,
} from '../shared/studio_features.ts'
import { errorText } from '../shared/rpc.ts'
import type { AgentLoop } from './agent.ts'
import type { ChatStore } from './chats.ts'
import type { PreviewServerManager } from './preview.ts'
import type { SettingsStore } from './settings.ts'
import { newId } from './store.ts'
import type { CheckpointStore } from './tools/changes.ts'
import { invalidateWorkspaceFilesCache } from './tools/files.ts'
import {
  countDiffLines,
  createGitWorktree,
  getGitChanges,
  getGitRepoStatus,
  mergeWorktreeToBase,
  removeGitWorktree,
} from './tools/git.ts'

const MAX_PARALLEL_LAUNCH = 8

export interface FleetManagerDeps {
  chats: ChatStore
  agent: AgentLoop
  settings: SettingsStore
  checkpoints: CheckpointStore
  previews?: PreviewServerManager
  dataDir: string
  onChatsChanged: () => void
  emitAgent: (event: AgentEvent) => void
  closeBrowser?: (conversationId: string) => Promise<void>
  beforeSend?: () => Promise<void>
}

function normPathKey(dir: string | undefined): string {
  if (!dir) return ''
  const clean = resolve(dir).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? clean.toLowerCase() : clean
}

function summarizePromptTitle(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean) ?? ''
  if (!firstLine) return 'Worktree Task'
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine
}

function lastConversationSnippet(conv: Conversation | null): string | undefined {
  if (!conv) return undefined
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (!m) continue
    if (m.role === 'assistant' && m.text.trim()) {
      const line = m.text.trim().replace(/\s+/g, ' ')
      return line.length > 140 ? `${line.slice(0, 140)}…` : line
    }
    if (m.role === 'user' && !m.isSummary && m.text.trim()) {
      const line = m.text.trim().replace(/\s+/g, ' ')
      return line.length > 140 ? `${line.slice(0, 140)}…` : line
    }
  }
  return undefined
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const out = new Array<R>(items.length)
  let next = 0
  async function run(): Promise<void> {
    while (next < items.length) {
      const idx = next++
      out[idx] = await worker(items[idx]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()))
  return out
}

export class WorktreeFleetManager {
  private readonly deps: FleetManagerDeps
  private readonly mergeLocks = new Map<string, Promise<unknown>>()

  constructor(deps: FleetManagerDeps) {
    this.deps = deps
  }

  private withMergeLock<T>(baseWorkspace: string, task: () => Promise<T>): Promise<T> {
    const key = normPathKey(baseWorkspace)
    const prev = this.mergeLocks.get(key) ?? Promise.resolve()
    const run = prev.catch(() => undefined).then(task)
    const tail = run.catch(() => undefined)
    this.mergeLocks.set(key, tail)
    void tail.finally(() => {
      if (this.mergeLocks.get(key) === tail) {
        this.mergeLocks.delete(key)
      }
    })
    return run
  }

  private resolveStatus(meta: ConversationMeta, conv: Conversation | null): {
    status: FleetWorkerStatus
    pendingApprovals: number
  } {
    const pendingApprovals = this.deps.agent.pendingApprovalsFor(meta.id)
    if (pendingApprovals > 0) {
      return { status: 'waiting_approval', pendingApprovals }
    }
    if (this.deps.agent.busy(meta.id)) {
      return { status: 'running', pendingApprovals: 0 }
    }
    const last = conv?.messages[conv.messages.length - 1]
    if (last?.role === 'assistant' && last.incomplete === 'error') {
      return { status: 'error', pendingApprovals: 0 }
    }
    return { status: 'idle', pendingApprovals: 0 }
  }

  private async buildWorkerSnapshot(meta: ConversationMeta): Promise<FleetWorkerSnapshot> {
    const conv = await this.deps.chats.get(meta.id).catch(() => null)
    const worktreePath = meta.workspace ?? conv?.workspace ?? ''
    const baseWorkspace = meta.worktreeBaseWorkspace ?? conv?.worktreeBaseWorkspace ?? worktreePath
    const branch = meta.worktreeBranch ?? conv?.worktreeBranch ?? ''
    const baseBranch = meta.worktreeBaseBranch ?? conv?.worktreeBaseBranch

    const { status, pendingApprovals } = this.resolveStatus(meta, conv)

    let gitFiles: FileChangeEntry[] = []
    if (worktreePath) {
      gitFiles = await getGitChanges(worktreePath, baseBranch).catch(() => [])
    }

    let additions = 0
    let deletions = 0
    for (const f of gitFiles) {
      const counts = f.additions > 0 || f.deletions > 0 ? { additions: f.additions, deletions: f.deletions } : countDiffLines(f.diff)
      additions += counts.additions
      deletions += counts.deletions
    }

    if (gitFiles.length > 0 || meta.diffStats) {
      await this.deps.chats.setDiffStats(meta.id, { additions, deletions }).catch(() => undefined)
    }

    const activePreview = this.deps.previews?.latestForConversation(meta.id)
    const previewUrl =
      activePreview && (activePreview.status === 'running' || activePreview.status === 'starting')
        ? activePreview.url
        : undefined

    return {
      conversationId: meta.id,
      title: meta.title || conv?.title || summarizePromptTitle(''),
      baseWorkspace,
      worktreePath,
      branch,
      ...(baseBranch ? { baseBranch } : {}),
      status,
      pendingApprovals,
      messageCount: conv?.messages.length ?? meta.messageCount ?? 0,
      changedFiles: gitFiles.length,
      additions,
      deletions,
      ...(lastConversationSnippet(conv) ? { lastSnippet: lastConversationSnippet(conv) } : {}),
      updatedAt: meta.updatedAt,
      createdAt: meta.createdAt,
      ...(previewUrl ? { previewUrl } : {}),
    }
  }

  async list(baseWorkspace?: string): Promise<FleetWorkerSnapshot[]> {
    const filterKey = baseWorkspace ? normPathKey(baseWorkspace) : ''
    const allWorktrees = this.deps.chats
      .list()
      .filter((c) => Boolean(c.worktreeBaseWorkspace && c.worktreeBranch && c.workspace))
      .filter((c) => !c.archived)
      .filter((c) => !filterKey || normPathKey(c.worktreeBaseWorkspace) === filterKey)

    const snapshots = await mapWithConcurrency(allWorktrees, 4, (meta) => this.buildWorkerSnapshot(meta))
    const rank = (s: FleetWorkerStatus): number =>
      s === 'waiting_approval' ? 0 : s === 'running' ? 1 : s === 'error' ? 2 : 3

    return snapshots.sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt)
  }

  async launch(opts: {
    baseWorkspace: string
    tasks: FleetTaskDraft[]
    startImmediately?: boolean
  }): Promise<FleetLaunchResult> {
    if (this.deps.beforeSend) {
      await this.deps.beforeSend()
    }
    const baseWorkspace = opts.baseWorkspace?.trim() || this.deps.settings.get().workspace?.trim()
    if (!baseWorkspace) {
      throw new Error('Select a Git workspace folder before launching parallel worktrees.')
    }

    const status = await getGitRepoStatus(baseWorkspace)
    if (!status.isRepo) {
      throw new Error('Selected workspace is not a Git repository.')
    }

    const cleanedTasks = opts.tasks
      .map((t, index) => ({
        index,
        prompt: t.prompt.trim(),
        branchName: t.branchName?.trim() || undefined,
        title: t.title?.trim() || undefined,
      }))
      .filter((t) => Boolean(t.prompt))
      .slice(0, MAX_PARALLEL_LAUNCH)

    if (cleanedTasks.length === 0) {
      throw new Error('Add at least one non-empty task prompt to launch.')
    }

    const copyEnv = this.deps.settings.get().copyEnvOnWorktree !== false
    const providerId = this.deps.settings.activeProvider()?.id

    const created: Array<{
      conversation: Conversation
      prompt: string
      branch: string
      worktreePath: string
    }> = []
    const errors: FleetLaunchResult['errors'] = []

    // Sequential worktree creation avoids `.git/index.lock` collisions inside the base repository.
    for (const task of cleanedTasks) {
      const id = newId('chat')
      try {
        const wt = await createGitWorktree(baseWorkspace, this.deps.dataDir, id, task.branchName, { copyEnv })
        const conv = await this.deps.chats.create({
          id,
          workspace: wt.worktreePath,
          providerId,
          worktreeBaseWorkspace: wt.baseWorkspace,
          worktreeBranch: wt.branch,
          worktreeBaseBranch: wt.baseBranch,
        })
        conv.title = task.title || summarizePromptTitle(task.prompt)
        conv.titleSource = task.title ? 'user' : 'heuristic'
        await this.deps.chats.save(conv)
        created.push({
          conversation: conv,
          prompt: task.prompt,
          branch: wt.branch,
          worktreePath: wt.worktreePath,
        })
      } catch (err) {
        errors.push({
          index: task.index,
          prompt: task.prompt,
          error: errorText(err),
        })
      }
    }

    if (created.length > 0) {
      this.deps.onChatsChanged()
    }

    if (opts.startImmediately !== false) {
      for (const item of created) {
        void this.deps.agent.run(item.conversation, item.prompt).catch((err) => {
          process.stderr.write(`fleet agent run failed (${item.conversation.id}): ${errorText(err)}\n`)
        })
      }
    }

    return {
      launched: created.map((item) => ({
        conversationId: item.conversation.id,
        branch: item.branch,
        worktreePath: item.worktreePath,
        title: item.conversation.title,
      })),
      errors,
    }
  }

  async inspectDiff(conversationId: string): Promise<FleetDiffResult> {
    const conv = await this.deps.chats.get(conversationId)
    if (!conv || !conv.worktreeBaseWorkspace || !conv.workspace || !conv.worktreeBranch) {
      throw new Error('Conversation is not an active isolated Git worktree.')
    }
    const meta = this.deps.chats.list().find((m) => m.id === conversationId)
    const worker = await this.buildWorkerSnapshot(
      meta ?? {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        workspace: conv.workspace,
        worktreeBaseWorkspace: conv.worktreeBaseWorkspace,
        worktreeBranch: conv.worktreeBranch,
        worktreeBaseBranch: conv.worktreeBaseBranch,
      },
    )
    const [gitItems, cpItems] = await Promise.all([
      getGitChanges(conv.workspace, conv.worktreeBaseBranch).catch(() => []),
      this.deps.checkpoints.entries(conversationId, conv.workspace).catch(() => []),
    ])
    const merged = new Map(gitItems.map((i) => [i.path, i]))
    for (const cp of cpItems) merged.set(cp.path, cp)
    return {
      worker,
      files: [...merged.values()],
    }
  }

  async merge(
    conversationId: string,
    opts?: { commitMessage?: string; cleanupWorktree?: boolean },
  ): Promise<WorktreeMergeResult> {
    if (this.deps.agent.busy(conversationId)) {
      throw new Error('Stop the active turn before merging this worktree.')
    }
    const conv = await this.deps.chats.get(conversationId)
    if (!conv?.worktreeBaseWorkspace || !conv.workspace || !conv.worktreeBranch) {
      throw new Error('This conversation is not running in an isolated Git worktree.')
    }

    await this.deps.previews?.stopForConversation(conversationId).catch(() => undefined)

    return this.withMergeLock(conv.worktreeBaseWorkspace, async () => {
      const res = await mergeWorktreeToBase({
        baseWorkspace: conv.worktreeBaseWorkspace!,
        worktreePath: conv.workspace!,
        branch: conv.worktreeBranch!,
        baseBranch: conv.worktreeBaseBranch,
        commitMessage: opts?.commitMessage,
        cleanupWorktree: opts?.cleanupWorktree,
      })

      invalidateWorkspaceFilesCache(conv.worktreeBaseWorkspace!)
      invalidateWorkspaceFilesCache(conv.workspace!)

      if (res.cleanedUp) {
        conv.workspace = res.baseWorkspace
        delete conv.worktreeBaseWorkspace
        delete conv.worktreeBranch
        delete conv.worktreeBaseBranch
        await this.deps.checkpoints.deleteChat(conversationId).catch(() => undefined)
        await this.deps.chats.save(conv)
        this.deps.onChatsChanged()
        this.deps.emitAgent({ type: 'conversation_sync', conversation: conv })
      }
      return res
    })
  }

  async discard(conversationId: string): Promise<void> {
    this.deps.agent.clearQueue(conversationId)
    this.deps.agent.stop(conversationId)
    await this.deps.previews?.stopForConversation(conversationId).catch(() => undefined)
    const conv = await this.deps.chats.get(conversationId)
    await this.deps.chats.remove(conversationId)
    await this.deps.checkpoints.deleteChat(conversationId).catch(() => undefined)
    if (this.deps.closeBrowser) {
      await this.deps.closeBrowser(conversationId).catch(() => undefined)
    }
    if (conv?.worktreeBaseWorkspace && conv.workspace) {
      await removeGitWorktree(conv.worktreeBaseWorkspace, conv.workspace, conv.worktreeBranch, false).catch(() => undefined)
      invalidateWorkspaceFilesCache(conv.worktreeBaseWorkspace)
    }
    this.deps.onChatsChanged()
  }

  stopAll(baseWorkspace?: string): number {
    const filterKey = baseWorkspace ? normPathKey(baseWorkspace) : ''
    let count = 0
    for (const c of this.deps.chats.list()) {
      if (!c.worktreeBaseWorkspace || !c.worktreeBranch) continue
      if (filterKey && normPathKey(c.worktreeBaseWorkspace) !== filterKey) continue
      if (this.deps.agent.busy(c.id)) {
        this.deps.agent.clearQueue(c.id)
        this.deps.agent.stop(c.id)
        count++
      }
    }
    return count
  }
}
