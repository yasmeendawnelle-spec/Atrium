// Every built-in file tool resolves paths through here, so a model can never
// be talked into reading or writing outside the folder the user chose.
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path'

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/

/** Rejects anything that is not a plain relative path inside the workspace. */
export function resolveInside(workspace: string, requested: string): string {
  if (!requested || typeof requested !== 'string') {
    throw new WorkspaceError('A file path is required.')
  }
  const trimmed = requested.trim()
  if (isAbsolute(trimmed) || WINDOWS_ABS.test(trimmed) || trimmed.startsWith('\\\\')) {
    throw new WorkspaceError(`"${trimmed}" is outside the workspace. Use a path relative to it.`)
  }
  const root = resolve(workspace)
  const target = resolve(root, trimmed)
  const rel = relative(root, target)
  if (rel === '' || rel === '.') return root
  if (rel.startsWith('..') || win32.isAbsolute(rel)) {
    throw new WorkspaceError(`"${trimmed}" is outside the workspace.`)
  }
  return target
}

/**
 * Like resolveInside, but follows symlinks and rejects targets that land
 * outside the workspace. Missing files are allowed (for writes).
 */
export async function resolveInsideReal(workspace: string, requested: string): Promise<string> {
  const target = resolveInside(workspace, requested)
  const root = await existingReal(resolve(workspace))
  // Walk up to the nearest part of the path that exists, resolve its links,
  // check it is still inside, then put back the parts that do not exist yet.
  let cursor = target
  const missing: string[] = []
  while (true) {
    try {
      const real = await realpath(cursor)
      const rel = relative(root, real)
      if (rel.startsWith('..') || win32.isAbsolute(rel)) {
        throw new WorkspaceError(`"${requested}" points outside the workspace through a link.`)
      }
      return missing.length ? join(real, ...missing.reverse()) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = dirname(cursor)
      if (parent === cursor) throw new WorkspaceError(`"${requested}" is outside the workspace.`)
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

async function existingReal(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    throw new WorkspaceError('The workspace folder no longer exists. Pick it again in Settings.')
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
