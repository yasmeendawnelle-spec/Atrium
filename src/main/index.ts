// Electron main process: the window, the core utility process, and the few
// things only main may do (encrypted secrets, folder picker, opening links).
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  Notification,
  protocol,
  screen,
  session,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { classifyDocumentExt, extractDocument, MAX_DOCUMENT_BYTES } from '../core/tools/documents.ts'
import { RpcPeer } from '../shared/rpc.ts'
import { defaultBrowserModeForLocale } from '../shared/browserUrl.ts'
import type { PickedFileResult } from '../shared/types.ts'
import type { HostMethods } from '../shared/ipc.ts'
import { BuiltinBrowserController } from './browser.ts'
import { ComputerController } from './computer.ts'
import { QuickEntryController } from './quick.ts'
import { SecretStore } from './secrets.ts'
import { prepareScreenshots, runScreenshots } from './screenshots.ts'
import { AppUpdaterController, loadElectronAutoUpdater } from './updater.ts'

const isDev = Boolean(process.env.ELECTRON_RENDERER_URL)
let core: UtilityProcess | null = null
let quitting = false
let backgroundActive = false
let tray: Tray | null = null
let restarts = 0
let updater: AppUpdaterController | null = null
const windows = new Set<BrowserWindow>()
const screenshotRun = prepareScreenshots()
const stagedArtifacts = new Map<string, string>()
let artifactSeq = 0
const builtinBrowser = new BuiltinBrowserController({
  userDataDir: app.getPath('userData'),
  preferCdp: false,
})
builtinBrowser.setOnStateChange((snap) => {
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send('app:browser', snap)
  }
})
const quickEntry = new QuickEntryController({
  isDev,
  connectWindow: (contents) => connectWindow(contents),
  skipShortcut: screenshotRun,
})
const computer = new ComputerController({
  userDataDir: app.getPath('userData'),
  getMainWindows: () => [...windows],
  onEmergencyStop: () => core?.postMessage({ kind: 'emergency_stop' }),
  skipHud: screenshotRun,
})

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'atrium-artifact',
    privileges: { standard: true, secure: true, bypassCSP: false },
  },
])

function focusOrCreateWindow(onReady?: (win: BrowserWindow) => void): void {
  const existing = [...windows].find((w) => !w.isDestroyed())
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    onReady?.(existing)
    return
  }
  const prevSize = windows.size
  createWindow()
  const created = [...windows].find((w) => !w.isDestroyed())
  if (created && windows.size > prevSize) {
    created.once('ready-to-show', () => onReady?.(created))
  }
}

function updateTray(): void {
  if (screenshotRun) return
  if (!backgroundActive) {
    if (tray) {
      tray.destroy()
      tray = null
    }
    return
  }
  if (tray) return
  const iconPath = join(__dirname, '../../build/icon.png')
  const img = existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setToolTip('Atrium')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Atrium', click: () => focusOrCreateWindow() },
      { type: 'separator' },
      {
        label: 'Quit Atrium',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.on('click', () => focusOrCreateWindow())
}

function ensureUpdater(): AppUpdaterController {
  if (updater) return updater
  updater = new AppUpdaterController({
    updater: loadElectronAutoUpdater(),
    currentVersion: app.getVersion(),
    userDataDir: app.getPath('userData'),
    appUpdateYmlPath: process.resourcesPath ? join(process.resourcesPath, 'app-update.yml') : undefined,
    envUrl: process.env.ATRIUM_UPDATE_URL,
    beforeInstall: () => shutdownCore(),
    onStateChange: (state) => {
      for (const win of windows) {
        if (!win.isDestroyed()) win.webContents.send('app:updater', state)
      }
    },
  })
  return updater
}

async function shutdownCore(): Promise<void> {
  if (!core) {
    quitting = true
    return
  }
  quitting = true
  const child = core
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.postMessage({ kind: 'shutdown' })
  })
}

const secrets = new SecretStore(join(app.getPath('userData'), 'secrets.json'))

