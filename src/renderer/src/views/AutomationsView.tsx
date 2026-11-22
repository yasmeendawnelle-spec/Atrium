import { useEffect, useState } from 'react'
import {
  ChevronRight,
  Clock,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AutomationDraft, AutomationRule, AutomationSchedule } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { openChat } from '../lib/chats.ts'
import { setState, toast, useStore } from '../lib/store.ts'
import { ConfirmDialog, Dialog } from '../components/Dialog.tsx'
import { Oculus } from '../components/Oculus.tsx'
import { folderName } from '../components/WorkspacePicker.tsx'

function formatTime(ms?: number): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

function scheduleLabel(schedule: AutomationSchedule): string {
  if (schedule.kind === 'cron') return `Cron: ${schedule.expr}`
  if (schedule.minutes >= 60 && schedule.minutes % 60 === 0) {
    return `Every ${schedule.minutes / 60}h`
  }
  return `Every ${schedule.minutes}m`
}

interface RuleFormState {
  id?: string
  name: string
  prompt: string
  workspace: string
  useWorktree: boolean
  agentMode: 'auto' | 'plan'
  scheduleKind: 'cron' | 'interval'
  cronExpr: string
  intervalMinutes: number
  enabled: boolean
  notifyOnComplete: boolean
}

function emptyForm(defaultWorkspace?: string): RuleFormState {
  return {
    name: '',
    prompt: '',
    workspace: defaultWorkspace ?? '',
    useWorktree: false,
    agentMode: 'auto',
    scheduleKind: 'cron',
    cronExpr: '0 9 * * *',
    intervalMinutes: 60,
    enabled: true,
    notifyOnComplete: true,
  }
}

function formFromRule(rule: AutomationRule): RuleFormState {
  return {
    id: rule.id,
    name: rule.name,
    prompt: rule.prompt,
    workspace: rule.workspace ?? '',
    useWorktree: Boolean(rule.useWorktree),
    agentMode: rule.agentMode === 'plan' ? 'plan' : 'auto',
    scheduleKind: rule.schedule.kind,
    cronExpr: rule.schedule.kind === 'cron' ? rule.schedule.expr : '0 9 * * *',
    intervalMinutes: rule.schedule.kind === 'interval' ? rule.schedule.minutes : 60,
    enabled: rule.enabled,
    notifyOnComplete: rule.notifyOnComplete !== false,
  }
}

