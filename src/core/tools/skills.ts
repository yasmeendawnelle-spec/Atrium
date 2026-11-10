// Agent Skills: progressive-disclosure SKILL.md discovery, prompt summary, and on-demand loader.
import { mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import type { SkillDetail, SkillDraft, SkillInfo, SkillScope, ToolInfo } from '../../shared/types.ts'
import { resolveInsideReal, WorkspaceError } from './workspace.ts'

const MAX_SKILL_BYTES = 160_000
const MAX_LIST_FILES = 60

export const LOAD_SKILL_TOOL: ToolInfo = {
  name: 'load_skill',
  description:
    'Load the full instructions (SKILL.md) or a bundled reference/script file for an installed skill listed in <available_skills>.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact skill name from <available_skills>.' },
      file: {
        type: 'string',
        description:
          'Optional relative file path inside the skill folder (for example "references/guide.md"). Omit to load SKILL.md.',
      },
    },
    required: ['name'],
  },
}

interface DiscoveryRoot {
  root: string
  scope: SkillScope
  source: string
  pluginId?: string
  pluginName?: string
}

export interface PluginSkillSource {
  pluginId: string
  pluginName: string
  dir: string
  extraDirs?: string[]
  bareSkillDir?: string
  commandsDir?: string
}

interface ParsedSkill {
  name: string
  description: string
  body: string
  raw: string
}

function unquoteYaml(val: string): string {
  const s = val.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"')
  }
  return s
}

export function parseSkillMarkdown(raw: string, fallbackName: string): ParsedSkill {
  const normalized = raw.replace(/\r\n/g, '\n')
  let name = ''
  let description = ''
  let body = normalized

  if (normalized.startsWith('---\n')) {
    const closeIdx = normalized.indexOf('\n---\n', 4)
    const eofCloseIdx = closeIdx === -1 && normalized.endsWith('\n---') ? normalized.length - 4 : closeIdx
    if (eofCloseIdx !== -1) {
      const fm = normalized.slice(4, eofCloseIdx)
      body = normalized.slice(eofCloseIdx + (closeIdx !== -1 ? 5 : 4)).trimStart()
      const lines = fm.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
        if (!m?.[1]) continue
        const key = m[1].toLowerCase()
        let value = (m[2] ?? '').trim()
        if (value === '|' || value === '>') {
          const block: string[] = []
          while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1] ?? '')) {
            i++
            block.push((lines[i] ?? '').replace(/^[ \t]{1,2}/, ''))
          }
          value = block.join(value === '>' ? ' ' : '\n').trim()
        } else {
          value = unquoteYaml(value)
        }
        if (key === 'name' && value) name = value
        if (key === 'description' && value) description = value
      }
    }
  }

  if (!name) name = fallbackName
  if (!description) {
    const firstProse = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('---'))
    description = (firstProse ?? `${name} skill instructions`).slice(0, 180)
  }

  return { name: name.trim(), description: description.trim(), body, raw: normalized }
}

function slugifySkillName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

async function listRelativeFiles(rootDir: string, depth = 0, baseDir = rootDir, acc: string[] = []): Promise<string[]> {
  if (depth > 3 || acc.length >= MAX_LIST_FILES) return acc
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return acc
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (acc.length >= MAX_LIST_FILES) break
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(rootDir, entry.name)
    let isDir = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      try {
        isDir = (await stat(full)).isDirectory()
      } catch {
        continue
      }
    }
    if (isDir) {
      await listRelativeFiles(full, depth + 1, baseDir, acc)
    } else {
      acc.push(relative(baseDir, full).replace(/\\/g, '/'))
    }
  }
  return acc
}

export interface SkillsDeps {
  appDir: string
  homeDir?: string
  getDisabled: () => string[]
  setDisabled: (names: string[]) => void
  getPluginSources?: () => Promise<PluginSkillSource[]>
}

export class SkillsManager {
  private readonly deps: SkillsDeps

  constructor(deps: SkillsDeps) {
    this.deps = deps
  }