const hostMethods: { [M in keyof HostMethods]: (...args: Parameters<HostMethods[M]>) => Promise<ReturnType<HostMethods[M]>> } = {
  'secrets.get': (key) => secrets.get(key),
  'secrets.set': (key, value) => secrets.set(key, value),
  'net.resolveProxy': (url) => session.defaultSession.resolveProxy(url),
  'app.openExternal': async (url) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Only web links can be opened.')
    await shell.openExternal(url)
  },
  'app.focusMain': async () => {
    focusOrCreateWindow((win) => {
      if (win.isDestroyed()) return
      win.setAlwaysOnTop(true)
      win.moveTop()
      win.focus()
      app.focus({ steal: true })
      setTimeout(() => {
        if (!win.isDestroyed()) win.setAlwaysOnTop(false)
      }, 150)
    })
  },
  'app.notify': async (opts) => {
    if (screenshotRun || !Notification.isSupported()) return
    const n = new Notification({ title: opts.title, body: opts.body })
    n.on('click', () => {
      focusOrCreateWindow((win) => {
        if (opts.conversationId && !win.isDestroyed()) {
          win.webContents.send('app:event', { action: 'open_chat', conversationId: opts.conversationId })
        }
      })
    })
    n.show()
  },
  'app.setBackgroundActive': async (active) => {
    backgroundActive = Boolean(active)
    updateTray()
  },
  'app.updateQuickShortcut': async (shortcut) => quickEntry.updateShortcut(shortcut),
  'browser.state': async (conversationId) => builtinBrowser.state(conversationId),
  'browser.open': async (url, conversationId) => builtinBrowser.open(url, conversationId),
  'browser.action': async (action, conversationId) => builtinBrowser.action(action, conversationId),
  'browser.capture': async (conversationId) => builtinBrowser.capture(conversationId),
  'browser.eval': async (script, conversationId) => builtinBrowser.evalScript(script, conversationId),
  'browser.setMode': async (mode, conversationId) => builtinBrowser.setMode(mode, { navigateIfHome: false, conversationId }),
  'computer.screenshot': (opts) => computer.capture(opts),
  'computer.mouse': (input) => computer.mouse(input),
  'computer.keyboard': (input) => computer.keyboard(input),
  'computer.window': (input) => computer.window(input),
  'computer.wait': (opts) => computer.wait(opts),
  'computer.setHud': (state) => computer.setHud(state),
}

function startCore(): void {
  const child = utilityProcess.fork(join(__dirname, 'core.js'), [], {
    serviceName: 'Atrium core',
    stdio: 'pipe',
  })
  core = child
  const peer = new RpcPeer(child, hostMethods as unknown as Record<string, (...args: never[]) => unknown>)
  child.on('message', (data) => void peer.receive(data))
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[core] ${chunk}`))
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[core] ${chunk}`))
  child.on('exit', (code) => {
    peer.dispose('The core process stopped.')
    if (core === child) core = null
    if (quitting) return
    // Restart with backoff, then hand every window a fresh port.
    const delay = Math.min(10_000, 500 * 2 ** restarts++)
    process.stderr.write(`[main] core exited with code ${code}; restarting in ${delay}ms\n`)
    setTimeout(() => {
      startCore()
      for (const win of windows) if (!win.isDestroyed()) connectWindow(win.webContents)
      const qwc = quickEntry.getWebContents()
      if (qwc && !qwc.isDestroyed()) connectWindow(qwc)
    }, delay)
  })
  child.on('spawn', () => {
    setTimeout(() => (restarts = 0), 30_000)
  })
  child.postMessage({ kind: 'start', dir: app.getPath('userData') })
}

/** Gives a window its own private channel to the core. */
function connectWindow(contents: WebContents): void {
  if (!core) return
  const { port1, port2 } = new MessageChannelMain()
  core.postMessage({ kind: 'attach' }, [port1])
  contents.postMessage('core:port', null, [port2])
}

