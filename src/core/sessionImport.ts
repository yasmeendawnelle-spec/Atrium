// Zero-dependency discovery and cross-provider import of local coding agent sessions.
import { existsSync, statSync } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import type {
  ExternalAgentSource,
  ExternalSessionCandidate,
  ExternalSessionImportTarget,
  ExternalSessionScanResult,
  Message,
  SessionImportResult,
  ToolCall,
} from '../shared/types.ts'
import type { ChatStore } from './chats.ts'
import type { SettingsStore } from './settings.ts'

export interface SessionImportEnvOverrides {
  homeDir?: string
  appDataDir?: string
  xdgConfigDir?: string
  xdgDataDir?: string
  dshHomeDir?: string
}

export interface DiscoverSessionsOptions {
  chats: Pick<ChatStore, 'findByExternalOrigin'>
  workspace?: string
  recentWorkspaces?: string[]
  folderPath?: string
  envOverrides?: SessionImportEnvOverrides
}

export interface ImportSessionsOptions {
  chats: ChatStore
  settings: Pick<SettingsStore, 'get' | 'update'>
  items: ExternalSessionImportTarget[]
  workspaceOverride?: string
  overwriteExisting?: boolean
}

interface ParsedExternalSession {
  source: ExternalAgentSource
  sourceLabel: string
  externalId: string
  sourcePath: string
  title: string
  preview?: string
  workspace?: string
  messages: Message[]
  messageCount: number
  turnCount: number
  createdAt: number
  updatedAt: number
  fileSize?: number
}

interface EnvPaths {
  homeDir: string
  appDataDir: string
  xdgConfigDir: string
  xdgDataDir: string
  dshHomeDir: string
}

const SOURCE_LABELS: Record<ExternalAgentSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'OpenAI Codex',
  dsh: 'DeepSeek Harness (DSH)',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  cline: 'Cline / Roo Code',
  opencode: 'OpenCode',
  aider: 'Aider',
  custom: 'Custom Folder',
}

const ZSTD_MAGIC = 0xFD2FB528
const DSH_CANONICAL_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/

const MAX_FILES_PER_SOURCE = 60
const MAX_TOTAL_SESSIONS = 250
const DISCOVERY_HEAD_BYTES = 256 * 1024
const DISCOVERY_TAIL_BYTES = 32 * 1024
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOOL_OUTPUT_CHARS = 24_000
const SKIP_WALK_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.venv', '__pycache__'])

function resolveEnvPaths(overrides?: SessionImportEnvOverrides): EnvPaths {
  const homeDir = overrides?.homeDir || homedir()
  const appDataDir = overrides?.appDataDir || process.env.APPDATA || join(homeDir, 'AppData', 'Roaming')
  const xdgConfigDir = overrides?.xdgConfigDir || process.env.XDG_CONFIG_HOME || join(homeDir, '.config')
  const xdgDataDir = overrides?.xdgDataDir || process.env.XDG_DATA_HOME || join(homeDir, '.local', 'share')
  const dshHomeDir = overrides?.dshHomeDir || process.env.DSH_HOME || join(homeDir, '.dsh')
  return { homeDir, appDataDir, xdgConfigDir, xdgDataDir, dshHomeDir }
}

function asObject(val: unknown): Record<string, unknown> {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>
  }
  return {}
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return { value: parsed }
    } catch {
      return { raw: trimmed }
    }
  }
  return {}
}

function stringifyOutput(val: unknown): string {
  if (typeof val === 'string') return val
  if (val == null) return ''
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

function sanitizeToolName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
  return cleaned || 'tool'
}

function parseTimestamp(raw: unknown, fallback = 0): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw)
  }
  if (typeof raw === 'string' && raw.trim()) {
    const asNum = Number(raw.trim())
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? Math.round(asNum * 1000) : Math.round(asNum)
    }
    const ms = Date.parse(raw.trim())
    if (Number.isFinite(ms) && ms > 0) return ms
  }
  return fallback
}

function truncateToolOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… (truncated during import)`
}

function stripWrappedTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i')
  const match = re.exec(text)
  return match?.[1] ? match[1].trim() : null
}

function deriveTitleAndPreview(messages: Message[], explicitTitle?: string): { title: string; preview?: string } {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim())
  const lastContent = [...messages]
    .reverse()
    .find((m) => (m.role === 'assistant' || m.role === 'user') && m.text.trim())
  const previewSrc = lastContent && (lastContent.role === 'user' || lastContent.role === 'assistant') ? lastContent.text : ''
  const cleanPreview = previewSrc.replace(/\s+/g, ' ').trim()
  const preview = cleanPreview ? (cleanPreview.length > 140 ? `${cleanPreview.slice(0, 140)}…` : cleanPreview) : undefined

  const cleanExplicit = explicitTitle?.replace(/\s+/g, ' ').trim()
  if (cleanExplicit) {
    return {
      title: cleanExplicit.length > 72 ? `${cleanExplicit.slice(0, 72)}…` : cleanExplicit,
      preview,
    }
  }
  if (firstUser && firstUser.role === 'user') {
    const firstLine =
      firstUser.text
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .find(Boolean) ?? ''
    if (firstLine) {
      return {
        title: firstLine.length > 56 ? `${firstLine.slice(0, 56)}…` : firstLine,
        preview,
      }
    }
  }
  return { title: 'Imported chat', preview }
}

function countTurns(messages: Message[]): number {
  let turns = 0
  for (const m of messages) {
    if (m.role === 'user' && !m.isSummary) turns += 1
  }
  if (turns === 0 && messages.length > 0) return 1
  return turns
}

function extractTextFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (typeof b.text === 'string' && b.text) {
      parts.push(b.text)
    } else if (typeof b.content === 'string' && b.content && b.type !== 'tool_use') {
      parts.push(b.content)
    }
  }
  return parts.join('\n')
}

/**
 * Normalizes imported messages for cross-provider replay safety across Anthropic Messages,
 * OpenAI Responses, and Chat Completions APIs. Strips foreign cryptographic signatures and
 * guarantees every tool call has a valid ASCII ID, object input, and paired tool result.
 */
export function normalizeImportedMessages(rawMessages: Message[]): Message[] {
  const cleaned: Message[] = []
  for (const m of rawMessages) {
    if (m.role === 'user') {
      const text = (m.text ?? '').trim()
      if (!text && !m.images?.length && !m.documents?.length) continue
      cleaned.push({
        role: 'user',
        text,
        ...(m.images?.length ? { images: m.images } : {}),
        ...(m.documents?.length ? { documents: m.documents } : {}),
        ...(m.isSummary ? { isSummary: true } : {}),
      })
    } else if (m.role === 'assistant') {
      const text = (m.text ?? '').trim()
      const reasoningParts: string[] = []
      if (typeof m.reasoning === 'string' && m.reasoning.trim()) {
        reasoningParts.push(m.reasoning.trim())
      }
      if (Array.isArray(m.thinking)) {
        for (const t of m.thinking) {
          if (t?.thinking && t.thinking.trim()) reasoningParts.push(t.thinking.trim())
        }
      }
      if (Array.isArray(m.reasoningItems)) {
        for (const r of m.reasoningItems) {
          if (r?.summary && r.summary.trim()) reasoningParts.push(r.summary.trim())
        }
      }
      const reasoning = reasoningParts.join('\n\n').trim() || undefined
      const toolCalls: ToolCall[] = Array.isArray(m.toolCalls)
        ? m.toolCalls.map((c) => ({
            id: typeof c.id === 'string' ? c.id : '',
            name: sanitizeToolName(c.name),
            input: asObject(c.input),
          }))
        : []
      if (!text && !reasoning && toolCalls.length === 0) continue
      cleaned.push({
        role: 'assistant',
        text,
        toolCalls,
        ...(reasoning ? { reasoning } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
      })
    } else if (m.role === 'tool') {
      cleaned.push({
        role: 'tool',
        toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : '',
        name: sanitizeToolName(m.name),
        output: truncateToolOutput(typeof m.output === 'string' ? m.output : stringifyOutput(m.output)),
        isError: Boolean(m.isError),
        ...(m.images?.length ? { images: m.images } : {}),
      })
    }
  }

  while (cleaned.length > 0 && cleaned[0]!.role === 'tool') {
    cleaned.shift()
  }

  const normalized: Message[] = []
  for (let i = 0; i < cleaned.length; i += 1) {
    const m = cleaned[i]!
    if (m.role === 'user') {
      normalized.push(m)
      continue
    }
    if (m.role === 'tool') {
      // Drop orphan tool messages not immediately following an assistant with toolCalls.
      continue
    }

    const msgIdx = normalized.length
    const idMap = new Map<string, { id: string; name: string }>()
    const nextCalls: ToolCall[] = m.toolCalls.map((c, callIdx) => {
      const nextId = `imp_${msgIdx}_${callIdx}`
      const safeName = sanitizeToolName(c.name)
      if (c.id) idMap.set(c.id, { id: nextId, name: safeName })
      return { id: nextId, name: safeName, input: asObject(c.input) }
    })

    normalized.push({
      role: 'assistant',
      text: m.text,
      toolCalls: nextCalls,
      ...(m.reasoning ? { reasoning: m.reasoning } : {}),
      ...(m.usage ? { usage: m.usage } : {}),
    })

    if (nextCalls.length === 0) continue

    const followingTools: Array<Extract<Message, { role: 'tool' }>> = []
    let j = i + 1
    while (j < cleaned.length && cleaned[j]!.role === 'tool') {
      followingTools.push(cleaned[j] as Extract<Message, { role: 'tool' }>)
      j += 1
    }
    i = j - 1

    const matchedOutputs = new Map<string, Extract<Message, { role: 'tool' }>>()
    const unmatchedTools: Array<Extract<Message, { role: 'tool' }>> = []
    for (const tr of followingTools) {
      const mapped = tr.toolCallId ? idMap.get(tr.toolCallId) : undefined
      if (mapped && !matchedOutputs.has(mapped.id)) {
        matchedOutputs.set(mapped.id, {
          role: 'tool',
          toolCallId: mapped.id,
          name: mapped.name,
          output: tr.output,
          isError: tr.isError,
          ...(tr.images?.length ? { images: tr.images } : {}),
        })
      } else if (!tr.toolCallId) {
        unmatchedTools.push(tr)
      }
    }

    let positionalIdx = 0
    for (const call of nextCalls) {
      const existing = matchedOutputs.get(call.id)
      if (existing) {
        normalized.push(existing)
      } else if (positionalIdx < unmatchedTools.length) {
        const fallback = unmatchedTools[positionalIdx++]!
        normalized.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          output: fallback.output,
          isError: fallback.isError,
          ...(fallback.images?.length ? { images: fallback.images } : {}),
        })
      } else {
        normalized.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          output: '(imported without recorded output)',
          isError: false,
        })
      }
    }
  }

  return normalized
}

async function readTextHeadTail(
  filePath: string,
  fileSize: number,
  headBytes = DISCOVERY_HEAD_BYTES,
  tailBytes = DISCOVERY_TAIL_BYTES,
): Promise<{ head: string; tail: string; truncated: boolean }> {
  if (fileSize <= headBytes + tailBytes) {
    const full = await readFile(filePath, 'utf8')
    return { head: full, tail: '', truncated: false }
  }
  const fh = await open(filePath, 'r')
  try {
    const headBuf = Buffer.allocUnsafe(headBytes)
    const headRead = await fh.read(headBuf, 0, headBytes, 0)
    const tailOffset = Math.max(0, fileSize - tailBytes)
    const tailBuf = Buffer.allocUnsafe(tailBytes)
    const tailRead = await fh.read(tailBuf, 0, tailBytes, tailOffset)
    const headStr = headBuf.subarray(0, headRead.bytesRead).toString('utf8')
    const tailRaw = tailBuf.subarray(0, tailRead.bytesRead).toString('utf8')
    const nl = tailRaw.indexOf('\n')
    const tailStr = nl >= 0 ? tailRaw.slice(nl + 1) : tailRaw
    return { head: headStr, tail: tailStr, truncated: true }
  } finally {
    await fh.close()
  }
}

async function readJsonlRecords(filePath: string, full: boolean, fileSize: number): Promise<{ records: Record<string, unknown>[]; estimatedLines: number }> {
  const safeSize = Math.min(fileSize, MAX_IMPORT_FILE_BYTES)
  if (!full && safeSize > DISCOVERY_HEAD_BYTES + DISCOVERY_TAIL_BYTES) {
    const { head, tail } = await readTextHeadTail(filePath, safeSize)
    const headLines = head.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const tailLines = tail.split(/\r?\n/).filter((l) => l.trim().length > 0)
    const records: Record<string, unknown>[] = []
    for (const line of [...headLines, ...tailLines]) {
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>)
        }
      } catch {
        // Ignore partial line at slice boundary during fast discovery scan.
      }
    }
    const avgBytes = headLines.length > 0 ? head.length / headLines.length : 512
    return { records, estimatedLines: Math.max(records.length, Math.round(safeSize / Math.max(120, avgBytes))) }
  }
  const fh = await open(filePath, 'r')
  let text = ''
  try {
    const buf = Buffer.allocUnsafe(safeSize)
    const res = await fh.read(buf, 0, safeSize, 0)
    text = buf.subarray(0, res.bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const records: Record<string, unknown>[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>)
      }
    } catch {
      // Skip malformed JSONL line gracefully.
    }
  }
  return { records, estimatedLines: records.length }
}

async function collectFilesSortedByMtime(
  roots: string[],
  opts: { maxDepth: number; skipDirs?: Set<string>; predicate: (fullPath: string, name: string) => boolean; limit?: number },
): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const found: Array<{ path: string; size: number; mtimeMs: number }> = []
  const skip = opts.skipDirs ?? SKIP_WALK_DIRS

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > opts.maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && opts.predicate(full, entry.name)) {
        try {
          const st = await stat(full)
          if (st.size > 0) {
            found.push({ path: full, size: st.size, mtimeMs: st.mtimeMs })
          }
        } catch {
          // Ignore disappeared/unreadable files.
        }
      }
    }
  }

  for (const root of roots) {
    if (existsSync(root)) {
      await walk(root, 0)
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return opts.limit ? found.slice(0, opts.limit) : found
}

// ---- 1. Claude Code (~/.claude/projects/**/*.jsonl) ----

async function parseClaudeCodeFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  full: boolean,
): Promise<ParsedExternalSession | null> {
  const { records } = await readJsonlRecords(filePath, full, fileMeta.size)
  if (records.length === 0) return null

  let sessionId = basename(filePath, '.jsonl')
  let cwd: string | undefined
  let customTitle: string | undefined
  let createdAt = 0
  let updatedAt = 0

  const rawMessages: Message[] = []
  const toolNameMap = new Map<string, string>()
  let lastAssistantMsgId: string | undefined

  const getOrCreateAssistant = (msgId: string | undefined): Extract<Message, { role: 'assistant' }> => {
    const prev = rawMessages[rawMessages.length - 1]
    if (prev && prev.role === 'assistant' && msgId && msgId === lastAssistantMsgId) {
      return prev
    }
    lastAssistantMsgId = msgId
    const next: Extract<Message, { role: 'assistant' }> = { role: 'assistant', text: '', toolCalls: [] }
    rawMessages.push(next)
    return next
  }

  for (const rec of records) {
    if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) {
      sessionId = rec.sessionId.trim()
    }
    if (!cwd && typeof rec.cwd === 'string' && rec.cwd.trim()) {
      cwd = rec.cwd.trim()
    }
    const ts = parseTimestamp(rec.timestamp)
    if (ts > 0) {
      if (!createdAt || ts < createdAt) createdAt = ts
      if (ts > updatedAt) updatedAt = ts
    }

    const rType = rec.type
    if (rType === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) {
      customTitle = rec.customTitle.trim()
      continue
    }
    if (rec.isMeta === true || rec.isSidechain === true) continue
    if (
      rType === 'queue-operation' ||
      rType === 'attachment' ||
      rType === 'file-history-snapshot' ||
      rType === 'file-history-delta' ||
      rType === 'atis-latch' ||
      rType === 'agent-name' ||
      rType === 'last-prompt' ||
      rType === 'system'
    ) {
      continue
    }

    const msgObj = rec.message && typeof rec.message === 'object' ? (rec.message as Record<string, unknown>) : null
    if (!msgObj) continue

    if (rType === 'user' || msgObj.role === 'user') {
      const content = msgObj.content
      if (typeof content === 'string') {
        if (content.trim()) {
          lastAssistantMsgId = undefined
          rawMessages.push({ role: 'user', text: content })
        }
      } else if (Array.isArray(content)) {
        const userTextParts: string[] = []
        const toolResults: Array<Extract<Message, { role: 'tool' }>> = []
        for (const blk of content) {
          if (typeof blk === 'string') {
            if (blk.trim()) userTextParts.push(blk)
            continue
          }
          if (!blk || typeof blk !== 'object') continue
          const b = blk as Record<string, unknown>
          if (b.type === 'tool_result') {
            const tcId = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
            const outText = typeof b.content === 'string' ? b.content : extractTextFromBlocks(b.content)
            toolResults.push({
              role: 'tool',
              toolCallId: tcId,
              name: toolNameMap.get(tcId) ?? 'tool',
              output: outText,
              isError: Boolean(b.is_error),
            })
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            userTextParts.push(b.text)
          }
        }
        for (const tr of toolResults) {
          lastAssistantMsgId = undefined
          rawMessages.push(tr)
        }
        const joinedUser = userTextParts.join('\n').trim()
        if (joinedUser) {
          lastAssistantMsgId = undefined
          rawMessages.push({ role: 'user', text: joinedUser })
        }
      }
      continue
    }

    if (rType === 'assistant' || msgObj.role === 'assistant') {
      const msgId = typeof msgObj.id === 'string' ? msgObj.id : undefined
      const content = msgObj.content
      if (typeof content === 'string') {
        if (content.trim()) {
          const target = getOrCreateAssistant(msgId)
          target.text = [target.text, content].filter(Boolean).join('\n')
        }
      } else if (Array.isArray(content)) {
        let target: Extract<Message, { role: 'assistant' }> | null = null
        const ensure = () => {
          if (!target) target = getOrCreateAssistant(msgId)
          return target
        }
        for (const blk of content) {
          if (!blk || typeof blk !== 'object') continue
          const b = blk as Record<string, unknown>
          if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
            const asst = ensure()
            asst.reasoning = [asst.reasoning, b.thinking.trim()].filter(Boolean).join('\n\n')
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            const asst = ensure()
            asst.text = [asst.text, b.text].filter(Boolean).join('\n')
          } else if (b.type === 'tool_use') {
            const asst = ensure()
            const tcId = typeof b.id === 'string' ? b.id : `cc_${asst.toolCalls.length}`
            const tcName = sanitizeToolName(b.name)
            toolNameMap.set(tcId, tcName)
            asst.toolCalls.push({
              id: tcId,
              name: tcName,
              input: asObject(b.input),
            })
          }
        }
      }
    }
  }

  const messages = normalizeImportedMessages(rawMessages)
  if (messages.length === 0) return null
  const { title, preview } = deriveTitleAndPreview(messages, customTitle)
  const fallbackTs = Math.round(fileMeta.mtimeMs)
  return {
    source: 'claude-code',
    sourceLabel: SOURCE_LABELS['claude-code'],
    externalId: sessionId,
    sourcePath: filePath,
    title,
    preview,
    ...(cwd ? { workspace: cwd } : {}),
    messages,
    messageCount: messages.length,
    turnCount: countTurns(messages),
    createdAt: createdAt || fallbackTs,
    updatedAt: Math.max(createdAt || fallbackTs, updatedAt || fallbackTs),
    fileSize: fileMeta.size,
  }
}

// ---- 2. OpenAI Codex (~/.codex/sessions/**/*.jsonl) ----

function isCodexInjectedUserBoilerplate(text: string): boolean {
  const t = text.trim()
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('# AGENTS.md instructions') ||
    t.startsWith('<INSTRUCTIONS>')
  )
}

function extractCodexMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (
      (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text' || p.type === 'summary_text' || p.type === 'reasoning_text') &&
      typeof p.text === 'string' &&
      p.text
    ) {
      parts.push(p.text)
    }
  }
  return parts.join('\n')
}

async function parseCodexFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  full: boolean,
): Promise<ParsedExternalSession | null> {
  const { records } = await readJsonlRecords(filePath, full, fileMeta.size)
  if (records.length === 0) return null

  let sessionId = basename(filePath, '.jsonl')
  let cwd: string | undefined
  let createdAt = 0
  let updatedAt = 0
  let hasResponseItemMessages = false

  const responseMessages: Message[] = []
  const fallbackEventMessages: Message[] = []
  const callNameById = new Map<string, string>()
  let pendingReasoning: string[] = []

  const attachToOrPushAssistant = (opts: { text?: string; toolCall?: ToolCall }) => {
    const reasoning = pendingReasoning.join('\n\n').trim()
    pendingReasoning = []
    const last = responseMessages[responseMessages.length - 1]
    if (last && last.role === 'assistant') {
      if (reasoning) last.reasoning = [last.reasoning, reasoning].filter(Boolean).join('\n\n')
      if (opts.text) last.text = [last.text, opts.text].filter(Boolean).join('\n')
      if (opts.toolCall) last.toolCalls.push(opts.toolCall)
      return
    }
    responseMessages.push({
      role: 'assistant',
      text: opts.text ?? '',
      toolCalls: opts.toolCall ? [opts.toolCall] : [],
      ...(reasoning ? { reasoning } : {}),
    })
  }

  for (const rec of records) {
    const ts = parseTimestamp(rec.timestamp)
    if (ts > 0) {
      if (!createdAt || ts < createdAt) createdAt = ts
      if (ts > updatedAt) updatedAt = ts
    }

    const payload = rec.payload && typeof rec.payload === 'object' ? (rec.payload as Record<string, unknown>) : null
    if (!payload) continue

    if (rec.type === 'session_meta') {
      const id = typeof payload.id === 'string' ? payload.id : typeof payload.session_id === 'string' ? payload.session_id : ''
      if (id.trim()) sessionId = id.trim()
      if (!cwd && typeof payload.cwd === 'string' && payload.cwd.trim()) cwd = payload.cwd.trim()
      const metaTs = parseTimestamp(payload.timestamp)
      if (metaTs > 0 && (!createdAt || metaTs < createdAt)) createdAt = metaTs
      continue
    }

    if (rec.type === 'turn_context') {
      if (!cwd && typeof payload.cwd === 'string' && payload.cwd.trim()) cwd = payload.cwd.trim()
      continue
    }

    if (rec.type === 'response_item') {
      const pType = payload.type
      if (pType === 'message') {
        const role = payload.role
        if (role === 'developer' || role === 'system') continue
        const text = extractCodexMessageText(payload.content).trim()
        if (!text) continue
        if (role === 'user') {
          if (isCodexInjectedUserBoilerplate(text)) continue
          hasResponseItemMessages = true
          pendingReasoning = []
          responseMessages.push({ role: 'user', text })
        } else if (role === 'assistant') {
          hasResponseItemMessages = true
          attachToOrPushAssistant({ text })
        }
      } else if (pType === 'reasoning') {
        const sum = extractCodexMessageText(payload.summary).trim()
        const body = extractCodexMessageText(payload.content).trim()
        if (sum) pendingReasoning.push(sum)
        if (body && body !== sum) pendingReasoning.push(body)
      } else if (pType === 'function_call') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `cx_${responseMessages.length}`
        const name = sanitizeToolName(payload.name)
        callNameById.set(callId, name)
        attachToOrPushAssistant({
          toolCall: { id: callId, name, input: parseJsonObject(payload.arguments) },
        })
      } else if (pType === 'custom_tool_call') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : `cx_${responseMessages.length}`
        const name = sanitizeToolName(payload.name)
        callNameById.set(callId, name)
        const input = typeof payload.input === 'string' ? { input: payload.input } : asObject(payload.input)
        attachToOrPushAssistant({ toolCall: { id: callId, name, input } })
      } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
        responseMessages.push({
          role: 'tool',
          toolCallId: callId,
          name: callNameById.get(callId) ?? 'tool',
          output: stringifyOutput(payload.output),
          isError: false,
        })
      }
      continue
    }

    if (rec.type === 'event_msg') {
      const evType = payload.type
      if (evType === 'user_message' && typeof payload.message === 'string' && payload.message.trim()) {
        fallbackEventMessages.push({ role: 'user', text: payload.message.trim() })
      } else if (evType === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
        fallbackEventMessages.push({ role: 'assistant', text: payload.message.trim(), toolCalls: [] })
      }
    }
  }

  const chosen = hasResponseItemMessages ? responseMessages : fallbackEventMessages
  const messages = normalizeImportedMessages(chosen)
  if (messages.length === 0) return null
  const { title, preview } = deriveTitleAndPreview(messages)
  const fallbackTs = Math.round(fileMeta.mtimeMs)
  return {
    source: 'codex',
    sourceLabel: SOURCE_LABELS.codex,
    externalId: sessionId,
    sourcePath: filePath,
    title,
    preview,
    ...(cwd ? { workspace: cwd } : {}),
    messages,
    messageCount: messages.length,
    turnCount: countTurns(messages),
    createdAt: createdAt || fallbackTs,
    updatedAt: Math.max(createdAt || fallbackTs, updatedAt || fallbackTs),
    fileSize: fileMeta.size,
  }
}

// ---- 3. Antigravity (~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl) ----

const AGY_TOOL_STEP_TYPES = new Set([
  'CODE_ACTION',
  'RUN_COMMAND',
  'VIEW_FILE',
  'GREP_SEARCH',
  'FIND',
  'LIST_DIRECTORY',
  'SEARCH_WEB',
  'GENERIC',
  'WRITE_TO_FILE',
  'EDIT_FILE',
  'BROWSER_SUBAGENT',
  'ERROR_MESSAGE',
])

function resolveAntigravitySourceFile(transcriptPath: string, full: boolean): string {
  if (!full) return transcriptPath
  if (basename(transcriptPath) === 'transcript.jsonl') {
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    if (existsSync(fullPath)) return fullPath
  }
  return transcriptPath
}

function deriveAntigravityConvId(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const match = /\/brain\/([^/]+)\/\.system_generated\/logs\//.exec(normalized)
  if (match?.[1]) return match[1]
  const logsDir = dirname(filePath)
  const sysDir = dirname(logsDir)
  const parentDir = dirname(sysDir)
  return basename(parentDir) || basename(filePath, '.jsonl')
}

async function parseAntigravityFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  full: boolean,
): Promise<ParsedExternalSession | null> {
  const actualPath = resolveAntigravitySourceFile(filePath, full)
  let actualSize = fileMeta.size
  if (actualPath !== filePath) {
    try {
      actualSize = statSync(actualPath).size
    } catch {
      // Keep base size if stat fails.
    }
  }
  const { records } = await readJsonlRecords(actualPath, full, actualSize)
  if (records.length === 0) return null

  const externalId = deriveAntigravityConvId(filePath)
  let createdAt = 0
  let updatedAt = 0
  const rawMessages: Message[] = []
  let pendingToolQueue: Array<{ id: string; name: string }> = []
  let stepCounter = 0

  for (const rec of records) {
    const ts = parseTimestamp(rec.created_at)
    if (ts > 0) {
      if (!createdAt || ts < createdAt) createdAt = ts
      if (ts > updatedAt) updatedAt = ts
    }

    const rType = rec.type
    if (rType === 'USER_INPUT') {
      pendingToolQueue = []
      const rawContent = typeof rec.content === 'string' ? rec.content : ''
      const extracted = stripWrappedTag(rawContent, 'USER_REQUEST') ?? rawContent
      const cleanUser = extracted
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
        .trim()
      if (cleanUser) {
        rawMessages.push({ role: 'user', text: cleanUser })
      }
      continue
    }

    if (rType === 'PLANNER_RESPONSE') {
      pendingToolQueue = []
      const thinking = typeof rec.thinking === 'string' ? rec.thinking.trim() : ''
      const text = typeof rec.content === 'string' ? rec.content.trim() : ''
      const calls: ToolCall[] = []
      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          if (!tc || typeof tc !== 'object') continue
          const obj = tc as Record<string, unknown>
          const name = sanitizeToolName(obj.name)
          const id = `agy_${stepCounter++}`
          calls.push({ id, name, input: parseJsonObject(obj.args ?? obj.input) })
          pendingToolQueue.push({ id, name })
        }
      }
      if (text || thinking || calls.length > 0) {
        rawMessages.push({
          role: 'assistant',
          text,
          toolCalls: calls,
          ...(thinking ? { reasoning: thinking } : {}),
        })
      }
      continue
    }

    if (typeof rType === 'string' && AGY_TOOL_STEP_TYPES.has(rType)) {
      if (pendingToolQueue.length > 0) {
        const nextCall = pendingToolQueue.shift()!
        const output =
          typeof rec.content === 'string' && rec.content
            ? rec.content
            : typeof rec.error === 'string'
              ? rec.error
              : stringifyOutput(rec)
        rawMessages.push({
          role: 'tool',
          toolCallId: nextCall.id,
          name: nextCall.name,
          output,
          isError: rType === 'ERROR_MESSAGE' || Boolean(rec.error),
        })
      }
    }
  }

  const messages = normalizeImportedMessages(rawMessages)
  if (messages.length === 0) return null
  const { title, preview } = deriveTitleAndPreview(messages)
  const fallbackTs = Math.round(fileMeta.mtimeMs)
  return {
    source: 'antigravity',
    sourceLabel: SOURCE_LABELS.antigravity,
    externalId,
    sourcePath: filePath,
    title,
    preview,
    messages,
    messageCount: messages.length,
    turnCount: countTurns(messages),
    createdAt: createdAt || fallbackTs,
    updatedAt: Math.max(createdAt || fallbackTs, updatedAt || fallbackTs),
    fileSize: actualSize,
  }
}

// ---- 4. Cursor (User/globalStorage/state.vscdb + workspaceStorage) ----

interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { open?: boolean; readOnly?: boolean }) => {
    prepare: (sql: string) => {
      get: (...params: unknown[]) => Record<string, unknown> | undefined
      all: (...params: unknown[]) => Array<Record<string, unknown>>
    }
    close: () => void
  }
}

async function loadNodeSqlite(warnings: string[]): Promise<SqliteModule | null> {
  try {
    // Indirection avoids static bundling resolution of Node builtin node:sqlite.
    const sqliteSpec = ['node', 'sqlite'].join(':')
    const mod = (await import(sqliteSpec)) as unknown as Partial<SqliteModule>
    if (typeof mod.DatabaseSync === 'function') {
      return mod as SqliteModule
    }
    warnings.push('node:sqlite DatabaseSync unavailable; skipped Cursor SQLite databases.')
    return null
  } catch (err) {
    warnings.push(`Skipped Cursor SQLite database (${err instanceof Error ? err.message : String(err)}).`)
    return null
  }
}

function decodeWorkspaceUri(rawUri: string | undefined): string | undefined {
  if (!rawUri || typeof rawUri !== 'string') return undefined
  const trimmed = rawUri.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed)
    } catch {
      return undefined
    }
  }
  return trimmed
}

async function buildCursorWorkspaceMap(globalDbPath: string, sqlite: SqliteModule): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const userDir = dirname(dirname(globalDbPath))
  const wsRoot = join(userDir, 'workspaceStorage')
  if (!existsSync(wsRoot)) return map

  let dirs: string[] = []
  try {
    const entries = await readdir(wsRoot, { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => join(wsRoot, e.name))
  } catch {
    return map
  }

  for (const dir of dirs.slice(0, 80)) {
    const wjPath = join(dir, 'workspace.json')
    const wdbPath = join(dir, 'state.vscdb')
    if (!existsSync(wjPath) || !existsSync(wdbPath)) continue
    let folderPath: string | undefined
    try {
      const parsed = JSON.parse(await readFile(wjPath, 'utf8')) as { folder?: string; workspace?: string }
      folderPath = decodeWorkspaceUri(parsed.folder ?? parsed.workspace)
    } catch {
      continue
    }
    if (!folderPath) continue

    let db: InstanceType<SqliteModule['DatabaseSync']> | null = null
    try {
      db = new sqlite.DatabaseSync(wdbPath, { open: true, readOnly: true })
      const rows = db
        .prepare("SELECT value FROM ItemTable WHERE key IN ('composer.composerData', 'workbench.panel.aichat.view.aichat.chatdata')")
        .all()
      for (const r of rows) {
        if (!r?.value) continue
        try {
          const data = JSON.parse(String(r.value)) as {
            allComposers?: Array<{ composerId?: string }>
            tabs?: Array<{ tabId?: string }>
          }
          for (const c of data.allComposers ?? []) {
            if (typeof c?.composerId === 'string' && c.composerId) map.set(c.composerId, folderPath)
          }
          for (const t of data.tabs ?? []) {
            if (typeof t?.tabId === 'string' && t.tabId) map.set(t.tabId, folderPath)
          }
        } catch {
          // Ignore malformed workspace composer entry.
        }
      }
    } catch {
      // Skip locked or unreadable workspace SQLite DBs.
    } finally {
      try {
        db?.close()
      } catch {
        // ignore close failure
      }
    }
  }
  return map
}

function buildMessagesFromCursorBubbles(bubbles: Array<Record<string, unknown>>): Message[] {
  const raw: Message[] = []
  let callCounter = 0

  const appendAssistant = (opts: { text?: string; thinking?: string; toolCall?: ToolCall; toolResult?: Extract<Message, { role: 'tool' }> }) => {
    const prev = raw[raw.length - 1]
    if (prev && prev.role === 'assistant' && !opts.toolResult) {
      if (opts.thinking) prev.reasoning = [prev.reasoning, opts.thinking].filter(Boolean).join('\n\n')
      if (opts.text) prev.text = [prev.text, opts.text].filter(Boolean).join('\n')
      if (opts.toolCall) prev.toolCalls.push(opts.toolCall)
      return
    }
    if (opts.toolCall || opts.text || opts.thinking) {
      raw.push({
        role: 'assistant',
        text: opts.text ?? '',
        toolCalls: opts.toolCall ? [opts.toolCall] : [],
        ...(opts.thinking ? { reasoning: opts.thinking } : {}),
      })
    }
    if (opts.toolResult) {
      raw.push(opts.toolResult)
    }
  }

  for (const b of bubbles) {
    const bType = b.type
    const text = typeof b.text === 'string' ? b.text.trim() : ''
    if (bType === 1 || bType === 'user') {
      if (text) raw.push({ role: 'user', text })
      continue
    }
    if (bType === 2 || bType === 'ai' || bType === 'assistant') {
      const thinkingObj = b.thinking && typeof b.thinking === 'object' ? (b.thinking as Record<string, unknown>) : null
      const thinking = typeof thinkingObj?.text === 'string' ? thinkingObj.text.trim() : ''
      const tfd =
        b.toolFormerData && typeof b.toolFormerData === 'object' ? (b.toolFormerData as Record<string, unknown>) : null

      if (tfd) {
        const callId = `cur_${callCounter++}`
        const name = sanitizeToolName(tfd.name ?? tfd.tool ?? 'tool')
        const input = parseJsonObject(tfd.params ?? tfd.rawArgs ?? tfd.args)
        const resultStr = stringifyOutput(tfd.result)
        appendAssistant({ text, thinking, toolCall: { id: callId, name, input } })
        if (resultStr) {
          raw.push({
            role: 'tool',
            toolCallId: callId,
            name,
            output: resultStr,
            isError: tfd.status === 'error',
          })
        }
      } else if (text || thinking) {
        appendAssistant({ text, thinking })
      }
    }
  }

  return normalizeImportedMessages(raw)
}

async function discoverCursorDatabase(
  dbPath: string,
  sqlite: SqliteModule,
  warnings: string[],
  limit = MAX_FILES_PER_SOURCE,
): Promise<ParsedExternalSession[]> {
  if (!existsSync(dbPath)) return []
  const wsMap = await buildCursorWorkspaceMap(dbPath, sqlite)
  const sessions: ParsedExternalSession[] = []

  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true })
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()
    const getBubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')

    for (const row of rows) {
      const key = String(row.key ?? '')
      if (!key || key === 'composerData:empty-state-draft') continue
      let data: Record<string, unknown>
      try {
        data = JSON.parse(String(row.value)) as Record<string, unknown>
      } catch {
        continue
      }
      const composerId =
        (typeof data.composerId === 'string' && data.composerId.trim()) || key.slice('composerData:'.length)
      if (!composerId) continue

      const headers = Array.isArray(data.fullConversationHeadersOnly)
        ? (data.fullConversationHeadersOnly as Array<Record<string, unknown>>)
        : []
      const inlineConv = Array.isArray(data.conversation) ? (data.conversation as Array<Record<string, unknown>>) : []

      let bubbles: Array<Record<string, unknown>> = []
      if (headers.length > 0) {
        for (const h of headers) {
          const bid = typeof h?.bubbleId === 'string' ? h.bubbleId : ''
          if (!bid) continue
          const bRow = getBubbleStmt.get(`bubbleId:${composerId}:${bid}`)
          if (bRow?.value) {
            try {
              bubbles.push(JSON.parse(String(bRow.value)) as Record<string, unknown>)
            } catch {
              // ignore corrupt bubble
            }
          }
        }
      } else if (inlineConv.length > 0) {
        bubbles = inlineConv
      }

      if (bubbles.length === 0) continue
      const messages = buildMessagesFromCursorBubbles(bubbles)
      if (messages.length === 0) continue

      const explicitName =
        (typeof data.name === 'string' && data.name.trim()) ||
        (typeof data.title === 'string' && data.title.trim()) ||
        undefined
      const { title, preview } = deriveTitleAndPreview(messages, explicitName)
      const createdAt = parseTimestamp(data.createdAt, Date.now())
      const updatedAt = parseTimestamp(data.lastUpdatedAt ?? data.updatedAt, createdAt)

      let workspace = wsMap.get(composerId)
      if (!workspace && Array.isArray(data.workspaceUris) && data.workspaceUris[0]) {
        workspace = decodeWorkspaceUri(String(data.workspaceUris[0]))
      }
      if (!workspace) {
        for (const b of bubbles) {
          if (Array.isArray(b.workspaceUris) && b.workspaceUris[0]) {
            workspace = decodeWorkspaceUri(String(b.workspaceUris[0]))
            if (workspace) break
          }
        }
      }

      sessions.push({
        source: 'cursor',
        sourceLabel: SOURCE_LABELS.cursor,
        externalId: composerId,
        sourcePath: dbPath,
        title,
        preview,
        ...(workspace ? { workspace } : {}),
        messages,
        messageCount: messages.length,
        turnCount: countTurns(messages),
        createdAt,
        updatedAt: Math.max(createdAt, updatedAt),
      })
    }
  } catch (err) {
    warnings.push(`Failed reading Cursor database ${dbPath}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions.slice(0, limit)
}

