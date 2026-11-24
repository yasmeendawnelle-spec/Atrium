// Types shared by the core process, the Electron main process, and the renderer.

export type Protocol = 'anthropic' | 'responses' | 'openai'
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ProviderConfig {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  model: string
  /** Configured or discovered models available under this provider (always includes `model`). */
  models?: string[]
  presetId?: string
  managedBy?: 'relaypulse'
  hasKey: boolean
}

export interface ProviderDraft extends Omit<ProviderConfig, 'id' | 'hasKey'> {
  id?: string
  /** Only sent when the user typed a new key. Never sent back to the renderer. */
  apiKey?: string
}

export type SubscriptionCategory = 'gpt' | 'claude' | 'gemini' | 'deepseek' | 'zhipu' | 'kimi'

export type SubscriptionTierLevel = 'standard' | 'pro'

export interface CategorySubscriptionInfo {
  category: SubscriptionCategory
  level: SubscriptionTierLevel
  planId: string
  name: string
  status: 'active' | 'expired'
  active: boolean
  priceCny: number
  weeklyLimitUsd: number
  weeklyUsedUsd: number
  monthlyLimitUsd: number
  monthlyUsedUsd: number
  remainingPercent: number
  usedPercent: number
  daysRemaining: number | null
  cycleResetAt: string
  startedAt: string
  expiresAt: string
  expiresAtFormatted: string
  preferredKeyGroup: string
  source: 'remote' | 'atrium'
}

export interface RelayPulseSubscriptionInfo {
  tier: string
  name: string
  status: string
  active: boolean
  remainingPercent: number
  usedPercent: number
  daysRemaining: number | null
  expiresAtFormatted: string | null
}

export interface RelayPulseAccountState {
  connected: boolean
  origin: string
  stagingAgreementAccepted?: boolean
  stagingAgreementAcceptedAt?: number
  email?: string
  displayName?: string
  oauthProvider?: string | null
  hasPassword?: boolean
  avatar?: string | null
  avatarCustom?: boolean
  balanceCny?: number
  specialBalanceUsd?: number
  usedCny?: number
  todayUsedCny?: number
  todayCalls?: number
  keyGroup?: string
  subscription?: RelayPulseSubscriptionInfo | null
  subscriptions?: Partial<Record<SubscriptionCategory, CategorySubscriptionInfo>>
  sessionExpiresAt?: number
  sessionValid?: boolean
  providerId?: string
  availableModels?: string[]
  lastSyncedAt?: number
}

export type RelayPulseOAuthResult =
  | { status: 'signed_in'; state: RelayPulseAccountState }
  | { status: 'needs_email'; pendingToken: string; provider: 'google' | 'github'; username?: string }

export type RechargePayChannel = 'wxpay' | 'alipay'

export interface RechargeCreateOrderRequest {
  payChannel: RechargePayChannel
  amountCny: number
}

export interface RechargeOrderInfo {
  outTradeNo: string
  amountCny: number
  payCny: number
  exchangeRate?: number
  qrImageDataUrl: string
  payMode: string
  payChannel: string
  payMethod: string
  manualConfirmation: boolean
  isDemo?: boolean
  message?: string
}

export interface RechargeOrderStatusResult {
  outTradeNo: string
  paid: boolean
  status: 'pending' | 'submitted' | 'paid' | 'expired' | 'amount_mismatch'
  amountCny?: number
  state?: RelayPulseAccountState
}

export type McpTransport = 'stdio' | 'http'

export interface McpOAuthConfig {
  clientId?: string
  scopes?: string
  /** True once encrypted OAuth tokens exist for this server. */
  authorized?: boolean
  expiresAt?: number
}

export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  /**
   * Keys whose values are kept in encrypted storage, as `env:NAME` or `header:NAME`.
   * Their values come back to the renderer as empty strings.
   */
  secretKeys?: string[]
  authMode?: 'none' | 'oauth'
  oauth?: McpOAuthConfig
  source?: { kind: 'manual' | 'registry' | 'github' | 'import' | 'plugin'; ref?: string }
  pluginId?: string
}

