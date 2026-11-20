import { useState } from 'react'
import { AlertTriangle, FolderOpen, KeyRound, Package, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PluginCandidate } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import {
  acknowledgeDiscoveredPlugins,
  refreshPlugins,
  scanLocalPlugins,
  setState,
  toast,
  useStore,
} from '../lib/store.ts'
import { Dialog } from './Dialog.tsx'
import { GithubPluginDialog, pluginOriginLabel } from './PluginsPanel.tsx'

export function PluginDiscoveryModal() {
  const open = useStore((s) => s.pluginDiscoveryOpen)
  const discovered = useStore((s) => s.discoveredPlugins)
  const workspace = useStore((s) => s.settings?.workspace)

  if (!open) return null
  return (
    <PluginDiscoveryDialog
      discovered={discovered}
      workspace={workspace}
      onClose={() => void acknowledgeDiscoveredPlugins(false)}
    />
  )
}

function PluginDiscoveryDialog({
  discovered,
  workspace,
  onClose,
}: {
  discovered: PluginCandidate[]
  workspace?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const item of discovered) {
      if (!item.alreadyImported && item.recommended) {
        init[item.sourcePath] = true
      }
    }
    return init
  })
  const hasAnyImported = discovered.some((c) => c.alreadyImported)
  const hasAnyNew = discovered.some((c) => !c.alreadyImported)
  const [onlyNew, setOnlyNew] = useState<boolean>(hasAnyImported && hasAnyNew)
  const [importing, setImporting] = useState(false)
  const [showGithub, setShowGithub] = useState(false)

  const visible = onlyNew ? discovered.filter((c) => !c.alreadyImported) : discovered
  const selectedPaths = discovered
    .filter((c) => !c.alreadyImported && selected[c.sourcePath])
    .map((c) => c.sourcePath)

  const toggle = (path: string) => {
    setSelected((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const selectRecommended = () => {
    const next: Record<string, boolean> = {}
    for (const item of discovered) {
      if (!item.alreadyImported && item.recommended) next[item.sourcePath] = true
    }
    setSelected(next)
  }

  const clearSelection = () => setSelected({})

  const handleImport = async () => {
    if (selectedPaths.length === 0) {
      toast(t('plugins.importNoneSelected'), 'error')
      return
    }
    setImporting(true)
    try {
      const res = await call('plugins.importLocal', selectedPaths)
      await refreshPlugins(workspace)
      await scanLocalPlugins({ autoPrompt: false, openModal: false, workspace })
      await acknowledgeDiscoveredPlugins(false)
      const needsKey = res.createdMcpServers.some((m) => !m.enabled) || res.warnings.length > 0
      toast(
        t('plugins.importedSummary', { count: res.installed.length }) +
          (needsKey ? t('plugins.importedNeedsKeyNote') : ''),
      )
      if (res.skipped.length > 0 && res.installed.length === 0) {
        const msg = res.warnings[0] ?? res.skipped[0]
        if (msg) toast(msg, 'error')
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setImporting(false)
    }
  }

  const handleImportFolder = async () => {
    const folder = await shell.pickFolder()
    if (!folder) return
    setImporting(true)
    try {
      const res = await call('plugins.importFolder', folder)
      await refreshPlugins(workspace)
      await scanLocalPlugins({ autoPrompt: false, openModal: false, workspace })
      setState({ pluginDiscoveryOpen: false })
      const importedName = res.installed[0]?.name ?? folder
      toast(t('plugins.bundleInstalled', { name: importedName }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog title={t('plugins.discoverTitle')} onClose={onClose} wide>
      <div className="plugin-discover-intro">
        <Sparkles size={16} />
        <p>{t('plugins.discoverDesc')}</p>
      </div>

      {discovered.length > 0 && (
        <div className="plugin-discover-toolbar">
          <div className="plugin-discover-toolbar-left">
            {hasAnyImported && (
              <label className="plugin-discover-filter">
                <input
                  type="checkbox"
                  checked={onlyNew}
                  onChange={(e) => setOnlyNew(e.target.checked)}
                />
                <span>{t('plugins.discoverOnlyNew')}</span>
              </label>
            )}
          </div>
          <div className="plugin-discover-toolbar-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={selectRecommended}>
              {t('plugins.discoverSelectRecommended')}
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={clearSelection}>
              {t('plugins.discoverClearSelection')}
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="plugin-discover-empty">
          <Package size={24} />
          <p>{t('plugins.discoverNoFound')}</p>
          <div className="empty-state-actions">
            <button type="button" className="btn btn-small" onClick={() => void handleImportFolder()} disabled={importing}>
              <FolderOpen size={14} />
              {t('plugins.importFolderBtn')}
            </button>
            <button type="button" className="btn btn-small" onClick={() => setShowGithub(true)} disabled={importing}>
              {t('plugins.importGithubBtn')}
            </button>
          </div>
        </div>
      ) : (
        <ul className="plugin-modal-list">
          {visible.map((c) => {
            const checked = !!selected[c.sourcePath]
            const disabled = c.alreadyImported || importing
            const hasSecrets = c.mcpProposals.some((m) =>
              m.option.inputs.some((i) => i.required && !i.defaultValue),
            )
            return (
              <li
                key={c.sourcePath}
                className={`plugin-discover-row${c.alreadyImported ? ' imported' : ''}${checked ? ' selected' : ''}`}
              >
                <label className="plugin-discover-check">
                  <input
                    type="checkbox"
                    checked={c.alreadyImported || checked}
                    disabled={disabled}
                    onChange={() => toggle(c.sourcePath)}
                  />
                  <div className="plugin-discover-main">
                    <div className="row-line">
                      <span className="row-title">{c.displayName || c.name}</span>
                      {c.version && <span className="row-meta">v{c.version}</span>}
                      <span className={`plugin-origin-pill origin-${c.origin}`}>
                        {c.originLabel || pluginOriginLabel(c.origin, t)}
                      </span>
                      {c.alreadyImported && (
                        <span className="chip chip-done">{t('plugins.discoverAlreadyImported')}</span>
                      )}
                    </div>
                    {c.description && <p className="plugin-discover-desc">{c.description}</p>}
                    <div className="plugin-meta-chips">
                      {c.skillNames.length > 0 && (
                        <span className="skill-asset-chip">{t('plugins.skillsCount', { count: c.skillNames.length })}</span>
                      )}
                      {c.commandNames.length > 0 && (
                        <span className="skill-asset-chip">{t('plugins.commandsCount', { count: c.commandNames.length })}</span>
                      )}
                      {c.ruleFiles.length > 0 && (
                        <span className="skill-asset-chip">{t('plugins.rulesCount', { count: c.ruleFiles.length })}</span>
                      )}
                      {c.mcpProposals.length > 0 && (
                        <span className="skill-asset-chip">{t('plugins.mcpCount', { count: c.mcpProposals.length })}</span>
                      )}
                      {hasSecrets && (
                        <span className="plugin-warn-chip">
                          <KeyRound size={11} />
                          {t('plugins.needsConfigHint')}
                        </span>
                      )}
                      {c.hasHooks && (
                        <span className="plugin-warn-chip">
                          <AlertTriangle size={11} />
                          {t('plugins.discoverHooksTag')}
                        </span>
                      )}
                      {c.hasAppConnector && (
                        <span className="plugin-warn-chip">
                          <AlertTriangle size={11} />
                          {t('plugins.discoverAppTag')}
                        </span>
                      )}
                    </div>
                    <code className="plugin-discover-path">{c.sourcePath}</code>
                    {c.warnings.length > 0 && (
                      <p className="plugin-discover-note">{c.warnings.join(' · ')}</p>
                    )}
                  </div>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <div className="plugin-discover-foot">
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={importing}
          onClick={() => void acknowledgeDiscoveredPlugins(true)}
        >
          {t('plugins.discoverNeverAsk')}
        </button>
        <div className="plugin-discover-foot-right">
          <button type="button" className="btn" disabled={importing} onClick={onClose}>
            {t('plugins.discoverRemindLater')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={importing || selectedPaths.length === 0}
            onClick={() => void handleImport()}
          >
            {importing
              ? t('plugins.discoverImporting')
              : t('plugins.discoverImportSelected', { count: selectedPaths.length })}
          </button>
        </div>
      </div>

      {showGithub && (
        <GithubPluginDialog
          workspace={workspace}
          onClose={() => setShowGithub(false)}
          onInstalled={() => setState({ pluginDiscoveryOpen: false })}
        />
      )}
    </Dialog>
  )
}