async function parseSingleCursorComposer(dbPath: string, composerId: string): Promise<ParsedExternalSession | null> {
  const warnings: string[] = []
  const sqlite = await loadNodeSqlite(warnings)
  if (!sqlite || !existsSync(dbPath)) return null
  const wsMap = await buildCursorWorkspaceMap(dbPath, sqlite)

  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true })
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${composerId}`)
    if (!row?.value) return null
    const data = JSON.parse(String(row.value)) as Record<string, unknown>
    const headers = Array.isArray(data.fullConversationHeadersOnly)
      ? (data.fullConversationHeadersOnly as Array<Record<string, unknown>>)
      : []
    const inlineConv = Array.isArray(data.conversation) ? (data.conversation as Array<Record<string, unknown>>) : []

    let bubbles: Array<Record<string, unknown>> = []
    if (headers.length > 0) {
      const getBubbleStmt = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?')
      for (const h of headers) {
        const bid = typeof h?.bubbleId === 'string' ? h.bubbleId : ''
        if (!bid) continue
        const bRow = getBubbleStmt.get(`bubbleId:${composerId}:${bid}`)
        if (bRow?.value) {
          try {
            bubbles.push(JSON.parse(String(bRow.value)) as Record<string, unknown>)
          } catch {
            // ignore
          }
        }
      }
    } else {
      bubbles = inlineConv
    }

    const messages = buildMessagesFromCursorBubbles(bubbles)
    if (messages.length === 0) return null

    const explicitName =
      (typeof data.name === 'string' && data.name.trim()) ||
      (typeof data.title === 'string' && data.title.trim()) ||
      undefined
    const { title, preview } = deriveTitleAndPreview(messages, explicitName)
    const createdAt = parseTimestamp(data.createdAt, Date.now())
    const updatedAt = parseTimestamp(data.lastUpdatedAt ?? data.updatedAt, createdAt)
    const workspace =
      wsMap.get(composerId) ??
      (Array.isArray(data.workspaceUris) && data.workspaceUris[0] ? decodeWorkspaceUri(String(data.workspaceUris[0])) : undefined)

    return {
      source: 'cursor',
      sourceLabel: SOURCE_LABELS.cursor,
      externalId: composerId,
      sourcePath: dbPath,
      title,
      preview,
      ...(workspace ? { workspace } : {}),
      messages,
      messageCount: messages.length,
      turnCount: countTurns(messages),
      createdAt,
      updatedAt: Math.max(createdAt, updatedAt),
    }
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

// ---- 5. Gemini CLI (~/.gemini/tmp/<project>/chats/session-*.{json,jsonl}) ----

function readGeminiProjectRoot(chatFilePath: string): string | undefined {
  const chatsDir = dirname(chatFilePath)
  const projDir = dirname(chatsDir)
  const rootFile = join(projDir, '.project_root')
  if (!existsSync(rootFile)) return undefined
  try {
    if (!statSync(rootFile).isFile()) return undefined
  } catch {
    return undefined
  }
  return rootFile
}

function parseGeminiMessagesList(entries: Array<Record<string, unknown>>): {
  messages: Message[]
  createdAt: number
  updatedAt: number
} {
  const raw: Message[] = []
  let createdAt = 0
  let updatedAt = 0
  let tcCounter = 0

  for (const entry of entries) {
    const ts = parseTimestamp(entry.timestamp ?? entry.createdAt ?? entry.lastUpdated)
    if (ts > 0) {
      if (!createdAt || ts < createdAt) createdAt = ts
      if (ts > updatedAt) updatedAt = ts
    }

    const kind = typeof entry.type === 'string' ? entry.type : typeof entry.role === 'string' ? entry.role : ''
    const text =
      typeof entry.content === 'string'
        ? entry.content
        : typeof entry.text === 'string'
          ? entry.text
          : extractTextFromBlocks(entry.content)

    if (kind === 'user') {
      if (text.trim()) raw.push({ role: 'user', text: text.trim() })
      continue
    }

    if (kind === 'gemini' || kind === 'model' || kind === 'assistant') {
      const thoughtParts: string[] = []
      if (Array.isArray(entry.thoughts)) {
        for (const t of entry.thoughts) {
          if (typeof t === 'string' && t.trim()) thoughtParts.push(t.trim())
          else if (t && typeof t === 'object') {
            const o = t as Record<string, unknown>
            const desc = typeof o.description === 'string' ? o.description : typeof o.text === 'string' ? o.text : ''
            if (desc.trim()) thoughtParts.push(desc.trim())
          }
        }
      }
      const calls: ToolCall[] = []
      const postToolResults: Array<Extract<Message, { role: 'tool' }>> = []
      if (Array.isArray(entry.toolCalls)) {
        for (const tc of entry.toolCalls) {
          if (!tc || typeof tc !== 'object') continue
          const o = tc as Record<string, unknown>
          const id = typeof o.id === 'string' ? o.id : `gem_${tcCounter++}`
          const name = sanitizeToolName(o.name ?? o.displayName)
          calls.push({ id, name, input: parseJsonObject(o.args ?? o.input) })
          const resOut = stringifyOutput(o.result ?? o.resultDisplay)
          postToolResults.push({
            role: 'tool',
            toolCallId: id,
            name,
            output: resOut || '(completed)',
            isError: o.status === 'error',
          })
        }
      }
      const reasoning = thoughtParts.join('\n\n').trim() || undefined
      if (text.trim() || reasoning || calls.length > 0) {
        raw.push({
          role: 'assistant',
          text: text.trim(),
          toolCalls: calls,
          ...(reasoning ? { reasoning } : {}),
        })
        raw.push(...postToolResults)
      }
    }
  }

  return { messages: normalizeImportedMessages(raw), createdAt, updatedAt }
}

async function parseGeminiCliFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  full: boolean,
): Promise<ParsedExternalSession | null> {
  if (fileMeta.size > MAX_IMPORT_FILE_BYTES) return null
  let workspace: string | undefined
  const projRootFile = readGeminiProjectRoot(filePath)
  if (projRootFile) {
    try {
      const rawRoot = (await readFile(projRootFile, 'utf8')).trim()
      if (rawRoot) workspace = rawRoot
    } catch {
      // ignore
    }
  }

  let sessionId = basename(filePath).replace(/\.(jsonl?|JSONL?)$/, '')
  let createdAt = 0
  let updatedAt = 0
  let explicitTitle: string | undefined
  let msgEntries: Array<Record<string, unknown>> = []

  if (filePath.toLowerCase().endsWith('.json')) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
      if (typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) sessionId = parsed.sessionId.trim()
      if (typeof parsed.title === 'string' && parsed.title.trim()) explicitTitle = parsed.title.trim()
      createdAt = parseTimestamp(parsed.startTime ?? parsed.createdAt)
      updatedAt = parseTimestamp(parsed.lastUpdated ?? parsed.updatedAt)
      if (Array.isArray(parsed.messages)) {
        msgEntries = parsed.messages.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
      }
    } catch {
      return null
    }
  } else {
    const { records } = await readJsonlRecords(filePath, full, fileMeta.size)
    if (records.length === 0) return null
    for (const rec of records) {
      if (typeof rec.sessionId === 'string' && rec.sessionId.trim() && rec.kind === undefined && !rec.type && !rec.role) {
        sessionId = rec.sessionId.trim()
      }
      if (rec.startTime || rec.lastUpdated || (rec.sessionId && !rec.type && !rec.role)) {
        if (typeof rec.sessionId === 'string' && rec.sessionId.trim()) sessionId = rec.sessionId.trim()
        const st = parseTimestamp(rec.startTime)
        const lu = parseTimestamp(rec.lastUpdated)
        if (st > 0) createdAt = st
        if (lu > 0) updatedAt = lu
        continue
      }
      msgEntries.push(rec)
    }
  }

  const parsedMsgs = parseGeminiMessagesList(msgEntries)
  if (parsedMsgs.messages.length === 0) return null
  const { title, preview } = deriveTitleAndPreview(parsedMsgs.messages, explicitTitle)
  const fallbackTs = Math.round(fileMeta.mtimeMs)
  const finalCreated = createdAt || parsedMsgs.createdAt || fallbackTs
  const finalUpdated = Math.max(finalCreated, updatedAt || parsedMsgs.updatedAt || fallbackTs)
  return {
    source: 'gemini-cli',
    sourceLabel: SOURCE_LABELS['gemini-cli'],
    externalId: sessionId,
    sourcePath: filePath,
    title,
    preview,
    ...(workspace ? { workspace } : {}),
    messages: parsedMsgs.messages,
    messageCount: parsedMsgs.messages.length,
    turnCount: countTurns(parsedMsgs.messages),
    createdAt: finalCreated,
    updatedAt: finalUpdated,
    fileSize: fileMeta.size,
  }
}

// ---- 6. Cline / Roo Code (tasks/<taskId>/api_conversation_history.json) ----

async function parseClineTaskFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
): Promise<ParsedExternalSession | null> {
  if (fileMeta.size > MAX_IMPORT_FILE_BYTES) return null
  let entries: unknown
  try {
    entries = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(entries)) return null

  const taskDir = dirname(filePath)
  const externalId = basename(taskDir) || basename(filePath, '.json')
  const rawMessages: Message[] = []
  const toolNames = new Map<string, string>()

  for (const item of entries) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const role = rec.role
    if (role !== 'user' && role !== 'assistant') continue

    if (typeof rec.content === 'string') {
      if (rec.content.trim()) {
        rawMessages.push(
          role === 'user'
            ? { role: 'user', text: rec.content.trim() }
            : { role: 'assistant', text: rec.content.trim(), toolCalls: [] },
        )
      }
      continue
    }

    if (!Array.isArray(rec.content)) continue
    if (role === 'user') {
      const texts: string[] = []
      const tools: Array<Extract<Message, { role: 'tool' }>> = []
      for (const blk of rec.content) {
        if (!blk || typeof blk !== 'object') continue
        const b = blk as Record<string, unknown>
        if (b.type === 'tool_result') {
          const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
          tools.push({
            role: 'tool',
            toolCallId: id,
            name: toolNames.get(id) ?? 'tool',
            output: extractTextFromBlocks(b.content),
            isError: Boolean(b.is_error),
          })
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const clean = stripWrappedTag(b.text, 'task') ?? b.text
          texts.push(clean.trim())
        }
      }
      rawMessages.push(...tools)
      if (texts.length > 0) rawMessages.push({ role: 'user', text: texts.join('\n') })
    } else {
      const texts: string[] = []
      const thoughts: string[] = []
      const calls: ToolCall[] = []
      for (const blk of rec.content) {
        if (!blk || typeof blk !== 'object') continue
        const b = blk as Record<string, unknown>
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          thoughts.push(b.thinking.trim())
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          texts.push(b.text.trim())
        } else if (b.type === 'tool_use') {
          const id = typeof b.id === 'string' ? b.id : `cl_${calls.length}`
          const name = sanitizeToolName(b.name)
          toolNames.set(id, name)
          calls.push({ id, name, input: asObject(b.input) })
        }
      }
      const reasoning = thoughts.join('\n\n').trim() || undefined
      if (texts.length > 0 || reasoning || calls.length > 0) {
        rawMessages.push({
          role: 'assistant',
          text: texts.join('\n'),
          toolCalls: calls,
          ...(reasoning ? { reasoning } : {}),
        })
      }
    }
  }

  const messages = normalizeImportedMessages(rawMessages)
  if (messages.length === 0) return null
  const { title, preview } = deriveTitleAndPreview(messages)
  const fallbackTs = Math.round(fileMeta.mtimeMs)
  return {
    source: 'cline',
    sourceLabel: SOURCE_LABELS.cline,
    externalId,
    sourcePath: filePath,
    title,
    preview,
    messages,
    messageCount: messages.length,
    turnCount: countTurns(messages),
    createdAt: Number(externalId) > 1e12 ? Number(externalId) : fallbackTs,
    updatedAt: fallbackTs,
    fileSize: fileMeta.size,
  }
}

// ---- 7. OpenCode (~/.local/share/opencode/storage) ----

function findOpenCodeStorageRoot(sessionFilePath: string): string | null {
  let cur = dirname(sessionFilePath)
  for (let i = 0; i < 6; i += 1) {
    if (basename(cur) === 'storage') return cur
    if (existsSync(join(cur, 'session')) && existsSync(join(cur, 'message'))) return cur
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

async function parseOpenCodeSessionFile(
  sessionFilePath: string,
  fileMeta: { size: number; mtimeMs: number },
): Promise<ParsedExternalSession | null> {
  let sessionObj: Record<string, unknown>
  try {
    sessionObj = JSON.parse(await readFile(sessionFilePath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  const sessionId = typeof sessionObj.id === 'string' ? sessionObj.id.trim() : basename(sessionFilePath, '.json')
  if (!sessionId) return null

  const storageRoot = findOpenCodeStorageRoot(sessionFilePath)
  const rawMessages: Message[] = []
  let partCounter = 0

  if (storageRoot) {
    const msgDir = join(storageRoot, 'message', sessionId)
    if (existsSync(msgDir)) {
      let msgFiles: string[] = []
      try {
        msgFiles = (await readdir(msgDir)).filter((f) => f.endsWith('.json'))
      } catch {
        msgFiles = []
      }
      const msgRecords: Array<Record<string, unknown>> = []
      for (const f of msgFiles) {
        try {
          msgRecords.push(JSON.parse(await readFile(join(msgDir, f), 'utf8')) as Record<string, unknown>)
        } catch {
          // ignore
        }
      }
      msgRecords.sort((a, b) => {
        const ta = parseTimestamp(asObject(a.time).created ?? a.createdAt)
        const tb = parseTimestamp(asObject(b.time).created ?? b.createdAt)
        return ta - tb
      })

      for (const mr of msgRecords) {
        const msgId = typeof mr.id === 'string' ? mr.id : ''
        const role = mr.role
        const partDir = msgId ? join(storageRoot, 'part', msgId) : ''
        const partRecords: Array<Record<string, unknown>> = []
        if (partDir && existsSync(partDir)) {
          try {
            const partFiles = (await readdir(partDir)).filter((f) => f.endsWith('.json')).sort()
            for (const pf of partFiles) {
              try {
                partRecords.push(JSON.parse(await readFile(join(partDir, pf), 'utf8')) as Record<string, unknown>)
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }
        }

        if (role === 'user') {
          const texts = partRecords
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => String(p.text).trim())
            .filter(Boolean)
          if (texts.length > 0) rawMessages.push({ role: 'user', text: texts.join('\n') })
        } else if (role === 'assistant') {
          const texts: string[] = []
          const reasoning: string[] = []
          const calls: ToolCall[] = []
          const toolResults: Array<Extract<Message, { role: 'tool' }>> = []
          for (const p of partRecords) {
            if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
              texts.push(p.text.trim())
            } else if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.trim()) {
              reasoning.push(p.text.trim())
            } else if (p.type === 'tool') {
              const callId = typeof p.callID === 'string' ? p.callID : typeof p.id === 'string' ? p.id : `oc_${partCounter++}`
              const name = sanitizeToolName(p.tool)
              const stateObj = asObject(p.state)
              calls.push({ id: callId, name, input: asObject(stateObj.input) })
              const outStr = stringifyOutput(stateObj.output ?? stateObj.error)
              toolResults.push({
                role: 'tool',
                toolCallId: callId,
                name,
                output: outStr || '(completed)',
                isError: stateObj.status === 'error' || Boolean(stateObj.error),
              })
            }
          }
          if (texts.length > 0 || reasoning.length > 0 || calls.length > 0) {
            rawMessages.push({
              role: 'assistant',
              text: texts.join('\n'),
              toolCalls: calls,
              ...(reasoning.length > 0 ? { reasoning: reasoning.join('\n\n') } : {}),
            })
            rawMessages.push(...toolResults)
          }
        }
      }
    }
  }

  const messages = normalizeImportedMessages(rawMessages)
  if (messages.length === 0) return null
  const timeObj = asObject(sessionObj.time)
  const createdAt = parseTimestamp(timeObj.created, Math.round(fileMeta.mtimeMs))
  const updatedAt = parseTimestamp(timeObj.updated, createdAt)
  const explicitTitle = typeof sessionObj.title === 'string' ? sessionObj.title : undefined
  const workspace = typeof sessionObj.directory === 'string' && sessionObj.directory.trim() ? sessionObj.directory.trim() : undefined
  const { title, preview } = deriveTitleAndPreview(messages, explicitTitle)

  return {
    source: 'opencode',
    sourceLabel: SOURCE_LABELS.opencode,
    externalId: sessionId,
    sourcePath: sessionFilePath,
    title,
    preview,
    ...(workspace ? { workspace } : {}),
    messages,
    messageCount: messages.length,
    turnCount: countTurns(messages),
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt),
    fileSize: fileMeta.size,
  }
}

// ---- 8. Aider (.aider.chat.history.md) ----

async function parseAiderHistoryFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  targetIndex?: number,
): Promise<ParsedExternalSession[]> {
  if (fileMeta.size > MAX_IMPORT_FILE_BYTES) return []
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return []
  }

  const workspace = dirname(filePath)
  const headerRe = /^# aider chat started at (.+)$/gm
  const headers: Array<{ dateStr: string; idx: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = headerRe.exec(text)) !== null) {
    headers.push({ dateStr: match[1]!.trim(), idx: match.index, end: match.index + match[0].length })
  }
  if (headers.length === 0) return []

  const results: ParsedExternalSession[] = []
  for (let i = 0; i < headers.length; i += 1) {
    if (targetIndex !== undefined && i !== targetIndex) continue
    const h = headers[i]!
    const nextStart = headers[i + 1]?.idx ?? text.length
    const section = text.slice(h.end, nextStart)

    const raw: Message[] = []
    const lines = section.split(/\r?\n/)
    let assistantBuf: string[] = []
    let userBuf: string[] = []
    let inUserBlock = false

    const flushUser = () => {
      const joined = userBuf.join('\n').trim()
      userBuf = []
      if (joined) raw.push({ role: 'user', text: joined })
    }
    const flushAssistant = () => {
      const joined = assistantBuf.join('\n').trim()
      assistantBuf = []
      if (joined) raw.push({ role: 'assistant', text: joined, toolCalls: [] })
    }

    for (const line of lines) {
      if (line.startsWith('#### ')) {
        if (!inUserBlock) {
          flushAssistant()
          inUserBlock = true
        }
        userBuf.push(line.slice(5))
      } else {
        if (inUserBlock) {
          flushUser()
          inUserBlock = false
        }
        if (!line.startsWith('> ')) {
          assistantBuf.push(line)
        }
      }
    }
    if (inUserBlock) flushUser()
    else flushAssistant()

    const messages = normalizeImportedMessages(raw)
    if (messages.length === 0) continue

    const ts = parseTimestamp(h.dateStr, Math.round(fileMeta.mtimeMs))
    const { title, preview } = deriveTitleAndPreview(messages)
    const externalId = `${filePath}#session-${i}`
    results.push({
      source: 'aider',
      sourceLabel: SOURCE_LABELS.aider,
      externalId,
      sourcePath: filePath,
      title,
      preview,
      workspace,
      messages,
      messageCount: messages.length,
      turnCount: countTurns(messages),
      createdAt: ts,
      updatedAt: ts,
      fileSize: fileMeta.size,
    })
  }
  return results
}

