import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import {
  AlertTriangle,
  ChevronRight,
  FolderOpen,
  GitBranch,
  KeyRound,
  Palette,
  Play,
  Plug,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InstalledPlugin, McpServerConfig, PluginDetail, PluginOrigin } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { unlockRhineAudio } from '../lib/rhineAudio.ts'
import {
  refreshPlugins,
  replayPluginBoot,
  scanLocalPlugins,
  setState,
  toast,
  togglePluginEnabled,
  useStore,
} from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { ConfirmDialog, Dialog } from './Dialog.tsx'
import { Oculus } from './Oculus.tsx'
import { Tile } from './Tile.tsx'

export function pluginOriginLabel(origin: PluginOrigin, t: TFunction): string {
  switch (origin) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'antigravity':
      return 'Antigravity'
    case 'workspace':
      return t('skills.scopeWorkspace')
    case 'github':
      return 'GitHub'
    case 'atrium':
      return 'Atrium'
    case 'local':
    default:
      return 'Local'
  }
}

export function GithubPluginDialog({
  workspace,
  onClose,
  onInstalled,
}: {
  workspace?: string
  onClose: () => void
  onInstalled?: () => void
}) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return
    setBusy(true)
    try {
      const res = await call('plugins.importGithub', url.trim())
      await refreshPlugins(workspace)
      const installedName = res.installed[0]?.displayName || res.installed[0]?.name || url.trim()
      toast(t('plugins.bundleInstalled', { name: installedName }))
      onInstalled?.()
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('plugins.githubTitle')} onClose={onClose}>
      <form className="provider-form" onSubmit={(e) => void submit(e)}>
        <p className="dialog-note">{t('plugins.githubHint')}</p>
        <label className="field">
          <span>GitHub URL</span>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('plugins.githubPlaceholder')}
            autoFocus
            required
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()}>
            <GitBranch size={14} />
            {busy ? t('plugins.installing') : t('plugins.install')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function PluginsPanel({
  workspace,
  onScan,
  onImportFolder,
  onOpenGithub,
  scanning = false,
}: {
  workspace?: string
  onScan: () => void
  onImportFolder: () => void
  onOpenGithub: () => void
  scanning?: boolean
}) {
  const { t } = useTranslation()
  const plugins = useStore((s) => s.plugins)
  const discovered = useStore((s) => s.discoveredPlugins)
  const servers = useStore((s) => s.servers)

  const unimportedCount = discovered.filter((d) => !d.alreadyImported).length

  return (
    <>
      {unimportedCount > 0 && (
        <div className="plugin-discover-banner">
          <div className="plugin-discover-banner-copy">
            <Sparkles size={15} />
            <span>{t('plugins.discoverFoundBanner', { count: unimportedCount })}</span>
          </div>
          <button
            type="button"
            className="btn btn-small btn-primary"
            onClick={() => setState({ pluginDiscoveryOpen: true })}
          >
            {t('plugins.discoverOpenBtn')}
          </button>
        </div>
      )}

      {plugins.length === 0 ? (
        <div className="empty-state">
          <Oculus state="idle" size={64} />
          <h2>{t('plugins.emptyTitle')}</h2>
          <p>{t('plugins.emptyHint')}</p>
          <div className="empty-state-actions">
            <button type="button" className="btn btn-primary" onClick={onScan} disabled={scanning}>
              <RefreshCw size={14} className={scanning ? 'spin' : undefined} />
              {scanning ? t('plugins.scanning') : t('plugins.scanBtn')}
            </button>
            <button type="button" className="btn" onClick={onImportFolder}>
              <FolderOpen size={14} />
              {t('plugins.importFolderBtn')}
            </button>
            <button type="button" className="btn" onClick={onOpenGithub}>
              <GitBranch size={14} />
              {t('plugins.importGithubBtn')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="rows">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} workspace={workspace} servers={servers} />
          ))}
        </ul>
      )}
    </>
  )
}

