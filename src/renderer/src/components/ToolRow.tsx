import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { BookOpen, Bot, Check, ChevronRight, Copy, ExternalLink, FileText, Globe, Monitor, MousePointer2, Terminal, Wrench } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ImageAttachment, ToolCall, ToolRunStatus } from '@shared/types.ts'
import { requestOpenBrowserDrawer, useStore } from '../lib/store.ts'

const ANSI_FG_COLORS: Record<number, string> = {
  30: '#6e7681',
  31: '#f85149',
  32: '#3fb950',
  33: '#d29922',
  34: '#58a6ff',
  35: '#bc8cff',
  36: '#39c5cf',
  37: '#e6edf3',
  90: '#8b949e',
  91: '#ff7b72',
  92: '#56d364',
  93: '#e3b341',
  94: '#79c0ff',
  95: '#d2a8ff',
  96: '#56d4dd',
  97: '#ffffff',
}

/** Converts ANSI SGR escape sequences cleanly into styled spans without leaking escape codes. */
export function renderAnsiText(raw: string): ReactNode {
  if (!raw.includes('\x1b')) return raw
  const cleaned = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  const re = /\x1b\[([0-9;]*)m/g
  const out: ReactNode[] = []
  let last = 0
  let fg: string | undefined
  let bold = false
  let dim = false
  let key = 0

  const pushSlice = (text: string) => {
    if (!text) return
    if (!fg && !bold && !dim) {
      out.push(text)
      return
    }
    const style: CSSProperties = {
      ...(fg ? { color: fg } : {}),
      ...(bold ? { fontWeight: 600 } : {}),
      ...(dim ? { opacity: 0.65 } : {}),
    }
    out.push(
      <span key={key++} style={style}>
        {text}
      </span>,
    )
  }

  let match: RegExpExecArray | null
  while ((match = re.exec(cleaned)) !== null) {
    pushSlice(cleaned.slice(last, match.index))
    last = re.lastIndex
    const codes = (match[1] || '0').split(';').map((c) => Number(c || '0'))
    for (const c of codes) {
      if (c === 0) {
        fg = undefined
        bold = false
        dim = false
      } else if (c === 1) bold = true
      else if (c === 2) dim = true
      else if (c === 22) {
        bold = false
        dim = false
      } else if (c === 39) fg = undefined
      else if (ANSI_FG_COLORS[c]) fg = ANSI_FG_COLORS[c]
    }
  }
  pushSlice(cleaned.slice(last))
  return out.length > 0 ? out : cleaned.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

function stripAnsi(raw: string): string {
  return raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

const FILE_TOOLS = new Set(['list_dir', 'read_file', 'search', 'edit_file', 'write_file', 'apply_patch'])
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])
const BROWSER_TOOLS = new Set([
  'browser_open',
  'browser_click',
  'browser_mouse',
  'browser_type',
  'browser_key',
  'browser_scroll',
  'browser_screenshot',
  'browser_eval',
])

/** Splits `mcp__<serverId>__<tool>` into its parts. */
export function splitToolName(name: string): { serverId?: string; tool: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? { serverId: m[1], tool: m[2]! } : { tool: name }
}

function summaryOf(call: ToolCall): string {
  const input = call.input ?? {}
  if (call.name === 'run_command') return String(input.command ?? '')
  if (call.name === 'web_fetch' || call.name === 'browser_open') return String(input.url ?? '')
  if (call.name === 'browser_click') {
    if (input.ref || input.selector) return String(input.ref ?? input.selector ?? '')
    return `(${Math.round(Number(input.x ?? 0))}, ${Math.round(Number(input.y ?? 0))})`
  }
  if (call.name === 'browser_mouse') {
    const act = String(input.action ?? 'move')
    if (input.ref || input.selector) return `${act} · ${String(input.ref ?? input.selector ?? '')}`
    return `${act} (${Math.round(Number(input.x ?? 0))}, ${Math.round(Number(input.y ?? 0))})`
  }
  if (call.name === 'browser_type') return String(input.text ?? '').slice(0, 60)
  if (call.name === 'browser_key') return String(input.key ?? '')
  if (call.name === 'browser_scroll') return `${Number(input.deltaY ?? 480)}px`
  if (call.name === 'desktop_screenshot') return `display #${Number(input.displayIndex ?? 0)}`
  if (call.name === 'desktop_mouse') {
    const act = String(input.action ?? 'click')
    const x = Math.round(Number(input.x ?? 0))
    const y = Math.round(Number(input.y ?? 0))
    return act === 'drag'
      ? `drag (${x},${y}) -> (${Math.round(Number(input.endX ?? 0))},${Math.round(Number(input.endY ?? 0))})`
      : `${act} (${x}, ${y})`
  }
  if (call.name === 'desktop_keyboard') {
    if (input.action === 'hotkey' && Array.isArray(input.keys)) return input.keys.map(String).join(' + ')
    if (input.action === 'key') return String(input.key ?? '')
    return String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  }
  if (call.name === 'desktop_window') {
    const target = String(input.title ?? input.processName ?? input.handle ?? '').trim()
    return target ? `${String(input.action ?? 'list')} · ${target}` : String(input.action ?? 'list')
  }
  if (call.name === 'desktop_wait') return `${Number(input.seconds ?? 1.5)}s`
  if (call.name === 'load_skill') {
    const n = String(input.name ?? '')
    const f = typeof input.file === 'string' && input.file ? ` · ${input.file}` : ''
    return `${n}${f}`
  }
  if (call.name === 'run_subagent') {
    const role = input.role === 'worker' ? 'worker' : 'explorer'
    const task = typeof input.task === 'string' ? input.task.replace(/\s+/g, ' ').trim() : ''
    return task ? `[${role}] ${task.slice(0, 76)}` : role
  }
  if (call.name === 'apply_patch') {
    const text = typeof input.patch === 'string' ? input.patch : ''
    const files = [...text.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File:|\+\+\+ b\/)(.+)$/gm)].map((m) => m[1]!.trim())
    return files.slice(0, 2).join(', ') + (files.length > 2 ? ` +${files.length - 2}` : '')
  }
  if (typeof input.path === 'string') return input.path
  if (typeof input.query === 'string') return input.query
  const first = Object.values(input).find((v) => typeof v === 'string')
  return typeof first === 'string' ? first.slice(0, 80) : ''
}