// The window draws its own title bar: the page owns the top strip and the OS only
// paints the minimise / maximise / close buttons over it, in the page's colours.
const TITLEBAR_HEIGHT = 48
const mac = process.platform === 'darwin'
const win32 = process.platform === 'win32'
const chrome = (dark: boolean) => (dark ? { color: '#00000000', symbolColor: '#edece6' } : { color: '#00000000', symbolColor: '#22211f' })

function installMacApplicationMenu(): void {
  if (!mac) return
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow(),
        },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowBounds(): WindowBounds {
  const fallback: WindowBounds = { width: 1240, height: 820 }
  if (screenshotRun) return fallback
  try {
    const parsed = JSON.parse(readFileSync(windowStatePath(), 'utf8')) as Partial<WindowBounds>
    const width = typeof parsed.width === 'number' && parsed.width >= 900 ? Math.round(parsed.width) : 1240
    const height = typeof parsed.height === 'number' && parsed.height >= 600 ? Math.round(parsed.height) : 820
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      const visible = screen.getAllDisplays().some(({ workArea }) => {
        const cx = parsed.x! + Math.min(120, Math.round(width / 2))
        const cy = parsed.y! + Math.min(80, Math.round(height / 2))
        return cx >= workArea.x && cx <= workArea.x + workArea.width && cy >= workArea.y && cy <= workArea.y + workArea.height
      })
      if (visible) return { width, height, x: Math.round(parsed.x), y: Math.round(parsed.y), maximized: Boolean(parsed.maximized) }
    }
    return { width, height, maximized: Boolean(parsed.maximized) }
  } catch {
    return fallback
  }
}

function saveWindowBounds(win: BrowserWindow): void {
  if (screenshotRun || win.isDestroyed()) return
  const maximized = win.isMaximized()
  const bounds = win.getNormalBounds()
  const payload: WindowBounds = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, maximized }
  try {
    const file = windowStatePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(payload, null, 2))
  } catch {
    /* ignore disk write failure for non-critical window geometry */
  }
}

function createWindow(): void {
  const dark = nativeTheme.shouldUseDarkColors
  const iconPath = join(__dirname, '../../build/icon.png')
  const saved = loadWindowBounds()
  const offset = windows.size > 0 && saved.x !== undefined && saved.y !== undefined ? windows.size * 26 : 0
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x + offset, y: saved.y + offset } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Atrium',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    backgroundColor: dark ? '#1e1e1b' : '#faf8f4',
    titleBarStyle: mac ? 'hiddenInset' : win32 ? 'hidden' : 'default',
    ...(mac
      ? { trafficLightPosition: { x: 18, y: 17 } }
      : win32
        ? { titleBarOverlay: { ...chrome(dark), height: TITLEBAR_HEIGHT } }
        : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  windows.add(win)
  builtinBrowser.setHostWindow(win)
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveWindowBounds(win), 250)
  }
  win.on('resize', queueSave)
  win.on('move', queueSave)
  win.on('maximize', () => saveWindowBounds(win))
  win.on('unmaximize', () => saveWindowBounds(win))
  win.on('focus', () => {
    builtinBrowser.setHostWindow(win)
    if (!screenshotRun) updater?.checkOnFocus()
  })
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveWindowBounds(win)
  })
  win.on('closed', () => {
    windows.delete(win)
    builtinBrowser.setHostWindow([...windows].find((w) => !w.isDestroyed()) ?? null)
    if (windows.size === 0 && !backgroundActive && !quitting && process.platform !== 'darwin') {
      quitting = true
      app.quit()
    }
  })
  win.once('ready-to-show', () => {
    if (saved.maximized && !screenshotRun) win.maximize()
    win.show()
    if (screenshotRun) void runScreenshots(win)
  })

  // Links open in the user's browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(process.env.ELECTRON_RENDERER_URL!)) return
    event.preventDefault()
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

ipcMain.on('core:connect', (event) => connectWindow(event.sender))

