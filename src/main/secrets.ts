// API keys and MCP tokens, encrypted with the OS key store (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux) and kept in one file in userData.
import { safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class SecretStore {
  private values = new Map<string, string>()
  private loaded = false
  private writing: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>
      for (const [key, value] of Object.entries(raw)) this.values.set(key, value)
    } catch {
      /* first run, or unreadable: start empty */
    }
  }

  async get(key: string): Promise<string | null> {
    await this.load()
    const stored = this.values.get(key)
    if (!stored) return null
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      // Encrypted under another OS account or a reset key store.
      return null
    }
  }

  async set(key: string, value: string | null): Promise<void> {
    await this.load()
    if (value === null || value === '') this.values.delete(key)
    else {
      if (!this.available()) {
        throw new Error('This computer has no secure key store, so Atrium cannot save keys.')
      }
      this.values.set(key, safeStorage.encryptString(value).toString('base64'))
    }
    const snapshot = JSON.stringify(Object.fromEntries(this.values), null, 2)
    this.writing = this.writing.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, this.file)
    })
    await this.writing
  }
}
