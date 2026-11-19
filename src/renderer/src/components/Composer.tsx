import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react'
import {
  ArrowUp,
  BookOpen,
  Brain,
  CornerDownRight,
  FileCode2,
  Globe,
  ListChecks,
  ListPlus,
  Mic,
  MicOff,
  Minimize2,
  Pencil,
  Plug,
  Plus,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AgentMode,
  AttachedExternalFile,
  DocumentAttachment,
  ImageAttachment,
  McpPromptInfo,
  McpResourceInfo,
  PickedFileResult,
  QueuedMessage,
  SkillInfo,
  WorkScene,
} from '@shared/types.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { fileToImageAttachment, normalizeImageDataUrl } from '../lib/images.ts'
import { getState, toast, useStore } from '../lib/store.ts'
import type { ContextBreakdown } from '../lib/contextUsage.ts'
import { useVoiceDictation } from '../lib/useVoiceDictation.ts'
import { ComposerPlusMenu } from './ComposerPlusMenu.tsx'
import { ContextWindowPicker } from './ContextWindowPicker.tsx'
import { Dialog } from './Dialog.tsx'
import { DocumentChip, DocumentPreviewModal } from './DocumentChip.tsx'
import { PermissionPicker } from './PermissionPicker.tsx'

export type SlashAction = 'compact' | 'new' | 'plan' | 'auto' | 'manual' | 'bypass' | 'revoke' | 'browser' | 'remember'

interface Props {
  busy: boolean
  disabled?: boolean
  compact?: boolean
  workspace?: string
  direction?: 'up' | 'down'
  value: string
  images: ImageAttachment[]
  attachedFiles?: string[]
  externalFiles?: AttachedExternalFile[]
  queued?: QueuedMessage[]
  skills?: SkillInfo[]
  agentMode?: AgentMode
  workScene?: WorkScene
  canCompact?: boolean
  hasSessionAllows?: boolean
  contextInfo?: ContextBreakdown
  onChangeText: (text: string) => void
  onAddImages: (images: ImageAttachment[]) => void
  onRemoveImage: (id: string) => void
  onAddFiles?: (files: string[]) => void
  onRemoveFile?: (file: string) => void
  onAddExternalFiles?: (files: AttachedExternalFile[]) => void
  onRemoveExternalFile?: (id: string) => void
  onCancelQueued?: (queuedId: string) => void
  onSteerQueued?: (queuedId: string) => void
  onEditQueued?: (item: QueuedMessage) => void
  onAddFolder?: () => void
  onSelectMode?: (mode: AgentMode) => void
  onTogglePlan?: () => void
  onCompact?: () => void
  leading?: ReactNode
  trailing?: ReactNode
  onSend: (text: string, images: ImageAttachment[], documents: DocumentAttachment[]) => void
  onSlashCommand?: (action: SlashAction) => void
  onStop: () => void
}

interface MentionMatch {
  start: number
  end: number
  query: string
}

function findMention(value: string, caret: number): MentionMatch | null {
  const before = value.slice(0, caret)
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!m) return null
  const query = m[1] ?? ''
  return { start: before.length - query.length - 1, end: caret, query }
}

function findSlash(value: string, caret: number): string | null {
  if (caret !== value.length) return null
  const m = /^\/([a-z-]*)$/i.exec(value)
  return m ? (m[1] ?? '').toLowerCase() : null
}

