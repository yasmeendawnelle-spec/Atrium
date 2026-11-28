// The core process, started by main with Electron's utilityProcess.fork().
// It has no window and no access to the OS key store. It talks to main over
// `process.parentPort` and to the renderer over a MessagePort that main hands
// it in the first message.
import { join } from 'node:path'
import { RpcPeer, errorText, type Handler } from '../shared/rpc.ts'
import type { CoreEvent, CoreMethods } from '../shared/ipc.ts'
import { derivePlanFromMessages } from '../shared/plan.ts'
import type { DocumentAttachment, ImageAttachment, ProviderDraft } from '../shared/types.ts'
import { bindSecrets, type HostCall } from './secrets.ts'
import { RelayPulseAccountManager } from './account.ts'
import { systemPrompt } from './prompt.ts'
import { configureNetwork } from './net.ts'
import { SettingsStore } from './settings.ts'
import { createCoreEventCoalescer } from './streamCoalescer.ts'
import { McpManager } from './mcp/manager.ts'
import { parseConfigText } from './mcp/parse.ts'
import { PluginManager } from './plugins.ts'
import { importGithub, MarketHub, searchRegistry } from './market.ts'
import { newId } from './store.ts'
import { ChatStore } from './chats.ts'
import { discoverExternalSessions, importExternalSessions } from './sessionImport.ts'
import { AgentLoop } from './agent.ts'
import { AutomationManager, previewCronRuns } from './automations.ts'
import { KnowledgeBaseManager } from './knowledge.ts'
import { MemoryStore } from './memory.ts'
import { detectRuntimes } from './runtimes.ts'
import { prewarmPtyHelper } from './pty.ts'
import { detectSandboxCapabilities } from './sandbox.ts'
import { hasSpeechApiKey, saveSpeechApiKey, transcribeSpeech } from './speech.ts'
import { TerminalManager } from './terminal.ts'
import {
  evaluateCommandPolicy,
  evaluateFileReadPolicy,
  evaluateFileWritePolicy,
  inspectWorkspacePolicy,
  saveWorkspacePolicy,
} from './policy.ts'
import { PreviewServerManager } from './preview.ts'
import { WorktreeFleetManager } from './fleet.ts'
import { PlatformManager } from './platform/manager.ts'
import type { BrowserHostBridge } from './tools/browser_tools.ts'
import type { ComputerHostBridge } from './tools/computer_tools.ts'
import { chat, endpointFor, fetchProviderModels, testConnection } from './providers/index.ts'
import { CheckpointStore } from './tools/changes.ts'
import { invalidateWorkspaceFilesCache, listWorkspaceFiles, readWorkspacePreview, saveArtifactFile } from './tools/files.ts'
import {
  buildGitHubPrUrl,
  checkoutGitBranch,
  commitGitChanges,
  createGitWorktree,
  fetchGitHubIssues,
  getGitAheadBehind,
  getGitChanges,
  getGitRepoStatus,
  isLinkedWorktree,
  listGitBranches,
  pushGitBranch,
  removeGitWorktree,
  stageGitFiles,
} from './tools/git.ts'
import { SkillsManager } from './tools/skills.ts'

// Minimal shapes of Electron's ParentPort and MessagePortMain, so the core
// does not need to import Electron's types.
interface PortEvent {
  data: unknown
  ports: MainPort[]
}
interface MainPort {
  on(event: 'message', listener: (e: PortEvent) => void): void
  on(event: 'close', listener: () => void): void
  postMessage(message: unknown): void
  start(): void
}
interface ParentPort {
  on(event: 'message', listener: (e: PortEvent) => void): void
  postMessage(message: unknown): void
}

interface StartMessage {
  kind: 'start'
  dir: string
}

export { systemPrompt }

