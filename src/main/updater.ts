// Application auto-updater built on electron-updater's generic NSIS feed.
// Kept decoupled from Electron imports at module top-level so unit tests can
// exercise the full config resolution and update state machine in plain Node.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { UpdateState } from '../shared/types.ts'

const PLACEHOLDER_HOST_SUFFIXES = ['.local', '.invalid', '.example', '.test']
const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.org', 'example.net'])

export function isPlaceholderFeedUrl(raw?: string): boolean {
  if (!raw) return true
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    if (!host) return true
    if (PLACEHOLDER_HOSTS.has(host)) return true
    return PLACEHOLDER_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  } catch {
    return true
  }
}

export function normalizeFeedUrl(raw?: string): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    const host = parsed.hostname.toLowerCase()
    if (host === 'github.com' || host === 'www.github.com') {
      const segments = parsed.pathname.split('/').filter(Boolean)
      if (segments.length === 2 || (segments.length === 3 && segments[2]?.toLowerCase() === 'releases')) {
        return `https://github.com/${segments[0]}/${segments[1]}/releases/latest/download`
      }
    }
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

export function readFeedUrlFromAppUpdateYml(ymlPath: string): string | undefined {
  if (!existsSync(ymlPath)) return undefined
  try {
    const text = readFileSync(ymlPath, 'utf8')
    const match = text.match(/^\s*url:\s*(.+?)\s*$/m)
    let value = match?.[1]?.trim()
    if (!value) return undefined
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    return normalizeFeedUrl(value)
  } catch {
    return undefined
  }
}

export interface ResolvedUpdateConfig {
  feedUrl?: string
  autoUpdate: boolean
  configured: boolean
  skippedUpdateVersion?: string
}

export function resolveUpdateConfig(opts: {
  userDataDir: string
  envUrl?: string
  overrideUrl?: string
  appUpdateYmlPath?: string
}): ResolvedUpdateConfig {
  let settingsUrl: string | undefined
  let autoUpdate = false
  let skippedUpdateVersion: string | undefined

  const settingsPath = join(opts.userDataDir, 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        updateUrl?: unknown
        autoUpdate?: unknown
        skippedUpdateVersion?: unknown
      }
      if (typeof raw.updateUrl === 'string') settingsUrl = raw.updateUrl
      if (typeof raw.autoUpdate === 'boolean') autoUpdate = raw.autoUpdate
      if (typeof raw.skippedUpdateVersion === 'string' && raw.skippedUpdateVersion.trim()) {
        skippedUpdateVersion = raw.skippedUpdateVersion.trim()
      }
    } catch {
      // Ignore corrupt or partially written settings.json; defaults still apply.
    }
  }

  const candidates = [
    normalizeFeedUrl(opts.overrideUrl),
    normalizeFeedUrl(opts.envUrl),
    normalizeFeedUrl(settingsUrl),
    opts.appUpdateYmlPath ? readFeedUrlFromAppUpdateYml(opts.appUpdateYmlPath) : undefined,
  ]

  const feedUrl = candidates.find((url): url is string => Boolean(url && !isPlaceholderFeedUrl(url)))
  return {
    feedUrl,
    autoUpdate,
    configured: Boolean(feedUrl),
    skippedUpdateVersion,
  }
}

function cleanNoteBlock(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatReleaseNotes(notes: unknown): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') {
    const cleaned = cleanNoteBlock(notes)
    return cleaned || undefined
  }
  if (Array.isArray(notes)) {
    const parts = notes
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const note = (item as { note?: unknown }).note
        return typeof note === 'string' ? cleanNoteBlock(note) : ''
      })
      .filter(Boolean)
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

function extractReleaseDate(info: { releaseDate?: unknown } | undefined): string | undefined {
  return typeof info?.releaseDate === 'string' && info.releaseDate.trim() ? info.releaseDate.trim() : undefined
}

function extractDownloadSize(info: { files?: unknown } | undefined): number | undefined {
  if (!Array.isArray(info?.files)) return undefined
  for (const file of info.files) {
    if (file && typeof file === 'object') {
      const size = (file as { size?: unknown }).size
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) return size
    }
  }
  return undefined
}

export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  forceDevUpdateConfig: boolean
  logger: { info(msg?: unknown): void; warn(msg?: unknown): void; error(msg?: unknown): void } | null
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  setFeedURL(options: { provider: 'generic'; url: string } | string): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterControllerOptions {
  updater: AutoUpdaterLike
  currentVersion: string
  userDataDir: string
  appUpdateYmlPath?: string
  envUrl?: string
  onStateChange?: (state: UpdateState) => void
  beforeInstall?: () => Promise<void> | void
}

