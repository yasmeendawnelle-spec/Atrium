// Atrium Platform Manager: unifies local coding agents and orchestrates cross-agent delegation.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { normalizeReasoningEffort, type Message, type ProviderConfig, type WorktreeMergeResult } from '../../shared/types.ts'
import type {
  PlatformAgentProfile,
  PlatformAgentUpdatePatch,
  PlatformBoardNote,
  PlatformCustomAgentDraft,
  PlatformEvent,
  PlatformLogEntry,
  PlatformModelOption,
  PlatformPermissionMode,
  PlatformSession,
  PlatformSessionSummary,
  PlatformStartSessionRequest,
  PlatformTask,
  PlatformTaskDiffResult,
} from '../../shared/platform.ts'
import { displayProviderName, isLocalProviderUrl } from '../../shared/orchestrator.ts'
import type { SettingsStore } from '../settings.ts'
import { newId, readJson, writeJson } from '../store.ts'
import { createGitWorktree, getGitChanges, mergeWorktreeToBase, removeGitWorktree } from '../tools/git.ts'
import {
  detectLocalAgentEndpoint,
  detectLocalDefaultModel,
  discoverPlatformAgents,
  inferEffortFromModelName,
  probeAgyModels,
  probeClaudeCodeModels,
  probeCodexModels,
  resolveAgyVariantForEffort,
  resolveCliConfigModelValue,
  runExternalCliAgent,
  writeLocalDefaultEffort,
  writeLocalDefaultModel,
  type CustomAgentRecord,
  type SavedAgentPref,
} from './adapters.ts'
import {
  PlatformBusServer,
  buildCommanderSystemPrompt,
  buildWorkerSystemPrompt,
  type BusCallContext,
} from './bus.ts'
import { runAtriumPlatformAgent } from './atriumRunner.ts'

const MAX_SAVED_SESSIONS = 25
const DEFAULT_MAX_DEPTH = 2
const MAX_ALLOWED_DEPTH = 4
const MAX_CONCURRENT_WORKERS = 4
const MAX_TASK_LOGS = 400

interface SavedPlatformConfig {
  prefs: Record<string, SavedAgentPref>
  customAgents: CustomAgentRecord[]
  cachedModelsByAgent?: Record<string, PlatformModelOption[]>
  cachedEndpointsByAgent?: Record<string, string>
}

export interface PlatformManagerDeps {
  dir: string
  dataDir: string
  settings: SettingsStore
  onBeforeModelCall?: (provider: ProviderConfig, model: string) => Promise<void>
  emit: (event: PlatformEvent) => void
}