export type McpState = 'off' | 'connecting' | 'connected' | 'error'

export interface ToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpResourceInfo {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpPromptArgument {
  name: string
  description?: string
  required?: boolean
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: McpPromptArgument[]
}

export interface McpResourceContent {
  serverId: string
  serverName: string
  uri: string
  mimeType?: string
  text?: string
  images?: ImageAttachment[]
}

export interface McpPromptResult {
  description?: string
  text: string
  images?: ImageAttachment[]
}

export interface McpServerStatus {
  id: string
  state: McpState
  error?: string
  needsAuth?: boolean
  tools: ToolInfo[]
  resources?: McpResourceInfo[]
  prompts?: McpPromptInfo[]
  stderrTail?: string
}

export interface McpTestResult {
  ok: boolean
  tools: ToolInfo[]
  error?: string
  stderrTail?: string
  serverName?: string
  serverVersion?: string
}

// ---- Conversation model (provider neutral) ----

export interface ToolCall {
  id: string
  /** OpenAI Responses API output item id (e.g. `fc_...`) for verbatim replay. */
  itemId?: string
  name: string
  input: Record<string, unknown>
}

/**
 * One thinking block from an Anthropic response, kept so it can be sent back
 * unchanged on later turns. `signature` is empty when the provider omitted it;
 * blocks without one are dropped on replay rather than sent.
 * `redacted_thinking` blocks preserve encrypted safety payloads via `data`.
 */
export interface ThinkingBlock {
  type?: 'thinking' | 'redacted_thinking'
  thinking: string
  signature: string
  data?: string
}

/** OpenAI Responses API reasoning item, preserved for stateless replay. */
export interface ResponsesReasoning {
  id: string
  summary?: string
  encryptedContent?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ImageAttachment {
  id: string
  name: string
  mimeType: string
  /** Data URL (`data:image/...;base64,...`) kept in conversation history. */
  dataUrl: string
}

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text'

export interface DocumentAttachment {
  id: string
  name: string
  path?: string
  docKind: DocumentKind
  content: string
  truncated?: boolean
  byteSize?: number
  pageCount?: number
  sheetCount?: number
  slideCount?: number
  sheetNames?: string[]
}

export interface QueuedMessage {
  id: string
  text: string
  images?: ImageAttachment[]
  documents?: DocumentAttachment[]
  createdAt: number
}

export type Message =
  | { role: 'user'; text: string; images?: ImageAttachment[]; documents?: DocumentAttachment[]; isSummary?: boolean }
  | {
      role: 'assistant'
      text: string
      toolCalls: ToolCall[]
      /** reasoning_content from OpenAI-compatible thinking models; sent back during tool rounds. */
      reasoning?: string
      /** Anthropic thinking blocks, replayed verbatim. Absent for other providers. */
      thinking?: ThinkingBlock[]
      /** OpenAI Responses reasoning items (encrypted_content / summary), replayed verbatim. */
      reasoningItems?: ResponsesReasoning[]
      usage?: TokenUsage
      mode?: AgentMode
      workScene?: WorkScene
      /** Present when this reply ended prematurely before completing cleanly. */
      incomplete?: 'token_limit' | 'stream_interrupted' | 'aborted' | 'error'
    }
  | { role: 'tool'; toolCallId: string; name: string; output: string; isError: boolean; images?: ImageAttachment[] }

export interface ConversationUsageTotals {
  userMessages: number
  assistantMessages: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  untaggedSceneMessages: number
  workScene: Omit<SceneUsageBreakdown, 'scene'>
  codeScene: Omit<SceneUsageBreakdown, 'scene'>
}

export interface ConversationMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  providerId?: string
  workspace?: string
  messageCount?: number
  titleSource?: 'heuristic' | 'ai' | 'user'
  /** Original repository path when this chat runs in an isolated Git worktree. */
  worktreeBaseWorkspace?: string
  worktreeBranch?: string
  worktreeBaseBranch?: string
  /** Source conversation provenance when created via Fork Branch. */
  forkedFromId?: string
  forkedFromTitle?: string
  /** Pinned conversations stay at the top of their workspace group. */
  pinned?: boolean
  /** Archived conversations move out of the main sidebar list until restored. */
  archived?: boolean
  /** Cached working-tree diff summary shown as +add/-del pills in Sidebar. */
  diffStats?: { additions: number; deletions: number }
  /** Aggregated token and message usage cached in chats index for instant UsageSummary queries. */
  usageTotals?: ConversationUsageTotals
}

/** True when a persisted chat entry is an empty, unstarted non-worktree/non-fork draft. */
export function isEmptyChatStub(
  c: Pick<ConversationMeta, 'messageCount' | 'worktreeBranch' | 'forkedFromId'>,
  isBusy = false,
): boolean {
  return !isBusy && (c.messageCount ?? 1) === 0 && !c.worktreeBranch && !c.forkedFromId
}

export interface FileChangeEntry {
  path: string
  fromPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  diff: string
  revertible: boolean
  staged?: boolean
  unstaged?: boolean
  updatedAt?: number
}

export interface WorkspaceChanges {
  workspace?: string
  isGit: boolean
  branch?: string
  head?: string
  isWorktree: boolean
  baseBranch?: string
  branches?: string[]
  ahead?: number
  behind?: number
  githubRepo?: string
  items: FileChangeEntry[]
}

export interface GitPushResult {
  branch: string
  remote: string
}

export interface GitPrUrlResult {
  url: string
  branch: string
  baseBranch?: string
  pushed?: boolean
}

export interface GitRepoStatus {
  isRepo: boolean
  branch?: string
  head?: string
  dirtyCount: number
  githubRepo?: string
}

export interface GitHubIssueSummary {
  number: number
  title: string
  url: string
  state: string
  author?: string
  labels: string[]
  body: string
  updatedAt: string
}

export interface GitCommitResult {
  commitHash: string
  summary: string
  branch?: string
}

export interface WorktreeMergeResult {
  baseWorkspace: string
  baseBranch?: string
  branch: string
  mergedCommit?: string
  autoCommitted?: boolean
  cleanedUp: boolean
}

export interface DiffReviewComment {
  id: string
  path: string
  side: 'old' | 'new'
  line: number
  snippet: string
  body: string
}

export interface AttachedExternalFile {
  id: string
  name: string
  path: string
  docKind?: DocumentKind
  content: string
  truncated?: boolean
  byteSize?: number
  pageCount?: number
  sheetCount?: number
  slideCount?: number
  sheetNames?: string[]
}

export type PickedFileResult =
  | { kind: 'image'; name: string; mimeType: string; dataUrl: string; byteSize: number }
  | {
      kind: 'document'
      name: string
      path: string
      relativePath?: string
      docKind: Exclude<DocumentKind, 'text'>
      content: string
      truncated?: boolean
      byteSize?: number
      pageCount?: number
      sheetCount?: number
      slideCount?: number
      sheetNames?: string[]
      error?: string
    }
  | {
      kind: 'file'
      name: string
      path: string
      relativePath?: string
      content?: string
      truncated?: boolean
      binary?: boolean
      legacyOffice?: boolean
      tooLarge?: boolean
    }

export interface WorkspaceFilePreview {
  path: string
  content: string
  truncated: boolean
  size: number
}

export interface Conversation extends ConversationMeta {
  messages: Message[]
}

// ---- Tool runs and approvals ----

export type ToolRunStatus = 'awaiting_approval' | 'running' | 'done' | 'error' | 'denied'

export type ApprovalKind = 'write' | 'edit' | 'shell' | 'mcp' | 'computer'

export interface ApprovalRequest {
  approvalId: string
  conversationId: string
  toolCallId: string
  kind: ApprovalKind
  toolName: string
  /** Short human summary, e.g. the command line or the file path. */
  summary: string
  /** Full detail, e.g. new file content or JSON arguments. */
  detail?: string
  serverName?: string
  /** Human-readable description of the persistent rule if user chooses Allow Always. */
  alwaysRuleLabel?: string
}

export type ApprovalDecision = 'allow' | 'allow_session' | 'allow_always' | 'deny'

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'Stop'

// ---- Events streamed from the agent to the UI ----

export type AgentEvent =
  | { type: 'turn_start'; conversationId: string }
  | { type: 'text_delta'; conversationId: string; text: string }
  | { type: 'reasoning_delta'; conversationId: string; text: string }
  | { type: 'tool_call'; conversationId: string; call: ToolCall; serverName?: string }
  | {
      type: 'tool_status'
      conversationId: string
      toolCallId: string
      status: ToolRunStatus
      output?: string
      images?: ImageAttachment[]
    }
  | {
      type: 'hook_event'
      conversationId: string
      event: HookEventName
      pluginName: string
      toolName?: string
      decision: 'allow' | 'block' | 'warn'
      message?: string
    }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'message_saved'; conversationId: string; message: Message }
  | { type: 'conversation_sync'; conversation: Conversation }
  | { type: 'queue_sync'; conversationId: string; items: QueuedMessage[] }
  | { type: 'compacting'; conversationId: string; active: boolean; auto?: boolean }
  | { type: 'error'; conversationId: string; message: string }
  | {
      type: 'turn_end'
      conversationId: string
      reason: 'done' | 'aborted' | 'error' | 'max_rounds' | 'truncated'
      truncation?: 'token_limit' | 'stream_interrupted'
    }

