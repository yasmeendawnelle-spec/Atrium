// Headless Node.js runtime wiring Atrium's shared/core engine for cross-platform CLI execution.
import { join, resolve } from 'node:path'
import { RelayPulseAccountManager } from '../core/account.ts'
import { AgentLoop } from '../core/agent.ts'
import { ChatStore } from '../core/chats.ts'
import { WorktreeFleetManager } from '../core/fleet.ts'
import { KnowledgeBaseManager } from '../core/knowledge.ts'
import { McpManager } from '../core/mcp/manager.ts'
import { MemoryStore } from '../core/memory.ts'
import { configureNetwork } from '../core/net.ts'
import { PluginManager } from '../core/plugins.ts'
import { PreviewServerManager } from '../core/preview.ts'
import { orchestratorDirective } from '../core/orchestrator.ts'
import { systemPrompt, ultracodeDirective } from '../core/prompt.ts'
import { bindSecrets } from '../core/secrets.ts'
import { SettingsStore } from '../core/settings.ts'
import { TerminalManager } from '../core/terminal.ts'
import { CheckpointStore } from '../core/tools/changes.ts'
import { invalidateWorkspaceFilesCache } from '../core/tools/files.ts'
import { createGitWorktree, getGitChanges, getGitRepoStatus } from '../core/tools/git.ts'
import { SkillsManager } from '../core/tools/skills.ts'
import { newId } from '../core/store.ts'
import { isLocalProviderUrl } from '../shared/orchestrator.ts'
import type {
  AgentEvent,
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  Conversation,
  FileChangeEntry,
  McpServerStatus,
  ProviderConfig,
  ReasoningEffort,
  SkillInfo,
  WorkScene,
} from '../shared/types.ts'
import { normalizeAgentMode } from '../shared/types.ts'
import { CliSecretStore, createCliHostCall, openExternalUrl, resolveCliHome } from './secrets.ts'

export interface CliRuntimeOptions {
  homeDir?: string
  workspace?: string
  requireAccount?: boolean
  unattended?: boolean
  autoApprove?: boolean
  systemPromptOverride?: string
  appendSystemPrompt?: string
  maxRounds?: number
  noPersistence?: boolean
  connectMcp?: boolean
  /**
   * Load MCP configs but wait for `startMcp()` before spawning servers, so the interactive CLI can
   * draw its first screen before several child processes compete for the CPU.
   */
  deferMcpConnect?: boolean
  onAgentEvent?: (ev: AgentEvent) => void
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>
}

export interface OpenChatOptions {
  resume?: string | true
  continueWorkspace?: boolean
  forkSession?: boolean
  name?: string
  worktree?: string | true
}

export interface TurnOutcome {
  reason: 'done' | 'aborted' | 'error' | 'max_rounds' | 'truncated'
  errorMessage?: string
}

export class CliRuntime {
  readonly homeDir: string
  readonly dataDir: string
  workspace: string | undefined
  readonly secrets: CliSecretStore
  readonly settings: SettingsStore
  readonly chats: ChatStore
  readonly checkpoints: CheckpointStore
  readonly mcp: McpManager
  readonly account: RelayPulseAccountManager
  readonly terminal: TerminalManager
  readonly memory: MemoryStore
  readonly knowledge: KnowledgeBaseManager
  readonly plugins: PluginManager
  readonly skills: SkillsManager
  readonly previews: PreviewServerManager
  readonly agent: AgentLoop
  readonly fleet: WorktreeFleetManager

  private requireAccountFlag: boolean
  private autoApproveFlag: boolean
  private noPersistenceFlag: boolean
  private connectMcpFlag: boolean
  private deferMcpFlag: boolean
  private eventListeners = new Set<(ev: AgentEvent) => void>()
  private approvalHandler: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | undefined
  private initialized = false
  private disposed = false

