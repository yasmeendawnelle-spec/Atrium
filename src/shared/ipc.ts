// The typed surface between renderer, main, and the core process.
// The preload exposes exactly these methods. Main forwards `CoreMethods` to the core process.
import type {
  AgentEvent,
  ApprovalDecision,
  AppSettings,
  AutomationDraft,
  AutomationRule,
  BrowserActionInput,
  BrowserMode,
  BrowserSnapshot,
  BrowserViewLayout,
  ComputerUseHudState,
  Conversation,
  ConversationMeta,
  DesktopKeyboardInput,
  DesktopMouseInput,
  DesktopSnapshot,
  DesktopWindowInput,
  DocumentAttachment,
  GitCommitResult,
  GitHubIssueSummary,
  GitPrUrlResult,
  GitPushResult,
  GithubImportResult,
  GitRepoStatus,
  KnowledgeHit,
  KnowledgeStats,
  MemoryDraft,
  MemoryItem,
  PickedFileResult,
  QueuedMessage,
  SkillDetail,
  SkillDraft,
  SkillInfo,
  ImageAttachment,
  InstalledPlugin,
  InstallOption,
  MarketSearchResult,
  McpPromptInfo,
  McpPromptResult,
  McpResourceContent,
  McpResourceInfo,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  PluginCandidate,
  PluginDetail,
  PluginImportResult,
  ProviderConfig,
  ProviderDraft,
  RechargeCreateOrderRequest,
  RechargeOrderInfo,
  RechargeOrderStatusResult,
  RelayPulseAccountState,
  RelayPulseOAuthResult,
  RewindResult,
  RuntimeInfo,
  SandboxCapabilities,
  SpeechTranscribeRequest,
  SpeechTranscribeResult,
  SubscriptionCategory,
  SubscriptionTierLevel,
  TerminalEvent,
  TerminalSessionInfo,
  UpdateState,
  UsageSummary,
  WorktreeMergeResult,
  WorkspaceChanges,
  WorkspaceFilePreview,
} from './types.ts'
import type {
  FleetDiffResult,
  FleetLaunchResult,
  FleetTaskDraft,
  FleetWorkerSnapshot,
  PolicyDecision,
  PolicyInspection,
  PreviewEvent,
  PreviewServerInfo,
  ProjectPolicyConfig,
} from './studio_features.ts'

export interface ProviderTestResult {
  ok: boolean
  error?: string
  models?: string[]
}

/** Methods implemented by the core process (src/core). */
export interface CoreMethods {
  'settings.get': () => AppSettings
  'settings.update': (patch: Partial<AppSettings>) => AppSettings

  'providers.list': () => ProviderConfig[]
  'providers.save': (draft: ProviderDraft) => ProviderConfig
  'providers.selectModel': (providerId: string, model: string) => { providers: ProviderConfig[]; settings: AppSettings }
  'providers.fetchModels': (target: ProviderDraft | string) => ProviderTestResult
  'providers.setModels': (providerId: string, models: string[], activeModel?: string) => ProviderConfig
  'providers.remove': (id: string) => void
  'providers.test': (draft: ProviderDraft) => ProviderTestResult

  'mcp.list': () => McpServerConfig[]
  'mcp.status': () => McpServerStatus[]
  'mcp.save': (config: Omit<McpServerConfig, 'id'> & { id?: string }) => McpServerConfig
  'mcp.remove': (id: string) => void
  'mcp.setEnabled': (id: string, enabled: boolean) => McpServerStatus
  'mcp.reconnect': (id: string) => McpServerStatus
  'mcp.test': (config: Omit<McpServerConfig, 'id' | 'enabled'> & { id?: string }) => McpTestResult
  'mcp.parseConfig': (text: string) => InstallOption[]
  'mcp.oauthStart': (id: string) => McpServerStatus
  'mcp.oauthRevoke': (id: string) => McpServerStatus
  'mcp.resources': () => Array<McpResourceInfo & { serverId: string; serverName: string }>
  'mcp.readResource': (serverId: string, uri: string) => McpResourceContent
  'mcp.prompts': () => Array<McpPromptInfo & { serverId: string; serverName: string }>
  'mcp.getPrompt': (serverId: string, name: string, args?: Record<string, string>) => McpPromptResult

