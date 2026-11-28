// Ephemeral localhost MCP + HTTP Agent-Bus for cross-agent delegation in Atrium Platform.
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type {
  PlatformAgentProfile,
  PlatformBoardNote,
  PlatformPermissionMode,
} from '../../shared/platform.ts'

export interface PlatformToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const PLATFORM_TOOL_DEFS: readonly PlatformToolDef[] = [
  {
    name: 'platform_list_agents',
    description:
      'List all available AI coding agents in this Atrium Platform session (their IDs, names, roles, permission modes, and whether they can be delegated to).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'platform_delegate',
    description:
      'Delegate a focused coding, research, review, or verification task to another agent on the local machine (for example: agy, codex, gemini-cli, atrium, claude-code). Set wait=true (default) to receive its final output and changed files directly, or wait=false to launch in parallel.',
    inputSchema: {
      type: 'object',
      properties: {
        target_agent: {
          type: 'string',
          description: 'Target agent ID (from platform_list_agents), e.g. "agy", "codex", "gemini-cli", "atrium", "claude-code".',
        },
        task: {
          type: 'string',
          description: 'Complete, self-contained instructions for the target agent (goal, file paths, constraints, verification steps).',
        },
        mode: {
          type: 'string',
          enum: ['plan', 'accept_edits', 'full_auto'],
          description: 'Optional permission mode override for this delegated task.',
        },
        use_worktree: {
          type: 'boolean',
          description: 'Optional override to isolate this task in its own Git worktree.',
        },
        model: {
          type: 'string',
          description: 'Optional model override passed to the target agent.',
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the delegated agent to finish before returning (default: true). Set false for parallel launches.',
        },
        timeout_sec: {
          type: 'number',
          description: 'Optional timeout in seconds (defaults to 600).',
        },
      },
      required: ['target_agent', 'task'],
    },
  },
  {
    name: 'platform_check_task',
    description: 'Check current status, recent output, changed files, and errors of a delegated task by task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID returned by platform_delegate.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'platform_wait_task',
    description: 'Block until an async/parallel delegated task completes and return its full output and changed files.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID returned by platform_delegate.' },
        timeout_sec: { type: 'number', description: 'Maximum wait time in seconds (default 600).' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'platform_send_followup',
    description:
      'Send follow-up instructions or review feedback to an already completed/stopped task, resuming that agent’s session context when supported.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Target task ID to resume/follow up on.' },
        message: { type: 'string', description: 'Follow-up prompt or revision instructions.' },
        wait: { type: 'boolean', description: 'Wait for completion (default: true).' },
      },
      required: ['task_id', 'message'],
    },
  },
  {
    name: 'platform_cancel_task',
    description: 'Stop/cancel a currently running delegated task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Running task ID to cancel.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'platform_board_post',
    description: 'Post a plan, status update, file-lock notice, handoff note, or review finding onto the shared session blackboard.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading for this board note.' },
        content: { type: 'string', description: 'Detailed note body.' },
        kind: {
          type: 'string',
          enum: ['plan', 'update', 'handoff', 'lock', 'review'],
          description: 'Category of blackboard note.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'platform_board_read',
    description: 'Read recent notes posted on the shared session blackboard by any participating agent or user.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of most recent notes to return (default 20).' },
      },
    },
  },
] as const

export interface BusCallContext {
  callerTaskId?: string
}

export type PlatformBusDispatcher = (
  toolName: string,
  args: Record<string, unknown>,
  ctx: BusCallContext,
) => Promise<unknown>

