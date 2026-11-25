import { useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Archive, ArchiveRestore, ArrowDown, ArrowDownAZ, ArrowUp, BrainCircuit, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, Command, Copy, Download, FolderOpen, FolderPlus, GitBranch, GitFork, MessageSquare, PanelLeftClose, Pencil, Pin, PinOff, Plug, Plus, RotateCw, Search, Settings, ShieldCheck, Sparkles, Store, Trash2, UserCircle2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isEmptyChatStub, type ConversationMeta } from '@shared/types.ts'
import { deleteChat, forkChat, newChat, openChat, stopChat } from '../lib/chats.ts'
import { installAppUpdate, liveFor, navigate, openAccountModal, openFleetModal, openPolicyModal, openSettings, openUpdatePrompt, setState, toast, toggleSidebar, useStore, type View } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { AccountAvatar } from './AccountPanel.tsx'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu.tsx'
import { ConfirmDialog } from './Dialog.tsx'
import { HistoryNavButtons, WorkSceneSwitch } from './HeaderControls.tsx'
import { Oculus } from './Oculus.tsx'
import { folderName, pickWorkspace, removeRecentWorkspace } from './WorkspacePicker.tsx'

const NAV: { view: View; icon: typeof Plug; key: string }[] = [
  { view: 'connections', icon: Plug, key: 'nav.connections' },
  { view: 'market', icon: Store, key: 'nav.marketplace' },
  { view: 'automations', icon: Clock, key: 'nav.automations' },
  { view: 'knowledge', icon: BrainCircuit, key: 'nav.knowledge' },
]

const UNSCOPED_KEY = '__unscoped__'

function wsKey(path: string | undefined): string {
  return path ? path.replace(/[\\/]+$/, '').toLowerCase() : UNSCOPED_KEY
}

function formatRelTime(ts: number, t: ReturnType<typeof useTranslation>['t']): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return t('chat.timeJustNow')
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return t('chat.timeMinsAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('chat.timeHoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('chat.timeDaysAgo', { count: days })
}

interface WorkspaceGroup {
  key: string
  path?: string
  name: string
  chats: ConversationMeta[]
  isActive: boolean
}