function PluginRow({
  plugin,
  workspace,
  servers,
}: {
  plugin: InstalledPlugin
  workspace?: string
  servers: McpServerConfig[]
}) {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<PluginDetail | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const warnings = plugin.warnings ?? []
  const detailWarnings = detail?.warnings ?? []

  useEffect(() => {
    if (!open) return
    let cancelled = false
    call('plugins.get', plugin.id)
      .then((res) => {
        if (!cancelled) setDetail(res)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, plugin.id, plugin.enabled, plugin.mcpServerIds.length, warnings.length])

  const linkedServers = servers.filter((s) => plugin.mcpServerIds.includes(s.id))
  const hasDisabledMcp = linkedServers.some((s) => !s.enabled)

  const toggle = async () => {
    try {
      await togglePluginEnabled(plugin.id, !plugin.enabled, workspace)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const remove = async () => {
    try {
      await call('plugins.remove', plugin.id)
      await refreshPlugins(workspace)
      await scanLocalPlugins({ autoPrompt: false, openModal: false, workspace })
      toast(t('plugins.removed', { name: plugin.displayName || plugin.name }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <li className={`row${plugin.enabled ? '' : ' row-muted'}`}>
      <Tile name={plugin.displayName || plugin.name} />
      <div className="row-main">
        <button
          type="button"
          className="row-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <ChevronRight size={14} className={`chev${open ? ' open' : ''}`} />
          <span className="row-title">{plugin.displayName || plugin.name}</span>
          {plugin.version && <span className="row-meta">v{plugin.version}</span>}
          <span className={`plugin-origin-pill origin-${plugin.origin}`}>
            {plugin.originLabel || pluginOriginLabel(plugin.origin, t)}
          </span>
          {plugin.skillNames.length > 0 && (
            <span className="skill-asset-chip">{t('plugins.skillsCount', { count: plugin.skillNames.length })}</span>
          )}
          {plugin.commandNames.length > 0 && (
            <span className="skill-asset-chip">{t('plugins.commandsCount', { count: plugin.commandNames.length })}</span>
          )}
          {plugin.ruleFiles.length > 0 && (
            <span className="skill-asset-chip">{t('plugins.rulesCount', { count: plugin.ruleFiles.length })}</span>
          )}
          {plugin.mcpServerIds.length > 0 && (
            <span className="skill-asset-chip">{t('plugins.mcpCount', { count: plugin.mcpServerIds.length })}</span>
          )}
          {plugin.hasTheme && (
            <span className="skill-asset-chip plugin-theme-chip">
              <Palette size={10} />
              {ft('plugins.themeChip')}
            </span>
          )}
          {plugin.hasBootAnimation && (
            <span className="skill-asset-chip plugin-theme-chip">
              <Sparkles size={10} />
              {ft('plugins.bootChip')}
            </span>
          )}
          {plugin.author && <span className="row-meta">{ft('plugins.authorBy', { author: plugin.author })}</span>}
          {warnings.length > 0 && (
            <span className="plugin-warn-chip" title={warnings.join('\n')}>
              <AlertTriangle size={11} />
              {hasDisabledMcp ? t('plugins.needsConfigHint') : warnings.length}
            </span>
          )}
        </button>
        {plugin.description && <div className="row-desc">{plugin.description}</div>}
      </div>

      <div className="row-actions">
        {plugin.enabled && plugin.hasBootAnimation && (
          <button
            type="button"
            className="btn btn-ghost btn-small plugin-boot-preview-btn"
            onClick={() => {
              unlockRhineAudio()
              replayPluginBoot()
            }}
            title={ft('plugins.previewBoot')}
          >
            <Play size={12} />
            <span>{ft('plugins.previewBoot')}</span>
          </button>
        )}
        <label className="switch">
          <input
            type="checkbox"
            checked={plugin.enabled}
            onChange={() => void toggle()}
            aria-label={plugin.displayName || plugin.name}
          />
          <span />
        </label>
        <button
          type="button"
          className="icon-btn danger"
          onClick={() => setConfirmRemove(true)}
          aria-label={t('common.remove')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className={`row-expand${open ? ' open' : ''}`}>
        <div className="row-expand-inner">
          {detail && (
            <div className="row-detail plugin-detail">
              {detail.sourcePath && <code className="plugin-discover-path">{detail.sourcePath}</code>}

              {detail.skillNames.length > 0 && (
                <div className="plugin-detail-section">
                  <span className="plugin-detail-label">{t('plugins.includedSkills')}</span>
                  <div className="skill-files-list">
                    {detail.skillNames.map((name) => (
                      <code key={name}>{name}</code>
                    ))}
                  </div>
                </div>
              )}

              {detail.commandNames.length > 0 && (
                <div className="plugin-detail-section">
                  <span className="plugin-detail-label">{t('plugins.includedCommands')}</span>
                  <div className="skill-files-list">
                    {detail.commandNames.map((name) => (
                      <code key={name}>/{name}</code>
                    ))}
                  </div>
                </div>
              )}

              {detail.ruleFiles.length > 0 && (
                <div className="plugin-detail-section">
                  <span className="plugin-detail-label">{t('plugins.includedRules')}</span>
                  <div className="skill-files-list">
                    {detail.ruleFiles.map((name) => (
                      <code key={name}>{name}</code>
                    ))}
                  </div>
                </div>
              )}

              {linkedServers.length > 0 && (
                <div className="plugin-detail-section">
                  <span className="plugin-detail-label">{t('plugins.linkedMcp')}</span>
                  <div className="plugin-mcp-chips">
                    {linkedServers.map((s) => (
                      <span key={s.id} className={`chip ${s.enabled ? 'chip-connected' : 'chip-off'}`}>
                        <Plug size={11} />
                        {s.name}
                        {!s.enabled && (
                          <>
                            {' · '}
                            <KeyRound size={10} />
                            {t('plugins.needsConfigHint')}
                          </>
                        )}
                      </span>
                    ))}
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => setState({ connectionsTab: 'mcp' })}
                    >
                      {t('plugins.configureMcp')}
                    </button>
                  </div>
                </div>
              )}

              {detailWarnings.length > 0 && (
                <div className="plugin-detail-warnings">
                  <span className="plugin-detail-label">{t('plugins.warningsTitle')}</span>
                  <ul>
                    {detailWarnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {detail.files.length > 0 && (
                <div className="skill-files-bar">
                  <FolderOpen size={12} />
                  <span>{t('plugins.bundledFiles')}:</span>
                  <div className="skill-files-list">
                    {detail.files.map((f) => (
                      <code key={f}>{f}</code>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title={t('common.remove')}
          message={t('plugins.removeConfirm', { name: plugin.displayName || plugin.name })}
          confirmLabel={t('common.remove')}
          onConfirm={() => {
            setConfirmRemove(false)
            void remove()
          }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </li>
  )
}
