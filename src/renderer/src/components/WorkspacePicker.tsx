import { useEffect, useRef, useState } from 'react'
import { useAnchoredPopover, useDismissPopover } from '../lib/popover.ts'
import { Check, ChevronDown, FolderOpen, FolderPlus, FolderTree, ExternalLink, GitBranchPlus, Unlink, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitRepoStatus } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { newChat } from '../lib/chats.ts'
import { getState, refreshKnowledgeAndMemory, setState, toast, useStore } from '../lib/store.ts'

export function folderName(path: string | undefined): string | undefined {
  return path?.split(/[\\/]/).filter(Boolean).pop()
}

function normPath(path: string | undefined): string {
  if (!path) return ''
  const clean = path.replace(/[\\/]+$/, '')
  return navigator.userAgent.includes('Windows') ? clean.toLowerCase() : clean
}

export async function setWorkspace(folder: string | undefined, opts?: { rebindActiveChat?: boolean }): Promise<void> {
  try {
    const rebind = opts?.rebindActiveChat ?? true
    const activeId = getState().activeChatId
    const activeConv = activeId ? getState().conversations[activeId] : undefined
    const activeMeta = activeId ? getState().chats.find((c) => c.id === activeId) : undefined
    const isActiveLocked = Boolean(
      activeId &&
        ((activeConv?.messages.length ?? activeMeta?.messageCount ?? 0) > 0 ||
          Boolean(activeConv?.worktreeBranch ?? activeMeta?.worktreeBranch) ||
          Boolean(activeConv?.workspace ?? activeMeta?.workspace)),
    )
    const [settings, sessionAllows] = await Promise.all([
      call('settings.update', { workspace: folder ?? '' }),
      call('agent.allows', folder ?? '').catch(() => [] as string[]),
    ])
    const shouldBind = Boolean(activeId && !isActiveLocked && rebind)
    if (activeId && shouldBind) {
      await call('chats.setWorkspace', activeId, folder).catch(() => undefined)
      setState((s) => {
        const conv = s.conversations[activeId]
        return {
          settings,
          sessionAllows,
          ...(conv ? { conversations: { ...s.conversations, [activeId]: { ...conv, workspace: folder } } } : {}),
        }
      })
    } else {
      setState({ settings, sessionAllows, ...(!folder ? { newChatUseWorktree: false } : {}) })
    }
    void refreshKnowledgeAndMemory(folder)
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export async function pickWorkspace(opts?: { rebindActiveChat?: boolean }): Promise<string | undefined> {
  const folder = await shell.pickFolder()
  if (!folder) return undefined
  await setWorkspace(folder, opts)
  return folder
}

export async function removeRecentWorkspace(folder: string): Promise<void> {
  const current = getState().settings?.recentWorkspaces ?? []
  const targetKey = normPath(folder)
  const next = current.filter((item) => normPath(item) !== targetKey)
  const isCurrent = normPath(getState().settings?.workspace) === targetKey
  try {
    const patch = isCurrent
      ? { recentWorkspaces: next, workspace: next[0] ?? '' }
      : { recentWorkspaces: next }
    const [settings, sessionAllows] = await Promise.all([
      call('settings.update', patch),
      isCurrent ? call('agent.allows', next[0] ?? '').catch(() => [] as string[]) : Promise.resolve(getState().sessionAllows),
    ])
    setState({ settings, ...(isCurrent ? { sessionAllows } : {}) })
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

export function WorkspacePicker({
  variant = 'chip',
  direction = 'up',
  onOpenFiles,
}: {
  variant?: 'sidebar' | 'chip'
  direction?: 'up' | 'down'
  onOpenFiles?: () => void
}) {
  const { t } = useTranslation()
  const workspace = useStore((s) => s.settings?.workspace)
  const recents = useStore((s) => s.settings?.recentWorkspaces ?? [])
  const [open, setOpen] = useState(false)
  const [gitInfo, setGitInfo] = useState<GitRepoStatus | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const name = folderName(workspace)

  useEffect(() => {
    if (!open || !workspace) {
      setGitInfo(null)
      return
    }
    let active = true
    void call('workspace.gitInfo', workspace)
      .then((info) => {
        if (active) setGitInfo(info)
      })
      .catch(() => {
        if (active) setGitInfo(null)
      })
    return () => {
      active = false
    }
  }, [open, workspace])

  useDismissPopover(wrapRef, open, () => setOpen(false))
  const popStyle = useAnchoredPopover(wrapRef, popRef, open && variant === 'chip', {
    width: 308,
    direction,
    align: 'left',
    maxHeight: 430,
  })

  const allPaths = workspace && !recents.includes(workspace) ? [workspace, ...recents] : recents

  return (
    <div className={`workspace-picker variant-${variant} dir-${direction}${open ? ' open' : ''}`} ref={wrapRef}>
      {variant === 'sidebar' ? (
        <button
          type="button"
          className={`side-workspace-btn${workspace ? '' : ' unset'}${open ? ' open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={workspace ?? t('chat.noWorkspace')}
        >
          <span className="side-ws-icon" aria-hidden="true">
            <FolderOpen size={14} strokeWidth={1.85} />
          </span>
          <span className="side-ws-text">
            <span className="side-ws-label">{t('chat.workspaceTitle')}</span>
            <span className="side-ws-name">{name ?? t('chat.pickWorkspace')}</span>
          </span>
          <ChevronDown size={14} className="side-ws-chev" />
        </button>
      ) : (
        <button
          type="button"
          className={`tool-chip workspace-chip${workspace ? '' : ' unset'}${open ? ' open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={workspace ?? t('chat.noWorkspace')}
        >
          <FolderOpen size={14} />
          <span>{name ?? t('chat.pickWorkspace')}</span>
          <ChevronDown size={12} className="workspace-chip-chev" />
        </button>
      )}

      <div ref={popRef} style={variant === 'chip' ? popStyle : undefined} className="workspace-popover" role="menu" aria-label={t('chat.workspaceTitle')}>
        {workspace ? (
          <div className="ws-current-card">
            <div className="ws-current-head">
              <span className="ws-current-badge">
                <FolderOpen size={13} />
              </span>
              <div className="ws-current-meta">
                <strong>{name}</strong>
                <span className="mono">{workspace}</span>
              </div>
            </div>
            <div className="ws-current-actions">
              {onOpenFiles && (
                <button
                  type="button"
                  className="ws-quick-btn"
                  onClick={() => {
                    setOpen(false)
                    onOpenFiles()
                  }}
                >
                  <FolderTree size={12} />
                  <span>{t('chat.browseFiles')}</span>
                </button>
              )}
              {gitInfo?.isRepo && (
                <button
                  type="button"
                  className="ws-quick-btn"
                  onClick={() => {
                    setOpen(false)
                    void newChat({ workspace, useWorktree: true }).catch((err) => toast(errorMessage(err), 'error'))
                  }}
                  title={t('studio.newWorktreeHint')}
                >
                  <GitBranchPlus size={12} />
                  <span>{t('studio.newWorktree')}</span>
                </button>
              )}
              <button
                type="button"
                className="ws-quick-btn"
                onClick={() => {
                  setOpen(false)
                  void setWorkspace(undefined)
                }}
              >
                <Unlink size={12} />
                <span>{t('chat.detachWorkspace')}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="ws-empty-note">{t('chat.noWorkspace')}</div>
        )}

        {allPaths.length > 0 && (
          <div className="ws-recents">
            <div className="ws-section-head">{t('chat.recentWorkspaces')}</div>
            <div className="ws-recent-list">
              {allPaths.map((dir) => {
                const isCurrent = dir === workspace
                const label = folderName(dir) ?? dir
                return (
                  <div key={dir} className={`ws-recent-row${isCurrent ? ' active' : ''}`}>
                    <button
                      type="button"
                      className="ws-recent-pick"
                      onClick={() => {
                        setOpen(false)
                        if (!isCurrent) void setWorkspace(dir)
                      }}
                      title={dir}
                    >
                      <FolderOpen size={13} className="ws-recent-icon" />
                      <span className="ws-recent-text">
                        <strong>{label}</strong>
                        <span className="mono">{dir}</span>
                      </span>
                      {isCurrent && <Check size={13} className="ws-recent-check" />}
                    </button>
                    {!isCurrent && (
                      <button
                        type="button"
                        className="ws-recent-remove"
                        aria-label={t('common.remove')}
                        onClick={() => void removeRecentWorkspace(dir)}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="ws-popover-foot">
          <button
            type="button"
            className="ws-choose-btn"
            onClick={() => {
              setOpen(false)
              void pickWorkspace()
            }}
          >
            <FolderPlus size={14} />
            <span>{t('chat.chooseAnotherFolder')}</span>
          </button>
          <button
            type="button"
            className="ws-choose-btn"
            onClick={() => {
              setOpen(false)
              void shell.newWindow()
            }}
          >
            <ExternalLink size={14} />
            <span>{t('nav.newWindow')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