// ---- 8.5. DeepSeek Harness (DSH: ~/.dsh/sessions/**/*.{jsonl,jsonl.zstd} & .segments/sessions.sqlite) ----

export interface ZstdFrameRange {
  start: number
  end: number
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  tornStart?: number
}

/**
 * Locate complete RFC 8878 Zstandard frames inside a concatenated multi-frame buffer
 * (matching `dsh-session-persistence-jsonl`). Reports an incomplete final frame via `tornStart`.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`Invalid Zstandard frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset >= buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`Invalid Zstandard frame header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`Reserved Zstandard block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length >= maxFrames) return { frames }
  }

  return { frames }
}

function decompressZstdFrames(
  buffer: Buffer,
  opts?: { maxHeadFrames?: number; includeLastFrame?: boolean },
): string {
  if (buffer.length === 0) return ''
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) return ''

  let selected: ZstdFrameRange[]
  const maxHead = opts?.maxHeadFrames
  if (maxHead && frames.length > maxHead) {
    selected = frames.slice(0, maxHead)
    if (opts?.includeLastFrame !== false) {
      selected.push(frames[frames.length - 1]!)
    }
  } else {
    selected = frames
  }

  const parts: string[] = []
  for (const { start, end } of selected) {
    const out = zstdDecompressSync(buffer.subarray(start, end))
    parts.push(Buffer.from(out).toString('utf8'))
  }
  return parts.join('')
}

/**
 * Parse canonical DSH session generation filenames (`session.jsonl`, `session.v4.jsonl.zstd`, etc.).
 */
