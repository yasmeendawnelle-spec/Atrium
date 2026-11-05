// Conversations live as one JSON file each, plus a small index for the list.
import { join } from 'node:path'
import type {
  Conversation,
  ConversationMeta,
  ConversationUsageTotals,
  SceneUsageBreakdown,
  UsageSummary,
  WorkScene,
} from '../shared/types.ts'
import { BlobStore } from './blobs.ts'
import { newId, readJson, removeFile, writeJson } from './store.ts'

function emptySceneTotals(): Omit<SceneUsageBreakdown, 'scene'> {
  return {
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }
}

function emptySceneUsage(scene: WorkScene): SceneUsageBreakdown {
  return {
    scene,
    ...emptySceneTotals(),
  }
}

function addSceneTotals(
  target: SceneUsageBreakdown,
  part: Omit<SceneUsageBreakdown, 'scene'>,
): void {
  target.messages += part.messages
  target.inputTokens += part.inputTokens
  target.outputTokens += part.outputTokens
  target.cacheReadTokens += part.cacheReadTokens
  target.cacheWriteTokens += part.cacheWriteTokens
  target.totalTokens += part.totalTokens
}

export function computeConversationUsage(conversation: Conversation): ConversationUsageTotals {
  let userMessages = 0
  let assistantMessages = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let untaggedSceneMessages = 0
  const workScene = emptySceneTotals()
  const codeScene = emptySceneTotals()

  for (const m of conversation.messages) {
    if (m.role === 'user' && !m.isSummary) {
      userMessages += 1
    } else if (m.role === 'assistant') {
      assistantMessages += 1
      const hasSceneTag = m.workScene === 'work' || m.workScene === 'code'
      if (!hasSceneTag) untaggedSceneMessages += 1
      const sceneBucket = m.workScene === 'work' ? workScene : codeScene
      sceneBucket.messages += 1
      const u = m.usage
      if (u) {
        const inp = u.inputTokens || 0
        const out = u.outputTokens || 0
        const cacheRead = u.cacheReadTokens || 0
        const cacheWrite = u.cacheWriteTokens || 0
        inputTokens += inp
        outputTokens += out
        cacheReadTokens += cacheRead
        cacheWriteTokens += cacheWrite
        sceneBucket.inputTokens += inp
        sceneBucket.outputTokens += out
        sceneBucket.cacheReadTokens += cacheRead
        sceneBucket.cacheWriteTokens += cacheWrite
        sceneBucket.totalTokens += inp + out
      }
    }
  }

  return {
    userMessages,
    assistantMessages,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    untaggedSceneMessages,
    workScene,
    codeScene,
  }
}

export class ChatStore {
  private index: ConversationMeta[] = []
  private readonly dir: string
  private readonly blobs: BlobStore

  constructor(dir: string) {
    this.dir = dir
    this.blobs = new BlobStore(dir)
  }

  private indexPath(): string {
    return join(this.dir, 'chats.json')
  }

  private file(id: string): string {
    return join(this.dir, 'chats', `${id}.json`)
  }

  async load(): Promise<void> {
    const raw = await readJson(this.indexPath(), [] as ConversationMeta[])
    const cleaned: ConversationMeta[] = []
    let changed = false

    for (const entry of raw) {
      let count = entry.messageCount
      let missingFile = false
      if (count === undefined || count === 0) {
        const conv = await readJson<Conversation | null>(this.file(entry.id), null)
        if (!conv) {
          missingFile = true
        } else {
          count = conv.messages.length
        }
      }
      if (missingFile) {
        changed = true
        continue
      }
      const isDefaultUntitled = !entry.title || entry.title === 'New chat' || entry.title === '新对话'
      const isGhostStub = !entry.worktreeBranch && !entry.forkedFromId && count === 0 && isDefaultUntitled
      if (isGhostStub) {
        changed = true
        await removeFile(this.file(entry.id)).catch(() => undefined)
        continue
      }
      if (entry.messageCount !== count) {
        changed = true
        cleaned.push({ ...entry, messageCount: count })
      } else {
        cleaned.push(entry)
      }
    }

    this.index = cleaned
    if (changed) {
      await writeJson(this.indexPath(), this.index)
    }
  }

