// One small external store for the whole UI. Core events update it; views
// read it with useStore(selector).
import { useSyncExternalStore } from 'react'
import type { CoreEvent } from '@shared/ipc.ts'
import type {
  AgentEvent,
  AppSettings,
  ApprovalRequest,
  AttachedExternalFile,
  AutomationRule,
  BrowserSnapshot,
  ComputerUseMode,
  Conversation,
  ConversationMeta,
  DiffReviewComment,
  ImageAttachment,
  InstalledPlugin,
  KnowledgeStats,
  McpServerConfig,
  McpServerStatus,
  MemoryItem,
  PluginCandidate,
  ProviderConfig,
  QueuedMessage,
  RelayPulseAccountState,
  SandboxCapabilities,
  SkillInfo,
  TerminalSessionInfo,
  ToolRunStatus,
  UpdateState,
} from '@shared/types.ts'
import { call, shell } from './api.ts'
import { RELAYPULSE_DEFAULT_ORIGIN } from '@shared/relaypulse.ts'

export type View = 'chat' | 'connections' | 'market' | 'automations' | 'knowledge' | 'settings'

export type SettingsSection =
  | 'general'
  | 'models'
  | 'code'
  | 'cowork'
  | 'usage'
  | 'import'
  | 'system'
  | 'developer'
  | 'plugins'
  | 'skills'
  | 'connectors'
  | 'marketplace'

export interface NavEntry {
  view: View
  chatId: string | null
  connectionsTab?: 'mcp' | 'skills' | 'plugins'
}

function sameNav(a: NavEntry, b: NavEntry): boolean {
  if (a.view !== b.view) return false
  if (a.view === 'chat' && a.chatId !== b.chatId) return false
  if (a.view === 'connections' && (a.connectionsTab ?? 'mcp') !== (b.connectionsTab ?? 'mcp')) return false
  return true
}

export interface LiveTurn {
  busy: boolean
  hasText: boolean
  hasReasoning: boolean
  tools: Record<string, { status: ToolRunStatus; output?: string; images?: ImageAttachment[] }>
  approvals: ApprovalRequest[]
  compacting?: { active: boolean; auto?: boolean }
  error?: string
  endReason?: 'done' | 'aborted' | 'error' | 'max_rounds' | 'truncated'
  truncation?: 'token_limit' | 'stream_interrupted'
}

export interface StreamTurn {
  text: string
  reasoning: string
}

export interface ChatDraft {
  text: string
  files: string[]
  externalFiles: AttachedExternalFile[]
  images: ImageAttachment[]
}

export const EMPTY_DRAFT: ChatDraft = { text: '', files: [], externalFiles: [], images: [] }

export interface State {
  ready: boolean
  view: View
  connectionsTab: 'mcp' | 'skills' | 'plugins'
  navHistory: NavEntry[]
  navIndex: number
  sidebarOpen: boolean
  paletteOpen: boolean
  settingsOpen: boolean
  settingsSection: SettingsSection
  settings: AppSettings | null
  providers: ProviderConfig[]
  account: RelayPulseAccountState
  accountModalOpen: boolean
  servers: McpServerConfig[]
  statuses: Record<string, McpServerStatus>
  skills: SkillInfo[]
  plugins: InstalledPlugin[]
  discoveredPlugins: PluginCandidate[]
  pluginDiscoveryOpen: boolean
  terminalSessions: TerminalSessionInfo[]
  activeTerminalId: string | null
  terminalRequestedOpen: number
  automations: AutomationRule[]
  sandboxInfo: SandboxCapabilities | null
  memories: MemoryItem[]
  knowledge: KnowledgeStats | null
  knowledgeTab: 'knowledge' | 'memory'
  browserSnapshot: BrowserSnapshot | null
  browserSnapshotsByChat: Record<string, BrowserSnapshot>
  browserRequestedOpen: number
  chats: ConversationMeta[]
  activeChatId: string | null
  newChatUseWorktree: boolean
  conversations: Record<string, Conversation>
  live: Record<string, LiveTurn>
  streams: Record<string, StreamTurn>
  unreadChats: Record<string, boolean>
  queued: Record<string, QueuedMessage[]>
  diffComments: Record<string, DiffReviewComment[]>
  drafts: Record<string, ChatDraft>
  sessionAllows: string[]
  changesRevision: number
  update: UpdateState | null
  updatePromptForced: boolean
  snoozedUpdateKey: string | null
  toast: { id: number; text: string; tone: 'ok' | 'error' } | null
}