  'terminal.list': () => TerminalSessionInfo[]
  'terminal.create': (opts?: { workspace?: string; title?: string; command?: string; cols?: number; rows?: number }) => TerminalSessionInfo
  'terminal.read': (id: string) => { session: TerminalSessionInfo; output: string }
  'terminal.write': (id: string, data: string) => void
  'terminal.resize': (id: string, cols: number, rows: number) => void
  'terminal.signal': (id: string, sig?: 'SIGINT' | 'SIGTERM') => void
  'terminal.clear': (id: string) => void
  'terminal.close': (id: string) => void

  'automations.list': () => AutomationRule[]
  'automations.save': (draft: AutomationDraft) => AutomationRule
  'automations.remove': (id: string) => void
  'automations.setEnabled': (id: string, enabled: boolean) => AutomationRule
  'automations.runNow': (id: string) => AutomationRule
  'automations.previewCron': (expr: string, count?: number) => { valid: boolean; nextRuns: number[]; error?: string }

  'market.search': (query: string, cursor?: string) => MarketSearchResult
  'market.importGithub': (url: string) => GithubImportResult

  'system.runtimes': () => RuntimeInfo[]
  'stats.usage': () => UsageSummary

  'chats.list': () => ConversationMeta[]
  'chats.get': (id: string) => Conversation | null
  'chats.create': (workspace?: string) => Conversation
  'chats.createWorktree': (baseWorkspace: string, branchName?: string) => Conversation
  'chats.fork': (id: string, messageIndex?: number, titleSuffix?: string) => Conversation
  'chats.remove': (id: string) => void
  'chats.rename': (id: string, title: string) => ConversationMeta
  'chats.setWorkspace': (id: string, workspace?: string) => ConversationMeta
  'chats.setProvider': (id: string, providerId?: string) => ConversationMeta
  'chats.setPinned': (id: string, pinned: boolean) => ConversationMeta
  'chats.setArchived': (id: string, archived: boolean) => ConversationMeta
  'chats.archiveGroup': (ids: string[], archived: boolean) => ConversationMeta[]
  'chats.rewind': (conversationId: string, messageIndex: number, revertFiles?: boolean) => RewindResult
  'agent.send': (conversationId: string, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]) => void
  'agent.enqueue': (conversationId: string, text: string, images?: ImageAttachment[], documents?: DocumentAttachment[]) => QueuedMessage[]
  'agent.cancelQueued': (conversationId: string, queuedId: string) => QueuedMessage[]
  'agent.steerQueued': (conversationId: string, queuedId: string) => void
  'agent.queueList': (conversationId: string) => QueuedMessage[]
  'agent.regenerate': (conversationId: string) => void
  'agent.compact': (conversationId: string) => Conversation
  'agent.stop': (conversationId: string) => void
  'agent.approve': (approvalId: string, decision: ApprovalDecision) => void
  'agent.allows': (workspace?: string) => string[]
  'agent.revokeAllows': (workspace?: string) => void
  'agent.allowedRules': (workspace?: string) => string[]
  'agent.revokeAllowedRule': (rule: string, workspace?: string) => string[]
  'workspace.files': (workspace?: string) => string[]
  'workspace.readPreview': (path: string, workspace?: string) => WorkspaceFilePreview
  'workspace.changes': (conversationId?: string, workspace?: string) => WorkspaceChanges
  'workspace.revertChange': (conversationId: string, path: string, workspace?: string) => WorkspaceChanges
  'workspace.revertAllChanges': (conversationId: string, workspace?: string) => WorkspaceChanges
  'workspace.gitInfo': (workspace?: string) => GitRepoStatus
  'workspace.gitCommit': (workspace: string, message: string, paths?: string[]) => GitCommitResult
  'workspace.gitStage': (workspace: string, paths: string[], staged: boolean) => WorkspaceChanges
  'workspace.gitCheckout': (workspace: string, branch: string, createNew?: boolean) => GitRepoStatus
  'workspace.gitPush': (workspace: string) => GitPushResult
  'workspace.gitPrUrl': (workspace: string, title?: string) => GitPrUrlResult
  'workspace.suggestCommitMessage': (workspace?: string, conversationId?: string) => string
  'workspace.gitMergeWorktree': (conversationId: string, opts?: { commitMessage?: string; cleanupWorktree?: boolean }) => WorktreeMergeResult
  'workspace.githubIssues': (workspace?: string, query?: string) => GitHubIssueSummary[]
  'workspace.saveArtifact': (path: string, content: string, workspace?: string) => { path: string }
  'skills.list': (workspace?: string) => SkillInfo[]
  'skills.get': (name: string, workspace?: string) => SkillDetail | null
  'skills.setEnabled': (name: string, enabled: boolean, workspace?: string) => SkillInfo[]
  'skills.create': (draft: SkillDraft, workspace?: string) => SkillInfo
  'skills.remove': (name: string, workspace?: string) => void
  'plugins.list': () => InstalledPlugin[]
  'plugins.get': (id: string) => PluginDetail | null
  'plugins.discover': (workspace?: string) => PluginCandidate[]
  'plugins.importLocal': (sourcePaths: string[]) => PluginImportResult
  'plugins.importFolder': (folderPath: string) => PluginImportResult
  'plugins.importGithub': (repoUrl: string) => PluginImportResult
  'plugins.setEnabled': (id: string, enabled: boolean) => InstalledPlugin[]
  'plugins.remove': (id: string) => void
  'sandbox.info': () => SandboxCapabilities
  'memory.list': (workspace?: string) => MemoryItem[]
  'memory.save': (draft: MemoryDraft) => MemoryItem
  'memory.remove': (id: string) => void
  'memory.extractFromChat': (conversationId: string) => MemoryItem[]
  'knowledge.status': (workspace?: string) => KnowledgeStats
  'knowledge.addFiles': (paths: string[], workspace?: string) => KnowledgeStats
  'knowledge.addNote': (title: string, content: string, workspace?: string) => KnowledgeStats
  'knowledge.remove': (sourceId: string, workspace?: string) => KnowledgeStats
  'knowledge.reindex': (workspace?: string) => KnowledgeStats
  'knowledge.search': (query: string, workspace?: string, topK?: number) => KnowledgeHit[]
  'speech.transcribe': (req: SpeechTranscribeRequest) => SpeechTranscribeResult
  'speech.saveKey': (apiKey: string | null) => { hasKey: boolean }
  'speech.hasKey': () => { hasKey: boolean }
  'browser.state': (conversationId?: string) => BrowserSnapshot
  'browser.open': (url: string, conversationId?: string) => BrowserSnapshot
  'browser.action': (action: BrowserActionInput, conversationId?: string) => BrowserSnapshot
  'browser.capture': (conversationId?: string) => BrowserSnapshot
  'policy.inspect': (workspace?: string) => PolicyInspection
  'policy.save': (workspace: string | undefined, scope: 'project' | 'local', config: ProjectPolicyConfig) => PolicyInspection
  'policy.checkPath': (workspace: string | undefined, path: string, op: 'read' | 'write') => PolicyDecision
  'preview.list': (conversationId?: string) => PreviewServerInfo[]
  'preview.start': (opts: {
    workspace?: string
    command: string
    conversationId?: string
    url?: string
    port?: number
  }) => { server: PreviewServerInfo; ready: boolean; logTail: string }
  'preview.logs': (serverId: string) => { server: PreviewServerInfo; logs: string } | null
  'preview.stop': (serverId: string) => boolean
  'fleet.list': (baseWorkspace?: string) => FleetWorkerSnapshot[]
  'fleet.launch': (opts: { baseWorkspace?: string; tasks: FleetTaskDraft[] }) => FleetLaunchResult
  'fleet.diff': (conversationId: string) => FleetDiffResult
  'fleet.merge': (conversationId: string, opts?: { commitMessage?: string; cleanupWorktree?: boolean }) => WorktreeMergeResult
  'fleet.discard': (conversationId: string) => void
  'fleet.stopAll': (baseWorkspace?: string) => number
  'account.state': () => RelayPulseAccountState
  'account.refresh': () => RelayPulseAccountState
  'account.setOrigin': (
    origin: string,
    options?: { acceptStagingRisk?: boolean },
  ) => RelayPulseAccountState
  'account.sendCode': (email: string) => { ok: boolean; message: string }
  'account.loginEmail': (req: {
    email: string
    code?: string
    password?: string
    newPassword?: string
  }) => RelayPulseAccountState
  'account.resetPassword': (req: {
    email: string
    code: string
    newPassword: string
  }) => { ok: boolean; message: string; state: RelayPulseAccountState }
  'account.updatePassword': (req: {
    oldPassword?: string
    newPassword: string
  }) => { ok: boolean; message: string; state: RelayPulseAccountState }
  'account.oauthStart': (provider: 'google' | 'github') => RelayPulseOAuthResult
  'account.oauthBindEmail': (req: { pendingToken: string; email: string; code: string }) => RelayPulseAccountState
  'account.redeem': (code: string) => { ok: boolean; message: string; state: RelayPulseAccountState }
  'account.createRechargeOrder': (req: RechargeCreateOrderRequest) => RechargeOrderInfo
  'account.checkRechargeOrder': (outTradeNo: string) => RechargeOrderStatusResult
  'account.reportRechargePaid': (outTradeNo: string) => { ok: boolean; message: string }
  'account.setKeyGroup': (group: string) => RelayPulseAccountState
  'account.subscribeCategory': (req: {
    category: SubscriptionCategory
    level: SubscriptionTierLevel
    switchKeyGroup?: boolean
  }) => {
    ok: boolean
    message: string
    source: 'remote' | 'atrium'
    state: RelayPulseAccountState
  }
  'account.cancelCategorySubscription': (category: SubscriptionCategory) => RelayPulseAccountState
  'account.setAvatar': (avatar: string | null) => RelayPulseAccountState
  'account.syncModels': () => RelayPulseAccountState
  'account.logout': () => RelayPulseAccountState
}

