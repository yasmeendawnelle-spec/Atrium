// Owns every configured MCP server: persistence, connections, and the tool
// catalogue the agent loop asks for. Tool names are namespaced as
// `mcp__<serverId>__<tool>` so two servers can expose the same tool name.
import { join } from 'node:path'
import type {
  McpPromptInfo,
  McpPromptResult,
  McpResourceContent,
  McpResourceInfo,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  ToolInfo,
} from '../../shared/types.ts'
import { newId, readJson, writeJson } from '../store.ts'
import { getSecret, setSecret, secretKey } from '../secrets.ts'
import { McpClient, testServer } from './client.ts'
import { clearMcpOAuth, startMcpOAuthFlow } from './oauth.ts'

const PREFIX = 'mcp__'

export interface McpTool {
  serverId: string
  serverName: string
  tool: ToolInfo
  /** The name the model sees. */
  exposedName: string
}

export class McpManager {
  private configs: McpServerConfig[] = []
  private clients = new Map<string, McpClient>()
  private readonly dir: string
  private readonly onStatus: (status: McpServerStatus) => void
  private readonly openExternal?: (url: string) => Promise<void>

  constructor(dir: string, onStatus: (status: McpServerStatus) => void, openExternal?: (url: string) => Promise<void>) {
    this.dir = dir
    this.onStatus = onStatus
    this.openExternal = openExternal
  }

  private path(): string {
    return join(this.dir, 'mcp-servers.json')
  }

  async load(opts?: { connect?: boolean }): Promise<void> {
    this.configs = await readJson(this.path(), [] as McpServerConfig[])
    if (opts?.connect === false) return
    this.connectEnabled()
  }

  /** Starts every enabled server that has no client yet (lets a caller defer `load`'s connects). */
  connectEnabled(): void {
    for (const config of this.configs) if (config.enabled && !this.clients.has(config.id)) void this.connect(config)
  }

  list(): McpServerConfig[] {
    return this.configs.map(redact)
  }

  statuses(): McpServerStatus[] {
    return this.configs.map((c) => this.clients.get(c.id)?.status ?? { id: c.id, state: 'off', tools: [], resources: [], prompts: [] })
  }

  tools(): McpTool[] {
    const out: McpTool[] = []
    for (const config of this.configs) {
      const client = this.clients.get(config.id)
      if (!client || client.status.state !== 'connected') continue
      for (const tool of client.status.tools) {
        out.push({ serverId: config.id, serverName: config.name, tool, exposedName: expose(config.id, tool.name) })
      }
    }
    return out
  }

  resources(): Array<McpResourceInfo & { serverId: string; serverName: string }> {
    const out: Array<McpResourceInfo & { serverId: string; serverName: string }> = []
    for (const config of this.configs) {
      const client = this.clients.get(config.id)
      if (!client || client.status.state !== 'connected') continue
      for (const res of client.status.resources ?? []) {
        out.push({ ...res, serverId: config.id, serverName: config.name })
      }
    }
    return out
  }

  prompts(): Array<McpPromptInfo & { serverId: string; serverName: string }> {
    const out: Array<McpPromptInfo & { serverId: string; serverName: string }> = []
    for (const config of this.configs) {
      const client = this.clients.get(config.id)
      if (!client || client.status.state !== 'connected') continue
      for (const prompt of client.status.prompts ?? []) {
        out.push({ ...prompt, serverId: config.id, serverName: config.name })
      }
    }
    return out
  }

  async readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<McpResourceContent> {
    const config = this.require(serverId)
    const client = this.clients.get(serverId)
    if (!client || client.status.state !== 'connected') {
      throw new Error(`Server "${config.name}" is not connected.`)
    }
    return client.readResource(uri, signal)
  }

  async getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpPromptResult> {
    const config = this.require(serverId)
    const client = this.clients.get(serverId)
    if (!client || client.status.state !== 'connected') {
      throw new Error(`Server "${config.name}" is not connected.`)
    }
    return client.getPrompt(name, args, signal)
  }

  findTool(exposedName: string): McpTool | undefined {
    return this.tools().find((t) => t.exposedName === exposedName)
  }

  async callTool(exposedName: string, args: Record<string, unknown>, signal: AbortSignal) {
    const found = this.findTool(exposedName)
    if (!found) throw new Error(`No connected server provides "${exposedName}".`)
    const client = this.clients.get(found.serverId)
    if (!client) throw new Error(`Server "${found.serverName}" is not connected.`)
    return client.callTool(found.tool.name, args, signal)
  }