function summarizeSession(s: PlatformSession): PlatformSessionSummary {
  return {
    id: s.id,
    title: s.title,
    workspace: s.workspace,
    commanderId: s.commanderId,
    workerIds: [...s.workerIds],
    useWorktrees: s.useWorktrees,
    status: s.status,
    taskCount: s.tasks.length,
    runningCount: s.tasks.filter((t) => t.status === 'running').length,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}

function summarizeTitle(prompt: string): string {
  const first = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? 'Platform Mission'
  return first.length > 52 ? `${first.slice(0, 52)}…` : first
}

function clampDepth(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_DEPTH
  return Math.max(1, Math.min(MAX_ALLOWED_DEPTH, Math.floor(raw)))
}

export class PlatformManager {
  private dir: string
  private dataDir: string
  private settings: SettingsStore
  private onBeforeModelCall?: (provider: ProviderConfig, model: string) => Promise<void>
  private emitEvent: (event: PlatformEvent) => void

  private config: SavedPlatformConfig = { prefs: {}, customAgents: [] }
  private agents: PlatformAgentProfile[] = []
  private initialScan: Promise<PlatformAgentProfile[]> | null = null
  private cachedModelsByAgent: Record<string, PlatformModelOption[]> = {}
  private modelProbeInFlight = new Map<string, Promise<PlatformModelOption[]>>()
  private sessions = new Map<string, PlatformSession>()
  private sessionOrder: string[] = []
  private buses = new Map<string, PlatformBusServer>()
  private controllers = new Map<string, AbortController>() // key: `${sessionId}:${taskId}`
  private taskPromises = new Map<string, Promise<PlatformTask>>() // key: `${sessionId}:${taskId}`
  private atriumHistories = new Map<string, Message[]>() // key: `${sessionId}:${taskId}`

  constructor(deps: PlatformManagerDeps) {
    this.dir = deps.dir
    this.dataDir = deps.dataDir
    this.settings = deps.settings
    this.onBeforeModelCall = deps.onBeforeModelCall
    this.emitEvent = deps.emit
  }

  private configPath(): string {
    return join(this.dir, 'platform-config.json')
  }

  private sessionsPath(): string {
    return join(this.dataDir, 'platform', 'sessions.json')
  }

  private runtimeDir(sessionId: string): string {
    return join(this.dataDir, 'platform', 'runtime', sessionId)
  }

  private taskKey(sessionId: string, taskId: string): string {
    return `${sessionId}:${taskId}`
  }

  async load(): Promise<void> {
    const rawCfg = await readJson<Partial<SavedPlatformConfig>>(this.configPath(), {})
    const restoredCache: Record<string, PlatformModelOption[]> = {}
    if (rawCfg.cachedModelsByAgent && typeof rawCfg.cachedModelsByAgent === 'object') {
      for (const [k, list] of Object.entries(rawCfg.cachedModelsByAgent)) {
        if (!Array.isArray(list)) continue
        const clean = list
          .filter((item): item is PlatformModelOption => Boolean(item && typeof item.id === 'string' && item.id.trim()))
          .map((item) => ({
            id: item.id.trim(),
            ...(typeof item.label === 'string' && item.label.trim() ? { label: item.label.trim() } : {}),
            ...(typeof item.hint === 'string' && item.hint.trim() ? { hint: item.hint.trim() } : {}),
            ...(typeof item.providerId === 'string' && item.providerId.trim() ? { providerId: item.providerId.trim() } : {}),
            ...(typeof item.group === 'string' && item.group.trim() ? { group: item.group.trim() } : {}),
          }))
        if (clean.length > 0) restoredCache[k] = clean
      }
    }
    const restoredEndpoints: Record<string, string> = {}
    if (rawCfg.cachedEndpointsByAgent && typeof rawCfg.cachedEndpointsByAgent === 'object') {
      for (const [k, v] of Object.entries(rawCfg.cachedEndpointsByAgent)) {
        if (typeof v === 'string' && v.trim()) restoredEndpoints[k] = v.trim()
      }
    }
    this.cachedModelsByAgent = restoredCache
    this.config = {
      prefs: rawCfg.prefs && typeof rawCfg.prefs === 'object' ? { ...rawCfg.prefs } : {},
      customAgents: Array.isArray(rawCfg.customAgents) ? [...rawCfg.customAgents] : [],
      cachedModelsByAgent: restoredCache,
      cachedEndpointsByAgent: restoredEndpoints,
    }
    const rawSessions = await readJson<PlatformSession[]>(this.sessionsPath(), [])
    this.sessions.clear()
    this.sessionOrder = []
    if (Array.isArray(rawSessions)) {
      for (const s of rawSessions.slice(0, MAX_SAVED_SESSIONS)) {
        if (!s?.id) continue
        // Normalize interrupted tasks from a prior process crash/exit.
        const fixedTasks = (s.tasks ?? []).map((t) =>
          t.status === 'running' || t.status === 'queued'
            ? { ...t, status: 'stopped' as unknown as PlatformTask['status'] }
            : t,
        )
        const normalizedTasks = fixedTasks.map((t) =>
          (t.status as string) === 'stopped' ? { ...t, status: 'cancelled' as const, endedAt: t.endedAt ?? Date.now() } : t,
        )
        const status = s.status === 'running' ? 'stopped' : s.status
        this.sessions.set(s.id, { ...s, status, tasks: normalizedTasks, board: s.board ?? [] })
        this.sessionOrder.push(s.id)
      }
    }
    // Probe local CLIs in the background so core startup stays instant.
    this.initialScan = this.scanAgents().finally(() => {
      this.initialScan = null
    })
  }

  private async ensureScanned(): Promise<void> {
    if (this.initialScan) {
      await this.initialScan
      return
    }
    if (this.agents.length === 0) {
      await this.scanAgents()
    }
  }

  private async saveConfig(): Promise<void> {
    await writeJson(this.configPath(), this.config)
  }

  private async saveSessions(): Promise<void> {
    const list = this.sessionOrder
      .slice(0, MAX_SAVED_SESSIONS)
      .map((id) => this.sessions.get(id))
      .filter((s): s is PlatformSession => Boolean(s))
    await mkdir(join(this.dataDir, 'platform'), { recursive: true })
    await writeJson(this.sessionsPath(), list)
  }

  private atriumModelCatalog(): { defaultModel?: string; models: PlatformModelOption[] } {
    const active = this.settings.activeProvider()
    const providers = this.settings.listProviders()
    const usable = providers.filter((p) => p.hasKey || isLocalProviderUrl(p.baseUrl) || p.id === active?.id)
    const seen = new Set<string>()
    const models: PlatformModelOption[] = []
    for (const p of usable) {
      const providerLabel = displayProviderName(p)
      const list = p.models?.length ? p.models : [p.model]
      for (const raw of list) {
        const clean = raw.trim()
        const key = `${p.id}::${clean}`
        if (!clean || seen.has(key)) continue
        seen.add(key)
        models.push({ id: clean, hint: providerLabel, group: providerLabel, providerId: p.id })
      }
    }
    return { defaultModel: active?.model, models }
  }

  async scanAgents(): Promise<PlatformAgentProfile[]> {
    const atriumCatalog = this.atriumModelCatalog()
    // Invalidate cached model catalogs if a CLI switched third-party endpoints (e.g. cc-switch)
    const [claudeEndpoint, codexEndpoint] = await Promise.all([
      detectLocalAgentEndpoint('claude-code'),
      detectLocalAgentEndpoint('codex'),
    ])
    const nextEndpoints: Record<string, string> = { ...(this.config.cachedEndpointsByAgent ?? {}) }
    const checkEndpointCache = (agentId: string, liveEndpoint?: string) => {
      const prevEndpoint = nextEndpoints[agentId]
      if ((prevEndpoint ?? '') !== (liveEndpoint ?? '')) {
        delete this.cachedModelsByAgent[agentId]
        if (this.config.cachedModelsByAgent) delete this.config.cachedModelsByAgent[agentId]
      }
      if (liveEndpoint) nextEndpoints[agentId] = liveEndpoint
      else delete nextEndpoints[agentId]
    }
    checkEndpointCache('claude-code', claudeEndpoint)
    checkEndpointCache('codex', codexEndpoint)
    this.config.cachedEndpointsByAgent = nextEndpoints

    this.agents = await discoverPlatformAgents({
      prefs: this.config.prefs,
      customAgents: this.config.customAgents,
      previousAgents: this.agents,
      atriumDefaultModel: atriumCatalog.defaultModel,
      atriumDefaultEffort: this.settings.get().reasoningEffort,
      atriumModels: atriumCatalog.models,
      cachedModelsByAgent: this.cachedModelsByAgent,
    })
    // Persist initial role selection once so subsequent rescans stay stable.
    for (const a of this.agents) {
      if (!this.config.prefs[a.id]) {
        this.config.prefs[a.id] = {
          role: a.role,
          permissionMode: a.permissionMode,
        }
      }
    }
    this.emitEvent({ type: 'agents', agents: this.listAgents() })
    const agy = this.agents.find((a) => a.id === 'agy')
    if (agy?.available && agy.binaryPath && !this.cachedModelsByAgent.agy?.length) {
      void this.getAgentModels('agy').catch(() => undefined)
    }
    const claude = this.agents.find((a) => a.id === 'claude-code')
    if (claude?.available && claude.endpointLabel && !this.cachedModelsByAgent['claude-code']?.length) {
      void this.getAgentModels('claude-code').catch(() => undefined)
    }
    const codex = this.agents.find((a) => a.id === 'codex')
    if (codex?.available && codex.endpointLabel && !this.cachedModelsByAgent.codex?.length) {
      void this.getAgentModels('codex').catch(() => undefined)
    }
    return this.listAgents()
  }

  async getAgentModels(agentId: string, refresh = false): Promise<PlatformModelOption[]> {
    await this.ensureScanned()
    const target = this.agents.find((a) => a.id === agentId)
    if (!target) return []

    if (target.kind === 'atrium') {
      const catalog = this.atriumModelCatalog()
      target.defaultModel = catalog.defaultModel
      target.availableModels = catalog.models
      this.emitEvent({ type: 'agents', agents: this.listAgents() })
      return [...catalog.models]
    }

    if (target.kind === 'agy' && target.available && target.binaryPath) {
      if (!refresh && this.cachedModelsByAgent[agentId]?.length) {
        return [...this.cachedModelsByAgent[agentId]!]
      }
      const existing = this.modelProbeInFlight.get(agentId)
      if (existing) return existing

      const binPath = target.binaryPath
      const promise = probeAgyModels(binPath)
        .then((models) => {
          if (models.length > 0) {
            this.cachedModelsByAgent[agentId] = models
            this.config.cachedModelsByAgent = { ...(this.config.cachedModelsByAgent ?? {}), [agentId]: models }
            void this.saveConfig().catch(() => undefined)
            const current = this.agents.find((a) => a.id === agentId)
            if (current) current.availableModels = models
            this.emitEvent({ type: 'agents', agents: this.listAgents() })
            return models
          }
          return target.availableModels ? [...target.availableModels] : []
        })
        .finally(() => {
          this.modelProbeInFlight.delete(agentId)
        })
      this.modelProbeInFlight.set(agentId, promise)
      return promise
    }

    if ((target.kind === 'claude-code' || target.kind === 'codex') && target.available) {
      const liveEndpoint = await detectLocalAgentEndpoint(target.kind)
      const prevEndpoint = this.config.cachedEndpointsByAgent?.[agentId]
      const endpointChanged = (liveEndpoint ?? '') !== (prevEndpoint ?? '')
      if (!refresh && !endpointChanged && this.cachedModelsByAgent[agentId]?.length) {
        return [...this.cachedModelsByAgent[agentId]!]
      }
      const existing = this.modelProbeInFlight.get(agentId)
      if (existing) return existing

      const promise = (target.kind === 'claude-code' ? probeClaudeCodeModels() : probeCodexModels())
        .then(async ({ models, endpointLabel }) => {
          const detectedDefault = await detectLocalDefaultModel(target.kind)
          this.cachedModelsByAgent[agentId] = models
          this.config.cachedModelsByAgent = { ...(this.config.cachedModelsByAgent ?? {}), [agentId]: models }
          this.config.cachedEndpointsByAgent = { ...(this.config.cachedEndpointsByAgent ?? {}) }
          if (endpointLabel) this.config.cachedEndpointsByAgent[agentId] = endpointLabel
          else delete this.config.cachedEndpointsByAgent[agentId]
          void this.saveConfig().catch(() => undefined)
          const current = this.agents.find((a) => a.id === agentId)
          if (current) {
            current.availableModels = models
            current.endpointLabel = endpointLabel
            if (detectedDefault) current.defaultModel = detectedDefault
          }
          this.emitEvent({ type: 'agents', agents: this.listAgents() })
          return models
        })
        .finally(() => {
          this.modelProbeInFlight.delete(agentId)
        })
      this.modelProbeInFlight.set(agentId, promise)
      return promise
    }

    if (refresh && target.kind === 'gemini-cli') {
      const detectedDefault = await detectLocalDefaultModel('gemini-cli')
      if (detectedDefault) target.defaultModel = detectedDefault
      this.emitEvent({ type: 'agents', agents: this.listAgents() })
    }

    return target.availableModels ? [...target.availableModels] : []
  }

  async getAgents(): Promise<PlatformAgentProfile[]> {
    await this.ensureScanned()
    return this.listAgents()
  }

  listAgents(): PlatformAgentProfile[] {
    return this.agents.map((a) => ({
      ...a,
      ...(a.customArgs ? { customArgs: [...a.customArgs] } : {}),
      ...(a.availableModels ? { availableModels: a.availableModels.map((m) => ({ ...m })) } : {}),
    }))
  }

  async updateAgent(agentId: string, patch: PlatformAgentUpdatePatch): Promise<PlatformAgentProfile[]> {
    await this.ensureScanned()
    const target = this.agents.find((a) => a.id === agentId)
    if (!target) throw new Error(`Unknown agent "${agentId}".`)

    if (patch.role === 'commander') {
      if (!target.available) {
        throw new Error(`Agent "${target.name}" is not installed on this machine.`)
      }
      for (const a of this.agents) {
        if (a.id !== agentId && a.role === 'commander') {
          this.config.prefs[a.id] = { ...(this.config.prefs[a.id] ?? {}), role: a.available ? 'worker' : 'disabled' }
        }
      }
    }

    const prev = this.config.prefs[agentId] ?? {}
    let nextModelOverride =
      patch.modelOverride !== undefined ? patch.modelOverride.trim() || undefined : prev.modelOverride
    let nextProviderOverride =
      patch.modelOverride !== undefined && !patch.modelOverride.trim()
        ? undefined
        : patch.modelProviderOverride !== undefined
          ? patch.modelProviderOverride.trim() || undefined
          : prev.modelProviderOverride
    let nextEffortOverride =
      patch.reasoningEffortOverride !== undefined
        ? patch.reasoningEffortOverride === ''
          ? undefined
          : normalizeReasoningEffort(patch.reasoningEffortOverride)
        : prev.reasoningEffortOverride

    // Smart AGY coordination: effort slider aligns with sibling model variant when available, and model selection clears stale effort override.
    if (target.kind === 'agy') {
      if (patch.reasoningEffortOverride !== undefined && patch.modelOverride === undefined && nextEffortOverride && nextEffortOverride !== 'auto') {
        const baseModel = nextModelOverride || target.defaultModel
        if (baseModel) {
          const variant = resolveAgyVariantForEffort(baseModel, nextEffortOverride, target.availableModels)
          if (variant) nextModelOverride = variant.id
        }
      } else if (patch.modelOverride !== undefined && patch.reasoningEffortOverride === undefined) {
        if (!patch.modelOverride.trim()) {
          nextEffortOverride = undefined
        } else if (prev.reasoningEffortOverride !== undefined) {
          nextEffortOverride = inferEffortFromModelName(nextModelOverride)
        }
      }
    }

    if (patch.syncToCliConfig === true) {
      const targetModel =
        (patch.modelOverride !== undefined ? patch.modelOverride : nextModelOverride || target.defaultModel)?.trim() || ''
      const targetEffort =
        patch.reasoningEffortOverride !== undefined
          ? patch.reasoningEffortOverride === ''
            ? undefined
            : normalizeReasoningEffort(patch.reasoningEffortOverride)
          : nextEffortOverride

      if (target.kind === 'atrium') {
        if (targetModel) {
          const providers = this.settings.listProviders()
          const targetProviderId =
            patch.modelProviderOverride?.trim() ||
            target.modelProviderOverride?.trim() ||
            providers.find(
              (p) =>
                (p.hasKey || isLocalProviderUrl(p.baseUrl)) &&
                (p.model === targetModel || p.models?.includes(targetModel)),
            )?.id ||
            this.settings.activeProvider()?.id
          if (!targetProviderId) {
            throw new Error('No Atrium provider available to save this default model.')
          }
          await this.settings.selectProviderModel(targetProviderId, targetModel)
        }
        if (targetEffort) {
          await this.settings.update({ reasoningEffort: targetEffort })
        }
        nextModelOverride = undefined
        nextProviderOverride = undefined
        nextEffortOverride = undefined
      } else if (target.kind === 'agy') {
        const paired =
          targetModel && targetEffort && targetEffort !== 'auto'
            ? resolveAgyVariantForEffort(targetModel, targetEffort, target.availableModels)
            : undefined
        const finalModel = paired?.id || targetModel
        if (finalModel) {
          const configVal = resolveCliConfigModelValue('agy', finalModel, target.availableModels)
          await writeLocalDefaultModel('agy', configVal)
        }
        nextModelOverride = undefined
        nextProviderOverride = undefined
        nextEffortOverride = targetEffort && targetEffort !== 'auto' && !paired ? targetEffort : undefined
      } else {
        if (targetModel) {
          const configVal = resolveCliConfigModelValue(target.kind, targetModel, target.availableModels)
          await writeLocalDefaultModel(target.kind, configVal)
        }
        if (targetEffort && targetEffort !== 'auto' && (target.kind === 'claude-code' || target.kind === 'codex')) {
          await writeLocalDefaultEffort(target.kind, targetEffort)
        }
        nextModelOverride = undefined
        nextProviderOverride = undefined
        nextEffortOverride = undefined
      }
    }

    this.config.prefs[agentId] = {
      ...prev,
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      modelOverride: nextModelOverride,
      modelProviderOverride: nextProviderOverride,
      reasoningEffortOverride: nextEffortOverride,
      ...(patch.binaryPath !== undefined ? { binaryPath: patch.binaryPath.trim() || undefined } : {}),
    }

    await this.saveConfig()
    return this.scanAgents()
  }

  async saveCustomAgent(draft: PlatformCustomAgentDraft): Promise<PlatformAgentProfile[]> {
    await this.ensureScanned()
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name || !command) throw new Error('Custom agent name and executable command are required.')
    const id = draft.id?.trim() || `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || newId('pcust')}`
    const record: CustomAgentRecord = {
      id,
      name,
      command,
      args: Array.isArray(draft.args) ? draft.args.map((s) => String(s)) : [],
      description: draft.description?.trim() || undefined,
      permissionMode: draft.permissionMode ?? 'accept_edits',
    }
    const idx = this.config.customAgents.findIndex((c) => c.id === id)
    if (idx >= 0) this.config.customAgents[idx] = record
    else this.config.customAgents.push(record)

    this.config.prefs[id] = {
      ...(this.config.prefs[id] ?? {}),
      role: this.config.prefs[id]?.role ?? 'worker',
      permissionMode: record.permissionMode,
    }
    await this.saveConfig()
    return this.scanAgents()
  }

  async removeCustomAgent(agentId: string): Promise<PlatformAgentProfile[]> {
    await this.ensureScanned()
    const before = this.config.customAgents.length
    this.config.customAgents = this.config.customAgents.filter((c) => c.id !== agentId)
    if (this.config.customAgents.length === before) {
      throw new Error(`Custom agent "${agentId}" not found.`)
    }
    delete this.config.prefs[agentId]
    await this.saveConfig()
    return this.scanAgents()
  }

  listSessions(): PlatformSessionSummary[] {
    return this.sessionOrder
      .map((id) => this.sessions.get(id))
      .filter((s): s is PlatformSession => Boolean(s))
      .map(summarizeSession)
  }

  getSession(sessionId: string): PlatformSession | null {
    const s = this.sessions.get(sessionId)
    return s ? structuredClone(s) : null
  }

  private emitSession(session: PlatformSession): void {
    this.emitEvent({ type: 'session_update', session: structuredClone(session) })
    this.emitEvent({ type: 'sessions_list', sessions: this.listSessions() })
  }

  private appendLog(session: PlatformSession, task: PlatformTask, entry: PlatformLogEntry): void {
    task.logs.push(entry)
    if (task.logs.length > MAX_TASK_LOGS) {
      task.logs.splice(0, task.logs.length - MAX_TASK_LOGS)
    }
    session.updatedAt = Date.now()
    this.emitEvent({ type: 'task_log', sessionId: session.id, taskId: task.id, entry })
  }

  private appendDelta(session: PlatformSession, task: PlatformTask, field: 'output' | 'thinking', delta: string): void {
    if (!delta) return
    if (field === 'output') task.output += delta
    else task.thinking = (task.thinking ?? '') + delta
    session.updatedAt = Date.now()
    this.emitEvent({ type: 'task_delta', sessionId: session.id, taskId: task.id, field, delta })
  }

  private async ensureBus(session: PlatformSession): Promise<PlatformBusServer> {
    const existing = this.buses.get(session.id)
    if (existing) return existing
    const bus = new PlatformBusServer({
      sessionId: session.id,
      runtimeDir: this.runtimeDir(session.id),
      dispatcher: (toolName, args, ctx) => this.dispatchBusTool(session.id, toolName, args, ctx),
    })
    await bus.start()
    this.buses.set(session.id, bus)
    return bus
  }

  private async maybeCloseIdleBus(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    const anyRunning = session?.tasks.some((t) => t.status === 'running' || t.status === 'queued') ?? false
    if (anyRunning) return
    const bus = this.buses.get(sessionId)
    if (bus) {
      this.buses.delete(sessionId)
      await bus.close()
    }
  }

  async startSession(req: PlatformStartSessionRequest): Promise<PlatformSession> {
    const prompt = req.prompt?.trim()
    if (!prompt) throw new Error('Mission prompt cannot be empty.')
    const workspace = resolve(req.workspace?.trim() || this.settings.get().workspace || process.cwd())
    if (!existsSync(workspace)) {
      throw new Error(`Workspace folder does not exist: ${workspace}`)
    }
    await this.ensureScanned()

    const commander =
      (req.commanderId ? this.agents.find((a) => a.id === req.commanderId) : undefined) ??
      this.agents.find((a) => a.role === 'commander' && a.available) ??
      this.agents.find((a) => a.available)
    if (!commander || !commander.available) {
      throw new Error('No available Commander agent found. Enable Atrium or install Claude Code / AGY / Codex.')
    }

    const explicitWorkers = req.workerIds
      ? req.workerIds.filter((id) => id !== commander.id && this.agents.some((a) => a.id === id && a.available))
      : this.agents
          .filter((a) => a.id !== commander.id && a.available && a.role !== 'disabled')
          .map((a) => a.id)

    const now = Date.now()
    const sessionId = newId('psess')
    const rootTaskId = newId('ptask')
    const rootTask: PlatformTask = {
      id: rootTaskId,
      sessionId,
      depth: 0,
      fromAgentId: 'user',
      agentId: commander.id,
      agentName: commander.name,
      prompt,
      cwd: workspace,
      permissionMode: commander.permissionMode,
      model: commander.modelOverride,
      ...(commander.modelProviderOverride ? { providerId: commander.modelProviderOverride } : {}),
      ...(commander.reasoningEffortOverride ? { reasoningEffort: commander.reasoningEffortOverride } : {}),
      status: 'running',
      output: '',
      logs: [
        {
          id: newId('plog'),
          ts: now,
          kind: 'system',
          title: 'Mission started',
          content: `${commander.name} accepted mission in ${workspace}`,
        },
      ],
      changedFiles: [],
      startedAt: now,
    }

    const session: PlatformSession = {
      id: sessionId,
      title: req.title?.trim() || summarizeTitle(prompt),
      workspace,
      commanderId: commander.id,
      workerIds: explicitWorkers,
      useWorktrees: Boolean(req.useWorktrees),
      maxDepth: clampDepth(req.maxDepth),
      status: 'running',
      rootTaskId,
      tasks: [rootTask],
      board: [
        {
          id: newId('pnote'),
          ts: now,
          authorAgentId: 'user',
          authorName: 'User',
          kind: 'plan',
          title: 'Mission Objective',
          content: prompt,
          taskId: rootTaskId,
        },
      ],
      createdAt: now,
      updatedAt: now,
    }

    this.sessions.set(sessionId, session)
    this.sessionOrder = [sessionId, ...this.sessionOrder.filter((id) => id !== sessionId)].slice(0, MAX_SAVED_SESSIONS)
    for (const key of [...this.sessions.keys()]) {
      if (!this.sessionOrder.includes(key)) this.sessions.delete(key)
    }

    await this.ensureBus(session)
    await this.saveSessions()
    this.emitSession(session)

    const p = this.launchTaskExecution(session, rootTask, commander, true)
    this.taskPromises.set(this.taskKey(sessionId, rootTaskId), p)
    void p.catch(() => undefined)
    return this.getSession(sessionId)!
  }

  private async dispatchBusTool(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx: BusCallContext,
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session "${sessionId}" not found.`)
    const callerTask = ctx.callerTaskId ? session.tasks.find((t) => t.id === ctx.callerTaskId) : undefined

    switch (toolName) {
      case 'platform_list_agents': {
        return {
          agents: this.agents.map((a) => ({
            id: a.id,
            kind: a.kind,
            name: a.name,
            role: a.role,
            available: a.available,
            permissionMode: a.permissionMode,
            defaultModel: a.defaultModel,
            modelOverride: a.modelOverride,
            activeModel: a.modelOverride || a.defaultModel,
            defaultReasoningEffort: a.defaultReasoningEffort,
            reasoningEffortOverride: a.reasoningEffortOverride,
            supportsMcpInjection: a.supportsMcpInjection,
            supportsResume: a.supportsResume,
          })),
        }
      }

      case 'platform_delegate': {
        const targetId = typeof args.target_agent === 'string' ? args.target_agent.trim() : ''
        const taskPrompt = typeof args.task === 'string' ? args.task.trim() : ''
        if (!targetId || !taskPrompt) {
          throw new Error('platform_delegate requires non-empty "target_agent" and "task".')
        }
        const callerDepth = callerTask?.depth ?? 0
        if (callerDepth + 1 > session.maxDepth) {
          throw new Error(
            `Delegation depth limit reached (${session.maxDepth}). Complete this subtask directly instead of delegating further.`,
          )
        }
        const runningWorkers = session.tasks.filter((t) => t.id !== session.rootTaskId && t.status === 'running').length
        if (runningWorkers >= MAX_CONCURRENT_WORKERS) {
          throw new Error(`Concurrent worker limit (${MAX_CONCURRENT_WORKERS}) reached. Wait for an active worker first.`)
        }
        const target = this.agents.find((a) => a.id === targetId || a.kind === targetId)
        if (!target) throw new Error(`Agent "${targetId}" is not registered in Atrium Platform.`)
        if (!target.available) {
          throw new Error(`Agent "${target.name}" (${target.id}) is not installed or unavailable on this machine.`)
        }
        if (target.role === 'disabled') {
          throw new Error(`Agent "${target.name}" (${target.id}) is disabled in the roster.`)
        }

        const modeRaw = typeof args.mode === 'string' ? args.mode : undefined
        const mode: PlatformPermissionMode =
          modeRaw === 'plan' || modeRaw === 'accept_edits' || modeRaw === 'full_auto'
            ? modeRaw
            : target.permissionMode
        const useWorktree = typeof args.use_worktree === 'boolean' ? args.use_worktree : session.useWorktrees
        const explicitModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined
        const model = explicitModel || target.modelOverride
        const providerId = explicitModel ? undefined : target.modelProviderOverride
        const wait = args.wait !== false
        const timeoutMs =
          typeof args.timeout_sec === 'number' && Number.isFinite(args.timeout_sec) && args.timeout_sec > 0
            ? Math.min(1800, Math.max(15, args.timeout_sec)) * 1000
            : undefined

        const childId = newId('ptask')
        let cwd = session.workspace
        let worktreePath: string | undefined
        let worktreeBranch: string | undefined
        let worktreeBaseBranch: string | undefined
        let worktreeBaseWorkspace: string | undefined

        if (useWorktree) {
          const slug = target.id.replace(/[^a-z0-9-]+/gi, '-')
          const created = await createGitWorktree(
            session.workspace,
            this.dataDir,
            `plat-${childId}`,
            `atrium/plat-${slug}-${childId.slice(0, 6)}`,
            { copyEnv: this.settings.get().copyEnvOnWorktree !== false },
          )
          cwd = created.worktreePath
          worktreePath = created.worktreePath
          worktreeBranch = created.branch
          worktreeBaseBranch = created.baseBranch
          worktreeBaseWorkspace = created.baseWorkspace
        }

        const now = Date.now()
        const childTask: PlatformTask = {
          id: childId,
          sessionId: session.id,
          parentTaskId: callerTask?.id,
          depth: callerDepth + 1,
          fromAgentId: callerTask?.agentId ?? session.commanderId,
          agentId: target.id,
          agentName: target.name,
          prompt: taskPrompt,
          cwd,
          ...(worktreePath ? { worktreePath, worktreeBranch, worktreeBaseBranch, worktreeBaseWorkspace } : {}),
          permissionMode: mode,
          ...(model ? { model } : {}),
          ...(providerId ? { providerId } : {}),
          ...(target.reasoningEffortOverride ? { reasoningEffort: target.reasoningEffortOverride } : {}),
          status: 'running',
          output: '',
          logs: [
            {
              id: newId('plog'),
              ts: now,
              kind: 'system',
              title: 'Delegated',
              content: `Assigned by ${callerTask?.agentName ?? 'Commander'}${worktreeBranch ? ` · worktree ${worktreeBranch}` : ''}`,
            },
          ],
          changedFiles: [],
          startedAt: now,
        }
        session.tasks.push(childTask)
        if (!session.workerIds.includes(target.id)) session.workerIds.push(target.id)
        session.updatedAt = now
        await this.saveSessions()
        this.emitSession(session)

        const canDelegateDeeper = childTask.depth < session.maxDepth
        const promise = this.launchTaskExecution(session, childTask, target, canDelegateDeeper, timeoutMs)
        this.taskPromises.set(this.taskKey(session.id, childId), promise)

        if (!wait) {
          void promise.catch(() => undefined)
          return {
            task_id: childId,
            agent: target.id,
            status: 'running',
            cwd,
            ...(worktreeBranch ? { worktreeBranch } : {}),
          }
        }

        const done = await promise
        return {
          task_id: done.id,
          agent: done.agentId,
          status: done.status,
          output: done.output,
          changed_files: done.changedFiles,
          ...(done.worktreeBranch ? { worktreeBranch: done.worktreeBranch } : {}),
          ...(done.error ? { error: done.error } : {}),
        }
      }

      case 'platform_check_task': {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        const task = session.tasks.find((t) => t.id === taskId)
        if (!task) throw new Error(`Task "${taskId}" not found.`)
        return {
          task_id: task.id,
          agent: task.agentId,
          status: task.status,
          output_tail: task.output.slice(-6000),
          changed_files: task.changedFiles,
          ...(task.worktreeBranch ? { worktreeBranch: task.worktreeBranch } : {}),
          ...(task.error ? { error: task.error } : {}),
        }
      }

      case 'platform_wait_task': {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        const task = session.tasks.find((t) => t.id === taskId)
        if (!task) throw new Error(`Task "${taskId}" not found.`)
        const pending = this.taskPromises.get(this.taskKey(session.id, taskId))
        if (pending && task.status === 'running') {
          const timeoutSec = typeof args.timeout_sec === 'number' && args.timeout_sec > 0 ? args.timeout_sec : 600
          const timer = new Promise<PlatformTask>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out waiting for task "${taskId}".`)), timeoutSec * 1000),
          )
          const done = await Promise.race([pending, timer])
          return {
            task_id: done.id,
            agent: done.agentId,
            status: done.status,
            output: done.output,
            changed_files: done.changedFiles,
            ...(done.error ? { error: done.error } : {}),
          }
        }
        return {
          task_id: task.id,
          agent: task.agentId,
          status: task.status,
          output: task.output,
          changed_files: task.changedFiles,
          ...(task.error ? { error: task.error } : {}),
        }
      }

      case 'platform_send_followup': {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        const message = typeof args.message === 'string' ? args.message.trim() : ''
        if (!taskId || !message) throw new Error('platform_send_followup requires "task_id" and "message".')
        const wait = args.wait !== false
        const updated = await this.sendFollowup(session.id, taskId, message, wait)
        return {
          task_id: updated.id,
          agent: updated.agentId,
          status: updated.status,
          output: updated.output,
          changed_files: updated.changedFiles,
          ...(updated.error ? { error: updated.error } : {}),
        }
      }

      case 'platform_cancel_task': {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        const ok = await this.stopTask(session.id, taskId)
        return { task_id: taskId, cancelled: ok }
      }

      case 'platform_board_post': {
        const title = typeof args.title === 'string' ? args.title.trim() : ''
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (!title || !content) throw new Error('platform_board_post requires "title" and "content".')
        const rawKind = typeof args.kind === 'string' ? args.kind : 'update'
        const kind: PlatformBoardNote['kind'] =
          rawKind === 'plan' || rawKind === 'handoff' || rawKind === 'lock' || rawKind === 'review'
            ? rawKind
            : 'update'
        const note: PlatformBoardNote = {
          id: newId('pnote'),
          ts: Date.now(),
          authorAgentId: callerTask?.agentId ?? session.commanderId,
          authorName: callerTask?.agentName ?? 'Commander',
          kind,
          title,
          content,
          taskId: callerTask?.id,
        }
        session.board.push(note)
        session.updatedAt = Date.now()
        await this.saveSessions()
        this.emitSession(session)
        return { ok: true, note }
      }

      case 'platform_board_read': {
        const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 20
        return { notes: session.board.slice(-limit) }
      }

      default:
        throw new Error(`Unknown platform tool "${toolName}".`)
    }
  }

  private async launchTaskExecution(
    session: PlatformSession,
    task: PlatformTask,
    profile: PlatformAgentProfile,
    enablePlatformTools: boolean,
    timeoutMs?: number,
    resumePrompt?: string,
  ): Promise<PlatformTask> {
    const key = this.taskKey(session.id, task.id)
    const ac = new AbortController()
    this.controllers.set(key, ac)

    const bus = await this.ensureBus(session)
    const bridge = await bus.prepareTaskBridgeFiles(task.id)
    const isRootCommander = task.id === session.rootTaskId

    const systemPrompt = isRootCommander
      ? buildCommanderSystemPrompt({
          commander: profile,
          roster: this.agents,
          workspace: task.cwd,
          useWorktrees: session.useWorktrees,
          maxDepth: session.maxDepth,
          helperPath: bridge.helperPath,
          board: session.board,
        })
      : buildWorkerSystemPrompt({
          worker: profile,
          fromAgentName:
            session.tasks.find((t) => t.id === task.parentTaskId)?.agentName ??
            this.agents.find((a) => a.id === session.commanderId)?.name ??
            'Commander',
          workspace: task.cwd,
          permissionMode: task.permissionMode,
          canDelegateDeeper: task.depth < session.maxDepth,
          helperPath: bridge.helperPath,
          board: session.board,
        })

    const effectivePrompt = resumePrompt
      ? profile.supportsResume && task.nativeSessionId
        ? resumePrompt
        : `Previous output summary:\n${task.output.slice(-4000)}\n\nFollow-up instruction:\n${resumePrompt}`
      : task.prompt

    let emittedOutputInTurn = false
    try {
      if (profile.kind === 'atrium') {
        const res = await runAtriumPlatformAgent({
          settings: this.settings,
          onBeforeModelCall: this.onBeforeModelCall,
          taskId: task.id,
          prompt: effectivePrompt,
          systemPrompt,
          cwd: task.cwd,
          permissionMode: task.permissionMode,
          modelOverride: task.model,
          providerId: task.providerId,
          reasoningEffort: task.reasoningEffort,
          enablePlatformTools,
          busDispatcher: (toolName, args, ctx) => this.dispatchBusTool(session.id, toolName, args, ctx),
          priorHistory: resumePrompt ? this.atriumHistories.get(key) : undefined,
          signal: ac.signal,
          onDelta: (field, delta) => {
            if (field === 'output' && delta) emittedOutputInTurn = true
            this.appendDelta(session, task, field, delta)
          },
          onLog: (entry) => this.appendLog(session, task, entry),
        })
        this.atriumHistories.set(key, res.history)
        task.model = res.model
        if (!emittedOutputInTurn && res.output) {
          this.appendDelta(session, task, 'output', res.output)
        }
        if (res.error) task.error = res.error
      } else {
        const res = await runExternalCliAgent({
          profile,
          prompt: effectivePrompt,
          cwd: task.cwd,
          permissionMode: task.permissionMode,
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          resumeSessionId: resumePrompt ? task.nativeSessionId : undefined,
          systemPrompt: resumePrompt && task.nativeSessionId ? undefined : systemPrompt,
          mcpConfigPath: profile.supportsMcpInjection ? bridge.mcpConfigPath : undefined,
          env: bridge.env,
          timeoutMs,
          signal: ac.signal,
          onChunk: (chunk) => {
            if (chunk.nativeSessionId) task.nativeSessionId = chunk.nativeSessionId
            if (chunk.thinkingDelta) {
              this.appendDelta(session, task, 'thinking', chunk.thinkingDelta)
            }
            if (chunk.textDelta) {
              emittedOutputInTurn = true
              this.appendDelta(session, task, 'output', chunk.textDelta)
            }
            if (chunk.toolCall) {
              this.appendLog(session, task, {
                id: newId('plog'),
                ts: Date.now(),
                kind: 'tool_call',
                title: chunk.toolCall.name,
                content: chunk.toolCall.input ?? '',
              })
            }
            if (chunk.toolResult) {
              this.appendLog(session, task, {
                id: newId('plog'),
                ts: Date.now(),
                kind: 'tool_result',
                content: chunk.toolResult.output,
              })
            }
            if (chunk.error) {
              this.appendLog(session, task, {
                id: newId('plog'),
                ts: Date.now(),
                kind: 'error',
                content: chunk.error,
              })
            }
          },
          onStderr: (line) => {
            this.appendLog(session, task, {
              id: newId('plog'),
              ts: Date.now(),
              kind: 'system',
              title: 'stderr',
              content: line,
            })
          },
        })
        if (res.nativeSessionId) task.nativeSessionId = res.nativeSessionId
        if (!emittedOutputInTurn && res.output) {
          this.appendDelta(session, task, 'output', res.output)
        }
        if (res.error) task.error = res.error
      }

      if (ac.signal.aborted) {
        task.status = 'cancelled'
      } else if (task.error) {
        task.status = 'failed'
      } else {
        task.status = 'completed'
      }
    } catch (err) {
      task.error = err instanceof Error ? err.message : String(err)
      task.status = ac.signal.aborted ? 'cancelled' : 'failed'
      this.appendLog(session, task, {
        id: newId('plog'),
        ts: Date.now(),
        kind: 'error',
        content: task.error,
      })
    } finally {
      this.controllers.delete(key)
      task.endedAt = Date.now()
      try {
        const changes = await getGitChanges(task.cwd, task.worktreeBaseBranch)
        task.changedFiles = changes.map((c) => c.path)
      } catch {
        /* non-git workspace */
      }

      // Refresh session rollup status once root task finishes (or no task is still running).
      const anyRunning = session.tasks.some((t) => t.status === 'running')
      if (!anyRunning) {
        const root = session.tasks.find((t) => t.id === session.rootTaskId)
        if (root?.status === 'cancelled' || session.status === 'stopped') session.status = 'stopped'
        else if (root?.status === 'failed') session.status = 'failed'
        else session.status = 'completed'
      }
      session.updatedAt = Date.now()
      await this.saveSessions()
      this.emitSession(session)
      await this.maybeCloseIdleBus(session.id)
    }

    return task
  }

  async sendFollowup(sessionId: string, taskId: string, prompt: string, wait = false): Promise<PlatformTask> {
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) throw new Error('Follow-up prompt cannot be empty.')
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session "${sessionId}" not found.`)
    const task = session.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Task "${taskId}" not found.`)
    if (task.status === 'running') throw new Error(`Task "${taskId}" is currently running.`)

    const agent = this.agents.find((a) => a.id === task.agentId)
    if (!agent || !agent.available) {
      throw new Error(`Agent "${task.agentName}" is unavailable.`)
    }

    task.status = 'running'
    task.error = undefined
    task.endedAt = undefined
    task.model = agent.modelOverride
    task.providerId = agent.modelProviderOverride
    task.reasoningEffort = agent.reasoningEffortOverride
    if (task.output.trim()) {
      this.appendDelta(session, task, 'output', `\n\n---\n\n**Follow-up:** ${cleanPrompt}\n\n`)
    }
    this.appendLog(session, task, {
      id: newId('plog'),
      ts: Date.now(),
      kind: 'system',
      title: 'Follow-up',
      content: cleanPrompt,
    })
    session.status = 'running'
    session.updatedAt = Date.now()
    await this.ensureBus(session)
    await this.saveSessions()
    this.emitSession(session)

    const p = this.launchTaskExecution(
      session,
      task,
      agent,
      task.id === session.rootTaskId || task.depth < session.maxDepth,
      undefined,
      cleanPrompt,
    )
    this.taskPromises.set(this.taskKey(session.id, task.id), p)
    if (wait) {
      await p
    } else {
      void p.catch(() => undefined)
    }
    return structuredClone(task)
  }

  async postBoardNote(
    sessionId: string,
    noteInput: { title: string; content: string; kind?: PlatformBoardNote['kind'] },
  ): Promise<PlatformBoardNote> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session "${sessionId}" not found.`)
    const title = noteInput.title.trim()
    const content = noteInput.content.trim()
    if (!title || !content) throw new Error('Board note requires title and content.')
    const note: PlatformBoardNote = {
      id: newId('pnote'),
      ts: Date.now(),
      authorAgentId: 'user',
      authorName: 'User',
      kind: noteInput.kind ?? 'update',
      title,
      content,
    }
    session.board.push(note)
    session.updatedAt = Date.now()
    await this.saveSessions()
    this.emitSession(session)
    return note
  }

  async stopTask(sessionId: string, taskId: string): Promise<boolean> {
    const ac = this.controllers.get(this.taskKey(sessionId, taskId))
    if (!ac) return false
    ac.abort()
    return true
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    let stoppedAny = false
    for (const t of session.tasks) {
      const ac = this.controllers.get(this.taskKey(sessionId, t.id))
      if (ac) {
        ac.abort()
        stoppedAny = true
      }
    }
    session.status = 'stopped'
    await this.saveSessions()
    this.emitSession(session)
    const bus = this.buses.get(sessionId)
    if (bus) {
      this.buses.delete(sessionId)
      await bus.close()
    }
    return stoppedAny
  }

  stopAll(): number {
    let count = 0
    for (const ac of this.controllers.values()) {
      ac.abort()
      count++
    }
    return count
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    if (!this.sessions.has(sessionId)) return false
    await this.stopSession(sessionId)
    this.sessions.delete(sessionId)
    this.sessionOrder = this.sessionOrder.filter((id) => id !== sessionId)
    await this.saveSessions()
    this.emitEvent({ type: 'sessions_list', sessions: this.listSessions() })
    return true
  }

  async diffTask(sessionId: string, taskId: string): Promise<PlatformTaskDiffResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session "${sessionId}" not found.`)
    const task = session.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Task "${taskId}" not found.`)
    const cwd = task.worktreePath || task.cwd
    const items = await getGitChanges(cwd, task.worktreeBaseBranch)
    return {
      taskId: task.id,
      cwd,
      isWorktree: Boolean(task.worktreePath && task.worktreeBranch),
      ...(task.worktreeBranch ? { branch: task.worktreeBranch } : {}),
      ...(task.worktreeBaseBranch ? { baseBranch: task.worktreeBaseBranch } : {}),
      items,
    }
  }

  async mergeWorktree(
    sessionId: string,
    taskId: string,
    opts?: { commitMessage?: string; cleanupWorktree?: boolean },
  ): Promise<WorktreeMergeResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session "${sessionId}" not found.`)
    const task = session.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Task "${taskId}" not found.`)
    if (task.status === 'running') throw new Error('Stop or wait for the task to finish before merging its worktree.')
    if (!task.worktreePath || !task.worktreeBranch) {
      throw new Error('This task is not running in an isolated Git worktree.')
    }
    const baseWorkspace = task.worktreeBaseWorkspace ?? session.workspace
    const res = await mergeWorktreeToBase({
      baseWorkspace,
      worktreePath: task.worktreePath,
      branch: task.worktreeBranch,
      baseBranch: task.worktreeBaseBranch,
      commitMessage: opts?.commitMessage,
      cleanupWorktree: opts?.cleanupWorktree,
    })
    if (res.cleanedUp) {
      task.worktreePath = undefined
      task.worktreeBranch = undefined
      task.worktreeBaseBranch = undefined
      task.worktreeBaseWorkspace = undefined
      task.cwd = baseWorkspace
    }
    session.updatedAt = Date.now()
    await this.saveSessions()
    this.emitSession(session)
    return res
  }

  async discardWorktree(sessionId: string, taskId: string): Promise<PlatformTask | null> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session "${sessionId}" not found.`)
    const task = session.tasks.find((t) => t.id === taskId)
    if (!task) return null
    if (task.status === 'running') throw new Error('Stop the task before discarding its worktree.')
    if (task.worktreePath) {
      await removeGitWorktree(
        task.worktreeBaseWorkspace ?? session.workspace,
        task.worktreePath,
        task.worktreeBranch,
        true,
      )
      task.worktreePath = undefined
      task.worktreeBranch = undefined
      task.worktreeBaseBranch = undefined
      task.worktreeBaseWorkspace = undefined
      task.cwd = session.workspace
      session.updatedAt = Date.now()
      await this.saveSessions()
      this.emitSession(session)
    }
    return structuredClone(task)
  }

  shutdown(): void {
    this.stopAll()
    for (const [id, bus] of this.buses) {
      this.buses.delete(id)
      void bus.close()
    }
  }
}
