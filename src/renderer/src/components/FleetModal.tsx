import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Eye,
  GitBranch,
  GitFork,
  GitMerge,
  Globe,
  MessageSquare,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import type { FleetDiffResult, FleetTaskDraft, FleetWorkerSnapshot } from '@shared/studio_features.ts'
import { call, errorMessage } from '../lib/api.ts'
import { openChat, stopChat } from '../lib/chats.ts'
import { closeFleetModal, requestOpenBrowserDrawer, setState, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { folderName } from './WorkspacePicker.tsx'

function renderDiffText(diff: string) {
  if (!diff.trim()) return null
  return (
    <pre className="fleet-diff-code">
      {diff.split(/\r?\n/).map((line, idx) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
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

export function FleetModal() {
  const ft = useFeatureText()
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const settings = useStore((s) => s.settings)
  const changesRevision = useStore((s) => s.changesRevision)
  const liveBusyKey = useStore((s) => Object.keys(s.live).filter((id) => s.live[id]?.busy).join(','))
  const liveApprovalKey = useStore((s) =>
    Object.keys(s.live)
      .filter((id) => (s.live[id]?.approvals.length ?? 0) > 0)
      .join(','),
  )

  const activeMeta = chats.find((c) => c.id === activeChatId)
  const baseWorkspace = activeMeta?.worktreeBaseWorkspace ?? activeMeta?.workspace ?? settings?.workspace

  const [workers, setWorkers] = useState<FleetWorkerSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [isGitRepo, setIsGitRepo] = useState(true)
  const [tasks, setTasks] = useState<FleetTaskDraft[]>([{ prompt: '', branchName: '' }])
  const [launching, setLaunching] = useState(false)
  const [diffsByChat, setDiffsByChat] = useState<Record<string, FleetDiffResult>>({})
  const [openDiffIds, setOpenDiffIds] = useState<Record<string, boolean>>({})
  const [loadingDiffId, setLoadingDiffId] = useState<string | null>(null)
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [gitInfo, list] = await Promise.all([
        baseWorkspace ? call('workspace.gitInfo', baseWorkspace).catch(() => ({ isRepo: false, dirtyCount: 0 })) : Promise.resolve({ isRepo: false, dirtyCount: 0 }),
        call('fleet.list', baseWorkspace),
      ])
      setIsGitRepo(Boolean(gitInfo.isRepo))
      setWorkers(list)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setLoading(false)
    }
  }, [baseWorkspace])

  useEffect(() => {
    void refresh()
  }, [refresh, changesRevision, chats.length, liveBusyKey, liveApprovalKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeFleetModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const validTaskCount = tasks.filter((t) => t.prompt.trim().length > 0).length
  const runningCount = workers.filter((w) => w.status === 'running').length
  const approvalCount = workers.filter((w) => w.status === 'waiting_approval').length

  const updateTaskRow = (idx: number, patch: Partial<FleetTaskDraft>) => {
    setTasks((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)))
  }

  const addTaskRow = () => {
    if (tasks.length >= 6) return
    setTasks((prev) => [...prev, { prompt: '', branchName: '' }])
  }

  const removeTaskRow = (idx: number) => {
    setTasks((prev) => (prev.length <= 1 ? [{ prompt: '', branchName: '' }] : prev.filter((_, i) => i !== idx)))
  }

  const handleLaunch = async () => {
    if (!baseWorkspace || validTaskCount === 0 || launching) return
    setLaunching(true)
    try {
      const res = await call('fleet.launch', { baseWorkspace, tasks })
      if (res.errors.length > 0) {
        toast(res.errors.map((e) => e.error).join('; '), 'error')
      }
      if (res.launched.length > 0) {
        toast(ft('fleet.launchedToast', { count: res.launched.length }))
        setTasks([{ prompt: '', branchName: '' }])
        setState((s) => ({ chats: s.chats, changesRevision: s.changesRevision + 1 }))
        await refresh()
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setLaunching(false)
    }
  }

  const toggleDiff = async (cid: string) => {
    const nextOpen = !openDiffIds[cid]
    setOpenDiffIds((prev) => ({ ...prev, [cid]: nextOpen }))
    if (nextOpen) {
      setLoadingDiffId(cid)
      try {
        const res = await call('fleet.diff', cid)
        setDiffsByChat((prev) => ({ ...prev, [cid]: res }))
      } catch (err) {
        toast(errorMessage(err), 'error')
      } finally {
        setLoadingDiffId(null)
      }
    }
  }

  const handleMerge = async (w: FleetWorkerSnapshot) => {
    if (mergingId) return
    setMergingId(w.conversationId)
    try {
      const res = await call('fleet.merge', w.conversationId, { cleanupWorktree: true })
      toast(ft('fleet.mergedToast', { branch: res.branch, base: res.baseBranch || 'HEAD' }))
      setState((s) => ({ changesRevision: s.changesRevision + 1 }))
      await refresh()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setMergingId(null)
    }
  }

  const handleDiscard = async (w: FleetWorkerSnapshot) => {
    if (confirmDiscardId !== w.conversationId) {
      setConfirmDiscardId(w.conversationId)
      return
    }
    setConfirmDiscardId(null)
    try {
      await call('fleet.discard', w.conversationId)
      toast(ft('fleet.discardedToast', { branch: w.branch }))
      await refresh()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleStopAll = async () => {
    try {
      const count = await call('fleet.stopAll', baseWorkspace)
      toast(ft('fleet.stoppedAllToast', { count }))
      await refresh()
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const statusLabel = (s: FleetWorkerSnapshot['status']) => {
    if (s === 'running') return ft('fleet.statusRunning')
    if (s === 'waiting_approval') return ft('fleet.statusApproval')
    if (s === 'error') return ft('fleet.statusError')
    return ft('fleet.statusIdle')
  }

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeFleetModal()}>
      <div className="feature-modal" role="dialog" aria-modal="true" aria-label={ft('fleet.title')}>
        <header className="feature-modal-head">
          <div className="feature-modal-title-wrap">
            <span className="feature-modal-ico">
              <GitFork size={17} />
            </span>
            <div>
              <h2 className="feature-modal-title">{ft('fleet.title')}</h2>
              <p className="feature-modal-sub">
                {baseWorkspace ? `${folderName(baseWorkspace) ?? baseWorkspace} · ` : ''}
                {ft('fleet.subtitle')}
              </p>
            </div>
          </div>
          <div className="feature-modal-head-acts">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => void refresh()}
              disabled={loading}
              title={ft('fleet.refresh')}
            >
              <RefreshCw size={13} className={loading ? 'spin' : undefined} />
              <span>{ft('fleet.refresh')}</span>
            </button>
            {runningCount > 0 && (
              <button type="button" className="btn btn-small" onClick={() => void handleStopAll()}>
                <Square size={12} />
                <span>{ft('fleet.stopAll')}</span>
              </button>
            )}
            <button type="button" className="icon-btn" onClick={closeFleetModal} aria-label={ft('fleet.close')}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="feature-modal-body">
          {!baseWorkspace ? (
            <div className="feature-banner warn">{ft('fleet.noWorkspace')}</div>
          ) : !isGitRepo ? (
            <div className="feature-banner warn">{ft('fleet.notGitRepo')}</div>
          ) : (
            <>
              <div className="fleet-stats-row">
                <span className="fleet-stat-chip">
                  <GitBranch size={12} />
                  <span>{ft('fleet.statsTotal', { count: workers.length })}</span>
                </span>
                <span className={`fleet-stat-chip${runningCount > 0 ? ' running' : ''}`}>
                  <span className={`fleet-dot${runningCount > 0 ? ' pulse' : ''}`} />
                  <span>{ft('fleet.statsRunning', { count: runningCount })}</span>
                </span>
                {approvalCount > 0 && (
                  <span className="fleet-stat-chip approval">
                    <span className="fleet-dot pulse" />
                    <span>{ft('fleet.statsApproval', { count: approvalCount })}</span>
                  </span>
                )}
              </div>

              <section className="fleet-launcher">
                <div className="fleet-launcher-head">
                  <span>{ft('fleet.launchTitle')}</span>
                  {tasks.length < 6 && (
                    <button type="button" className="btn btn-small" onClick={addTaskRow}>
                      <Plus size={13} />
                      <span>{ft('fleet.addTask')}</span>
                    </button>
                  )}
                </div>

                <div className="fleet-task-rows">
                  {tasks.map((row, i) => (
                    <div key={i} className="fleet-task-row">
                      <input
                        className="fleet-input"
                        value={row.prompt}
                        onChange={(e) => updateTaskRow(i, { prompt: e.target.value })}
                        placeholder={ft('fleet.taskPlaceholder')}
                      />
                      <input
                        className="fleet-input fleet-task-branch"
                        value={row.branchName ?? ''}
                        onChange={(e) => updateTaskRow(i, { branchName: e.target.value })}
                        placeholder={ft('fleet.branchPlaceholder')}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => removeTaskRow(i)}
                        aria-label={ft('fleet.discard')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="fleet-launcher-foot">
                  <span className="muted small">{baseWorkspace}</span>
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    disabled={launching || validTaskCount === 0}
                    onClick={() => void handleLaunch()}
                  >
                    <GitFork size={13} />
                    <span>
                      {launching ? ft('fleet.launching') : ft('fleet.launchBtn', { count: validTaskCount || 1 })}
                    </span>
                  </button>
                </div>
              </section>
            </>
          )}

          <section className="fleet-workers">
            {workers.length === 0 ? (
              <div className="feature-banner">{ft('fleet.emptyWorkers')}</div>
            ) : (
              workers.map((w) => {
                const isDiffOpen = Boolean(openDiffIds[w.conversationId])
                const diffResult = diffsByChat[w.conversationId]
                return (
                  <article key={w.conversationId} className="fleet-card">
                    <div className="fleet-card-top">
                      <div className="fleet-card-title-wrap">
                        <div className="fleet-card-title-row">
                          <span className={`fleet-status-pill ${w.status}`}>
                            <span className={`fleet-dot${w.status === 'running' ? ' pulse' : ''}`} />
                            <span>{statusLabel(w.status)}</span>
                          </span>
                          <span className="fleet-card-title">{w.title}</span>
                        </div>
                        <div className="fleet-card-meta">
                          <span className="fleet-branch-badge">
                            <GitBranch size={11} />
                            <span>
                              {w.branch}
                              {w.baseBranch ? ` → ${w.baseBranch}` : ''}
                            </span>
                          </span>
                          <span>
                            {w.changedFiles > 0 ? ft('fleet.filesChanged', { count: w.changedFiles }) : ft('fleet.noChangesYet')}
                          </span>
                          {(w.additions > 0 || w.deletions > 0) && (
                            <span className="studio-stat-pills">
                              {w.additions > 0 && <span className="stat-add">+{w.additions}</span>}
                              {w.deletions > 0 && <span className="stat-del">-{w.deletions}</span>}
                            </span>
                          )}
                          {w.previewUrl && (
                            <button
                              type="button"
                              className="btn btn-small"
                              onClick={() => {
                                void openChat(w.conversationId)
                                requestOpenBrowserDrawer()
                                closeFleetModal()
                              }}
                              title={w.previewUrl}
                            >
                              <Globe size={12} />
                              <span>{ft('fleet.previewLive')}</span>
                            </button>
                          )}
                        </div>
                        {w.lastSnippet && <div className="fleet-card-snippet">{w.lastSnippet}</div>}
                      </div>

                      <div className="fleet-card-acts">
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => {
                            void openChat(w.conversationId)
                            closeFleetModal()
                          }}
                        >
                          <MessageSquare size={12} />
                          <span>{ft('fleet.openChat')}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => void toggleDiff(w.conversationId)}
                        >
                          <Eye size={12} />
                          <span>{isDiffOpen ? ft('fleet.hideDiff') : ft('fleet.inspectDiff')}</span>
                        </button>
                        {w.status === 'running' && (
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => void stopChat(w.conversationId).then(() => refresh())}
                          >
                            <Square size={12} />
                            <span>{ft('fleet.stop')}</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          disabled={w.status === 'running' || mergingId === w.conversationId}
                          onClick={() => void handleMerge(w)}
                        >
                          <GitMerge size={12} />
                          <span>{mergingId === w.conversationId ? ft('fleet.merging') : ft('fleet.merge')}</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-small"
                          style={
                            confirmDiscardId === w.conversationId
                              ? { borderColor: 'var(--danger)', color: 'var(--danger)' }
                              : undefined
                          }
                          onClick={() => void handleDiscard(w)}
                        >
                          <Trash2 size={12} />
                          <span>
                            {confirmDiscardId === w.conversationId ? ft('fleet.discardConfirm') : ft('fleet.discard')}
                          </span>
                        </button>
                      </div>
                    </div>

                    {isDiffOpen && (
                      <div className="fleet-diff-panel">
                        {loadingDiffId === w.conversationId && !diffResult ? (
                          <div className="muted small">{ft('fleet.loadingDiff')}</div>
                        ) : diffResult && diffResult.files.length > 0 ? (
                          diffResult.files.map((file) => (
                            <div key={file.path} className="fleet-diff-file">
                              <div className="fleet-diff-file-head">
                                <span>
                                  [{file.status}] {file.path}
                                </span>
                                <span className="studio-stat-pills">
                                  {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
                                  {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
                                </span>
                              </div>
                              {renderDiffText(file.diff)}
                            </div>
                          ))
                        ) : (
                          <div className="muted small">{ft('fleet.noChangesYet')}</div>
                        )}
                      </div>
                    )}
                  </article>
                )
              })
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
