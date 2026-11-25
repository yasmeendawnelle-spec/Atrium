// Chrome DevTools Protocol (CDP) launcher & page controller for real Google Chrome / Edge windows.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import net from 'node:net'
import { join, win32 as win32Path } from 'node:path'
import type { BrowserEngine } from '../shared/types.ts'

export interface ChromeBinaryInfo {
  path: string
  label: string
  engine: Exclude<BrowserEngine, 'electron'>
}

export interface CdpRawTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export function chromeCandidatePaths(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  preferEngine?: Exclude<BrowserEngine, 'electron'>,
): ChromeBinaryInfo[] {
  const out: ChromeBinaryInfo[] = []
  const override = env.ATRIUM_CHROME_PATH?.trim()
  if (override) {
    const low = override.toLowerCase()
    out.push({
      path: override,
      label: low.includes('msedge') ? 'Microsoft Edge' : 'Google Chrome',
      engine: low.includes('msedge') ? 'edge-cdp' : 'chrome-cdp',
    })
  }

  let detected: ChromeBinaryInfo[]
  if (platform === 'win32') {
    const pf = env.PROGRAMFILES || 'C:\\Program Files'
    const pf86 = env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const local = env.LOCALAPPDATA || ''
    const winChrome: ChromeBinaryInfo[] = [
      win32Path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32Path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(local ? [win32Path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    ].map((p) => ({ path: p, label: 'Google Chrome', engine: 'chrome-cdp' }))

    const winEdge: ChromeBinaryInfo[] = [
      win32Path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      win32Path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...(local ? [win32Path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
    ].map((p) => ({ path: p, label: 'Microsoft Edge', engine: 'edge-cdp' }))

    detected = preferEngine === 'edge-cdp' ? [...winEdge, ...winChrome] : [...winChrome, ...winEdge]
  } else if (platform === 'darwin') {
    const macChrome: ChromeBinaryInfo[] = [
      {
        path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        label: 'Google Chrome',
        engine: 'chrome-cdp',
      },
      {
        path: '/Applications/Chromium.app/Contents/MacOS/Chromium',
        label: 'Chromium',
        engine: 'chrome-cdp',
      },
    ]
    const macEdge: ChromeBinaryInfo[] = [
      {
        path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        label: 'Microsoft Edge',
        engine: 'edge-cdp',
      },
    ]
    detected = preferEngine === 'edge-cdp' ? [...macEdge, ...macChrome] : [...macChrome, ...macEdge]
  } else {
    const linuxChrome: ChromeBinaryInfo[] = [
      { path: '/usr/bin/google-chrome', label: 'Google Chrome', engine: 'chrome-cdp' },
      { path: '/usr/bin/google-chrome-stable', label: 'Google Chrome', engine: 'chrome-cdp' },
      { path: '/usr/bin/chromium', label: 'Chromium', engine: 'chrome-cdp' },
      { path: '/usr/bin/chromium-browser', label: 'Chromium', engine: 'chrome-cdp' },
    ]
    const linuxEdge: ChromeBinaryInfo[] = [
      { path: '/usr/bin/microsoft-edge', label: 'Microsoft Edge', engine: 'edge-cdp' },
    ]
    detected = preferEngine === 'edge-cdp' ? [...linuxEdge, ...linuxChrome] : [...linuxChrome, ...linuxEdge]
  }
  return [...out, ...detected]
}

export function pickChromeBinary(
  candidates: ChromeBinaryInfo[],
  exists: (path: string) => boolean = existsSync,
): ChromeBinaryInfo | null {
  for (const cand of candidates) {
    if (cand.path && exists(cand.path)) return cand
  }
  return null
}

export function findInstalledChrome(preferEngine?: Exclude<BrowserEngine, 'electron'>): ChromeBinaryInfo | null {
  return pickChromeBinary(chromeCandidatePaths(process.platform, process.env, preferEngine))
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('Failed to allocate loopback debugging port.'))
      })
    })
  })
}

