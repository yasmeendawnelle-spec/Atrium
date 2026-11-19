import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  Columns2,
  Copy,
  ExternalLink,
  Eye,
  FileCode,
  FileDiff,
  FolderOpen,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Globe,
  Layers,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
  Upload,
  WrapText,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DiffReviewComment, FileChangeEntry, ImageAttachment, WorkspaceChanges, WorkspaceFilePreview } from '@shared/types.ts'
import type { ParsedArtifact } from '../lib/artifacts.ts'
import { buildSplitDiffRows, parseUnifiedDiff, type ParsedDiffLine } from '../lib/diff.ts'
import { highlightCode } from '../lib/highlight.ts'
import { useGlider } from '../lib/glider.ts'
import { useDismissPopover } from '../lib/popover.ts'
import { startColumnResize } from '../lib/resize.ts'
import { errorMessage, shell } from '../lib/api.ts'
import { browserSnapshotFor, toast, useStore } from '../lib/store.ts'
import { ContextMenu, type ContextMenuEntry } from './ContextMenu.tsx'
import { Dialog } from './Dialog.tsx'
import { folderName } from './WorkspacePicker.tsx'

const ArtifactPreview = lazy(() => import('./ArtifactPreview.tsx').then((m) => ({ default: m.ArtifactPreview })))
const BrowserPreviewPanel = lazy(() => import('./BrowserPreviewPanel.tsx').then((m) => ({ default: m.BrowserPreviewPanel })))
const TerminalPanel = lazy(() => import('./TerminalPanel.tsx').then((m) => ({ default: m.TerminalPanel })))

export type StudioTab = 'artifacts' | 'changes' | 'files' | 'terminal' | 'browser'

const STUDIO_WIDTH_KEY = 'atrium.studio.width'
const DEFAULT_STUDIO_WIDTH = 468
const MIN_STUDIO_WIDTH = 340

function maxStudioWidth(): number {
  if (typeof window === 'undefined') return 920
  const sidebarEl = document.querySelector<HTMLElement>('.sidebar')
  const sidebarW =
    sidebarEl && !sidebarEl.classList.contains('is-collapsed')
      ? Math.round(sidebarEl.getBoundingClientRect().width)
      : 0
  return Math.max(360, window.innerWidth - sidebarW - 240)
}

function clampStudioWidth(w: number): number {
  return Math.max(MIN_STUDIO_WIDTH, Math.min(maxStudioWidth(), Math.round(w)))
}

function loadSavedStudioWidth(): number {
  try {
    const raw = localStorage.getItem(STUDIO_WIDTH_KEY)
    const n = raw ? Number.parseInt(raw, 10) : NaN
    return Number.isFinite(n) ? clampStudioWidth(n) : clampStudioWidth(DEFAULT_STUDIO_WIDTH)
  } catch {
    return clampStudioWidth(DEFAULT_STUDIO_WIDTH)
  }
}

function fileExtension(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toUpperCase().slice(0, 5)
}

function splitDirName(relPath: string): { base: string; dir: string } {
  const parts = relPath.split('/')
  const base = parts.pop() || relPath
  return { base, dir: parts.join('/') }
}

function diffLangFromPath(relPath: string): string {
  const base = relPath.split('/').pop()?.toLowerCase() ?? ''
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1) : ''
}

function renderDiffLineCode(entry: ParsedDiffLine, lang: string, stripSignPrefix = false) {
  const raw = entry.text
  if (!raw) return ' '
  if ((entry.kind === 'add' || entry.kind === 'del' || entry.kind === 'ctx') && /^[+\- ]/.test(raw)) {
    const sign = raw[0]
    const body = raw.slice(1)
    const highlighted = body ? highlightCode(body, lang) : ' '
    return stripSignPrefix ? highlighted : (
      <>
        <span className="diff-sign">{sign}</span>
        {highlighted}
      </>
    )
  }
  return raw
}