export function Composer({
  busy,
  disabled,
  compact = false,
  workspace,
  direction = 'up',
  value,
  images,
  attachedFiles = [],
  externalFiles = [],
  queued = [],
  skills = [],
  agentMode = 'auto',
  workScene = 'code',
  canCompact,
  hasSessionAllows,
  contextInfo,
  onChangeText,
  onAddImages,
  onRemoveImage,
  onAddFiles,
  onRemoveFile,
  onAddExternalFiles,
  onRemoveExternalFile,
  onCancelQueued,
  onSteerQueued,
  onEditQueued,
  onAddFolder,
  onSelectMode,
  onTogglePlan,
  onCompact,
  leading,
  trailing,
  onSend,
  onSlashCommand,
  onStop,
}: Props) {
  const { t } = useTranslation()
  const [mention, setMention] = useState<MentionMatch | null>(null)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [previewImg, setPreviewImg] = useState<ImageAttachment | null>(null)
  const [previewDoc, setPreviewDoc] = useState<DocumentAttachment | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<{
    serverId: string
    serverName: string
    prompt: McpPromptInfo
    values: Record<string, string>
  } | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const servers = useStore((s) => s.servers)
  const statuses = useStore((s) => s.statuses)

  const mcpResources: Array<{ serverId: string; serverName: string; resource: McpResourceInfo }> = []
  const mcpPrompts: Array<{ serverId: string; serverName: string; prompt: McpPromptInfo }> = []
  for (const srv of servers) {
    const st = statuses[srv.id]
    if (!st || st.state !== 'connected') continue
    for (const resource of st.resources ?? []) {
      mcpResources.push({ serverId: srv.id, serverName: srv.name, resource })
    }
    for (const prompt of st.prompts ?? []) {
      mcpPrompts.push({ serverId: srv.id, serverName: srv.name, prompt })
    }
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`
  }, [value])

  useEffect(() => {
    if (!disabled) ref.current?.focus()
  }, [disabled])

  useEffect(() => {
    setFiles([])
  }, [workspace])

  useEffect(() => {
    if (!mention || !workspace) return
    let live = true
    void call('workspace.files', workspace).then((list) => {
      if (live) setFiles(list)
    })
    return () => {
      live = false
    }
  }, [mention !== null, workspace])

  useEffect(() => {
    if (!mention && slashQuery === null) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setMention(null)
        setSlashQuery(null)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [mention !== null, slashQuery !== null])

  const mentionQuery = mention?.query.toLowerCase() ?? ''
  const fileMatches =
    mention && workspace
      ? files.filter((f) => f.toLowerCase().includes(mentionQuery)).slice(0, 8)
      : []
  const resourceMatches = mention
    ? mcpResources
        .filter(
          (r) =>
            !mentionQuery ||
            r.resource.name.toLowerCase().includes(mentionQuery) ||
            r.resource.uri.toLowerCase().includes(mentionQuery) ||
            r.serverName.toLowerCase().includes(mentionQuery) ||
            (r.resource.description ?? '').toLowerCase().includes(mentionQuery),
        )
        .slice(0, 6)
    : []
  type MentionEntry =
    | { kind: 'file'; key: string; file: string }
    | { kind: 'resource'; key: string; serverId: string; serverName: string; resource: McpResourceInfo }
  const matches: MentionEntry[] = [
    ...fileMatches.map((file): MentionEntry => ({ kind: 'file', key: `file:${file}`, file })),
    ...resourceMatches.map((r): MentionEntry => ({
      kind: 'resource',
      key: `res:${r.serverId}:${r.resource.uri}`,
      serverId: r.serverId,
      serverName: r.serverName,
      resource: r.resource,
    })),
  ]

  const allowBypass = useStore((s) => s.settings?.allowBypassPermissions !== false)
  const voice = useVoiceDictation((spoken) => insertText(spoken))
  const allSlash = [
    ...(onTogglePlan || onSlashCommand ? [{ id: 'plan', cmd: '/plan', desc: t('mode.slashPlan'), icon: ListChecks }] : []),
    ...(onSelectMode || onSlashCommand ? [{ id: 'auto', cmd: '/auto', desc: t('mode.modes.auto.desc'), icon: Sparkles }] : []),
    ...(onSelectMode || onSlashCommand ? [{ id: 'manual', cmd: '/manual', desc: t('mode.modes.manual.desc'), icon: ShieldCheck }] : []),
    ...(allowBypass && (onSelectMode || onSlashCommand) ? [{ id: 'bypass', cmd: '/bypass', desc: t('mode.modes.bypass.desc'), icon: ShieldAlert }] : []),
    ...(canCompact && onSlashCommand ? [{ id: 'compact', cmd: '/compact', desc: t('chat.slashCompact'), icon: Minimize2 }] : []),
    ...(onSlashCommand ? [{ id: 'browser', cmd: '/browser', desc: t('chat.slashBrowser'), icon: Globe }] : []),
    ...(onSlashCommand ? [{ id: 'remember', cmd: '/remember', desc: t('chat.slashRemember'), icon: Brain }] : []),
    ...(onSlashCommand ? [{ id: 'new', cmd: '/new', desc: t('chat.slashNew'), icon: Plus }] : []),
    ...(hasSessionAllows && onSlashCommand ? [{ id: 'revoke', cmd: '/revoke', desc: t('chat.slashRevoke'), icon: ShieldOff }] : []),
    ...skills
      .filter((s) => s.enabled)
      .map((s) => ({
        id: `skill:${s.name}`,
        cmd: `/${s.name}`,
        desc: s.description,
        badge: t('mode.slashSkill'),
        icon: BookOpen,
      })),
    ...mcpPrompts.map((p) => ({
      id: `mcp-prompt:${p.serverId}::${p.prompt.name}`,
      cmd: `/${p.prompt.name}`,
      desc: p.prompt.description || p.serverName,
      badge: p.serverName,
      icon: Plug,
    })),
  ]
  const slashMatches =
    slashQuery !== null
      ? allSlash
          .filter((item) => item.cmd.slice(1).toLowerCase().includes(slashQuery) || item.desc.toLowerCase().includes(slashQuery))
          .slice(0, 12)
      : []

  const canMention = Boolean(workspace || mcpResources.length > 0)

  const syncMenus = (nextText: string, caret: number | null) => {
    if (caret === null) {
      setMention(null)
      setSlashQuery(null)
      return
    }
    const foundMention = canMention ? findMention(nextText, caret) : null
    const foundSlash = !foundMention ? findSlash(nextText, caret) : null
    setMention(foundMention)
    setSlashQuery(foundSlash)
    setActiveIdx(0)
  }

  const pickFile = (file: string) => {
    if (!mention) return
    const insertion = `\`${file}\` `
    const next = `${value.slice(0, mention.start)}${insertion}${value.slice(mention.end)}`
    const nextCaret = mention.start + insertion.length
    onChangeText(next)
    setMention(null)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const pickResource = async (serverId: string, resource: McpResourceInfo) => {
    if (mention) {
      const next = `${value.slice(0, mention.start)}${value.slice(mention.end)}`.replace(/\s+$/, (m) => (m ? ' ' : ''))
      onChangeText(next)
      setMention(null)
    }
    try {
      const res = await call('mcp.readResource', serverId, resource.uri)
      if (res.images?.length) onAddImages(res.images)
      if (res.text !== undefined) {
        onAddExternalFiles?.([
          {
            id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            name: resource.name || resource.uri,
            path: resource.uri,
            docKind: 'text',
            content: res.text,
          },
        ])
      }
      toast(t('chat.mcpResourceAttached', { name: resource.name || resource.uri }))
      requestAnimationFrame(() => ref.current?.focus())
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const pickMentionEntry = (entry: MentionEntry) => {
    if (entry.kind === 'file') {
      pickFile(entry.file)
    } else {
      void pickResource(entry.serverId, entry.resource)
    }
  }

  const applyMcpPrompt = async (serverId: string, name: string, args?: Record<string, string>) => {
    try {
      const res = await call('mcp.getPrompt', serverId, name, args)
      if (res.images?.length) onAddImages(res.images)
      if (res.text) {
        const replaceLeading = !value.trim() || value.trim().startsWith('/')
        const next = replaceLeading ? res.text : `${value.trimEnd()}\n\n${res.text}`
        onChangeText(next)
        requestAnimationFrame(() => {
          const el = ref.current
          if (!el) return
          el.focus()
          el.setSelectionRange(next.length, next.length)
        })
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const runSlash = (id: string) => {
    setSlashQuery(null)
    if (id.startsWith('mcp-prompt:')) {
      const rest = id.slice('mcp-prompt:'.length)
      const sep = rest.indexOf('::')
      const serverId = sep >= 0 ? rest.slice(0, sep) : ''
      const promptName = sep >= 0 ? rest.slice(sep + 2) : rest
      const found = mcpPrompts.find((p) => p.serverId === serverId && p.prompt.name === promptName)
      if (found) {
        if (found.prompt.arguments?.length) {
          const initValues: Record<string, string> = {}
          for (const a of found.prompt.arguments) initValues[a.name] = ''
          setPendingPrompt({
            serverId: found.serverId,
            serverName: found.serverName,
            prompt: found.prompt,
            values: initValues,
          })
        } else {
          void applyMcpPrompt(found.serverId, found.prompt.name)
        }
      }
      return
    }
    if (id.startsWith('skill:')) {
      const skillName = id.slice(6)
      const ins = `/${skillName} `
      const replaceLeadingSlash = !value.trim() || value.trim().startsWith('/')
      const next = replaceLeadingSlash ? ins : `${value.trimEnd()}\n${ins}`
      onChangeText(next)
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        el.setSelectionRange(next.length, next.length)
      })
      return
    }
    if (value.trim().startsWith('/')) onChangeText('')
    if (id === 'plan' && !onSlashCommand && onTogglePlan) {
      onTogglePlan()
      return
    }
    onSlashCommand?.(id as SlashAction)
  }

  const insertText = (ins: string) => {
    const el = ref.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const sep = start > 0 && !/\s$/.test(value.slice(0, start)) ? '\n' : ''
    const next = `${value.slice(0, start)}${sep}${ins}${value.slice(end)}`
    const nextCaret = start + sep.length + ins.length
    onChangeText(next)
    requestAnimationFrame(() => {
      const target = ref.current
      if (!target) return
      target.focus()
      target.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const openSlashFromPlus = () => {
    setMention(null)
    setActiveIdx(0)
    if (!value.trim()) {
      onChangeText('/')
      setSlashQuery('')
      requestAnimationFrame(() => {
        const el = ref.current
        if (!el) return
        el.focus()
        el.setSelectionRange(1, 1)
      })
      return
    }
    setSlashQuery('')
    requestAnimationFrame(() => ref.current?.focus())
  }

  const ingestPickedFiles = async (picked: PickedFileResult[]) => {
    const imgs: ImageAttachment[] = []
    const relFiles: string[] = []
    const extDocs: AttachedExternalFile[] = []
    for (const item of picked) {
      if (item.kind === 'image') {
        try {
          imgs.push(await normalizeImageDataUrl(item.name, item.mimeType, item.dataUrl, item.byteSize))
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error')
        }
      } else if (item.kind === 'document') {
        if (item.error) {
          toast(item.error, 'error')
        } else {
          extDocs.push({
            id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            name: item.name,
            path: item.relativePath ?? item.path,
            docKind: item.docKind,
            content: item.content,
            truncated: item.truncated,
            byteSize: item.byteSize,
            pageCount: item.pageCount,
            sheetCount: item.sheetCount,
            slideCount: item.slideCount,
            sheetNames: item.sheetNames,
          })
        }
      } else if (item.relativePath) {
        relFiles.push(item.relativePath)
      } else if (item.legacyOffice) {
        toast(t('chat.plusExternalLegacyOffice', { name: item.name }), 'error')
      } else if (item.tooLarge) {
        toast(t('chat.plusExternalTooLarge', { name: item.name }), 'error')
      } else if (item.binary) {
        toast(t('chat.plusExternalBinary', { name: item.name }), 'error')
      } else if (item.content !== undefined) {
        extDocs.push({
          id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          name: item.name,
          path: item.path,
          docKind: 'text',
          content: item.content,
          truncated: item.truncated,
        })
      }
    }
    if (imgs.length) onAddImages(imgs)
    if (relFiles.length) onAddFiles?.(relFiles)
    if (extDocs.length) onAddExternalFiles?.(extDocs)
  }

  const pickFilesAndPhotos = async () => {
    if (disabled) return
    try {
      const picked = await shell.pickFiles(workspace)
      if (picked.length) await ingestPickedFiles(picked)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  useEffect(() => {
    if (disabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        const st = getState()
        if (st.settingsOpen || st.paletteOpen) return
        e.preventDefault()
        void pickFilesAndPhotos()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [disabled, workspace])

  const handleImageFiles = async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList).filter((f) => f.type.startsWith('image/'))
    if (arr.length === 0) return
    const added: ImageAttachment[] = []
    for (const file of arr.slice(0, 6)) {
      try {
        added.push(await fileToImageAttachment(file))
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    if (added.length) onAddImages(added)
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgs = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean) as File[]
    if (imgs.length > 0) {
      e.preventDefault()
      void handleImageFiles(imgs)
    }
  }

  const handleDroppedFiles = async (fileList: FileList | File[]) => {
    const all = Array.from(fileList)
    const nativePaths = all.map((f) => shell.pathForFile(f)).filter(Boolean)
    if (nativePaths.length > 0) {
      try {
        const inspected = await shell.inspectFiles(nativePaths, workspace)
        if (inspected.length > 0) {
          await ingestPickedFiles(inspected)
          return
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    }
    const imgFiles = all.filter((f) => f.type.startsWith('image/'))
    if (imgFiles.length > 0) await handleImageFiles(imgFiles)
    const docs: AttachedExternalFile[] = []
    for (const f of all.filter((item) => !item.type.startsWith('image/')).slice(0, 6)) {
      if (f.size > 120 * 1024) {
        toast(t('chat.plusExternalTooLarge', { name: f.name }), 'error')
        continue
      }
      const txt = await f.text().catch(() => '')
      if (txt.includes('\u0000')) {
        toast(t('chat.plusExternalBinary', { name: f.name }), 'error')
        continue
      }
      docs.push({
        id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: f.name,
        path: f.name,
        docKind: 'text',
        content: txt,
      })
    }
    if (docs.length) onAddExternalFiles?.(docs)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    if (e.dataTransfer?.files?.length) {
      void handleDroppedFiles(e.dataTransfer.files)
    }
  }

  const canSend =
    !disabled && (Boolean(value.trim()) || images.length > 0 || attachedFiles.length > 0 || externalFiles.length > 0)

  const submit = () => {
    if (!canSend) return
    setMention(null)
    setSlashQuery(null)
    const refPrefix = attachedFiles.length
      ? `[Referenced files: ${attachedFiles.map((f) => `\`${f}\``).join(', ')}]\n\n`
      : ''
    const documents: DocumentAttachment[] = externalFiles.map((doc) => ({
      id: doc.id,
      name: doc.name,
      path: doc.path,
      docKind: doc.docKind ?? 'text',
      content: doc.content,
      truncated: doc.truncated,
      byteSize: doc.byteSize,
      pageCount: doc.pageCount,
      sheetCount: doc.sheetCount,
      slideCount: doc.slideCount,
      sheetNames: doc.sheetNames,
    }))
    const body =
      value.trim() ||
      (images.length && !documents.length ? 'Please inspect the attached image(s).' : '')
    onSend(`${refPrefix}${body}`, images, documents)
  }

  const showMention = Boolean(mention && canMention)
  const showSlash = slashQuery !== null && slashMatches.length > 0

  const plusMenu = (
    <ComposerPlusMenu
      workspace={workspace}
      direction={direction}
      disabled={disabled}
      skills={skills}
      onAddFilesAndPhotos={() => void pickFilesAndPhotos()}
      onAddFolder={onAddFolder}
      onOpenSlashCommands={openSlashFromPlus}
      onInsertText={insertText}
    />
  )

  const voiceBtn = (
    <button
      type="button"
      className={`voice-btn${compact ? ' compact' : ''}${voice.recording ? ' recording' : ''}${voice.transcribing ? ' transcribing' : ''}`}
      disabled={disabled || voice.transcribing}
      onClick={voice.toggle}
      aria-label={voice.recording ? t('voice.stop') : t('voice.dictate')}
      title={voice.recording ? `${t('voice.stop')} (${voice.seconds}s)` : t('voice.dictate')}
    >
      {voice.recording ? (
        <>
          <MicOff size={13} />
          <span className="voice-timer">{voice.seconds}s</span>
        </>
      ) : (
        <Mic size={14} />
      )}
    </button>
  )

  const actionBtns = (
    <>
      {busy && canSend && (
        <button
          className="send-btn queue"
          onClick={submit}
          aria-label={t('chat.queueAddBtn')}
          title={t('chat.queueAddBtn')}
        >
          <ListPlus size={16} strokeWidth={2.2} />
        </button>
      )}
      {busy ? (
        <button className="send-btn stop" onClick={onStop} aria-label={t('chat.stop')} title={t('chat.stop')}>
          <Square size={12} fill="currentColor" />
        </button>
      ) : (
        <button className="send-btn" onClick={submit} disabled={!canSend} aria-label={t('chat.send')} title={t('chat.send')}>
          <ArrowUp size={17} strokeWidth={2.4} />
        </button>
      )}
    </>
  )

  const textareaEl = (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder={
        busy
          ? t('chat.queuePlaceholderBusy')
          : agentMode === 'plan'
            ? t('mode.planPlaceholder')
            : compact
              ? t('chat.compactPlaceholder')
              : workScene === 'work'
                ? t('chat.workPlaceholder')
                : t('chat.placeholder')
      }
      disabled={disabled}
      onPaste={handlePaste}
      onChange={(e) => {
        const val = e.target.value
        onChangeText(val)
        syncMenus(val, e.target.selectionStart)
      }}
      onClick={(e) => syncMenus(value, (e.target as HTMLTextAreaElement).selectionStart)}
      onKeyDown={(e) => {
        if (showMention || showSlash) {
          const count = showMention ? matches.length : slashMatches.length
          if (e.key === 'Escape') {
            e.preventDefault()
            setMention(null)
            setSlashQuery(null)
            return
          }
          if (e.key === 'ArrowDown' && count > 0) {
            e.preventDefault()
            setActiveIdx((i) => (i + 1) % count)
            return
          }
          if (e.key === 'ArrowUp' && count > 0) {
            e.preventDefault()
            setActiveIdx((i) => (i - 1 + count) % count)
            return
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && count > 0 && !e.nativeEvent.isComposing) {
            e.preventDefault()
            if (showMention) {
              const chosen = matches[activeIdx]
              if (chosen) pickMentionEntry(chosen)
            } else {
              const chosen = slashMatches[activeIdx]
              if (chosen) runSlash(chosen.id)
            }
            return
          }
        }
        if (e.key === 'Tab' && e.shiftKey && onTogglePlan && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onTogglePlan()
          return
        }
        // IME composition (Chinese input) uses Enter to confirm a candidate.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          submit()
        }
      }}
    />
  )

  const queuedBlock = queued.length > 0 && (
    <div className="queued-stack" aria-label={t('chat.queueTitle', { count: queued.length })}>
      <div className="queued-stack-head">
        <ListPlus size={12} />
        <span>{t('chat.queueTitle', { count: queued.length })}</span>
      </div>
      <div className="queued-stack-list">
        {queued.map((item) => {
          const previewText =
            item.text ||
            [
              item.documents?.length ? item.documents.map((d) => d.name).join(', ') : '',
              item.images?.length ? `${item.images.length} image(s)` : '',
            ]
              .filter(Boolean)
              .join(' · ')
          const badges = [
            item.documents?.length ? `${item.documents.length} doc` : '',
            item.images?.length ? `${item.images.length} img` : '',
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <div key={item.id} className="queued-row">
              <span className="queued-row-text" title={item.text}>
                {previewText}
              </span>
              {badges && <span className="queued-row-meta">{badges}</span>}
              {onSteerQueued && (
                <button
                  type="button"
                  className="icon-btn queued-act steer"
                  onClick={() => onSteerQueued(item.id)}
                  title={t('chat.queueSendNow')}
                  aria-label={t('chat.queueSendNow')}
                >
                  <CornerDownRight size={12} />
                </button>
              )}
              {onEditQueued && (
                <button
                  type="button"
                  className="icon-btn queued-act"
                  onClick={() => onEditQueued(item)}
                  title={t('chat.queueEdit')}
                  aria-label={t('chat.queueEdit')}
                >
                  <Pencil size={11} />
                </button>
              )}
              {onCancelQueued && (
                <button
                  type="button"
                  className="icon-btn queued-act"
                  onClick={() => onCancelQueued(item.id)}
                  title={t('common.remove')}
                  aria-label={t('common.remove')}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )

  const attachmentsBlock = (attachedFiles.length > 0 || externalFiles.length > 0 || images.length > 0) && (
    <div className="composer-attachments">
      {images.map((img) => (
        <div key={img.id} className="img-chip">
          <button type="button" className="img-chip-thumb" onClick={() => setPreviewImg(img)} title={img.name}>
            <img src={img.dataUrl} alt={img.name} />
          </button>
          <button
            type="button"
            className="img-chip-rm"
            onClick={() => onRemoveImage(img.id)}
            aria-label={t('common.remove')}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {attachedFiles.map((file) => {
        const base = file.split('/').pop() ?? file
        return (
          <span key={file} className="context-chip" title={file}>
            <FileCode2 size={12} />
            <span>{base}</span>
            {onRemoveFile && (
              <button
                type="button"
                className="context-chip-rm"
                onClick={() => onRemoveFile(file)}
                aria-label={t('common.remove')}
              >
                <X size={11} />
              </button>
            )}
          </span>
        )
      })}
      {externalFiles.map((doc) => (
        <DocumentChip
          key={doc.id}
          doc={doc}
          onPreview={() =>
            setPreviewDoc({
              id: doc.id,
              name: doc.name,
              path: doc.path,
              docKind: doc.docKind ?? 'text',
              content: doc.content,
              truncated: doc.truncated,
              byteSize: doc.byteSize,
              pageCount: doc.pageCount,
              sheetCount: doc.sheetCount,
              slideCount: doc.slideCount,
              sheetNames: doc.sheetNames,
            })
          }
          onRemove={onRemoveExternalFile ? () => onRemoveExternalFile(doc.id) : undefined}
        />
      ))}
    </div>
  )

  return (
    <div
      ref={wrapRef}
      className={`composer dir-${direction}${compact ? ' compact' : ''}${dragging ? ' dragging' : ''}${agentMode === 'plan' ? ' plan-mode' : ''}${agentMode === 'bypass' ? ' bypass-mode' : ''}`}
      onDragOver={(e) => {
        if (disabled) return
        if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
      }}
      onDrop={handleDrop}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement
        if (
          e.target === e.currentTarget ||
          target.classList.contains('composer-bar') ||
          target.classList.contains('composer-pill') ||
          target.classList.contains('composer-compact-row')
        ) {
          e.preventDefault()
          ref.current?.focus()
        }
      }}
    >
      {dragging && <div className="composer-drop-hint">{t('chat.dropImages')}</div>}

      {showMention && (
        <div className="mention-popover" role="listbox" aria-label={t('chat.mentionFile')}>
          <div className="mention-head">{t('chat.mentionFile')}</div>
          {matches.length === 0 ? (
            <div className="mention-empty">{t('chat.mentionEmpty')}</div>
          ) : (
            <div className="mention-list">
              {matches.map((entry, idx) => (
                <button
                  key={entry.key}
                  type="button"
                  role="option"
                  aria-selected={idx === activeIdx}
                  style={{ '--opt-i': Math.min(idx, 10) } as React.CSSProperties}
                  className={`mention-item${idx === activeIdx ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickMentionEntry(entry)
                  }}
                >
                  {entry.kind === 'file' ? (
                    <>
                      <FileCode2 size={14} />
                      <span>{entry.file}</span>
                    </>
                  ) : (
                    <>
                      <Plug size={14} />
                      <span>{entry.resource.name || entry.resource.uri}</span>
                      <span className="slash-badge">{entry.serverName}</span>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {showSlash && (
        <div className="mention-popover" role="listbox" aria-label={t('chat.slashCommands')}>
          <div className="mention-head">{t('chat.slashCommands')}</div>
          <div className="mention-list">
            {slashMatches.map((item, idx) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={idx === activeIdx}
                  style={{ '--opt-i': Math.min(idx, 10) } as React.CSSProperties}
                  className={`mention-item slash-item${idx === activeIdx ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    runSlash(item.id)
                  }}
                >
                  <Icon size={14} />
                  <strong>{item.cmd}</strong>
                  {'badge' in item && item.badge && <span className="slash-badge">{item.badge}</span>}
                  <span className="slash-desc">{item.desc}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {compact ? (
        <>
          <div className="composer-pill">
            {queuedBlock}
            {attachmentsBlock}
            <div className="composer-compact-row">
              {plusMenu}
              {textareaEl}
              <div className="composer-compact-actions">
                {voiceBtn}
                {actionBtns}
              </div>
            </div>
          </div>
          <div className="composer-compact-foot">
            <div className="composer-compact-controls">
              {trailing}
              {onSelectMode && (
                <PermissionPicker mode={agentMode} direction={direction} disabled={disabled} onSelect={onSelectMode} />
              )}
              {contextInfo && <ContextWindowPicker context={contextInfo} direction={direction} onCompact={onCompact} />}
            </div>
          </div>
        </>
      ) : (
        <>
          {queuedBlock}
          {attachmentsBlock}
          {textareaEl}
          <div className="composer-bar">
            <div className="composer-side">
              {plusMenu}
              {leading}
            </div>
            <div className="composer-side">
              {trailing}
              {onSelectMode && (
                <PermissionPicker mode={agentMode} direction={direction} disabled={disabled} onSelect={onSelectMode} />
              )}
              {voiceBtn}
              {actionBtns}
            </div>
          </div>
        </>
      )}

      {previewImg && (
        <Dialog title={previewImg.name} onClose={() => setPreviewImg(null)} wide>
          <div className="img-lightbox">
            <img src={previewImg.dataUrl} alt={previewImg.name} />
          </div>
        </Dialog>
      )}

      <DocumentPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />

      {pendingPrompt && (
        <Dialog
          title={t('chat.mcpPromptArgsTitle', { name: pendingPrompt.prompt.name })}
          onClose={() => setPendingPrompt(null)}
        >
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault()
              const target = pendingPrompt
              setPendingPrompt(null)
              const cleanArgs: Record<string, string> = {}
              for (const [k, v] of Object.entries(target.values)) {
                if (v.trim()) cleanArgs[k] = v.trim()
              }
              void applyMcpPrompt(target.serverId, target.prompt.name, cleanArgs)
            }}
          >
            {pendingPrompt.prompt.description && <p className="muted small">{pendingPrompt.prompt.description}</p>}
            {(pendingPrompt.prompt.arguments ?? []).map((arg, i) => (
              <label key={arg.name} className="field">
                <span>
                  {arg.name}
                  {arg.required ? ` * (${t('chat.mcpPromptRequired')})` : ''}
                </span>
                <input
                  autoFocus={i === 0}
                  required={Boolean(arg.required)}
                  value={pendingPrompt.values[arg.name] ?? ''}
                  placeholder={arg.description || arg.name}
                  onChange={(e) =>
                    setPendingPrompt((cur) =>
                      cur ? { ...cur, values: { ...cur.values, [arg.name]: e.target.value } } : null,
                    )
                  }
                />
              </label>
            ))}
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setPendingPrompt(null)}>
                {t('common.cancel')}
              </button>
              <button type="submit" className="btn btn-primary">
                {t('chat.mcpPromptRun')}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  )
}