// ---- Marketplace ----

export interface MarketItem {
  id: string
  name: string
  title: string
  description: string
  version?: string
  repositoryUrl?: string
  websiteUrl?: string
  /** Ready-to-review configs, one per install method. */
  installs: InstallOption[]
}

export interface InstallOption {
  label: string
  config: Omit<McpServerConfig, 'id' | 'enabled'>
  /** Environment variables or headers the user must fill in. */
  inputs: InstallInput[]
  note?: string
}

export interface InstallInput {
  key: string
  /**
   * Where the value goes. For `arg`, every argument equal to `{{key}}` is
   * replaced with the value before the config is saved.
   */
  target: 'env' | 'header' | 'arg'
  description?: string
  required: boolean
  secret: boolean
  defaultValue?: string
}

export interface MarketSearchResult {
  items: MarketItem[]
  nextCursor?: string
}

export interface GithubPluginProposal {
  name: string
  displayName?: string
  version?: string
  description: string
  repoUrl: string
  skillNames: string[]
  commandNames: string[]
  ruleFiles: string[]
  mcpCount: number
}

export interface GithubImportResult {
  repo: string
  description?: string
  installs: InstallOption[]
  /** Files Atrium read to build the proposal. */
  sources: string[]
  plugin?: GithubPluginProposal
  warning?: string
}

