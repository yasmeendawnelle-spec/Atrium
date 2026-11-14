// Unified browser controller: per-conversation Electron WebContentsView sessions with Atrium virtual cursor
// and optional external Google Chrome/Edge CDP engine fallback.
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { BrowserWindow, WebContentsView, session, type WebContents } from 'electron'
import {
  buildBrowserUserAgent,
  getBrowserProfile,
  isModeHomeOrSearchUrl,
  normalizeBrowserMode,
  resolveBrowserInput,
} from '../shared/browserUrl.ts'
import type {
  BrowserActionInput,
  BrowserConsoleEntry,
  BrowserCursorAction,
  BrowserCursorState,
  BrowserElementRef,
  BrowserEngine,
  BrowserMode,
  BrowserSnapshot,
  BrowserTabInfo,
  BrowserViewLayout,
} from '../shared/types.ts'
import {
  activateCdpTab,
  CdpPageClient,
  closeCdpTab,
  createCdpTab,
  findInstalledChrome,
  gracefulCloseBrowser,
  launchChromeWithCdp,
  listCdpPageTargets,
  type CdpRawTarget,
  type ChromeBinaryInfo,
} from './cdp.ts'

const DEFAULT_CONVERSATION_KEY = '__default__'
const DEFAULT_OFFSCREEN_BOUNDS = { x: 0, y: 0, width: 960, height: 640 }

const COLLECT_DOM_SCRIPT = `(() => {
  const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"]';
  const nodes = Array.from(document.querySelectorAll(sel));
  const out = [];
  let seq = 0;
  for (const el of nodes) {
    if (out.length >= 40) break;
    if (el.closest('#__atrium_virtual_cursor__')) continue;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    const ref = 'e' + (++seq);
    el.setAttribute('data-atrium-ref', ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : tag);
    const rawText = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    const entry = {
      ref,
      tag,
      role,
      text: rawText.slice(0, 90),
    };
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.type) entry.type = String(el.type);
      if (el.placeholder) entry.placeholder = String(el.placeholder).slice(0, 60);
      if (el.type !== 'password' && typeof el.value === 'string' && el.value) entry.value = el.value.slice(0, 60);
    }
    if (tag === 'a' && el.href) entry.href = String(el.href).slice(0, 120);
    out.push(entry);
  }
  return out;
})()`

function buildResolveTargetScript(targetSel: string): string {
  return `(() => {
    const vw = window.innerWidth || 960;
    const vh = window.innerHeight || 640;
    const el = document.querySelector(${JSON.stringify(targetSel)});
    if (!el) return { found: false, x: Math.round(vw / 2), y: Math.round(vh / 2), vw, vh, label: '' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(vw - 1, Math.round(rect.left + rect.width / 2)));
    const y = Math.max(0, Math.min(vh - 1, Math.round(rect.top + rect.height / 2)));
    const rawLabel = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName || '').replace(/\\s+/g, ' ').trim();
    return { found: true, x, y, vw, vh, label: rawLabel.slice(0, 48) };
  })()`
}

function buildResolvePointScript(xRatio: number, yRatio: number): string {
  return `(() => {
    const vw = window.innerWidth || 960;
    const vh = window.innerHeight || 640;
    const x = Math.max(0, Math.min(vw - 1, Math.round(vw * ${xRatio})));
    const y = Math.max(0, Math.min(vh - 1, Math.round(vh * ${yRatio})));
    const el = document.elementFromPoint(x, y);
    const rawLabel = el ? (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName || '').replace(/\\s+/g, ' ').trim() : '';
    return { found: Boolean(el), x, y, vw, vh, label: rawLabel.slice(0, 48) };
  })()`
}

function buildClickScript(targetSel: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(targetSel)});
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus();
    el.click();
    return true;
  })()`
}

function buildTypeScript(targetSel: string, text: string): string {
  return `(() => {
    const vw = window.innerWidth || 960;
    const vh = window.innerHeight || 640;
    const el = document.querySelector(${JSON.stringify(targetSel)});
    if (!el) return { ok: false, x: Math.round(vw / 2), y: Math.round(vh / 2), vw, vh, label: '' };
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(vw - 1, Math.round(rect.left + rect.width / 2)));
    const y = Math.max(0, Math.min(vh - 1, Math.round(rect.top + rect.height / 2)));
    if (typeof el.focus === 'function') el.focus();
    if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const rawLabel = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName || '').replace(/\\s+/g, ' ').trim();
    return { ok: true, x, y, vw, vh, label: rawLabel.slice(0, 48) };
  })()`
}

function buildTypeAtPointScript(xRatio: number, yRatio: number, text: string): string {
  return `(() => {
    const vw = window.innerWidth || 960;
    const vh = window.innerHeight || 640;
    const x = Math.max(0, Math.min(vw - 1, Math.round(vw * ${xRatio})));
    const y = Math.max(0, Math.min(vh - 1, Math.round(vh * ${yRatio})));
    const hit = document.elementFromPoint(x, y);
    const el = hit && hit.closest ? (hit.closest('input, textarea, [contenteditable="true"]') || hit) : hit;
    if (!el) return { ok: false, x, y, vw, vh, label: '' };
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.click === 'function') el.click();
    if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if ('value' in el) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const rawLabel = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder')) || el.tagName || '').replace(/\\s+/g, ' ').trim();
    return { ok: true, x, y, vw, vh, label: rawLabel.slice(0, 48) };
  })()`
}

function buildVirtualCursorScript(cursor: BrowserCursorState): string {
  const xPct = (Math.max(0, Math.min(1, cursor.xRatio)) * 100).toFixed(3)
  const yPct = (Math.max(0, Math.min(1, cursor.yRatio)) * 100).toFixed(3)
  const isClickPulse =
    cursor.action === 'click' ||
    cursor.action === 'double_click' ||
    cursor.action === 'right_click' ||
    cursor.action === 'drag' ||
    cursor.action === 'type'
  const actionTag =
    cursor.action === 'double_click'
      ? 'Double Click'
      : cursor.action === 'right_click'
        ? 'Right Click'
        : cursor.action === 'click'
          ? 'Click'
          : cursor.action === 'drag'
            ? 'Drag'
            : cursor.action === 'hover'
              ? 'Hover'
              : cursor.action === 'scroll'
                ? 'Scroll'
                : cursor.action === 'type'
                  ? 'Type'
                  : cursor.action === 'key'
                    ? 'Key'
                    : 'Move'
  const pillText = cursor.targetLabel ? `Atrium · ${actionTag} · ${cursor.targetLabel.slice(0, 22)}` : `Atrium · ${actionTag}`
  return `(() => {
    const root = document.documentElement || document.body;
    if (!root) return false;
    let style = document.getElementById('__atrium_virtual_cursor_style__');
    if (!style) {
      style = document.createElement('style');
      style.id = '__atrium_virtual_cursor_style__';
      style.textContent = \`
        @keyframes __atrium_ripple__ {
          0% { transform: translate(-50%, -50%) scale(0.35); opacity: 0.95; }
          100% { transform: translate(-50%, -50%) scale(2.15); opacity: 0; }
        }
        #__atrium_virtual_cursor__ {
          position: fixed !important;
          z-index: 2147483647 !important;
          pointer-events: none !important;
          user-select: none !important;
          transition: left 220ms cubic-bezier(0.22, 1, 0.36, 1), top 220ms cubic-bezier(0.22, 1, 0.36, 1) !important;
          transform: translate(-2px, -2px);
          filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.32));
        }
        #__atrium_virtual_cursor__ .__atrium_ripple {
          position: absolute;
          left: 2px;
          top: 2px;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          border: 2px solid #d96b43;
          background: rgba(217, 107, 67, 0.16);
          animation: __atrium_ripple__ 560ms ease-out forwards;
        }
        #__atrium_virtual_cursor__ .__atrium_badge {
          position: absolute;
          left: 16px;
          top: 18px;
          padding: 2px 7px;
          border-radius: 999px;
          background: #1d1c1a;
          color: #fbfaf7;
          border: 1px solid rgba(255, 255, 255, 0.22);
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 10px;
          font-weight: 600;
          line-height: 14px;
          white-space: nowrap;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        }
      \`;
      (document.head || root).appendChild(style);
    }
    let host = document.getElementById('__atrium_virtual_cursor__');
    if (!host) {
      host = document.createElement('div');
      host.id = '__atrium_virtual_cursor__';
      host.setAttribute('aria-hidden', 'true');
      host.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 3L11.2 20.2L13.7 13.7L20.2 11.2L4 3Z" fill="#d96b43" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/></svg><span class="__atrium_badge"></span>';
      root.appendChild(host);
    }
    host.style.left = '${xPct}%';
    host.style.top = '${yPct}%';
    const badge = host.querySelector('.__atrium_badge');
    if (badge) badge.textContent = ${JSON.stringify(pillText)};
    const oldRipple = host.querySelector('.__atrium_ripple');
    if (oldRipple) oldRipple.remove();
    if (${isClickPulse ? 'true' : 'false'}) {
      const r = document.createElement('span');
      r.className = '__atrium_ripple';
      host.insertBefore(r, host.firstChild);
    }
    return true;
  })()`
}

function sendElectronKey(wc: WebContents, rawKey: string): void {
  const parts = rawKey
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return

  const keyToken = parts[parts.length - 1]!
  const modifiers: Array<'control' | 'alt' | 'shift' | 'meta'> = []
  for (const mod of parts.slice(0, -1)) {
    const m = mod.toLowerCase()
    if (m === 'ctrl' || m === 'control') modifiers.push('control')
    else if (m === 'alt' || m === 'option') modifiers.push('alt')
    else if (m === 'shift') modifiers.push('shift')
    else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'win' || m === 'super') modifiers.push('meta')
  }

  const KEY_MAP: Record<string, { keyCode: string; charCode?: string }> = {
    enter: { keyCode: 'Return', charCode: '\r' },
    return: { keyCode: 'Return', charCode: '\r' },
    tab: { keyCode: 'Tab' },
    escape: { keyCode: 'Escape' },
    esc: { keyCode: 'Escape' },
    backspace: { keyCode: 'Backspace' },
    delete: { keyCode: 'Delete' },
    del: { keyCode: 'Delete' },
    space: { keyCode: 'Space', charCode: ' ' },
    spacebar: { keyCode: 'Space', charCode: ' ' },
    up: { keyCode: 'Up' },
    arrowup: { keyCode: 'Up' },
    down: { keyCode: 'Down' },
    arrowdown: { keyCode: 'Down' },
    left: { keyCode: 'Left' },
    arrowleft: { keyCode: 'Left' },
    right: { keyCode: 'Right' },
    arrowright: { keyCode: 'Right' },
    home: { keyCode: 'Home' },
    end: { keyCode: 'End' },
    pageup: { keyCode: 'PageUp' },
    pgup: { keyCode: 'PageUp' },
    pagedown: { keyCode: 'PageDown' },
    pgdn: { keyCode: 'PageDown' },
  }

  const mapped = KEY_MAP[keyToken.toLowerCase()]
  const keyCode = mapped?.keyCode ?? (keyToken.length === 1 ? keyToken : keyToken)
  const modList = modifiers.length > 0 ? modifiers : undefined

  wc.sendInputEvent({ type: 'keyDown', keyCode, ...(modList ? { modifiers: modList } : {}) })
  if (mapped?.charCode) {
    wc.sendInputEvent({ type: 'char', keyCode: mapped.charCode, ...(modList ? { modifiers: modList } : {}) })
  } else if (keyToken.length === 1 && modifiers.length === 0) {
    wc.sendInputEvent({ type: 'char', keyCode: keyToken })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, ...(modList ? { modifiers: modList } : {}) })
}

