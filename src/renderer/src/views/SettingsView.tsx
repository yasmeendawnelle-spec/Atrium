import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowDownUp,
  BarChart3,
  BookOpen,
  Briefcase,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileJson,
  FileText,
  FolderOpen,
  Globe,
  Lock,
  Monitor,
  Package,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Sparkles,
  Store,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { defaultBrowserModeForLocale } from '@shared/browserUrl.ts'
import { groupModelsByVendor } from '@shared/relaypulse.ts'
import { CONTEXT_WINDOW_PRESETS, normalizeContextWindowTokens } from '@shared/types.ts'
import type {
  AppSettings,
  CodeThemeDark,
  CodeThemeLight,
  ProviderConfig,
  ReasoningEffort,
  RuntimeInfo,
  SandboxMode,
  SceneUsageBreakdown,
  TranscriptViewMode,
  TranscriptWidth,
  UsageSummary,
  VoiceMode,
} from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { resolveLocale } from '../i18n.ts'
import {
  checkForUpdates,
  clearSkippedUpdateVersion,
  closeSettings,
  downloadAppUpdate,
  installAppUpdate,
  navigate,
  refreshPlugins,
  refreshSkills,
  scanLocalPlugins,
  setState,
  skipUpdateVersion,
  toast,
  useStore,
  type SettingsSection,
} from '../lib/store.ts'
import { Dialog, ConfirmDialog } from '../components/Dialog.tsx'
import { AccountStatusCard } from '../components/AccountPanel.tsx'
import { ModelCatalogDialog } from '../components/ModelCatalogDialog.tsx'
import { ProviderForm } from '../components/ProviderForm.tsx'
import { StudioSelect } from '../components/StudioSelect.tsx'
import { Tile } from '../components/Tile.tsx'
import { folderName, removeRecentWorkspace, setWorkspace } from '../components/WorkspacePicker.tsx'
import { pickWorkspace } from './ChatView.tsx'

async function updateSetting(patch: Partial<AppSettings>) {
  try {
    setState({ settings: await call('settings.update', patch) })
  } catch (err) {
    toast(errorMessage(err), 'error')
  }
}

function downloadBlob(filename: string, content: string, mime = 'application/json') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function formatProviderName(p: Pick<ProviderConfig, 'name' | 'managedBy'>, t: (key: string) => string): string {
  return p.managedBy === 'relaypulse' && p.name === 'RelayPulse' ? t('settings.managedProviderName') : p.name
}

function formatCompactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const NICE_SCALE_MULTIPLIERS = [1, 1.2, 1.6, 2, 2.4, 3.2, 4, 4.8, 6, 8, 10]

function computeChartScale(rawMax: number): { axisMax: number; ticks: number[] } {
  if (rawMax <= 0) {
    return { axisMax: 100, ticks: [100, 75, 50, 25, 0] }
  }
  const exp = Math.floor(Math.log10(rawMax))
  const mag = 10 ** exp
  const normalized = rawMax / mag
  const nice = NICE_SCALE_MULTIPLIERS.find((m) => m >= normalized) ?? 10
  const axisMax = Math.round(nice * mag)
  return {
    axisMax,
    ticks: [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(axisMax * f)),
  }
}

function extractSafeSettingsPatch(raw: unknown): Partial<AppSettings> | null {
  if (!raw || typeof raw !== 'object') return null
  const src = ('settings' in raw && raw.settings && typeof raw.settings === 'object' ? raw.settings : raw) as Record<
    string,
    unknown
  >
  const out: Partial<AppSettings> = {}
  let count = 0

  if (src.locale === 'system' || src.locale === 'zh' || src.locale === 'en') {
    out.locale = src.locale
    count++
  }
  if (src.theme === 'system' || src.theme === 'light' || src.theme === 'dark') {
    out.theme = src.theme
    count++
  }
  if (src.proxyMode === 'system' || src.proxyMode === 'custom' || src.proxyMode === 'none') {
    out.proxyMode = src.proxyMode
    count++
  }
  if (typeof src.proxyUrl === 'string') {
    out.proxyUrl = src.proxyUrl.trim() || undefined
    count++
  }
  if (typeof src.webEnabled === 'boolean') {
    out.webEnabled = src.webEnabled
    count++
  }
  if (src.browserMode === 'edge' || src.browserMode === 'google') {
    out.browserMode = src.browserMode
    count++
  }
  if (typeof src.autoCompact === 'boolean') {
    out.autoCompact = src.autoCompact
    count++
  }
  if (typeof src.contextWindowTokens === 'number' && Number.isFinite(src.contextWindowTokens)) {
    out.contextWindowTokens = normalizeContextWindowTokens(src.contextWindowTokens)
    count++
  }
  if (typeof src.autoUpdate === 'boolean') {
    out.autoUpdate = src.autoUpdate
    count++
  }
  if (src.transcriptWidth === 'narrow' || src.transcriptWidth === 'default' || src.transcriptWidth === 'wide') {
    out.transcriptWidth = src.transcriptWidth
    count++
  }
  if (
    src.defaultTranscriptView === 'normal' ||
    src.defaultTranscriptView === 'thinking' ||
    src.defaultTranscriptView === 'verbose'
  ) {
    out.defaultTranscriptView = src.defaultTranscriptView
    count++
  }
  if (typeof src.codeFont === 'string') {
    out.codeFont = src.codeFont.trim() || undefined
    count++
  }
  if (typeof src.codeFontSize === 'number' && Number.isFinite(src.codeFontSize)) {
    out.codeFontSize = Math.min(16, Math.max(12, Math.round(src.codeFontSize)))
    count++
  }
  if (src.codeThemeLight === 'atrium' || src.codeThemeLight === 'github' || src.codeThemeLight === 'paper') {
    out.codeThemeLight = src.codeThemeLight
    count++
  }
  if (src.codeThemeDark === 'atrium' || src.codeThemeDark === 'monokai' || src.codeThemeDark === 'nord') {
    out.codeThemeDark = src.codeThemeDark
    count++
  }
  if (typeof src.allowBypassPermissions === 'boolean') {
    out.allowBypassPermissions = src.allowBypassPermissions
    count++
  }
  if (
    src.reasoningEffort === 'auto' ||
    src.reasoningEffort === 'low' ||
    src.reasoningEffort === 'medium' ||
    src.reasoningEffort === 'high'
  ) {
    out.reasoningEffort = src.reasoningEffort
    count++
  }
  if (src.workScene === 'code' || src.workScene === 'work') {
    out.workScene = src.workScene
    count++
  }
  if (typeof src.maxAgentRounds === 'number' && Number.isFinite(src.maxAgentRounds)) {
    out.maxAgentRounds = Math.max(10, Math.min(100, Math.floor(src.maxAgentRounds)))
    count++
  }
  if (typeof src.autoExtractMemory === 'boolean') {
    out.autoExtractMemory = src.autoExtractMemory
    count++
  }
  if (typeof src.enablePluginHooks === 'boolean') {
    out.enablePluginHooks = src.enablePluginHooks
    count++
  }

  return count > 0 ? out : null
}

interface NavItemDef {
  id: SettingsSection
  group: 'preferences' | 'computer' | 'customize'
  icon: typeof Settings
  keywords: string[]
}

const NAV_ITEMS: NavItemDef[] = [
  { id: 'general', group: 'preferences', icon: Settings, keywords: ['theme', 'dark', 'light', 'language', 'width', 'transcript', 'view', 'reasoning', 'scene'] },
  { id: 'models', group: 'preferences', icon: Sparkles, keywords: ['provider', 'api', 'key', 'model', 'openai', 'anthropic', 'codex', 'deepseek'] },
  { id: 'code', group: 'preferences', icon: Code2, keywords: ['code', 'font', 'size', 'diff', 'syntax', 'monokai', 'nord', 'github', 'bypass', 'permissions'] },
  { id: 'cowork', group: 'preferences', icon: FolderOpen, keywords: ['workspace', 'folder', 'web', 'search', 'compact', 'cowork', 'browser', 'edge', 'google', 'bing', '浏览器'] },
  { id: 'usage', group: 'preferences', icon: BarChart3, keywords: ['usage', 'tokens', 'cache', 'stats', 'cost'] },
  { id: 'import', group: 'preferences', icon: ArrowDownUp, keywords: ['import', 'export', 'backup', 'json', 'markdown'] },
  { id: 'system', group: 'computer', icon: Monitor, keywords: ['update', 'upgrade', 'version', 'proxy', 'network', 'restart'] },
  { id: 'developer', group: 'computer', icon: Wrench, keywords: ['node', 'npx', 'uvx', 'python', 'docker', 'runtime', 'path', 'userData', 'encryption'] },
  { id: 'plugins', group: 'customize', icon: Package, keywords: ['plugin', 'bundle', 'claude', 'codex', 'antigravity', 'import'] },
  { id: 'skills', group: 'customize', icon: BookOpen, keywords: ['skill', 'SKILL.md', 'workflow'] },
  { id: 'connectors', group: 'customize', icon: Plug, keywords: ['mcp', 'connector', 'server', 'tools'] },
  { id: 'marketplace', group: 'customize', icon: Store, keywords: ['market', 'install', 'registry', 'github'] },
]