export async function listCdpPageTargets(port: number): Promise<CdpRawTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) })
  if (!res.ok) return []
  const data = (await res.json()) as CdpRawTarget[]
  return data.filter(
    (t) =>
      t.type === 'page' &&
      Boolean(t.webSocketDebuggerUrl) &&
      !t.url.startsWith('devtools://') &&
      !t.url.startsWith('chrome-extension://'),
  )
}

export async function fetchCdpBrowserWsUrl(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return undefined
    const json = (await res.json()) as { webSocketDebuggerUrl?: string }
    return json.webSocketDebuggerUrl
  } catch {
    return undefined
  }
}

export async function createCdpTab(port: number, url?: string): Promise<CdpRawTarget | null> {
  const targetUrl = url ? encodeURIComponent(url) : ''
  const endpoint = targetUrl
    ? `http://127.0.0.1:${port}/json/new?${targetUrl}`
    : `http://127.0.0.1:${port}/json/new`
  // Chrome >=115 requires PUT for /json/new cleanly; try PUT first, fallback GET.
  let res = await fetch(endpoint, { method: 'PUT', signal: AbortSignal.timeout(4000) })
  if (res.status === 405) {
    res = await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(4000) })
  }
  if (!res.ok) return null
  return (await res.json()) as CdpRawTarget
}

export async function activateCdpTab(port: number, tabId: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/activate/${encodeURIComponent(tabId)}`, {
    signal: AbortSignal.timeout(2500),
  }).catch(() => undefined)
}

export async function closeCdpTab(port: number, tabId: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(tabId)}`, {
    signal: AbortSignal.timeout(2500),
  }).catch(() => undefined)
}

export async function gracefulCloseBrowser(browserWsUrl: string): Promise<void> {
  const client = await CdpPageClient.connect(browserWsUrl, 2000).catch(() => null)
  if (!client) return
  try {
    await client.call('Browser.close', {}, 1500)
  } catch {
    /* ignore */
  } finally {
    client.closeSocket()
  }
}

export interface LaunchedChrome {
  port: number
  process: ChildProcess
  browserWsUrl?: string
  initialTarget: CdpRawTarget
}

export async function launchChromeWithCdp(opts: {
  executablePath: string
  userDataDir: string
  initialUrl?: string
}): Promise<LaunchedChrome> {
  mkdirSync(opts.userDataDir, { recursive: true })
  const port = await allocateLoopbackPort()
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1200,800',
    ...(opts.initialUrl ? [opts.initialUrl] : []),
  ]
  const child = spawn(opts.executablePath, args, {
    stdio: 'ignore',
    windowsHide: false,
  })

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !exited) {
    try {
      const targets = await listCdpPageTargets(port)
      if (targets.length > 0 && targets[0]) {
        const browserWsUrl = await fetchCdpBrowserWsUrl(port)
        return { port, process: child, browserWsUrl, initialTarget: targets[0] }
      }
    } catch {
      /* waiting for DevTools endpoint */
    }
    await new Promise((r) => setTimeout(r, 120))
  }

  try {
    child.kill()
  } catch {
    /* ignore */
  }
  throw new Error('Timed out waiting for Google Chrome DevTools connection.')
}

