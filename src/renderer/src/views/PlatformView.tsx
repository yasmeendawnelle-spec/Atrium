// Atrium Platform (Test): Unified local multi-agent commander view (Claude Code / AGY / Codex / Gemini / DSH / Atrium).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  GitMerge,
  Layers,
  MessageSquarePlus,
  Network,
  PanelRight,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  Shield,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import type {
  PlatformAgentProfile,
  PlatformAgentRole,
  PlatformBoardNote,
  PlatformLogEntry,
  PlatformPermissionMode,
  PlatformSession,
  PlatformTask,
  PlatformTaskDiffResult,
  PlatformTaskStatus,
} from '@shared/platform.ts'
import type { ReasoningEffort } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { setState, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { Markdown } from '../components/Markdown.tsx'
import { Oculus } from '../components/Oculus.tsx'
import { PlatformModelPicker, type PlatformModelSelection } from '../components/PlatformModelPicker.tsx'
import { StudioSelect } from '../components/StudioSelect.tsx'
import { folderName } from '../components/WorkspacePicker.tsx'

const MONOGRAMS: Record<string, string> = {
  atrium: 'AT',
  'claude-code': 'CC',
  agy: 'AG',
  codex: 'CX',
  'gemini-cli': 'GM',
  dsh: 'DS',
  opencode: 'OC',
  aider: 'AD',
}

const BOARD_KINDS: readonly PlatformBoardNote['kind'][] = ['plan', 'update', 'handoff', 'lock', 'review']

function agentMonogram(agent?: Pick<PlatformAgentProfile, 'id' | 'kind' | 'shortName'> | null, fallback = 'AI'): string {
  if (!agent) return fallback.slice(0, 2).toUpperCase()
  return MONOGRAMS[agent.id] ?? MONOGRAMS[agent.kind] ?? (agent.shortName || fallback).slice(0, 2).toUpperCase()
}

function formatDuration(start: number, end?: number): string {
  const ms = Math.max(0, (end ?? Date.now()) - start)
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

function formatRelTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return '<1m'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function renderDiffText(diff: string) {
  if (!diff.trim()) return null
  return (
    <pre className="fleet-diff-code">
      {diff.split(/\r?\n/).map((line, idx) => {
        const cls =
          line.startsWith('+') && !line.startsWith('+++')
            ? 'fleet-diff-line add'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'fleet-diff-line del'
              : line.startsWith('@@')
                ? 'fleet-diff-line hunk'
                : 'fleet-diff-line'
        return (
          <div key={idx} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

function logIcon(kind: PlatformLogEntry['kind']) {
  if (kind === 'tool_call') return <Wrench size={11} />
  if (kind === 'tool_result') return <Check size={11} />
  if (kind === 'error') return <AlertCircle size={11} />
  return <Terminal size={11} />
}

export function PlatformView() {
  const ft = useFeatureText()
  const agents = useStore((s) => s.platformAgents)
  const sessionSummaries = useStore((s) => s.platformSessions)
  const sessionsById = useStore((s) => s.platformSessionsById)
  const activeSessionId = useStore((s) => s.platformActiveSessionId)
  const defaultWorkspace = useStore((s) => s.settings?.workspace)

  const [workspaceOverride, setWorkspaceOverride] = useState('')
  const [useWorktrees, setUseWorktrees] = useState(false)
  const [maxDepth, setMaxDepth] = useState(2)
  const [missionDraft, setMissionDraft] = useState('')
  const [forceNewMission, setForceNewMission] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [refreshingModelsId, setRefreshingModelsId] = useState<string | null>(null)
  const [dispatching, setDispatching] = useState(false)
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null)
  const [showUnavailable, setShowUnavailable] = useState(false)
  const [showCustomForm, setShowCustomForm] = useState(false)
  const [customName, setCustomName] = useState('')
  const [customCmd, setCustomCmd] = useState('')
  const [customArgs, setCustomArgs] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [inspectorTab, setInspectorTab] = useState<'logs' | 'board' | 'diff'>('logs')
  const [logFilter, setLogFilter] = useState<'all' | 'tools' | 'errors'>('all')
  const [taskFollowup, setTaskFollowup] = useState('')
  const [sendingFollowup, setSendingFollowup] = useState(false)
  const [boardKind, setBoardKind] = useState<PlatformBoardNote['kind']>('update')
  const [boardTitle, setBoardTitle] = useState('')
  const [boardContent, setBoardContent] = useState('')
  const [diffResult, setDiffResult] = useState<PlatformTaskDiffResult | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null)
  const [copiedLogs, setCopiedLogs] = useState(false)
  const [collapsedOutputs, setCollapsedOutputs] = useState<Record<string, boolean>>({})
  const [tick, setTick] = useState(0)

  const feedEndRef = useRef<HTMLDivElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const activeSession: PlatformSession | null = activeSessionId
    ? (sessionsById[activeSessionId] ?? null)
    : null

  const workspace = workspaceOverride || activeSession?.workspace || defaultWorkspace || ''

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  const statusLabel = useCallback(
    (status: PlatformTaskStatus | PlatformSession['status']) => {
      return ft(`platform.status.${status}` as 'platform.status.running')
    },
    [ft],
  )

  const permissionShort = useCallback(
    (mode: PlatformPermissionMode) => {
      if (mode === 'plan') return ft('platform.modePlan')
      if (mode === 'full_auto') return ft('platform.modeFullAuto')
      return ft('platform.modeAcceptEdits')
    },
    [ft],
  )

  const refreshInitial = useCallback(async () => {
    try {
      const [nextAgents, nextSessions] = await Promise.all([
        call('platform.agents'),
        call('platform.sessions'),
      ])
      setState((s) => ({
        platformAgents: nextAgents,
        platformSessions: nextSessions,
        platformActiveSessionId: s.platformActiveSessionId ?? nextSessions[0]?.id ?? null,
      }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [])

  useEffect(() => {
    void refreshInitial()
  }, [refreshInitial])

  useEffect(() => {
    if (!activeSessionId || sessionsById[activeSessionId]) return
    void call('platform.getSession', activeSessionId)
      .then((sess) => {
        if (sess) {
          setState((s) => ({
            platformSessionsById: { ...s.platformSessionsById, [sess.id]: sess },
          }))
        }
      })
      .catch(() => undefined)
  }, [activeSessionId, sessionsById])

  const anyRunning = useMemo(
    () =>
      (activeSession?.tasks.some((t) => t.status === 'running') ?? false) ||
      sessionSummaries.some((x) => x.runningCount > 0),
    [activeSession, sessionSummaries],
  )

  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => setTick((x) => x + 1), 1000)
    return () => window.clearInterval(timer)
  }, [anyRunning])

  useEffect(() => {
    setForceNewMission(false)
    if (!activeSession) {
      setSelectedTaskId(null)
      return
    }
    if (!selectedTaskId || !activeSession.tasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(activeSession.rootTaskId ?? activeSession.tasks[0]?.id ?? null)
    }
  }, [activeSession?.id])

  useEffect(() => {
    if (!activeSession) return
    if (!selectedTaskId || !activeSession.tasks.some((t) => t.id === selectedTaskId)) {
      setSelectedTaskId(activeSession.rootTaskId ?? activeSession.tasks[0]?.id ?? null)
    }
  }, [activeSession, selectedTaskId])

  const selectedTask: PlatformTask | null = useMemo(() => {
    if (!activeSession) return null
    return activeSession.tasks.find((t) => t.id === selectedTaskId) ?? activeSession.tasks[0] ?? null
  }, [activeSession, selectedTaskId])

  // Auto-scroll timeline when delegated child tasks appear.
  const taskCount = activeSession?.tasks.length ?? 0
  useEffect(() => {
    if (taskCount > 1) {
      feedEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [taskCount])

  // Auto-scroll live logs while selected task is running (only if user hasn't scrolled up).
  const logListRef = useRef<HTMLDivElement>(null)
  const logStickToBottomRef = useRef(true)
  useEffect(() => {
    logStickToBottomRef.current = true
  }, [selectedTask?.id])
  const selectedLogCount = selectedTask?.logs.length ?? 0
  useEffect(() => {
    if (inspectorOpen && inspectorTab === 'logs' && selectedTask?.status === 'running' && logStickToBottomRef.current) {
      logEndRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [inspectorOpen, inspectorTab, selectedTask?.status, selectedLogCount])

  // Auto-grow mission composer textarea cleanly.
  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(168, Math.max(46, el.scrollHeight))}px`
  }, [missionDraft])

  const loadTaskDiff = useCallback(async () => {
    if (!activeSession || !selectedTask) {
      setDiffResult(null)
      return
    }
    setLoadingDiff(true)
    try {
      const res = await call('platform.diffTask', activeSession.id, selectedTask.id)
      setDiffResult(res)
    } catch (err) {
      setDiffResult(null)
      toast(errorMessage(err), 'error')
    } finally {
      setLoadingDiff(false)
    }
  }, [activeSession, selectedTask])

  useEffect(() => {
    if (inspectorOpen && inspectorTab === 'diff' && activeSession && selectedTask) {
      void loadTaskDiff()
    }
  }, [inspectorOpen, inspectorTab, activeSession, selectedTask?.id, selectedTask?.status, loadTaskDiff])

  const availableAgents = useMemo(() => agents.filter((a) => a.available), [agents])
  const unavailableAgents = useMemo(() => agents.filter((a) => !a.available), [agents])
  const commanderAgent = useMemo(
    () => availableAgents.find((a) => a.role === 'commander') ?? availableAgents[0],
    [availableAgents],
  )
  const enabledWorkers = useMemo(
    () => availableAgents.filter((a) => a.id !== commanderAgent?.id && a.role !== 'disabled'),
    [availableAgents, commanderAgent?.id],
  )

  const isFollowupMode = Boolean(
    activeSession && activeSession.rootTaskId && activeSession.status !== 'running' && !forceNewMission,
  )

  const handleScan = async () => {
    setScanning(true)
    try {
      const list = await call('platform.scan')
      setState({ platformAgents: list })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setScanning(false)
    }
  }

  const handleRefreshModels = async (agentId: string, refresh = false) => {
    setRefreshingModelsId(agentId)
    try {
      await call('platform.agentModels', agentId, refresh)
      const latest = await call('platform.agents')
      setState({ platformAgents: latest })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setRefreshingModelsId((cur) => (cur === agentId ? null : cur))
    }
  }

  const handlePickWorkspace = async () => {
    const picked = await shell.pickFolder()
    if (picked) setWorkspaceOverride(picked)
  }

  const handleUpdateAgent = async (
    agentId: string,
    patch: {
      role?: PlatformAgentRole
      permissionMode?: PlatformPermissionMode
      modelOverride?: string
      modelProviderOverride?: string
      syncToCliConfig?: boolean
      binaryPath?: string
    },
  ) => {
    try {
      const list = await call('platform.updateAgent', agentId, patch)
      setState({ platformAgents: list })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleSelectAgentModel = async (agent: PlatformAgentProfile, sel: PlatformModelSelection) => {
    try {
      const list = await call('platform.updateAgent', agent.id, {
        modelOverride: sel.model,
        ...(sel.providerId !== undefined ? { modelProviderOverride: sel.providerId } : {}),
        ...(sel.reasoningEffort !== undefined ? { reasoningEffortOverride: sel.reasoningEffort } : {}),
        ...(sel.syncToCliConfig ? { syncToCliConfig: true } : {}),
      })
      setState({ platformAgents: list })
      if (sel.syncToCliConfig) {
        if (agent.id === 'atrium') {
          const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
          setState({ providers, settings })
        }
        if (sel.model) {
          toast(ft('platform.modelSyncedToast', { agent: agent.shortName, model: sel.model }))
        } else if (sel.reasoningEffort) {
          toast(ft('platform.effortSyncedToast', { agent: agent.shortName, effort: sel.reasoningEffort }))
        }
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleChangeAgentEffort = async (
    agent: PlatformAgentProfile,
    effort: ReasoningEffort,
    syncToCliConfig: boolean,
  ) => {
    try {
      const list = await call('platform.updateAgent', agent.id, {
        reasoningEffortOverride: effort,
        ...(syncToCliConfig ? { syncToCliConfig: true } : {}),
      })
      setState({ platformAgents: list })
      if (syncToCliConfig) {
        if (agent.id === 'atrium') {
          const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
          setState({ providers, settings })
        }
        toast(ft('platform.effortSyncedToast', { agent: agent.shortName, effort }))
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const applyPreset = async (commanderId: string, preferWorkers: string[]) => {
    const cmdAgent = availableAgents.find((a) => a.id === commanderId)
    if (!cmdAgent) {
      toast(`${commanderId} not installed`, 'error')
      return
    }
    try {
      await call('platform.updateAgent', cmdAgent.id, { role: 'commander' })
      for (const a of availableAgents) {
        if (a.id === cmdAgent.id) continue
        const nextRole: PlatformAgentRole =
          preferWorkers.length === 0 || preferWorkers.includes(a.id) ? 'worker' : 'disabled'
        await call('platform.updateAgent', a.id, { role: nextRole })
      }
      setState({ platformAgents: await call('platform.agents') })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleSaveCustomAgent = async () => {
    const name = customName.trim()
    const command = customCmd.trim()
    if (!name || !command) return
    const args = customArgs.trim() ? customArgs.trim().split(/\s+/) : []
    try {
      const list = await call('platform.saveCustomAgent', { name, command, args })
      setState({ platformAgents: list })
      setCustomName('')
      setCustomCmd('')
      setCustomArgs('')
      setShowCustomForm(false)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleRemoveCustomAgent = async (id: string) => {
    try {
      const list = await call('platform.removeCustomAgent', id)
      setState({ platformAgents: list })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleDispatch = async (promptText?: string) => {
    const clean = (promptText ?? missionDraft).trim()
    if (!clean || dispatching) return
    if (!workspace) {
      toast(ft('platform.noWorkspace'), 'error')
      return
    }
    setDispatching(true)
    try {
      if (isFollowupMode && activeSession?.rootTaskId && !promptText) {
        await call('platform.sendFollowup', activeSession.id, activeSession.rootTaskId, clean)
        setMissionDraft('')
      } else {
        const created = await call('platform.startSession', {
          workspace,
          prompt: clean,
          commanderId: commanderAgent?.id,
          workerIds: enabledWorkers.map((w) => w.id),
          useWorktrees,
          maxDepth,
        })
        setForceNewMission(false)
        setState((s) => ({
          platformActiveSessionId: created.id,
          platformSessionsById: { ...s.platformSessionsById, [created.id]: created },
        }))
        setSelectedTaskId(created.rootTaskId ?? null)
        if (!promptText) setMissionDraft('')
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setDispatching(false)
    }
  }

  const handleStopAll = async () => {
    try {
      const count = await call('platform.stopAll')
      toast(ft('platform.stoppedAllToast', { count }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleStopTask = async (taskId: string) => {
    if (!activeSession) return
    await call('platform.stopTask', activeSession.id, taskId).catch((err) => toast(errorMessage(err), 'error'))
  }

  const handleTaskFollowup = async () => {
    if (!activeSession || !selectedTask || !taskFollowup.trim() || sendingFollowup) return
    setSendingFollowup(true)
    try {
      await call('platform.sendFollowup', activeSession.id, selectedTask.id, taskFollowup.trim())
      setTaskFollowup('')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSendingFollowup(false)
    }
  }

  const handlePostBoardNote = async () => {
    if (!activeSession || !boardTitle.trim() || !boardContent.trim()) return
    try {
      await call('platform.postBoardNote', activeSession.id, {
        title: boardTitle.trim(),
        content: boardContent.trim(),
        kind: boardKind,
      })
      setBoardTitle('')
      setBoardContent('')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleMergeWorktree = async (taskId: string) => {
    if (!activeSession) return
    try {
      const res = await call('platform.mergeWorktree', activeSession.id, taskId, { cleanupWorktree: true })
      toast(ft('platform.mergedToast', { branch: res.branch, base: res.baseBranch || 'HEAD' }))
      void loadTaskDiff()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleDiscardWorktree = async (taskId: string, branch?: string) => {
    if (!activeSession) return
    try {
      await call('platform.discardWorktree', activeSession.id, taskId)
      toast(ft('platform.discardedToast', { branch: branch || 'worktree' }))
      void loadTaskDiff()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const copyTaskOutput = (task: PlatformTask) => {
    if (!task.output) return
    void navigator.clipboard.writeText(task.output).then(() => {
      setCopiedTaskId(task.id)
      window.setTimeout(() => setCopiedTaskId((cur) => (cur === task.id ? null : cur)), 1500)
    })
  }

  const copyAllLogs = (task: PlatformTask) => {
    const dump = task.logs
      .map((l) => `[${new Date(l.ts).toLocaleTimeString()}] ${l.title || l.kind}: ${l.content}`)
      .join('\n\n')
    if (!dump) return
    void navigator.clipboard.writeText(dump).then(() => {
      setCopiedLogs(true)
      window.setTimeout(() => setCopiedLogs(false), 1500)
    })
  }

  const focusTask = (taskId: string, tab?: 'logs' | 'board' | 'diff') => {
    setSelectedTaskId(taskId)
    setInspectorOpen(true)
    if (tab) setInspectorTab(tab)
  }

  const rootTask = activeSession?.tasks.find((t) => t.id === activeSession.rootTaskId) ?? null
  const workerTasks = activeSession?.tasks.filter((t) => t.id !== activeSession.rootTaskId) ?? []

  const filteredLogs = useMemo(() => {
    if (!selectedTask) return []
    if (logFilter === 'tools') {
      return selectedTask.logs.filter((l) => l.kind === 'tool_call' || l.kind === 'tool_result')
    }
    if (logFilter === 'errors') {
      return selectedTask.logs.filter((l) => l.kind === 'error')
    }
    return selectedTask.logs
  }, [selectedTask, logFilter])

  const diffTotals = useMemo(() => {
    if (!diffResult) return { additions: 0, deletions: 0 }
    return diffResult.items.reduce(
      (acc, item) => ({
        additions: acc.additions + item.additions,
        deletions: acc.deletions + item.deletions,
      }),
      { additions: 0, deletions: 0 },
    )
  }, [diffResult])

  const permissionOptions: { value: PlatformPermissionMode; label: string }[] = [
    { value: 'plan', label: ft('platform.modePlan') },
    { value: 'accept_edits', label: ft('platform.modeAcceptEdits') },
    { value: 'full_auto', label: ft('platform.modeFullAuto') },
  ]

  const rootCommanderProfile = rootTask ? agentById.get(rootTask.agentId) : commanderAgent
  const commanderActiveModel =
    rootTask?.model || rootCommanderProfile?.modelOverride || rootCommanderProfile?.defaultModel

  void tick

  return (
    <section className="platform-page">
      {/* Crisp Single-Row Header */}
      <header className="platform-head">
        <div className="platform-head-title">
          <span className="platform-head-ico" aria-hidden>
            <Network size={16} />
          </span>
          <h1 className="display">{ft('platform.title')}</h1>
          <span className="side-beta-pill">{ft('platform.testBadge')}</span>
          <span className="platform-ready-pill">
            <span className="platform-ready-dot" aria-hidden />
            <span>{ft('platform.readyCount', { count: availableAgents.length })}</span>
          </span>
        </div>

        <div className="platform-head-controls">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void handlePickWorkspace()}
            title={workspace || ft('platform.noWorkspace')}
          >
            <FolderOpen size={13} />
            <span>{workspace ? folderName(workspace) || workspace : ft('platform.noWorkspace')}</span>
          </button>

          <label className="platform-toggle-pill" title={ft('platform.worktreeHint')}>
            <GitBranch size={13} />
            <span>{ft('platform.worktreeToggle')}</span>
            <span className="switch">
              <input
                type="checkbox"
                checked={useWorktrees}
                onChange={(e) => setUseWorktrees(e.target.checked)}
              />
              <span />
            </span>
          </label>

          <div className="platform-depth-pill" title={ft('platform.maxDepthLabel')}>
            <Layers size={12} />
            <span>{ft('platform.maxDepthLabel')}</span>
            <div className="platform-depth-seg" role="group" aria-label={ft('platform.maxDepthLabel')}>
              {[1, 2, 3].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={maxDepth === d ? 'active' : undefined}
                  onClick={() => setMaxDepth(d)}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          <button type="button" className="btn btn-small" disabled={scanning} onClick={() => void handleScan()}>
            <RefreshCw size={13} className={scanning ? 'spin' : undefined} />
            <span>{scanning ? ft('platform.scanning') : ft('platform.rescan')}</span>
          </button>

          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setState({ platformActiveSessionId: null })
              setSelectedTaskId(null)
              setForceNewMission(false)
              setMissionDraft('')
            }}
          >
            <Plus size={13} />
            <span>{ft('platform.newMission')}</span>
          </button>

          <button
            type="button"
            className={`btn btn-small platform-insp-toggle${inspectorOpen ? ' active' : ''}`}
            onClick={() => setInspectorOpen((v) => !v)}
            aria-pressed={inspectorOpen}
            title={ft('platform.toggleInspector')}
          >
            <PanelRight size={13} />
            <span>{ft('platform.toggleInspector')}</span>
          </button>

          {anyRunning && (
            <button type="button" className="btn btn-small danger" onClick={() => void handleStopAll()}>
              <Square size={12} />
              <span>{ft('platform.stopAll')}</span>
            </button>
          )}
        </div>
      </header>

      {/* Main 3-Pane Workspace */}
      <div className={`platform-grid${inspectorOpen ? '' : ' inspector-closed'}`}>
        {/* Left Pane: Local Agent Pool & Session History */}
        <aside className="platform-roster">
          <div className="platform-section">
            <div className="platform-section-label">{ft('platform.presetsTitle')}</div>
            <div className="platform-preset-row">
              {availableAgents.some((a) => a.id === 'claude-code') && (
                <button
                  type="button"
                  className={`platform-preset-btn${commanderAgent?.id === 'claude-code' ? ' active' : ''}`}
                  onClick={() => void applyPreset('claude-code', ['agy', 'gemini-cli', 'codex', 'atrium'])}
                >
                  {ft('platform.presetClaudeHub')}
                </button>
              )}
              <button
                type="button"
                className={`platform-preset-btn${commanderAgent?.id === 'atrium' ? ' active' : ''}`}
                onClick={() => void applyPreset('atrium', [])}
              >
                {ft('platform.presetAtriumHub')}
              </button>
              {availableAgents.some((a) => a.id === 'agy') && (
                <button
                  type="button"
                  className={`platform-preset-btn${commanderAgent?.id === 'agy' ? ' active' : ''}`}
                  onClick={() => void applyPreset('agy', ['claude-code', 'gemini-cli', 'atrium'])}
                >
                  {ft('platform.presetAgyHub')}
                </button>
              )}
            </div>
          </div>

          <div className="platform-section platform-roster-scroll">
            <div className="platform-section-head">
              <span className="platform-section-label">
                {ft('platform.rosterTitle')} ({availableAgents.length})
              </span>
              <button
                type="button"
                className="platform-text-btn"
                onClick={() => setShowCustomForm((v) => !v)}
              >
                {ft('platform.addCustomBtn')}
              </button>
            </div>

            {showCustomForm && (
              <div className="platform-custom-form">
                <input
                  className="input"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder={ft('platform.customNamePlaceholder')}
                />
                <input
                  className="input"
                  value={customCmd}
                  onChange={(e) => setCustomCmd(e.target.value)}
                  placeholder={ft('platform.customCmdPlaceholder')}
                />
                <input
                  className="input"
                  value={customArgs}
                  onChange={(e) => setCustomArgs(e.target.value)}
                  placeholder={ft('platform.customArgsPlaceholder')}
                />
                <div className="platform-custom-acts">
                  <button type="button" className="btn btn-small btn-primary" onClick={() => void handleSaveCustomAgent()}>
                    {ft('platform.customSave')}
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => setShowCustomForm(false)}>
                    {ft('platform.customCancel')}
                  </button>
                </div>
              </div>
            )}

            <div className="platform-agent-list">
              {availableAgents.map((agent) => {
                const expanded = expandedAgentId === agent.id
                const modelList = agent.availableModels ?? []
                const needsModelFetch =
                  (agent.kind === 'agy' && modelList.length <= 1) ||
                  (agent.kind === 'atrium' && modelList.length === 0) ||
                  ((agent.kind === 'claude-code' || agent.kind === 'codex') &&
                    Boolean(agent.endpointLabel) &&
                    modelList.length <= 7)
                const toggleExpand = () => {
                  const nextOpen = !expanded
                  setExpandedAgentId(nextOpen ? agent.id : null)
                  if (nextOpen && needsModelFetch) {
                    void handleRefreshModels(agent.id, agent.kind === 'agy' && modelList.length <= 1)
                  }
                }
                return (
                  <div
                    key={agent.id}
                    className={`platform-agent-card${agent.role === 'commander' ? ' is-commander' : agent.role === 'disabled' ? ' is-disabled' : ''}`}
                    style={{ '--agent-accent': agent.accentColor } as CSSProperties}
                  >
                    <div className="platform-agent-top">
                      <span className="platform-agent-avatar" aria-hidden>
                        {agentMonogram(agent)}
                      </span>
                      <div className="platform-agent-meta">
                        <div className="platform-agent-name-row">
                          <strong>{agent.name}</strong>
                          {agent.version && <span className="platform-ver-tag">{agent.version}</span>}
                        </div>
                        <div className="platform-agent-caps">
                          <span className="platform-cap-badge">
                            {agent.supportsMcpInjection ? ft('platform.mcpCapable') : ft('platform.bridgeCapable')}
                          </span>
                          <span className="platform-perm-hint">{permissionShort(agent.permissionMode)}</span>
                        </div>
                        <PlatformModelPicker
                          agent={agent}
                          variant="pill"
                          refreshing={refreshingModelsId === agent.id}
                          onOpen={() => {
                            if (needsModelFetch) {
                              void handleRefreshModels(agent.id, agent.kind === 'agy' && modelList.length <= 1)
                            }
                          }}
                          onRefresh={() => void handleRefreshModels(agent.id, true)}
                          onSelect={(sel) => handleSelectAgentModel(agent, sel)}
                          onChangeEffort={(lvl, sync) => handleChangeAgentEffort(agent, lvl, sync)}
                        />
                      </div>
                      <button
                        type="button"
                        className={`icon-btn${expanded ? ' active' : ''}`}
                        aria-label="Configure agent"
                        onClick={toggleExpand}
                      >
                        <Settings2 size={13} />
                      </button>
                    </div>

                    <div className="platform-role-pills" role="group" aria-label={agent.name}>
                      {(['commander', 'worker', 'reviewer', 'disabled'] as const).map((r) => (
                        <button
                          key={r}
                          type="button"
                          className={`platform-role-btn${agent.role === r ? ' active' : ''}${r === 'commander' ? ' cmd' : ''}`}
                          onClick={() => void handleUpdateAgent(agent.id, { role: r })}
                        >
                          {r === 'commander'
                            ? ft('platform.roleCommander')
                            : r === 'worker'
                              ? ft('platform.roleWorker')
                              : r === 'reviewer'
                                ? ft('platform.roleReviewer')
                                : ft('platform.roleDisabled')}
                        </button>
                      ))}
                    </div>

                    {expanded && (
                      <div className="platform-agent-extra">
                        <StudioSelect
                          value={agent.permissionMode}
                          options={permissionOptions}
                          fullWidth
                          onChange={(v) => void handleUpdateAgent(agent.id, { permissionMode: v })}
                        />
                        <div className="platform-model-field-head">
                          <span>{ft('platform.modelLabel')}</span>
                          {(agent.kind === 'agy' ||
                            agent.kind === 'atrium' ||
                            agent.kind === 'claude-code' ||
                            agent.kind === 'codex') && (
                            <button
                              type="button"
                              className="icon-btn"
                              disabled={refreshingModelsId === agent.id}
                              onClick={() => void handleRefreshModels(agent.id, true)}
                              title={ft('platform.refreshModels')}
                              aria-label={ft('platform.refreshModels')}
                            >
                              <RefreshCw size={11} className={refreshingModelsId === agent.id ? 'spin' : undefined} />
                            </button>
                          )}
                        </div>
                        <PlatformModelPicker
                          agent={agent}
                          variant="field"
                          refreshing={refreshingModelsId === agent.id}
                          onOpen={() => {
                            if (needsModelFetch) {
                              void handleRefreshModels(agent.id, agent.kind === 'agy' && modelList.length <= 1)
                            }
                          }}
                          onRefresh={() => void handleRefreshModels(agent.id, true)}
                          onSelect={(sel) => handleSelectAgentModel(agent, sel)}
                          onChangeEffort={(lvl, sync) => handleChangeAgentEffort(agent, lvl, sync)}
                        />
                        {agent.kind !== 'atrium' && (
                          <input
                            className="input"
                            defaultValue={agent.binaryPath ?? ''}
                            placeholder={ft('platform.binaryPathPlaceholder')}
                            onBlur={(e) => {
                              const val = e.target.value.trim()
                              if (val && val !== (agent.binaryPath ?? '')) {
                                void handleUpdateAgent(agent.id, { binaryPath: val })
                              }
                            }}
                          />
                        )}
                        {agent.kind === 'custom' && (
                          <button
                            type="button"
                            className="btn btn-small danger"
                            onClick={() => void handleRemoveCustomAgent(agent.id)}
                          >
                            <Trash2 size={12} />
                            <span>{ft('platform.deleteAgent')}</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {unavailableAgents.length > 0 && (
              <div className="platform-unavail-wrap">
                <button
                  type="button"
                  className="platform-unavail-toggle"
                  onClick={() => setShowUnavailable((v) => !v)}
                >
                  {showUnavailable ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span>{ft('platform.notInstalledTitle', { count: unavailableAgents.length })}</span>
                </button>
                {showUnavailable && (
                  <div className="platform-unavail-list">
                    {unavailableAgents.map((agent: PlatformAgentProfile) => (
                      <div key={agent.id} className="platform-unavail-item">
                        <div className="platform-unavail-head">
                          <strong>{agent.name}</strong>
                          {agent.installHint && <code>{agent.installHint}</code>}
                        </div>
                        <input
                          className="input"
                          placeholder={ft('platform.binaryPathPlaceholder')}
                          onBlur={(e) => {
                            const val = e.target.value.trim()
                            if (val) void handleUpdateAgent(agent.id, { binaryPath: val, role: 'worker' })
                          }}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Session History */}
          <div className="platform-section platform-sessions-box">
            <div className="platform-section-label">
              {ft('platform.sessionsTitle', { count: sessionSummaries.length })}
            </div>
            {sessionSummaries.length === 0 ? (
              <div className="platform-sessions-empty">{ft('platform.noSessions')}</div>
            ) : (
              <div className="platform-session-list">
                {sessionSummaries.slice(0, 12).map((sess) => (
                  <div
                    key={sess.id}
                    className={`platform-session-row${activeSessionId === sess.id ? ' active' : ''}`}
                  >
                    <button
                      type="button"
                      className="platform-session-open"
                      onClick={() => setState({ platformActiveSessionId: sess.id })}
                    >
                      <span className={`platform-status-dot ${sess.status}`} aria-hidden />
                      <span className="platform-session-title">{sess.title}</span>
                      <span className="platform-session-time">{formatRelTime(sess.updatedAt)}</span>
                      <span className="platform-session-count">{sess.taskCount}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn platform-session-del"
                      aria-label="Delete session"
                      onClick={() =>
                        void call('platform.deleteSession', sess.id).then(() => {
                          if (activeSessionId === sess.id) setState({ platformActiveSessionId: null })
                        })
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Center Pane: Live Pipeline + Delegation Tree + Elevated Composer */}
        <main className="platform-stage">
          {/* Topology Bar */}
          <div className="platform-topology">
            <div
              className={`platform-topo-node commander${selectedTask && rootTask && selectedTask.id === rootTask.id ? ' selected' : ''}`}
            >
              <button
                type="button"
                className="platform-topo-node-main"
                onClick={() => rootTask && focusTask(rootTask.id)}
                disabled={!rootTask}
              >
                <Oculus
                  state={rootTask?.status === 'running' ? 'thinking' : rootTask?.status === 'failed' ? 'error' : 'idle'}
                  size={15}
                />
                <span className="platform-topo-role">{ft('platform.topologyCommander')}</span>
                <strong>
                  {activeSession
                    ? rootTask?.agentName ?? activeSession.commanderId
                    : commanderAgent?.name ?? '—'}
                </strong>
                {rootTask && (
                  <span className={`platform-status-pill ${rootTask.status}`}>{statusLabel(rootTask.status)}</span>
                )}
              </button>
              {rootCommanderProfile && (
                <PlatformModelPicker
                  agent={rootCommanderProfile}
                  variant="topo"
                  displayModelOverride={
                    activeSession?.status === 'running' ? commanderActiveModel : undefined
                  }
                  refreshing={refreshingModelsId === rootCommanderProfile.id}
                  onOpen={() => {
                    const count = rootCommanderProfile.availableModels?.length ?? 0
                    if (
                      (rootCommanderProfile.kind === 'agy' && count <= 1) ||
                      (rootCommanderProfile.kind === 'atrium' && count === 0) ||
                      ((rootCommanderProfile.kind === 'claude-code' || rootCommanderProfile.kind === 'codex') &&
                        Boolean(rootCommanderProfile.endpointLabel) &&
                        count <= 7)
                    ) {
                      void handleRefreshModels(
                        rootCommanderProfile.id,
                        rootCommanderProfile.kind === 'agy' && count <= 1,
                      )
                    }
                  }}
                  onRefresh={() => void handleRefreshModels(rootCommanderProfile.id, true)}
                  onSelect={(sel) => handleSelectAgentModel(rootCommanderProfile, sel)}
                  onChangeEffort={(lvl, sync) => handleChangeAgentEffort(rootCommanderProfile, lvl, sync)}
                />
              )}
            </div>

            <span className={`platform-topo-beam${anyRunning ? ' flowing' : ''}`} aria-hidden>
              <ArrowRight size={13} />
            </span>

            <div className="platform-topo-workers">
              {activeSession && workerTasks.length > 0 ? (
                workerTasks.map((t) => {
                  const prof = agentById.get(t.agentId)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`platform-topo-node worker${selectedTask?.id === t.id ? ' selected' : ''}`}
                      onClick={() => focusTask(t.id)}
                    >
                      <span
                        className={`platform-status-dot ${t.status}`}
                        style={t.status !== 'running' && prof?.accentColor ? { background: prof.accentColor } : undefined}
                        aria-hidden
                      />
                      <span>{t.agentName}</span>
                      <span className="platform-topo-time">{formatDuration(t.startedAt, t.endedAt)}</span>
                    </button>
                  )
                })
              ) : enabledWorkers.length > 0 ? (
                enabledWorkers.map((w) => (
                  <span key={w.id} className="platform-topo-node standby">
                    <span className="platform-agent-dot" style={{ background: w.accentColor }} aria-hidden />
                    <span>{w.shortName}</span>
                  </span>
                ))
              ) : (
                <span className="platform-topo-empty">{ft('platform.topologyWorkers')}: 0</span>
              )}
            </div>
          </div>

          {/* Center Scroll Area */}
          <div className="platform-timeline">
            {!activeSession ? (
              <div className="platform-empty">
                <div className="platform-team-preview" aria-label={ft('platform.readyTeamLabel')}>
                  <div className="platform-team-chip commander" style={{ '--agent-accent': commanderAgent?.accentColor } as CSSProperties}>
                    <span className="platform-agent-avatar sm">{agentMonogram(commanderAgent)}</span>
                    <span>{commanderAgent?.name ?? '—'}</span>
                  </div>
                  <ArrowRight size={14} className="platform-topo-arrow" aria-hidden />
                  <div className="platform-team-workers">
                    {enabledWorkers.slice(0, 5).map((w) => (
                      <div key={w.id} className="platform-team-chip" style={{ '--agent-accent': w.accentColor } as CSSProperties}>
                        <span className="platform-agent-avatar sm">{agentMonogram(w)}</span>
                        <span>{w.shortName}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <h2 className="display">{ft('platform.emptyTitle')}</h2>
                <p>{ft('platform.emptyHint')}</p>

                <div className="platform-starters">
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className="platform-starter-card"
                      onClick={() => setMissionDraft(ft(`platform.starter${n}Prompt` as 'platform.starter1Prompt'))}
                    >
                      <strong>{ft(`platform.starter${n}Title` as 'platform.starter1Title')}</strong>
                      <span>{ft(`platform.starter${n}Prompt` as 'platform.starter1Prompt')}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="platform-feed">
                {rootTask && (
                  <div
                    className={`platform-task-card is-root${selectedTask?.id === rootTask.id ? ' selected' : ''}`}
                    style={{ '--agent-accent': rootCommanderProfile?.accentColor } as CSSProperties}
                    onClick={() => focusTask(rootTask.id)}
                  >
                    <div className="platform-task-head">
                      <div className="platform-task-who">
                        <span className="platform-agent-avatar sm">{agentMonogram(rootCommanderProfile, rootTask.agentName)}</span>
                        <strong>{rootTask.agentName}</strong>
                        <span className="platform-cap-badge">{ft('platform.topologyCommander')}</span>
                        <span className={`platform-status-pill ${rootTask.status}`}>{statusLabel(rootTask.status)}</span>
                        <span className="platform-task-time">{formatDuration(rootTask.startedAt, rootTask.endedAt)}</span>
                      </div>
                      <div className="platform-task-acts">
                        {rootTask.output && (
                          <button
                            type="button"
                            className="icon-btn"
                            title={copiedTaskId === rootTask.id ? ft('platform.copied') : ft('platform.copyOutput')}
                            onClick={(e) => {
                              e.stopPropagation()
                              copyTaskOutput(rootTask)
                            }}
                          >
                            {copiedTaskId === rootTask.id ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                        )}
                        {rootTask.status === 'running' && (
                          <button
                            type="button"
                            className="btn btn-small danger"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleStopTask(rootTask.id)
                            }}
                          >
                            <Square size={11} />
                            <span>{ft('platform.stopBtn')}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="platform-mission-prompt">{rootTask.prompt}</div>

                    {rootTask.thinking && (
                      <details className="platform-thinking">
                        <summary>{ft('platform.thinkingLabel')}</summary>
                        <pre>{rootTask.thinking}</pre>
                      </details>
                    )}

                    {rootTask.output && (
                      <div className="platform-task-output">
                        <Markdown text={rootTask.output} streaming={rootTask.status === 'running'} />
                      </div>
                    )}

                    {rootTask.error && <div className="platform-task-error">{rootTask.error}</div>}
                  </div>
                )}

                {workerTasks.length > 0 && (
                  <div className="platform-delegation-branch">
                    {workerTasks.map((t) => {
                      const workerProf = agentById.get(t.agentId)
                      const fromProf = agentById.get(t.fromAgentId)
                      const fromLabel = fromProf?.shortName ?? t.fromAgentId
                      const isLong = t.output.length > 420
                      const isCollapsed = Boolean(collapsedOutputs[t.id])
                      return (
                        <div
                          key={t.id}
                          className={`platform-task-card is-delegation${selectedTask?.id === t.id ? ' selected' : ''}`}
                          style={{ '--agent-accent': workerProf?.accentColor } as CSSProperties}
                          onClick={() => focusTask(t.id)}
                        >
                          <div className="platform-task-head">
                            <div className="platform-task-who">
                              <span className="platform-agent-avatar sm">{agentMonogram(workerProf, t.agentName)}</span>
                              <strong>{ft('platform.delegatedFrom', { from: fromLabel, to: t.agentName })}</strong>
                              <span className={`platform-status-pill ${t.status}`}>{statusLabel(t.status)}</span>
                              {t.worktreeBranch && (
                                <span className="chat-wt-pill">{t.worktreeBranch.replace(/^atrium\//, '')}</span>
                              )}
                              {t.changedFiles.length > 0 && (
                                <button
                                  type="button"
                                  className="platform-files-pill"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    focusTask(t.id, 'diff')
                                  }}
                                >
                                  {ft('platform.filesCount', { count: t.changedFiles.length })}
                                </button>
                              )}
                              <span className="platform-task-time">{formatDuration(t.startedAt, t.endedAt)}</span>
                            </div>

                            <div className="platform-task-acts">
                              {t.output && (
                                <button
                                  type="button"
                                  className="icon-btn"
                                  title={copiedTaskId === t.id ? ft('platform.copied') : ft('platform.copyOutput')}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    copyTaskOutput(t)
                                  }}
                                >
                                  {copiedTaskId === t.id ? <Check size={12} /> : <Copy size={12} />}
                                </button>
                              )}
                              {isLong && (
                                <button
                                  type="button"
                                  className="platform-text-btn"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setCollapsedOutputs((prev) => ({ ...prev, [t.id]: !isCollapsed }))
                                  }}
                                >
                                  {isCollapsed ? ft('platform.expand') : ft('platform.collapse')}
                                </button>
                              )}
                              {t.status === 'running' && (
                                <button
                                  type="button"
                                  className="btn btn-small danger"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void handleStopTask(t.id)
                                  }}
                                >
                                  <Square size={11} />
                                  <span>{ft('platform.stopBtn')}</span>
                                </button>
                              )}
                              {t.worktreeBranch && t.status !== 'running' && (
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    void handleMergeWorktree(t.id)
                                  }}
                                >
                                  <GitMerge size={12} />
                                  <span>{ft('platform.mergeWorktree')}</span>
                                </button>
                              )}
                            </div>
                          </div>

                          <div className="platform-delegation-prompt">{t.prompt}</div>

                          {t.output && !isCollapsed && (
                            <div className="platform-task-output compact">
                              <Markdown text={t.output} streaming={t.status === 'running'} />
                            </div>
                          )}

                          {t.error && <div className="platform-task-error">{t.error}</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
                <div ref={feedEndRef} />
              </div>
            )}
          </div>

          {/* Elevated Warm Studio Composer */}
          <div className="platform-composer-shell">
            <div className="platform-composer-card">
              {activeSession && activeSession.status !== 'running' && (
                <div className="platform-composer-modebar">
                  <span className="platform-composer-mode-badge">
                    {isFollowupMode
                      ? ft('platform.composerModeFollowup', {
                          commander: rootTask?.agentName ?? commanderAgent?.name ?? 'Commander',
                        })
                      : ft('platform.composerModeNew')}
                  </span>
                  {isFollowupMode && (
                    <button
                      type="button"
                      className="platform-text-btn"
                      onClick={() => setForceNewMission(true)}
                    >
                      {ft('platform.switchToNew')}
                    </button>
                  )}
                </div>
              )}

              <textarea
                ref={composerRef}
                rows={2}
                value={missionDraft}
                onChange={(e) => setMissionDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void handleDispatch()
                  }
                }}
                placeholder={
                  isFollowupMode
                    ? ft('platform.followupCommanderPlaceholder', {
                        commander: rootTask?.agentName ?? commanderAgent?.name ?? 'Commander',
                      })
                    : ft('platform.commanderPlaceholder', { commander: commanderAgent?.name ?? 'Commander' })
                }
              />

              <div className="platform-composer-bar">
                <div className="platform-composer-meta">
                  <span>
                    <Shield size={12} />
                    {commanderAgent?.name ?? '—'}
                  </span>
                  {enabledWorkers.length > 0 && (
                    <span>→ {enabledWorkers.map((w) => w.shortName).join(', ')}</span>
                  )}
                </div>
                <div className="platform-composer-actions">
                  <span className="platform-shortcut-hint">{ft('platform.shortcutHint')}</span>
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    disabled={dispatching || !missionDraft.trim() || !commanderAgent}
                    onClick={() => void handleDispatch()}
                  >
                    <Send size={13} />
                    <span>{ft('platform.sendBtn')}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* Right Pane: Task Logs / Blackboard / Diff & Worktree */}
        {inspectorOpen && (
          <aside className="platform-inspector">
            <div className="platform-insp-tabs">
              <button
                type="button"
                className={`platform-insp-tab${inspectorTab === 'logs' ? ' active' : ''}`}
                onClick={() => setInspectorTab('logs')}
              >
                <Terminal size={13} />
                <span>{ft('platform.tabLogs', { count: selectedTask?.logs.length ?? 0 })}</span>
              </button>
              <button
                type="button"
                className={`platform-insp-tab${inspectorTab === 'board' ? ' active' : ''}`}
                onClick={() => setInspectorTab('board')}
              >
                <MessageSquarePlus size={13} />
                <span>{ft('platform.tabBoard', { count: activeSession?.board.length ?? 0 })}</span>
              </button>
              <button
                type="button"
                className={`platform-insp-tab${inspectorTab === 'diff' ? ' active' : ''}`}
                onClick={() => setInspectorTab('diff')}
              >
                <Wrench size={13} />
                <span>{ft('platform.tabDiff')}</span>
              </button>
              <button
                type="button"
                className="icon-btn platform-insp-close"
                aria-label="Close inspector"
                onClick={() => setInspectorOpen(false)}
              >
                <X size={14} />
              </button>
            </div>

            {inspectorTab === 'logs' && (
              <div className="platform-insp-body">
                {!selectedTask ? (
                  <div className="platform-insp-empty">{ft('platform.noTaskSelected')}</div>
                ) : (
                  <>
                    <div className="platform-insp-task-bar">
                      <div className="platform-insp-task-who">
                        <strong>{selectedTask.agentName}</strong>
                        <span className={`platform-status-pill ${selectedTask.status}`}>
                          {statusLabel(selectedTask.status)}
                        </span>
                        {selectedTask.model && <code>{selectedTask.model}</code>}
                      </div>
                      <button
                        type="button"
                        className="icon-btn"
                        title={copiedLogs ? ft('platform.copied') : ft('platform.copyOutput')}
                        onClick={() => copyAllLogs(selectedTask)}
                      >
                        {copiedLogs ? <Check size={12} /> : <Copy size={12} />}
                      </button>
                    </div>

                    <div className="platform-log-filters">
                      {(['all', 'tools', 'errors'] as const).map((f) => (
                        <button
                          key={f}
                          type="button"
                          className={`platform-filter-pill${logFilter === f ? ' active' : ''}`}
                          onClick={() => setLogFilter(f)}
                        >
                          {f === 'all'
                            ? ft('platform.logFilterAll')
                            : f === 'tools'
                              ? ft('platform.logFilterTools')
                              : ft('platform.logFilterErrors')}
                        </button>
                      ))}
                    </div>

                    <div
                      className="platform-log-list"
                      ref={logListRef}
                      onWheel={(e) => {
                        if (e.deltaY < 0) logStickToBottomRef.current = false
                      }}
                      onScroll={() => {
                        const el = logListRef.current
                        if (!el) return
                        const dist = el.scrollHeight - el.scrollTop - el.clientHeight
                        logStickToBottomRef.current = dist <= 40
                      }}
                    >
                      {filteredLogs.length === 0 ? (
                        <div className="platform-insp-empty">{ft('platform.logEmpty')}</div>
                      ) : (
                        filteredLogs.map((entry) => {
                          const isCollapsible = entry.content.length > 220
                          return (
                            <div key={entry.id} className={`platform-log-row kind-${entry.kind}`}>
                              <div className="platform-log-meta">
                                <span className="platform-log-title">
                                  {logIcon(entry.kind)}
                                  <span>{entry.title || entry.kind}</span>
                                </span>
                                <span>{new Date(entry.ts).toLocaleTimeString()}</span>
                              </div>
                              {isCollapsible ? (
                                <details className="platform-log-details">
                                  <summary>{entry.content.slice(0, 120)}…</summary>
                                  <pre>{entry.content}</pre>
                                </details>
                              ) : (
                                <pre>{entry.content}</pre>
                              )}
                            </div>
                          )
                        })
                      )}
                      <div ref={logEndRef} />
                    </div>

                    {selectedTask.status !== 'running' && (
                      <div className="platform-followup-box">
                        <input
                          className="input"
                          value={taskFollowup}
                          onChange={(e) => setTaskFollowup(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              void handleTaskFollowup()
                            }
                          }}
                          placeholder={ft('platform.taskFollowupPlaceholder', { agent: selectedTask.agentName })}
                        />
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          disabled={sendingFollowup || !taskFollowup.trim()}
                          onClick={() => void handleTaskFollowup()}
                        >
                          <Check size={12} />
                          <span>{ft('platform.taskFollowupSend')}</span>
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {inspectorTab === 'board' && (
              <div className="platform-insp-body">
                <div className="platform-board-list">
                  {!activeSession || activeSession.board.length === 0 ? (
                    <div className="platform-insp-empty">{ft('platform.boardEmpty')}</div>
                  ) : (
                    activeSession.board.map((note) => (
                      <div key={note.id} className="platform-board-note">
                        <div className="platform-board-head">
                          <span className={`platform-board-kind kind-${note.kind}`}>
                            {ft(`platform.boardKind.${note.kind}` as 'platform.boardKind.update')}
                          </span>
                          <strong>{note.authorName}</strong>
                          <span>{new Date(note.ts).toLocaleTimeString()}</span>
                        </div>
                        <div className="platform-board-title">{note.title}</div>
                        <div className="platform-board-content">{note.content}</div>
                      </div>
                    ))
                  )}
                </div>

                {activeSession && (
                  <div className="platform-board-form">
                    <div className="platform-board-kind-picks">
                      {BOARD_KINDS.map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={`platform-filter-pill${boardKind === k ? ' active' : ''}`}
                          onClick={() => setBoardKind(k)}
                        >
                          {ft(`platform.boardKind.${k}` as 'platform.boardKind.update')}
                        </button>
                      ))}
                    </div>
                    <input
                      className="input"
                      value={boardTitle}
                      onChange={(e) => setBoardTitle(e.target.value)}
                      placeholder={ft('platform.boardTitlePlaceholder')}
                    />
                    <textarea
                      rows={2}
                      value={boardContent}
                      onChange={(e) => setBoardContent(e.target.value)}
                      placeholder={ft('platform.boardContentPlaceholder')}
                    />
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={!boardTitle.trim() || !boardContent.trim()}
                      onClick={() => void handlePostBoardNote()}
                    >
                      {ft('platform.boardPostBtn')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {inspectorTab === 'diff' && (
              <div className="platform-insp-body">
                {!selectedTask ? (
                  <div className="platform-insp-empty">{ft('platform.noTaskSelected')}</div>
                ) : loadingDiff ? (
                  <div className="platform-insp-empty">{ft('platform.diffLoading')}</div>
                ) : (
                  <>
                    <div className="platform-diff-summary-bar">
                      <div className="platform-diff-stats">
                        <span>{ft('platform.diffSummary', { files: diffResult?.items.length ?? 0 })}</span>
                        {(diffTotals.additions > 0 || diffTotals.deletions > 0) && (
                          <span className="chat-diff-pill">
                            {diffTotals.additions > 0 && <em className="add">+{diffTotals.additions}</em>}
                            {diffTotals.deletions > 0 && <em className="del">-{diffTotals.deletions}</em>}
                          </span>
                        )}
                      </div>
                      <button type="button" className="platform-text-btn" onClick={() => void loadTaskDiff()}>
                        {ft('platform.diffRefresh')}
                      </button>
                    </div>

                    {diffResult?.isWorktree && (
                      <div className="platform-wt-bar">
                        <span>{ft('platform.worktreeBadge', { branch: diffResult.branch || '' })}</span>
                        <div className="platform-wt-acts">
                          <button
                            type="button"
                            className="btn btn-small btn-primary"
                            onClick={() => void handleMergeWorktree(selectedTask.id)}
                          >
                            <GitMerge size={12} />
                            <span>{ft('platform.mergeWorktree')}</span>
                          </button>
                          <button
                            type="button"
                            className="btn btn-small danger"
                            onClick={() => void handleDiscardWorktree(selectedTask.id, diffResult.branch)}
                          >
                            <Trash2 size={12} />
                            <span>{ft('platform.discardWorktree')}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {!diffResult || diffResult.items.length === 0 ? (
                      <div className="platform-insp-empty">{ft('platform.diffEmpty')}</div>
                    ) : (
                      <div className="platform-diff-list">
                        {diffResult.items.map((item) => (
                          <details key={item.path} className="platform-diff-item" open>
                            <summary>
                              <span className="platform-diff-path">{item.path}</span>
                              <span className="chat-diff-pill">
                                {item.additions > 0 && <em className="add">+{item.additions}</em>}
                                {item.deletions > 0 && <em className="del">-{item.deletions}</em>}
                              </span>
                            </summary>
                            {renderDiffText(item.diff)}
                          </details>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
