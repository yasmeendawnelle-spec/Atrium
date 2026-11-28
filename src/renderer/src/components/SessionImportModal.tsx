import { useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, FolderInput, FolderOpen, History, RefreshCw, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  ExternalAgentSource,
  ExternalSessionCandidate,
  ExternalSessionScanResult,
} from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { openChat } from '../lib/chats.ts'
import { closeSessionImportModal, setState, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { Dialog } from './Dialog.tsx'
import { folderName } from './WorkspacePicker.tsx'

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function compactPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/')
  const homeMatch = /^(?:[a-zA-Z]:)?\/(?:Users|home)\/[^/]+(\/.*)$/.exec(normalized)
  const short = homeMatch ? `~${homeMatch[1]}` : normalized
  if (short.length <= 68) return short
  const parts = short.split('/').filter(Boolean)
  if (parts.length <= 3) return `${short.slice(0, 32)}…${short.slice(-30)}`
  return `${parts[0]}/${parts[1]}/…/${parts.slice(-2).join('/')}`
}

function formatRelativeTime(ts: number, t: ReturnType<typeof useTranslation>['t']): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return t('chat.timeJustNow')
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return t('chat.timeMinsAgo', { count: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('chat.timeHoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return t('chat.timeDaysAgo', { count: days })
}

export function SessionImportModal() {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const workspace = useStore((s) => s.settings?.workspace)

  const [scan, setScan] = useState<ExternalSessionScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [customFolder, setCustomFolder] = useState<string | undefined>(undefined)
  const [activeSource, setActiveSource] = useState<ExternalAgentSource | 'all'>('all')
  const [query, setQuery] = useState('')
  const [onlyNew, setOnlyNew] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Record<string, boolean>>({})

  const runScan = async (folderPath?: string) => {
    setLoading(true)
    try {
      const result = await call('sessions.discover', {
        workspace,
        ...(folderPath ? { folderPath } : {}),
      })
      setScan(result)
      setSelectedKeys({})
      if (folderPath) {
        setActiveSource('all')
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void runScan(undefined)
  }, [])

  const sessions = scan?.sessions ?? []
  const sources = scan?.sources ?? []

  const visibleSessions = useMemo<ExternalSessionCandidate[]>(() => {
    const q = query.trim().toLowerCase()
    return sessions.filter((s) => {
      if (activeSource !== 'all' && s.source !== activeSource) return false
      if (onlyNew && s.alreadyImported) return false
      if (!q) return true
      return (
        s.title.toLowerCase().includes(q) ||
        (s.preview?.toLowerCase().includes(q) ?? false) ||
        (s.workspace?.toLowerCase().includes(q) ?? false) ||
        s.sourceLabel.toLowerCase().includes(q)
      )
    })
  }, [sessions, activeSource, onlyNew, query])

  const selectedList = useMemo(
    () => sessions.filter((s) => !s.alreadyImported && Boolean(selectedKeys[s.key])),
    [sessions, selectedKeys],
  )

  const toggleRow = (key: string) => {
    setSelectedKeys((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const selectAllVisible = () => {
    const next = { ...selectedKeys }
    for (const s of visibleSessions) {
      if (!s.alreadyImported) next[s.key] = true
    }
    setSelectedKeys(next)
  }

  const clearSelection = () => {
    setSelectedKeys({})
  }

  const handlePickFolder = async () => {
    const folder = await shell.pickFolder()
    if (!folder) return
    setCustomFolder(folder)
    await runScan(folder)
  }

  const handleResetFolder = async () => {
    setCustomFolder(undefined)
    setActiveSource('all')
    await runScan(undefined)
  }

  const handleOpenImported = async (chatId: string) => {
    closeSessionImportModal()
    await openChat(chatId)
  }

  const handleImportSelected = async () => {
    if (selectedList.length === 0) {
      toast(ft('sessionImport.noneSelected'), 'error')
      return
    }
    setImporting(true)
    try {
      const targets = selectedList.map((s) => ({
        key: s.key,
        source: s.source,
        externalId: s.externalId,
        sourcePath: s.sourcePath,
      }))
      const res = await call('sessions.import', targets)
      const [chats, nextSettings] = await Promise.all([
        call('chats.list'),
        call('settings.get'),
      ])
      setState({ chats, settings: nextSettings })

      if (res.imported.length > 0) {
        toast(ft('sessionImport.importSuccess', { count: res.imported.length }))
      } else if (res.skipped.length > 0) {
        toast(ft('sessionImport.importSkipped', { count: res.skipped.length }))
      }

      if (res.imported.length === 1) {
        closeSessionImportModal()
        await openChat(res.imported[0]!.id)
        return
      }
      await runScan(customFolder)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog title={ft('sessionImport.title')} onClose={closeSessionImportModal} wide>
      <div className="plugin-discover-intro">
        <History size={16} />
        <p>{ft('sessionImport.subtitle')}</p>
      </div>

      {customFolder && (
        <div className="session-import-folder-banner">
          <div className="session-import-folder-copy">
            <FolderOpen size={14} />
            <span>{ft('sessionImport.folderBanner', { path: customFolder })}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={loading || importing}
            onClick={() => void handleResetFolder()}
          >
            {ft('sessionImport.resetFolder')}
          </button>
        </div>
      )}

      {sources.length > 0 && (
        <div className="session-import-sources" role="tablist" aria-label={ft('sessionImport.sourceAll')}>
          <button
            type="button"
            role="tab"
            aria-selected={activeSource === 'all'}
            className={`session-import-pill${activeSource === 'all' ? ' active' : ''}`}
            onClick={() => setActiveSource('all')}
          >
            <span>{ft('sessionImport.sourceAll')}</span>
            <span className="session-import-pill-count">{sessions.length}</span>
          </button>
          {sources.map((src) => (
            <button
              key={src.source}
              type="button"
              role="tab"
              aria-selected={activeSource === src.source}
              className={`session-import-pill source-${src.source}${activeSource === src.source ? ' active' : ''}`}
              onClick={() => setActiveSource(src.source)}
            >
              <span className={`session-import-pill-dot source-${src.source}`} aria-hidden />
              <span>{src.label}</span>
              <span className="session-import-pill-count">{src.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="plugin-discover-toolbar">
        <div className="plugin-discover-toolbar-left">
          <div className="session-import-search">
            <Search size={13} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={ft('sessionImport.searchPlaceholder')}
              aria-label={ft('sessionImport.searchPlaceholder')}
            />
            {query && (
              <button
                type="button"
                className="session-import-search-clear"
                onClick={() => setQuery('')}
                aria-label={t('common.close')}
              >
                <X size={12} />
              </button>
            )}
          </div>
          {sessions.some((s) => s.alreadyImported) && (
            <button
              type="button"
              role="switch"
              aria-checked={onlyNew}
              className={`sim-toggle-pill${onlyNew ? ' on' : ''}`}
              onClick={() => setOnlyNew((v) => !v)}
            >
              <span className="sim-toggle-dot" aria-hidden />
              <span>{ft('sessionImport.onlyNew')}</span>
            </button>
          )}
        </div>
        <div className="plugin-discover-toolbar-actions">
          <button
            type="button"
            className="btn btn-small"
            disabled={loading || importing}
            onClick={() => void handlePickFolder()}
          >
            <FolderInput size={13} />
            {ft('sessionImport.pickFolder')}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={loading || importing}
            onClick={() => void runScan(customFolder)}
          >
            <RefreshCw size={13} className={loading ? 'spin' : undefined} />
            {ft('sessionImport.refresh')}
          </button>
          {visibleSessions.some((s) => !s.alreadyImported) && (
            <>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={loading || importing}
                onClick={selectAllVisible}
              >
                {ft('sessionImport.selectAll')}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={loading || importing || selectedList.length === 0}
                onClick={clearSelection}
              >
                {ft('sessionImport.clearSelection')}
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="sim-skeleton-list" aria-busy="true" aria-label={ft('sessionImport.scanning')}>
          <div className="sim-skeleton-caption">
            <RefreshCw size={13} className="spin" />
            <span>{ft('sessionImport.scanning')}</span>
          </div>
          {[0, 1, 2, 3].map((idx) => (
            <div key={idx} className="sim-skeleton-row" style={{ '--skel-i': idx } as React.CSSProperties}>
              <span className="sim-skeleton-box" />
              <div className="sim-skeleton-lines">
                <span className="sim-skeleton-line w-65" />
                <span className="sim-skeleton-line w-40" />
              </div>
            </div>
          ))}
        </div>
      ) : visibleSessions.length === 0 ? (
        <div className="plugin-discover-empty">
          <History size={24} />
          <strong>{ft('sessionImport.emptyTitle')}</strong>
          <p>{ft('sessionImport.emptyHint')}</p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void handlePickFolder()}
            disabled={importing}
          >
            <FolderInput size={14} />
            {ft('sessionImport.pickFolder')}
          </button>
        </div>
      ) : (
        <ul className="plugin-modal-list session-import-list">
          {visibleSessions.map((item) => {
            const checked = Boolean(selectedKeys[item.key])
            const disabled = item.alreadyImported || importing
            const wsName = item.workspace ? folderName(item.workspace) ?? item.workspace : undefined
            const sizeText = formatBytes(item.fileSize)
            return (
              <li
                key={item.key}
                className={`plugin-discover-row session-import-row${item.alreadyImported ? ' imported' : ''}${checked ? ' selected' : ''}`}
              >
                <label className="plugin-discover-check">
                  <input
                    type="checkbox"
                    className="rp-sr-checkbox"
                    checked={item.alreadyImported || checked}
                    disabled={disabled}
                    onChange={() => toggleRow(item.key)}
                  />
                  <span
                    className={`sim-check-box${item.alreadyImported || checked ? ' checked' : ''}${item.alreadyImported ? ' locked' : ''}`}
                    aria-hidden
                  >
                    {(item.alreadyImported || checked) && <Check size={11} strokeWidth={3} />}
                  </span>
                  <div className="plugin-discover-main">
                    <div className="row-line">
                      <span className="row-title">{item.title}</span>
                      <span className={`plugin-origin-pill session-source-pill source-${item.source}`}>
                        {item.sourceLabel}
                      </span>
                      {wsName && (
                        <span
                          className={`skill-asset-chip${item.workspaceExists === false ? ' missing-ws' : ''}`}
                          title={item.workspace}
                        >
                          <FolderOpen size={11} />
                          {wsName}
                          {item.workspaceExists === false ? ` ${ft('sessionImport.workspaceMissing')}` : ''}
                        </span>
                      )}
                      <span className="row-meta">
                        {ft('sessionImport.turnsCount', { count: item.turnCount })} ·{' '}
                        {ft('sessionImport.messagesCount', { count: item.messageCount })} ·{' '}
                        {formatRelativeTime(item.updatedAt, t)}
                        {sizeText ? ` · ${sizeText}` : ''}
                      </span>
                      {item.alreadyImported && item.importedChatId && (
                        <span className="session-import-imported-actions">
                          <span className="chip chip-done">{ft('sessionImport.importedBadge')}</span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-small"
                            onClick={(e) => {
                              e.preventDefault()
                              void handleOpenImported(item.importedChatId!)
                            }}
                          >
                            <ExternalLink size={12} />
                            {ft('sessionImport.openChatBtn')}
                          </button>
                        </span>
                      )}
                    </div>
                    {item.preview && <p className="plugin-discover-desc">{item.preview}</p>}
                    <code className="plugin-discover-path" title={item.sourcePath}>
                      {compactPath(item.sourcePath)}
                    </code>
                  </div>
                </label>
              </li>
            )
          })}
        </ul>
      )}

      <div className="plugin-discover-foot">
        <span className="muted small">
          {ft('sessionImport.foundSummary', { total: visibleSessions.length, selected: selectedList.length })}
        </span>
        <div className="plugin-discover-foot-right">
          <button
            type="button"
            className="btn"
            disabled={importing}
            onClick={closeSessionImportModal}
          >
            {ft('sessionImport.close')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={importing || loading || selectedList.length === 0}
            onClick={() => void handleImportSelected()}
          >
            {importing
              ? ft('sessionImport.importing')
              : ft('sessionImport.importBtn', { count: selectedList.length })}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
