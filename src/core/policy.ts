// Declarative project security policy engine (`.atrium/policy.json` + `.atrium/policy.local.json`)
// with built-in sensitive credential/secret file guards by default.
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { SandboxMode } from '../shared/types.ts'
import type {
  PolicyDecision,
  PolicyInspection,
  PolicySourceInfo,
  ProjectPolicyConfig,
} from '../shared/studio_features.ts'

export const DEFAULT_SENSITIVE_GLOBS: string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  '**/id_rsa',
  '**/id_rsa.*',
  '**/id_ed25519',
  '**/id_ed25519.*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/credentials.json',
  '**/service-account*.json',
  '**/.aws/**',
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/.atrium/secrets.json',
]

export const DEFAULT_SAFE_EXCEPTIONS: string[] = [
  '**/.env.example',
  '**/.env.sample',
  '**/.env.template',
  '**/.env.dist',
  '**/.env.schema',
  '**/*.pub',
]

const DEFAULT_POLICY_WRITE_GUARDS = ['.atrium/policy.json', '.atrium/policy.local.json']

const SANDBOX_RANK: Record<SandboxMode, number> = {
  off: 0,
  workspace_write: 1,
  read_only: 2,
}

interface CachedPolicyEntry {
  projectMtime: number
  localMtime: number
  inspection: PolicyInspection
}

const policyCache = new Map<string, CachedPolicyEntry>()

