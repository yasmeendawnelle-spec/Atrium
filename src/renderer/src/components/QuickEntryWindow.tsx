// Floating Quick Entry bar opened via global hotkey (Alt+Space).
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from 'react'
import { ArrowUp, Camera, ExternalLink, Mic, MicOff, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ImageAttachment } from '@shared/types.ts'
import { applyLocale } from '../i18n.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { fileToImageAttachment } from '../lib/images.ts'
import { handleCoreEvent, liveFor, loadAll, setState, toast, useChatStream, useStore } from '../lib/store.ts'
import { useVoiceDictation } from '../lib/useVoiceDictation.ts'
import { Oculus } from './Oculus.tsx'
import { folderName } from './WorkspacePicker.tsx'

export function QuickEntryWindow() {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)
  const account = useStore((s) => s.account)
  const providers = useStore((s) => s.providers)
  const toastState = useStore((s) => s.toast)
  const [text, setText] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const lastHeightRef = useRef(0)

  const conv = useStore((s) => (chatId ? s.conversations[chatId] : undefined))
  const live = useStore((s) => liveFor(s, chatId))
  const stream = useChatStream(chatId)

  const voice = useVoiceDictation((spoken) => {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${spoken}` : spoken))
    requestAnimationFrame(() => inputRef.current?.focus())
  })

  useEffect(() => {
    const off = window.atrium.onEvent((event) => {
      handleCoreEvent(event)
      if (event.channel === 'app' && event.payload.action === 'focus_quick_input') {
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    })
    void loadAll().catch(() => undefined)
    return off
  }, [])

  useEffect(() => {
    const theme = settings?.theme
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || ((theme ?? 'system') === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [settings?.theme])

  useEffect(() => {
    if (settings) applyLocale(settings.locale)
  }, [settings?.locale])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void shell.quickHide()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const lastReply = (() => {
    const msgs = conv?.messages ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role === 'assistant' && m.text.trim()) return m.text
    }
    return ''
  })()

  const answerText = stream.text || lastReply

  useLayoutEffect(() => {
    const inputEl = inputRef.current
    if (!inputEl) return
    inputEl.style.height = 'auto'
    inputEl.style.height = `${Math.min(Math.max(inputEl.scrollHeight, 24), 132)}px`
  }, [text, account.connected])

  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const syncHeight = () => {
      const h = Math.ceil(Math.max(el.getBoundingClientRect().height, el.scrollHeight))
      if (h > 0 && h !== lastHeightRef.current) {
        lastHeightRef.current = h
        void shell.quickResize(h).catch(() => undefined)
      }
    }
    syncHeight()
    const observer = new ResizeObserver(syncHeight)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, images.length, answerText, live.busy, live.error, account.connected])

  const captureScreen = async () => {
    try {
      const img = await shell.captureScreen()
      if (img) {
        setImages((prev) => [...prev, img].slice(0, 4))
        requestAnimationFrame(() => inputRef.current?.focus())
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const handlePaste = async (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imgFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => Boolean(f))
    if (imgFiles.length === 0) return
    e.preventDefault()
    const added: ImageAttachment[] = []
    for (const file of imgFiles.slice(0, 4)) {
      try {
        added.push(await fileToImageAttachment(file))
      } catch (err) {
        toast(errorMessage(err), 'error')
      }
    }
    if (added.length) {
      setImages((prev) => [...prev, ...added].slice(0, 4))
    }
  }

  const send = async () => {
    if (!account.connected) return
    const clean = text.trim()
    if ((!clean && images.length === 0) || live.busy) return
    let createdId: string | null = null
    const prevText = text
    const prevImages = [...images]
    try {
      let targetId = chatId
      if (!targetId) {
        const created = await call('chats.create', settings?.workspace)
        createdId = created.id
        setState((s) => ({ conversations: { ...s.conversations, [created.id]: created } }))
        targetId = created.id
        setChatId(targetId)
      }
      const imgsToSend = [...images]
      setText('')
      setImages([])
      await call('agent.send', targetId, clean || 'Please inspect this screenshot.', imgsToSend)
    } catch (err) {
      if (createdId) {
        await call('chats.remove', createdId).catch(() => undefined)
        setChatId(null)
        setText(prevText)
        setImages(prevImages)
      }
      toast(errorMessage(err), 'error')
    }
  }

  const toggleScene = async () => {
    const cur = settings?.workScene === 'work' ? 'work' : 'code'
    const next = cur === 'work' ? 'code' : 'work'
    const updated = await call('settings.update', { workScene: next }).catch(() => null)
    if (updated) setState({ settings: updated })
  }

  const activeProvider = providers.find((p) => p.id === settings?.activeProviderId) ?? providers[0]
  const wsName = folderName(settings?.workspace)
  const voiceActive = voice.recording || voice.transcribing

  return (
    <div className="quick-shell" ref={cardRef}>
      <div className="quick-main-row">
        <div className="quick-brand-mark drag" title={t('quick.title')}>
          <Oculus state={live.busy ? 'thinking' : 'idle'} size={18} />
        </div>
        {!account.connected ? (
          <>
            <p className="warn small quick-auth-notice">请先在 Atrium 主窗口登录官方账号后再使用（BYOK 模型同样需先登录）。</p>
            <button
              type="button"
              className="icon-btn quick-close-btn no-drag"
              onClick={() => void shell.quickHide()}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <textarea
            ref={inputRef}
            className="quick-input"
            rows={1}
            autoFocus
            value={text}
            placeholder={t('quick.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => void handlePaste(e)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
        )}
      </div>

      {images.length > 0 && (
        <div className="quick-images">
          {images.map((img) => (
            <div key={img.id} className="img-chip">
              <div className="img-chip-thumb">
                <img src={img.dataUrl} alt={img.name} />
              </div>
              <button
                type="button"
                className="img-chip-rm"
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                aria-label={t('common.remove')}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {(answerText || live.error) && (
        <div className="quick-reply">
          {live.error ? <p className="warn small">{live.error}</p> : <pre>{answerText}</pre>}
        </div>
      )}

      <div className="quick-bar drag">
        <div className="quick-bar-left">
          <button
            type="button"
            className="quick-tool-btn no-drag"
            disabled={!account.connected}
            onClick={() => void captureScreen()}
            title={t('quick.captureScreen')}
            aria-label={t('quick.captureScreen')}
          >
            <Camera size={14} />
          </button>
          <button
            type="button"
            className={`quick-tool-btn no-drag${voiceActive ? ' voice-active has-label' : ''}`}
            disabled={!account.connected || voice.transcribing}
            onClick={voice.toggle}
            title={t('voice.dictate')}
            aria-label={t('voice.dictate')}
          >
            {voice.recording ? <MicOff size={14} /> : <Mic size={14} />}
            {voice.recording && <span>{voice.seconds}s</span>}
            {!voice.recording && voice.transcribing && <span>{t('voice.transcribing')}</span>}
          </button>
          <button
            type="button"
            className="quick-meta-pill no-drag"
            onClick={() => void toggleScene()}
            title={t('nav.workSceneHint')}
          >
            <span>{settings?.workScene === 'work' ? 'Work' : 'Code'}</span>
            {wsName && <span className="quick-meta-ws">· {wsName}</span>}
          </button>
        </div>
        <div className="quick-bar-right no-drag">
          {activeProvider && (
            <span className="quick-model-tag mono" title={activeProvider.model}>
              {activeProvider.model}
            </span>
          )}
          {chatId && (
            <button
              type="button"
              className="quick-open-btn"
              onClick={() => void shell.quickOpenChat(chatId)}
              title={t('quick.openInAtrium')}
            >
              <ExternalLink size={12} />
              <span>{t('quick.openInAtrium')}</span>
            </button>
          )}
          {live.busy ? (
            <button
              type="button"
              className="send-btn stop quick-send-btn"
              onClick={() => chatId && void call('agent.stop', chatId)}
              aria-label={t('chat.stop')}
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn quick-send-btn"
              disabled={!account.connected || (!text.trim() && images.length === 0)}
              onClick={() => void send()}
              aria-label={t('chat.send')}
            >
              <ArrowUp size={14} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>

      {toastState && (
        <div key={toastState.id} className={`toast toast-${toastState.tone}`}>
          {toastState.text}
        </div>
      )}
    </div>
  )
}