export function Sidebar({
  open = true,
  sidebarWidth,
  resizing = false,
  onStartResize,
  onResetWidth,
}: {
  open?: boolean
  sidebarWidth?: number
  resizing?: boolean
  onStartResize?: (e: ReactPointerEvent<HTMLDivElement>) => void
  onResetWidth?: () => void
}) {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const chats = useStore((s) => s.chats)
  const activeId = useStore((s) => s.activeChatId)
  const view = useStore((s) => s.view)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  const unreadChats = useStore((s) => s.unreadChats)
  const busyIds = useStore((s) => Object.keys(s.live).filter((id) => liveFor(s, id).busy).join(','))
  const busy = new Set(busyIds.split(',').filter(Boolean))
  const connected = useStore((s) => Object.values(s.statuses).filter((st) => st?.state === 'connected').length)
  const enabledAutos = useStore((s) => s.automations.filter((a) => a.enabled).length)
  const memoryAndKbCount = useStore((s) => s.memories.length + (s.knowledge?.sourceCount ?? 0))
  const providers = useStore((s) => s.providers)
  const account = useStore((s) => s.account)
  const update = useStore((s) => s.update)
  const activeProviderId = settings?.activeProviderId ?? providers[0]?.id
  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? providers[0]
  const fleetOpen = useStore((s) => s.fleetOpen)
  const policyOpen = useStore((s) => s.policyOpen)
  const [confirmDeleteChat, setConfirmDeleteChat] = useState<ConversationMeta | null>(null)
  const [confirmDeleteGroup, setConfirmDeleteGroup] = useState<WorkspaceGroup | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showArchived, setShowArchived] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    targetKind: 'group' | 'chat'
    targetKey: string
    entries: ContextMenuEntry[]
    ariaLabel: string
  } | null>(null)

  const realChats = chats.filter((c) => !isEmptyChatStub(c, busy.has(c.id)))
  const worktreeChats = realChats.filter((c) => Boolean(c.worktreeBaseWorkspace && c.worktreeBranch && !c.archived))
  const busyWorktrees = worktreeChats.filter((c) => busy.has(c.id)).length

  const q = chatQuery.trim().toLowerCase()
  const matchedChats = q
    ? realChats.filter(
        (c) =>
          (c.title || t('chat.untitled')).toLowerCase().includes(q) ||
          (folderName(c.workspace) ?? '').toLowerCase().includes(q),
      )
    : realChats

  const visibleChats = matchedChats.filter((c) => !c.archived)
  const archivedChats = matchedChats.filter((c) => Boolean(c.archived))

  const activeChat = activeId ? chats.find((c) => c.id === activeId) : undefined
  const activeWsKey = wsKey(activeChat?.worktreeBaseWorkspace ?? activeChat?.workspace ?? settings?.workspace)

  const workspaceOrder = new Map<string, string>()
  const registerWorkspace = (dir: string | undefined) => {
    if (!dir) return
    const key = wsKey(dir)
    if (!workspaceOrder.has(key)) workspaceOrder.set(key, dir)
  }
  for (const dir of settings?.recentWorkspaces ?? []) registerWorkspace(dir)
  registerWorkspace(settings?.workspace)
  for (const c of realChats.filter((x) => !x.archived)) registerWorkspace(c.worktreeBaseWorkspace ?? c.workspace)

  const chatsByGroup = new Map<string, ConversationMeta[]>()
  for (const c of visibleChats) {
    const key = wsKey(c.worktreeBaseWorkspace ?? c.workspace)
    const list = chatsByGroup.get(key)
    if (list) list.push(c)
    else chatsByGroup.set(key, [c])
  }
  for (const list of chatsByGroup.values()) {
    list.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
  }

  const workspaceGroups: WorkspaceGroup[] = []
  for (const [key, dir] of workspaceOrder) {
    const name = folderName(dir) ?? dir
    const groupChats = chatsByGroup.get(key) ?? []
    if (q && groupChats.length === 0 && !name.toLowerCase().includes(q)) continue
    workspaceGroups.push({
      key,
      path: dir,
      name,
      chats: groupChats,
      isActive: key === activeWsKey,
    })
  }

  const unscopedChats = chatsByGroup.get(UNSCOPED_KEY) ?? []
  if (unscopedChats.length > 0 || (workspaceGroups.length === 0 && !q && realChats.length > 0)) {
    workspaceGroups.push({
      key: UNSCOPED_KEY,
      name: t('chat.generalChats'),
      chats: unscopedChats,
      isActive: Boolean(activeChat && !activeChat.workspace),
    })
  }

  const confirmDelete = async () => {
    const target = confirmDeleteChat
    setConfirmDeleteChat(null)
    if (!target) return
    if (busy.has(target.id)) await stopChat(target.id).catch(() => undefined)
    await deleteChat(target.id).catch((err) => toast(errorMessage(err), 'error'))
  }

  const confirmDeleteAllInGroup = async () => {
    const group = confirmDeleteGroup
    setConfirmDeleteGroup(null)
    if (!group || group.chats.length === 0) return
    try {
      await Promise.all(group.chats.filter((c) => busy.has(c.id)).map((c) => stopChat(c.id).catch(() => undefined)))
      for (const c of group.chats) {
        await deleteChat(c.id)
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const copyText = (value: string) => {
    void navigator.clipboard?.writeText(value)
    toast(t('chat.ctxCopiedText', { text: value }))
  }

  const togglePinChat = async (c: ConversationMeta) => {
    try {
      await call('chats.setPinned', c.id, !c.pinned)
      setState({ chats: await call('chats.list') })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const toggleArchiveChat = async (c: ConversationMeta) => {
    try {
      await call('chats.setArchived', c.id, !c.archived)
      const list = await call('chats.list')
      setState((s) => ({
        chats: list,
        ...(!c.archived && s.activeChatId === c.id ? { activeChatId: null } : {}),
      }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const archiveGroupChats = async (group: WorkspaceGroup) => {
    if (group.chats.length === 0) return
    try {
      const ids = group.chats.map((c) => c.id)
      await call('chats.archiveGroup', ids, true)
      const list = await call('chats.list')
      setState((s) => ({
        chats: list,
        ...(s.activeChatId && ids.includes(s.activeChatId) ? { activeChatId: null } : {}),
      }))
      toast(t('chat.ctxArchiveGroupDone', { count: ids.length }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const folderGroups = workspaceGroups.filter((g) => Boolean(g.path))

  const reorderWorkspaces = async (nextDirs: string[]) => {
    try {
      const nextSettings = await call('settings.update', { recentWorkspaces: nextDirs })
      setState({ settings: nextSettings })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const moveWorkspaceGroup = (key: string, delta: -1 | 1) => {
    const dirs = folderGroups.map((g) => g.path!)
    const idx = folderGroups.findIndex((g) => g.key === key)
    const nextIdx = idx + delta
    if (idx < 0 || nextIdx < 0 || nextIdx >= dirs.length) return
    const next = [...dirs]
    ;[next[idx], next[nextIdx]] = [next[nextIdx]!, next[idx]!]
    void reorderWorkspaces(next)
  }

  const sortWorkspacesAZ = () => {
    const dirs = folderGroups
      .map((g) => g.path!)
      .sort((a, b) => (folderName(a) ?? a).localeCompare(folderName(b) ?? b, undefined, { sensitivity: 'base' }))
    void reorderWorkspaces(dirs)
  }

  const setAllGroupsCollapsed = (nextState: boolean) => {
    const next: Record<string, boolean> = {}
    for (const g of workspaceGroups) next[g.key] = nextState
    setCollapsed(next)
  }

  const openGroupContextMenu = (e: ReactMouseEvent, group: WorkspaceGroup) => {
    e.preventDefault()
    e.stopPropagation()
    const folderIdx = folderGroups.findIndex((item) => item.key === group.key)
    const entries: ContextMenuEntry[] = [
      {
        id: 'new-session',
        label: t('chat.newChatInWorkspace'),
        icon: <Plus size={14} />,
        onSelect: () => void startChatInGroup(group.key, group.path),
      },
      ...(group.path
        ? [
            {
              id: 'reveal-folder',
              label: t('chat.ctxRevealFolder'),
              icon: <FolderOpen size={14} />,
              onSelect: () => void shell.revealPath(group.path!).catch((err) => toast(errorMessage(err), 'error')),
            },
            {
              id: 'copy-folder',
              label: t('chat.ctxCopyFolderPath'),
              icon: <Copy size={14} />,
              onSelect: () => copyText(group.path!),
            },
          ]
        : []),
      ...(group.path && folderGroups.length > 1
        ? [
            { kind: 'separator' as const, id: 'sep-order' },
            {
              id: 'move-up',
              label: t('chat.ctxMoveUp'),
              icon: <ArrowUp size={14} />,
              disabled: folderIdx <= 0,
              onSelect: () => moveWorkspaceGroup(group.key, -1),
            },
            {
              id: 'move-down',
              label: t('chat.ctxMoveDown'),
              icon: <ArrowDown size={14} />,
              disabled: folderIdx < 0 || folderIdx >= folderGroups.length - 1,
              onSelect: () => moveWorkspaceGroup(group.key, 1),
            },
            {
              id: 'sort-az',
              label: t('chat.ctxSortAZ'),
              icon: <ArrowDownAZ size={14} />,
              onSelect: () => sortWorkspacesAZ(),
            },
          ]
        : []),
      { kind: 'separator', id: 'sep-fold' },
      {
        id: 'collapse-all',
        label: t('chat.ctxCollapseAll'),
        icon: <ChevronsDownUp size={14} />,
        onSelect: () => setAllGroupsCollapsed(true),
      },
      {
        id: 'expand-all',
        label: t('chat.ctxExpandAll'),
        icon: <ChevronsUpDown size={14} />,
        onSelect: () => setAllGroupsCollapsed(false),
      },
    ]

    if ((group.path && group.chats.length === 0) || group.chats.length > 0) {
      entries.push({ kind: 'separator', id: 'sep-danger' })
      if (group.path && group.chats.length === 0) {
        entries.push({
          id: 'remove-ws',
          label: t('chat.removeWorkspace'),
          icon: <X size={14} />,
          onSelect: () => void removeRecentWorkspace(group.path!),
        })
      }
      if (group.chats.length > 0) {
        entries.push({
          id: 'archive-all',
          label: t('chat.ctxArchiveGroup', { count: group.chats.length }),
          icon: <Archive size={14} />,
          onSelect: () => void archiveGroupChats(group),
        })
        entries.push({
          id: 'delete-all',
          label: t('chat.ctxDeleteAllChats', { count: group.chats.length }),
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => setConfirmDeleteGroup(group),
        })
      }
    }

    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      targetKind: 'group',
      targetKey: group.key,
      entries,
      ariaLabel: group.name,
    })
  }

  const openChatContextMenu = (e: ReactMouseEvent, chat: ConversationMeta) => {
    e.preventDefault()
    e.stopPropagation()
    const baseWs = chat.worktreeBaseWorkspace ?? chat.workspace
    const chatTitle = chat.title || t('chat.untitled')
    const entries: ContextMenuEntry[] = [
      {
        id: 'open-chat',
        label: t('chat.ctxOpenChat'),
        icon: <MessageSquare size={14} />,
        onSelect: () => void openChat(chat.id),
      },
      {
        id: 'rename-chat',
        label: t('common.rename'),
        icon: <Pencil size={14} />,
        onSelect: () => startRename(chat),
      },
      {
        id: 'pin-chat',
        label: chat.pinned ? t('chat.ctxUnpinChat') : t('chat.ctxPinChat'),
        icon: chat.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        onSelect: () => void togglePinChat(chat),
      },
      {
        id: 'fork-chat',
        label: t('chat.fork'),
        icon: <GitBranch size={14} />,
        onSelect: () =>
          void forkChat(chat.id, undefined, t('chat.forkSuffix')).then((id) => {
            if (id) toast(t('chat.forkDone'))
          }),
      },
      ...(baseWs
        ? [
            {
              id: 'new-in-ws',
              label: t('chat.newChatInWorkspace'),
              icon: <Plus size={14} />,
              onSelect: () => void newChat(baseWs).catch((err) => toast(errorMessage(err), 'error')),
            },
          ]
        : []),
      { kind: 'separator', id: 'sep-meta' },
      {
        id: 'copy-title',
        label: t('chat.ctxCopyTitle'),
        icon: <Copy size={14} />,
        onSelect: () => copyText(chatTitle),
      },
      ...(chat.workspace
        ? [
            {
              id: 'reveal-ws',
              label: t('chat.ctxRevealWorkspace'),
              icon: <FolderOpen size={14} />,
              onSelect: () => void shell.revealPath(chat.workspace!).catch((err) => toast(errorMessage(err), 'error')),
            },
          ]
        : []),
      { kind: 'separator', id: 'sep-del' },
      {
        id: 'archive-chat',
        label: chat.archived ? t('chat.ctxRestoreChat') : t('chat.ctxArchiveChat'),
        icon: chat.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />,
        onSelect: () => void toggleArchiveChat(chat),
      },
      {
        id: 'delete-chat',
        label: t('common.delete'),
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setConfirmDeleteChat(chat),
      },
    ]

    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      targetKind: 'chat',
      targetKey: chat.id,
      entries,
      ariaLabel: chatTitle,
    })
  }

  const startRename = (c: ConversationMeta) => {
    setRenamingId(c.id)
    setRenameDraft(c.title || '')
  }

  const commitRename = async (id: string) => {
    const title = renameDraft.trim()
    setRenamingId(null)
    if (!title) return
    try {
      await call('chats.rename', id, title)
      setState({ chats: await call('chats.list') })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const addWorkspace = async () => {
    const folder = await pickWorkspace({ rebindActiveChat: false })
    if (!folder) return
    const key = wsKey(folder)
    setCollapsed((prev) => ({ ...prev, [key]: false }))
    if (!realChats.some((c) => wsKey(c.workspace) === key)) {
      await newChat(folder).catch((err) => toast(errorMessage(err), 'error'))
    }
  }

  const startChatInGroup = async (key: string, path: string | undefined) => {
    setCollapsed((prev) => ({ ...prev, [key]: false }))
    await newChat(path ?? '').catch((err) => toast(errorMessage(err), 'error'))
  }

  return (
    <aside
      className={`sidebar${busy.size > 0 ? ' has-busy' : ''}${open ? '' : ' is-collapsed'}${resizing ? ' is-resizing' : ''}`}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      {open && onStartResize && (
        <div
          className={`sidebar-resizer${resizing ? ' active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('nav.resizeSidebar')}
          aria-valuenow={sidebarWidth}
          title={t('nav.resizeSidebar')}
          onPointerDown={onStartResize}
          onDoubleClick={onResetWidth}
        >
          {resizing && sidebarWidth != null && <span className="sidebar-resize-badge">{sidebarWidth}px</span>}
        </div>
      )}
      <div className="side-ambient" aria-hidden="true">
        <span className="side-ambient-aurora side-aurora-top" />
        <span className="side-ambient-aurora side-aurora-bottom" />
        <span className="side-ambient-dots" />
        <span className="side-seam-beam" />
      </div>
      <div className="sidebar-inner">
        <div className="side-top drag">
          <div className="brand">
            <span className="brand-badge" aria-hidden>
              <Oculus state={busy.size ? 'thinking' : 'idle'} size={18} label="Atrium" />
            </span>
            <span className="brand-name">Atrium</span>
          </div>
          <div className="side-top-acts">
            <HistoryNavButtons />
            <WorkSceneSwitch compact />
            <button className="icon-btn" onClick={toggleSidebar} aria-label={t('nav.hideSidebar')} title={t('nav.hideSidebar')}>
              <PanelLeftClose size={16} />
            </button>
          </div>
        </div>

      <nav className="side-main">
        <button className="side-item new-chat" onClick={() => void newChat().catch((err) => toast(errorMessage(err), 'error'))}>
          <span className="new-chat-plus" aria-hidden>
            <Plus size={14} strokeWidth={2.6} />
          </span>
          <span>{t('nav.newChat')}</span>
        </button>
        {NAV.map(({ view: v, icon: Icon, key }) => (
          <button key={v} data-view={v} className={`side-item${view === v ? ' active' : ''}`} onClick={() => navigate({ view: v, chatId: null })}>
            <Icon size={17} strokeWidth={1.75} />
            <span>{t(key)}</span>
            {v === 'connections' && connected > 0 && <span className="side-count">{connected}</span>}
            {v === 'automations' && enabledAutos > 0 && <span className="side-count">{enabledAutos}</span>}
            {v === 'knowledge' && memoryAndKbCount > 0 && <span className="side-count">{memoryAndKbCount}</span>}
          </button>
        ))}
        <button
          type="button"
          className={`side-item${fleetOpen ? ' active' : ''}`}
          onClick={openFleetModal}
        >
          <GitFork size={17} strokeWidth={1.75} />
          <span>{ft('fleet.navLabel')}</span>
          {worktreeChats.length > 0 && (
            <span className={`side-count side-fleet-badge${busyWorktrees > 0 ? ' is-running' : ''}`}>
              {worktreeChats.length}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`side-item${policyOpen ? ' active' : ''}`}
          onClick={openPolicyModal}
        >
          <ShieldCheck size={17} strokeWidth={1.75} />
          <span>{ft('policy.navLabel')}</span>
        </button>
      </nav>

      <div className="side-group-row">
        <span className="side-group-label">{t('nav.workspaces')}</span>
        <button
          type="button"
          className="icon-btn side-group-action"
          onClick={() => void addWorkspace()}
          aria-label={t('chat.addWorkspace')}
          title={t('chat.addWorkspace')}
        >
          <FolderPlus size={14} />
        </button>
      </div>

      {(realChats.length > 0 || workspaceOrder.size > 0) && (
        <div className="side-search">
          <Search size={13} className="side-search-icon" />
          <input
            value={chatQuery}
            onChange={(e) => setChatQuery(e.target.value)}
            placeholder={t('chat.searchChats')}
            aria-label={t('chat.searchChats')}
          />
          {chatQuery ? (
            <button type="button" className="side-search-clear" onClick={() => setChatQuery('')} aria-label={t('common.close')}>
              <X size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="side-search-cmd"
              onClick={() => setState({ paletteOpen: true })}
              aria-label={t('nav.commandPalette')}
              title={`${t('nav.commandPalette')} (${
                document.documentElement.dataset.platform === 'mac' ? '⌘K' : 'Ctrl+K'
              })`}
            >
              {document.documentElement.dataset.platform === 'mac' ? <Command size={11} /> : <span>Ctrl K</span>}
            </button>
          )}
        </div>
      )}

      <nav className="chat-list" aria-label={t('nav.chats')}>
        {workspaceGroups.length === 0 && (
          <p className="side-empty">{q ? t('chat.noMatchingChats') : t('nav.noChats')}</p>
        )}
        {workspaceGroups.map((g) => {
          const isCollapsed = q ? false : Boolean(collapsed[g.key])
          return (
            <div key={g.key} className={`ws-group${g.isActive ? ' active-ws' : ''}${isCollapsed ? ' collapsed' : ''}`}>
              <div
                className={`ws-group-head${ctxMenu?.targetKind === 'group' && ctxMenu.targetKey === g.key ? ' ctx-target' : ''}`}
                onContextMenu={(e) => openGroupContextMenu(e, g)}
              >
                <button
                  type="button"
                  className="ws-group-toggle"
                  onClick={() => toggleGroup(g.key)}
                  title={g.path ?? g.name}
                  aria-expanded={!isCollapsed}
                >
                  <ChevronRight size={13} className={`ws-group-chev${!isCollapsed ? ' open' : ''}`} />
                  {g.path ? (
                    <FolderOpen size={14} className="ws-group-icon" strokeWidth={1.85} />
                  ) : (
                    <MessageSquare size={14} className="ws-group-icon" strokeWidth={1.85} />
                  )}
                  <span className="ws-group-name">{g.name}</span>
                  <span className="ws-group-count">{g.chats.length}</span>
                </button>
                <div className="ws-group-actions">
                  <button
                    type="button"
                    className="icon-btn ws-group-act"
                    onClick={() => void startChatInGroup(g.key, g.path)}
                    aria-label={t('chat.newChatInWorkspace')}
                    title={t('chat.newChatInWorkspace')}
                  >
                    <Plus size={13} />
                  </button>
                  {g.path && g.chats.length === 0 && (
                    <button
                      type="button"
                      className="icon-btn ws-group-act"
                      onClick={() => void removeRecentWorkspace(g.path!)}
                      aria-label={t('chat.removeWorkspace')}
                      title={t('chat.removeWorkspace')}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              <div className={`ws-group-collapse${isCollapsed ? '' : ' open'}`} aria-hidden={isCollapsed}>
                <div className="ws-group-collapse-inner">
                  <div className="ws-group-chats">
                    {g.chats.length === 0 ? (
                      <button type="button" className="ws-group-empty" onClick={() => void startChatInGroup(g.key, g.path)}>
                        <Plus size={12} />
                        <span>{t('chat.startWorkspaceChat')}</span>
                      </button>
                    ) : (
                      g.chats.map((c, idx) => (
                        <div
                          key={c.id}
                          style={{ '--item-i': Math.min(idx, 12) } as CSSProperties}
                          className={`chat-item${c.id === activeId && view === 'chat' ? ' active' : ''}${busy.has(c.id) ? ' is-busy' : ''}${ctxMenu?.targetKind === 'chat' && ctxMenu.targetKey === c.id ? ' ctx-target' : ''}`}
                          onContextMenu={(e) => {
                            if (renamingId !== c.id) openChatContextMenu(e, c)
                          }}
                        >
                          {renamingId === c.id ? (
                            <form
                              className="chat-rename-form"
                              onSubmit={(e) => {
                                e.preventDefault()
                                void commitRename(c.id)
                              }}
                            >
                              <input
                                className="chat-rename-input"
                                value={renameDraft}
                                autoFocus
                                onFocus={(e) => e.currentTarget.select()}
                                onChange={(e) => setRenameDraft(e.target.value)}
                                onBlur={() => void commitRename(c.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault()
                                    setRenameDraft('')
                                    setRenamingId(null)
                                  }
                                }}
                                aria-label={t('common.rename')}
                              />
                            </form>
                          ) : (
                            <>
                              <button
                                className="chat-item-open"
                                onClick={() => void openChat(c.id)}
                                title={c.workspace ? `${c.title || t('chat.untitled')} · ${c.workspace}` : c.title}
                              >
                                {busy.has(c.id) ? (
                                  <Oculus state="thinking" size={13} />
                                ) : unreadChats[c.id] ? (
                                  <span className="chat-unread-dot" title={t('chat.unreadDone')} />
                                ) : c.pinned ? (
                                  <Pin size={12} className="chat-item-icon pin-icon" strokeWidth={1.9} />
                                ) : c.worktreeBranch ? (
                                  <GitBranch size={13} className="chat-item-icon wt-icon" strokeWidth={1.8} />
                                ) : (
                                  <MessageSquare size={13} className="chat-item-icon" strokeWidth={1.7} />
                                )}
                                <span className="chat-item-title">{c.title || t('chat.untitled')}</span>
                                {c.diffStats && (c.diffStats.additions > 0 || c.diffStats.deletions > 0) && (
                                  <span className="chat-diff-pill">
                                    {c.diffStats.additions > 0 && <em className="add">+{c.diffStats.additions}</em>}
                                    {c.diffStats.deletions > 0 && <em className="del">-{c.diffStats.deletions}</em>}
                                  </span>
                                )}
                                {c.worktreeBranch && (
                                  <span className="chat-wt-pill" title={c.worktreeBranch}>
                                    {c.worktreeBranch.replace(/^atrium\//, '')}
                                  </span>
                                )}
                                {!busy.has(c.id) && (
                                  <span className="chat-item-time">{formatRelTime(c.updatedAt, t)}</span>
                                )}
                              </button>
                              <div className="chat-item-actions">
                                <button
                                  className="icon-btn chat-item-act"
                                  onClick={() =>
                                    void forkChat(c.id, undefined, t('chat.forkSuffix')).then((id) => {
                                      if (id) toast(t('chat.forkDone'))
                                    })
                                  }
                                  aria-label={t('chat.fork')}
                                  title={t('chat.forkHint')}
                                >
                                  <GitBranch size={12} />
                                </button>
                                <button
                                  className="icon-btn chat-item-act"
                                  onClick={() => startRename(c)}
                                  aria-label={t('common.rename')}
                                  title={t('common.rename')}
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  className="icon-btn chat-item-act danger"
                                  onClick={() => setConfirmDeleteChat(c)}
                                  aria-label={t('common.delete')}
                                  title={t('common.delete')}
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )
        })}

        {archivedChats.length > 0 && (
          <div className="ws-archived-section">
            <button
              type="button"
              className="ws-archived-toggle"
              onClick={() => setShowArchived((v) => !v)}
              aria-expanded={showArchived}
            >
              <ChevronRight size={12} className={`ws-group-chev${showArchived ? ' open' : ''}`} />
              <Archive size={12} />
              <span>{t('chat.archivedTitle', { count: archivedChats.length })}</span>
            </button>
            {showArchived && (
              <div className="ws-archived-list">
                {archivedChats.map((c) => (
                  <div key={c.id} className="chat-item archived">
                    <button
                      type="button"
                      className="chat-item-open"
                      onClick={() => void openChat(c.id)}
                      title={c.title || t('chat.untitled')}
                    >
                      <Archive size={12} className="chat-item-icon" />
                      <span className="chat-item-title">{c.title || t('chat.untitled')}</span>
                      <span className="chat-item-time">{formatRelTime(c.updatedAt, t)}</span>
                    </button>
                    <div className="chat-item-actions">
                      <button
                        type="button"
                        className="icon-btn chat-item-act"
                        onClick={() => void toggleArchiveChat(c)}
                        title={t('chat.ctxRestoreChat')}
                        aria-label={t('chat.ctxRestoreChat')}
                      >
                        <ArchiveRestore size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn chat-item-act danger"
                        onClick={() => setConfirmDeleteChat(c)}
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      <div className="side-foot">
        {update?.status === 'downloaded' && (
          <button
            type="button"
            className="side-upgrade-btn"
            onClick={() => void installAppUpdate()}
            title={update.version ? t('updates.ready', { version: update.version }) : t('updates.restartToUpgrade')}
          >
            <RotateCw size={14} strokeWidth={2} />
            <span className="side-upgrade-label">
              {update.version
                ? t('updates.restartToUpgradeVersion', { version: update.version })
                : t('updates.restartToUpgrade')}
            </span>
          </button>
        )}
        {update?.status === 'downloading' && (
          <button
            type="button"
            className="side-update-progress"
            onClick={openUpdatePrompt}
            title={t('updates.downloading', { version: update.version ?? '', percent: update.percent ?? 0 })}
          >
            <Download size={14} strokeWidth={1.9} />
            <span>{t('updates.downloadingShort', { percent: update.percent ?? 0 })}</span>
          </button>
        )}
        {update?.status === 'available' &&
          !(update.source !== 'manual' && update.version && settings?.skippedUpdateVersion === update.version) && (
            <button
              type="button"
              className="side-update-progress available"
              onClick={openUpdatePrompt}
              title={t('updates.available', { version: update.version ?? '' })}
            >
              <Sparkles size={14} strokeWidth={1.9} />
              <span>{t('updates.availableShort', { version: update.version ?? '' })}</span>
            </button>
          )}
        <button
          type="button"
          className={`side-item rp-side-account${account.connected ? ' connected' : ''}`}
          onClick={openAccountModal}
          title={
            account.connected
              ? t('account.sideTitleConnected', { email: account.email })
              : t('account.sideTitleDisconnected')
          }
        >
          {account.connected ? (
            <AccountAvatar account={account} size="sm" />
          ) : (
            <UserCircle2 size={17} strokeWidth={1.75} />
          )}
          <span className="rp-side-account-label">
            {account.connected ? (account.displayName || account.email || 'Atrium') : t('account.sideSignInLabel')}
          </span>
          {account.connected && (
            <span className="side-model-pill rp-side-balance">
              {(() => {
                const activeCats = Object.values(account.subscriptions ?? {}).filter((s) => Boolean(s?.active))
                if (activeCats.length === 1) {
                  const only = activeCats[0]!
                  return `${t(`account.categories.${only.category}.shortName`)} ${only.remainingPercent}%`
                }
                if (activeCats.length > 1) {
                  return t('account.sideMultiPlans', { count: activeCats.length })
                }
                if (account.subscription?.active) {
                  return t('account.sideLegacySub', { pct: account.subscription.remainingPercent })
                }
                return account.balanceCny === -1 ? t('account.unlimitedShort') : `¥${Number(account.balanceCny ?? 0).toFixed(2)}`
              })()}
            </span>
          )}
        </button>
        <button data-view="settings" className={`side-item${settingsOpen ? ' active' : ''}`} onClick={() => openSettings('general')}>
          <Settings size={17} strokeWidth={1.75} />
          <span>{t('nav.settings')}</span>
          {activeProvider && (
            <span className="side-model-pill">
              {activeProvider.managedBy === 'relaypulse' && activeProvider.name === 'RelayPulse'
                ? 'Atrium Cloud'
                : activeProvider.name}
            </span>
          )}
        </button>
      </div>
      </div>

      {confirmDeleteChat && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('chat.deleteConfirm')}
          confirmLabel={t('common.delete')}
          onConfirm={() => void confirmDelete()}
          onClose={() => setConfirmDeleteChat(null)}
        />
      )}

      {confirmDeleteGroup && (
        <ConfirmDialog
          title={t('common.delete')}
          message={t('chat.ctxDeleteAllConfirm', {
            name: confirmDeleteGroup.name,
            count: confirmDeleteGroup.chats.length,
          })}
          confirmLabel={t('common.delete')}
          onConfirm={() => void confirmDeleteAllInGroup()}
          onClose={() => setConfirmDeleteGroup(null)}
        />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          entries={ctxMenu.entries}
          ariaLabel={ctxMenu.ariaLabel}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </aside>
  )
}