async function main(): Promise<void> {
  const host = (process as unknown as { parentPort?: ParentPort }).parentPort
  if (!host) throw new Error('The core process must be started with utilityProcess.fork().')

  const hostPeer = new RpcPeer(host)
  const callHost: HostCall = (method, ...args) => hostPeer.call(method, ...args)
  bindSecrets(callHost)

  // Main sends {kind:'start'} once, then {kind:'attach'} with a port for each
  // window (again after a reload), and {kind:'shutdown'} when the app quits.
  let resolveStart: (msg: StartMessage) => void = () => undefined
  const started = new Promise<StartMessage>((resolve) => (resolveStart = resolve))
  const waitingPorts: MainPort[] = []
  let attach: ((port: MainPort) => void) | null = null
  let shutdown: () => void = () => process.exit(0)
  let emergencyStop: () => void = () => undefined
  host.on('message', (e) => {
    const msg = e.data as { kind?: string }
    if (msg?.kind === 'start') resolveStart(msg as StartMessage)
    else if (msg?.kind === 'attach' && e.ports[0]) {
      if (attach) attach(e.ports[0])
      else waitingPorts.push(e.ports[0])
    } else if (msg?.kind === 'shutdown') shutdown()
    else if (msg?.kind === 'emergency_stop') emergencyStop()
    else void hostPeer.receive(e.data)
  })
  const start = await started

  const dir = start.dir
  const settings = new SettingsStore(dir)
  await settings.load()
  const resolveConfiguredBrowserMode = (cfg: ReturnType<SettingsStore['get']>) => {
    if (cfg.browserMode === 'edge' || cfg.browserMode === 'google') return cfg.browserMode
    if (cfg.locale === 'zh') return 'edge'
    if (cfg.locale === 'en') return 'google'
    return undefined
  }
  const initialBrowserMode = resolveConfiguredBrowserMode(settings.get())
  if (initialBrowserMode) {
    void callHost('browser.setMode', initialBrowserMode).catch(() => undefined)
  }
  configureNetwork({
    mode: settings.get().proxyMode,
    url: settings.get().proxyUrl,
    resolveSystem: (url) => callHost('net.resolveProxy', url),
  })
  const dataDir = join(dir, 'data')
  const chats = new ChatStore(dataDir)
  await chats.load()
  const checkpoints = new CheckpointStore(dataDir)

  const windows = new Set<RpcPeer>()
  const sendToWindows = (event: CoreEvent) => {
    for (const peer of windows) peer.emit(event.channel, event.payload)
  }
  const coalescer = createCoreEventCoalescer(sendToWindows, 16)
  const emit = (event: CoreEvent) => {
    coalescer.emit(event)
  }

  const mcp = new McpManager(
    dir,
    (status) => emit({ channel: 'mcp', payload: status }),
    (url) => callHost('app.openExternal', url),
  )
  const account = new RelayPulseAccountManager({
    dir,
    settings,
    openExternal: (url) => callHost('app.openExternal', url),
    focusApp: () => callHost('app.focusMain'),
    onChange: (payload) => emit({ channel: 'account', payload }),
  })
  await account.load()
  const requireAccount = () => {
    if (!account.isConnected()) {
      throw new Error('请先登录 Atrium 账号后再使用（登录后也可在设置中配置自带 API Key / Ollama）')
    }
  }
  const terminal = new TerminalManager({
    emit: (payload) => emit({ channel: 'terminal', payload }),
    getDefaultWorkspace: () => settings.get().workspace,
    dataDir,
  })
  const previews = new PreviewServerManager({
    onChange: (payload) => emit({ channel: 'preview', payload }),
  })
  void prewarmPtyHelper(dataDir).catch(() => undefined)
  const memory = new MemoryStore(dir, (items) => emit({ channel: 'memory', payload: items }))
  const knowledge = new KnowledgeBaseManager(dataDir, (stats) => emit({ channel: 'knowledge', payload: stats }))
  const browserBridge: BrowserHostBridge = {
    open: async (url, conversationId) => {
      const snap = await callHost('browser.open', url, conversationId)
      emit({ channel: 'browser', payload: snap })
      return snap
    },
    action: async (action, conversationId) => {
      const resolvedCid = conversationId ?? action.conversationId
      const snap = await callHost('browser.action', action, resolvedCid)
      emit({ channel: 'browser', payload: snap })
      return snap
    },
    capture: async (conversationId) => {
      const snap = await callHost('browser.capture', conversationId)
      emit({ channel: 'browser', payload: snap })
      return snap
    },
    evalScript: (script, conversationId) => callHost('browser.eval', script, conversationId),
    state: (conversationId) => callHost('browser.state', conversationId),
  }
  const computerBridge: ComputerHostBridge = {
    screenshot: (opts) => callHost('computer.screenshot', opts),
    mouse: (input) => callHost('computer.mouse', input),
    keyboard: (input) => callHost('computer.keyboard', input),
    window: (input) => callHost('computer.window', input),
    wait: (opts) => callHost('computer.wait', opts),
    setHud: (state) => callHost('computer.setHud', state),
  }
  const plugins = new PluginManager({
    dir,
    mcp,
    getDisabledSkills: () => settings.get().disabledSkills ?? [],
    setDisabledSkills: (disabledSkills) => {
      void settings.update({ disabledSkills })
    },
  })
  const marketHub = new MarketHub({
    getAuthToken: () => account.getSessionToken(),
    getAccountState: () => account.getState(),
    getWorkspace: () => settings.get().workspace,
    plugins,
  })
  const skills = new SkillsManager({
    appDir: dir,
    getDisabled: () => settings.get().disabledSkills ?? [],
    setDisabled: (disabledSkills) => {
      void settings.update({ disabledSkills })
    },
    getPluginSources: () => plugins.activeSkillSources(),
  })

  const agent = new AgentLoop({
    settings,
    mcp,
    dataDir,
    checkpoints,
    skills,
    plugins,
    terminal,
    memory,
    knowledge,
    browser: browserBridge,
    computer: computerBridge,
    preview: previews,
    emit: (payload) => {
      emit({ channel: 'agent', payload })
      if (payload.type === 'message_saved' && payload.message.role === 'assistant' && payload.message.usage) {
        const provider = payload.message.providerId
          ? settings.getProvider(payload.message.providerId)
          : settings.activeProvider()
        const billedModel = payload.message.model ?? provider?.model
        if (provider?.managedBy === 'relaypulse' && billedModel) {
          void account.recordSubscriptionUsage(billedModel, payload.message.usage).catch(() => undefined)
        }
      }
    },
    onBeforeModelCall: async (provider, model) => {
      if (provider.managedBy === 'relaypulse') {
        await account.ensureKeyGroupForModel(model).catch(() => undefined)
      }
    },
    save: async (conversation) => {
      await chats.save(conversation)
      emit({ channel: 'chats', payload: chats.list() })
    },
    enableAutoTitle: true,
    onAutoTitle: async (conversationId, title) => {
      const updated = await chats.setAutoTitle(conversationId, title)
      if (!updated) return
      emit({ channel: 'chats', payload: chats.list() })
      emit({ channel: 'agent', payload: { type: 'conversation_sync', conversation: updated } })
    },
    systemPrompt,
  })
  const platform = new PlatformManager({
    dir,
    dataDir,
    settings,
    onBeforeModelCall: async (provider, model) => {
      if (provider.managedBy === 'relaypulse') {
        await account.ensureKeyGroupForModel(model).catch(() => undefined)
      }
    },
    emit: (payload) => emit({ channel: 'platform', payload }),
  })
  emergencyStop = () => {
    agent.stopAll()
    platform.stopAll()
  }

  const fleet = new WorktreeFleetManager({
    chats,
    agent,
    settings,
    checkpoints,
    previews,
    dataDir,
    onChatsChanged: () => emit({ channel: 'chats', payload: chats.list() }),
    emitAgent: (payload) => emit({ channel: 'agent', payload }),
    closeBrowser: async (cid) => {
      await callHost('browser.action', { kind: 'close', conversationId: cid }, cid)
    },
    beforeSend: async () => {
      requireAccount()
      await syncRelayPulseRoute()
    },
  })

  const automations = new AutomationManager({
    dir,
    dataDir,
    settings,
    chats,
    mcp,
    checkpoints,
    skills,
    plugins,
    terminal,
    memory,
    knowledge,
    emitAgent: (payload) => emit({ channel: 'agent', payload }),
    onChange: (rules) => emit({ channel: 'automations', payload: rules }),
    onChatsChanged: () => emit({ channel: 'chats', payload: chats.list() }),
    notify: (opts) => callHost('app.notify', opts).catch(() => undefined),
    onBackgroundActiveChange: (active) => void callHost('app.setBackgroundActive', active).catch(() => undefined),
  })

  const syncRelayPulseRoute = async (model?: string) => {
    const active = settings.activeProvider()
    const targetModel = model ?? (active?.managedBy === 'relaypulse' ? active.model : undefined)
    if (targetModel) {
      await account.ensureKeyGroupForModel(targetModel).catch(() => undefined)
    }
  }

  const handlers: { [M in keyof CoreMethods]: (...args: Parameters<CoreMethods[M]>) => unknown } = {
    'settings.get': () => settings.get(),
    'settings.update': async (patch) => {
      const prevShortcut = settings.get().quickEntryShortcut ?? 'Alt+Space'
      const prevMode = resolveConfiguredBrowserMode(settings.get())
      const updated = await settings.update(patch)
      automations.syncBackgroundState()
      if (patch.quickEntryShortcut !== undefined && (updated.quickEntryShortcut ?? '') !== prevShortcut) {
        await callHost('app.updateQuickShortcut', updated.quickEntryShortcut ?? '').catch(() => undefined)
      }
      const nextMode = resolveConfiguredBrowserMode(updated)
      if (nextMode && (patch.browserMode !== undefined || (patch.locale !== undefined && nextMode !== prevMode))) {
        const snap = await callHost('browser.setMode', nextMode).catch(() => null)
        if (snap) emit({ channel: 'browser', payload: snap })
      }
      return updated
    },
    'providers.list': () => settings.listProviders(),
    'providers.save': (draft) => {
      if (draft.managedBy !== 'relaypulse') requireAccount()
      return settings.saveProvider(draft)
    },
    'providers.selectModel': async (providerId, model) => {
      requireAccount()
      const res = await settings.selectProviderModel(providerId, model)
      const provider = settings.getProvider(providerId)
      if (provider?.managedBy === 'relaypulse') {
        await syncRelayPulseRoute(model)
      }
      return res
    },
    'providers.fetchModels': async (target) => {
      requireAccount()
      const draft = typeof target === 'string' ? settings.getProvider(target) : target
      if (!draft) return { ok: false, error: '未找到指定的模型供应商。' }
      return fetchDraftModels(settings, draft)
    },
    'providers.setModels': (providerId, models, activeModel) => {
      requireAccount()
      return settings.setProviderModels(providerId, models, activeModel)
    },
    'providers.remove': (id) => settings.removeProvider(id),
    'providers.test': (draft) => {
      requireAccount()
      return testDraft(settings, draft)
    },
    'account.state': () => account.getState(),
    'account.refresh': () => account.refresh(),
    'account.setOrigin': (origin, options) => account.setOrigin(origin, options),
    'account.sendCode': (email) => account.sendCode(email),
    'account.loginEmail': (req) => account.loginEmail(req),
    'account.resetPassword': (req) => account.resetPassword(req),
    'account.updatePassword': (req) => account.updatePassword(req),
    'account.oauthStart': (provider) => account.oauthStart(provider),
    'account.oauthBindEmail': (req) => account.oauthBindEmail(req),
    'account.redeem': (code) => account.redeem(code),
    'account.createRechargeOrder': (req) => account.createRechargeOrder(req),
    'account.checkRechargeOrder': (outTradeNo) => account.checkRechargeOrder(outTradeNo),
    'account.reportRechargePaid': (outTradeNo) => account.reportRechargePaid(outTradeNo),
    'account.setKeyGroup': (group) => account.setKeyGroup(group),
    'account.subscribeCategory': (req) => account.subscribeCategory(req),
    'account.cancelCategorySubscription': (category) => account.cancelCategorySubscription(category),
    'account.setAvatar': (avatar) => account.setAvatar(avatar),
    'account.syncModels': () => account.syncModels(),
    'account.logout': () => account.logout(),
    'mcp.list': () => mcp.list(),
    'mcp.status': () => mcp.statuses(),
    'mcp.save': (config) => mcp.save(config),
    'mcp.remove': (id) => mcp.remove(id),
    'mcp.setEnabled': (id, enabled) => mcp.setEnabled(id, enabled),
    'mcp.reconnect': (id) => mcp.reconnect(id),
    'mcp.test': (config) => mcp.test(config),
    'mcp.parseConfig': (text) => parseConfigText(text),
    'mcp.oauthStart': async (id) => {
      const status = await mcp.oauthStart(id)
      emit({ channel: 'mcp', payload: status })
      return status
    },
    'mcp.oauthRevoke': async (id) => {
      const status = await mcp.oauthRevoke(id)
      emit({ channel: 'mcp', payload: status })
      return status
    },
    'mcp.resources': () => mcp.resources(),
    'mcp.readResource': (serverId, uri) => mcp.readResource(serverId, uri),
    'mcp.prompts': () => mcp.prompts(),
    'mcp.getPrompt': (serverId, name, args) => mcp.getPrompt(serverId, name, args),
    'terminal.list': () => terminal.list(),
    'terminal.create': (opts) => terminal.create(opts),
    'terminal.read': (id) => terminal.read(id),
    'terminal.write': (id, data) => terminal.write(id, data),
    'terminal.resize': (id, cols, rows) => terminal.resize(id, cols, rows),
    'terminal.signal': (id, sig) => terminal.signal(id, sig),
    'terminal.clear': (id) => terminal.clear(id),
    'terminal.close': (id) => terminal.close(id),
    'automations.list': () => automations.list(),
    'automations.save': (draft) => automations.save(draft),
    'automations.remove': (id) => automations.remove(id),
    'automations.setEnabled': (id, enabled) => automations.setEnabled(id, enabled),
    'automations.runNow': (id) => automations.runNow(id),
    'automations.previewCron': (expr, count) => previewCronRuns(expr, count),
    'market.search': (query, cursor) => searchRegistry(query, cursor),
    'market.importGithub': (url) => importGithub(url),
    'market.catalog': () => marketHub.catalog(),
    'market.me': () => marketHub.me(),
    'market.searchAll': (query, scope) => marketHub.searchAll(query, scope),
    'market.pluginDetail': (id) => marketHub.pluginDetail(id),
    'market.inspectLocalFolder': (folderPath) => plugins.packLocalFolder(folderPath),
    'market.submit': (req) => marketHub.submit(req),
    'market.mySubmissions': () => marketHub.mySubmissions(),
    'market.reviewQueue': () => marketHub.reviewQueue(),
    'market.reviewDecision': (id, req) => marketHub.reviewDecision(id, req),
    'market.deleteSubmission': (id) => marketHub.deleteSubmission(id),
    'market.installPlugin': (id) => marketHub.installPlugin(id),
    'system.runtimes': () => detectRuntimes(),
    'chats.list': () => chats.list(),
    'chats.get': (id) => chats.get(id),
    'chats.create': async (workspace) => {
      requireAccount()
      const ws = workspace !== undefined ? workspace || undefined : settings.get().workspace
      const conversation = await chats.create({
        workspace: ws,
        providerId: settings.activeProvider()?.id,
      })
      emit({ channel: 'chats', payload: chats.list() })
      return conversation
    },
    'chats.createWorktree': async (baseWorkspace, branchName) => {
      requireAccount()
      const id = newId('chat')
      const wt = await createGitWorktree(baseWorkspace, dataDir, id, branchName, {
        copyEnv: settings.get().copyEnvOnWorktree !== false,
      })
      const conversation = await chats.create({
        id,
        workspace: wt.worktreePath,
        providerId: settings.activeProvider()?.id,
        worktreeBaseWorkspace: wt.baseWorkspace,
        worktreeBranch: wt.branch,
        worktreeBaseBranch: wt.baseBranch,
      })
      emit({ channel: 'chats', payload: chats.list() })
      return conversation
    },
    'chats.fork': async (id, messageIndex, titleSuffix) => {
      requireAccount()
      const forked = await chats.fork(id, messageIndex, titleSuffix)
      emit({ channel: 'chats', payload: chats.list() })
      return forked
    },
    'chats.remove': async (id) => {
      agent.clearQueue(id)
      agent.stop(id)
      await previews.stopForConversation(id).catch(() => undefined)
      const conv = await chats.get(id)
      await chats.remove(id)
      await checkpoints.deleteChat(id).catch(() => undefined)
      void callHost('browser.action', { kind: 'close', conversationId: id }, id).catch(() => undefined)
      if (conv?.worktreeBaseWorkspace && conv.workspace) {
        await removeGitWorktree(conv.worktreeBaseWorkspace, conv.workspace, conv.worktreeBranch).catch(() => undefined)
      }
      emit({ channel: 'chats', payload: chats.list() })
    },
    'chats.rename': async (id, title) => {
      const meta = await chats.rename(id, title)
      emit({ channel: 'chats', payload: chats.list() })
      return meta
    },
    'chats.setWorkspace': async (id, workspace) => {
      const meta = await chats.setWorkspace(id, workspace)
      emit({ channel: 'chats', payload: chats.list() })
      return meta
    },
    'chats.setProvider': async (id, providerId) => {
      const meta = await chats.setProvider(id, providerId)
      emit({ channel: 'chats', payload: chats.list() })
      return meta
    },
    'chats.setPinned': async (id, pinned) => {
      const meta = await chats.setPinned(id, pinned)
      emit({ channel: 'chats', payload: chats.list() })
      return meta
    },
    'chats.setArchived': async (id, archived) => {
      const meta = await chats.setArchived(id, archived)
      emit({ channel: 'chats', payload: chats.list() })
      return meta
    },
    'chats.archiveGroup': async (ids, archived) => {
      const updated = await chats.setArchivedBatch(ids, archived)
      emit({ channel: 'chats', payload: chats.list() })
      return updated
    },
    'chats.rewind': async (conversationId, messageIndex, revertFiles = true) => {
      if (agent.busy(conversationId)) throw new Error('Stop the active turn before rewinding.')
      const conversation = await chats.get(conversationId)
      if (!conversation) throw new Error(`No chat with id "${conversationId}".`)
      if (messageIndex < 0 || messageIndex >= conversation.messages.length) {
        throw new Error('Selected rewind point is out of range.')
      }
      const target = conversation.messages[messageIndex]
      const draftText = target?.role === 'user' && !target.isSummary ? target.text : ''
      const ws = conversation.workspace ?? settings.get().workspace
      const revertedFiles =
        revertFiles && ws ? await checkpoints.rewindToTurn(conversationId, ws, messageIndex) : []
      if (ws && revertedFiles.length > 0) invalidateWorkspaceFilesCache(ws)
      conversation.messages = conversation.messages.slice(0, messageIndex)
      const rewoundPlan = derivePlanFromMessages(conversation.messages)
      if (rewoundPlan) conversation.plan = rewoundPlan
      else delete conversation.plan
      await chats.save(conversation)
      emit({ channel: 'chats', payload: chats.list() })
      emit({ channel: 'agent', payload: { type: 'conversation_sync', conversation } })
      return { conversation, draftText, revertedFiles }
    },
    'sessions.discover': (opts) =>
      discoverExternalSessions({
        chats,
        workspace: opts?.workspace ?? settings.get().workspace,
        recentWorkspaces: settings.get().recentWorkspaces,
        folderPath: opts?.folderPath,
      }),
    'sessions.import': async (items, opts) => {
      const res = await importExternalSessions({
        chats,
        settings,
        items,
        workspaceOverride: opts?.workspaceOverride,
        overwriteExisting: opts?.overwriteExisting,
      })
      if (res.imported.length > 0) {
        emit({ channel: 'chats', payload: chats.list() })
      }
      return res
    },
    'agent.send': async (conversationId, text, images, documents) => {
      requireAccount()
      await syncRelayPulseRoute()
      return send(chats, agent, conversationId, text, images, documents)
    },
    'agent.enqueue': async (conversationId, text, images, documents) => {
      requireAccount()
      await syncRelayPulseRoute()
      const conversation = await chats.get(conversationId)
      if (!conversation) throw new Error(`No chat with id "${conversationId}".`)
      return agent.enqueue(conversation, text, images, documents)
    },
    'agent.cancelQueued': (conversationId, queuedId) => agent.cancelQueued(conversationId, queuedId),
    'agent.steerQueued': async (conversationId, queuedId) => {
      requireAccount()
      await syncRelayPulseRoute()
      const conversation = await chats.get(conversationId)
      if (!conversation) throw new Error(`No chat with id "${conversationId}".`)
      agent.steerQueued(conversation, queuedId)
    },
    'agent.queueList': (conversationId) => agent.queuedFor(conversationId),
    'agent.regenerate': async (conversationId) => {
      requireAccount()
      await syncRelayPulseRoute()
      return regenerate(chats, agent, conversationId)
    },
    'agent.compact': async (conversationId) => {
      requireAccount()
      const conversation = await chats.get(conversationId)
      if (!conversation) throw new Error(`No chat with id "${conversationId}".`)
      return agent.compact(conversation)
    },
    'agent.stop': (conversationId) => agent.stop(conversationId),
    'agent.approve': (approvalId, decision) => agent.approve(approvalId, decision),
    'agent.allows': (workspace) => agent.sessionAllowsFor(workspace ?? settings.get().workspace),
    'agent.revokeAllows': (workspace) => agent.clearSessionAllows(workspace ?? settings.get().workspace),
    'agent.allowedRules': (workspace) => settings.allowedRulesFor(workspace ?? settings.get().workspace),
    'agent.revokeAllowedRule': (rule, workspace) =>
      settings.removeAllowedRule(workspace ?? settings.get().workspace, rule),
    'workspace.files': (workspace) => listWorkspaceFiles(workspace ?? settings.get().workspace),
    'workspace.readPreview': (path, workspace) => readWorkspacePreview(workspace ?? settings.get().workspace, path),
    'workspace.changes': (conversationId, workspace) =>
      computeWorkspaceChanges(chats, checkpoints, workspace ?? settings.get().workspace, conversationId),
    'workspace.revertChange': async (conversationId, path, workspace) => {
      const conv = await chats.get(conversationId)
      const ws = workspace ?? conv?.workspace ?? settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      await checkpoints.revertFile(conversationId, ws, path)
      invalidateWorkspaceFilesCache(ws)
      return computeWorkspaceChanges(chats, checkpoints, ws, conversationId)
    },
    'workspace.revertAllChanges': async (conversationId, workspace) => {
      const conv = await chats.get(conversationId)
      const ws = workspace ?? conv?.workspace ?? settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      await checkpoints.revertAll(conversationId, ws)
      invalidateWorkspaceFilesCache(ws)
      return computeWorkspaceChanges(chats, checkpoints, ws, conversationId)
    },
    'workspace.gitInfo': (workspace) => getGitRepoStatus(workspace ?? settings.get().workspace),
    'workspace.gitCommit': async (workspace, message, paths) => {
      const ws = workspace || settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      const result = await commitGitChanges(ws, message, paths)
      invalidateWorkspaceFilesCache(ws)
      const norm = (p?: string) => (process.platform === 'win32' ? p?.toLowerCase() : p)
      for (const entry of chats.list()) {
        if (entry.workspace && norm(entry.workspace) === norm(ws)) {
          await checkpoints.markCommitted(entry.id, paths).catch(() => undefined)
        }
      }
      return result
    },
    'workspace.gitStage': async (workspace, paths, staged) => {
      const ws = workspace || settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      await stageGitFiles(ws, paths, staged)
      return computeWorkspaceChanges(chats, checkpoints, ws)
    },
    'workspace.gitCheckout': async (workspace, branch, createNew) => {
      const ws = workspace || settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      const status = await checkoutGitBranch(ws, branch, createNew)
      invalidateWorkspaceFilesCache(ws)
      return status
    },
    'workspace.gitPush': async (workspace) => {
      const ws = workspace || settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      return pushGitBranch(ws)
    },
    'workspace.gitPrUrl': async (workspace, title) => {
      const ws = workspace || settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      return buildGitHubPrUrl(ws, title)
    },
    'workspace.suggestCommitMessage': (workspace, conversationId) =>
      suggestCommitMessage(settings, chats, checkpoints, workspace, conversationId),
    'workspace.gitMergeWorktree': (conversationId, opts) => fleet.merge(conversationId, opts),
    'workspace.githubIssues': (workspace, query) => fetchGitHubIssues(workspace ?? settings.get().workspace, query),
    'workspace.saveArtifact': async (path, content, workspace) => {
      const savedPath = await saveArtifactFile(workspace ?? settings.get().workspace, path, content)
      return { path: savedPath }
    },
    'skills.list': (workspace) => skills.list(workspace ?? settings.get().workspace),
    'skills.get': (name, workspace) => skills.get(name, workspace ?? settings.get().workspace),
    'skills.setEnabled': (name, enabled, workspace) => skills.setEnabled(name, enabled, workspace ?? settings.get().workspace),
    'skills.create': (draft, workspace) => skills.create(draft, workspace ?? settings.get().workspace),
    'skills.remove': (name, workspace) => skills.remove(name, workspace ?? settings.get().workspace),
    'plugins.list': () => plugins.list(),
    'plugins.get': (id) => plugins.get(id),
    'plugins.discover': (workspace) => plugins.discoverLocal(workspace ?? settings.get().workspace),
    'plugins.importLocal': (sourcePaths) => plugins.importLocal(sourcePaths),
    'plugins.importFolder': (folderPath) => plugins.importFolder(folderPath),
    'plugins.importGithub': (repoUrl) => plugins.importGithub(repoUrl),
    'plugins.setEnabled': (id, enabled) => plugins.setEnabled(id, enabled),
    'plugins.remove': (id) => plugins.remove(id),
    'plugins.activeTheme': () => plugins.getActiveTheme(),
    'sandbox.info': () => detectSandboxCapabilities(),
    'memory.list': (workspace) => memory.list(workspace),
    'memory.save': (draft) => memory.save(draft),
    'memory.remove': (id) => memory.remove(id),
    'memory.extractFromChat': async (conversationId) => {
      const conv = await chats.get(conversationId)
      if (!conv) throw new Error(`No chat with id "${conversationId}".`)
      return memory.extractFromConversation(settings, conv)
    },
    'knowledge.status': (workspace) => knowledge.status(workspace ?? settings.get().workspace),
    'knowledge.addFiles': (paths, workspace) => knowledge.addFiles(paths, workspace ?? settings.get().workspace),
    'knowledge.addNote': (title, content, workspace) =>
      knowledge.addNote(title, content, workspace ?? settings.get().workspace),
    'knowledge.remove': (sourceId, workspace) => knowledge.remove(sourceId, workspace ?? settings.get().workspace),
    'knowledge.reindex': (workspace) => knowledge.reindex(workspace ?? settings.get().workspace),
    'knowledge.search': (query, workspace, topK) =>
      knowledge.search(query, workspace ?? settings.get().workspace, topK),
    'speech.transcribe': (req) => transcribeSpeech(settings, req),
    'speech.saveKey': (apiKey) => saveSpeechApiKey(apiKey),
    'speech.hasKey': () => hasSpeechApiKey(),
    'browser.state': (conversationId) => callHost('browser.state', conversationId),
    'browser.open': async (url, conversationId) => browserBridge.open(url, conversationId),
    'browser.action': async (action, conversationId) => browserBridge.action(action, conversationId),
    'browser.capture': async (conversationId) => browserBridge.capture(conversationId),
    'policy.inspect': (workspace) => inspectWorkspacePolicy(workspace ?? settings.get().workspace),
    'policy.save': (workspace, scope, config) => saveWorkspacePolicy(workspace ?? settings.get().workspace, scope, config),
    'policy.checkPath': (workspace, targetPath, op) => {
      const ws = workspace ?? settings.get().workspace
      return op === 'write' ? evaluateFileWritePolicy(ws, targetPath) : evaluateFileReadPolicy(ws, targetPath)
    },
    'preview.list': (conversationId) => previews.list(conversationId),
    'preview.start': async (opts) => {
      const ws = opts.workspace ?? settings.get().workspace
      if (!ws) throw new Error('No workspace folder is set.')
      const cmdDecision = await evaluateCommandPolicy(ws, opts.command)
      if (!cmdDecision.allowed) {
        throw new Error(cmdDecision.reason ?? 'Blocked by project command security policy.')
      }
      const res = await previews.start({
        workspace: ws,
        command: opts.command,
        conversationId: opts.conversationId,
        url: opts.url,
        port: opts.port,
      })
      if (res.ready && res.server.url) {
        void browserBridge.open(res.server.url, opts.conversationId).catch(() => undefined)
      }
      return res
    },
    'preview.logs': (serverId) => previews.logs({ serverId }),
    'preview.stop': (serverId) => previews.stop(serverId),
    'fleet.list': (baseWorkspace) => fleet.list(baseWorkspace),
    'fleet.launch': (opts) =>
      fleet.launch({
        baseWorkspace: opts.baseWorkspace ?? settings.get().workspace ?? '',
        tasks: opts.tasks,
      }),
    'fleet.diff': (conversationId) => fleet.inspectDiff(conversationId),
    'fleet.merge': (conversationId, opts) => fleet.merge(conversationId, opts),
    'fleet.discard': (conversationId) => fleet.discard(conversationId),
    'fleet.stopAll': (baseWorkspace) => fleet.stopAll(baseWorkspace),
    'platform.scan': () => platform.scanAgents(),
    'platform.agents': () => platform.getAgents(),
    'platform.agentModels': (agentId, refresh) => platform.getAgentModels(agentId, refresh),
    'platform.updateAgent': (agentId, patch) => platform.updateAgent(agentId, patch),
    'platform.saveCustomAgent': (draft) => platform.saveCustomAgent(draft),
    'platform.removeCustomAgent': (agentId) => platform.removeCustomAgent(agentId),
    'platform.sessions': () => platform.listSessions(),
    'platform.getSession': (sessionId) => platform.getSession(sessionId),
    'platform.startSession': (req) => platform.startSession(req),
    'platform.sendFollowup': (sessionId, taskId, prompt) => platform.sendFollowup(sessionId, taskId, prompt),
    'platform.postBoardNote': (sessionId, note) => platform.postBoardNote(sessionId, note),
    'platform.stopTask': (sessionId, taskId) => platform.stopTask(sessionId, taskId),
    'platform.stopSession': (sessionId) => platform.stopSession(sessionId),
    'platform.stopAll': () => platform.stopAll(),
    'platform.deleteSession': (sessionId) => platform.deleteSession(sessionId),
    'platform.diffTask': (sessionId, taskId) => platform.diffTask(sessionId, taskId),
    'platform.mergeWorktree': (sessionId, taskId, opts) => platform.mergeWorktree(sessionId, taskId, opts),
    'platform.discardWorktree': (sessionId, taskId) => platform.discardWorktree(sessionId, taskId),
    'stats.usage': () => chats.summarizeUsage(),
  }
  const table = handlers as unknown as Record<string, Handler>
  attach = (port) => {
    const peer = new RpcPeer(port, table)
    windows.add(peer)
    port.on('message', (e) => void peer.receive(e.data))
    port.on('close', () => {
      windows.delete(peer)
      peer.dispose('Window closed')
    })
    port.start()
  }
  // Load saved plugins, MCP servers, memory, and scheduled automations before windows attach.
  await plugins.load()
  await mcp.load()
  await memory.load()
  await automations.load()
  await platform.load()
  automations.startScheduler()
  if (settings.get().quickEntryShortcut) {
    void callHost('app.updateQuickShortcut', settings.get().quickEntryShortcut!).catch(() => undefined)
  }

  for (const port of waitingPorts.splice(0)) attach(port)

  let stopping = false
  shutdown = () => {
    if (stopping) return
    stopping = true
    coalescer.dispose()
    platform.shutdown()
    automations.shutdown()
    previews.shutdown()
    terminal.shutdown()
    void mcp.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
}

async function computeWorkspaceChanges(
  chats: ChatStore,
  checkpoints: CheckpointStore,
  fallbackWorkspace: string | undefined,
  conversationId?: string,
) {
  const conv = conversationId ? await chats.get(conversationId) : null
  const ws = conv?.workspace ?? fallbackWorkspace
  if (!ws) {
    return { workspace: undefined, isGit: false, isWorktree: false, items: [] }
  }
  const [gitStatus, linked, cpItems] = await Promise.all([
    getGitRepoStatus(ws),
    isLinkedWorktree(ws),
    conversationId ? checkpoints.entries(conversationId, ws) : Promise.resolve([]),
  ])
  const [gitItems, branches, aheadBehind] = gitStatus.isRepo
    ? await Promise.all([
        getGitChanges(ws, conv?.worktreeBaseBranch),
        listGitBranches(ws),
        getGitAheadBehind(ws),
      ])
    : [[], [], { ahead: 0, behind: 0 }]
  const merged = new Map(gitItems.map((item) => [item.path, item]))
  for (const cp of cpItems) merged.set(cp.path, cp)
  const items = [...merged.values()]
  if (conversationId) {
    const additions = items.reduce((s, x) => s + x.additions, 0)
    const deletions = items.reduce((s, x) => s + x.deletions, 0)
    await chats.setDiffStats(conversationId, { additions, deletions }).catch(() => undefined)
  }
  return {
    workspace: ws,
    isGit: gitStatus.isRepo,
    branch: conv?.worktreeBranch ?? gitStatus.branch,
    head: gitStatus.head,
    isWorktree: Boolean(conv?.worktreeBaseWorkspace) || linked,
    baseBranch: conv?.worktreeBaseBranch,
    branches,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    githubRepo: gitStatus.githubRepo,
    items,
  }
}

async function resolveDraftKey(settings: SettingsStore, draft: ProviderDraft): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const key = draft.apiKey?.trim() || (draft.id ? await settings.providerKey(draft.id) : '')
  const local = /^https?:\/\/(localhost|127\.)/.test(draft.baseUrl)
  if (!key && !local) return { ok: false, error: '请先填写 API Key。' }
  return { ok: true, key }
}

