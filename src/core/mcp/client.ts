// One MCP server connection. Owns its transport, its client, and a ring
// buffer of the server's own log output so the UI can show why it failed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  LATEST_PROTOCOL_VERSION,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  ImageAttachment,
  McpPromptInfo,
  McpPromptResult,
  McpResourceContent,
  McpResourceInfo,
  McpServerConfig,
  McpServerStatus,
  McpTestResult,
  ToolInfo,
} from '../../shared/types.ts'
import { netFetch, proxyEnvFor } from '../net.ts'
import { getSecret, secretKey } from '../secrets.ts'
import { installHint } from '../runtimes.ts'
import { newId } from '../store.ts'
import { createBackgroundOAuthProvider, hasStoredOAuthBundle, isUnauthorizedMcpError } from './oauth.ts'

const STDERR_LIMIT = 4000
const TEST_TIMEOUT = 25_000
const MAX_MCP_IMAGES_PER_RESULT = 4
const MAX_MCP_IMAGE_B64_CHARS = Math.ceil(4 * 1024 * 1024 * 1.4)
const ALLOWED_IMAGE_EXT = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
])

export interface ResolvedServer {
  config: McpServerConfig
  env: Record<string, string>
  headers: Record<string, string>
}

export async function resolveSecrets(config: McpServerConfig): Promise<ResolvedServer> {
  const env = { ...(config.env ?? {}) }
  const headers = { ...(config.headers ?? {}) }
  for (const ref of config.secretKeys ?? []) {
    const [target, ...rest] = ref.split(':')
    const name = rest.join(':')
    // A value typed in the form wins; an empty one means "use the saved value".
    if (target === 'env' && !env[name]) env[name] = (await getSecret(secretKey('mcp', config.id, name))) ?? ''
    else if (target === 'header' && !headers[name]) headers[name] = (await getSecret(secretKey('mcp', config.id, name))) ?? ''
  }
  return { config, env, headers }
}

function toToolInfo(tool: { name: string; description?: string; inputSchema?: unknown }): ToolInfo {
  const schema = tool.inputSchema
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : { type: 'object' },
  }
}

export class McpClient {
  private client: Client | null = null
  private transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | null = null
  private stderr = ''
  private tools: ToolInfo[] = []
  private resources: McpResourceInfo[] = []
  private prompts: McpPromptInfo[] = []
  private connecting: Promise<void> | null = null
  readonly status: McpServerStatus
  readonly config: McpServerConfig
  private readonly onToolsChanged: (client: McpClient) => void

  constructor(config: McpServerConfig, onToolsChanged: (client: McpClient) => void) {
    this.config = config
    this.onToolsChanged = onToolsChanged
    this.status = { id: config.id, state: 'off', tools: [], resources: [], prompts: [] }
  }

  /** Name and version the server reported, once connected. */
  serverInfo(): { name?: string; version?: string } {
    const info = this.client?.getServerVersion()
    return { name: info?.name, version: info?.version }
  }