  constructor(opts: CliRuntimeOptions = {}) {
    this.homeDir = opts.homeDir ? resolve(opts.homeDir) : resolveCliHome()
    this.dataDir = join(this.homeDir, 'data')
    this.workspace = opts.workspace ? resolve(opts.workspace) : process.cwd()
    this.requireAccountFlag = opts.requireAccount !== false
    this.autoApproveFlag = Boolean(opts.autoApprove)
    this.noPersistenceFlag = Boolean(opts.noPersistence)
    this.connectMcpFlag = opts.connectMcp !== false
    this.deferMcpFlag = Boolean(opts.deferMcpConnect)
    this.approvalHandler = opts.onApproval
    if (opts.onAgentEvent) this.eventListeners.add(opts.onAgentEvent)

    this.secrets = new CliSecretStore(this.homeDir)
    const hostCall = createCliHostCall(this.secrets)
    bindSecrets(hostCall)

    this.settings = new SettingsStore(this.homeDir)
    this.chats = new ChatStore(this.dataDir)
    this.checkpoints = new CheckpointStore(this.dataDir)
    this.mcp = new McpManager(
      this.homeDir,
      (_status: McpServerStatus) => undefined,
      (url) => openExternalUrl(url),
    )
    this.account = new RelayPulseAccountManager({
      dir: this.homeDir,
      settings: this.settings,
      openExternal: (url) => openExternalUrl(url),
      onChange: () => undefined,
    })
    this.terminal = new TerminalManager({
      emit: () => undefined,
      getDefaultWorkspace: () => this.workspace ?? this.settings.get().workspace,
      dataDir: this.dataDir,
    })
    this.memory = new MemoryStore(this.homeDir)
    this.knowledge = new KnowledgeBaseManager(this.dataDir)
    this.plugins = new PluginManager({
      dir: this.homeDir,
      homeDir: this.homeDir,
      mcp: this.mcp,
      getDisabledSkills: () => this.settings.get().disabledSkills ?? [],
      setDisabledSkills: (disabledSkills) => {
        void this.settings.update({ disabledSkills })
      },
    })
    this.skills = new SkillsManager({
      appDir: this.homeDir,
      getDisabled: () => this.settings.get().disabledSkills ?? [],
      setDisabled: (disabledSkills) => {
        void this.settings.update({ disabledSkills })
      },
      getPluginSources: () => this.plugins.activeSkillSources(),
    })

    const customSystemPrompt: typeof systemPrompt = (ws, notes, spOpts) => {
      if (opts.systemPromptOverride?.trim()) {
        const chunks = [opts.systemPromptOverride.trim()]
        // Keep Orchestrator & Ultracode workflow rules even when the user replaces the base prompt.
        if (spOpts?.orchestrator) chunks.push(orchestratorDirective({ ...spOpts.orchestrator, ultracode: spOpts.ultracode }))
        if (spOpts?.ultracode) chunks.push(ultracodeDirective(normalizeAgentMode(spOpts.mode, 'auto')))
        return chunks.join('\n\n')
      }
      const base = systemPrompt(ws, notes, spOpts)
      if (opts.appendSystemPrompt?.trim()) return `${base}\n\n${opts.appendSystemPrompt.trim()}`
      return base
    }

    this.previews = new PreviewServerManager()

    this.agent = new AgentLoop({
      settings: this.settings,
      mcp: this.mcp,
      dataDir: this.dataDir,
      checkpoints: this.checkpoints,
      skills: this.skills,
      plugins: this.plugins,
      terminal: this.terminal,
      memory: this.memory,
      knowledge: this.knowledge,
      preview: this.previews,
      unattended: Boolean(opts.unattended) && !this.autoApproveFlag,
      ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
      onBeforeModelCall: async (provider, model) => {
        if (provider.managedBy === 'relaypulse') {
          await this.account.ensureKeyGroupForModel(model).catch(() => undefined)
        }
      },
      emit: (ev) => this.handleAgentEvent(ev),
      save: async (conversation) => {
        if (!this.noPersistenceFlag) {
          await this.chats.save(conversation)
        }
      },
      enableAutoTitle: !this.noPersistenceFlag,
      onAutoTitle: async (conversationId, title) => {
        if (!this.noPersistenceFlag) {
          await this.chats.setAutoTitle(conversationId, title)
        }
      },
      systemPrompt: customSystemPrompt,
    })

    this.fleet = new WorktreeFleetManager({
      chats: this.chats,
      agent: this.agent,
      settings: this.settings,
      checkpoints: this.checkpoints,
      previews: this.previews,
      dataDir: this.dataDir,
      onChatsChanged: () => undefined,
      emitAgent: (ev) => this.handleAgentEvent(ev),
      beforeSend: async () => {
        this.assertReady()
        const active = this.settings.activeProvider()
        if (active?.managedBy === 'relaypulse') {
          await this.account.ensureKeyGroupForModel(active.model).catch(() => undefined)
        }
      },
    })
  }