async function testDraft(settings: SettingsStore, draft: ProviderDraft) {
  const resolved = await resolveDraftKey(settings, draft)
  if (!resolved.ok) return resolved
  return testConnection(draft, resolved.key)
}

async function fetchDraftModels(settings: SettingsStore, draft: ProviderDraft) {
  const resolved = await resolveDraftKey(settings, draft)
  if (!resolved.ok) return resolved
  return fetchProviderModels(draft, resolved.key)
}

async function suggestCommitMessage(
  settings: SettingsStore,
  chats: ChatStore,
  checkpoints: CheckpointStore,
  workspace: string | undefined,
  conversationId?: string,
): Promise<string> {
  const changes = await computeWorkspaceChanges(chats, checkpoints, workspace ?? settings.get().workspace, conversationId)
  if (changes.items.length === 0) return ''
  const names = changes.items.slice(0, 3).map((i) => i.path.split('/').pop() ?? i.path)
  const fallback =
    changes.items.length <= 3
      ? `chore: update ${names.join(', ')}`
      : `chore: update ${names.slice(0, 2).join(', ')} and ${changes.items.length - 2} more files`

  const provider = settings.activeProvider()
  if (!provider || !provider.hasKey) return fallback
  try {
    const apiKey = await settings.providerKey(provider.id)
    const endpoint = endpointFor(provider, apiKey)
    const diffSnippet = changes.items
      .slice(0, 8)
      .map((i) => `[${i.status}] ${i.path} (+${i.additions}/-${i.deletions})\n${i.diff.slice(0, 1200)}`)
      .join('\n\n')
    const res = await chat(
      provider.protocol,
      endpoint,
      {
        model: provider.model,
        system:
          'Generate ONE concise single-line Conventional Commit subject line (<= 72 chars, no quotes, no markdown fences, lowercase prefix like feat:, fix:, refactor:, chore:, docs:).',
        messages: [{ role: 'user', text: diffSnippet }],
        tools: [],
        signal: AbortSignal.timeout(10_000),
        maxTokens: 80,
      },
      { onText: () => undefined },
    )
    const firstLine = res.text.trim().replace(/^[`"']+|[`"']+$/g, '').split('\n')[0]?.trim()
    return firstLine && firstLine.length <= 100 ? firstLine : fallback
  } catch {
    return fallback
  }
}

async function send(
  chats: ChatStore,
  agent: AgentLoop,
  conversationId: string,
  text: string,
  images?: ImageAttachment[],
  documents?: DocumentAttachment[],
): Promise<void> {
  const conversation = await chats.get(conversationId)
  if (!conversation) throw new Error(`No chat with id "${conversationId}".`)
  if (agent.busy(conversationId)) throw new Error('This chat is already working on something.')
  // Runs in the background; progress arrives as events. This resolves once
  // the turn has been accepted, not when it finishes.
  void agent.run(conversation, text, images, documents).catch((err) => {
    process.stderr.write(`agent run failed: ${errorText(err)}\n`)
  })
}

async function regenerate(chats: ChatStore, agent: AgentLoop, conversationId: string): Promise<void> {
  const conversation = await chats.get(conversationId)
  if (!conversation) throw new Error(`No chat with id "${conversationId}".`)
  if (agent.busy(conversationId)) throw new Error('This chat is already working on something.')
  void agent.regenerate(conversation).catch((err) => {
    process.stderr.write(`agent regenerate failed: ${errorText(err)}\n`)
  })
}

void main().catch((err) => {
  process.stderr.write(`core failed to start: ${errorText(err)}\n`)
  process.exit(1)
})