function cacheKey(workspace: string): string {
  const abs = resolve(workspace)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function invalidatePolicyCache(workspace?: string): void {
  if (!workspace) {
    policyCache.clear()
    return
  }
  policyCache.delete(cacheKey(workspace))
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp | null {
  let pat = normalizeSlashes(pattern.trim())
  if (!pat) return null
  // Bare patterns without a slash (e.g. `.env`, `*.pem`) match both root and nested paths.
  if (!pat.includes('/')) {
    pat = `**/${pat}`
  }
  let regex = '^'
  let i = 0
  while (i < pat.length) {
    if (pat.slice(i, i + 3) === '**/') {
      regex += '(?:.*/)?'
      i += 3
      continue
    }
    if (pat.slice(i, i + 3) === '/**' && i + 3 === pat.length) {
      regex += '(?:/.*)?'
      i += 3
      continue
    }
    if (pat.slice(i, i + 2) === '**') {
      regex += '.*'
      i += 2
      continue
    }
    const ch = pat[i]!
    if (ch === '*') regex += '[^/]*'
    else if (ch === '?') regex += '[^/]'
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  regex += '$'
  try {
    return new RegExp(regex, caseInsensitive ? 'i' : '')
  } catch {
    return null
  }
}

export function matchPolicyGlob(
  relPath: string,
  pattern: string,
  caseInsensitive = process.platform === 'win32',
): boolean {
  const cleanPath = normalizeSlashes(relPath)
  if (!cleanPath) return false
  const re = globToRegExp(pattern, caseInsensitive)
  return re ? re.test(cleanPath) : false
}

export function matchCommandPattern(command: string, pattern: string): boolean {
  const cleanCmd = command.trim()
  const cleanPat = pattern.trim()
  if (!cleanCmd || !cleanPat) return false

  // `/regex/flags` syntax
  if (cleanPat.startsWith('/') && cleanPat.lastIndexOf('/') > 0) {
    const lastSlash = cleanPat.lastIndexOf('/')
    const body = cleanPat.slice(1, lastSlash)
    const flags = cleanPat.slice(lastSlash + 1)
    if (/^[gimsuy]*$/.test(flags)) {
      try {
        return new RegExp(body, flags).test(cleanCmd)
      } catch {
        return false
      }
    }
  }

  // Glob syntax containing `*` or `?`
  if (cleanPat.includes('*') || cleanPat.includes('?')) {
    const escaped = cleanPat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp(`^${escaped}$`, 'is').test(cleanCmd)
    } catch {
      return false
    }
  }

  // Plain substring / token match (case-insensitive)
  return cleanCmd.toLowerCase().includes(cleanPat.toLowerCase())
}

function cleanStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizePolicySandboxMode(raw: unknown): SandboxMode | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase().replace(/-/g, '_')
  if (v === 'off' || v === 'workspace_write' || v === 'read_only') return v
  return undefined
}

function sanitizePolicyConfig(raw: unknown): ProjectPolicyConfig {
  if (!raw || typeof raw !== 'object') return {}
  const obj = raw as Record<string, unknown>
  const out: ProjectPolicyConfig = {}
  if (obj.version === 1) out.version = 1
  if (typeof obj.protectSensitiveFiles === 'boolean') out.protectSensitiveFiles = obj.protectSensitiveFiles
  const denyRead = cleanStringList(obj.denyRead)
  if (denyRead.length) out.denyRead = denyRead
  const allowRead = cleanStringList(obj.allowRead)
  if (allowRead.length) out.allowRead = allowRead
  const denyWrite = cleanStringList(obj.denyWrite)
  if (denyWrite.length) out.denyWrite = denyWrite
  const allowWrite = cleanStringList(obj.allowWrite)
  if (allowWrite.length) out.allowWrite = allowWrite
  const denyCommands = cleanStringList(obj.denyCommands)
  if (denyCommands.length) out.denyCommands = denyCommands
  const allowCommands = cleanStringList(obj.allowCommands)
  if (allowCommands.length) out.allowCommands = allowCommands
  const sandboxMode = normalizePolicySandboxMode(obj.sandboxMode)
  if (sandboxMode) out.sandboxMode = sandboxMode
  if (typeof obj.allowNetwork === 'boolean') out.allowNetwork = obj.allowNetwork
  return out
}

async function readPolicyFile(filePath: string): Promise<{
  info: PolicySourceInfo
  config: ProjectPolicyConfig
  mtimeMs: number
}> {
  const info: PolicySourceInfo = { path: filePath, exists: false }
  const st = await stat(filePath).catch(() => null)
  if (!st || !st.isFile()) {
    return { info, config: {}, mtimeMs: -1 }
  }
  info.exists = true
  try {
    const rawText = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(rawText) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      info.parseError = 'Policy file root must be a JSON object.'
      return { info, config: {}, mtimeMs: st.mtimeMs }
    }
    return { info, config: sanitizePolicyConfig(parsed), mtimeMs: st.mtimeMs }
  } catch (err) {
    info.parseError = err instanceof Error ? err.message : String(err)
    return { info, config: {}, mtimeMs: st.mtimeMs }
  }
}

function dedupeLists(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    if (!list) continue
    for (const item of list) {
      if (!seen.has(item)) {
        seen.add(item)
        out.push(item)
      }
    }
  }
  return out
}