export function parseDshLogFilename(filename: string): { version: number; compressed: boolean } | null {
  const m = DSH_CANONICAL_LOG_RE.exec(filename)
  if (!m) return null
  const version = m[1] ? Number(m[1]) : 0
  if (!Number.isSafeInteger(version)) return null
  return { version, compressed: Boolean(m[2]) }
}

function extractDshContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      if (block) parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      parts.push(b.text)
    } else if (b.type === 'file' && b.attachment && typeof b.attachment === 'object') {
      const att = b.attachment as Record<string, unknown>
      const name = typeof att.name === 'string' ? att.name : typeof att.path === 'string' ? att.path : 'file'
      parts.push(`[Attached file: ${name}]`)
    } else if (b.type === 'image' && b.attachment && typeof b.attachment === 'object') {
      const att = b.attachment as Record<string, unknown>
      const name = typeof att.name === 'string' ? att.name : 'image'
      parts.push(`[Image: ${name}]`)
    } else if (b.type !== 'reasoning' && b.type !== 'thinking' && b.type !== 'tool-call' && b.type !== 'tool_use') {
      if (typeof b.text === 'string' && b.text) parts.push(b.text)
    }
  }
  return parts.join('\n')
}

function parseDshRecords(
  records: Array<Record<string, unknown>>,
  sourcePath: string,
  fallback: { externalId: string; mtimeMs: number; size?: number; includeSubagents?: boolean },
): ParsedExternalSession | null {
  if (records.length === 0) return null

  let sessionId = fallback.externalId
  let cwd: string | undefined
  let createdAt = 0
  let updatedAt = 0
  let explicitTitle: string | undefined
  let origin: unknown

  const rawMessages: Message[] = []
  const callNames = new Map<string, string>()
  const seenCallIds = new Set<string>()

  const attachToolCall = (call: ToolCall) => {
    const prev = rawMessages[rawMessages.length - 1]
    if (prev && prev.role === 'assistant') {
      prev.toolCalls.push(call)
    } else {
      rawMessages.push({ role: 'assistant', text: '', toolCalls: [call] })
    }
  }

  for (const rec of records) {
    // Session header (JSONL line 0 `type: 'session'` or injected SQLite header object)
    if (rec.type === 'session' || (rec.id !== undefined && rec.version !== undefined && rec.isSeeded !== undefined)) {
      if (typeof rec.id === 'string' && rec.id.trim()) sessionId = rec.id.trim()
      if (!cwd && typeof rec.cwd === 'string' && rec.cwd.trim()) cwd = rec.cwd.trim()
      if (rec.origin !== undefined) origin = rec.origin
      const hdrTs = parseTimestamp(rec.createdAt)
      if (hdrTs > 0 && (!createdAt || hdrTs < createdAt)) createdAt = hdrTs
      continue
    }

    const ts = parseTimestamp(rec.time ?? rec.timestamp)
    if (ts > 0) {
      if (!createdAt || ts < createdAt) createdAt = ts
      if (ts > updatedAt) updatedAt = ts
    }

    const evType = typeof rec.type === 'string' ? rec.type : ''
    const data = asObject(rec.data ?? rec.payload ?? rec)

    if (evType === 'session/title') {
      if (typeof data.title === 'string' && data.title.trim()) {
        explicitTitle = data.title.trim()
      }
      continue
    }

    if (evType === 'working-directory/change' || evType === 'workspace-root/change') {
      const nextCwd = data.cwd ?? data.directory ?? data.path ?? data.root
      if (typeof nextCwd === 'string' && nextCwd.trim()) {
        cwd = nextCwd.trim()
      }
      continue
    }

    if (evType === 'user/message') {
      const msg = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : data
      const sourceObj = msg.source && typeof msg.source === 'object' ? (msg.source as Record<string, unknown>) : null
      if (sourceObj?.kind && sourceObj.kind !== 'user') continue
      const text = extractDshContentText(msg.content ?? msg.text).trim()
      if (text) rawMessages.push({ role: 'user', text })
      continue
    }

    if (evType === 'assistant/message') {
      const msg = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : data
      const content = msg.content
      const textParts: string[] = []
      const reasoningParts: string[] = []
      const calls: ToolCall[] = []

      if (typeof content === 'string') {
        if (content.trim()) textParts.push(content.trim())
      } else if (Array.isArray(content)) {
        for (const blk of content) {
          if (!blk || typeof blk !== 'object') continue
          const b = blk as Record<string, unknown>
          if ((b.type === 'reasoning' || b.type === 'thinking') && (typeof b.text === 'string' || typeof b.thinking === 'string')) {
            const rt = String(b.text ?? b.thinking ?? '').trim()
            if (rt) reasoningParts.push(rt)
          } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            textParts.push(b.text.trim())
          } else if (b.type === 'tool-call' || b.type === 'tool_use') {
            const callId =
              (typeof b.id === 'string' && b.id) ||
              (typeof b.callId === 'string' && b.callId) ||
              `dsh_${rawMessages.length}_${calls.length}`
            const name = sanitizeToolName(b.name)
            seenCallIds.add(callId)
            callNames.set(callId, name)
            calls.push({ id: callId, name, input: parseJsonObject(b.arguments ?? b.input) })
          }
        }
      }

      const text = textParts.join('\n')
      const reasoning = reasoningParts.join('\n\n').trim() || undefined
      if (text || reasoning || calls.length > 0) {
        rawMessages.push({
          role: 'assistant',
          text,
          toolCalls: calls,
          ...(reasoning ? { reasoning } : {}),
        })
      }
      continue
    }

    if (evType === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : typeof data.id === 'string' ? data.id : ''
      if (callId && seenCallIds.has(callId)) continue
      const finalId = callId || `dsh_tc_${rawMessages.length}`
      const name = sanitizeToolName(data.name)
      seenCallIds.add(finalId)
      callNames.set(finalId, name)
      attachToolCall({
        id: finalId,
        name,
        input: parseJsonObject(data.arguments ?? data.input),
      })
      continue
    }

    if (evType === 'tool/result') {
      const msg = data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>) : data
      const sourceObj = msg.source && typeof msg.source === 'object' ? (msg.source as Record<string, unknown>) : null
      const callId =
        (typeof sourceObj?.callId === 'string' && sourceObj.callId) ||
        (typeof data.callId === 'string' && data.callId) ||
        (typeof msg.toolCallId === 'string' && msg.toolCallId) ||
        ''
      const outText =
        extractDshContentText(msg.content) ||
        stringifyOutput(data.result ?? data.output)
      const isError = Boolean(msg.isError || data.error)
      rawMessages.push({
        role: 'tool',
        toolCallId: callId,
        name: (callId && callNames.get(callId)) || sanitizeToolName(msg.name ?? data.name),
        output: outText,
        isError,
      })
    }
  }

  if (origin === 'subagent' && !fallback.includeSubagents) {
    return null
  }

  const messages = normalizeImportedMessages(rawMessages)
  if (messages.length === 0) return null
  const { title, preview } = deriveTitleAndPreview(messages, explicitTitle)
  const fallbackTs = Math.round(fallback.mtimeMs)
  const finalCreated = createdAt || fallbackTs
  const finalUpdated = Math.max(finalCreated, updatedAt || fallbackTs)
  return {
    source: 'dsh',
    sourceLabel: SOURCE_LABELS.dsh,
    externalId: sessionId,
    sourcePath,
    title,
    preview,
    ...(cwd ? { workspace: cwd } : {}),
    messages,
    messageCount: messages.length,
    turnCount: countTurns(messages),
    createdAt: finalCreated,
    updatedAt: finalUpdated,
    ...(fallback.size !== undefined ? { fileSize: fallback.size } : {}),
  }
}

