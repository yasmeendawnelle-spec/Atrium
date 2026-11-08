import { useEffect, useRef, useState } from 'react'
import { Copy, Eraser, Plus, RotateCw, Send, Square, Terminal as TerminalIcon, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { call, errorMessage } from '../lib/api.ts'
import { clearTerminalLocalBuffer, setState, subscribeTerminalOutput, toast, useStore } from '../lib/store.ts'

function terminalTheme(dark: boolean) {
  if (dark) {
    return {
      background: '#161513',
      foreground: '#eee8e0',
      cursor: '#de7e5c',
      cursorAccent: '#161513',
      selectionBackground: 'rgba(222, 126, 92, 0.28)',
      black: '#282521',
      red: '#ef6b5b',
      green: '#6bc48d',
      yellow: '#e6b455',
      blue: '#71a8e8',
      magenta: '#c58be0',
      cyan: '#66c7c0',
      white: '#dfd9d0',
      brightBlack: '#6f685f',
    }
  }
  return {
    background: '#faf8f4',
    foreground: '#1d1b18',
    cursor: '#c46342',
    cursorAccent: '#faf8f4',
    selectionBackground: 'rgba(196, 99, 66, 0.2)',
    black: '#2c2823',
    red: '#c63d2f',
    green: '#2a7b4f',
    yellow: '#a86b18',
    blue: '#2a64ad',
    magenta: '#8848a3',
    cyan: '#217b75',
    white: '#d9d2c7',
    brightBlack: '#7a7267',
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export function TerminalPanel({
  workspace,
  onSendOutputToChat,
}: {
  workspace?: string
  onSendOutputToChat?: (snippet: string) => void
}) {
  const { t } = useTranslation()
  const sessions = useStore((s) => s.terminalSessions)
  const activeId = useStore((s) => s.activeTerminalId)
  const [creating, setCreating] = useState(false)
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const activeIdRef = useRef<string | null>(activeId)
  activeIdRef.current = activeId

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null

  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === 'dark')
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  // Mount xterm instance once while TerminalPanel is open.
  useEffect(() => {
    const container = hostRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: "var(--font-code, 'IBM Plex Mono', Consolas, monospace)",
      fontSize: 12.5,
      lineHeight: 1.38,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: terminalTheme(document.documentElement.dataset.theme === 'dark'),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* ignore before layout settles */
      }
    })

    const onDataSub = term.onData((data) => {
      const id = activeIdRef.current
      if (id) void call('terminal.write', id, data).catch(() => undefined)
    })

    let resizeTimer: number | null = null
    const onResizeSub = term.onResize(({ cols, rows }) => {
      const id = activeIdRef.current
      if (!id || cols < 1 || rows < 1) return
      if (resizeTimer) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        void call('terminal.resize', id, cols, rows).catch(() => undefined)
      }, 40)
    })

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
      })
    })
    ro.observe(container)

    termRef.current = term
    fitRef.current = fit

    return () => {
      if (resizeTimer) window.clearTimeout(resizeTimer)
      onDataSub.dispose()
      onResizeSub.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = terminalTheme(dark)
    }
  }, [dark])

  // Hydrate full scrollback buffer + subscribe live stream whenever active session changes.
  useEffect(() => {
    const term = termRef.current
    const id = activeSession?.id
    if (!term || !id) {
      term?.clear()
      return
    }
    let alive = true
    term.reset()
    void call('terminal.read', id)
      .then((snap) => {
        if (!alive || !termRef.current) return
        if (snap.output) termRef.current.write(snap.output)
        requestAnimationFrame(() => {
          try {
            fitRef.current?.fit()
            const cur = termRef.current
            if (cur && cur.cols > 0 && cur.rows > 0) {
              void call('terminal.resize', id, cur.cols, cur.rows).catch(() => undefined)
            }
            cur?.focus()
          } catch {
            /* ignore */
          }
        })
      })
      .catch(() => undefined)

    const unsub = subscribeTerminalOutput(id, (chunk) => {
      termRef.current?.write(chunk)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [activeSession?.id])

  const openNewShell = async (command?: string, title?: string) => {
    if (creating) return
    setCreating(true)
    try {
      const created = await call('terminal.create', {
        workspace,
        command,
        title,
        cols: termRef.current?.cols,
        rows: termRef.current?.rows,
      })
      setState((s) => ({
        terminalSessions: s.terminalSessions.some((x) => x.id === created.id)
          ? s.terminalSessions
          : [...s.terminalSessions, created],
        activeTerminalId: created.id,
      }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setCreating(false)
    }
  }

  const closeTab = async (id: string) => {
    try {
      await call('terminal.close', id)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const restartActive = async () => {
    if (!activeSession) return
    const prev = activeSession
    try {
      await call('terminal.close', prev.id)
      await openNewShell(prev.command, prev.title)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const clearActive = async () => {
    if (!activeSession) return
    clearTerminalLocalBuffer(activeSession.id)
    termRef.current?.clear()
    await call('terminal.clear', activeSession.id).catch(() => undefined)
  }

  const sendToChat = async () => {
    if (!activeSession || !onSendOutputToChat) return
    try {
      const snap = await call('terminal.read', activeSession.id)
      const tail = stripAnsi(snap.output).trim().split(/\r?\n/).slice(-60).join('\n')
      if (!tail) return
      onSendOutputToChat(`\`\`\`\n${tail}\n\`\`\``)
      toast(t('terminal.sentToDraft'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const copyOutput = async () => {
    if (!activeSession) return
    try {
      const snap = await call('terminal.read', activeSession.id)
      const clean = stripAnsi(snap.output).trim()
      if (!clean) return
      await navigator.clipboard?.writeText(clean)
      toast(t('terminal.copiedOutput'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs-bar">
        <div className="terminal-tabs-scroll">
          {sessions.map((s) => {
            const active = activeSession?.id === s.id
            return (
              <div key={s.id} className={`terminal-tab${active ? ' active' : ''}`}>
                <button
                  type="button"
                  className="terminal-tab-btn"
                  onClick={() => setState({ activeTerminalId: s.id })}
                  title={`${s.title} (${s.cwd})`}
                >
                  <span className={`terminal-status-dot ${s.status}`} aria-hidden="true" />
                  <span className="terminal-tab-title">{s.title}</span>
                  {s.startedBy === 'agent' && <span className="terminal-agent-badge">{t('terminal.agentTag')}</span>}
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  onClick={() => void closeTab(s.id)}
                  title={t('terminal.closeTab')}
                  aria-label={t('terminal.closeTab')}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          className="btn btn-small terminal-new-btn"
          disabled={creating}
          onClick={() => void openNewShell()}
          title={t('terminal.newShell')}
        >
          <Plus size={12} />
          <span>{t('terminal.newShell')}</span>
        </button>
      </div>

      {activeSession ? (
        <div className="terminal-toolbar">
          <div className="terminal-meta">
            <span className={`chip chip-${activeSession.status === 'running' ? 'connected' : 'off'}`}>
              <span className={`dot dot-${activeSession.status === 'running' ? 'connected' : 'off'}`} aria-hidden />
              {activeSession.status === 'running'
                ? t('terminal.running')
                : t('terminal.exited', { code: activeSession.exitCode ?? '-' })}
            </span>
            {activeSession.pty && <span className="terminal-agent-badge">PTY</span>}
            {activeSession.pid && <span className="terminal-pid">PID {activeSession.pid}</span>}
            <span className="terminal-cwd" title={activeSession.cwd}>
              {activeSession.cwd}
            </span>
          </div>
          <div className="terminal-actions">
            {activeSession.status === 'running' && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => void call('terminal.signal', activeSession.id, 'SIGINT')}
                title={t('terminal.interrupt')}
                aria-label={t('terminal.interrupt')}
              >
                <Square size={13} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn"
              onClick={() => void restartActive()}
              title={t('terminal.restart')}
              aria-label={t('terminal.restart')}
            >
              <RotateCw size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void clearActive()}
              title={t('terminal.clear')}
              aria-label={t('terminal.clear')}
            >
              <Eraser size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void copyOutput()}
              title={t('terminal.copyOutput')}
              aria-label={t('terminal.copyOutput')}
            >
              <Copy size={13} />
            </button>
            {onSendOutputToChat && (
              <button
                type="button"
                className="btn btn-small"
                onClick={() => void sendToChat()}
                title={t('terminal.sendToChat')}
              >
                <Send size={12} />
                <span>{t('terminal.sendToChat')}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="studio-empty">
          <div className="studio-empty-stage" aria-hidden="true">
            <span className="studio-empty-ring" />
            <div className="studio-empty-badge">
              <TerminalIcon size={20} />
            </div>
          </div>
          <strong>{t('terminal.emptyTitle')}</strong>
          <p>{t('terminal.emptyHint')}</p>
          <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void openNewShell()}>
            <TerminalIcon size={14} />
            <span>{t('terminal.openShellBtn')}</span>
          </button>
        </div>
      )}
      <div
        className={`terminal-xterm-host${activeSession ? '' : ' is-hidden'}`}
        ref={hostRef}
        onClick={() => termRef.current?.focus()}
        aria-hidden={!activeSession}
      />
    </div>
  )
}
