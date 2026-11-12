// Local scheduled automations (cron & interval) with optional isolated Git worktree execution.
import { join } from 'node:path'
import type {
  AgentEvent,
  AutomationDraft,
  AutomationRule,
  AutomationRunRecord,
  AutomationSchedule,
  Conversation,
} from '../shared/types.ts'
import { AgentLoop } from './agent.ts'
import type { ChatStore } from './chats.ts'
import type { KnowledgeBaseManager } from './knowledge.ts'
import type { McpManager } from './mcp/manager.ts'
import type { MemoryStore } from './memory.ts'
import type { PluginManager } from './plugins.ts'
import type { SettingsStore } from './settings.ts'
import { newId, readJson, writeJson } from './store.ts'
import type { TerminalManager } from './terminal.ts'
import type { CheckpointStore } from './tools/changes.ts'
import { createGitWorktree, getGitRepoStatus } from './tools/git.ts'
import type { SkillsManager } from './tools/skills.ts'
import { systemPrompt } from './prompt.ts'

const MAX_HISTORY = 20
const MAX_CRON_SEARCH_MINUTES = 527_040 // 366 days

interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domWildcard: boolean
  dowWildcard: boolean
}

function parseField(raw: string, min: number, max: number, normalize?: (n: number) => number): Set<number> {
  const token = raw.trim()
  if (!token) throw new Error('Empty cron field.')
  const out = new Set<number>()
  for (const part of token.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) throw new Error(`Invalid cron segment in "${raw}".`)
    const slashParts = trimmed.split('/')
    if (slashParts.length > 2) throw new Error(`Too many "/" in cron segment "${trimmed}".`)
    const rangeStr = slashParts[0]!
    const step = slashParts[1] !== undefined ? Number(slashParts[1]) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in cron segment "${trimmed}".`)

    let start = min
    let end = max
    if (rangeStr !== '*') {
      const bounds = rangeStr.split('-')
      if (bounds.length === 1) {
        start = Number(bounds[0])
        end = slashParts.length === 2 ? max : start
      } else if (bounds.length === 2) {
        start = Number(bounds[0])
        end = Number(bounds[1])
      } else {
        throw new Error(`Invalid range "${rangeStr}".`)
      }
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error(`Non-integer cron value in "${trimmed}".`)
      }
      if (normalize) {
        start = normalize(start)
        end = normalize(end)
      }
      if (start < min || end > max || start > end) {
        throw new Error(`Cron value out of range (${min}-${max}) in "${trimmed}".`)
      }
    }
    for (let v = start; v <= end; v += step) {
      out.add(normalize ? normalize(v) : v)
    }
  }
  if (out.size === 0) throw new Error(`Cron field "${raw}" matched zero values.`)
  return out
}

export function parseCronExpr(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error('Cron expression must have 5 space-separated fields: minute hour day month weekday.')
  }
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  return {
    minutes: parseField(m, 0, 59),
    hours: parseField(h, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12),
    daysOfWeek: parseField(dow, 0, 7, (n) => (n === 7 ? 0 : n)),
    domWildcard: dom === '*',
    dowWildcard: dow === '*',
  }
}

function matchesCron(parsed: ParsedCron, d: Date): boolean {
  if (!parsed.minutes.has(d.getMinutes())) return false
  if (!parsed.hours.has(d.getHours())) return false
  if (!parsed.months.has(d.getMonth() + 1)) return false
  const domMatch = parsed.daysOfMonth.has(d.getDate())
  const dowMatch = parsed.daysOfWeek.has(d.getDay())
  if (!parsed.domWildcard && !parsed.dowWildcard) return domMatch || dowMatch
  return domMatch && dowMatch
}

export function nextCronRun(expr: string, afterMs = Date.now()): number {
  const parsed = parseCronExpr(expr)
  const startMinuteMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const probe = new Date(startMinuteMs)
  for (let i = 0; i < MAX_CRON_SEARCH_MINUTES; i++) {
    if (matchesCron(parsed, probe)) return probe.getTime()
    probe.setMinutes(probe.getMinutes() + 1)
  }
  throw new Error(`No matching run date found within a year for "${expr}".`)
}

export function previewCronRuns(expr: string, count = 3, afterMs = Date.now()): { valid: boolean; nextRuns: number[]; error?: string } {
  try {
    const out: number[] = []
    let cursor = afterMs
    for (let i = 0; i < Math.max(1, Math.min(count, 10)); i++) {
      const next = nextCronRun(expr, cursor)
      out.push(next)
      cursor = next
    }
    return { valid: true, nextRuns: out }
  } catch (err) {
    return { valid: false, nextRuns: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export function computeNextScheduleRun(schedule: AutomationSchedule, afterMs = Date.now()): number {
  if (schedule.kind === 'interval') {
    const mins = Math.max(1, Math.round(schedule.minutes))
    return afterMs + mins * 60_000
  }
  return nextCronRun(schedule.expr, afterMs)
}

export interface AutomationDeps {
  dir: string
  dataDir: string
  settings: SettingsStore
  chats: ChatStore
  mcp: McpManager
  checkpoints?: CheckpointStore
  skills?: SkillsManager
  plugins?: PluginManager
  terminal?: TerminalManager
  memory?: MemoryStore
  knowledge?: KnowledgeBaseManager
  emitAgent: (event: AgentEvent) => void
  onChange: (rules: AutomationRule[]) => void
  onChatsChanged: () => void
  notify?: (opts: { title: string; body: string; conversationId?: string }) => Promise<void> | void
  onBackgroundActiveChange?: (active: boolean) => void
  tickMs?: number
}

export class AutomationManager {
  private rules: AutomationRule[] = []
  private inFlight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly deps: AutomationDeps

  constructor(deps: AutomationDeps) {
    this.deps = deps
  }

  private path(): string {
    return join(this.deps.dir, 'automations.json')
  }

  async load(): Promise<void> {
    const raw = await readJson<AutomationRule[]>(this.path(), [])
    const now = Date.now()
    let dirty = false
    this.rules = raw.map((rule) => {
      const next = { ...rule }
      if (next.lastStatus === 'running') {
        next.lastStatus = 'aborted'
        dirty = true
      }
      if (next.enabled) {
        if (!next.nextRunAt || next.nextRunAt <= now) {
          try {
            next.nextRunAt = computeNextScheduleRun(next.schedule, now)
          } catch {
            next.enabled = false
          }
          dirty = true
        }
      } else if (next.nextRunAt !== undefined) {
        delete next.nextRunAt
        dirty = true
      }
      return next
    })
    if (dirty) await writeJson(this.path(), this.rules)
    this.syncBackgroundState()
  }

  startScheduler(): void {
    if (this.timer) return
    const interval = this.deps.tickMs ?? 15_000
    this.timer = setInterval(() => {
      void this.tickDueRules()
    }, interval)
    this.timer.unref?.()
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  list(): AutomationRule[] {
    return structuredClone(this.rules)
  }

  hasActiveSchedules(): boolean {
    return this.rules.some((r) => r.enabled) || this.inFlight.size > 0
  }

  syncBackgroundState(): void {
    const keepAlive = this.hasActiveSchedules() || Boolean(this.deps.settings.get().runInBackground)
    this.deps.onBackgroundActiveChange?.(keepAlive)
  }

  async save(draft: AutomationDraft): Promise<AutomationRule> {
    const name = draft.name.trim()
    const prompt = draft.prompt.trim()
    if (!name) throw new Error('Automation name is required.')
    if (!prompt) throw new Error('Automation prompt is required.')
    if (draft.schedule.kind === 'interval') {
      if (!Number.isFinite(draft.schedule.minutes) || draft.schedule.minutes < 1) {
        throw new Error('Interval must be at least 1 minute.')
      }
    } else {
      parseCronExpr(draft.schedule.expr)
    }

    const now = Date.now()
    const existing = draft.id ? this.rules.find((r) => r.id === draft.id) : undefined
    const enabled = draft.enabled ?? existing?.enabled ?? true
    const schedule: AutomationSchedule =
      draft.schedule.kind === 'interval'
        ? { kind: 'interval', minutes: Math.round(draft.schedule.minutes) }
        : { kind: 'cron', expr: draft.schedule.expr.trim() }

    const rule: AutomationRule = {
      id: existing?.id ?? newId('auto'),
      name,
      prompt,
      ...(draft.workspace?.trim() ? { workspace: draft.workspace.trim() } : {}),
      useWorktree: Boolean(draft.useWorktree),
      agentMode: draft.agentMode ?? 'auto',
      schedule,
      enabled,
      notifyOnComplete: draft.notifyOnComplete ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(enabled ? { nextRunAt: computeNextScheduleRun(schedule, now) } : {}),
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastStatus ? { lastStatus: existing.lastStatus } : {}),
      ...(existing?.lastConversationId ? { lastConversationId: existing.lastConversationId } : {}),
      ...(existing?.lastSummary ? { lastSummary: existing.lastSummary } : {}),
      ...(existing?.lastError ? { lastError: existing.lastError } : {}),
      history: existing?.history ?? [],
    }

    this.rules = [...this.rules.filter((r) => r.id !== rule.id), rule].sort((a, b) => a.createdAt - b.createdAt)
    await writeJson(this.path(), this.rules)
    this.syncBackgroundState()
    this.deps.onChange(this.list())
    return structuredClone(rule)
  }

  async remove(id: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== id)
    await writeJson(this.path(), this.rules)
    this.syncBackgroundState()
    this.deps.onChange(this.list())
  }

  async setEnabled(id: string, enabled: boolean): Promise<AutomationRule> {
    const idx = this.rules.findIndex((r) => r.id === id)
    if (idx === -1) throw new Error(`Automation "${id}" was not found.`)
    const now = Date.now()
    const cur = this.rules[idx]!
    const next: AutomationRule = {
      ...cur,
      enabled,
      updatedAt: now,
      nextRunAt: enabled ? computeNextScheduleRun(cur.schedule, now) : undefined,
    }
    this.rules[idx] = next
    await writeJson(this.path(), this.rules)
    this.syncBackgroundState()
    this.deps.onChange(this.list())
    return structuredClone(next)
  }

  async runNow(id: string): Promise<AutomationRule> {
    const cur = this.rules.find((r) => r.id === id)
    if (!cur) throw new Error(`Automation "${id}" was not found.`)
    if (this.inFlight.has(id)) return structuredClone(cur)
    void this.executeRule(id)
    return structuredClone(this.rules.find((r) => r.id === id)!)
  }

  async tickDueRules(now = Date.now()): Promise<void> {
    const due = this.rules.filter((r) => r.enabled && !this.inFlight.has(r.id) && r.nextRunAt !== undefined && r.nextRunAt <= now)
    for (const rule of due) {
      void this.executeRule(rule.id, now)
    }
  }

  async executeRule(id: string, now = Date.now()): Promise<void> {
    const rule = this.rules.find((r) => r.id === id)
    if (!rule || this.inFlight.has(id)) return
    this.inFlight.add(id)

    const runId = newId('run')
    const outcome: { status: AutomationRunRecord['status']; error?: string } = { status: 'done' }
    let conv: Conversation | null = null

    try {
      const targetWs = rule.workspace ?? this.deps.settings.get().workspace
      if (targetWs && rule.useWorktree) {
        const git = await getGitRepoStatus(targetWs).catch(() => ({ isRepo: false }))
        if (git.isRepo) {
          const convId = newId('chat')
          const slug = rule.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'auto'
          const wt = await createGitWorktree(targetWs, this.deps.dataDir, convId, `auto/${slug}-${Date.now().toString(36)}`)
          conv = await this.deps.chats.create({
            id: convId,
            workspace: wt.worktreePath,
            providerId: this.deps.settings.activeProvider()?.id,
            worktreeBaseWorkspace: wt.baseWorkspace,
            worktreeBranch: wt.branch,
            worktreeBaseBranch: wt.baseBranch,
          })
        }
      }
      if (!conv) {
        conv = await this.deps.chats.create({
          workspace: targetWs,
          providerId: this.deps.settings.activeProvider()?.id,
        })
      }
      conv.title = `[Auto] ${rule.name}`
      await this.deps.chats.save(conv)
      this.deps.onChatsChanged()

      const startRecord: AutomationRunRecord = {
        runId,
        startedAt: now,
        status: 'running',
        conversationId: conv.id,
      }
      this.patchRule(id, {
        lastRunAt: now,
        lastStatus: 'running',
        lastConversationId: conv.id,
        lastError: undefined,
        ...(rule.enabled ? { nextRunAt: computeNextScheduleRun(rule.schedule, now) } : {}),
        history: [startRecord, ...(rule.history ?? [])].slice(0, MAX_HISTORY),
      })
      await writeJson(this.path(), this.rules)
      this.deps.onChange(this.list())

      const runner = new AgentLoop({
        settings: this.deps.settings,
        mcp: this.deps.mcp,
        dataDir: this.deps.dataDir,
        checkpoints: this.deps.checkpoints,
        skills: this.deps.skills,
        plugins: this.deps.plugins,
        terminal: this.deps.terminal,
        memory: this.deps.memory,
        knowledge: this.deps.knowledge,
        forcedMode: rule.agentMode ?? 'auto',
        unattended: true,
        emit: (ev) => {
          this.deps.emitAgent(ev)
          if (ev.type === 'error') outcome.error = ev.message
          else if (ev.type === 'turn_end') {
            outcome.status = ev.reason === 'max_rounds' ? 'done' : ev.reason
          }
        },
        save: async (c) => {
          await this.deps.chats.save(c)
          this.deps.onChatsChanged()
        },
        systemPrompt,
      })

      await runner.run(conv, rule.prompt)

      let summary = ''
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const m = conv.messages[i]
        if (m?.role === 'assistant' && m.text.trim()) {
          summary = m.text.trim().slice(0, 240)
          break
        }
      }

      const finishedAt = Date.now()
      const freshRule = this.rules.find((r) => r.id === id)
      const nextHistory = (freshRule?.history ?? []).map((h) =>
        h.runId === runId
          ? {
              ...h,
              finishedAt,
              status: outcome.status,
              ...(summary ? { summary } : {}),
              ...(outcome.error ? { error: outcome.error } : {}),
            }
          : h,
      )
      this.patchRule(id, {
        lastStatus: outcome.status,
        ...(summary ? { lastSummary: summary } : {}),
        ...(outcome.error ? { lastError: outcome.error } : {}),
        history: nextHistory,
      })
      await writeJson(this.path(), this.rules)
      this.deps.onChange(this.list())

      if (rule.notifyOnComplete !== false) {
        const body =
          outcome.status === 'error'
            ? outcome.error || 'Scheduled automation failed.'
            : summary || 'Completed scheduled task.'
        await this.deps.notify?.({
          title: `Atrium · ${rule.name}`,
          body: body.slice(0, 160),
          conversationId: conv.id,
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const finishedAt = Date.now()
      const freshRule = this.rules.find((r) => r.id === id)
      const nextHistory = (freshRule?.history ?? []).map((h) =>
        h.runId === runId ? { ...h, finishedAt, status: 'error' as const, error: msg } : h,
      )
      this.patchRule(id, {
        lastStatus: 'error',
        lastError: msg,
        history: nextHistory,
      })
      await writeJson(this.path(), this.rules).catch(() => undefined)
      this.deps.onChange(this.list())
      if (rule.notifyOnComplete !== false) {
        await this.deps.notify?.({
          title: `Atrium · ${rule.name}`,
          body: msg.slice(0, 160),
          ...(conv?.id ? { conversationId: conv.id } : {}),
        })
      }
    } finally {
      this.inFlight.delete(id)
      this.syncBackgroundState()
    }
  }

  private patchRule(id: string, patch: Partial<AutomationRule>): void {
    this.rules = this.rules.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: Date.now() } : r))
  }
}