// ---- Settings ----

export type ProxyMode = 'system' | 'custom' | 'none'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version?: string
  percent?: number
  releaseNotes?: string
  releaseDate?: string
  downloadSize?: number
  source?: 'auto' | 'manual'
  error?: string
  feedUrl?: string
  configured: boolean
  checkedAt?: number
}

export type AgentMode = 'auto' | 'manual' | 'accept_edits' | 'plan' | 'bypass'
export type ExecMode = Exclude<AgentMode, 'plan'>
export type WorkScene = 'work' | 'code'

export const AGENT_MODES: readonly AgentMode[] = ['auto', 'manual', 'accept_edits', 'plan', 'bypass']

export function normalizeAgentMode(mode: string | undefined, fallback: AgentMode = 'auto'): AgentMode {
  if (mode === 'auto' || mode === 'manual' || mode === 'accept_edits' || mode === 'plan' || mode === 'bypass') return mode
  if (mode === 'agent') return 'auto'
  return fallback
}

export interface RewindResult {
  conversation: Conversation
  draftText: string
  revertedFiles: string[]
}

export type SkillScope = 'workspace' | 'user' | 'plugin' | 'app'

export interface SkillInfo {
  name: string
  description: string
  scope: SkillScope
  source: string
  path: string
  dir: string
  enabled: boolean
  pluginId?: string
  pluginName?: string
  hasScripts?: boolean
  hasReferences?: boolean
}