  private async discoveryRoots(workspace?: string): Promise<DiscoveryRoot[]> {
    const roots: DiscoveryRoot[] = []
    if (workspace) {
      roots.push(
        { root: join(workspace, '.agents', 'skills'), scope: 'workspace', source: '.agents/skills' },
        { root: join(workspace, '.claude', 'skills'), scope: 'workspace', source: '.claude/skills' },
        { root: join(workspace, '.codex', 'skills'), scope: 'workspace', source: '.codex/skills' },
        { root: join(workspace, 'skills'), scope: 'workspace', source: 'skills' },
      )
    }
    const home = this.deps.homeDir ?? homedir()
    if (home) {
      roots.push(
        { root: join(home, '.agents', 'skills'), scope: 'user', source: '~/.agents/skills' },
        { root: join(home, '.claude', 'skills'), scope: 'user', source: '~/.claude/skills' },
        { root: join(home, '.codex', 'skills'), scope: 'user', source: '~/.codex/skills' },
      )
    }
    if (this.deps.getPluginSources) {
      const sources = await this.deps.getPluginSources()
      for (const ps of sources) {
        const dirs = [ps.dir, ...(ps.extraDirs ?? [])]
        for (const dir of dirs) {
          roots.push({
            root: dir,
            scope: 'plugin',
            source: ps.pluginName,
            pluginId: ps.pluginId,
            pluginName: ps.pluginName,
          })
        }
      }
    }
    roots.push({ root: join(this.deps.appDir, 'skills'), scope: 'app', source: 'app/skills' })
    return roots
  }

  private async addSkillFromDir(
    seen: Map<string, SkillInfo>,
    disabled: Set<string>,
    opts: {
      skillDir: string
      fallbackName: string
      scope: SkillScope
      source: string
      pluginId?: string
      pluginName?: string
    },
  ): Promise<void> {
    const skillFile = join(opts.skillDir, 'SKILL.md')
    let raw: string
    try {
      raw = await readFile(skillFile, 'utf8')
    } catch {
      return
    }

    const parsed = parseSkillMarkdown(raw, opts.fallbackName)
    const key = parsed.name.toLowerCase()
    if (seen.has(key)) return

    let hasScripts = false
    let hasReferences = false
    try {
      const children = await readdir(opts.skillDir)
      hasScripts = children.includes('scripts')
      hasReferences = children.includes('references')
    } catch {
      // ignore
    }

    seen.set(key, {
      name: parsed.name,
      description: parsed.description,
      scope: opts.scope,
      source: opts.source,
      path: skillFile,
      dir: opts.skillDir,
      enabled: !disabled.has(key),
      ...(opts.pluginId ? { pluginId: opts.pluginId, pluginName: opts.pluginName } : {}),
      hasScripts,
      hasReferences,
    })
  }

