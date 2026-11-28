// Local coding-agent discovery, CLI command builders, unified stream parsers, and process runner.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { normalizeReasoningEffort, type ReasoningEffort } from '../../shared/types.ts'
import { netFetch } from '../net.ts'
import type {
  PlatformAgentKind,
  PlatformAgentProfile,
  PlatformAgentRole,
  PlatformModelOption,
  PlatformPermissionMode,
} from '../../shared/platform.ts'

export interface BuiltinAgentCatalogEntry {
  id: string
  kind: PlatformAgentKind
  name: string
  shortName: string
  description: string
  binaries: string[]
  extraPaths: () => string[]
  versionArgs: string[]
  supportsMcpInjection: boolean
  supportsStreamJson: boolean
  supportsResume: boolean
  defaultPermissionMode: PlatformPermissionMode
  accentColor: string
  installHint: string
}

export const BUILTIN_AGENT_CATALOG: readonly BuiltinAgentCatalogEntry[] = [
  {
    id: 'atrium',
    kind: 'atrium',
    name: 'Atrium Agent',
    shortName: 'Atrium',
    description: 'Built-in Atrium runtime using your configured flagship or fast models and workspace tools.',
    binaries: [],
    extraPaths: () => [],
    versionArgs: [],
    supportsMcpInjection: true,
    supportsStreamJson: true,
    supportsResume: true,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#c46342',
    installHint: 'Built-in',
  },
  {
    id: 'claude-code',
    kind: 'claude-code',
    name: 'Claude Code',
    shortName: 'Claude',
    description: 'Anthropic Claude Code CLI with native MCP bus injection and stream-json telemetry.',
    binaries: ['claude'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [join(homedir(), '.local', 'bin', 'claude.exe'), join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd')]
        : [join(homedir(), '.local', 'bin', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude'],
    versionArgs: ['--version'],
    supportsMcpInjection: true,
    supportsStreamJson: true,
    supportsResume: true,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#d97757',
    installHint: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'agy',
    kind: 'agy',
    name: 'Antigravity (AGY)',
    shortName: 'AGY',
    description: 'Google Antigravity CLI agent with headless print/stream-json mode and conversation resume.',
    binaries: ['agy'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [
            join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
            join(homedir(), '.local', 'bin', 'agy.exe'),
          ]
        : [join(homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy'],
    versionArgs: ['--version'],
    supportsMcpInjection: false,
    supportsStreamJson: true,
    supportsResume: true,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#4f7df3',
    installHint: 'Antigravity CLI (agy)',
  },
  {
    id: 'codex',
    kind: 'codex',
    name: 'OpenAI Codex',
    shortName: 'Codex',
    description: 'OpenAI Codex CLI with headless exec --json mode, sandbox controls, and session resume.',
    binaries: ['codex'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'codex.cmd')]
        : ['/usr/local/bin/codex', '/opt/homebrew/bin/codex'],
    versionArgs: ['--version'],
    supportsMcpInjection: false,
    supportsStreamJson: true,
    supportsResume: true,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#10a37f',
    installHint: 'npm i -g @openai/codex',
  },
  {
    id: 'gemini-cli',
    kind: 'gemini-cli',
    name: 'Gemini CLI',
    shortName: 'Gemini',
    description: 'Google Gemini CLI with stream-json output, approval modes, and resumable sessions.',
    binaries: ['gemini'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'gemini.cmd')]
        : ['/usr/local/bin/gemini', '/opt/homebrew/bin/gemini'],
    versionArgs: ['--version'],
    supportsMcpInjection: false,
    supportsStreamJson: true,
    supportsResume: true,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#6366f1',
    installHint: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'dsh',
    kind: 'dsh',
    name: 'DeepSeek Harness (DSH)',
    shortName: 'DSH',
    description: 'DeepSeek Harness CLI agent.',
    binaries: ['dsh'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [join(homedir(), '.local', 'bin', 'dsh.exe'), join(homedir(), '.dsh', 'bin', 'dsh.exe')]
        : [join(homedir(), '.local', 'bin', 'dsh'), join(homedir(), '.dsh', 'bin', 'dsh')],
    versionArgs: ['--version'],
    supportsMcpInjection: false,
    supportsStreamJson: false,
    supportsResume: false,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#3b82f6',
    installHint: 'DeepSeek Harness CLI (dsh)',
  },
  {
    id: 'opencode',
    kind: 'opencode',
    name: 'OpenCode',
    shortName: 'OpenCode',
    description: 'OpenCode terminal coding agent.',
    binaries: ['opencode'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [join(homedir(), '.local', 'bin', 'opencode.exe')]
        : [join(homedir(), '.local', 'bin', 'opencode'), '/usr/local/bin/opencode'],
    versionArgs: ['--version'],
    supportsMcpInjection: false,
    supportsStreamJson: false,
    supportsResume: false,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#8b5cf6',
    installHint: 'opencode.ai',
  },
  {
    id: 'aider',
    kind: 'aider',
    name: 'Aider',
    shortName: 'Aider',
    description: 'Aider AI pair programming CLI.',
    binaries: ['aider'],
    extraPaths: () =>
      process.platform === 'win32'
        ? [join(homedir(), '.local', 'bin', 'aider.exe')]
        : [join(homedir(), '.local', 'bin', 'aider'), '/usr/local/bin/aider'],
    versionArgs: ['--version'],
    supportsMcpInjection: false,
    supportsStreamJson: false,
    supportsResume: false,
    defaultPermissionMode: 'accept_edits',
    accentColor: '#0ea5e9',
    installHint: 'pip install aider-chat',
  },
] as const

export interface SavedAgentPref {
  role?: PlatformAgentRole
  permissionMode?: PlatformPermissionMode
  modelOverride?: string
  modelProviderOverride?: string
  reasoningEffortOverride?: ReasoningEffort
  binaryPath?: string
}

export interface CustomAgentRecord {
  id: string
  name: string
  command: string
  args: string[]
  description?: string
  permissionMode: PlatformPermissionMode
}

export function resolveSpawnSpec(
  binaryPath: string,
  args: string[],
): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const ext = extname(binaryPath).toLowerCase()
    if (ext === '.ps1') {
      const siblingCmd = binaryPath.slice(0, -4) + '.cmd'
      if (existsSync(siblingCmd)) {
        return {
          command: process.env.ComSpec || 'cmd.exe',
          args: ['/d', '/s', '/c', siblingCmd, ...args],
        }
      }
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', binaryPath, ...args],
      }
    }
    if (ext === '.cmd' || ext === '.bat') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', binaryPath, ...args],
      }
    }
  }
  return { command: binaryPath, args }
}

export function resolveBinaryPath(
  names: readonly string[],
  extraCandidates: readonly string[] = [],
  overridePath?: string,
): string | undefined {
  if (overridePath?.trim()) {
    const p = resolve(overridePath.trim())
    if (existsSync(p)) return p
  }

  const pathDirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : ['']

  for (const dir of pathDirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir, name.endsWith(ext) ? name : `${name}${ext}`)
        if (existsSync(candidate)) {
          if (process.platform === 'win32' && ext === '.ps1') {
            const cmdCandidate = join(dir, `${name}.cmd`)
            if (existsSync(cmdCandidate)) return cmdCandidate
          }
          return candidate
        }
      }
    }
  }

  for (const extra of extraCandidates) {
    if (extra && existsSync(extra)) {
      if (process.platform === 'win32' && extra.toLowerCase().endsWith('.ps1')) {
        const siblingCmd = extra.slice(0, -4) + '.cmd'
        if (existsSync(siblingCmd)) return siblingCmd
      }
      return extra
    }
  }

  return undefined
}

