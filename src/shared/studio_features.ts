// Shared types for Project Security Policy, Managed Dev-Server Preview, and Parallel Worktree Fleet.
import type { FileChangeEntry, SandboxMode } from './types.ts'

// ---- Project Security Policy (.atrium/policy.json & .atrium/policy.local.json) ----

export interface ProjectPolicyConfig {
  version?: 1
  protectSensitiveFiles?: boolean
  denyRead?: string[]
  allowRead?: string[]
  denyWrite?: string[]
  allowWrite?: string[]
  denyCommands?: string[]
  allowCommands?: string[]
  sandboxMode?: SandboxMode
  allowNetwork?: boolean
}

export interface PolicySourceInfo {
  path: string
  exists: boolean
  parseError?: string
}

export interface PolicyInspection {
  workspace?: string
  projectFile: PolicySourceInfo
  localFile: PolicySourceInfo
  protectSensitiveFiles: boolean
  defaultSensitiveGlobs: string[]
  defaultSafeExceptions: string[]
  effective: {
    protectSensitiveFiles: boolean
    denyRead: string[]
    allowRead: string[]
    denyWrite: string[]
    allowWrite: string[]
    denyCommands: string[]
    allowCommands: string[]
    sandboxMode?: SandboxMode
    allowNetwork?: boolean
  }
  projectConfig: ProjectPolicyConfig
  localConfig: ProjectPolicyConfig
  activeRuleCount: number
}

export interface PolicyDecision {
  allowed: boolean
  reason?: string
  matchedRule?: string
  source?: 'default' | 'project' | 'local'
}

// ---- Managed Local Dev-Server Preview ----

export type PreviewServerStatus = 'starting' | 'running' | 'stopped' | 'error'

export interface PreviewServerInfo {
  id: string
  conversationId?: string
  workspace: string
  command: string
  url?: string
  port?: number
  status: PreviewServerStatus
  pid?: number
  startedAt: number
  stoppedAt?: number
  exitCode?: number | null
  error?: string
}

export type PreviewEvent = {
  type: 'list'
  servers: PreviewServerInfo[]
}

// ---- Multi-Agent Parallel Worktree Fleet ----

export type FleetWorkerStatus = 'running' | 'waiting_approval' | 'idle' | 'error'

export interface FleetTaskDraft {
  prompt: string
  branchName?: string
  title?: string
}

export interface FleetWorkerSnapshot {
  conversationId: string
  title: string
  baseWorkspace: string
  worktreePath: string
  branch: string
  baseBranch?: string
  status: FleetWorkerStatus
  pendingApprovals: number
  messageCount: number
  changedFiles: number
  additions: number
  deletions: number
  lastSnippet?: string
  updatedAt: number
  createdAt: number
  previewUrl?: string
}

export interface FleetDiffResult {
  worker: FleetWorkerSnapshot
  files: FileChangeEntry[]
}

export interface FleetLaunchResult {
  launched: Array<{
    conversationId: string
    branch: string
    worktreePath: string
    title: string
  }>
  errors: Array<{
    index: number
    prompt: string
    error: string
  }>
}