ipcMain.handle('app.pickFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

const PICKED_IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}
const MAX_PICKED_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_PICKED_TEXT_BYTES = 120 * 1024

async function inspectLocalFiles(rawPaths: string[], workspace?: unknown): Promise<PickedFileResult[]> {
  const ws = typeof workspace === 'string' && workspace.trim() ? resolve(workspace.trim()) : ''
  const items: PickedFileResult[] = []
  for (const rawPath of rawPaths.slice(0, 12)) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue
    const filePath = resolve(rawPath)
    const name = basename(filePath)
    const ext = extname(filePath).toLowerCase()
    const mimeType = PICKED_IMAGE_MIMES[ext]
    let size = 0
    try {
      const st = statSync(filePath)
      if (!st.isFile()) continue
      size = st.size
    } catch {
      continue
    }

    if (mimeType) {
      if (size > MAX_PICKED_IMAGE_BYTES) {
        items.push({ kind: 'file', name, path: filePath, tooLarge: true })
        continue
      }
      const buf = readFileSync(filePath)
      items.push({
        kind: 'image',
        name,
        mimeType,
        dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
        byteSize: buf.byteLength,
      })
      continue
    }

    const rel = (() => {
      if (!ws) return undefined
      const r = relative(ws, filePath)
      return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : undefined
    })()

    const docKind = classifyDocumentExt(filePath)
    if (docKind === 'legacy_office') {
      items.push({ kind: 'file', name, path: filePath, ...(rel ? { relativePath: rel } : {}), legacyOffice: true })
      continue
    }
    if (docKind) {
      if (size > MAX_DOCUMENT_BYTES) {
        items.push({ kind: 'file', name, path: filePath, ...(rel ? { relativePath: rel } : {}), tooLarge: true })
        continue
      }
      try {
        const extracted = await extractDocument(filePath, readFileSync(filePath))
        items.push({
          kind: 'document',
          name,
          path: filePath,
          ...(rel ? { relativePath: rel } : {}),
          docKind: extracted.docKind,
          content: extracted.content,
          truncated: extracted.truncated,
          byteSize: extracted.byteSize,
          pageCount: extracted.pageCount,
          sheetCount: extracted.sheetCount,
          slideCount: extracted.slideCount,
          sheetNames: extracted.sheetNames,
        })
      } catch (err) {
        items.push({
          kind: 'document',
          name,
          path: filePath,
          ...(rel ? { relativePath: rel } : {}),
          docKind,
          content: '',
          byteSize: size,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      continue
    }

    if (rel) {
      items.push({
        kind: 'file',
        name,
        path: filePath,
        relativePath: rel,
      })
      continue
    }

    const buf = readFileSync(filePath)
    if (buf.subarray(0, 8192).includes(0)) {
      items.push({ kind: 'file', name, path: filePath, binary: true })
      continue
    }
    const truncated = buf.byteLength > MAX_PICKED_TEXT_BYTES
    const content = (truncated ? buf.subarray(0, MAX_PICKED_TEXT_BYTES) : buf).toString('utf8')
    items.push({ kind: 'file', name, path: filePath, content, truncated })
  }
  return items
}

ipcMain.handle('app.pickFiles', async (event, workspace?: unknown): Promise<PickedFileResult[]> => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const ws = typeof workspace === 'string' && workspace.trim() ? resolve(workspace.trim()) : ''
  const options = {
    ...(ws && existsSync(ws) ? { defaultPath: ws } : {}),
    properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return []
  return inspectLocalFiles(result.filePaths, workspace)
})

ipcMain.handle('app.inspectFiles', async (_event, paths: unknown, workspace?: unknown): Promise<PickedFileResult[]> => {
  if (!Array.isArray(paths)) return []
  return inspectLocalFiles(
    paths.filter((p): p is string => typeof p === 'string'),
    workspace,
  )
})

// The renderer follows light/dark on its own; this keeps the window buttons in step.
ipcMain.on('app.titleBarTheme', (event, dark: unknown) => {
  if (!win32) return
  const win = BrowserWindow.fromWebContents(event.sender)
  try {
    win?.setTitleBarOverlay({ ...chrome(dark === true), height: TITLEBAR_HEIGHT })
  } catch {
    /* the platform has no overlay: nothing to update */
  }
})

ipcMain.handle('app.openExternal', async (_event, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('Only web links can be opened.')
  await shell.openExternal(url)
})

function resolveValidatedPath(targetPath: unknown, workspace?: unknown): string {
  if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error('Path is required.')
  const cleanTarget = targetPath.trim()
  let resolvedPath = ''
  if (typeof workspace === 'string' && workspace.trim()) {
    const base = resolve(workspace.trim())
    const candidate = resolve(base, cleanTarget)
    const rel = relative(base, candidate)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Target path escapes workspace.')
    }
    resolvedPath = candidate
  } else {
    if (!isAbsolute(cleanTarget)) throw new Error('Workspace path must be absolute.')
    resolvedPath = resolve(cleanTarget)
  }
  if (!existsSync(resolvedPath)) throw new Error(`Path does not exist: ${resolvedPath}`)
  return resolvedPath
}

function findEditorExecutable(): { name: string; command: string } | null {
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
  const candidates: Array<{ name: string; paths: string[]; bin: string }> =
    process.platform === 'win32'
      ? [
          {
            name: 'Cursor',
            paths: [join(local, 'Programs', 'cursor', 'Cursor.exe')],
            bin: 'cursor.cmd',
          },
          {
            name: 'VS Code',
            paths: [
              join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
              join(pf, 'Microsoft VS Code', 'Code.exe'),
            ],
            bin: 'code.cmd',
          },
        ]
      : process.platform === 'darwin'
        ? [
            {
              name: 'Cursor',
              paths: ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor'],
              bin: 'cursor',
            },
            {
              name: 'VS Code',
              paths: ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'],
              bin: 'code',
            },
          ]
        : [
            { name: 'Cursor', paths: ['/usr/bin/cursor', '/usr/local/bin/cursor'], bin: 'cursor' },
            { name: 'VS Code', paths: ['/usr/bin/code', '/usr/local/bin/code'], bin: 'code' },
          ]

  for (const item of candidates) {
    const hit = item.paths.find((p) => p && existsSync(p))
    if (hit) return { name: item.name, command: hit }
  }
  return null
}

function launchOnPath(bin: string, args: string[]): Promise<boolean> {
  return new Promise((res) => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    execFile(lookup, [bin], { windowsHide: true, timeout: 1500 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        res(false)
        return
      }
      const exe = stdout.trim().split(/\r?\n/)[0]?.trim()
      if (!exe) {
        res(false)
        return
      }
      try {
        const child = spawn(exe, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe),
        })
        child.unref()
        res(true)
      } catch {
        res(false)
      }
    })
  })
}

