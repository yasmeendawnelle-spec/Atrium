// Embedded Antigravity-style Chromium browser panel docked inside Studio via Electron WebContentsView.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Camera,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  MousePointer2,
  Plus,
  RotateCw,
  Terminal,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { defaultBrowserModeForLocale, getBrowserProfile, normalizeBrowserUrl } from '@shared/browserUrl.ts'
import type { BrowserElementRef, BrowserMode, BrowserViewLayout, ImageAttachment } from '@shared/types.ts'
import { resolveLocale } from '../i18n.ts'
import { call, errorMessage, shell } from '../lib/api.ts'
import { browserSnapshotFor, setBrowserSnapshot, setState, toast, useStore } from '../lib/store.ts'

const OVERLAY_SELECTOR =
  '[role="dialog"], .ctx-menu, .mention-popover, .open > .model-popover, .open > .tools-popover, .open > .workspace-popover, .open > .perm-popover, .open > .context-popover, .open > .plus-popover'

function isViewportOccluded(): boolean {
  if (typeof document === 'undefined') return false
  return Boolean(document.querySelector(OVERLAY_SELECTOR))
}

function toSafeHttpUrl(raw: string): string | null {
  try {
    return normalizeBrowserUrl(raw)
  } catch {
    return null
  }
}

export function BrowserPreviewPanel({
  active = true,
  conversationId,
  onAttachScreenshot,
}: {
  active?: boolean
  conversationId?: string | null
  onAttachScreenshot?: (image: ImageAttachment) => void
}) {
  const { t } = useTranslation()
  const settings = useStore((s) => s.settings)
  const storeActiveChatId = useStore((s) => s.activeChatId)
  const effectiveCid = (conversationId ?? storeActiveChatId) || undefined
  const snapshot = useStore((s) => browserSnapshotFor(s, effectiveCid))
  const settingsOpen = useStore((s) => s.settingsOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const autoMode = defaultBrowserModeForLocale(resolveLocale(settings?.locale ?? 'system'))
  const browserMode: BrowserMode = snapshot?.mode ?? settings?.browserMode ?? autoMode
  const modeProfile = getBrowserProfile(browserMode)
  const [urlInput, setUrlInput] = useState(snapshot?.url || modeProfile.homeUrl)
  const [busy, setBusy] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [refsOpen, setRefsOpen] = useState(true)
  const [domOccluded, setDomOccluded] = useState(isViewportOccluded)
  const [activeInputRef, setActiveInputRef] = useState<BrowserElementRef | null>(null)
  const [typeDraft, setTypeDraft] = useState('')
  const stageRef = useRef<HTMLDivElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const latestLayoutRef = useRef<BrowserViewLayout | null>(null)
  const rafSyncRef = useRef<number | null>(null)
  const userClosedRef = useRef(false)
  const autoLaunchStartedRef = useRef(false)
  const wheelCooldownRef = useRef(0)
  const reqSeqRef = useRef(0)

  const occluded = settingsOpen || paletteOpen || domOccluded

  useEffect(() => {
    autoLaunchStartedRef.current = false
    userClosedRef.current = false
    setActiveInputRef(null)
    if (!snapshot) {
      setUrlInput(modeProfile.homeUrl)
    } else if (snapshot.url) {
      setUrlInput(snapshot.url)
    }
  }, [effectiveCid])

  useEffect(() => {
    if (!snapshot && active) {
      void call('browser.state', effectiveCid)
        .then((st) => {
          if (st) setBrowserSnapshot(st, effectiveCid)
        })
        .catch(() => undefined)
    }
  }, [active, effectiveCid, snapshot])

  const openUrl = useCallback(async (target: string) => {
    const clean = target.trim()
    if (!clean) return
    const seq = ++reqSeqRef.current
    userClosedRef.current = false
    setBusy(true)
    setActiveInputRef(null)
    try {
      const next = await call('browser.open', clean, effectiveCid)
      if (seq === reqSeqRef.current) setBrowserSnapshot(next, effectiveCid)
    } catch (err) {
      if (seq === reqSeqRef.current) toast(errorMessage(err), 'error')
    } finally {
      if (seq === reqSeqRef.current) setBusy(false)
    }
  }, [effectiveCid])

  const switchBrowserMode = useCallback(
    async (nextMode: BrowserMode) => {
      if (nextMode === browserMode && snapshot?.open && !snapshot?.error) return
      autoLaunchStartedRef.current = true
      userClosedRef.current = false
      const seq = ++reqSeqRef.current
      setBusy(true)
      setActiveInputRef(null)
      try {
        const updatedSettings = await call('settings.update', { browserMode: nextMode })
        setState({ settings: updatedSettings })
        const next = await call('browser.action', { kind: 'setMode', mode: nextMode, conversationId: effectiveCid }, effectiveCid)
        if (seq === reqSeqRef.current) {
          setBrowserSnapshot(next, effectiveCid)
          if (next.url) setUrlInput(next.url)
        }
      } catch (err) {
        if (seq === reqSeqRef.current) toast(errorMessage(err), 'error')
      } finally {
        if (seq === reqSeqRef.current) setBusy(false)
      }
    },
    [browserMode, effectiveCid, snapshot?.open, snapshot?.error],
  )

  // Immediately open the active mode's home page inside the embedded pane when switching to Browser tab.
  useEffect(() => {
    if (
      active &&
      snapshot &&
      !snapshot.open &&
      !userClosedRef.current &&
      !autoLaunchStartedRef.current
    ) {
      autoLaunchStartedRef.current = true
      const targetHome = getBrowserProfile(snapshot.mode ?? settings?.browserMode ?? autoMode).homeUrl
      setUrlInput(targetHome)
      void openUrl(targetHome)
    }
  }, [active, snapshot, settings?.browserMode, autoMode, openUrl])

  useEffect(() => {
    if (snapshot?.url && document.activeElement !== urlInputRef.current) {
      setUrlInput(snapshot.url)
    }
  }, [snapshot?.url])

  useEffect(() => {
    const check = () => setDomOccluded(isViewportOccluded())
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'open'],
      childList: true,
      subtree: true,
    })
    return () => obs.disconnect()
  }, [])

  const pushStageLayout = useCallback(() => {
    const stageVisible = Boolean(
      active &&
        !occluded &&
        !snapshot?.popoutOpen &&
        !snapshot?.error &&
        stageRef.current,
    )
    if (!stageVisible || !stageRef.current) {
      latestLayoutRef.current = null
      if (rafSyncRef.current !== null) {
        cancelAnimationFrame(rafSyncRef.current)
        rafSyncRef.current = null
      }
      void shell.syncBrowserView({ conversationId: effectiveCid, visible: false, x: 0, y: 0, width: 0, height: 0 })
      return
    }
    const rect = stageRef.current.getBoundingClientRect()
    if (rect.width < 120 || rect.height < 80) {
      latestLayoutRef.current = null
      if (rafSyncRef.current !== null) {
        cancelAnimationFrame(rafSyncRef.current)
        rafSyncRef.current = null
      }
      void shell.syncBrowserView({ conversationId: effectiveCid, visible: false, x: 0, y: 0, width: 0, height: 0 })
      return
    }
    latestLayoutRef.current = {
      conversationId: effectiveCid,
      visible: true,
      x: Math.round(rect.left) + 3,
      y: Math.round(rect.top),
      width: Math.max(40, Math.round(rect.width) - 3),
      height: Math.round(rect.height),
    }
    if (rafSyncRef.current === null) {
      rafSyncRef.current = requestAnimationFrame(() => {
        rafSyncRef.current = null
        if (latestLayoutRef.current) {
          void shell.syncBrowserView(latestLayoutRef.current)
        }
      })
    }
  }, [active, effectiveCid, occluded, snapshot?.popoutOpen, snapshot?.error])

  useLayoutEffect(() => {
    pushStageLayout()
    const el = stageRef.current
    const ro = el ? new ResizeObserver(pushStageLayout) : null
    if (el && ro) ro.observe(el)
    window.addEventListener('resize', pushStageLayout)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', pushStageLayout)
      if (rafSyncRef.current !== null) {
        cancelAnimationFrame(rafSyncRef.current)
        rafSyncRef.current = null
      }
    }
  }, [pushStageLayout, logsOpen, refsOpen, activeInputRef, snapshot?.tabs?.length, snapshot?.elements.length])

  useEffect(() => {
    return () => {
      void shell.syncBrowserView(null)
    }
  }, [])

  const runAction = async (
    action: Parameters<typeof call<'browser.action'>>[1],
  ) => {
    if (action.kind === 'close') userClosedRef.current = true
    const seq = ++reqSeqRef.current
    setBusy(true)
    try {
      const payload = effectiveCid ? { ...action, conversationId: effectiveCid } : action
      const next = await call('browser.action', payload, effectiveCid)
      if (seq === reqSeqRef.current) setBrowserSnapshot(next, effectiveCid)
    } catch (err) {
      if (seq === reqSeqRef.current) toast(errorMessage(err), 'error')
    } finally {
      if (seq === reqSeqRef.current) setBusy(false)
    }
  }

  const handleStageClick = (e: MouseEvent<HTMLImageElement>) => {
    if (busy) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const xRatio = (e.clientX - rect.left) / rect.width
    const yRatio = (e.clientY - rect.top) / rect.height
    void runAction({ kind: 'clickPoint', xRatio, yRatio })
  }

  const handleStageWheel = (e: WheelEvent<HTMLImageElement>) => {
    if (busy || Math.abs(e.deltaY) < 8) return
    const now = Date.now()
    if (now - wheelCooldownRef.current < 220) return
    wheelCooldownRef.current = now
    void runAction({ kind: 'scroll', deltaY: Math.round(e.deltaY * 1.4) })
  }

  const consoleErrorCount = snapshot?.consoleLogs.filter((l) => l.level === 'error').length ?? 0
  const consoleWarnCount = snapshot?.consoleLogs.filter((l) => l.level === 'warn').length ?? 0
  const consoleBadgeCount = consoleErrorCount || snapshot?.consoleLogs.length || 0
  const safeExternalUrl = toSafeHttpUrl(snapshot?.url || urlInput)
  const displayTabs =
    snapshot?.tabs && snapshot.tabs.length > 0
      ? snapshot.tabs
      : [
          {
            id: 'default',
            title: snapshot?.title || modeProfile.homeTitle,
            url: snapshot?.url || urlInput,
            active: true,
          },
        ]

  const captureShot = async () => {
    setBusy(true)
    try {
      const next = await call('browser.capture', effectiveCid)
      setBrowserSnapshot(next, effectiveCid)
      if (next.screenshotDataUrl && onAttachScreenshot) {
        onAttachScreenshot({
          id: `img_${Date.now().toString(36)}`,
          name: `${next.title || 'browser'}.jpg`,
          mimeType: 'image/jpeg',
          dataUrl: next.screenshotDataUrl,
        })
        toast(t('browser.attachedToChat'))
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="browser-panel">
      <div className="browser-tabs-strip">
        <div className="browser-tabs-scroll">
          {displayTabs.map((tab) => (
            <div key={tab.id} className={`browser-tab-pill${tab.active ? ' active' : ''}`}>
              <button
                type="button"
                className="browser-tab-switch"
                disabled={busy || tab.id === 'default'}
                onClick={() => void runAction({ kind: 'switchTab', tabId: tab.id })}
                title={tab.url || tab.title}
              >
                <Globe size={12} className="browser-tab-ico" />
                <span>{tab.title || modeProfile.homeTitle}</span>
              </button>
              {displayTabs.length > 1 && (
                <button
                  type="button"
                  className="browser-tab-x"
                  disabled={busy}
                  onClick={() => void runAction({ kind: 'closeTab', tabId: tab.id })}
                  aria-label={t('browser.closeTab')}
                  title={t('browser.closeTab')}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn browser-newtab-btn"
          disabled={busy}
          onClick={() => void runAction({ kind: 'newTab', text: modeProfile.homeUrl })}
          aria-label={t('browser.newTab')}
          title={t('browser.newTab')}
        >
          <Plus size={13} />
        </button>
        <div className="browser-mode-switch" role="radiogroup" aria-label={t('browser.modeLabel')}>
          {(['edge', 'google'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={browserMode === m}
              className={`browser-mode-btn${browserMode === m ? ' active' : ''}`}
              onClick={() => void switchBrowserMode(m)}
              title={t(m === 'edge' ? 'browser.modeEdgeHint' : 'browser.modeGoogleHint')}
            >
              <span className={`browser-mode-dot ${m}`} aria-hidden="true" />
              <span>{t(m === 'edge' ? 'browser.modeEdge' : 'browser.modeGoogle')}</span>
            </button>
          ))}
        </div>
      </div>

      <form
        className="browser-toolbar"
        onSubmit={(e) => {
          e.preventDefault()
          void openUrl(urlInput)
        }}
      >
        <button
          type="button"
          className="icon-btn"
          disabled={busy || !snapshot?.canGoBack}
          onClick={() => void runAction({ kind: 'back' })}
          aria-label={t('browser.back')}
          title={t('browser.back')}
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={busy || !snapshot?.canGoForward}
          onClick={() => void runAction({ kind: 'forward' })}
          aria-label={t('browser.forward')}
          title={t('browser.forward')}
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={busy || !snapshot?.open}
          onClick={() => void runAction({ kind: 'reload' })}
          aria-label={t('browser.reload')}
          title={t('browser.reload')}
        >
          <RotateCw size={13} className={busy || snapshot?.loading ? 'spin' : undefined} />
        </button>

        <div className="browser-omnibox">
          <Globe size={12} className="browser-omnibox-icon" aria-hidden="true" />
          <input
            ref={urlInputRef}
            className="browser-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={
              browserMode === 'edge' ? t('browser.addressPlaceholderEdge') : t('browser.addressPlaceholderGoogle')
            }
            aria-label={t('browser.address')}
          />
          <button
            type="submit"
            className="btn-primary browser-omnibox-submit"
            disabled={!urlInput.trim()}
            aria-label={t('browser.go')}
            title={t('browser.go')}
          >
            <ArrowRight size={11} />
          </button>
        </div>

        <div className="browser-toolbar-acts">
          {onAttachScreenshot && (
            <button
              type="button"
              className="icon-btn"
              disabled={busy || !snapshot?.open}
              onClick={() => void captureShot()}
              title={t('browser.attachShot')}
              aria-label={t('browser.attachShot')}
            >
              <Camera size={13} />
            </button>
          )}
          <button
            type="button"
            className={`icon-btn browser-console-btn${logsOpen ? ' is-active' : ''}`}
            onClick={() => setLogsOpen((v) => !v)}
            aria-label={t('browser.console')}
            title={t('browser.console')}
          >
            <Terminal size={13} />
            {consoleBadgeCount > 0 && (
              <span className={`browser-log-badge${consoleErrorCount > 0 ? ' err' : consoleWarnCount > 0 ? ' warn' : ''}`}>
                {consoleBadgeCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={!safeExternalUrl}
            onClick={() => {
              if (safeExternalUrl) void shell.openExternal(safeExternalUrl)
            }}
            aria-label={t('browser.openExternal')}
            title={t('browser.openExternal')}
          >
            <ExternalLink size={13} />
          </button>
        </div>
      </form>

      {snapshot?.error && (
        <div className="browser-err">
          <span className="browser-err-text">{snapshot.error}</span>
          <div className="browser-err-acts">
            <button type="button" className="btn btn-small" disabled={busy || !urlInput.trim()} onClick={() => void openUrl(urlInput)}>
              {t('browser.retry')}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => void switchBrowserMode(browserMode === 'edge' ? 'google' : 'edge')}
            >
              {t(browserMode === 'edge' ? 'browser.switchToGoogle' : 'browser.switchToEdge')}
            </button>
            {safeExternalUrl && (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => void shell.openExternal(safeExternalUrl)}
              >
                {t('browser.openExternal')}
              </button>
            )}
          </div>
        </div>
      )}

      {logsOpen && (
        <div className="browser-inspector-drawer">
          <div className="browser-inspector-head">
            <span className="browser-inspector-url" title={snapshot?.url || urlInput}>
              {snapshot?.title || snapshot?.url || modeProfile.homeTitle}
            </span>
            <div className="browser-inspector-acts">
              <button
                type="button"
                className="icon-btn"
                disabled={busy || !snapshot?.open}
                onClick={() => void runAction({ kind: 'scroll', deltaY: -480 })}
                title={t('browser.scrollUp')}
                aria-label={t('browser.scrollUp')}
              >
                <ArrowUp size={12} />
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={busy || !snapshot?.open}
                onClick={() => void runAction({ kind: 'scroll', deltaY: 480 })}
                title={t('browser.scrollDown')}
                aria-label={t('browser.scrollDown')}
              >
                <ArrowDown size={12} />
              </button>
            </div>
          </div>

          {snapshot && snapshot.elements.length > 0 && (
            <div className="browser-refs">
              <button
                type="button"
                className="browser-refs-head"
                onClick={() => setRefsOpen((v) => !v)}
                aria-expanded={refsOpen}
                title={t('browser.toggleRefs')}
              >
                {refsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span>{t('browser.interactiveRefs', { count: snapshot.elements.length })}</span>
              </button>
              {refsOpen && (
                <>
                  <div className="browser-ref-pills">
                    {snapshot.elements.slice(0, 14).map((el) => {
                      const isTextInput = el.tag === 'input' || el.tag === 'textarea'
                      const isSelectedInput = activeInputRef?.ref === el.ref
                      return (
                        <button
                          key={el.ref}
                          type="button"
                          className={`browser-ref-pill${isSelectedInput ? ' active' : ''}`}
                          disabled={busy}
                          onClick={() => {
                            if (isTextInput) {
                              setActiveInputRef(isSelectedInput ? null : el)
                              setTypeDraft(el.value ?? '')
                            } else {
                              setActiveInputRef(null)
                              void runAction({ kind: 'click', ref: el.ref })
                            }
                          }}
                          title={el.href || el.placeholder || el.text}
                        >
                          <code>{el.ref}</code>
                          <span>{el.text || el.placeholder || el.tag}</span>
                        </button>
                      )
                    })}
                  </div>
                  {activeInputRef && (
                    <form
                      className="browser-type-bar"
                      onSubmit={(e) => {
                        e.preventDefault()
                        const targetRef = activeInputRef.ref
                        const valueToType = typeDraft
                        setActiveInputRef(null)
                        void runAction({ kind: 'type', ref: targetRef, text: valueToType })
                      }}
                    >
                      <code>{activeInputRef.ref}</code>
                      <input
                        autoFocus
                        value={typeDraft}
                        onChange={(e) => setTypeDraft(e.target.value)}
                        placeholder={t('browser.typeInputPlaceholder', { ref: activeInputRef.ref })}
                      />
                      <button type="submit" className="btn btn-small btn-primary" disabled={busy}>
                        {t('browser.typeSend')}
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>
          )}

          <div className="browser-console">
            {!snapshot || snapshot.consoleLogs.length === 0 ? (
              <div className="muted small">{t('browser.noConsole')}</div>
            ) : (
              snapshot.consoleLogs.map((log, i) => (
                <div key={i} className={`browser-log-row level-${log.level}`}>
                  <span>[{log.level}]</span>
                  <code>{log.text}</code>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="browser-cursor-bar">
        <span className="browser-cursor-pill">
          <MousePointer2 size={11} />
          <span>{t('browser.virtualCursorBadge')}</span>
        </span>
        {snapshot?.cursor && (
          <span className="browser-cursor-telemetry">
            <code>
              ({Math.round(snapshot.cursor.x)}, {Math.round(snapshot.cursor.y)})
            </code>
            <span>
              {snapshot.cursor.action}
              {snapshot.cursor.targetLabel ? ` · ${snapshot.cursor.targetLabel}` : ''}
            </span>
          </span>
        )}
      </div>

      <div ref={stageRef} className="browser-stage">
        {(busy || snapshot?.loading) && <div className="browser-loading-bar" aria-hidden="true" />}
        {snapshot?.screenshotDataUrl ? (
          <div className="browser-stage-frame">
            <img
              src={snapshot.screenshotDataUrl}
              alt={snapshot.title || 'Browser Preview'}
              className="browser-stage-img"
              style={snapshot.screenshotWidth ? { width: `${snapshot.screenshotWidth}px` } : undefined}
              title={t('browser.clickPreviewHint')}
              onClick={handleStageClick}
              onWheel={handleStageWheel}
            />
            {snapshot.cursor && (
              <div
                className={`browser-virtual-cursor action-${snapshot.cursor.action}`}
                style={{
                  left: `${(snapshot.cursor.xRatio * 100).toFixed(2)}%`,
                  top: `${(snapshot.cursor.yRatio * 100).toFixed(2)}%`,
                }}
                aria-hidden="true"
              >
                <span className="browser-virtual-cursor-ring" />
                <MousePointer2 size={16} className="browser-virtual-cursor-ico" />
                <span className="browser-virtual-cursor-tag">
                  Atrium · {snapshot.cursor.action}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="browser-stage-loading">
            <div className="browser-empty-icon">
              <Globe size={18} className={busy || snapshot?.loading ? 'spin-slow' : undefined} />
            </div>
            <span>{busy || snapshot?.loading ? t('browser.loadingPage') : snapshot?.error || urlInput}</span>
            {!snapshot?.open && !busy && (
              <div className="browser-presets">
                {modeProfile.presets.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      setUrlInput(preset)
                      void openUrl(preset)
                    }}
                  >
                    {preset}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
