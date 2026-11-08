// Interactive terminal tabs & background process lifecycle manager.
// Avoids brittle native C++ addons across Electron ABIs while supporting both
// interactive workspace shells and long-running background dev servers.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { TerminalEvent, TerminalSessionInfo } from '../shared/types.ts'
import {
  clampPtySize,
  encodePtyInputFrame,
  encodePtyResizeFrame,
  PTY_CLOSE_FRAME,
  spawnInteractivePty,
} from './pty.ts'
import { newId } from './store.ts'

const OUTPUT_BUFFER_LIMIT = 200_000
const OUTPUT_BATCH_MS = 12
const OUTPUT_BATCH_MAX_CHARS = 32_768
const MAX_HISTORY = 100

interface ManagedSession {
  info: TerminalSessionInfo
  proc: ChildProcess
  ptyMode: boolean
  ptyFramed: boolean
  interactive: boolean
  outputChunks: string[]
  outputHead: number
  outputChars: number
  pendingEmit: string[]
  pendingEmitChars: number
  emitTimer?: ReturnType<typeof setTimeout>
  lineBuffer: string
  history: string[]
  historyIdx: number
  closing: boolean
}

function defaultPosixShell(): string {
  const envShell = process.env.SHELL?.trim()
  if (envShell && existsSync(envShell)) return envShell
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

function killTree(proc: ChildProcess, sig: 'SIGINT' | 'SIGTERM' = 'SIGTERM', sync = false): void {
  const pid = proc.pid
  if (!pid) return
  if (process.platform === 'win32') {
    if (sig === 'SIGINT') {
      try {
        proc.stdin?.write('\x03')
      } catch {
        /* ignore */
      }
      return
    }
    if (sync) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
      return
    }
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    return
  }
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      proc.kill(sig)
    } catch {
      /* ignore */
    }
  }
}

function formatWinPromptCommand(line: string): string {
  const psPrompt = `Write-Host -NoNewline ("$([char]27)[36mPS " + (Get-Location).Path + "$([char]27)[0m> ")`
  return `${line}\n${psPrompt}\n`
}

export class TerminalManager {
  private sessions = new Map<string, ManagedSession>()
  private readonly emit: (event: TerminalEvent) => void
  private readonly getDefaultWorkspace: () => string | undefined
  private readonly dataDir?: string