export type CoreMethod = keyof CoreMethods

export const CORE_METHODS: readonly CoreMethod[] = [
  'settings.get',
  'settings.update',
  'providers.list',
  'providers.save',
  'providers.selectModel',
  'providers.fetchModels',
  'providers.setModels',
  'providers.remove',
  'providers.test',
  'mcp.list',
  'mcp.status',
  'mcp.save',
  'mcp.remove',
  'mcp.setEnabled',
  'mcp.reconnect',
  'mcp.test',
  'mcp.parseConfig',
  'mcp.oauthStart',
  'mcp.oauthRevoke',
  'terminal.list',
  'terminal.create',
  'terminal.read',
  'terminal.write',
  'terminal.signal',
  'terminal.clear',
  'terminal.close',
  'automations.list',
  'automations.save',
  'automations.remove',
  'automations.setEnabled',
  'automations.runNow',
  'automations.previewCron',
  'market.search',
  'market.importGithub',
  'system.runtimes',
  'stats.usage',
  'chats.list',
  'chats.get',
  'chats.create',
  'chats.createWorktree',
  'chats.fork',
  'chats.remove',
  'chats.rename',
  'chats.setWorkspace',
  'chats.setProvider',
  'chats.setPinned',
  'chats.setArchived',
  'chats.archiveGroup',
  'chats.rewind',
  'agent.send',
  'agent.enqueue',
  'agent.cancelQueued',
  'agent.steerQueued',
  'agent.queueList',
  'agent.regenerate',
  'agent.compact',
  'agent.stop',
  'agent.approve',
  'agent.allows',
  'agent.revokeAllows',
  'agent.allowedRules',
  'agent.revokeAllowedRule',
  'workspace.files',
  'workspace.readPreview',
  'workspace.changes',
  'workspace.revertChange',
  'workspace.revertAllChanges',
  'workspace.gitInfo',
  'workspace.gitCommit',
  'workspace.gitStage',
  'workspace.gitCheckout',
  'workspace.gitPush',
  'workspace.gitPrUrl',
  'workspace.suggestCommitMessage',
  'workspace.gitMergeWorktree',
  'workspace.githubIssues',
  'workspace.saveArtifact',
  'skills.list',
  'skills.get',
  'skills.setEnabled',
  'skills.create',
  'skills.remove',
  'plugins.list',
  'plugins.get',
  'plugins.discover',
  'plugins.importLocal',
  'plugins.importFolder',
  'plugins.importGithub',
  'plugins.setEnabled',
  'plugins.remove',
  'sandbox.info',
  'memory.list',
  'memory.save',
  'memory.remove',
  'memory.extractFromChat',
  'knowledge.status',
  'knowledge.addFiles',
  'knowledge.addNote',
  'knowledge.remove',
  'knowledge.reindex',
  'knowledge.search',
  'speech.transcribe',
  'speech.saveKey',
  'speech.hasKey',
  'browser.state',
  'browser.open',
  'browser.action',
  'browser.capture',
  'policy.inspect',
  'policy.save',
  'policy.checkPath',
  'preview.list',
  'preview.start',
  'preview.logs',
  'preview.stop',
  'fleet.list',
  'fleet.launch',
  'fleet.diff',
  'fleet.merge',
  'fleet.discard',
  'fleet.stopAll',
  'account.state',
  'account.refresh',
  'account.setOrigin',
  'account.sendCode',
  'account.loginEmail',
  'account.resetPassword',
  'account.updatePassword',
  'account.oauthStart',
  'account.oauthBindEmail',
  'account.redeem',
  'account.createRechargeOrder',
  'account.checkRechargeOrder',
  'account.reportRechargePaid',
  'account.setKeyGroup',
  'account.subscribeCategory',
  'account.cancelCategorySubscription',
  'account.setAvatar',
  'account.syncModels',
  'account.logout',
]