export function probeBinaryVersion(binaryPath: string, versionArgs: readonly string[] = ['--version']): Promise<string | undefined> {
  if (!versionArgs.length) return Promise.resolve(undefined)
  return new Promise((done) => {
    const spec = resolveSpawnSpec(binaryPath, [...versionArgs])
    let settled = false
    const finish = (val: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(val)
    }
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      if (out.length < 512) out += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < 512) out += d.toString('utf8')
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish(undefined)
    }, 3500)
    child.on('error', () => finish(undefined))
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) {
        finish(undefined)
        return
      }
      const line = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0)
      finish(line ? line.slice(0, 48) : undefined)
    })
  })
}

export function parseAgyModelsOutput(raw: string): PlatformModelOption[] {
  const seen = new Set<string>()
  const out: PlatformModelOption[] = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || /^(?:fetching|loading|error|warning|usage)\b/i.test(line)) continue
    const match = /^([A-Za-z0-9._:/-]+)(?:\t+|\s{2,})(.+)$/.exec(line)
    if (match) {
      const id = match[1]!.trim()
      const label = match[2]!.trim()
      if (id && !seen.has(id)) {
        seen.add(id)
        out.push({ id, label })
      }
      continue
    }
    if (/^[A-Za-z0-9._:/-]+$/.test(line) && !seen.has(line)) {
      seen.add(line)
      out.push({ id: line })
    }
  }
  return out
}

export function probeAgyModels(binaryPath: string): Promise<PlatformModelOption[]> {
  return new Promise((done) => {
    const spec = resolveSpawnSpec(binaryPath, ['models'])
    let settled = false
    const finish = (models: PlatformModelOption[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(models)
    }
    const child = spawn(spec.command, spec.args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 32_768) stdout += d.toString('utf8')
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish([])
    }, 30_000)
    child.on('error', () => finish([]))
    child.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) {
        finish([])
        return
      }
      finish(parseAgyModelsOutput(stdout))
    })
  })
}

export interface CliConfigInfo {
  supported: boolean
  path?: string
  displayPath?: string
}

export function cliConfigInfoForKind(kind: PlatformAgentKind, homeOverride?: string): CliConfigInfo {
  const home = homeOverride || homedir()
  switch (kind) {
    case 'agy':
      return {
        supported: true,
        path: join(home, '.gemini', 'antigravity-cli', 'settings.json'),
        displayPath: '~/.gemini/antigravity-cli/settings.json',
      }
    case 'claude-code':
      return {
        supported: true,
        path: join(home, '.claude', 'settings.json'),
        displayPath: '~/.claude/settings.json',
      }
    case 'gemini-cli':
      return {
        supported: true,
        path: join(home, '.gemini', 'settings.json'),
        displayPath: '~/.gemini/settings.json',
      }
    case 'codex':
      return {
        supported: true,
        path: join(home, '.codex', 'config.toml'),
        displayPath: '~/.codex/config.toml',
      }
    case 'atrium':
      return {
        supported: true,
        displayPath: 'Atrium Settings',
      }
    default:
      return { supported: false }
  }
}

export function resolveAgyCliModelArg(model: string, availableModels?: readonly PlatformModelOption[]): string {
  const clean = model.trim()
  if (!clean) return ''
  if (availableModels?.length) {
    const exactId = availableModels.find((m) => m.id === clean)
    if (exactId) return exactId.id
    const lower = clean.toLowerCase()
    const byLabel = availableModels.find((m) => m.label && m.label.trim().toLowerCase() === lower)
    if (byLabel) return byLabel.id
  }
  return clean
}

export function resolveCliConfigModelValue(
  kind: PlatformAgentKind,
  model: string,
  availableModels?: readonly PlatformModelOption[],
): string {
  const clean = model.trim()
  if (!clean) return ''
  if (kind === 'agy' && availableModels?.length) {
    const lower = clean.toLowerCase()
    const match = availableModels.find(
      (m) => m.id === clean || (m.label && m.label.trim().toLowerCase() === lower),
    )
    if (match?.label?.trim()) return match.label.trim()
  }
  return clean
}

