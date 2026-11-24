// Cross-platform encrypted secret storage (AES-256-GCM) and minimal OS host bridge for Atrium CLI.
import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HostCall } from '../core/secrets.ts'
import type { BrowserSnapshot, DesktopSnapshot } from '../shared/types.ts'

interface EncryptedEntry {
  v: 1
  iv: string
  tag: string
  data: string
}

type SecretMap = Record<string, EncryptedEntry>

const MASTER_KEY_BYTES = 32
const IV_BYTES = 12

/** Resolves the Atrium CLI home directory (`ATRIUM_CLI_HOME`, `ATRIUM_HOME`, or `~/.atrium`). */
export function resolveCliHome(): string {
  const override = process.env.ATRIUM_CLI_HOME?.trim() || process.env.ATRIUM_HOME?.trim()
  if (override) return override
  return join(homedir(), '.atrium')
}

async function writeFileSecureAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`
  await writeFile(tmp, data, { mode: 0o600 })
  if (process.platform !== 'win32') {
    await chmod(tmp, 0o600).catch(() => undefined)
  }
  await rename(tmp, filePath)
}

/**
 * Encrypted at-rest secret store using AES-256-GCM with a per-installation 256-bit key.
 * Works identically across Windows, macOS, and headless Linux SSH environments.
 */
export class CliSecretStore {
  private readonly dir: string
  private masterKey: Buffer | null = null
  private entries: SecretMap = {}
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(dir: string) {
    this.dir = dir
  }

  private masterKeyPath(): string {
    return join(this.dir, '.master.key')
  }

  private secretsPath(): string {
    return join(this.dir, 'secrets.enc.json')
  }

  private async ensureMasterKey(): Promise<Buffer> {
    if (this.masterKey) return this.masterKey
    const keyPath = this.masterKeyPath()
    try {
      const raw = await readFile(keyPath)
      if (raw.length === MASTER_KEY_BYTES) {
        this.masterKey = raw
        return raw
      }
      const hexOrText = raw.toString('utf8').trim()
      if (/^[0-9a-f]{64}$/i.test(hexOrText)) {
        const parsed = Buffer.from(hexOrText, 'hex')
        this.masterKey = parsed
        return parsed
      }
    } catch {
      // Missing key file: generate one below.
    }
    const generated = randomBytes(MASTER_KEY_BYTES)
    await writeFileSecureAtomic(keyPath, generated)
    this.masterKey = generated
    return generated
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await this.ensureMasterKey()
    try {
      const raw = await readFile(this.secretsPath(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.entries = parsed as SecretMap
      } else {
        this.entries = {}
      }
    } catch {
      this.entries = {}
    }
    this.loaded = true
  }

  async get(key: string): Promise<string | null> {
    if (!this.loaded) await this.load()
    const entry = this.entries[key]
    if (!entry || entry.v !== 1) return null
    const mk = await this.ensureMasterKey()
    try {
      const decipher = createDecipheriv('aes-256-gcm', mk, Buffer.from(entry.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
      const dec = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()])
      return dec.toString('utf8')
    } catch {
      return null
    }
  }

  async set(key: string, value: string | null): Promise<void> {
    const task = this.writeQueue.then(async () => {
      if (!this.loaded) await this.load()
      if (value === null || value === '') {
        delete this.entries[key]
      } else {
        const mk = await this.ensureMasterKey()
        const iv = randomBytes(IV_BYTES)
        const cipher = createCipheriv('aes-256-gcm', mk, iv)
        const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        const tag = cipher.getAuthTag()
        this.entries[key] = {
          v: 1,
          iv: iv.toString('base64'),
          tag: tag.toString('base64'),
          data: enc.toString('base64'),
        }
      }
      await writeFileSecureAtomic(this.secretsPath(), JSON.stringify(this.entries, null, 2))
    })
    this.writeQueue = task.catch(() => undefined)
    return task
  }
}

/** Validates and opens an HTTP(S) URL in the default browser when a desktop session exists. */
export async function openExternalUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open non-HTTP URL: ${parsed.protocol}`)
  }
  const href = parsed.href
  process.stderr.write(`Opening browser: ${href}\n`)

  try {
    let cmd: string
    let args: string[]
    if (process.platform === 'win32') {
      cmd = 'cmd'
      args = ['/c', 'start', '', href]
    } else if (process.platform === 'darwin') {
      cmd = 'open'
      args = [href]
    } else {
      cmd = 'xdg-open'
      args = [href]
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Headless SSH environments fall back cleanly to the printed URL above.
  }
}

export function resolveEnvProxy(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    const host = u.hostname.toLowerCase()
    if (noProxy.some((e) => e === '*' || host === e.replace(/^\*?\./, '') || host.endsWith(`.${e.replace(/^\*?\./, '')}`))) {
      return 'DIRECT'
    }
    const candidate =
      (u.protocol === 'http:'
        ? process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy
        : process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
    const clean = candidate?.trim()
    if (!clean) return 'DIRECT'
    const proxyUrl = new URL(clean)
    if (proxyUrl.protocol === 'https:') return `HTTPS ${proxyUrl.host}`
    if (proxyUrl.protocol === 'http:') return `PROXY ${proxyUrl.host}`
    return 'DIRECT'
  } catch {
    return 'DIRECT'
  }
}

function headlessGuiError(surface: 'Browser' | 'Desktop'): never {
  throw new Error(`${surface} automation is only available in the Atrium desktop app, not in headless CLI mode.`)
}

/** Builds a HostCall adapter suitable for headless CLI execution on Windows, macOS, and Linux. */
export function createCliHostCall(secretStore: CliSecretStore): HostCall {
  return (async (method: string, ...args: unknown[]) => {
    switch (method) {
      case 'secrets.get':
        return secretStore.get(String(args[0] ?? ''))
      case 'secrets.set':
        await secretStore.set(String(args[0] ?? ''), (args[1] as string | null) ?? null)
        return undefined
      case 'net.resolveProxy':
        return resolveEnvProxy(String(args[0] ?? ''))
      case 'app.openExternal':
        await openExternalUrl(String(args[0] ?? ''))
        return undefined
      case 'app.focusMain':
      case 'app.notify':
      case 'app.setBackgroundActive':
      case 'computer.setHud':
        return undefined
      case 'app.updateQuickShortcut':
        return { ok: true }
      case 'browser.state':
      case 'browser.open':
      case 'browser.action':
      case 'browser.capture':
      case 'browser.eval':
      case 'browser.setMode':
        return headlessGuiError('Browser') as unknown as BrowserSnapshot
      case 'computer.screenshot':
      case 'computer.mouse':
      case 'computer.keyboard':
      case 'computer.window':
      case 'computer.wait':
        return headlessGuiError('Desktop') as unknown as DesktopSnapshot
      default:
        throw new Error(`Unsupported CLI host method: ${method}`)
    }
  }) as HostCall
}
