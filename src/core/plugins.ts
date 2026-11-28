// Plugin Bundle Manager: discovers compatible plugins from Claude Code, Codex,
// Antigravity/Gemini, workspace folders, arbitrary local folders, and GitHub
// repositories; installs isolated copies under Atrium's data dir; and keeps
// bundled skills, commands, rules, and linked MCP servers synchronized.
import { access, cp, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  ActivePluginThemePayload,
  InstalledPlugin,
  InstallOption,
  MarketBundleFile,
  MarketLocalPackPreview,
  McpServerConfig,
  PluginBootConfig,
  PluginBootPalette,
  PluginCandidate,
  PluginDetail,
  PluginImportResult,
  PluginMcpProposal,
  PluginOrigin,
  PluginThemeManifest,
} from '../shared/types.ts'
import { configsFromMarkdown, parseConfigText } from './mcp/parse.ts'
import { normalizeHooksConfig, type PluginHookSource } from './hooks.ts'
import { describeNetworkError, netFetch } from './net.ts'
import { newId, readJson, writeJson } from './store.ts'
import { parseSkillMarkdown, type PluginSkillSource } from './tools/skills.ts'
import { resolveInsideReal } from './tools/workspace.ts'

const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024
const MAX_RULE_FILE_BYTES = 16 * 1024
const MAX_TOTAL_RULE_CHARS = 32_000
const MAX_PLUGIN_THEME_CSS_BYTES = 128 * 1024
const SKIP_COPY_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.DS_Store'])
const SKIP_COPY_FILES = new Set(['.in_use', '.app.json', 'Thumbs.db'])
const UNSUPPORTED_RUNTIMES = new Set(['agy-node', 'codex.exe', 'codex-command-runner.exe', 'codex-code-mode-host.exe'])
const PLUGIN_MANIFEST_PATHS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']
const MCP_CONFIG_FILES = ['.mcp.json', 'mcp_config.json', 'mcp.json']
const GITHUB_API = 'https://api.github.com'
const SAFE_BOOT_COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0?\.\d+|\.\d+|1(?:\.0+)?|0))?\s*\))$/

/** Sanitizes plugin-contributed CSS to prevent remote fetches, @import chains, or legacy script expressions. */
export function sanitizePluginCss(rawCss: string): string {
  if (!rawCss || typeof rawCss !== 'string') return ''
  let css = rawCss.replace(/\0/g, '').slice(0, MAX_PLUGIN_THEME_CSS_BYTES)
  css = css.replace(/@import\s+(?:url\([^)]*\)|['"][^'"]*['"]|[^;{}\r\n]+)\s*;?/gi, '/* blocked @import */')
  css = css.replace(/expression\s*\([^)]*\)/gi, 'none')
  css = css.replace(/(?:-moz-binding|behavior)\s*:[^;{}]+;?/gi, '')
  css = css.replace(/javascript\s*:/gi, 'blocked:')
  css = css.replace(/vbscript\s*:/gi, 'blocked:')
  css = css.replace(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (full, _q, inner: string) => {
    const trimmed = inner.trim()
    if (/^#[A-Za-z0-9_-]+$/.test(trimmed)) return full
    if (/^data:image\/svg\+xml/i.test(trimmed) && !/<script/i.test(trimmed)) return full
    return 'none'
  })
  return css.trim()
}

function cleanBootText(val: unknown, maxLen = 120): string | undefined {
  if (typeof val !== 'string') return undefined
  const clean = val.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return clean ? clean.slice(0, maxLen) : undefined
}

function cleanBootColor(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined
  const clean = val.trim()
  return SAFE_BOOT_COLOR_RE.test(clean) ? clean : undefined
}

/** Validates and normalizes a declarative JSON boot sequence configuration. */
export function parsePluginBootConfig(rawJson: string): PluginBootConfig | null {
  if (!rawJson || typeof rawJson !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>

  const brand = cleanBootText(obj.brand, 64)
  if (!brand) return null

  const style: PluginBootConfig['style'] =
    obj.style === 'rhine-lab-access'
      ? 'rhine-lab-access'
      : obj.style === 'minimal-telemetry'
        ? 'minimal-telemetry'
        : 'rhine-lab-orbital'

  const rawDuration = typeof obj.durationMs === 'number' && Number.isFinite(obj.durationMs) ? obj.durationMs : 2900
  const durationMs = Math.max(1200, Math.min(4500, Math.round(rawDuration)))

  const telemetryLines: string[] = Array.isArray(obj.telemetryLines)
    ? obj.telemetryLines
        .map((line) => cleanBootText(line, 120))
        .filter((line): line is string => Boolean(line))
        .slice(0, 8)
    : []

  let palette: PluginBootPalette | undefined
  if (obj.palette && typeof obj.palette === 'object' && !Array.isArray(obj.palette)) {
    const rawPal = obj.palette as Record<string, unknown>
    const nextPal: PluginBootPalette = {}
    const bg = cleanBootColor(rawPal.bg)
    const surface = cleanBootColor(rawPal.surface)
    const ink = cleanBootColor(rawPal.ink)
    const muted = cleanBootColor(rawPal.muted)
    const olive = cleanBootColor(rawPal.olive)
    const brass = cleanBootColor(rawPal.brass)
    const accent = cleanBootColor(rawPal.accent)
    const accent2 = cleanBootColor(rawPal.accent2)
    const grid = cleanBootColor(rawPal.grid)
    if (bg) nextPal.bg = bg
    if (surface) nextPal.surface = surface
    if (ink) nextPal.ink = ink
    if (muted) nextPal.muted = muted
    if (olive) nextPal.olive = olive
    if (brass) nextPal.brass = brass
    if (accent) nextPal.accent = accent
    if (accent2) nextPal.accent2 = accent2
    if (grid) nextPal.grid = grid
    if (Object.keys(nextPal).length > 0) palette = nextPal
  }

  const subBrand = cleanBootText(obj.subBrand, 96)
  const systemTag = cleanBootText(obj.systemTag, 120)
  const division = cleanBootText(obj.division, 120)
  const coordinates = cleanBootText(obj.coordinates, 120)
  const specCode = cleanBootText(obj.specCode, 64)
  const versionTag = cleanBootText(obj.versionTag, 64)
  const motto = cleanBootText(obj.motto, 120)
  const confirmEntry = typeof obj.confirmEntry === 'boolean' ? obj.confirmEntry : undefined
  const entryReadyText = cleanBootText(obj.entryReadyText, 96)
  const entryButtonText = cleanBootText(obj.entryButtonText, 96)
  const entryHintText = cleanBootText(obj.entryHintText, 96)
  const accessPrompt = cleanBootText(obj.accessPrompt, 96)
  const identityText = cleanBootText(obj.identityText, 96)
  const requestText = cleanBootText(obj.requestText, 96)
  const processingText = cleanBootText(obj.processingText, 96)
  const authorizedText = cleanBootText(obj.authorizedText, 96)
  const welcomePrefix = cleanBootText(obj.welcomePrefix, 96)
  const companyTag = cleanBootText(obj.companyTag, 96)
  const databaseTag = cleanBootText(obj.databaseTag, 96)
  const poweredBy = cleanBootText(obj.poweredBy, 96)
  const mastheadSub = cleanBootText(obj.mastheadSub, 96)
  const mastheadOs = cleanBootText(obj.mastheadOs, 96)

  return {
    style,
    durationMs,
    brand,
    ...(subBrand ? { subBrand } : {}),
    ...(systemTag ? { systemTag } : {}),
    ...(division ? { division } : {}),
    ...(coordinates ? { coordinates } : {}),
    ...(specCode ? { specCode } : {}),
    ...(versionTag ? { versionTag } : {}),
    ...(motto ? { motto } : {}),
    ...(confirmEntry !== undefined ? { confirmEntry } : {}),
    ...(entryReadyText ? { entryReadyText } : {}),
    ...(entryButtonText ? { entryButtonText } : {}),
    ...(entryHintText ? { entryHintText } : {}),
    ...(accessPrompt ? { accessPrompt } : {}),
    ...(identityText ? { identityText } : {}),
    ...(requestText ? { requestText } : {}),
    ...(processingText ? { processingText } : {}),
    ...(authorizedText ? { authorizedText } : {}),
    ...(welcomePrefix ? { welcomePrefix } : {}),
    ...(companyTag ? { companyTag } : {}),
    ...(databaseTag ? { databaseTag } : {}),
    ...(poweredBy ? { poweredBy } : {}),
    ...(mastheadSub ? { mastheadSub } : {}),
    ...(mastheadOs ? { mastheadOs } : {}),
    telemetryLines,
    ...(palette ? { palette } : {}),
  }
}

interface ManifestShape {
  name?: string
  id?: string
  displayName?: string
  version?: string
  description?: string
  author?: string | { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string | { url?: string }
  skills?: string | string[]
  commands?: string | string[]
  mcpServers?: unknown
  hooks?: unknown
  apps?: unknown
  theme?: PluginThemeManifest
  interface?: {
    displayName?: string
    shortDescription?: string
    longDescription?: string
    websiteURL?: string
  }
}

interface InspectedPlugin {
  id: string
  name: string
  displayName?: string
  version?: string
  description: string
  author?: string
  homepage?: string
  repository?: string
  skillNames: string[]
  commandNames: string[]
  ruleFiles: string[]
  mcpProposals: PluginMcpProposal[]
  hasHooks: boolean
  hasAppConnector: boolean
  hasTheme: boolean
  hasBootAnimation: boolean
  themeName?: string
  warnings: string[]
  recommended: boolean
  isBareSingleSkill: boolean
}

export interface PluginMcpAdapter {
  list: () => McpServerConfig[]
  save: (draft: Omit<McpServerConfig, 'id'> & { id?: string }) => Promise<McpServerConfig>
  remove: (id: string) => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<unknown>
  hasMissingSecrets?: (id: string) => Promise<boolean>
}

export interface PluginDeps {
  dir: string
  homeDir?: string
  mcp: PluginMcpAdapter
  getDisabledSkills?: () => string[]
  setDisabledSkills?: (names: string[]) => void
  fetchImpl?: typeof netFetch
}

function normPath(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function slugifyPluginId(raw: string): string {
  const clean = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return clean || 'plugin'
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function originDisplayLabel(origin: PluginOrigin): string {
  switch (origin) {
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'antigravity':
      return 'Antigravity'
    case 'dsh':
      return 'DeepSeek (DSH)'
    case 'github':
      return 'GitHub'
    case 'workspace':
      return 'Workspace'
    case 'atrium':
      return 'Atrium'
    default:
      return 'Local'
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return a.localeCompare(b)
}

async function listMarkdownRecursive(rootDir: string, baseDir = rootDir, depth = 0, acc: string[] = []): Promise<string[]> {
  if (depth > 2) return acc
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return acc
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      await listMarkdownRecursive(full, baseDir, depth + 1, acc)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      acc.push(relative(baseDir, full).replace(/\\/g, '/'))
    }
  }
  return acc
}

async function listPluginFiles(rootDir: string, baseDir = rootDir, depth = 0, acc: string[] = []): Promise<string[]> {
  if (depth > 3 || acc.length >= 120) return acc
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return acc
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (acc.length >= 120) break
    if (SKIP_COPY_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.') && !entry.name.startsWith('.claude-plugin') && !entry.name.startsWith('.codex-plugin') && entry.name !== '.mcp.json') {
      continue
    }
    const full = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      await listPluginFiles(full, baseDir, depth + 1, acc)
    } else {
      acc.push(relative(baseDir, full).replace(/\\/g, '/'))
    }
  }
  return acc
}

function firstStringArray(val: unknown): string[] {
  if (typeof val === 'string' && val.trim()) return [val.trim()]
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).map((v) => v.trim())
  return []
}