  async save(
    draft: Omit<McpServerConfig, 'id'> & { id?: string },
    opts?: { connect?: boolean },
  ): Promise<McpServerConfig> {
    const id = draft.id && this.configs.some((c) => c.id === draft.id) ? draft.id : newId('mcp')
    const existing = this.configs.find((c) => c.id === id)
    const config: McpServerConfig = { ...draft, id, enabled: draft.enabled ?? existing?.enabled ?? true }
    await this.storeSecrets(config)
    this.configs = [...this.configs.filter((c) => c.id !== id), config]
    await writeJson(this.path(), this.configs)
    if (opts?.connect !== false) {
      if (config.enabled) void this.connect(config)
      else await this.disconnect(id)
    }
    return redact(config)
  }

  async remove(id: string): Promise<void> {
    const config = this.configs.find((c) => c.id === id)
    await this.disconnect(id)
    for (const ref of config?.secretKeys ?? []) {
      const name = ref.split(':').slice(1).join(':')
      await setSecret(secretKey('mcp', id, name), null)
    }
    await clearMcpOAuth(id).catch(() => undefined)
    this.configs = this.configs.filter((c) => c.id !== id)
    await writeJson(this.path(), this.configs)
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerStatus> {
    const config = this.require(id)
    config.enabled = enabled
    await writeJson(this.path(), this.configs)
    if (enabled) await this.connect(config)
    else await this.disconnect(id)
    return this.statusOf(id)
  }

  async reconnect(id: string): Promise<McpServerStatus> {
    await this.connect(this.require(id))
    return this.statusOf(id)
  }

  async oauthStart(id: string): Promise<McpServerStatus> {
    if (!this.openExternal) {
      throw new Error('Opening a browser window for OAuth is unavailable in this environment.')
    }
    const config = this.require(id)
    const { expiresAt } = await startMcpOAuthFlow(config, this.openExternal)
    config.authMode = 'oauth'
    config.oauth = {
      ...config.oauth,
      authorized: true,
      ...(expiresAt ? { expiresAt } : {}),
    }
    config.enabled = true
    await writeJson(this.path(), this.configs)
    await this.connect(config)
    return this.statusOf(id)
  }

  async oauthRevoke(id: string): Promise<McpServerStatus> {
    const config = this.require(id)
    await clearMcpOAuth(id)
    if (config.oauth) {
      config.oauth = {
        ...config.oauth,
        authorized: false,
        expiresAt: undefined,
      }
    }
    await writeJson(this.path(), this.configs)
    if (config.enabled) await this.connect(config)
    return this.statusOf(id)
  }

  async hasMissingSecrets(id: string): Promise<boolean> {
    const config = this.configs.find((c) => c.id === id)
    if (!config?.secretKeys?.length) return false
    for (const ref of config.secretKeys) {
      const [target, ...rest] = ref.split(':')
      const name = rest.join(':')
      const bag = target === 'env' ? config.env : target === 'header' ? config.headers : undefined
      if (bag?.[name]) continue
      const saved = await getSecret(secretKey('mcp', id, name))
      if (!saved) return true
    }
    return false
  }

  test(config: Omit<McpServerConfig, 'id' | 'enabled'> & { id?: string }): Promise<McpTestResult> {
    return testServer(config)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()))
    this.clients.clear()
  }

  private require(id: string): McpServerConfig {
    const config = this.configs.find((c) => c.id === id)
    if (!config) throw new Error(`No MCP server with id "${id}".`)
    return config
  }

  private statusOf(id: string): McpServerStatus {
    return this.clients.get(id)?.status ?? { id, state: 'off', tools: [], resources: [], prompts: [] }
  }

  private async connect(config: McpServerConfig): Promise<void> {
    await this.disconnect(config.id)
    const client = new McpClient(config, () => this.onStatus(client.status))
    this.clients.set(config.id, client)
    this.onStatus(client.status)
    await client.connect()
    this.onStatus(client.status)
  }

  private async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (!client) return
    this.clients.delete(id)
    await client.close()
    this.onStatus({ id, state: 'off', tools: [], resources: [], prompts: [] })
  }

  /** Moves secret values out of the config and into encrypted storage. */
  private async storeSecrets(config: McpServerConfig): Promise<void> {
    for (const ref of config.secretKeys ?? []) {
      const [target, ...rest] = ref.split(':')
      const name = rest.join(':')
      const bag = target === 'env' ? config.env : target === 'header' ? config.headers : undefined
      const value = bag?.[name]
      if (value) {
        await setSecret(secretKey('mcp', config.id, name), value)
        bag![name] = ''
      }
    }
  }
}

function expose(serverId: string, toolName: string): string {
  return `${PREFIX}${serverId}__${toolName}`
}

/** Empties secret values before anything crosses to the renderer. */
function redact(config: McpServerConfig): McpServerConfig {
  const copy: McpServerConfig = { ...config, env: { ...config.env }, headers: { ...config.headers } }
  for (const ref of copy.secretKeys ?? []) {
    const [target, ...rest] = ref.split(':')
    const name = rest.join(':')
    if (target === 'env' && copy.env) copy.env[name] = ''
    if (target === 'header' && copy.headers) copy.headers[name] = ''
  }
  return copy
}
