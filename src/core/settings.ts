// App settings and provider configs. API keys never touch these files.
import { join } from 'node:path'
import {
  normalizeAgentMode,
  normalizeContextWindowTokens,
  type AppSettings,
  type ProviderConfig,
  type ProviderDraft,
} from '../shared/types.ts'
import { configureNetwork } from './net.ts'
import { getSecret, secretKey, setSecret } from './secrets.ts'
import { newId, readJson, removeFile, writeJson } from './store.ts'

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'system',
  theme: 'system',
  recentWorkspaces: [],
  onboarded: false,
  proxyMode: 'system',
  autoUpdate: false,
  webEnabled: true,
  autoCompact: true,
  agentMode: 'auto',
  lastExecMode: 'auto',
  workScene: 'code',
  disabledSkills: [],
  transcriptWidth: 'default',
  defaultTranscriptView: 'normal',
  codeFontSize: 13,
  codeThemeLight: 'atrium',
  codeThemeDark: 'atrium',
  allowBypassPermissions: true,
  shellSandbox: 'off',
  sandboxAllowNetwork: true,
  memoryEnabled: true,
  quickEntryShortcut: 'Alt+Space',
  voiceMode: 'auto',
  voiceModel: 'whisper-1',
  voiceLanguage: 'auto',
  computerUseEnabled: true,
  computerUseMode: 'browser',
  desktopControlEnabled: false,
  copyEnvOnWorktree: true,
  maxAgentRounds: 40,
  autoExtractMemory: true,
  enablePluginHooks: false,
  contextWindowTokens: 0,
}

interface ProviderRecord extends Omit<ProviderConfig, 'hasKey'> {
  /** Present only so the renderer can be told whether a key exists. */
  hasKey: boolean
}