export interface SkillDetail extends SkillInfo {
  content: string
  files: string[]
}

export interface SkillDraft {
  name: string
  description: string
  content: string
  scope?: 'workspace' | 'user'
}

export type PluginOrigin = 'claude-code' | 'codex' | 'antigravity' | 'github' | 'local' | 'workspace' | 'atrium'

export interface PluginMcpProposal {
  serverKey: string
  option: InstallOption
  unsupportedRuntime?: string
}

export interface PluginCandidate {
  key: string
  id: string
  name: string
  displayName?: string
  version?: string
  description: string
  author?: string
  homepage?: string
  repository?: string
  origin: PluginOrigin
  originLabel: string
  sourcePath: string
  skillNames: string[]
  commandNames: string[]
  ruleFiles: string[]
  mcpProposals: PluginMcpProposal[]
  hasHooks: boolean
  hasAppConnector: boolean
  warnings: string[]
  alreadyImported: boolean
  importedPluginId?: string
  recommended: boolean
}

export interface InstalledPlugin {
  id: string
  name: string
  displayName?: string
  version?: string
  description: string
  author?: string
  homepage?: string
  repository?: string
  origin: PluginOrigin
  originLabel: string
  sourcePath: string
  installDir: string
  enabled: boolean
  installedAt: number
  updatedAt: number
  skillNames: string[]
  commandNames: string[]
  ruleFiles: string[]
  mcpServerIds: string[]
  warnings?: string[]
}

export interface PluginDetail extends InstalledPlugin {
  files: string[]
  readme?: string
}

export interface PluginImportResult {
  installed: InstalledPlugin[]
  skipped: string[]
  createdMcpServers: McpServerConfig[]
  warnings: string[]
}

export type TranscriptWidth = 'narrow' | 'default' | 'wide'
export type TranscriptViewMode = 'normal' | 'thinking' | 'verbose'
export type CodeThemeLight = 'atrium' | 'github' | 'paper'
export type CodeThemeDark = 'atrium' | 'monokai' | 'nord'

export interface SceneUsageBreakdown {
  scene: WorkScene
  messages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
}

export interface UsageSummary {
  conversations: number
  userMessages: number
  assistantMessages: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  byProvider: Array<{
    providerId: string
    conversations: number
    inputTokens: number
    outputTokens: number
  }>
  byScene: {
    work: SceneUsageBreakdown
    code: SceneUsageBreakdown
  }
  untaggedSceneMessages: number
}

export type CliThemeId = 'warm-studio' | 'claude' | 'codex' | 'agy' | 'minimal'

export const CLI_THEME_IDS: readonly CliThemeId[] = ['warm-studio', 'claude', 'codex', 'agy', 'minimal']

