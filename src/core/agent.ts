// The agent loop. One turn: send the conversation, stream the reply, run the
// tools the model asked for (asking the user first when needed), and repeat
// until the model stops calling tools or the round limit is hit.
import {
  normalizeAgentMode,
  resolveEffectiveContextLimit,
  type AgentEvent,
  type AgentMode,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRequest,
  type Conversation,
  type DocumentAttachment,
  type ImageAttachment,
  type Message,
  type ProviderConfig,
  type QueuedMessage,
  type ToolCall,
  type WorkScene,
} from '../shared/types.ts'
import { chat } from './providers/index.ts'
import { endpointFor, type ConnectionTest } from './providers/index.ts'
import {
  formatUserMessagePrompt,
  ProviderError,
  retainRecentToolImages,
  type ChatResult,
  type ProviderEndpoint,
  type ToolDef,
} from './providers/types.ts'
import { CheckpointStore, snapshotExistingFile } from './tools/changes.ts'
import { FILE_TOOLS, loadProjectInstructions, prepareEdit, prepareWriteDiff, runReadTool, writeApproved } from './tools/files.ts'
import { applyPreparedPatch, preparePatch } from './tools/patch.ts'
import { SHELL_TOOL, runCommand } from './tools/shell.ts'
import { LOAD_SKILL_TOOL, type SkillsManager } from './tools/skills.ts'
import {
  buildSubagentProgressText,
  buildSubagentPrompt,
  formatSubagentReport,
  formatSubagentStep,
  parseSubagentInput,
  RUN_SUBAGENT_TOOL,
} from './tools/subagent.ts'
import { WEB_TOOLS, runWebTool } from './tools/web.ts'
import { BG_TOOLS, runReadBackground, runStartBackground, runStopBackground } from './tools/terminal_tools.ts'
import { MEMORY_TOOLS, runMemoryTool } from './tools/memory_tools.ts'
import { KNOWLEDGE_TOOLS, runKnowledgeTool } from './tools/knowledge_tools.ts'
import { BROWSER_TOOLS, runBrowserTool, type BrowserHostBridge } from './tools/browser_tools.ts'
import { COMPUTER_TOOLS, describeComputerAction, runComputerTool, type ComputerHostBridge } from './tools/computer_tools.ts'
import type { KnowledgeBaseManager } from './knowledge.ts'
import type { McpManager } from './mcp/manager.ts'
import type { MemoryStore } from './memory.ts'
import type { PluginManager } from './plugins.ts'
import type { SettingsStore } from './settings.ts'
import type { TerminalManager } from './terminal.ts'
import { HookEngine, loadWorkspaceHookSource, type HookRunEventNotice, type PluginHookSource } from './hooks.ts'
import {
  evaluateCommandPolicy,
  formatPolicyPromptNote,
  inspectWorkspacePolicy,
  resolveEffectiveSandbox,
} from './policy.ts'
import type { PreviewServerManager } from './preview.ts'
import { PREVIEW_TOOLS, runPreviewTool } from './tools/preview_tools.ts'

const MAX_ROUNDS = 40
const ULTRACODE_MIN_ROUNDS = 60
const OUTPUT_LIMIT = 30_000
const READ_ONLY_FILE_TOOLS = new Set(['list_dir', 'read_file', 'search'])
const READ_ONLY_WEB_TOOLS = new Set(['web_search', 'web_fetch'])

const MCP_LIST_RESOURCES_TOOL: ToolDef = {
  name: 'mcp_list_resources',
  description: 'List readable resources exposed by connected MCP servers (documents, schemas, logs, etc.).',
  inputSchema: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Optional server name filter.' },
    },
  },
}

const MCP_READ_RESOURCE_TOOL: ToolDef = {
  name: 'mcp_read_resource',
  description: 'Read the contents of an MCP resource by server_id and uri (returned by mcp_list_resources).',
  inputSchema: {
    type: 'object',
    properties: {
      server_id: { type: 'string', description: 'MCP server id returned by mcp_list_resources.' },
      uri: { type: 'string', description: 'Resource URI to read.' },
    },
    required: ['server_id', 'uri'],
  },
}