  async list(workspace?: string): Promise<SkillInfo[]> {
    const disabled = new Set(this.deps.getDisabled().map((s) => s.toLowerCase()))
    const seen = new Map<string, SkillInfo>()

    for (const { root, scope, source, pluginId, pluginName } of await this.discoveryRoots(workspace)) {
      let entries
      try {
        entries = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const skillDir = join(root, entry.name)
        let isDir = entry.isDirectory()
        if (!isDir && entry.isSymbolicLink()) {
          try {
            isDir = (await stat(skillDir)).isDirectory()
          } catch {
            continue
          }
        }
        if (!isDir) continue
        await this.addSkillFromDir(seen, disabled, {
          skillDir,
          fallbackName: entry.name,
          scope,
          source,
          pluginId,
          pluginName,
        })
      }
    }

    if (this.deps.getPluginSources) {
      const sources = await this.deps.getPluginSources()
      for (const ps of sources) {
        if (ps.bareSkillDir) {
          await this.addSkillFromDir(seen, disabled, {
            skillDir: ps.bareSkillDir,
            fallbackName: basename(ps.bareSkillDir),
            scope: 'plugin',
            source: ps.pluginName,
            pluginId: ps.pluginId,
            pluginName: ps.pluginName,
          })
        }
        if (!ps.commandsDir) continue
        let cmdEntries
        try {
          cmdEntries = await readdir(ps.commandsDir, { withFileTypes: true })
        } catch {
          continue
        }
        cmdEntries.sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of cmdEntries) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
          const cmdFile = join(ps.commandsDir, entry.name)
          let raw: string
          try {
            raw = await readFile(cmdFile, 'utf8')
          } catch {
            continue
          }
          const parsed = parseSkillMarkdown(raw, basename(entry.name, '.md'))
          const key = parsed.name.toLowerCase()
          if (seen.has(key)) continue
          seen.set(key, {
            name: parsed.name,
            description: parsed.description,
            scope: 'plugin',
            source: ps.pluginName,
            path: cmdFile,
            dir: ps.commandsDir,
            enabled: !disabled.has(key),
            pluginId: ps.pluginId,
            pluginName: ps.pluginName,
          })
        }
      }
    }

    const order: Record<SkillScope, number> = { workspace: 0, user: 1, plugin: 2, app: 3 }
    return [...seen.values()].sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name))
  }

  async get(name: string, workspace?: string): Promise<SkillDetail | null> {
    const all = await this.list(workspace)
    const target = all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
    if (!target) return null
    const content = await readFile(target.path, 'utf8')
    if (basename(target.path).toUpperCase() !== 'SKILL.MD') {
      return { ...target, content, files: [basename(target.path)] }
    }
    const realDir = await realpath(target.dir).catch(() => target.dir)
    const files = await listRelativeFiles(realDir)
    return { ...target, content, files }
  }

  async setEnabled(name: string, enabled: boolean, workspace?: string): Promise<SkillInfo[]> {
    const key = name.trim().toLowerCase()
    const current = new Set(this.deps.getDisabled().map((s) => s.toLowerCase()))
    if (enabled) current.delete(key)
    else current.add(key)
    this.deps.setDisabled([...current])
    return this.list(workspace)
  }

  async create(draft: SkillDraft, workspace?: string): Promise<SkillInfo> {
    const slug = slugifySkillName(draft.name)
    if (!slug) throw new Error('Skill name must contain letters or numbers.')
    const description = draft.description.trim() || `${slug} workflow skill`
    const body = draft.content.trim() || `# ${slug}\n\nDescribe step-by-step instructions here.\n`

    const useWorkspace = Boolean(workspace) && draft.scope !== 'user'
    const home = this.deps.homeDir ?? homedir()
    const parent = useWorkspace ? join(workspace!, '.agents', 'skills') : join(home, '.agents', 'skills')
    const dir = join(parent, slug)
    const file = join(dir, 'SKILL.md')

    await mkdir(dir, { recursive: true })
    const doc = [
      '---',
      `name: ${slug}`,
      `description: ${JSON.stringify(description)}`,
      '---',
      '',
      body,
      '',
    ].join('\n')
    await writeFile(file, doc, 'utf8')

    // Ensure a newly created skill starts enabled even if a stale disable entry existed.
    await this.setEnabled(slug, true, workspace)
    const list = await this.list(workspace)
    const created = list.find((s) => s.name.toLowerCase() === slug)
    if (!created) throw new Error(`Failed to load created skill "${slug}".`)
    return created
  }

  async remove(name: string, workspace?: string): Promise<void> {
    const all = await this.list(workspace)
    const target = all.find((s) => s.name.toLowerCase() === name.trim().toLowerCase())
    if (!target) return

    const st = await stat(target.dir).catch(() => null)
    // Remove symlink entry only if target.dir itself is a symlink; otherwise delete the skill directory.
    try {
      await unlink(target.dir)
    } catch {
      if (st) await rm(target.dir, { recursive: true, force: true })
    }

    const key = target.name.toLowerCase()
    const nextDisabled = this.deps.getDisabled().filter((s) => s.toLowerCase() !== key)
    if (nextDisabled.length !== this.deps.getDisabled().length) this.deps.setDisabled(nextDisabled)
  }

  async formatAvailableSkillsPrompt(workspace?: string): Promise<string> {
    const enabled = (await this.list(workspace)).filter((s) => s.enabled)
    if (!enabled.length) return ''
    const lines = enabled.map((s) => `- ${s.name} (${s.source}): ${s.description}`)
    return [
      '<available_skills>',
      'Specialized skills are installed. Before executing a task covered by a skill below, or when the user invokes `/<skill-name>`, call `load_skill` with its exact `name` to read its full instructions and conventions:',
      ...lines,
      '</available_skills>',
    ].join('\n')
  }

  async runLoadSkill(
    workspace: string | undefined,
    name: string,
    file?: string,
  ): Promise<{ output: string; isError: boolean }> {
    const cleanName = name.trim()
    if (!cleanName) return { output: 'Skill name is required.', isError: true }

    const detail = await this.get(cleanName, workspace)
    if (!detail) return { output: `Skill "${cleanName}" was not found.`, isError: true }
    if (!detail.enabled) return { output: `Skill "${detail.name}" is currently disabled.`, isError: true }

    if (!file || file.trim() === '' || file.trim() === 'SKILL.md') {
      const body = detail.content.length > MAX_SKILL_BYTES ? detail.content.slice(0, MAX_SKILL_BYTES) + '\n…[truncated]' : detail.content
      const header = [
        `# Skill: ${detail.name} (${detail.source})`,
        `Directory: ${detail.dir}`,
        `Files: ${detail.files.length ? detail.files.join(', ') : 'SKILL.md'}`,
        '',
        body,
      ].join('\n')
      return { output: header, isError: false }
    }

    try {
      const realDir = await realpath(detail.dir)
      const full = await resolveInsideReal(realDir, file.trim())
      const content = await readFile(full, 'utf8')
      const out = content.length > MAX_SKILL_BYTES ? content.slice(0, MAX_SKILL_BYTES) + '\n…[truncated]' : content
      return { output: out, isError: false }
    } catch (err) {
      return {
        output: err instanceof WorkspaceError ? err.message : (err as Error).message,
        isError: true,
      }
    }
  }
}
