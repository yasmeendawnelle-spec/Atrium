// Deterministic plugin & workspace lifecycle hook engine (PreToolUse, PostToolUse, Stop).
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { HookEventName } from '../shared/types.ts'
import { resolveInsideReal } from './tools/workspace.ts'

export interface HookCommandSpec {
  type: 'command'
  command: string
  timeout?: number
}

export interface HookMatcherGroup {
  matcher?: string
  hooks: HookCommandSpec[]
}

export type HooksByEvent = Partial<Record<HookEventName, HookMatcherGroup[]>>

export interface PluginHookSource {
  pluginId: string
  pluginName: string
  pluginDir: string
  hooks: HooksByEvent
}

export interface HookRunEventNotice {
  event: HookEventName
  pluginName: string
  toolName?: string
  decision: 'allow' | 'block' | 'warn'
  message?: string
}

export interface HookExecutionResult {
  decision: 'allow' | 'block'
  reason?: string
  additionalContext?: string
  notices: HookRunEventNotice[]
}

export interface HookContext {
  event: HookEventName
  conversationId: string
  workspace?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  signal: AbortSignal
  sources: PluginHookSource[]
}

const TOOL_ALIASES: Record<string, readonly string[]> = {
  run_command: ['Bash'],
  start_background: ['Bash'],
  stop_background: ['Bash'],
  edit_file: ['Edit'],
  write_file: ['Write'],
  apply_patch: ['Edit', 'MultiEdit'],
  read_file: ['Read'],
  search: ['Grep'],
  list_dir: ['Glob', 'LS'],
  web_fetch: ['WebFetch'],
  web_search: ['WebSearch'],
  run_subagent: ['Task', 'Agent'],
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 60_000
const MAX_STDIO_BYTES = 64 * 1024

function clampTimeoutMs(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_TIMEOUT_MS
  const ms = raw <= 120 ? raw * 1000 : raw
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(ms)))
}

function normalizeMatcherGroups(raw: unknown): HookMatcherGroup[] {
  if (!Array.isArray(raw)) return []
  const groups: HookMatcherGroup[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const matcher = typeof obj.matcher === 'string' ? obj.matcher.trim() : undefined
    const rawHooks = Array.isArray(obj.hooks) ? obj.hooks : typeof obj.command === 'string' ? [obj] : []
    const hooks: HookCommandSpec[] = []
    for (const h of rawHooks) {
      if (!h || typeof h !== 'object') continue
      const hObj = h as Record<string, unknown>
      const kind = typeof hObj.type === 'string' ? hObj.type : 'command'
      const cmd = typeof hObj.command === 'string' ? hObj.command.trim() : ''
      if (kind !== 'command' || !cmd) continue
      const timeout = typeof hObj.timeout === 'number' && Number.isFinite(hObj.timeout) ? hObj.timeout : undefined
      hooks.push({ type: 'command', command: cmd, ...(timeout ? { timeout } : {}) })
    }
    if (hooks.length > 0) {
      groups.push({ ...(matcher ? { matcher } : {}), hooks })
    }
  }
  return groups
}

/** Normalizes both `{ hooks: { PreToolUse: [...] } }` and flat `{ PreToolUse: [...] }` structures. */
export function normalizeHooksConfig(raw: unknown): HooksByEvent {
  if (!raw || typeof raw !== 'object') return {}
  const root = raw as Record<string, unknown>
  const bag =
    root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)
      ? (root.hooks as Record<string, unknown>)
      : root
  const out: HooksByEvent = {}
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop'] as const) {
    const groups = normalizeMatcherGroups(bag[ev])
    if (groups.length > 0) out[ev] = groups
  }
  return out
}

export function matchesHookMatcher(matcher: string | undefined, toolName: string): boolean {
  const pattern = matcher?.trim()
  if (!pattern || pattern === '*') return true
  const candidates = [toolName, ...(TOOL_ALIASES[toolName] ?? [])]
  try {
    const re = new RegExp(`^(?:${pattern})$`)
    return candidates.some((name) => re.test(name))
  } catch {
    const parts = pattern.split('|').map((p) => p.trim()).filter(Boolean)
    return candidates.some((name) => parts.includes(name))
  }
}

