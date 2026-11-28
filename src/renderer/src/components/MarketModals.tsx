import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  BadgeCheck,
  Check,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Package,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  GithubImportResult,
  InstallOption,
  MarketBundleFile,
  MarketIdentity,
  MarketLocalPackPreview,
  MarketPluginDetail,
  MarketPluginListing,
  MarketPluginSection,
  MarketReviewQueueResult,
} from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { navigate, refreshPlugins, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { Dialog } from './Dialog.tsx'
import { OptionList } from './OptionList.tsx'
import { Tile } from './Tile.tsx'

export function PluginAvatarIcon({
  avatar,
  name,
  official = false,
  size = 42,
}: {
  avatar?: string | null
  name: string
  official?: boolean
  size?: number
}) {
  const [imgFailed, setImgFailed] = useState(false)
  const hasAvatar = Boolean(avatar && avatar.trim() && !imgFailed)

  return (
    <div
      className={`market-avatar-wrap${official ? ' is-official' : ''}`}
      style={{ width: size, height: size }}
    >
      {hasAvatar ? (
        <img
          className="market-author-avatar"
          src={avatar!}
          alt={name}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <Tile name={name || 'A'} />
      )}
      {official && (
        <span className="market-official-seal" title="Official Co-contributor">
          <BadgeCheck size={13} />
        </span>
      )}
    </div>
  )
}

export function MarketUploadModal({
  identity,
  onClose,
  onSubmitted,
}: {
  identity: MarketIdentity
  onClose: () => void
  onSubmitted: (created: MarketPluginListing) => void
}) {
  const ft = useFeatureText()
  const { t } = useTranslation()
  const [mode, setMode] = useState<'local' | 'github'>('local')
  const [pack, setPack] = useState<MarketLocalPackPreview | null>(null)
  const [picking, setPicking] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [inspectingGh, setInspectingGh] = useState(false)
  const [ghResult, setGhResult] = useState<GithubImportResult | null>(null)
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [description, setDescription] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [targetSection, setTargetSection] = useState<MarketPluginSection>(
    identity.isCoContributor ? 'official' : 'community',
  )
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState('')

  const pickLocalFolder = async () => {
    setErr('')
    const folder = await shell.pickFolder()
    if (!folder) return
    setPicking(true)
    try {
      const preview = await call('market.inspectLocalFolder', folder)
      setPack(preview)
      setName(preview.displayName || preview.name)
      setVersion(preview.version || '1.0.0')
      setDescription(preview.description || '')
    } catch (e) {
      setErr(errorMessage(e))
      setPack(null)
    } finally {
      setPicking(false)
    }
  }

  const inspectRepo = async () => {
    if (!repoUrl.trim()) return
    setErr('')
    setInspectingGh(true)
    try {
      const res = await call('market.importGithub', repoUrl.trim())
      setGhResult(res)
      const fallbackName = res.plugin?.displayName || res.plugin?.name || res.repo.split('/').pop() || ''
      if (!name) setName(fallbackName)
      if (res.plugin?.version) setVersion(res.plugin.version)
      if (!description) setDescription(res.plugin?.description || res.description || '')
    } catch (e) {
      setErr(errorMessage(e))
      setGhResult(null)
    } finally {
      setInspectingGh(false)
    }
  }

  const submit = async () => {
    setErr('')
    const cleanName = name.trim()
    const cleanDesc = description.trim()
    if (cleanName.length < 2) {
      setErr(ft('marketHub.pluginName'))
      return
    }
    if (!cleanDesc) {
      setErr(ft('marketHub.pluginDesc'))
      return
    }
    if (mode === 'local' && !pack) {
      setErr(ft('marketHub.pickFolderBtn'))
      return
    }
    if (mode === 'github' && !repoUrl.trim()) {
      setErr('GitHub URL is required.')
      return
    }

    const tags = tagsRaw
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)

    setSubmitting(true)
    try {
      const created = await call('market.submit', {
        name: cleanName,
        displayName: cleanName,
        version: version.trim() || '1.0.0',
        description: cleanDesc,
        tags,
        submissionKind: mode === 'local' ? 'bundle' : 'github',
        ...(mode === 'local' && pack
          ? {
              files: pack.files,
              skillNames: pack.skillNames,
              commandNames: pack.commandNames,
              ruleFiles: pack.ruleFiles,
              mcpCount: pack.mcpCount,
              hasHooks: pack.hasHooks,
            }
          : {
              repoUrl: repoUrl.trim(),
              skillNames: ghResult?.plugin?.skillNames ?? [],
              commandNames: ghResult?.plugin?.commandNames ?? [],
              ruleFiles: ghResult?.plugin?.ruleFiles ?? [],
              mcpCount: ghResult?.plugin?.mcpCount ?? ghResult?.installs.length ?? 0,
            }),
        targetSection: identity.isCoContributor ? targetSection : 'community',
      })
      toast(
        created.status === 'approved' && created.section === 'official'
          ? ft('marketHub.submittedOfficialToast', { name: created.displayName || created.name })
          : ft('marketHub.submittedCommunityToast', { name: created.displayName || created.name }),
      )
      onSubmitted(created)
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog title={ft('marketHub.uploadTitle')} onClose={onClose} wide>
      <div className="market-upload-form">
        <div className="seg" role="tablist">
          <button
            type="button"
            className={`seg-btn${mode === 'local' ? ' active' : ''}`}
            onClick={() => {
              setMode('local')
              setErr('')
            }}
          >
            <FolderOpen size={13} />
            <span>{ft('marketHub.uploadTabLocal')}</span>
          </button>
          <button
            type="button"
            className={`seg-btn${mode === 'github' ? ' active' : ''}`}
            onClick={() => {
              setMode('github')
              setErr('')
            }}
          >
            <GitBranch size={13} />
            <span>{ft('marketHub.uploadTabGithub')}</span>
          </button>
        </div>

        {mode === 'local' ? (
          <div className="market-pick-box">
            <button type="button" className="btn" onClick={() => void pickLocalFolder()} disabled={picking}>
              <FolderOpen size={14} />
              <span>{pack ? ft('marketHub.repickFolderBtn') : ft('marketHub.pickFolderBtn')}</span>
            </button>
            {pack && (
              <div className="market-pack-summary">
                <code className="mono small">{pack.folderPath}</code>
                <div className="plugin-meta-chips">
                  <span className="skill-asset-chip">{pack.fileCount} files</span>
                  {pack.skillNames.length > 0 && (
                    <span className="skill-asset-chip">{t('plugins.skillsCount', { count: pack.skillNames.length })}</span>
                  )}
                  {pack.commandNames.length > 0 && (
                    <span className="skill-asset-chip">{t('plugins.commandsCount', { count: pack.commandNames.length })}</span>
                  )}
                  {pack.ruleFiles.length > 0 && (
                    <span className="skill-asset-chip">{t('plugins.rulesCount', { count: pack.ruleFiles.length })}</span>
                  )}
                  {pack.mcpCount > 0 && (
                    <span className="skill-asset-chip">{t('plugins.mcpCount', { count: pack.mcpCount })}</span>
                  )}
                  {pack.hasHooks && <span className="plugin-warn-chip">{ft('marketHub.warningHooks')}</span>}
                  {pack.hasScripts && <span className="plugin-warn-chip">{ft('marketHub.warningScripts')}</span>}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="github-line">
            <input
              className="input mono"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder={t('market.githubPlaceholder')}
            />
            <button
              type="button"
              className="btn"
              onClick={() => void inspectRepo()}
              disabled={inspectingGh || !repoUrl.trim()}
            >
              {inspectingGh ? t('market.reading') : ft('marketHub.githubReadBtn')}
            </button>
          </div>
        )}

        <div className="market-form-grid">
          <label className="field">
            <span>{ft('marketHub.pluginName')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-plugin" />
          </label>
          <label className="field">
            <span>{ft('marketHub.pluginVersion')}</span>
            <input className="input mono" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
          </label>
        </div>

        <label className="field">
          <span>{ft('marketHub.pluginDesc')}</span>
          <textarea
            className="input"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <label className="field">
          <span>{ft('marketHub.pluginTags')}</span>
          <input
            className="input"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="coding, automation, git"
          />
        </label>

        {identity.isCoContributor ? (
          <div className="market-section-choice">
            <span className="market-choice-title">{ft('marketHub.targetSectionLabel')}</span>
            <label className="market-radio-row">
              <input
                type="radio"
                name="marketTargetSection"
                checked={targetSection === 'official'}
                onChange={() => setTargetSection('official')}
              />
              <span>{ft('marketHub.targetOfficial')}</span>
            </label>
            <label className="market-radio-row">
              <input
                type="radio"
                name="marketTargetSection"
                checked={targetSection === 'community'}
                onChange={() => setTargetSection('community')}
              />
              <span>{ft('marketHub.targetCommunity')}</span>
            </label>
          </div>
        ) : (
          <div className="market-policy-callout">
            <ShieldCheck size={15} />
            <span>{ft('marketHub.reviewPolicyNote')}</span>
          </div>
        )}

        <div className="market-avatar-preview-note">
          <PluginAvatarIcon
            avatar={identity.avatar}
            name={identity.displayName || identity.email || name || 'A'}
            official={identity.isCoContributor && targetSection === 'official'}
            size={34}
          />
          <span>{ft('marketHub.avatarPreviewHint')}</span>
        </div>

        {err && <p className="warn">{err}</p>}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => void submit()}
          >
            <Upload size={14} />
            <span>
              {identity.isCoContributor && targetSection === 'official'
                ? ft('marketHub.publishOfficialAction')
                : ft('marketHub.submitAction')}
            </span>
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function MarketMySubmissionsModal({
  onClose,
  onChanged,
}: {
  onClose: () => void
  onChanged: () => void
}) {
  const ft = useFeatureText()
  const { t } = useTranslation()
  const [items, setItems] = useState<MarketPluginListing[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  const reload = async () => {
    setLoading(true)
    setErr('')
    try {
      setItems(await call('market.mySubmissions'))
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const remove = async (item: MarketPluginListing) => {
    try {
      await call('market.deleteSubmission', item.id)
      toast(ft('marketHub.deletedToast', { name: item.displayName || item.name }))
      await reload()
      onChanged()
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  return (
    <Dialog title={ft('marketHub.myTitle')} onClose={onClose} wide>
      {loading ? (
        <p className="muted">{t('common.loading')}</p>
      ) : err ? (
        <p className="warn">{err}</p>
      ) : items.length === 0 ? (
        <p className="empty">{ft('marketHub.myEmpty')}</p>
      ) : (
        <ul className="market-sub-list">
          {items.map((item) => (
            <li key={item.id} className="market-sub-item">
              <div className="market-sub-head">
                <PluginAvatarIcon
                  avatar={item.author.avatar}
                  name={item.author.name}
                  official={item.section === 'official'}
                  size={36}
                />
                <div className="market-sub-meta">
                  <div className="market-card-top">
                    <strong>{item.displayName || item.name}</strong>
                    <span className="chip">v{item.version}</span>
                    <span className={`market-status-pill status-${item.status}`}>
                      {item.status === 'approved'
                        ? ft('marketHub.approvedBadge')
                        : item.status === 'rejected'
                          ? ft('marketHub.rejectedBadge')
                          : ft('marketHub.pendingBadge')}
                    </span>
                  </div>
                  <p className="muted small">{item.description}</p>
                  {item.reviewNote && (
                    <p className="market-review-note-text">{ft('marketHub.reviewNoteLabel')}: {item.reviewNote}</p>
                  )}
                </div>
                <button
                  type="button"
                  className="btn btn-small danger"
                  onClick={() => void remove(item)}
                >
                  <Trash2 size={12} />
                  <span>{ft('marketHub.withdrawBtn')}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

export function MarketReviewModal({
  isCoContributor,
  onClose,
  onChanged,
}: {
  isCoContributor: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const ft = useFeatureText()
  const { t } = useTranslation()
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending')
  const [queue, setQueue] = useState<MarketReviewQueueResult>({ pending: [], approved: [], rejected: [] })
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<MarketPluginDetail | null>(null)
  const [selectedFile, setSelectedFile] = useState<MarketBundleFile | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadQueue = async (preferredTab?: 'pending' | 'approved' | 'rejected') => {
    setLoading(true)
    setErr('')
    try {
      const res = await call('market.reviewQueue')
      setQueue(res)
      const activeList = res[preferredTab ?? tab]
      setSelectedId((cur) => (cur && activeList.some((i) => i.id === cur) ? cur : activeList[0]?.id ?? null))
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadQueue()
  }, [])

  useEffect(() => {
    const list = queue[tab]
    if (!selectedId || !list.some((i) => i.id === selectedId)) {
      setSelectedId(list[0]?.id ?? null)
    }
  }, [tab, queue])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      setSelectedFile(null)
      return
    }
    let cancelled = false
    void call('market.pluginDetail', selectedId)
      .then((res) => {
        if (cancelled) return
        setDetail(res)
        setSelectedFile(res.files?.[0] ?? null)
        setNote(res.plugin.reviewNote ?? '')
      })
      .catch(() => {
        if (!cancelled) {
          setDetail(null)
          setSelectedFile(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const act = async (decision: 'approve' | 'reject', section?: MarketPluginSection) => {
    if (!detail) return
    setBusy(true)
    try {
      await call('market.reviewDecision', detail.plugin.id, {
        decision,
        ...(section ? { section } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
      toast(
        decision === 'approve'
          ? ft('marketHub.approvedToast', { name: detail.plugin.displayName || detail.plugin.name })
          : ft('marketHub.rejectedToast', { name: detail.plugin.displayName || detail.plugin.name }),
      )
      await loadQueue()
      onChanged()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!detail) return
    setBusy(true)
    try {
      await call('market.deleteSubmission', detail.plugin.id)
      toast(ft('marketHub.deletedToast', { name: detail.plugin.displayName || detail.plugin.name }))
      await loadQueue()
      onChanged()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const list = queue[tab]

  return (
    <Dialog title={ft('marketHub.reviewTitle')} onClose={onClose} wide>
      <div className="market-review-wrap">
        <div className="seg" role="tablist">
          <button type="button" className={`seg-btn${tab === 'pending' ? ' active' : ''}`} onClick={() => setTab('pending')}>
            {ft('marketHub.reviewTabPending', { count: queue.pending.length })}
          </button>
          <button type="button" className={`seg-btn${tab === 'approved' ? ' active' : ''}`} onClick={() => setTab('approved')}>
            {ft('marketHub.reviewTabApproved', { count: queue.approved.length })}
          </button>
          <button type="button" className={`seg-btn${tab === 'rejected' ? ' active' : ''}`} onClick={() => setTab('rejected')}>
            {ft('marketHub.reviewTabRejected', { count: queue.rejected.length })}
          </button>
        </div>

        {loading ? (
          <p className="muted">{t('common.loading')}</p>
        ) : err ? (
          <p className="warn">{err}</p>
        ) : list.length === 0 ? (
          <p className="empty">{ft('marketHub.reviewEmpty')}</p>
        ) : (
          <div className="market-review-split">
            <ul className="market-review-list">
              {list.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`market-review-item${selectedId === item.id ? ' active' : ''}`}
                    onClick={() => setSelectedId(item.id)}
                  >
                    <PluginAvatarIcon
                      avatar={item.author.avatar}
                      name={item.author.name}
                      official={item.section === 'official'}
                      size={32}
                    />
                    <div className="market-review-item-meta">
                      <strong>{item.displayName || item.name}</strong>
                      <span>{item.author.name} · v{item.version}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>

            {detail && (
              <div className="market-review-detail">
                <div className="market-detail-head">
                  <PluginAvatarIcon
                    avatar={detail.plugin.author.avatar}
                    name={detail.plugin.author.name}
                    official={detail.plugin.section === 'official'}
                    size={44}
                  />
                  <div className="market-detail-titles">
                    <div className="market-card-top">
                      <strong>{detail.plugin.displayName || detail.plugin.name}</strong>
                      <span className="chip">v{detail.plugin.version}</span>
                      {detail.plugin.hasHooks && (
                        <span className="plugin-warn-chip">
                          <AlertTriangle size={11} />
                          <span>{ft('marketHub.warningHooks')}</span>
                        </span>
                      )}
                      {detail.plugin.hasScripts && (
                        <span className="plugin-warn-chip">
                          <AlertTriangle size={11} />
                          <span>{ft('marketHub.warningScripts')}</span>
                        </span>
                      )}
                    </div>
                    <span className="muted small">
                      {detail.plugin.author.name}
                      {detail.plugin.author.email ? ` (${detail.plugin.author.email})` : ''}
                    </span>
                  </div>
                  {detail.plugin.repoUrl && (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => void shell.openExternal(detail.plugin.repoUrl!)}
                    >
                      <ExternalLink size={12} />
                      <span>GitHub</span>
                    </button>
                  )}
                </div>

                <p className="market-detail-desc">{detail.plugin.description}</p>

                {detail.files && detail.files.length > 0 && (
                  <div className="market-code-preview-box">
                    <div className="market-file-tabs">
                      {detail.files.map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          className={`market-file-tab${selectedFile?.path === f.path ? ' active' : ''}`}
                          onClick={() => setSelectedFile(f)}
                        >
                          {f.path}
                        </button>
                      ))}
                    </div>
                    {selectedFile && (
                      <pre className="market-code-viewer">
                        {selectedFile.encoding === 'base64'
                          ? `[Binary base64 payload, ${selectedFile.size} bytes]`
                          : selectedFile.content}
                      </pre>
                    )}
                  </div>
                )}

                <label className="field">
                  <span>{ft('marketHub.reviewNoteLabel')}</span>
                  <textarea
                    className="input"
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={ft('marketHub.reviewNotePlaceholder')}
                  />
                </label>

                <div className="market-review-actions">
                  <button
                    type="button"
                    className="btn btn-small danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    <Trash2 size={12} />
                    <span>{ft('marketHub.deleteBtn')}</span>
                  </button>
                  <div className="market-review-right-acts">
                    <button
                      type="button"
                      className="btn btn-small danger"
                      disabled={busy}
                      onClick={() => void act('reject')}
                    >
                      <XCircle size={12} />
                      <span>{ft('marketHub.rejectBtn')}</span>
                    </button>
                    {isCoContributor && (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={busy}
                        onClick={() => void act('approve', 'official')}
                      >
                        <BadgeCheck size={12} />
                        <span>{ft('marketHub.approveOfficialBtn')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={busy}
                      onClick={() => void act('approve', 'community')}
                    >
                      <Check size={12} />
                      <span>{ft('marketHub.approveCommunityBtn')}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}

export function MarketPluginDetailModal({
  listing,
  installed,
  installing,
  onInstall,
  onClose,
}: {
  listing: MarketPluginListing
  installed: boolean
  installing: boolean
  onInstall: () => void
  onClose: () => void
}) {
  const ft = useFeatureText()
  const { t } = useTranslation()
  const [detail, setDetail] = useState<MarketPluginDetail | null>(null)
  const [selectedFile, setSelectedFile] = useState<MarketBundleFile | null>(null)

  useEffect(() => {
    let cancelled = false
    void call('market.pluginDetail', listing.id)
      .then((res) => {
        if (cancelled) return
        setDetail(res)
        setSelectedFile(res.files?.[0] ?? null)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [listing.id])

  const p = detail?.plugin ?? listing

  return (
    <Dialog title={p.displayName || p.name} onClose={onClose} wide>
      <div className="market-detail-modal">
        <div className="market-detail-head">
          <PluginAvatarIcon
            avatar={p.author.avatar}
            name={p.author.name || p.name}
            official={p.section === 'official'}
            size={48}
          />
          <div className="market-detail-titles">
            <div className="market-card-top">
              <strong>{p.displayName || p.name}</strong>
              <span className="chip">v{p.version}</span>
              <span className={`market-section-pill${p.section === 'official' ? ' official' : ''}`}>
                {p.section === 'official' ? ft('marketHub.officialBadge') : ft('marketHub.approvedBadge')}
              </span>
            </div>
            <span className="muted small">
              {ft('marketHub.byAuthor', { name: p.author.name })} · {ft('marketHub.installsCount', { count: p.installCount })}
            </span>
          </div>
          {p.repoUrl && (
            <button type="button" className="btn btn-small" onClick={() => void shell.openExternal(p.repoUrl!)}>
              <ExternalLink size={12} />
              <span>GitHub</span>
            </button>
          )}
        </div>

        <p className="market-detail-desc">{p.description}</p>

        <div className="plugin-meta-chips">
          {p.skillNames.map((s) => (
            <span key={s} className="skill-asset-chip">Skill: {s}</span>
          ))}
          {p.commandNames.map((c) => (
            <span key={c} className="skill-asset-chip">/{c}</span>
          ))}
          {p.mcpCount > 0 && (
            <span className="skill-asset-chip">{t('plugins.mcpCount', { count: p.mcpCount })}</span>
          )}
        </div>

        {detail?.files && detail.files.length > 0 && (
          <div className="market-code-preview-box">
            <div className="market-file-tabs">
              {detail.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`market-file-tab${selectedFile?.path === f.path ? ' active' : ''}`}
                  onClick={() => setSelectedFile(f)}
                >
                  {f.path}
                </button>
              ))}
            </div>
            {selectedFile && (
              <pre className="market-code-viewer">
                {selectedFile.encoding === 'base64'
                  ? `[Binary base64 payload, ${selectedFile.size} bytes]`
                  : selectedFile.content}
              </pre>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={installing}
            onClick={onInstall}
          >
            {installing
              ? ft('marketHub.installingBtn')
              : installed
                ? ft('marketHub.installedBadge')
                : ft('marketHub.installBtn')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

export function MarketGithubImportModal({
  initialUrl = '',
  onPickMcp,
  onClose,
}: {
  initialUrl?: string
  onPickMcp: (option: InstallOption) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const workspace = useStore((s) => s.settings?.workspace)
  const [url, setUrl] = useState(initialUrl)
  const [busy, setBusy] = useState(false)
  const [installingBundle, setInstallingBundle] = useState(false)
  const [result, setResult] = useState<GithubImportResult | null>(null)
  const [error, setError] = useState('')

  const read = async (target = url) => {
    const clean = target.trim()
    if (!clean) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      setResult(await call('market.importGithub', clean))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialUrl.trim()) void read(initialUrl)
  }, [initialUrl])

  const installBundle = async () => {
    if (!result?.plugin) return
    setInstallingBundle(true)
    try {
      const res = await call('plugins.importGithub', result.plugin.repoUrl)
      await refreshPlugins(workspace)
      const installedName = res.installed[0]?.displayName || res.installed[0]?.name || result.plugin.name
      toast(t('plugins.bundleInstalled', { name: installedName }))
      onClose()
      navigate({ view: 'connections', chatId: null, connectionsTab: 'plugins' })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setInstallingBundle(false)
    }
  }

  return (
    <Dialog title={t('market.github')} onClose={onClose} wide>
      <div className="github-import">
        <p className="muted small">{t('market.githubHint')}</p>
        <div className="github-line">
          <input
            className="input mono"
            value={url}
            placeholder={t('market.githubPlaceholder')}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && url.trim() && void read()}
          />
          <button type="button" className="btn" onClick={() => void read()} disabled={busy || !url.trim()}>
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
            {result.installs.length > 0 && <OptionList options={result.installs} onPick={onPickMcp} />}
          </div>
        )}
      </div>
    </Dialog>
  )
}