export async function detectLocalDefaultModel(kind: PlatformAgentKind, homeOverride?: string): Promise<string | undefined> {
  const home = homeOverride || homedir()
  try {
    if (kind === 'agy') {
      const raw = await readFile(join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')
      const json = JSON.parse(raw) as { model?: unknown }
      return typeof json.model === 'string' && json.model.trim() ? json.model.trim() : undefined
    }
    if (kind === 'claude-code') {
      const raw = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
      const json = JSON.parse(raw) as { model?: unknown; env?: Record<string, unknown> }
      if (typeof json.model === 'string' && json.model.trim()) return json.model.trim()
      const envModel = json.env?.ANTHROPIC_MODEL
      return typeof envModel === 'string' && envModel.trim() ? envModel.trim() : undefined
    }
    if (kind === 'gemini-cli') {
      const raw = await readFile(join(home, '.gemini', 'settings.json'), 'utf8')
      const json = JSON.parse(raw) as { model?: unknown }
      if (typeof json.model === 'string' && json.model.trim()) return json.model.trim()
      if (json.model && typeof json.model === 'object' && 'name' in json.model) {
        const name = (json.model as { name?: unknown }).name
        return typeof name === 'string' && name.trim() ? name.trim() : undefined
      }
      return undefined
    }
    if (kind === 'codex') {
      const raw = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        if (line.startsWith('[')) break
        const m = /^model\s*=\s*["']([^"']+)["']/.exec(line)
        if (m?.[1]?.trim()) return m[1].trim()
      }
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

export function supportsReasoningEffortForKind(kind: PlatformAgentKind): boolean {
  return kind === 'atrium' || kind === 'agy' || kind === 'claude-code' || kind === 'codex'
}

export function inferEffortFromModelName(model?: string): ReasoningEffort | undefined {
  const clean = model?.trim()
  if (!clean) return undefined
  const paren = /\((low|medium|high|xhigh|max)\)\s*$/i.exec(clean)
  if (paren?.[1]) return normalizeReasoningEffort(paren[1])
  const slug = /-(low|medium|high|xhigh|max)\s*$/i.exec(clean)
  if (slug?.[1]) return normalizeReasoningEffort(slug[1])
  return undefined
}

export function resolveAgyVariantForEffort(
  model: string,
  effort: ReasoningEffort,
  availableModels?: readonly PlatformModelOption[],
): PlatformModelOption | undefined {
  const clean = model.trim()
  if (!clean || effort === 'auto' || !availableModels?.length) return undefined
  const canonicalId = resolveAgyCliModelArg(clean, availableModels)
  const baseId = canonicalId.replace(/-(low|medium|high|xhigh|max)$/i, '').toLowerCase()
  const targetId = `${baseId}-${effort}`
  return availableModels.find((m) => m.id.toLowerCase() === targetId)
}

export async function detectLocalDefaultEffort(
  kind: PlatformAgentKind,
  defaultModel?: string,
  homeOverride?: string,
): Promise<ReasoningEffort | undefined> {
  const home = homeOverride || homedir()
  try {
    if (kind === 'agy') {
      return inferEffortFromModelName(defaultModel)
    }
    if (kind === 'claude-code') {
      const raw = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
      const json = JSON.parse(raw) as { effortLevel?: unknown }
      if (typeof json.effortLevel === 'string' && json.effortLevel.trim()) {
        return normalizeReasoningEffort(json.effortLevel)
      }
      return undefined
    }
    if (kind === 'codex') {
      const raw = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
      for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        if (line.startsWith('[')) break
        const m = /^model_reasoning_effort\s*=\s*["']([^"']+)["']/.exec(line)
        if (m?.[1]?.trim()) return normalizeReasoningEffort(m[1])
      }
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function writeLocalDefaultEffort(
  kind: PlatformAgentKind,
  effort: ReasoningEffort,
  homeOverride?: string,
): Promise<ReasoningEffort> {
  if (effort === 'auto') return 'auto'
  const info = cliConfigInfoForKind(kind, homeOverride)
  if (!info.supported || !info.path) {
    throw new Error(`Writing local default reasoning effort is not supported for agent "${kind}".`)
  }
  if (kind === 'agy') {
    // AGY stores its default effort level as part of the model label in settings.json.
    return effort
  }
  await mkdir(dirname(info.path), { recursive: true })

  if (kind === 'claude-code') {
    let json: Record<string, unknown> = {}
    if (existsSync(info.path)) {
      const raw = await readFile(info.path, 'utf8')
      if (raw.trim()) {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          throw new Error(
            `Cannot update ${info.displayPath || info.path}: existing JSON is invalid (${err instanceof Error ? err.message : String(err)}).`,
          )
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`Cannot update ${info.displayPath || info.path}: expected a JSON object at top level.`)
        }
        json = parsed as Record<string, unknown>
      }
    }
    json.effortLevel = effort
    await writeFile(info.path, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    return effort
  }

  if (kind === 'codex') {
    const raw = existsSync(info.path) ? await readFile(info.path, 'utf8') : ''
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const hadTrailingNewline = raw.length === 0 || /\r?\n$/.test(raw)
    const lines = raw ? raw.split(/\r?\n/) : []
    if (raw && /\r?\n$/.test(raw) && lines[lines.length - 1] === '') {
      lines.pop()
    }

    let replaced = false
    let firstSectionIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim()
      if (trimmed.startsWith('[')) {
        firstSectionIdx = i
        break
      }
      if (/^\s*model_reasoning_effort\s*=/.test(lines[i]!)) {
        lines[i] = `model_reasoning_effort = "${effort}"`
        replaced = true
        break
      }
    }

    if (!replaced) {
      const insertIdx = firstSectionIdx >= 0 ? firstSectionIdx : 0
      lines.splice(insertIdx, 0, `model_reasoning_effort = "${effort}"`)
    }

    const body = lines.join(eol)
    await writeFile(info.path, hadTrailingNewline ? `${body}${eol}` : body, 'utf8')
    return effort
  }

  throw new Error(`Writing local default reasoning effort is not supported for agent "${kind}".`)
}

export async function writeLocalDefaultModel(
  kind: PlatformAgentKind,
  modelValue: string,
  homeOverride?: string,
): Promise<string> {
  const clean = modelValue.trim()
  if (!clean) {
    throw new Error('Default model value cannot be empty.')
  }
  const info = cliConfigInfoForKind(kind, homeOverride)
  if (!info.supported || !info.path) {
    throw new Error(`Writing local default model is not supported for agent "${kind}".`)
  }
  await mkdir(dirname(info.path), { recursive: true })

  if (kind === 'agy' || kind === 'claude-code' || kind === 'gemini-cli') {
    let json: Record<string, unknown> = {}
    if (existsSync(info.path)) {
      const raw = await readFile(info.path, 'utf8')
      if (raw.trim()) {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          throw new Error(
            `Cannot update ${info.displayPath || info.path}: existing JSON is invalid (${err instanceof Error ? err.message : String(err)}).`,
          )
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`Cannot update ${info.displayPath || info.path}: expected a JSON object at top level.`)
        }
        json = parsed as Record<string, unknown>
      }
    }

    if (kind === 'gemini-cli' && json.model && typeof json.model === 'object' && !Array.isArray(json.model)) {
      json.model = { ...(json.model as Record<string, unknown>), name: clean }
    } else {
      json.model = clean
    }
    await writeFile(info.path, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
    return clean
  }

  if (kind === 'codex') {
    const raw = existsSync(info.path) ? await readFile(info.path, 'utf8') : ''
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const escaped = clean.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const hadTrailingNewline = raw.length === 0 || /\r?\n$/.test(raw)
    const lines = raw ? raw.split(/\r?\n/) : []
    if (raw && /\r?\n$/.test(raw) && lines[lines.length - 1] === '') {
      lines.pop()
    }

    let replaced = false
    let firstSectionIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim()
      if (trimmed.startsWith('[')) {
        firstSectionIdx = i
        break
      }
      if (/^\s*model\s*=/.test(lines[i]!)) {
        lines[i] = `model = "${escaped}"`
        replaced = true
        break
      }
    }

    if (!replaced) {
      const insertIdx = firstSectionIdx >= 0 ? firstSectionIdx : 0
      lines.splice(insertIdx, 0, `model = "${escaped}"`)
    }

    const body = lines.join(eol)
    await writeFile(info.path, hadTrailingNewline ? `${body}${eol}` : body, 'utf8')
    return clean
  }

  throw new Error(`Writing local default model is not supported for agent "${kind}".`)
}

export function curatedModelsForAgent(kind: PlatformAgentKind, defaultModel?: string): PlatformModelOption[] {
  const presets: Record<string, PlatformModelOption[]> = {
    'claude-code': [
      { id: 'sonnet', label: 'Claude Sonnet (latest alias)', group: 'Aliases' },
      { id: 'opus', label: 'Claude Opus (latest alias)', group: 'Aliases' },
      { id: 'haiku', label: 'Claude Haiku (latest alias)', group: 'Aliases' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Claude' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Claude' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', group: 'Claude' },
    ],
    'gemini-cli': [
      { id: 'auto', label: 'Auto (Gemini CLI routing)', group: 'Gemini' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', group: 'Gemini' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', group: 'Gemini' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', group: 'Gemini' },
    ],
    codex: [
      { id: 'gpt-5.4', label: 'GPT-5.4', group: 'OpenAI' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', group: 'OpenAI' },
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', group: 'OpenAI' },
      { id: 'o3', label: 'o3', group: 'OpenAI' },
      { id: 'o4-mini', label: 'o4-mini', group: 'OpenAI' },
    ],
    dsh: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat', group: 'DeepSeek' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', group: 'DeepSeek' },
    ],
  }
  const base = [...(presets[kind] ?? [])]
  if (defaultModel?.trim()) {
    const clean = defaultModel.trim()
    if (!base.some((m) => m.id === clean || m.label === clean)) {
      base.unshift({ id: clean, hint: 'Local default' })
    }
  }
  return base
}

const MAX_GATEWAY_MODELS = 500
const CLAUDE_ALIAS_NAMES = ['sonnet', 'opus', 'haiku'] as const
const CLAUDE_ALIAS_LABELS: Record<(typeof CLAUDE_ALIAS_NAMES)[number], string> = {
  sonnet: 'Claude Sonnet (latest alias)',
  opus: 'Claude Opus (latest alias)',
  haiku: 'Claude Haiku (latest alias)',
}

export function extractSafeEndpointLabel(rawUrl?: string, officialHosts: readonly string[] = []): string | undefined {
  const clean = rawUrl?.trim()
  if (!clean) return undefined
  try {
    const u = new URL(clean)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
    const hostLower = u.hostname.toLowerCase()
    if (!hostLower) return undefined
    if (officialHosts.some((h) => h.toLowerCase() === hostLower)) return undefined
    return u.host || hostLower
  } catch {
    return undefined
  }
}

export function parseGatewayModelsResponse(raw: unknown, endpointLabel?: string): PlatformModelOption[] {
  let list: unknown[] = []
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Array.isArray(obj.data)) list = obj.data
    else if (Array.isArray(obj.models)) list = obj.models
  }
  const seen = new Set<string>()
  const out: PlatformModelOption[] = []
  for (const item of list) {
    if (out.length >= MAX_GATEWAY_MODELS) break
    if (typeof item === 'string') {
      const clean = item.trim()
      if (clean && !seen.has(clean)) {
        seen.add(clean)
        out.push({ id: clean, ...(endpointLabel ? { hint: endpointLabel } : {}) })
      }
      continue
    }
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const rawId =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id.trim()
        : typeof rec.name === 'string' && rec.name.trim()
          ? rec.name.trim().replace(/^models\//i, '')
          : ''
    if (!rawId || seen.has(rawId)) continue
    seen.add(rawId)
    const rawLabel =
      typeof rec.display_name === 'string' && rec.display_name.trim()
        ? rec.display_name.trim()
        : typeof rec.displayName === 'string' && rec.displayName.trim()
          ? rec.displayName.trim()
          : undefined
    const ownedBy = typeof rec.owned_by === 'string' && rec.owned_by.trim() ? rec.owned_by.trim() : undefined
    const hint = ownedBy && ownedBy !== 'system' ? ownedBy : endpointLabel
    out.push({
      id: rawId,
      ...(rawLabel && rawLabel !== rawId ? { label: rawLabel } : {}),
      ...(hint ? { hint } : {}),
    })
  }
  return out
}

interface ClaudeLocalInspection {
  defaultModel?: string
  baseUrl?: string
  apiKey?: string
  endpointLabel?: string
  aliasTargets: Partial<Record<'sonnet' | 'opus' | 'haiku', string>>
  configuredModels: string[]
}

async function inspectClaudeLocalConfig(
  homeOverride?: string,
  envOverride?: Record<string, string | undefined>,
): Promise<ClaudeLocalInspection> {
  const home = homeOverride || homedir()
  const procEnv = envOverride ?? process.env
  const aliasTargets: Partial<Record<'sonnet' | 'opus' | 'haiku', string>> = {}
  const configuredModels: string[] = []
  const pushConfigured = (raw: unknown) => {
    const clean = typeof raw === 'string' ? raw.trim() : ''
    if (!clean) return
    if ((CLAUDE_ALIAS_NAMES as readonly string[]).includes(clean.toLowerCase())) return
    if (!configuredModels.includes(clean)) configuredModels.push(clean)
  }

  let envObj: Record<string, unknown> = {}
  let jsonModel: unknown
  let modelSettingsKeys: string[] = []
  try {
    const raw = await readFile(join(home, '.claude', 'settings.json'), 'utf8')
    const json = JSON.parse(raw) as {
      model?: unknown
      env?: Record<string, unknown>
      modelSettings?: Record<string, unknown>
    }
    jsonModel = json.model
    if (json.env && typeof json.env === 'object' && !Array.isArray(json.env)) {
      envObj = json.env
    }
    if (json.modelSettings && typeof json.modelSettings === 'object' && !Array.isArray(json.modelSettings)) {
      modelSettingsKeys = Object.keys(json.modelSettings)
    }
  } catch {
    /* ignore missing or unreadable Claude settings */
  }

  const pickEnv = (key: string): string | undefined => {
    const fromJson = envObj[key]
    if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim()
    const fromProc = procEnv[key]
    return typeof fromProc === 'string' && fromProc.trim() ? fromProc.trim() : undefined
  }

  const baseUrl = pickEnv('ANTHROPIC_BASE_URL')
  const apiKey = pickEnv('ANTHROPIC_AUTH_TOKEN') || pickEnv('ANTHROPIC_API_KEY')
  const endpointLabel = extractSafeEndpointLabel(baseUrl, ['api.anthropic.com'])

  const sonnetTarget = pickEnv('ANTHROPIC_DEFAULT_SONNET_MODEL')
  const opusTarget = pickEnv('ANTHROPIC_DEFAULT_OPUS_MODEL')
  const haikuTarget = pickEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL') ?? pickEnv('ANTHROPIC_SMALL_FAST_MODEL')
  if (sonnetTarget) aliasTargets.sonnet = sonnetTarget
  if (opusTarget) aliasTargets.opus = opusTarget
  if (haikuTarget) aliasTargets.haiku = haikuTarget

  pushConfigured(pickEnv('ANTHROPIC_MODEL'))
  pushConfigured(opusTarget)
  pushConfigured(sonnetTarget)
  pushConfigured(haikuTarget)
  pushConfigured(pickEnv('ANTHROPIC_REASONING_MODEL'))
  pushConfigured(jsonModel)
  for (const k of modelSettingsKeys) pushConfigured(k)

  const defaultModel =
    typeof jsonModel === 'string' && jsonModel.trim()
      ? jsonModel.trim()
      : pickEnv('ANTHROPIC_MODEL')

  return {
    defaultModel,
    baseUrl,
    apiKey,
    endpointLabel,
    aliasTargets,
    configuredModels,
  }
}

interface CodexLocalInspection {
  defaultModel?: string
  baseUrl?: string
  apiKey?: string
  endpointLabel?: string
}

async function inspectCodexLocalConfig(
  homeOverride?: string,
  envOverride?: Record<string, string | undefined>,
): Promise<CodexLocalInspection> {
  const home = homeOverride || homedir()
  const procEnv = envOverride ?? process.env
  let defaultModel: string | undefined
  let activeProvider: string | undefined
  const providerBlocks = new Map<string, { baseUrl?: string; envKey?: string; bearerToken?: string }>()
  let currentProvider: string | undefined

  try {
    const raw = await readFile(join(home, '.codex', 'config.toml'), 'utf8')
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('[')) {
        const sec = /^\[model_providers\.([^\]]+)\]/.exec(line)
        currentProvider = sec?.[1]?.trim().replace(/^["']|["']$/g, '')
        if (currentProvider && !providerBlocks.has(currentProvider)) {
          providerBlocks.set(currentProvider, {})
        }
        continue
      }
      const kv = /^([A-Za-z0-9_]+)\s*=\s*["']([^"']*)["']/.exec(line)
      if (!kv) continue
      const key = kv[1]!
      const val = kv[2]!.trim()
      if (!currentProvider) {
        if (key === 'model' && val) defaultModel = val
        else if (key === 'model_provider' && val) activeProvider = val
      } else {
        const blk = providerBlocks.get(currentProvider)!
        if (key === 'base_url' && val) blk.baseUrl = val
        else if (key === 'env_key' && val) blk.envKey = val
        else if (key === 'experimental_bearer_token' && val) blk.bearerToken = val
      }
    }
  } catch {
    /* ignore missing or unreadable Codex TOML */
  }

  let selected = activeProvider ? providerBlocks.get(activeProvider) : undefined
  if (!selected && providerBlocks.size === 1) {
    selected = [...providerBlocks.values()][0]
  }
  const baseUrl = selected?.baseUrl || procEnv.OPENAI_BASE_URL?.trim() || undefined
  let apiKey = selected?.bearerToken
  if (!apiKey && selected?.envKey) {
    apiKey = procEnv[selected.envKey]?.trim()
  }
  if (!apiKey) {
    apiKey = procEnv.OPENAI_API_KEY?.trim()
  }
  if (!apiKey) {
    try {
      const authRaw = await readFile(join(home, '.codex', 'auth.json'), 'utf8')
      const authJson = JSON.parse(authRaw) as { OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } }
      if (typeof authJson.OPENAI_API_KEY === 'string' && authJson.OPENAI_API_KEY.trim()) {
        apiKey = authJson.OPENAI_API_KEY.trim()
      }
    } catch {
      /* ignore missing auth.json */
    }
  }

  return {
    defaultModel,
    baseUrl,
    apiKey,
    endpointLabel: extractSafeEndpointLabel(baseUrl, ['api.openai.com']),
  }
}