function buildInspection(
  workspace: string | undefined,
  projectFile: PolicySourceInfo,
  projectConfig: ProjectPolicyConfig,
  localFile: PolicySourceInfo,
  localConfig: ProjectPolicyConfig,
): PolicyInspection {
  const protectSensitiveFiles =
    localConfig.protectSensitiveFiles ?? projectConfig.protectSensitiveFiles ?? true

  const denyRead = dedupeLists(projectConfig.denyRead, localConfig.denyRead)
  const allowRead = dedupeLists(projectConfig.allowRead, localConfig.allowRead)
  const denyWrite = dedupeLists(projectConfig.denyWrite, localConfig.denyWrite)
  const allowWrite = dedupeLists(projectConfig.allowWrite, localConfig.allowWrite)
  const denyCommands = dedupeLists(projectConfig.denyCommands, localConfig.denyCommands)
  const allowCommands = dedupeLists(projectConfig.allowCommands, localConfig.allowCommands)

  let sandboxMode: SandboxMode | undefined = projectConfig.sandboxMode
  if (localConfig.sandboxMode) {
    if (!sandboxMode || SANDBOX_RANK[localConfig.sandboxMode] > SANDBOX_RANK[sandboxMode]) {
      sandboxMode = localConfig.sandboxMode
    }
  }

  let allowNetwork: boolean | undefined = projectConfig.allowNetwork
  if (localConfig.allowNetwork !== undefined) {
    allowNetwork = allowNetwork === false ? false : localConfig.allowNetwork
  }

  const activeRuleCount =
    (protectSensitiveFiles ? DEFAULT_SENSITIVE_GLOBS.length : 0) +
    denyRead.length +
    allowRead.length +
    denyWrite.length +
    allowWrite.length +
    denyCommands.length +
    allowCommands.length

  return {
    ...(workspace ? { workspace } : {}),
    projectFile,
    localFile,
    protectSensitiveFiles,
    defaultSensitiveGlobs: [...DEFAULT_SENSITIVE_GLOBS],
    defaultSafeExceptions: [...DEFAULT_SAFE_EXCEPTIONS],
    effective: {
      protectSensitiveFiles,
      denyRead,
      allowRead,
      denyWrite,
      allowWrite,
      denyCommands,
      allowCommands,
      ...(sandboxMode ? { sandboxMode } : {}),
      ...(allowNetwork !== undefined ? { allowNetwork } : {}),
    },
    projectConfig,
    localConfig,
    activeRuleCount,
  }
}

export async function inspectWorkspacePolicy(workspace: string | undefined): Promise<PolicyInspection> {
  if (!workspace) {
    return buildInspection(
      undefined,
      { path: '.atrium/policy.json', exists: false },
      {},
      { path: '.atrium/policy.local.json', exists: false },
      {},
    )
  }

  const key = cacheKey(workspace)
  const projectPath = join(workspace, '.atrium', 'policy.json')
  const localPath = join(workspace, '.atrium', 'policy.local.json')

  const [projStat, localStat] = await Promise.all([
    stat(projectPath).catch(() => null),
    stat(localPath).catch(() => null),
  ])
  const projMtime = projStat?.isFile() ? projStat.mtimeMs : -1
  const localMtime = localStat?.isFile() ? localStat.mtimeMs : -1

  const cached = policyCache.get(key)
  if (cached && cached.projectMtime === projMtime && cached.localMtime === localMtime) {
    return cached.inspection
  }

  const [proj, local] = await Promise.all([readPolicyFile(projectPath), readPolicyFile(localPath)])
  const inspection = buildInspection(workspace, proj.info, proj.config, local.info, local.config)
  policyCache.set(key, {
    projectMtime: proj.mtimeMs,
    localMtime: local.mtimeMs,
    inspection,
  })
  return inspection
}

export const loadWorkspacePolicy = inspectWorkspacePolicy

