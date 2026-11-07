// Tracks per-conversation file checkpoints (pre-images) for instant preview & revert,
// even when the workspace is not a Git repository.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileChangeEntry } from '../../shared/types.ts'
import { readJson, removeFile, writeJson } from '../store.ts'
import { countDiffLines } from './git.ts'
import { buildCompactDiff } from './patch.ts'
import { resolveInside, resolveInsideReal, WorkspaceError } from './workspace.ts'

export interface CheckpointSnapshot {
  path: string
  fromPath?: string
  beforeExists: boolean
  beforeContent?: string
  updatedAt?: number
}

interface StoredCheckpoint {
  path: string
  fromPath?: string
  beforeExists: boolean
  beforeContent?: string
  updatedAt: number
}

export interface TurnSnapshotRecord {
  id: string
  messageIndex: number
  timestamp: number
  snapshots: CheckpointSnapshot[]
}

function normRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

async function resolveSafeWrite(workspace: string, rel: string): Promise<string> {
  const lexical = resolveInside(workspace, rel)
  try {
    return await resolveInsideReal(workspace, rel)
  } catch (err) {
    if (err instanceof WorkspaceError) throw err
    return lexical
  }
}

export async function snapshotExistingFile(workspace: string, relPath: string): Promise<CheckpointSnapshot> {
  const clean = normRel(relPath)
  try {
    const abs = await resolveInsideReal(workspace, clean)
    const content = await readFile(abs, 'utf8')
    return { path: clean, beforeExists: true, beforeContent: content }
  } catch (err) {
    if (err instanceof WorkspaceError) throw err
    return { path: clean, beforeExists: false }
  }
}

