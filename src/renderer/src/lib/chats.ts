import { isEmptyChatStub, type DocumentAttachment, type ImageAttachment } from '@shared/types.ts'
import { call, errorMessage } from './api.ts'
import { draftKey, EMPTY_DRAFT, getState, navigate, refreshKnowledgeAndMemory, setState, toast, updateDraft } from './store.ts'

function focusComposer(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
  })
}

async function cleanupEmptyChat(id: string | null | undefined): Promise<void> {
  if (!id) return
  const s = getState()
  const isBusy = Boolean(s.live[id]?.busy)
  if (isBusy) return
  const conv = s.conversations[id]
  const meta = s.chats.find((c) => c.id === id)
  const target = conv ? { ...conv, messageCount: conv.messages.length } : meta
  if (!target || !isEmptyChatStub(target, false)) return
  await call('chats.remove', id).catch(() => undefined)
  setState((cur) => {
    const conversations = { ...cur.conversations }
    delete conversations[id]
    const drafts = { ...cur.drafts }
    delete drafts[id]
    const queued = { ...cur.queued }
    delete queued[id]
    const navHistory = cur.navHistory.filter((entry) => !(entry.view === 'chat' && entry.chatId === id))
    const safeHistory = navHistory.length ? navHistory : [{ view: 'chat' as const, chatId: null }]
    const navIndex = Math.min(cur.navIndex, safeHistory.length - 1)
    return {
      conversations,
      drafts,
      queued,
      chats: cur.chats.filter((c) => c.id !== id),
      navHistory: safeHistory,
      navIndex,
    }
  })
}

async function syncWorkspaceFromConversation(workspace: string | undefined): Promise<void> {
  const cur = getState().settings?.workspace
  if (!workspace || workspace === cur) return
  try {
    const [settings, sessionAllows] = await Promise.all([
      call('settings.update', { workspace }),
      call('agent.allows', workspace).catch(() => [] as string[]),
    ])
    setState({ settings, sessionAllows })
  } catch {
    /* ignore workspace sync error */
  }
}