async function parseDshJsonlFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  full: boolean,
): Promise<ParsedExternalSession | null> {
  if (fileMeta.size > MAX_IMPORT_FILE_BYTES) return null

  const fallbackId = basename(dirname(filePath)) || basename(filePath)
  let records: Array<Record<string, unknown>> = []

  const lower = filePath.toLowerCase()
  const isZstdExt = lower.endsWith('.zstd')
  let isZstdMagic = false
  if (!isZstdExt && fileMeta.size >= 4) {
    const fh = await open(filePath, 'r')
    try {
      const hdr = Buffer.allocUnsafe(4)
      const rd = await fh.read(hdr, 0, 4, 0)
      if (rd.bytesRead === 4 && hdr.readUInt32LE(0) === ZSTD_MAGIC) {
        isZstdMagic = true
      }
    } finally {
      await fh.close()
    }
  }

  if (isZstdExt || isZstdMagic) {
    let rawBuf: Buffer
    try {
      rawBuf = await readFile(filePath)
    } catch {
      return null
    }
    let decodedText = ''
    try {
      decodedText = decompressZstdFrames(rawBuf, full ? undefined : { maxHeadFrames: 4, includeLastFrame: true })
    } catch {
      return null
    }
    for (const line of decodedText.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>)
        }
      } catch {
        // Ignore truncated/corrupt line gracefully.
      }
    }
  } else {
    const res = await readJsonlRecords(filePath, full, fileMeta.size)
    records = res.records
  }

  return parseDshRecords(records, filePath, {
    externalId: fallbackId,
    mtimeMs: fileMeta.mtimeMs,
    size: fileMeta.size,
  })
}

function collectDshSqliteRecordsForTrace(
  db: InstanceType<SqliteModule['DatabaseSync']>,
  trace: Record<string, unknown>,
  full: boolean,
): Array<Record<string, unknown>> | null {
  let headerObj: Record<string, unknown>
  try {
    headerObj = JSON.parse(String(trace.header)) as Record<string, unknown>
  } catch {
    return null
  }
  const records: Array<Record<string, unknown>> = [headerObj]

  const tailSegId = typeof trace.tail_segment_uuid === 'string' ? trace.tail_segment_uuid : ''
  if (!tailSegId) return records

  const segStmt = db.prepare(
    'SELECT segment_uuid, parent_segment_uuid, parent_end_seq, base_seq FROM segments WHERE segment_uuid = ?',
  )
  const framesStmt = db.prepare(
    'SELECT start_seq, end_seq, codec, payload FROM frames WHERE segment_uuid = ? ORDER BY start_seq ASC',
  )

  const chain: Array<{ segmentUuid: string; maxSeq: number }> = []
  let curSegId: string | null = tailSegId
  let nextChildParentEndSeq = Number.POSITIVE_INFINITY
  const visitedSegs = new Set<string>()

  while (curSegId && !visitedSegs.has(curSegId)) {
    visitedSegs.add(curSegId)
    const seg = segStmt.get(curSegId)
    if (!seg) break
    chain.push({ segmentUuid: curSegId, maxSeq: nextChildParentEndSeq })
    curSegId = typeof seg.parent_segment_uuid === 'string' ? seg.parent_segment_uuid : null
    nextChildParentEndSeq = typeof seg.parent_end_seq === 'number' ? seg.parent_end_seq : Number.POSITIVE_INFINITY
  }
  chain.reverse()

  const decodedLines: string[] = []
  const pushFrameLines = (codec: number, payload: Uint8Array) => {
    const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
    const text = codec === 1 ? Buffer.from(zstdDecompressSync(buf)).toString('utf8') : buf.toString('utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) decodedLines.push(trimmed)
    }
  }

  for (let i = 0; i < chain.length; i += 1) {
    const link = chain[i]!
    const rows = framesStmt.all(link.segmentUuid).filter((f) => Number(f.start_seq) <= link.maxSeq)
    if (!full && chain.length === 1 && rows.length > 5) {
      for (const r of rows.slice(0, 3)) {
        try {
          pushFrameLines(Number(r.codec), r.payload as Uint8Array)
        } catch {
          // ignore corrupt frame during quick scan
        }
      }
      const last = rows[rows.length - 1]!
      try {
        pushFrameLines(Number(last.codec), last.payload as Uint8Array)
      } catch {
        // ignore
      }
    } else {
      for (const r of rows) {
        try {
          pushFrameLines(Number(r.codec), r.payload as Uint8Array)
        } catch {
          // ignore
        }
      }
    }
  }

  for (const line of decodedLines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>)
      }
    } catch {
      // ignore malformed event JSON
    }
  }
  return records
}

function isDshSegmentsSqlite(db: InstanceType<SqliteModule['DatabaseSync']>): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('traces', 'segments', 'frames')")
    .all()
  return rows.length === 3
}