/** Methods the core process calls on main (things only main can do). */
export interface HostMethods {
  'secrets.get': (key: string) => string | null
  'secrets.set': (key: string, value: string | null) => void
  /** Chromium's proxy decision for a URL, e.g. "PROXY 127.0.0.1:7897" or "DIRECT". */
  'net.resolveProxy': (url: string) => string
  'app.openExternal': (url: string) => void
  'app.focusMain': () => void
  'app.notify': (opts: { title: string; body: string; conversationId?: string }) => void
  'app.setBackgroundActive': (active: boolean) => void
  'app.updateQuickShortcut': (shortcut: string) => { ok: boolean; error?: string }
  'browser.state': (conversationId?: string) => BrowserSnapshot
  'browser.open': (url: string, conversationId?: string) => BrowserSnapshot
  'browser.action': (action: BrowserActionInput, conversationId?: string) => BrowserSnapshot
  'browser.capture': (conversationId?: string) => BrowserSnapshot
  'browser.eval': (script: string, conversationId?: string) => { value: string; isError?: boolean }
  'browser.setMode': (mode: BrowserMode, conversationId?: string) => BrowserSnapshot
  'computer.screenshot': (opts?: { displayIndex?: number; hideAtrium?: boolean }) => DesktopSnapshot
  'computer.mouse': (input: DesktopMouseInput) => DesktopSnapshot
  'computer.keyboard': (input: DesktopKeyboardInput) => DesktopSnapshot
  'computer.window': (input: DesktopWindowInput) => DesktopSnapshot
  'computer.wait': (opts?: { seconds?: number; displayIndex?: number }) => DesktopSnapshot
  'computer.setHud': (state: ComputerUseHudState) => void
}

