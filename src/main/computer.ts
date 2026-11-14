// Main-process OS Desktop Computer Use controller: multi-monitor screen capture,
// coordinate translation, Win32 input dispatch, floating always-on-top stop HUD, and panic shortcut.
import { app, BrowserWindow, desktopCapturer, globalShortcut, nativeTheme, screen, type Display } from 'electron'
import {
  computeScreenshotDimensions,
  mapDipPointToScreenshot,
  mapDipRectToScreenshot,
  mapScreenshotPointToDip,
} from '../shared/desktopGeometry.ts'
import type {
  ComputerUseHudState,
  DesktopDisplayInfo,
  DesktopKeyboardInput,
  DesktopMouseInput,
  DesktopSnapshot,
  DesktopWindowInfo,
  DesktopWindowInput,
} from '../shared/types.ts'
import { resolveKeyChord, WinDesktopWorker } from './desktopDriver.ts'

const EMERGENCY_STOP_SHORTCUT = 'Alt+Shift+X'

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  )
}

function buildHudHtml(label: string, dark: boolean, zh: boolean): string {
  const bg = dark ? '#1f1e1b' : '#ffffff'
  const fg = dark ? '#f0efe9' : '#22211f'
  const border = dark ? 'rgba(255,255,255,0.16)' : 'rgba(28,25,20,0.14)'
  const badgeBg = dark ? 'rgba(255,255,255,0.08)' : 'rgba(28,25,20,0.06)'
  const title = label || (zh ? 'Atrium 正在控制桌面' : 'Atrium Computer Use')
  const stopText = zh ? '紧急停止' : 'Stop'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none}
    .pill{width:100%;height:100%;display:flex;align-items:center;gap:8px;padding:0 10px 0 12px;border-radius:999px;background:${bg};color:${fg};border:1px solid ${border};font-size:12px}
    .dot{width:8px;height:8px;border-radius:50%;background:#e0533c;flex:none;animation:pulse 1.3s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.45;transform:scale(0.82)}}
    .label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .kbd{font-size:10px;opacity:0.75;background:${badgeBg};padding:2px 6px;border-radius:6px;font-family:ui-monospace,Consolas,monospace;flex:none}
    .stop{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;background:#d9483b;color:#fff;font-size:11px;font-weight:600;text-decoration:none;flex:none}
    .stop:hover{background:#c23b2f}
  </style></head><body>
    <div class="pill">
      <span class="dot"></span>
      <span class="label" id="lbl">${escapeHtml(title)}</span>
      <span class="kbd">${EMERGENCY_STOP_SHORTCUT}</span>
      <a class="stop" href="hud://stop">${stopText}</a>
    </div>
  </body></html>`
}

export function matchTargetWindow(
  windows: DesktopWindowInfo[],
  query: Pick<DesktopWindowInput, 'handle' | 'title' | 'processName'>,
): DesktopWindowInfo | undefined {
  if (query.handle?.trim()) {
    const clean = query.handle.trim()
    const exact = windows.find((w) => w.hwnd === clean)
    if (exact) return exact
  }
  const titleNeedle = query.title?.trim().toLowerCase()
  const procNeedle = query.processName?.trim().toLowerCase()
  if (titleNeedle && procNeedle) {
    const both = windows.find(
      (w) => w.title.toLowerCase().includes(titleNeedle) && w.processName.toLowerCase().includes(procNeedle),
    )
    if (both) return both
  }
  if (titleNeedle) {
    const byTitle = windows.find((w) => w.title.toLowerCase().includes(titleNeedle))
    if (byTitle) return byTitle
  }
  if (procNeedle) {
    const byProc = windows.find((w) => w.processName.toLowerCase().includes(procNeedle))
    if (byProc) return byProc
  }
  return undefined
}

export class ComputerController {
  private readonly worker: WinDesktopWorker
  private readonly getMainWindows: () => BrowserWindow[]
  private readonly onEmergencyStop: () => void
  private readonly skipHud: boolean
  private readonly displayMeta = new Map<number, DesktopDisplayInfo>()
  private hudWin: BrowserWindow | null = null
  private hudVisible = false
  private hudLabel = ''
  private shortcutArmed = false
  private aborted = false

  constructor(opts: {
    userDataDir: string
    getMainWindows: () => BrowserWindow[]
    onEmergencyStop: () => void
    skipHud?: boolean
  }) {
    this.worker = new WinDesktopWorker(opts.userDataDir)
    this.getMainWindows = opts.getMainWindows
    this.onEmergencyStop = opts.onEmergencyStop
    this.skipHud = Boolean(opts.skipHud)
  }

  private orderedDisplays(): Display[] {
    const primary = screen.getPrimaryDisplay()
    const all = screen.getAllDisplays()
    const others = all
      .filter((d) => d.id !== primary.id)
      .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    return [primary, ...others]
  }

  private resolveDisplay(displayIndex?: number): { index: number; display: Display; all: DesktopDisplayInfo[] } {
    const ordered = this.orderedDisplays()
    const idx =
      typeof displayIndex === 'number' && Number.isFinite(displayIndex) && displayIndex >= 0 && displayIndex < ordered.length
        ? Math.floor(displayIndex)
        : 0
    const all: DesktopDisplayInfo[] = ordered.map((d, index) => {
      const cached = this.displayMeta.get(index)
      const scaled = computeScreenshotDimensions(d.bounds.width, d.bounds.height, 1280)
      return {
        index,
        id: String(d.id),
        primary: index === 0,
        bounds: { ...d.bounds },
        scaleFactor: d.scaleFactor || 1,
        shotWidth: cached && cached.id === String(d.id) ? cached.shotWidth : scaled.width,
        shotHeight: cached && cached.id === String(d.id) ? cached.shotHeight : scaled.height,
      }
    })
    return { index: idx, display: ordered[idx]!, all }
  }

  private async safeCursorDip(): Promise<{ x: number; y: number }> {
    if (process.platform === 'win32') {
      try {
        const phys = await this.worker.cursor()
        if (phys.x !== 0 || phys.y !== 0) {
          return screen.screenToDipPoint(phys)
        }
      } catch {
        /* fallback to Electron screen API */
      }
    }
    return screen.getCursorScreenPoint()
  }

  private async listMappedWindows(meta: DesktopDisplayInfo): Promise<DesktopWindowInfo[]> {
    if (process.platform !== 'win32') return []
    let raw: DesktopWindowInfo[] = []
    try {
      raw = await this.worker.listWindows()
    } catch {
      return []
    }
    return raw.map((w) => {
      const topLeftDip = screen.screenToDipPoint({ x: w.x, y: w.y })
      const botRightDip = screen.screenToDipPoint({ x: w.x + w.width, y: w.y + w.height })
      const dipRect = {
        x: topLeftDip.x,
        y: topLeftDip.y,
        width: Math.max(1, botRightDip.x - topLeftDip.x),
        height: Math.max(1, botRightDip.y - topLeftDip.y),
      }
      const mapped = mapDipRectToScreenshot(dipRect, meta)
      return { ...w, x: mapped.x, y: mapped.y, width: mapped.width, height: mapped.height }
    })
  }

  async capture(opts?: {
    displayIndex?: number
    hideAtrium?: boolean
    captureImage?: boolean
  }): Promise<DesktopSnapshot> {
    if (opts?.hideAtrium) {
      for (const win of this.getMainWindows()) {
        if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) {
          win.minimize()
        }
      }
      await new Promise((r) => setTimeout(r, 220))
    }

    const { index, display, all } = this.resolveDisplay(opts?.displayIndex)
    const targetDims = computeScreenshotDimensions(display.bounds.width, display.bounds.height, 1280)
    let screenshotDataUrl: string | undefined
    let shotWidth = targetDims.width
    let shotHeight = targetDims.height
    let error: string | undefined

    if (opts?.captureImage !== false) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: targetDims,
        })
        const match =
          sources.find((s) => s.display_id && s.display_id === String(display.id)) ??
          sources[index] ??
          sources[0]
        if (match && !match.thumbnail.isEmpty()) {
          const size = match.thumbnail.getSize()
          if (size.width > 0 && size.height > 0) {
            shotWidth = size.width
            shotHeight = size.height
            screenshotDataUrl = `data:image/jpeg;base64,${match.thumbnail.toJPEG(88).toString('base64')}`
          }
        } else {
          error = 'Desktop screen source returned an empty capture.'
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
    }

    const meta: DesktopDisplayInfo = {
      index,
      id: String(display.id),
      primary: index === 0,
      bounds: { ...display.bounds },
      scaleFactor: display.scaleFactor || 1,
      shotWidth,
      shotHeight,
    }
    this.displayMeta.set(index, meta)
    const displays = all.map((d) => (d.index === index ? meta : d))

    const [cursorDip, windows] = await Promise.all([this.safeCursorDip(), this.listMappedWindows(meta)])
    const cursor = mapDipPointToScreenshot(cursorDip.x, cursorDip.y, meta)

    return {
      displayIndex: index,
      displays,
      shotWidth,
      shotHeight,
      cursor,
      windows,
      screenshotDataUrl,
      ...(error ? { error } : {}),
    }
  }

  async mouse(input: DesktopMouseInput): Promise<DesktopSnapshot> {
    this.aborted = false
    const displayIndex = input.displayIndex ?? 0
    const { index, display } = this.resolveDisplay(displayIndex)
    const cached = this.displayMeta.get(index)
    const scaled = computeScreenshotDimensions(display.bounds.width, display.bounds.height, 1280)
    const meta: DesktopDisplayInfo =
      cached && cached.id === String(display.id)
        ? cached
        : {
            index,
            id: String(display.id),
            primary: index === 0,
            bounds: { ...display.bounds },
            scaleFactor: display.scaleFactor || 1,
            shotWidth: scaled.width,
            shotHeight: scaled.height,
          }

    const startDip = mapScreenshotPointToDip(input.x, input.y, meta)
    const startPhys = screen.dipToScreenPoint(startDip)
    let endPhys: { x: number; y: number } | undefined
    if (input.action === 'drag') {
      const endDip = mapScreenshotPointToDip(input.endX ?? input.x, input.endY ?? input.y, meta)
      endPhys = screen.dipToScreenPoint(endDip)
    }

    await this.worker.mouse({
      action: input.action,
      x: startPhys.x,
      y: startPhys.y,
      endX: endPhys?.x,
      endY: endPhys?.y,
      deltaX: input.deltaX ?? 0,
      deltaY: input.action === 'scroll' ? (input.deltaY ?? 360) : (input.deltaY ?? 0),
      button: input.button,
    })

    if (input.captureAfter === false) {
      return this.capture({ displayIndex: index, captureImage: false })
    }
    await new Promise((r) => setTimeout(r, 220))
    return this.capture({ displayIndex: index, captureImage: true })
  }

  async keyboard(input: DesktopKeyboardInput): Promise<DesktopSnapshot> {
    this.aborted = false
    const displayIndex = input.displayIndex ?? 0
    if (input.action === 'type') {
      await this.worker.typeText(input.text ?? '')
    } else if (input.action === 'key') {
      const specs = resolveKeyChord([input.key ?? ''])
      await this.worker.keyChord(specs)
    } else if (input.action === 'hotkey') {
      const specs = resolveKeyChord(input.keys ?? [])
      await this.worker.keyChord(specs)
    } else {
      throw new Error(`Unsupported keyboard action "${String(input.action)}".`)
    }

    if (input.captureAfter === false) {
      return this.capture({ displayIndex, captureImage: false })
    }
    await new Promise((r) => setTimeout(r, 200))
    return this.capture({ displayIndex, captureImage: true })
  }

  async window(input: DesktopWindowInput): Promise<DesktopSnapshot> {
    this.aborted = false
    const displayIndex = input.displayIndex ?? 0
    if (input.action === 'list') {
      return this.capture({ displayIndex, captureImage: Boolean(input.captureAfter) })
    }

    const windows = await this.worker.listWindows()
    const target = matchTargetWindow(windows, input)
    if (!target) {
      throw new Error(
        `No matching desktop window found for ${JSON.stringify({
          handle: input.handle,
          title: input.title,
          processName: input.processName,
        })}.`,
      )
    }
    if (input.action === 'focus') {
      await this.worker.focusWindow(target.hwnd)
    } else {
      await this.worker.setWindowState(target.hwnd, input.action)
    }
    if (input.captureAfter === false) {
      return this.capture({ displayIndex, captureImage: false })
    }
    await new Promise((r) => setTimeout(r, 220))
    return this.capture({ displayIndex, captureImage: true })
  }

  async wait(opts?: { seconds?: number; displayIndex?: number }): Promise<DesktopSnapshot> {
    this.aborted = false
    const ms = Math.max(200, Math.min(10_000, Math.round((opts?.seconds ?? 1.5) * 1000)))
    const deadline = Date.now() + ms
    while (!this.aborted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(150, Math.max(20, deadline - Date.now()))))
    }
    return this.capture({ displayIndex: opts?.displayIndex, captureImage: true })
  }

  async setHud(state: ComputerUseHudState): Promise<void> {
    if (this.skipHud) return
    if (!state.active) {
      this.hideHud()
      return
    }
    this.hudLabel = state.label ?? ''
    this.armShortcut(true)
    const zh = app.getLocale().toLowerCase().startsWith('zh')
    const html = buildHudHtml(this.hudLabel, nativeTheme.shouldUseDarkColors, zh)

    if (!this.hudWin || this.hudWin.isDestroyed()) {
      const workArea = screen.getPrimaryDisplay().workArea
      const width = 368
      const height = 40
      const x = workArea.x + Math.round((workArea.width - width) / 2)
      const y = workArea.y + 8
      const win = new BrowserWindow({
        width,
        height,
        x,
        y,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        skipTaskbar: true,
        focusable: false,
        alwaysOnTop: true,
        hasShadow: true,
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      win.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('hud://stop')) {
          event.preventDefault()
          this.triggerEmergencyStop()
        }
      })
      this.hudWin = win
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      if (!win.isDestroyed()) {
        win.showInactive()
        this.hudVisible = true
      }
      return
    }

    if (!this.hudVisible && !this.hudWin.isDestroyed()) {
      const workArea = screen.getPrimaryDisplay().workArea
      this.hudWin.setPosition(workArea.x + Math.round((workArea.width - 368) / 2), workArea.y + 8)
      this.hudWin.showInactive()
      this.hudVisible = true
    }
    if (!this.hudWin.isDestroyed()) {
      await this.hudWin.webContents.executeJavaScript(
        `(() => { const el = document.getElementById('lbl'); if (el) el.textContent = ${JSON.stringify(
          this.hudLabel || (zh ? 'Atrium 正在控制桌面' : 'Atrium Computer Use'),
        )}; })()`,
      ).catch(() => undefined)
    }
  }

  private hideHud(): void {
    this.hudVisible = false
    this.armShortcut(false)
    if (this.hudWin && !this.hudWin.isDestroyed()) {
      this.hudWin.hide()
    }
  }

  private armShortcut(enable: boolean): void {
    if (this.skipHud) return
    if (enable && !this.shortcutArmed) {
      try {
        this.shortcutArmed = globalShortcut.register(EMERGENCY_STOP_SHORTCUT, () => this.triggerEmergencyStop())
      } catch {
        this.shortcutArmed = false
      }
    } else if (!enable && this.shortcutArmed) {
      try {
        globalShortcut.unregister(EMERGENCY_STOP_SHORTCUT)
      } catch {
        /* ignore */
      }
      this.shortcutArmed = false
    }
  }

  triggerEmergencyStop(): void {
    this.aborted = true
    this.hideHud()
    this.onEmergencyStop()
  }

  dispose(): void {
    this.armShortcut(false)
    if (this.hudWin && !this.hudWin.isDestroyed()) {
      try {
        this.hudWin.destroy()
      } catch {
        /* ignore */
      }
    }
    this.hudWin = null
    this.worker.dispose()
  }
}