ipcMain.handle('app.revealPath', async (_event, targetPath: unknown, workspace?: unknown) => {
  const resolvedPath = resolveValidatedPath(targetPath, workspace)
  if (statSync(resolvedPath).isDirectory()) {
    const errMsg = await shell.openPath(resolvedPath)
    if (errMsg) throw new Error(errMsg)
  } else {
    shell.showItemInFolder(resolvedPath)
  }
})

ipcMain.handle('app.openInEditor', async (_event, targetPath: unknown, workspace?: unknown) => {
  const resolvedPath = resolveValidatedPath(targetPath, workspace)
  const wsPath =
    typeof workspace === 'string' && workspace.trim() && existsSync(resolve(workspace.trim()))
      ? resolve(workspace.trim())
      : undefined
  const args = wsPath && wsPath !== resolvedPath ? [wsPath, resolvedPath] : [resolvedPath]
  const found = findEditorExecutable()
  if (found) {
    const child = spawn(found.command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { editor: found.name }
  }
  for (const [name, bin] of [
    ['Cursor', 'cursor'],
    ['VS Code', 'code'],
  ] as const) {
    if (await launchOnPath(bin, args)) return { editor: name }
  }
  const errMsg = await shell.openPath(resolvedPath)
  if (errMsg) throw new Error(errMsg)
  return { editor: 'system' }
})

ipcMain.handle('app.stageArtifact', (_event, html: unknown) => {
  const id = `art-${++artifactSeq}`
  stagedArtifacts.set(id, typeof html === 'string' ? html : '')
  if (stagedArtifacts.size > 50) {
    const oldest = stagedArtifacts.keys().next().value
    if (oldest) stagedArtifacts.delete(oldest)
  }
  return `atrium-artifact://frame/${id}`
})

ipcMain.handle('app.info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  userData: app.getPath('userData'),
  encryption: secrets.available(),
}))