  list(): ConversationMeta[] {
    return [...this.index].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<Conversation | null> {
    const conv = await readJson<Conversation | null>(this.file(id), null)
    return conv ? this.blobs.hydrateConversation(conv) : null
  }

  async create(opts?: {
    id?: string
    workspace?: string
    providerId?: string
    worktreeBaseWorkspace?: string
    worktreeBranch?: string
    worktreeBaseBranch?: string
  }): Promise<Conversation> {
    const now = Date.now()
    const conversation: Conversation = {
      id: opts?.id ?? newId('chat'),
      title: '',
      createdAt: now,
      updatedAt: now,
      ...(opts?.workspace ? { workspace: opts.workspace } : {}),
      ...(opts?.providerId ? { providerId: opts.providerId } : {}),
      ...(opts?.worktreeBaseWorkspace ? { worktreeBaseWorkspace: opts.worktreeBaseWorkspace } : {}),
      ...(opts?.worktreeBranch ? { worktreeBranch: opts.worktreeBranch } : {}),
      ...(opts?.worktreeBaseBranch ? { worktreeBaseBranch: opts.worktreeBaseBranch } : {}),
      messages: [],
    }
    this.index.push(meta(conversation))
    await this.persist(conversation)
    return conversation
  }

  /** Creates a branched copy of an existing conversation (full or up to `upToMessageIndex`). */
  async fork(id: string, upToMessageIndex?: number, titleSuffix = 'branch'): Promise<Conversation> {
    const src = await this.get(id)
    if (!src) throw new Error(`No chat with id "${id}".`)
    let end = src.messages.length
    if (upToMessageIndex !== undefined) {
      if (upToMessageIndex < 0 || upToMessageIndex >= src.messages.length) {
        throw new Error('Selected fork point is out of range.')
      }
      end = upToMessageIndex + 1
      // Keep contiguous tool results attached if the user clicked an assistant message mid-turn.
      if (src.messages[upToMessageIndex]?.role === 'assistant') {
        while (end < src.messages.length && src.messages[end]?.role === 'tool') end++
      }
    }
    const baseTitle = src.title?.trim() || titleFrom(src)
    const now = Date.now()
    const suffix = titleSuffix.trim() || 'branch'
    const forked: Conversation = {
      id: newId('chat'),
      title: `${baseTitle} (${suffix})`,
      titleSource: 'user',
      createdAt: now,
      updatedAt: now,
      ...(src.providerId ? { providerId: src.providerId } : {}),
      ...(src.workspace ? { workspace: src.workspace } : {}),
      forkedFromId: src.id,
      forkedFromTitle: baseTitle,
      messages: structuredClone(src.messages.slice(0, end)),
    }
    this.index.push(meta(forked))
    await this.persist(forked)
    return forked
  }

  private upsertMeta(conversation: Conversation): ConversationMeta {
    const nextMeta = meta(conversation)
    const idx = this.index.findIndex((m) => m.id === conversation.id)
    if (idx >= 0) this.index[idx] = nextMeta
    else this.index.push(nextMeta)
    return nextMeta
  }

  async save(conversation: Conversation): Promise<void> {
    conversation.updatedAt = Date.now()
    if (!conversation.title) {
      conversation.title = titleFrom(conversation)
      if (!conversation.titleSource) conversation.titleSource = 'heuristic'
    }
    this.upsertMeta(conversation)
    await this.persist(conversation)
  }

  async rename(id: string, title: string): Promise<ConversationMeta> {
    const conversation = await this.get(id)
    if (!conversation) throw new Error(`No chat with id "${id}".`)
    conversation.title = title.trim()
    conversation.titleSource = 'user'
    await this.save(conversation)
    return meta(conversation)
  }

  async setAutoTitle(id: string, title: string): Promise<Conversation | null> {
    const clean = title.trim()
    if (!clean) return null
    const conversation = await this.get(id)
    if (!conversation) return null
    if (conversation.titleSource === 'user' || conversation.titleSource === 'ai') return null
    conversation.title = clean
    conversation.titleSource = 'ai'
    this.upsertMeta(conversation)
    await this.persist(conversation)
    return conversation
  }

  async setWorkspace(id: string, workspace?: string): Promise<ConversationMeta> {
    const conversation = await this.get(id)
    if (!conversation) throw new Error(`No chat with id "${id}".`)
    const clean = workspace?.trim() || undefined
    if (conversation.messages.length > 0) {
      throw new Error('Cannot change workspace after a conversation already has content.')
    }
    if (conversation.worktreeBranch) {
      throw new Error('Cannot change workspace of a Git worktree conversation.')
    }
    if (conversation.workspace && clean !== conversation.workspace) {
      throw new Error('Workspace is already fixed for this conversation.')
    }
    if (clean) conversation.workspace = clean
    else delete conversation.workspace
    await this.save(conversation)
    return meta(conversation)
  }

  async setProvider(id: string, providerId?: string): Promise<ConversationMeta> {
    const conversation = await this.get(id)
    if (!conversation) throw new Error(`No chat with id "${id}".`)
    const clean = providerId?.trim() || undefined
    if (clean) conversation.providerId = clean
    else delete conversation.providerId
    await this.save(conversation)
    return meta(conversation)
  }

  async setPinned(id: string, pinned: boolean): Promise<ConversationMeta> {
    const conversation = await this.get(id)
    if (!conversation) throw new Error(`No chat with id "${id}".`)
    if (pinned) conversation.pinned = true
    else delete conversation.pinned
    const nextMeta = this.upsertMeta(conversation)
    await this.persist(conversation)
    return nextMeta
  }

  async setArchived(id: string, archived: boolean): Promise<ConversationMeta> {
    const conversation = await this.get(id)
    if (!conversation) throw new Error(`No chat with id "${id}".`)
    if (archived) conversation.archived = true
    else delete conversation.archived
    const nextMeta = this.upsertMeta(conversation)
    await this.persist(conversation)
    return nextMeta
  }

  async setArchivedBatch(ids: string[], archived: boolean): Promise<ConversationMeta[]> {
    const out: ConversationMeta[] = []
    for (const id of ids) {
      const conv = await this.get(id)
      if (!conv) continue
      if (archived) conv.archived = true
      else delete conv.archived
      const nextMeta = this.upsertMeta(conv)
      const offloaded = await this.blobs.offloadConversation(conv)
      await writeJson(this.file(conv.id), offloaded, { compact: true })
      out.push(nextMeta)
    }
    if (out.length > 0) await writeJson(this.indexPath(), this.index)
    return out
  }

  async setDiffStats(id: string, diffStats?: { additions: number; deletions: number }): Promise<void> {
    const existing = this.index.find((m) => m.id === id)
    if (!existing) return
    const next = diffStats && (diffStats.additions > 0 || diffStats.deletions > 0) ? diffStats : undefined
    const same =
      existing.diffStats?.additions === next?.additions && existing.diffStats?.deletions === next?.deletions
    if (same) return
    if (next) existing.diffStats = next
    else delete existing.diffStats
    await writeJson(this.indexPath(), this.index)
  }

  async remove(id: string): Promise<void> {
    this.index = this.index.filter((m) => m.id !== id)
    await writeJson(this.indexPath(), this.index)
    await removeFile(this.file(id))
  }

  async summarizeUsage(): Promise<UsageSummary> {
    let userMessages = 0
    let assistantMessages = 0
    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let outputTokens = 0
    const workSceneStats = emptySceneUsage('work')
    const codeSceneStats = emptySceneUsage('code')
    let untaggedSceneMessages = 0
    const byProviderMap = new Map<
      string,
      { providerId: string; conversations: number; inputTokens: number; outputTokens: number }
    >()

    const missingEntries = this.index.filter((entry) => !entry.usageTotals)
    const missingFiles = new Set<string>()
    if (missingEntries.length > 0) {
      let backfilled = false
      const loaded = await Promise.all(
        missingEntries.map((entry) => readJson<Conversation | null>(this.file(entry.id), null)),
      )
      for (let i = 0; i < missingEntries.length; i++) {
        const entry = missingEntries[i]!
        const conv = loaded[i]
        if (!conv) {
          missingFiles.add(entry.id)
          continue
        }
        entry.usageTotals = computeConversationUsage(conv)
        if (entry.messageCount === undefined) entry.messageCount = conv.messages.length
        backfilled = true
      }
      if (backfilled) {
        await writeJson(this.indexPath(), this.index)
      }
    }

    let conversations = 0
    for (const entry of this.index) {
      if (missingFiles.has(entry.id) || !entry.usageTotals) continue
      const t = entry.usageTotals
      conversations += 1
      const pid = entry.providerId ?? 'default'
      let row = byProviderMap.get(pid)
      if (!row) {
        row = { providerId: pid, conversations: 0, inputTokens: 0, outputTokens: 0 }
        byProviderMap.set(pid, row)
      }
      row.conversations += 1
      userMessages += t.userMessages
      assistantMessages += t.assistantMessages
      inputTokens += t.inputTokens
      cacheReadTokens += t.cacheReadTokens
      cacheWriteTokens += t.cacheWriteTokens
      outputTokens += t.outputTokens
      row.inputTokens += t.inputTokens
      row.outputTokens += t.outputTokens
      untaggedSceneMessages += t.untaggedSceneMessages
      addSceneTotals(workSceneStats, t.workScene)
      addSceneTotals(codeSceneStats, t.codeScene)
    }

    const byProvider = Array.from(byProviderMap.values()).sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    )

    return {
      conversations,
      userMessages,
      assistantMessages,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      byProvider,
      byScene: {
        work: workSceneStats,
        code: codeSceneStats,
      },
      untaggedSceneMessages,
    }
  }