let state: State = {
  ready: false,
  view: 'chat',
  connectionsTab: 'mcp',
  navHistory: [{ view: 'chat', chatId: null }],
  navIndex: 0,
  sidebarOpen: localStorage.getItem('atrium.sidebar') !== 'closed',
  paletteOpen: false,
  settingsOpen: false,
  settingsSection: 'general',
  settings: null,
  providers: [],
  account: { origin: RELAYPULSE_DEFAULT_ORIGIN, connected: false },
  accountModalOpen: false,
  servers: [],
  statuses: {},
  skills: [],
  plugins: [],
  discoveredPlugins: [],
  pluginDiscoveryOpen: false,
  terminalSessions: [],
  activeTerminalId: null,
  terminalRequestedOpen: 0,
  automations: [],
  sandboxInfo: null,
  memories: [],
  knowledge: null,
  knowledgeTab: 'knowledge',
  browserSnapshot: null,
  browserSnapshotsByChat: {},
  browserRequestedOpen: 0,
  chats: [],
  activeChatId: null,
  newChatUseWorktree: false,
  conversations: {},
  live: {},
  streams: {},
  unreadChats: {},
  queued: {},
  diffComments: {},
  drafts: {},
  sessionAllows: [],
  changesRevision: 0,
  update: null,
  updatePromptForced: false,
  snoozedUpdateKey: null,
  toast: null,
}

const listeners = new Set<() => void>()

export function getState(): State {
  return state
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  for (const l of listeners) l()
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => selector(state),
  )
}

const emptyTurn = (): LiveTurn => ({ busy: false, hasText: false, hasReasoning: false, tools: {}, approvals: [] })
const EMPTY_STREAM: StreamTurn = { text: '', reasoning: '' }

export function liveFor(s: State, id: string | null): LiveTurn {
  return (id && s.live[id]) || EMPTY
}
export function streamFor(s: State, id: string | null): StreamTurn {
  return (id && s.streams[id]) || EMPTY_STREAM
}
const EMPTY = emptyTurn()
const autoOpenedBrowserChats = new Set<string>()

export function browserSnapshotFor(s: State, chatId: string | null | undefined): BrowserSnapshot | null {
  if (chatId) {
    return s.browserSnapshotsByChat[chatId] ?? (s.browserSnapshot?.conversationId === chatId ? s.browserSnapshot : null)
  }
  return s.browserSnapshotsByChat['__default__'] ?? (!s.browserSnapshot?.conversationId ? s.browserSnapshot : null)
}

export function setBrowserSnapshot(snap: BrowserSnapshot, fallbackChatId?: string | null): void {
  const key = snap.conversationId || fallbackChatId || '__default__'
  const normalized = !snap.conversationId && fallbackChatId ? { ...snap, conversationId: fallbackChatId } : snap
  setState((s) => ({
    browserSnapshotsByChat: { ...s.browserSnapshotsByChat, [key]: normalized },
    ...(!normalized.conversationId || normalized.conversationId === s.activeChatId ? { browserSnapshot: normalized } : {}),
  }))
}

const streamListeners = new Map<string, Set<(stream: StreamTurn) => void>>()
export function subscribeStream(id: string, cb: (stream: StreamTurn) => void): () => void {
  let set = streamListeners.get(id)
  if (!set) {
    set = new Set()
    streamListeners.set(id, set)
  }
  set.add(cb)
  return () => {
    const s = streamListeners.get(id)
    if (s) {
      s.delete(cb)
      if (s.size === 0) streamListeners.delete(id)
    }
  }
}

const pendingStreamDeltas = new Map<string, { text: string; reasoning: string }>()
let streamFlushHandle: number | ReturnType<typeof setTimeout> | null = null
let streamFlushUsesRaf = false

function notifyStreamListeners(id: string, nextStream: StreamTurn): void {
  const subs = streamListeners.get(id)
  if (!subs) return
  for (const fn of subs) fn(nextStream)
}