const SHELL_CHAIN_RE = /[;&|<>`\n\r]|\$\(/

export function buildAlwaysAllowRule(
  call: ToolCall,
  kind: ApprovalKind,
  serverId?: string,
): { rule: string; label: string } {
  if (call.name === 'run_command' || call.name === 'start_background' || call.name === 'preview_start') {
    const raw = String(call.input.command ?? '').replace(/\s+/g, ' ').trim()
    if (raw && !SHELL_CHAIN_RE.test(raw)) {
      const tokens = raw.split(' ')
      const multiTokenRoot = new Set(['npm', 'pnpm', 'yarn', 'bun', 'git', 'npx', 'uv', 'cargo', 'docker'])
      const prefix = multiTokenRoot.has(tokens[0] ?? '') && tokens[1] ? `${tokens[0]} ${tokens[1]}` : (tokens[0] ?? '')
      if (prefix && prefix.length <= 48) {
        return { rule: `cmd-prefix:${prefix}`, label: `${prefix} *` }
      }
    }
    return { rule: `cmd-exact:${raw}`, label: raw.slice(0, 48) || call.name }
  }
  const key = call.name.startsWith('browser_')
    ? 'browser'
    : call.name.startsWith('desktop_')
      ? 'computer'
      : kind === 'mcp' && serverId
        ? `mcp:${serverId}`
        : kind
  const label = key === 'computer' ? 'Computer Use' : key
  return { rule: `tool:${key}`, label }
}

export function matchesAllowedRules(
  call: ToolCall,
  kind: ApprovalKind,
  serverId: string | undefined,
  rules: string[],
): boolean {
  if (rules.length === 0) return false
  if (call.name === 'run_command' || call.name === 'start_background' || call.name === 'preview_start') {
    const raw = String(call.input.command ?? '').replace(/\s+/g, ' ').trim()
    if (!raw) return false
    for (const rule of rules) {
      if (rule === `cmd-exact:${raw}`) return true
      if (rule.startsWith('cmd-prefix:') && !SHELL_CHAIN_RE.test(raw)) {
        const prefix = rule.slice('cmd-prefix:'.length)
        if (raw === prefix || raw.startsWith(`${prefix} `)) return true
      }
    }
    return false
  }
  const key = call.name.startsWith('browser_')
    ? 'browser'
    : call.name.startsWith('desktop_')
      ? 'computer'
      : kind === 'mcp' && serverId
        ? `mcp:${serverId}`
        : kind
  return rules.includes(`tool:${key}`)
}

function truncationReason(result: ChatResult): 'token_limit' | 'stream_interrupted' | null {
  if (result.incompleteStream || result.stopReason === 'incomplete_stream') return 'stream_interrupted'
  if (result.stopReason === 'length' || result.stopReason === 'max_tokens' || result.stopReason === 'incomplete') {
    return 'token_limit'
  }
  return null
}

const DANGEROUS_SHELL_RE =
  /(?:^|[;&|(\s])(?:rm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)|del\s+\/[sfq]|rmdir\s+\/s|rd\s+\/s|remove-item\b[^\n]*-recurse|format\s+[a-z]:|mkfs(?:\.[a-z0-9]+)?|dd\s+if=|diskpart|shutdown|reboot|halt|sudo\s+|chmod\s+(?:-r\s+)?777|chown\s+-r|git\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push\b[^\n]*(?:\s(?:-f\b|--force(?:-with-lease)?\b))|branch\s+-D\b)|(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|pwsh|powershell)|(?:powershell|pwsh)\b[^\n]*-encodedcommand|\biex\b|invoke-expression)/i

export function isDangerousShellCommand(command: string): boolean {
  return DANGEROUS_SHELL_RE.test(command.trim())
}

export function estimateMessagesTokens(system: string, tools: ToolDef[], messages: Message[]): number {
  let chars = system.length + JSON.stringify(tools).length
  let images = 0
  for (const m of retainRecentToolImages(messages)) {
    if (m.role === 'user') {
      chars += formatUserMessagePrompt(m).length + 16
      images += m.images?.length ?? 0
    } else if (m.role === 'assistant') {
      chars += m.text.length + (m.reasoning?.length ?? 0) + JSON.stringify(m.toolCalls).length + 24
    } else {
      chars += m.output.length + m.name.length + 16
      images += m.images?.length ?? 0
    }
  }
  return Math.ceil(chars / 3.5) + images * 1600
}

export function isContextOverflowError(err: unknown): boolean {
  const status = err instanceof ProviderError ? err.status : undefined
  const msg = err instanceof Error ? err.message : String(err)
  if (status && status !== 400 && status !== 413 && status !== 422) return false
  return /context[_ ]?length|maximum context|too many tokens|prompt is too long|exceeds.*(?:context|limit)|input length.*exceeds|reduce the length/i.test(
    msg,
  )
}

export interface ApprovalAnswer {
  decision: ApprovalDecision
}

interface PendingApproval {
  request: ApprovalRequest
  resolve: (answer: ApprovalAnswer) => void
}

export interface LoopDeps {
  settings: SettingsStore
  mcp: McpManager
  dataDir?: string
  checkpoints?: CheckpointStore
  skills?: SkillsManager
  plugins?: PluginManager
  terminal?: TerminalManager
  memory?: MemoryStore
  knowledge?: KnowledgeBaseManager
  browser?: BrowserHostBridge
  computer?: ComputerHostBridge
  preview?: PreviewServerManager
  /** When true (e.g. background scheduled tasks), any action requiring interactive approval is safely declined instead of hanging. */
  unattended?: boolean
  compactThresholdTokens?: number
  emit: (event: AgentEvent) => void
  save: (conversation: Conversation) => Promise<void>
  systemPrompt: (
    workspace: string | undefined,
    projectNotes?: string,
    opts?: {
      mode?: AgentMode
      workScene?: WorkScene
      skillsSummary?: string
      pluginRules?: string
      memoryPrompt?: string
      knowledgePrompt?: string
      computerUse?: boolean
      browserComputerUse?: boolean
      desktopControl?: boolean
      ultracode?: boolean
    },
  ) => string
  allowSubagents?: boolean
  forcedMode?: AgentMode
  checkpointConversationId?: string
  checkpointTurnIndex?: number
  maxRounds?: number
  enableAutoTitle?: boolean
  onAutoTitle?: (conversationId: string, title: string) => Promise<void>
  sharedApprovals?: Map<string, PendingApproval>
  sharedSessionAllows?: Map<string, Set<string>>
}

export class AgentLoop {
  private running = new Map<string, AbortController>()
  private queues = new Map<string, QueuedMessage[]>()
  private steerPending = new Set<string>()
  private approvals: Map<string, PendingApproval>
  /** Session-scoped approvals, isolated per workspace folder. */
  private sessionAllows: Map<string, Set<string>>
  private memoryExtractAtCount = new Map<string, number>()
  private memoryExtracting = new Set<string>()
  private readonly hookEngine = new HookEngine()
  private readonly deps: LoopDeps

  constructor(deps: LoopDeps) {
    this.deps = deps
    this.approvals = deps.sharedApprovals ?? new Map()
    this.sessionAllows = deps.sharedSessionAllows ?? new Map()
  }

  private scopeKey(workspace: string | undefined): string {
    if (!workspace) return '__global__'
    return process.platform === 'win32' ? workspace.toLowerCase() : workspace
  }

  sessionAllowsFor(workspace: string | undefined): string[] {
    return [...(this.sessionAllows.get(this.scopeKey(workspace)) ?? [])]
  }

  clearSessionAllows(workspace: string | undefined): void {
    this.sessionAllows.delete(this.scopeKey(workspace))
  }

  busy(conversationId: string): boolean {
    return this.running.has(conversationId)
  }

  runningConversationIds(): string[] {
    return [...this.running.keys()]
  }

  pendingApprovalsFor(conversationId: string): number {
    let count = 0
    for (const entry of this.approvals.values()) {
      if (entry.request.conversationId === conversationId) count++
    }
    return count
  }

  stop(conversationId: string): void {
    this.running.get(conversationId)?.abort()
  }

  stopAll(): void {
    for (const controller of this.running.values()) controller.abort()
    void this.deps.computer?.setHud({ active: false }).catch(() => undefined)
  }

  queuedFor(conversationId: string): QueuedMessage[] {
    return [...(this.queues.get(conversationId) ?? [])]
  }

  clearQueue(conversationId: string): void {
    this.steerPending.delete(conversationId)
    if (this.queues.delete(conversationId)) {
      this.deps.emit({ type: 'queue_sync', conversationId, items: [] })
    }
  }

  enqueue(
    conversation: Conversation,
    text: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
  ): QueuedMessage[] {
    const cleanText = text.trim()
    if (!cleanText && !images?.length && !documents?.length) {
      return this.queuedFor(conversation.id)
    }
    if (!this.running.has(conversation.id)) {
      void this.run(conversation, cleanText, images, documents)
      return this.queuedFor(conversation.id)
    }
    const item: QueuedMessage = {
      id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      text: cleanText,
      ...(images?.length ? { images } : {}),
      ...(documents?.length ? { documents } : {}),
      createdAt: Date.now(),
    }
    const list = [...(this.queues.get(conversation.id) ?? []), item]
    this.queues.set(conversation.id, list)
    this.deps.emit({ type: 'queue_sync', conversationId: conversation.id, items: [...list] })
    return [...list]
  }

  cancelQueued(conversationId: string, queuedId: string): QueuedMessage[] {
    const cur = this.queues.get(conversationId) ?? []
    const next = cur.filter((q) => q.id !== queuedId)
    if (next.length === 0) this.queues.delete(conversationId)
    else this.queues.set(conversationId, next)
    this.deps.emit({ type: 'queue_sync', conversationId, items: [...next] })
    return [...next]
  }

  steerQueued(conversation: Conversation, queuedId: string): void {
    const cur = [...(this.queues.get(conversation.id) ?? [])]
    const idx = cur.findIndex((q) => q.id === queuedId)
    if (idx < 0) return
    const [picked] = cur.splice(idx, 1)
    if (!picked) return
    cur.unshift(picked)
    this.queues.set(conversation.id, cur)
    this.deps.emit({ type: 'queue_sync', conversationId: conversation.id, items: [...cur] })
    this.steerPending.add(conversation.id)
    if (this.running.has(conversation.id)) {
      this.stop(conversation.id)
    } else {
      this.drainNextQueued(conversation)
    }
  }

  private drainNextQueued(conversation: Conversation): void {
    queueMicrotask(() => {
      if (this.running.has(conversation.id)) return
      const cur = this.queues.get(conversation.id)
      if (!cur || cur.length === 0) return
      const next = cur.shift()!
      if (cur.length === 0) this.queues.delete(conversation.id)
      this.deps.emit({ type: 'queue_sync', conversationId: conversation.id, items: [...(this.queues.get(conversation.id) ?? [])] })
      void this.run(conversation, next.text, next.images, next.documents)
    })
  }

  approve(approvalId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(approvalId)
    if (!pending) return
    this.approvals.delete(approvalId)
    pending.resolve({ decision })
  }

  private async executeTurnLoop(
    conversation: Conversation,
    action: { kind: 'send'; text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] } | { kind: 'regenerate' },
  ): Promise<void> {
    const controller = new AbortController()
    this.running.set(conversation.id, controller)
    const { signal } = controller
    this.deps.emit({ type: 'turn_start', conversationId: conversation.id })
    let reason: 'done' | 'aborted' | 'error' | 'max_rounds' | 'truncated' = 'error'
    try {
      reason = await this.turn(conversation, action, signal)
    } catch (err) {
      if (signal.aborted) {
        reason = 'aborted'
        await this.deps.save(conversation).catch(() => undefined)
        this.deps.emit({ type: 'turn_end', conversationId: conversation.id, reason: 'aborted' })
        return
      }
      reason = 'error'
      await this.deps.save(conversation).catch(() => undefined)
      const message = err instanceof Error ? err.message : String(err)
      this.deps.emit({ type: 'error', conversationId: conversation.id, message })
      this.deps.emit({ type: 'turn_end', conversationId: conversation.id, reason: 'error' })
    } finally {
      this.running.delete(conversation.id)
      if (this.running.size === 0) {
        void this.deps.computer?.setHud({ active: false }).catch(() => undefined)
      }
      const steered = this.steerPending.delete(conversation.id)
      if (reason === 'done' || steered) {
        this.drainNextQueued(conversation)
      }
    }
  }

  async run(
    conversation: Conversation,
    text: string,
    images?: ImageAttachment[],
    documents?: DocumentAttachment[],
  ): Promise<void> {
    if (this.running.has(conversation.id)) throw new Error('This chat is already working on something.')
    await this.executeTurnLoop(conversation, { kind: 'send', text, images, documents })
  }

  async regenerate(conversation: Conversation): Promise<void> {
    if (this.running.has(conversation.id)) throw new Error('This chat is already working on something.')
    let lastUserIdx = -1
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const m = conversation.messages[i]!
      if (m.role === 'user' && !m.isSummary) {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx < 0) throw new Error('Nothing to regenerate yet.')
    conversation.messages = conversation.messages.slice(0, lastUserIdx + 1)
    await this.deps.save(conversation)
    this.deps.emit({ type: 'conversation_sync', conversation })
    await this.executeTurnLoop(conversation, { kind: 'regenerate' })
  }

  async compact(conversation: Conversation): Promise<Conversation> {
    if (this.running.has(conversation.id)) throw new Error('Stop the current response before compacting.')
    if (conversation.messages.length < 4) return conversation
    const provider = this.deps.settings.activeProvider()
    if (!provider) throw new Error('Add a model provider first, under Connections.')
    if (!provider.hasKey) throw new Error(`"${provider.name}" has no API key yet.`)
    const apiKey = await this.deps.settings.providerKey(provider.id)
    const endpoint = endpointFor(provider, apiKey)
    return this.performCompact(conversation, provider, endpoint, new AbortController().signal, false)
  }

  private compactThreshold(model?: string): number {
    if (this.deps.compactThresholdTokens !== undefined) {
      return this.deps.compactThresholdTokens
    }
    const appSettings = this.deps.settings.get()
    const activeModel = model ?? this.deps.settings.activeProvider()?.model
    const limit = resolveEffectiveContextLimit(activeModel, appSettings.contextWindowTokens)
    return Math.max(24_000, Math.round(limit * 0.8))
  }

  private shouldAutoCompact(
    conversation: Conversation,
    system: string,
    tools: ToolDef[],
    model?: string,
  ): boolean {
    if (this.deps.settings.get().autoCompact === false) return false
    if (conversation.messages.length < 6) return false
    const threshold = this.compactThreshold(model)
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const m = conversation.messages[i]!
      if (m.role === 'assistant' && m.usage) {
        if (m.usage.inputTokens >= threshold) return true
        break
      }
    }
    return estimateMessagesTokens(system, tools, conversation.messages) >= Math.round(threshold * 1.1)
  }

  private async performCompact(
    conversation: Conversation,
    provider: ProviderConfig,
    endpoint: ProviderEndpoint,
    signal: AbortSignal,
    auto: boolean,
  ): Promise<Conversation> {
    if (conversation.messages.length < 4) return conversation
    const userTurns: number[] = []
    for (let i = 0; i < conversation.messages.length; i++) {
      const m = conversation.messages[i]!
      if (m.role === 'user' && !m.isSummary) userTurns.push(i)
    }
    let splitAt =
      userTurns.length >= 3
        ? userTurns[userTurns.length - 2]!
        : userTurns.length >= 2
          ? userTurns[userTurns.length - 1]!
          : Math.max(1, conversation.messages.length - 2)
    // Ensure tail starts on a user turn (never inside an assistant/tool pair).
    while (splitAt > 0 && conversation.messages[splitAt]?.role === 'tool') splitAt--
    if (splitAt <= 1) splitAt = Math.min(conversation.messages.length, Math.max(2, conversation.messages.length - 1))
    if (splitAt <= 0 || splitAt >= conversation.messages.length) return conversation

    const toSummarize = conversation.messages.slice(0, splitAt)
    const kept = conversation.messages.slice(splitAt)
    const transcript = formatForSummary(toSummarize)

    this.deps.emit({ type: 'compacting', conversationId: conversation.id, active: true, auto })
    try {
      const result = await chat(
        provider.protocol,
        endpoint,
        {
          model: provider.model,
          system:
            'Summarize the earlier conversation cleanly as a structured handoff note in the same language the user used. Include: 1) User goal & constraints, 2) Key files inspected or modified, 3) Decisions & tool findings, 4) Any pending next steps. Keep it concise and factual.',
          messages: [{ role: 'user', text: transcript }],
          tools: [],
          signal,
          maxTokens: 2048,
        },
        { onText: () => undefined },
      )
      const summaryText = result.text.trim()
      if (!summaryText) return conversation

      const summaryMsg: Message = {
        role: 'user',
        text: `[Compacted ${toSummarize.length} earlier messages]\n\n${summaryText}`,
        isSummary: true,
      }
      conversation.messages = [summaryMsg, ...kept]
      await this.deps.save(conversation)
      this.deps.emit({ type: 'conversation_sync', conversation })
      return conversation
    } finally {
      this.deps.emit({ type: 'compacting', conversationId: conversation.id, active: false, auto })
    }
  }

  private async turn(
    conversation: Conversation,
    action: { kind: 'send'; text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[] } | { kind: 'regenerate' },
    signal: AbortSignal,
  ): Promise<'done' | 'aborted' | 'max_rounds' | 'truncated'> {
    const provider = this.deps.settings.activeProvider()
    if (!provider) throw new Error('Add a model provider first, under Connections.')
    if (!provider.hasKey) throw new Error(`"${provider.name}" has no API key yet.`)
    const apiKey = await this.deps.settings.providerKey(provider.id)
    const endpoint = endpointFor(provider, apiKey)
    const appSettings = this.deps.settings.get()
    const workspace = conversation.workspace ?? appSettings.workspace
    if (!conversation.workspace && workspace) conversation.workspace = workspace
    conversation.providerId = provider.id
    const [rawProjectNotes, policyInspection] = await Promise.all([
      loadProjectInstructions(workspace),
      inspectWorkspacePolicy(workspace),
    ])
    const policyNote = formatPolicyPromptNote(policyInspection)
    const projectNotes = [rawProjectNotes, policyNote].filter(Boolean).join('\n\n')
    const mode: AgentMode = normalizeAgentMode(this.deps.forcedMode ?? appSettings.agentMode, 'manual')
    const workScene: WorkScene = appSettings.workScene === 'work' ? 'work' : 'code'
    const skillsSummary = this.deps.skills ? await this.deps.skills.formatAvailableSkillsPrompt(workspace) : ''
    const pluginRules = this.deps.plugins ? await this.deps.plugins.formatActiveRulesPrompt() : ''
    const memoryPrompt =
      this.deps.memory && appSettings.memoryEnabled !== false
        ? this.deps.memory.formatPromptBlock(workspace)
        : undefined
    const knowledgePrompt = this.deps.knowledge
      ? await this.deps.knowledge.formatPromptHint(workspace)
      : undefined
    const cuEnabled = appSettings.computerUseEnabled !== false && mode !== 'plan'
    const browserComputerUse = Boolean(this.deps.browser && cuEnabled)
    const desktopControl = Boolean(this.deps.computer && cuEnabled && this.isDesktopControlAllowed())
    const computerUse = browserComputerUse || desktopControl
    // Subagents run with allowSubagents=false, so Ultracode only ever drives the top-level agent.
    const ultracode = this.isUltracodeActive()
    const system = this.deps.systemPrompt(workspace, projectNotes || undefined, {
      mode,
      workScene,
      ultracode,
      skillsSummary: skillsSummary || undefined,
      pluginRules: pluginRules || undefined,
      memoryPrompt,
      knowledgePrompt,
      computerUse,
      browserComputerUse,
      desktopControl,
    })

    if (action.kind === 'send') {
      const userMessage: Message = {
        role: 'user',
        text: action.text,
        ...(action.images?.length ? { images: action.images } : {}),
        ...(action.documents?.length ? { documents: action.documents } : {}),
      }
      conversation.messages.push(userMessage)
      this.deps.emit({ type: 'message_saved', conversationId: conversation.id, message: userMessage })
      await this.deps.save(conversation)
    }

    let turnIndex = this.deps.checkpointTurnIndex ?? 0
    if (this.deps.checkpointTurnIndex === undefined) {
      for (let i = conversation.messages.length - 1; i >= 0; i--) {
        const m = conversation.messages[i]!
        if (m.role === 'user' && !m.isSummary) {
          turnIndex = i
          break
        }
      }
    }

    const tools = this.toolDefs(workspace, mode)
    const configuredRounds =
      typeof appSettings.maxAgentRounds === 'number' && Number.isFinite(appSettings.maxAgentRounds)
        ? Math.max(10, Math.min(100, Math.floor(appSettings.maxAgentRounds)))
        : MAX_ROUNDS
    // An Ultracode turn spends rounds on planning, dispatching and verifying, so it gets a higher floor.
    const maxRounds =
      this.deps.maxRounds ?? (ultracode ? Math.max(configuredRounds, ULTRACODE_MIN_ROUNDS) : configuredRounds)
    let stopHookContinuations = 0
    for (let round = 0; round < maxRounds; round++) {
      if (signal.aborted) {
        await this.deps.save(conversation)
        this.deps.emit({ type: 'turn_end', conversationId: conversation.id, reason: 'aborted' })
        return 'aborted'
      }
      let autoCompacted = false
      if (this.shouldAutoCompact(conversation, system, tools, provider.model)) {
        try {
          await this.performCompact(conversation, provider, endpoint, signal, true)
          autoCompacted = true
        } catch {
          if (signal.aborted) throw new Error('Stopped.')
        }
      }

      let partialText = ''
      let partialReasoning = ''
      const callModel = () => {
        partialText = ''
        partialReasoning = ''
        return chat(
          provider.protocol,
          endpoint,
          {
            model: provider.model,
            system,
            messages: conversation.messages,
            tools,
            signal,
            effort: appSettings.reasoningEffort ?? 'auto',
            cacheKey: conversation.id,
          },
          {
            onText: (delta) => {
              partialText += delta
              this.deps.emit({ type: 'text_delta', conversationId: conversation.id, text: delta })
            },
            onReasoning: (delta) => {
              partialReasoning += delta
              this.deps.emit({ type: 'reasoning_delta', conversationId: conversation.id, text: delta })
            },
          },
        )
      }

      let result: ChatResult
      try {
        result = await callModel()
      } catch (err) {
        if (!autoCompacted && this.deps.settings.get().autoCompact !== false && isContextOverflowError(err) && conversation.messages.length >= 4) {
          await this.performCompact(conversation, provider, endpoint, signal, true)
          result = await callModel()
        } else {
          if (partialText.trim() || partialReasoning.trim()) {
            const partialMsg: Message = {
              role: 'assistant',
              text: partialText,
              toolCalls: [],
              ...(partialReasoning ? { reasoning: partialReasoning } : {}),
              workScene,
              ...(mode === 'plan' ? { mode: 'plan' as const } : {}),
              incomplete: signal.aborted ? 'aborted' : 'error',
            }
            conversation.messages.push(partialMsg)
            this.deps.emit({ type: 'message_saved', conversationId: conversation.id, message: partialMsg })
          }
          throw err
        }
      }
      const trunc = truncationReason(result)
      if (trunc === 'stream_interrupted') {
        if (!result.text.trim() && !result.reasoning?.trim()) {
          throw new Error('The model response stream closed unexpectedly before sending a reply.')
        }
        const partial = this.toAssistantMessage({ ...result, toolCalls: [] }, mode, workScene, 'stream_interrupted')
        conversation.messages.push(partial)
        this.deps.emit({ type: 'message_saved', conversationId: conversation.id, message: partial })
        await this.deps.save(conversation)
        this.deps.emit({
          type: 'turn_end',
          conversationId: conversation.id,
          reason: 'truncated',
          truncation: 'stream_interrupted',
        })
        return 'truncated'
      }

      const terminalNoTools = !result.refusal && result.toolCalls.length === 0 && Object.keys(result.badArguments).length === 0
      const assistant = this.toAssistantMessage(result, mode, workScene, terminalNoTools && trunc ? trunc : undefined)
      conversation.messages.push(assistant)
      this.deps.emit({ type: 'message_saved', conversationId: conversation.id, message: assistant })

      if (result.refusal) {
        await this.deps.save(conversation)
        this.deps.emit({ type: 'error', conversationId: conversation.id, message: result.refusal })
        this.deps.emit({ type: 'turn_end', conversationId: conversation.id, reason: 'done' })
        return 'done'
      }
      if (terminalNoTools) {
        if (stopHookContinuations < 2 && !signal.aborted) {
          const hookSources = await this.activeHookSources(workspace)
          if (hookSources.length > 0) {
            const stopRes = await this.hookEngine.run({
              event: 'Stop',
              conversationId: conversation.id,
              workspace,
              signal,
              sources: hookSources,
            })
            this.emitHookNotices(conversation.id, stopRes.notices)
            if (stopRes.decision === 'block') {
              stopHookContinuations++
              const feedbackMsg: Message = {
                role: 'user',
                text: `[Hook Stop check failed — resolve before finishing]: ${stopRes.reason || 'Blocked by plugin hook.'}`,
              }
              conversation.messages.push(feedbackMsg)
              this.deps.emit({ type: 'message_saved', conversationId: conversation.id, message: feedbackMsg })
              await this.deps.save(conversation)
              continue
            }
          }
        }
        await this.deps.save(conversation)
        if (trunc === 'token_limit') {
          this.deps.emit({
            type: 'turn_end',
            conversationId: conversation.id,
            reason: 'truncated',
            truncation: 'token_limit',
          })
          return 'truncated'
        }
        this.deps.emit({ type: 'turn_end', conversationId: conversation.id, reason: 'done' })
        this.maybeRefineTitle(conversation, provider, endpoint, result.text)
        this.maybeAutoExtractMemory(conversation)
        return 'done'
      }
      await this.runTools(conversation, result, workspace, signal, mode, turnIndex)
      await this.deps.save(conversation)
    }
    await this.deps.save(conversation)
    this.deps.emit({ type: 'turn_end', conversationId: conversation.id, reason: 'max_rounds' })
    return 'max_rounds'
  }

  private maybeAutoExtractMemory(conversation: Conversation): void {
    if (this.deps.unattended || this.deps.allowSubagents === false || !this.deps.memory) return
    const appSettings = this.deps.settings.get()
    if (appSettings.memoryEnabled === false || appSettings.autoExtractMemory === false) return
    if (this.memoryExtracting.has(conversation.id)) return
    const substantiveCount = conversation.messages.filter(
      (m) => (m.role === 'user' && !m.isSummary) || (m.role === 'assistant' && Boolean(m.text.trim())),
    ).length
    if (substantiveCount < 4) return
    const lastExtracted = this.memoryExtractAtCount.get(conversation.id) ?? 0
    if (substantiveCount - lastExtracted < 4) return

    this.memoryExtracting.add(conversation.id)
    this.memoryExtractAtCount.set(conversation.id, substantiveCount)
    const snapshot: Conversation = {
      ...conversation,
      messages: [...conversation.messages],
    }
    void this.deps.memory
      .extractFromConversation(this.deps.settings, snapshot)
      .catch(() => undefined)
      .finally(() => {
        this.memoryExtracting.delete(conversation.id)
      })
  }

  private maybeRefineTitle(
    conversation: Conversation,
    provider: ProviderConfig,
    endpoint: ProviderEndpoint,
    assistantText: string,
  ): void {
    if (!this.deps.enableAutoTitle || !this.deps.onAutoTitle || this.deps.unattended) return
    if (conversation.titleSource === 'user' || conversation.titleSource === 'ai') return
    const userTurns = conversation.messages.filter((m) => m.role === 'user' && !m.isSummary)
    if (userTurns.length !== 1) return
    const firstUser = userTurns[0]
    if (!firstUser || firstUser.role !== 'user') return
    const userPrompt = firstUser.text.trim()
    const replySnippet = assistantText.trim()
    if (!userPrompt && !replySnippet) return

    const onAutoTitle = this.deps.onAutoTitle
    const convId = conversation.id
    void (async () => {
      try {
        const summaryInput = [
          `User: ${userPrompt.slice(0, 600)}`,
          replySnippet ? `Assistant: ${replySnippet.slice(0, 400)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
        const res = await chat(
          provider.protocol,
          endpoint,
          {
            model: provider.model,
            system:
              'Generate ONE concise sidebar title summarizing this conversation in the exact same language the user wrote (4-14 Chinese characters or 2-6 English words). Output ONLY plain text with no quotes, no markdown, no prefixes, and no trailing punctuation.',
            messages: [{ role: 'user', text: summaryInput }],
            tools: [],
            signal: AbortSignal.timeout(8_000),
            maxTokens: 48,
          },
          { onText: () => undefined },
        )
        const rawLine = res.text
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean)
        if (!rawLine) return
        const clean = rawLine
          .replace(/^["'`《「『【\[\(]+|["'`》」』】\]\)]+$/g, '')
          .replace(/[。.!！?？:：;；]+$/g, '')
          .replace(/\s+/g, ' ')
          .trim()
        if (!clean || clean.length > 48) return
        if (this.running.has(convId)) return
        await onAutoTitle(convId, clean)
      } catch {
        /* ignore background title generation failures */
      }
    })()
  }

  private toAssistantMessage(
    result: ChatResult,
    mode: AgentMode,
    workScene: WorkScene,
    incomplete?: 'token_limit' | 'stream_interrupted',
  ): Message {
    return {
      role: 'assistant',
      text: result.text,
      toolCalls: result.toolCalls,
      reasoning: result.reasoning,
      thinking: result.thinking,
      reasoningItems: result.reasoningItems,
      usage: result.usage,
      workScene,
      ...(mode === 'plan' ? { mode: 'plan' as const } : {}),
      ...(incomplete ? { incomplete } : {}),
    }
  }

  private isDesktopControlAllowed(): boolean {
    const s = this.deps.settings.get()
    return s.desktopControlEnabled === true || s.computerUseMode === 'desktop' || !this.deps.browser
  }

  private toolDefs(workspace: string | undefined, mode: AgentMode): ToolDef[] {
    const defs: ToolDef[] = []
    if (workspace) {
      if (mode === 'plan') {
        defs.push(...FILE_TOOLS.filter((t) => READ_ONLY_FILE_TOOLS.has(t.name)))
        if (this.deps.terminal) defs.push(BG_TOOLS[1]!)
        if (this.deps.preview) {
          const logsTool = PREVIEW_TOOLS.find((t) => t.name === 'preview_logs')
          if (logsTool) defs.push(logsTool)
        }
      } else {
        defs.push(...FILE_TOOLS, SHELL_TOOL)
        if (this.deps.terminal) defs.push(...BG_TOOLS)
        if (this.deps.preview) defs.push(...PREVIEW_TOOLS)
      }
    }
    if (this.deps.skills) defs.push(LOAD_SKILL_TOOL)
    if (this.deps.memory) {
      if (mode === 'plan') {
        defs.push(MEMORY_TOOLS.find((t) => t.name === 'search_memory')!)
      } else {
        defs.push(...MEMORY_TOOLS)
      }
    }
    if (this.deps.knowledge) defs.push(...KNOWLEDGE_TOOLS)
    const cuEnabled = this.deps.settings.get().computerUseEnabled !== false
    if (this.deps.browser) {
      if (mode === 'plan' || !cuEnabled) {
        defs.push(...BROWSER_TOOLS.filter((t) => t.name === 'browser_open' || t.name === 'browser_screenshot'))
      } else {
        defs.push(...BROWSER_TOOLS)
      }
    }
    if (this.deps.computer && cuEnabled && this.isDesktopControlAllowed() && mode !== 'plan') {
      defs.push(...COMPUTER_TOOLS)
    }
    if (this.deps.settings.get().webEnabled !== false) defs.push(...WEB_TOOLS)
    if (this.deps.allowSubagents !== false) defs.push(RUN_SUBAGENT_TOOL)
    if ((this.deps.mcp.resources?.().length ?? 0) > 0) {
      defs.push(MCP_LIST_RESOURCES_TOOL, MCP_READ_RESOURCE_TOOL)
    }
    if (mode !== 'plan') {
      for (const mcp of this.deps.mcp.tools()) {
        defs.push({ name: mcp.exposedName, description: `${mcp.serverName}: ${mcp.tool.description}`, inputSchema: mcp.tool.inputSchema })
      }
    }
    return defs
  }

  private isAllowedInPlanMode(name: string): boolean {
    return (
      READ_ONLY_FILE_TOOLS.has(name) ||
      READ_ONLY_WEB_TOOLS.has(name) ||
      name === 'load_skill' ||
      name === 'run_subagent' ||
      name === 'read_background' ||
      name === 'preview_logs' ||
      name === 'search_memory' ||
      name === 'knowledge_search' ||
      name === 'mcp_list_resources' ||
      name === 'mcp_read_resource' ||
      name === 'browser_open' ||
      name === 'browser_screenshot'
    )
  }

  private isConcurrentReadOnly(call: ToolCall, mode: AgentMode): boolean {
    if (this.deps.mcp.findTool(call.name)) return false
    if (
      call.name === 'load_skill' ||
      call.name === 'read_background' ||
      call.name === 'search_memory' ||
      call.name === 'knowledge_search' ||
      call.name === 'mcp_list_resources' ||
      call.name === 'mcp_read_resource'
    ) {
      return true
    }
    if (call.name === 'run_subagent') return mode === 'plan' || call.input?.role !== 'worker'
    return READ_ONLY_FILE_TOOLS.has(call.name) || READ_ONLY_WEB_TOOLS.has(call.name)
  }

  private async executeReadOnly(
    conversation: Conversation,
    call: ToolCall,
    workspace: string | undefined,
    signal: AbortSignal,
    mode: AgentMode,
    turnIndex: number,
  ): Promise<{ output: string; isError: boolean; images?: ImageAttachment[] }> {
    if (READ_ONLY_WEB_TOOLS.has(call.name)) {
      if (this.deps.settings.get().webEnabled === false) {
        return { output: 'Built-in web tools are turned off in Settings.', isError: true }
      }
      return runWebTool(call.name, call.input, { signal })
    }
    if (call.name === 'read_background') {
      if (!this.deps.terminal) return { output: 'Terminal manager is unavailable.', isError: true }
      return runReadBackground(this.deps.terminal, call.input)
    }
    if (call.name === 'search_memory') {
      if (!this.deps.memory) return { output: 'Memory store is unavailable.', isError: true }
      return runMemoryTool(this.deps.memory, call.name, call.input, workspace, conversation.id)
    }
    if (call.name === 'knowledge_search') {
      if (!this.deps.knowledge) return { output: 'Knowledge base is unavailable.', isError: true }
      return runKnowledgeTool(this.deps.knowledge, call.input, workspace)
    }
    if (call.name === 'mcp_list_resources') {
      const filter = typeof call.input.server === 'string' ? call.input.server.trim().toLowerCase() : ''
      const list = (this.deps.mcp.resources?.() ?? []).filter(
        (r) => !filter || r.serverName.toLowerCase().includes(filter) || r.serverId.toLowerCase() === filter,
      )
      if (list.length === 0) return { output: 'No matching MCP resources found.', isError: false }
      return {
        output: list
          .map(
            (r) =>
              `- [${r.serverName} · server_id="${r.serverId}"] ${r.name} (${r.uri})${r.mimeType ? ` · ${r.mimeType}` : ''}${r.description ? `\n  ${r.description}` : ''}`,
          )
          .join('\n'),
        isError: false,
      }
    }
    if (call.name === 'mcp_read_resource') {
      const serverId = typeof call.input.server_id === 'string' ? call.input.server_id.trim() : ''
      const uri = typeof call.input.uri === 'string' ? call.input.uri.trim() : ''
      if (!serverId || !uri) return { output: 'Both `server_id` and `uri` are required.', isError: true }
      try {
        const content = await this.deps.mcp.readResource(serverId, uri, signal)
        return {
          output: content.text || (content.images?.length ? `[${content.images.length} image(s) from ${uri}]` : '(empty resource)'),
          isError: false,
          ...(content.images?.length ? { images: content.images } : {}),
        }
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true }
      }
    }
    if (call.name === 'load_skill') {
      if (!this.deps.skills) return { output: 'Skills manager is unavailable.', isError: true }
      const file = typeof call.input.file === 'string' ? call.input.file : undefined
      return this.deps.skills.runLoadSkill(workspace, String(call.input.name ?? ''), file)
    }
    if (call.name === 'run_subagent') {
      return this.executeSubagent(conversation, call, workspace, signal, mode, turnIndex)
    }
    if (!workspace) {
      return { output: 'No workspace folder is set. Ask the user to pick one in Settings.', isError: true }
    }
    return runReadTool(workspace, call.name, call.input)
  }

  private async activeHookSources(workspace: string | undefined): Promise<PluginHookSource[]> {
    if (this.deps.settings.get().enablePluginHooks !== true) return []
    const [pluginSources, wsSource] = await Promise.all([
      this.deps.plugins ? this.deps.plugins.activeHookSources() : Promise.resolve([]),
      loadWorkspaceHookSource(workspace),
    ])
    return wsSource ? [...pluginSources, wsSource] : pluginSources
  }

  private emitHookNotices(conversationId: string, notices: HookRunEventNotice[]): void {
    for (const n of notices) {
      if (n.decision === 'allow' && !n.message) continue
      this.deps.emit({
        type: 'hook_event',
        conversationId,
        event: n.event,
        pluginName: n.pluginName,
        ...(n.toolName ? { toolName: n.toolName } : {}),
        decision: n.decision,
        ...(n.message ? { message: n.message } : {}),
      })
    }
  }

  private async runWithToolHooks(
    conversation: Conversation,
    call: ToolCall,
    workspace: string | undefined,
    signal: AbortSignal,
    runner: () => Promise<{ output: string; isError: boolean; images?: ImageAttachment[] }>,
  ): Promise<{ output: string; isError: boolean; images?: ImageAttachment[] }> {
    const hookSources = await this.activeHookSources(workspace)
    if (hookSources.length === 0) return runner()

    const pre = await this.hookEngine.run({
      event: 'PreToolUse',
      conversationId: conversation.id,
      workspace,
      toolName: call.name,
      toolInput: call.input,
      signal,
      sources: hookSources,
    })
    this.emitHookNotices(conversation.id, pre.notices)
    if (pre.decision === 'block') {
      return { output: `Blocked by plugin hook: ${pre.reason || 'PreToolUse hook denied this action.'}`, isError: true }
    }

    const outcome = await runner()
    if (
      signal.aborted ||
      outcome.output === 'The user denied this action.' ||
      outcome.output === 'The user denied this desktop action.' ||
      outcome.output.includes('is disabled in Plan Mode')
    ) {
      return outcome
    }

    const post = await this.hookEngine.run({
      event: 'PostToolUse',
      conversationId: conversation.id,
      workspace,
      toolName: call.name,
      toolInput: call.input,
      toolOutput: outcome.output,
      isError: outcome.isError,
      signal,
      sources: hookSources,
    })
    this.emitHookNotices(conversation.id, post.notices)
    let nextOutput = outcome.output
    let nextError = outcome.isError
    if (post.additionalContext) {
      nextOutput = `${nextOutput}\n\n[Hook feedback]\n${post.additionalContext}`
    }
    if (post.decision === 'block') {
      nextError = true
      nextOutput = `${nextOutput}\n\n[Hook blocked post-check]: ${post.reason || 'PostToolUse hook reported an error.'}`
    }
    return {
      ...outcome,
      output: nextOutput,
      isError: nextError,
    }
  }

  private async runTools(
    conversation: Conversation,
    result: ChatResult,
    workspace: string | undefined,
    signal: AbortSignal,
    mode: AgentMode,
    turnIndex: number,
  ): Promise<void> {
    const hitTokenLimit = truncationReason(result) === 'token_limit'
    const nameById = new Map(result.toolCalls.map((c) => [c.id, c.name]))
    for (const [id, raw] of Object.entries(result.badArguments)) {
      const name = nameById.get(id) ?? 'unknown'
      const msg = hitTokenLimit
        ? `The tool arguments were truncated by the output token limit before valid JSON completed. Split large file writes or calls into smaller chunks. Raw prefix: ${raw}`
        : `The tool arguments were not valid JSON: ${raw}`
      await this.recordTool(conversation, id, name, msg, true)
    }
    const calls = result.toolCalls.filter((c) => !(c.id in result.badArguments))
    for (let i = 0; i < calls.length; ) {
      if (signal.aborted) return
      if (this.isConcurrentReadOnly(calls[i]!, mode)) {
        const batch: ToolCall[] = []
        while (i < calls.length && this.isConcurrentReadOnly(calls[i]!, mode)) {
          batch.push(calls[i]!)
          i++
        }
        for (const call of batch) {
          this.deps.emit({ type: 'tool_call', conversationId: conversation.id, call })
          this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        }
        const outcomes = await Promise.all(
          batch.map((call) =>
            this.runWithToolHooks(conversation, call, workspace, signal, () =>
              this.executeReadOnly(conversation, call, workspace, signal, mode, turnIndex),
            ),
          ),
        )
        for (let k = 0; k < batch.length; k++) {
          const call = batch[k]!
          const outcome = outcomes[k]!
          await this.recordTool(conversation, call.id, call.name, outcome.output, outcome.isError, outcome.images)
        }
        continue
      }
      const call = calls[i++]!
      const mcp = this.deps.mcp.findTool(call.name)
      this.deps.emit({ type: 'tool_call', conversationId: conversation.id, call, serverName: mcp?.serverName })
      const outcome = await this.runWithToolHooks(conversation, call, workspace, signal, () =>
        this.execute(conversation, call, workspace, mcp?.serverId, signal, mode, turnIndex),
      )
      await this.recordTool(conversation, call.id, call.name, outcome.output, outcome.isError, outcome.images)
    }
  }

  private async execute(
    conversation: Conversation,
    call: ToolCall,
    workspace: string | undefined,
    serverId: string | undefined,
    signal: AbortSignal,
    mode: AgentMode,
    turnIndex: number,
  ): Promise<{ output: string; isError: boolean; images?: ImageAttachment[] }> {
    try {
      if (mode === 'plan' && !this.isAllowedInPlanMode(call.name)) {
        return {
          output: `Tool "${call.name}" is disabled in Plan Mode (read-only). Deliver the plan first and switch permission mode before making changes.`,
          isError: true,
        }
      }
      if (call.name === 'load_skill' || call.name === 'run_subagent') {
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        return this.executeReadOnly(conversation, call, workspace, signal, mode, turnIndex)
      }
      const checkpointConvId = this.deps.checkpointConversationId ?? conversation.id
      if (call.name === 'read_background') {
        if (!this.deps.terminal) return { output: 'Terminal manager is unavailable.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        return runReadBackground(this.deps.terminal, call.input)
      }
      if (call.name === 'stop_background') {
        if (!this.deps.terminal) return { output: 'Terminal manager is unavailable.', isError: true }
        const allowed = await this.ask(conversation, call, serverId, signal, mode, undefined, workspace)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        return runStopBackground(this.deps.terminal, call.input)
      }
      if (!workspace && (FILE_TOOLS.some((t) => t.name === call.name) || call.name === 'run_command' || call.name === 'start_background' || PREVIEW_TOOLS.some((t) => t.name === call.name))) {
        return { output: 'No workspace folder is set. Ask the user to pick one in Settings.', isError: true }
      }
      if (call.name === 'preview_logs') {
        if (!this.deps.preview) return { output: 'Preview server manager is unavailable.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        const browserConvId = this.deps.checkpointConversationId ?? conversation.id
        return runPreviewTool(this.deps.preview, this.deps.browser, call.name, call.input, {
          workspace: workspace!,
          conversationId: browserConvId,
          signal,
        })
      }
      if (call.name === 'preview_stop') {
        if (!this.deps.preview) return { output: 'Preview server manager is unavailable.', isError: true }
        const allowed = await this.ask(conversation, call, serverId, signal, mode, undefined, workspace)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        const browserConvId = this.deps.checkpointConversationId ?? conversation.id
        return runPreviewTool(this.deps.preview, this.deps.browser, call.name, call.input, {
          workspace: workspace!,
          conversationId: browserConvId,
          signal,
        })
      }
      if (call.name === 'preview_start') {
        if (!this.deps.preview) return { output: 'Preview server manager is unavailable.', isError: true }
        const cmdDecision = await evaluateCommandPolicy(workspace!, String(call.input.command ?? ''))
        if (!cmdDecision.allowed) {
          return { output: cmdDecision.reason ?? 'Blocked by project command security policy.', isError: true }
        }
        const allowed = await this.ask(conversation, call, serverId, signal, mode, undefined, workspace)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        const browserConvId = this.deps.checkpointConversationId ?? conversation.id
        return runPreviewTool(this.deps.preview, this.deps.browser, call.name, call.input, {
          workspace: workspace!,
          conversationId: browserConvId,
          signal,
        })
      }
      if (call.name === 'edit_file') {
        const prepared = await prepareEdit(workspace!, call.input)
        const allowed = await this.ask(conversation, call, serverId, signal, mode, prepared.diff, workspace)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        const before = await snapshotExistingFile(workspace!, prepared.path)
        await writeApproved(workspace!, prepared.path, prepared.nextContent)
        await this.deps.checkpoints?.record(checkpointConvId, [before])
        await this.deps.checkpoints?.recordTurn(checkpointConvId, turnIndex, [before])
        return {
          output: `Edited ${prepared.path} (${prepared.replacements} replacement${prepared.replacements === 1 ? '' : 's'}).`,
          isError: false,
        }
      }
      if (call.name === 'write_file') {
        const path = String(call.input.path ?? '')
        const content = String(call.input.content ?? '')
        const diffOrContent = await prepareWriteDiff(workspace!, path, content)
        const allowed = await this.ask(conversation, call, serverId, signal, mode, diffOrContent, workspace)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        const before = await snapshotExistingFile(workspace!, path)
        await writeApproved(workspace!, path, content)
        await this.deps.checkpoints?.record(checkpointConvId, [before])
        await this.deps.checkpoints?.recordTurn(checkpointConvId, turnIndex, [before])
        return { output: `Wrote ${path}.`, isError: false }
      }
      if (call.name === 'apply_patch') {
        const prepared = await preparePatch(workspace!, call.input)
        const allowed = await this.ask(conversation, call, serverId, signal, mode, prepared.diff, workspace, prepared.summary)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        await applyPreparedPatch(prepared)
        const snaps = prepared.files.map((f) => ({
          path: f.path,
          fromPath: f.fromPath,
          beforeExists: f.beforeExists,
          beforeContent: f.beforeContent,
        }))
        await this.deps.checkpoints?.record(checkpointConvId, snaps)
        await this.deps.checkpoints?.recordTurn(checkpointConvId, turnIndex, snaps)
        const summaryLines = prepared.files.map((f) => `${f.status}: ${f.fromPath ? `${f.fromPath} -> ${f.path}` : f.path}`)
        return { output: `Applied patch to ${prepared.files.length} file(s):\n${summaryLines.join('\n')}`, isError: false }
      }
      if (READ_ONLY_WEB_TOOLS.has(call.name)) {
        if (this.deps.settings.get().webEnabled === false) {
          return { output: 'Built-in web tools are turned off in Settings.', isError: true }
        }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        return runWebTool(call.name, call.input, { signal })
      }
      if (call.name === 'run_command' || call.name === 'start_background') {
        const cmdDecision = await evaluateCommandPolicy(workspace!, String(call.input.command ?? ''))
        if (!cmdDecision.allowed) {
          return { output: cmdDecision.reason ?? 'Blocked by project command security policy.', isError: true }
        }
      }
      if (call.name === 'run_command' || call.name === 'start_background' || serverId) {
        const allowed = await this.ask(conversation, call, serverId, signal, mode, undefined, workspace)
        if (!allowed) return { output: 'The user denied this action.', isError: true }
      }
      this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
      if (call.name === 'start_background') {
        if (!this.deps.terminal) return { output: 'Terminal manager is unavailable.', isError: true }
        return runStartBackground(this.deps.terminal, workspace!, call.input, signal)
      }
      if (call.name === 'run_command') {
        const seconds = Number(call.input.timeoutSeconds ?? 120)
        const s = this.deps.settings.get()
        const policy = await inspectWorkspacePolicy(workspace!)
        const effSandbox = resolveEffectiveSandbox(s.shellSandbox, s.sandboxAllowNetwork, policy)
        return runCommand(
          workspace!,
          String(call.input.command ?? ''),
          Number.isFinite(seconds) ? seconds : 120,
          signal,
          (liveOutput) =>
            this.deps.emit({
              type: 'tool_status',
              conversationId: conversation.id,
              toolCallId: call.id,
              status: 'running',
              output: liveOutput,
            }),
          {
            sandboxMode: effSandbox.sandboxMode,
            allowNetwork: effSandbox.allowNetwork,
            dataDir: this.deps.dataDir,
          },
        )
      }
      if (call.name === 'save_memory' || call.name === 'delete_memory') {
        if (!this.deps.memory) return { output: 'Memory store is unavailable.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        return runMemoryTool(this.deps.memory, call.name, call.input, workspace, conversation.id)
      }
      if (BROWSER_TOOLS.some((t) => t.name === call.name)) {
        if (!this.deps.browser) return { output: 'Built-in browser engine is unavailable.', isError: true }
        if (
          call.name === 'browser_click' ||
          call.name === 'browser_mouse' ||
          call.name === 'browser_type' ||
          call.name === 'browser_key' ||
          call.name === 'browser_scroll' ||
          call.name === 'browser_eval'
        ) {
          const allowed = await this.ask(conversation, call, undefined, signal, mode, undefined, workspace)
          if (!allowed) return { output: 'The user denied this action.', isError: true }
        }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        const browserConvId = this.deps.checkpointConversationId ?? conversation.id
        const res = await runBrowserTool(this.deps.browser, call.name, call.input, { conversationId: browserConvId })
        return { output: res.output, isError: res.isError, images: res.images }
      }
      if (COMPUTER_TOOLS.some((t) => t.name === call.name)) {
        if (!this.deps.computer || this.deps.settings.get().computerUseEnabled === false) {
          return { output: 'Desktop Computer Use is disabled or unavailable.', isError: true }
        }
        if (!this.isDesktopControlAllowed()) {
          return {
            output:
              'Direct OS desktop control is currently off because Computer Use prioritizes the built-in browser. Use `browser_*` tools in the built-in browser instead, or ask the user to enable Direct OS Desktop Control.',
            isError: true,
          }
        }
        const allowed = await this.ask(conversation, call, undefined, signal, mode, undefined, workspace)
        if (!allowed) return { output: 'The user denied this desktop action.', isError: true }
        if (signal.aborted) return { output: 'Stopped.', isError: true }
        this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'running' })
        void this.deps.computer
          .setHud({ active: true, label: describeComputerAction(call.name, call.input) })
          .catch(() => undefined)
        const res = await runComputerTool(this.deps.computer, call.name, call.input)
        return { output: res.output, isError: res.isError, images: res.images }
      }
      if (FILE_TOOLS.some((t) => t.name === call.name)) {
        return runReadTool(workspace!, call.name, call.input)
      }
      if (serverId) return this.deps.mcp.callTool(call.name, call.input, signal)
      return { output: `Unknown tool "${call.name}".`, isError: true }
    } catch (err) {
      if (signal.aborted) return { output: 'Stopped.', isError: true }
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }

  private isUltracodeActive(): boolean {
    return this.deps.settings.get().ultracode === true && this.deps.allowSubagents !== false
  }

  private async executeSubagent(
    parentConversation: Conversation,
    parentCall: ToolCall,
    workspace: string | undefined,
    signal: AbortSignal,
    parentMode: AgentMode,
    turnIndex: number,
  ): Promise<{ output: string; isError: boolean }> {
    if (this.deps.allowSubagents === false) {
      return { output: 'Nested subagent calls are disabled.', isError: true }
    }
    const { role, task, maxRounds } = parseSubagentInput(parentCall.input, parentMode, {
      ultracode: this.isUltracodeActive(),
    })
    if (!task) return { output: 'Subagent `task` is required.', isError: true }
    if (signal.aborted) return { output: 'Stopped.', isError: true }

    const steps: string[] = []
    const activeSteps = new Map<string, string>()
    let stoppedEarly: string | undefined
    let childError: string | undefined
    const emitProgress = () =>
      this.deps.emit({
        type: 'tool_status',
        conversationId: parentConversation.id,
        toolCallId: parentCall.id,
        status: 'running',
        output: buildSubagentProgressText(role, steps, [...activeSteps.values()].pop()),
      })

    emitProgress()
    const childConv: Conversation = {
      id: `${parentConversation.id}::sub::${parentCall.id}`,
      title: `Subagent (${role})`,
      workspace,
      providerId: parentConversation.providerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    }
    const childLoop = new AgentLoop({
      ...this.deps,
      allowSubagents: false,
      enableAutoTitle: false,
      onAutoTitle: undefined,
      forcedMode: role === 'explorer' ? 'plan' : parentMode,
      checkpointConversationId: this.deps.checkpointConversationId ?? parentConversation.id,
      checkpointTurnIndex: turnIndex,
      maxRounds,
      sharedApprovals: this.approvals,
      sharedSessionAllows: this.sessionAllows,
      emit: (ev) => {
        if (ev.type === 'tool_call') {
          activeSteps.set(ev.call.id, formatSubagentStep(ev.call.name, ev.call.input))
          emitProgress()
        } else if (ev.type === 'tool_status' && (ev.status === 'done' || ev.status === 'error' || ev.status === 'denied')) {
          const done = activeSteps.get(ev.toolCallId)
          if (done) {
            steps.push(done)
            activeSteps.delete(ev.toolCallId)
          }
          emitProgress()
        } else if (ev.type === 'approval') {
          this.deps.emit({ ...ev, request: { ...ev.request, conversationId: parentConversation.id } })
        } else if (ev.type === 'error') {
          childError = ev.message
        } else if (ev.type === 'turn_end' && ev.reason !== 'done') {
          stoppedEarly = ev.reason === 'max_rounds' ? `Reached step limit (${maxRounds}).` : `Subagent ended (${ev.reason}).`
        }
      },
      save: async () => undefined,
      systemPrompt: (ws, notes, opts) => buildSubagentPrompt(this.deps.systemPrompt(ws, notes, opts), role),
    })

    const onAbort = () => childLoop.stop(childConv.id)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await childLoop.run(childConv, task)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }

    if (signal.aborted) return { output: 'Stopped.', isError: true }
    let summary = ''
    for (let i = childConv.messages.length - 1; i >= 0; i--) {
      const m = childConv.messages[i]
      if (m?.role === 'assistant' && m.text.trim()) {
        summary = m.text
        break
      }
    }
    if (childError && !summary) return { output: childError, isError: true }
    return { output: formatSubagentReport(role, steps, summary, stoppedEarly ?? childError), isError: false }
  }

  private isAutoApprovedByMode(mode: AgentMode, kind: ApprovalKind, call: ToolCall): boolean {
    if (mode === 'bypass') return this.deps.settings.get().allowBypassPermissions !== false
    if (mode === 'manual' || mode === 'plan') return false
    if (mode === 'accept_edits') return kind === 'edit' || kind === 'write'
    if (mode === 'auto') {
      if (kind === 'edit' || kind === 'write') return true
      if (
        call.name === 'browser_click' ||
        call.name === 'browser_mouse' ||
        call.name === 'browser_type' ||
        call.name === 'browser_key' ||
        call.name === 'browser_scroll'
      ) {
        return true
      }
      if (kind === 'shell') return !isDangerousShellCommand(String(call.input.command ?? ''))
      return false
    }
    return false
  }

  /** Returns true when the user (or active permission mode) allows the action. */
  private async ask(
    conversation: Conversation,
    call: ToolCall,
    serverId: string | undefined,
    signal: AbortSignal,
    mode: AgentMode,
    detailOverride?: string,
    workspace?: string,
    summaryOverride?: string,
  ): Promise<boolean> {
    const kind: ApprovalKind =
      call.name === 'edit_file' || call.name === 'apply_patch'
        ? 'edit'
        : call.name === 'write_file'
          ? 'write'
          : call.name === 'run_command' ||
              call.name === 'start_background' ||
              call.name === 'stop_background' ||
              call.name === 'preview_start' ||
              call.name === 'preview_stop'
            ? 'shell'
            : call.name.startsWith('desktop_')
              ? 'computer'
              : 'mcp'
    if (this.isAutoApprovedByMode(mode, kind, call)) return true
    const isBrowser = call.name.startsWith('browser_')
    const isComputer = kind === 'computer'
    const allowKey = isBrowser ? 'browser' : isComputer ? 'computer' : kind === 'mcp' ? `mcp:${serverId}` : kind
    const wsScope = workspace ?? conversation.workspace
    const scope = this.scopeKey(wsScope)
    const allowedSet = this.sessionAllows.get(scope)
    if (allowedSet?.has(allowKey)) return true
    const persistentRules = this.deps.settings.allowedRulesFor?.(wsScope) ?? []
    if (matchesAllowedRules(call, kind, serverId, persistentRules)) return true
    if (this.deps.unattended) return false
    const builtRule = buildAlwaysAllowRule(call, kind, serverId)
    const request: ApprovalRequest = {
      approvalId: `apr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      conversationId: conversation.id,
      toolCallId: call.id,
      kind,
      toolName: call.name,
      summary: summaryOverride ?? summaryFor(call),
      detail: detailOverride ?? detailFor(call),
      serverName: serverId ? this.deps.mcp.findTool(call.name)?.serverName : isBrowser ? 'Browser' : isComputer ? 'Computer Use' : undefined,
      alwaysRuleLabel: builtRule.label,
    }
    // Register the pending approval (and the Stop handler) before telling
    // anyone about it, so an immediate answer or Stop is never lost.
    const answered = new Promise<ApprovalAnswer>((resolve) => {
      this.approvals.set(request.approvalId, { request, resolve })
      const onAbort = () => {
        if (this.approvals.delete(request.approvalId)) resolve({ decision: 'deny' })
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'awaiting_approval' })
    this.deps.emit({ type: 'approval', request })
    const answer = await answered
    if (answer.decision === 'allow_session') {
      let set = this.sessionAllows.get(scope)
      if (!set) {
        set = new Set()
        this.sessionAllows.set(scope, set)
      }
      set.add(allowKey)
    } else if (answer.decision === 'allow_always') {
      await this.deps.settings.addAllowedRule?.(wsScope, builtRule.rule)
    }
    if (answer.decision === 'deny') {
      this.deps.emit({ type: 'tool_status', conversationId: conversation.id, toolCallId: call.id, status: 'denied' })
    }
    return answer.decision !== 'deny'
  }

  private async recordTool(
    conversation: Conversation,
    toolCallId: string,
    name: string,
    output: string,
    isError: boolean,
    images?: ImageAttachment[],
  ): Promise<void> {
    const trimmed = output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n…(truncated)` : output
    const message: Message = {
      role: 'tool',
      toolCallId,
      name,
      output: trimmed,
      isError,
      ...(images?.length ? { images } : {}),
    }
    conversation.messages.push(message)
    this.deps.emit({
      type: 'tool_status',
      conversationId: conversation.id,
      toolCallId,
      status: isError ? 'error' : 'done',
      output: trimmed,
      ...(images?.length ? { images } : {}),
    })
    this.deps.emit({ type: 'message_saved', conversationId: conversation.id, message })
  }
}

function summaryFor(call: ToolCall): string {
  if (call.name === 'edit_file') return `Edit ${String(call.input.path ?? '')}`
  if (call.name === 'write_file') return `Write ${String(call.input.path ?? '')}`
  if (call.name === 'apply_patch') return 'Apply multi-file patch'
  if (call.name === 'run_command' || call.name === 'start_background' || call.name === 'preview_start') return String(call.input.command ?? '')
  if (call.name === 'preview_stop') return `Stop preview server ${String(call.input.serverId ?? '')}`.trim()
  if (call.name === 'stop_background') return `Stop background session ${String(call.input.sessionId ?? '')}`
  if (call.name === 'browser_click') {
    if (call.input.ref || call.input.selector) return `Click browser element ${String(call.input.ref ?? call.input.selector ?? '')}`
    return `Click browser coordinates (${Math.round(Number(call.input.x ?? 0))}, ${Math.round(Number(call.input.y ?? 0))})`
  }
  if (call.name === 'browser_mouse') {
    const act = String(call.input.action ?? 'move')
    if (call.input.ref || call.input.selector) return `Browser virtual cursor ${act} ${String(call.input.ref ?? call.input.selector ?? '')}`
    return `Browser virtual cursor ${act} (${Math.round(Number(call.input.x ?? 0))}, ${Math.round(Number(call.input.y ?? 0))})`
  }
  if (call.name === 'browser_type') return `Type into browser element ${String(call.input.ref ?? call.input.selector ?? '')}`
  if (call.name === 'browser_key') return `Press key ${String(call.input.key ?? '')} in built-in browser`
  if (call.name === 'browser_scroll') return `Scroll browser (${Number(call.input.deltaY ?? 480)}px)`
  if (call.name === 'browser_eval') return 'Run JavaScript in built-in browser'
  if (call.name.startsWith('desktop_')) return describeComputerAction(call.name, call.input)
  return call.name
}

function detailFor(call: ToolCall): string | undefined {
  if (call.name === 'write_file') return String(call.input.content ?? '')
  if (call.name === 'run_command' || call.name === 'start_background' || call.name === 'preview_start') return undefined
  return JSON.stringify(call.input, null, 2)
}

function formatForSummary(messages: Message[]): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const imgs = m.images?.length ? ` [+${m.images.length} image(s)]` : ''
      const docs = m.documents?.length ? ` [+${m.documents.length} doc(s): ${m.documents.map((d) => d.name).join(', ')}]` : ''
      lines.push(`USER${imgs}${docs}: ${m.text.slice(0, 2000)}`)
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input).slice(0, 120)})`).join(', ')
      if (m.text.trim()) lines.push(`ASSISTANT: ${m.text.slice(0, 2000)}`)
      if (calls) lines.push(`TOOLS CALLED: ${calls}`)
    } else {
      const status = m.isError ? 'ERROR' : 'OK'
      const imgs = m.images?.length ? ` [+${m.images.length} image(s)]` : ''
      lines.push(`TOOL RESULT [${m.name} ${status}]${imgs}: ${m.output.slice(0, 1200)}`)
    }
  }
  return lines.join('\n\n')
}

export type { ConnectionTest }