  private async persist(conversation: Conversation): Promise<void> {
    const offloaded = await this.blobs.offloadConversation(conversation)
    await writeJson(this.file(conversation.id), offloaded, { compact: true })
    await writeJson(this.indexPath(), this.index)
  }
}

function meta(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    providerId: conversation.providerId,
    workspace: conversation.workspace,
    messageCount: conversation.messages.length,
    usageTotals: computeConversationUsage(conversation),
    ...(conversation.titleSource ? { titleSource: conversation.titleSource } : {}),
    ...(conversation.worktreeBaseWorkspace ? { worktreeBaseWorkspace: conversation.worktreeBaseWorkspace } : {}),
    ...(conversation.worktreeBranch ? { worktreeBranch: conversation.worktreeBranch } : {}),
    ...(conversation.worktreeBaseBranch ? { worktreeBaseBranch: conversation.worktreeBaseBranch } : {}),
    ...(conversation.forkedFromId ? { forkedFromId: conversation.forkedFromId } : {}),
    ...(conversation.forkedFromTitle ? { forkedFromTitle: conversation.forkedFromTitle } : {}),
    ...(conversation.pinned ? { pinned: true } : {}),
    ...(conversation.archived ? { archived: true } : {}),
    ...(conversation.diffStats ? { diffStats: conversation.diffStats } : {}),
  }
}

export function titleFrom(conversation: Conversation): string {
  const first = conversation.messages.find((m) => m.role === 'user' && !m.isSummary)
  if (!first || first.role !== 'user') return 'New chat'
  const proseLines: string[] = []
  const codeLines: string[] = []
  let inFence = false
  for (const line of first.text.split(/\r?\n/)) {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (!clean) continue
    if (/^```/.test(clean)) {
      inFence = !inFence
      continue
    }
    if (inFence) codeLines.push(clean)
    else proseLines.push(clean)
  }
  const raw =
    proseLines[0] ||
    codeLines[0] ||
    first.documents?.[0]?.name ||
    first.images?.[0]?.name ||
    ''
  return raw.length > 42 ? `${raw.slice(0, 42)}…` : raw || 'New chat'
}