export class AppUpdaterController {
  private readonly updater: AutoUpdaterLike
  private readonly userDataDir: string
  private readonly appUpdateYmlPath?: string
  private readonly envUrl?: string
  private readonly onStateChange?: (state: UpdateState) => void
  private readonly beforeInstall?: () => Promise<void> | void

  private state: UpdateState
  private appliedFeedUrl?: string
  private skippedUpdateVersion?: string
  private installing = false
  private backgroundCheck = false
  private checkSource: 'auto' | 'manual' = 'auto'
  private lastCheckStartedAt = 0
  private disposed = false
  private startupTimer?: ReturnType<typeof setTimeout>
  private intervalTimer?: ReturnType<typeof setInterval>
  private readonly handlers: Record<string, (...args: any[]) => void>

  constructor(opts: UpdaterControllerOptions) {
    this.updater = opts.updater
    this.userDataDir = opts.userDataDir
    this.appUpdateYmlPath = opts.appUpdateYmlPath
    this.envUrl = opts.envUrl
    this.onStateChange = opts.onStateChange
    this.beforeInstall = opts.beforeInstall

    const initial = this.readConfig()
    this.state = {
      status: 'idle',
      currentVersion: opts.currentVersion,
      feedUrl: initial.feedUrl,
      configured: initial.configured,
    }

    this.handlers = {
      'checking-for-update': () => {
        if (this.state.status === 'downloaded') return
        this.setState({ status: 'checking', source: this.checkSource, error: undefined, checkedAt: Date.now() })
      },
      'update-available': (info: { version?: string; releaseNotes?: unknown; releaseDate?: unknown; files?: unknown } | undefined) => {
        const version = info?.version
        if (this.state.status === 'downloaded' && this.state.version === version) return
        if (this.backgroundCheck && version && version === this.skippedUpdateVersion) {
          this.updater.autoDownload = false
        }
        this.setState({
          status: 'available',
          version,
          percent: undefined,
          releaseNotes: formatReleaseNotes(info?.releaseNotes),
          releaseDate: extractReleaseDate(info),
          downloadSize: extractDownloadSize(info),
          source: this.checkSource,
          error: undefined,
        })
      },
      'update-not-available': (info: { version?: string } | undefined) => {
        if (this.state.status === 'downloaded') return
        this.setState({
          status: 'not-available',
          version: info?.version,
          percent: undefined,
          releaseNotes: undefined,
          releaseDate: undefined,
          downloadSize: undefined,
          source: this.checkSource,
          error: undefined,
          checkedAt: Date.now(),
        })
      },
      'download-progress': (info: { percent?: number } | undefined) => {
        if (this.state.status === 'downloaded') return
        const pct = typeof info?.percent === 'number' && Number.isFinite(info.percent) ? Math.max(0, Math.min(100, Math.round(info.percent))) : 0
        this.setState({ status: 'downloading', percent: pct, error: undefined })
      },
      'update-downloaded': (info: { version?: string; releaseNotes?: unknown; releaseDate?: unknown; files?: unknown } | undefined) => {
        this.setState({
          status: 'downloaded',
          version: info?.version ?? this.state.version,
          percent: 100,
          releaseNotes: formatReleaseNotes(info?.releaseNotes) ?? this.state.releaseNotes,
          releaseDate: extractReleaseDate(info) ?? this.state.releaseDate,
          downloadSize: extractDownloadSize(info) ?? this.state.downloadSize,
          error: undefined,
        })
      },
      error: (err: unknown) => {
        this.handleUpdaterError(err)
      },
    }

    for (const [event, fn] of Object.entries(this.handlers)) {
      this.updater.on(event, fn)
    }
    this.syncConfig()
  }

  private readConfig(overrideUrl?: string): ResolvedUpdateConfig {
    return resolveUpdateConfig({
      userDataDir: this.userDataDir,
      envUrl: this.envUrl,
      overrideUrl,
      appUpdateYmlPath: this.appUpdateYmlPath,
    })
  }