function expandHookCommand(cmd: string, pluginDir: string): string {
  return cmd.replace(/\$\{(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT|ATRIUM_PLUGIN_ROOT)\}/g, pluginDir)
}

function killHookTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      /* fallback */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      /* fallback */
    }
  }
  try {
    proc.kill('SIGKILL')
  } catch {
    /* ignore */
  }
}

async function execHookCommand(
  source: PluginHookSource,
  spec: HookCommandSpec,
  ctx: HookContext,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string }> {
  const command = expandHookCommand(spec.command, source.pluginDir)
  const cwd = ctx.workspace || source.pluginDir
  const timeoutMs = clampTimeoutMs(spec.timeout)

  const payload = JSON.stringify({
    hook_event_name: ctx.event,
    conversation_id: ctx.conversationId,
    workspace: ctx.workspace ?? null,
    cwd,
    ...(ctx.toolName ? { tool_name: ctx.toolName } : {}),
    ...(ctx.toolInput ? { tool_input: ctx.toolInput } : {}),
    ...(ctx.toolOutput !== undefined ? { tool_output: ctx.toolOutput.slice(0, 16_000) } : {}),
    ...(ctx.isError !== undefined ? { is_error: ctx.isError } : {}),
  })

  return new Promise((resolveRun) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: source.pluginDir,
        ATRIUM_PLUGIN_ROOT: source.pluginDir,
        ...(ctx.workspace ? { ATRIUM_WORKSPACE: ctx.workspace, CLAUDE_PROJECT_DIR: ctx.workspace } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const finish = (code: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      resolveRun({ code, stdout, stderr, timedOut, ...(error ? { error } : {}) })
    }

    const onAbort = () => {
      killHookTree(child)
      finish(null, 'Aborted')
    }
    if (ctx.signal.aborted) {
      onAbort()
      return
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      timedOut = true
      killHookTree(child)
      finish(null, `Hook timed out after ${Math.round(timeoutMs / 1000)}s`)
    }, timeoutMs)

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_STDIO_BYTES) {
        stdout = (stdout + d.toString('utf8')).slice(0, MAX_STDIO_BYTES)
      }
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_STDIO_BYTES) {
        stderr = (stderr + d.toString('utf8')).slice(0, MAX_STDIO_BYTES)
      }
    })
    child.stdin?.on('error', () => undefined)
    try {
      child.stdin?.end(payload, 'utf8')
    } catch {
      /* ignore */
    }
    child.on('error', (err) => finish(null, err.message))
    child.on('exit', (code) => finish(code))
  })
}

function parseJsonOutput(stdout: string): {
  blockReason?: string
  additionalContext?: string
} {
  const trimmed = stdout.trim()
  if (!trimmed.startsWith('{')) return {}
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const specific =
      parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === 'object'
        ? (parsed.hookSpecificOutput as Record<string, unknown>)
        : undefined
    const blocked =
      parsed.decision === 'block' ||
      parsed.continue === false ||
      specific?.permissionDecision === 'deny'
    const blockReason = blocked
      ? (typeof parsed.reason === 'string' && parsed.reason.trim()) ||
        (typeof parsed.stopReason === 'string' && parsed.stopReason.trim()) ||
        (typeof specific?.permissionDecisionReason === 'string' && specific.permissionDecisionReason.trim()) ||
        'Blocked by plugin hook.'
      : undefined
    const additionalContext =
      (typeof parsed.additionalContext === 'string' && parsed.additionalContext.trim()) ||
      (typeof specific?.additionalContext === 'string' && specific.additionalContext.trim()) ||
      undefined
    return { blockReason, additionalContext }
  } catch {
    return {}
  }
}

const WORKSPACE_HOOK_CACHE_LIMIT = 64
const workspaceHookCache = new Map<string, { mtimeMs: number; source: PluginHookSource | null }>()