function ChangeDiffLines({
  path,
  diff,
  viewMode = 'unified',
  comments = [],
  onAddComment,
  onRemoveComment,
}: {
  path: string
  diff: string
  viewMode?: 'unified' | 'split'
  comments?: DiffReviewComment[]
  onAddComment?: (comment: Omit<DiffReviewComment, 'id'>) => void
  onRemoveComment?: (id: string) => void
}) {
  const { t } = useTranslation()
  const [draftAnchor, setDraftAnchor] = useState<{ line: number; side: 'old' | 'new'; snippet: string } | null>(null)
  const [draftBody, setDraftBody] = useState('')
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  const splitRows = useMemo(() => (viewMode === 'split' ? buildSplitDiffRows(parsed) : []), [parsed, viewMode])
  const lang = useMemo(() => diffLangFromPath(path), [path])

  if (!diff.trim()) return null

  const commentsByKey = new Map<string, DiffReviewComment[]>()
  for (const c of comments) {
    const key = `${c.side}:${c.line}`
    const arr = commentsByKey.get(key) ?? []
    arr.push(c)
    commentsByKey.set(key, arr)
  }

  const saveDraft = () => {
    if (!draftAnchor || !onAddComment) return
    const clean = draftBody.trim()
    if (!clean) return
    onAddComment({
      path,
      side: draftAnchor.side,
      line: draftAnchor.line,
      snippet: draftAnchor.snippet,
      body: clean,
    })
    setDraftBody('')
    setDraftAnchor(null)
  }

  if (viewMode === 'split') {
    return (
      <div className="diff-view studio-diff-view studio-diff-split">
        {splitRows.map((row) => {
          if (row.kind === 'file' || row.kind === 'hunk') {
            return (
              <div key={row.index} className={row.kind === 'file' ? 'diff-line diff-file' : 'diff-line diff-hunk'}>
                <span className="diff-code-text">{row.headerText || ' '}</span>
              </div>
            )
          }
          const renderCell = (cell: ParsedDiffLine | undefined, sideKind: 'old' | 'new') => {
            if (!cell) return <div className="diff-split-cell empty" />
            const cls =
              cell.kind === 'add'
                ? 'diff-line diff-add'
                : cell.kind === 'del'
                  ? 'diff-line diff-del'
                  : 'diff-line diff-ctx'
            const lineNum = sideKind === 'old' ? cell.oldLine : cell.newLine
            const commentSide: 'old' | 'new' | undefined = cell.kind === 'del' ? 'old' : lineNum !== undefined ? sideKind : undefined
            const canComment = Boolean(onAddComment && lineNum !== undefined && commentSide)
            return (
              <div className={`diff-split-cell ${cls}`}>
                <span className="diff-gutter">
                  <span className="diff-ln">{lineNum ?? ''}</span>
                  {canComment && (
                    <button
                      type="button"
                      className="diff-comment-trigger"
                      onClick={() => {
                        setDraftAnchor({ line: lineNum!, side: commentSide!, snippet: cell.text })
                        setDraftBody('')
                      }}
                      title={t('studio.addLineComment')}
                      aria-label={t('studio.addLineComment')}
                    >
                      <MessageSquarePlus size={10} />
                    </button>
                  )}
                </span>
                <span className="diff-code-text">{renderDiffLineCode(cell, lang, true)}</span>
              </div>
            )
          }
          return (
            <div key={row.index} className="diff-split-row">
              {renderCell(row.left, 'old')}
              {renderCell(row.right, 'new')}
            </div>
          )
        })}
        {draftAnchor && (
          <div className="studio-inline-editor">
            <textarea
              rows={2}
              autoFocus
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder={`L${draftAnchor.line}: ${t('studio.commentPlaceholder')}`}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setDraftAnchor(null)
                  setDraftBody('')
                } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  saveDraft()
                }
              }}
            />
            <div className="studio-inline-editor-acts">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  setDraftAnchor(null)
                  setDraftBody('')
                }}
              >
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-small btn-primary" disabled={!draftBody.trim()} onClick={saveDraft}>
                {t('studio.commentSave')}
              </button>
            </div>
          </div>
        )}
        {comments.map((comment) => (
          <div key={comment.id} className="studio-inline-comment">
            <div className="studio-inline-comment-head">
              <span>
                L{comment.line}
                {comment.side === 'old' ? ' (old)' : ''}
              </span>
              {onRemoveComment && (
                <button
                  type="button"
                  className="icon-btn studio-inline-rm"
                  onClick={() => onRemoveComment(comment.id)}
                  title={t('common.remove')}
                  aria-label={t('common.remove')}
                >
                  <Trash2 size={11} />
                </button>
              )}
            </div>
            <p>{comment.body}</p>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="diff-view studio-diff-view">
      {parsed.map((entry) => {
        const cls =
          entry.kind === 'file'
            ? 'diff-line diff-file'
            : entry.kind === 'hunk'
              ? 'diff-line diff-hunk'
              : entry.kind === 'add'
                ? 'diff-line diff-add'
                : entry.kind === 'del'
                  ? 'diff-line diff-del'
                  : 'diff-line diff-ctx'
        const canComment = Boolean(onAddComment && entry.line !== undefined && entry.side)
        const anchorKey = entry.line !== undefined && entry.side ? `${entry.side}:${entry.line}` : ''
        const lineComments = anchorKey ? commentsByKey.get(anchorKey) ?? [] : []
        const isEditingHere =
          draftAnchor !== null && entry.line === draftAnchor.line && entry.side === draftAnchor.side

        return (
          <div key={entry.index} className="diff-line-group">
            <div className={cls}>
              {entry.kind !== 'file' && entry.kind !== 'hunk' && (
                <span className="diff-gutter">
                  <span className="diff-ln">{entry.newLine ?? entry.oldLine ?? ''}</span>
                  {canComment && (
                    <button
                      type="button"
                      className="diff-comment-trigger"
                      onClick={() => {
                        setDraftAnchor({ line: entry.line!, side: entry.side!, snippet: entry.text })
                        setDraftBody('')
                      }}
                      title={t('studio.addLineComment')}
                      aria-label={t('studio.addLineComment')}
                    >
                      <MessageSquarePlus size={11} />
                    </button>
                  )}
                </span>
              )}
              <span className="diff-code-text">{renderDiffLineCode(entry, lang)}</span>
            </div>

            {lineComments.map((comment) => (
              <div key={comment.id} className="studio-inline-comment">
                <div className="studio-inline-comment-head">
                  <span>
                    L{comment.line}
                    {comment.side === 'old' ? ' (old)' : ''}
                  </span>
                  {onRemoveComment && (
                    <button
                      type="button"
                      className="icon-btn studio-inline-rm"
                      onClick={() => onRemoveComment(comment.id)}
                      title={t('common.remove')}
                      aria-label={t('common.remove')}
                    >
                      <Trash2 size={11} />
                    </button>
                  )}
                </div>
                <p>{comment.body}</p>
              </div>
            ))}

            {isEditingHere && (
              <div className="studio-inline-editor">
                <textarea
                  rows={2}
                  autoFocus
                  value={draftBody}
                  onChange={(e) => setDraftBody(e.target.value)}
                  placeholder={t('studio.commentPlaceholder')}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setDraftAnchor(null)
                      setDraftBody('')
                    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      saveDraft()
                    }
                  }}
                />
                <div className="studio-inline-editor-acts">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      setDraftAnchor(null)
                      setDraftBody('')
                    }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    disabled={!draftBody.trim()}
                    onClick={saveDraft}
                  >
                    {t('studio.commentSave')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ChangeRow({
  item,
  index,
  expanded,
  diffViewMode = 'unified',
  onToggleExpand,
  onToggleStage,
  onPreviewFile,
  onRevert,
  comments,
  onAddComment,
  onRemoveComment,
}: {
  item: FileChangeEntry
  index: number
  expanded: boolean
  diffViewMode?: 'unified' | 'split'
  onToggleExpand: () => void
  onToggleStage?: (staged: boolean) => void
  onPreviewFile?: () => void
  onRevert?: () => void
  comments: DiffReviewComment[]
  onAddComment?: (comment: Omit<DiffReviewComment, 'id'>) => void
  onRemoveComment?: (id: string) => void
}) {
  const { t } = useTranslation()
  const { base, dir } = splitDirName(item.path)
  const badge = item.status === 'added' ? 'A' : item.status === 'deleted' ? 'D' : item.status === 'renamed' ? 'R' : 'M'
  const hasDiff = Boolean(item.diff.trim())
  const showStageCheck = Boolean(onToggleStage && (item.staged !== undefined || item.unstaged !== undefined))
  const isStagedOnly = Boolean(item.staged && !item.unstaged)
  const isMixedStage = Boolean(item.staged && item.unstaged)

  return (
    <div
      className={`studio-change-card status-${item.status}${item.staged ? ' is-staged' : ''}`}
      style={{ '--item-i': Math.min(index, 12) } as CSSProperties}
    >
      <div className="studio-change-head">
        {showStageCheck && (
          <button
            type="button"
            className={`studio-stage-check${isStagedOnly ? ' checked' : isMixedStage ? ' partial' : ''}`}
            onClick={() => onToggleStage!(!isStagedOnly)}
            title={isStagedOnly ? t('studio.unstageFile') : t('studio.stageFile')}
            aria-label={isStagedOnly ? t('studio.unstageFile') : t('studio.stageFile')}
            aria-pressed={isStagedOnly}
          >
            {isStagedOnly ? <Check size={10} strokeWidth={3} /> : isMixedStage ? <span className="partial-dot" /> : null}
          </button>
        )}
        <button type="button" className="studio-change-open" onClick={onToggleExpand} aria-expanded={expanded}>
          <ChevronRight size={13} className={`studio-change-chev${expanded ? ' open' : ''}`} />
          <span className={`studio-status-badge status-${item.status}`}>{badge}</span>
          <span className="studio-change-meta">
            <strong>{base}</strong>
            {(item.fromPath || dir) && <span>{item.fromPath ? `${item.fromPath} → ${item.path}` : dir}</span>}
          </span>
        </button>
        {item.staged && <span className="studio-staged-tag">{t('studio.stagedTag')}</span>}
        {comments.length > 0 && <span className="studio-comment-count">{comments.length}</span>}
        <span className="studio-stat-pills">
          {item.additions > 0 && <span className="stat-add">+{item.additions}</span>}
          {item.deletions > 0 && <span className="stat-del">-{item.deletions}</span>}
        </span>
        {item.status !== 'deleted' && onPreviewFile && (
          <button
            type="button"
            className="icon-btn studio-revert-btn"
            onClick={onPreviewFile}
            title={t('studio.openFile')}
            aria-label={t('studio.openFile')}
          >
            <Eye size={13} />
          </button>
        )}
        {item.revertible && onRevert && (
          <button
            type="button"
            className="icon-btn studio-revert-btn"
            onClick={onRevert}
            title={t('studio.revertFile')}
            aria-label={t('studio.revertFile')}
          >
            <Undo2 size={13} />
          </button>
        )}
      </div>
      {hasDiff && (
        <div className={`studio-diff-collapse${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
          <div className="studio-diff-collapse-inner">
            <ChangeDiffLines
              path={item.path}
              diff={item.diff}
              viewMode={diffViewMode}
              comments={comments}
              onAddComment={onAddComment}
              onRemoveComment={onRemoveComment}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export function StudioDrawer({
  open = true,
  chatId,
  tab,
  onTabChange,
  onClose,
  workspace,
  artifacts,
  selectedArtifactUid,
  onSelectArtifact,
  changes,
  changesLoading,
  onRefreshChanges,
  onRevertChange,
  onRevertAllChanges,
  reviewComments = [],
  onAddReviewComment,
  onRemoveReviewComment,
  onClearReviewComments,
  onSubmitReviewComments,
  onGitCommit,
  onStageGitFiles,
  onCheckoutBranch,
  onPushGit,
  onCreatePr,
  onSuggestCommitMessage,
  onMergeWorktree,
  files,
  draftFiles,
  onToggleDraftFile,
  onPreviewFile,
  onRefreshFiles,
  onArtifactSaved,
  onSendTerminalOutput,
  onAttachBrowserScreenshot,
}: {
  open?: boolean
  chatId?: string | null
  tab: StudioTab
  onTabChange: (tab: StudioTab) => void
  onClose: () => void
  workspace?: string
  artifacts: ParsedArtifact[]
  selectedArtifactUid: string | null
  onSelectArtifact: (uid: string) => void
  changes: WorkspaceChanges | null
  changesLoading?: boolean
  onRefreshChanges: () => void
  onRevertChange: (path: string) => void
  onRevertAllChanges: () => void
  reviewComments?: DiffReviewComment[]
  onAddReviewComment?: (comment: Omit<DiffReviewComment, 'id'>) => void
  onRemoveReviewComment?: (id: string) => void
  onClearReviewComments?: () => void
  onSubmitReviewComments?: () => void
  onGitCommit?: (message: string) => Promise<boolean>
  onStageGitFiles?: (paths: string[], staged: boolean) => Promise<void>
  onCheckoutBranch?: (branch: string, createNew?: boolean) => Promise<boolean>
  onPushGit?: () => Promise<boolean>
  onCreatePr?: () => Promise<void>
  onSuggestCommitMessage?: () => Promise<string>
  onMergeWorktree?: (opts: { commitMessage?: string; cleanupWorktree: boolean }) => Promise<boolean>
  files: string[]
  draftFiles: string[]
  onToggleDraftFile: (relPath: string) => void
  onPreviewFile: (relPath: string) => Promise<void> | void
  onRefreshFiles?: () => void
  onArtifactSaved: () => void
  onSendTerminalOutput?: (snippet: string) => void
  onAttachBrowserScreenshot?: (image: ImageAttachment) => void
}) {
  const { t } = useTranslation()
  const terminalSessions = useStore((s) => s.terminalSessions)
  const runningTerminals = terminalSessions.filter((s) => s.status === 'running').length
  const browserOpen = useStore((s) => Boolean(browserSnapshotFor(s, chatId ?? s.activeChatId)?.open))
  const [fileFilter, setFileFilter] = useState('')
  const [expandedDiffs, setExpandedDiffs] = useState<Record<string, boolean>>({})
  const [diffWrap, setDiffWrap] = useState(true)
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(() => {
    try {
      return localStorage.getItem('atrium.studio.diffMode') === 'split' ? 'split' : 'unified'
    } catch {
      return 'unified'
    }
  })
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [newBranchDraft, setNewBranchDraft] = useState('')
  const [pushing, setPushing] = useState(false)
  const [creatingPr, setCreatingPr] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeCommitMsg, setMergeCommitMsg] = useState('')
  const [mergeCleanup, setMergeCleanup] = useState(true)
  const [merging, setMerging] = useState(false)
  const [studioWidth, setStudioWidth] = useState<number>(loadSavedStudioWidth)
  const [resizing, setResizing] = useState(false)
  const [fileCtxMenu, setFileCtxMenu] = useState<{
    x: number
    y: number
    file: string
    entries: ContextMenuEntry[]
  } | null>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const branchWrapRef = useRef<HTMLDivElement | null>(null)
  useDismissPopover(branchWrapRef, branchMenuOpen, () => setBranchMenuOpen(false))
  // Keep sandboxed artifact frames alive during the close slide, then unmount them once settled shut.
  const [renderArtifactStage, setRenderArtifactStage] = useState(open)

  useEffect(() => {
    const onWinResize = () => {
      setStudioWidth((prev) => clampStudioWidth(prev))
    }
    window.addEventListener('resize', onWinResize)
    return () => {
      window.removeEventListener('resize', onWinResize)
      dragCleanupRef.current?.()
    }
  }, [])

  useEffect(() => {
    document.body.classList.toggle('is-resizing-studio', resizing)
    return () => document.body.classList.remove('is-resizing-studio')
  }, [resizing])

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragCleanupRef.current?.()
    dragCleanupRef.current = startColumnResize({
      event: e,
      startWidth: studioWidth,
      computeWidth: (base, deltaX) => clampStudioWidth(base - deltaX),
      onStart: () => setResizing(true),
      onMove: (w) => setStudioWidth(w),
      onEnd: (finalWidth) => {
        dragCleanupRef.current = null
        setResizing(false)
        try {
          localStorage.setItem(STUDIO_WIDTH_KEY, String(finalWidth))
        } catch {
          /* ignore storage error */
        }
      },
    })
  }

  const resetWidth = () => {
    const def = clampStudioWidth(DEFAULT_STUDIO_WIDTH)
    setStudioWidth(def)
    try {
      localStorage.setItem(STUDIO_WIDTH_KEY, String(def))
    } catch {
      /* ignore */
    }
  }

  const isExpandedWidth = studioWidth >= 560
  const toggleExpandedWidth = () => {
    const next = isExpandedWidth
      ? clampStudioWidth(DEFAULT_STUDIO_WIDTH)
      : clampStudioWidth(Math.min(680, Math.round(window.innerWidth * 0.52)))
    setStudioWidth(next)
    try {
      localStorage.setItem(STUDIO_WIDTH_KEY, String(next))
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (open) {
      setRenderArtifactStage(true)
      return
    }
    const timer = window.setTimeout(() => setRenderArtifactStage(false), 360)
    return () => window.clearTimeout(timer)
  }, [open])

  // Latest version per unique identifier for compact switcher pills.
  const latestByIdentifier = useMemo(() => {
    const map = new Map<string, ParsedArtifact>()
    for (const art of artifacts) map.set(art.identifier.toLowerCase(), art)
    return [...map.values()]
  }, [artifacts])

  const selectedArtifact = useMemo(() => {
    if (artifacts.length === 0) return null
    return artifacts.find((a) => a.uid === selectedArtifactUid) ?? artifacts[artifacts.length - 1]!
  }, [artifacts, selectedArtifactUid])

  const selectedVersions = useMemo(() => {
    if (!selectedArtifact) return []
    const key = selectedArtifact.identifier.toLowerCase()
    return artifacts.filter((a) => a.identifier.toLowerCase() === key)
  }, [artifacts, selectedArtifact])

  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase()
    const matched = q ? files.filter((f) => f.toLowerCase().includes(q)) : files
    return matched.slice(0, 160)
  }, [files, fileFilter])

  const revertibleCount = changes?.items.filter((i) => i.revertible).length ?? 0
  const changeCount = changes?.items.length ?? 0
  const totalAdditions = changes?.items.reduce((acc, i) => acc + i.additions, 0) ?? 0
  const totalDeletions = changes?.items.reduce((acc, i) => acc + i.deletions, 0) ?? 0
  const allDiffsExpanded = Boolean(
    changes &&
      changes.items.length > 0 &&
      changes.items.every((item) => expandedDiffs[item.path] ?? changes.items.length <= 3),
  )
  const toggleAllDiffs = () => {
    if (!changes?.items.length) return
    const nextState = !allDiffsExpanded
    const nextMap: Record<string, boolean> = {}
    for (const item of changes.items) nextMap[item.path] = nextState
    setExpandedDiffs(nextMap)
  }
  const artifactCount = latestByIdentifier.length
  const hasStreaming = Boolean(selectedArtifact?.streaming)
  const { containerRef: tabsRef, ready: tabsReady, animate: tabsAnimate, gliderStyle: tabsGliderStyle } = useGlider(
    '.studio-tab.active',
    [tab, artifactCount, changeCount, runningTerminals, browserOpen, open, studioWidth],
  )

  useEffect(() => {
    if (!open) return
    const active = tabsRef.current?.querySelector('.studio-tab.active') as HTMLElement | null
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [tab, open, tabsRef])

  const toggleDiff = (path: string) => {
    setExpandedDiffs((prev) => ({ ...prev, [path]: !(prev[path] ?? (changes?.items.length ?? 0) <= 3) }))
  }

  const openFileContextMenu = (e: ReactMouseEvent, file: string, added: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const sep = workspace?.includes('\\') ? '\\' : '/'
    const cleanWs = workspace ? workspace.replace(/[\\/]+$/, '') : ''
    const fullPath = cleanWs ? `${cleanWs}${sep}${sep === '\\' ? file.replace(/\//g, '\\') : file}` : ''

    const entries: ContextMenuEntry[] = [
      {
        id: 'preview-file',
        label: t('chat.previewFile'),
        icon: <Eye size={14} />,
        onSelect: () => void onPreviewFile(file),
      },
      {
        id: 'toggle-draft',
        label: added ? t('chat.ctxRemoveFromDraft') : t('chat.attachFile'),
        icon: added ? <Trash2 size={14} /> : <Plus size={14} />,
        onSelect: () => onToggleDraftFile(file),
      },
      ...(workspace
        ? [
            { kind: 'separator' as const, id: 'sep-reveal' },
            {
              id: 'open-editor',
              label: t('chat.openInEditor'),
              icon: <ExternalLink size={14} />,
              onSelect: () =>
                void shell
                  .openInEditor(file, workspace)
                  .then((r) => toast(t('chat.openedInEditor', { editor: r.editor, path: file })))
                  .catch((err) => toast(errorMessage(err), 'error')),
            },
            {
              id: 'reveal-file',
              label: t('chat.ctxRevealFile'),
              icon: <FolderOpen size={14} />,
              onSelect: () => void shell.revealPath(file, workspace).catch((err) => toast(errorMessage(err), 'error')),
            },
          ]
        : []),
      { kind: 'separator', id: 'sep-copy' },
      {
        id: 'copy-rel',
        label: t('studio.copyPath'),
        icon: <Copy size={14} />,
        onSelect: () => {
          void navigator.clipboard?.writeText(file)
          toast(t('studio.pathCopied', { path: file }))
        },
      },
      ...(fullPath
        ? [
            {
              id: 'copy-full',
              label: t('chat.ctxCopyFullPath'),
              icon: <Copy size={14} />,
              onSelect: () => {
                void navigator.clipboard?.writeText(fullPath)
                toast(t('studio.pathCopied', { path: fullPath }))
              },
            },
          ]
        : []),
    ]

    setFileCtxMenu({ x: e.clientX, y: e.clientY, file, entries })
  }

  return (
    <aside
      className={`workspace-drawer studio-drawer${open ? ' open' : ''}${resizing ? ' is-resizing' : ''}${hasStreaming ? ' is-streaming' : ''}${changesLoading ? ' is-loading' : ''}`}
      style={open ? ({ width: `${studioWidth}px` } as CSSProperties) : undefined}
      aria-label={t('studio.title')}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      {open && (
        <div
          className={`studio-resizer${resizing ? ' active' : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('studio.resizeHint')}
          aria-valuenow={studioWidth}
          title={t('studio.resizeHint')}
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
        >
          {resizing && <span className="studio-resize-badge">{studioWidth}px</span>}
        </div>
      )}
      <div className="studio-ambient" aria-hidden="true">
        <span className="studio-ambient-aurora studio-aurora-top" />
        <span className="studio-ambient-aurora studio-aurora-bottom" />
        <span className="studio-ambient-dots" />
        <span className="studio-seam-beam" />
      </div>
      <div className="studio-drawer-inner">
        <div className="ws-drawer-head studio-head">
          <div ref={tabsRef} className={`studio-tabs${tabsReady ? ' has-glider' : ''}`} role="tablist">
            {tabsReady && (
              <span className={`studio-tab-glider${tabsAnimate ? ' animate' : ''}`} style={tabsGliderStyle} aria-hidden="true" />
            )}
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'artifacts'}
              className={`studio-tab${tab === 'artifacts' ? ' active' : ''}`}
              onClick={() => onTabChange('artifacts')}
            >
              <Sparkles size={13} />
              <span>{t('studio.artifacts')}</span>
              {artifactCount > 0 && <span className="studio-tab-badge">{artifactCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'changes'}
              className={`studio-tab${tab === 'changes' ? ' active' : ''}`}
              onClick={() => onTabChange('changes')}
            >
              <FileDiff size={13} />
              <span>{t('studio.changes')}</span>
              {changeCount > 0 && <span className="studio-tab-badge">{changeCount}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'files'}
              className={`studio-tab${tab === 'files' ? ' active' : ''}`}
              onClick={() => onTabChange('files')}
            >
              <FolderOpen size={13} />
              <span>{t('studio.files')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'terminal'}
              className={`studio-tab${tab === 'terminal' ? ' active' : ''}`}
              onClick={() => onTabChange('terminal')}
            >
              <Terminal size={13} />
              <span>{t('studio.terminal')}</span>
              {runningTerminals > 0 && <span className="studio-tab-badge">{runningTerminals}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'browser'}
              className={`studio-tab${tab === 'browser' ? ' active' : ''}`}
              onClick={() => onTabChange('browser')}
            >
              <Globe size={13} />
              <span>{t('studio.browser')}</span>
              {browserOpen && <span className="studio-tab-badge">1</span>}
            </button>
          </div>
          <div className="studio-head-actions">
            <button
              type="button"
              className="icon-btn studio-expand-btn"
              onClick={toggleExpandedWidth}
              aria-label={isExpandedWidth ? t('studio.restoreWidth') : t('studio.expandWidth')}
              title={isExpandedWidth ? t('studio.restoreWidth') : t('studio.expandWidth')}
            >
              {isExpandedWidth ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button type="button" className="icon-btn studio-close-btn" onClick={onClose} aria-label={t('common.close')}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div key={tab} className="studio-tab-panel">
          {tab === 'artifacts' && (
            <div className="studio-body">
              {selectedArtifact && (open || renderArtifactStage) ? (
                <>
                  {latestByIdentifier.length > 1 && (
                    <div className="studio-art-strip">
                      {latestByIdentifier.map((art) => {
                        const active = selectedArtifact.identifier.toLowerCase() === art.identifier.toLowerCase()
                        return (
                          <button
                            key={art.uid}
                            type="button"
                            className={`studio-art-pill${active ? ' active' : ''}`}
                            onClick={() => onSelectArtifact(art.uid)}
                            title={art.title}
                          >
                            <Layers size={11} />
                            <span>{art.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <Suspense fallback={<div className="artifact-loading">{t('common.loading')}</div>}>
                    <ArtifactPreview
                      artifact={selectedArtifact}
                      versions={selectedVersions}
                      onSelectVersion={(v) => onSelectArtifact(v.uid)}
                      workspace={workspace}
                      onSavedToWorkspace={onArtifactSaved}
                    />
                  </Suspense>
                </>
              ) : (
                <div className="studio-empty">
                  <div className="studio-empty-stage" aria-hidden="true">
                    <span className="studio-empty-ring" />
                    <div className="studio-empty-badge">
                      <Sparkles size={20} />
                    </div>
                  </div>
                  <strong>{t('studio.noArtifactsTitle')}</strong>
                  <p>{t('studio.noArtifactsHint')}</p>
                </div>
              )}
            </div>
          )}

          {tab === 'changes' && (
            <div className="studio-body">
              <div className="studio-changes-bar">
                <div className="studio-branch-info">
                  {changes?.isGit ? (
                    <div className="studio-branch-wrap" ref={branchWrapRef}>
                      <button
                        type="button"
                        className="studio-branch-pill clickable"
                        onClick={() => onCheckoutBranch && setBranchMenuOpen((v) => !v)}
                        title={t('studio.gitSwitchBranch')}
                      >
                        <GitBranch size={12} />
                        <span>{changes.branch ?? changes.head ?? 'HEAD'}</span>
                        {(changes.ahead ?? 0) > 0 && <em className="studio-ahead-tag">↑{changes.ahead}</em>}
                        {changes.isWorktree && <em className="studio-wt-tag">{t('studio.worktreeTag')}</em>}
                      </button>
                      {branchMenuOpen && onCheckoutBranch && (
                        <div className="studio-branch-menu" role="dialog" aria-label={t('studio.gitSwitchBranch')}>
                          <form
                            className="studio-branch-create"
                            onSubmit={(e) => {
                              e.preventDefault()
                              const name = newBranchDraft.trim()
                              if (!name) return
                              setBranchMenuOpen(false)
                              setNewBranchDraft('')
                              void onCheckoutBranch(name, true)
                            }}
                          >
                            <input
                              autoFocus
                              value={newBranchDraft}
                              onChange={(e) => setNewBranchDraft(e.target.value)}
                              placeholder={t('studio.gitNewBranchPlaceholder')}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') setBranchMenuOpen(false)
                              }}
                            />
                          </form>
                          <div className="studio-branch-list">
                            {(changes.branches ?? []).map((b) => (
                              <button
                                key={b}
                                type="button"
                                className={`studio-branch-item${b === changes.branch ? ' active' : ''}`}
                                onClick={() => {
                                  setBranchMenuOpen(false)
                                  if (b !== changes.branch) void onCheckoutBranch(b, false)
                                }}
                              >
                                <GitBranch size={11} />
                                <span>{b}</span>
                                {b === changes.branch && <Check size={11} />}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="studio-branch-muted">{folderName(workspace) ?? t('chat.noWorkspace')}</span>
                  )}
                  {changeCount > 0 && (
                    <span className="studio-changes-meta">
                      <span>{t('studio.diffSummary', { count: changeCount })}</span>
                      {totalAdditions > 0 && <span className="stat-add">+{totalAdditions}</span>}
                      {totalDeletions > 0 && <span className="stat-del">-{totalDeletions}</span>}
                    </span>
                  )}
                </div>
                <div className="studio-changes-actions">
                  {changes?.isGit && onPushGit && (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={pushing}
                      onClick={() => {
                        setPushing(true)
                        void onPushGit().finally(() => setPushing(false))
                      }}
                      title={t('studio.gitPush')}
                    >
                      <Upload size={12} />
                      <span>{t('studio.gitPush')}</span>
                    </button>
                  )}
                  {changes?.isGit && changes.githubRepo && onCreatePr && (
                    <button
                      type="button"
                      className="btn btn-small"
                      disabled={creatingPr}
                      onClick={() => {
                        setCreatingPr(true)
                        void onCreatePr().finally(() => setCreatingPr(false))
                      }}
                      title={t('studio.gitCreatePr')}
                    >
                      <GitPullRequest size={12} />
                      <span>{t('studio.gitCreatePr')}</span>
                    </button>
                  )}
                  {changes?.isWorktree && onMergeWorktree && (
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      onClick={() => {
                        setMergeCommitMsg('')
                        setMergeCleanup(true)
                        setMergeOpen(true)
                      }}
                    >
                      <GitMerge size={12} />
                      <span>{t('studio.mergeWorktree')}</span>
                    </button>
                  )}
                  {revertibleCount > 0 && (
                    <button type="button" className="btn btn-small" onClick={onRevertAllChanges}>
                      <Undo2 size={12} />
                      <span>{t('studio.revertAll')}</span>
                    </button>
                  )}
                  {changeCount > 0 && (
                    <>
                      <button
                        type="button"
                        className={`icon-btn${diffViewMode === 'split' ? ' is-active' : ''}`}
                        onClick={() =>
                          setDiffViewMode((m) => {
                            const next = m === 'split' ? 'unified' : 'split'
                            try {
                              localStorage.setItem('atrium.studio.diffMode', next)
                            } catch {
                              /* ignore storage error */
                            }
                            return next
                          })
                        }
                        aria-label={diffViewMode === 'split' ? t('studio.diffUnified') : t('studio.diffSplit')}
                        title={diffViewMode === 'split' ? t('studio.diffUnified') : t('studio.diffSplit')}
                      >
                        <Columns2 size={13} />
                      </button>
                      <button
                        type="button"
                        className={`icon-btn${diffWrap ? ' is-active' : ''}`}
                        onClick={() => setDiffWrap((v) => !v)}
                        aria-label={t('studio.wrapDiff')}
                        title={t('studio.wrapDiff')}
                      >
                        <WrapText size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={toggleAllDiffs}
                        aria-label={allDiffsExpanded ? t('studio.collapseAll') : t('studio.expandAll')}
                        title={allDiffsExpanded ? t('studio.collapseAll') : t('studio.expandAll')}
                      >
                        <ChevronsUpDown size={13} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={onRefreshChanges}
                    aria-label={t('studio.refresh')}
                    title={t('studio.refresh')}
                  >
                    <RefreshCw size={13} className={changesLoading ? 'spin' : undefined} />
                  </button>
                </div>
              </div>

              {changes?.isGit && changes.items.length > 0 && onStageGitFiles && (
                <div className="studio-stage-toolbar">
                  <button
                    type="button"
                    className="btn-link-subtle"
                    onClick={() => void onStageGitFiles(changes.items.map((x) => x.path), true)}
                  >
                    {t('studio.stageAll')}
                  </button>
                  <button
                    type="button"
                    className="btn-link-subtle"
                    onClick={() => void onStageGitFiles(changes.items.map((x) => x.path), false)}
                  >
                    {t('studio.unstageAll')}
                  </button>
                </div>
              )}

              {changes?.isGit && changes.items.length > 0 && onGitCommit && (
                <form
                  className="studio-commit-bar"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (committing || !commitMsg.trim()) return
                    setCommitting(true)
                    void onGitCommit(commitMsg.trim())
                      .then((ok) => {
                        if (ok) setCommitMsg('')
                      })
                      .finally(() => setCommitting(false))
                  }}
                >
                  <input
                    className="studio-commit-input"
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    placeholder={t('studio.gitCommitPlaceholder')}
                    aria-label={t('studio.gitCommitPlaceholder')}
                  />
                  {onSuggestCommitMessage && (
                    <button
                      type="button"
                      className="icon-btn studio-suggest-btn"
                      disabled={suggesting}
                      onClick={() => {
                        setSuggesting(true)
                        void onSuggestCommitMessage()
                          .then((draft) => {
                            if (draft) setCommitMsg(draft)
                          })
                          .finally(() => setSuggesting(false))
                      }}
                      title={t('studio.gitSuggestBtn')}
                      aria-label={t('studio.gitSuggestBtn')}
                    >
                      <Sparkles size={13} className={suggesting ? 'spin-slow' : undefined} />
                    </button>
                  )}
                  <button type="submit" className="btn btn-small btn-primary" disabled={committing || !commitMsg.trim()}>
                    <GitCommit size={12} />
                    <span>{t('studio.gitCommitBtn')}</span>
                  </button>
                </form>
              )}

              {!workspace ? (
                <div className="ws-drawer-empty">{t('chat.noWorkspace')}</div>
              ) : !changes || changes.items.length === 0 ? (
                <div className="studio-empty">
                  <div className="studio-empty-stage" aria-hidden="true">
                    <span className="studio-empty-ring" />
                    <div className="studio-empty-badge">
                      <FileDiff size={20} />
                    </div>
                  </div>
                  <strong>{t('studio.noChangesTitle')}</strong>
                  <p>{t('studio.noChangesHint')}</p>
                </div>
              ) : (
                <div className={`studio-changes-list${diffWrap ? ' diff-wrap' : ''}`}>
                  {changes.items.map((item, idx) => (
                    <ChangeRow
                      key={item.path}
                      index={idx}
                      item={item}
                      expanded={expandedDiffs[item.path] ?? changes.items.length <= 3}
                      diffViewMode={diffViewMode}
                      onToggleExpand={() => toggleDiff(item.path)}
                      onToggleStage={
                        changes.isGit && onStageGitFiles
                          ? (staged) => void onStageGitFiles([item.path], staged)
                          : undefined
                      }
                      onPreviewFile={() => void onPreviewFile(item.path)}
                      onRevert={item.revertible ? () => onRevertChange(item.path) : undefined}
                      comments={reviewComments.filter((c) => c.path === item.path)}
                      onAddComment={onAddReviewComment}
                      onRemoveComment={onRemoveReviewComment}
                    />
                  ))}
                </div>
              )}

              {reviewComments.length > 0 && onSubmitReviewComments && (
                <div className="studio-review-bar">
                  <span className="studio-review-count">{t('studio.reviewCount', { count: reviewComments.length })}</span>
                  {onClearReviewComments && (
                    <button type="button" className="btn btn-small" onClick={onClearReviewComments}>
                      {t('studio.reviewClearBtn')}
                    </button>
                  )}
                  <button type="button" className="btn btn-small btn-primary" onClick={onSubmitReviewComments}>
                    <Send size={12} />
                    <span>{t('studio.reviewSendBtn')}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'files' && (
            <>
              <div className="ws-files-top">
                <div className="ws-drawer-search">
                  <Search size={13} />
                  <input
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder={t('chat.filterFiles')}
                    aria-label={t('chat.filterFiles')}
                  />
                  {fileFilter && (
                    <button
                      type="button"
                      className="icon-btn ws-search-clear"
                      onClick={() => setFileFilter('')}
                      aria-label={t('common.close')}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                {workspace && (
                  <div className="ws-files-meta">
                    <span className="ws-files-count">
                      {fileFilter.trim()
                        ? t('studio.filesCount', { shown: filteredFiles.length, total: files.length })
                        : t('studio.filesTotal', { total: files.length })}
                    </span>
                    {draftFiles.length > 0 && (
                      <span className="ws-files-attached">{t('studio.filesAttachedCount', { count: draftFiles.length })}</span>
                    )}
                    {onRefreshFiles && (
                      <button
                        type="button"
                        className="icon-btn ws-files-refresh"
                        onClick={onRefreshFiles}
                        title={t('studio.refreshFiles')}
                        aria-label={t('studio.refreshFiles')}
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="ws-drawer-list">
                {!workspace ? (
                  <div className="ws-drawer-empty">{t('chat.noWorkspace')}</div>
                ) : filteredFiles.length === 0 ? (
                  <div className="ws-drawer-empty">{t('chat.mentionEmpty')}</div>
                ) : (
                  filteredFiles.map((file, idx) => {
                    const { base, dir } = splitDirName(file)
                    const ext = fileExtension(file)
                    const added = draftFiles.includes(file)
                    return (
                      <div
                        key={file}
                        style={{ '--item-i': Math.min(idx, 12) } as CSSProperties}
                        className={`ws-file-row${added ? ' added' : ''}${fileCtxMenu?.file === file ? ' ctx-target' : ''}`}
                        onContextMenu={(e) => openFileContextMenu(e, file, added)}
                      >
                        <button
                          type="button"
                          className="ws-file-open"
                          onClick={() => void onPreviewFile(file)}
                          title={file}
                        >
                          <FileCode size={13} className="ws-file-icon" />
                          <span className="ws-file-meta">
                            <span className="ws-file-name-row">
                              <strong>{base}</strong>
                              {ext && <em className="ws-file-ext">{ext}</em>}
                            </span>
                            {dir && <span>{dir}</span>}
                          </span>
                        </button>
                        {workspace && (
                          <button
                            type="button"
                            className="ws-file-act"
                            onClick={() =>
                              void shell
                                .openInEditor(file, workspace)
                                .then((r) => toast(t('chat.openedInEditor', { editor: r.editor, path: file })))
                                .catch((err) => toast(errorMessage(err), 'error'))
                            }
                            title={t('chat.openInEditor')}
                            aria-label={t('chat.openInEditor')}
                          >
                            <ExternalLink size={12} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="ws-file-act ws-file-copy"
                          onClick={() => {
                            void navigator.clipboard?.writeText(file)
                            toast(t('studio.pathCopied', { path: file }))
                          }}
                          title={t('studio.copyPath')}
                          aria-label={t('studio.copyPath')}
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          type="button"
                          className="ws-file-act ws-file-add"
                          onClick={() => onToggleDraftFile(file)}
                          title={t('chat.attachFile')}
                          aria-label={t('chat.attachFile')}
                        >
                          {added ? <Check size={13} /> : <Plus size={13} />}
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
            </>
          )}

          {tab === 'terminal' && open && (
            <div className="studio-body studio-terminal-body">
              <Suspense fallback={<div className="artifact-loading">{t('common.loading')}</div>}>
                <TerminalPanel workspace={workspace} onSendOutputToChat={onSendTerminalOutput} />
              </Suspense>
            </div>
          )}

          {tab === 'browser' && open && (
            <div className="studio-body studio-terminal-body">
              <Suspense fallback={<div className="artifact-loading">{t('common.loading')}</div>}>
                <BrowserPreviewPanel
                  active={open && tab === 'browser'}
                  conversationId={chatId}
                  onAttachScreenshot={onAttachBrowserScreenshot}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>

      {mergeOpen && changes?.isWorktree && onMergeWorktree && (
        <Dialog title={t('studio.mergeWorktreeTitle')} onClose={() => !merging && setMergeOpen(false)}>
          <div className="merge-wt-modal">
            <p className="confirm-msg">
              {t('studio.mergeWorktreeDesc', {
                branch: changes.branch ?? 'worktree',
                baseBranch: changes.baseBranch ?? 'main',
              })}
            </p>
            <label className="field-label">
              <span>{t('studio.mergeWorktreeCommitLabel')}</span>
              <input
                value={mergeCommitMsg}
                onChange={(e) => setMergeCommitMsg(e.target.value)}
                placeholder={t('studio.mergeWorktreeCommitPlaceholder')}
              />
            </label>
            <label className="rewind-check">
              <input
                type="checkbox"
                checked={mergeCleanup}
                onChange={(e) => setMergeCleanup(e.target.checked)}
              />
              <span>{t('studio.mergeWorktreeCleanup')}</span>
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn" disabled={merging} onClick={() => setMergeOpen(false)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={merging}
                onClick={() => {
                  setMerging(true)
                  void onMergeWorktree({
                    commitMessage: mergeCommitMsg.trim() || undefined,
                    cleanupWorktree: mergeCleanup,
                  })
                    .then((ok) => {
                      if (ok) setMergeOpen(false)
                    })
                    .finally(() => setMerging(false))
                }}
              >
                <GitMerge size={13} />
                <span>{t('studio.mergeWorktreeBtn')}</span>
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {fileCtxMenu && (
        <ContextMenu
          x={fileCtxMenu.x}
          y={fileCtxMenu.y}
          entries={fileCtxMenu.entries}
          ariaLabel={fileCtxMenu.file}
          onClose={() => setFileCtxMenu(null)}
        />
      )}
    </aside>
  )
}

export type { WorkspaceFilePreview }