/** Events pushed from the core (or main) to the renderer. */
export type CoreEvent =
  | { channel: 'agent'; payload: AgentEvent }
  | { channel: 'mcp'; payload: McpServerStatus }
  | { channel: 'chats'; payload: ConversationMeta[] }
  | { channel: 'terminal'; payload: TerminalEvent }
  | { channel: 'automations'; payload: AutomationRule[] }
  | { channel: 'memory'; payload: MemoryItem[] }
  | { channel: 'knowledge'; payload: KnowledgeStats }
  | { channel: 'browser'; payload: BrowserSnapshot }
  | { channel: 'preview'; payload: PreviewEvent }
  | { channel: 'account'; payload: RelayPulseAccountState }
  | { channel: 'app'; payload: { action: 'open_chat'; conversationId: string } | { action: 'focus_quick_input' } }
  /** Sent by main when application auto-update state changes. */
  | { channel: 'updater'; payload: UpdateState }
  /** Sent by the preload after the core restarted, so the UI reloads its data. */
  | { channel: 'core'; payload: { state: 'reconnected' } }

/** Methods implemented in main itself (not forwarded to core). */
export interface ShellMethods {
  'app.pickFolder': () => string | null
  'app.pickFiles': (workspace?: string) => PickedFileResult[]
  'app.inspectFiles': (paths: string[], workspace?: string) => PickedFileResult[]
  'app.openExternal': (url: string) => void
  'app.revealPath': (targetPath: string, workspace?: string) => void
  'app.openInEditor': (targetPath: string, workspace?: string) => { editor: string }
  'app.stageArtifact': (html: string) => string
  'app.info': () => { version: string; platform: string; userData: string; encryption: boolean }
  'app.newWindow': () => void
  'app.updateState': () => UpdateState
  'app.checkUpdates': (feedUrl?: string) => UpdateState
  'app.downloadUpdate': () => UpdateState
  'app.installUpdate': () => void
  'app.captureScreen': () => ImageAttachment | null
  'app.quickOpenChat': (conversationId: string) => void
  'app.quickHide': () => void
  'app.quickResize': (height: number) => void
  'app.openBrowserWindow': (url?: string) => void
  'app.syncBrowserView': (layout: BrowserViewLayout | null) => void
  'app.dockBrowserView': () => void
}