  get pid(): number | null {
    return this.transport instanceof StdioClientTransport ? this.transport.pid : null
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.connecting = this.open().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async open(): Promise<void> {
    await this.close()
    this.stderr = ''
    this.status.state = 'connecting'
    this.status.error = undefined
    this.status.needsAuth = false
    const resolved = await resolveSecrets(this.config)
    // A failed spawn surfaces only on the transport; `connect` itself just
    // reports "Connection closed". Keep the first real error to explain it.
    let transportError: unknown
    let interactiveAuthNeeded = false
    try {
      const client = new Client({ name: 'atrium', version: '0.1.0' })
      const transport = await this.makeTransport(resolved, () => {
        interactiveAuthNeeded = true
      })
      transport.onerror = (err) => {
        transportError ??= err
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshTools()
      })
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        void this.refreshResources()
      })
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        void this.refreshPrompts()
      })
      await client.connect(transport)
      this.client = client
      this.transport = transport
      await this.refreshTools()
      await Promise.allSettled([this.refreshResources(), this.refreshPrompts()])
      this.status.state = 'connected'
      this.status.needsAuth = false
    } catch (err) {
      await this.close()
      this.status.state = 'error'
      const rootErr = transportError ?? err
      const needsAuth = interactiveAuthNeeded || isUnauthorizedMcpError(rootErr) || isUnauthorizedMcpError(err)
      this.status.needsAuth = needsAuth
      this.status.error = needsAuth
        ? 'OAuth sign-in is required before this server can connect.'
        : spawnHint(rootErr, this.config, this.stderr)
      this.status.stderrTail = this.stderr || undefined
    }
  }

  private async makeTransport(resolved: ResolvedServer, onInteractiveAuthNeeded: () => void) {
    if (this.config.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: this.config.command ?? '',
        args: this.config.args ?? [],
        cwd: this.config.cwd,
        // The SDK's default environment keeps PATH, APPDATA and TEMP, which
        // npx and uvx need. The proxy variables make their downloads work.
        env: { ...getDefaultEnvironment(), ...(await proxyEnvFor()), ...resolved.env },
        stderr: 'pipe',
      })
      transport.stderr?.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_LIMIT)
        this.status.stderrTail = this.stderr
      })
      return transport
    }
    const url = new URL(this.config.url ?? '')
    const requestInit: RequestInit = { headers: resolved.headers }
    const hasOAuth = this.config.authMode === 'oauth' || (await hasStoredOAuthBundle(this.config.id))
    const authProvider = createBackgroundOAuthProvider(this.config, onInteractiveAuthNeeded)
    const probe = await probeStreamableHttp(url, resolved.headers)
    if (probe.streamable || hasOAuth || probe.unauthorized) {
      return new StreamableHTTPClientTransport(url, {
        requestInit,
        fetch: netFetch,
        authProvider,
      })
    }
    // Older servers only speak the deprecated SSE transport.
    return new SSEClientTransport(url, { requestInit, fetch: netFetch, authProvider })
  }

  private async refreshTools(): Promise<void> {
    if (!this.client) return
    const listed = await this.client.listTools()
    this.tools = (listed.tools ?? []).map(toToolInfo)
    this.status.tools = this.tools
    this.onToolsChanged(this)
  }

  private async refreshResources(): Promise<void> {
    if (!this.client) return
    const caps = this.client.getServerCapabilities()
    if (!caps?.resources) {
      this.resources = []
      this.status.resources = []
      return
    }
    try {
      const listed = await this.client.listResources()
      this.resources = (listed.resources ?? []).map((r) => ({
        uri: r.uri,
        name: r.name || r.uri,
        ...(r.description ? { description: r.description } : {}),
        ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      }))
    } catch {
      this.resources = []
    }
    this.status.resources = this.resources
    this.onToolsChanged(this)
  }

  private async refreshPrompts(): Promise<void> {
    if (!this.client) return
    const caps = this.client.getServerCapabilities()
    if (!caps?.prompts) {
      this.prompts = []
      this.status.prompts = []
      return
    }
    try {
      const listed = await this.client.listPrompts()
      this.prompts = (listed.prompts ?? []).map((p) => ({
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
        ...(Array.isArray(p.arguments)
          ? {
              arguments: p.arguments.map((a) => ({
                name: a.name,
                ...(a.description ? { description: a.description } : {}),
                ...(a.required !== undefined ? { required: a.required } : {}),
              })),
            }
          : {}),
      }))
    } catch {
      this.prompts = []
    }
    this.status.prompts = this.prompts
    this.onToolsChanged(this)
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ output: string; isError: boolean; images?: ImageAttachment[] }> {
    if (!this.client) throw new Error(`Server "${this.config.name}" is not connected.`)
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: 120_000,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: 600_000,
    })
    const parsed = parseMcpResult(result as { content?: unknown; toolResult?: unknown })
    return {
      output: parsed.output,
      isError: result.isError === true,
      ...(parsed.images?.length ? { images: parsed.images } : {}),
    }
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContent> {
    if (!this.client) throw new Error(`Server "${this.config.name}" is not connected.`)
    const res = await this.client.readResource({ uri }, { signal, timeout: 30_000 })
    const texts: string[] = []
    const images: ImageAttachment[] = []
    let mimeType: string | undefined
    for (const entry of res.contents ?? []) {
      const item = entry as { uri?: string; mimeType?: string; text?: string; blob?: string }
      mimeType ??= item.mimeType
      if (typeof item.text === 'string') {
        texts.push(item.text)
      } else if (typeof item.blob === 'string' && item.mimeType) {
        const img = toImageAttachment(item.mimeType, item.blob, item.uri || uri)
        if (img && images.length < MAX_MCP_IMAGES_PER_RESULT) {
          images.push(img)
        } else {
          texts.push(`[binary resource ${item.mimeType}]`)
        }
      }
    }
    return {
      serverId: this.config.id,
      serverName: this.config.name,
      uri,
      ...(mimeType ? { mimeType } : {}),
      ...(texts.length ? { text: texts.join('\n\n') } : {}),
      ...(images.length ? { images } : {}),
    }
  }

  async getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<McpPromptResult> {
    if (!this.client) throw new Error(`Server "${this.config.name}" is not connected.`)
    const res = await this.client.getPrompt({ name, arguments: args }, { signal, timeout: 30_000 })
    const texts: string[] = []
    const images: ImageAttachment[] = []
    for (const msg of res.messages ?? []) {
      const rolePrefix = msg.role && msg.role !== 'user' ? `[${msg.role}]\n` : ''
      const parsed = parseContentBlocks([msg.content], images)
      if (parsed) texts.push(`${rolePrefix}${parsed}`)
    }
    return {
      ...(res.description ? { description: res.description } : {}),
      text: texts.join('\n\n').trim(),
      ...(images.length ? { images } : {}),
    }
  }

  async close(): Promise<void> {
    const client = this.client
    this.client = null
    this.transport = null
    this.tools = []
    this.resources = []
    this.prompts = []
    this.status.tools = []
    this.status.resources = []
    this.status.prompts = []
    if (client) {
      try {
        await client.close()
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Probes an HTTP endpoint with a bare initialize request, without opening a
 * session. A JSON response means Streamable HTTP; an event stream or a
 * rejection means the older SSE transport.
 */
async function probeStreamableHttp(
  url: URL,
  headers: Record<string, string>,
): Promise<{ streamable: boolean; unauthorized: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await netFetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'atrium', version: '0.1.0' },
        },
      }),
      signal: controller.signal,
    })
    const type = res.headers.get('content-type') ?? ''
    return {
      streamable: res.ok && type.includes('application/json'),
      unauthorized: res.status === 401,
    }
  } catch {
    return { streamable: false, unauthorized: false }
  } finally {
    clearTimeout(timer)
  }
}