  private handleAgentEvent(ev: AgentEvent): void {
    if (ev.type === 'message_saved' && ev.message.role === 'assistant' && ev.message.usage) {
      const provider = ev.message.providerId
        ? this.settings.getProvider(ev.message.providerId)
        : this.settings.activeProvider()
      const billedModel = ev.message.model ?? provider?.model
      if (provider?.managedBy === 'relaypulse' && billedModel) {
        void this.account.recordSubscriptionUsage(billedModel, ev.message.usage).catch(() => undefined)
      }
    }

    if (ev.type === 'approval') {
      if (this.autoApproveFlag) {
        this.agent.approve(ev.request.approvalId, 'allow')
      } else if (this.approvalHandler) {
        void this.approvalHandler(ev.request)
          .then((decision) => this.agent.approve(ev.request.approvalId, decision))
          .catch(() => this.agent.approve(ev.request.approvalId, 'deny'))
      } else {
        this.agent.approve(ev.request.approvalId, 'deny')
      }
      return
    }

    for (const listener of this.eventListeners) {
      listener(ev)
    }
  }

  onEvent(listener: (ev: AgentEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  setApprovalHandler(handler: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | undefined): void {
    this.approvalHandler = handler
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApproveFlag = enabled
  }

  async init(): Promise<void> {
    if (this.initialized) return
    const hostCall = createCliHostCall(this.secrets)
    bindSecrets(hostCall)

    await this.secrets.load()
    await this.settings.load()
    const cfg = this.settings.get()
    configureNetwork({
      mode: cfg.proxyMode,
      url: cfg.proxyUrl,
      resolveSystem: (u) => hostCall('net.resolveProxy', u),
    })

    await Promise.all([
      this.chats.load(),
      this.account.load(),
      this.plugins.load(),
      this.memory.load(),
      this.mcp.load({ connect: this.connectMcpFlag && !this.deferMcpFlag }),
    ])
    this.initialized = true
  }

  /** Spawns the enabled MCP servers held back by `deferMcpConnect`. Safe to call more than once. */
  startMcp(): void {
    if (this.connectMcpFlag && !this.disposed) this.mcp.connectEnabled()
  }

  async applyOverrides(opts: {
    provider?: string
    model?: string
    mode?: AgentMode
    scene?: WorkScene
    effort?: ReasoningEffort
    ultracode?: boolean
    orchestrator?: boolean
    executorModel?: string
    workspace?: string
  }): Promise<void> {
    if (opts.workspace) {
      this.workspace = resolve(opts.workspace)
    }
    const patch: {
      agentMode?: AgentMode
      workScene?: WorkScene
      reasoningEffort?: ReasoningEffort
      ultracode?: boolean
      orchestratorEnabled?: boolean
      workspace?: string
    } = {}
    if (opts.mode) patch.agentMode = opts.mode
    if (opts.scene) patch.workScene = opts.scene
    if (opts.effort) patch.reasoningEffort = opts.effort
    if (opts.ultracode !== undefined) patch.ultracode = opts.ultracode
    if (opts.orchestrator !== undefined) patch.orchestratorEnabled = opts.orchestrator
    else if (opts.executorModel !== undefined) patch.orchestratorEnabled = true
    if (opts.workspace) patch.workspace = this.workspace
    if (Object.keys(patch).length > 0) {
      await this.settings.update(patch)
    }
    if (opts.provider) {
      const target = this.findProvider(opts.provider)
      if (!target) {
        throw new Error(`Provider "${opts.provider}" not found. Run "atrium models" to inspect configured providers.`)
      }
      await this.settings.update({ activeProviderId: target.id })
    }
    if (opts.model) {
      await this.selectModel(opts.model, opts.provider)
    }
    if (opts.executorModel !== undefined) {
      await this.selectExecutorModel(opts.executorModel)
    }
  }

  findProvider(query: string): ProviderConfig | undefined {
    const clean = query.trim().toLowerCase()
    if (!clean) return undefined
    const list = this.settings.listProviders()
    return (
      list.find((p) => p.id.toLowerCase() === clean) ||
      list.find((p) => p.name.toLowerCase() === clean) ||
      list.find(
        (p) =>
          (p.managedBy === 'relaypulse' && (clean === 'atrium cloud' || clean === 'atrium' || clean === 'cloud')) ||
          p.name.toLowerCase().includes(clean),
      )
    )
  }

  resolveModelMatch(queryOrId: string, preferredProvider?: string): { provider: ProviderConfig; model: string } {
    const clean = queryOrId.trim()
    if (!clean) throw new Error('Model id cannot be empty.')
    const providers = this.settings.listProviders()
    if (providers.length === 0) {
      throw new Error('No model providers configured. Run "atrium login" first.')
    }

    const active = (preferredProvider ? this.findProvider(preferredProvider) : undefined) ?? this.settings.activeProvider()
    const orderedProviders = active ? [active, ...providers.filter((p) => p.id !== active.id)] : providers

    for (const p of orderedProviders) {
      const list = p.models?.length ? p.models : [p.model]
      const exact = list.find((m) => m.toLowerCase() === clean.toLowerCase())
      if (exact) return { provider: p, model: exact }
    }

    const lower = clean.toLowerCase()
    for (const p of orderedProviders) {
      const list = p.models?.length ? p.models : [p.model]
      const partial = list.find((m) => m.toLowerCase().includes(lower))
      if (partial) return { provider: p, model: partial }
    }

    const fallbackProvider = active ?? providers[0]!
    return { provider: fallbackProvider, model: clean }
  }

  async selectExecutorModel(
    queryOrAuto: string,
  ): Promise<{ mode: 'auto' } | { mode: 'pinned'; provider: ProviderConfig; model: string }> {
    const clean = queryOrAuto.trim()
    if (!clean || clean.toLowerCase() === 'auto') {
      await this.settings.update({
        orchestratorExecutorProviderId: '',
        orchestratorExecutorModel: '',
      })
      return { mode: 'auto' }
    }
    const usable = this.settings
      .listProviders()
      .filter((p) => p.hasKey || isLocalProviderUrl(p.baseUrl) || p.id === this.settings.activeProvider()?.id)
    const lower = clean.toLowerCase()
    let matched: { provider: ProviderConfig; model: string } | null = null
    for (const p of usable) {
      const list = p.models?.length ? p.models : [p.model]
      const exact = list.find((m) => m.toLowerCase() === lower)
      if (exact) {
        matched = { provider: p, model: exact }
        break
      }
    }
    if (!matched) {
      for (const p of usable) {
        const list = p.models?.length ? p.models : [p.model]
        const partial = list.find((m) => m.toLowerCase().includes(lower))
        if (partial) {
          matched = { provider: p, model: partial }
          break
        }
      }
    }
    const target = matched ?? this.resolveModelMatch(clean)
    await this.settings.update({
      orchestratorExecutorProviderId: target.provider.id,
      orchestratorExecutorModel: target.model,
    })
    return { mode: 'pinned', provider: target.provider, model: target.model }
  }

  async selectModel(queryOrId: string, preferredProvider?: string): Promise<{ provider: ProviderConfig; model: string }> {
    const match = this.resolveModelMatch(queryOrId, preferredProvider)
    await this.settings.selectProviderModel(match.provider.id, match.model)
    if (match.provider.managedBy === 'relaypulse') {
      await this.account.ensureKeyGroupForModel(match.model).catch(() => undefined)
    }
    return { provider: this.settings.getProvider(match.provider.id) ?? match.provider, model: match.model }
  }

  assertReady(): void {
    const provider = this.settings.activeProvider()
    if (!provider) {
      if (this.requireAccountFlag && !this.account.isConnected()) {
        throw new Error('Not signed in to an Atrium account yet. Run "atrium login" first (or add a BYOK provider via "/provider add").')
      }
      throw new Error('No model provider available. Run "atrium login" or "/provider add".')
    }
    if (provider.managedBy === 'relaypulse' && this.requireAccountFlag && !this.account.isConnected()) {
      throw new Error('Atrium account session is disconnected. Run "atrium login" to sign in again.')
    }
    const isLocal = /^https?:\/\/(localhost|127\.)/i.test(provider.baseUrl)
    if (!provider.hasKey && !isLocal) {
      throw new Error(`Provider "${provider.name}" has no API key configured. Run "atrium login" or check your provider setup.`)
    }
  }

  async openOrCreateChat(rawOpts?: string | true | OpenChatOptions): Promise<Conversation> {
    const opts: OpenChatOptions =
      typeof rawOpts === 'object' && rawOpts !== null
        ? rawOpts
        : rawOpts !== undefined
          ? { resume: rawOpts }
          : {}

    let conversation: Conversation | null = null

    if (typeof opts.resume === 'string') {
      const existing = await this.chats.get(opts.resume)
      if (!existing) {
        const prefixMatch = this.chats.list().find((m) => m.id.startsWith(opts.resume as string))
        conversation = prefixMatch ? await this.chats.get(prefixMatch.id) : null
      } else {
        conversation = existing
      }
      if (!conversation) throw new Error(`Conversation "${opts.resume}" not found.`)
    } else if (opts.resume === true || opts.continueWorkspace) {
      const all = this.chats.list()
      const targetWs = this.workspace
      const norm = (p?: string) => (p ? resolve(p).replace(/[\\/]+$/, '').toLowerCase() : '')
      const matching =
        opts.continueWorkspace && targetWs
          ? all.find((m) => (process.platform === 'win32' ? norm(m.workspace) === norm(targetWs) : m.workspace === targetWs))
          : undefined
      const picked = matching ?? all[0]
      if (picked) {
        conversation = await this.chats.get(picked.id)
      }
    }

    if (conversation && opts.forkSession && !this.noPersistenceFlag) {
      conversation = await this.chats.fork(conversation.id, undefined, opts.name || 'fork')
    } else if (conversation && opts.forkSession && this.noPersistenceFlag) {
      conversation = {
        ...structuredClone(conversation),
        id: newId('chat'),
        title: `${conversation.title || 'Chat'} (${opts.name || 'fork'})`,
      }
    }

    if (!conversation) {
      let worktreeMeta:
        | { worktreeBaseWorkspace: string; worktreeBranch: string; worktreeBaseBranch?: string }
        | undefined
      if (opts.worktree && this.workspace) {
        const chatId = newId('chat')
        const wt = await createGitWorktree(
          this.workspace,
          this.dataDir,
          chatId,
          typeof opts.worktree === 'string' ? opts.worktree : undefined,
          { copyEnv: this.settings.get().copyEnvOnWorktree !== false },
        )
        this.workspace = wt.worktreePath
        worktreeMeta = {
          worktreeBaseWorkspace: wt.baseWorkspace,
          worktreeBranch: wt.branch,
          ...(wt.baseBranch ? { worktreeBaseBranch: wt.baseBranch } : {}),
        }
      }

      if (this.noPersistenceFlag) {
        const now = Date.now()
        conversation = {
          id: newId('chat'),
          title: opts.name?.trim() || 'Ephemeral CLI chat',
          createdAt: now,
          updatedAt: now,
          workspace: this.workspace,
          providerId: this.settings.activeProvider()?.id,
          ...worktreeMeta,
          messages: [],
        }
      } else {
        conversation = await this.chats.create({
          workspace: this.workspace,
          providerId: this.settings.activeProvider()?.id,
          ...worktreeMeta,
        })
      }
    }

    if (opts.name?.trim() && !opts.forkSession) {
      if (this.noPersistenceFlag) {
        conversation.title = opts.name.trim()
        conversation.titleSource = 'user'
      } else {
        const meta = await this.chats.rename(conversation.id, opts.name.trim())
        conversation = { ...conversation, title: meta.title, titleSource: meta.titleSource, updatedAt: meta.updatedAt }
      }
    }

    return conversation
  }

  async runTurn(conversation: Conversation, prompt: string): Promise<TurnOutcome> {
    const active = this.settings.activeProvider()
    if (active?.managedBy === 'relaypulse') {
      await this.account.ensureKeyGroupForModel(active.model).catch(() => undefined)
    }

    let outcome: TurnOutcome = { reason: 'done' }
    const off = this.onEvent((ev) => {
      if (ev.type === 'error' && ev.conversationId === conversation.id) {
        outcome = { reason: 'error', errorMessage: ev.message }
      } else if (ev.type === 'turn_end' && ev.conversationId === conversation.id) {
        outcome = {
          reason: ev.reason,
          ...(ev.reason === 'error' && outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        }
      }
    })

    try {
      await this.agent.run(conversation, prompt)
      return outcome
    } finally {
      off()
    }
  }

  async undoLastTurn(conversationId: string): Promise<{ conversation: Conversation; revertedFiles: string[] }> {
    if (this.agent.busy(conversationId)) {
      throw new Error('Stop the active response before undoing.')
    }
    const conversation = await this.chats.get(conversationId)
    if (!conversation) throw new Error(`No conversation found with id "${conversationId}".`)

    let lastUserIdx = -1
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const m = conversation.messages[i]
      if (m?.role === 'user' && !m.isSummary) {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) throw new Error('Nothing to undo in this conversation yet.')

    const ws = conversation.workspace ?? this.workspace
    const revertedFiles = ws ? await this.checkpoints.rewindToTurn(conversationId, ws, lastUserIdx) : []
    if (ws && revertedFiles.length > 0) invalidateWorkspaceFilesCache(ws)
    conversation.messages = conversation.messages.slice(0, lastUserIdx)
    await this.chats.save(conversation)
    return { conversation, revertedFiles }
  }

  async listChanges(conversationId?: string): Promise<FileChangeEntry[]> {
    const conv = conversationId ? await this.chats.get(conversationId) : null
    const ws = conv?.workspace ?? this.workspace
    if (!ws) return []
    const gitStatus = await getGitRepoStatus(ws)
    const [gitItems, cpItems] = await Promise.all([
      gitStatus.isRepo ? getGitChanges(ws, conv?.worktreeBaseBranch) : Promise.resolve([]),
      conversationId ? this.checkpoints.entries(conversationId, ws) : Promise.resolve([]),
    ])
    const merged = new Map(gitItems.map((i) => [i.path, i]))
    for (const cp of cpItems) merged.set(cp.path, cp)
    return [...merged.values()]
  }

  async listSkills(): Promise<SkillInfo[]> {
    return this.skills.list(this.workspace)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.agent.stopAll()
    await this.previews.stopAll().catch(() => undefined)
    this.previews.shutdown()
    this.terminal.shutdown()
    await this.mcp.shutdown().catch(() => undefined)
  }
}

export async function createCliRuntime(opts: CliRuntimeOptions = {}): Promise<CliRuntime> {
  const runtime = new CliRuntime(opts)
  await runtime.init()
  return runtime
}