export function normalizeProviderModels(activeModel: string, rawModels?: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (m: string | undefined) => {
    const clean = typeof m === 'string' ? m.trim() : ''
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  if (Array.isArray(rawModels)) {
    for (const m of rawModels) push(m)
  }
  push(activeModel)
  return out
}

export class SettingsStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private providers: ProviderRecord[] = []
  private dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private settingsPath(): string {
    return join(this.dir, 'settings.json')
  }

  private providersPath(): string {
    return join(this.dir, 'providers.json')
  }

  async load(): Promise<void> {
    const saved = await readJson(this.settingsPath(), {} as Partial<AppSettings>)
    const normalized = normalizeAgentMode(saved.agentMode, DEFAULT_SETTINGS.agentMode!)
    const allowBypass = saved.allowBypassPermissions !== false
    const safeMode = !allowBypass && normalized === 'bypass' ? 'auto' : normalized
    const rawLastExec = normalized !== 'plan' ? normalized : (saved.lastExecMode ?? 'auto')
    const safeLastExec = !allowBypass && rawLastExec === 'bypass' ? 'auto' : rawLastExec
    const rawRounds = typeof saved.maxAgentRounds === 'number' && Number.isFinite(saved.maxAgentRounds)
      ? Math.max(10, Math.min(100, Math.floor(saved.maxAgentRounds)))
      : DEFAULT_SETTINGS.maxAgentRounds
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      allowBypassPermissions: allowBypass,
      agentMode: safeMode,
      lastExecMode: safeLastExec,
      workScene: saved.workScene === 'work' ? 'work' : 'code',
      maxAgentRounds: rawRounds,
      ...(saved.browserMode === 'edge' || saved.browserMode === 'google' ? { browserMode: saved.browserMode } : { browserMode: undefined }),
    }
    const desktopControl =
      saved.computerUseMode === 'desktop'
        ? true
        : saved.computerUseMode === 'browser'
          ? Boolean(saved.desktopControlEnabled)
          : Boolean(saved.desktopControlEnabled)
    this.settings.desktopControlEnabled = desktopControl
    this.settings.computerUseMode = saved.computerUseMode === 'desktop' || desktopControl ? 'desktop' : 'browser'
    this.settings.contextWindowTokens = normalizeContextWindowTokens(saved.contextWindowTokens)
    this.providers = await readJson(this.providersPath(), [] as ProviderRecord[])
    this.applyNetwork()
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next: AppSettings = { ...this.settings, ...patch }
    if (patch.agentMode !== undefined) {
      const normalized = normalizeAgentMode(patch.agentMode, this.settings.agentMode ?? 'auto')
      next.agentMode = normalized
      if (normalized !== 'plan' && patch.lastExecMode === undefined) {
        next.lastExecMode = normalized
      }
    }
    if (patch.workspace !== undefined) {
      const folder = patch.workspace.trim()
      if (!folder) {
        next.workspace = undefined
      } else {
        next.workspace = folder
        const norm = (item: string) => (process.platform === 'win32' ? item.toLowerCase() : item)
        const key = norm(folder)
        if (patch.recentWorkspaces === undefined) {
          const existing = this.settings.recentWorkspaces ?? []
          const idx = existing.findIndex((item) => norm(item) === key)
          if (idx >= 0) {
            const updated = [...existing]
            updated[idx] = folder
            next.recentWorkspaces = updated.slice(0, 24)
          } else {
            next.recentWorkspaces = [folder, ...existing].slice(0, 24)
          }
        } else {
          const seen = new Set<string>()
          const deduped: string[] = []
          for (const item of patch.recentWorkspaces) {
            const k = norm(item)
            if (seen.has(k)) continue
            seen.add(k)
            deduped.push(k === key ? folder : item)
          }
          if (!seen.has(key)) deduped.unshift(folder)
          next.recentWorkspaces = deduped.slice(0, 24)
        }
      }
    } else if (patch.recentWorkspaces !== undefined) {
      const norm = (item: string) => (process.platform === 'win32' ? item.toLowerCase() : item)
      const seen = new Set<string>()
      const deduped: string[] = []
      for (const item of patch.recentWorkspaces) {
        const clean = item.trim()
        if (!clean) continue
        const k = norm(clean)
        if (seen.has(k)) continue
        seen.add(k)
        deduped.push(clean)
      }
      next.recentWorkspaces = deduped.slice(0, 24)
    }
    if (patch.updateUrl !== undefined) {
      next.updateUrl = patch.updateUrl.trim() || undefined
    }
    if (patch.codeFont !== undefined) {
      next.codeFont = patch.codeFont.trim() || undefined
    }
    if (patch.codeFontSize !== undefined) {
      const n = Number(patch.codeFontSize)
      next.codeFontSize = Number.isFinite(n) ? Math.min(16, Math.max(12, Math.round(n))) : DEFAULT_SETTINGS.codeFontSize
    }
    if (patch.maxAgentRounds !== undefined) {
      const n = Number(patch.maxAgentRounds)
      next.maxAgentRounds = Number.isFinite(n)
        ? Math.max(10, Math.min(100, Math.floor(n)))
        : DEFAULT_SETTINGS.maxAgentRounds
    }
    if (patch.contextWindowTokens !== undefined) {
      next.contextWindowTokens = normalizeContextWindowTokens(patch.contextWindowTokens)
    }
    if (patch.transcriptWidth !== undefined) {
      next.transcriptWidth =
        patch.transcriptWidth === 'narrow' || patch.transcriptWidth === 'wide' ? patch.transcriptWidth : 'default'
    }
    if (patch.defaultTranscriptView !== undefined) {
      next.defaultTranscriptView =
        patch.defaultTranscriptView === 'thinking' || patch.defaultTranscriptView === 'verbose'
          ? patch.defaultTranscriptView
          : 'normal'
    }
    if (patch.codeThemeLight !== undefined) {
      next.codeThemeLight =
        patch.codeThemeLight === 'github' || patch.codeThemeLight === 'paper' ? patch.codeThemeLight : 'atrium'
    }
    if (patch.codeThemeDark !== undefined) {
      next.codeThemeDark =
        patch.codeThemeDark === 'monokai' || patch.codeThemeDark === 'nord' ? patch.codeThemeDark : 'atrium'
    }
    if (next.allowBypassPermissions === false && next.agentMode === 'bypass') {
      next.agentMode = 'auto'
      next.lastExecMode = 'auto'
    }
    if (patch.skippedUpdateVersion !== undefined) {
      next.skippedUpdateVersion = patch.skippedUpdateVersion.trim() || undefined
    }
    if (patch.shellSandbox !== undefined) {
      next.shellSandbox =
        patch.shellSandbox === 'workspace_write' || patch.shellSandbox === 'read_only' ? patch.shellSandbox : 'off'
    }
    if (patch.quickEntryShortcut !== undefined) {
      next.quickEntryShortcut = patch.quickEntryShortcut.trim()
    }
    if (patch.voiceMode !== undefined) {
      next.voiceMode = patch.voiceMode === 'whisper' || patch.voiceMode === 'system' ? patch.voiceMode : 'auto'
    }
    if (patch.voiceEndpoint !== undefined) {
      next.voiceEndpoint = patch.voiceEndpoint.trim().replace(/\/+$/, '') || undefined
    }
    if (patch.voiceModel !== undefined) {
      next.voiceModel = patch.voiceModel.trim() || 'whisper-1'
    }
    if (patch.voiceLanguage !== undefined) {
      next.voiceLanguage = patch.voiceLanguage.trim() || 'auto'
    }
    if (patch.browserMode !== undefined) {
      next.browserMode = patch.browserMode === 'edge' ? 'edge' : 'google'
    }
    if (patch.computerUseEnabled !== undefined) {
      next.computerUseEnabled = Boolean(patch.computerUseEnabled)
    }
    if (patch.computerUseMode !== undefined) {
      next.computerUseMode = patch.computerUseMode === 'desktop' ? 'desktop' : 'browser'
      if (patch.desktopControlEnabled === undefined) {
        next.desktopControlEnabled = next.computerUseMode === 'desktop'
      }
    }
    if (patch.desktopControlEnabled !== undefined) {
      next.desktopControlEnabled = Boolean(patch.desktopControlEnabled)
      if (patch.computerUseMode === undefined) {
        next.computerUseMode = next.desktopControlEnabled ? 'desktop' : 'browser'
      }
    }
    if (patch.copyEnvOnWorktree !== undefined) {
      next.copyEnvOnWorktree = Boolean(patch.copyEnvOnWorktree)
    }
    if (patch.allowedToolRules !== undefined) {
      const cleaned: Record<string, string[]> = {}
      for (const [scope, rules] of Object.entries(patch.allowedToolRules)) {
        if (!Array.isArray(rules)) continue
        const dedup = [...new Set(rules.map((r) => String(r).trim()).filter(Boolean))]
        if (dedup.length > 0) cleaned[scope] = dedup
      }
      next.allowedToolRules = cleaned
    }
    this.settings = next
    await writeJson(this.settingsPath(), this.settings)
    this.applyNetwork()
    return this.get()
  }

  private scopeRuleKey(workspace?: string): string {
    if (!workspace?.trim()) return '__global__'
    const clean = workspace.trim()
    return process.platform === 'win32' ? clean.toLowerCase() : clean
  }

  allowedRulesFor(workspace?: string): string[] {
    const key = this.scopeRuleKey(workspace)
    return [...(this.settings.allowedToolRules?.[key] ?? [])]
  }

  async addAllowedRule(workspace: string | undefined, rule: string): Promise<string[]> {
    const clean = rule.trim()
    if (!clean) return this.allowedRulesFor(workspace)
    const key = this.scopeRuleKey(workspace)
    const current = this.settings.allowedToolRules?.[key] ?? []
    if (current.includes(clean)) return [...current]
    const nextMap = { ...(this.settings.allowedToolRules ?? {}), [key]: [...current, clean] }
    await this.update({ allowedToolRules: nextMap })
    return nextMap[key]!
  }

  async removeAllowedRule(workspace: string | undefined, rule: string): Promise<string[]> {
    const key = this.scopeRuleKey(workspace)
    const current = this.settings.allowedToolRules?.[key] ?? []
    const nextList = current.filter((r) => r !== rule)
    const nextMap = { ...(this.settings.allowedToolRules ?? {}) }
    if (nextList.length > 0) nextMap[key] = nextList
    else delete nextMap[key]
    await this.update({ allowedToolRules: nextMap })
    return nextList
  }

  private applyNetwork(): void {
    configureNetwork({ mode: this.settings.proxyMode, url: this.settings.proxyUrl })
  }

  listProviders(): ProviderConfig[] {
    return this.providers.map((p) => ({
      ...p,
      models: normalizeProviderModels(p.model, p.models),
    }))
  }

  getProvider(id: string): ProviderRecord | undefined {
    const found = this.providers.find((p) => p.id === id)
    return found ? { ...found, models: normalizeProviderModels(found.model, found.models) } : undefined
  }

  activeProvider(): ProviderRecord | undefined {
    const id = this.settings.activeProviderId
    return (id && this.getProvider(id)) || this.providers[0]
  }

  async providerKey(id: string): Promise<string> {
    return (await getSecret(secretKey('provider', id, 'apiKey'))) ?? ''
  }

  async saveProvider(draft: ProviderDraft): Promise<ProviderConfig> {
    const id = draft.id && this.getProvider(draft.id) ? draft.id : newId('prov')
    const existing = this.getProvider(id)
    const cleanModel = draft.model.trim()
    const rawModels = draft.models ?? existing?.models
    const models = normalizeProviderModels(cleanModel, rawModels)
    const record: ProviderRecord = {
      id,
      name: draft.name.trim() || 'Untitled',
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
      model: cleanModel,
      models,
      presetId: draft.presetId,
      ...(draft.managedBy ? { managedBy: draft.managedBy } : {}),
      hasKey: existing?.hasKey ?? false,
    }
    if (draft.apiKey !== undefined) {
      const value = draft.apiKey.trim()
      await setSecret(secretKey('provider', id, 'apiKey'), value || null)
      record.hasKey = Boolean(value)
    }
    this.providers = [...this.providers.filter((p) => p.id !== id), record]
    await writeJson(this.providersPath(), this.providers)
    if (!this.settings.activeProviderId) await this.update({ activeProviderId: id })
    return { ...record }
  }

  async selectProviderModel(
    providerId: string,
    model: string,
  ): Promise<{ providers: ProviderConfig[]; settings: AppSettings }> {
    const existing = this.providers.find((p) => p.id === providerId)
    if (!existing) throw new Error('未找到指定的模型供应商。')
    const cleanModel = model.trim()
    if (!cleanModel) throw new Error('模型名称不能为空。')
    const prevModels = normalizeProviderModels(existing.model, existing.models)
    const models = prevModels.includes(cleanModel) ? prevModels : [...prevModels, cleanModel]
    const updated: ProviderRecord = { ...existing, model: cleanModel, models }
    this.providers = this.providers.map((p) => (p.id === providerId ? updated : p))
    await writeJson(this.providersPath(), this.providers)
    const nextSettings = await this.update({ activeProviderId: providerId })
    return { providers: this.listProviders(), settings: nextSettings }
  }

  async mergeProviderModels(providerId: string, discovered: readonly string[]): Promise<ProviderConfig> {
    const existing = this.providers.find((p) => p.id === providerId)
    if (!existing) throw new Error('未找到指定的模型供应商。')
    const models = normalizeProviderModels(existing.model, [...(existing.models ?? []), ...discovered])
    const updated: ProviderRecord = { ...existing, models }
    this.providers = this.providers.map((p) => (p.id === providerId ? updated : p))
    await writeJson(this.providersPath(), this.providers)
    return { ...updated }
  }

  async setProviderModels(
    providerId: string,
    selectedModels: readonly string[],
    activeModel?: string,
  ): Promise<ProviderConfig> {
    const existing = this.providers.find((p) => p.id === providerId)
    if (!existing) throw new Error('未找到指定的模型供应商。')
    const preferred = (activeModel ?? existing.model ?? '').trim()
    const cleanList = normalizeProviderModels('', selectedModels)
    if (cleanList.length === 0) throw new Error('请至少选择一个模型。')
    const nextActive = preferred && cleanList.includes(preferred) ? preferred : cleanList[0]!
    const updated: ProviderRecord = { ...existing, model: nextActive, models: cleanList }
    this.providers = this.providers.map((p) => (p.id === providerId ? updated : p))
    await writeJson(this.providersPath(), this.providers)
    return { ...updated }
  }

  async removeProvider(id: string): Promise<void> {
    await setSecret(secretKey('provider', id, 'apiKey'), null)
    this.providers = this.providers.filter((p) => p.id !== id)
    await writeJson(this.providersPath(), this.providers)
    if (this.settings.activeProviderId === id) {
      await this.update({ activeProviderId: this.providers[0]?.id })
    }
  }

  async reset(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS }
    this.providers = []
    await removeFile(this.settingsPath())
    await removeFile(this.providersPath())
  }
}
