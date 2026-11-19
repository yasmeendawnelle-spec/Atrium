import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  CircleDot,
  ExternalLink,
  Folder,
  Globe,
  LayoutGrid,
  Loader2,
  Monitor,
  Paperclip,
  Plug,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  SquareSlash,
  Store,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitHubIssueSummary, GitRepoStatus, SkillInfo } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { useAnchoredPopover, useDismissPopover } from '../lib/popover.ts'
import {
  navigate,
  setState,
  toast,
  toggleMcpServerEnabled,
  togglePluginEnabled,
  toggleSkillEnabled,
  toggleComputerUseEnabled,
  toggleDesktopControlEnabled,
  toggleWebToolEnabled,
  useStore,
} from '../lib/store.ts'
import { Dialog } from './Dialog.tsx'
import { Tile } from './Tile.tsx'

type PlusSubmenu = 'connectors' | 'plugins' | null

function GitHubMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2C6.475 2 2 6.475 2 12a10.01 10.01 0 0 0 6.838 9.488c.5.087.687-.213.687-.476 0-.237-.013-1.024-.013-1.862-2.512.463-3.162-.612-3.362-1.175-.113-.288-.6-1.175-1.025-1.413-.35-.187-.85-.65-.013-.662.788-.013 1.35.725 1.538 1.025.9 1.512 2.337 1.087 2.912.825.088-.65.35-1.087.638-1.337-2.225-.25-4.55-1.113-4.55-4.938 0-1.087.387-1.987 1.025-2.687-.1-.25-.45-1.275.1-2.65 0 0 .837-.263 2.75 1.024a9.28 9.28 0 0 1 2.5-.337c.85 0 1.7.112 2.5.337 1.912-1.3 2.75-1.024 2.75-1.024.55 1.375.2 2.4.1 2.65.637.7 1.025 1.587 1.025 2.687 0 3.838-2.337 4.688-4.563 4.938.363.312.675.912.675 1.85 0 1.337-.012 2.412-.012 2.75 0 .262.187.574.687.474A10.016 10.016 0 0 0 22 12c0-5.525-4.475-10-10-10Z" />
    </svg>
  )
}

/** Formats an imported GitHub issue into a clean Markdown context block for the composer. */
export function formatGitHubIssuePrompt(repo: string, issue: GitHubIssueSummary): string {
  const header = `[GitHub Issue #${issue.number} (${repo})](${issue.url}): ${issue.title}`
  const metaParts: string[] = []
  if (issue.author) metaParts.push(`Author: @${issue.author}`)
  if (issue.labels.length > 0) metaParts.push(`Labels: ${issue.labels.join(', ')}`)
  const meta = metaParts.length > 0 ? `${metaParts.join(' · ')}\n` : ''
  const rawBody = issue.body.trim()
  const body = rawBody.length > 3500 ? `${rawBody.slice(0, 3500)}\n...(truncated)` : rawBody
  return body ? `${header}\n${meta}\n${body}\n\n` : `${header}\n${meta}\n`
}

