import { useEffect, useState } from 'react'
import {
  BookOpen,
  ChevronRight,
  ClipboardPaste,
  Copy,
  FolderOpen,
  GitBranch,
  KeyRound,
  LogOut,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Store,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InstallOption, McpServerConfig } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { navigate, refreshPlugins, refreshSkills, scanLocalPlugins, setState, toast, useStore } from '../lib/store.ts'
import { blankForm, formFromConfig, formFromOption, type ServerForm } from '../lib/serverForm.ts'
import { ServerWizard } from '../components/ServerWizard.tsx'
import { PasteDialog } from '../components/PasteDialog.tsx'
import { ConfirmDialog } from '../components/Dialog.tsx'
import { Oculus } from '../components/Oculus.tsx'
import { NewSkillDialog, SkillsPanel } from '../components/SkillsPanel.tsx'
import { GithubPluginDialog, PluginsPanel } from '../components/PluginsPanel.tsx'
import { Tile } from '../components/Tile.tsx'

export interface WizardState {
  title: string
  form: ServerForm
  note?: string
}

export function ConnectionsView() {
  const { t } = useTranslation()
  const tab = useStore((s) => s.connectionsTab)
  const servers = useStore((s) => s.servers)
  const statuses = useStore((s) => s.statuses)
  const skills = useStore((s) => s.skills)
  const plugins = useStore((s) => s.plugins)
  const workspace = useStore((s) => s.settings?.workspace)
  const [wizard, setWizard] = useState<WizardState | null>(null)
  const [pasting, setPasting] = useState(false)
  const [creatingSkill, setCreatingSkill] = useState(false)
  const [githubPluginOpen, setGithubPluginOpen] = useState(false)
  const [scanningPlugins, setScanningPlugins] = useState(false)

  useEffect(() => {
    void Promise.all([refreshSkills(workspace), refreshPlugins(workspace)])
  }, [workspace])

  const connectedCount = servers.filter((s) => s.enabled && statuses[s.id]?.state === 'connected').length
  const totalTools = servers.reduce((acc, s) => acc + (s.enabled && statuses[s.id]?.state === 'connected' ? (statuses[s.id]?.tools.length ?? 0) : 0), 0)
  const enabledSkills = skills.filter((s) => s.enabled).length
  const enabledPlugins = plugins.filter((p) => p.enabled).length

  const fromOption = (option: InstallOption) => {
    setPasting(false)
    setWizard({ title: t('wizard.addTitle'), form: formFromOption(option), note: option.note })
  }

  const handleScanPlugins = async () => {
    setScanningPlugins(true)
    try {
      const list = await scanLocalPlugins({ autoPrompt: false, openModal: false, workspace })
      if (list.length === 0) {
        toast(t('plugins.discoverNoFound'))
      } else {
        setState({ pluginDiscoveryOpen: true })
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setScanningPlugins(false)
    }
  }

  const handleImportPluginFolder = async () => {
    const dir = await shell.pickFolder()
    if (!dir) return
    try {
      const res = await call('plugins.importFolder', dir)
      await refreshPlugins(workspace)
      await scanLocalPlugins({ autoPrompt: false, openModal: false, workspace })
      const importedName = res.installed[0]?.displayName || res.installed[0]?.name || dir
      toast(t('plugins.bundleInstalled', { name: importedName }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="display">{t('connections.title')}</h1>
          <div className="seg conn-tabs" role="tablist" aria-label={t('connections.title')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'mcp'}
              className={`seg-btn${tab === 'mcp' ? ' active' : ''}`}
              onClick={() => setState({ connectionsTab: 'mcp' })}
            >
              {t('skills.mcpTab')} ({servers.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'skills'}
              className={`seg-btn${tab === 'skills' ? ' active' : ''}`}
              onClick={() => setState({ connectionsTab: 'skills' })}
            >
              <BookOpen size={13} />
              <span>{t('skills.tab')} ({skills.length})</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'plugins'}
              className={`seg-btn${tab === 'plugins' ? ' active' : ''}`}
              onClick={() => setState({ connectionsTab: 'plugins' })}
            >
              <Package size={13} />
              <span>{t('plugins.tab')} ({plugins.length})</span>
            </button>
          </div>
          <p className="page-intro">
            {tab === 'plugins'
              ? t('plugins.intro')
              : tab === 'skills'
                ? t('skills.intro')
                : t('connections.intro')}
          </p>
          {tab === 'mcp' && servers.length > 0 && (
            <div className="summary-pills">
              <span className="summary-pill">
                <span className={`dot ${connectedCount > 0 ? 'dot-connected' : ''}`} aria-hidden />
                {connectedCount}/{servers.length} {t('connections.state.connected')}
              </span>
              {totalTools > 0 && <span className="summary-pill">{t('connections.tools', { count: totalTools })}</span>}
            </div>
          )}
          {tab === 'skills' && skills.length > 0 && (
            <div className="summary-pills">
              <span className="summary-pill">
                <span className={`dot ${enabledSkills > 0 ? 'dot-connected' : ''}`} aria-hidden />
                {t('skills.enabledCount', { enabled: enabledSkills, total: skills.length })}
              </span>
            </div>
          )}
          {tab === 'plugins' && plugins.length > 0 && (
            <div className="summary-pills">
              <span className="summary-pill">
                <span className={`dot ${enabledPlugins > 0 ? 'dot-connected' : ''}`} aria-hidden />
                {t('plugins.enabledCount', { enabled: enabledPlugins, total: plugins.length })}
              </span>
            </div>
          )}
        </div>
        <div className="page-actions">
          {tab === 'plugins' ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => void handleImportPluginFolder()}
              >
                <FolderOpen size={14} />
                {t('plugins.importFolderBtn')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setGithubPluginOpen(true)}
              >
                <GitBranch size={14} />
                {t('plugins.importGithubBtn')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={scanningPlugins}
                onClick={() => void handleScanPlugins()}
              >
                <RefreshCw size={14} className={scanningPlugins ? 'spin' : undefined} />
                {scanningPlugins ? t('plugins.scanning') : t('plugins.scanBtn')}
              </button>
            </>
          ) : tab === 'skills' ? (
            <button type="button" className="btn btn-primary" onClick={() => setCreatingSkill(true)}>
              <Plus size={14} />
              {t('skills.newSkill')}
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => setPasting(true)}>
                <ClipboardPaste size={14} />
                {t('connections.paste')}
              </button>
              <button className="btn btn-primary" onClick={() => setWizard({ title: t('wizard.addTitle'), form: blankForm() })}>
                <Plus size={14} />
                {t('connections.add')}
              </button>
            </>
          )}
        </div>
      </header>
      {tab === 'plugins' ? (
        <PluginsPanel
          workspace={workspace}
          onScan={() => void handleScanPlugins()}
          onImportFolder={() => void handleImportPluginFolder()}
          onOpenGithub={() => setGithubPluginOpen(true)}
          scanning={scanningPlugins}
        />
      ) : tab === 'skills' ? (
        <SkillsPanel onNewSkill={() => setCreatingSkill(true)} />
      ) : servers.length === 0 ? (
        <div className="empty-state">
          <Oculus state="idle" size={64} />
          <h2 className="display">{t('connections.emptyTitle')}</h2>
          <p>{t('connections.empty')}</p>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={() => setWizard({ title: t('wizard.addTitle'), form: blankForm() })}>
              <Plus size={14} />
              {t('connections.add')}
            </button>
            <button className="btn" onClick={() => navigate({ view: 'market', chatId: null })}>
              <Store size={14} />
              {t('connections.browse')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="rows">
          {servers.map((server) => (
            <ServerRow key={server.id} server={server} onEdit={() => setWizard({ title: t('wizard.editTitle'), form: formFromConfig(server) })} />
          ))}
        </ul>
      )}
      {wizard && <ServerWizard title={wizard.title} initial={wizard.form} note={wizard.note} onClose={() => setWizard(null)} />}
      {pasting && <PasteDialog onPick={fromOption} onClose={() => setPasting(false)} />}
      {creatingSkill && <NewSkillDialog workspace={workspace} onClose={() => setCreatingSkill(false)} />}
      {githubPluginOpen && <GithubPluginDialog workspace={workspace} onClose={() => setGithubPluginOpen(false)} />}
    </section>
  )
}

function ServerRow({ server, onEdit }: { server: McpServerConfig; onEdit: () => void }) {
  const { t } = useTranslation()
  const status = useStore((s) => s.statuses[server.id])
  const [open, setOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const state = server.enabled ? (status?.state ?? 'connecting') : 'off'
  const tools = status?.tools ?? []
  const where = server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].join(' ') : server.url
  const isHttp = server.transport === 'http'
  const showOAuthSignIn = isHttp && (server.authMode === 'oauth' || Boolean(status?.needsAuth))
  const oauthAuthorized = Boolean(server.oauth?.authorized) && !status?.needsAuth

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      setState({ servers: await call('mcp.list') })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const startOAuth = async () => {
    setAuthorizing(true)
    try {
      await call('mcp.oauthStart', server.id)
      setState({ servers: await call('mcp.list') })
      toast(t('connections.oauthDone'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setAuthorizing(false)
    }
  }

  const revokeOAuth = async () => {
    try {
      await call('mcp.oauthRevoke', server.id)
      setState({ servers: await call('mcp.list') })
      toast(t('connections.oauthRevoked'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }
  const remove = () => setConfirmRemove(true)

  return (
    <li className="row">
      <Tile name={server.name} />
      <div className="row-main">
        <button className="row-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronRight size={14} className={`chev${open ? ' open' : ''}`} />
          <span className="row-title">{server.name}</span>
          <span className={`chip chip-${state}`}>
            <span className={`dot dot-${state}`} aria-hidden />
            {t(`connections.state.${state}`)}
          </span>
          {oauthAuthorized && (
            <span className="chip oauth-ok-chip">
              <ShieldCheck size={11} />
              <span>{t('connections.oauthSignedIn')}</span>
            </span>
          )}
          {state === 'connected' && <span className="row-meta">{t('connections.tools', { count: tools.length })}</span>}
        </button>
        <button
          type="button"
          className="cmd-pill"
          title={t('common.copy')}
          onClick={() => void navigator.clipboard.writeText(where ?? '').then(() => toast(t('common.copied')))}
        >
          <span className="cmd-badge">{server.transport.toUpperCase()}</span>
          <code className="cmd-pill-text">{where}</code>
          <Copy size={11} className="cmd-pill-copy" aria-hidden />
        </button>
        {state === 'error' && status?.error && <p className="row-error">{status.error}</p>}
      </div>
      <div className="row-actions">
        {showOAuthSignIn && (
          <button
            type="button"
            className={`btn btn-small${!oauthAuthorized ? ' btn-primary' : ''}`}
            disabled={authorizing}
            onClick={() => void startOAuth()}
          >
            <KeyRound size={12} />
            <span>{authorizing ? t('connections.oauthSigningIn') : t('connections.oauthSignIn')}</span>
          </button>
        )}
        {oauthAuthorized && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => void revokeOAuth()}
            title={t('connections.oauthRevoke')}
            aria-label={t('connections.oauthRevoke')}
          >
            <LogOut size={13} />
          </button>
        )}
        <label className="switch" title={t(`connections.state.${server.enabled ? 'connected' : 'off'}`)}>
          <input type="checkbox" checked={server.enabled} onChange={(e) => void act(() => call('mcp.setEnabled', server.id, e.target.checked))} />
          <span />
        </label>
        <button className="icon-btn" onClick={() => void act(() => call('mcp.reconnect', server.id))} aria-label={t('connections.reconnect')} disabled={!server.enabled}>
          <RefreshCw size={14} />
        </button>
        <button className="icon-btn" onClick={onEdit} aria-label={t('common.edit')}>
          <Pencil size={14} />
        </button>
        <button className="icon-btn danger" onClick={remove} aria-label={t('common.remove')}>
          <Trash2 size={14} />
        </button>
      </div>
      <div className={`row-expand${open ? ' open' : ''}`}>
        <div className="row-expand-inner">
          {(tools.length > 0 || status?.stderrTail) && (
            <div className="row-detail">
              {tools.length > 0 && (
                <ul className="tool-list">
                  {tools.map((tool) => (
                    <li key={tool.name}>
                      <code>{tool.name}</code>
                      <span>{tool.description}</span>
                    </li>
                  ))}
                </ul>
              )}
              {status?.stderrTail && (
                <>
                  <div className="tool-label">{t('connections.log')}</div>
                  <pre className="log">{status.stderrTail}</pre>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title={t('common.remove')}
          message={t('connections.removeConfirm', { name: server.name })}
          confirmLabel={t('common.remove')}
          onConfirm={() => {
            setConfirmRemove(false)
            void act(() => call('mcp.remove', server.id))
          }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </li>
  )
}