export async function detectLocalAgentEndpoint(kind: PlatformAgentKind, homeOverride?: string): Promise<string | undefined> {
  if (kind === 'claude-code') {
    return (await inspectClaudeLocalConfig(homeOverride)).endpointLabel
  }
  if (kind === 'codex') {
    return (await inspectCodexLocalConfig(homeOverride)).endpointLabel
  }
  return undefined
}

export function buildClaudeModelsList(opts: {
  defaultModel?: string
  aliasTargets?: Partial<Record<'sonnet' | 'opus' | 'haiku', string>>
  configuredModels?: readonly string[]
  gatewayModels?: readonly PlatformModelOption[]
  endpointLabel?: string
}): PlatformModelOption[] {
  const out: PlatformModelOption[] = []
  const seen = new Set<string>()
  const push = (opt: PlatformModelOption) => {
    const cleanId = opt.id.trim()
    if (!cleanId || seen.has(cleanId)) return
    seen.add(cleanId)
    out.push({ ...opt, id: cleanId })
  }

  for (const alias of CLAUDE_ALIAS_NAMES) {
    const target = opts.aliasTargets?.[alias]
    push({
      id: alias,
      label: CLAUDE_ALIAS_LABELS[alias],
      ...(target ? { hint: `→ ${target}` } : {}),
      group: 'Aliases',
    })
  }

  for (const raw of opts.configuredModels ?? []) {
    const clean = raw.trim()
    if (!clean || seen.has(clean)) continue
    push({
      id: clean,
      group: 'Configured',
      hint: opts.endpointLabel || 'Local config',
    })
  }

  if (opts.gatewayModels && opts.gatewayModels.length > 0) {
    for (const gm of opts.gatewayModels) {
      push(gm)
    }
  } else {
    for (const curated of curatedModelsForAgent('claude-code', opts.defaultModel)) {
      push(curated)
    }
  }
  return out
}