function GitHubIssueDialog({
  workspace,
  repo,
  onInsert,
  onClose,
}: {
  workspace?: string
  repo: string
  onInsert: (text: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [issues, setIssues] = useState<GitHubIssueSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadIssues = (q?: string) => {
    setLoading(true)
    setError(null)
    void call('workspace.githubIssues', workspace, q)
      .then((res) => setIssues(res))
      .catch((err) => {
        setIssues([])
        setError(errorMessage(err))
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadIssues()
  }, [workspace, repo])

  return (
    <Dialog title={`${t('chat.githubIssueTitle')} · ${repo}`} onClose={onClose} wide>
      <div className="gh-issue-modal">
        <form
          className="gh-issue-search"
          onSubmit={(e) => {
            e.preventDefault()
            loadIssues(query)
          }}
        >
          <div className="gh-issue-input-wrap">
            <Search size={14} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('chat.githubIssuePlaceholder')}
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn-primary btn-small" disabled={loading}>
            {t('chat.githubIssueLoad')}
          </button>
        </form>

        {loading ? (
          <div className="gh-issue-state">
            <Loader2 size={16} className="spin" />
            <span>{t('chat.githubIssueLoading')}</span>
          </div>
        ) : error ? (
          <div className="gh-issue-state error">{error}</div>
        ) : issues.length === 0 ? (
          <div className="gh-issue-state">{t('chat.githubIssueEmpty')}</div>
        ) : (
          <div className="gh-issue-list">
            {issues.map((issue) => (
              <button
                key={issue.number}
                type="button"
                className="gh-issue-row"
                onClick={() => {
                  onInsert(formatGitHubIssuePrompt(repo, issue))
                  onClose()
                }}
              >
                <span className={`gh-issue-icon ${issue.state}`}>
                  <CircleDot size={14} />
                </span>
                <div className="gh-issue-body">
                  <div className="gh-issue-top">
                    <span className="gh-issue-num">#{issue.number}</span>
                    <strong>{issue.title}</strong>
                  </div>
                  {(issue.labels.length > 0 || issue.author) && (
                    <div className="gh-issue-meta">
                      {issue.author && <span>@{issue.author}</span>}
                      {issue.labels.slice(0, 3).map((label) => (
                        <span key={label} className="gh-issue-label">
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="gh-issue-insert">{t('chat.githubIssueInsert')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function ComposerPlusMenu({
  workspace,
  direction = 'up',
  disabled,
  skills,
  onAddFilesAndPhotos,
  onAddFolder,
  onOpenSlashCommands,
  onInsertText,
}: {
  workspace?: string
  direction?: 'up' | 'down'
  disabled?: boolean
  skills: SkillInfo[]
  onAddFilesAndPhotos: () => void
  onAddFolder?: () => void
  onOpenSlashCommands: () => void
  onInsertText: (text: string) => void
}) {
  const { t } = useTranslation()
  const servers = useStore((s) => s.servers)
  const statuses = useStore((s) => s.statuses)
  const plugins = useStore((s) => s.plugins)
  const discoveredPlugins = useStore((s) => s.discoveredPlugins)
  const webEnabled = useStore((s) => s.settings?.webEnabled !== false)
  const computerUseEnabled = useStore((s) => s.settings?.computerUseEnabled !== false)
  const desktopControlEnabled = useStore(
    (s) => s.settings?.desktopControlEnabled === true || s.settings?.computerUseMode === 'desktop',
  )
  const sessionAllows = useStore((s) => s.sessionAllows)

  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<PlusSubmenu>(null)
  const [inlineSubmenu, setInlineSubmenu] = useState(false)
  const [subStyle, setSubStyle] = useState<CSSProperties | undefined>(undefined)
  const [gitInfo, setGitInfo] = useState<GitRepoStatus | null>(null)
  const [issueDialogRepo, setIssueDialogRepo] = useState<string | null>(null)

  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const closeAll = () => {
    setOpen(false)
    setSubmenu(null)
  }

  useDismissPopover(wrapRef, open, closeAll)
  const popStyle = useAnchoredPopover(wrapRef, popRef, open, {
    width: 278,
    direction,
    align: 'left',
    maxHeight: 420,
  })

  useEffect(() => {
    if (!open) {
      setSubmenu(null)
      return
    }
    if (!workspace) {
      setGitInfo(null)
      return
    }
    let live = true
    void call('workspace.gitInfo', workspace)
      .then((res) => {
        if (live) setGitInfo(res)
      })
      .catch(() => {
        if (live) setGitInfo(null)
      })
    return () => {
      live = false
    }
  }, [open, workspace])

  useLayoutEffect(() => {
    if (!open || !submenu) {
      setInlineSubmenu(false)
      setSubStyle(undefined)
      return
    }
    const updateSub = () => {
      const pop = popRef.current
      if (!pop) return
      const rect = pop.getBoundingClientRect()
      const subW = 316
      const margin = 12
      const gap = 6
      const fitsRight = rect.right + gap + subW <= window.innerWidth - margin
      const fitsLeft = rect.left - gap - subW >= margin
      if (!fitsRight && !fitsLeft) {
        setInlineSubmenu(true)
        setSubStyle(undefined)
        return
      }
      setInlineSubmenu(false)
      const left = fitsRight ? rect.right + gap : rect.left - gap - subW
      if (direction === 'up') {
        const bottom = Math.max(margin, window.innerHeight - rect.bottom)
        const maxHeight = Math.min(380, window.innerHeight - bottom - margin)
        setSubStyle({ left, bottom, maxHeight })
      } else {
        const top = Math.max(margin, rect.top)
        const maxHeight = Math.min(380, window.innerHeight - top - margin)
        setSubStyle({ left, top, maxHeight })
      }
    }
    updateSub()
    window.addEventListener('resize', updateSub)
    return () => window.removeEventListener('resize', updateSub)
  }, [open, submenu, direction])

  const githubRepo = gitInfo?.githubRepo
  const activeConnectors = servers.filter((s) => s.enabled).length + (webEnabled ? 1 : 0) + (computerUseEnabled ? 1 : 0)
  const unimportedPluginsCount = discoveredPlugins.filter((d) => !d.alreadyImported).length
  const activePluginsAndSkills =
    plugins.filter((p) => p.enabled).length +
    skills.filter((s) => s.enabled && s.scope !== 'plugin').length

  const handleToggleWeb = async (checked: boolean) => {
    try {
      await toggleWebToolEnabled(checked)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleToggleComputerUse = async (checked: boolean) => {
    try {
      await toggleComputerUseEnabled(checked)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleToggleDesktopControl = async (checked: boolean) => {
    try {
      await toggleDesktopControlEnabled(checked)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleToggleMcp = async (id: string, checked: boolean) => {
    try {
      await toggleMcpServerEnabled(id, checked)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleToggleSkill = async (name: string, checked: boolean) => {
    try {
      await toggleSkillEnabled(name, checked, workspace)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handleTogglePlugin = async (id: string, checked: boolean) => {
    try {
      await togglePluginEnabled(id, checked, workspace)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const revokeAllows = async () => {
    await call('agent.revokeAllows', workspace).catch(() => undefined)
    setState({ sessionAllows: [] })
    toast(t('chat.trustRevoked'))
  }

  const renderConnectorsSubmenu = () => (
    <div className="plus-sub-inner">
      <div className="plus-sub-head">
        {inlineSubmenu && (
          <button type="button" className="plus-sub-back" onClick={() => setSubmenu(null)} aria-label={t('nav.back')}>
            <ArrowLeft size={13} />
          </button>
        )}
        <span>{t('chat.plusConnectors')}</span>
        <button
          type="button"
          className="tools-head-link"
          onClick={() => {
            closeAll()
            navigate({ view: 'connections', chatId: null })
          }}
        >
          {t('chat.plusManage')}
        </button>
      </div>

      <div className="plus-sub-list">
        <div className="plus-sub-row">
          <span className="tools-builtin-icon">
            <Globe size={14} />
          </span>
          <div className="tools-builtin-meta">
            <strong>{t('chat.webTools')}</strong>
            <span>{t('chat.webToolsSub')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={webEnabled}
              onChange={(e) => void handleToggleWeb(e.target.checked)}
              aria-label={t('chat.webTools')}
            />
            <span />
          </label>
        </div>

        <div className="plus-sub-row">
          <span className="tools-builtin-icon">
            <Globe size={14} />
          </span>
          <div className="tools-builtin-meta">
            <strong>{t('chat.computerTools')}</strong>
            <span>{t('chat.computerToolsSub')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={computerUseEnabled}
              onChange={(e) => void handleToggleComputerUse(e.target.checked)}
              aria-label={t('chat.computerTools')}
            />
            <span />
          </label>
        </div>

        {computerUseEnabled && (
          <div className="plus-sub-row">
            <span className="tools-builtin-icon">
              <Monitor size={14} />
            </span>
            <div className="tools-builtin-meta">
              <strong>{t('chat.desktopControlTools')}</strong>
              <span>{t('chat.desktopControlToolsSub')}</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={desktopControlEnabled}
                onChange={(e) => void handleToggleDesktopControl(e.target.checked)}
                aria-label={t('chat.desktopControlTools')}
              />
              <span />
            </label>
          </div>
        )}

        {sessionAllows.length > 0 && (
          <div className="tools-trust-bar">
            <span className="tools-trust-label">
              <ShieldCheck size={13} />
              <span>
                {t('chat.sessionTrustTitle')}: {sessionAllows.join(', ')}
              </span>
            </span>
            <button type="button" className="tools-head-link" onClick={() => void revokeAllows()}>
              {t('chat.revokeTrust')}
            </button>
          </div>
        )}

        {servers.length > 0 && <div className="plus-sub-divider" />}

        {servers.map((srv) => {
          const st = statuses[srv.id]
          const state = srv.enabled ? (st?.state ?? 'connecting') : 'off'
          const count = st?.tools?.length ?? 0
          return (
            <div key={srv.id} className="tools-srv-row">
              <Tile name={srv.name} />
              <div className="tools-srv-meta">
                <div className="tools-srv-top">
                  <strong>{srv.name}</strong>
                  <span className={`dot dot-${state}`} />
                </div>
                <span>
                  {t(`connections.state.${state}`)}
                  {count > 0 ? ` · ${t('connections.tools', { count })}` : ''}
                </span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={srv.enabled}
                  onChange={(e) => void handleToggleMcp(srv.id, e.target.checked)}
                  aria-label={srv.name}
                />
                <span />
              </label>
            </div>
          )
        })}

        {servers.length === 0 && (
          <button
            type="button"
            className="plus-sub-footer-btn"
            onClick={() => {
              closeAll()
              navigate({ view: 'market', chatId: null })
            }}
          >
            <Store size={14} />
            <span>{t('chat.plusBrowseMarket')}</span>
            <ExternalLink size={12} />
          </button>
        )}
      </div>
    </div>
  )

  const renderPluginsSubmenu = () => (
    <div className="plus-sub-inner">
      <div className="plus-sub-head">
        {inlineSubmenu && (
          <button type="button" className="plus-sub-back" onClick={() => setSubmenu(null)} aria-label={t('nav.back')}>
            <ArrowLeft size={13} />
          </button>
        )}
        <span>{t('chat.plusPlugins')}</span>
        <button
          type="button"
          className="tools-head-link"
          onClick={() => {
            closeAll()
            navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
          }}
        >
          {t('chat.plusManage')}
        </button>
      </div>

      <div className="plus-sub-list">
        {unimportedPluginsCount > 0 && (
          <button
            type="button"
            className="plus-plugin-discover-btn"
            onClick={() => {
              closeAll()
              setState({ pluginDiscoveryOpen: true })
            }}
          >
            <Sparkles size={14} />
            <span>{t('chat.plusPluginsDiscover', { count: unimportedPluginsCount })}</span>
            <ChevronRight size={13} />
          </button>
        )}

        {plugins.length === 0 && skills.length === 0 ? (
          <div className="plus-sub-empty">{t('chat.plusPluginsEmpty')}</div>
        ) : (
          <>
            {plugins.length > 0 && (
              <>
                <div className="plus-sub-section">{t('chat.plusPluginsSection')}</div>
                {plugins.map((plugin) => (
                  <div key={plugin.id} className="tools-srv-row plus-plugin-row">
                    <button
                      type="button"
                      className="plus-plugin-use"
                      onClick={() => {
                        closeAll()
                        navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
                      }}
                      title={plugin.description}
                    >
                      <span className="tools-builtin-icon tools-skill-icon">
                        <Plug size={14} />
                      </span>
                      <div className="tools-srv-meta">
                        <div className="tools-srv-top">
                          <strong>{plugin.displayName || plugin.name}</strong>
                          <span className="skill-scope-pill scope-plugin">{plugin.originLabel || plugin.origin}</span>
                        </div>
                        <span>
                          {[
                            plugin.skillNames.length > 0
                              ? t('plugins.skillsCount', { count: plugin.skillNames.length })
                              : null,
                            plugin.commandNames.length > 0
                              ? t('plugins.commandsCount', { count: plugin.commandNames.length })
                              : null,
                            plugin.mcpServerIds.length > 0
                              ? t('plugins.mcpCount', { count: plugin.mcpServerIds.length })
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || plugin.description}
                        </span>
                      </div>
                    </button>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={plugin.enabled}
                        onChange={(e) => void handleTogglePlugin(plugin.id, e.target.checked)}
                        aria-label={plugin.name}
                      />
                      <span />
                    </label>
                  </div>
                ))}
              </>
            )}

            {skills.length > 0 && (
              <>
                <div className="plus-sub-section">{t('chat.plusSkillsSection')}</div>
                {skills.map((skill) => (
                  <div key={`${skill.scope}-${skill.pluginId ?? ''}-${skill.name}`} className="tools-srv-row plus-plugin-row">
                    <button
                      type="button"
                      className="plus-plugin-use"
                      onClick={() => {
                        closeAll()
                        onInsertText(`/${skill.name} `)
                      }}
                      title={skill.description}
                    >
                      <span className="tools-builtin-icon tools-skill-icon">
                        <BookOpen size={14} />
                      </span>
                      <div className="tools-srv-meta">
                        <div className="tools-srv-top">
                          <strong>/{skill.name}</strong>
                          <span className={`skill-scope-pill scope-${skill.scope}`}>
                            {skill.pluginName ?? t(`skills.scopeTag.${skill.scope}`)}
                          </span>
                        </div>
                        <span>{skill.description}</span>
                      </div>
                    </button>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={skill.enabled}
                        onChange={(e) => void handleToggleSkill(skill.name, e.target.checked)}
                        aria-label={skill.name}
                      />
                      <span />
                    </label>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>

      <div className="plus-sub-divider" />

      <button
        type="button"
        className="plus-sub-footer-btn"
        onClick={() => {
          closeAll()
          navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
        }}
      >
        <Plug size={14} />
        <span>{t('chat.plusPluginsInstall')}</span>
        <ExternalLink size={12} />
      </button>

      <button
        type="button"
        className="plus-sub-footer-btn"
        onClick={() => {
          closeAll()
          navigate({ view: 'market', chatId: null })
        }}
      >
        <Store size={14} />
        <span>{t('chat.plusBrowseMarket')}</span>
        <ExternalLink size={12} />
      </button>
    </div>
  )

  return (
    <div className={`plus-menu-wrap dir-${direction}${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        data-composer-plus
        className={`tool-chip mention-btn plus-btn${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('chat.plusMenu')}
        title={t('chat.plusMenu')}
      >
        <Plus size={16} />
      </button>

      <div ref={popRef} style={popStyle} className="plus-popover" role="menu" aria-label={t('chat.plusMenu')}>
        {inlineSubmenu && submenu ? (
          submenu === 'connectors' ? (
            renderConnectorsSubmenu()
          ) : (
            renderPluginsSubmenu()
          )
        ) : (
          <div className="plus-menu-list">
            <button
              type="button"
              role="menuitem"
              className="plus-item"
              onMouseEnter={() => setSubmenu(null)}
              onClick={() => {
                closeAll()
                onAddFilesAndPhotos()
              }}
            >
              <span className="plus-item-icon">
                <Paperclip size={15} />
              </span>
              <span className="plus-item-copy">
                <span className="plus-item-label">{t('chat.plusAddFiles')}</span>
              </span>
              <kbd className="plus-kbd">Ctrl+U</kbd>
            </button>

            {onAddFolder && (
              <button
                type="button"
                role="menuitem"
                className="plus-item"
                onMouseEnter={() => setSubmenu(null)}
                onClick={() => {
                  closeAll()
                  onAddFolder()
                }}
              >
                <span className="plus-item-icon">
                  <Folder size={15} />
                </span>
                <span className="plus-item-copy">
                  <span className="plus-item-label">{t('chat.plusAddFolder')}</span>
                </span>
              </button>
            )}

            <button
              type="button"
              role="menuitem"
              className={`plus-item${!githubRepo ? ' disabled' : ''}`}
              disabled={!githubRepo}
              onMouseEnter={() => setSubmenu(null)}
              onClick={() => {
                if (!githubRepo) return
                closeAll()
                setIssueDialogRepo(githubRepo)
              }}
            >
              <span className="plus-item-icon">
                <GitHubMark />
              </span>
              <span className="plus-item-copy">
                <span className="plus-item-label">{t('chat.plusImportGithub')}</span>
                <span className="plus-item-sub">{githubRepo ?? t('chat.plusGithubMissing')}</span>
              </span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="plus-item"
              onMouseEnter={() => setSubmenu(null)}
              onClick={() => {
                closeAll()
                onOpenSlashCommands()
              }}
            >
              <span className="plus-item-icon">
                <SquareSlash size={15} />
              </span>
              <span className="plus-item-copy">
                <span className="plus-item-label">{t('chat.plusSlashCommands')}</span>
              </span>
            </button>

            <button
              type="button"
              role="menuitem"
              data-plus-submenu="connectors"
              aria-expanded={submenu === 'connectors'}
              className={`plus-item${submenu === 'connectors' ? ' active' : ''}`}
              onMouseEnter={() => setSubmenu('connectors')}
              onClick={() => setSubmenu((cur) => (cur === 'connectors' ? null : 'connectors'))}
            >
              <span className="plus-item-icon">
                <LayoutGrid size={15} />
              </span>
              <span className="plus-item-copy">
                <span className="plus-item-label">{t('chat.plusConnectors')}</span>
              </span>
              {activeConnectors > 0 && <span className="plus-item-count">{activeConnectors}</span>}
              <ChevronRight size={14} className="plus-item-chev" />
            </button>

            <button
              type="button"
              role="menuitem"
              data-plus-submenu="plugins"
              aria-expanded={submenu === 'plugins'}
              className={`plus-item${submenu === 'plugins' ? ' active' : ''}`}
              onMouseEnter={() => setSubmenu('plugins')}
              onClick={() => setSubmenu((cur) => (cur === 'plugins' ? null : 'plugins'))}
            >
              <span className="plus-item-icon">
                <Plug size={15} />
              </span>
              <span className="plus-item-copy">
                <span className="plus-item-label">{t('chat.plusPlugins')}</span>
              </span>
              {activePluginsAndSkills > 0 && (
                <span className="plus-item-count">{activePluginsAndSkills}</span>
              )}
              <ChevronRight size={14} className="plus-item-chev" />
            </button>
          </div>
        )}
      </div>

      {open && submenu && !inlineSubmenu && (
        <div style={subStyle} className="plus-submenu" role="menu">
          {submenu === 'connectors' ? renderConnectorsSubmenu() : renderPluginsSubmenu()}
        </div>
      )}

      {issueDialogRepo && (
        <GitHubIssueDialog
          workspace={workspace}
          repo={issueDialogRepo}
          onInsert={onInsertText}
          onClose={() => setIssueDialogRepo(null)}
        />
      )}
    </div>
  )
}
