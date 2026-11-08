// Agent tools for spawning, monitoring, and stopping persistent background commands
// shared transparently with the Studio Terminal drawer.
import type { ToolDef } from '../providers/types.ts'
import type { TerminalManager } from '../terminal.ts'

export const BG_TOOLS: ToolDef[] = [
  {
    name: 'start_background',
    description:
      'Start a long-running background process (e.g. a dev server, file watcher, or build daemon) inside the workspace Terminal drawer so it stays running across steps without timing out.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in the background' },
        title: { type: 'string', description: 'Short label shown in the Terminal tab (optional)' },
        waitMs: {
          type: 'number',
          description: 'Optional startup settle time in ms before sampling initial logs (default 1200, max 5000)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_background',
    description: 'Inspect status and recent output logs from a running or exited terminal/background process.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id returned by start_background' },
        tailChars: { type: 'number', description: 'Maximum characters from the tail of logs (default 8000)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'stop_background',
    description: 'Stop a running background process previously started with start_background.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id to terminate' },
      },
      required: ['sessionId'],
    },
  },
]

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

export async function runStartBackground(
  terminal: TerminalManager,
  workspace: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
  const command = String(input.command ?? '').trim()
  if (!command) return { output: '`command` is required.', isError: true }
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined
  const waitMs = Math.max(150, Math.min(Number(input.waitMs ?? 1200) || 1200, 5000))

  const session = terminal.create({ workspace, command, title, startedBy: 'agent' })

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, waitMs)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  if (signal.aborted) {
    terminal.close(session.id)
    return { output: 'Stopped.', isError: true }
  }

  const snapshot = terminal.read(session.id, 6000)
  const clean = stripAnsi(snapshot.output).trim()
  const statusLine =
    snapshot.session.status === 'exited'
      ? `Process exited immediately (code ${snapshot.session.exitCode ?? 'null'}).`
      : `Started background process (sessionId: ${session.id}, pid: ${snapshot.session.pid ?? 'unknown'}, status: running).`
  return {
    output: clean ? `${statusLine}\n\nInitial output:\n${clean}` : statusLine,
    isError: snapshot.session.status === 'exited' && snapshot.session.exitCode !== 0,
  }
}

export function runReadBackground(
  terminal: TerminalManager,
  input: Record<string, unknown>,
): { output: string; isError: boolean } {
  const sessionId = String(input.sessionId ?? '').trim()
  if (!sessionId) return { output: '`sessionId` is required.', isError: true }
  const tail = Math.max(500, Math.min(Number(input.tailChars ?? 8000) || 8000, 30_000))
  const { session, output } = terminal.read(sessionId, tail)
  const clean = stripAnsi(output).trim()
  const header = `Session ${session.id} (${session.title}) — status: ${session.status}${session.status === 'exited' ? ` (exit ${session.exitCode ?? 'null'})` : ''}`
  return { output: clean ? `${header}\n\n${clean}` : `${header}\n\n(no output yet)`, isError: false }
}

export function runStopBackground(
  terminal: TerminalManager,
  input: Record<string, unknown>,
): { output: string; isError: boolean } {
  const sessionId = String(input.sessionId ?? '').trim()
  if (!sessionId) return { output: '`sessionId` is required.', isError: true }
  const info = terminal.get(sessionId)
  if (!info) return { output: `Background session "${sessionId}" was not found.`, isError: true }
  terminal.close(sessionId)
  return { output: `Stopped and closed background process "${info.title}" (${sessionId}).`, isError: false }
}
