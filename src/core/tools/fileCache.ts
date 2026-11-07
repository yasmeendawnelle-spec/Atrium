// Short-TTL cache for workspace relative file listings used by @-mentions and UI drawers.
import { resolve, sep } from 'node:path'

interface WorkspaceFileCacheEntry {
  realRoot: string
  rawRoots: Set<string>
  files: string[]
  limit: number
  truncated: boolean
  at: number
}

const WORKSPACE_FILES_TTL_MS = 5_000
const cache = new Map<string, WorkspaceFileCacheEntry>()

function normalizePath(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function sameOrInside(parent: string, target: string): boolean {
  return target === parent || target.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

export function getCachedWorkspaceFiles(realRoot: string, rawRoot: string, limit: number): string[] | null {
  const key = normalizePath(realRoot)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at >= WORKSPACE_FILES_TTL_MS) {
    cache.delete(key)
    return null
  }
  entry.rawRoots.add(normalizePath(rawRoot))
  if (!entry.truncated || limit <= entry.limit) {
    return entry.files.slice(0, limit)
  }
  return null
}

export function setCachedWorkspaceFiles(
  realRoot: string,
  rawRoot: string,
  limit: number,
  files: string[],
  truncated: boolean,
): void {
  const key = normalizePath(realRoot)
  cache.set(key, {
    realRoot: key,
    rawRoots: new Set([key, normalizePath(rawRoot)]),
    files: [...files],
    limit,
    truncated,
    at: Date.now(),
  })
}

/** Clears cached file lists matching a workspace root or modified file path (or all entries if omitted). */
export function invalidateWorkspaceFilesCache(target?: string): void {
  if (!target) {
    cache.clear()
    return
  }
  const normTarget = normalizePath(target)
  for (const [key, entry] of cache) {
    if (sameOrInside(key, normTarget) || sameOrInside(normTarget, key)) {
      cache.delete(key)
      continue
    }
    for (const raw of entry.rawRoots) {
      if (sameOrInside(raw, normTarget) || sameOrInside(normTarget, raw)) {
        cache.delete(key)
        break
      }
    }
  }
}