export async function saveWorkspacePolicy(
  workspace: string | undefined,
  scope: 'project' | 'local',
  config: ProjectPolicyConfig,
): Promise<PolicyInspection> {
  if (!workspace) {
    throw new Error('Select a workspace folder before saving a project security policy.')
  }
  const sanitized: ProjectPolicyConfig = {
    version: 1,
    ...sanitizePolicyConfig(config),
  }
  const filePath = join(workspace, '.atrium', scope === 'local' ? 'policy.local.json' : 'policy.json')
  await mkdir(join(workspace, '.atrium'), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8')
  invalidatePolicyCache(workspace)
  return inspectWorkspacePolicy(workspace)
}

function toWorkspaceRelative(workspace: string | undefined, targetPath: string): string {
  const clean = targetPath.trim()
  if (!clean) return ''
  if (!workspace || !isAbsolute(clean)) {
    return normalizeSlashes(clean)
  }
  const rel = relative(resolve(workspace), resolve(clean))
  if (rel.startsWith('..')) {
    return normalizeSlashes(clean)
  }
  return normalizeSlashes(rel)
}

function findMatchingGlob(relPath: string, patterns: string[] | undefined): string | undefined {
  if (!patterns || patterns.length === 0) return undefined
  for (const pat of patterns) {
    if (matchPolicyGlob(relPath, pat)) return pat
  }
  return undefined
}

export async function evaluateFileReadPolicy(
  workspace: string | undefined,
  targetPath: string,
  inspection?: PolicyInspection,
): Promise<PolicyDecision> {
  const policy = inspection ?? (await inspectWorkspacePolicy(workspace))
  const rel = toWorkspaceRelative(workspace, targetPath)
  if (!rel) return { allowed: true }

  const localAllow = findMatchingGlob(rel, policy.localConfig.allowRead)
  if (localAllow) return { allowed: true, matchedRule: localAllow, source: 'local' }

  const localDeny = findMatchingGlob(rel, policy.localConfig.denyRead)
  if (localDeny) {
    return {
      allowed: false,
      matchedRule: localDeny,
      source: 'local',
      reason: `Blocked by local security policy (denyRead rule "${localDeny}"): "${rel}" cannot be read.`,
    }
  }

  const projectAllow = findMatchingGlob(rel, policy.projectConfig.allowRead)
  if (projectAllow) return { allowed: true, matchedRule: projectAllow, source: 'project' }

  const projectDeny = findMatchingGlob(rel, policy.projectConfig.denyRead)
  if (projectDeny) {
    return {
      allowed: false,
      matchedRule: projectDeny,
      source: 'project',
      reason: `Blocked by project security policy (.atrium/policy.json denyRead rule "${projectDeny}"): "${rel}" cannot be read. Override locally in .atrium/policy.local.json if intended.`,
    }
  }

  if (policy.effective.protectSensitiveFiles !== false) {
    const safeMatch = findMatchingGlob(rel, DEFAULT_SAFE_EXCEPTIONS)
    if (safeMatch) return { allowed: true, matchedRule: safeMatch, source: 'default' }

    const defaultDeny = findMatchingGlob(rel, DEFAULT_SENSITIVE_GLOBS)
    if (defaultDeny) {
      return {
        allowed: false,
        matchedRule: defaultDeny,
        source: 'default',
        reason: `Blocked by Atrium sensitive-file shield (rule "${defaultDeny}"): reading "${rel}" is restricted to protect secrets/credentials. Override in .atrium/policy.local.json allowRead if needed.`,
      }
    }
  }

  return { allowed: true }
}

export async function evaluateFileWritePolicy(
  workspace: string | undefined,
  targetPath: string,
  inspection?: PolicyInspection,
): Promise<PolicyDecision> {
  const policy = inspection ?? (await inspectWorkspacePolicy(workspace))
  const rel = toWorkspaceRelative(workspace, targetPath)
  if (!rel) return { allowed: true }

  const localAllow = findMatchingGlob(rel, policy.localConfig.allowWrite)
  if (localAllow) return { allowed: true, matchedRule: localAllow, source: 'local' }

  const localDeny = findMatchingGlob(rel, policy.localConfig.denyWrite)
  if (localDeny) {
    return {
      allowed: false,
      matchedRule: localDeny,
      source: 'local',
      reason: `Blocked by local security policy (denyWrite rule "${localDeny}"): "${rel}" cannot be modified.`,
    }
  }

  const projectAllow = findMatchingGlob(rel, policy.projectConfig.allowWrite)
  if (projectAllow) return { allowed: true, matchedRule: projectAllow, source: 'project' }

  const projectDeny = findMatchingGlob(rel, policy.projectConfig.denyWrite)
  if (projectDeny) {
    return {
      allowed: false,
      matchedRule: projectDeny,
      source: 'project',
      reason: `Blocked by project security policy (.atrium/policy.json denyWrite rule "${projectDeny}"): "${rel}" cannot be modified. Override locally in .atrium/policy.local.json if intended.`,
    }
  }

  const policyFileGuard = findMatchingGlob(rel, DEFAULT_POLICY_WRITE_GUARDS)
  if (policyFileGuard) {
    return {
      allowed: false,
      matchedRule: policyFileGuard,
      source: 'default',
      reason: `Blocked by Atrium policy integrity guard: agents cannot directly edit "${rel}". Manage policy rules in Security Policy Settings.`,
    }
  }

  if (policy.effective.protectSensitiveFiles !== false) {
    const safeMatch = findMatchingGlob(rel, DEFAULT_SAFE_EXCEPTIONS)
    if (safeMatch) return { allowed: true, matchedRule: safeMatch, source: 'default' }

    const defaultDeny = findMatchingGlob(rel, DEFAULT_SENSITIVE_GLOBS)
    if (defaultDeny) {
      return {
        allowed: false,
        matchedRule: defaultDeny,
        source: 'default',
        reason: `Blocked by Atrium sensitive-file shield (rule "${defaultDeny}"): modifying "${rel}" is restricted to protect secrets/credentials. Override in .atrium/policy.local.json allowWrite if needed.`,
      }
    }
  }

  return { allowed: true }
}

const HOME_SENSITIVE_PATH_RE =
  /(?:^|[\s"'`<>=;(])(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOME%|\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)[\\/]\.(?:ssh|aws|gnupg)(?:[\\/]|$|[\s"'`;&|>)])/i

const ATRIUM_SECRETS_RE = /(?:^|[\\/])\.(?:atrium)[\\/]secrets\.json(?:$|[\s"'`;&|>)])/i

function extractCommandPathTokens(command: string): string[] {
  const out: string[] = []
  const rawTokens = command
    .split(/[\s;&|<>()`'",]+/)
    .map((t) => t.trim())
    .filter(Boolean)

  for (const tok of rawTokens) {
    // Handle KEY=VALUE assignments: skip KEY=, only inspect VALUE if it contains `/` or `\` or starts with `.`.
    const eqIdx = tok.indexOf('=')
    if (eqIdx > 0) {
      const value = tok.slice(eqIdx + 1).trim()
      if (value && (value.startsWith('.') || value.includes('/') || value.includes('\\'))) {
        out.push(value)
      }
      continue
    }
    if (tok.startsWith('-')) continue
    if (/^https?:\/\//i.test(tok)) continue
    out.push(tok)
  }
  return out
}

export async function evaluateCommandPolicy(
  workspace: string | undefined,
  command: string,
  inspection?: PolicyInspection,
): Promise<PolicyDecision> {
  const policy = inspection ?? (await inspectWorkspacePolicy(workspace))
  const cleanCmd = command.trim()
  if (!cleanCmd) return { allowed: true }

  for (const pat of policy.localConfig.allowCommands ?? []) {
    if (matchCommandPattern(cleanCmd, pat)) return { allowed: true, matchedRule: pat, source: 'local' }
  }
  for (const pat of policy.localConfig.denyCommands ?? []) {
    if (matchCommandPattern(cleanCmd, pat)) {
      return {
        allowed: false,
        matchedRule: pat,
        source: 'local',
        reason: `Blocked by local command policy (denyCommands rule "${pat}").`,
      }
    }
  }
  for (const pat of policy.projectConfig.allowCommands ?? []) {
    if (matchCommandPattern(cleanCmd, pat)) return { allowed: true, matchedRule: pat, source: 'project' }
  }
  for (const pat of policy.projectConfig.denyCommands ?? []) {
    if (matchCommandPattern(cleanCmd, pat)) {
      return {
        allowed: false,
        matchedRule: pat,
        source: 'project',
        reason: `Blocked by project command policy (.atrium/policy.json denyCommands rule "${pat}").`,
      }
    }
  }

  if (policy.effective.protectSensitiveFiles !== false) {
    if (HOME_SENSITIVE_PATH_RE.test(cleanCmd)) {
      return {
        allowed: false,
        matchedRule: '~/.ssh|~/.aws|~/.gnupg',
        source: 'default',
        reason:
          'Blocked by Atrium sensitive-file shield: shell commands accessing ~/.ssh, ~/.aws, or ~/.gnupg credential directories are blocked by default.',
      }
    }
    if (ATRIUM_SECRETS_RE.test(cleanCmd)) {
      return {
        allowed: false,
        matchedRule: '**/.atrium/secrets.json',
        source: 'default',
        reason: 'Blocked by Atrium sensitive-file shield: access to .atrium/secrets.json via shell is blocked.',
      }
    }
  }

  const tokens = extractCommandPathTokens(cleanCmd)
  for (const token of tokens) {
    const decision = await evaluateFileReadPolicy(workspace, token, policy)
    if (!decision.allowed) {
      return {
        allowed: false,
        matchedRule: decision.matchedRule,
        source: decision.source,
        reason: `Blocked by security policy: command references protected path "${token}" (${decision.matchedRule ?? 'restricted'}).`,
      }
    }
  }

  return { allowed: true }
}

export function resolveEffectiveSandbox(
  settingsMode: SandboxMode | undefined,
  settingsAllowNetwork: boolean | undefined,
  inspection: PolicyInspection,
): { sandboxMode: SandboxMode; allowNetwork: boolean } {
  const baseMode: SandboxMode = settingsMode ?? 'off'
  const policyMode = inspection.effective.sandboxMode
  const effectiveMode: SandboxMode =
    policyMode && SANDBOX_RANK[policyMode] > SANDBOX_RANK[baseMode] ? policyMode : baseMode

  const allowNetwork = inspection.effective.allowNetwork === false ? false : settingsAllowNetwork !== false
  return { sandboxMode: effectiveMode, allowNetwork }
}

export function formatPolicyPromptNote(inspection: PolicyInspection): string {
  const hasExplicitFile = inspection.projectFile.exists || inspection.localFile.exists
  const hasCustomRules =
    inspection.effective.denyRead.length > 0 ||
    inspection.effective.denyWrite.length > 0 ||
    inspection.effective.denyCommands.length > 0 ||
    Boolean(inspection.effective.sandboxMode) ||
    inspection.effective.allowNetwork === false

  if (!hasExplicitFile && !hasCustomRules) return ''

  const lines = ['# Project Security Policy']
  if (inspection.effective.protectSensitiveFiles) {
    lines.push('- Sensitive credential files (`.env`, `*.pem`, `*.key`, `~/.ssh`, etc.) are protected from read/write/shell access.')
  }
  if (inspection.effective.denyRead.length) {
    lines.push(`- Denied reads: ${inspection.effective.denyRead.join(', ')}`)
  }
  if (inspection.effective.denyWrite.length) {
    lines.push(`- Denied writes: ${inspection.effective.denyWrite.join(', ')}`)
  }
  if (inspection.effective.denyCommands.length) {
    lines.push(`- Denied commands: ${inspection.effective.denyCommands.join(', ')}`)
  }
  if (inspection.effective.sandboxMode) {
    lines.push(`- Enforced shell sandbox floor: ${inspection.effective.sandboxMode}`)
  }
  if (inspection.effective.allowNetwork === false) {
    lines.push('- Sandbox network access is disabled by project policy.')
  }
  return lines.join('\n')
}

export async function resolveWorkspaceRelPath(workspace: string, requestedAbsOrRel: string): Promise<string> {
  const root = await realpath(resolve(workspace)).catch(() => resolve(workspace))
  const abs = isAbsolute(requestedAbsOrRel) ? resolve(requestedAbsOrRel) : resolve(root, requestedAbsOrRel)
  return normalizeSlashes(relative(root, abs))
}