  constructor(opts: {
    emit: (event: TerminalEvent) => void
    getDefaultWorkspace: () => string | undefined
    dataDir?: string
  }) {
    this.emit = opts.emit
    this.getDefaultWorkspace = opts.getDefaultWorkspace
    this.dataDir = opts.dataDir
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  get(id: string): TerminalSessionInfo | undefined {
    const s = this.sessions.get(id)
    return s ? { ...s.info } : undefined
  }

  read(id: string, tailChars?: number): { session: TerminalSessionInfo; output: string } {
    const s = this.require(id)
    return { session: { ...s.info }, output: this.readBuffer(s, tailChars) }
  }

  create(opts?: {
    workspace?: string
    title?: string
    command?: string
    startedBy?: 'user' | 'agent'
    cols?: number
    rows?: number
  }): TerminalSessionInfo {
    const cwd = opts?.workspace?.trim() || this.getDefaultWorkspace() || process.cwd()
    const command = opts?.command?.trim() || undefined
    const interactive = !command
    const id = newId('term')
    const startedBy = opts?.startedBy ?? 'user'

    let shellLabel = 'shell'
    let ptyMode = false
    let ptyFramed = false
    let size: { cols: number; rows: number } | undefined
    let proc: ChildProcess

    if (command) {
      shellLabel = command.split(/\s+/)[0] || 'cmd'
      proc = spawn(command, {
        cwd,
        shell: true,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
      })
    } else {
      const pty = spawnInteractivePty({ cwd, cols: opts?.cols, rows: opts?.rows, dataDir: this.dataDir })
      if (pty) {
        proc = pty.proc
        shellLabel = pty.shellLabel
        ptyMode = true
        ptyFramed = pty.ptyFramed
        size = { cols: pty.cols, rows: pty.rows }
      } else if (process.platform === 'win32') {
        shellLabel = 'powershell'
        proc = spawn('powershell.exe', ['-NoLogo', '-NoExit', '-Command', '-'], {
          cwd,
          windowsHide: true,
          env: { ...process.env, TERM: 'xterm-256color' },
        })
      } else {
        const sh = defaultPosixShell()
        shellLabel = basename(sh)
        proc = spawn(sh, ['-i'], {
          cwd,
          detached: true,
          windowsHide: true,
          env: { ...process.env, TERM: 'xterm-256color' },
        })
      }
    }

    const index = this.sessions.size + 1
    const title = opts?.title?.trim() || (command ? command.slice(0, 32) : `Shell ${index}`)
    const info: TerminalSessionInfo = {
      id,
      title,
      cwd,
      shell: shellLabel,
      ...(command ? { command } : {}),
      pid: proc.pid,
      status: 'running',
      createdAt: Date.now(),
      startedBy,
      ...(ptyMode ? { pty: true } : {}),
      ...(size ? { cols: size.cols, rows: size.rows } : {}),
    }

    const session: ManagedSession = {
      info,
      proc,
      ptyMode,
      ptyFramed,
      interactive,
      outputChunks: [],
      outputHead: 0,
      outputChars: 0,
      pendingEmit: [],
      pendingEmitChars: 0,
      lineBuffer: '',
      history: [],
      historyIdx: 0,
      closing: false,
    }
    this.sessions.set(id, session)

    const append = (chunk: string) => this.queueOutput(session, chunk, false)

    if (command) {
      append(`\x1b[90m$ ${command}\x1b[0m\r\n`)
    } else if (!ptyMode && process.platform === 'win32') {
      try {
        proc.stdin?.write(
          '[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n' +
            'Write-Host -NoNewline ("$([char]27)[36mPS " + (Get-Location).Path + "$([char]27)[0m> ")\n',
        )
      } catch {
        /* ignore init write failure */
      }
    } else if (!ptyMode) {
      append(`\x1b[36m${cwd}\x1b[0m$ `)
    }

    proc.stdout?.on('data', (d: Buffer) => append(d.toString('utf8')))
    proc.stderr?.on('data', (d: Buffer) => append(d.toString('utf8')))
    proc.stdin?.on('error', () => undefined)

    proc.on('error', (err) => {
      append(`\r\n\x1b[31m[Terminal error: ${err.message}]\x1b[0m\r\n`)
    })

    proc.on('exit', (code) => {
      session.info.status = 'exited'
      session.info.exitCode = code
      if (!session.closing) {
        this.queueOutput(session, `\r\n\x1b[90m[Process exited with code ${code ?? 'null'}]\x1b[0m\r\n`, true)
        this.emit({ type: 'state', session: { ...session.info } })
      } else {
        this.clearPendingEmit(session)
      }
    })

    this.emit({ type: 'state', session: { ...info } })
    return { ...info }
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    const next = clampPtySize(cols, rows)
    s.info.cols = next.cols
    s.info.rows = next.rows
    if (s.info.status === 'running' && s.ptyFramed && s.proc.stdin) {
      try {
        s.proc.stdin.write(encodePtyResizeFrame(next.cols, next.rows))
      } catch {
        /* ignore write failure */
      }
    }
  }

  write(id: string, data: string): void {
    const s = this.require(id)
    if (s.info.status !== 'running' || !s.proc.stdin) return

    if (s.ptyFramed) {
      s.proc.stdin.write(encodePtyInputFrame(data))
      return
    }
    if (s.ptyMode || !s.interactive) {
      s.proc.stdin.write(data)
      return
    }

    // Pipe-mode interactive line editor (Windows PowerShell / fallback sh):
    // supports local character echo, Backspace, Ctrl+C interrupt, Ctrl+L clear, and Up/Down history.
    if (data === '\x1b[A') {
      if (s.history.length === 0) return
      s.historyIdx = Math.max(0, s.historyIdx - 1)
      this.replaceLineBuffer(s, s.history[s.historyIdx] ?? '')
      return
    }
    if (data === '\x1b[B') {
      if (s.history.length === 0) return
      s.historyIdx = Math.min(s.history.length, s.historyIdx + 1)
      this.replaceLineBuffer(s, s.historyIdx === s.history.length ? '' : (s.history[s.historyIdx] ?? ''))
      return
    }
    // Ignore unhandled ANSI cursor escapes in pipe line-editor
    if (data.startsWith('\x1b')) return

    for (const ch of data) {
      if (ch === '\x03') {
        s.lineBuffer = ''
        this.emitLocalChunk(s, '^C\r\n')
        this.writePrompt(s)
        continue
      }
      if (ch === '\x0c') {
        this.resetBuffer(s)
        s.lineBuffer = ''
        this.emitLocalChunk(s, '\x1b[2J\x1b[3J\x1b[H')
        this.writePrompt(s)
        continue
      }
      if (ch === '\r' || ch === '\n') {
        const line = s.lineBuffer
        s.lineBuffer = ''
        this.emitLocalChunk(s, '\r\n')
        const trimmed = line.trim()
        if (trimmed) {
          if (s.history.at(-1) !== trimmed) {
            s.history.push(trimmed)
            if (s.history.length > MAX_HISTORY) s.history.shift()
          }
          s.historyIdx = s.history.length
        }
        if (trimmed === 'clear' || trimmed === 'cls') {
          this.resetBuffer(s)
          this.emitLocalChunk(s, '\x1b[2J\x1b[3J\x1b[H')
          this.writePrompt(s)
        } else if (!trimmed) {
          this.writePrompt(s)
        } else if (process.platform === 'win32') {
          s.proc.stdin.write(formatWinPromptCommand(line))
        } else {
          s.proc.stdin.write(`${line}\n`)
        }
        continue
      }
      if (ch === '\x7f' || ch === '\b') {
        if (s.lineBuffer.length > 0) {
          s.lineBuffer = s.lineBuffer.slice(0, -1)
          this.emitLocalChunk(s, '\b \b')
        }
        continue
      }
      if (ch >= ' ' || ch === '\t') {
        s.lineBuffer += ch
        this.emitLocalChunk(s, ch)
      }
    }
  }

  private appendToRing(s: ManagedSession, chunk: string): void {
    if (!chunk) return
    if (chunk.length >= OUTPUT_BUFFER_LIMIT) {
      const sliced = chunk.slice(-OUTPUT_BUFFER_LIMIT)
      s.outputChunks = [sliced]
      s.outputHead = 0
      s.outputChars = sliced.length
      return
    }
    s.outputChunks.push(chunk)
    s.outputChars += chunk.length
    while (s.outputChars > OUTPUT_BUFFER_LIMIT && s.outputHead < s.outputChunks.length) {
      const head = s.outputChunks[s.outputHead]!
      if (s.outputChars - head.length >= OUTPUT_BUFFER_LIMIT) {
        s.outputChars -= head.length
        s.outputHead += 1
      } else {
        const excess = s.outputChars - OUTPUT_BUFFER_LIMIT
        s.outputChunks[s.outputHead] = head.slice(excess)
        s.outputChars = OUTPUT_BUFFER_LIMIT
      }
    }
    if (s.outputHead > 64 && s.outputHead * 2 >= s.outputChunks.length) {
      s.outputChunks = s.outputChunks.slice(s.outputHead)
      s.outputHead = 0
    }
  }

  private readBuffer(s: ManagedSession, tailChars?: number): string {
    if (!tailChars || tailChars <= 0 || tailChars >= s.outputChars) {
      if (s.outputHead > 0) {
        s.outputChunks = s.outputChunks.slice(s.outputHead)
        s.outputHead = 0
      }
      return s.outputChunks.join('')
    }
    const parts: string[] = []
    let remaining = tailChars
    for (let i = s.outputChunks.length - 1; i >= s.outputHead && remaining > 0; i--) {
      const piece = s.outputChunks[i]!
      if (piece.length <= remaining) {
        parts.push(piece)
        remaining -= piece.length
      } else {
        parts.push(piece.slice(piece.length - remaining))
        remaining = 0
      }
    }
    return parts.reverse().join('')
  }

  private clearPendingEmit(s: ManagedSession): void {
    if (s.emitTimer) {
      clearTimeout(s.emitTimer)
      s.emitTimer = undefined
    }
    s.pendingEmit = []
    s.pendingEmitChars = 0
  }

  private resetBuffer(s: ManagedSession): void {
    this.clearPendingEmit(s)
    s.outputChunks = []
    s.outputHead = 0
    s.outputChars = 0
  }

  private flushOutput(s: ManagedSession): void {
    if (s.emitTimer) {
      clearTimeout(s.emitTimer)
      s.emitTimer = undefined
    }
    if (s.pendingEmit.length === 0) return
    const chunk = s.pendingEmit.length === 1 ? s.pendingEmit[0]! : s.pendingEmit.join('')
    s.pendingEmit = []
    s.pendingEmitChars = 0
    if (!s.closing && this.sessions.has(s.info.id)) {
      this.emit({ type: 'data', id: s.info.id, chunk })
    }
  }

  private queueOutput(s: ManagedSession, chunk: string, immediate = false): void {
    if (!chunk) return
    this.appendToRing(s, chunk)
    if (s.closing) return
    s.pendingEmit.push(chunk)
    s.pendingEmitChars += chunk.length
    if (immediate || s.pendingEmitChars >= OUTPUT_BATCH_MAX_CHARS) {
      this.flushOutput(s)
    } else if (!s.emitTimer) {
      s.emitTimer = setTimeout(() => this.flushOutput(s), OUTPUT_BATCH_MS)
    }
  }

  private emitLocalChunk(s: ManagedSession, chunk: string): void {
    this.queueOutput(s, chunk, true)
  }

  private replaceLineBuffer(s: ManagedSession, next: string): void {
    const erase = s.lineBuffer.length > 0 ? '\b \b'.repeat(s.lineBuffer.length) : ''
    s.lineBuffer = next
    this.emitLocalChunk(s, `${erase}${next}`)
  }

  private writePrompt(s: ManagedSession): void {
    if (process.platform === 'win32') {
      try {
        s.proc.stdin?.write('Write-Host -NoNewline ("$([char]27)[36mPS " + (Get-Location).Path + "$([char]27)[0m> ")\n')
        return
      } catch {
        /* fallback */
      }
    }
    this.emitLocalChunk(s, `\x1b[36m${s.info.cwd}\x1b[0m$ `)
  }

  signal(id: string, sig: 'SIGINT' | 'SIGTERM' = 'SIGINT'): void {
    const s = this.require(id)
    if (s.info.status !== 'running') return
    if (sig === 'SIGINT' && s.ptyFramed) {
      try {
        s.proc.stdin?.write(encodePtyInputFrame('\x03'))
      } catch {
        /* ignore */
      }
      return
    }
    if (sig === 'SIGINT' && s.ptyMode) {
      s.proc.stdin?.write('\x03')
      return
    }
    if (sig === 'SIGINT' && s.interactive && !s.ptyMode) {
      this.write(id, '\x03')
      return
    }
    killTree(s.proc, sig)
  }

  clear(id: string): void {
    const s = this.require(id)
    this.resetBuffer(s)
    this.emit({ type: 'data', id, chunk: '\x1b[2J\x1b[3J\x1b[H' })
    if (s.interactive && !s.ptyMode && s.info.status === 'running') {
      this.writePrompt(s)
    }
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.closing = true
    this.clearPendingEmit(s)
    if (s.info.status === 'running') {
      if (s.ptyFramed) {
        try {
          s.proc.stdin?.write(PTY_CLOSE_FRAME)
        } catch {
          /* ignore */
        }
      }
      killTree(s.proc, 'SIGTERM', true)
    }
    this.sessions.delete(id)
    this.emit({ type: 'closed', id })
  }

  shutdown(): void {
    for (const s of this.sessions.values()) {
      s.closing = true
      this.clearPendingEmit(s)
      if (s.info.status === 'running') {
        if (s.ptyFramed) {
          try {
            s.proc.stdin?.write(PTY_CLOSE_FRAME)
          } catch {
            /* ignore */
          }
        }
        killTree(s.proc, 'SIGTERM', true)
      }
    }
    this.sessions.clear()
  }

  private require(id: string): ManagedSession {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`Terminal session "${id}" was not found or already closed.`)
    return s
  }
}