/** Resolves plugin root placeholders (`${CLAUDE_PLUGIN_ROOT}`, relative paths) for a target install directory. */
function rewriteMcpOptionForDir(option: InstallOption, pluginDir: string): { option: InstallOption; unsupportedRuntime?: string } {
  const replaceRoot = (text: string): string =>
    text.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, pluginDir)

  const cfg: Omit<McpServerConfig, 'id' | 'enabled'> = {
    ...option.config,
    args: option.config.args ? [...option.config.args] : undefined,
    env: option.config.env ? { ...option.config.env } : undefined,
    headers: option.config.headers ? { ...option.config.headers } : undefined,
  }

  let unsupportedRuntime: string | undefined
  if (cfg.command) {
    cfg.command = replaceRoot(cfg.command)
    const cmdBase = basename(cfg.command).toLowerCase()
    if (UNSUPPORTED_RUNTIMES.has(cmdBase) || cfg.command.includes('.plugin-appserver')) {
      unsupportedRuntime = cmdBase
    }
  }
  if (cfg.cwd) cfg.cwd = replaceRoot(cfg.cwd)
  if (cfg.args) {
    cfg.args = cfg.args.map((arg) => {
      const expanded = replaceRoot(arg)
      if (!expanded.startsWith('-') && !isAbsolute(expanded) && (expanded.includes('/') || expanded.includes('\\'))) {
        return resolve(pluginDir, expanded)
      }
      return expanded
    })
  }
  if (cfg.env) {
    for (const [k, v] of Object.entries(cfg.env)) cfg.env[k] = replaceRoot(v)
  }

  return {
    option: {
      ...option,
      label: cfg.transport === 'stdio' ? `${cfg.command ?? ''} ${(cfg.args ?? []).join(' ')}`.trim() : cfg.url ?? option.label,
      config: cfg,
    },
    unsupportedRuntime,
  }
}

