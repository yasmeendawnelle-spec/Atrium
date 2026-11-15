// Floating always-on-top Quick Entry window toggled by global hotkey (e.g. Alt+Space).
import { BrowserWindow, desktopCapturer, globalShortcut, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import type { ImageAttachment } from '../shared/types.ts'

const QUICK_WIDTH = 620
const QUICK_MIN_HEIGHT = 82
const QUICK_MAX_HEIGHT = 540

export class QuickEntryController {
  private win: BrowserWindow | null = null
  private currentShortcut = ''
  private readonly isDev: boolean
  private readonly connectWindow: (contents: Electron.WebContents) => void
  private readonly skipShortcut: boolean

  constructor(opts: {
    isDev: boolean
    connectWindow: (contents: Electron.WebContents) => void
    skipShortcut?: boolean
  }) {
    this.isDev = opts.isDev
    this.connectWindow = opts.connectWindow
    this.skipShortcut = Boolean(opts.skipShortcut)
  }

  getWebContents(): Electron.WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null
  }

  private create(): BrowserWindow {
    const dark = nativeTheme.shouldUseDarkColors
    const win = new BrowserWindow({
      width: QUICK_WIDTH,
      height: 92,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: 'Atrium Quick Entry',
      backgroundColor: dark ? '#242320' : '#f7f5f0',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    win.on('close', (e) => {
      if (!this.win) return
      e.preventDefault()
      win.hide()
    })
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    win.webContents.once('did-finish-load', () => {
      this.connectWindow(win.webContents)
    })
    if (this.isDev && process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#quick`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'quick' })
    }
    this.win = win
    return win
  }

  private positionOnActiveDisplay(win: BrowserWindow): void {
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const { x, y, width, height } = display.workArea
    const winWidth = QUICK_WIDTH
    const px = Math.round(x + (width - winWidth) / 2)
    const py = Math.round(y + Math.max(48, height * 0.16))
    win.setPosition(px, py)
  }

  show(): void {
    const win = this.win && !this.win.isDestroyed() ? this.win : this.create()
    this.positionOnActiveDisplay(win)
    const showAndFocus = () => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
      win.webContents.send('app:event', { action: 'focus_quick_input' })
    }
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', showAndFocus)
    } else {
      showAndFocus()
    }
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
      this.win.hide()
    }
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible() && this.win.isFocused()) {
      this.hide()
    } else {
      this.show()
    }
  }

  resize(height: number): void {
    if (!this.win || this.win.isDestroyed()) return
    const next = Math.min(QUICK_MAX_HEIGHT, Math.max(QUICK_MIN_HEIGHT, Math.round(height)))
    const [w] = this.win.getSize()
    if (w) this.win.setSize(w, next)
  }

  updateShortcut(shortcut: string): { ok: boolean; error?: string } {
    if (this.skipShortcut) return { ok: true }
    if (this.currentShortcut) {
      try {
        globalShortcut.unregister(this.currentShortcut)
      } catch {
        /* ignore */
      }
      this.currentShortcut = ''
    }
    const clean = shortcut.trim()
    if (!clean) return { ok: true }
    try {
      const ok = globalShortcut.register(clean, () => this.toggle())
      if (!ok) {
        return { ok: false, error: `Shortcut "${clean}" is already claimed by another app.` }
      }
      this.currentShortcut = clean
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async captureActiveScreen(): Promise<ImageAttachment | null> {
    const wasVisible = Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible())
    if (wasVisible) {
      this.win!.hide()
      await new Promise((r) => setTimeout(r, 90))
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1600, height: 1000 },
      })
      const primary = sources[0]
      if (!primary) return null
      const dataUrl = primary.thumbnail.toDataURL()
      return {
        id: `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name: `screen-${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.png`,
        mimeType: 'image/png',
        dataUrl,
      }
    } finally {
      if (wasVisible && this.win && !this.win.isDestroyed()) {
        this.win.show()
        this.win.focus()
      }
    }
  }

  dispose(): void {
    if (this.currentShortcut) {
      try {
        globalShortcut.unregister(this.currentShortcut)
      } catch {
        /* ignore */
      }
      this.currentShortcut = ''
    }
    const win = this.win
    this.win = null
    if (win && !win.isDestroyed()) win.destroy()
  }
}
