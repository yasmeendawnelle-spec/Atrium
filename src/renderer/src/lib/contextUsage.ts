import {
  estimateModelContextLimit,
  resolveEffectiveContextLimit,
  type Conversation,
  type Message,
  type TokenUsage,
} from '../../../shared/types.ts'

export { estimateModelContextLimit, resolveEffectiveContextLimit }

export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messagesTokens: number
  toolOutputsTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheReadTokens: number
  limitTokens: number
  autocompactBufferTokens: number
}

export function formatCompactTokens(tokens: number): string {
  const clean = Math.max(0, Math.round(tokens))
  if (clean < 1000) return String(clean)
  if (clean < 999_950) {
    const k = clean / 1000
    return `${k.toFixed(1).replace(/\.0$/, '')}k`
  }
  const m = clean / 1_000_000
  return `${m.toFixed(1).replace(/\.0$/, '')}M`
}

function approxTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / 3.6)
}

function measureMessages(messages: Message[]): {
  messagesChars: number
  toolOutputsChars: number
  reasoningChars: number
  lastUsage?: TokenUsage
} {
  let messagesChars = 0
  let toolOutputsChars = 0
  let reasoningChars = 0
  let lastUsage: TokenUsage | undefined

  for (const m of messages) {
    if (m.role === 'user') {
      messagesChars += m.text.length
      if (m.images?.length) messagesChars += m.images.length * 1400
      if (m.documents?.length) {
        for (const d of m.documents) messagesChars += d.content?.length ?? 0
      }
    } else if (m.role === 'assistant') {
      messagesChars += m.text.length
      if (m.reasoning) reasoningChars += m.reasoning.length
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          toolOutputsChars += tc.name.length + JSON.stringify(tc.input ?? {}).length
        }
      }
      if (m.usage) lastUsage = m.usage
    } else if (m.role === 'tool') {
      toolOutputsChars += m.name.length + m.output.length
      if (m.images?.length) toolOutputsChars += m.images.length * 1400
    }
  }
  return { messagesChars, toolOutputsChars, reasoningChars, lastUsage }
}

export function computeContextBreakdown(opts: {
  conversation?: Pick<Conversation, 'messages'>
  model?: string
  hasWorkspace?: boolean
  mcpToolCount?: number
  skillCount?: number
  autoCompact?: boolean
  contextWindowTokens?: number
}): ContextBreakdown {
  const limitTokens = resolveEffectiveContextLimit(opts.model, opts.contextWindowTokens)
  const autoCompactThreshold = Math.round(limitTokens * 0.8)
  const autocompactBufferTokens = opts.autoCompact === false ? 0 : Math.max(0, limitTokens - autoCompactThreshold)
  const rawSystem = opts.hasWorkspace ? 1250 : 850
  const rawTools = 750 + (opts.mcpToolCount ?? 0) * 160 + (opts.skillCount ?? 0) * 65

  const msgs = opts.conversation?.messages ?? []
  const measured = measureMessages(msgs)
  const rawMessages = approxTokens(measured.messagesChars)
  const rawToolOutputs = approxTokens(measured.toolOutputsChars)
  const rawReasoning = approxTokens(measured.reasoningChars)

  const apiTotal = measured.lastUsage
    ? Math.max(0, (measured.lastUsage.inputTokens || 0) + (measured.lastUsage.outputTokens || 0))
    : 0
  const rawSum = rawSystem + rawTools + rawMessages + rawToolOutputs + rawReasoning

  if (apiTotal > 0 && rawSum > 0) {
    const scale = apiTotal / rawSum
    const systemTokens = Math.max(1, Math.round(rawSystem * scale))
    const toolsTokens = rawTools > 0 ? Math.max(1, Math.round(rawTools * scale)) : 0
    const toolOutputsTokens = rawToolOutputs > 0 ? Math.max(1, Math.round(rawToolOutputs * scale)) : 0
    const reasoningTokens = rawReasoning > 0 ? Math.max(1, Math.round(rawReasoning * scale)) : 0
    const messagesTokens = Math.max(
      0,
      apiTotal - systemTokens - toolsTokens - toolOutputsTokens - reasoningTokens,
    )
    return {
      systemTokens,
      toolsTokens,
      messagesTokens,
      toolOutputsTokens,
      reasoningTokens,
      totalTokens: apiTotal,
      cacheReadTokens: measured.lastUsage?.cacheReadTokens ?? 0,
      limitTokens,
      autocompactBufferTokens,
    }
  }

  const totalTokens = rawMessages + rawToolOutputs + rawReasoning > 0 ? rawSum : 0
  return {
    systemTokens: totalTokens > 0 ? rawSystem : 0,
    toolsTokens: totalTokens > 0 ? rawTools : 0,
    messagesTokens: rawMessages,
    toolOutputsTokens: rawToolOutputs,
    reasoningTokens: rawReasoning,
    totalTokens,
    cacheReadTokens: 0,
    limitTokens,
    autocompactBufferTokens,
  }
}
