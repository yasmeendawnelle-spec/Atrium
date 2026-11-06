import type { Message, ReasoningEffort, ResponsesReasoning, ThinkingBlock, TokenUsage, ToolCall } from '../../shared/types.ts'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolDef[]
  signal: AbortSignal
  maxTokens?: number
  effort?: ReasoningEffort
  cacheKey?: string
}

export interface StreamHandlers {
  onText(delta: string): void
  onReasoning?(delta: string): void
}

export interface ChatResult {
  text: string
  reasoning?: string
  /** Anthropic thinking blocks (and redacted_thinking), signatures/data included, for verbatim replay. */
  thinking?: ThinkingBlock[]
  /** OpenAI Responses API reasoning items, for verbatim stateless replay. */
  reasoningItems?: ResponsesReasoning[]
  toolCalls: ToolCall[]
  /** Tool calls whose arguments were not valid JSON, keyed by call id. */
  badArguments: Record<string, string>
  stopReason: string
  /** True when the SSE stream reached EOF without receiving a terminal completion marker or finish reason. */
  incompleteStream?: boolean
  /** Set when the model refused. The turn must end without running any tools. */
  refusal?: string
  usage?: TokenUsage
}

export interface ProviderEndpoint {
  baseUrl: string
  apiKey: string
  /** First-party api.anthropic.com only. Third-party proxies reject Anthropic-only fields. */
  anthropicDirect?: boolean
}

export interface ProviderAdapter {
  chat(endpoint: ProviderEndpoint, req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult>
  listModels(endpoint: ProviderEndpoint, signal?: AbortSignal): Promise<string[]>
}

export class ProviderError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

/** Builds a readable error from a non-2xx HTTP response. */
export async function httpError(res: Response, label: string): Promise<ProviderError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
      detail =
        (typeof json.error === 'string' ? json.error : json.error?.message) || json.message || text.slice(0, 300)
    } catch {
      detail = text.slice(0, 300)
    }
  } catch {
    /* ignore */
  }
  const hint =
    res.status === 401 || res.status === 403
      ? 'The API key was rejected. Check the key in Settings > Models.'
      : res.status === 404
        ? 'The model or address was not found. Check the base URL and model name.'
        : res.status === 429
          ? 'The provider is rate limiting requests or your quota ran out. Wait a moment or check your plan.'
          : res.status >= 500
            ? 'The provider had a server error. Try again in a moment.'
            : ''
  const msg = [`${label} returned ${res.status}.`, hint, detail && `Details: ${detail}`].filter(Boolean).join(' ')
  return new ProviderError(msg, res.status)
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Formats a user message with any attached parsed documents for model APIs. */
export function formatUserMessagePrompt(m: Extract<Message, { role: 'user' }>): string {
  if (!m.documents?.length) return m.text
  const docBlocks = m.documents.map((doc) => {
    const attrs = [
      `name="${doc.name.replace(/"/g, "'")}"`,
      `kind="${doc.docKind}"`,
      ...(doc.path ? [`path="${doc.path.replace(/"/g, "'")}"`] : []),
      ...(doc.pageCount ? [`pages="${doc.pageCount}"`] : []),
      ...(doc.sheetCount ? [`sheets="${doc.sheetCount}"`] : []),
      ...(doc.slideCount ? [`slides="${doc.slideCount}"`] : []),
      ...(doc.truncated ? ['truncated="true"'] : []),
    ].join(' ')
    return `<attached_document ${attrs}>\n${doc.content}\n</attached_document>`
  })
  return [...docBlocks, m.text.trim()].filter(Boolean).join('\n\n')
}

/** Extracts media type and base64 payload from an `ImageAttachment.dataUrl`. */
export function parseDataUrl(dataUrl: string): { mediaType: string; data: string } | null {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl)
  if (!m?.[1] || !m[2]) return null
  return { mediaType: m[1], data: m[2] }
}

/**
 * Pairs every assistant tool call with a result. A turn that was stopped
 * mid-way leaves calls without results, which both APIs reject.
 */
export function repairHistory(messages: Message[]): Message[] {
  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    out.push(m)
    if (m.role !== 'assistant' || m.toolCalls.length === 0) continue
    const answered = new Set<string>()
    let j = i + 1
    while (j < messages.length && messages[j]!.role === 'tool') {
      answered.add((messages[j] as Extract<Message, { role: 'tool' }>).toolCallId)
      j++
    }
    // Copy the existing results, then add placeholders for the missing ones.
    for (let k = i + 1; k < j; k++) out.push(messages[k]!)
    for (const call of m.toolCalls) {
      if (!answered.has(call.id)) {
        out.push({ role: 'tool', toolCallId: call.id, name: call.name, output: 'Cancelled by the user.', isError: true })
      }
    }
    i = j - 1
  }
  return out
}

/**
 * Keeps only the most recent `keepCount` tool screenshots when preparing API requests,
 * preventing multi-step Computer Use / Browser Use histories from overflowing request size or token budgets.
 */
export function retainRecentToolImages(messages: Message[], keepCount = 3): Message[] {
  let remaining = Math.max(0, Math.floor(keepCount))
  const keepIndices = new Set<number>()
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i]!
    if (m.role === 'tool' && m.images && m.images.length > 0) {
      keepIndices.add(i)
      remaining--
    }
  }
  return messages.map((m, idx) => {
    if (m.role !== 'tool' || !m.images?.length || keepIndices.has(idx)) return m
    const { images: _dropped, ...rest } = m
    return rest
  })
}