function formatLoadError(url: string, code: number, desc: string): string {
  if (desc === 'ERR_CONNECTION_REFUSED' || code === -102) {
    return `Connection refused (${desc}) loading ${url} — check that the local server is running.`
  }
  if (desc === 'ERR_NAME_NOT_RESOLVED' || code === -105) {
    return `Host not found (${desc}) loading ${url}.`
  }
  if (desc === 'ERR_SSL_PROTOCOL_ERROR' || code === -107) {
    return `TLS handshake failed (${desc}) loading ${url}. Local servers usually use http:// instead of https://.`
  }
  return `Load failed (${code}${desc ? `: ${desc}` : ''}) loading ${url}`
}

export interface BrowserControllerOptions {
  userDataDir?: string
  preferCdp?: boolean
  initialMode?: BrowserMode
}

interface ElectronSessionState {
  key: string
  conversationId?: string
  pageOpen: boolean
  lastRequestedUrl: string
  consoleLogs: BrowserConsoleEntry[]
  lastError: string | undefined
  lastScreenshotDataUrl: string | undefined
  lastScreenshotWidth: number | undefined
  lastScreenshotHeight: number | undefined
  lastElements: BrowserElementRef[]
  cursor: BrowserCursorState | undefined
  embeddedTabs: { id: string; view: WebContentsView }[]
  activeTabId: string
  tabSeq: number
  openSeq: number
  view: WebContentsView | null
  lastCapturedLayoutKey: string
}

export class BuiltinBrowserController {
  private readonly profileDir: string
  private readonly preferCdp: boolean
  private chromeBin: ChromeBinaryInfo | null
  private mode: BrowserMode
  private baseUserAgent = ''

  // Shared UI/dock state across conversations
  private hostWin: BrowserWindow | null = null
  private lastLayout: BrowserViewLayout | null = null
  private onStateChange?: (snap: BrowserSnapshot) => void
  private readonly pushTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Per-conversation Electron WebContentsView sessions
  private readonly sessions = new Map<string, ElectronSessionState>()
  private activeConversationKey = DEFAULT_CONVERSATION_KEY
  private dockedView: WebContentsView | null = null
  private dockedSessionKey: string | null = null
  private dockedLive = false
  private postAttachTimer: ReturnType<typeof setTimeout> | null = null
  private popoutWin: BrowserWindow | null = null

  // CDP Chrome/Edge state (optional legacy mode)
  private chromeProc: ChildProcess | null = null
  private cdpPort = 0
  private cdpBrowserWsUrl: string | undefined
  private cdpClient: CdpPageClient | null = null
  private activeTargetId = ''
  private cdpTabs: BrowserTabInfo[] = []
  private cdpUrl = ''
  private cdpTitle = ''
  private cdpLoading = false
  private cdpCanGoBack = false
  private cdpCanGoForward = false
  private cdpLaunchPromise: Promise<void> | null = null
  private cdpMirrorTimer: ReturnType<typeof setInterval> | null = null
  private cdpMirrorBusy = false
  private cdpLastRequestedUrl = ''
  private cdpLastError: string | undefined
  private cdpConsoleLogs: BrowserConsoleEntry[] = []
  private cdpElements: BrowserElementRef[] = []
  private cdpScreenshotDataUrl: string | undefined
  private cdpPageOpen = false
  private cdpCursor: BrowserCursorState | undefined

  constructor(opts: BrowserControllerOptions = {}) {
    this.profileDir = opts.userDataDir ? join(opts.userDataDir, 'chrome-profile') : join(process.cwd(), '.chrome-profile')
    this.preferCdp = opts.preferCdp === true
    this.mode = normalizeBrowserMode(opts.initialMode, 'google')
    this.chromeBin = this.preferCdp ? findInstalledChrome(this.mode === 'edge' ? 'edge-cdp' : 'chrome-cdp') : null
  }

  private resolveSessionKey(conversationId?: string): string {
    const clean = typeof conversationId === 'string' ? conversationId.trim() : ''
    return clean || this.activeConversationKey || DEFAULT_CONVERSATION_KEY
  }

  private getOrCreateSession(conversationId?: string): ElectronSessionState {
    const key = this.resolveSessionKey(conversationId)
    let sess = this.sessions.get(key)
    if (!sess) {
      sess = {
        key,
        ...(key !== DEFAULT_CONVERSATION_KEY ? { conversationId: key } : {}),
        pageOpen: false,
        lastRequestedUrl: '',
        consoleLogs: [],
        lastError: undefined,
        lastScreenshotDataUrl: undefined,
        lastScreenshotWidth: undefined,
        lastScreenshotHeight: undefined,
        lastElements: [],
        cursor: undefined,
        embeddedTabs: [],
        activeTabId: '',
        tabSeq: 0,
        openSeq: 0,
        view: null,
        lastCapturedLayoutKey: '',
      }
      this.sessions.set(key, sess)
    }
    return sess
  }

  private resolvedUserAgent(): string {
    if (!this.baseUserAgent) {
      const partition = session.fromPartition('persist:atrium-browser')
      this.baseUserAgent = partition.getUserAgent()
    }
    return buildBrowserUserAgent(this.baseUserAgent, this.mode)
  }