export async function probeGatewayModels(opts: {
  baseUrl: string
  apiKey?: string
  protocol: 'anthropic' | 'openai'
  endpointLabel?: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}): Promise<PlatformModelOption[]> {
  const base = opts.baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) return []
  const doFetch = opts.fetchFn ?? netFetch
  const endsWithV1 = /\/v\d+$/i.test(base)
  const candidateUrls =
    opts.protocol === 'anthropic'
      ? endsWithV1
        ? [`${base}/models?limit=100`, `${base}/models`]
        : [`${base}/v1/models?limit=100`, `${base}/v1/models`, `${base}/models?limit=100`]
      : endsWithV1
        ? [`${base}/models`]
        : [`${base}/v1/models`, `${base}/models`]

  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01'
    if (opts.apiKey) {
      headers['x-api-key'] = opts.apiKey
      headers.authorization = `Bearer ${opts.apiKey}`
    }
  } else if (opts.apiKey) {
    headers.authorization = `Bearer ${opts.apiKey}`
  }

  const label = opts.endpointLabel ?? extractSafeEndpointLabel(base)
  for (const url of candidateUrls) {
    try {
      const res = await doFetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
      })
      if (!res.ok) {
        if (res.status === 404 || res.status === 405) continue
        return []
      }
      const json: unknown = await res.json()
      const parsed = parseGatewayModelsResponse(json, label)
      if (parsed.length > 0) return parsed
    } catch {
      /* ignore unreachable endpoint or aborted probe */
    }
  }
  return []
}

export async function probeClaudeCodeModels(
  homeOverride?: string,
  envOverride?: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
): Promise<{ models: PlatformModelOption[]; endpointLabel?: string }> {
  const info = await inspectClaudeLocalConfig(homeOverride, envOverride)
  let gatewayModels: PlatformModelOption[] = []
  if (info.baseUrl) {
    gatewayModels = await probeGatewayModels({
      baseUrl: info.baseUrl,
      apiKey: info.apiKey,
      protocol: 'anthropic',
      endpointLabel: info.endpointLabel,
      fetchFn,
    })
  }
  const models = buildClaudeModelsList({
    defaultModel: info.defaultModel,
    aliasTargets: info.aliasTargets,
    configuredModels: info.configuredModels,
    gatewayModels,
    endpointLabel: info.endpointLabel,
  })
  return { models, endpointLabel: info.endpointLabel }
}

export async function probeCodexModels(
  homeOverride?: string,
  envOverride?: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
): Promise<{ models: PlatformModelOption[]; endpointLabel?: string }> {
  const info = await inspectCodexLocalConfig(homeOverride, envOverride)
  let gatewayModels: PlatformModelOption[] = []
  if (info.baseUrl) {
    gatewayModels = await probeGatewayModels({
      baseUrl: info.baseUrl,
      apiKey: info.apiKey,
      protocol: 'openai',
      endpointLabel: info.endpointLabel,
      fetchFn,
    })
  }
  const models: PlatformModelOption[] = []
  const seen = new Set<string>()
  const push = (m: PlatformModelOption) => {
    if (!m.id || seen.has(m.id)) return
    seen.add(m.id)
    models.push(m)
  }
  if (info.defaultModel) {
    push({ id: info.defaultModel, hint: info.endpointLabel || 'Local default' })
  }
  for (const gm of gatewayModels) push(gm)
  if (gatewayModels.length === 0) {
    for (const c of curatedModelsForAgent('codex', info.defaultModel)) push(c)
  }
  return { models, endpointLabel: info.endpointLabel }
}