function scheduleStreamFlush(): void {
  if (streamFlushHandle !== null) return
  if (typeof requestAnimationFrame === 'function') {
    streamFlushUsesRaf = true
    streamFlushHandle = requestAnimationFrame(() => {
      streamFlushHandle = null
      flushStreamDeltas()
    })
  } else {
    streamFlushUsesRaf = false
    streamFlushHandle = setTimeout(() => {
      streamFlushHandle = null
      flushStreamDeltas()
    }, 16)
  }
}

export function flushStreamDeltas(): void {
  if (streamFlushHandle !== null) {
    if (streamFlushUsesRaf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(streamFlushHandle as number)
    } else {
      clearTimeout(streamFlushHandle as ReturnType<typeof setTimeout>)
    }
    streamFlushHandle = null
  }
  if (pendingStreamDeltas.size === 0) return
  const batch = new Map(pendingStreamDeltas)
  pendingStreamDeltas.clear()

  const updatedStreams: Array<[string, StreamTurn]> = []
  setState((s) => {
    const nextStreams = { ...s.streams }
    let nextLive: Record<string, LiveTurn> | null = null
    for (const [id, delta] of batch) {
      const curStream = s.streams[id] ?? EMPTY_STREAM
      const merged: StreamTurn = {
        text: delta.text ? curStream.text + delta.text : curStream.text,
        reasoning: delta.reasoning ? curStream.reasoning + delta.reasoning : curStream.reasoning,
      }
      nextStreams[id] = merged
      updatedStreams.push([id, merged])

      const curTurn = (nextLive ?? s.live)[id] ?? emptyTurn()
      const needTextFlag = Boolean(delta.text) && !curTurn.hasText
      const needReasoningFlag = Boolean(delta.reasoning) && !curTurn.hasReasoning
      if (needTextFlag || needReasoningFlag) {
        nextLive ??= { ...s.live }
        nextLive[id] = {
          ...curTurn,
          ...(needTextFlag ? { hasText: true } : {}),
          ...(needReasoningFlag ? { hasReasoning: true } : {}),
        }
      }
    }
    return nextLive ? { streams: nextStreams, live: nextLive } : { streams: nextStreams }
  })
  for (const [id, merged] of updatedStreams) {
    notifyStreamListeners(id, merged)
  }
}

function queueStreamDelta(id: string, kind: 'text' | 'reasoning', chunk: string): void {
  if (!chunk) return
  let entry = pendingStreamDeltas.get(id)
  if (!entry) {
    entry = { text: '', reasoning: '' }
    pendingStreamDeltas.set(id, entry)
  }
  entry[kind] += chunk
  scheduleStreamFlush()
}

function resetStream(id: string): void {
  pendingStreamDeltas.delete(id)
  setState((s) => {
    if (!(id in s.streams)) return {}
    const nextStreams = { ...s.streams }
    delete nextStreams[id]
    return { streams: nextStreams }
  })
  notifyStreamListeners(id, EMPTY_STREAM)
}

export function draftKey(chatId: string | null): string {
  return chatId ?? '__new__'
}

export function updateDraft(chatId: string | null, fn: (cur: ChatDraft) => ChatDraft): void {
  const key = draftKey(chatId)
  setState((s) => {
    const cur = s.drafts[key] ?? EMPTY_DRAFT
    const next = fn(cur)
    return { drafts: { ...s.drafts, [key]: next } }
  })
}

export function diffReviewKey(chatId: string | null, workspace?: string): string {
  return workspace ? `${chatId ?? '__new__'}::${workspace}` : chatId ?? '__new__'
}