export async function openChat(id: string): Promise<void> {
  const prevId = getState().activeChatId
  if (prevId && prevId !== id) void cleanupEmptyChat(prevId)
  navigate({ view: 'chat', chatId: id })
  void call('agent.queueList', id)
    .then((items) => setState((s) => ({ queued: { ...s.queued, [id]: items } })))
    .catch(() => undefined)
  const cached = getState().conversations[id]
  const meta = getState().chats.find((c) => c.id === id)
  if (cached) {
    void syncWorkspaceFromConversation(cached.worktreeBaseWorkspace ?? cached.workspace ?? meta?.worktreeBaseWorkspace ?? meta?.workspace)
    return
  }
  try {
    const conversation = await call('chats.get', id)
    if (conversation) {
      setState((s) => ({ conversations: { ...s.conversations, [id]: conversation } }))
      void syncWorkspaceFromConversation(
        conversation.worktreeBaseWorkspace ?? conversation.workspace ?? meta?.worktreeBaseWorkspace ?? meta?.workspace,
      )
    }
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export async function forkChat(id: string, messageIndex?: number, titleSuffix?: string): Promise<string | null> {
  try {
    const prevId = getState().activeChatId
    const forked = await call('chats.fork', id, messageIndex, titleSuffix)
    if (prevId && prevId !== forked.id) void cleanupEmptyChat(prevId)
    setState((s) => ({
      conversations: { ...s.conversations, [forked.id]: forked },
    }))
    navigate({ view: 'chat', chatId: forked.id })
    return forked.id
  } catch (err) {
    toast(errorMessage(err), 'error')
    return null
  }
}

export async function newWorktreeChat(baseWorkspace: string, branchName?: string): Promise<string> {
  const prevId = getState().activeChatId
  const conversation = await call('chats.createWorktree', baseWorkspace, branchName)
  if (prevId && prevId !== conversation.id) void cleanupEmptyChat(prevId)
  setState((s) => ({
    conversations: { ...s.conversations, [conversation.id]: conversation },
    changesRevision: s.changesRevision + 1,
  }))
  navigate({ view: 'chat', chatId: conversation.id })
  return conversation.id
}

/** Opens a fresh draft start screen without creating an empty entry in the sidebar until first send. */
export async function newChat(opts?: string | { workspace?: string; useWorktree?: boolean }): Promise<void> {
  const prevId = getState().activeChatId
  if (prevId) void cleanupEmptyChat(prevId)

  const targetWorkspace = typeof opts === 'string' ? opts : opts?.workspace
  const useWorktree = typeof opts === 'object' ? Boolean(opts?.useWorktree) : false

  if (targetWorkspace !== undefined) {
    const clean = targetWorkspace.trim()
    const current = getState().settings?.workspace ?? ''
    if (clean !== current) {
      try {
        const [settings, sessionAllows] = await Promise.all([
          call('settings.update', { workspace: clean }),
          call('agent.allows', clean).catch(() => [] as string[]),
        ])
        setState({ settings, sessionAllows })
        void refreshKnowledgeAndMemory(clean || undefined)
      } catch {
        /* ignore workspace switch error */
      }
    }
  }

  setState({ newChatUseWorktree: useWorktree })
  const alreadyOnStart = getState().view === 'chat' && !getState().activeChatId
  navigate({ view: 'chat', chatId: null }, { replace: alreadyOnStart })
  focusComposer()
}

/** Sends a message (lazily persisting a new chat only on first send, or queuing if busy). */
export async function sendMessage(
  text: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed && !images?.length && !documents?.length) return
  let createdFreshId: string | null = null
  try {
    const cleanImgs = images?.length ? images : undefined
    const cleanDocs = documents?.length ? documents : undefined
    let id = getState().activeChatId
    if (!id) {
      const ws = getState().settings?.workspace
      const useWorktree = Boolean(getState().newChatUseWorktree && ws)
      const created = useWorktree
        ? await call('chats.createWorktree', ws!)
        : await call('chats.create', ws)
      createdFreshId = created.id
      id = created.id
      setState((s) => ({
        newChatUseWorktree: false,
        conversations: { ...s.conversations, [created.id]: created },
        ...(useWorktree ? { changesRevision: s.changesRevision + 1 } : {}),
      }))
      navigate({ view: 'chat', chatId: created.id }, { replace: true })
    }
    if (getState().live[id]?.busy) {
      const items = await call('agent.enqueue', id, trimmed, cleanImgs, cleanDocs)
      setState((s) => ({ queued: { ...s.queued, [id]: items } }))
      return
    }
    await call('agent.send', id, trimmed, cleanImgs, cleanDocs)
  } catch (err) {
    if (createdFreshId) {
      await deleteChat(createdFreshId).catch(() => undefined)
      navigate({ view: 'chat', chatId: null }, { replace: true })
      updateDraft(null, (cur) => ({
        ...cur,
        text,
        images: images?.length ? images : cur.images,
      }))
    }
    toast(errorMessage(err), 'error')
  }
}

export async function cancelQueuedMessage(conversationId: string, queuedId: string): Promise<void> {
  try {
    const items = await call('agent.cancelQueued', conversationId, queuedId)
    setState((s) => ({ queued: { ...s.queued, [conversationId]: items } }))
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export async function steerQueuedMessage(conversationId: string, queuedId: string): Promise<void> {
  try {
    await call('agent.steerQueued', conversationId, queuedId)
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export async function regenerateChat(id: string): Promise<void> {
  try {
    await call('agent.regenerate', id)
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export async function compactChat(id: string): Promise<void> {
  try {
    const conversation = await call('agent.compact', id)
    setState((s) => ({ conversations: { ...s.conversations, [id]: conversation } }))
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export async function stopChat(id: string): Promise<void> {
  await call('agent.stop', id).catch(() => undefined)
}

export async function rewindChatTurn(id: string, messageIndex: number, revertFiles = true): Promise<boolean> {
  try {
    const res = await call('chats.rewind', id, messageIndex, revertFiles)
    setState((s) => {
      const drafts = { ...s.drafts }
      if (res.draftText) {
        drafts[draftKey(id)] = {
          ...(drafts[draftKey(id)] ?? EMPTY_DRAFT),
          text: res.draftText,
        }
      }
      return {
        conversations: { ...s.conversations, [id]: res.conversation },
        drafts,
        changesRevision: s.changesRevision + 1,
      }
    })
    return true
  } catch (err) {
    toast(errorMessage(err), 'error')
    return false
  }
}

export async function deleteChat(id: string): Promise<void> {
  await call('chats.remove', id)
  setState((s) => {
    const conversations = { ...s.conversations }
    delete conversations[id]
    const drafts = { ...s.drafts }
    delete drafts[id]
    const queued = { ...s.queued }
    delete queued[id]
    const navHistory = s.navHistory.filter((entry) => !(entry.view === 'chat' && entry.chatId === id))
    const safeHistory = navHistory.length ? navHistory : [{ view: 'chat' as const, chatId: null }]
    const navIndex = Math.min(s.navIndex, safeHistory.length - 1)
    return {
      conversations,
      drafts,
      queued,
      activeChatId: s.activeChatId === id ? null : s.activeChatId,
      navHistory: safeHistory,
      navIndex,
    }
  })
}
