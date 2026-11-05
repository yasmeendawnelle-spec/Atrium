// Detects the programs MCP servers usually need, so the UI can tell a
// beginner "install Node.js first" instead of showing a spawn error.
import { spawn } from 'node:child_process'
import type { RuntimeInfo } from '../shared/types.ts'

const CHECKS: { id: RuntimeInfo['id']; command: string; args: string[] }[] = [
  { id: 'node', command: 'node', args: ['--version'] },
  { id: 'npx', command: 'npx', args: ['--version'] },
  { id: 'uvx', command: 'uvx', args: ['--version'] },
  { id: 'python', command: process.platform === 'win32' ? 'python' : 'python3', args: ['--version'] },
  { id: 'docker', command: 'docker', args: ['--version'] },
]

let cache: { at: number; value: RuntimeInfo[] } | undefined

function probe(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // A shell is needed on Windows so `npx` resolves to npx.cmd.
    const child = spawn(command, args, { shell: process.platform === 'win32', windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, 8000)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
    child.on('error', () => finish(null))
    // The Microsoft Store "python" stub exits non-zero, which counts as missing.
    child.on('close', (code) => finish(code === 0 ? out.trim().split(/\r?\n/)[0] ?? '' : null))
  })
}

export async function detectRuntimes(force = false): Promise<RuntimeInfo[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.value
  const value = await Promise.all(
    CHECKS.map(async (c) => {
      const version = await probe(c.command, c.args)
      return version === null ? { id: c.id, found: false } : { id: c.id, found: true, version: version.replace(/^v/, '') }
    }),
  )
  cache = { at: Date.now(), value }
  return value
}

/** What to tell the user when `command` could not be started. */
export function installHint(command: string | undefined): string {
  const c = (command ?? '').toLowerCase().replace(/\.(cmd|exe)$/, '')
  if (c === 'npx' || c === 'node' || c === 'npm') return 'Install Node.js from nodejs.org, then restart Atrium.'
  if (c === 'uvx' || c === 'uv') return 'Install uv from docs.astral.sh/uv, then restart Atrium.'
  if (c === 'docker') return 'Install Docker Desktop and make sure it is running.'
  if (c.startsWith('python')) return 'Install Python from python.org, then restart Atrium.'
  return 'Check that the program is installed and on your PATH.'
}
