import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Code2, Copy, GitBranch, Globe, Layers, ListChecks, Pencil, Play, RotateCcw, Sparkles, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DocumentAttachment, ImageAttachment, Message, TokenUsage } from '@shared/types.ts'
import { splitMessageSegments, type ParsedArtifact } from '../lib/artifacts.ts'
import { streamFor, useStore, type LiveTurn } from '../lib/store.ts'
import { Dialog } from './Dialog.tsx'
import { DocumentChip, DocumentPreviewModal } from './DocumentChip.tsx'
import { Markdown } from './Markdown.tsx'
import { Oculus } from './Oculus.tsx'
import { ToolRow } from './ToolRow.tsx'

type ToolMessage = Extract<Message, { role: 'tool' }>

function Reasoning({ text, open, active }: { text: string; open?: boolean; active?: boolean }) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(Boolean(open))

  useEffect(() => {
    if (open !== undefined) setIsOpen(open)
  }, [open])

  if (!text.trim()) return null
  return (
    <div className="reasoning">
      <button type="button" className="reasoning-summary" onClick={() => setIsOpen((v) => !v)} aria-expanded={isOpen}>
        <ChevronRight size={13} className={`chev${isOpen ? ' open' : ''}`} />
        <Oculus state={active ? 'thinking' : 'idle'} size={14} />
        <span>{t('chat.reasoning')}</span>
      </button>
      <div className={`reasoning-expand${isOpen ? ' open' : ''}`} aria-hidden={!isOpen}>
        <div className="reasoning-expand-inner">
          <div className="reasoning-text">{text}</div>
        </div>
      </div>
    </div>
  )
}

function CompactSummary({ text }: { text: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const clean = text.replace(/^\[Compacted [^\]]+\]\s*/i, '').trim()

  return (
    <div className="summary-card">
      <button type="button" className="summary-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRight size={13} className={`chev${open ? ' open' : ''}`} />
        <Layers size={13} />
        <span>{t('chat.compactedTitle')}</span>
      </button>
      {open && (
        <div className="summary-body">
          <Markdown text={clean} />
        </div>
      )}
    </div>
  )
}

function AssistantHead({ modelName, isPlan }: { modelName?: string; isPlan?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="msg-head">
      <Oculus state="idle" size={16} />
      <span className="msg-author">Atrium</span>
      {modelName && <span className="msg-model">{modelName}</span>}
      {isPlan && <span className="plan-msg-badge">{t('mode.planBadge')}</span>}
    </div>
  )
}

function formatTokenCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function AssistantActions({
  text,
  onRegenerate,
  onFork,
  usage,
}: {
  text: string
  onRegenerate?: () => void
  onFork?: () => void
  usage?: TokenUsage
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const cachePct =
    usage?.cacheReadTokens && usage.inputTokens > 0
      ? Math.min(100, Math.round((usage.cacheReadTokens / usage.inputTokens) * 100))
      : 0

  return (
    <div className="msg-actions">
      <button type="button" className={`msg-action-btn${copied ? ' copied' : ''}`} onClick={copy} title={t('chat.copyReply')}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span>{copied ? t('common.copied') : t('chat.copyReply')}</span>
      </button>
      {onRegenerate && (
        <button type="button" className="msg-action-btn" onClick={onRegenerate} title={t('chat.regenerate')}>
          <RotateCcw size={13} />
          <span>{t('chat.regenerate')}</span>
        </button>
      )}
      {onFork && (
        <button type="button" className="msg-action-btn" onClick={onFork} title={t('chat.forkHint')}>
          <GitBranch size={13} />
          <span>{t('chat.fork')}</span>
        </button>
      )}
      {usage && (
        <span className="msg-usage" title={`${usage.inputTokens} in / ${usage.outputTokens} out`}>
          {formatTokenCount(usage.inputTokens)} in · {formatTokenCount(usage.outputTokens)} out
          {cachePct > 0 ? ` · ${t('chat.cached', { pct: cachePct })}` : ''}
        </span>
      )}
    </div>
  )
}

function ArtifactInlineCard({
  artifact,
  active,
  onOpen,
}: {
  artifact: Pick<ParsedArtifact, 'uid' | 'title' | 'kind' | 'language' | 'streaming'>
  active?: boolean
  onOpen?: (uid: string) => void
}) {
  const { t } = useTranslation()
  const Icon =
    artifact.kind === 'mermaid'
      ? GitBranch
      : artifact.kind === 'html'
        ? Globe
        : artifact.kind === 'svg'
          ? Sparkles
          : Code2

  return (
    <button
      type="button"
      className={`artifact-card${active ? ' active' : ''}`}
      onClick={() => onOpen?.(artifact.uid)}
    >
      <span className="artifact-card-icon">
        <Icon size={15} />
      </span>
      <span className="artifact-card-meta">
        <strong>{artifact.title}</strong>
        <span>
          {(artifact.language || artifact.kind).toUpperCase()}
          {' · '}
          {artifact.streaming ? t('studio.streaming') : t('studio.openCanvas')}
        </span>
      </span>
      <span className="artifact-card-pill">{t('studio.preview')}</span>
    </button>
  )
}

const EMPTY_ARTIFACTS: ParsedArtifact[] = []
const EMPTY_LIVE_TOOLS: LiveTurn['tools'] = {}

const RichAssistantContent = memo(function RichAssistantContent({
  text,
  msgKey,
  fencedArtifacts,
  activeArtifactUid,
  onOpenArtifact,
  streaming = false,
}: {
  text: string
  msgKey: string
  fencedArtifacts: ParsedArtifact[]
  activeArtifactUid?: string | null
  onOpenArtifact?: (uid: string) => void
  streaming?: boolean
}) {
  const segments = useMemo(() => splitMessageSegments(text, msgKey), [text, msgKey])
  return (
    <>
      {segments.map((seg, idx) =>
        seg.kind === 'markdown' ? (
          seg.text.trim() ? <Markdown key={idx} text={seg.text} streaming={streaming} /> : null
        ) : (
          <ArtifactInlineCard
            key={seg.artifact.uid}
            artifact={seg.artifact}
            active={seg.artifact.uid === activeArtifactUid}
            onOpen={onOpenArtifact}
          />
        ),
      )}
      {fencedArtifacts.length > 0 && (
        <div className="artifact-fenced-row">
          {fencedArtifacts.map((art) => (
            <button
              key={art.uid}
              type="button"
              className={`artifact-fenced-pill${art.uid === activeArtifactUid ? ' active' : ''}`}
              onClick={() => onOpenArtifact?.(art.uid)}
            >
              <Sparkles size={12} />
              <span>{art.title}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
})

type UserMsg = Extract<Message, { role: 'user' }>
type AssistantMsg = Extract<Message, { role: 'assistant' }>

const SavedUserRow = memo(function SavedUserRow({
  m,
  index,
  hit,
  activeHit,
  isEditing,
  onPreviewImage,
  onPreviewDoc,
  onStartEdit,
  onCancelEdit,
  onCommitEdit,
  onFork,
  onRewind,
}: {
  m: UserMsg
  index: number
  hit: boolean
  activeHit: boolean
  isEditing: boolean
  onPreviewImage: (img: ImageAttachment) => void
  onPreviewDoc: (doc: DocumentAttachment) => void
  onStartEdit?: (index: number, currentText: string) => void
  onCancelEdit: () => void
  onCommitEdit?: (index: number, nextText: string) => void
  onFork?: (index: number) => void
  onRewind?: (index: number) => void
}) {
  const { t } = useTranslation()
  const [editDraft, setEditDraft] = useState(m.text)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (isEditing) setEditDraft(m.text)
  }, [isEditing, m.text])

  if (m.isSummary) return <CompactSummary text={m.text} />

  return (
    <div
      data-msg-idx={index}
      className={`msg-user-wrap${hit ? ' search-hit' : ''}${activeHit ? ' search-hit-active' : ''}`}
    >
      <div className="msg msg-user">
        {Boolean(m.images?.length) && (
          <div className="msg-user-images">
            {m.images!.map((img) => (
              <button key={img.id} type="button" className="msg-user-img-btn" onClick={() => onPreviewImage(img)} title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
              </button>
            ))}
          </div>
        )}
        {Boolean(m.documents?.length) && (
          <div className="msg-user-docs">
            {m.documents!.map((doc) => (
              <DocumentChip key={doc.id} doc={doc} onPreview={() => onPreviewDoc(doc)} />
            ))}
          </div>
        )}
        {isEditing ? (
          <div className="msg-user-editor">
            <textarea
              autoFocus
              rows={Math.min(8, Math.max(2, editDraft.split('\n').length))}
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  onCancelEdit()
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  const trimmed = editDraft.trim()
                  if (!trimmed && !m.images?.length && !m.documents?.length) return
                  onCommitEdit?.(index, trimmed)
                }
              }}
            />
            <div className="msg-user-editor-acts">
              <button type="button" className="btn btn-small" onClick={onCancelEdit}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={!editDraft.trim() && !m.images?.length && !m.documents?.length}
                onClick={() => onCommitEdit?.(index, editDraft.trim())}
              >
                {t('chat.saveAndResend')}
              </button>
            </div>
          </div>
        ) : (
          m.text && <span>{m.text}</span>
        )}
      </div>
      {!isEditing && (
        <div className="msg-user-actions">
          {m.text && (
            <button
              type="button"
              className={`msg-rewind-btn${copied ? ' copied' : ''}`}
              onClick={() => {
                void navigator.clipboard.writeText(m.text).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                })
              }}
              title={t('chat.copyPrompt')}
              aria-label={t('chat.copyPrompt')}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? t('common.copied') : t('chat.copyPrompt')}</span>
            </button>
          )}
          {onStartEdit && (
            <button
              type="button"
              className="msg-rewind-btn"
              onClick={() => onStartEdit(index, m.text)}
              title={t('chat.editPrompt')}
              aria-label={t('chat.editPrompt')}
            >
              <Pencil size={12} />
              <span>{t('chat.editPrompt')}</span>
            </button>
          )}
          {onFork && (
            <button
              type="button"
              className="msg-rewind-btn"
              onClick={() => onFork(index)}
              title={t('chat.forkHint')}
              aria-label={t('chat.fork')}
            >
              <GitBranch size={12} />
              <span>{t('chat.fork')}</span>
            </button>
          )}
          {onRewind && (
            <button
              type="button"
              className="msg-rewind-btn"
              onClick={() => onRewind(index)}
              title={t('chat.rewindHint')}
              aria-label={t('chat.rewind')}
            >
              <Undo2 size={12} />
              <span>{t('chat.rewind')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
})

const SavedAssistantRow = memo(function SavedAssistantRow({
  m,
  index,
  turnStart,
  endOfTurn,
  canAct,
  showFork,
  hit,
  activeHit,
  modelName,
  defaultReasoningOpen,
  defaultToolsOpen,
  results,
  liveTools,
  fencedArtifacts,
  activeArtifactUid,
  onOpenArtifact,
  onPreviewImage,
  onRegenerate,
  onFork,
  onApprovePlan,
}: {
  m: AssistantMsg
  index: number
  turnStart: boolean
  endOfTurn: boolean
  canAct: boolean
  showFork: boolean
  hit: boolean
  activeHit: boolean
  modelName?: string
  defaultReasoningOpen: boolean
  defaultToolsOpen: boolean
  results: Map<string, ToolMessage>
  liveTools: LiveTurn['tools']
  fencedArtifacts: ParsedArtifact[]
  activeArtifactUid?: string | null
  onOpenArtifact?: (uid: string) => void
  onPreviewImage: (img: ImageAttachment) => void
  onRegenerate?: () => void
  onFork?: (index: number) => void
  onApprovePlan?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-msg-idx={index}
      className={`msg msg-assistant${hit ? ' search-hit' : ''}${activeHit ? ' search-hit-active' : ''}`}
    >
      {turnStart && <AssistantHead modelName={modelName} isPlan={m.mode === 'plan'} />}
      {m.reasoning && <Reasoning text={m.reasoning} open={defaultReasoningOpen} />}
      {m.text.trim() && (
        <RichAssistantContent
          text={m.text}
          msgKey={`m${index}`}
          fencedArtifacts={fencedArtifacts}
          activeArtifactUid={activeArtifactUid}
          onOpenArtifact={onOpenArtifact}
        />
      )}
      {m.toolCalls.map((call) => {
        const result = results.get(call.id)
        const liveStatus = liveTools[call.id]
        const status = result ? (result.isError ? (liveStatus?.status === 'denied' ? 'denied' : 'error') : 'done') : (liveStatus?.status ?? 'running')
        return (
          <ToolRow
            key={call.id}
            call={call}
            status={status}
            output={result?.output ?? liveStatus?.output}
            images={result?.images ?? liveStatus?.images}
            onPreviewImage={onPreviewImage}
            defaultOpen={defaultToolsOpen}
          />
        )
      })}
      {m.mode === 'plan' && endOfTurn && canAct && !m.incomplete && m.toolCalls.length === 0 && onApprovePlan && (
        <div className="plan-approve-bar">
          <div className="plan-approve-info">
            <ListChecks size={15} />
            <span>{t('mode.planReady')}</span>
          </div>
          <button type="button" className="btn btn-small btn-primary" onClick={onApprovePlan}>
            <Play size={12} />
            <span>{t('mode.approveImplement')}</span>
          </button>
        </div>
      )}
      {endOfTurn && (canAct || showFork) && (
        <AssistantActions
          text={m.text}
          onRegenerate={canAct ? onRegenerate : undefined}
          onFork={showFork ? () => onFork?.(index) : undefined}
          usage={canAct ? m.usage : undefined}
        />
      )}
    </div>
  )
})

const StreamingTurn = memo(function StreamingTurn({
  chatId,
  messageIndex,
  needStreamingHead,
  modelName,
  defaultReasoningOpen,
  fencedArtifacts,
  activeArtifactUid,
  onOpenArtifact,
}: {
  chatId: string | null
  messageIndex: number
  needStreamingHead: boolean
  modelName?: string
  defaultReasoningOpen: boolean
  fencedArtifacts: ParsedArtifact[]
  activeArtifactUid?: string | null
  onOpenArtifact?: (uid: string) => void
}) {
  const stream = useStore((s) => streamFor(s, chatId))
  if (!stream.text && !stream.reasoning) return null
  return (
    <div className="msg msg-assistant streaming">
      {needStreamingHead && <AssistantHead modelName={modelName} />}
      {stream.reasoning && <Reasoning text={stream.reasoning} open={!stream.text || defaultReasoningOpen} active={!stream.text} />}
      {stream.text && (
        <RichAssistantContent
          text={stream.text}
          msgKey={`m${messageIndex}`}
          fencedArtifacts={fencedArtifacts}
          activeArtifactUid={activeArtifactUid}
          onOpenArtifact={onOpenArtifact}
          streaming
        />
      )}
    </div>
  )
})

export function MessageList({
  chatId = null,
  messages,
  live,
  modelName,
  artifacts = EMPTY_ARTIFACTS,
  activeArtifactUid,
  searchQuery,
  activeSearchMatchIndex,
  onOpenArtifact,
  onRegenerate,
  onContinue,
  onApprovePlan,
  onEditUser,
  onRewind,
  onFork,
}: {
  chatId?: string | null
  messages: Message[]
  live: LiveTurn
  modelName?: string
  artifacts?: ParsedArtifact[]
  activeArtifactUid?: string | null
  searchQuery?: string
  activeSearchMatchIndex?: number | null
  onOpenArtifact?: (uid: string) => void
  onRegenerate?: () => void
  onContinue?: () => void
  onApprovePlan?: () => void
  onEditUser?: (messageIndex: number, nextText: string) => void | Promise<void>
  onRewind?: (messageIndex: number) => void
  onFork?: (messageIndex: number) => void
}) {
  const { t } = useTranslation()
  const defaultView = useStore((s) => s.settings?.defaultTranscriptView ?? 'normal')
  const defaultReasoningOpen = defaultView === 'thinking' || defaultView === 'verbose'
  const defaultToolsOpen = defaultView === 'verbose'
  const [previewImg, setPreviewImg] = useState<ImageAttachment | null>(null)
  const [previewDoc, setPreviewDoc] = useState<DocumentAttachment | null>(null)
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const needle = searchQuery?.trim().toLowerCase() ?? ''

  const cbRef = useRef({ onOpenArtifact, onRegenerate, onApprovePlan, onEditUser, onRewind, onFork })
  cbRef.current = { onOpenArtifact, onRegenerate, onApprovePlan, onEditUser, onRewind, onFork }

  const stableOpenArtifact = useCallback((uid: string) => cbRef.current.onOpenArtifact?.(uid), [])
  const stableRegenerate = useCallback(() => cbRef.current.onRegenerate?.(), [])
  const stableApprovePlan = useCallback(() => cbRef.current.onApprovePlan?.(), [])
  const stableFork = useCallback((idx: number) => cbRef.current.onFork?.(idx), [])
  const stableRewind = useCallback((idx: number) => cbRef.current.onRewind?.(idx), [])
  const stableStartEdit = useCallback((idx: number) => setEditingIdx(idx), [])
  const stableCancelEdit = useCallback(() => setEditingIdx(null), [])
  const stableCommitEdit = useCallback((idx: number, nextText: string) => {
    setEditingIdx(null)
    void cbRef.current.onEditUser?.(idx, nextText)
  }, [])

  const results = useMemo(() => {
    const map = new Map<string, ToolMessage>()
    for (const m of messages) if (m.role === 'tool') map.set(m.toolCallId, m)
    return map
  }, [messages])

  const fencedByMsg = useMemo(() => {
    const map = new Map<number, ParsedArtifact[]>()
    for (const art of artifacts) {
      if (!art.uid.includes(':fence:')) continue
      const arr = map.get(art.messageIndex) ?? []
      arr.push(art)
      map.set(art.messageIndex, arr)
    }
    return map
  }, [artifacts])

  const lastSaved = messages[messages.length - 1]
  const needStreamingHead = !lastSaved || lastSaved.role === 'user'

  return (
    <div className="messages">
      {messages.map((m, i) => {
        if (m.role === 'user') {
          const hit = Boolean(needle && m.text.toLowerCase().includes(needle))
          return (
            <SavedUserRow
              key={i}
              m={m}
              index={i}
              hit={hit}
              activeHit={activeSearchMatchIndex === i}
              isEditing={editingIdx === i}
              onPreviewImage={setPreviewImg}
              onPreviewDoc={setPreviewDoc}
              onStartEdit={onEditUser ? stableStartEdit : undefined}
              onCancelEdit={stableCancelEdit}
              onCommitEdit={onEditUser ? stableCommitEdit : undefined}
              onFork={onFork ? stableFork : undefined}
              onRewind={onRewind ? stableRewind : undefined}
            />
          )
        }
        if (m.role === 'tool') return null
        const prev = messages[i - 1]
        const next = messages[i + 1]
        const turnStart = !prev || prev.role === 'user'
        const endOfTurn = !next || next.role === 'user'
        const isLastMsg = i === messages.length - 1
        const canAct = Boolean(m.text.trim()) && isLastMsg && !live.busy
        const showFork = Boolean(onFork && endOfTurn && !live.busy && m.text.trim())
        const hasPendingTool = !results.has(m.toolCalls[0]?.id ?? '') && m.toolCalls.some((c) => !results.has(c.id))
        const hit = Boolean(needle && m.text.toLowerCase().includes(needle))
        return (
          <SavedAssistantRow
            key={i}
            m={m}
            index={i}
            turnStart={turnStart}
            endOfTurn={endOfTurn}
            canAct={canAct}
            showFork={showFork}
            hit={hit}
            activeHit={activeSearchMatchIndex === i}
            modelName={modelName}
            defaultReasoningOpen={defaultReasoningOpen}
            defaultToolsOpen={defaultToolsOpen}
            results={results}
            liveTools={hasPendingTool ? live.tools : EMPTY_LIVE_TOOLS}
            fencedArtifacts={fencedByMsg.get(i) ?? EMPTY_ARTIFACTS}
            activeArtifactUid={activeArtifactUid}
            onOpenArtifact={stableOpenArtifact}
            onPreviewImage={setPreviewImg}
            onRegenerate={onRegenerate ? stableRegenerate : undefined}
            onFork={onFork ? stableFork : undefined}
            onApprovePlan={onApprovePlan ? stableApprovePlan : undefined}
          />
        )
      })}
      <StreamingTurn
        chatId={chatId}
        messageIndex={messages.length}
        needStreamingHead={needStreamingHead}
        modelName={modelName}
        defaultReasoningOpen={defaultReasoningOpen}
        fencedArtifacts={fencedByMsg.get(messages.length) ?? EMPTY_ARTIFACTS}
        activeArtifactUid={activeArtifactUid}
        onOpenArtifact={stableOpenArtifact}
      />
      {live.compacting?.active && (
        <div className="msg-note-row compacting-banner">
          <Layers size={14} className="spin-slow" />
          <span>{live.compacting.auto ? t('chat.autoCompacting') : t('chat.compacting')}</span>
        </div>
      )}
      {live.error && (
        <div className="msg-error-row">
          <span>{live.error}</span>
          {!live.busy && (
            <div className="msg-row-actions">
              {onContinue && lastSaved?.role === 'assistant' && (
                <button type="button" className="btn btn-small btn-primary" onClick={onContinue}>
                  <Play size={12} />
                  <span>{t('chat.continue')}</span>
                </button>
              )}
              {onRegenerate && (
                <button type="button" className="btn btn-small" onClick={onRegenerate}>
                  <RotateCcw size={12} />
                  <span>{t('common.retry')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {live.endReason === 'aborted' && (
        <div className="msg-note-row">
          <span className="msg-note">{t('chat.stopped')}</span>
          {onContinue && !live.busy && lastSaved?.role === 'assistant' && (
            <button type="button" className="btn btn-small" onClick={onContinue}>
              <Play size={12} />
              <span>{t('chat.continue')}</span>
            </button>
          )}
        </div>
      )}
      {(() => {
        const persisted =
          !live.busy && !live.endReason && !live.error && lastSaved?.role === 'assistant' ? lastSaved.incomplete : undefined
        const truncatedKind =
          live.endReason === 'truncated'
            ? (live.truncation ?? 'stream_interrupted')
            : persisted === 'token_limit' || persisted === 'stream_interrupted'
              ? persisted
              : undefined
        if (!truncatedKind) return null
        return (
          <div className="msg-note-row">
            <span>{truncatedKind === 'token_limit' ? t('chat.truncatedTokenLimit') : t('chat.truncatedStream')}</span>
            {!live.busy && (
              <div className="msg-row-actions">
                {onContinue && (
                  <button type="button" className="btn btn-small btn-primary" onClick={onContinue}>
                    <Play size={12} />
                    <span>{t('chat.continue')}</span>
                  </button>
                )}
                {onRegenerate && truncatedKind === 'stream_interrupted' && (
                  <button type="button" className="btn btn-small" onClick={onRegenerate}>
                    <RotateCcw size={12} />
                    <span>{t('common.retry')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })()}
      {live.endReason === 'max_rounds' && (
        <div className="msg-note-row">
          <span>{t('chat.maxRounds')}</span>
          {onContinue && !live.busy && (
            <button type="button" className="btn btn-small btn-primary" onClick={onContinue}>
              <Play size={12} />
              <span>{t('chat.continue')}</span>
            </button>
          )}
        </div>
      )}

      {previewImg && (
        <Dialog title={previewImg.name} onClose={() => setPreviewImg(null)} wide>
          <div className="img-lightbox">
            <img src={previewImg.dataUrl} alt={previewImg.name} />
          </div>
        </Dialog>
      )}

      <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />
    </div>
  )
}