  private setState(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch }
    this.onStateChange?.({ ...this.state })
    return { ...this.state }
  }

  private handleUpdaterError(err: unknown): void {
    // Never clobber an already downloaded update during background checks.
    if (this.state.status === 'downloaded') return
    if (this.backgroundCheck) {
      this.setState({ status: 'idle', error: undefined })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    this.setState({ status: 'error', error: message || 'Update check failed' })
  }

  syncConfig(overrideUrl?: string): ResolvedUpdateConfig {
    const cfg = this.readConfig(overrideUrl)
    this.skippedUpdateVersion = cfg.skippedUpdateVersion
    this.updater.autoDownload = cfg.autoUpdate
    this.updater.autoInstallOnAppQuit = true
    this.updater.autoRunAppAfterInstall = true

    if (cfg.feedUrl) {
      // Allow testing or custom enterprise feeds even when running unpackaged.
      this.updater.forceDevUpdateConfig = true
      if (this.appliedFeedUrl !== cfg.feedUrl) {
        this.updater.setFeedURL({ provider: 'generic', url: cfg.feedUrl })
        this.appliedFeedUrl = cfg.feedUrl
      }
    }

    const resetUnconfiguredError = cfg.configured && this.state.status === 'error' && this.state.error === 'NOT_CONFIGURED'
    if (
      this.state.feedUrl !== cfg.feedUrl ||
      this.state.configured !== cfg.configured ||
      resetUnconfiguredError
    ) {
      this.setState({
        feedUrl: cfg.feedUrl,
        configured: cfg.configured,
        ...(resetUnconfiguredError ? { status: 'idle', error: undefined } : {}),
      })
    }
    return cfg
  }

  getState(): UpdateState {
    if (this.state.status !== 'checking' && this.state.status !== 'downloading') {
      this.syncConfig()
    }
    return { ...this.state }
  }

  async checkForUpdates(opts?: { feedUrl?: string; background?: boolean }): Promise<UpdateState> {
    const cfg = this.syncConfig(opts?.feedUrl)
    if (!cfg.configured) {
      if (opts?.background) return { ...this.state }
      return this.setState({
        status: 'error',
        error: 'NOT_CONFIGURED',
        configured: false,
        feedUrl: undefined,
        checkedAt: Date.now(),
      })
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading') {
      return { ...this.state }
    }

    this.backgroundCheck = Boolean(opts?.background)
    this.checkSource = opts?.background ? 'auto' : 'manual'
    this.lastCheckStartedAt = Date.now()
    try {
      await this.updater.checkForUpdates()
    } catch (err) {
      if ((this.state.status as UpdateState['status']) === 'checking') {
        this.handleUpdaterError(err)
      }
    } finally {
      this.backgroundCheck = false
      // Restore configured autoDownload in case a skipped version temporarily disabled it.
      if (!this.disposed) this.syncConfig(opts?.feedUrl)
    }
    return { ...this.state }
  }

  checkOnFocus(minIntervalMs = 30 * 60 * 1000): boolean {
    if (this.disposed || this.state.status === 'checking' || this.state.status === 'downloading') {
      return false
    }
    if (this.lastCheckStartedAt > 0 && Date.now() - this.lastCheckStartedAt < minIntervalMs) {
      return false
    }
    const cfg = this.syncConfig()
    if (!cfg.configured) return false
    void this.checkForUpdates({ background: true })
    return true
  }

  async downloadUpdate(): Promise<UpdateState> {
    if (this.state.status === 'downloaded') return { ...this.state }
    const cfg = this.syncConfig()
    if (!cfg.configured) {
      return this.setState({ status: 'error', error: 'NOT_CONFIGURED', configured: false, feedUrl: undefined })
    }
    try {
      await this.updater.downloadUpdate()
    } catch (err) {
      this.handleUpdaterError(err)
    }
    return { ...this.state }
  }

  async installUpdate(): Promise<void> {
    if (this.installing || this.state.status !== 'downloaded') return
    this.installing = true
    try {
      await this.beforeInstall?.()
    } finally {
      // false = show installer / cleanly replace files; true = relaunch app automatically afterward
      this.updater.quitAndInstall(false, true)
    }
  }

  startSchedule(opts?: { initialDelayMs?: number; intervalMs?: number }): void {
    const initialDelayMs = opts?.initialDelayMs ?? 4_000
    const intervalMs = opts?.intervalMs ?? 2 * 60 * 60 * 1000

    const runBackground = () => {
      const cfg = this.syncConfig()
      if (cfg.configured) {
        void this.checkForUpdates({ background: true })
      }
    }

    this.startupTimer = setTimeout(runBackground, initialDelayMs)
    this.startupTimer.unref?.()
    this.intervalTimer = setInterval(runBackground, intervalMs)
    this.intervalTimer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.startupTimer) clearTimeout(this.startupTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    for (const [event, fn] of Object.entries(this.handlers)) {
      this.updater.removeListener(event, fn)
    }
  }
}

export function loadElectronAutoUpdater(): AutoUpdaterLike {
  const req = createRequire(import.meta.url)
  const mod = req('electron-updater') as { autoUpdater?: AutoUpdaterLike; default?: { autoUpdater?: AutoUpdaterLike } }
  const updater = mod.autoUpdater ?? mod.default?.autoUpdater
  if (!updater) {
    throw new Error('electron-updater did not export autoUpdater')
  }
  return updater
}
