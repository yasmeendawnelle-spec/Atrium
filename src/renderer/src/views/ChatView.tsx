import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Globe,
  PanelRight,
  Plug,
  Plus,
  Search,
  Sparkles,
  Store,
  Undo2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  normalizeAgentMode,
  type AgentMode,
  type DiffReviewComment,
  type DocumentAttachment,
  type GitRepoStatus,
  type ImageAttachment,
  type QueuedMessage,
  type WorkspaceChanges,
  type WorkspaceFilePreview,
  type WorkScene,
} from '@shared/types.ts'
import { groupModelsByVendor, type ModelVendorGroup } from '@shared/relaypulse.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { extractConversationArtifacts, extractLiveArtifactsTail, type ParsedArtifact } from '../lib/artifacts.ts'
import { computeContextBreakdown } from '../lib/contextUsage.ts'
import {
  cancelQueuedMessage,
  compactChat,
  forkChat,
  newChat,
  regenerateChat,
  rewindChatTurn,
  sendMessage,
  steerQueuedMessage,
  stopChat,
} from '../lib/chats.ts'
import { formatReviewPrompt } from '../lib/diff.ts'
import { highlightCode } from '../lib/highlight.ts'
import { useAnchoredPopover, useDismissPopover } from '../lib/popover.ts'
import {
  addDiffComment,
  browserSnapshotFor,
  clearDiffComments,
  diffReviewKey,
  draftKey,
  EMPTY_DRAFT,
  getState,
  liveFor,
  navigate,
  openSettings,
  refreshSkills,
  removeDiffComment,
  setBrowserSnapshot,
  setState,
  subscribeStream,
  toast,
  updateDraft,
  useStore,
} from '../lib/store.ts'
import { ApprovalCard } from '../components/ApprovalCard.tsx'
import { Composer, type SlashAction } from '../components/Composer.tsx'
import { Dialog } from '../components/Dialog.tsx'
import { EffortMeter, EffortSlider } from '../components/EffortSlider.tsx'
import { UltracodeChip, UltracodeToggle } from '../components/Ultracode.tsx'
import { MessageList } from '../components/MessageList.tsx'
import { Oculus, type OculusState } from '../components/Oculus.tsx'
import { StudioDrawer, type StudioTab } from '../components/StudioDrawer.tsx'
import { Tile } from '../components/Tile.tsx'
import { splitToolName } from '../components/ToolRow.tsx'
import { TopBar } from '../components/TopBar.tsx'
import { folderName, pickWorkspace, WorkspacePicker } from '../components/WorkspacePicker.tsx'

export { pickWorkspace }

function greetingKey(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const hour = new Date().getHours()
  return hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
}

function langFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    py: 'py', json: 'json', yml: 'yaml', yaml: 'yaml', css: 'css', scss: 'css',
    html: 'html', svg: 'svg', xml: 'xml', sh: 'bash', bash: 'bash', ps1: 'ps1',
    md: 'md', sql: 'sql', rs: 'rust', go: 'go', diff: 'diff',
  }
  return map[ext] ?? ''
}

