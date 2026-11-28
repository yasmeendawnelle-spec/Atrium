import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BadgeCheck,
  Check,
  ClipboardCheck,
  Compass,
  ExternalLink,
  FileText,
  GitBranch,
  Package,
  Search,
  ShieldCheck,
  Star,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  InstallOption,
  MarketCatalogResult,
  MarketExternalHit,
  MarketExternalSource,
  MarketIdentity,
  MarketPluginListing,
  MarketSearchScope,
  MarketUnifiedSearchResult,
} from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { formFromOption } from '../lib/serverForm.ts'
import { refreshPlugins, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import {
  MarketGithubImportModal,
  MarketMySubmissionsModal,
  MarketPluginDetailModal,
  MarketReviewModal,
  MarketUploadModal,
  PluginAvatarIcon,
} from '../components/MarketModals.tsx'
import { OptionList } from '../components/OptionList.tsx'
import { ServerWizard } from '../components/ServerWizard.tsx'
import type { WizardState } from './ConnectionsView.tsx'

const SOURCE_SCOPES: readonly MarketSearchScope[] = ['all', 'atrium', 'github', 'claude', 'chatgpt', 'dsh']

function sourceLabelKey(scope: MarketSearchScope) {
  switch (scope) {
    case 'all':
      return 'marketHub.scopeAll' as const
    case 'atrium':
      return 'marketHub.scopeAtrium' as const
    case 'github':
      return 'marketHub.scopeGithub' as const
    case 'claude':
      return 'marketHub.scopeClaude' as const
    case 'chatgpt':
      return 'marketHub.scopeChatgpt' as const
    case 'dsh':
      return 'marketHub.scopeDsh' as const
  }
}

function externalSourceBadgeLabel(source: MarketExternalSource): string {
  switch (source) {
    case 'claude':
      return 'Claude'
    case 'chatgpt':
      return 'ChatGPT'
    case 'dsh':
      return 'DSH'
    default:
      return 'GitHub'
  }
}

export function MarketView() {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const workspace = useStore((s) => s.settings?.workspace)
  const installedPlugins = useStore((s) => s.plugins)

  const [catalog, setCatalog] = useState<MarketCatalogResult>({ official: [], community: [] })
  const [identity, setIdentity] = useState<MarketIdentity>({
    authenticated: false,
    isCoContributor: false,
    isReviewer: false,
    pendingCount: 0,
  })
  const [loadingCatalog, setLoadingCatalog] = useState(true)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<MarketSearchScope>('all')
  const [searching, setSearching] = useState(false)
  const [searchResult, setSearchResult] = useState<MarketUnifiedSearchResult | null>(null)
  const searchSeq = useRef(0)

  const [uploadOpen, setUploadOpen] = useState(false)
  const [myOpen, setMyOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [githubModalUrl, setGithubModalUrl] = useState<string | null>(null)
  const [detailPlugin, setDetailPlugin] = useState<MarketPluginListing | null>(null)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [wizard, setWizard] = useState<WizardState | null>(null)

  const loadStorefront = async () => {
    setLoadingCatalog(true)
    try {
      const [catRes, meRes] = await Promise.all([
        call('market.catalog'),
        call('market.me').catch(() => ({
          authenticated: false,
          isCoContributor: false,
          isReviewer: false,
          pendingCount: 0,
        })),
      ])
      setCatalog(catRes)
      setIdentity(meRes)
    } finally {
      setLoadingCatalog(false)
    }
  }

  useEffect(() => {
    void loadStorefront()
  }, [])

  const runSearch = async (q: string, nextScope: MarketSearchScope) => {
    const clean = q.trim()
    if (!clean) {
      setSearchResult(null)
      setSearching(false)
      return
    }
    const seqId = ++searchSeq.current
    setSearching(true)
    try {
      const res = await call('market.searchAll', clean, nextScope)
      if (seqId === searchSeq.current) setSearchResult(res)
    } catch (err) {
      if (seqId === searchSeq.current) toast(errorMessage(err), 'error')
    } finally {
      if (seqId === searchSeq.current) setSearching(false)
    }
  }

  useEffect(() => {
    const clean = query.trim()
    if (!clean) {
      searchSeq.current++
      setSearchResult(null)
      setSearching(false)
      return
    }
    const timer = setTimeout(() => void runSearch(clean, scope), 420)
    return () => clearTimeout(timer)
  }, [query, scope])

  const installedIds = useMemo(() => {
    const set = new Set<string>()
    for (const p of installedPlugins) {
      set.add(p.id.toLowerCase())
      if (p.sourcePath.startsWith('atrium-market:')) {
        set.add(p.sourcePath.slice('atrium-market:'.length).toLowerCase())
      }
      if (p.repository) set.add(p.repository.toLowerCase())
    }
    return set
  }, [installedPlugins])

  const isListingInstalled = (item: MarketPluginListing): boolean => {
    if (installedIds.has(item.id.toLowerCase())) return true
    if (item.repoUrl && installedIds.has(item.repoUrl.toLowerCase())) return true
    return false
  }

  const handleInstallListing = async (item: MarketPluginListing) => {
    setInstallingId(item.id)
    try {
      const res = await call('market.installPlugin', item.id)
      await refreshPlugins(workspace)
      const installedName = res.installed[0]?.displayName || res.installed[0]?.name || item.displayName || item.name
      toast(ft('marketHub.installedToast', { name: installedName }))
      setDetailPlugin(null)
      void loadStorefront()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setInstallingId((cur) => (cur === item.id ? null : cur))
    }
  }

  const handleImportExternal = async (hit: MarketExternalHit) => {
    setInstallingId(hit.id)
    try {
      if (hit.originKind === 'local' && hit.localSourcePath) {
        const res = await call('plugins.importLocal', [hit.localSourcePath])
        await refreshPlugins(workspace)
        const installedName = res.installed[0]?.displayName || res.installed[0]?.name || hit.name
        toast(ft('marketHub.installedToast', { name: installedName }))
      } else if (hit.originKind === 'github' && hit.repositoryUrl) {
        setGithubModalUrl(hit.repositoryUrl)
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setInstallingId((cur) => (cur === hit.id ? null : cur))
    }
  }

  const openMcpWizard = (option: InstallOption, name: string) =>
    setWizard({ title: t('wizard.installTitle', { name }), form: formFromOption(option), note: t('market.unofficial') })

  const activeQuery = Boolean(query.trim())

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1 className="display">{ft('marketHub.title')}</h1>
          <p className="page-intro">{ft('marketHub.intro')}</p>
        </div>
        <div className="page-actions market-hero-actions">
          {identity.isReviewer && (
            <button type="button" className="btn" onClick={() => setReviewOpen(true)}>
              <ClipboardCheck size={14} />
              <span>{ft('marketHub.reviewBtn')}</span>
              {identity.pendingCount > 0 && <span className="market-pending-dot">{identity.pendingCount}</span>}
            </button>
          )}
          <button type="button" className="btn" onClick={() => setMyOpen(true)}>
            <FileText size={14} />
            <span>{ft('marketHub.mySubmissionsBtn')}</span>
          </button>
          <button type="button" className="btn" onClick={() => setGithubModalUrl('')}>
            <GitBranch size={14} />
            <span>{ft('marketHub.githubImportBtn')}</span>
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            <Upload size={14} />
            <span>{ft('marketHub.uploadBtn')}</span>
          </button>
        </div>
      </header>

      <div className="market-search-bar-card">
        <label className="search">
          <Search size={16} />
          <input
            value={query}
            placeholder={ft('marketHub.searchPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) void runSearch(query, scope)
            }}
            aria-label={ft('marketHub.searchPlaceholder')}
          />
          {query && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setQuery('')}
              aria-label={ft('marketHub.clearSearch')}
            >
              <X size={14} />
            </button>
          )}
        </label>

        {activeQuery && (
          <div className="market-search-tabs" role="tablist">
            {SOURCE_SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                className={`market-scope-pill${scope === s ? ' active' : ''}`}
                onClick={() => setScope(s)}
              >
                <span>{ft(sourceLabelKey(s))}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {catalog.offline && !activeQuery && (
        <div className="market-offline-banner">
          <Compass size={15} />
          <span>{ft('marketHub.offlineNote')}</span>
        </div>
      )}

      {!activeQuery ? (
        <>
          {/* Official Co-contributor Section */}
          <section className="market-section market-official-section">
            <div className="market-section-head">
              <div className="market-section-title-row">
                <BadgeCheck size={17} className="market-official-icon" />
                <h2>{ft('marketHub.officialSection')}</h2>
                <span className="market-section-pill official">{ft('marketHub.coContributorBadge')}</span>
              </div>
              <p className="muted small">{ft('marketHub.officialSubtitle')}</p>
            </div>

            {loadingCatalog ? (
              <p className="muted">{t('common.loading')}</p>
            ) : catalog.official.length === 0 ? (
              <div className="market-section-empty">
                <Package size={18} />
                <span>{ft('marketHub.emptyOfficial')}</span>
              </div>
            ) : (
              <ul className="market-grid">
                {catalog.official.map((item) => (
                  <CuratedPluginCard
                    key={item.id}
                    item={item}
                    installed={isListingInstalled(item)}
                    installing={installingId === item.id}
                    onInstall={() => void handleInstallListing(item)}
                    onDetails={() => setDetailPlugin(item)}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Reviewed & Approved Community Plugins */}
          <section className="market-section">
            <div className="market-section-head">
              <div className="market-section-title-row">
                <ShieldCheck size={17} className="market-community-icon" />
                <h2>{ft('marketHub.communitySection')}</h2>
                <span className="market-section-pill">{ft('marketHub.approvedBadge')}</span>
              </div>
              <p className="muted small">{ft('marketHub.communitySubtitle')}</p>
            </div>

            {loadingCatalog ? (
              <p className="muted">{t('common.loading')}</p>
            ) : catalog.community.length === 0 ? (
              <div className="market-section-empty">
                <Upload size={18} />
                <span>{ft('marketHub.emptyCommunity')}</span>
              </div>
            ) : (
              <ul className="market-grid">
                {catalog.community.map((item) => (
                  <CuratedPluginCard
                    key={item.id}
                    item={item}
                    installed={isListingInstalled(item)}
                    installing={installingId === item.id}
                    onInstall={() => void handleInstallListing(item)}
                    onDetails={() => setDetailPlugin(item)}
                  />
                ))}
              </ul>
            )}
          </section>

          <p className="market-external-hint muted small">{ft('marketHub.externalSearchNote')}</p>
        </>
      ) : (
        <div className="market-search-results">
          {searching && <p className="muted">{t('common.loading')}</p>}
          {searchResult && searchResult.warnings.length > 0 && (
            <div className="market-offline-banner">
              <Compass size={15} />
              <span>{searchResult.warnings[0]}</span>
            </div>
          )}

          {searchResult && (
            <>
              {searchResult.official.length > 0 && (
                <section className="market-section">
                  <div className="market-section-head">
                    <div className="market-section-title-row">
                      <BadgeCheck size={16} className="market-official-icon" />
                      <h2>{ft('marketHub.officialSection')}</h2>
                    </div>
                  </div>
                  <ul className="market-grid">
                    {searchResult.official.map((item) => (
                      <CuratedPluginCard
                        key={item.id}
                        item={item}
                        installed={isListingInstalled(item)}
                        installing={installingId === item.id}
                        onInstall={() => void handleInstallListing(item)}
                        onDetails={() => setDetailPlugin(item)}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {searchResult.community.length > 0 && (
                <section className="market-section">
                  <div className="market-section-head">
                    <div className="market-section-title-row">
                      <ShieldCheck size={16} className="market-community-icon" />
                      <h2>{ft('marketHub.communitySection')}</h2>
                    </div>
                  </div>
                  <ul className="market-grid">
                    {searchResult.community.map((item) => (
                      <CuratedPluginCard
                        key={item.id}
                        item={item}
                        installed={isListingInstalled(item)}
                        installing={installingId === item.id}
                        onInstall={() => void handleInstallListing(item)}
                        onDetails={() => setDetailPlugin(item)}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {searchResult.external.length > 0 && (
                <section className="market-section">
                  <div className="market-section-head">
                    <div className="market-section-title-row">
                      <Compass size={16} />
                      <h2>{ft('marketHub.externalSectionTitle', { count: searchResult.external.length })}</h2>
                    </div>
                  </div>
                  <ul className="market-grid">
                    {searchResult.external.map((hit) => (
                      <ExternalSearchCard
                        key={hit.id}
                        hit={hit}
                        busy={installingId === hit.id}
                        onImport={() => void handleImportExternal(hit)}
                        onPickMcp={(opt) => openMcpWizard(opt, hit.name)}
                      />
                    ))}
                  </ul>
                </section>
              )}

              {!searching &&
                searchResult.official.length === 0 &&
                searchResult.community.length === 0 &&
                searchResult.external.length === 0 && <p className="empty">{ft('marketHub.searchNoHits')}</p>}
            </>
          )}
        </div>
      )}

      {uploadOpen && (
        <MarketUploadModal
          identity={identity}
          onClose={() => setUploadOpen(false)}
          onSubmitted={() => void loadStorefront()}
        />
      )}
      {myOpen && (
        <MarketMySubmissionsModal
          onClose={() => setMyOpen(false)}
          onChanged={() => void loadStorefront()}
        />
      )}
      {reviewOpen && (
        <MarketReviewModal
          isCoContributor={identity.isCoContributor}
          onClose={() => setReviewOpen(false)}
          onChanged={() => void loadStorefront()}
        />
      )}
      {detailPlugin && (
        <MarketPluginDetailModal
          listing={detailPlugin}
          installed={isListingInstalled(detailPlugin)}
          installing={installingId === detailPlugin.id}
          onInstall={() => void handleInstallListing(detailPlugin)}
          onClose={() => setDetailPlugin(null)}
        />
      )}
      {githubModalUrl !== null && (
        <MarketGithubImportModal
          initialUrl={githubModalUrl}
          onPickMcp={(opt) => {
            setGithubModalUrl(null)
            openMcpWizard(opt, opt.config.name)
          }}
          onClose={() => setGithubModalUrl(null)}
        />
      )}
      {wizard && (
        <ServerWizard
          title={wizard.title}
          initial={wizard.form}
          note={wizard.note}
          onClose={() => setWizard(null)}
        />
      )}
    </section>
  )
}

function CuratedPluginCard({
  item,
  installed,
  installing,
  onInstall,
  onDetails,
}: {
  item: MarketPluginListing
  installed: boolean
  installing: boolean
  onInstall: () => void
  onDetails: () => void
}) {
  const ft = useFeatureText()
  const { t } = useTranslation()
  const isOfficial = item.section === 'official'

  return (
    <li className={`market-card market-card-v2${isOfficial ? ' is-official' : ''}`}>
      <div className="market-card-head">
        <PluginAvatarIcon
          avatar={item.author.avatar}
          name={item.author.name || item.name}
          official={isOfficial}
        />
        <div className="market-card-titles">
          <div className="market-card-top">
            <span className="row-title">{item.displayName || item.name}</span>
            <span className="chip">v{item.version}</span>
            <span className={`market-section-pill${isOfficial ? ' official' : ''}`}>
              {isOfficial ? ft('marketHub.officialBadge') : ft('marketHub.approvedBadge')}
            </span>
          </div>
          <span className="row-meta">
            {ft('marketHub.byAuthor', { name: item.author.name })}
            {item.installCount > 0 ? ` · ${ft('marketHub.installsCount', { count: item.installCount })}` : ''}
          </span>
        </div>
        {item.repoUrl && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => void shell.openExternal(item.repoUrl!)}
            aria-label={t('market.repo')}
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      <p className="market-card-desc">{item.description}</p>

      <div className="plugin-meta-chips">
        {item.skillNames.length > 0 && (
          <span className="skill-asset-chip">{t('plugins.skillsCount', { count: item.skillNames.length })}</span>
        )}
        {item.commandNames.length > 0 && (
          <span className="skill-asset-chip">{t('plugins.commandsCount', { count: item.commandNames.length })}</span>
        )}
        {item.ruleFiles.length > 0 && (
          <span className="skill-asset-chip">{t('plugins.rulesCount', { count: item.ruleFiles.length })}</span>
        )}
        {item.mcpCount > 0 && (
          <span className="skill-asset-chip">{t('plugins.mcpCount', { count: item.mcpCount })}</span>
        )}
        {item.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="skill-asset-chip">#{tag}</span>
        ))}
      </div>

      <div className="market-card-foot">
        <button type="button" className="btn btn-small" onClick={onDetails}>
          {ft('marketHub.detailsBtn')}
        </button>
        <button
          type="button"
          className={`btn btn-small${installed ? '' : ' btn-primary'}`}
          disabled={installing}
          onClick={onInstall}
        >
          {installed && <Check size={12} />}
          <span>
            {installing
              ? ft('marketHub.installingBtn')
              : installed
                ? ft('marketHub.installedBadge')
                : ft('marketHub.installBtn')}
          </span>
        </button>
      </div>
    </li>
  )
}

function ExternalSearchCard({
  hit,
  busy,
  onImport,
  onPickMcp,
}: {
  hit: MarketExternalHit
  busy: boolean
  onImport: () => void
  onPickMcp: (opt: InstallOption) => void
}) {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const [open, setOpen] = useState(false)
  const firstInstall = hit.installs?.[0]

  return (
    <li className="market-card market-card-v2 is-external">
      <div className="market-card-head">
        <PluginAvatarIcon avatar={hit.authorAvatar} name={hit.authorName || hit.name} size={40} />
        <div className="market-card-titles">
          <div className="market-card-top">
            <span className="row-title">{hit.name}</span>
            <span className={`market-external-badge src-${hit.source}`}>
              {externalSourceBadgeLabel(hit.source)}
            </span>
            {hit.originKind === 'local' && (
              <span className="chip">{ft('marketHub.localSourceTag', { source: externalSourceBadgeLabel(hit.source) })}</span>
            )}
            {typeof hit.stars === 'number' && hit.stars > 0 && (
              <span className="chip">
                <Star size={10} />
                {hit.stars}
              </span>
            )}
          </div>
          <span className="row-meta mono">{hit.title}</span>
        </div>
        {hit.repositoryUrl && (
          <button
            type="button"
            className="icon-btn"
            onClick={() => void shell.openExternal(hit.repositoryUrl!)}
            aria-label={t('market.repo')}
          >
            <ExternalLink size={14} />
          </button>
        )}
      </div>

      <p className="market-card-desc">{hit.description || hit.title}</p>

      <div className="market-card-foot">
        <span className="row-meta">{hit.authorName ? ft('marketHub.byAuthor', { name: hit.authorName }) : ''}</span>
        {hit.originKind === 'registry' && firstInstall ? (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => (hit.installs && hit.installs.length > 1 ? setOpen(!open) : onPickMcp(firstInstall))}
          >
            {t('market.install')}
          </button>
        ) : (
          <button
            type="button"
            className={`btn btn-small${hit.alreadyImported ? '' : ' btn-primary'}`}
            disabled={busy || Boolean(hit.alreadyImported)}
            onClick={onImport}
          >
            {hit.alreadyImported
              ? ft('marketHub.installedBadge')
              : hit.originKind === 'local'
                ? ft('marketHub.importLocalBtn')
                : ft('marketHub.inspectGithubBtn')}
          </button>
        )}
      </div>

      {hit.installs && hit.installs.length > 1 && (
        <div className={`row-expand${open ? ' open' : ''}`}>
          <div className="row-expand-inner">
            <div className="row-detail">
              <OptionList options={hit.installs} onPick={onPickMcp} />
            </div>
          </div>
        </div>
      )}
    </li>
  )
}
