import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveInside, resolveInsideReal, WorkspaceError } from '../src/core/tools/workspace.ts'

const root = resolve(tmpdir(), 'atrium-ws')

test('accepts paths inside the workspace', () => {
  assert.equal(resolveInside(root, 'src/app.ts'), join(root, 'src', 'app.ts'))
  assert.equal(resolveInside(root, '.'), root)
  assert.equal(resolveInside(root, 'a/../b.txt'), join(root, 'b.txt'))
})

test('rejects paths that escape the workspace', () => {
  for (const bad of ['../secret.txt', 'a/../../x', 'C:\\Windows\\system.ini', 'D:/x', '/etc/passwd', '\\\\server\\share\\x', '']) {
    assert.throws(() => resolveInside(root, bad), WorkspaceError, bad)
  }
})

test('rejects a link that points outside the workspace', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'atrium-link-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const ws = join(base, 'ws')
  const outside = join(base, 'outside')
  await mkdir(ws)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'x')
  try {
    // Junctions need no admin rights on Windows.
    await symlink(outside, join(ws, 'link'), 'junction')
  } catch {
    t.skip('this system does not allow creating links')
    return
  }
  await assert.rejects(resolveInsideReal(ws, 'link/secret.txt'), WorkspaceError)
  // A file that does not exist yet, inside the workspace, is fine (for writes).
  assert.equal(await resolveInsideReal(ws, 'new/file.txt'), join(await realRoot(ws), 'new', 'file.txt'))
})

async function realRoot(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}