function ModelPicker({ direction = 'up' }: { direction?: 'up' | 'down' }) {
  const { t } = useTranslation()
  const providers = useStore((s) => s.providers)
  const activeId = useStore((s) => s.settings?.activeProviderId ?? s.providers[0]?.id)
  const chatId = useStore((s) => s.activeChatId)
  const effort = useStore((s) => s.settings?.reasoningEffort ?? 'auto')
  const ultracode = useStore((s) => s.settings?.ultracode === true)
  const active = providers.find((p) => p.id === activeId) ?? providers[0]
  const [open, setOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})
  const [expandedVendors, setExpandedVendors] = useState<Record<string, boolean>>({})
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useDismissPopover(wrapRef, open, () => {
    setOpen(false)
    setModelQuery('')
    setExpandedProviders({})
    setExpandedVendors({})
  })
  const popStyle = useAnchoredPopover(wrapRef, popRef, open, {
    width: 620,
    direction,
    align: 'right',
    minHeight: 280,
    maxHeight: 520,
  })

  if (!active) return null

  const totalModels = providers.reduce((acc, p) => acc + Math.max(1, p.models?.length ?? 0), 0)
  const q = modelQuery.trim().toLowerCase()
  const providerGroups: Array<{
    key: string
    provider: (typeof providers)[number]
    label: string
    vendorGroups: ModelVendorGroup[]
    totalCount: number
  }> = []

  for (const p of providers) {
    const providerLabel = p.managedBy === 'relaypulse' && p.name === 'RelayPulse' ? 'Atrium Cloud' : p.name
    const baseList = (p.models?.length ? p.models : [p.model]).filter(Boolean)
    const rawVendors = groupModelsByVendor(baseList)
    const filteredVendors: ModelVendorGroup[] = []

    for (const vg of rawVendors) {
      const models = vg.models.filter(
        (m) =>
          !q ||
          m.toLowerCase().includes(q) ||
          vg.label.toLowerCase().includes(q) ||
          providerLabel.toLowerCase().includes(q),
      )
      if (models.length > 0) {
        filteredVendors.push({ ...vg, models })
      }
    }

    const totalCount = filteredVendors.reduce((sum, vg) => sum + vg.models.length, 0)
    if (totalCount > 0) {
      providerGroups.push({
        key: p.id,
        provider: p,
        label: providerLabel,
        vendorGroups: filteredVendors,
        totalCount,
      })
    }
  }

  let optionIdx = 0

  return (
    <div className={`model-picker${open ? ' open' : ''} dir-${direction}`} ref={wrapRef}>
      <button
        type="button"
        className={`model-pick${open ? ' open' : ''}`}
        onClick={() =>
          setOpen((v) => {
            if (v) {
              setExpandedProviders({})
              setExpandedVendors({})
            } else {
              const nextProviders: Record<string, boolean> = {}
              const nextVendors: Record<string, boolean> = {}
              if (active) {
                nextProviders[active.id] = true
                const activeList = (active.models?.length ? active.models : [active.model]).filter(Boolean)
                const activeGroup = groupModelsByVendor(activeList).find((vg) => vg.models.includes(active.model))
                if (activeGroup) nextVendors[`${active.id}::${activeGroup.id}`] = true
              }
              setExpandedProviders(nextProviders)
              setExpandedVendors(nextVendors)
            }
            return !v
          })
        }
        aria-expanded={open}
        aria-haspopup="listbox"
        title={`${active.name} · ${active.model}`}
      >
        <span className="model-pick-dot" aria-hidden />
        <span className="model-pick-name">{active.model}</span>
        {effort !== 'auto' && (
          <span className="model-pick-effort" data-level={effort}>
            <EffortMeter level={effort} size="sm" />
            {t(`chat.effortLevels.${effort}`)}
          </span>
        )}
        <ChevronDown size={13} className="model-pick-chev" />
      </button>
      <div ref={popRef} style={popStyle} className="model-popover" role="listbox" aria-label={t('chat.model')}>
        <div className="model-popover-body">
          <div className="model-popover-models">
            <div className="model-popover-head">
              <span>{t('chat.switchModel')}</span>
              <span className="model-popover-total">{totalModels}</span>
            </div>
            {totalModels > 5 && (
              <div className="model-popover-search">
                <Search size={13} />
                <input
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder={t('chat.searchModels')}
                  aria-label={t('chat.searchModels')}
                />
              </div>
            )}
            <div className="model-popover-list">
          {providerGroups.map((pg) => {
            const { provider: p, vendorGroups, totalCount } = pg
            const hasActiveProvider = p.id === active.id
            const providerOpen = Boolean(q) || Boolean(expandedProviders[pg.key])
            const autoOpenSoleVendor = vendorGroups.length === 1 && p.managedBy !== 'relaypulse'
            return (
              <div key={pg.key} className="model-popover-group">
                <button
                  type="button"
                  className={`model-group-head model-group-toggle${providerOpen ? ' open' : ''}${hasActiveProvider ? ' has-active' : ''}`}
                  aria-expanded={providerOpen}
                  onClick={() =>
                    setExpandedProviders((prev) => ({
                      ...prev,
                      [pg.key]: !prev[pg.key],
                    }))
                  }
                >
                  <span className="model-group-label">
                    <ChevronRight size={13} className={`chev${providerOpen ? ' open' : ''}`} />
                    <Tile name={pg.label} />
                    <span>{pg.label}</span>
                  </span>
                  <span className="model-group-right">
                    {!providerOpen && hasActiveProvider && <span className="model-group-active">{active.model}</span>}
                    <span className="model-group-count">{totalCount}</span>
                  </span>
                </button>
                {providerOpen && (
                  <div className="model-subgroups">
                    {vendorGroups.map((vg) => {
                      const subKey = `${p.id}::${vg.id}`
                      const vendorOpen = Boolean(q) || (expandedVendors[subKey] ?? autoOpenSoleVendor)
                      const hasActiveVendor = hasActiveProvider && vg.models.includes(active.model)
                      return (
                        <div key={subKey} className="model-subgroup">
                          <button
                            type="button"
                            className={`model-subgroup-toggle${vendorOpen ? ' open' : ''}${hasActiveVendor ? ' has-active' : ''}`}
                            aria-expanded={vendorOpen}
                            onClick={() =>
                              setExpandedVendors((prev) => ({
                                ...prev,
                                [subKey]: !(prev[subKey] ?? autoOpenSoleVendor),
                              }))
                            }
                          >
                            <span className="model-group-label">
                              <ChevronRight size={12} className={`chev${vendorOpen ? ' open' : ''}`} />
                              <Tile name={vg.tileName} />
                              <span>{vg.label}</span>
                            </span>
                            <span className="model-group-right">
                              {!vendorOpen && hasActiveVendor && <span className="model-group-active">{active.model}</span>}
                              <span className="model-group-count">{vg.models.length}</span>
                            </span>
                          </button>
                          {vendorOpen && (
                            <div className="model-subgroup-items">
                              {vg.models.map((modelId) => {
                                const isCurrent = p.id === active.id && modelId === active.model
                                const idx = optionIdx++
                                return (
                                  <button
                                    key={`${p.id}:${modelId}`}
                                    type="button"
                                    role="option"
                                    aria-selected={isCurrent}
                                    style={{ transitionDelay: open ? `${Math.min(idx, 10) * 10}ms` : '0ms' }}
                                    className={`model-option compact${isCurrent ? ' active' : ''}`}
                                    onClick={async () => {
                                      setOpen(false)
                                      setModelQuery('')
                                      setExpandedProviders({})
                                      setExpandedVendors({})
                                      const next = await call('providers.selectModel', p.id, modelId)
                                      setState(next)
                                      if (chatId) void call('chats.setProvider', chatId, p.id).catch(() => undefined)
                                    }}
                                  >
                                    <span className="model-option-dot" aria-hidden />
                                    <span className="model-option-main">
                                      <span className="model-option-title">{modelId}</span>
                                    </span>
                                    <span className="model-option-check" aria-hidden>
                                      {isCurrent && <Check size={14} />}
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          {providerGroups.length === 0 && <div className="model-popover-empty">{t('chat.noMatchingModels')}</div>}
            </div>
          </div>
          <div className="model-effort-section">
            <EffortSlider
              compact
              title={t('chat.effort')}
              value={effort}
              onChange={async (level) => {
                setState({ settings: await call('settings.update', { reasoningEffort: level }) })
              }}
            />
            <UltracodeToggle
              checked={ultracode}
              onChange={async (next) => {
                setState({ settings: await call('settings.update', { ultracode: next }) })
              }}
            />
          </div>
        </div>
        <div className="model-popover-foot">
          <button
            type="button"
            className="model-popover-manage"
            onClick={() => {
              setOpen(false)
              openSettings('models')
            }}
          >
            <Plus size={13} />
            <span>{t('chat.manageModels')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

const EMPTY_QUEUE: QueuedMessage[] = []
const EMPTY_REVIEW: DiffReviewComment[] = []

export function ChatView() {
  const { t } = useTranslation()
  const chatId = useStore((s) => s.activeChatId)
  const conversation = useStore((s) => (chatId ? s.conversations[chatId] : undefined))
  const live = useStore((s) => liveFor(s, chatId))
  const queued = useStore((s) => (chatId ? s.queued[chatId] ?? EMPTY_QUEUE : EMPTY_QUEUE))
  const draft = useStore((s) => s.drafts[draftKey(chatId)] ?? EMPTY_DRAFT)
  const providers = useStore((s) => s.providers)
  const activeProviderId = useStore((s) => s.settings?.activeProviderId ?? s.providers[0]?.id)
  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? providers[0]
  const hasProvider = providers.length > 0
  const globalWorkspace = useStore((s) => s.settings?.workspace)
  const workspace = conversation?.workspace ?? globalWorkspace
  const workspaceName = folderName(workspace)
  const reviewKey = diffReviewKey(chatId, workspace)
  const reviewComments = useStore((s) => s.diffComments[reviewKey] ?? EMPTY_REVIEW)
  const sessionAllows = useStore((s) => s.sessionAllows)
  const skills = useStore((s) => s.skills)
  const statuses = useStore((s) => s.statuses)
  const agentMode = useStore((s) => normalizeAgentMode(s.settings?.agentMode, 'auto'))
  const lastExecMode = useStore((s) => s.settings?.lastExecMode ?? 'auto')
  const workScene: WorkScene = useStore((s) => (s.settings?.workScene === 'work' ? 'work' : 'code'))
  const allowBypass = useStore((s) => s.settings?.allowBypassPermissions !== false)
  const autoCompact = useStore((s) => s.settings?.autoCompact !== false)
  const contextWindowTokens = useStore((s) => s.settings?.contextWindowTokens)
  const ultracodeOn = useStore((s) => s.settings?.ultracode === true)
  const changesRevision = useStore((s) => s.changesRevision)
  const terminalSessions = useStore((s) => s.terminalSessions)
  const terminalRequestedOpen = useStore((s) => s.terminalRequestedOpen)
  const browserRequestedOpen = useStore((s) => s.browserRequestedOpen)
  const browserOpen = useStore((s) => Boolean(browserSnapshotFor(s, chatId)?.open))
  const newChatUseWorktree = useStore((s) => s.newChatUseWorktree)
  const title = useStore((s) => s.chats.find((c) => c.id === chatId)?.title)

  const scroller = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const lastTermReqRef = useRef(terminalRequestedOpen)
  const lastBrowserReqRef = useRef(browserRequestedOpen)
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioTab, setStudioTab] = useState<StudioTab>('files')
  const [selectedArtifactUid, setSelectedArtifactUid] = useState<string | null>(null)
  const [drawerFiles, setDrawerFiles] = useState<string[]>([])
  const [workspaceGit, setWorkspaceGit] = useState<GitRepoStatus | null>(null)
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [chatSearch, setChatSearch] = useState('')
  const [searchCursor, setSearchCursor] = useState(0)
  const [rewindTarget, setRewindTarget] = useState<number | null>(null)
  const [rewindRevertFiles, setRewindRevertFiles] = useState(true)
  const [compacting, setCompacting] = useState(false)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [streamingArtifacts, setStreamingArtifacts] = useState<ParsedArtifact[]>([])
  const seenArtCount = useRef<Record<string, number>>({})
  const userClosedStudio = useRef<Record<string, boolean>>({})

  const savedArtifacts = useMemo(
    () => extractConversationArtifacts(conversation?.messages ?? []),
    [conversation?.messages],
  )
  const savedMessagesLen = conversation?.messages.length ?? 0

  useEffect(() => {
    setStreamingArtifacts([])
    if (!chatId) return
    let lastCheck = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const evaluate = (text: string) => {
      const maybeArtifact =
        Boolean(text) &&
        (text.includes('<artifact') ||
          text.includes('<antArtifact') ||
          /```(?:mermaid|svg|html|htm|tsx|jsx)\b/i.test(text))
      if (!maybeArtifact) {
        setStreamingArtifacts((prev) => (prev.length ? [] : prev))
        return
      }
      setStreamingArtifacts(extractLiveArtifactsTail(savedArtifacts, savedMessagesLen, text))
    }
    const unsub = subscribeStream(chatId, (stream) => {
      if (!stream.text) {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        setStreamingArtifacts((prev) => (prev.length ? [] : prev))
        return
      }
      const now = Date.now()
      const wait = Math.max(0, 150 - (now - lastCheck))
      if (wait === 0) {
        lastCheck = now
        evaluate(stream.text)
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null
          lastCheck = Date.now()
          const cur = getState().streams[chatId]
          if (cur) evaluate(cur.text)
        }, wait)
      }
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [chatId, savedArtifacts, savedMessagesLen])

  const artifacts = useMemo(
    () => (streamingArtifacts.length ? [...savedArtifacts, ...streamingArtifacts] : savedArtifacts),
    [savedArtifacts, streamingArtifacts],
  )

  useEffect(() => {
    setSelectedArtifactUid(null)
    if (!chatId) return
    // Record baseline count on first open so old history doesn't auto-pop unexpectedly unless clicked.
    if (seenArtCount.current[chatId] === undefined) {
      seenArtCount.current[chatId] = artifacts.length
    }
  }, [chatId])

  useEffect(() => {
    if (!chatId) return
    const prev = seenArtCount.current[chatId] ?? 0
    if (artifacts.length > prev) {
      seenArtCount.current[chatId] = artifacts.length
      const newest = artifacts[artifacts.length - 1]
      if (newest) {
        setSelectedArtifactUid(newest.uid)
        if (!userClosedStudio.current[chatId]) {
          setStudioTab('artifacts')
          setStudioOpen(true)
        }
      }
    }
  }, [chatId, artifacts])

  const loadFiles = () => {
    if (!workspace) {
      setDrawerFiles([])
      return
    }
    void call('workspace.files', workspace).then(setDrawerFiles).catch(() => undefined)
  }

  const loadChanges = () => {
    if (!workspace) {
      setChanges(null)
      return
    }
    setChangesLoading(true)
    void call('workspace.changes', chatId ?? undefined, workspace)
      .then((res) => setChanges(res))
      .catch(() => setChanges(null))
      .finally(() => setChangesLoading(false))
  }

  useEffect(() => {
    if (!studioOpen || !workspace) return
    loadFiles()
  }, [studioOpen, studioTab, workspace])

  useEffect(() => {
    loadChanges()
  }, [workspace, chatId, changesRevision, studioOpen])

  useEffect(() => {
    void refreshSkills(workspace)
  }, [workspace])

  useEffect(() => {
    if (!workspace) {
      setWorkspaceGit(null)
      return
    }
    let alive = true
    void call('workspace.gitInfo', workspace)
      .then((info) => {
        if (!alive) return
        setWorkspaceGit(info)
        if (!info.isRepo && getState().newChatUseWorktree) {
          setState({ newChatUseWorktree: false })
        }
      })
      .catch(() => {
        if (alive) setWorkspaceGit(null)
      })
    return () => {
      alive = false
    }
  }, [workspace, changesRevision])

  useEffect(() => {
    if (browserRequestedOpen === lastBrowserReqRef.current) return
    lastBrowserReqRef.current = browserRequestedOpen
    setStudioTab('browser')
    setStudioOpen(true)
    if (chatId) userClosedStudio.current[chatId] = false
  }, [browserRequestedOpen, chatId])

  useEffect(() => {
    if (terminalRequestedOpen === lastTermReqRef.current) return
    lastTermReqRef.current = terminalRequestedOpen
    if (studioOpen && studioTab === 'terminal') {
      setStudioOpen(false)
      if (chatId) userClosedStudio.current[chatId] = true
    } else {
      setStudioTab('terminal')
      setStudioOpen(true)
      if (chatId) userClosedStudio.current[chatId] = false
    }
  }, [terminalRequestedOpen, studioOpen, studioTab, chatId])

  const toggleAttached = (file: string) =>
    updateDraft(chatId, (cur) => ({
      ...cur,
      files: cur.files.includes(file) ? cur.files.filter((f) => f !== file) : [...cur.files, file],
    }))

  const openPreview = async (file: string) => {
    try {
      const res = await call('workspace.readPreview', file, workspace)
      setPreview(res)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleCompact = async () => {
    if (!chatId || compacting || live.busy) return
    setCompacting(true)
    toast(t('chat.compacting'))
    try {
      await compactChat(chatId)
      toast(t('chat.compactDone'))
    } finally {
      setCompacting(false)
    }
  }

  const setAgentMode = async (nextMode: AgentMode) => {
    const patch = nextMode !== 'plan' ? { agentMode: nextMode, lastExecMode: nextMode } : { agentMode: nextMode }
    const updated = await call('settings.update', patch)
    setState({ settings: updated })
  }
  const togglePlanMode = () => void setAgentMode(agentMode === 'plan' ? lastExecMode : 'plan')

  const handleApprovePlan = async () => {
    if (!chatId || live.busy) return
    await setAgentMode(lastExecMode)
    void sendMessage(t('mode.approvePrompt'))
  }

  const handleSlash = async (action: SlashAction) => {
    if (action === 'plan') {
      togglePlanMode()
      return
    }
    if (action === 'auto' || action === 'manual' || action === 'bypass') {
      if (action === 'bypass' && !allowBypass) {
        toast(t('settings.bypassDisabledToast'), 'error')
        return
      }
      await setAgentMode(action)
      toast(t('mode.switched', { mode: t(`mode.modes.${action}.label`) }))
      return
    }
    if (action === 'compact') {
      await handleCompact()
    } else if (action === 'browser') {
      setStudioTab('browser')
      setStudioOpen(true)
      if (chatId) userClosedStudio.current[chatId] = false
    } else if (action === 'remember') {
      setState({ knowledgeTab: 'memory' })
      navigate({ view: 'knowledge', chatId })
    } else if (action === 'new') {
      await newChat()
    } else if (action === 'revoke') {
      await call('agent.revokeAllows', workspace).catch(() => undefined)
      setState({ sessionAllows: [] })
      toast(t('chat.trustRevoked'))
    }
  }

  const confirmRewind = async () => {
    const idx = rewindTarget
    setRewindTarget(null)
    if (!chatId || idx === null) return
    const ok = await rewindChatTurn(chatId, idx, rewindRevertFiles)
    if (ok) {
      loadFiles()
      loadChanges()
      toast(t('chat.rewindDone'))
    }
  }

  const runningTool = Object.values(live.tools).some((x) => x.status === 'running')
  const oculus: OculusState = live.approvals.length
    ? 'approval'
    : live.busy || compacting
      ? runningTool && !live.hasText
        ? 'tool'
        : 'thinking'
      : live.error
        ? 'error'
        : 'idle'

  const activeToolCall = conversation?.messages
    .slice()
    .reverse()
    .flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []))
    .find((c) => live.tools[c.id]?.status === 'running')
  const isAutoCompacting = Boolean(live.compacting?.active)
  const thinkingLabel = compacting
    ? t('chat.compacting')
    : isAutoCompacting
      ? t('chat.autoCompacting')
      : activeToolCall
        ? t('chat.thinkingTool', { tool: splitToolName(activeToolCall.name).tool })
        : live.hasReasoning && !live.hasText
          ? t('chat.thinkingDeep')
          : live.hasText
            ? t('chat.thinkingWrite')
            : t('chat.thinking')

  useEffect(() => {
    const scrollIfNearBottom = () => {
      const el = scroller.current
      if (!el) return
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 180
      if (nearBottom) {
        el.scrollTop = el.scrollHeight
        setShowScrollBottom(false)
      }
    }
    scrollIfNearBottom()
    if (!chatId) return
    return subscribeStream(chatId, scrollIfNearBottom)
  }, [chatId, conversation?.messages.length, live.approvals.length])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBottom(dist > 200)
  }

  const scrollToBottom = () => {
    const el = scroller.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const empty = !conversation || conversation.messages.length === 0
  const hasConversationContent = Boolean(conversation && (conversation.messages.length > 0 || live.busy))
  const workspaceLocked = Boolean(
    chatId && (hasConversationContent || Boolean(conversation?.workspace) || Boolean(conversation?.worktreeBranch)),
  )
  const canUseWorktree = Boolean(!chatId && workspace && workspaceGit?.isRepo)
  const worktreeChecked = Boolean(canUseWorktree && newChatUseWorktree)
  const canCompact = Boolean(chatId && conversation && conversation.messages.length >= 4 && !live.busy && !compacting)
  const mcpToolCount = useMemo(
    () => Object.values(statuses).reduce((sum, st) => sum + (st?.tools?.length ?? 0), 0),
    [statuses],
  )
  const enabledSkillCount = useMemo(() => skills.filter((s) => s.enabled).length, [skills])
  const contextInfo = useMemo(
    () =>
      computeContextBreakdown({
        conversation,
        model: activeProvider?.model,
        hasWorkspace: Boolean(workspace),
        mcpToolCount,
        skillCount: enabledSkillCount,
        autoCompact,
        contextWindowTokens,
      }),
    [conversation, activeProvider?.model, workspace, mcpToolCount, enabledSkillCount, autoCompact, contextWindowTokens],
  )

  const searchMatches = useMemo(() => {
    const q = chatSearch.trim().toLowerCase()
    if (!q || !conversation) return []
    const hits: number[] = []
    conversation.messages.forEach((m, i) => {
      if ((m.role === 'user' && !m.isSummary) || m.role === 'assistant') {
        if (m.text.toLowerCase().includes(q)) hits.push(i)
      }
    })
    return hits
  }, [chatSearch, conversation])

  const activeSearchMatchIdx = searchMatches.length > 0 ? searchMatches[searchCursor % searchMatches.length]! : null

  useEffect(() => {
    setSearchOpen(false)
    setChatSearch('')
    setSearchCursor(0)
  }, [chatId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && conversation && conversation.messages.length > 0) {
        e.preventDefault()
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [conversation])

  useEffect(() => {
    if (!searchOpen || activeSearchMatchIdx === null) return
    const targetEl = scroller.current?.querySelector<HTMLElement>(`[data-msg-idx="${activeSearchMatchIdx}"]`)
    targetEl?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [searchOpen, activeSearchMatchIdx])

  const notice = !hasProvider && (
    <div className="banner">
      <span>{t('chat.noProvider')}</span>
      <button className="btn btn-small btn-primary" onClick={() => openSettings('models')}>
        {t('chat.setUpModel')}
      </button>
    </div>
  )

  const handleEditQueued = (item: QueuedMessage) => {
    if (!chatId) return
    void cancelQueuedMessage(chatId, item.id)
    updateDraft(chatId, (cur) => ({
      text: cur.text ? `${cur.text}\n${item.text}` : item.text,
      files: cur.files,
      images: [...cur.images, ...(item.images ?? [])].slice(0, 6),
      externalFiles: [
        ...cur.externalFiles,
        ...(item.documents ?? []).map((doc) => ({
          id: doc.id,
          name: doc.name,
          path: doc.path ?? doc.name,
          docKind: doc.docKind,
          content: doc.content,
          truncated: doc.truncated,
          byteSize: doc.byteSize,
          pageCount: doc.pageCount,
          sheetCount: doc.sheetCount,
          slideCount: doc.slideCount,
          sheetNames: doc.sheetNames,
        })),
      ].slice(0, 6),
    }))
  }

  const makeComposer = (direction: 'up' | 'down') => (
    <Composer
      busy={live.busy}
      disabled={!hasProvider || compacting}
      compact={hasConversationContent}
      workspace={workspace}
      direction={direction}
      value={draft.text}
      images={draft.images}
      attachedFiles={draft.files}
      externalFiles={draft.externalFiles}
      queued={queued}
      skills={skills}
      agentMode={agentMode}
      workScene={workScene}
      canCompact={canCompact}
      hasSessionAllows={sessionAllows.length > 0}
      contextInfo={contextInfo}
      onChangeText={(text) => updateDraft(chatId, (cur) => ({ ...cur, text }))}
      onAddImages={(added: ImageAttachment[]) => updateDraft(chatId, (cur) => ({ ...cur, images: [...cur.images, ...added].slice(0, 6) }))}
      onRemoveImage={(id) => updateDraft(chatId, (cur) => ({ ...cur, images: cur.images.filter((img) => img.id !== id) }))}
      onAddFiles={(added) =>
        updateDraft(chatId, (cur) => ({
          ...cur,
          files: Array.from(new Set([...cur.files, ...added])),
        }))
      }
      onRemoveFile={(file) => updateDraft(chatId, (cur) => ({ ...cur, files: cur.files.filter((f) => f !== file) }))}
      onAddExternalFiles={(added) =>
        updateDraft(chatId, (cur) => ({
          ...cur,
          externalFiles: [
            ...cur.externalFiles,
            ...added.filter((a) => !cur.externalFiles.some((b) => b.path === a.path)),
          ].slice(0, 6),
        }))
      }
      onRemoveExternalFile={(id) =>
        updateDraft(chatId, (cur) => ({
          ...cur,
          externalFiles: cur.externalFiles.filter((doc) => doc.id !== id),
        }))
      }
      onCancelQueued={chatId ? (qid) => void cancelQueuedMessage(chatId, qid) : undefined}
      onSteerQueued={chatId ? (qid) => void steerQueuedMessage(chatId, qid) : undefined}
      onEditQueued={chatId ? handleEditQueued : undefined}
      onAddFolder={!workspaceLocked ? () => void pickWorkspace() : undefined}
      onSelectMode={(next) => void setAgentMode(next)}
      onTogglePlan={togglePlanMode}
      onCompact={canCompact ? () => void handleCompact() : undefined}
      leading={
        !workspaceLocked ? (
          <>
            <WorkspacePicker
              variant="chip"
              direction={direction}
              onOpenFiles={() => {
                setStudioTab('files')
                setStudioOpen(true)
              }}
            />
            {!chatId && workspace && (
              <button
                type="button"
                role="checkbox"
                aria-checked={worktreeChecked}
                disabled={!canUseWorktree}
                className={`worktree-toggle${worktreeChecked ? ' checked' : ''}`}
                onClick={() => canUseWorktree && setState({ newChatUseWorktree: !newChatUseWorktree })}
                title={!canUseWorktree ? t('chat.worktreeRequiresGit') : t('chat.worktreeToggleHint')}
              >
                <span className="worktree-check" aria-hidden="true">
                  {worktreeChecked && <Check size={10} strokeWidth={3} />}
                </span>
                <GitBranch size={12} />
                <span>{t('chat.worktreeToggle')}</span>
              </button>
            )}
          </>
        ) : undefined
      }
      trailing={
        <>
          {ultracodeOn && (
            <UltracodeChip
              onDisable={async () => {
                setState({ settings: await call('settings.update', { ultracode: false }) })
              }}
            />
          )}
          <ModelPicker direction={direction} />
        </>
      }
      onSend={(text, images, documents: DocumentAttachment[]) => {
        updateDraft(chatId, () => EMPTY_DRAFT)
        void sendMessage(text, images, documents)
      }}
      onSlashCommand={(action) => void handleSlash(action)}
      onStop={() => chatId && void stopChat(chatId)}
    />
  )

  const openArtifactCanvas = (uid: string) => {
    setSelectedArtifactUid(uid)
    setStudioTab('artifacts')
    setStudioOpen(true)
    if (chatId) userClosedStudio.current[chatId] = false
  }

  const closeStudio = () => {
    setStudioOpen(false)
    if (chatId) userClosedStudio.current[chatId] = true
  }

  const toggleStudio = (preferredTab?: StudioTab) => {
    if (studioOpen && (!preferredTab || preferredTab === studioTab)) {
      closeStudio()
      return
    }
    const nextTab = preferredTab ?? (artifacts.length > 0 ? 'artifacts' : workspace ? 'files' : 'artifacts')
    setStudioTab(nextTab)
    setStudioOpen(true)
    if (chatId) userClosedStudio.current[chatId] = false
  }

  const revertSingle = async (relPath: string) => {
    if (!chatId) return
    try {
      const updated = await call('workspace.revertChange', chatId, relPath, workspace)
      setChanges(updated)
      loadFiles()
      toast(t('studio.revertedFile', { path: relPath }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const revertAll = async () => {
    if (!chatId) return
    try {
      const updated = await call('workspace.revertAllChanges', chatId, workspace)
      setChanges(updated)
      loadFiles()
      toast(t('studio.revertedAll'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleGitCommit = async (message: string): Promise<boolean> => {
    if (!workspace) return false
    try {
      const res = await call('workspace.gitCommit', workspace, message)
      toast(t('studio.gitCommitted', { hash: res.commitHash, summary: res.summary }))
      loadFiles()
      loadChanges()
      return true
    } catch (err) {
      toast(errorMessage(err), 'error')
      return false
    }
  }

  const handleSuggestCommit = async (): Promise<string> => {
    try {
      return await call('workspace.suggestCommitMessage', workspace, chatId ?? undefined)
    } catch (err) {
      toast(errorMessage(err), 'error')
      return ''
    }
  }

  const handleStageGitFiles = async (paths: string[], staged: boolean): Promise<void> => {
    if (!workspace) return
    try {
      const next = await call('workspace.gitStage', workspace, paths, staged)
      setChanges(next)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleCheckoutBranch = async (branch: string, createNew = false): Promise<boolean> => {
    if (!workspace) return false
    try {
      const status = await call('workspace.gitCheckout', workspace, branch, createNew)
      toast(t('studio.gitSwitchedBranch', { branch: status.branch || branch }))
      setState((s) => ({ changesRevision: s.changesRevision + 1 }))
      loadFiles()
      loadChanges()
      return true
    } catch (err) {
      toast(errorMessage(err), 'error')
      return false
    }
  }

  const handlePushGit = async (): Promise<boolean> => {
    if (!workspace) return false
    try {
      const res = await call('workspace.gitPush', workspace)
      toast(t('studio.gitPushed', { branch: res.branch, remote: res.remote }))
      loadChanges()
      return true
    } catch (err) {
      toast(errorMessage(err), 'error')
      return false
    }
  }

  const handleCreatePr = async (): Promise<void> => {
    if (!workspace) return
    try {
      const res = await call('workspace.gitPrUrl', workspace, title)
      try {
        const snap = await call('browser.open', res.url, chatId ?? undefined)
        setBrowserSnapshot(snap, chatId)
        setStudioTab('browser')
        setStudioOpen(true)
      } catch {
        await shell.openExternal(res.url)
      }
      loadChanges()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleEditUser = async (messageIndex: number, nextText: string): Promise<void> => {
    if (!chatId || live.busy || !conversation) return
    const target = conversation.messages[messageIndex]
    const imgs = target?.role === 'user' ? target.images : undefined
    const docs = target?.role === 'user' ? target.documents : undefined
    const ok = await rewindChatTurn(chatId, messageIndex, false)
    if (!ok) return
    updateDraft(chatId, (cur) => ({ ...cur, text: '' }))
    await sendMessage(nextText, imgs, docs)
  }

  const handleMergeWorktree = async (opts: { commitMessage?: string; cleanupWorktree: boolean }): Promise<boolean> => {
    if (!chatId) return false
    try {
      const res = await call('workspace.gitMergeWorktree', chatId, opts)
      if (res.cleanedUp) {
        const settings = await call('settings.update', { workspace: res.baseWorkspace }).catch(() => null)
        if (settings) setState({ settings })
      }
      toast(t('studio.mergeWorktreeDone', { branch: res.branch, baseBranch: res.baseBranch ?? 'main' }))
      setState((s) => ({ changesRevision: s.changesRevision + 1 }))
      loadFiles()
      loadChanges()
      return true
    } catch (err) {
      toast(errorMessage(err), 'error')
      return false
    }
  }

  const handleSubmitReviewComments = () => {
    if (reviewComments.length === 0) return
    const prompt = formatReviewPrompt(t('studio.reviewPromptHeader'), reviewComments)
    const count = reviewComments.length
    clearDiffComments(reviewKey)
    void sendMessage(prompt)
    toast(t('studio.reviewSentToast', { count }))
  }

  const changeCount = changes?.items.length ?? 0
  const runningTerminals = terminalSessions.filter((s) => s.status === 'running').length
  const studioBadge = artifacts.length + changeCount + runningTerminals + (browserOpen ? 1 : 0)

  const studioBtn =
    workspace || artifacts.length > 0 || terminalSessions.length > 0 || browserOpen ? (
      <button
        type="button"
        className={`topbar-btn${studioOpen ? ' active' : ''}`}
        onClick={() => toggleStudio()}
        aria-expanded={studioOpen}
        title={t('studio.title')}
      >
        <PanelRight size={14} />
        <span>{t('studio.title')}</span>
        {studioBadge > 0 && <span className="topbar-badge">{studioBadge}</span>}
      </button>
    ) : null

  const previewModal = preview && (
    <Dialog title={preview.path} onClose={() => setPreview(null)} wide>
      <div className="preview-modal">
        {preview.truncated && <p className="preview-note">{t('chat.previewTruncated')}</p>}
        <pre className="preview-code">
          <code>{highlightCode(preview.content, langFromPath(preview.path))}</code>
        </pre>
        <div className="dialog-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (!draft.files.includes(preview.path)) toggleAttached(preview.path)
              setPreview(null)
            }}
          >
            <Plus size={14} />
            <span>{draft.files.includes(preview.path) ? t('common.copied') : t('chat.attachFile')}</span>
          </button>
        </div>
      </div>
    </Dialog>
  )

  const studioDrawer = (
    <StudioDrawer
      key="studio-drawer"
      open={studioOpen}
      chatId={chatId}
      tab={studioTab}
      onTabChange={setStudioTab}
      onClose={closeStudio}
      workspace={workspace}
      artifacts={artifacts}
      selectedArtifactUid={selectedArtifactUid}
      onSelectArtifact={setSelectedArtifactUid}
      changes={changes}
      changesLoading={changesLoading}
      onRefreshChanges={loadChanges}
      onRevertChange={(path) => void revertSingle(path)}
      onRevertAllChanges={() => void revertAll()}
      reviewComments={reviewComments}
      onAddReviewComment={(comment) => addDiffComment(reviewKey, comment)}
      onRemoveReviewComment={(id) => removeDiffComment(reviewKey, id)}
      onClearReviewComments={() => clearDiffComments(reviewKey)}
      onSubmitReviewComments={handleSubmitReviewComments}
      onGitCommit={handleGitCommit}
      onStageGitFiles={handleStageGitFiles}
      onCheckoutBranch={handleCheckoutBranch}
      onPushGit={handlePushGit}
      onCreatePr={handleCreatePr}
      onSuggestCommitMessage={handleSuggestCommit}
      onMergeWorktree={handleMergeWorktree}
      files={drawerFiles}
      draftFiles={draft.files}
      onToggleDraftFile={toggleAttached}
      onPreviewFile={openPreview}
      onRefreshFiles={loadFiles}
      onArtifactSaved={() => {
        loadFiles()
        loadChanges()
      }}
      onSendTerminalOutput={(snippet) =>
        updateDraft(chatId, (cur) => ({
          ...cur,
          text: cur.text.trim() ? `${cur.text}\n\n${snippet}` : snippet,
        }))
      }
      onAttachBrowserScreenshot={(image) =>
        updateDraft(chatId, (cur) => ({
          ...cur,
          images: [...cur.images, image].slice(0, 6),
        }))
      }
    />
  )

  const rewindModal = rewindTarget !== null && (
    <Dialog title={t('chat.rewindTitle')} onClose={() => setRewindTarget(null)}>
      <p className="confirm-msg">{t('chat.rewindConfirm')}</p>
      {workspace && (
        <label className="rewind-check">
          <input
            type="checkbox"
            checked={rewindRevertFiles}
            onChange={(e) => setRewindRevertFiles(e.target.checked)}
          />
          <span>{t('chat.rewindRevertFiles')}</span>
        </label>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => setRewindTarget(null)}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void confirmRewind()}>
          <Undo2 size={14} />
          <span>{t('chat.rewindAction')}</span>
        </button>
      </div>
    </Dialog>
  )

  if (empty) {
    const starters =
      workScene === 'work'
        ? [
            {
              key: 'research',
              icon: Globe,
              tone: 'tile-tone-0',
              title: t('chat.workStarters.researchTitle'),
              desc: t('chat.workStarters.researchDesc'),
              action: () => (hasProvider ? void sendMessage(t('chat.workStarters.researchPrompt')) : openSettings('models')),
            },
            {
              key: 'brief',
              icon: FileText,
              tone: 'tile-tone-1',
              title: t('chat.workStarters.briefTitle'),
              desc: t('chat.workStarters.briefDesc'),
              action: () => (hasProvider ? void sendMessage(t('chat.workStarters.briefPrompt')) : openSettings('models')),
            },
            {
              key: 'visual',
              icon: Sparkles,
              tone: 'tile-tone-2',
              title: t('chat.workStarters.visualTitle'),
              desc: t('chat.workStarters.visualDesc'),
              action: () => (hasProvider ? void sendMessage(t('chat.workStarters.visualPrompt')) : openSettings('models')),
            },
            {
              key: 'organize',
              icon: FolderSearch,
              tone: 'tile-tone-3',
              title: t('chat.workStarters.organizeTitle'),
              desc: t('chat.workStarters.organizeDesc'),
              action: () => (hasProvider && workspace ? void sendMessage(t('chat.workStarters.organizePrompt')) : void pickWorkspace()),
            },
          ]
        : [
            {
              key: 'explore',
              icon: FolderSearch,
              tone: 'tile-tone-0',
              title: t('chat.starters.exploreTitle'),
              desc: t('chat.starters.exploreDesc'),
              action: () => (hasProvider ? void sendMessage(t('chat.starters.explorePrompt')) : void pickWorkspace()),
            },
            {
              key: 'draft',
              icon: FileText,
              tone: 'tile-tone-1',
              title: t('chat.starters.draftTitle'),
              desc: t('chat.starters.draftDesc'),
              action: () => (hasProvider ? void sendMessage(t('chat.starters.draftPrompt')) : openSettings('models')),
            },
            {
              key: 'connect',
              icon: Plug,
              tone: 'tile-tone-2',
              title: t('chat.starters.connectTitle'),
              desc: t('chat.starters.connectDesc'),
              action: () => navigate({ view: 'connections', chatId: null }),
            },
            {
              key: 'market',
              icon: Store,
              tone: 'tile-tone-3',
              title: t('chat.starters.marketTitle'),
              desc: t('chat.starters.marketDesc'),
              action: () => navigate({ view: 'market', chatId: null }),
            },
          ]

    return (
      <section className="chat chat-start">
        <TopBar trailing={studioBtn} />
        <div className="chat-shell">
          <div className="start">
            <div className="start-hero">
              <div className="start-emblem-stage" aria-hidden="true">
                <span className="emblem-aura" />
                <span className="emblem-ring ring-1" />
                <span className="emblem-ring ring-2" />
                <div className="start-emblem">
                  <Oculus state={oculus} size={42} />
                </div>
              </div>
              <div className="studio-pill">
                <span className="studio-pill-dot" aria-hidden="true" />
                <span className="studio-pill-scene">{t(`scene.${workScene}`)}</span>
                <span className="pill-sep">·</span>
                <span>
                  {activeProvider
                    ? `${activeProvider.managedBy === 'relaypulse' && activeProvider.name === 'RelayPulse' ? 'Atrium Cloud' : activeProvider.name} · ${activeProvider.model}`
                    : 'Atrium Studio'}
                </span>
                {workspaceName && (
                  <>
                    <span className="pill-sep">·</span>
                    <span>{workspaceName}</span>
                  </>
                )}
              </div>
              <h2 className="greeting display">{t(`chat.greet.${greetingKey()}`)}</h2>
              <p className="start-subtitle">{workScene === 'work' ? t('chat.workSubtitle') : t('chat.subtitle')}</p>
            </div>
            <div className="start-composer">
              {notice}
              {makeComposer('down')}
            </div>
            <div className="starter-grid">
              {starters.map(({ key, icon: Icon, tone, title: cardTitle, desc, action }) => (
                <button key={key} className="starter-card" onClick={action}>
                  <span className={`starter-icon ${tone}`} aria-hidden>
                    <Icon size={17} strokeWidth={1.85} />
                  </span>
                  <span className="starter-text">
                    <strong>{cardTitle}</strong>
                    <span>{desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
          {studioDrawer}
        </div>
        {previewModal}
        {rewindModal}
      </section>
    )
  }

  return (
    <section className="chat">
      <TopBar
        trailing={
          <>
            {(agentMode === 'plan' || agentMode === 'bypass') && (
              <button
                type="button"
                className={`topbar-pill ${agentMode === 'plan' ? 'plan-topbar-pill' : 'bypass-topbar-pill'}`}
                onClick={agentMode === 'plan' ? togglePlanMode : () => void setAgentMode('auto')}
                title={t('mode.switchHint')}
              >
                <span>{agentMode === 'plan' ? t('mode.planBadge') : t('mode.modes.bypass.short')}</span>
              </button>
            )}
            {conversation?.worktreeBranch ? (
              <span className="topbar-pill worktree-pill" title={`${t('studio.worktreeHint')}: ${conversation.workspace}`}>
                <GitBranch size={12} />
                <span>{conversation.worktreeBranch}</span>
              </span>
            ) : (
              workspaceName && (
                <button
                  type="button"
                  className="topbar-pill workspace-locked-pill"
                  onClick={() => toggleStudio('files')}
                  title={`${t('chat.workspaceLockedHint')}: ${workspace}`}
                >
                  <FolderOpen size={12} />
                  <span>{workspaceName}</span>
                </button>
              )
            )}
            <button
              type="button"
              className={`icon-btn topbar-search-btn${searchOpen ? ' active' : ''}`}
              onClick={() => {
                setSearchOpen((v) => {
                  const next = !v
                  if (next) requestAnimationFrame(() => searchInputRef.current?.focus())
                  return next
                })
              }}
              aria-label={t('chat.searchInChat')}
              title={`${t('chat.searchInChat')} (Ctrl+F)`}
            >
              <Search size={14} />
            </button>
            {studioBtn}
          </>
        }
      >
        <h1 className="topbar-title">{title || t('chat.untitled')}</h1>
      </TopBar>
      <div className="chat-shell">
        <div className="chat-pane">
          {searchOpen && (
            <div className="chat-search-bar" role="search">
              <Search size={13} />
              <input
                ref={searchInputRef}
                value={chatSearch}
                onChange={(e) => {
                  setChatSearch(e.target.value)
                  setSearchCursor(0)
                }}
                placeholder={t('chat.searchChatPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSearchOpen(false)
                  } else if (e.key === 'Enter' && searchMatches.length > 0 && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    setSearchCursor((c) =>
                      e.shiftKey ? (c - 1 + searchMatches.length) % searchMatches.length : (c + 1) % searchMatches.length,
                    )
                  }
                }}
              />
              {chatSearch.trim() && (
                <span className="chat-search-count">
                  {searchMatches.length > 0
                    ? `${(searchCursor % searchMatches.length) + 1} / ${searchMatches.length}`
                    : t('chat.searchNoMatch')}
                </span>
              )}
              <button
                type="button"
                className="icon-btn"
                disabled={searchMatches.length === 0}
                onClick={() => setSearchCursor((c) => (c - 1 + searchMatches.length) % Math.max(1, searchMatches.length))}
                title={t('chat.searchPrev')}
                aria-label={t('chat.searchPrev')}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={searchMatches.length === 0}
                onClick={() => setSearchCursor((c) => (c + 1) % Math.max(1, searchMatches.length))}
                title={t('chat.searchNext')}
                aria-label={t('chat.searchNext')}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSearchOpen(false)}
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <X size={13} />
              </button>
            </div>
          )}
          <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
            <MessageList
              chatId={chatId}
              messages={conversation.messages}
              live={live}
              modelName={activeProvider?.model}
              artifacts={artifacts}
              activeArtifactUid={studioOpen ? selectedArtifactUid : null}
              searchQuery={searchOpen ? chatSearch : undefined}
              activeSearchMatchIndex={searchOpen ? activeSearchMatchIdx : null}
              onOpenArtifact={openArtifactCanvas}
              onRegenerate={chatId && !live.busy ? () => void regenerateChat(chatId) : undefined}
              onEditUser={chatId && !live.busy ? (idx, nextText) => void handleEditUser(idx, nextText) : undefined}
              onContinue={
                !live.busy
                  ? () => {
                      const lastMsg = conversation.messages[conversation.messages.length - 1]
                      const resumingPartial =
                        live.endReason === 'truncated' ||
                        live.endReason === 'aborted' ||
                        (live.endReason === 'error' && lastMsg?.role === 'assistant') ||
                        (!live.endReason && lastMsg?.role === 'assistant' && Boolean(lastMsg.incomplete))
                      void sendMessage(resumingPartial ? t('chat.continueTruncatedPrompt') : 'Continue.')
                    }
                  : undefined
              }
              onApprovePlan={!live.busy ? () => void handleApprovePlan() : undefined}
              onFork={
                chatId
                  ? (idx) =>
                      void forkChat(chatId, idx, t('chat.forkSuffix')).then((id) => {
                        if (id) toast(t('chat.forkDone'))
                      })
                  : undefined
              }
              onRewind={
                chatId && !live.busy
                  ? (idx) => {
                      setRewindRevertFiles(true)
                      setRewindTarget(idx)
                    }
                  : undefined
              }
            />
            {live.approvals.map((a) => (
              <ApprovalCard key={a.approvalId} request={a} />
            ))}
            {(live.busy || compacting) && live.approvals.length === 0 && (
              <div className="working">
                <div className={`thinking-bar thinking-${oculus}`} role="status" aria-live="polite">
                  <Oculus state={oculus} size={22} />
                  <span className="thinking-label">{thinkingLabel}</span>
                  <span className="thinking-wave" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </div>
            )}
          </div>
          <footer className="chat-footer">
            {showScrollBottom && (
              <button type="button" className="scroll-bottom-btn" onClick={scrollToBottom} aria-label={t('chat.scrollToBottom')} title={t('chat.scrollToBottom')}>
                <ArrowDown size={13} />
                <span>{t('chat.scrollToBottom')}</span>
              </button>
            )}
            {notice}
            {makeComposer('up')}
            <p className="disclaimer">{t('chat.disclaimer')}</p>
          </footer>
        </div>
        {studioDrawer}
      </div>
      {previewModal}
      {rewindModal}
    </section>
  )
}
