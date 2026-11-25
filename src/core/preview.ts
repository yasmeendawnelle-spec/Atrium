// Managed local dev-server launcher, URL detector, readiness prober, and lifecycle cleanup.
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import { newId } from './store.ts'
import type { PreviewEvent, PreviewServerInfo } from '../shared/studio_features.ts'

const MAX_LOG_CHARS = 60_000
const MAX_ACTIVE_SERVERS = 6
const MAX_HISTORY_RECORDS = 20

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g
const LOCAL_URL_RE =
  /(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d{2,5})(\/[^\s"'<>)\]]*)?/i
const LISTEN_PORT_RE =
  /(?:listening|running|started|serving)\s+(?:on|at)\s+(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|port\s+)?:?(\d{2,5})\b/i

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

export function extractLocalServerUrl(text: string): { url: string; port?: number } | null {
  const clean = stripAnsi(text)
  const urlMatch = LOCAL_URL_RE.exec(clean)
  if (urlMatch) {
    const scheme = urlMatch[1]!.toLowerCase()
    let host = urlMatch[2]!
    const port = Number(urlMatch[3])
    const suffix = urlMatch[4] ?? ''
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    if (host === '0.0.0.0' || host === '[::]' || host === '[::1]') {
      host = '127.0.0.1'
    }
    return {
      url: `${scheme}${host}:${port}${suffix}`,
      port,
    }
  }
  const listenMatch = LISTEN_PORT_RE.exec(clean)
  if (listenMatch) {
    const port = Number(listenMatch[1])
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return {
        url: `http://127.0.0.1:${port}`,
        port,
      }
    }
  }
  return null
}

function probeSingleUrl(targetUrl: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(ok)
    }

    let parsed: URL
    try {
      parsed = new URL(targetUrl)
    } catch {
      finish(false)
      return
    }

    const isHttps = parsed.protocol === 'https:'
    const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`
    const client = isHttps ? https : http

    const req = client.request(
      {
        hostname: parsed.hostname,
        port,
        path,
        method: 'GET',
        timeout: timeoutMs,
        ...(isHttps ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.resume()
        req.destroy()
        finish(true)
      },
    )

    const timer = setTimeout(() => {
      req.destroy()
      finish(false)
    }, timeoutMs)

    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.on('error', () => {
      finish(false)
    })
    req.end()
  })
}

export async function probeLocalHttpUrl(targetUrl: string, timeoutMs = 1500): Promise<boolean> {
  return probeSingleUrl(targetUrl, timeoutMs)
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    return
  }
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return
    } catch {
      /* fallback */
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
      const killTimer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }, 1200)
      killTimer.unref?.()
      return
    } catch {
      /* fallback to direct kill */
    }
  }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

interface ManagedPreview {
  info: PreviewServerInfo
  child: ChildProcess | null
  logs: string
  exited: boolean
  stopRequested: boolean
  exitPromise: Promise<void>
}

export class PreviewServerManager {
  private readonly servers = new Map<string, ManagedPreview>()
  private readonly onChange?: (event: PreviewEvent) => void

  constructor(opts?: { onChange?: (event: PreviewEvent) => void }) {
    this.onChange = opts?.onChange
  }

  private emitList(): void {
    this.onChange?.({ type: 'list', servers: this.list() })
  }

  private pruneOldHistory(): void {
    if (this.servers.size <= MAX_HISTORY_RECORDS) return
    const inactive = [...this.servers.values()]
      .filter((s) => s.info.status === 'stopped' || s.info.status === 'error')
      .sort((a, b) => a.info.startedAt - b.info.startedAt)
    while (this.servers.size > MAX_HISTORY_RECORDS && inactive.length > 0) {
      const oldest = inactive.shift()!
      this.servers.delete(oldest.info.id)
    }
  }

  list(conversationId?: string): PreviewServerInfo[] {
    const items = [...this.servers.values()]
      .map((s) => ({ ...s.info }))
      .filter((info) => !conversationId || info.conversationId === conversationId)
      .sort((a, b) => b.startedAt - a.startedAt)
    return items
  }

  get(serverId: string): PreviewServerInfo | undefined {
    const entry = this.servers.get(serverId)
    return entry ? { ...entry.info } : undefined
  }

  latestForConversation(conversationId?: string): PreviewServerInfo | undefined {
    const all = this.list(conversationId)
    const active = all.find((s) => s.status === 'running' || s.status === 'starting')
    return active ?? all[0]
  }

  async start(opts: {
    workspace: string
    command: string
    conversationId?: string
    url?: string
    port?: number
    readyTimeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ server: PreviewServerInfo; ready: boolean; logTail: string }> {
    const command = opts.command.trim()
    if (!command) {
      throw new Error('A dev server command is required (e.g. "npm run dev").')
    }

    const activeCount = [...this.servers.values()].filter(
      (s) => s.info.status === 'starting' || s.info.status === 'running',
    ).length
    if (activeCount >= MAX_ACTIVE_SERVERS) {
      throw new Error(
        `Maximum of ${MAX_ACTIVE_SERVERS} concurrent preview servers reached. Stop an existing preview server first.`,
      )
    }

    let initialUrl = opts.url?.trim() || undefined
    let initialPort = typeof opts.port === 'number' && Number.isFinite(opts.port) ? Math.floor(opts.port) : undefined
    if (!initialUrl && initialPort) {
      initialUrl = `http://127.0.0.1:${initialPort}`
    } else if (initialUrl && !initialPort) {
      const parsed = extractLocalServerUrl(initialUrl)
      if (parsed?.port) initialPort = parsed.port
    }

    const id = newId('srv')
    const info: PreviewServerInfo = {
      id,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      workspace: opts.workspace,
      command,
      ...(initialUrl ? { url: initialUrl } : {}),
      ...(initialPort ? { port: initialPort } : {}),
      status: 'starting',
      startedAt: Date.now(),
    }

    let resolveExit: () => void = () => undefined
    const exitPromise = new Promise<void>((res) => {
      resolveExit = res
    })

    const child = spawn(command, {
      cwd: opts.workspace,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        BROWSER: 'none',
        FORCE_COLOR: '0',
      },
    })
    if (child.pid) info.pid = child.pid

    const entry: ManagedPreview = {
      info,
      child,
      logs: '',
      exited: false,
      stopRequested: false,
      exitPromise,
    }
    this.servers.set(id, entry)
    this.pruneOldHistory()
    this.emitList()

    const appendLog = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString('utf8'))
      if (!text) return
      entry.logs = (entry.logs + text).slice(-MAX_LOG_CHARS)
      if (!entry.info.url) {
        const detected = extractLocalServerUrl(entry.logs)
        if (detected) {
          entry.info.url = detected.url
          if (detected.port) entry.info.port = detected.port
          this.emitList()
        }
      }
    }

    child.stdout?.on('data', appendLog)
    child.stderr?.on('data', appendLog)

    child.on('error', (err) => {
      entry.exited = true
      entry.info.status = 'error'
      entry.info.stoppedAt = Date.now()
      entry.info.error = err.message
      entry.logs = (entry.logs + `\n[spawn error] ${err.message}`).slice(-MAX_LOG_CHARS)
      this.emitList()
      resolveExit()
    })

    child.on('close', (code) => {
      entry.exited = true
      entry.info.exitCode = code
      entry.info.stoppedAt = Date.now()
      if (entry.stopRequested || code === 0) {
        entry.info.status = 'stopped'
      } else {
        entry.info.status = 'error'
        entry.info.error = `Preview server exited with code ${code ?? 'unknown'}.`
      }
      this.emitList()
      resolveExit()
    })

    const timeoutMs = Math.min(60_000, Math.max(1500, Math.floor(opts.readyTimeoutMs ?? 20_000)))
    const deadline = Date.now() + timeoutMs
    let ready = false

    const abortHandler = () => {
      entry.stopRequested = true
      killProcessTree(child)
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        abortHandler()
      } else {
        opts.signal.addEventListener('abort', abortHandler, { once: true })
      }
    }

    try {
      while (Date.now() < deadline) {
        if (opts.signal?.aborted) {
          await Promise.race([entry.exitPromise, new Promise((r) => setTimeout(r, 800))])
          return {
            server: { ...entry.info },
            ready: false,
            logTail: entry.logs.slice(-4000),
          }
        }
        if (entry.exited) {
          return {
            server: { ...entry.info },
            ready: false,
            logTail: entry.logs.slice(-4000),
          }
        }
        if (entry.info.url) {
          const ok = await probeLocalHttpUrl(entry.info.url, 1200)
          if (ok) {
            ready = true
            entry.info.status = 'running'
            this.emitList()
            return {
              server: { ...entry.info },
              ready: true,
              logTail: entry.logs.slice(-4000),
            }
          }
          // If server printed localhost but only bound IPv4 127.0.0.1, probe 127.0.0.1 fallback.
          if (entry.info.url.includes('://localhost:')) {
            const v4Url = entry.info.url.replace('://localhost:', '://127.0.0.1:')
            if (await probeLocalHttpUrl(v4Url, 800)) {
              entry.info.url = v4Url
              ready = true
              entry.info.status = 'running'
              this.emitList()
              return {
                server: { ...entry.info },
                ready: true,
                logTail: entry.logs.slice(-4000),
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, 150))
      }

      if (!entry.exited && entry.info.status === 'starting') {
        entry.info.status = entry.info.url ? 'running' : 'starting'
        this.emitList()
      }

      return {
        server: { ...entry.info },
        ready,
        logTail: entry.logs.slice(-4000),
      }
    } finally {
      opts.signal?.removeEventListener('abort', abortHandler)
    }
  }

  logs(query: { serverId?: string; conversationId?: string; tailChars?: number }): {
    server: PreviewServerInfo
    logs: string
  } | null {
    let entry: ManagedPreview | undefined
    if (query.serverId) {
      entry = this.servers.get(query.serverId)
    } else if (query.conversationId) {
      const match = this.latestForConversation(query.conversationId)
      if (match) entry = this.servers.get(match.id)
    } else {
      const latest = this.list()[0]
      if (latest) entry = this.servers.get(latest.id)
    }
    if (!entry) return null
    const tail = Math.min(MAX_LOG_CHARS, Math.max(200, query.tailChars ?? 8000))
    return {
      server: { ...entry.info },
      logs: entry.logs.slice(-tail),
    }
  }

  async stop(serverId: string): Promise<boolean> {
    const entry = this.servers.get(serverId)
    if (!entry) return false
    if (entry.exited || !entry.child) {
      if (entry.info.status === 'running' || entry.info.status === 'starting') {
        entry.info.status = 'stopped'
        entry.info.stoppedAt = Date.now()
        this.emitList()
      }
      return true
    }
    entry.stopRequested = true
    killProcessTree(entry.child)
    await Promise.race([entry.exitPromise, new Promise((r) => setTimeout(r, 1500))])
    if (!entry.exited) {
      entry.info.status = 'stopped'
      entry.info.stoppedAt = Date.now()
      this.emitList()
    }
    return true
  }

  async stopForConversation(conversationId: string): Promise<number> {
    const targets = [...this.servers.values()].filter(
      (s) =>
        s.info.conversationId === conversationId &&
        (s.info.status === 'running' || s.info.status === 'starting'),
    )
    let count = 0
    for (const target of targets) {
      if (await this.stop(target.info.id)) count++
    }
    return count
  }

  async stopAll(): Promise<number> {
    const targets = [...this.servers.values()].filter(
      (s) => !s.exited && (s.info.status === 'running' || s.info.status === 'starting'),
    )
    const settled = await Promise.all(targets.map((t) => this.stop(t.info.id)))
    return settled.filter(Boolean).length
  }

  shutdown(): void {
    for (const entry of this.servers.values()) {
      if (!entry.exited && entry.child) {
        entry.stopRequested = true
        killProcessTree(entry.child)
        entry.info.status = 'stopped'
        entry.info.stoppedAt = Date.now()
      }
    }
  }
}