const BUS_CLI_HELPER_SOURCE = `// Ephemeral Atrium Platform CLI bridge helper (auto-generated per session).
const busUrl = process.env.ATRIUM_PLATFORM_BUS_URL
const token = process.env.ATRIUM_PLATFORM_BUS_TOKEN
const callerTaskId = process.env.ATRIUM_PLATFORM_TASK_ID || ''

if (!busUrl || !token) {
  console.error('Missing ATRIUM_PLATFORM_BUS_URL or ATRIUM_PLATFORM_BUS_TOKEN')
  process.exit(1)
}

const [, , cmd, ...rest] = process.argv
const HELP = 'Usage: atrium-bus.mjs <list|delegate|check|wait|followup|cancel|board-post|board-read> ...'

async function callBus(tool, args) {
  const res = await fetch(busUrl + '/api/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...(callerTaskId ? { 'X-Atrium-Task-Id': callerTaskId } : {}),
    },
    body: JSON.stringify({ tool, args, callerTaskId }),
  })
  const text = await res.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON response (' + res.status + '): ' + text)
  }
  if (!res.ok || !parsed.ok) {
    throw new Error(parsed.error || 'Bus HTTP ' + res.status)
  }
  console.log(JSON.stringify(parsed.result, null, 2))
}

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP)
    return
  }
  if (cmd === 'list') {
    await callBus('platform_list_agents', {})
    return
  }
  if (cmd === 'delegate') {
    const [target, ...taskParts] = rest
    const task = taskParts.join(' ').trim()
    if (!target || !task) throw new Error('delegate requires <agentId> <task...>')
    await callBus('platform_delegate', { target_agent: target, task, wait: true })
    return
  }
  if (cmd === 'check') {
    if (!rest[0]) throw new Error('check requires <taskId>')
    await callBus('platform_check_task', { task_id: rest[0] })
    return
  }
  if (cmd === 'wait') {
    if (!rest[0]) throw new Error('wait requires <taskId>')
    await callBus('platform_wait_task', { task_id: rest[0] })
    return
  }
  if (cmd === 'followup') {
    const [taskId, ...msgParts] = rest
    const message = msgParts.join(' ').trim()
    if (!taskId || !message) throw new Error('followup requires <taskId> <message...>')
    await callBus('platform_send_followup', { task_id: taskId, message, wait: true })
    return
  }
  if (cmd === 'cancel') {
    if (!rest[0]) throw new Error('cancel requires <taskId>')
    await callBus('platform_cancel_task', { task_id: rest[0] })
    return
  }
  if (cmd === 'board-post') {
    const [title, ...bodyParts] = rest
    const content = bodyParts.join(' ').trim()
    if (!title || !content) throw new Error('board-post requires <title> <content...>')
    await callBus('platform_board_post', { title, content, kind: 'update' })
    return
  }
  if (cmd === 'board-read') {
    await callBus('platform_board_read', { limit: Number(rest[0]) || 20 })
    return
  }
  throw new Error('Unknown command: ' + cmd)
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err))
  process.exit(1)
})
`

function readBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Request payload too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export class PlatformBusServer {
  readonly sessionId: string
  readonly runtimeDir: string
  readonly token: string
  private server: Server | null = null
  private port = 0
  private helperScriptPath: string | null = null
  private dispatcher: PlatformBusDispatcher

  constructor(opts: { sessionId: string; runtimeDir: string; dispatcher: PlatformBusDispatcher }) {
    this.sessionId = opts.sessionId
    this.runtimeDir = opts.runtimeDir
    this.token = randomBytes(32).toString('hex')
    this.dispatcher = opts.dispatcher
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  get mcpUrl(): string {
    return `${this.baseUrl}/mcp`
  }

  async start(): Promise<void> {
    if (this.server) return
    await mkdir(this.runtimeDir, { recursive: true })
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        const addr = server.address() as AddressInfo | null
        if (!addr) {
          rejectListen(new Error('Failed to bind Platform Agent-Bus socket.'))
          return
        }
        this.port = addr.port
        resolveListen()
      })
    })
    this.server = server
  }

  async prepareTaskBridgeFiles(taskId: string): Promise<{ mcpConfigPath: string; helperPath: string; env: Record<string, string> }> {
    await mkdir(this.runtimeDir, { recursive: true })
    if (!this.helperScriptPath) {
      const helper = join(this.runtimeDir, 'atrium-bus.mjs')
      await writeFile(helper, BUS_CLI_HELPER_SOURCE, 'utf8')
      this.helperScriptPath = helper
    }
    const mcpConfigPath = join(this.runtimeDir, `mcp-${taskId}.json`)
    const mcpConfig = {
      mcpServers: {
        'atrium-platform': {
          type: 'http',
          url: this.mcpUrl,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'X-Atrium-Task-Id': taskId,
          },
        },
      },
    }
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8')
    return {
      mcpConfigPath,
      helperPath: this.helperScriptPath,
      env: {
        ATRIUM_PLATFORM_BUS_URL: this.baseUrl,
        ATRIUM_PLATFORM_BUS_TOKEN: this.token,
        ATRIUM_PLATFORM_TASK_ID: taskId,
        ATRIUM_PLATFORM_SESSION_ID: this.sessionId,
      },
    }
  }

  async close(): Promise<void> {
    const s = this.server
    this.server = null
    if (s) {
      await new Promise<void>((done) => s.close(() => done()))
    }
    await rm(this.runtimeDir, { recursive: true, force: true }).catch(() => undefined)
    this.helperScriptPath = null
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    return typeof header === 'string' && header.trim() === `Bearer ${this.token}`
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized: invalid Atrium Platform token.' })
      return
    }
    const urlPath = (req.url || '/').split('?')[0]
    const taskIdHeader = typeof req.headers['x-atrium-task-id'] === 'string' ? req.headers['x-atrium-task-id'].trim() : ''

    if (urlPath === '/mcp') {
      if (req.method === 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (req.method === 'DELETE') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      await this.handleMcpRpc(req, res, taskIdHeader || undefined)
      return
    }

    if (urlPath === '/api/call' && req.method === 'POST') {
      await this.handleHttpCall(req, res, taskIdHeader || undefined)
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  }

  private async handleHttpCall(req: IncomingMessage, res: ServerResponse, headerTaskId?: string): Promise<void> {
    try {
      const raw = await readBody(req)
      const body = raw ? (JSON.parse(raw) as { tool?: unknown; args?: unknown; callerTaskId?: unknown }) : {}
      const toolName = typeof body.tool === 'string' ? body.tool.trim() : ''
      if (!toolName) {
        sendJson(res, 400, { ok: false, error: 'Missing "tool" name.' })
        return
      }
      const args =
        body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? (body.args as Record<string, unknown>)
          : {}
      const callerTaskId =
        (typeof body.callerTaskId === 'string' && body.callerTaskId.trim()) || headerTaskId
      const result = await this.dispatcher(toolName, args, { callerTaskId })
      sendJson(res, 200, { ok: true, result })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async handleMcpRpc(req: IncomingMessage, res: ServerResponse, headerTaskId?: string): Promise<void> {
    let rpcId: unknown = null
    try {
      const raw = await readBody(req)
      const msg = JSON.parse(raw) as {
        jsonrpc?: string
        id?: unknown
        method?: string
        params?: Record<string, unknown>
      }
      rpcId = msg.id ?? null
      const method = msg.method || ''

      if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
        res.writeHead(202)
        res.end()
        return
      }
      if (method === 'initialize') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'atrium-platform', version: '0.1.0' },
          },
        })
        return
      }
      if (method === 'ping') {
        sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result: {} })
        return
      }
      if (method === 'tools/list') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpcId,
          result: {
            tools: PLATFORM_TOOL_DEFS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        })
        return
      }
      if (method === 'tools/call') {
        const params = msg.params ?? {}
        const name = typeof params.name === 'string' ? params.name : ''
        const args =
          params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {}
        try {
          const result = await this.dispatcher(name, args, { callerTaskId: headerTaskId })
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              isError: false,
            },
          })
        } catch (err) {
          sendJson(res, 200, {
            jsonrpc: '2.0',
            id: rpcId,
            result: {
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            },
          })
        }
        return
      }

      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32601, message: `Method not found: ${method}` },
      })
    } catch (err) {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

export function buildCommanderSystemPrompt(opts: {
  commander: PlatformAgentProfile
  roster: readonly PlatformAgentProfile[]
  workspace: string
  useWorktrees: boolean
  maxDepth: number
  helperPath: string
  board: readonly PlatformBoardNote[]
}): string {
  const peers = opts.roster.filter(
    (a) => a.id !== opts.commander.id && a.available && a.role !== 'disabled',
  )
  const peerLines = peers.length
    ? peers
        .map(
          (a) =>
            `- \`${a.id}\` (${a.name} · role=${a.role} · mode=${a.permissionMode}${a.modelOverride ? ` · model=${a.modelOverride}` : ''})`,
        )
        .join('\n')
    : '- (No other external or teammate agents are enabled right now; handle the mission directly.)'

  const toolUsage = opts.commander.supportsMcpInjection
    ? `You have the \`atrium-platform\` MCP tools connected directly in this session:
- \`platform_list_agents\`: list available teammate agents
- \`platform_delegate(target_agent, task, mode?, use_worktree?, model?, wait?)\`: delegate focused work to another agent (for example \`agy\`, \`codex\`, \`gemini-cli\`, \`atrium\`)
- \`platform_check_task(task_id)\` / \`platform_wait_task(task_id)\`: inspect or wait for parallel background tasks
- \`platform_send_followup(task_id, message)\`: send revision feedback or follow-up instructions to a delegated agent
- \`platform_cancel_task(task_id)\`: cancel a running task
- \`platform_board_post(title, content, kind?)\` / \`platform_board_read()\`: coordinate on the shared session blackboard`
    : `Invoke the Atrium Platform Agent-Bus via Node CLI helper:
- \`node "${opts.helperPath}" list\`
- \`node "${opts.helperPath}" delegate <agentId> "<detailed task>"\`
- \`node "${opts.helperPath}" check <taskId>\`
- \`node "${opts.helperPath}" wait <taskId>\`
- \`node "${opts.helperPath}" followup <taskId> "<message>"\`
- \`node "${opts.helperPath}" board-post "<title>" "<content>"\`
- \`node "${opts.helperPath}" board-read\``

  const boardSnippet = opts.board.length
    ? `\nRecent shared blackboard notes:\n${opts.board
        .slice(-5)
        .map((n) => `- [${n.kind}] ${n.authorName}: **${n.title}** — ${n.content.slice(0, 200)}`)
        .join('\n')}`
    : ''

  return `You are acting as the **Commander** (${opts.commander.name}) inside **Atrium Platform**.
Workspace: ${opts.workspace}
Worktree isolation default: ${opts.useWorktrees ? 'ON (each delegated agent can edit safely in its own worktree)' : 'OFF (shared workspace; coordinate file ownership to avoid conflicts)'}
Max delegation depth: ${opts.maxDepth}

Available teammate agents you can command:
${peerLines}

${toolUsage}

Orchestration rules:
1. When a task benefits from specialized or parallel execution (e.g., delegating coding/edits, UI, refactoring, tests, or independent code review to \`agy\`, \`codex\`, \`gemini-cli\`, \`atrium\`, etc.), decompose it clearly and delegate via \`platform_delegate\`.
2. Give every delegated agent self-contained context: exact file paths, goal, constraints, and what checks to run.
3. For independent parts in parallel, pass \`wait: false\` to \`platform_delegate\`, then collect results with \`platform_wait_task\`. Note: if sharing the workspace (worktrees OFF), never let two parallel workers edit the same file simultaneously — coordinate via \`platform_board_post\`.
4. After workers finish, inspect their outputs and changed files; use \`platform_send_followup\` if something is incomplete, then synthesize a clear final report for the user.${boardSnippet}`
}

export function buildWorkerSystemPrompt(opts: {
  worker: PlatformAgentProfile
  fromAgentName: string
  workspace: string
  permissionMode: PlatformPermissionMode
  canDelegateDeeper: boolean
  helperPath: string
  board: readonly PlatformBoardNote[]
}): string {
  const modeNote: Record<PlatformPermissionMode, string> = {
    plan: 'Permission mode is READ-ONLY PLAN. Do not modify files or run mutating commands.',
    accept_edits: 'You can inspect the repository and make targeted file edits inside the assigned workspace.',
    full_auto: 'You can inspect, edit files, and run build/test verification commands inside the assigned workspace.',
  }
  const busNote = opts.worker.supportsMcpInjection
    ? opts.canDelegateDeeper
      ? 'You also have `atrium-platform` MCP tools if you need to read/post on the shared blackboard (`platform_board_read`, `platform_board_post`).'
      : 'Focus directly on completing your assigned task without re-delegating.'
    : `Shared blackboard helper (optional): \`node "${opts.helperPath}" board-read\``
  const boardSnippet = opts.board.length
    ? `\nShared blackboard context:\n${opts.board
        .slice(-4)
        .map((n) => `- [${n.kind}] ${n.authorName}: ${n.title} — ${n.content.slice(0, 180)}`)
        .join('\n')}`
    : ''
  return `You are **${opts.worker.name}** working inside **Atrium Platform**, assigned a task by **${opts.fromAgentName}**.
Assigned workspace: ${opts.workspace}
${modeNote[opts.permissionMode]}
${busNote}${boardSnippet}

Report concisely with what files you touched, exact checks/tests run, and any blockers.`
}