export interface AppSettings {
  locale: 'system' | 'zh' | 'en'
  theme: 'system' | 'light' | 'dark'
  workspace?: string
  recentWorkspaces?: string[]
  activeProviderId?: string
  reasoningEffort?: ReasoningEffort
  onboarded: boolean
  proxyMode: ProxyMode
  proxyUrl?: string
  updateUrl?: string
  autoUpdate?: boolean
  skippedUpdateVersion?: string
  webEnabled?: boolean
  autoCompact?: boolean
  agentMode?: AgentMode
  lastExecMode?: ExecMode
  workScene?: WorkScene
  disabledSkills?: string[]
  transcriptWidth?: TranscriptWidth
  defaultTranscriptView?: TranscriptViewMode
  codeFont?: string
  codeFontSize?: number
  codeThemeLight?: CodeThemeLight
  codeThemeDark?: CodeThemeDark
  allowBypassPermissions?: boolean
  pluginDiscoveryDismissed?: boolean
  seenExternalPluginKeys?: string[]
  /** Keep core & scheduled automations running in the tray when all windows are closed. */
  runInBackground?: boolean
  /** OS-level sandbox enforcement for agent shell commands ('off' | 'workspace_write' | 'read_only'). */
  shellSandbox?: SandboxMode
  /** Whether sandboxed commands may access the network on Unix sandboxes (macOS/Linux). */
  sandboxAllowNetwork?: boolean
  /** Inject pinned and workspace-relevant long-term memories into system prompts. */
  memoryEnabled?: boolean
  /** Global accelerator to summon/hide the floating Quick Entry window (empty to disable). */
  quickEntryShortcut?: string
  /** Speech-to-text backend preference for voice dictation. */
  voiceMode?: VoiceMode
  /** Custom OpenAI-compatible Whisper base URL (e.g. https://api.openai.com/v1 or local whisper.cpp). */
  voiceEndpoint?: string
  /** Speech model name sent to `/audio/transcriptions` (e.g. whisper-1 / whisper-large-v3). */
  voiceModel?: string
  /** Preferred dictation language tag (e.g. zh-CN / en-US / auto). */
  voiceLanguage?: string
  /** Built-in browser dual mode ('edge' uses Bing/Edge UA for mainland China accessibility; 'google' uses Google/Chrome UA). */
  browserMode?: BrowserMode
  /** Enable Computer Use capabilities (prioritizes per-conversation built-in browser with Atrium's dedicated virtual cursor). */
  computerUseEnabled?: boolean
  /** Computer Use priority mode ('browser' = Built-in Browser first with Atrium virtual cursor; 'desktop' = allow direct OS desktop control). */
  computerUseMode?: ComputerUseMode
  /** Allow Atrium to directly control the physical OS desktop (`desktop_*` tools) in addition to built-in browser automation. */
  desktopControlEnabled?: boolean
  /** Persistent per-workspace tool/command allow rules saved via Allow Always. */
  allowedToolRules?: Record<string, string[]>
  /** Copy local root `.env*` config files automatically when creating a Git worktree. */
  copyEnvOnWorktree?: boolean
  /** Maximum tool-call rounds per assistant turn (10-100, default 40). */
  maxAgentRounds?: number
  /** Automatically extract durable preferences/facts into MemoryStore after substantive turns. */
  autoExtractMemory?: boolean
  /** Execute lifecycle hooks (PreToolUse / PostToolUse / Stop) declared by enabled plugins or workspace. */
  enablePluginHooks?: boolean
  /** Custom context window limit in tokens (0 or undefined = auto-detect from active model). */
  contextWindowTokens?: number
  /** Active CLI color theme identifier. */
  cliTheme?: CliThemeId
}

export const CONTEXT_WINDOW_PRESETS = [0, 64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000] as const

export function normalizeContextWindowTokens(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.max(32_000, Math.min(2_000_000, Math.round(raw)))
}

export function estimateModelContextLimit(model?: string): number {
  const m = (model ?? '').trim().toLowerCase()
  if (!m) return 200_000
  if (m.includes('gemini') || m.includes('1m') || m.includes('opus-5') || m.includes('sonnet-5')) {
    return 1_000_000
  }
  if (
    m.includes('deepseek-v4') ||
    m.includes('glm-5') ||
    m.includes('kimi-k2') ||
    m.includes('qwen3') ||
    m.includes('gpt-5') ||
    m.includes('claude')
  ) {
    return 200_000
  }
  if (m.includes('deepseek') || m.includes('glm') || m.includes('qwen') || m.includes('gpt-4')) {
    return 128_000
  }
  return 200_000
}

export function resolveEffectiveContextLimit(model?: string, customLimitTokens?: number): number {
  const custom = normalizeContextWindowTokens(customLimitTokens)
  return custom > 0 ? custom : estimateModelContextLimit(model)
}