export function addDiffComment(key: string, comment: Omit<DiffReviewComment, 'id'>): void {
  const id = `rc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  setState((s) => ({
    diffComments: {
      ...s.diffComments,
      [key]: [...(s.diffComments[key] ?? []), { ...comment, id }],
    },
  }))
}

export function updateDiffComment(key: string, id: string, body: string): void {
  const clean = body.trim()
  if (!clean) {
    removeDiffComment(key, id)
    return
  }
  setState((s) => ({
    diffComments: {
      ...s.diffComments,
      [key]: (s.diffComments[key] ?? []).map((c) => (c.id === id ? { ...c, body: clean } : c)),
    },
  }))
}

export function removeDiffComment(key: string, id: string): void {
  setState((s) => ({
    diffComments: {
      ...s.diffComments,
      [key]: (s.diffComments[key] ?? []).filter((c) => c.id !== id),
    },
  }))
}

export function clearDiffComments(key: string): void {
  setState((s) => {
    const next = { ...s.diffComments }
    delete next[key]
    return { diffComments: next }
  })
}

function updateTurn(id: string, fn: (t: LiveTurn) => Partial<LiveTurn>): void {
  setState((s) => {
    const cur = s.live[id] ?? emptyTurn()
    return { live: { ...s.live, [id]: { ...cur, ...fn(cur) } } }
  })
}

function onAgent(e: AgentEvent): void {
  if (e.type === 'approval') {
    const id = e.request.conversationId
    updateTurn(id, (t) => ({ approvals: [...t.approvals, e.request] }))
    return
  }
  if (e.type === 'conversation_sync') {
    const conv = e.conversation
    setState((s) => ({ conversations: { ...s.conversations, [conv.id]: conv } }))
    return
  }
  if (e.type === 'queue_sync') {
    setState((s) => ({ queued: { ...s.queued, [e.conversationId]: e.items } }))
    return
  }
  const id = e.conversationId
  switch (e.type) {
    case 'turn_start':
      resetStream(id)
      return updateTurn(id, () => ({ ...emptyTurn(), busy: true }))
    case 'text_delta':
      queueStreamDelta(id, 'text', e.text)
      return
    case 'reasoning_delta':
      queueStreamDelta(id, 'reasoning', e.text)
      return
    case 'tool_call':
      if (e.call.name.startsWith('browser_') && !autoOpenedBrowserChats.has(id) && getState().activeChatId === id) {
        autoOpenedBrowserChats.add(id)
        requestOpenBrowserDrawer()
      }
      return updateTurn(id, (t) => ({ tools: { ...t.tools, [e.call.id]: { status: 'running' } } }))
    case 'tool_status':
      return updateTurn(id, (t) => ({
        tools: {
          ...t.tools,
          [e.toolCallId]: {
            status: e.status,
            output: e.output ?? t.tools[e.toolCallId]?.output,
            images: e.images ?? t.tools[e.toolCallId]?.images,
          },
        },
        approvals: e.status === 'awaiting_approval' ? t.approvals : t.approvals.filter((a) => a.toolCallId !== e.toolCallId),
      }))
    case 'message_saved':
      if (e.message.role === 'assistant') {
        pendingStreamDeltas.delete(id)
        setState((s) => {
          const nextStreams = id in s.streams ? { ...s.streams } : null
          if (nextStreams) delete nextStreams[id]
          const conv = s.conversations[id]
          const curTurn = s.live[id] ?? emptyTurn()
          const nextLive =
            curTurn.hasText || curTurn.hasReasoning
              ? { ...s.live, [id]: { ...curTurn, hasText: false, hasReasoning: false } }
              : s.live
          return {
            ...(nextStreams ? { streams: nextStreams } : {}),
            ...(nextLive !== s.live ? { live: nextLive } : {}),
            ...(conv ? { conversations: { ...s.conversations, [id]: { ...conv, messages: [...conv.messages, e.message] } } } : {}),
          }
        })
        notifyStreamListeners(id, EMPTY_STREAM)
        return
      }
      setState((s) => {
        const conv = s.conversations[id]
        if (!conv) return {}
        return { conversations: { ...s.conversations, [id]: { ...conv, messages: [...conv.messages, e.message] } } }
      })
      return
    case 'compacting':
      return updateTurn(id, () => ({ compacting: e.active ? { active: true, auto: e.auto } : undefined }))
    case 'hook_event':
      if (e.decision === 'block' || e.decision === 'warn') {
        const msg = e.message ? `: ${e.message}` : ''
        toast(`[${e.pluginName} · ${e.event}]${msg}`, e.decision === 'block' ? 'error' : 'ok')
      }
      return
    case 'error':
      flushStreamDeltas()
      return updateTurn(id, () => ({ error: e.message }))
    case 'turn_end': {
      pendingStreamDeltas.delete(id)
      setState((s) => {
        const isCurrentVisible = s.view === 'chat' && s.activeChatId === id
        const nextStreams = id in s.streams ? { ...s.streams } : null
        if (nextStreams) delete nextStreams[id]
        return {
          ...(nextStreams ? { streams: nextStreams } : {}),
          changesRevision: s.changesRevision + 1,
          ...(!isCurrentVisible ? { unreadChats: { ...s.unreadChats, [id]: true } } : {}),
        }
      })
      notifyStreamListeners(id, EMPTY_STREAM)
      void call('agent.allows').then((sessionAllows) => setState({ sessionAllows })).catch(() => undefined)
      return updateTurn(id, () => ({
        busy: false,
        hasText: false,
        hasReasoning: false,
        approvals: [],
        compacting: undefined,
        endReason: e.reason,
        truncation: e.truncation,
      }))
    }
  }
}

const terminalChunkListeners = new Map<string, Set<(chunk: string) => void>>()
const terminalLocalBuffers = new Map<string, string>()

export function subscribeTerminalOutput(id: string, cb: (chunk: string) => void): () => void {
  let set = terminalChunkListeners.get(id)
  if (!set) {
    set = new Set()
    terminalChunkListeners.set(id, set)
  }
  set.add(cb)
  return () => {
    const s = terminalChunkListeners.get(id)
    if (s) {
      s.delete(cb)
      if (s.size === 0) terminalChunkListeners.delete(id)
    }
  }
}

export function clearTerminalLocalBuffer(id: string): void {
  terminalLocalBuffers.set(id, '')
}

export function requestOpenTerminalDrawer(): void {
  setState((s) => ({
    view: 'chat',
    terminalRequestedOpen: s.terminalRequestedOpen + 1,
  }))
}

export function requestOpenBrowserDrawer(): void {
  setState((s) => ({
    view: 'chat',
    browserRequestedOpen: s.browserRequestedOpen + 1,
  }))
}

export async function refreshKnowledgeAndMemory(workspace?: string): Promise<void> {
  const ws = workspace ?? getState().settings?.workspace
  const [memories, knowledge] = await Promise.all([
    call('memory.list', ws).catch(() => [] as MemoryItem[]),
    call('knowledge.status', ws).catch(() => null),
  ])
  setState({ memories, knowledge })
}

export function handleCoreEvent(event: CoreEvent): void {
  if (event.channel === 'agent') onAgent(event.payload)
  else if (event.channel === 'mcp') setState((s) => ({ statuses: { ...s.statuses, [event.payload.id]: event.payload } }))
  else if (event.channel === 'chats') setState({ chats: event.payload })
  else if (event.channel === 'terminal') {
    const t = event.payload
    if (t.type === 'data') {
      const prev = terminalLocalBuffers.get(t.id) ?? ''
      terminalLocalBuffers.set(t.id, (prev + t.chunk).slice(-100_000))
      const listenersForId = terminalChunkListeners.get(t.id)
      if (listenersForId) for (const fn of listenersForId) fn(t.chunk)
    } else if (t.type === 'state') {
      setState((s) => {
        const idx = s.terminalSessions.findIndex((x) => x.id === t.session.id)
        const next = idx === -1 ? [...s.terminalSessions, t.session] : s.terminalSessions.map((x) => (x.id === t.session.id ? t.session : x))
        return {
          terminalSessions: next,
          activeTerminalId: s.activeTerminalId ?? t.session.id,
        }
      })
    } else if (t.type === 'closed') {
      terminalLocalBuffers.delete(t.id)
      setState((s) => {
        const next = s.terminalSessions.filter((x) => x.id !== t.id)
        return {
          terminalSessions: next,
          activeTerminalId: s.activeTerminalId === t.id ? (next[0]?.id ?? null) : s.activeTerminalId,
        }
      })
    }
  } else if (event.channel === 'automations') {
    setState({ automations: event.payload })
  } else if (event.channel === 'memory') {
    const ws = getState().settings?.workspace
    void call('memory.list', ws).then((memories) => setState({ memories })).catch(() => setState({ memories: event.payload }))
  } else if (event.channel === 'knowledge') {
    setState({ knowledge: event.payload })
  } else if (event.channel === 'browser') {
    setBrowserSnapshot(event.payload)
  } else if (event.channel === 'account') {
    setState({ account: event.payload })
    void Promise.all([call('providers.list'), call('settings.get')])
      .then(([providers, settings]) => setState({ providers, settings }))
      .catch(() => undefined)
  } else if (event.channel === 'app') {
    if (event.payload.action === 'open_chat' && event.payload.conversationId) {
      const targetId = event.payload.conversationId
      void import('./chats.ts').then((m) => m.openChat(targetId))
    }
  }
  else if (event.channel === 'updater') {
    const next = event.payload
    setState((s) => {
      const versionChanged = Boolean(next.version && next.version !== s.update?.version)
      return {
        update: next,
        ...(versionChanged ? { snoozedUpdateKey: null } : {}),
      }
    })
  }
  else if (event.channel === 'core') void loadAll()
}

export async function refreshSkills(workspace?: string): Promise<SkillInfo[]> {
  const skills = await call('skills.list', workspace).catch(() => [] as SkillInfo[])
  setState({ skills })
  return skills
}

export async function loadAll(): Promise<void> {
  // Start secondary panel IPCs immediately in parallel, but unlock first-paint
  // as soon as critical workspace/session state finishes loading.
  const secondaryPromise = Promise.all([
    call('skills.list').catch(() => [] as SkillInfo[]),
    call('plugins.list').catch(() => [] as InstalledPlugin[]),
    call('terminal.list').catch(() => [] as TerminalSessionInfo[]),
    call('automations.list').catch(() => [] as AutomationRule[]),
    call('sandbox.info').catch(() => null),
    call('browser.state').catch(() => null),
  ])

  const [settings, providers, servers, statuses, chats, sessionAllows, account, update] = await Promise.all([
    call('settings.get'),
    call('providers.list'),
    call('mcp.list'),
    call('mcp.status'),
    call('chats.list'),
    call('agent.allows').catch(() => [] as string[]),
    call('account.state').catch(() => ({ origin: RELAYPULSE_DEFAULT_ORIGIN, connected: false })),
    shell.updateState().catch(() => null),
  ])
  setState({
    ready: true,
    settings,
    providers,
    account,
    servers,
    chats,
    sessionAllows,
    update,
    statuses: Object.fromEntries(statuses.map((st) => [st.id, st])),
  })

  void secondaryPromise.then(([skills, plugins, terminalSessions, automations, sandboxInfo, browserSnapshot]) => {
    setState((s) => {
      const bKey = browserSnapshot?.conversationId || '__default__'
      return {
        skills,
        plugins,
        terminalSessions,
        activeTerminalId:
          s.activeTerminalId && terminalSessions.some((t) => t.id === s.activeTerminalId)
            ? s.activeTerminalId
            : (terminalSessions[0]?.id ?? null),
        automations,
        sandboxInfo,
        browserSnapshot,
        ...(browserSnapshot ? { browserSnapshotsByChat: { ...s.browserSnapshotsByChat, [bKey]: browserSnapshot } } : {}),
      }
    })
  })
  void Promise.all([
    call('memory.list', settings.workspace).catch(() => [] as MemoryItem[]),
    call('knowledge.status', settings.workspace).catch(() => null),
  ]).then(([memories, knowledge]) => {
    setState({ memories, knowledge })
  })
  if (account.connected) {
    void call('account.refresh').catch(() => undefined)
  }
}

export function openAccountModal(): void {
  setState({ accountModalOpen: true })
}

export function closeAccountModal(): void {
  setState({ accountModalOpen: false })
}

export async function checkForUpdates(feedUrl?: string): Promise<UpdateState | null> {
  const next = await shell.checkUpdates(feedUrl)
  setState({ update: next })
  return next
}

export async function downloadAppUpdate(): Promise<UpdateState | null> {
  const next = await shell.downloadUpdate()
  setState({ update: next })
  return next
}

export async function installAppUpdate(): Promise<void> {
  await shell.installUpdate()
}

export function openUpdatePrompt(): void {
  setState({ updatePromptForced: true, snoozedUpdateKey: null })
}

export function closeUpdatePrompt(snooze = true): void {
  const u = getState().update
  const key = snooze && u?.status ? `${u.status}:${u.version ?? ''}` : getState().snoozedUpdateKey
  setState({ updatePromptForced: false, snoozedUpdateKey: key })
}

export async function skipUpdateVersion(version: string): Promise<void> {
  const trimmed = version.trim()
  if (!trimmed) return
  const settings = await call('settings.update', { skippedUpdateVersion: trimmed })
  setState({
    settings,
    updatePromptForced: false,
    snoozedUpdateKey: null,
  })
}

export async function clearSkippedUpdateVersion(): Promise<void> {
  const settings = await call('settings.update', { skippedUpdateVersion: '' })
  setState({ settings })
}

let toastId = 0

export function toggleSidebar(): void {
  const open = !getState().sidebarOpen
  localStorage.setItem('atrium.sidebar', open ? 'open' : 'closed')
  setState({ sidebarOpen: open })
}

export function canGoBack(s: State = state): boolean {
  return s.navIndex > 0
}

export function canGoForward(s: State = state): boolean {
  return s.navIndex < s.navHistory.length - 1
}

export function openSettings(section: SettingsSection = 'general'): void {
  setState({ settingsOpen: true, settingsSection: section, paletteOpen: false })
}

export function closeSettings(): void {
  setState({ settingsOpen: false })
}

export function navigate(target: NavEntry, opts?: { replace?: boolean }): void {
  if (target.view === 'settings') {
    openSettings()
    return
  }
  setState((s) => {
    const normalized: NavEntry = {
      view: target.view,
      chatId: target.view === 'chat' ? target.chatId : s.activeChatId,
      ...(target.view === 'connections' ? { connectionsTab: target.connectionsTab ?? s.connectionsTab } : {}),
    }
    const cur = s.navHistory[s.navIndex]
    let navHistory = s.navHistory
    let navIndex = s.navIndex
    if (!cur || !sameNav(cur, normalized)) {
      if (opts?.replace) {
        navHistory = [...s.navHistory.slice(0, s.navIndex), normalized, ...s.navHistory.slice(s.navIndex + 1)]
      } else {
        navHistory = [...s.navHistory.slice(0, s.navIndex + 1), normalized].slice(-40)
        navIndex = navHistory.length - 1
      }
    }
    const nextUnread =
      normalized.view === 'chat' && normalized.chatId && s.unreadChats[normalized.chatId]
        ? (() => {
            const copy = { ...s.unreadChats }
            delete copy[normalized.chatId!]
            return copy
          })()
        : s.unreadChats
    return {
      view: normalized.view,
      ...(normalized.view === 'chat' ? { activeChatId: normalized.chatId, unreadChats: nextUnread } : {}),
      ...(normalized.view === 'connections' ? { connectionsTab: normalized.connectionsTab ?? 'mcp' } : {}),
      paletteOpen: false,
      settingsOpen: false,
      navHistory,
      navIndex,
    }
  })
}

async function applyHistoryEntry(entry: NavEntry, idx: number): Promise<void> {
  setState({
    navIndex: idx,
    view: entry.view,
    ...(entry.view === 'chat' ? { activeChatId: entry.chatId } : {}),
    ...(entry.view === 'connections' ? { connectionsTab: entry.connectionsTab ?? 'mcp' } : {}),
  })
  if (entry.view === 'chat' && entry.chatId) {
    const id = entry.chatId
    const conv = state.conversations[id] ?? (await call('chats.get', id).catch(() => null))
    if (conv) {
      setState((s) => ({ conversations: { ...s.conversations, [id]: conv } }))
      const ws = conv.worktreeBaseWorkspace ?? conv.workspace
      if (ws && ws !== state.settings?.workspace) {
        const [settings, sessionAllows] = await Promise.all([
          call('settings.update', { workspace: ws }).catch(() => state.settings),
          call('agent.allows', ws).catch(() => [] as string[]),
        ])
        if (settings) setState({ settings, sessionAllows })
      }
    }
  }
}

export async function goBack(): Promise<void> {
  const s = getState()
  if (s.navIndex <= 0) return
  const nextIdx = s.navIndex - 1
  const target = s.navHistory[nextIdx]
  if (target) await applyHistoryEntry(target, nextIdx)
}

export async function goForward(): Promise<void> {
  const s = getState()
  if (s.navIndex >= s.navHistory.length - 1) return
  const nextIdx = s.navIndex + 1
  const target = s.navHistory[nextIdx]
  if (target) await applyHistoryEntry(target, nextIdx)
}
export async function toggleMcpServerEnabled(id: string, enabled: boolean): Promise<void> {
  await call('mcp.setEnabled', id, enabled)
  setState({ servers: await call('mcp.list') })
}

export async function toggleWebToolEnabled(enabled: boolean): Promise<void> {
  const settings = await call('settings.update', { webEnabled: enabled })
  setState({ settings })
}

export async function toggleComputerUseEnabled(enabled: boolean): Promise<void> {
  const settings = await call('settings.update', { computerUseEnabled: enabled })
  setState({ settings })
}

export async function toggleDesktopControlEnabled(enabled: boolean): Promise<void> {
  const settings = await call('settings.update', {
    desktopControlEnabled: enabled,
    computerUseMode: enabled ? 'desktop' : 'browser',
  })
  setState({ settings })
}

export async function setComputerUseMode(mode: ComputerUseMode): Promise<void> {
  const settings = await call('settings.update', {
    computerUseMode: mode,
    desktopControlEnabled: mode === 'desktop',
  })
  setState({ settings })
}

export async function toggleSkillEnabled(name: string, enabled: boolean, workspace?: string): Promise<void> {
  const skills = await call('skills.setEnabled', name, enabled, workspace)
  setState({ skills })
}

export async function refreshPlugins(workspace?: string): Promise<InstalledPlugin[]> {
  const ws = workspace ?? getState().settings?.workspace
  const [plugins, skills, servers, statuses] = await Promise.all([
    call('plugins.list').catch(() => [] as InstalledPlugin[]),
    call('skills.list', ws).catch(() => [] as SkillInfo[]),
    call('mcp.list').catch(() => [] as McpServerConfig[]),
    call('mcp.status').catch(() => [] as McpServerStatus[]),
  ])
  setState({
    plugins,
    skills,
    servers,
    statuses: Object.fromEntries(statuses.map((st) => [st.id, st])),
  })
  return plugins
}

export async function togglePluginEnabled(id: string, enabled: boolean, workspace?: string): Promise<void> {
  await call('plugins.setEnabled', id, enabled)
  await refreshPlugins(workspace)
}

export async function scanLocalPlugins(opts?: {
  autoPrompt?: boolean
  openModal?: boolean
  workspace?: string
}): Promise<PluginCandidate[]> {
  const ws = opts?.workspace ?? getState().settings?.workspace
  const discoveredPlugins = await call('plugins.discover', ws).catch(() => [] as PluginCandidate[])
  setState({ discoveredPlugins })
  if (opts?.openModal) {
    setState({ pluginDiscoveryOpen: true })
    return discoveredPlugins
  }
  if (opts?.autoPrompt) {
    const s = getState().settings
    if (s && !s.pluginDiscoveryDismissed) {
      const seen = new Set(s.seenExternalPluginKeys ?? [])
      const fresh = discoveredPlugins.filter((c) => !c.alreadyImported && c.recommended && !seen.has(c.key))
      if (fresh.length > 0) setState({ pluginDiscoveryOpen: true })
    }
  }
  return discoveredPlugins
}

export async function acknowledgeDiscoveredPlugins(dismissForever = false): Promise<void> {
  const { settings, discoveredPlugins } = getState()
  const existing = new Set(settings?.seenExternalPluginKeys ?? [])
  for (const c of discoveredPlugins) existing.add(c.key)
  const patch: Partial<AppSettings> = {
    seenExternalPluginKeys: [...existing],
    ...(dismissForever ? { pluginDiscoveryDismissed: true } : {}),
  }
  const updated = await call('settings.update', patch).catch(() => settings)
  setState({ settings: updated ?? settings, pluginDiscoveryOpen: false })
}

export function toast(text: string, tone: 'ok' | 'error' = 'ok'): void {
  const id = ++toastId
  setState({ toast: { id, text, tone } })
  setTimeout(() => {
    if (getState().toast?.id === id) setState({ toast: null })
  }, 3200)
}