function spawnHint(err: unknown, config: McpServerConfig, stderr = ''): string {
  const e = err as { code?: string; message?: string }
  const message = e?.message || String(err)
  if (e?.code === 'ENOENT' || /spawn .* ENOENT/i.test(message)) {
    return `Couldn't find "${config.command}". ${installHint(config.command)}`
  }
  if (/Connection closed/i.test(message) && config.transport === 'stdio') {
    // The program started but exited before answering. Its log usually says why.
    const last = stderr.trim().split(/\r?\n/).pop()
    return `The program exited before it answered.${last ? ` Last log line: ${last}` : ' Check the command and try again.'}`
  }
  return message
}

function toImageAttachment(rawMime: string | undefined, rawData: string | undefined, hintName?: string): ImageAttachment | null {
  if (!rawMime || !rawData) return null
  const baseMime = rawMime.split(';')[0]?.trim().toLowerCase() ?? ''
  const mime = baseMime === 'image/jpg' ? 'image/jpeg' : baseMime
  const ext = ALLOWED_IMAGE_EXT.get(mime)
  if (!ext) return null
  const b64 = rawData.replace(/^data:[^;]+;base64,/i, '').trim()
  if (!b64 || b64.length > MAX_MCP_IMAGE_B64_CHARS) return null
  const label = hintName ? hintName.split('/').pop() || `mcp-image.${ext}` : `mcp-image.${ext}`
  return {
    id: newId('mcpimg'),
    name: label.includes('.') ? label : `${label}.${ext}`,
    mimeType: mime,
    dataUrl: `data:${mime};base64,${b64}`,
  }
}