export async function discoverPlatformAgents(opts: {
  prefs: Record<string, SavedAgentPref>
  customAgents: readonly CustomAgentRecord[]
  previousAgents?: readonly PlatformAgentProfile[]
  atriumDefaultModel?: string
  atriumDefaultEffort?: ReasoningEffort
  atriumModels?: readonly PlatformModelOption[]
  cachedModelsByAgent?: Record<string, readonly PlatformModelOption[]>
}): Promise<PlatformAgentProfile[]> {
  const now = Date.now()
  const prevById = new Map((opts.previousAgents ?? []).map((a) => [a.id, a]))

  const builtins = await Promise.all(
    BUILTIN_AGENT_CATALOG.map(async (def): Promise<PlatformAgentProfile> => {
      const pref = opts.prefs[def.id]
      const cfgInfo = cliConfigInfoForKind(def.kind)
      const supportsEffort = supportsReasoningEffortForKind(def.kind)
      if (def.kind === 'atrium') {
        return {
          id: def.id,
          kind: def.kind,
          name: def.name,
          shortName: def.shortName,
          description: def.description,
          available: true,
          version: 'built-in',
          defaultModel: opts.atriumDefaultModel,
          availableModels: opts.atriumModels ? [...opts.atriumModels] : [],
          detectedAt: now,
          supportsMcpInjection: def.supportsMcpInjection,
          supportsStreamJson: def.supportsStreamJson,
          supportsResume: def.supportsResume,
          supportsCliConfigSync: cfgInfo.supported,
          supportsReasoningEffort: supportsEffort,
          ...(cfgInfo.displayPath ? { cliConfigPath: cfgInfo.displayPath } : {}),
          defaultReasoningEffort: opts.atriumDefaultEffort ?? 'auto',
          reasoningEffortOverride: pref?.reasoningEffortOverride,
          role: pref?.role ?? prevById.get(def.id)?.role ?? 'worker',
          permissionMode: pref?.permissionMode ?? def.defaultPermissionMode,
          modelOverride: pref?.modelOverride,
          modelProviderOverride: pref?.modelProviderOverride,
          accentColor: def.accentColor,
          installHint: def.installHint,
        }
      }
      const bin = resolveBinaryPath(def.binaries, def.extraPaths(), pref?.binaryPath)
      const cachedPrev = prevById.get(def.id)
      const [version, detectedDefault, detectedEndpoint, claudeInfo] = await Promise.all([
        bin
          ? cachedPrev?.binaryPath === bin && cachedPrev.version
            ? Promise.resolve(cachedPrev.version)
            : probeBinaryVersion(bin, def.versionArgs)
          : Promise.resolve(undefined),
        detectLocalDefaultModel(def.kind),
        detectLocalAgentEndpoint(def.kind),
        def.kind === 'claude-code' ? inspectClaudeLocalConfig() : Promise.resolve(undefined),
      ])
      const detectedEffort = await detectLocalDefaultEffort(def.kind, detectedDefault)
      const endpointUnchanged = (cachedPrev?.endpointLabel ?? undefined) === (detectedEndpoint ?? undefined)
      const rawCached = opts.cachedModelsByAgent?.[def.id] ?? (endpointUnchanged ? cachedPrev?.availableModels : undefined)
      const cachedModels = rawCached && rawCached.length > 0 ? rawCached : undefined
      let availableModels: PlatformModelOption[]
      if (def.kind === 'claude-code' && claudeInfo) {
        if (cachedModels && cachedModels.length > 0) {
          availableModels = [...cachedModels]
        } else {
          availableModels = buildClaudeModelsList({
            defaultModel: detectedDefault,
            aliasTargets: claudeInfo.aliasTargets,
            configuredModels: claudeInfo.configuredModels,
            endpointLabel: detectedEndpoint,
          })
        }
      } else {
        availableModels =
          cachedModels && cachedModels.length > 0
            ? [...cachedModels]
            : curatedModelsForAgent(def.kind, detectedDefault)
      }
      return {
        id: def.id,
        kind: def.kind,
        name: def.name,
        shortName: def.shortName,
        description: def.description,
        available: Boolean(bin),
        binaryPath: bin,
        version,
        defaultModel: detectedDefault,
        availableModels,
        detectedAt: now,
        supportsMcpInjection: def.supportsMcpInjection,
        supportsStreamJson: def.supportsStreamJson,
        supportsResume: def.supportsResume,
        supportsCliConfigSync: cfgInfo.supported,
        supportsReasoningEffort: supportsEffort,
        ...(cfgInfo.displayPath ? { cliConfigPath: cfgInfo.displayPath } : {}),
        ...(detectedEndpoint ? { endpointLabel: detectedEndpoint } : {}),
        ...(detectedEffort ? { defaultReasoningEffort: detectedEffort } : {}),
        reasoningEffortOverride: pref?.reasoningEffortOverride,
        role: pref?.role ?? prevById.get(def.id)?.role ?? (bin ? 'worker' : 'disabled'),
        permissionMode: pref?.permissionMode ?? def.defaultPermissionMode,
        modelOverride: pref?.modelOverride,
        accentColor: def.accentColor,
        installHint: def.installHint,
      }
    }),
  )

  const customs = await Promise.all(
    opts.customAgents.map(async (custom): Promise<PlatformAgentProfile> => {
      const pref = opts.prefs[custom.id]
      const cmdCandidate = pref?.binaryPath?.trim() || custom.command.trim()
      const resolved = existsSync(cmdCandidate) ? cmdCandidate : resolveBinaryPath([cmdCandidate])
      return {
        id: custom.id,
        kind: 'custom',
        name: custom.name,
        shortName: custom.name.slice(0, 12),
        description: custom.description?.trim() || `Custom CLI: ${custom.command}`,
        available: Boolean(resolved),
        binaryPath: resolved ?? cmdCandidate,
        detectedAt: now,
        supportsMcpInjection: false,
        supportsStreamJson: false,
        supportsResume: false,
        role: pref?.role ?? 'worker',
        permissionMode: pref?.permissionMode ?? custom.permissionMode ?? 'accept_edits',
        modelOverride: pref?.modelOverride,
        customCommand: custom.command,
        customArgs: custom.args,
        accentColor: '#7c6f64',
      }
    }),
  )

  const all = [...builtins, ...customs]
  // Ensure at least one available agent holds the Commander role on first initialization.
  const hasCommander = all.some((a) => a.available && a.role === 'commander')
  if (!hasCommander) {
    const priorityOrder = ['claude-code', 'atrium', 'agy', 'codex', 'gemini-cli']
    const picked =
      priorityOrder
        .map((id) => all.find((a) => a.id === id && a.available))
        .find(Boolean) ?? all.find((a) => a.available)
    if (picked) picked.role = 'commander'
  }
  return all
}

export interface BuildCommandSpecInput {
  profile: PlatformAgentProfile
  prompt: string
  cwd: string
  permissionMode: PlatformPermissionMode
  model?: string
  reasoningEffort?: ReasoningEffort
  resumeSessionId?: string
  systemPrompt?: string
  mcpConfigPath?: string
}

export interface AgentCommandSpec {
  binaryPath: string
  args: string[]
  stdinText?: string
}