function normWsKey(workspace: string): string {
  const abs = resolve(workspace)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function invalidateWorkspaceHookCache(workspace?: string): void {
  if (!workspace) {
    workspaceHookCache.clear()
    return
  }
  workspaceHookCache.delete(normWsKey(workspace))
}

/** Loads optional `<workspace>/.atrium/hooks.json` in addition to plugin hook sources, cached by mtime. */
export async function loadWorkspaceHookSource(workspace: string | undefined): Promise<PluginHookSource | null> {
  if (!workspace?.trim()) return null
  const key = normWsKey(workspace)
  try {
    const candidate = join(resolve(workspace), '.atrium', 'hooks.json')
    const st = await stat(candidate).catch(() => null)
    const mtimeMs = st && st.isFile() ? st.mtimeMs : -1
    const cached = workspaceHookCache.get(key)
    if (cached && cached.mtimeMs === mtimeMs) return cached.source

    let source: PluginHookSource | null = null
    if (mtimeMs >= 0) {
      const realWs = await realpath(workspace)
      const hookFile = await resolveInsideReal(realWs, join('.atrium', 'hooks.json')).catch(() => null)
      if (hookFile) {
        const raw = await readFile(hookFile, 'utf8')
        const hooks = normalizeHooksConfig(JSON.parse(raw))
        if (hooks.PreToolUse || hooks.PostToolUse || hooks.Stop) {
          source = {
            pluginId: '__workspace__',
            pluginName: 'Workspace Hooks',
            pluginDir: realWs,
            hooks,
          }
        }
      }
    }

    if (workspaceHookCache.has(key)) workspaceHookCache.delete(key)
    else if (workspaceHookCache.size >= WORKSPACE_HOOK_CACHE_LIMIT) {
      const oldest = workspaceHookCache.keys().next().value
      if (oldest !== undefined) workspaceHookCache.delete(oldest)
    }
    workspaceHookCache.set(key, { mtimeMs, source })
    return source
  } catch {
    return null
  }
}

export class HookEngine {
  async run(ctx: HookContext): Promise<HookExecutionResult> {
    const notices: HookRunEventNotice[] = []
    const extraContexts: string[] = []

    for (const source of ctx.sources) {
      const groups = source.hooks[ctx.event]
      if (!groups?.length) continue

      for (const group of groups) {
        if (ctx.event !== 'Stop' && ctx.toolName && !matchesHookMatcher(group.matcher, ctx.toolName)) {
          continue
        }
        for (const spec of group.hooks) {
          if (ctx.signal.aborted) {
            return { decision: 'allow', notices }
          }
          const res = await execHookCommand(source, spec, ctx)
          if (res.timedOut || res.error) {
            notices.push({
              event: ctx.event,
              pluginName: source.pluginName,
              toolName: ctx.toolName,
              decision: 'warn',
              message: res.error || 'Hook execution error.',
            })
            continue
          }
          if (res.code === 2) {
            const reason = res.stderr.trim() || res.stdout.trim() || `Blocked by ${source.pluginName} (${ctx.event}).`
            notices.push({
              event: ctx.event,
              pluginName: source.pluginName,
              toolName: ctx.toolName,
              decision: 'block',
              message: reason,
            })
            return {
              decision: 'block',
              reason,
              ...(extraContexts.length ? { additionalContext: extraContexts.join('\n\n') } : {}),
              notices,
            }
          }
          if (res.code === 0) {
            const parsed = parseJsonOutput(res.stdout)
            if (parsed.additionalContext) extraContexts.push(parsed.additionalContext)
            if (parsed.blockReason) {
              notices.push({
                event: ctx.event,
                pluginName: source.pluginName,
                toolName: ctx.toolName,
                decision: 'block',
                message: parsed.blockReason,
              })
              return {
                decision: 'block',
                reason: parsed.blockReason,
                ...(extraContexts.length ? { additionalContext: extraContexts.join('\n\n') } : {}),
                notices,
              }
            }
            notices.push({
              event: ctx.event,
              pluginName: source.pluginName,
              toolName: ctx.toolName,
              decision: 'allow',
            })
          } else {
            notices.push({
              event: ctx.event,
              pluginName: source.pluginName,
              toolName: ctx.toolName,
              decision: 'warn',
              message: res.stderr.trim() || `Hook exited with code ${res.code ?? 'null'}.`,
            })
          }
        }
      }
    }

    return {
      decision: 'allow',
      ...(extraContexts.length ? { additionalContext: extraContexts.join('\n\n') } : {}),
      notices,
    }
  }
}
