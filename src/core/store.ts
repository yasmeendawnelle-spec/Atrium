// Small JSON persistence helpers. Writes are atomic (temp file + rename) and
// serialized per file, so a crash never leaves a half-written config.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const queues = new Map<string, Promise<void>>()

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    // A corrupt file should not brick the app. Keep a copy and start fresh.
    try {
      await rename(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return fallback
  }
}

export function writeJson(path: string, value: unknown, opts?: { compact?: boolean }): Promise<void> {
  const prev = queues.get(path) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      const json = opts?.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)
      await writeFile(tmp, json, 'utf8')
      await rename(tmp, path)
    })
  queues.set(path, next)
  void next.finally(() => {
    if (queues.get(path) === next) queues.delete(path)
  })
  return next
}

export async function removeFile(path: string): Promise<void> {
  await (queues.get(path) ?? Promise.resolve()).catch(() => undefined)
  await rm(path, { force: true })
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}