export function buildAgentCommandSpec(input: BuildCommandSpecInput): AgentCommandSpec {
  const binaryPath = input.profile.binaryPath || input.profile.customCommand
  if (!binaryPath) {
    throw new Error(`Agent "${input.profile.name}" does not have an executable binary path.`)
  }
  const model = input.model?.trim() || input.profile.modelOverride?.trim()
  const effort = input.reasoningEffort ?? input.profile.reasoningEffortOverride
  const combinedPrompt = input.systemPrompt?.trim()
    ? `${input.systemPrompt.trim()}\n\n---\n\n${input.prompt}`
    : input.prompt

  switch (input.profile.kind) {
    case 'claude-code': {
      const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose']
      if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
      if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath)
      if (input.systemPrompt?.trim()) args.push('--append-system-prompt', input.systemPrompt.trim())
      if (model) args.push('--model', model)
      if (effort && effort !== 'auto') args.push('--effort', effort)
      if (input.permissionMode === 'plan') args.push('--permission-mode', 'plan')
      else if (input.permissionMode === 'accept_edits') args.push('--permission-mode', 'acceptEdits')
      else args.push('--dangerously-skip-permissions')
      return { binaryPath, args, stdinText: input.prompt }
    }

    case 'agy': {
      const args: string[] = ['--print', '--output-format', 'stream-json']
      if (input.resumeSessionId) args.push('--conversation', input.resumeSessionId)
      const rawModel = model || (effort && effort !== 'auto' ? input.profile.defaultModel : undefined)
      if (rawModel) {
        const variant =
          effort && effort !== 'auto'
            ? resolveAgyVariantForEffort(rawModel, effort, input.profile.availableModels)
            : undefined
        const resolvedAgyModel = variant?.id || resolveAgyCliModelArg(rawModel, input.profile.availableModels)
        if (resolvedAgyModel) args.push('--model', resolvedAgyModel)
      }
      if (effort && effort !== 'auto') args.push('--effort', effort)
      if (input.permissionMode === 'plan') args.push('--mode', 'plan')
      else if (input.permissionMode === 'accept_edits') args.push('--mode', 'accept-edits')
      else args.push('--mode', 'accept-edits', '--dangerously-skip-permissions')
      return { binaryPath, args, stdinText: combinedPrompt }
    }

    case 'codex': {
      const args: string[] = input.resumeSessionId
        ? ['exec', 'resume', input.resumeSessionId, '--json', '-']
        : ['exec', '--json', '-']
      if (model) args.push('-m', model)
      if (effort && effort !== 'auto') args.push('-c', `model_reasoning_effort="${effort}"`)
      if (input.permissionMode === 'plan') args.push('--sandbox', 'read-only')
      else if (input.permissionMode === 'accept_edits') args.push('--sandbox', 'workspace-write')
      else args.push('--full-auto')
      return { binaryPath, args, stdinText: combinedPrompt }
    }

    case 'gemini-cli': {
      const args: string[] = ['-o', 'stream-json', '-p', '']
      if (input.resumeSessionId) args.push('--resume', input.resumeSessionId)
      if (model) args.push('-m', model)
      if (input.permissionMode === 'plan') args.push('--approval-mode', 'plan')
      else if (input.permissionMode === 'accept_edits') args.push('--approval-mode', 'auto_edit')
      else args.push('--approval-mode', 'yolo')
      return { binaryPath, args, stdinText: combinedPrompt }
    }

    case 'dsh': {
      const args = input.profile.customArgs?.length ? [...input.profile.customArgs] : ['-p']
      if (model && !args.includes('--model') && !args.includes('-m')) {
        args.push('--model', model)
      }
      return { binaryPath, args, stdinText: combinedPrompt }
    }

    case 'opencode': {
      const args: string[] = ['run']
      if (model) args.push('-m', model)
      return { binaryPath, args, stdinText: combinedPrompt }
    }

    case 'aider': {
      const args: string[] = ['--yes-always', '--no-auto-commits', '--message', combinedPrompt]
      if (model) args.push('--model', model)
      return { binaryPath, args }
    }

    case 'custom': {
      const rawArgs = input.profile.customArgs ?? []
      let usedPromptPlaceholder = false
      const resolvedArgs = rawArgs.map((arg) => {
        let next = arg
        if (next.includes('{{prompt}}')) {
          usedPromptPlaceholder = true
          next = next.replaceAll('{{prompt}}', combinedPrompt)
        }
        next = next.replaceAll('{{cwd}}', input.cwd)
        next = next.replaceAll('{{model}}', model ?? '')
        return next
      })
      return {
        binaryPath,
        args: resolvedArgs,
        ...(usedPromptPlaceholder ? {} : { stdinText: combinedPrompt }),
      }
    }

    case 'atrium':
      throw new Error('Atrium built-in agent should run via runAtriumPlatformAgent.')
  }
}

export interface ParsedStreamChunk {
  textDelta?: string
  thinkingDelta?: string
  toolCall?: { name: string; input?: string }
  toolResult?: { output: string }
  nativeSessionId?: string
  finalText?: string
  error?: string
}

function asObj(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as Record<string, unknown>) : {}
}

function stringifyShort(val: unknown, limit = 1600): string {
  if (typeof val === 'string') return val.slice(0, limit)
  if (val == null) return ''
  try {
    return JSON.stringify(val, null, 2).slice(0, limit)
  } catch {
    return String(val).slice(0, limit)
  }
}

export function parseAgentStreamLine(kind: PlatformAgentKind, rawLine: string): ParsedStreamChunk {
  const line = rawLine.trim()
  if (!line) return {}
  if (!line.startsWith('{') && !line.startsWith('[')) {
    return { textDelta: `${rawLine}\n` }
  }

  let parsed: Record<string, unknown>
  try {
    const json = JSON.parse(line)
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { textDelta: `${rawLine}\n` }
    }
    parsed = json as Record<string, unknown>
  } catch {
    return { textDelta: `${rawLine}\n` }
  }

  const sessionId =
    typeof parsed.session_id === 'string'
      ? parsed.session_id
      : typeof parsed.conversation_id === 'string'
        ? parsed.conversation_id
        : typeof parsed.thread_id === 'string'
          ? parsed.thread_id
          : undefined

  // Codex CLI `--json` events
  if (kind === 'codex' || typeof parsed.thread_id === 'string' || parsed.type === 'item.completed' || parsed.type === 'item.started') {
    const item = asObj(parsed.item)
    const itemType = typeof item.type === 'string' ? item.type : ''
    if (parsed.type === 'item.completed' || parsed.type === 'item.updated' || parsed.type === 'item.started') {
      if (itemType === 'agent_message' || itemType === 'message') {
        const text = typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : ''
        return { ...(sessionId ? { nativeSessionId: sessionId } : {}), ...(text ? { textDelta: text } : {}) }
      }
      if (itemType === 'reasoning') {
        const text = typeof item.text === 'string' ? item.text : ''
        return { ...(sessionId ? { nativeSessionId: sessionId } : {}), ...(text ? { thinkingDelta: text } : {}) }
      }
      if (itemType === 'command_execution' || itemType === 'mcp_tool_call' || itemType === 'tool_call') {
        const name = typeof item.command === 'string' ? `bash: ${item.command}` : String(item.tool || item.name || itemType)
        if (parsed.type === 'item.completed') {
          return {
            ...(sessionId ? { nativeSessionId: sessionId } : {}),
            toolResult: { output: stringifyShort(item.aggregated_output ?? item.output ?? item.result ?? 'done') },
          }
        }
        return {
          ...(sessionId ? { nativeSessionId: sessionId } : {}),
          toolCall: { name, input: stringifyShort(item.arguments ?? item.input) },
        }
      }
      if (itemType === 'file_change') {
        return {
          ...(sessionId ? { nativeSessionId: sessionId } : {}),
          toolResult: { output: stringifyShort(item.changes ?? item) },
        }
      }
    }
    if (parsed.type === 'error' || parsed.type === 'turn.failed') {
      const errObj = asObj(parsed.error)
      return {
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
        error: String(errObj.message || parsed.message || parsed.error || 'Agent turn failed'),
      }
    }
    return sessionId ? { nativeSessionId: sessionId } : {}
  }

  const evtType = typeof parsed.type === 'string' ? parsed.type : ''

  // Claude Code `stream-json`
  if (evtType === 'assistant') {
    const msg = asObj(parsed.message)
    const content = Array.isArray(msg.content) ? msg.content : []
    let textDelta = ''
    let thinkingDelta = ''
    let toolCall: ParsedStreamChunk['toolCall']
    for (const partRaw of content) {
      const part = asObj(partRaw)
      if (part.type === 'text' && typeof part.text === 'string') {
        textDelta += part.text
      } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
        thinkingDelta += part.thinking
      } else if (part.type === 'tool_use') {
        toolCall = {
          name: String(part.name || 'tool'),
          input: stringifyShort(part.input),
        }
      }
    }
    return {
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      ...(textDelta ? { textDelta } : {}),
      ...(thinkingDelta ? { thinkingDelta } : {}),
      ...(toolCall ? { toolCall } : {}),
    }
  }

  if (evtType === 'user') {
    const msg = asObj(parsed.message)
    const content = Array.isArray(msg.content) ? msg.content : []
    const outs: string[] = []
    for (const partRaw of content) {
      const part = asObj(partRaw)
      if (part.type === 'tool_result') {
        outs.push(stringifyShort(part.content))
      }
    }
    if (outs.length > 0) {
      return {
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
        toolResult: { output: outs.join('\n') },
      }
    }
  }

  if (evtType === 'stream_event') {
    const ev = asObj(parsed.event)
    const delta = asObj(ev.delta)
    if (typeof delta.text === 'string') return { textDelta: delta.text }
    if (typeof delta.thinking === 'string') return { thinkingDelta: delta.thinking }
    return sessionId ? { nativeSessionId: sessionId } : {}
  }

  if (evtType === 'result') {
    const isErr = parsed.is_error === true
    if (isErr) {
      const errs = Array.isArray(parsed.errors) ? parsed.errors.join('; ') : ''
      return {
        ...(sessionId ? { nativeSessionId: sessionId } : {}),
        error: errs || stringifyShort(parsed.result || parsed.error || 'Agent execution error'),
      }
    }
    const finalText =
      typeof parsed.result === 'string'
        ? parsed.result
        : typeof parsed.response === 'string'
          ? parsed.response
          : typeof parsed.text === 'string'
            ? parsed.text
            : undefined
    return {
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      ...(finalText ? { finalText } : {}),
    }
  }

  // Gemini / AGY generic stream-json envelopes
  if (evtType === 'message' || evtType === 'content' || evtType === 'delta') {
    const role = typeof parsed.role === 'string' ? parsed.role : 'assistant'
    if (role !== 'user') {
      const content =
        typeof parsed.content === 'string'
          ? parsed.content
          : typeof parsed.text === 'string'
            ? parsed.text
            : typeof parsed.delta === 'string'
              ? parsed.delta
              : ''
      if (content) return { ...(sessionId ? { nativeSessionId: sessionId } : {}), textDelta: content }
    }
    return sessionId ? { nativeSessionId: sessionId } : {}
  }

  if (evtType === 'thinking' || evtType === 'thought') {
    const text =
      typeof parsed.content === 'string'
        ? parsed.content
        : typeof parsed.thinking === 'string'
          ? parsed.thinking
          : typeof parsed.text === 'string'
            ? parsed.text
            : ''
    return { ...(sessionId ? { nativeSessionId: sessionId } : {}), ...(text ? { thinkingDelta: text } : {}) }
  }

  if (evtType === 'tool_use' || evtType === 'tool_call') {
    return {
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      toolCall: {
        name: String(parsed.tool_name || parsed.name || 'tool'),
        input: stringifyShort(parsed.parameters ?? parsed.input ?? parsed.arguments),
      },
    }
  }

  if (evtType === 'tool_result') {
    return {
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      toolResult: {
        output: stringifyShort(parsed.output ?? parsed.result ?? parsed.content ?? ''),
      },
    }
  }

  if (evtType === 'error') {
    const msg = asObj(parsed.error).message ?? parsed.message ?? parsed.error
    return { ...(sessionId ? { nativeSessionId: sessionId } : {}), error: stringifyShort(msg || 'Unknown CLI error') }
  }

  return sessionId ? { nativeSessionId: sessionId } : {}
}

function killChildTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      /* fallback */
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
}

export interface RunExternalAgentOptions {
  profile: PlatformAgentProfile
  prompt: string
  cwd: string
  permissionMode: PlatformPermissionMode
  model?: string
  reasoningEffort?: ReasoningEffort
  resumeSessionId?: string
  systemPrompt?: string
  mcpConfigPath?: string
  env?: Record<string, string>
  timeoutMs?: number
  signal: AbortSignal
  onChunk: (chunk: ParsedStreamChunk) => void
  onStderr?: (line: string) => void
}

export interface RunExternalAgentResult {
  output: string
  thinking: string
  nativeSessionId?: string
  exitCode: number | null
  error?: string
}

export function runExternalCliAgent(opts: RunExternalAgentOptions): Promise<RunExternalAgentResult> {
  const cmdSpec = buildAgentCommandSpec({
    profile: opts.profile,
    prompt: opts.prompt,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    resumeSessionId: opts.resumeSessionId,
    systemPrompt: opts.systemPrompt,
    mcpConfigPath: opts.mcpConfigPath,
  })
  const spawnSpec = resolveSpawnSpec(cmdSpec.binaryPath, cmdSpec.args)

  return new Promise((done) => {
    let settled = false
    let output = ''
    let finalText = ''
    let thinking = ''
    let nativeSessionId = opts.resumeSessionId
    let streamErr = ''
    let stderrBuf = ''
    let lineBuf = ''
    let timedOut = false

    const finish = (res: RunExternalAgentResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      done(res)
    }

    const processLine = (raw: string) => {
      const chunk = parseAgentStreamLine(opts.profile.kind, raw)
      if (chunk.nativeSessionId) nativeSessionId = chunk.nativeSessionId
      if (chunk.thinkingDelta) thinking += chunk.thinkingDelta
      if (chunk.textDelta) output += chunk.textDelta
      if (chunk.finalText) finalText = chunk.finalText
      if (chunk.error) streamErr = chunk.error
      if (
        chunk.textDelta ||
        chunk.thinkingDelta ||
        chunk.toolCall ||
        chunk.toolResult ||
        chunk.finalText ||
        chunk.error ||
        chunk.nativeSessionId
      ) {
        opts.onChunk(chunk)
      }
    }

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (cmdSpec.stdinText !== undefined && child.stdin) {
      child.stdin.write(cmdSpec.stdinText, 'utf8')
      child.stdin.end()
    } else if (child.stdin) {
      child.stdin.end()
    }

    child.stdout?.on('data', (buf: Buffer) => {
      lineBuf += buf.toString('utf8')
      let nl = lineBuf.indexOf('\n')
      while (nl >= 0) {
        const line = lineBuf.slice(0, nl).replace(/\r$/, '')
        lineBuf = lineBuf.slice(nl + 1)
        processLine(line)
        nl = lineBuf.indexOf('\n')
      }
    })

    child.stderr?.on('data', (buf: Buffer) => {
      const chunk = buf.toString('utf8')
      if (stderrBuf.length < 24_000) stderrBuf += chunk
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed) opts.onStderr?.(trimmed)
      }
    })

    const timeoutMs = Math.max(15_000, opts.timeoutMs ?? 600_000)
    const timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, timeoutMs)

    const onAbort = () => killChildTree(child)
    if (opts.signal.aborted) {
      onAbort()
    } else {
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (err) => {
      finish({
        output: output.trim() || finalText.trim(),
        thinking: thinking.trim(),
        nativeSessionId,
        exitCode: null,
        error: `Failed to start "${cmdSpec.binaryPath}": ${err.message}`,
      })
    })

    child.on('close', (code) => {
      if (lineBuf.trim()) processLine(lineBuf.replace(/\r$/, ''))
      const resolvedOutput = finalText.trim() || output.trim()
      if (opts.signal.aborted) {
        finish({
          output: resolvedOutput,
          thinking: thinking.trim(),
          nativeSessionId,
          exitCode: code,
          error: 'Cancelled by user.',
        })
        return
      }
      if (timedOut) {
        finish({
          output: resolvedOutput,
          thinking: thinking.trim(),
          nativeSessionId,
          exitCode: code,
          error: `Timed out after ${Math.round(timeoutMs / 1000)}s.`,
        })
        return
      }
      if (streamErr) {
        finish({
          output: resolvedOutput,
          thinking: thinking.trim(),
          nativeSessionId,
          exitCode: code,
          error: streamErr,
        })
        return
      }
      if (code !== 0) {
        finish({
          output: resolvedOutput,
          thinking: thinking.trim(),
          nativeSessionId,
          exitCode: code,
          error: stderrBuf.trim() || resolvedOutput || `Agent exited with code ${code ?? 'unknown'}.`,
        })
        return
      }
      finish({
        output: resolvedOutput,
        thinking: thinking.trim(),
        nativeSessionId,
        exitCode: code,
      })
    })
  })
}

export function dirnameSafe(filePath: string | undefined): string {
  return filePath ? dirname(filePath) : ''
}