export function ToolRow({
  call,
  status,
  output,
  images,
  onPreviewImage,
  defaultOpen,
}: {
  call: ToolCall
  status: ToolRunStatus
  output?: string
  images?: ImageAttachment[]
  onPreviewImage?: (image: ImageAttachment) => void
  defaultOpen?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(Boolean(defaultOpen))
  useEffect(() => {
    if (defaultOpen !== undefined) setOpen(defaultOpen)
  }, [defaultOpen])
  const [copiedOut, setCopiedOut] = useState(false)
  const { serverId, tool } = splitToolName(call.name)
  const serverName = useStore((s) => (serverId ? s.servers.find((c) => c.id === serverId)?.name : undefined))
  const Icon =
    call.name === 'run_command'
      ? Terminal
      : call.name === 'load_skill'
        ? BookOpen
        : call.name === 'run_subagent'
          ? Bot
          : call.name.startsWith('desktop_')
            ? Monitor
            : WEB_TOOLS.has(call.name) || BROWSER_TOOLS.has(call.name)
              ? Globe
              : FILE_TOOLS.has(call.name)
                ? FileText
                : Wrench
  const summary = summaryOf(call)
  // File bodies read better as text than as one escaped JSON string.
  const { content, ...rest } = call.input ?? {}
  const body = typeof content === 'string' ? content : undefined

  const copyOutput = () => {
    if (output === undefined) return
    void navigator.clipboard.writeText(output).then(() => {
      setCopiedOut(true)
      setTimeout(() => setCopiedOut(false), 1800)
    })
  }

  const isBrowserTool = BROWSER_TOOLS.has(call.name)
  const previewShot = isBrowserTool && images?.length ? images[0] : undefined

  return (
    <div className={`tool-row tool-${status}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className={`chev${open ? ' open' : ''}`} />
        <Icon size={14} />
        <span className="tool-name">{tool}</span>
        {serverName && <span className="tool-server">{serverName}</span>}
        {summary && <code className="tool-summary">{summary}</code>}
        {status === 'done' ? (
          <span className="tool-check" role="img" aria-label={t('chat.status.done')}>
            <Check size={14} />
          </span>
        ) : (
          <span className={`chip chip-${status}`}>{t(`chat.status.${status}`)}</span>
        )}
      </button>
      {(call.name === 'run_subagent' || call.name === 'run_command') && status === 'running' && output && !open && (
        <div className="tool-sub-live">{stripAnsi(output).split(/\r?\n/).filter(Boolean).slice(-1)[0]}</div>
      )}
      {previewShot && (
        <div className="tool-browser-card">
          <div className="tool-browser-bar">
            <span className="tool-browser-badge">
              <MousePointer2 size={11} />
              <span>{t('browser.inlineComputerCard')}</span>
            </span>
            <button
              type="button"
              className="tool-browser-open-btn"
              onClick={() => requestOpenBrowserDrawer()}
              title={t('browser.openInPanel')}
            >
              <span>{t('browser.openInPanel')}</span>
              <ExternalLink size={11} />
            </button>
          </div>
          <button
            type="button"
            className="tool-browser-thumb"
            onClick={() => onPreviewImage?.(previewShot)}
            title={previewShot.name}
          >
            <img src={previewShot.dataUrl} alt={previewShot.name} />
          </button>
        </div>
      )}
      <div className={`tool-expand${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="tool-expand-inner">
          <div className="tool-body">
            <div className="tool-label">{t('chat.input')}</div>
            <pre>{JSON.stringify(body === undefined ? call.input : rest, null, 2)}</pre>
            {body !== undefined && <pre className="tool-content">{body}</pre>}
            {output !== undefined && (
              <>
                <div className="tool-label-row">
                  <span className="tool-label">{t('chat.output')}</span>
                  <button type="button" className="copy-mini" onClick={copyOutput}>
                    {copiedOut ? <Check size={11} /> : <Copy size={11} />}
                    <span>{copiedOut ? t('common.copied') : t('common.copy')}</span>
                  </button>
                </div>
                <pre>{renderAnsiText(output)}</pre>
              </>
            )}
            {Boolean(images?.length) && (
              <div className="tool-shots">
                {images!.map((img) => (
                  <button
                    key={img.id}
                    type="button"
                    className="tool-shot-btn"
                    onClick={() => onPreviewImage?.(img)}
                    title={img.name}
                  >
                    <img src={img.dataUrl} alt={img.name} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