export class CheckpointStore {
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'checkpoints')
  }

  private file(conversationId: string): string {
    return join(this.dir, `${conversationId}.json`)
  }

  private turnsFile(conversationId: string): string {
    return join(this.dir, `${conversationId}.turns.json`)
  }

  async load(conversationId: string): Promise<StoredCheckpoint[]> {
    return readJson(this.file(conversationId), [] as StoredCheckpoint[])
  }

  async loadTurns(conversationId: string): Promise<TurnSnapshotRecord[]> {
    return readJson(this.turnsFile(conversationId), [] as TurnSnapshotRecord[])
  }

  async recordTurn(conversationId: string, messageIndex: number, snapshots: CheckpointSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return
    const existing = await this.loadTurns(conversationId)
    existing.push({
      id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      messageIndex,
      timestamp: Date.now(),
      snapshots: snapshots.map((s) => ({
        path: normRel(s.path),
        ...(s.fromPath ? { fromPath: normRel(s.fromPath) } : {}),
        beforeExists: s.beforeExists,
        ...(s.beforeExists ? { beforeContent: s.beforeContent ?? '' } : {}),
        updatedAt: s.updatedAt ?? Date.now(),
      })),
    })
    await writeJson(this.turnsFile(conversationId), existing)
  }

  async record(conversationId: string, snapshots: CheckpointSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return
    const existing = await this.load(conversationId)
    const byPath = new Map(existing.map((c) => [normRel(c.path), c]))
    const now = Date.now()

    for (const snap of snapshots) {
      const key = normRel(snap.path)
      if (snap.fromPath) {
        const oldKey = normRel(snap.fromPath)
        const prevOld = byPath.get(oldKey)
        if (prevOld) {
          // Carry forward earliest pre-image from the source file.
          byPath.delete(oldKey)
          if (!byPath.has(key)) {
            byPath.set(key, {
              path: key,
              fromPath: prevOld.fromPath ?? oldKey,
              beforeExists: prevOld.beforeExists,
              beforeContent: prevOld.beforeContent,
              updatedAt: now,
            })
            continue
          }
        }
      }
      const prev = byPath.get(key)
      if (prev) {
        // Preserve original pre-image before Atrium touched this file in this chat.
        prev.updatedAt = now
      } else {
        byPath.set(key, {
          path: key,
          ...(snap.fromPath ? { fromPath: normRel(snap.fromPath) } : {}),
          beforeExists: snap.beforeExists,
          ...(snap.beforeExists ? { beforeContent: snap.beforeContent ?? '' } : {}),
          updatedAt: snap.updatedAt ?? now,
        })
      }
    }

    await writeJson(this.file(conversationId), [...byPath.values()])
  }

  async entries(conversationId: string, workspace: string): Promise<FileChangeEntry[]> {
    const stored = await this.load(conversationId)
    const out: FileChangeEntry[] = []

    for (const item of stored) {
      let currentExists = false
      let currentContent: string | undefined
      try {
        const abs = await resolveInsideReal(workspace, item.path)
        currentContent = await readFile(abs, 'utf8')
        currentExists = true
      } catch {
        currentExists = false
      }

      if (!item.beforeExists && !currentExists) continue
      if (item.beforeExists && currentExists && !item.fromPath && item.beforeContent === currentContent) continue

      const status: FileChangeEntry['status'] = item.fromPath
        ? 'renamed'
        : !item.beforeExists
          ? 'added'
          : !currentExists
            ? 'deleted'
            : 'modified'

      const diff = buildCompactDiff(item.path, item.beforeContent, currentContent, item.fromPath)
      const { additions, deletions } = countDiffLines(diff)
      out.push({
        path: item.path,
        ...(item.fromPath ? { fromPath: item.fromPath } : {}),
        status,
        additions,
        deletions,
        diff: diff.slice(0, 48_000),
        revertible: true,
        updatedAt: item.updatedAt,
      })
    }

    return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  private async applyRevertItem(
    workspace: string,
    item: Pick<CheckpointSnapshot, 'path' | 'fromPath' | 'beforeExists' | 'beforeContent'>,
  ): Promise<void> {
    if (item.fromPath && item.fromPath !== item.path) {
      const curAbs = await resolveSafeWrite(workspace, item.path)
      await rm(curAbs, { force: true }).catch(() => undefined)
      if (item.beforeExists) {
        const origAbs = await resolveSafeWrite(workspace, item.fromPath)
        await mkdir(dirname(origAbs), { recursive: true })
        await writeFile(origAbs, item.beforeContent ?? '', 'utf8')
      }
    } else if (item.beforeExists) {
      const abs = await resolveSafeWrite(workspace, item.path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, item.beforeContent ?? '', 'utf8')
    } else {
      const abs = await resolveSafeWrite(workspace, item.path)
      await rm(abs, { force: true })
    }
  }

  private async removeKeysFromCheckpoints(conversationId: string, keys: Set<string>): Promise<void> {
    const stored = await this.load(conversationId)
    const next = stored.filter((c) => !keys.has(normRel(c.path)))
    if (next.length > 0) await writeJson(this.file(conversationId), next)
    else await removeFile(this.file(conversationId))

    const turns = await this.loadTurns(conversationId)
    if (turns.length > 0) {
      const filtered = turns
        .map((t) => ({ ...t, snapshots: t.snapshots.filter((s) => !keys.has(normRel(s.path))) }))
        .filter((t) => t.snapshots.length > 0)
      if (filtered.length > 0) await writeJson(this.turnsFile(conversationId), filtered)
      else await removeFile(this.turnsFile(conversationId))
    }
  }

  /** Clears tracked checkpoint entries after files were committed in Git, without touching disk. */
  async markCommitted(conversationId: string, paths?: string[]): Promise<void> {
    if (!paths || paths.length === 0) {
      await this.deleteChat(conversationId)
      return
    }
    const keys = new Set(paths.map((p) => normRel(p)))
    await this.removeKeysFromCheckpoints(conversationId, keys)
  }

  async revertFile(conversationId: string, workspace: string, targetPath: string): Promise<void> {
    const stored = await this.load(conversationId)
    const key = normRel(targetPath)
    const item = stored.find((c) => normRel(c.path) === key)
    if (!item) throw new Error(`No revertible checkpoint found for "${targetPath}".`)

    await this.applyRevertItem(workspace, item)
    await this.removeKeysFromCheckpoints(conversationId, new Set([key]))
  }

  async rewindToTurn(conversationId: string, workspace: string, minMessageIndex: number): Promise<string[]> {
    const turns = await this.loadTurns(conversationId)
    if (turns.length === 0) return []
    const kept = turns.filter((r) => r.messageIndex < minMessageIndex)
    const toUndo = turns.filter((r) => r.messageIndex >= minMessageIndex)
    if (toUndo.length === 0) return []

    const reverted = new Set<string>()
    for (let i = toUndo.length - 1; i >= 0; i--) {
      const rec = toUndo[i]!
      for (let j = rec.snapshots.length - 1; j >= 0; j--) {
        const snap = rec.snapshots[j]!
        await this.applyRevertItem(workspace, snap)
        reverted.add(snap.path)
        if (snap.fromPath) reverted.add(snap.fromPath)
      }
    }

    if (kept.length === 0) {
      await removeFile(this.turnsFile(conversationId))
      await removeFile(this.file(conversationId))
    } else {
      await writeJson(this.turnsFile(conversationId), kept)
      // Rebuild aggregate checkpoint file purely from kept earliest snapshots.
      await removeFile(this.file(conversationId))
      for (const rec of kept) {
        await this.record(conversationId, rec.snapshots)
      }
    }
    return [...reverted]
  }

  async revertAll(conversationId: string, workspace: string): Promise<void> {
    const stored = await this.load(conversationId)
    for (let i = stored.length - 1; i >= 0; i--) {
      await this.revertFile(conversationId, workspace, stored[i]!.path)
    }
    await removeFile(this.file(conversationId))
    await removeFile(this.turnsFile(conversationId))
  }

  async deleteChat(conversationId: string): Promise<void> {
    await removeFile(this.file(conversationId))
    await removeFile(this.turnsFile(conversationId))
  }
}