interface PendingRpc {
  resolve: (value: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class CdpPageClient {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, PendingRpc>()
  private eventListeners = new Set<(method: string, params: Record<string, unknown>) => void>()
  private closeListeners = new Set<() => void>()
  private closed = false

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } }
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg
      } catch {
        return
      }
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'))
        else entry.resolve(msg.result ?? {})
        return
      }
      if (msg.method) {
        const params = msg.params ?? {}
        for (const cb of this.eventListeners) cb(msg.method, params)
      }
    })
    const onClosed = () => {
      if (this.closed) return
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('CDP connection closed.'))
      }
      this.pending.clear()
      for (const cb of this.closeListeners) cb()
    }
    ws.addEventListener('close', onClosed, { once: true })
    ws.addEventListener('error', onClosed, { once: true })
  }

  static connect(wsUrl: string, timeoutMs = 6000): Promise<CdpPageClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new Error('Timed out connecting to Chrome tab WebSocket.'))
      }, timeoutMs)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve(new CdpPageClient(ws))
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('Failed to connect to Chrome tab WebSocket.'))
        },
        { once: true },
      )
    })
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN
  }

  onEvent(cb: (method: string, params: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb)
    return () => this.closeListeners.delete(cb)
  }

  call<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.isOpen()) return Promise.reject(new Error('Chrome tab disconnected.'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP timeout on ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: Record<string, unknown>) => void,
        reject,
        timer,
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async enable(): Promise<void> {
    await Promise.allSettled([
      this.call('Page.enable'),
      this.call('Runtime.enable'),
      this.call('Log.enable'),
    ])
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.call<{
      result?: { value?: T; type?: string; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ||
          res.exceptionDetails.text ||
          'JavaScript evaluation failed.',
      )
    }
    return res.result?.value as T
  }

  async getNavState(): Promise<{
    url: string
    title: string
    canGoBack: boolean
    canGoForward: boolean
    currentIndex: number
    entries: { id: number; url: string; title: string }[]
  }> {
    const hist = await this.call<{
      currentIndex?: number
      entries?: { id: number; url: string; title: string }[]
    }>('Page.getNavigationHistory').catch(() => ({ currentIndex: 0, entries: [] }))
    const entries = Array.isArray(hist.entries) ? hist.entries : []
    const idx = typeof hist.currentIndex === 'number' ? hist.currentIndex : 0
    const cur = entries[idx]
    return {
      url: cur?.url ?? '',
      title: cur?.title ?? '',
      canGoBack: idx > 0,
      canGoForward: idx < entries.length - 1,
      currentIndex: idx,
      entries,
    }
  }

  async navigate(url: string, waitMs = 6000): Promise<{ errorText?: string }> {
    let settled = false
    let settleFn: (() => void) | undefined
    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          off()
          resolve()
        }
      }, waitMs)
      settleFn = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          off()
          setTimeout(resolve, 160)
        }
      }
      const off = this.onEvent((method) => {
        if (method === 'Page.frameStoppedLoading' || method === 'Page.loadEventFired') {
          settleFn?.()
        }
      })
    })
    const res = await this.call<{ errorText?: string }>('Page.navigate', { url })
    if (res.errorText) {
      settleFn?.()
      return { errorText: res.errorText }
    }
    await loaded
    return {}
  }

  async captureScreenshot(): Promise<string | undefined> {
    const res = await this.call<{ data?: string }>('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 82,
    }).catch(() => null)
    if (!res?.data) return undefined
    return `data:image/jpeg;base64,${res.data}`
  }

  async clickAtRatio(xRatio: number, yRatio: number): Promise<void> {
    const metrics = await this.evaluate<{ w: number; h: number }>(
      '({ w: window.innerWidth || 1200, h: window.innerHeight || 800 })',
    ).catch(() => ({ w: 1200, h: 800 }))
    const x = Math.max(1, Math.min(metrics.w - 1, Math.round(metrics.w * xRatio)))
    const y = Math.max(1, Math.min(metrics.h - 1, Math.round(metrics.h * yRatio)))
    await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  async scrollBy(deltaY: number): Promise<void> {
    const metrics = await this.evaluate<{ w: number; h: number }>(
      '({ w: window.innerWidth || 1200, h: window.innerHeight || 800 })',
    ).catch(() => ({ w: 1200, h: 800 }))
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(metrics.w / 2),
      y: Math.round(metrics.h / 2),
      deltaX: 0,
      deltaY,
    }).catch(async () => {
      await this.evaluate(`window.scrollBy({ top: ${Math.round(deltaY)}, behavior: 'instant' })`)
    })
  }

  async bringToFront(): Promise<void> {
    await this.call('Page.bringToFront').catch(() => undefined)
  }

  closeSocket(): void {
    this.closed = true
    for (const [, p] of this.pending) clearTimeout(p.timer)
    this.pending.clear()
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
    } catch {
      /* ignore */
    }
  }
}