type Promisify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never
}

export interface AtriumApi {
  call<M extends CoreMethod>(method: M, ...args: Parameters<CoreMethods[M]>): Promise<ReturnType<CoreMethods[M]>>
  shell: Promisify<{
    pickFolder: ShellMethods['app.pickFolder']
    pickFiles: ShellMethods['app.pickFiles']
    inspectFiles: ShellMethods['app.inspectFiles']
    openExternal: ShellMethods['app.openExternal']
    revealPath: ShellMethods['app.revealPath']
    openInEditor: ShellMethods['app.openInEditor']
    stageArtifact: ShellMethods['app.stageArtifact']
    info: ShellMethods['app.info']
    newWindow: ShellMethods['app.newWindow']
    updateState: ShellMethods['app.updateState']
    checkUpdates: ShellMethods['app.checkUpdates']
    downloadUpdate: ShellMethods['app.downloadUpdate']
    installUpdate: ShellMethods['app.installUpdate']
    captureScreen: ShellMethods['app.captureScreen']
    quickOpenChat: ShellMethods['app.quickOpenChat']
    quickHide: ShellMethods['app.quickHide']
    quickResize: ShellMethods['app.quickResize']
    openBrowserWindow: ShellMethods['app.openBrowserWindow']
    syncBrowserView: ShellMethods['app.syncBrowserView']
    dockBrowserView: ShellMethods['app.dockBrowserView']
  }> & {
    /** Tells main to recolour the window buttons (Windows and Linux) after a theme change. */
    setTitleBarTheme(dark: boolean): void
    /** Resolves a dropped File object's native path under contextIsolation. */
    pathForFile(file: unknown): string
  }
  onEvent(listener: (event: CoreEvent) => void): () => void
}