ipcMain.handle('app.newWindow', () => {
  createWindow()
})

ipcMain.handle('app.updateState', () => ensureUpdater().getState())

ipcMain.handle('app.checkUpdates', (_event, feedUrl?: unknown) =>
  ensureUpdater().checkForUpdates({ feedUrl: typeof feedUrl === 'string' ? feedUrl : undefined }),
)

ipcMain.handle('app.downloadUpdate', () => ensureUpdater().downloadUpdate())

ipcMain.handle('app.installUpdate', () => ensureUpdater().installUpdate())

ipcMain.handle('app.captureScreen', () => quickEntry.captureActiveScreen())

ipcMain.handle('app.quickOpenChat', (_event, conversationId: unknown) => {
  quickEntry.hide()
  const cid = typeof conversationId === 'string' ? conversationId : ''
  focusOrCreateWindow((win) => {
    if (cid && !win.isDestroyed()) {
      win.webContents.send('app:event', { action: 'open_chat', conversationId: cid })
    }
  })
})

ipcMain.handle('app.quickHide', () => quickEntry.hide())

ipcMain.handle('app.quickResize', (_event, height: unknown) => {
  if (typeof height === 'number' && Number.isFinite(height)) quickEntry.resize(height)
})

ipcMain.handle('app.openBrowserWindow', (_event, url?: unknown) =>
  builtinBrowser.openInteractiveWindow(typeof url === 'string' ? url : undefined),
)

ipcMain.handle('app.syncBrowserView', (_event, layout: unknown) =>
  builtinBrowser.syncLayout(
    layout && typeof layout === 'object'
      ? (layout as { conversationId?: string; visible: boolean; x: number; y: number; width: number; height: number })
      : null,
  ),
)

ipcMain.handle('app.dockBrowserView', () => builtinBrowser.dockBackFromPopout())

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = [...windows][0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    if (win32) app.setAppUserModelId('com.atrium.app')
    installMacApplicationMenu()
    if (mac && isDev) {
      const devIcon = join(__dirname, '../../build/icon.png')
      if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
    }
    void builtinBrowser.setMode(defaultBrowserModeForLocale(app.getLocale()), { navigateIfHome: false })
    protocol.handle('atrium-artifact', (request) => {
      const id = new URL(request.url).pathname.replace(/^\/+/, '')
      const html = stagedArtifacts.get(id) ?? '<!doctype html><html><body></body></html>'
      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: https: blob:; font-src data:; connect-src 'none';",
        },
      })
    })
    startCore()
    if (!screenshotRun) ensureUpdater().startSchedule()
    createWindow()
    app.on('activate', () => {
      if (windows.size === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !backgroundActive) app.quit()
  })

  // Give the core a moment to stop MCP servers, so no child processes are orphaned.
  app.on('before-quit', (event) => {
    quitting = true
    tray?.destroy()
    tray = null
    quickEntry.dispose()
    computer.dispose()
    builtinBrowser.dispose()
    updater?.dispose()
    if (!core) return
    event.preventDefault()
    void shutdownCore().then(() => app.quit())
  })
}