export function SettingsModal() {
  const { t } = useTranslation()
  const activeSection = useStore((s) => s.settingsSection)
  const updateState = useStore((s) => s.update)
  const settings = useStore((s) => s.settings)
  const [query, setQuery] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.overlay:not(.settings-overlay)')) {
        e.stopPropagation()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    const prev = document.activeElement as HTMLElement | null
    modalRef.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [activeSection])

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return NAV_ITEMS
    return NAV_ITEMS.filter((item) => {
      const label = t(`settings.tabs.${item.id}`).toLowerCase()
      const group = t(`settings.groups.${item.group}`).toLowerCase()
      return label.includes(q) || group.includes(q) || item.keywords.some((kw) => kw.toLowerCase().includes(q))
    })
  }, [query, t])

  const shownSection: SettingsSection | null = useMemo(() => {
    if (filteredItems.length === 0) return null
    if (filteredItems.some((i) => i.id === activeSection)) return activeSection
    return filteredItems[0]!.id
  }, [filteredItems, activeSection])

  if (!settings) return null

  const updateBadge =
    updateState &&
    (updateState.status === 'downloaded' ||
      (updateState.status === 'available' &&
        !(updateState.source !== 'manual' && updateState.version && settings.skippedUpdateVersion === updateState.version)))

  const groups: Array<'preferences' | 'computer' | 'customize'> = ['preferences', 'computer', 'customize']

  return createPortal(
    <div
      className="overlay settings-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeSettings()
      }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <header className="settings-modal-head">
          <h2>{t('settings.title')}</h2>
          <button
            type="button"
            className="icon-btn settings-modal-close"
            data-settings-close
            onClick={closeSettings}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-modal-shell">
          <aside className="settings-nav" aria-label={t('settings.title')}>
            <label className="settings-search">
              <Search size={14} />
              <input
                type="search"
                className="settings-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('settings.searchPlaceholder')}
                aria-label={t('settings.searchPlaceholder')}
              />
              {query && (
                <button
                  type="button"
                  className="settings-search-clear"
                  onClick={() => setQuery('')}
                  aria-label={t('common.close')}
                >
                  <X size={12} />
                </button>
              )}
            </label>

            <div className="settings-nav-groups">
              {groups.map((grp) => {
                const items = filteredItems.filter((i) => i.group === grp)
                if (items.length === 0) return null
                return (
                  <div key={grp} className="settings-nav-group">
                    <div className="settings-nav-group-title">{t(`settings.groups.${grp}`)}</div>
                    {items.map((item) => {
                      const Icon = item.icon
                      const isActive = shownSection === item.id
                      return (
                        <button
                          key={item.id}
                          type="button"
                          data-settings-tab={item.id}
                          className={`settings-nav-item${isActive ? ' active' : ''}`}
                          onClick={() => setState({ settingsSection: item.id })}
                        >
                          <Icon size={15} strokeWidth={1.8} />
                          <span>{t(`settings.tabs.${item.id}`)}</span>
                          {item.id === 'system' && updateBadge && (
                            <span
                              className={`settings-nav-dot${updateState.status === 'downloaded' ? ' ready' : ''}`}
                              aria-hidden
                            />
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </aside>

          <div ref={bodyRef} className="settings-modal-body">
            {shownSection === null && <div className="settings-empty-search">{t('settings.searchEmpty')}</div>}
            {shownSection === 'general' && <GeneralSection />}
            {shownSection === 'models' && <ModelsSection />}
            {shownSection === 'code' && <CodeSection />}
            {shownSection === 'cowork' && <CoworkSection />}
            {shownSection === 'usage' && <UsageSection />}
            {shownSection === 'import' && <ImportExportSection />}
            {shownSection === 'system' && <SystemSection />}
            {shownSection === 'developer' && <DeveloperSection />}
            {shownSection === 'plugins' && <PluginsSection />}
            {shownSection === 'skills' && <SkillsSection />}
            {shownSection === 'connectors' && <ConnectorsSection />}
            {shownSection === 'marketplace' && <MarketplaceSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export const SettingsView = SettingsModal

function GeneralSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const widthVal: TranscriptWidth = settings.transcriptWidth ?? 'default'
  const viewVal: TranscriptViewMode = settings.defaultTranscriptView ?? 'normal'
  const effortVal: ReasoningEffort = settings.reasoningEffort ?? 'medium'

  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.appearance')}</h3>
          <p>{t('settings.appearanceDesc')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.theme')}</strong>
          </div>
          <div className="seg" role="group" aria-label={t('settings.theme')}>
            {(['system', 'light', 'dark'] as const).map((th) => (
              <button
                key={th}
                type="button"
                className={`seg-btn${settings.theme === th ? ' active' : ''}`}
                onClick={() => void updateSetting({ theme: th })}
              >
                {t(th === 'system' ? 'settings.themeSystem' : th === 'light' ? 'settings.themeLight' : 'settings.themeDark')}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.language')}</strong>
          </div>
          <div className="seg" role="group" aria-label={t('settings.language')}>
            {(['system', 'zh', 'en'] as const).map((loc) => (
              <button
                key={loc}
                type="button"
                className={`seg-btn${settings.locale === loc ? ' active' : ''}`}
                onClick={() => void updateSetting({ locale: loc })}
              >
                {loc === 'system' ? t('settings.languageSystem') : loc === 'zh' ? '中文' : 'English'}
              </button>
            ))}
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.transcriptWidth')}</strong>
            <span>{t('settings.transcriptWidthHint')}</span>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('settings.transcriptWidth')}
            value={widthVal}
            options={[
              { value: 'narrow', label: t('settings.widthNarrow') },
              { value: 'default', label: t('settings.widthDefault') },
              { value: 'wide', label: t('settings.widthWide') },
            ]}
            onChange={(val) => void updateSetting({ transcriptWidth: val as TranscriptWidth })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.defaultTranscriptView')}</strong>
            <span>{t('settings.defaultTranscriptViewHint')}</span>
          </div>
          <div className="seg" role="group" aria-label={t('settings.defaultTranscriptView')}>
            {(['normal', 'thinking', 'verbose'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`seg-btn${viewVal === mode ? ' active' : ''}`}
                onClick={() => void updateSetting({ defaultTranscriptView: mode })}
              >
                {t(mode === 'normal' ? 'settings.viewNormal' : mode === 'thinking' ? 'settings.viewThinking' : 'settings.viewVerbose')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.defaults')}</h3>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.reasoningEffort')}</strong>
            <span>{t('settings.reasoningEffortHint')}</span>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('settings.reasoningEffort')}
            value={effortVal}
            options={[
              { value: 'auto', label: t('settings.reasoningAuto') },
              { value: 'low', label: t('settings.reasoningLow') },
              { value: 'medium', label: t('settings.reasoningMedium') },
              { value: 'high', label: t('settings.reasoningHigh') },
            ]}
            onChange={(val) => void updateSetting({ reasoningEffort: val as ReasoningEffort })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.defaultScene')}</strong>
            <span>{t('settings.defaultSceneHint')}</span>
          </div>
          <div className="seg" role="group" aria-label={t('settings.defaultScene')}>
            {(['code', 'work'] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                className={`seg-btn${(settings.workScene ?? 'code') === sc ? ' active' : ''}`}
                onClick={() => void updateSetting({ workScene: sc })}
              >
                {t(`scene.${sc}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelsSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const providers = useStore((s) => s.providers)
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  const [removingProvider, setRemovingProvider] = useState<ProviderConfig | null>(null)
  const [catalogProvider, setCatalogProvider] = useState<ProviderConfig | null>(null)
  const activeId = settings.activeProviderId ?? providers[0]?.id
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedVendorKeys, setExpandedVendorKeys] = useState<Record<string, boolean>>({})

  const pickModel = async (providerId: string, model: string) => {
    try {
      const next = await call('providers.selectModel', providerId, model)
      setState(next)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const confirmRemove = async (p: ProviderConfig) => {
    setRemovingProvider(null)
    try {
      await call('providers.remove', p.id)
      const [list, next] = await Promise.all([call('providers.list'), call('settings.get')])
      setState({ providers: list, settings: next })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-pane-top">
        <div className="settings-pane-head">
          <h3>{t('settings.tabs.models')}</h3>
          <p>{t('settings.modelsDesc')}</p>
        </div>
        <button type="button" className="btn btn-small" onClick={() => setEditing('new')}>
          <Plus size={14} />
          {t('settings.addModel')}
        </button>
      </div>

      <div className="rp-settings-account-wrap">
        <AccountStatusCard />
      </div>

      <ul className="rows settings-model-rows">
        {providers.map((p) => {
          const isOpen = expandedId === p.id
          const isCurrent = p.id === activeId
          return (
            <li key={p.id} className={`model-row-item${isOpen ? ' open' : ''}`}>
              <div className="row">
                <Tile name={formatProviderName(p, t)} />
                <button
                  type="button"
                  className="row-main row-toggle"
                  onClick={() => setExpandedId(isOpen ? null : p.id)}
                  aria-expanded={isOpen}
                >
                  <div className="row-line">
                    <ChevronRight size={14} className={`chev${isOpen ? ' open' : ''}`} />
                    <span className="row-title">{formatProviderName(p, t)}</span>
                    <span className="model-pill">{p.model}</span>
                    {(p.models?.length ?? 0) > 1 && (
                      <span className="chip">{p.models!.length} 个模型</span>
                    )}
                    {p.managedBy === 'relaypulse' && <span className="chip">官方账号</span>}
                    {isCurrent && <span className="chip chip-done">{t('settings.inUse')}</span>}
                  </div>
                </button>
                <div className="row-actions">
                  {!isCurrent && (
                    <button type="button" className="btn btn-small" onClick={() => void updateSetting({ activeProviderId: p.id })}>
                      {t('settings.use')}
                    </button>
                  )}
                  <button type="button" className="icon-btn" onClick={() => setEditing(p)} aria-label={t('common.edit')}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="icon-btn danger" onClick={() => setRemovingProvider(p)} aria-label={t('common.remove')}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className={`model-row-expand${isOpen ? ' open' : ''}`}>
                <div className="model-row-expand-inner">
                  <div className="model-meta-bar">
                    <div className="model-meta-pills">
                      <span className="model-meta-pill">
                        <Sparkles size={12} />
                        {p.protocol === 'anthropic'
                          ? t('settings.protocolAnthropic')
                          : p.protocol === 'responses'
                            ? t('settings.protocolResponses')
                            : t('settings.protocolOpenai')}
                      </span>
                      <span className="model-meta-pill">
                        <Globe size={12} />
                        {p.managedBy === 'relaypulse' ? t('settings.managedEndpoint') : p.baseUrl}
                      </span>
                      {p.hasKey && (
                        <span className="model-meta-pill ok">
                          <Lock size={12} />
                          {t('settings.keySavedBadge')}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setCatalogProvider(p)}
                    >
                      <RefreshCw size={12} />
                      <span>拉取模型</span>
                    </button>
                  </div>
                  {(p.models?.length ?? 0) > 0 && (() => {
                    const rawModels = p.models?.length ? p.models : [p.model]
                    const vendorGroups = groupModelsByVendor(rawModels)
                    const autoOpenSoleVendor = vendorGroups.length === 1 && p.managedBy !== 'relaypulse'
                    return (
                      <div className="settings-vendor-groups">
                        {vendorGroups.map((vg) => {
                          const vKey = `${p.id}::${vg.id}`
                          const vOpen = expandedVendorKeys[vKey] ?? autoOpenSoleVendor
                          const hasActive = isCurrent && vg.models.includes(p.model)
                          return (
                            <div key={vKey} className="settings-vendor-group">
                              <button
                                type="button"
                                className={`settings-vendor-toggle${vOpen ? ' open' : ''}${hasActive ? ' has-active' : ''}`}
                                aria-expanded={vOpen}
                                onClick={() =>
                                  setExpandedVendorKeys((prev) => ({
                                    ...prev,
                                    [vKey]: !(prev[vKey] ?? autoOpenSoleVendor),
                                  }))
                                }
                              >
                                <span className="model-group-label">
                                  <ChevronRight size={13} className={`chev${vOpen ? ' open' : ''}`} />
                                  <Tile name={vg.tileName} />
                                  <span>{vg.label}</span>
                                </span>
                                <span className="model-group-right">
                                  {!vOpen && hasActive && <span className="model-group-active">{p.model}</span>}
                                  <span className="model-group-count">{vg.models.length}</span>
                                </span>
                              </button>
                              {vOpen && (
                                <div className="provider-models-chips settings-model-chips">
                                  {vg.models.map((m) => {
                                    const activeChip = isCurrent && m === p.model
                                    return (
                                      <button
                                        key={m}
                                        type="button"
                                        className={`provider-model-chip provider-model-chip-btn${activeChip ? ' active' : ''}`}
                                        onClick={() => void pickModel(p.id, m)}
                                      >
                                        {activeChip && <Check size={11} />}
                                        <span>{m}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })()}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {editing && (
        <Dialog title={editing === 'new' ? t('settings.addModel') : formatProviderName(editing, t)} onClose={() => setEditing(null)}>
          <ProviderForm existing={editing === 'new' ? undefined : editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </Dialog>
      )}

      {catalogProvider && (
        <ModelCatalogDialog
          title={`${formatProviderName(catalogProvider, t)} · 拉取并选择模型`}
          target={catalogProvider.id}
          initialSelected={catalogProvider.models ?? [catalogProvider.model]}
          initialDefault={catalogProvider.model}
          onConfirm={async (models, defaultModel) => {
            await call('providers.setModels', catalogProvider.id, models, defaultModel)
            const [list, next] = await Promise.all([call('providers.list'), call('settings.get')])
            setState({ providers: list, settings: next })
            toast(`已保存 ${formatProviderName(catalogProvider, t)} 的 ${models.length} 个模型`)
          }}
          onClose={() => setCatalogProvider(null)}
        />
      )}

      {removingProvider && (
        <ConfirmDialog
          title={t('common.remove')}
          message={t('settings.removeModel', { name: formatProviderName(removingProvider, t) })}
          confirmLabel={t('common.remove')}
          onConfirm={() => void confirmRemove(removingProvider)}
          onClose={() => setRemovingProvider(null)}
        />
      )}
    </div>
  )
}

function CodeDiffPreviewCard({
  mode,
  preset,
  fontSize,
  fontFamily,
}: {
  mode: 'light' | 'dark'
  preset: string
  fontSize: number
  fontFamily?: string
}) {
  const customFont = fontFamily?.replace(/[;"'\\]/g, '').trim()
  const style = {
    fontSize: `${fontSize}px`,
    ...(customFont ? { fontFamily: `'${customFont}', var(--font-code)` } : {}),
  }
  return (
    <div className="code-preview-surface" data-preview-mode={mode} data-preview-preset={preset} style={style}>
      <div className="code-preview-line">
        <span className="code-preview-ln">1</span>
        <span className="code-preview-mark"> </span>
        <span className="code-preview-code">
          <span className="tok-keyword">function</span> <span className="tok-func">greet</span>(name:{' '}
          <span className="tok-type">string</span>) {'{'}
        </span>
      </div>
      <div className="code-preview-line del">
        <span className="code-preview-ln">2</span>
        <span className="code-preview-mark">-</span>
        <span className="code-preview-code">
          {'  '}
          <span className="tok-keyword">return</span> <span className="tok-string">&quot;Hello, &quot;</span>{' '}
          <span className="tok-op">+</span> name;
        </span>
      </div>
      <div className="code-preview-line add">
        <span className="code-preview-ln">2</span>
        <span className="code-preview-mark">+</span>
        <span className="code-preview-code">
          {'  '}
          <span className="tok-keyword">return</span> <span className="tok-string">`Hello, ${'{name}'}!`</span>;
        </span>
      </div>
      <div className="code-preview-line">
        <span className="code-preview-ln">3</span>
        <span className="code-preview-mark"> </span>
        <span className="code-preview-code">{'}'}</span>
      </div>
    </div>
  )
}

function CodeSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const sandboxInfo = useStore((s) => s.sandboxInfo)
  const [fontInput, setFontInput] = useState(settings.codeFont ?? '')
  const lightPreset: CodeThemeLight = settings.codeThemeLight ?? 'atrium'
  const darkPreset: CodeThemeDark = settings.codeThemeDark ?? 'atrium'
  const codeSize = settings.codeFontSize ?? 13
  const allowBypass = settings.allowBypassPermissions !== false
  const sandboxMode: SandboxMode = settings.shellSandbox ?? 'off'

  useEffect(() => {
    setFontInput(settings.codeFont ?? '')
  }, [settings.codeFont])

  const commitFont = () => {
    const trimmed = fontInput.trim() || undefined
    if (trimmed !== (settings.codeFont ?? undefined)) {
      void updateSetting({ codeFont: trimmed ?? '' })
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.codeAppearance')}</h3>
          <p>{t('settings.codeAppearanceDesc')}</p>
        </div>

        <div className="code-looks-grid">
          <div className="code-look-col">
            <StudioSelect
              fullWidth
              ariaLabel={t('settings.codeLightLabel')}
              value={lightPreset}
              options={[
                { value: 'atrium', label: t('settings.codePresetAtriumLight') },
                { value: 'github', label: t('settings.codePresetGithub') },
                { value: 'paper', label: t('settings.codePresetPaper') },
              ]}
              onChange={(val) => void updateSetting({ codeThemeLight: val as CodeThemeLight })}
            />
            <CodeDiffPreviewCard mode="light" preset={lightPreset} fontSize={codeSize} fontFamily={fontInput} />
          </div>

          <div className="code-look-col">
            <StudioSelect
              fullWidth
              ariaLabel={t('settings.codeDarkLabel')}
              value={darkPreset}
              options={[
                { value: 'atrium', label: t('settings.codePresetAtriumDark') },
                { value: 'monokai', label: t('settings.codePresetMonokai') },
                { value: 'nord', label: t('settings.codePresetNord') },
              ]}
              onChange={(val) => void updateSetting({ codeThemeDark: val as CodeThemeDark })}
            />
            <CodeDiffPreviewCard mode="dark" preset={darkPreset} fontSize={codeSize} fontFamily={fontInput} />
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.codeFont')}</strong>
            <span>{t('settings.codeFontHint')}</span>
          </div>
          <input
            type="text"
            className="input mono settings-code-input"
            value={fontInput}
            placeholder={t('settings.codeFontPlaceholder')}
            aria-label={t('settings.codeFont')}
            onChange={(e) => setFontInput(e.target.value)}
            onBlur={commitFont}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitFont()
              }
            }}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.codeFontSize')}</strong>
            <span>{t('settings.codeFontSizeHint')}</span>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('settings.codeFontSize')}
            value={codeSize}
            options={[
              { value: 12, label: '12 px' },
              { value: 13, label: t('settings.codeFontSizeDefault') },
              { value: 14, label: '14 px' },
              { value: 15, label: '15 px' },
              { value: 16, label: '16 px' },
            ]}
            onChange={(val) => void updateSetting({ codeFontSize: Number(val) })}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.sessions')}</h3>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.allowBypass')}</strong>
            <span>{t('settings.allowBypassHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={allowBypass}
              onChange={(e) => void updateSetting({ allowBypassPermissions: e.target.checked })}
              aria-label={t('settings.allowBypass')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.computerUseTitle')}</strong>
            <span>{t('settings.computerUseHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.computerUseEnabled !== false}
              onChange={(e) => void updateSetting({ computerUseEnabled: e.target.checked })}
              aria-label={t('settings.computerUseTitle')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.desktopControlTitle')}</strong>
            <span>{t('settings.desktopControlHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.desktopControlEnabled === true || settings.computerUseMode === 'desktop'}
              disabled={settings.computerUseEnabled === false}
              onChange={(e) =>
                void updateSetting({
                  desktopControlEnabled: e.target.checked,
                  computerUseMode: e.target.checked ? 'desktop' : 'browser',
                })
              }
              aria-label={t('settings.desktopControlTitle')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.maxAgentRounds')}</strong>
            <span>{t('settings.maxAgentRoundsHint')}</span>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('settings.maxAgentRounds')}
            value={settings.maxAgentRounds ?? 40}
            options={[
              { value: 25, label: t('settings.maxAgentRoundsOption', { count: 25 }) },
              { value: 40, label: t('settings.maxAgentRoundsOption', { count: 40 }) },
              { value: 60, label: t('settings.maxAgentRoundsOption', { count: 60 }) },
              { value: 100, label: t('settings.maxAgentRoundsOption', { count: 100 }) },
            ]}
            onChange={(val) => void updateSetting({ maxAgentRounds: Number(val) })}
          />
        </div>

        <div className="setting-row-block">
          <div className="setting-row-meta">
            <strong>{t('chat.allowedRulesTitle')}</strong>
            <span>{t('chat.allowedRulesHint')}</span>
          </div>
          {(() => {
            const wsNorm = settings.workspace?.trim().toLowerCase() || '__global__'
            const entries = Object.entries(settings.allowedToolRules ?? {}).filter(
              ([k]) => k.toLowerCase() === wsNorm || (!settings.workspace && k === '__global__'),
            )
            const rules = entries.flatMap(([, list]) => list)
            if (rules.length === 0) {
              return <p className="muted small">{t('chat.noAllowedRules')}</p>
            }
            return (
              <div className="settings-allow-rules">
                {rules.map((rule) => (
                  <span key={rule} className="summary-pill allow-rule-pill">
                    <code>{rule.replace(/^cmd-prefix:/, '').replace(/^cmd-exact:/, '').replace(/^tool:/, '')}</code>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={async () => {
                        await call('agent.revokeAllowedRule', rule, settings.workspace)
                        setState({ settings: await call('settings.get') })
                      }}
                      title={t('chat.revokeRule')}
                      aria-label={t('chat.revokeRule')}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )
          })()}
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('sandbox.title')}</strong>
            <span>
              {t('sandbox.hint')}
              {sandboxInfo ? ` · ${sandboxInfo.backend}` : ''}
            </span>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('sandbox.title')}
            value={sandboxMode}
            options={[
              { value: 'off', label: t('sandbox.modes.off') },
              { value: 'workspace_write', label: t('sandbox.modes.workspace_write') },
              { value: 'read_only', label: t('sandbox.modes.read_only') },
            ]}
            onChange={(val) => void updateSetting({ shellSandbox: val as SandboxMode })}
          />
        </div>

        {sandboxInfo && (
          <div className="setting-line">
            <span className={`chip ${sandboxInfo.supported ? 'chip-done' : ''}`}>
              {sandboxInfo.backend}
            </span>
            <span className="muted small">{sandboxInfo.details}</span>
          </div>
        )}

        {sandboxMode !== 'off' && sandboxInfo?.platform !== 'win32' && (
          <div className="setting-row">
            <div className="setting-row-meta">
              <strong>{t('sandbox.allowNetwork')}</strong>
              <span>{t('sandbox.allowNetworkHint')}</span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.sandboxAllowNetwork !== false}
                onChange={(e) => void updateSetting({ sandboxAllowNetwork: e.target.checked })}
              />
              <span />
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

function CoworkSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const recent = settings.recentWorkspaces ?? []

  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-top">
          <div className="settings-pane-head">
            <h3>{t('settings.workspace')}</h3>
            <p>{t('settings.workspaceHint')}</p>
          </div>
          <button type="button" className="btn btn-small" onClick={() => void pickWorkspace()}>
            <FolderOpen size={14} />
            {t('settings.chooseFolder')}
          </button>
        </div>

        <div className="setting-line">
          <code>{settings.workspace ?? t('settings.noFolder')}</code>
        </div>

        {recent.length > 0 && (
          <div className="settings-recent-ws">
            <div className="settings-sub-label">
              <strong>{t('settings.recentWorkspaces')}</strong>
              <span className="muted small">{t('settings.recentWorkspacesHint')}</span>
            </div>
            <ul className="settings-ws-list">
              {recent.map((dir) => {
                const isCurrent = dir === settings.workspace
                return (
                  <li key={dir} className="settings-ws-item">
                    <div className="settings-ws-meta">
                      <strong>{folderName(dir) ?? dir}</strong>
                      <code title={dir}>{dir}</code>
                    </div>
                    <div className="row-actions">
                      {!isCurrent ? (
                        <button type="button" className="btn btn-small" onClick={() => void setWorkspace(dir, { rebindActiveChat: false })}>
                          {t('settings.switchWorkspace')}
                        </button>
                      ) : (
                        <span className="chip chip-done">{t('settings.inUse')}</span>
                      )}
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={t('common.remove')}
                        onClick={() => void removeRecentWorkspace(dir)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.capabilities')}</h3>
          <p>{t('settings.capabilitiesHint')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.webTools')}</strong>
            <span>{t('settings.webToolsHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.webEnabled !== false}
              onChange={(e) => void updateSetting({ webEnabled: e.target.checked })}
              aria-label={t('settings.webTools')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('browser.settingsMode')}</strong>
            <span>{t('browser.settingsModeHint')}</span>
          </div>
          {(() => {
            const currentMode =
              settings.browserMode ?? defaultBrowserModeForLocale(resolveLocale(settings.locale))
            return (
              <div className="seg" role="radiogroup" aria-label={t('browser.settingsMode')}>
                {(['edge', 'google'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={currentMode === m}
                    className={`seg-btn${currentMode === m ? ' active' : ''}`}
                    onClick={() => void updateSetting({ browserMode: m })}
                  >
                    {t(m === 'edge' ? 'browser.modeEdge' : 'browser.modeGoogle')}
                  </button>
                ))}
              </div>
            )
          })()}
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('chat.copyEnvWorktree')}</strong>
            <span>{t('chat.copyEnvWorktreeHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.copyEnvOnWorktree !== false}
              onChange={(e) => void updateSetting({ copyEnvOnWorktree: e.target.checked })}
              aria-label={t('chat.copyEnvWorktree')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.contextWindowLimit')}</strong>
            <span>{t('settings.contextWindowLimitHint')}</span>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('settings.contextWindowLimit')}
            value={normalizeContextWindowTokens(settings.contextWindowTokens)}
            options={CONTEXT_WINDOW_PRESETS.map((preset) => ({
              value: preset,
              label:
                preset === 0
                  ? t('settings.contextWindowAuto')
                  : `${Math.round(preset / 1000) >= 1000 ? `${preset / 1_000_000}M` : `${Math.round(preset / 1000)}k`} tokens`,
            }))}
            onChange={(val) => void updateSetting({ contextWindowTokens: Number(val) })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.autoCompact')}</strong>
            <span>{t('settings.autoCompactHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.autoCompact !== false}
              onChange={(e) => void updateSetting({ autoCompact: e.target.checked })}
              aria-label={t('settings.autoCompact')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('memory.autoInject')}</strong>
            <span>{t('memory.autoInjectHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.memoryEnabled !== false}
              onChange={(e) => void updateSetting({ memoryEnabled: e.target.checked })}
              aria-label={t('memory.autoInject')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('memory.autoExtract')}</strong>
            <span>{t('memory.autoExtractHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              disabled={settings.memoryEnabled === false}
              checked={settings.memoryEnabled !== false && settings.autoExtractMemory !== false}
              onChange={(e) => void updateSetting({ autoExtractMemory: e.target.checked })}
              aria-label={t('memory.autoExtract')}
            />
            <span />
          </label>
        </div>
      </div>
    </div>
  )
}

function SceneUsageChart({
  work,
  code,
  untaggedSceneMessages,
}: {
  work: SceneUsageBreakdown
  code: SceneUsageBreakdown
  untaggedSceneMessages: number
}) {
  const { t } = useTranslation()

  const rawMax = Math.max(
    work.totalTokens,
    code.totalTokens,
    work.inputTokens,
    code.inputTokens,
    work.outputTokens,
    code.outputTokens,
  )
  const { axisMax, ticks } = computeChartScale(rawMax)

  const groups = [
    { key: 'total', label: t('settings.usageMetricTotal'), workVal: work.totalTokens, codeVal: code.totalTokens },
    { key: 'input', label: t('settings.usageMetricInput'), workVal: work.inputTokens, codeVal: code.inputTokens },
    { key: 'output', label: t('settings.usageMetricOutput'), workVal: work.outputTokens, codeVal: code.outputTokens },
  ]

  const combinedTotal = work.totalTokens + code.totalTokens
  const workPct = combinedTotal > 0 ? Math.round((work.totalTokens / combinedTotal) * 100) : 0
  const codePct = combinedTotal > 0 ? 100 - workPct : 0

  const renderBar = (scene: 'work' | 'code', sceneLabel: string, value: number, metricLabel: string) => {
    const pct = axisMax > 0 ? Math.min(100, (value / axisMax) * 100) : 0
    const isZero = value <= 0
    return (
      <div className="usage-bar-col" title={`${sceneLabel} · ${metricLabel}: ${value.toLocaleString()}`}>
        <span className={`usage-bar-val${isZero ? ' is-zero' : ''}`}>{formatCompactNum(value)}</span>
        <div
          className={`usage-bar ${scene}${isZero ? ' is-zero' : ''}`}
          style={{ height: isZero ? '2px' : `max(4px, ${pct.toFixed(2)}%)` }}
        />
      </div>
    )
  }

  const sceneSummaries: Array<{
    key: 'work' | 'code'
    label: string
    pct: number
    data: SceneUsageBreakdown
  }> = [
    { key: 'work', label: 'Work', pct: workPct, data: work },
    { key: 'code', label: 'Code', pct: codePct, data: code },
  ]

  return (
    <div className="usage-scene-card">
      <div className="usage-scene-head">
        <div>
          <div className="usage-scene-title">{t('settings.usageByScene')}</div>
          <p className="usage-scene-desc">{t('settings.usageBySceneDesc')}</p>
        </div>
        <div className="usage-scene-legend" aria-label={t('settings.usageByScene')}>
          <span className="usage-legend-item">
            <span className="usage-legend-dot work" aria-hidden />
            <span>Work</span>
          </span>
          <span className="usage-legend-item">
            <span className="usage-legend-dot code" aria-hidden />
            <span>Code</span>
          </span>
        </div>
      </div>

      <div className="usage-bar-chart" role="img" aria-label={t('settings.usageByScene')}>
        <div className="usage-chart-yaxis" aria-hidden>
          <div className="usage-chart-yaxis-inner">
            {ticks.map((tick, idx) => {
              const pct = ((ticks.length - 1 - idx) / (ticks.length - 1)) * 100
              return (
                <span key={`${tick}-${idx}`} className="usage-chart-ytick" style={{ bottom: `${pct}%` }}>
                  {formatCompactNum(tick)}
                </span>
              )
            })}
          </div>
        </div>

        <div className="usage-chart-plot">
          <div className="usage-chart-grid" aria-hidden>
            {ticks.map((tick, idx) => {
              const pct = ((ticks.length - 1 - idx) / (ticks.length - 1)) * 100
              return (
                <div
                  key={`${tick}-${idx}`}
                  className={`usage-chart-gridline${idx === ticks.length - 1 ? ' is-base' : ''}`}
                  style={{ bottom: `${pct}%` }}
                />
              )
            })}
          </div>

          <div className="usage-chart-groups">
            {groups.map((g) => (
              <div key={g.key} className="usage-bar-group">
                <div className="usage-bar-pair">
                  {renderBar('work', 'Work', g.workVal, g.label)}
                  {renderBar('code', 'Code', g.codeVal, g.label)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="usage-chart-xlabels">
          {groups.map((g) => (
            <span key={g.key} className="usage-chart-xlabel">
              {g.label}
            </span>
          ))}
        </div>
      </div>

      <div className="usage-scene-split" aria-hidden>
        <div className="usage-split-seg work" style={{ width: `${workPct}%` }} />
        <div className="usage-split-seg code" style={{ width: `${codePct}%` }} />
      </div>

      <div className="usage-scene-summary-grid">
        {sceneSummaries.map((item) => (
          <div key={item.key} className={`usage-scene-stat ${item.key}`}>
            <div className="usage-scene-stat-top">
              <span className="usage-scene-badge">
                <span className={`usage-legend-dot ${item.key}`} aria-hidden />
                {item.key === 'work' ? <Briefcase size={13} /> : <Code2 size={13} />}
                <strong>{item.label}</strong>
              </span>
              <span className="usage-scene-share">{item.pct}%</span>
            </div>
            <div className="usage-scene-stat-main">
              <strong>{formatCompactNum(item.data.totalTokens)}</strong>
              <span>{t('settings.usageTurns', { count: item.data.messages })}</span>
            </div>
            <div className="usage-scene-stat-meta">
              <span>
                {t('settings.usageMetricInput')} {formatCompactNum(item.data.inputTokens)}
              </span>
              <span>·</span>
              <span>
                {t('settings.usageMetricOutput')} {formatCompactNum(item.data.outputTokens)}
              </span>
              {item.data.cacheReadTokens > 0 && (
                <>
                  <span>·</span>
                  <span>
                    {t('settings.usageCacheRead')} {formatCompactNum(item.data.cacheReadTokens)}
                  </span>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {untaggedSceneMessages > 0 && (
        <p className="usage-scene-footnote">{t('settings.usageLegacyNote', { count: untaggedSceneMessages })}</p>
      )}
    </div>
  )
}

function UsageSection() {
  const { t } = useTranslation()
  const providers = useStore((s) => s.providers)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    void call('stats.usage')
      .then((res) => setUsage(res))
      .catch(() => setUsage(null))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  const providerName = (id: string) => {
    if (id === 'default') return t('settings.usageProviderFallback')
    const found = providers.find((p) => p.id === id)
    return found ? formatProviderName(found, t) : id
  }

  return (
    <div className="settings-pane">
      <div className="settings-pane-top">
        <div className="settings-pane-head">
          <h3>{t('settings.usageTitle')}</h3>
          <p>{t('settings.usageDesc')}</p>
        </div>
        <button type="button" className="btn btn-small" disabled={loading} onClick={load}>
          <RefreshCw size={14} className={loading ? 'spin' : undefined} />
          {t('settings.usageRefresh')}
        </button>
      </div>

      {usage && (
        <>
          <div className="usage-kpi-grid">
            <div className="usage-kpi">
              <span className="usage-kpi-label">{t('settings.usageConversations')}</span>
              <strong className="usage-kpi-val">{usage.conversations}</strong>
            </div>
            <div className="usage-kpi">
              <span className="usage-kpi-label">{t('settings.usageMessages')}</span>
              <strong className="usage-kpi-val">
                {usage.userMessages} / {usage.assistantMessages}
              </strong>
            </div>
            <div className="usage-kpi">
              <span className="usage-kpi-label">{t('settings.usageInputTokens')}</span>
              <strong className="usage-kpi-val">{formatCompactNum(usage.inputTokens)}</strong>
            </div>
            <div className="usage-kpi">
              <span className="usage-kpi-label">{t('settings.usageOutputTokens')}</span>
              <strong className="usage-kpi-val">{formatCompactNum(usage.outputTokens)}</strong>
            </div>
          </div>

          <div className="usage-cache-row">
            <span className="summary-pill">
              {t('settings.usageCacheRead')}: <strong>{formatCompactNum(usage.cacheReadTokens)}</strong>
            </span>
            <span className="summary-pill">
              {t('settings.usageCacheWrite')}: <strong>{formatCompactNum(usage.cacheWriteTokens)}</strong>
            </span>
          </div>

          <SceneUsageChart
            work={usage.byScene.work}
            code={usage.byScene.code}
            untaggedSceneMessages={usage.untaggedSceneMessages}
          />

          {usage.byProvider.length > 0 ? (
            <div className="usage-table-wrap">
              <div className="settings-sub-label">
                <strong>{t('settings.usageByProvider')}</strong>
              </div>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t('settings.usageProviderCol')}</th>
                    <th>{t('settings.usageChatsCol')}</th>
                    <th>{t('settings.usageTokensCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byProvider.map((row) => (
                    <tr key={row.providerId}>
                      <td>{providerName(row.providerId)}</td>
                      <td className="mono">{row.conversations}</td>
                      <td className="mono">
                        {formatCompactNum(row.inputTokens)} / {formatCompactNum(row.outputTokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">{t('settings.usageEmpty')}</p>
          )}
        </>
      )}
    </div>
  )
}

function ImportExportSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const providers = useStore((s) => s.providers)
  const activeChatId = useStore((s) => s.activeChatId)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExportSettings = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'Atrium',
      settings: {
        locale: settings.locale,
        theme: settings.theme,
        proxyMode: settings.proxyMode,
        proxyUrl: settings.proxyUrl,
        transcriptWidth: settings.transcriptWidth ?? 'default',
        defaultTranscriptView: settings.defaultTranscriptView ?? 'normal',
        codeFont: settings.codeFont,
        codeFontSize: settings.codeFontSize ?? 13,
        codeThemeLight: settings.codeThemeLight ?? 'atrium',
        codeThemeDark: settings.codeThemeDark ?? 'atrium',
        allowBypassPermissions: settings.allowBypassPermissions !== false,
        webEnabled: settings.webEnabled !== false,
        browserMode: settings.browserMode,
        autoCompact: settings.autoCompact !== false,
        contextWindowTokens: normalizeContextWindowTokens(settings.contextWindowTokens),
        reasoningEffort: settings.reasoningEffort ?? 'medium',
        workScene: settings.workScene ?? 'code',
        maxAgentRounds: settings.maxAgentRounds ?? 40,
        autoExtractMemory: settings.autoExtractMemory !== false,
        enablePluginHooks: Boolean(settings.enablePluginHooks),
      },
      providers: providers.map((p) => ({
        name: formatProviderName(p, t),
        protocol: p.protocol,
        baseUrl: p.managedBy === 'relaypulse' ? '' : p.baseUrl,
        model: p.model,
      })),
    }
    downloadBlob(`atrium-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2))
    toast(t('settings.exportSettingsDone'))
  }

  const handleImportFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const patch = extractSafeSettingsPatch(parsed)
      if (!patch) {
        toast(t('settings.importSettingsInvalid'), 'error')
        return
      }
      const next = await call('settings.update', patch)
      setState({ settings: next })
      toast(t('settings.importSettingsDone'))
    } catch {
      toast(t('settings.importSettingsInvalid'), 'error')
    }
  }

  const handleExportChat = async (format: 'md' | 'json') => {
    if (!activeChatId) return
    const conv = await call('chats.get', activeChatId).catch(() => null)
    if (!conv) {
      toast(t('settings.exportChatNone'), 'error')
      return
    }
    const safeTitle = (conv.title || 'chat').replace(/[<>:"/\\|?*]+/g, '-').slice(0, 48)
    if (format === 'json') {
      downloadBlob(`${safeTitle}.json`, JSON.stringify(conv, null, 2))
    } else {
      const lines: string[] = [`# ${conv.title || 'Atrium Chat'}`, '']
      for (const m of conv.messages) {
        if (m.role === 'user') {
          lines.push(`## User`, '', m.text, '')
        } else if (m.role === 'assistant') {
          lines.push(`## Assistant`, '')
          if (m.reasoning?.trim()) {
            lines.push(`<details><summary>Reasoning</summary>\n\n${m.reasoning.trim()}\n\n</details>`, '')
          }
          if (m.text.trim()) lines.push(m.text.trim(), '')
        } else if (m.role === 'tool') {
          lines.push(`### Tool: \`${m.name}\``, '', '```', m.output.slice(0, 4000), '```', '')
        }
      }
      downloadBlob(`${safeTitle}.md`, lines.join('\n'), 'text/markdown;charset=utf-8')
    }
    toast(t('settings.exportChatDone'))
  }

  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.tabs.import')}</h3>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.exportSettings')}</strong>
            <span>{t('settings.exportSettingsHint')}</span>
          </div>
          <button type="button" className="btn btn-small" onClick={handleExportSettings}>
            <Download size={14} />
            {t('settings.exportSettingsBtn')}
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.importSettings')}</strong>
            <span>{t('settings.importSettingsHint')}</span>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImportFile(f)
                e.target.value = ''
              }}
            />
            <button type="button" className="btn btn-small" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} />
              {t('settings.importSettingsBtn')}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.exportChat')}</h3>
          <p>{activeChatId ? t('settings.exportChatHint') : t('settings.exportChatNone')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.exportChat')}</strong>
            <span>{t('settings.exportChatHint')}</span>
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn-small" disabled={!activeChatId} onClick={() => void handleExportChat('md')}>
              <FileText size={14} />
              {t('settings.exportChatMd')}
            </button>
            <button type="button" className="btn btn-small" disabled={!activeChatId} onClick={() => void handleExportChat('json')}>
              <FileJson size={14} />
              {t('settings.exportChatJson')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SystemSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const [proxyUrl, setProxyUrl] = useState(settings.proxyUrl ?? '')
  const [shortcutInput, setShortcutInput] = useState(settings.quickEntryShortcut ?? 'Alt+Space')
  const [voiceUrl, setVoiceUrl] = useState(settings.voiceEndpoint ?? '')
  const [voiceModel, setVoiceModel] = useState(settings.voiceModel ?? 'whisper-1')
  const [voiceKey, setVoiceKey] = useState('')
  const [hasSpeechKey, setHasSpeechKey] = useState(false)

  useEffect(() => {
    setProxyUrl(settings.proxyUrl ?? '')
    setShortcutInput(settings.quickEntryShortcut ?? 'Alt+Space')
    setVoiceUrl(settings.voiceEndpoint ?? '')
    setVoiceModel(settings.voiceModel ?? 'whisper-1')
  }, [settings.proxyUrl, settings.quickEntryShortcut, settings.voiceEndpoint, settings.voiceModel])

  useEffect(() => {
    void call('speech.hasKey').then((r) => setHasSpeechKey(r.hasKey)).catch(() => undefined)
  }, [])

  return (
    <div className="settings-pane">
      <UpdatesCard />

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('settings.network')}</h3>
          <p>{t('settings.proxyHint')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.proxy')}</strong>
          </div>
          <div className="seg" role="radiogroup" aria-label={t('settings.proxy')}>
            {(['system', 'custom', 'none'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={settings.proxyMode === mode}
                className={`seg-btn${settings.proxyMode === mode ? ' active' : ''}`}
                onClick={() => void updateSetting({ proxyMode: mode })}
              >
                {t(mode === 'system' ? 'settings.proxySystem' : mode === 'custom' ? 'settings.proxyCustom' : 'settings.proxyNone')}
              </button>
            ))}
          </div>
        </div>

        {settings.proxyMode === 'custom' && (
          <div className="setting-row">
            <div className="setting-row-meta">
              <strong>{t('settings.proxyCustom')}</strong>
            </div>
            <input
              className="input mono proxy-input"
              value={proxyUrl}
              placeholder="http://127.0.0.1:7890"
              onChange={(e) => setProxyUrl(e.target.value)}
              onBlur={() => void updateSetting({ proxyUrl: proxyUrl.trim() || undefined })}
            />
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('automations.backgroundTitle')}</h3>
          <p>{t('automations.backgroundHint')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('automations.runInBackground')}</strong>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={Boolean(settings.runInBackground)}
              onChange={(e) => void updateSetting({ runInBackground: e.target.checked })}
            />
            <span />
          </label>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('quick.settingsTitle')}</h3>
          <p>{t('quick.settingsHint')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('quick.shortcutLabel')}</strong>
            <span>{t('quick.shortcutHint')}</span>
          </div>
          <div className="row-actions">
            <input
              type="text"
              className="input mono settings-code-input"
              value={shortcutInput}
              placeholder="Alt+Space"
              onChange={(e) => setShortcutInput(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() => void updateSetting({ quickEntryShortcut: shortcutInput.trim() }).then(() => toast(t('quick.shortcutSaved')))}
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-pane-head">
          <h3>{t('voice.settingsTitle')}</h3>
          <p>{t('voice.settingsHint')}</p>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('voice.modeLabel')}</strong>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('voice.modeLabel')}
            value={settings.voiceMode ?? 'auto'}
            options={[
              { value: 'auto', label: t('voice.modes.auto') },
              { value: 'whisper', label: t('voice.modes.whisper') },
              { value: 'system', label: t('voice.modes.system') },
            ]}
            onChange={(val) => void updateSetting({ voiceMode: val as VoiceMode })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('voice.languageLabel')}</strong>
          </div>
          <StudioSelect
            className="settings-select"
            ariaLabel={t('voice.languageLabel')}
            value={settings.voiceLanguage ?? 'auto'}
            options={[
              { value: 'auto', label: t('settings.system') },
              { value: 'zh-CN', label: '中文', hint: 'zh-CN' },
              { value: 'en-US', label: 'English', hint: 'en-US' },
            ]}
            onChange={(val) => void updateSetting({ voiceLanguage: String(val) })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('voice.endpointLabel')}</strong>
            <span>{t('voice.endpointHint')}</span>
          </div>
          <input
            type="text"
            className="input mono proxy-input"
            value={voiceUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => setVoiceUrl(e.target.value)}
            onBlur={() => void updateSetting({ voiceEndpoint: voiceUrl.trim() })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('voice.modelLabel')}</strong>
          </div>
          <input
            type="text"
            className="input mono settings-code-input"
            value={voiceModel}
            placeholder="whisper-1"
            onChange={(e) => setVoiceModel(e.target.value)}
            onBlur={() => void updateSetting({ voiceModel: voiceModel.trim() || 'whisper-1' })}
          />
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('voice.apiKeyLabel')}</strong>
            <span>{hasSpeechKey ? t('voice.apiKeySaved') : t('voice.apiKeyHint')}</span>
          </div>
          <div className="row-actions">
            <input
              type="password"
              className="input mono settings-code-input"
              value={voiceKey}
              placeholder={hasSpeechKey ? '••••••••' : 'sk-...'}
              onChange={(e) => setVoiceKey(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() =>
                void call('speech.saveKey', voiceKey.trim() || null).then((r) => {
                  setHasSpeechKey(r.hasKey)
                  setVoiceKey('')
                  toast(t('voice.apiKeyUpdated'))
                })
              }
            >
              {voiceKey.trim() ? t('common.save') : hasSpeechKey ? t('common.remove') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UpdatesCard() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const updateState = useStore((s) => s.update)
  const [feedInput, setFeedInput] = useState(settings.updateUrl ?? '')
  const [infoVersion, setInfoVersion] = useState<string | null>(null)

  useEffect(() => {
    setFeedInput(settings.updateUrl ?? '')
  }, [settings.updateUrl])

  useEffect(() => {
    void shell.info().then((info) => setInfoVersion(info.version))
  }, [])

  const currentVersion = updateState?.currentVersion ?? infoVersion ?? '0.2.0'
  const checking = updateState?.status === 'checking'
  const downloading = updateState?.status === 'downloading'
  const downloaded = updateState?.status === 'downloaded'
  const available = updateState?.status === 'available'
  const sizeLabel =
    updateState?.downloadSize && Number.isFinite(updateState.downloadSize)
      ? `${(updateState.downloadSize / (1024 * 1024)).toFixed(1)} MB`
      : null
  const isSkippedVersion = Boolean(updateState?.version && settings.skippedUpdateVersion === updateState.version)

  const saveFeedIfChanged = async (): Promise<string | undefined> => {
    const trimmed = feedInput.trim() || undefined
    if (trimmed !== (settings.updateUrl ?? undefined)) {
      await updateSetting({ updateUrl: trimmed })
      setState({ update: await shell.updateState().catch(() => updateState) })
    }
    return trimmed
  }

  const onCheck = async () => {
    try {
      const feedUrl = await saveFeedIfChanged()
      await checkForUpdates(feedUrl)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="settings-group">
      <div className="settings-pane-top">
        <div className="settings-pane-head">
          <h3>{t('updates.title')}</h3>
          <p>{t('updates.hint')}</p>
        </div>
        <div className="row-actions">
          {available && !downloaded && (
            <>
              {updateState?.version && !isSkippedVersion && (
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void skipUpdateVersion(updateState.version!)}
                >
                  {t('updates.skipVersion')}
                </button>
              )}
              <button type="button" className="btn btn-primary btn-small" onClick={() => void downloadAppUpdate()}>
                <Download size={14} />
                {t('updates.updateNow')}
              </button>
            </>
          )}
          {!available && (
            <button type="button" className="btn btn-small" disabled={checking || downloading} onClick={() => void onCheck()}>
              <RefreshCw size={14} className={checking ? 'spin' : undefined} />
              {checking ? t('updates.checking') : t('updates.check')}
            </button>
          )}
        </div>
      </div>

      <div className="update-meta-row">
        <span className="summary-pill">{t('updates.currentVersion', { version: currentVersion })}</span>
        {updateState?.status === 'not-available' && (
          <span className="chip chip-done">
            <CheckCircle2 size={12} />
            {t('updates.upToDate')}
          </span>
        )}
        {available && updateState?.version && (
          <span className="chip chip-running">{t('updates.available', { version: updateState.version })}</span>
        )}
        {sizeLabel && <span className="summary-pill">{sizeLabel}</span>}
        {settings.skippedUpdateVersion && (
          <span className="summary-pill">
            {t('updates.skippedHint', { version: settings.skippedUpdateVersion })}
            <button
              type="button"
              className="update-unskip-btn"
              onClick={() => void clearSkippedUpdateVersion()}
            >
              {t('updates.clearSkipped', { version: settings.skippedUpdateVersion })}
            </button>
          </span>
        )}
      </div>

      {available && !downloaded && updateState?.releaseNotes && (
        <div className="update-banner available">
          <div className="update-banner-text">
            <strong>{t('updates.availableTitle', { version: updateState.version ?? '' })}</strong>
            <p className="small muted update-notes-pre">{updateState.releaseNotes}</p>
          </div>
          <button type="button" className="btn btn-small" disabled={checking} onClick={() => void onCheck()}>
            <RefreshCw size={13} className={checking ? 'spin' : undefined} />
            {t('updates.check')}
          </button>
        </div>
      )}

      {downloaded && (
        <div className="update-banner ready">
          <div className="update-banner-text">
            <strong>{updateState?.version ? t('updates.ready', { version: updateState.version }) : t('updates.restartToUpgrade')}</strong>
            {updateState?.releaseNotes && <p className="small muted update-notes-pre">{updateState.releaseNotes}</p>}
          </div>
          <button type="button" className="btn btn-primary btn-small" onClick={() => void installAppUpdate()}>
            <RotateCw size={14} />
            {t('updates.restartToUpgrade')}
          </button>
        </div>
      )}

      {downloading && (
        <div className="update-progress-box">
          <div className="update-progress-head">
            <span>{t('updates.downloading', { version: updateState?.version ?? '', percent: updateState?.percent ?? 0 })}</span>
            <span className="mono small">{updateState?.percent ?? 0}%</span>
          </div>
          <div className="update-progress-track" role="progressbar" aria-valuenow={updateState?.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="update-progress-fill" style={{ width: `${updateState?.percent ?? 0}%` }} />
          </div>
        </div>
      )}

      {updateState?.status === 'error' && updateState.error && (
        <p className="warn">{updateState.error === 'NOT_CONFIGURED' ? t('updates.notConfigured') : t('updates.failed', { message: updateState.error })}</p>
      )}

      <div className="setting-row">
        <div className="setting-row-meta">
          <strong>{t('updates.feedUrl')}</strong>
        </div>
        <input
          className="input mono settings-feed-input"
          type="url"
          value={feedInput}
          placeholder={
            updateState?.feedUrl && !/rpulse\.top/i.test(updateState.feedUrl)
              ? updateState.feedUrl
              : t('updates.feedUrlPlaceholder')
          }
          onChange={(e) => setFeedInput(e.target.value)}
          onBlur={() => void saveFeedIfChanged()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void onCheck()
            }
          }}
        />
      </div>

      <div className="setting-row">
        <div className="setting-row-meta">
          <strong>{t('updates.autoDownload')}</strong>
          <span>{t('updates.autoDownloadHint')}</span>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.autoUpdate === true}
            onChange={(e) =>
              void updateSetting({ autoUpdate: e.target.checked }).then(async () => {
                setState({ update: await shell.updateState().catch(() => updateState) })
              })
            }
            aria-label={t('updates.autoDownload')}
          />
          <span />
        </label>
      </div>
    </div>
  )
}

function DeveloperSection() {
  const { t } = useTranslation()
  const [runtimes, setRuntimes] = useState<RuntimeInfo[] | null>(null)
  const [info, setInfo] = useState<{ version: string; userData: string } | null>(null)
  const [copiedPath, setCopiedPath] = useState(false)

  const loadRuntimes = () => call('system.runtimes').then(setRuntimes, () => setRuntimes([]))

  useEffect(() => {
    void loadRuntimes()
    void shell.info().then(setInfo)
  }, [])

  const copyUserData = () => {
    if (!info?.userData) return
    void navigator.clipboard.writeText(info.userData).then(() => {
      setCopiedPath(true)
      setTimeout(() => setCopiedPath(false), 1800)
    })
  }

  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-top">
          <div className="settings-pane-head">
            <h3>{t('settings.programs')}</h3>
          </div>
          <button type="button" className="btn btn-small" onClick={() => void loadRuntimes()}>
            <RefreshCw size={14} />
            {t('settings.recheck')}
          </button>
        </div>

        <ul className="runtimes">
          {(runtimes ?? []).map((r) => {
            const fullVersion = r.version?.trim() ?? ''
            const shortVersion = fullVersion.replace(/\s*\([^)]+\)\s*$/, '').trim()
            const label = r.found ? `${t('settings.found')}${shortVersion ? ` ${shortVersion}` : ''}` : t('settings.missing')
            return (
              <li key={r.id} className="runtime-pill" title={fullVersion ? `${r.id}: ${fullVersion}` : undefined}>
                <span className={`dot dot-${r.found ? 'connected' : 'off'}`} aria-hidden />
                <code>{r.id}</code>
                <span className="muted">{label}</span>
              </li>
            )
          })}
        </ul>
      </div>

      {info && (
        <div className="settings-group">
          <div className="settings-pane-head">
            <h3>Atrium</h3>
          </div>

          <div className="setting-row">
            <div className="setting-row-meta">
              <strong>{t('settings.version', { version: info.version })}</strong>
            </div>
            <span className="summary-pill">v{info.version}</span>
          </div>

          <div className="setting-row">
            <div className="setting-row-meta">
              <strong>{t('settings.platform')}</strong>
            </div>
            <span className="summary-pill">{navigator.platform}</span>
          </div>

          <div className="setting-row">
            <div className="setting-row-meta">
              <strong>{t('settings.dataFolder')}</strong>
              <code className="settings-path-code">{info.userData}</code>
            </div>
            <button type="button" className="btn btn-small" onClick={copyUserData}>
              {copiedPath ? <Check size={14} /> : <Copy size={14} />}
              {copiedPath ? t('common.copied') : t('settings.copyPath')}
            </button>
          </div>

          <div className="setting-row">
            <div className="setting-row-meta">
              <strong>{t('settings.encryptionStatus')}</strong>
              <span>{t('settings.encryptionValue')}</span>
            </div>
            <span className="chip chip-done">
              <Lock size={12} />
              safeStorage
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function SkillsSection() {
  const { t } = useTranslation()
  const skills = useStore((s) => s.skills)
  const workspace = useStore((s) => s.settings?.workspace)

  useEffect(() => {
    void refreshSkills(workspace)
  }, [workspace])

  const toggleSkill = async (name: string, enabled: boolean) => {
    try {
      await call('skills.setEnabled', name, enabled, workspace)
      await refreshSkills(workspace)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-pane-top">
        <div className="settings-pane-head">
          <h3>{t('settings.tabs.skills')}</h3>
          <p>{t('settings.skillsSectionDesc')}</p>
        </div>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => navigate({ view: 'connections', chatId: null, connectionsTab: 'skills' })}
        >
          {t('settings.manageSkills')}
        </button>
      </div>

      {skills.length === 0 ? (
        <p className="muted small">{t('skills.emptyTitle')}</p>
      ) : (
        <div className="settings-group">
          {skills.map((s) => (
            <div key={`${s.scope}:${s.name}`} className="setting-row">
              <div className="setting-row-meta">
                <div className="settings-inline-tags">
                  <strong>{s.name}</strong>
                  <span className="summary-pill">{t(`skills.scopeTag.${s.scope}`)}</span>
                </div>
                <span>{s.description}</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={(e) => void toggleSkill(s.name, e.target.checked)}
                  aria-label={s.name}
                />
                <span />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConnectorsSection() {
  const { t } = useTranslation()
  const servers = useStore((s) => s.servers)
  const statuses = useStore((s) => s.statuses)

  const toggleServer = async (id: string, enabled: boolean) => {
    try {
      const next = await call('mcp.setEnabled', id, enabled)
      setState((s) => ({
        servers: s.servers.map((srv) => (srv.id === id ? { ...srv, enabled } : srv)),
        statuses: { ...s.statuses, [id]: next },
      }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-pane-top">
        <div className="settings-pane-head">
          <h3>{t('settings.tabs.connectors')}</h3>
          <p>{t('settings.connectorsSectionDesc')}</p>
        </div>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => navigate({ view: 'connections', chatId: null, connectionsTab: 'mcp' })}
        >
          {t('settings.manageConnectors')}
        </button>
      </div>

      {servers.length === 0 ? (
        <p className="muted small">{t('settings.noConnectors')}</p>
      ) : (
        <div className="settings-group">
          {servers.map((srv) => {
            const st = statuses[srv.id]
            const state = st?.state ?? (srv.enabled ? 'connecting' : 'off')
            const toolCount = st?.tools.length ?? 0
            return (
              <div key={srv.id} className="setting-row">
                <div className="setting-row-meta">
                  <div className="settings-inline-tags">
                    <span className={`dot dot-${state}`} aria-hidden />
                    <strong>{srv.name}</strong>
                    <span className="summary-pill">{t(`connections.state.${state}`)}</span>
                    {toolCount > 0 && <span className="summary-pill">{t('settings.toolsCount', { count: toolCount })}</span>}
                  </div>
                  <span>{srv.transport === 'http' ? (srv.url ?? '') : [srv.command, ...(srv.args ?? [])].filter(Boolean).join(' ')}</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={srv.enabled}
                    onChange={(e) => void toggleServer(srv.id, e.target.checked)}
                    aria-label={srv.name}
                  />
                  <span />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MarketplaceSection() {
  const { t } = useTranslation()
  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-top">
          <div className="settings-pane-head">
            <h3>{t('settings.tabs.marketplace')}</h3>
            <p>{t('settings.marketplaceSectionDesc')}</p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={() => {
              closeSettings()
              navigate({ view: 'market', chatId: null })
            }}
          >
            <Store size={14} />
            {t('settings.openMarketplace')}
          </button>
        </div>

        <div className="setting-line">
          <span>{t('settings.marketplaceTip')}</span>
        </div>
      </div>
    </div>
  )
}

function PluginsSection() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)!
  const plugins = useStore((s) => s.plugins)
  const discovered = useStore((s) => s.discoveredPlugins)
  const [scanning, setScanning] = useState(false)

  const autoDetect = !settings.pluginDiscoveryDismissed
  const unimportedCount = discovered.filter((d) => !d.alreadyImported).length

  const toggleAutoDetect = async (enabled: boolean) => {
    const next = await call('settings.update', { pluginDiscoveryDismissed: !enabled })
    setState({ settings: next })
  }

  const handleScan = async () => {
    setScanning(true)
    try {
      const list = await scanLocalPlugins({ autoPrompt: false, openModal: false, workspace: settings.workspace })
      if (list.length === 0) {
        toast(t('plugins.discoverNoFound'))
      } else {
        setState({ pluginDiscoveryOpen: true })
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="settings-pane">
      <div className="settings-group">
        <div className="settings-pane-top">
          <div className="settings-pane-head">
            <h3>{t('plugins.tab')}</h3>
            <p>{t('settings.pluginsSectionDesc')}</p>
          </div>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              closeSettings()
              navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
            }}
          >
            {t('settings.managePlugins')}
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.pluginsAutoDetect')}</strong>
            <span>{t('settings.pluginsAutoDetectHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={autoDetect}
              onChange={(e) => void toggleAutoDetect(e.target.checked)}
              aria-label={t('settings.pluginsAutoDetect')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('settings.pluginsEnableHooks')}</strong>
            <span>{t('settings.pluginsEnableHooksHint')}</span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={Boolean(settings.enablePluginHooks)}
              onChange={(e) => void updateSetting({ enablePluginHooks: e.target.checked })}
              aria-label={t('settings.pluginsEnableHooks')}
            />
            <span />
          </label>
        </div>

        <div className="setting-row">
          <div className="setting-row-meta">
            <strong>{t('plugins.scanBtn')}</strong>
            <span>
              {t('plugins.enabledCount', {
                enabled: plugins.filter((p) => p.enabled).length,
                total: plugins.length,
              })}
              {unimportedCount > 0 ? ` · ${t('plugins.discoverFoundBanner', { count: unimportedCount })}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-small"
            disabled={scanning}
            onClick={() => void handleScan()}
          >
            <RefreshCw size={13} className={scanning ? 'spin' : undefined} />
            {scanning ? t('plugins.scanning') : t('plugins.scanBtn')}
          </button>
        </div>
      </div>
    </div>
  )
}
