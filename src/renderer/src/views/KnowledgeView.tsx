// Project Knowledge Base (BM25 multi-format document search) & Cross-Session Long-Term Memory view.
import { useState, type DragEvent } from 'react'
import {
  Brain,
  FileText,
  FolderOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeHit, MemoryCategory, MemoryDraft, MemoryItem, MemoryScope } from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { setState, toast, useStore } from '../lib/store.ts'
import { Dialog } from '../components/Dialog.tsx'
import { Oculus } from '../components/Oculus.tsx'
import { StudioSelect } from '../components/StudioSelect.tsx'
import { folderName } from '../components/WorkspacePicker.tsx'

export function KnowledgeView() {
  const { t } = useTranslation()
  const tab = useStore((s) => s.knowledgeTab)
  const settings = useStore((s) => s.settings)
  const knowledge = useStore((s) => s.knowledge)
  const memories = useStore((s) => s.memories)
  const activeChatId = useStore((s) => s.activeChatId)
  const workspace = settings?.workspace

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [dragging, setDragging] = useState(false)

  const [noteOpen, setNoteOpen] = useState(false)
  const [noteTitle, setNoteTitle] = useState('')
  const [noteBody, setNoteBody] = useState('')

  const [memScopeFilter, setMemScopeFilter] = useState<'all' | 'workspace' | 'global'>('all')
  const [memDraft, setMemDraft] = useState<MemoryDraft | null>(null)
  const [extracting, setExtracting] = useState(false)

  const setTab = (next: 'knowledge' | 'memory') => setState({ knowledgeTab: next })

  const addPickedFiles = async () => {
    try {
      const picked = await shell.pickFiles(workspace)
      const paths = picked
        .map((p) => (p.kind !== 'image' ? p.path : undefined))
        .filter((p): p is string => Boolean(p))
      if (paths.length === 0) return
      setIndexing(true)
      const next = await call('knowledge.addFiles', paths, workspace)
      setState({ knowledge: next })
      toast(t('knowledge.indexedToast', { count: paths.length }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setIndexing(false)
    }
  }

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (!e.dataTransfer?.files?.length) return
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => shell.pathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    setIndexing(true)
    try {
      const next = await call('knowledge.addFiles', paths, workspace)
      setState({ knowledge: next })
      toast(t('knowledge.indexedToast', { count: paths.length }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setIndexing(false)
    }
  }

  const saveNote = async () => {
    if (!noteTitle.trim() || !noteBody.trim()) return
    setIndexing(true)
    try {
      const next = await call('knowledge.addNote', noteTitle.trim(), noteBody.trim(), workspace)
      setState({ knowledge: next })
      setNoteOpen(false)
      setNoteTitle('')
      setNoteBody('')
      toast(t('knowledge.noteSaved'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setIndexing(false)
    }
  }

  const runSearch = async () => {
    const clean = query.trim()
    if (!clean) {
      setHits(null)
      return
    }
    setSearching(true)
    try {
      const found = await call('knowledge.search', clean, workspace, 6)
      setHits(found)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSearching(false)
    }
  }

  const saveMemoryDraft = async () => {
    if (!memDraft || !memDraft.content.trim()) return
    try {
      await call('memory.save', {
        ...memDraft,
        workspace: memDraft.scope === 'workspace' ? workspace : undefined,
      })
      const refreshed = await call('memory.list', workspace)
      setState({ memories: refreshed })
      setMemDraft(null)
      toast(t('memory.saved'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const togglePinMemory = async (item: MemoryItem) => {
    try {
      await call('memory.save', {
        id: item.id,
        content: item.content,
        category: item.category,
        scope: item.scope,
        workspace: item.workspace,
        pinned: !item.pinned,
      })
      setState({ memories: await call('memory.list', workspace) })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const extractFromActive = async () => {
    if (!activeChatId) return
    setExtracting(true)
    try {
      const added = await call('memory.extractFromChat', activeChatId)
      setState({ memories: await call('memory.list', workspace) })
      toast(t('memory.extractedToast', { count: added.length }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setExtracting(false)
    }
  }

  const visibleMemories = memories.filter((m) =>
    memScopeFilter === 'all' ? true : m.scope === memScopeFilter,
  )

  return (
    <div
      className={`page${dragging ? ' kb-dragging' : ''}`}
      onDragOver={(e) => {
        if (tab === 'knowledge' && Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={(e) => {
        if (tab === 'knowledge') void handleDrop(e)
      }}
    >
      <header className="page-head">
        <div>
          <h1>{t('knowledge.pageTitle')}</h1>
          <div className="conn-tabs" role="tablist" aria-label={t('knowledge.pageTitle')}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'knowledge'}
              className={`seg-btn${tab === 'knowledge' ? ' active' : ''}`}
              onClick={() => setTab('knowledge')}
            >
              {t('knowledge.tabKnowledge')} ({knowledge?.sourceCount ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'memory'}
              className={`seg-btn${tab === 'memory' ? ' active' : ''}`}
              onClick={() => setTab('memory')}
            >
              {t('memory.tabMemory')} ({memories.length})
            </button>
          </div>
          <p className="page-sub">
            {tab === 'knowledge' ? t('knowledge.intro') : t('memory.intro')}
          </p>
          {tab === 'knowledge' && (
            <div className="page-pills">
              <span className="summary-pill">
                <FolderOpen size={12} />
                {workspace ? folderName(workspace) ?? workspace : t('knowledge.globalScope')}
              </span>
              <span className="summary-pill">
                {t('knowledge.statsSummary', {
                  sources: knowledge?.sourceCount ?? 0,
                  chunks: knowledge?.chunkCount ?? 0,
                })}
              </span>
            </div>
          )}
        </div>

        <div className="page-actions">
          {tab === 'knowledge' ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={indexing}
                onClick={() => void call('knowledge.reindex', workspace).then((next) => setState({ knowledge: next }))}
              >
                <RefreshCw size={14} className={indexing ? 'spin' : undefined} />
                <span>{t('knowledge.reindex')}</span>
              </button>
              <button type="button" className="btn" onClick={() => setNoteOpen(true)}>
                <StickyNote size={14} />
                <span>{t('knowledge.addNoteBtn')}</span>
              </button>
              <button type="button" className="btn btn-primary" disabled={indexing} onClick={() => void addPickedFiles()}>
                <Plus size={14} />
                <span>{t('knowledge.addFilesBtn')}</span>
              </button>
            </>
          ) : (
            <>
              {activeChatId && (
                <button
                  type="button"
                  className="btn"
                  disabled={extracting}
                  onClick={() => void extractFromActive()}
                >
                  <Sparkles size={14} />
                  <span>{extracting ? t('memory.extracting') : t('memory.extractBtn')}</span>
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  setMemDraft({
                    content: '',
                    category: 'preference',
                    scope: workspace ? 'workspace' : 'global',
                    workspace,
                    pinned: false,
                  })
                }
              >
                <Plus size={14} />
                <span>{t('memory.newBtn')}</span>
              </button>
            </>
          )}
        </div>
      </header>

      {tab === 'knowledge' ? (
        <>
          <form
            className="kb-search-bar"
            onSubmit={(e) => {
              e.preventDefault()
              void runSearch()
            }}
          >
            <Search size={15} />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                if (!e.target.value.trim()) setHits(null)
              }}
              placeholder={t('knowledge.searchPlaceholder')}
              aria-label={t('knowledge.searchPlaceholder')}
            />
            <button type="submit" className="btn btn-small btn-primary" disabled={searching || !query.trim()}>
              {searching ? t('knowledge.searching') : t('knowledge.searchBtn')}
            </button>
          </form>

          {hits && (
            <div className="kb-hits-box">
              <div className="kb-hits-head">
                <strong>{t('knowledge.hitsTitle', { count: hits.length })}</strong>
                <button type="button" className="btn btn-small" onClick={() => setHits(null)}>
                  {t('common.close')}
                </button>
              </div>
              {hits.length === 0 ? (
                <p className="muted small">{t('knowledge.noHits')}</p>
              ) : (
                <div className="kb-hits-list">
                  {hits.map((hit, i) => (
                    <div key={`${hit.sourceId}-${i}`} className="kb-hit-card">
                      <div className="kb-hit-meta">
                        <strong>{hit.path || hit.title}</strong>
                        {hit.section && <span className="chip">{hit.section}</span>}
                        <span className="summary-pill mono">BM25 {hit.score}</span>
                      </div>
                      <p>{hit.snippet}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!knowledge || knowledge.sources.length === 0 ? (
            <div className="empty-state">
              <Oculus state="idle" size={64} />
              <h2 className="display">{t('knowledge.emptyTitle')}</h2>
              <p>{t('knowledge.emptyHint')}</p>
              <button type="button" className="btn btn-primary" onClick={() => void addPickedFiles()}>
                <Plus size={14} />
                <span>{t('knowledge.addFilesBtn')}</span>
              </button>
            </div>
          ) : (
            <ul className="rows">
              {knowledge.sources.map((src) => (
                <li key={src.id} className="row">
                  <div className="auto-icon-badge" aria-hidden="true">
                    {src.kind === 'note' ? <StickyNote size={16} /> : <FileText size={16} />}
                  </div>
                  <div className="row-main">
                    <div className="row-line">
                      <span className="row-title">{src.title}</span>
                      {src.docKind && <span className="auto-badge">{src.docKind.toUpperCase()}</span>}
                      <span className="auto-badge">
                        {t('knowledge.chunkBadge', { chunks: src.chunkCount })}
                      </span>
                    </div>
                    <div className="auto-meta-line">
                      <code>{src.path || t('knowledge.noteType')}</code>
                      <span>· {(src.charCount / 1000).toFixed(1)}k chars</span>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={t('common.remove')}
                      onClick={() =>
                        void call('knowledge.remove', src.id, workspace).then((next) => setState({ knowledge: next }))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="mem-toolbar">
            <div className="mem-filters">
              {(['all', 'workspace', 'global'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`seg-btn${memScopeFilter === f ? ' active' : ''}`}
                  onClick={() => setMemScopeFilter(f)}
                >
                  {t(`memory.filter_${f}`)}
                </button>
              ))}
            </div>
            <label className="mem-auto-toggle">
              <span>{t('memory.autoInject')}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings?.memoryEnabled !== false}
                  onChange={(e) =>
                    void call('settings.update', { memoryEnabled: e.target.checked }).then((s) =>
                      setState({ settings: s }),
                    )
                  }
                />
                <span />
              </label>
            </label>
          </div>

          {visibleMemories.length === 0 ? (
            <div className="empty-state">
              <Oculus state="idle" size={64} />
              <h2 className="display">{t('memory.emptyTitle')}</h2>
              <p>{t('memory.emptyHint')}</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  setMemDraft({
                    content: '',
                    category: 'preference',
                    scope: workspace ? 'workspace' : 'global',
                    workspace,
                    pinned: false,
                  })
                }
              >
                <Plus size={14} />
                <span>{t('memory.newBtn')}</span>
              </button>
            </div>
          ) : (
            <ul className="rows">
              {visibleMemories.map((item) => (
                <li key={item.id} className="row">
                  <div className="auto-icon-badge" aria-hidden="true">
                    <Brain size={16} />
                  </div>
                  <div className="row-main">
                    <div className="row-line">
                      <span className={`chip chip-cat-${item.category}`}>
                        {t(`memory.categories.${item.category}`)}
                      </span>
                      <span className="auto-badge">
                        {item.scope === 'workspace'
                          ? folderName(item.workspace) ?? t('memory.scopeWorkspace')
                          : t('memory.scopeGlobal')}
                      </span>
                      {item.pinned && <span className="chip chip-done">{t('memory.pinnedTag')}</span>}
                    </div>
                    <p className="mem-content">{item.content}</p>
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className={`icon-btn${item.pinned ? ' is-pinned' : ''}`}
                      onClick={() => void togglePinMemory(item)}
                      title={t('memory.pinToggle')}
                      aria-label={t('memory.pinToggle')}
                    >
                      <Pin size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={t('common.remove')}
                      onClick={() =>
                        void call('memory.remove', item.id).then(async () =>
                          setState({ memories: await call('memory.list', workspace) }),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {noteOpen && (
        <Dialog title={t('knowledge.noteModalTitle')} onClose={() => setNoteOpen(false)}>
          <div className="auto-modal-form">
            <label className="field">
              <span>{t('knowledge.noteTitleLabel')}</span>
              <input
                className="input"
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                placeholder={t('knowledge.noteTitlePlaceholder')}
                autoFocus
              />
            </label>
            <label className="field">
              <span>{t('knowledge.noteContentLabel')}</span>
              <textarea
                className="input"
                rows={6}
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder={t('knowledge.noteContentPlaceholder')}
              />
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setNoteOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!noteTitle.trim() || !noteBody.trim() || indexing}
                onClick={() => void saveNote()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {memDraft && (
        <Dialog title={t('memory.newBtn')} onClose={() => setMemDraft(null)}>
          <div className="auto-modal-form">
            <label className="field">
              <span>{t('memory.contentLabel')}</span>
              <textarea
                className="input"
                rows={4}
                value={memDraft.content}
                onChange={(e) => setMemDraft({ ...memDraft, content: e.target.value })}
                placeholder={t('memory.contentPlaceholder')}
                autoFocus
              />
            </label>
            <div className="kb-two-col">
              <div className="field">
                <span>{t('memory.categoryLabel')}</span>
                <StudioSelect
                  value={memDraft.category}
                  ariaLabel={t('memory.categoryLabel')}
                  fullWidth
                  options={[
                    { value: 'preference', label: t('memory.categories.preference') },
                    { value: 'fact', label: t('memory.categories.fact') },
                    { value: 'workflow', label: t('memory.categories.workflow') },
                    { value: 'decision', label: t('memory.categories.decision') },
                  ]}
                  onChange={(val) => setMemDraft({ ...memDraft, category: val as MemoryCategory })}
                />
              </div>
              <div className="field">
                <span>{t('memory.scopeLabel')}</span>
                <StudioSelect
                  value={memDraft.scope}
                  ariaLabel={t('memory.scopeLabel')}
                  fullWidth
                  options={[
                    { value: 'global', label: t('memory.scopeGlobal') },
                    ...(workspace ? [{ value: 'workspace' as MemoryScope, label: t('memory.scopeWorkspace') }] : []),
                  ]}
                  onChange={(val) => setMemDraft({ ...memDraft, scope: val as MemoryScope })}
                />
              </div>
            </div>
            <label className="mem-check-row">
              <input
                type="checkbox"
                checked={Boolean(memDraft.pinned)}
                onChange={(e) => setMemDraft({ ...memDraft, pinned: e.target.checked })}
              />
              <span>{t('memory.pinAlways')}</span>
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn" onClick={() => setMemDraft(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!memDraft.content.trim()}
                onClick={() => void saveMemoryDraft()}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}
