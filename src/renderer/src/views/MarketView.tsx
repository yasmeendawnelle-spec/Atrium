import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, GitBranch, Package, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GithubImportResult, InstallOption, MarketItem } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { navigate, refreshPlugins, toast, useStore } from '../lib/store.ts'
import { formFromOption } from '../lib/serverForm.ts'
import { ServerWizard } from '../components/ServerWizard.tsx'
import { OptionList } from '../components/OptionList.tsx'
import { Tile } from '../components/Tile.tsx'
import type { WizardState } from './ConnectionsView.tsx'

export function MarketView() {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<MarketItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [wizard, setWizard] = useState<WizardState | null>(null)
  const seq = useRef(0)

  const load = async (q: string, after?: string) => {
    const id = ++seq.current
    setLoading(true)
    setError('')
    try {
      const result = await call('market.search', q, after)
      if (id !== seq.current) return
      setItems((prev) => (after ? [...prev, ...result.items] : result.items))
      setCursor(result.nextCursor)
    } catch (err) {
      if (id === seq.current) setError(errorMessage(err))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 350 : 0)
    return () => clearTimeout(timer)
  }, [query])

  const install = (option: InstallOption, name: string) =>
    setWizard({ title: t('wizard.installTitle', { name }), form: formFromOption(option), note: t('market.unofficial') })

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="display">{t('market.title')}</h1>
          <p className="page-intro">{t('market.intro')}</p>
        </div>
      </header>

      <div className="market-toolbar">
        <GithubImport onPick={(option) => install(option, option.config.name)} />
        <label className="search">
          <Search size={16} />
          <input value={query} placeholder={t('market.search')} onChange={(e) => setQuery(e.target.value)} aria-label={t('market.search')} />
        </label>
      </div>

      {error && <p className="warn">{error}</p>}
      <ul className="market-grid">
        {items.map((item) => (
          <MarketCard key={item.id} item={item} onInstall={(option) => install(option, item.name)} />
        ))}
      </ul>
      {!loading && !error && items.length === 0 && <p className="empty">{t('market.noResults')}</p>}
      {loading && <p className="muted">{t('common.loading')}</p>}
      {!loading && cursor && (
        <button className="btn load-more" onClick={() => void load(query, cursor)}>
          {t('market.loadMore')}
        </button>
      )}
      {wizard && <ServerWizard title={wizard.title} initial={wizard.form} note={wizard.note} onClose={() => setWizard(null)} />}
    </section>
  )
}

function MarketCard({ item, onInstall }: { item: MarketItem; onInstall: (option: InstallOption) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const first = item.installs[0]
  return (
    <li className="market-card">
      <div className="market-card-head">
        <Tile name={item.name} />
        <div className="market-card-titles">
          <div className="market-card-top">
            <span className="row-title">{item.name}</span>
            {item.version && <span className="chip">v{item.version}</span>}
          </div>
          <span className="row-meta mono">{item.title}</span>
        </div>
        {item.repositoryUrl && (
          <button className="icon-btn" onClick={() => void shell.openExternal(item.repositoryUrl!)} aria-label={t('market.repo')}>
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      <p className="market-card-desc">{item.description || item.title}</p>

      <div className="market-card-foot">
        {first ? (
          <button
            type="button"
            className="cmd-pill"
            title={t('common.copy')}
            onClick={() => void navigator.clipboard.writeText(first.label).then(() => toast(t('common.copied')))}
          >
            <code className="cmd-pill-text">{first.label}</code>
            <Copy size={11} className="cmd-pill-copy" aria-hidden />
          </button>
        ) : (
          <span className="row-meta">{item.title}</span>
        )}
        <button className="btn btn-small" onClick={() => (item.installs.length > 1 ? setOpen(!open) : first && onInstall(first))}>
          {t('market.install')}
        </button>
      </div>

      {item.installs.length > 1 && (
        <div className={`row-expand${open ? ' open' : ''}`}>
          <div className="row-expand-inner">
            <div className="row-detail">
              <OptionList options={item.installs} onPick={onInstall} />
            </div>
          </div>
        </div>
      )}
    </li>
  )
}

function GithubImport({ onPick }: { onPick: (option: InstallOption) => void }) {
  const { t } = useTranslation()
  const workspace = useStore((s) => s.settings?.workspace)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [installingBundle, setInstallingBundle] = useState(false)
  const [result, setResult] = useState<GithubImportResult | null>(null)
  const [error, setError] = useState('')

  const read = async () => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      setResult(await call('market.importGithub', url))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const installBundle = async () => {
    if (!result?.plugin) return
    setInstallingBundle(true)
    try {
      const res = await call('plugins.importGithub', result.plugin.repoUrl)
      await refreshPlugins(workspace)
      const installedName = res.installed[0]?.displayName || res.installed[0]?.name || result.plugin.name
      toast(t('plugins.bundleInstalled', { name: installedName }))
      navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setInstallingBundle(false)
    }
  }

  return (
    <div className="github-import">
      <div className="github-head">
        <span className="github-head-label">
          <GitBranch size={15} />
          <span className="github-title">{t('market.github')}</span>
        </span>
        <span className="github-hint muted small">{t('market.githubHint')}</span>
      </div>
      <div className="github-line">
        <input className="input mono" value={url} placeholder={t('market.githubPlaceholder')} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void read()} />
        <button className="btn" onClick={() => void read()} disabled={busy || !url.trim()}>
          {busy ? t('market.reading') : t('market.readRepo')}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {result && (
        <div className="github-result">
          {result.description && <p>{result.description}</p>}
          {result.sources.length > 0 && <p className="muted small">{t('market.sources', { files: result.sources.join(', ') })}</p>}
          {result.plugin && (
            <div className="plugin-bundle-card">
              <div className="plugin-bundle-main">
                <div className="row-line">
                  <Package size={15} />
                  <strong>{t('plugins.bundleDetected', { name: result.plugin.name })}</strong>
                </div>
                <div className="plugin-meta-chips">
                  {result.plugin.skillNames.length > 0 && (
                    <span className="skill-asset-chip">{t('plugins.skillsCount', { count: result.plugin.skillNames.length })}</span>
                  )}
                  {result.plugin.commandNames.length > 0 && (
                    <span className="skill-asset-chip">{t('plugins.commandsCount', { count: result.plugin.commandNames.length })}</span>
                  )}
                  {result.plugin.ruleFiles.length > 0 && (
                    <span className="skill-asset-chip">{t('plugins.rulesCount', { count: result.plugin.ruleFiles.length })}</span>
                  )}
                  {result.plugin.mcpCount > 0 && (
                    <span className="skill-asset-chip">{t('plugins.mcpCount', { count: result.plugin.mcpCount })}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={installingBundle}
                onClick={() => void installBundle()}
              >
                {installingBundle ? t('plugins.installing') : t('plugins.bundleInstall')}
              </button>
            </div>
          )}
          {result.warning && <p className="warn">{result.warning}</p>}
          {result.installs.length > 0 && <OptionList options={result.installs} onPick={onPick} />}
        </div>
      )}
    </div>
  )
}