function parseContentBlocks(blocks: unknown[], imagesOut: ImageAttachment[]): string {
  const parts = blocks.map((block) => {
    const b = block as {
      type?: string
      text?: string
      data?: string
      mimeType?: string
      resource?: { uri?: string; mimeType?: string; text?: string; blob?: string }
    }
    if (b.type === 'text') return b.text ?? ''
    if (b.type === 'image') {
      if (imagesOut.length < MAX_MCP_IMAGES_PER_RESULT) {
        const att = toImageAttachment(b.mimeType, b.data)
        if (att) {
          imagesOut.push(att)
          return `[image ${att.mimeType}]`
        }
      }
      return `[image omitted: unsupported type or exceeds 4MB limit (${b.mimeType ?? 'unknown'})]`
    }
    if (b.type === 'resource') {
      const res = b.resource
      const uri = res?.uri ?? ''
      if (typeof res?.text === 'string') {
        return uri ? `[resource ${uri}]\n${res.text}` : res.text
      }
      if (typeof res?.blob === 'string' && res.mimeType && imagesOut.length < MAX_MCP_IMAGES_PER_RESULT) {
        const att = toImageAttachment(res.mimeType, res.blob, uri || undefined)
        if (att) {
          imagesOut.push(att)
          return `[resource image ${uri || att.mimeType}]`
        }
      }
      return uri ? `[resource ${uri}${res?.mimeType ? ` (${res.mimeType})` : ''}]` : '[resource]'
    }
    return JSON.stringify(block)
  })
  return parts.join('\n').trim()
}

function parseMcpResult(result: { content?: unknown; toolResult?: unknown }): { output: string; images?: ImageAttachment[] } {
  // Servers on the 2024-10-07 protocol return `toolResult` instead of `content`.
  if (!Array.isArray(result.content) && result.toolResult !== undefined) {
    return {
      output: typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult, null, 2),
    }
  }
  const content = Array.isArray(result.content) ? result.content : []
  const images: ImageAttachment[] = []
  const text = parseContentBlocks(content, images)
  return {
    output: text || (images.length > 0 ? `[${images.length} image(s) attached]` : '(no output)'),
    ...(images.length ? { images } : {}),
  }
}

/** Connects, lists tools, and disconnects. Used by the add-server wizard. */
export async function testServer(config: Omit<McpServerConfig, 'id' | 'enabled'> & { id?: string }): Promise<McpTestResult> {
  const full: McpServerConfig = { ...config, id: config.id ?? 'test', enabled: true }
  const client = new McpClient(full, () => undefined)
  const timer = setTimeout(() => void client.close(), TEST_TIMEOUT)
  try {
    await client.connect()
    if (client.status.state === 'error') {
      return { ok: false, tools: [], error: client.status.error, stderrTail: client.status.stderrTail }
    }
    const info = client.serverInfo()
    return {
      ok: true,
      tools: client.status.tools,
      serverName: info.name,
      serverVersion: info.version,
      stderrTail: client.status.stderrTail,
    }
  } finally {
    clearTimeout(timer)
    await client.close()
  }
}