// ---- Interactive Terminal & Background Processes ----

export type TerminalStatus = 'running' | 'exited'

export interface TerminalSessionInfo {
  id: string
  title: string
  cwd: string
  shell: string
  command?: string
  pid?: number
  status: TerminalStatus
  exitCode?: number | null
  createdAt: number
  startedBy: 'user' | 'agent'
  pty?: boolean
  cols?: number
  rows?: number
}

export type TerminalEvent =
  | { type: 'data'; id: string; chunk: string }
  | { type: 'state'; session: TerminalSessionInfo }
  | { type: 'closed'; id: string }

// ---- Local Scheduled Automations ----

export type AutomationSchedule =
  | { kind: 'interval'; minutes: number }
  | { kind: 'cron'; expr: string }

export interface AutomationRunRecord {
  runId: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'done' | 'error' | 'truncated' | 'aborted'
  conversationId?: string
  summary?: string
  error?: string
}

export interface AutomationRule {
  id: string
  name: string
  prompt: string
  workspace?: string
  useWorktree?: boolean
  agentMode?: 'auto' | 'plan' | 'manual'
  schedule: AutomationSchedule
  enabled: boolean
  notifyOnComplete?: boolean
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  nextRunAt?: number
  lastStatus?: AutomationRunRecord['status']
  lastConversationId?: string
  lastSummary?: string
  lastError?: string
  history?: AutomationRunRecord[]
}

export interface AutomationDraft {
  id?: string
  name: string
  prompt: string
  workspace?: string
  useWorktree?: boolean
  agentMode?: 'auto' | 'plan' | 'manual'
  schedule: AutomationSchedule
  enabled?: boolean
  notifyOnComplete?: boolean
}

export interface RuntimeInfo {
  id: 'node' | 'npx' | 'uvx' | 'python' | 'docker'
  found: boolean
  version?: string
}

// ---- P2: OS Command Sandbox ----

export type SandboxMode = 'off' | 'workspace_write' | 'read_only'

export interface SandboxCapabilities {
  platform: string
  supported: boolean
  backend: string
  details: string
}

// ---- P2: Cross-Session Memory & Project Knowledge Base ----

export type MemoryCategory = 'preference' | 'fact' | 'workflow' | 'decision'
export type MemoryScope = 'global' | 'workspace'

export interface MemoryItem {
  id: string
  content: string
  category: MemoryCategory
  scope: MemoryScope
  workspace?: string
  pinned?: boolean
  sourceChatId?: string
  createdAt: number
  updatedAt: number
}

export interface MemoryDraft {
  id?: string
  content: string
  category: MemoryCategory
  scope: MemoryScope
  workspace?: string
  pinned?: boolean
  sourceChatId?: string
}

export interface KnowledgeSource {
  id: string
  title: string
  kind: 'file' | 'note'
  path?: string
  docKind?: DocumentKind
  chunkCount: number
  charCount: number
  updatedAt: number
}

export interface KnowledgeHit {
  sourceId: string
  title: string
  path?: string
  section?: string
  score: number
  snippet: string
}

export interface KnowledgeStats {
  workspace?: string
  sourceCount: number
  chunkCount: number
  sources: KnowledgeSource[]
}

// ---- P2: Voice Dictation ----

export type VoiceMode = 'auto' | 'whisper' | 'system'

export interface SpeechTranscribeRequest {
  /** Base64 encoded 16kHz 16-bit mono PCM WAV audio for local OS or Whisper engines. */
  wavBase64?: string
  /** Fallback encoded audio blob if recorded compressed. */
  audioBase64?: string
  mimeType?: string
  language?: string
}

export interface SpeechTranscribeResult {
  text: string
  backend: 'whisper' | 'windows-speech'
}

// ---- P2: Built-in Chromium Browser Preview & Control ----

export interface BrowserElementRef {
  ref: string
  tag: string
  role: string
  text: string
  type?: string
  href?: string
  placeholder?: string
  value?: string
}

