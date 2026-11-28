import type { FileChangeEntry, ReasoningEffort } from './types.ts'

export type PlatformAgentKind =
  | 'atrium'
  | 'claude-code'
  | 'agy'
  | 'codex'
  | 'gemini-cli'
  | 'dsh'
  | 'opencode'
  | 'aider'
  | 'custom'

export type PlatformPermissionMode = 'plan' | 'accept_edits' | 'full_auto'
export type PlatformAgentRole = 'commander' | 'worker' | 'reviewer' | 'disabled'
export type PlatformTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface PlatformModelOption {
  id: string
  label?: string
  hint?: string
  providerId?: string
  group?: string
}

export interface PlatformAgentProfile {
  id: string
  kind: PlatformAgentKind
  name: string
  shortName: string
  description: string
  available: boolean
  binaryPath?: string
  version?: string
  defaultModel?: string
  availableModels?: PlatformModelOption[]
  detectedAt: number
  supportsMcpInjection: boolean
  supportsStreamJson: boolean
  supportsResume: boolean
  supportsCliConfigSync?: boolean
  supportsReasoningEffort?: boolean
  cliConfigPath?: string
  endpointLabel?: string
  defaultReasoningEffort?: ReasoningEffort
  reasoningEffortOverride?: ReasoningEffort
  role: PlatformAgentRole
  permissionMode: PlatformPermissionMode
  modelOverride?: string
  modelProviderOverride?: string
  customCommand?: string
  customArgs?: string[]
  accentColor: string
  installHint?: string
}

export interface PlatformAgentUpdatePatch {
  role?: PlatformAgentRole
  permissionMode?: PlatformPermissionMode
  modelOverride?: string
  modelProviderOverride?: string
  reasoningEffortOverride?: ReasoningEffort | ''
  syncToCliConfig?: boolean
  binaryPath?: string
}

export interface PlatformCustomAgentDraft {
  id?: string
  name: string
  command: string
  args: string[]
  description?: string
  permissionMode?: PlatformPermissionMode
}

export interface PlatformLogEntry {
  id: string
  ts: number
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'system' | 'error'
  title?: string
  content: string
}

export interface PlatformTask {
  id: string
  sessionId: string
  parentTaskId?: string
  depth: number
  fromAgentId: string
  agentId: string
  agentName: string
  prompt: string
  cwd: string
  worktreePath?: string
  worktreeBranch?: string
  worktreeBaseBranch?: string
  worktreeBaseWorkspace?: string
  permissionMode: PlatformPermissionMode
  model?: string
  providerId?: string
  reasoningEffort?: ReasoningEffort
  status: PlatformTaskStatus
  nativeSessionId?: string
  output: string
  thinking?: string
  error?: string
  logs: PlatformLogEntry[]
  changedFiles: string[]
  startedAt: number
  endedAt?: number
}

export interface PlatformBoardNote {
  id: string
  ts: number
  authorAgentId: string
  authorName: string
  kind: 'plan' | 'update' | 'handoff' | 'lock' | 'review'
  title: string
  content: string
  taskId?: string
}

export interface PlatformSession {
  id: string
  title: string
  workspace: string
  commanderId: string
  workerIds: string[]
  useWorktrees: boolean
  maxDepth: number
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped'
  rootTaskId?: string
  tasks: PlatformTask[]
  board: PlatformBoardNote[]
  createdAt: number
  updatedAt: number
}

export interface PlatformSessionSummary {
  id: string
  title: string
  workspace: string
  commanderId: string
  workerIds: string[]
  useWorktrees: boolean
  status: PlatformSession['status']
  taskCount: number
  runningCount: number
  createdAt: number
  updatedAt: number
}

export interface PlatformStartSessionRequest {
  workspace?: string
  prompt: string
  commanderId?: string
  workerIds?: string[]
  useWorktrees?: boolean
  maxDepth?: number
  title?: string
}

export interface PlatformTaskDiffResult {
  taskId: string
  cwd: string
  isWorktree: boolean
  branch?: string
  baseBranch?: string
  items: FileChangeEntry[]
}

export type PlatformEvent =
  | { type: 'agents'; agents: PlatformAgentProfile[] }
  | { type: 'session_update'; session: PlatformSession }
  | { type: 'sessions_list'; sessions: PlatformSessionSummary[] }
  | { type: 'task_log'; sessionId: string; taskId: string; entry: PlatformLogEntry }
  | { type: 'task_delta'; sessionId: string; taskId: string; field: 'output' | 'thinking'; delta: string }