async function resolveSafeFile(rootReal: string, rel: string): Promise<string | null> {
  try {
    const cleanRel = rel.replace(/^\.\//, '')
    if (!cleanRel) return null
    const candidate = await resolveInsideReal(rootReal, cleanRel)
    const st = await stat(candidate)
    return st.isFile() ? candidate : null
  } catch {
    return null
  }
}

async function resolveSafeSubdir(rootReal: string, rel: string): Promise<string | null> {
  try {
    const candidate = await resolveInsideReal(rootReal, rel.replace(/^\.\//, ''))
    const st = await stat(candidate)
    return st.isDirectory() ? candidate : null
  } catch {
    return null
  }
}

async function scanSkillNamesInDir(skillsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const names: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const sub = join(skillsDir, entry.name)
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      isDir = await stat(sub).then((s) => s.isDirectory()).catch(() => false)
    }
    if (!isDir) continue
    const raw = await readTextIfExists(join(sub, 'SKILL.md'))
    if (!raw) continue
    names.push(parseSkillMarkdown(raw, entry.name).name)
  }
  return names
}

/** Inspects a directory for a plugin manifest or skill/MCP bundle without copying or running anything. */
export async function inspectPluginDirectory(dir: string, fallbackName?: string): Promise<InspectedPlugin | null> {
  const realDir = await realpath(dir).catch(() => null)
  if (!realDir) return null
  const st = await stat(realDir).catch(() => null)
  if (!st?.isDirectory()) return null

  let manifest: ManifestShape | null = null
  for (const rel of PLUGIN_MANIFEST_PATHS) {
    const raw = await readTextIfExists(join(realDir, rel))
    if (!raw) continue
    try {
      manifest = JSON.parse(raw) as ManifestShape
      break
    } catch {
      /* continue */
    }
  }

  // Check if directory itself is a single bare skill (`SKILL.md` at root)
  const rootSkillRaw = !manifest ? await readTextIfExists(join(realDir, 'SKILL.md')) : null
  if (rootSkillRaw) {
    const parsed = parseSkillMarkdown(rootSkillRaw, fallbackName || basename(realDir))
    const id = slugifyPluginId(parsed.name)
    return {
      id,
      name: parsed.name,
      description: parsed.description,
      skillNames: [parsed.name],
      commandNames: [],
      ruleFiles: [],
      mcpProposals: [],
      hasHooks: false,
      hasAppConnector: false,
      hasTheme: false,
      hasBootAnimation: false,
      warnings: [],
      recommended: true,
      isBareSingleSkill: true,
    }
  }

  // Discover skills dirs
  const skillRelCandidates = manifest?.skills ? firstStringArray(manifest.skills) : ['skills']
  const skillNames: string[] = []
  const seenSkills = new Set<string>()
  for (const rel of skillRelCandidates) {
    const sub = await resolveSafeSubdir(realDir, rel)
    if (!sub) continue
    for (const s of await scanSkillNamesInDir(sub)) {
      const k = s.toLowerCase()
      if (!seenSkills.has(k)) {
        seenSkills.add(k)
        skillNames.push(s)
      }
    }
  }

  // Discover commands (`commands/*.md`)
  const commandRelCandidates = manifest?.commands ? firstStringArray(manifest.commands) : ['commands']
  const commandNames: string[] = []
  const seenCmds = new Set<string>()
  for (const rel of commandRelCandidates) {
    const sub = await resolveSafeSubdir(realDir, rel)
    if (!sub) continue
    for (const mdRel of await listMarkdownRecursive(sub)) {
      const base = basename(mdRel, '.md')
      const cmdSlug = slugifyPluginId(base)
      if (!seenCmds.has(cmdSlug)) {
        seenCmds.add(cmdSlug)
        commandNames.push(cmdSlug)
      }
    }
  }

  // Discover rules (`rules/**/*.md`)
  const rulesSub = await resolveSafeSubdir(realDir, 'rules')
  const ruleFiles = rulesSub ? (await listMarkdownRecursive(rulesSub)).map((r) => `rules/${r}`) : []

  // Discover MCP configs
  const rawOptions: InstallOption[] = []
  const seenMcp = new Set<string>()
  const pushOptions = (opts: InstallOption[]) => {
    for (const opt of opts) {
      const key = opt.config.name.toLowerCase()
      if (seenMcp.has(key)) continue
      seenMcp.add(key)
      rawOptions.push(opt)
    }
  }

  if (manifest?.mcpServers) {
    if (typeof manifest.mcpServers === 'string') {
      const target = await resolveInsideReal(realDir, manifest.mcpServers.replace(/^\.\//, '')).catch(() => null)
      const txt = target ? await readTextIfExists(target) : null
      if (txt) pushOptions(parseConfigText(txt, { kind: 'plugin' }))
    } else if (typeof manifest.mcpServers === 'object') {
      pushOptions(parseConfigText(JSON.stringify({ mcpServers: manifest.mcpServers }), { kind: 'plugin' }))
    }
  }

  for (const mcpRel of MCP_CONFIG_FILES) {
    const txt = await readTextIfExists(join(realDir, mcpRel))
    if (txt) pushOptions(parseConfigText(txt, { kind: 'plugin' }))
  }

  const hasHooks = Boolean(manifest?.hooks) || (await exists(join(realDir, 'hooks', 'hooks.json')))
  const hasAppConnector = Boolean(manifest?.apps) || (await exists(join(realDir, '.app.json')))

  const themeCssRel = manifest?.theme?.cssFile?.trim() || 'theme/theme.css'
  const themeBootRel = manifest?.theme?.bootFile?.trim() || 'theme/boot.json'
  const resolvedThemeCss = await resolveSafeFile(realDir, themeCssRel)
  const resolvedThemeBoot = await resolveSafeFile(realDir, themeBootRel)
  const hasThemeCss = Boolean(resolvedThemeCss)
  const hasBootAnimation = Boolean(resolvedThemeBoot)
  const hasTheme = Boolean(hasThemeCss || hasBootAnimation)

  // Not a recognizable plugin bundle if it has neither manifest nor components
  if (
    !manifest &&
    skillNames.length === 0 &&
    commandNames.length === 0 &&
    ruleFiles.length === 0 &&
    rawOptions.length === 0 &&
    !hasTheme
  ) {
    return null
  }

  const rawName = (manifest?.name || manifest?.id || fallbackName || basename(realDir)).trim()
  const displayName = (manifest?.displayName || manifest?.interface?.displayName)?.trim() || undefined
  const id = slugifyPluginId(rawName)
  const themeName = manifest?.theme?.name?.trim() || (hasTheme ? displayName || rawName : undefined)
  const description =
    (manifest?.description || manifest?.interface?.shortDescription || manifest?.interface?.longDescription || '').trim()
  const author =
    typeof manifest?.author === 'string'
      ? manifest.author.trim()
      : manifest?.author?.name?.trim() || undefined
  const homepage = (manifest?.homepage || manifest?.interface?.websiteURL)?.trim() || undefined
  const repository =
    typeof manifest?.repository === 'string'
      ? manifest.repository.trim()
      : manifest?.repository?.url?.trim() || undefined

  const warnings: string[] = []
  const mcpProposals: PluginMcpProposal[] = rawOptions.map((opt) => {
    const { option, unsupportedRuntime } = rewriteMcpOptionForDir(opt, realDir)
    if (unsupportedRuntime) {
      warnings.push(`MCP "${option.config.name}" requires external runtime "${unsupportedRuntime}".`)
    } else if (option.inputs.some((i) => i.required && !i.defaultValue)) {
      warnings.push(`MCP "${option.config.name}" requires ${option.inputs.filter((i) => i.required).map((i) => i.key).join(', ')}.`)
    }
    return {
      serverKey: option.config.name,
      option,
      ...(unsupportedRuntime ? { unsupportedRuntime } : {}),
    }
  })

  if (hasHooks) warnings.push('Contains lifecycle hooks (runs when Plugin Hooks are enabled in Settings).')
  if (hasAppConnector && mcpProposals.length === 0) {
    warnings.push('Uses a hosted app connector (.app.json); included skills are still usable.')
  }

  const hasUsableMcp = mcpProposals.some((m) => !m.unsupportedRuntime)
  const recommended =
    skillNames.length > 0 || commandNames.length > 0 || ruleFiles.length > 0 || hasUsableMcp || hasTheme

  return {
    id,
    name: rawName,
    displayName,
    version: manifest?.version?.trim() || undefined,
    description,
    author,
    homepage,
    repository,
    skillNames,
    commandNames,
    ruleFiles,
    mcpProposals,
    hasHooks,
    hasAppConnector,
    hasTheme,
    hasBootAnimation,
    ...(themeName ? { themeName } : {}),
    warnings,
    recommended,
    isBareSingleSkill: false,
  }
}

/** Parses `https://github.com/owner/repo` or `/tree/<branch>/<subpath>` into parts. */
export function parseGithubUrl(input: string): { owner: string; repo: string; branch?: string; subpath?: string } | null {
  const text = input.trim().replace(/\.git$/, '')
  const match = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?\/?$/)
  if (!match) return null
  return {
    owner: match[1]!,
    repo: match[2]!,
    ...(match[3] ? { branch: match[3] } : {}),
    ...(match[4] ? { subpath: match[4].replace(/\/$/, '') } : {}),
  }
}

export class PluginManager {
  private readonly deps: PluginDeps
  private plugins: InstalledPlugin[] = []
  private hookRevision = 0
  private hookCache: {
    revision: number
    watchedFiles: string[]
    mtimeSig: string
    sources: PluginHookSource[]
  } | null = null

  constructor(deps: PluginDeps) {
    this.deps = deps
  }

  private invalidateHookCache(): void {
    this.hookRevision += 1
    this.hookCache = null
  }

  private async computeFilesMtimeSig(files: string[]): Promise<string> {
    if (files.length === 0) return ''
    const parts = await Promise.all(
      files.map(async (f) => {
        const st = await stat(f).catch(() => null)
        return `${f}:${st ? st.mtimeMs : -1}`
      }),
    )
    return parts.join('|')
  }

  private indexPath(): string {
    return join(this.deps.dir, 'plugins.json')
  }

  private pluginsRootDir(): string {
    return join(this.deps.dir, 'plugins')
  }

  private home(): string {
    return this.deps.homeDir ?? process.env.ATRIUM_PLUGIN_HOME ?? homedir()
  }

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.indexPath(), [])
    this.plugins = Array.isArray(raw) ? (raw as InstalledPlugin[]) : []
    this.invalidateHookCache()
  }

  list(): InstalledPlugin[] {
    return this.plugins.map((p) => ({ ...p }))
  }

  async get(id: string): Promise<PluginDetail | null> {
    const found = this.plugins.find((p) => p.id === id)
    if (!found) return null
    const files = await listPluginFiles(found.installDir)
    const readme =
      (await readTextIfExists(join(found.installDir, 'README.md'))) ??
      (await readTextIfExists(join(found.installDir, 'readme.md'))) ??
      undefined
    return {
      ...found,
      files,
      ...(readme ? { readme: readme.slice(0, 24_000) } : {}),
    }
  }

  /** Returns active skill and command roots for `SkillsManager`. */
  async activeSkillSources(): Promise<PluginSkillSource[]> {
    const out: PluginSkillSource[] = []
    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue
      const realDir = await realpath(plugin.installDir).catch(() => null)
      if (!realDir) continue

      let skillsDirs: string[] = []
      for (const rel of PLUGIN_MANIFEST_PATHS) {
        const raw = await readTextIfExists(join(realDir, rel))
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw) as ManifestShape
          const rels = parsed.skills ? firstStringArray(parsed.skills) : ['skills']
          for (const r of rels) {
            const sub = await resolveSafeSubdir(realDir, r)
            if (sub) skillsDirs.push(sub)
          }
          break
        } catch {
          /* continue */
        }
      }
      if (skillsDirs.length === 0) {
        const def = await resolveSafeSubdir(realDir, 'skills')
        if (def) skillsDirs = [def]
      }

      const bareSkillDir =
        skillsDirs.length === 0 && (await exists(join(realDir, 'SKILL.md'))) ? realDir : undefined
      const commandsDir = (await resolveSafeSubdir(realDir, 'commands')) ?? undefined
      out.push({
        pluginId: plugin.id,
        pluginName: plugin.displayName || plugin.name,
        dir: skillsDirs[0] ?? join(realDir, 'skills'),
        extraDirs: skillsDirs.slice(1),
        ...(bareSkillDir ? { bareSkillDir } : {}),
        commandsDir,
      })
    }
    return out
  }

  /** Formats enabled plugin rules (`rules/*.md`) for injection into the system prompt. */
  async formatActiveRulesPrompt(): Promise<string> {
    const chunks: string[] = []
    let used = 0
    for (const plugin of this.plugins) {
      if (!plugin.enabled || plugin.ruleFiles.length === 0) continue
      const realDir = await realpath(plugin.installDir).catch(() => null)
      if (!realDir) continue
      for (const rel of plugin.ruleFiles) {
        if (used >= MAX_TOTAL_RULE_CHARS) break
        const target = await resolveInsideReal(realDir, rel).catch(() => null)
        if (!target) continue
        const raw = await readTextIfExists(target)
        if (!raw || !raw.trim()) continue
        const body = raw.trim().slice(0, MAX_RULE_FILE_BYTES)
        chunks.push(`### Plugin: ${plugin.displayName || plugin.name} (${rel})\n${body}`)
        used += body.length
      }
    }
    if (chunks.length === 0) return ''
    return `<plugin_rules>\n${chunks.join('\n\n')}\n</plugin_rules>`
  }

  /** Returns the active enabled plugin theme CSS (sanitized) and declarative boot config, if any. */
  async getActiveTheme(): Promise<ActivePluginThemePayload | null> {
    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue
      const realDir = await realpath(plugin.installDir).catch(() => null)
      if (!realDir) continue

      let manifest: ManifestShape | null = null
      for (const rel of PLUGIN_MANIFEST_PATHS) {
        const raw = await readTextIfExists(join(realDir, rel))
        if (!raw) continue
        try {
          manifest = JSON.parse(raw) as ManifestShape
          break
        } catch {
          /* continue */
        }
      }

      const cssRel = manifest?.theme?.cssFile?.trim() || 'theme/theme.css'
      const bootRel = manifest?.theme?.bootFile?.trim() || 'theme/boot.json'
      const cssFile = await resolveSafeFile(realDir, cssRel)
      const bootFile = await resolveSafeFile(realDir, bootRel)
      if (!cssFile && !bootFile) continue

      const rawCss = cssFile ? (await readTextIfExists(cssFile)) ?? '' : ''
      const css = sanitizePluginCss(rawCss)
      const rawBoot = bootFile ? await readTextIfExists(bootFile) : null
      const boot = rawBoot ? parsePluginBootConfig(rawBoot) ?? undefined : undefined
      if (!css && !boot) continue

      const themeId = slugifyPluginId(manifest?.theme?.id || plugin.id)
      const pluginName = plugin.displayName || plugin.name
      const themeName = manifest?.theme?.name?.trim() || plugin.themeName || pluginName
      const rawChrome = manifest?.theme?.chrome
      const chrome: 'rhine-lab' | 'none' | undefined =
        rawChrome === 'rhine-lab' || rawChrome === 'none'
          ? rawChrome
          : themeId === 'rhine-lab'
            ? 'rhine-lab'
            : undefined
      const rawEff = manifest?.theme?.effects
      const effects =
        rawEff && typeof rawEff === 'object'
          ? {
              clickReticle: Boolean(rawEff.clickReticle),
              telemetryHud: Boolean(rawEff.telemetryHud),
              rollingClock: Boolean(rawEff.rollingClock),
              tactileAudio: Boolean(rawEff.tactileAudio),
              redactionReveal: Boolean(rawEff.redactionReveal),
              archiveBackdrop: Boolean(rawEff.archiveBackdrop),
              archiveMode: Boolean(rawEff.archiveMode),
            }
          : undefined
      return {
        pluginId: plugin.id,
        pluginName,
        themeId,
        themeName,
        css,
        ...(boot ? { boot } : {}),
        ...(chrome ? { chrome } : {}),
        ...(effects ? { effects } : {}),
      }
    }
    return null
  }

  /** Collects lifecycle hook configs from enabled plugins (`hooks/hooks.json` or manifest `hooks`), cached by revision + mtime. */
  async activeHookSources(): Promise<PluginHookSource[]> {
    if (this.hookCache && this.hookCache.revision === this.hookRevision) {
      const sig = await this.computeFilesMtimeSig(this.hookCache.watchedFiles)
      if (sig === this.hookCache.mtimeSig) {
        return this.hookCache.sources
      }
    }

    const revision = this.hookRevision
    const watchedSet = new Set<string>()
    const out: PluginHookSource[] = []
    for (const plugin of this.plugins) {
      if (!plugin.enabled) continue
      const realDir = await realpath(plugin.installDir).catch(() => null)
      if (!realDir) continue

      let mergedRaw: unknown = null
      for (const rel of PLUGIN_MANIFEST_PATHS) {
        const manifestFile = join(realDir, rel)
        watchedSet.add(manifestFile)
        const raw = await readTextIfExists(manifestFile)
        if (!raw) continue
        try {
          const parsed = JSON.parse(raw) as ManifestShape
          if (parsed.hooks) {
            if (typeof parsed.hooks === 'string') {
              const target = await resolveInsideReal(realDir, parsed.hooks.replace(/^\.\//, '')).catch(() => null)
              if (target) watchedSet.add(target)
              const txt = target ? await readTextIfExists(target) : null
              if (txt) mergedRaw = JSON.parse(txt)
            } else if (typeof parsed.hooks === 'object') {
              mergedRaw = parsed.hooks
            }
          }
          break
        } catch {
          /* continue */
        }
      }

      const defaultHookCandidate = join(realDir, 'hooks', 'hooks.json')
      watchedSet.add(defaultHookCandidate)
      if (!mergedRaw) {
        const hookPath = await resolveInsideReal(realDir, join('hooks', 'hooks.json')).catch(() => null)
        if (hookPath) watchedSet.add(hookPath)
        const txt = hookPath ? await readTextIfExists(hookPath) : null
        if (txt) {
          try {
            mergedRaw = JSON.parse(txt)
          } catch {
            /* ignore invalid json */
          }
        }
      }

      const hooks = normalizeHooksConfig(mergedRaw)
      if (!hooks.PreToolUse && !hooks.PostToolUse && !hooks.Stop) continue
      out.push({
        pluginId: plugin.id,
        pluginName: plugin.displayName || plugin.name,
        pluginDir: realDir,
        hooks,
      })
    }

    const watchedFiles = Array.from(watchedSet).sort()
    const mtimeSig = await this.computeFilesMtimeSig(watchedFiles)
    if (this.hookRevision === revision) {
      this.hookCache = { revision, watchedFiles, mtimeSig, sources: out }
    }
    return out
  }

  /**
   * Scans Claude Code, Codex, Antigravity/Gemini, and workspace plugin locations read-only.
   * Nothing is copied or started until the user explicitly chooses plugins to import.
   */
  async discoverLocal(workspace?: string): Promise<PluginCandidate[]> {
    const home = this.home()
    const rawSources: Array<{ path: string; origin: PluginOrigin; dedupeGroup?: string; versionHint?: string }> = []
    const seenPaths = new Set<string>()

    const pushSource = async (path: string, origin: PluginOrigin, dedupeGroup?: string, versionHint?: string) => {
      const real = await realpath(path).catch(() => null)
      if (!real) return
      const key = normPath(real)
      if (seenPaths.has(key)) return
      seenPaths.add(key)
      rawSources.push({ path: real, origin, dedupeGroup, versionHint })
    }

    // 1. Claude Code installed_plugins.json + cache fallback
    const claudeRoot = join(home, '.claude', 'plugins')
    const installedJsonRaw = await readTextIfExists(join(claudeRoot, 'installed_plugins.json'))
    if (installedJsonRaw) {
      try {
        const parsed = JSON.parse(installedJsonRaw) as {
          plugins?: Record<string, Array<{ installPath?: string; version?: string }>>
        }
        for (const entries of Object.values(parsed.plugins ?? {})) {
          for (const entry of entries ?? []) {
            if (entry?.installPath) {
              await pushSource(entry.installPath, 'claude-code', undefined, entry.version)
            }
          }
        }
      } catch {
        /* ignore malformed user registry */
      }
    }
    await this.scanVersionedCache(join(claudeRoot, 'cache'), 'claude-code', pushSource)

    // 2. Antigravity / Gemini config plugins
    const geminiPluginsRoot = join(home, '.gemini', 'config', 'plugins')
    for (const dir of await listSubdirs(geminiPluginsRoot)) {
      await pushSource(dir, 'antigravity')
    }

    // 3. Codex plugins cache (keep latest version per plugin folder)
    await this.scanVersionedCache(join(home, '.codex', 'plugins', 'cache'), 'codex', pushSource)

    // 4. DeepSeek Harness (DSH) plugins & skills
    const dshHome = process.env.DSH_HOME || join(home, '.dsh')
    for (const dir of await listSubdirs(join(dshHome, 'plugins'))) {
      await pushSource(dir, 'dsh')
    }
    for (const dir of await listSubdirs(join(dshHome, 'skills'))) {
      await pushSource(dir, 'dsh')
    }

    // 5. Workspace plugins
    if (workspace) {
      for (const relRoot of ['.atrium/plugins', '.claude/plugins', '.codex/plugins', '.dsh/plugins']) {
        for (const dir of await listSubdirs(join(workspace, relRoot))) {
          await pushSource(dir, 'workspace')
        }
      }
      if (await exists(join(workspace, '.claude-plugin', 'plugin.json'))) {
        await pushSource(workspace, 'workspace')
      }
    }

    const candidates: PluginCandidate[] = []
    const seenOriginIds = new Set<string>()

    for (const src of rawSources) {
      const inspected = await inspectPluginDirectory(src.path)
      if (!inspected || (inspected.isBareSingleSkill && src.origin !== 'dsh')) continue

      const originIdKey = `${src.origin}:${inspected.id}`
      if (seenOriginIds.has(originIdKey)) continue
      seenOriginIds.add(originIdKey)

      const existing = this.plugins.find(
        (p) => normPath(p.sourcePath) === normPath(src.path) || (p.origin === src.origin && p.id === inspected.id),
      )

      candidates.push({
        key: originIdKey,
        id: inspected.id,
        name: inspected.name,
        displayName: inspected.displayName,
        version: inspected.version ?? src.versionHint,
        description: inspected.description,
        author: inspected.author,
        homepage: inspected.homepage,
        repository: inspected.repository,
        origin: src.origin,
        originLabel: originDisplayLabel(src.origin),
        sourcePath: src.path,
        skillNames: inspected.skillNames,
        commandNames: inspected.commandNames,
        ruleFiles: inspected.ruleFiles,
        mcpProposals: inspected.mcpProposals,
        hasHooks: inspected.hasHooks,
        hasAppConnector: inspected.hasAppConnector,
        ...(inspected.hasTheme ? { hasTheme: true } : {}),
        ...(inspected.hasBootAnimation ? { hasBootAnimation: true } : {}),
        ...(inspected.themeName ? { themeName: inspected.themeName } : {}),
        warnings: inspected.warnings,
        alreadyImported: Boolean(existing),
        ...(existing ? { importedPluginId: existing.id } : {}),
        recommended: inspected.recommended,
      })
    }

    return candidates.sort((a, b) => {
      if (a.alreadyImported !== b.alreadyImported) return a.alreadyImported ? 1 : -1
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
      return (a.displayName || a.name).localeCompare(b.displayName || b.name)
    })
  }

  private async scanVersionedCache(
    cacheRoot: string,
    origin: PluginOrigin,
    pushSource: (path: string, origin: PluginOrigin, dedupeGroup?: string, versionHint?: string) => Promise<void>,
  ): Promise<void> {
    for (const marketplaceDir of await listSubdirs(cacheRoot)) {
      if (basename(marketplaceDir).startsWith('.')) continue
      for (const pluginDir of await listSubdirs(marketplaceDir)) {
        if (basename(pluginDir).startsWith('.')) continue
        // Direct plugin folder or versioned subfolders inside `<marketplace>/<plugin>/<ver>`
        const hasDirectManifest = await someAsync(PLUGIN_MANIFEST_PATHS, (rel) => exists(join(pluginDir, rel)))
        if (hasDirectManifest) {
          await pushSource(pluginDir, origin)
          continue
        }
        const versions = (await listSubdirs(pluginDir)).sort((a, b) => compareVersions(basename(b), basename(a)))
        if (versions[0]) {
          await pushSource(versions[0], origin, `${origin}:${basename(pluginDir)}`, basename(versions[0]))
        }
      }
    }
  }

  /** Imports one or more discovered local plugin directories safely into Atrium's isolated plugins dir. */
  async importLocal(sourcePaths: string[]): Promise<PluginImportResult> {
    const installed: InstalledPlugin[] = []
    const skipped: string[] = []
    const createdMcpServers: McpServerConfig[] = []
    const warnings: string[] = []

    const discovered = await this.discoverLocal()
    const originByPath = new Map(discovered.map((d) => [normPath(d.sourcePath), d.origin]))

    for (const rawPath of sourcePaths) {
      const origin = originByPath.get(normPath(rawPath)) ?? this.inferOriginFromPath(rawPath)
      const res = await this.installFromDirectory(rawPath, origin)
      if (!res) {
        skipped.push(rawPath)
        continue
      }
      installed.push(res.plugin)
      createdMcpServers.push(...res.createdMcpServers)
      warnings.push(...res.warnings)
    }

    return { installed, skipped, createdMcpServers, warnings }
  }

  /** Imports an arbitrary user-picked local directory (plugin bundle OR single skill folder). */
  async importFolder(folderPath: string): Promise<PluginImportResult> {
    const origin = this.inferOriginFromPath(folderPath)
    const res = await this.installFromDirectory(folderPath, origin)
    if (!res) {
      throw new Error('Selected folder does not contain a valid plugin manifest, skills, or MCP configuration.')
    }
    return {
      installed: [res.plugin],
      skipped: [],
      createdMcpServers: res.createdMcpServers,
      warnings: res.warnings,
    }
  }

  /** Fetches a GitHub plugin repository (or subpath) over the GitHub API and installs it into Atrium. */
  async importGithub(repoUrl: string): Promise<PluginImportResult> {
    const parsed = parseGithubUrl(repoUrl)
    if (!parsed) throw new Error('That does not look like a valid GitHub repository URL.')

    const fetcher = this.deps.fetchImpl ?? netFetch
    const { owner, repo, subpath } = parsed
    const repoInfo = await this.githubJson<{ description?: string; default_branch?: string }>(
      fetcher,
      `${GITHUB_API}/repos/${owner}/${repo}`,
    )
    const branch = parsed.branch || repoInfo.default_branch || 'main'
    const treeRes = await this.githubJson<{
      tree?: Array<{ path: string; type: string; size?: number }>
    }>(fetcher, `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`)

    const prefix = subpath ? `${subpath}/` : ''
    const blobs = (treeRes.tree ?? []).filter((item) => {
      if (item.type !== 'blob') return false
      if (prefix && !item.path.startsWith(prefix)) return false
      const rel = prefix ? item.path.slice(prefix.length) : item.path
      if (!rel || rel.includes('..') || rel.startsWith('/')) return false
      const segs = rel.split('/')
      if (segs.some((s) => SKIP_COPY_DIRS.has(s))) return false
      if ((item.size ?? 0) > MAX_PLUGIN_FILE_BYTES) return false
      return isRelevantGithubFile(rel)
    })

    if (blobs.length === 0) {
      throw new Error(`No plugin manifest, skills, rules, or MCP config found in ${owner}/${repo}.`)
    }

    const tempId = `${slugifyPluginId(subpath ? basename(subpath) : repo)}-${newId('tmp').slice(-6)}`
    const stageDir = join(this.pluginsRootDir(), `.stage-${tempId}`)
    await rm(stageDir, { recursive: true, force: true })
    await mkdir(stageDir, { recursive: true })

    try {
      for (const blob of blobs) {
        const rel = prefix ? blob.path.slice(prefix.length) : blob.path
        const target = resolve(stageDir, rel)
        if (!target.startsWith(resolve(stageDir))) continue
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${blob.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`
        const res = await fetcher(rawUrl, { headers: { 'user-agent': 'atrium' } })
        if (!res.ok) continue
        const buf = Buffer.from(await res.arrayBuffer())
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, buf)
      }

      const fallback = subpath ? basename(subpath) : repo
      const inspected = await inspectPluginDirectory(stageDir, fallback)
      if (!inspected) {
        throw new Error(`Repository ${owner}/${repo} did not yield a runnable plugin structure.`)
      }

      const canonicalId = this.allocateId(inspected.id, repoUrl)
      const destDir = join(this.pluginsRootDir(), canonicalId)
      await rm(destDir, { recursive: true, force: true })
      await mkdir(dirname(destDir), { recursive: true })
      if (inspected.isBareSingleSkill) {
        const skillDest = join(destDir, 'skills', slugifyPluginId(inspected.name))
        await this.safeCopyDir(stageDir, skillDest)
        await writeJson(join(destDir, 'plugin.json'), {
          name: inspected.name,
          description: inspected.description || repoInfo.description || '',
          repository: repoUrl,
        })
      } else {
        await cp(stageDir, destDir, { recursive: true })
        // Fill missing manifest fallback metadata cleanly
        const hasAnyManifest = await someAsync(PLUGIN_MANIFEST_PATHS, (rel) => exists(join(destDir, rel)))
        if (!hasAnyManifest) {
          await writeJson(join(destDir, 'plugin.json'), {
            name: subpath ? basename(subpath) : repo,
            description: repoInfo.description || inspected.description || '',
            repository: `https://github.com/${owner}/${repo}`,
          })
        }
      }

      const finalized = await this.finalizeInstalledPlugin({
        id: canonicalId,
        destDir,
        sourcePath: repoUrl.trim(),
        origin: 'github',
      })
      return {
        installed: [finalized.plugin],
        skipped: [],
        createdMcpServers: finalized.createdMcpServers,
        warnings: finalized.warnings,
      }
    } finally {
      await rm(stageDir, { recursive: true, force: true })
    }
  }

  /** Safely packs a local plugin directory (or single SKILL.md folder) into uploadable files for Marketplace review. */
  async packLocalFolder(folderPath: string): Promise<MarketLocalPackPreview> {
    const inspected = await inspectPluginDirectory(folderPath)
    if (!inspected) {
      throw new Error('Selected folder does not contain a valid plugin manifest, SKILL.md, commands, rules, or MCP configuration.')
    }

    const realRoot = await realpath(folderPath)
    const files: MarketBundleFile[] = []
    let totalBytes = 0
    let hasScripts = false
    const MAX_BUNDLE_FILES = 100
    const MAX_SINGLE_BYTES = 512 * 1024
    const MAX_TOTAL_BYTES = 1_800_000
    const TEXT_EXTS = new Set([
      '.md', '.mdx', '.json', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.sh', '.bash', '.ps1', '.yaml', '.yml', '.toml', '.css', '.html', '.htm', '.svg', '.xml',
    ])

    const walk = async (currDir: string): Promise<void> => {
      if (files.length >= MAX_BUNDLE_FILES) return
      const entries = await readdir(currDir, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (files.length >= MAX_BUNDLE_FILES) break
        if (SKIP_COPY_DIRS.has(entry.name) || SKIP_COPY_FILES.has(entry.name)) continue
        const full = join(currDir, entry.name)
        const resolved = await realpath(full).catch(() => null)
        if (!resolved) continue
        const rel = relative(realRoot, resolved).replace(/\\/g, '/')
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
        const st = await stat(resolved).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) {
          await walk(resolved)
        } else if (st.isFile()) {
          if (st.size > MAX_SINGLE_BYTES) {
            throw new Error(`File "${rel}" exceeds 512KB limit for Marketplace upload.`)
          }
          const lower = rel.toLowerCase()
          if (
            /^scripts\//i.test(lower) ||
            /\.(?:sh|bash|ps1|py|js|mjs|cjs|ts)$/i.test(lower)
          ) {
            hasScripts = true
          }
          const dot = lower.lastIndexOf('.')
          const ext = dot >= 0 ? lower.slice(dot) : ''
          const isText = TEXT_EXTS.has(ext) || lower.endsWith('license') || lower.endsWith('.env.example')
          const buf = await readFile(resolved)
          totalBytes += buf.byteLength
          if (totalBytes > MAX_TOTAL_BYTES) {
            throw new Error('Total plugin bundle size exceeds 1.8MB limit for Marketplace upload.')
          }
          files.push({
            path: rel,
            content: buf.toString(isText ? 'utf8' : 'base64'),
            encoding: isText ? 'utf8' : 'base64',
            size: buf.byteLength,
          })
        }
      }
    }

    await walk(realRoot)
    if (files.length === 0) {
      throw new Error('No uploadable files found inside the selected plugin folder.')
    }

    return {
      folderPath: realRoot,
      name: inspected.name,
      ...(inspected.displayName ? { displayName: inspected.displayName } : {}),
      version: inspected.version || '1.0.0',
      description: inspected.description,
      skillNames: inspected.skillNames,
      commandNames: inspected.commandNames,
      ruleFiles: inspected.ruleFiles,
      mcpCount: inspected.mcpProposals.length,
      hasHooks: inspected.hasHooks,
      hasScripts,
      ...(inspected.hasTheme ? { hasTheme: true } : {}),
      ...(inspected.hasBootAnimation ? { hasBootAnimation: true } : {}),
      fileCount: files.length,
      totalBytes,
      warnings: inspected.warnings,
      files,
    }
  }

  /** Installs a plugin directly from a validated Marketplace bundle payload. */
  async installFromBundle(opts: {
    id: string
    name: string
    displayName?: string
    version?: string
    description: string
    author?: string
    repository?: string
    files: MarketBundleFile[]
    sourceRef: string
  }): Promise<PluginImportResult> {
    if (!Array.isArray(opts.files) || opts.files.length === 0) {
      throw new Error('Marketplace plugin bundle has no files to install.')
    }
    const tempId = `${slugifyPluginId(opts.id || opts.name)}-${newId('tmp').slice(-6)}`
    const stageDir = join(this.pluginsRootDir(), `.stage-${tempId}`)
    await rm(stageDir, { recursive: true, force: true })
    await mkdir(stageDir, { recursive: true })
    const resolvedStage = resolve(stageDir)

    try {
      for (const file of opts.files) {
        const cleanRel = String(file.path || '').replace(/\\/g, '/').trim()
        if (!cleanRel || cleanRel.startsWith('/') || /^[a-zA-Z]:/.test(cleanRel) || cleanRel.split('/').includes('..')) {
          throw new Error(`Invalid path in plugin bundle: ${file.path}`)
        }
        const target = resolve(resolvedStage, cleanRel)
        if (!target.startsWith(resolvedStage)) {
          throw new Error(`Unsafe path in plugin bundle: ${file.path}`)
        }
        await mkdir(dirname(target), { recursive: true })
        const buf =
          file.encoding === 'base64'
            ? Buffer.from(file.content, 'base64')
            : Buffer.from(file.content, 'utf8')
        await writeFile(target, buf)
      }

      const inspected = await inspectPluginDirectory(resolvedStage, opts.name)
      if (!inspected) {
        throw new Error('Downloaded Marketplace bundle does not form a valid Atrium plugin.')
      }

      const canonicalId = this.allocateId(slugifyPluginId(opts.id || inspected.id), opts.sourceRef)
      const destDir = join(this.pluginsRootDir(), canonicalId)
      const prev = this.plugins.find((p) => p.id === canonicalId)
      if (prev) {
        for (const oldMcp of prev.mcpServerIds) {
          await this.deps.mcp.remove(oldMcp).catch(() => undefined)
        }
      }

      await rm(destDir, { recursive: true, force: true })
      await mkdir(destDir, { recursive: true })

      if (inspected.isBareSingleSkill) {
        const skillDest = join(destDir, 'skills', slugifyPluginId(inspected.name))
        await this.safeCopyDir(resolvedStage, skillDest)
        await writeJson(join(destDir, 'plugin.json'), {
          name: opts.name || inspected.name,
          ...(opts.displayName ? { displayName: opts.displayName } : {}),
          ...(opts.version ? { version: opts.version } : {}),
          description: opts.description || inspected.description || '',
          ...(opts.author ? { author: opts.author } : {}),
          ...(opts.repository ? { repository: opts.repository } : {}),
        })
      } else {
        await cp(resolvedStage, destDir, { recursive: true })
        const hasAnyManifest = await someAsync(PLUGIN_MANIFEST_PATHS, (rel) => exists(join(destDir, rel)))
        if (!hasAnyManifest) {
          await writeJson(join(destDir, 'plugin.json'), {
            name: opts.name || inspected.name,
            ...(opts.displayName ? { displayName: opts.displayName } : {}),
            ...(opts.version ? { version: opts.version } : {}),
            description: opts.description || inspected.description || '',
            ...(opts.author ? { author: opts.author } : {}),
            ...(opts.repository ? { repository: opts.repository } : {}),
          })
        }
      }

      const finalized = await this.finalizeInstalledPlugin({
        id: canonicalId,
        destDir,
        sourcePath: opts.sourceRef,
        origin: 'atrium',
      })
      return {
        installed: [finalized.plugin],
        skipped: [],
        createdMcpServers: finalized.createdMcpServers,
        warnings: finalized.warnings,
      }
    } finally {
      await rm(stageDir, { recursive: true, force: true })
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledPlugin[]> {
    const target = this.plugins.find((p) => p.id === id)
    if (!target) throw new Error(`Plugin "${id}" was not found.`)

    target.enabled = enabled
    target.updatedAt = Date.now()
    this.invalidateHookCache()
    await writeJson(this.indexPath(), this.plugins)

    const servers = new Map(this.deps.mcp.list().map((s) => [s.id, s]))
    for (const mcpId of target.mcpServerIds) {
      const cfg = servers.get(mcpId)
      if (!cfg) continue
      if (!enabled) {
        await this.deps.mcp.setEnabled(mcpId, false).catch(() => undefined)
      } else {
        const missingSecrets = this.deps.mcp.hasMissingSecrets ? await this.deps.mcp.hasMissingSecrets(mcpId) : false
        if (!missingSecrets && !isUnsupportedCommand(cfg)) {
          await this.deps.mcp.setEnabled(mcpId, true).catch(() => undefined)
        }
      }
    }

    return this.list()
  }

  async remove(id: string): Promise<void> {
    const target = this.plugins.find((p) => p.id === id)
    if (!target) return

    for (const mcpId of target.mcpServerIds) {
      await this.deps.mcp.remove(mcpId).catch(() => undefined)
    }

    if (this.deps.getDisabledSkills && this.deps.setDisabledSkills && target.skillNames.length > 0) {
      const removedNames = new Set(target.skillNames.map((n) => n.toLowerCase()))
      const current = this.deps.getDisabledSkills()
      const filtered = current.filter((n) => !removedNames.has(n.toLowerCase()))
      if (filtered.length !== current.length) this.deps.setDisabledSkills(filtered)
    }

    const pluginsRoot = await realpath(this.pluginsRootDir()).catch(() => resolve(this.pluginsRootDir()))
    const resolvedDest = await realpath(target.installDir).catch(() => resolve(target.installDir))
    if (resolvedDest.startsWith(pluginsRoot)) {
      await rm(resolvedDest, { recursive: true, force: true })
    }

    this.plugins = this.plugins.filter((p) => p.id !== id)
    this.invalidateHookCache()
    await writeJson(this.indexPath(), this.plugins)
  }

  private inferOriginFromPath(folderPath: string): PluginOrigin {
    const norm = folderPath.replace(/\\/g, '/').toLowerCase()
    if (norm.includes('/.claude/plugins/')) return 'claude-code'
    if (norm.includes('/.codex/plugins/')) return 'codex'
    if (norm.includes('/.gemini/config/plugins/')) return 'antigravity'
    if (norm.includes('/.dsh/')) return 'dsh'
    return 'local'
  }

  private allocateId(baseId: string, sourcePath: string): string {
    const existingSameSource = this.plugins.find((p) => normPath(p.sourcePath) === normPath(sourcePath))
    if (existingSameSource) return existingSameSource.id
    if (!this.plugins.some((p) => p.id === baseId)) return baseId
    let idx = 2
    while (this.plugins.some((p) => p.id === `${baseId}-${idx}`)) idx++
    return `${baseId}-${idx}`
  }

  private async installFromDirectory(
    sourceDir: string,
    origin: PluginOrigin,
  ): Promise<{ plugin: InstalledPlugin; createdMcpServers: McpServerConfig[]; warnings: string[] } | null> {
    const inspected = await inspectPluginDirectory(sourceDir)
    if (!inspected) return null

    const realSrc = await realpath(sourceDir)
    const id = this.allocateId(inspected.id, realSrc)
    const destDir = join(this.pluginsRootDir(), id)

    // Remove previous MCP servers owned by this plugin id if updating
    const prev = this.plugins.find((p) => p.id === id)
    if (prev) {
      for (const oldMcp of prev.mcpServerIds) {
        await this.deps.mcp.remove(oldMcp).catch(() => undefined)
      }
    }

    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })

    if (inspected.isBareSingleSkill) {
      const skillDest = join(destDir, 'skills', slugifyPluginId(inspected.name))
      await this.safeCopyDir(realSrc, skillDest)
      await writeJson(join(destDir, 'plugin.json'), {
        name: inspected.name,
        description: inspected.description,
      })
    } else {
      await this.safeCopyDir(realSrc, destDir)
    }

    return this.finalizeInstalledPlugin({ id, destDir, sourcePath: realSrc, origin })
  }

  private async finalizeInstalledPlugin(opts: {
    id: string
    destDir: string
    sourcePath: string
    origin: PluginOrigin
  }): Promise<{ plugin: InstalledPlugin; createdMcpServers: McpServerConfig[]; warnings: string[] }> {
    const realInstallDir = await realpath(opts.destDir).catch(() => resolve(opts.destDir))
    const inspected = await inspectPluginDirectory(realInstallDir)
    if (!inspected) throw new Error('Installed plugin directory could not be verified.')

    const existingServers = this.deps.mcp.list()
    const createdMcpServers: McpServerConfig[] = []
    const mcpServerIds: string[] = []
    const warnings = [...inspected.warnings]

    for (const proposal of inspected.mcpProposals) {
      const { option, unsupportedRuntime } = rewriteMcpOptionForDir(proposal.option, realInstallDir)
      const needsSecret = option.inputs.some((i) => i.required && !i.defaultValue)
      const dup = existingServers.find(
        (s) => !s.pluginId && s.name.toLowerCase() === option.config.name.toLowerCase(),
      )
      const name = dup ? `${option.config.name} (${inspected.displayName || inspected.name})` : option.config.name
      const enabled = !needsSecret && !unsupportedRuntime
      const saved = await this.deps.mcp.save({
        ...option.config,
        name,
        enabled,
        pluginId: opts.id,
        source: { kind: 'plugin', ref: opts.id },
      })
      createdMcpServers.push(saved)
      mcpServerIds.push(saved.id)
    }

    const now = Date.now()
    const prev = this.plugins.find((p) => p.id === opts.id)
    const plugin: InstalledPlugin = {
      id: opts.id,
      name: inspected.name,
      ...(inspected.displayName ? { displayName: inspected.displayName } : {}),
      ...(inspected.version ? { version: inspected.version } : {}),
      description: inspected.description,
      ...(inspected.author ? { author: inspected.author } : {}),
      ...(inspected.homepage ? { homepage: inspected.homepage } : {}),
      ...(inspected.repository ? { repository: inspected.repository } : {}),
      origin: opts.origin,
      originLabel: originDisplayLabel(opts.origin),
      sourcePath: opts.sourcePath,
      installDir: realInstallDir,
      enabled: true,
      installedAt: prev?.installedAt ?? now,
      updatedAt: now,
      skillNames: inspected.skillNames,
      commandNames: inspected.commandNames,
      ruleFiles: inspected.ruleFiles,
      mcpServerIds,
      ...(inspected.hasTheme ? { hasTheme: true } : {}),
      ...(inspected.hasBootAnimation ? { hasBootAnimation: true } : {}),
      ...(inspected.themeName ? { themeName: inspected.themeName } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }

    this.plugins = [...this.plugins.filter((p) => p.id !== opts.id), plugin]
    this.invalidateHookCache()
    await writeJson(this.indexPath(), this.plugins)
    return { plugin, createdMcpServers, warnings }
  }

  private async safeCopyDir(srcRoot: string, destDir: string): Promise<void> {
    const realRoot = await realpath(srcRoot)
    const copyRecursive = async (currSrc: string, currDest: string): Promise<void> => {
      await mkdir(currDest, { recursive: true })
      const entries = await readdir(currSrc, { withFileTypes: true })
      for (const entry of entries) {
        if (SKIP_COPY_DIRS.has(entry.name) || SKIP_COPY_FILES.has(entry.name)) continue
        const fullSrc = join(currSrc, entry.name)
        const fullDest = join(currDest, entry.name)
        const resolved = await realpath(fullSrc).catch(() => null)
        if (!resolved) continue
        // Never follow symlinks escaping the plugin root
        const rel = relative(realRoot, resolved)
        if (rel.startsWith('..') || isAbsolute(rel)) continue
        const st = await stat(resolved).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) {
          await copyRecursive(resolved, fullDest)
        } else if (st.isFile() && st.size <= MAX_PLUGIN_FILE_BYTES) {
          await mkdir(dirname(fullDest), { recursive: true })
          await cp(resolved, fullDest)
        }
      }
    }
    await copyRecursive(realRoot, destDir)
  }

  private async githubJson<T>(fetcher: typeof netFetch, url: string): Promise<T> {
    try {
      const res = await fetcher(url, {
        headers: { accept: 'application/json', 'user-agent': 'atrium' },
      })
      if (!res.ok) {
        if (res.status === 403 || res.status === 429) {
          throw new Error('GitHub is limiting requests right now. Try again in a minute.')
        }
        throw new Error(`GitHub request failed (${res.status}).`)
      }
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof Error && /limiting requests|failed \(/.test(err.message)) throw err
      throw new Error(describeNetworkError(err, url))
    }
  }
}

