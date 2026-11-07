// Runs a command inside the workspace, after the user has approved that exact
// command. Nothing here is ever invoked without an approval decision.
import { spawn, type ChildProcess } from 'node:child_process'
import type { SandboxMode, ToolInfo } from '../../shared/types.ts'
import { runSandboxedCommand } from '../sandbox.ts'

export const SHELL_TOOL: ToolInfo = {
  name: 'run_command',
  description:
    'Run a shell command inside the workspace. The user approves every command before it runs. Use it for builds, tests and git, not for reading files (use the file tools).',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      timeoutSeconds: { type: 'number', description: 'Give up after this many seconds. Defaults to 120, max 600.' },
    },
    required: ['command'],
  },
}

const OUTPUT_LIMIT = 100_000
const STREAM_INTERVAL_MS = 180

export interface CommandResult {
  output: string
  isError: boolean
  exitCode: number | null
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      /* fall back to direct signal */
    }
  }
  child.kill()
}

export function runCommand(
  workspace: string,
  command: string,
  timeoutSeconds: number,
  signal: AbortSignal,
  onOutput?: (outputSoFar: string) => void,
  opts?: { sandboxMode?: SandboxMode; allowNetwork?: boolean; dataDir?: string },
): Promise<CommandResult> {
  if (opts?.sandboxMode && opts.sandboxMode !== 'off') {
    return runSandboxedCommand({
      workspace,
      command,
      mode: opts.sandboxMode,
      allowNetwork: opts.allowNetwork,
      dataDir: opts.dataDir,
      timeoutSeconds,
      signal,
      onOutput,
    })
  }
  const timeout = Math.min(600, Math.max(5, timeoutSeconds || 120)) * 1000
  return new Promise((resolvePromise) => {
    // `shell: true` is what makes `npm test` work on Windows without the user
    // having to know about cmd.exe. The workspace is the only cwd allowed.
    const child = spawn(command, {
      cwd: workspace,
      shell: true,
      windowsHide: true,
      env: process.env,
    })
    let output = ''
    let truncated = false
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const pushLive = () => {
      flushTimer = null
      if (!onOutput) return
      onOutput(truncated ? `${output}\n… output truncated` : output)
    }
    const collect = (chunk: Buffer) => {
      if (!truncated) {
        output += chunk.toString('utf8')
        if (output.length > OUTPUT_LIMIT) {
          output = output.slice(0, OUTPUT_LIMIT)
          truncated = true
        }
      }
      if (onOutput && !flushTimer) {
        flushTimer = setTimeout(pushLive, STREAM_INTERVAL_MS)
      }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeout)
    const onAbort = () => killProcessTree(child)
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      cleanup()
      resolvePromise({ output: `Could not start the command: ${err.message}`, isError: true, exitCode: null })
    })
    child.on('close', (code) => {
      cleanup()
      const tail = truncated ? '\n… output truncated' : ''
      if (signal.aborted) {
        resolvePromise({ output: `${output}${tail}\nStopped by the user.`, isError: true, exitCode: code })
      } else if (timedOut) {
        resolvePromise({ output: `${output}${tail}\nTimed out after ${timeout / 1000}s and was stopped.`, isError: true, exitCode: code })
      } else {
        resolvePromise({
          output: `${output}${tail}\nExit code: ${code ?? 'unknown'}`,
          isError: code !== 0,
          exitCode: code,
        })
      }
    })

    function cleanup() {
      clearTimeout(timer)
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      signal.removeEventListener('abort', onAbort)
    }
  })
}