  private applyUserAgent(): void {
    try {
      const ua = this.resolvedUserAgent()
      const partition = session.fromPartition('persist:atrium-browser')
      partition.setUserAgent(ua)
      for (const sess of this.sessions.values()) {
        this.pruneEmbeddedTabs(sess)
        for (const tab of sess.embeddedTabs) {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setUserAgent(ua)
          }
        }
      }
    } catch {
      /* ignore outside full Electron session */
    }
  }

  async setMode(
    rawMode: BrowserMode,
    opts?: { navigateIfHome?: boolean; conversationId?: string },
  ): Promise<BrowserSnapshot> {
    const nextMode = normalizeBrowserMode(rawMode, this.mode)
    const changed = nextMode !== this.mode
    this.mode = nextMode
    if (this.preferCdp) {
      this.chromeBin = findInstalledChrome(nextMode === 'edge' ? 'edge-cdp' : 'chrome-cdp')
    }
    this.applyUserAgent()
    const profile = getBrowserProfile(this.mode)

    if (opts?.navigateIfHome) {
      const sess = this.getOrCreateSession(opts.conversationId)
      const activeUrl =
        this.isCdpMode()
          ? this.cdpUrl
          : sess.view && !sess.view.webContents.isDestroyed()
            ? sess.view.webContents.getURL()
            : ''
      const lastReq = this.isCdpMode() ? this.cdpLastRequestedUrl : sess.lastRequestedUrl
      const lastErr = this.isCdpMode() ? this.cdpLastError : sess.lastError
      const openFlag = this.isCdpMode() ? this.cdpPageOpen : sess.pageOpen
      const checkUrl = activeUrl && !activeUrl.startsWith('chrome-error://') ? activeUrl : lastReq
      const loadingModeHome =
        changed &&
        sess.view &&
        !sess.view.webContents.isDestroyed() &&
        sess.view.webContents.isLoadingMainFrame() &&
        isModeHomeOrSearchUrl(lastReq)
      if (!openFlag || Boolean(lastErr) || isModeHomeOrSearchUrl(checkUrl) || loadingModeHome) {
        if (sess.view && !sess.view.webContents.isDestroyed() && sess.view.webContents.isLoadingMainFrame()) {
          try {
            sess.view.webContents.stop()
          } catch {
            /* ignore */
          }
        }
        return this.open(profile.homeUrl, opts.conversationId)
      }
    }

    const snap = this.state(opts?.conversationId)
    this.onStateChange?.(snap)
    return snap
  }

  private isCdpMode(): boolean {
    return Boolean(this.chromeBin)
  }

  private engineInfo(): { engine: BrowserEngine; browserLabel: string } {
    if (this.chromeBin) return { engine: this.chromeBin.engine, browserLabel: this.chromeBin.label }
    return {
      engine: 'electron',
      browserLabel: this.mode === 'edge' ? 'Microsoft Edge (Embedded)' : 'Google Chrome (Embedded)',
    }
  }

  setOnStateChange(listener: (snap: BrowserSnapshot) => void): void {
    this.onStateChange = listener
  }

  private hideDockedView(targetWin?: BrowserWindow | null): void {
    if (!this.dockedView) {
      this.dockedLive = false
      this.dockedSessionKey = null
      return
    }
    const prevView = this.dockedView
    try {
      prevView.setVisible(false)
    } catch {
      /* ignore */
    }
    const win = targetWin ?? this.hostWin
    if (win && !win.isDestroyed()) {
      try {
        prevView.setBounds(DEFAULT_OFFSCREEN_BOUNDS)
      } catch {
        /* ignore */
      }
    }
    this.dockedLive = false
    this.dockedView = null
    this.dockedSessionKey = null
  }

  private ensureViewAddedToHost(view: WebContentsView): void {
    if (!this.hostWin || this.hostWin.isDestroyed()) return
    try {
      const children = this.hostWin.contentView.children
      if (!children.includes(view)) {
        this.hostWin.contentView.addChildView(view)
      }
    } catch {
      /* ignore view attach errors */
    }
  }

  private removeViewFromHost(view: WebContentsView): void {
    if (!this.hostWin || this.hostWin.isDestroyed()) return
    try {
      this.hostWin.contentView.removeChildView(view)
    } catch {
      /* ignore view detach errors */
    }
  }

  setHostWindow(win: BrowserWindow | null): void {
    const next = win && !win.isDestroyed() ? win : null
    if (this.hostWin === next) return
    const prevHost = this.hostWin
    if (prevHost && !prevHost.isDestroyed()) {
      this.hideDockedView(prevHost)
      for (const sess of this.sessions.values()) {
        for (const tab of sess.embeddedTabs) {
          try {
            prevHost.contentView.removeChildView(tab.view)
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.hostWin = next
    if (next) {
      for (const sess of this.sessions.values()) {
        this.pruneEmbeddedTabs(sess)
        for (const tab of sess.embeddedTabs) {
          this.ensureViewAddedToHost(tab.view)
          tab.view.setVisible(false)
        }
      }
    }
    if (!this.isCdpMode() && this.lastLayout && !this.popoutOpen()) {
      void this.syncLayout(this.lastLayout)
    }
  }

  private popoutOpen(): boolean {
    return Boolean(this.popoutWin && !this.popoutWin.isDestroyed())
  }

  private pushSessionLog(sess: ElectronSessionState, level: BrowserConsoleEntry['level'], text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    sess.consoleLogs.push({ level, text: trimmed.slice(0, 260), at: Date.now() })
    if (sess.consoleLogs.length > 50) sess.consoleLogs.splice(0, sess.consoleLogs.length - 50)
  }

  private schedulePush(key: string, includeFrame = false): void {
    const existing = this.pushTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.pushTimers.delete(key)
      if (!this.onStateChange) return
      const cid = key === DEFAULT_CONVERSATION_KEY ? undefined : key
      if (includeFrame) {
        void this.capture(cid).then((snap) => this.onStateChange?.(snap))
      } else {
        this.onStateChange(this.state(cid))
      }
    }, 120)
    this.pushTimers.set(key, timer)
  }

  private closedState(sess?: ElectronSessionState): BrowserSnapshot {
    const info = this.engineInfo()
    return {
      ...(sess?.conversationId ? { conversationId: sess.conversationId } : {}),
      open: false,
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      elements: [],
      consoleLogs: sess ? [...sess.consoleLogs] : [...this.cdpConsoleLogs],
      mode: this.mode,
      engine: info.engine,
      browserLabel: info.browserLabel,
      tabs: [],
      popoutOpen: false,
      dockedLive: false,
      error: sess ? sess.lastError : this.cdpLastError,
    }
  }

  // ---- CDP Lifecycle & Control (legacy external Chrome/Edge mode) ----

  private pushCdpLog(level: BrowserConsoleEntry['level'], text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.cdpConsoleLogs.push({ level, text: trimmed.slice(0, 260), at: Date.now() })
    if (this.cdpConsoleLogs.length > 50) this.cdpConsoleLogs.splice(0, this.cdpConsoleLogs.length - 50)
  }

  private stopCdpMirrorLoop(): void {
    if (this.cdpMirrorTimer) {
      clearInterval(this.cdpMirrorTimer)
      this.cdpMirrorTimer = null
    }
  }

  private startCdpMirrorLoop(): void {
    if (this.cdpMirrorTimer || !this.isCdpMode() || !this.cdpPageOpen) return
    this.cdpMirrorTimer = setInterval(() => {
      if (this.cdpMirrorBusy || !this.cdpPageOpen || !this.cdpPort) return
      this.cdpMirrorBusy = true
      void this.captureCdp(false)
        .then((snap) => this.onStateChange?.(snap))
        .catch(() => undefined)
        .finally(() => {
          this.cdpMirrorBusy = false
        })
    }, 1300)
  }

  private resetCdpState(): void {
    this.stopCdpMirrorLoop()
    this.cdpClient?.closeSocket()
    this.cdpClient = null
    this.chromeProc = null
    this.cdpPort = 0
    this.cdpBrowserWsUrl = undefined
    this.activeTargetId = ''
    this.cdpTabs = []
    this.cdpUrl = ''
    this.cdpTitle = ''
    this.cdpLoading = false
    this.cdpCanGoBack = false
    this.cdpCanGoForward = false
    this.cdpPageOpen = false
    this.cdpElements = []
    this.cdpScreenshotDataUrl = undefined
    this.cdpCursor = undefined
  }

  private async connectToTarget(target: CdpRawTarget): Promise<CdpPageClient> {
    if (this.cdpClient && this.activeTargetId === target.id && this.cdpClient.isOpen()) {
      return this.cdpClient
    }
    this.cdpClient?.closeSocket()
    this.cdpClient = null
    if (!target.webSocketDebuggerUrl) {
      throw new Error('Selected Chrome tab has no debugging endpoint.')
    }
    const client = await CdpPageClient.connect(target.webSocketDebuggerUrl)
    await client.enable()
    this.activeTargetId = target.id
    this.cdpUrl = target.url
    this.cdpTitle = target.title

    client.onEvent((method, params) => {
      if (this.cdpClient !== client) return
      if (method === 'Page.frameStartedLoading') {
        this.cdpLoading = true
        this.schedulePush(DEFAULT_CONVERSATION_KEY, false)
      } else if (
        method === 'Page.frameStoppedLoading' ||
        method === 'Page.loadEventFired' ||
        method === 'Page.navigatedWithinDocument'
      ) {
        this.cdpLoading = false
        this.schedulePush(DEFAULT_CONVERSATION_KEY, true)
      } else if (method === 'Runtime.consoleAPICalled') {
        const rawType = String(params.type || 'log')
        const level: BrowserConsoleEntry['level'] =
          rawType === 'error' ? 'error' : rawType === 'warning' ? 'warn' : 'log'
        const args = Array.isArray(params.args)
          ? (params.args as { value?: unknown; description?: string }[])
          : []
        const text = args
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ''))
          .filter(Boolean)
          .join(' ')
        this.pushCdpLog(level, text)
        this.schedulePush(DEFAULT_CONVERSATION_KEY, false)
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as
          | { text?: string; exception?: { description?: string } }
          | undefined
        const msg = details?.exception?.description || details?.text || 'Uncaught exception'
        this.pushCdpLog('error', msg)
        this.schedulePush(DEFAULT_CONVERSATION_KEY, false)
      }
    })

    client.onClose(() => {
      if (this.cdpClient === client) {
        this.cdpClient = null
        void this.syncCdpTargetsAfterDisconnect()
      }
    })

    this.cdpClient = client
    return client
  }

  private async syncCdpTargetsAfterDisconnect(): Promise<void> {
    if (!this.cdpPort) return
    const targets = await listCdpPageTargets(this.cdpPort).catch(() => [])
    if (targets.length === 0) {
      this.resetCdpState()
      this.onStateChange?.(this.closedState())
      return
    }
    const next = targets[0]!
    this.cdpTabs = targets.map((t, i) => ({
      id: t.id,
      title: t.title || t.url,
      url: t.url,
      active: i === 0,
    }))
    try {
      await this.connectToTarget(next)
      this.schedulePush(DEFAULT_CONVERSATION_KEY, true)
    } catch {
      /* ignore reconnect race */
    }
  }

  private async ensureCdpConnected(initialUrl?: string): Promise<CdpPageClient> {
    if (this.cdpLaunchPromise) {
      await this.cdpLaunchPromise
    }
    if (this.cdpPort && this.chromeProc && !this.chromeProc.killed) {
      const targets = await listCdpPageTargets(this.cdpPort).catch(() => [])
      if (targets.length > 0) {
        this.cdpPageOpen = true
        const current = targets.find((t) => t.id === this.activeTargetId) ?? targets[0]!
        this.cdpTabs = targets.map((t) => ({
          id: t.id,
          title: t.title || t.url,
          url: t.url,
          active: t.id === current.id,
        }))
        return this.connectToTarget(current)
      }
    }

    if (!this.chromeBin) {
      throw new Error('No Chromium binary found on this system.')
    }
    const bin = this.chromeBin
    let created: CdpRawTarget | null = null
    this.cdpLaunchPromise = (async () => {
      const launched = await launchChromeWithCdp({
        executablePath: bin.path,
        userDataDir: this.profileDir,
        initialUrl,
      })
      this.chromeProc = launched.process
      this.cdpPort = launched.port
      this.cdpBrowserWsUrl = launched.browserWsUrl
      this.cdpPageOpen = true
      created = launched.initialTarget
      this.cdpTabs = [
        {
          id: created.id,
          title: created.title || created.url,
          url: created.url,
          active: true,
        },
      ]
      launched.process.once('exit', () => {
        if (this.chromeProc === launched.process) {
          this.resetCdpState()
          this.onStateChange?.(this.closedState())
        }
      })
    })()

    try {
      await this.cdpLaunchPromise
    } finally {
      this.cdpLaunchPromise = null
    }

    if (!created) throw new Error('Chrome opened without an initial page target.')
    const client = await this.connectToTarget(created)
    if (this.lastLayout?.visible) this.startCdpMirrorLoop()
    return client
  }

  private async captureCdp(collectDom = true, conversationId?: string): Promise<BrowserSnapshot> {
    if (!this.cdpPageOpen || !this.cdpPort) return this.closedState()
    const targets = await listCdpPageTargets(this.cdpPort).catch(() => [])
    if (targets.length === 0) {
      this.resetCdpState()
      return this.closedState()
    }
    const target = targets.find((t) => t.id === this.activeTargetId) ?? targets[0]!
    this.activeTargetId = target.id
    this.cdpTabs = targets.map((t) => ({
      id: t.id,
      title: t.title || t.url,
      url: t.url,
      active: t.id === target.id,
    }))

    const client = await this.connectToTarget(target)
    const nav = await client.getNavState().catch(() => ({
      url: target.url,
      title: target.title,
      canGoBack: false,
      canGoForward: false,
      currentIndex: 0,
      entries: [],
    }))
    this.cdpUrl = nav.url || target.url
    this.cdpTitle = nav.title || target.title
    this.cdpCanGoBack = nav.canGoBack
    this.cdpCanGoForward = nav.canGoForward

    if (collectDom) {
      try {
        const res = await client.evaluate<BrowserElementRef[]>(COLLECT_DOM_SCRIPT)
        this.cdpElements = Array.isArray(res) ? res : []
      } catch {
        this.cdpElements = []
      }
    }
    const shot = await client.captureScreenshot()
    if (shot) this.cdpScreenshotDataUrl = shot
    return this.state(conversationId)
  }

  // ---- Electron WebContentsView Per-Conversation Embedded Tabs ----

  private pruneEmbeddedTabs(sess: ElectronSessionState): void {
    sess.embeddedTabs = sess.embeddedTabs.filter((t) => !t.view.webContents.isDestroyed())
  }

  private clearScreenshotCache(sess: ElectronSessionState): void {
    sess.lastScreenshotDataUrl = undefined
    sess.lastScreenshotWidth = undefined
    sess.lastScreenshotHeight = undefined
  }

  private createEmbeddedTab(sess: ElectronSessionState): { id: string; view: WebContentsView } {
    this.pruneEmbeddedTabs(sess)
    if (sess.view && this.dockedView === sess.view) {
      this.hideDockedView()
    } else if (sess.view && !sess.view.webContents.isDestroyed()) {
      try {
        sess.view.setVisible(false)
      } catch {
        /* ignore */
      }
    }

    const partition = session.fromPartition('persist:atrium-browser')
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    view.setBackgroundColor('#ffffff')
    view.setBounds(DEFAULT_OFFSCREEN_BOUNDS)
    view.setVisible(false)
    this.ensureViewAddedToHost(view)
    const wc = view.webContents
    try {
      wc.setUserAgent(this.resolvedUserAgent())
    } catch {
      /* ignore if session is unavailable */
    }

    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void this.actionElectron(sess, { kind: 'newTab', text: url, conversationId: sess.conversationId })
      }
      return { action: 'deny' }
    })
    wc.on('will-navigate', (ev, url) => {
      if (!/^https?:\/\//i.test(url)) ev.preventDefault()
    })
    wc.on('did-start-loading', () => {
      if (sess.view === view) sess.lastError = undefined
      this.schedulePush(sess.key, false)
    })
    wc.on('did-navigate', (_ev, url) => {
      if (url && url !== 'about:blank') sess.pageOpen = true
      this.schedulePush(sess.key, sess.view === view)
    })
    wc.on('did-navigate-in-page', () => {
      this.schedulePush(sess.key, sess.view === view)
    })
    wc.on('page-title-updated', () => {
      this.schedulePush(sess.key, false)
    })
    wc.on('did-finish-load', () => {
      this.schedulePush(sess.key, sess.view === view)
    })
    wc.on('did-stop-loading', () => {
      this.schedulePush(sess.key, sess.view === view)
    })
    wc.on('did-fail-load', (_ev, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      if (sess.view === view) {
        sess.lastError = formatLoadError(validatedURL || wc.getURL(), code, desc)
        this.schedulePush(sess.key, true)
      }
    })
    wc.on('console-message', (ev) => {
      const level: BrowserConsoleEntry['level'] =
        ev.level === 'error' ? 'error' : ev.level === 'warning' ? 'warn' : 'log'
      this.pushSessionLog(sess, level, String(ev.message))
      this.schedulePush(sess.key, false)
    })

    const id = `tab_${++sess.tabSeq}`
    const tab = { id, view }
    sess.embeddedTabs.push(tab)
    sess.activeTabId = id
    sess.view = view
    return tab
  }

  private ensureView(sess: ElectronSessionState): WebContentsView {
    this.pruneEmbeddedTabs(sess)
    const active = sess.embeddedTabs.find((t) => t.id === sess.activeTabId) ?? sess.embeddedTabs[0]
    if (active) {
      sess.activeTabId = active.id
      sess.view = active.view
      this.ensureViewAddedToHost(active.view)
      return active.view
    }
    return this.createEmbeddedTab(sess).view
  }

  private async updateVirtualCursor(
    sess: ElectronSessionState,
    wc: WebContents,
    info: {
      x: number
      y: number
      vw: number
      vh: number
      endX?: number
      endY?: number
      action: BrowserCursorAction
      targetLabel?: string
    },
  ): Promise<void> {
    const vw = Math.max(1, info.vw)
    const vh = Math.max(1, info.vh)
    const xRatio = Math.max(0, Math.min(1, info.x / vw))
    const yRatio = Math.max(0, Math.min(1, info.y / vh))
    const shotW = sess.lastScreenshotWidth && sess.lastScreenshotWidth > 0 ? sess.lastScreenshotWidth : vw
    const shotH = sess.lastScreenshotHeight && sess.lastScreenshotHeight > 0 ? sess.lastScreenshotHeight : vh
    const cursor: BrowserCursorState = {
      x: Math.round(xRatio * shotW),
      y: Math.round(yRatio * shotH),
      xRatio,
      yRatio,
      ...(info.endX !== undefined && info.endY !== undefined
        ? {
            endXRatio: Math.max(0, Math.min(1, info.endX / vw)),
            endYRatio: Math.max(0, Math.min(1, info.endY / vh)),
            endX: Math.round(Math.max(0, Math.min(1, info.endX / vw)) * shotW),
            endY: Math.round(Math.max(0, Math.min(1, info.endY / vh)) * shotH),
          }
        : {}),
      action: info.action,
      ...(info.targetLabel ? { targetLabel: info.targetLabel } : {}),
      updatedAt: Date.now(),
    }
    sess.cursor = cursor
    try {
      await wc.executeJavaScript(buildVirtualCursorScript(cursor))
    } catch {
      /* ignore DOM injection errors on restricted pages */
    }
  }

  private async captureViewImage(sess: ElectronSessionState, wc: WebContents): Promise<string | undefined> {
    try {
      if (sess.cursor) {
        await wc.executeJavaScript(buildVirtualCursorScript(sess.cursor)).catch(() => undefined)
        await new Promise((r) => setTimeout(r, 35))
      }
      const img = await wc.capturePage()
      const size = img.getSize()
      if (img.isEmpty() || size.width <= 0 || size.height <= 0) {
        return sess.lastScreenshotDataUrl
      }
      const resized = size.width > 960 ? img.resize({ width: 960 }) : img
      const dataUrl = `data:image/jpeg;base64,${resized.toJPEG(85).toString('base64')}`
      const bounds = sess.view && !sess.view.webContents.isDestroyed() ? sess.view.getBounds() : undefined
      sess.lastScreenshotWidth = bounds && bounds.width >= 40 ? bounds.width : size.width
      sess.lastScreenshotHeight = bounds && bounds.height >= 40 ? bounds.height : size.height
      sess.lastScreenshotDataUrl = dataUrl
      return dataUrl
    } catch {
      return sess.lastScreenshotDataUrl
    }
  }

  private async waitLoad(sess: ElectronSessionState, wc: WebContents, timeoutMs = 6_000): Promise<void> {
    if (!wc.isLoadingMainFrame()) {
      await new Promise((r) => setTimeout(r, 140))
      return
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, timeoutMs)
      const finish = () => {
        cleanup()
        setTimeout(resolve, 160)
      }
      const fail = (_e: unknown, code: number, desc: string, url: string, isMainFrame: boolean) => {
        if (isMainFrame && code !== -3) {
          sess.lastError = formatLoadError(url || wc.getURL(), code, desc)
        }
        cleanup()
        resolve()
      }
      const cleanup = () => {
        clearTimeout(timer)
        wc.removeListener('did-finish-load', finish)
        wc.removeListener('did-stop-loading', finish)
        wc.removeListener('did-fail-load', fail)
      }
      wc.once('did-finish-load', finish)
      wc.once('did-stop-loading', finish)
      wc.once('did-fail-load', fail)
    })
  }

  // ---- Unified Public API ----

  state(conversationId?: string): BrowserSnapshot {
    const info = this.engineInfo()
    const cleanCid = typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : undefined
    if (this.isCdpMode()) {
      if (!this.cdpPageOpen) return this.closedState()
      return {
        ...(cleanCid ? { conversationId: cleanCid } : {}),
        open: true,
        url: this.cdpUrl,
        title: this.cdpTitle,
        loading: this.cdpLoading,
        canGoBack: this.cdpCanGoBack,
        canGoForward: this.cdpCanGoForward,
        screenshotDataUrl: this.cdpScreenshotDataUrl,
        cursor: this.cdpCursor,
        elements: this.cdpElements,
        consoleLogs: [...this.cdpConsoleLogs],
        mode: this.mode,
        engine: info.engine,
        browserLabel: info.browserLabel,
        tabs: [...this.cdpTabs],
        popoutOpen: false,
        dockedLive: false,
        error: this.cdpLastError,
      }
    }

    const key = this.resolveSessionKey(conversationId)
    const sess = this.sessions.get(key)
    if (!sess) {
      return {
        ...(cleanCid ? { conversationId: cleanCid } : {}),
        open: false,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        elements: [],
        consoleLogs: [],
        mode: this.mode,
        engine: info.engine,
        browserLabel: info.browserLabel,
        tabs: [],
        popoutOpen: false,
        dockedLive: false,
      }
    }
    if (!sess.pageOpen || !sess.view || sess.view.webContents.isDestroyed()) {
      return this.closedState(sess)
    }

    this.pruneEmbeddedTabs(sess)
    const wc = sess.view.webContents
    const nav = wc.navigationHistory
    const rawUrl = wc.getURL()
    const safeUrl = rawUrl.startsWith('chrome-error://') ? '' : rawUrl
    const fallbackTitle = getBrowserProfile(this.mode).homeTitle
    const tabs: BrowserTabInfo[] = sess.embeddedTabs
      .filter((t) => !t.view.webContents.isDestroyed())
      .map((t) => {
        const twc = t.view.webContents
        const tUrl = twc.getURL()
        const safeTUrl = tUrl.startsWith('chrome-error://') ? '' : tUrl
        const tTitle = twc.getTitle()
        return {
          id: t.id,
          title: tTitle || safeTUrl || fallbackTitle,
          url: safeTUrl,
          active: t.id === sess.activeTabId,
        }
      })

    return {
      ...(sess.conversationId ? { conversationId: sess.conversationId } : {}),
      open: true,
      url: safeUrl,
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: nav ? nav.canGoBack() : false,
      canGoForward: nav ? nav.canGoForward() : false,
      screenshotDataUrl: sess.lastScreenshotDataUrl,
      screenshotWidth: sess.lastScreenshotWidth,
      screenshotHeight: sess.lastScreenshotHeight,
      cursor: sess.cursor,
      elements: sess.lastElements,
      consoleLogs: [...sess.consoleLogs],
      mode: this.mode,
      engine: info.engine,
      browserLabel: info.browserLabel,
      tabs,
      popoutOpen: this.popoutOpen(),
      dockedLive: this.dockedLive && this.dockedView === sess.view,
      error: sess.lastError,
    }
  }

  async capture(conversationId?: string): Promise<BrowserSnapshot> {
    if (this.isCdpMode()) return this.captureCdp(true, conversationId)
    const key = this.resolveSessionKey(conversationId)
    const sess = this.sessions.get(key)
    if (!sess || !sess.pageOpen || !sess.view || sess.view.webContents.isDestroyed()) {
      return this.state(conversationId)
    }
    const wc = sess.view.webContents
    try {
      const res = (await wc.executeJavaScript(COLLECT_DOM_SCRIPT)) as BrowserElementRef[]
      sess.lastElements = Array.isArray(res) ? res : []
    } catch {
      sess.lastElements = []
    }
    await this.captureViewImage(sess, wc)
    return this.state(conversationId)
  }

  async syncLayout(rawLayout: BrowserViewLayout | null): Promise<void> {
    this.lastLayout = rawLayout
    if (rawLayout?.conversationId?.trim()) {
      this.activeConversationKey = rawLayout.conversationId.trim()
    }
    if (this.isCdpMode()) {
      const visible = Boolean(rawLayout?.visible && this.cdpPageOpen && this.cdpPort)
      if (visible) this.startCdpMirrorLoop()
      else this.stopCdpMirrorLoop()
      return
    }
    if (this.popoutOpen()) {
      this.dockedLive = false
      return
    }
    if (!this.hostWin || this.hostWin.isDestroyed()) {
      this.dockedLive = false
      return
    }

    const key = this.resolveSessionKey(rawLayout?.conversationId)
    const sess = this.sessions.get(key)
    const wantsVisible = Boolean(
      rawLayout &&
        rawLayout.visible &&
        rawLayout.width >= 40 &&
        rawLayout.height >= 40 &&
        sess &&
        sess.pageOpen &&
        sess.view &&
        !sess.view.webContents.isDestroyed(),
    )

    if (!wantsVisible || !rawLayout || !sess || !sess.view) {
      const prevDockedView = this.dockedView
      const prevDockedKey = this.dockedSessionKey
      let wasFocused = false
      if (prevDockedView && !prevDockedView.webContents.isDestroyed()) {
        try {
          wasFocused = prevDockedView.webContents.isFocused()
        } catch {
          /* ignore */
        }
      }
      this.hideDockedView()
      if (wasFocused && !this.hostWin.isDestroyed()) {
        this.hostWin.webContents.focus()
      }
      if (prevDockedView && !prevDockedView.webContents.isDestroyed() && prevDockedKey) {
        const prevSess = this.sessions.get(prevDockedKey)
        if (prevSess && prevSess.pageOpen) {
          const fresh = await this.captureViewImage(prevSess, prevDockedView.webContents)
          if (fresh && !this.dockedLive && prevSess.pageOpen) {
            this.onStateChange?.(this.state(prevSess.conversationId))
          }
        }
      }
      return
    }

    if (this.dockedView && this.dockedView !== sess.view) {
      this.hideDockedView()
    }
    for (const s of this.sessions.values()) {
      for (const tab of s.embeddedTabs) {
        if (tab.view !== sess.view && !tab.view.webContents.isDestroyed()) {
          try {
            tab.view.setVisible(false)
          } catch {
            /* ignore */
          }
        }
      }
    }

    this.ensureViewAddedToHost(sess.view)
    const bounds = {
      x: Math.round(rawLayout.x),
      y: Math.round(rawLayout.y),
      width: Math.max(40, Math.round(rawLayout.width)),
      height: Math.max(40, Math.round(rawLayout.height)),
    }
    sess.view.setBounds(bounds)
    sess.view.setVisible(true)
    const wasDocked = this.dockedLive && this.dockedView === sess.view
    this.dockedView = sess.view
    this.dockedSessionKey = sess.key
    this.dockedLive = true
    const layoutKey = `${bounds.width}x${bounds.height}`
    if (!wasDocked || !sess.lastScreenshotDataUrl || sess.lastCapturedLayoutKey !== layoutKey) {
      sess.lastCapturedLayoutKey = layoutKey
      if (this.postAttachTimer) clearTimeout(this.postAttachTimer)
      const targetCid = sess.conversationId
      this.postAttachTimer = setTimeout(() => {
        this.postAttachTimer = null
        if (!sess.pageOpen || !this.dockedLive || this.dockedView !== sess.view) return
        void this.capture(targetCid).then((snap) => this.onStateChange?.(snap))
      }, 150)
    }
  }

  async open(rawUrl: string, conversationId?: string): Promise<BrowserSnapshot> {
    const targetUrl = resolveBrowserInput(rawUrl, this.mode)

    if (this.isCdpMode()) {
      this.cdpLastRequestedUrl = targetUrl
      this.cdpLastError = undefined
      this.cdpPageOpen = true
      const wasRunning = Boolean(this.cdpPort && this.chromeProc && !this.chromeProc.killed)
      const client = await this.ensureCdpConnected(wasRunning ? undefined : targetUrl)
      if (wasRunning) {
        const navRes = await client.navigate(targetUrl)
        if (navRes.errorText) {
          this.cdpLastError = `${navRes.errorText} loading ${targetUrl}`
        }
        await client.bringToFront()
      } else {
        await new Promise((r) => setTimeout(r, 250))
        await client.bringToFront()
      }
      const snap = await this.captureCdp(true, conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    const sess = this.getOrCreateSession(conversationId)
    sess.lastRequestedUrl = targetUrl
    sess.lastError = undefined
    sess.pageOpen = true

    const seq = ++sess.openSeq
    const view = this.ensureView(sess)
    if (!this.popoutOpen() && this.hostWin && !this.hostWin.isDestroyed()) {
      if (
        sess.key === this.activeConversationKey &&
        this.lastLayout?.visible &&
        this.lastLayout.width >= 40 &&
        this.lastLayout.height >= 40
      ) {
        await this.syncLayout({ ...this.lastLayout, conversationId: sess.conversationId })
      } else if (this.dockedView !== view) {
        this.ensureViewAddedToHost(view)
        view.setBounds(DEFAULT_OFFSCREEN_BOUNDS)
        view.setVisible(false)
      }
    }
    this.schedulePush(sess.key, false)
    try {
      await view.webContents.loadURL(targetUrl)
      if (seq !== sess.openSeq || sess.view !== view) return this.state(sess.conversationId)
      if (view.webContents.isLoadingMainFrame()) {
        await this.waitLoad(sess, view.webContents, 5_000)
      } else {
        await new Promise((r) => setTimeout(r, 140))
      }
    } catch (err) {
      if (seq !== sess.openSeq || sess.view !== view) return this.state(sess.conversationId)
      const msg = err instanceof Error ? err.message : String(err)
      if (!/ERR_ABORTED|\(-3\)/.test(msg)) {
        const codeMatch = /\((-?\d+)\)/.exec(msg)
        const descMatch = /(ERR_[A-Z0-9_]+)/.exec(msg)
        sess.lastError = formatLoadError(
          targetUrl,
          codeMatch ? Number(codeMatch[1]) : -2,
          descMatch ? descMatch[1]! : msg,
        )
      }
    }
    if (seq !== sess.openSeq || sess.view !== view) return this.state(sess.conversationId)
    await this.capture(sess.conversationId)
    if (!sess.lastScreenshotDataUrl && seq === sess.openSeq && !view.webContents.isDestroyed()) {
      await new Promise((r) => setTimeout(r, 120))
      await this.captureViewImage(sess, view.webContents)
    }
    if (seq !== sess.openSeq) return this.state(sess.conversationId)
    const finalSnap = this.state(sess.conversationId)
    this.onStateChange?.(finalSnap)
    return finalSnap
  }

  async action(act: BrowserActionInput, conversationId?: string): Promise<BrowserSnapshot> {
    const cid = act.conversationId ?? conversationId
    if (act.kind === 'setMode' && act.mode) {
      return this.setMode(act.mode, { navigateIfHome: true, conversationId: cid })
    }
    if (this.isCdpMode()) {
      return this.actionCdp(act, cid)
    }
    const sess = this.getOrCreateSession(cid)
    return this.actionElectron(sess, act)
  }

  private async actionCdp(act: BrowserActionInput, conversationId?: string): Promise<BrowserSnapshot> {
    if (act.kind === 'close') {
      const wsUrl = this.cdpBrowserWsUrl
      const proc = this.chromeProc
      this.resetCdpState()
      this.cdpLastError = undefined
      if (wsUrl) await gracefulCloseBrowser(wsUrl)
      setTimeout(() => {
        try {
          if (proc && !proc.killed) proc.kill()
        } catch {
          /* ignore */
        }
      }, 400)
      const closed = this.closedState()
      this.onStateChange?.(closed)
      return closed
    }

    if (act.kind === 'launch') {
      this.cdpLastError = undefined
      const initialUrl = act.text?.trim() ? resolveBrowserInput(act.text, this.mode) : undefined
      const client = await this.ensureCdpConnected(initialUrl)
      if (initialUrl && !this.cdpUrl.startsWith(initialUrl)) {
        await client.navigate(initialUrl)
      }
      await client.bringToFront()
      await new Promise((r) => setTimeout(r, 180))
      const snap = await this.captureCdp(true, conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    const client = await this.ensureCdpConnected()
    this.cdpLastError = undefined

    if (act.kind === 'newTab') {
      const tabUrl = act.text?.trim() ? resolveBrowserInput(act.text, this.mode) : getBrowserProfile(this.mode).homeUrl
      const created = await createCdpTab(this.cdpPort, tabUrl)
      if (created) {
        await activateCdpTab(this.cdpPort, created.id)
        const nextClient = await this.connectToTarget(created)
        await nextClient.bringToFront()
        await new Promise((r) => setTimeout(r, 220))
      }
      const snap = await this.captureCdp(true, conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    if (act.kind === 'switchTab' && act.tabId) {
      await activateCdpTab(this.cdpPort, act.tabId)
      const targets = await listCdpPageTargets(this.cdpPort).catch(() => [])
      const target = targets.find((t) => t.id === act.tabId)
      if (target) {
        const nextClient = await this.connectToTarget(target)
        await nextClient.bringToFront()
      }
      const snap = await this.captureCdp(true, conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    if (act.kind === 'closeTab' && act.tabId) {
      await closeCdpTab(this.cdpPort, act.tabId)
      await new Promise((r) => setTimeout(r, 140))
      const remaining = await listCdpPageTargets(this.cdpPort).catch(() => [])
      if (remaining.length === 0) {
        return this.actionCdp({ kind: 'close' }, conversationId)
      }
      const next = remaining[0]!
      await activateCdpTab(this.cdpPort, next.id)
      await this.connectToTarget(next)
      const snap = await this.captureCdp(true, conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    if (act.kind === 'back') {
      const nav = await client.getNavState()
      const prev = nav.entries[nav.currentIndex - 1]
      if (prev) {
        await client.call('Page.navigateToHistoryEntry', { entryId: prev.id })
        await new Promise((r) => setTimeout(r, 280))
      }
      return this.captureCdp(true, conversationId)
    }

    if (act.kind === 'forward') {
      const nav = await client.getNavState()
      const next = nav.entries[nav.currentIndex + 1]
      if (next) {
        await client.call('Page.navigateToHistoryEntry', { entryId: next.id })
        await new Promise((r) => setTimeout(r, 280))
      }
      return this.captureCdp(true, conversationId)
    }

    if (act.kind === 'reload') {
      await client.call('Page.reload')
      await new Promise((r) => setTimeout(r, 320))
      return this.captureCdp(true, conversationId)
    }

    if (act.kind === 'scroll') {
      const dy = typeof act.deltaY === 'number' && Number.isFinite(act.deltaY) ? act.deltaY : 480
      await client.scrollBy(dy)
      await new Promise((r) => setTimeout(r, 140))
      return this.captureCdp(true, conversationId)
    }

    if (act.kind === 'clickPoint' || act.kind === 'doubleClickPoint' || act.kind === 'rightClickPoint') {
      const rx = Math.max(0, Math.min(1, Number(act.xRatio ?? 0.5)))
      const ry = Math.max(0, Math.min(1, Number(act.yRatio ?? 0.5)))
      this.cdpCursor = {
        x: Math.round(rx * 960),
        y: Math.round(ry * 640),
        xRatio: rx,
        yRatio: ry,
        action: act.kind === 'doubleClickPoint' ? 'double_click' : act.kind === 'rightClickPoint' ? 'right_click' : 'click',
        updatedAt: Date.now(),
      }
      await client.clickAtRatio(rx, ry)
      await new Promise((r) => setTimeout(r, 240))
      return this.captureCdp(true, conversationId)
    }

    const targetSel = act.ref ? `[data-atrium-ref=${JSON.stringify(act.ref)}]` : act.selector ?? ''
    if (!targetSel) throw new Error('Target ref or CSS selector is required.')

    if (act.kind === 'click') {
      const clicked = await client.evaluate<boolean>(buildClickScript(targetSel))
      if (!clicked) throw new Error(`Element not found: ${act.ref ?? act.selector}`)
      await new Promise((r) => setTimeout(r, 240))
      return this.captureCdp(true, conversationId)
    }

    if (act.kind === 'type') {
      const typed = await client.evaluate<{ ok: boolean }>(buildTypeScript(targetSel, act.text ?? ''))
      if (!typed?.ok) throw new Error(`Input not found: ${act.ref ?? act.selector}`)
      await new Promise((r) => setTimeout(r, 160))
      return this.captureCdp(true, conversationId)
    }

    return this.captureCdp(true, conversationId)
  }

  private destroySessionTabs(sess: ElectronSessionState): void {
    const t = this.pushTimers.get(sess.key)
    if (t) {
      clearTimeout(t)
      this.pushTimers.delete(sess.key)
    }
    const tabs = [...sess.embeddedTabs]
    sess.embeddedTabs = []
    sess.activeTabId = ''
    if (sess.view && this.dockedView === sess.view) {
      this.hideDockedView()
    }
    if (sess.view && !tabs.some((tab) => tab.view === sess.view)) {
      this.removeViewFromHost(sess.view)
      if (!sess.view.webContents.isDestroyed()) {
        sess.view.webContents.close()
      }
    }
    for (const tab of tabs) {
      if (this.dockedView === tab.view) this.hideDockedView()
      this.removeViewFromHost(tab.view)
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.close()
      }
    }
    sess.view = null
  }

  private async actionElectron(sess: ElectronSessionState, act: BrowserActionInput): Promise<BrowserSnapshot> {
    if (act.kind === 'close') {
      ++sess.openSeq
      this.destroySessionTabs(sess)
      sess.pageOpen = false
      sess.lastElements = []
      sess.cursor = undefined
      this.clearScreenshotCache(sess)
      sess.lastCapturedLayoutKey = ''
      sess.lastError = undefined
      if (sess.key !== DEFAULT_CONVERSATION_KEY) {
        this.sessions.delete(sess.key)
      }
      const closed = this.closedState(sess)
      this.onStateChange?.(closed)
      return closed
    }

    if (act.kind === 'launch') {
      return this.open(act.text?.trim() || getBrowserProfile(this.mode).homeUrl, sess.conversationId)
    }

    if (act.kind === 'newTab') {
      ++sess.openSeq
      this.createEmbeddedTab(sess)
      this.clearScreenshotCache(sess)
      sess.lastElements = []
      sess.cursor = undefined
      sess.pageOpen = true
      return this.open(act.text?.trim() || getBrowserProfile(this.mode).homeUrl, sess.conversationId)
    }

    if (act.kind === 'switchTab' && act.tabId) {
      ++sess.openSeq
      this.pruneEmbeddedTabs(sess)
      const target = sess.embeddedTabs.find((t) => t.id === act.tabId)
      if (target) {
        if (sess.view !== target.view) {
          if (sess.view && this.dockedView === sess.view) {
            this.hideDockedView()
          }
          sess.activeTabId = target.id
          sess.view = target.view
          this.clearScreenshotCache(sess)
          sess.lastElements = []
          sess.cursor = undefined
        }
        sess.lastError = undefined
        sess.pageOpen = true
        if (sess.key === this.activeConversationKey && this.lastLayout?.visible) {
          await this.syncLayout({ ...this.lastLayout, conversationId: sess.conversationId })
        }
      }
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    if (act.kind === 'closeTab' && act.tabId) {
      ++sess.openSeq
      this.pruneEmbeddedTabs(sess)
      const idx = sess.embeddedTabs.findIndex((t) => t.id === act.tabId)
      if (idx === -1) {
        const snap = await this.capture(sess.conversationId)
        this.onStateChange?.(snap)
        return snap
      }
      if (sess.embeddedTabs.length <= 1) {
        return this.actionElectron(sess, { kind: 'close', conversationId: sess.conversationId })
      }
      const [removed] = sess.embeddedTabs.splice(idx, 1)
      if (removed) {
        if (this.dockedView === removed.view) {
          this.hideDockedView()
        }
        if (removed.view === sess.view) sess.view = null
        this.removeViewFromHost(removed.view)
        if (!removed.view.webContents.isDestroyed()) {
          removed.view.webContents.close()
        }
      }
      if (sess.activeTabId === act.tabId || !sess.embeddedTabs.some((t) => t.id === sess.activeTabId)) {
        const next = sess.embeddedTabs[Math.min(idx, sess.embeddedTabs.length - 1)]!
        sess.activeTabId = next.id
        sess.view = next.view
        this.clearScreenshotCache(sess)
        sess.lastElements = []
        sess.cursor = undefined
        sess.lastError = undefined
        if (sess.key === this.activeConversationKey && this.lastLayout?.visible) {
          await this.syncLayout({ ...this.lastLayout, conversationId: sess.conversationId })
        }
      }
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    const view = sess.pageOpen && sess.view && !sess.view.webContents.isDestroyed() ? sess.view : null
    if (!view) throw new Error('No browser page is open yet. Open a URL first.')
    const wc = view.webContents
    const nav = wc.navigationHistory
    sess.lastError = undefined

    if (act.kind === 'back') {
      if (nav?.canGoBack()) {
        nav.goBack()
        await this.waitLoad(sess, wc, 6_000)
      }
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'forward') {
      if (nav?.canGoForward()) {
        nav.goForward()
        await this.waitLoad(sess, wc, 6_000)
      }
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'reload') {
      wc.reload()
      await this.waitLoad(sess, wc, 8_000)
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'scroll') {
      const dy = typeof act.deltaY === 'number' && Number.isFinite(act.deltaY) ? act.deltaY : 480
      const dx = typeof act.deltaX === 'number' && Number.isFinite(act.deltaX) ? act.deltaX : 0
      const ptInfo =
        act.xRatio !== undefined && act.yRatio !== undefined
          ? ((await wc.executeJavaScript(buildResolvePointScript(act.xRatio, act.yRatio))) as {
              x: number
              y: number
              vw: number
              vh: number
            })
          : ((await wc.executeJavaScript(
              `({ x: ${Math.round((sess.cursor?.xRatio ?? 0.5) * (sess.lastScreenshotWidth || 960))}, y: ${Math.round((sess.cursor?.yRatio ?? 0.5) * (sess.lastScreenshotHeight || 640))}, vw: window.innerWidth || 960, vh: window.innerHeight || 640 })`,
            )) as { x: number; y: number; vw: number; vh: number })
      await this.updateVirtualCursor(sess, wc, {
        x: ptInfo.x,
        y: ptInfo.y,
        vw: ptInfo.vw,
        vh: ptInfo.vh,
        action: 'scroll',
        targetLabel: dy >= 0 ? `↓${Math.abs(Math.round(dy))}px` : `↑${Math.abs(Math.round(dy))}px`,
      })
      await wc.executeJavaScript(`window.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' })`)
      await new Promise((r) => setTimeout(r, 150))
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'key') {
      const key = act.key?.trim() ?? ''
      if (!key) throw new Error('`key` is required.')
      const vw = sess.lastScreenshotWidth || 960
      const vh = sess.lastScreenshotHeight || 640
      const cx = Math.round((sess.cursor?.xRatio ?? 0.5) * vw)
      const cy = Math.round((sess.cursor?.yRatio ?? 0.5) * vh)
      await this.updateVirtualCursor(sess, wc, {
        x: cx,
        y: cy,
        vw,
        vh,
        action: 'key',
        targetLabel: key,
      })
      sendElectronKey(wc, key)
      await new Promise((r) => setTimeout(r, 80))
      if (wc.isLoadingMainFrame()) await this.waitLoad(sess, wc, 4_500)
      else await new Promise((r) => setTimeout(r, 100))
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'movePoint') {
      const coords =
        act.ref || act.selector
          ? ((await wc.executeJavaScript(
              buildResolveTargetScript(act.ref ? `[data-atrium-ref=${JSON.stringify(act.ref)}]` : act.selector ?? ''),
            )) as { found: boolean; x: number; y: number; vw: number; vh: number; label: string })
          : ((await wc.executeJavaScript(
              buildResolvePointScript(
                Math.max(0, Math.min(1, Number(act.xRatio ?? 0.5))),
                Math.max(0, Math.min(1, Number(act.yRatio ?? 0.5))),
              ),
            )) as { found: boolean; x: number; y: number; vw: number; vh: number; label: string })
      if ((act.ref || act.selector) && !coords.found) {
        throw new Error(`Element not found: ${act.ref ?? act.selector}`)
      }
      await this.updateVirtualCursor(sess, wc, {
        x: coords.x,
        y: coords.y,
        vw: coords.vw,
        vh: coords.vh,
        action: 'hover',
        targetLabel: coords.label || act.ref,
      })
      wc.sendInputEvent({ type: 'mouseMove', x: coords.x, y: coords.y })
      await new Promise((r) => setTimeout(r, 120))
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'dragPoint') {
      const rx1 = Math.max(0, Math.min(1, Number(act.xRatio ?? 0.5)))
      const ry1 = Math.max(0, Math.min(1, Number(act.yRatio ?? 0.5)))
      const rx2 = Math.max(0, Math.min(1, Number(act.endXRatio ?? rx1)))
      const ry2 = Math.max(0, Math.min(1, Number(act.endYRatio ?? ry1)))
      const startPt = (await wc.executeJavaScript(buildResolvePointScript(rx1, ry1))) as {
        x: number
        y: number
        vw: number
        vh: number
        label: string
      }
      const ex = Math.max(0, Math.min(startPt.vw - 1, Math.round(startPt.vw * rx2)))
      const ey = Math.max(0, Math.min(startPt.vh - 1, Math.round(startPt.vh * ry2)))
      await this.updateVirtualCursor(sess, wc, {
        x: startPt.x,
        y: startPt.y,
        endX: ex,
        endY: ey,
        vw: startPt.vw,
        vh: startPt.vh,
        action: 'drag',
        targetLabel: startPt.label,
      })
      wc.sendInputEvent({ type: 'mouseMove', x: startPt.x, y: startPt.y })
      wc.sendInputEvent({ type: 'mouseDown', x: startPt.x, y: startPt.y, button: 'left', clickCount: 1 })
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        const ix = Math.round(startPt.x + ((ex - startPt.x) * i) / steps)
        const iy = Math.round(startPt.y + ((ey - startPt.y) * i) / steps)
        wc.sendInputEvent({ type: 'mouseMove', x: ix, y: iy })
        await new Promise((r) => setTimeout(r, 18))
      }
      wc.sendInputEvent({ type: 'mouseUp', x: ex, y: ey, button: 'left', clickCount: 1 })
      await this.updateVirtualCursor(sess, wc, {
        x: ex,
        y: ey,
        vw: startPt.vw,
        vh: startPt.vh,
        action: 'drag',
        targetLabel: startPt.label,
      })
      await new Promise((r) => setTimeout(r, 120))
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'clickPoint' || act.kind === 'doubleClickPoint' || act.kind === 'rightClickPoint') {
      const rx = Math.max(0, Math.min(1, Number(act.xRatio ?? 0.5)))
      const ry = Math.max(0, Math.min(1, Number(act.yRatio ?? 0.5)))
      const coords = (await wc.executeJavaScript(buildResolvePointScript(rx, ry))) as {
        x: number
        y: number
        vw: number
        vh: number
        label: string
        found: boolean
      }
      const isRight = act.kind === 'rightClickPoint' || act.button === 'right'
      const isMiddle = act.button === 'middle'
      const isDouble = act.kind === 'doubleClickPoint' || act.doubleClick === true
      const cursorAction: BrowserCursorAction = isDouble ? 'double_click' : isRight ? 'right_click' : 'click'
      await this.updateVirtualCursor(sess, wc, {
        x: coords.x,
        y: coords.y,
        vw: coords.vw,
        vh: coords.vh,
        action: cursorAction,
        targetLabel: coords.label,
      })
      const btn: 'left' | 'right' | 'middle' = isRight ? 'right' : isMiddle ? 'middle' : 'left'
      wc.sendInputEvent({ type: 'mouseMove', x: coords.x, y: coords.y })
      wc.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: btn, clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: btn, clickCount: 1 })
      if (isDouble) {
        await new Promise((r) => setTimeout(r, 35))
        wc.sendInputEvent({ type: 'mouseDown', x: coords.x, y: coords.y, button: btn, clickCount: 2 })
        wc.sendInputEvent({ type: 'mouseUp', x: coords.x, y: coords.y, button: btn, clickCount: 2 })
      }
      await new Promise((r) => setTimeout(r, 60))
      if (wc.isLoadingMainFrame()) await this.waitLoad(sess, wc, 4_500)
      else await new Promise((r) => setTimeout(r, 110))
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    if (act.kind === 'type' && act.xRatio !== undefined && act.yRatio !== undefined && !act.ref && !act.selector) {
      const res = (await wc.executeJavaScript(
        buildTypeAtPointScript(
          Math.max(0, Math.min(1, act.xRatio)),
          Math.max(0, Math.min(1, act.yRatio)),
          act.text ?? '',
        ),
      )) as { ok: boolean; x: number; y: number; vw: number; vh: number; label: string }
      if (!res?.ok) throw new Error('Input element not found at target coordinates.')
      await this.updateVirtualCursor(sess, wc, {
        x: res.x,
        y: res.y,
        vw: res.vw,
        vh: res.vh,
        action: 'type',
        targetLabel: res.label,
      })
      if (act.submit) {
        sendElectronKey(wc, 'Enter')
        await new Promise((r) => setTimeout(r, 80))
        if (wc.isLoadingMainFrame()) await this.waitLoad(sess, wc, 4_500)
      } else {
        await new Promise((r) => setTimeout(r, 140))
      }
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }

    const targetSel = act.ref ? `[data-atrium-ref=${JSON.stringify(act.ref)}]` : act.selector ?? ''
    if (!targetSel) throw new Error('Target ref or CSS selector is required.')

    if (act.kind === 'click') {
      const targetInfo = (await wc.executeJavaScript(buildResolveTargetScript(targetSel))) as {
        found: boolean
        x: number
        y: number
        vw: number
        vh: number
        label: string
      }
      if (!targetInfo?.found) throw new Error(`Element not found: ${act.ref ?? act.selector}`)
      const isRight = act.button === 'right'
      const isDouble = act.doubleClick === true
      const cursorAction: BrowserCursorAction = isDouble ? 'double_click' : isRight ? 'right_click' : 'click'
      await this.updateVirtualCursor(sess, wc, {
        x: targetInfo.x,
        y: targetInfo.y,
        vw: targetInfo.vw,
        vh: targetInfo.vh,
        action: cursorAction,
        targetLabel: targetInfo.label || act.ref,
      })
      const btn: 'left' | 'right' | 'middle' = isRight ? 'right' : act.button === 'middle' ? 'middle' : 'left'
      wc.sendInputEvent({ type: 'mouseMove', x: targetInfo.x, y: targetInfo.y })
      wc.sendInputEvent({ type: 'mouseDown', x: targetInfo.x, y: targetInfo.y, button: btn, clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: targetInfo.x, y: targetInfo.y, button: btn, clickCount: 1 })
      if (isDouble) {
        await new Promise((r) => setTimeout(r, 35))
        wc.sendInputEvent({ type: 'mouseDown', x: targetInfo.x, y: targetInfo.y, button: btn, clickCount: 2 })
        wc.sendInputEvent({ type: 'mouseUp', x: targetInfo.x, y: targetInfo.y, button: btn, clickCount: 2 })
      }
      await new Promise((r) => setTimeout(r, 60))
      if (wc.isLoadingMainFrame()) await this.waitLoad(sess, wc, 4_500)
      else await new Promise((r) => setTimeout(r, 110))
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    if (act.kind === 'type') {
      const typed = (await wc.executeJavaScript(buildTypeScript(targetSel, act.text ?? ''))) as {
        ok: boolean
        x: number
        y: number
        vw: number
        vh: number
        label: string
      }
      if (!typed?.ok) throw new Error(`Input not found: ${act.ref ?? act.selector}`)
      await this.updateVirtualCursor(sess, wc, {
        x: typed.x,
        y: typed.y,
        vw: typed.vw,
        vh: typed.vh,
        action: 'type',
        targetLabel: typed.label || act.ref,
      })
      if (act.submit) {
        sendElectronKey(wc, 'Enter')
        await new Promise((r) => setTimeout(r, 80))
        if (wc.isLoadingMainFrame()) await this.waitLoad(sess, wc, 4_500)
      } else {
        await new Promise((r) => setTimeout(r, 140))
      }
      const snap = await this.capture(sess.conversationId)
      this.onStateChange?.(snap)
      return snap
    }
    const snap = await this.capture(sess.conversationId)
    this.onStateChange?.(snap)
    return snap
  }

  async evalScript(script: string, conversationId?: string): Promise<{ value: string; isError?: boolean }> {
    if (this.isCdpMode()) {
      if (!this.cdpPageOpen || !this.cdpClient) {
        return { value: 'No browser page is open yet. Call browser_open first.', isError: true }
      }
      try {
        const res = await this.cdpClient.evaluate(`(async () => { return (${script}); })()`)
        if (res === undefined) return { value: 'undefined' }
        if (typeof res === 'string') return { value: res }
        return { value: JSON.stringify(res, null, 2) }
      } catch (err) {
        return { value: err instanceof Error ? err.message : String(err), isError: true }
      }
    }

    const sess = this.sessions.get(this.resolveSessionKey(conversationId))
    const view = sess?.pageOpen && sess.view && !sess.view.webContents.isDestroyed() ? sess.view : null
    if (!view) return { value: 'No browser page is open yet. Call browser_open first.', isError: true }
    try {
      const res = await view.webContents.executeJavaScript(`(async () => { return (${script}); })()`)
      if (res === undefined) return { value: 'undefined' }
      if (typeof res === 'string') return { value: res }
      return { value: JSON.stringify(res, null, 2) }
    } catch (err) {
      return { value: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  openInteractiveWindow(rawUrl?: string, conversationId?: string): void {
    if (this.isCdpMode()) {
      const clean = rawUrl?.trim()
      if (!this.cdpPageOpen) {
        void this.actionCdp({ kind: 'launch', ...(clean ? { text: clean } : {}) }, conversationId).catch(() => undefined)
        return
      }
      if (clean && !this.cdpUrl.startsWith(clean)) {
        void this.open(clean, conversationId).catch(() => undefined)
        return
      }
      void this.cdpClient?.bringToFront()
      return
    }

    const clean = rawUrl?.trim()
    const sess = this.getOrCreateSession(conversationId)
    if (clean) {
      void this.open(clean, sess.conversationId).catch(() => undefined)
      return
    }
    if (!sess.pageOpen) {
      void this.open(getBrowserProfile(this.mode).homeUrl, sess.conversationId).catch(() => undefined)
      return
    }
    if (this.lastLayout?.visible) {
      void this.syncLayout({ ...this.lastLayout, conversationId: sess.conversationId })
    }
    this.onStateChange?.(this.state(sess.conversationId))
  }

  dockBackFromPopout(): void {
    if (this.popoutWin && !this.popoutWin.isDestroyed()) {
      this.popoutWin.close()
    }
  }

  dispose(): void {
    for (const timer of this.pushTimers.values()) clearTimeout(timer)
    this.pushTimers.clear()
    if (this.postAttachTimer) clearTimeout(this.postAttachTimer)
    this.stopCdpMirrorLoop()

    const wsUrl = this.cdpBrowserWsUrl
    const proc = this.chromeProc
    this.cdpClient?.closeSocket()
    this.cdpClient = null
    this.chromeProc = null
    this.cdpPort = 0
    this.cdpBrowserWsUrl = undefined
    if (wsUrl) void gracefulCloseBrowser(wsUrl)
    if (proc && !proc.killed) {
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill()
        } catch {
          /* ignore */
        }
      }, 300)
    }

    if (this.popoutWin && !this.popoutWin.isDestroyed()) {
      const pop = this.popoutWin
      this.popoutWin = null
      pop.destroy()
    }
    for (const sess of [...this.sessions.values()]) {
      this.destroySessionTabs(sess)
    }
    this.sessions.clear()
  }
}