/** Lightweight GitHub repo plugin bundle check used by Market GitHub Import. */
export async function inspectGithubTreeForPlugin(
  repoUrl: string,
  treePaths: string[],
  readFile: (path: string) => Promise<string | null>,
): Promise<{
  name: string
  displayName?: string
  version?: string
  description: string
  skillNames: string[]
  commandNames: string[]
  ruleFiles: string[]
  mcpCount: number
} | null> {
  const manifestPath = PLUGIN_MANIFEST_PATHS.find((p) => treePaths.includes(p))
  let manifest: ManifestShape | null = null
  if (manifestPath) {
    const raw = await readFile(manifestPath)
    if (raw) {
      try {
        manifest = JSON.parse(raw) as ManifestShape
      } catch {
        /* ignore */
      }
    }
  }

  const skillMdPaths = treePaths.filter((p) => p === 'SKILL.md' || /^skills\/[^/]+\/SKILL\.md$/i.test(p))
  const commandPaths = treePaths.filter((p) => /^commands\/[^/]+\.md$/i.test(p))
  const ruleFiles = treePaths.filter((p) => /^rules\/.+\.md$/i.test(p))
  const mcpFiles = treePaths.filter((p) => MCP_CONFIG_FILES.includes(p))

  if (!manifest && skillMdPaths.length === 0 && commandPaths.length === 0 && ruleFiles.length === 0) {
    return null
  }

  const skillNames = skillMdPaths.map((p) => (p === 'SKILL.md' ? basename(repoUrl.replace(/\.git$/, '')) : p.split('/')[1]!))
  const commandNames = commandPaths.map((p) => slugifyPluginId(basename(p, '.md')))

  let mcpCount = 0
  for (const mf of mcpFiles) {
    const txt = await readFile(mf)
    if (txt) mcpCount += parseConfigText(txt, { kind: 'plugin' }).length
  }
  if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') {
    mcpCount += parseConfigText(JSON.stringify({ mcpServers: manifest.mcpServers }), { kind: 'plugin' }).length
  }

  // Fallback README MCP check
  if (!mcpCount && treePaths.includes('README.md')) {
    const readme = await readFile('README.md')
    if (readme) void configsFromMarkdown(readme, { kind: 'plugin' })
  }

  const fallbackName = basename(repoUrl.trim().replace(/\/$/, '').replace(/\.git$/, '')) || 'plugin'
  return {
    name: (manifest?.name || manifest?.id || fallbackName).trim(),
    displayName: (manifest?.displayName || manifest?.interface?.displayName)?.trim() || undefined,
    version: manifest?.version?.trim() || undefined,
    description: (manifest?.description || manifest?.interface?.shortDescription || '').trim(),
    skillNames,
    commandNames,
    ruleFiles,
    mcpCount,
  }
}

function isRelevantGithubFile(rel: string): boolean {
  const lower = rel.toLowerCase()
  if (PLUGIN_MANIFEST_PATHS.includes(lower) || MCP_CONFIG_FILES.includes(lower)) return true
  if (lower === 'skill.md' || lower === 'readme.md' || lower === 'license' || lower === 'agents.md' || lower === 'claude.md') return true
  if (/^(?:skills|commands|rules|scripts|references|assets|examples|resources|theme)\//.test(lower)) return true
  return false
}

function isUnsupportedCommand(cfg: McpServerConfig): boolean {
  if (!cfg.command) return false
  const cmdBase = basename(cfg.command).toLowerCase()
  return UNSUPPORTED_RUNTIMES.has(cmdBase) || cfg.command.includes('.plugin-appserver')
}

async function listSubdirs(rootDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(rootDir, entry.name)
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      isDir = await stat(full).then((s) => s.isDirectory()).catch(() => false)
    }
    if (isDir) out.push(full)
  }
  return out
}

async function someAsync<T>(items: T[], fn: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) {
    if (await fn(item)) return true
  }
  return false
}