export function AutomationsView() {
  const { t } = useTranslation()
  const rules = useStore((s) => s.automations)
  const defaultWorkspace = useStore((s) => s.settings?.workspace)
  const [modal, setModal] = useState<RuleFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [cronPreview, setCronPreview] = useState<{ valid: boolean; nextRuns: number[]; error?: string }>({
    valid: true,
    nextRuns: [],
  })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AutomationRule | null>(null)

  useEffect(() => {
    void call('automations.list')
      .then((list) => setState({ automations: list }))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!modal || modal.scheduleKind !== 'cron') return
    let active = true
    const timer = setTimeout(() => {
      void call('automations.previewCron', modal.cronExpr, 3)
        .then((res) => {
          if (active) setCronPreview(res)
        })
        .catch(() => undefined)
    }, 120)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [modal?.scheduleKind, modal?.cronExpr, Boolean(modal)])

  const enabledCount = rules.filter((r) => r.enabled).length

  const presets = [
    {
      key: 'daily',
      title: t('automations.tplDailyTitle'),
      desc: t('automations.tplDailyDesc'),
      draft: {
        ...emptyForm(defaultWorkspace),
        name: t('automations.tplDailyTitle'),
        prompt: t('automations.tplDailyPrompt'),
        scheduleKind: 'cron' as const,
        cronExpr: '0 9 * * *',
        agentMode: 'plan' as const,
      },
    },
    {
      key: 'test',
      title: t('automations.tplTestTitle'),
      desc: t('automations.tplTestDesc'),
      draft: {
        ...emptyForm(defaultWorkspace),
        name: t('automations.tplTestTitle'),
        prompt: t('automations.tplTestPrompt'),
        scheduleKind: 'interval' as const,
        intervalMinutes: 360,
        agentMode: 'auto' as const,
        useWorktree: false,
      },
    },
    {
      key: 'audit',
      title: t('automations.tplAuditTitle'),
      desc: t('automations.tplAuditDesc'),
      draft: {
        ...emptyForm(defaultWorkspace),
        name: t('automations.tplAuditTitle'),
        prompt: t('automations.tplAuditPrompt'),
        scheduleKind: 'cron' as const,
        cronExpr: '0 10 * * 1',
        agentMode: 'plan' as const,
      },
    },
  ]

  const saveForm = async () => {
    if (!modal) return
    if (modal.scheduleKind === 'cron' && !cronPreview.valid) {
      toast(cronPreview.error || t('automations.cronInvalid'), 'error')
      return
    }
    setSaving(true)
    try {
      const draft: AutomationDraft = {
        ...(modal.id ? { id: modal.id } : {}),
        name: modal.name.trim(),
        prompt: modal.prompt.trim(),
        workspace: modal.workspace.trim() || undefined,
        useWorktree: modal.useWorktree,
        agentMode: modal.agentMode,
        schedule:
          modal.scheduleKind === 'cron'
            ? { kind: 'cron', expr: modal.cronExpr.trim() }
            : { kind: 'interval', minutes: Math.max(1, Math.round(Number(modal.intervalMinutes) || 60)) },
        enabled: modal.enabled,
        notifyOnComplete: modal.notifyOnComplete,
      }
      const saved = await call('automations.save', draft)
      setState({ automations: await call('automations.list') })
      setModal(null)
      toast(t('automations.saved', { name: saved.name }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (rule: AutomationRule, enabled: boolean) => {
    try {
      await call('automations.setEnabled', rule.id, enabled)
      setState({ automations: await call('automations.list') })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const runNow = async (rule: AutomationRule) => {
    try {
      await call('automations.runNow', rule.id)
      setState({ automations: await call('automations.list') })
      toast(t('automations.runningNow'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="display">{t('automations.title')}</h1>
          <p className="page-intro">{t('automations.intro')}</p>
          {rules.length > 0 && (
            <div className="summary-pills">
              <span className="summary-pill">
                <span className={`dot ${enabledCount > 0 ? 'dot-connected' : ''}`} aria-hidden />
                {t('automations.activeSummary', { enabled: enabledCount, total: rules.length })}
              </span>
            </div>
          )}
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setModal(emptyForm(defaultWorkspace))}
          >
            <Plus size={14} />
            <span>{t('automations.newBtn')}</span>
          </button>
        </div>
      </header>

      {rules.length === 0 ? (
        <div className="empty-state">
          <Oculus state="idle" size={64} />
          <h2 className="display">{t('automations.emptyTitle')}</h2>
          <p>{t('automations.emptyHint')}</p>
          <div className="auto-template-grid">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                className="auto-template-card"
                onClick={() => setModal(p.draft)}
              >
                <Sparkles size={15} />
                <strong>{p.title}</strong>
                <span>{p.desc}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <ul className="rows">
          {rules.map((rule) => {
            const expanded = expandedId === rule.id
            const statusKey =
              rule.lastStatus === 'running'
                ? 'connecting'
                : rule.lastStatus === 'error'
                  ? 'error'
                  : rule.enabled
                    ? 'connected'
                    : 'off'
            const statusText =
              rule.lastStatus === 'running'
                ? t('automations.statusRunning')
                : rule.lastStatus === 'error'
                  ? t('automations.statusError')
                  : rule.lastStatus === 'truncated'
                    ? t('automations.statusTruncated')
                    : rule.lastStatus === 'aborted'
                      ? t('automations.statusAborted')
                      : rule.lastStatus === 'done'
                        ? t('automations.statusDone')
                        : rule.enabled
                          ? t('connections.state.connected')
                          : t('automations.paused')
            const history = rule.history ?? []

            return (
              <li key={rule.id} className="row auto-row">
                <div className="auto-icon-badge" aria-hidden="true">
                  <Clock size={18} />
                </div>
                <div className="row-main">
                  <button
                    type="button"
                    className="row-toggle"
                    onClick={() => setExpandedId(expanded ? null : rule.id)}
                    aria-expanded={expanded}
                  >
                    <ChevronRight size={14} className={`chev${expanded ? ' open' : ''}`} />
                    <span className="row-title">{rule.name}</span>
                    <span className={`chip chip-${statusKey}`}>
                      <span className={`dot dot-${statusKey}`} aria-hidden />
                      {statusText}
                    </span>
                    {rule.useWorktree && (
                      <span className="auto-badge">
                        <GitBranch size={11} />
                        {t('automations.worktreeBadge')}
                      </span>
                    )}
                    <span className="row-meta">{scheduleLabel(rule.schedule)}</span>
                  </button>
                  <div className="auto-meta-line">
                    <span>
                      {rule.workspace ? folderName(rule.workspace) : t('automations.workspaceInherit')}
                    </span>
                    <span>·</span>
                    <span>
                      {rule.enabled && rule.nextRunAt
                        ? t('automations.nextRun', { time: formatTime(rule.nextRunAt) })
                        : t('automations.paused')}
                    </span>
                    <span>·</span>
                    <span>
                      {rule.lastRunAt
                        ? t('automations.lastRun', { time: formatTime(rule.lastRunAt) })
                        : t('automations.neverRun')}
                    </span>
                    {history.length > 0 && (
                      <>
                        <span>·</span>
                        <span>{t('automations.historyBtn', { count: history.length })}</span>
                      </>
                    )}
                  </div>
                  {rule.lastError && <p className="row-error">{rule.lastError}</p>}
                  {!rule.lastError && rule.lastSummary && (
                    <p className="auto-summary-preview">{rule.lastSummary}</p>
                  )}
                </div>
                <div className="row-actions">
                  <label className="switch" title={t('automations.enabledLabel')}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => void toggleEnabled(rule, e.target.checked)}
                    />
                    <span />
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={rule.lastStatus === 'running'}
                    onClick={() => void runNow(rule)}
                    title={t('automations.runNow')}
                    aria-label={t('automations.runNow')}
                  >
                    <Play size={14} />
                  </button>
                  {rule.lastConversationId && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => void openChat(rule.lastConversationId!)}
                      title={t('automations.openChat')}
                      aria-label={t('automations.openChat')}
                    >
                      <MessageSquare size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setModal(formFromRule(rule))}
                    aria-label={t('common.edit')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={() => setConfirmDelete(rule)}
                    aria-label={t('common.remove')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div className={`row-expand${expanded ? ' open' : ''}`}>
                  <div className="row-expand-inner">
                    <div className="row-detail auto-detail">
                      <p className="auto-prompt-box">{rule.prompt}</p>
                      {history.length > 0 && (
                        <ul className="auto-history-list">
                          {history.map((run) => (
                            <li key={run.runId} className="auto-history-item">
                              <span className={`chip chip-${run.status === 'error' ? 'error' : run.status === 'running' ? 'connecting' : 'connected'}`}>
                                {run.status}
                              </span>
                              <span className="auto-history-time">{formatTime(run.startedAt)}</span>
                              <span className="auto-history-text">
                                {run.error || run.summary || '—'}
                              </span>
                              {run.conversationId && (
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  onClick={() => void openChat(run.conversationId!)}
                                >
                                  <MessageSquare size={12} />
                                  <span>{t('automations.openChat')}</span>
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {modal && (
        <Dialog
          title={modal.id ? t('automations.editTitle') : t('automations.createTitle')}
          onClose={() => !saving && setModal(null)}
          wide
        >
          <div className="auto-modal-form">
            <label className="field">
              <span>{t('automations.nameLabel')}</span>
              <input
                className="input"
                value={modal.name}
                onChange={(e) => setModal({ ...modal, name: e.target.value })}
                placeholder={t('automations.namePlaceholder')}
                autoFocus
              />
            </label>

            <label className="field">
              <span>{t('automations.promptLabel')}</span>
              <textarea
                className="input"
                rows={4}
                value={modal.prompt}
                onChange={(e) => setModal({ ...modal, prompt: e.target.value })}
                placeholder={t('automations.promptPlaceholder')}
              />
            </label>

            <div className="field">
              <span>{t('automations.workspaceLabel')}</span>
              <div className="auto-ws-row">
                <input
                  className="input mono"
                  value={modal.workspace}
                  onChange={(e) => setModal({ ...modal, workspace: e.target.value })}
                  placeholder={defaultWorkspace || t('automations.workspaceInherit')}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void shell.pickFolder().then((folder) => {
                      if (folder) setModal((cur) => (cur ? { ...cur, workspace: folder } : cur))
                    })
                  }}
                >
                  <FolderOpen size={14} />
                  <span>{t('settings.chooseFolder')}</span>
                </button>
              </div>
            </div>

            <div className="field">
              <span>{t('automations.scheduleKind')}</span>
              <div className="seg" role="radiogroup">
                <button
                  type="button"
                  role="radio"
                  aria-checked={modal.scheduleKind === 'cron'}
                  className={`seg-btn${modal.scheduleKind === 'cron' ? ' active' : ''}`}
                  onClick={() => setModal({ ...modal, scheduleKind: 'cron' })}
                >
                  {t('automations.kindCron')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={modal.scheduleKind === 'interval'}
                  className={`seg-btn${modal.scheduleKind === 'interval' ? ' active' : ''}`}
                  onClick={() => setModal({ ...modal, scheduleKind: 'interval' })}
                >
                  {t('automations.kindInterval')}
                </button>
              </div>
            </div>

            {modal.scheduleKind === 'cron' ? (
              <div className="field">
                <span>{t('automations.cronExpr')}</span>
                <input
                  className="input mono"
                  value={modal.cronExpr}
                  onChange={(e) => setModal({ ...modal, cronExpr: e.target.value })}
                  placeholder="0 9 * * *"
                />
                <div className="auto-preset-pills">
                  {[
                    { label: t('automations.presetDaily9'), expr: '0 9 * * *' },
                    { label: t('automations.presetWeekdays930'), expr: '30 9 * * 1-5' },
                    { label: t('automations.presetHourly'), expr: '0 * * * *' },
                    { label: t('automations.presetMon10'), expr: '0 10 * * 1' },
                  ].map((p) => (
                    <button
                      key={p.expr}
                      type="button"
                      className={`btn btn-small${modal.cronExpr.trim() === p.expr ? ' btn-primary' : ''}`}
                      onClick={() => setModal({ ...modal, cronExpr: p.expr })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {cronPreview.valid ? (
                  <div className="auto-cron-preview">
                    <strong>{t('automations.cronNextRuns')}:</strong>{' '}
                    {cronPreview.nextRuns.map((ts) => formatTime(ts)).join(' · ')}
                  </div>
                ) : (
                  <p className="row-error">{cronPreview.error || t('automations.cronInvalid')}</p>
                )}
              </div>
            ) : (
              <label className="field">
                <span>{t('automations.intervalMinutes')}</span>
                <input
                  type="number"
                  min={1}
                  className="input mono"
                  value={modal.intervalMinutes}
                  onChange={(e) => setModal({ ...modal, intervalMinutes: Number(e.target.value) || 1 })}
                />
              </label>
            )}

            <div className="field">
              <span>{t('automations.modeLabel')}</span>
              <div className="seg" role="radiogroup">
                <button
                  type="button"
                  role="radio"
                  aria-checked={modal.agentMode === 'auto'}
                  className={`seg-btn${modal.agentMode === 'auto' ? ' active' : ''}`}
                  onClick={() => setModal({ ...modal, agentMode: 'auto' })}
                >
                  {t('automations.modeAuto')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={modal.agentMode === 'plan'}
                  className={`seg-btn${modal.agentMode === 'plan' ? ' active' : ''}`}
                  onClick={() => setModal({ ...modal, agentMode: 'plan' })}
                >
                  {t('automations.modePlan')}
                </button>
              </div>
            </div>

            <label className="rewind-check">
              <input
                type="checkbox"
                checked={modal.useWorktree}
                onChange={(e) => setModal({ ...modal, useWorktree: e.target.checked })}
              />
              <span>{t('automations.useWorktree')}</span>
            </label>

            <label className="rewind-check">
              <input
                type="checkbox"
                checked={modal.notifyOnComplete}
                onChange={(e) => setModal({ ...modal, notifyOnComplete: e.target.checked })}
              />
              <span>{t('automations.notifyOnComplete')}</span>
            </label>

            <label className="rewind-check">
              <input
                type="checkbox"
                checked={modal.enabled}
                onChange={(e) => setModal({ ...modal, enabled: e.target.checked })}
              />
              <span>{t('automations.enabledLabel')}</span>
            </label>

            <div className="dialog-actions">
              <button type="button" className="btn" disabled={saving} onClick={() => setModal(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving || !modal.name.trim() || !modal.prompt.trim()}
                onClick={() => void saveForm()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={t('common.remove')}
          message={t('automations.deleteConfirm', { name: confirmDelete.name })}
          confirmLabel={t('common.remove')}
          onConfirm={() => {
            const target = confirmDelete
            setConfirmDelete(null)
            void call('automations.remove', target.id)
              .then(async () => setState({ automations: await call('automations.list') }))
              .catch((err) => toast(errorMessage(err), 'error'))
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </section>
  )
}