async function discoverDshSqliteDatabase(
  dbPath: string,
  sqlite: SqliteModule,
  warnings: string[],
  limit = MAX_FILES_PER_SOURCE,
): Promise<ParsedExternalSession[]> {
  if (!existsSync(dbPath)) return []
  let fileMtimeMs = Date.now()
  let fileSize = 0
  try {
    const st = await stat(dbPath)
    fileMtimeMs = st.mtimeMs
    fileSize = st.size
  } catch {
    return []
  }

  const sessions: ParsedExternalSession[] = []
  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true })
    if (!isDshSegmentsSqlite(db)) return []
    const traces = db.prepare('SELECT trace_uuid, header, tail_segment_uuid FROM traces').all()
    for (const trace of traces) {
      const traceUuid = typeof trace.trace_uuid === 'string' ? trace.trace_uuid : ''
      const records = collectDshSqliteRecordsForTrace(db, trace, false)
      if (!records) continue
      const parsed = parseDshRecords(records, dbPath, {
        externalId: traceUuid,
        mtimeMs: fileMtimeMs,
        size: fileSize,
      })
      if (parsed) sessions.push(parsed)
    }
  } catch (err) {
    warnings.push(`Failed reading DSH SQLite database ${dbPath}: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }

  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions.slice(0, limit)
}

async function parseSingleDshSqliteTrace(dbPath: string, externalId: string): Promise<ParsedExternalSession | null> {
  const warnings: string[] = []
  const sqlite = await loadNodeSqlite(warnings)
  if (!sqlite || !existsSync(dbPath)) return null

  const st = await stat(dbPath)
  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null
  try {
    db = new sqlite.DatabaseSync(dbPath, { open: true, readOnly: true })
    if (!isDshSegmentsSqlite(db)) return null
    const traces = db.prepare('SELECT trace_uuid, header, tail_segment_uuid FROM traces').all()
    for (const trace of traces) {
      let headerId = ''
      try {
        const hdr = JSON.parse(String(trace.header)) as { id?: unknown }
        if (typeof hdr?.id === 'string') headerId = hdr.id.trim()
      } catch {
        continue
      }
      const traceUuid = typeof trace.trace_uuid === 'string' ? trace.trace_uuid.trim() : ''
      if (headerId !== externalId && traceUuid !== externalId) continue
      const records = collectDshSqliteRecordsForTrace(db, trace, true)
      if (!records) return null
      return parseDshRecords(records, dbPath, {
        externalId: headerId || traceUuid,
        mtimeMs: st.mtimeMs,
        size: st.size,
        includeSubagents: true,
      })
    }
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // ignore
    }
  }
}

async function collectLatestDshJsonlFiles(dshSessionsRoot: string, limit: number): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const all = await collectFilesSortedByMtime([dshSessionsRoot], {
    maxDepth: 4,
    skipDirs: new Set([...SKIP_WALK_DIRS, '.segments']),
    predicate: (_fullPath, name) => parseDshLogFilename(name) !== null,
  })
  const bestByDir = new Map<string, { file: { path: string; size: number; mtimeMs: number }; version: number; compressed: boolean }>()
  for (const f of all) {
    const info = parseDshLogFilename(basename(f.path))
    if (!info) continue
    const dir = dirname(f.path)
    const prev = bestByDir.get(dir)
    const isBetter =
      !prev ||
      info.version > prev.version ||
      (info.version === prev.version &&
        ((info.compressed && !prev.compressed) ||
          (info.compressed === prev.compressed && f.mtimeMs > prev.file.mtimeMs)))
    if (isBetter) {
      bestByDir.set(dir, { file: f, version: info.version, compressed: info.compressed })
    }
  }
  return [...bestByDir.values()]
    .map((entry) => entry.file)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}

// ---- 9. Custom Folder / Generic Exports ----

async function parseCustomSessionFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
): Promise<ParsedExternalSession | null> {
  if (fileMeta.size > MAX_IMPORT_FILE_BYTES) return null
  const lower = filePath.toLowerCase()

  if (lower.endsWith('.json')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'))
    } catch {
      return null
    }
    const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    const rawList = Array.isArray(parsed) ? parsed : Array.isArray(obj?.messages) ? (obj.messages as unknown[]) : null
    if (!rawList || rawList.length === 0) return null

    // Convert Atrium export / generic { role, text|content } list cleanly
    const raw: Message[] = []
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue
      const m = entry as Record<string, unknown>
      if (m.role === 'user') {
        const text = typeof m.text === 'string' ? m.text : extractTextFromBlocks(m.content)
        if (text.trim()) raw.push({ role: 'user', text })
      } else if (m.role === 'assistant') {
        const text = typeof m.text === 'string' ? m.text : extractTextFromBlocks(m.content)
        const reasoning = typeof m.reasoning === 'string' ? m.reasoning : undefined
        const toolCalls = Array.isArray(m.toolCalls) ? (m.toolCalls as ToolCall[]) : []
        if (text.trim() || reasoning?.trim() || toolCalls.length > 0) {
          raw.push({ role: 'assistant', text, toolCalls, ...(reasoning ? { reasoning } : {}) })
        }
      } else if (m.role === 'tool') {
        raw.push({
          role: 'tool',
          toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : '',
          name: sanitizeToolName(m.name),
          output: typeof m.output === 'string' ? m.output : stringifyOutput(m.output),
          isError: Boolean(m.isError),
        })
      }
    }
    const messages = normalizeImportedMessages(raw)
    if (messages.length === 0) return null

    const explicitTitle = typeof obj?.title === 'string' ? obj.title : undefined
    const workspace = typeof obj?.workspace === 'string' && obj.workspace.trim() ? obj.workspace.trim() : undefined
    const externalId = typeof obj?.id === 'string' && obj.id.trim() ? obj.id.trim() : resolve(filePath)
    const createdAt = parseTimestamp(obj?.createdAt, Math.round(fileMeta.mtimeMs))
    const updatedAt = parseTimestamp(obj?.updatedAt, createdAt)
    const { title, preview } = deriveTitleAndPreview(messages, explicitTitle)
    return {
      source: 'custom',
      sourceLabel: SOURCE_LABELS.custom,
      externalId,
      sourcePath: filePath,
      title,
      preview,
      ...(workspace ? { workspace } : {}),
      messages,
      messageCount: messages.length,
      turnCount: countTurns(messages),
      createdAt,
      updatedAt: Math.max(createdAt, updatedAt),
      fileSize: fileMeta.size,
    }
  }

  if (lower.endsWith('.md')) {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch {
      return null
    }
    const sectionRe = /^##\s+(User|Assistant)\s*$/gm
    const matches: Array<{ role: 'user' | 'assistant'; idx: number; end: number }> = []
    let m: RegExpExecArray | null
    while ((m = sectionRe.exec(text)) !== null) {
      matches.push({ role: m[1]!.toLowerCase() as 'user' | 'assistant', idx: m.index, end: m.index + m[0].length })
    }
    if (matches.length === 0) return null

    const h1 = /^#\s+(.+)$/m.exec(text.slice(0, matches[0]!.idx))
    const explicitTitle = h1?.[1]?.trim()
    const raw: Message[] = []
    for (let i = 0; i < matches.length; i += 1) {
      const cur = matches[i]!
      const nextIdx = matches[i + 1]?.idx ?? text.length
      let body = text.slice(cur.end, nextIdx).trim()
      if (!body) continue
      if (cur.role === 'user') {
        raw.push({ role: 'user', text: body })
      } else {
        let reasoning: string | undefined
        const rMatch = /<details>\s*<summary>\s*Reasoning\s*<\/summary>\s*([\s\S]*?)\s*<\/details>/i.exec(body)
        if (rMatch?.[1]) {
          reasoning = rMatch[1].trim()
          body = body.replace(rMatch[0], '').trim()
        }
        // Strip exported tool subsections if any
        const toolIdx = body.search(/\n###\s+Tool:/i)
        if (toolIdx >= 0) body = body.slice(0, toolIdx).trim()
        if (body || reasoning) {
          raw.push({ role: 'assistant', text: body, toolCalls: [], ...(reasoning ? { reasoning } : {}) })
        }
      }
    }
    const messages = normalizeImportedMessages(raw)
    if (messages.length === 0) return null
    const { title, preview } = deriveTitleAndPreview(messages, explicitTitle)
    const fallbackTs = Math.round(fileMeta.mtimeMs)
    return {
      source: 'custom',
      sourceLabel: SOURCE_LABELS.custom,
      externalId: resolve(filePath),
      sourcePath: filePath,
      title,
      preview,
      messages,
      messageCount: messages.length,
      turnCount: countTurns(messages),
      createdAt: fallbackTs,
      updatedAt: fallbackTs,
      fileSize: fileMeta.size,
    }
  }

  return null
}

function toCandidate(parsed: ParsedExternalSession, chats: Pick<ChatStore, 'findByExternalOrigin'>): ExternalSessionCandidate {
  const existing = chats.findByExternalOrigin(parsed.source, parsed.externalId)
  const key = `${parsed.source}:${parsed.externalId}`
  return {
    key,
    source: parsed.source,
    sourceLabel: parsed.sourceLabel,
    externalId: parsed.externalId,
    sourcePath: parsed.sourcePath,
    title: parsed.title,
    ...(parsed.preview ? { preview: parsed.preview } : {}),
    ...(parsed.workspace ? { workspace: parsed.workspace, workspaceExists: existsSync(parsed.workspace) } : {}),
    messageCount: parsed.messageCount,
    turnCount: parsed.turnCount,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    ...(parsed.fileSize !== undefined ? { fileSize: parsed.fileSize } : {}),
    alreadyImported: Boolean(existing),
    ...(existing ? { importedChatId: existing.id } : {}),
  }
}

async function detectAndParseCustomFolderFile(
  filePath: string,
  fileMeta: { size: number; mtimeMs: number },
  sqlite: SqliteModule | null,
  warnings: string[],
  full: boolean,
): Promise<ParsedExternalSession[]> {
  const name = basename(filePath)
  const norm = filePath.replace(/\\/g, '/')

  if (name === 'state.vscdb' && sqlite) {
    return discoverCursorDatabase(filePath, sqlite, warnings, 40)
  }
  if (name.toLowerCase().endsWith('.sqlite') && sqlite) {
    return discoverDshSqliteDatabase(filePath, sqlite, warnings, 40)
  }
  if (name === '.aider.chat.history.md') {
    return parseAiderHistoryFile(filePath, fileMeta)
  }
  if (name === 'api_conversation_history.json') {
    const parsed = await parseClineTaskFile(filePath, fileMeta)
    return parsed ? [parsed] : []
  }
  if (name === 'transcript.jsonl' || (norm.includes('/.system_generated/logs/') && name === 'transcript_full.jsonl')) {
    const parsed = await parseAntigravityFile(filePath, fileMeta, full)
    return parsed ? [parsed] : []
  }
  if (/^session-.*\.jsonl?$/i.test(name) && norm.includes('/chats/')) {
    const parsed = await parseGeminiCliFile(filePath, fileMeta, full)
    return parsed ? [parsed] : []
  }
  if (parseDshLogFilename(name) !== null || name.toLowerCase().endsWith('.jsonl.zstd')) {
    const parsed = await parseDshJsonlFile(filePath, fileMeta, full)
    if (parsed) return [parsed]
  }
  if (name.endsWith('.jsonl')) {
    const { head } = await readTextHeadTail(filePath, Math.min(fileMeta.size, 32 * 1024), 8192, 0)
    if (/"type"\s*:\s*"session"|"user\/message"|"assistant\/message"/.test(head)) {
      const parsed = await parseDshJsonlFile(filePath, fileMeta, full)
      if (parsed) return [parsed]
    }
    if (/"session_meta"|"response_item"|"turn_context"/.test(head)) {
      const parsed = await parseCodexFile(filePath, fileMeta, full)
      if (parsed) return [parsed]
    }
    if (/"USER_INPUT"|"PLANNER_RESPONSE"/.test(head)) {
      const parsed = await parseAntigravityFile(filePath, fileMeta, full)
      if (parsed) return [parsed]
    }
    if (/"parentUuid"|"sessionId"/.test(head) && (/"type":"user"|"type": "user"|"type":"assistant"|"type": "assistant"/.test(head))) {
      const parsed = await parseClaudeCodeFile(filePath, fileMeta, full)
      if (parsed) return [parsed]
    }
    // Fallback probe for Claude / Codex without obvious first-chunk marker
    const claude = await parseClaudeCodeFile(filePath, fileMeta, full)
    if (claude) return [claude]
    const codex = await parseCodexFile(filePath, fileMeta, full)
    if (codex) return [codex]
    const agy = await parseAntigravityFile(filePath, fileMeta, full)
    if (agy) return [agy]
    return []
  }
  if (name.endsWith('.json') || name.endsWith('.md')) {
    if (name.endsWith('.json')) {
      try {
        const preview = await readFile(filePath, 'utf8')
        if (preview.includes('"projectID"') && preview.includes('"directory"') && preview.includes('"time"')) {
          const oc = await parseOpenCodeSessionFile(filePath, fileMeta)
          if (oc) return [oc]
        }
      } catch {
        // continue
      }
    }
    const custom = await parseCustomSessionFile(filePath, fileMeta)
    return custom ? [custom] : []
  }
  return []
}

/**
 * Discovers importable coding-agent sessions across standard local agent directories or a user-picked folder.
 */
export async function discoverExternalSessions(opts: DiscoverSessionsOptions): Promise<ExternalSessionScanResult> {
  const warnings: string[] = []
  const env = resolveEnvPaths(opts.envOverrides)
  const sessions: ParsedExternalSession[] = []
  const sourceRoots = new Map<ExternalAgentSource, Set<string>>()

  const addRoot = (source: ExternalAgentSource, root: string) => {
    if (!existsSync(root)) return
    let set = sourceRoots.get(source)
    if (!set) {
      set = new Set()
      sourceRoots.set(source, set)
    }
    set.add(root)
  }

  if (opts.folderPath?.trim()) {
    const folder = resolve(opts.folderPath.trim())
    if (!existsSync(folder)) {
      throw new Error(`Folder does not exist: ${folder}`)
    }
    const files = await collectFilesSortedByMtime([folder], {
      maxDepth: 4,
      limit: 300,
      predicate: (_full, name) =>
        name.endsWith('.jsonl') ||
        name.endsWith('.zstd') ||
        name.endsWith('.json') ||
        name.endsWith('.md') ||
        name.endsWith('.sqlite') ||
        name === 'state.vscdb',
    })
    const hasSqlite = files.some((f) => {
      const n = basename(f.path).toLowerCase()
      return n === 'state.vscdb' || n.endsWith('.sqlite')
    })
    const sqlite = hasSqlite ? await loadNodeSqlite(warnings) : null
    for (const f of files) {
      const parsedList = await detectAndParseCustomFolderFile(f.path, f, sqlite, warnings, false)
      for (const parsed of parsedList) {
        addRoot(parsed.source, folder)
        sessions.push(parsed)
      }
    }
  } else {
    // 1. Claude Code
    const claudeRoot = join(env.homeDir, '.claude', 'projects')
    addRoot('claude-code', claudeRoot)
    const claudeFiles = await collectFilesSortedByMtime([claudeRoot], {
      maxDepth: 3,
      skipDirs: new Set([...SKIP_WALK_DIRS, 'subagents']),
      limit: MAX_FILES_PER_SOURCE,
      predicate: (_full, name) => name.endsWith('.jsonl'),
    })
    for (const f of claudeFiles) {
      const parsed = await parseClaudeCodeFile(f.path, f, false)
      if (parsed) sessions.push(parsed)
    }

    // 2. OpenAI Codex
    const codexRoots = [join(env.homeDir, '.codex', 'sessions'), join(env.homeDir, '.codex', 'archived_sessions')]
    for (const r of codexRoots) addRoot('codex', r)
    const codexFiles = await collectFilesSortedByMtime(codexRoots, {
      maxDepth: 5,
      limit: MAX_FILES_PER_SOURCE,
      predicate: (_full, name) => name.endsWith('.jsonl'),
    })
    for (const f of codexFiles) {
      const parsed = await parseCodexFile(f.path, f, false)
      if (parsed) sessions.push(parsed)
    }

    // 2.5. DeepSeek Harness (DSH)
    const dshSessionsRoot = join(env.dshHomeDir, 'sessions')
    addRoot('dsh', dshSessionsRoot)
    const dshJsonlFiles = await collectLatestDshJsonlFiles(dshSessionsRoot, MAX_FILES_PER_SOURCE)
    for (const f of dshJsonlFiles) {
      const parsed = await parseDshJsonlFile(f.path, f, false)
      if (parsed) sessions.push(parsed)
    }
    const dshSqlitePath = join(dshSessionsRoot, '.segments', 'sessions.sqlite')
    if (existsSync(dshSqlitePath)) {
      const sqlite = await loadNodeSqlite(warnings)
      if (sqlite) {
        addRoot('dsh', dshSqlitePath)
        const dshSqliteSessions = await discoverDshSqliteDatabase(dshSqlitePath, sqlite, warnings, MAX_FILES_PER_SOURCE)
        sessions.push(...dshSqliteSessions)
      }
    }

    // 3. Antigravity
    const agyRoot = join(env.homeDir, '.gemini', 'antigravity', 'brain')
    addRoot('antigravity', agyRoot)
    const agyFiles = await collectFilesSortedByMtime([agyRoot], {
      maxDepth: 4,
      limit: MAX_FILES_PER_SOURCE,
      predicate: (fullPath, name) => name === 'transcript.jsonl' && fullPath.replace(/\\/g, '/').includes('/.system_generated/logs/'),
    })
    for (const f of agyFiles) {
      const parsed = await parseAntigravityFile(f.path, f, false)
      if (parsed) sessions.push(parsed)
    }

    // 4. Cursor
    const cursorCandidates = [
      join(env.appDataDir, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      join(env.homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      join(env.xdgConfigDir, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    ]
    const cursorDbs = [...new Set(cursorCandidates)].filter((p) => existsSync(p))
    if (cursorDbs.length > 0) {
      const sqlite = await loadNodeSqlite(warnings)
      if (sqlite) {
        for (const dbPath of cursorDbs) {
          addRoot('cursor', dbPath)
          const parsedList = await discoverCursorDatabase(dbPath, sqlite, warnings, MAX_FILES_PER_SOURCE)
          sessions.push(...parsedList)
        }
      }
    }

    // 5. Gemini CLI
    const geminiRoot = join(env.homeDir, '.gemini', 'tmp')
    addRoot('gemini-cli', geminiRoot)
    const geminiFiles = await collectFilesSortedByMtime([geminiRoot], {
      maxDepth: 4,
      limit: MAX_FILES_PER_SOURCE,
      predicate: (fullPath, name) =>
        fullPath.replace(/\\/g, '/').includes('/chats/') && /^session-.*\.jsonl?$/i.test(name),
    })
    for (const f of geminiFiles) {
      const parsed = await parseGeminiCliFile(f.path, f, false)
      if (parsed) sessions.push(parsed)
    }

    // 6. Cline / Roo Code
    const storageRoots = [
      join(env.appDataDir, 'Code', 'User', 'globalStorage'),
      join(env.appDataDir, 'Cursor', 'User', 'globalStorage'),
      join(env.appDataDir, 'Windsurf', 'User', 'globalStorage'),
      join(env.homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
      join(env.xdgConfigDir, 'Code', 'User', 'globalStorage'),
    ]
    const clineRoots: string[] = []
    for (const base of storageRoots) {
      for (const extId of ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline']) {
        const taskRoot = join(base, extId, 'tasks')
        if (existsSync(taskRoot)) {
          addRoot('cline', taskRoot)
          clineRoots.push(taskRoot)
        }
      }
    }
    const clineFiles = await collectFilesSortedByMtime(clineRoots, {
      maxDepth: 2,
      limit: MAX_FILES_PER_SOURCE,
      predicate: (_full, name) => name === 'api_conversation_history.json',
    })
    for (const f of clineFiles) {
      const parsed = await parseClineTaskFile(f.path, f)
      if (parsed) sessions.push(parsed)
    }

    // 7. OpenCode
    const opencodeRoots = [
      ...new Set([
        join(env.xdgDataDir, 'opencode', 'storage', 'session'),
        join(env.homeDir, '.local', 'share', 'opencode', 'storage', 'session'),
      ]),
    ]
    for (const r of opencodeRoots) addRoot('opencode', r)
    const opencodeFiles = await collectFilesSortedByMtime(opencodeRoots, {
      maxDepth: 3,
      limit: MAX_FILES_PER_SOURCE,
      predicate: (_full, name) => name.endsWith('.json'),
    })
    for (const f of opencodeFiles) {
      const parsed = await parseOpenCodeSessionFile(f.path, f)
      if (parsed) sessions.push(parsed)
    }

    // 8. Aider
    const aiderWorkspaces = [...new Set([opts.workspace, ...(opts.recentWorkspaces ?? [])].filter((w): w is string => Boolean(w?.trim())))]
    for (const ws of aiderWorkspaces) {
      const aiderFile = join(ws, '.aider.chat.history.md')
      if (!existsSync(aiderFile)) continue
      try {
        const st = await stat(aiderFile)
        addRoot('aider', ws)
        const parsedList = await parseAiderHistoryFile(aiderFile, { size: st.size, mtimeMs: st.mtimeMs })
        sessions.push(...parsedList)
      } catch {
        // ignore
      }
    }
  }

  // Deduplicate by key keeping newest update timestamp.
  const deduped = new Map<string, ParsedExternalSession>()
  for (const s of sessions) {
    const key = `${s.source}:${s.externalId}`
    const prev = deduped.get(key)
    if (!prev || s.updatedAt > prev.updatedAt) {
      deduped.set(key, s)
    }
  }

  const sorted = [...deduped.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TOTAL_SESSIONS)

  const candidates = sorted.map((s) => toCandidate(s, opts.chats))

  const countBySource = new Map<ExternalAgentSource, number>()
  for (const c of candidates) {
    countBySource.set(c.source, (countBySource.get(c.source) ?? 0) + 1)
  }

  const sources = [...countBySource.entries()]
    .map(([source, count]) => ({
      source,
      label: SOURCE_LABELS[source],
      count,
      roots: [...(sourceRoots.get(source) ?? [])],
    }))
    .sort((a, b) => b.count - a.count)

  return { sessions: candidates, sources, warnings }
}

async function loadFullSessionForImport(item: ExternalSessionImportTarget): Promise<ParsedExternalSession | null> {
  if (!existsSync(item.sourcePath)) {
    throw new Error(`Source file no longer exists: ${item.sourcePath}`)
  }
  const st = await stat(item.sourcePath)
  const fileMeta = { size: st.size, mtimeMs: st.mtimeMs }

  switch (item.source) {
    case 'claude-code':
      return parseClaudeCodeFile(item.sourcePath, fileMeta, true)
    case 'codex':
      return parseCodexFile(item.sourcePath, fileMeta, true)
    case 'dsh':
      if (item.sourcePath.toLowerCase().endsWith('.sqlite')) {
        return parseSingleDshSqliteTrace(item.sourcePath, item.externalId)
      }
      return parseDshJsonlFile(item.sourcePath, fileMeta, true)
    case 'antigravity':
      return parseAntigravityFile(item.sourcePath, fileMeta, true)
    case 'cursor':
      return parseSingleCursorComposer(item.sourcePath, item.externalId)
    case 'gemini-cli':
      return parseGeminiCliFile(item.sourcePath, fileMeta, true)
    case 'cline':
      return parseClineTaskFile(item.sourcePath, fileMeta)
    case 'opencode':
      return parseOpenCodeSessionFile(item.sourcePath, fileMeta)
    case 'aider': {
      const match = /#session-(\d+)$/.exec(item.externalId)
      const targetIdx = match?.[1] ? Number(match[1]) : 0
      const list = await parseAiderHistoryFile(item.sourcePath, fileMeta, targetIdx)
      return list[0] ?? null
    }
    case 'custom':
      return parseCustomSessionFile(item.sourcePath, fileMeta)
  }
}

/**
 * Full-fidelity import of selected external coding-agent sessions into Atrium's ChatStore.
 */
export async function importExternalSessions(opts: ImportSessionsOptions): Promise<SessionImportResult> {
  const imported: SessionImportResult['imported'] = []
  const skipped: SessionImportResult['skipped'] = []
  const warnings: string[] = []
  const newWorkspaces: string[] = []
  const now = Date.now()

  for (const item of opts.items) {
    const key = item.key || `${item.source}:${item.externalId}`
    const existing = opts.chats.findByExternalOrigin(item.source, item.externalId)
    if (existing && !opts.overwriteExisting) {
      skipped.push({ key, reason: `Already imported as "${existing.title}"` })
      continue
    }

    let parsed: ParsedExternalSession | null = null
    try {
      parsed = await loadFullSessionForImport(item)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      skipped.push({ key, reason: msg })
      warnings.push(`${key}: ${msg}`)
      continue
    }

    if (!parsed || parsed.messages.length === 0) {
      skipped.push({ key, reason: 'No conversation turns found in source session.' })
      continue
    }

    const overrideWs = opts.workspaceOverride?.trim()
    const targetWorkspace = overrideWs
      ? overrideWs
      : parsed.workspace && existsSync(parsed.workspace)
        ? parsed.workspace
        : undefined
    if (targetWorkspace) newWorkspaces.push(targetWorkspace)

    const saved = await opts.chats.importConversation({
      title: parsed.title,
      messages: parsed.messages,
      workspace: targetWorkspace,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      importedFrom: {
        source: parsed.source,
        sourceLabel: parsed.sourceLabel,
        externalId: parsed.externalId,
        sourcePath: parsed.sourcePath,
        importedAt: now,
      },
      replaceExistingId: existing && opts.overwriteExisting ? existing.id : undefined,
    })

    const savedMeta = opts.chats.list().find((m) => m.id === saved.id)
    if (savedMeta) {
      imported.push(savedMeta)
    }
  }

  // Register any valid imported workspaces in recentWorkspaces without switching active workspace.
  if (newWorkspaces.length > 0) {
    const curRecent = opts.settings.get().recentWorkspaces ?? []
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
    const seen = new Set(curRecent.map(norm))
    const merged = [...curRecent]
    let added = false
    for (const ws of newWorkspaces) {
      const k = norm(ws)
      if (!seen.has(k)) {
        seen.add(k)
        merged.push(ws)
        added = true
      }
    }
    if (added) {
      await opts.settings.update({ recentWorkspaces: merged.slice(0, 24) })
    }
  }

  return { imported, skipped, warnings }
}