export type BrowserMode = 'edge' | 'google'

export type BrowserEngine = 'chrome-cdp' | 'edge-cdp' | 'electron'

export interface BrowserTabInfo {
  id: string
  title: string
  url: string
  active: boolean
}

export type ComputerUseMode = 'browser' | 'desktop'

export type BrowserCursorAction =
  | 'move'
  | 'hover'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'drag'
  | 'scroll'
  | 'type'
  | 'key'

export interface BrowserCursorState {
  x: number
  y: number
  xRatio: number
  yRatio: number
  endX?: number
  endY?: number
  endXRatio?: number
  endYRatio?: number
  action: BrowserCursorAction
  targetLabel?: string
  updatedAt: number
}

export interface BrowserActionInput {
  kind:
    | 'launch'
    | 'click'
    | 'clickPoint'
    | 'movePoint'
    | 'doubleClickPoint'
    | 'rightClickPoint'
    | 'dragPoint'
    | 'key'
    | 'type'
    | 'scroll'
    | 'back'
    | 'forward'
    | 'reload'
    | 'newTab'
    | 'switchTab'
    | 'closeTab'
    | 'setMode'
    | 'close'
  conversationId?: string
  ref?: string
  selector?: string
  text?: string
  tabId?: string
  mode?: BrowserMode
  deltaX?: number
  deltaY?: number
  x?: number
  y?: number
  endX?: number
  endY?: number
  xRatio?: number
  yRatio?: number
  endXRatio?: number
  endYRatio?: number
  button?: 'left' | 'right' | 'middle'
  doubleClick?: boolean
  key?: string
  submit?: boolean
}

export interface BrowserConsoleEntry {
  level: 'log' | 'warn' | 'error'
  text: string
  at: number
}

export interface BrowserViewLayout {
  conversationId?: string
  visible: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserSnapshot {
  conversationId?: string
  open: boolean
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  screenshotDataUrl?: string
  screenshotWidth?: number
  screenshotHeight?: number
  cursor?: BrowserCursorState
  elements: BrowserElementRef[]
  consoleLogs: BrowserConsoleEntry[]
  mode?: BrowserMode
  engine?: BrowserEngine
  browserLabel?: string
  tabs?: BrowserTabInfo[]
  popoutOpen?: boolean
  dockedLive?: boolean
  error?: string
}

// ---- OS Desktop Computer Use ----

export interface DesktopDisplayInfo {
  index: number
  id: string
  primary: boolean
  bounds: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  shotWidth: number
  shotHeight: number
}

export interface DesktopWindowInfo {
  hwnd: string
  title: string
  processName: string
  pid: number
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  maximized: boolean
  foreground: boolean
}

export interface DesktopSnapshot {
  displayIndex: number
  displays: DesktopDisplayInfo[]
  shotWidth: number
  shotHeight: number
  cursor: { x: number; y: number; inDisplay: boolean }
  windows: DesktopWindowInfo[]
  screenshotDataUrl?: string
  error?: string
}

export type DesktopMouseAction =
  | 'move'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'middle_click'
  | 'drag'
  | 'scroll'
  | 'down'
  | 'up'

export interface DesktopMouseInput {
  action: DesktopMouseAction
  x: number
  y: number
  endX?: number
  endY?: number
  deltaX?: number
  deltaY?: number
  button?: 'left' | 'right' | 'middle'
  displayIndex?: number
  captureAfter?: boolean
}

export interface DesktopKeyboardInput {
  action: 'type' | 'key' | 'hotkey'
  text?: string
  key?: string
  keys?: string[]
  displayIndex?: number
  captureAfter?: boolean
}

export interface DesktopWindowInput {
  action: 'list' | 'focus' | 'minimize' | 'maximize' | 'restore'
  handle?: string
  title?: string
  processName?: string
  displayIndex?: number
  captureAfter?: boolean
}

export interface ComputerUseHudState {
  active: boolean
  label?: string
  shortcut?: string
}
