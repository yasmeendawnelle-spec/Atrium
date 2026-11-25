// OpenAI Chat Completions adapter. Also serves DeepSeek, GLM, Qwen, Kimi,
// OpenRouter, Ollama and other OpenAI-compatible endpoints.
import type { ImageAttachment, Message, TokenUsage, ToolCall } from '../../shared/types.ts'
import { supportsDeepSeekThinking } from '../../shared/thinking.ts'
import { netFetch } from '../net.ts'
import { readSse } from './sse.ts'
import {
  formatUserMessagePrompt,
  httpError,
  joinUrl,
  ProviderError,
  repairHistory,
  retainRecentToolImages,
  type ChatRequest,
  type ChatResult,
  type ProviderAdapter,
  type ProviderEndpoint,
  type StreamHandlers,
} from './types.ts'

// Endpoints that rejected `stream_options` or `thinking` fall back to plain bodies.
const plainFallbackHosts = new Set<string>()

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return baseUrl.toLowerCase()
  }
}

export function buildOpenAiBody(endpoint: ProviderEndpoint, req: ChatRequest, rich: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req.system, req.messages),
    stream: true,
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
  }
  if (!rich) return body
  body.stream_options = { include_usage: true }
  if (
    supportsDeepSeekThinking(endpoint.baseUrl, req.model) &&
    (req.effort === 'medium' || req.effort === 'high' || req.effort === 'xhigh' || req.effort === 'max')
  ) {
    body.thinking = { type: 'enabled' }
  }
  return body
}

function parseUsageChunk(raw: Record<string, any>, prev?: TokenUsage): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return prev
  const cacheHit =
    typeof raw.prompt_cache_hit_tokens === 'number'
      ? raw.prompt_cache_hit_tokens
      : typeof raw.prompt_tokens_details?.cached_tokens === 'number'
        ? raw.prompt_tokens_details.cached_tokens
        : prev?.cacheReadTokens
  return {
    inputTokens: typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : (prev?.inputTokens ?? 0),
    outputTokens: typeof raw.completion_tokens === 'number' ? raw.completion_tokens : (prev?.outputTokens ?? 0),
    ...(cacheHit !== undefined ? { cacheReadTokens: cacheHit } : {}),
  }
}

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type WireMessage =
  | { role: 'system' | 'user'; content: string | UserContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
      reasoning_content?: string
    }
  | { role: 'tool'; tool_call_id: string; content: string }

function headers(endpoint: ProviderEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (endpoint.apiKey) h.authorization = `Bearer ${endpoint.apiKey}`
  return h
}

export function toOpenAiMessages(system: string, messages: Message[]): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: system }]
  let pendingToolImages: ImageAttachment[] = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    const parts: UserContentPart[] = [
      { type: 'text', text: '[Screenshot(s) captured by the tool call(s) above]' },
      ...pendingToolImages.map((img): UserContentPart => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
    ]
    out.push({ role: 'user', content: parts })
    pendingToolImages = []
  }

  for (const m of retainRecentToolImages(repairHistory(messages))) {
    if (m.role !== 'tool') flushToolImages()
    if (m.role === 'user') {
      const promptText = formatUserMessagePrompt(m)
      if (m.images?.length) {
        const parts: UserContentPart[] = []
        if (promptText) parts.push({ type: 'text', text: promptText })
        for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } })
        out.push({ role: 'user', content: parts })
      } else {
        out.push({ role: 'user', content: promptText })
      }
    } else if (m.role === 'assistant') {
      const msg: WireMessage = { role: 'assistant', content: m.text || null }
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }))
        // Thinking models (DeepSeek, Kimi) need their reasoning echoed back
        // while a tool-call chain is in progress.
        if (m.reasoning) msg.reasoning_content = m.reasoning
      }
      out.push(msg)
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.output || '(empty)' })
      if (m.images?.length) pendingToolImages.push(...m.images)
    }
  }
  flushToolImages()
  return out
}

interface PartialCall {
  id: string
  name: string
  args: string
}

export const openAiAdapter: ProviderAdapter = {
  async chat(endpoint: ProviderEndpoint, req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const url = joinUrl(endpoint.baseUrl, 'chat/completions')
    const host = hostOf(endpoint.baseUrl)
    const rich = !plainFallbackHosts.has(host)

    const send = (withRich: boolean) =>
      netFetch(url, {
        method: 'POST',
        headers: headers(endpoint),
        body: JSON.stringify(buildOpenAiBody(endpoint, req, withRich)),
        signal: req.signal,
      })

    let res = await send(rich)
    if (rich && (res.status === 400 || res.status === 422)) {
      const errPreview = await res.clone().text().catch(() => '')
      // Only fall back when the server rejects extra parameters, not prompt length overflow.
      if (!/context[_ ]?length|too many tokens|maximum context|token limit/i.test(errPreview)) {
        plainFallbackHosts.add(host)
        res = await send(false)
      }
    }
    if (!res.ok || !res.body) throw await httpError(res, 'The model API')

    let text = ''
    let reasoning = ''
    let stopReason = 'stop'
    let sawTerminal = false
    let usage: TokenUsage | undefined
    const calls = new Map<number, PartialCall>()

    for await (const evt of readSse(res.body, req.signal)) {
      if (evt.data === '[DONE]') {
        sawTerminal = true
        break
      }
      let data: Record<string, any>
      try {
        data = JSON.parse(evt.data)
      } catch {
        continue
      }
      if (data.error) throw new ProviderError(`The model API reported an error: ${data.error.message ?? evt.data}`)
      // OpenAI & DeepSeek place `usage` in a trailing chunk where `choices` is empty.
      if (data.usage) usage = parseUsageChunk(data.usage, usage)
      const choice = data.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content
        handlers.onText(delta.content)
      }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        handlers.onReasoning?.(r)
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const [pos, tc] of delta.tool_calls.entries()) {
          // Some compatible servers omit `index`; fall back to position.
          const index = typeof tc.index === 'number' ? tc.index : pos
          const cur = calls.get(index) ?? { id: '', name: '', args: '' }
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.name += tc.function.name
          if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
          else if (tc.function?.arguments && typeof tc.function.arguments === 'object')
            cur.args = JSON.stringify(tc.function.arguments)
          calls.set(index, cur)
        }
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason
        sawTerminal = true
      }
    }

    if (!sawTerminal) {
      return {
        text,
        reasoning: reasoning || undefined,
        toolCalls: [],
        badArguments: {},
        stopReason: 'incomplete_stream',
        incompleteStream: true,
        usage,
      }
    }

    const toolCalls: ToolCall[] = []
    const badArguments: Record<string, string> = {}
    for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!c.name) continue
      const id = c.id || `call_${index}_${Date.now().toString(36)}`
      let input: Record<string, unknown> = {}
      if (c.args.trim()) {
        try {
          const parsed = JSON.parse(c.args)
          input = parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
          badArguments[id] = c.args
        }
      }
      toolCalls.push({ id, name: c.name, input })
    }
    return { text, reasoning: reasoning || undefined, toolCalls, badArguments, stopReason, usage }
  },

  async listModels(endpoint: ProviderEndpoint, signal?: AbortSignal): Promise<string[]> {
    const res = await netFetch(joinUrl(endpoint.baseUrl, 'models'), { headers: headers(endpoint), signal })
    if (!res.ok) throw await httpError(res, 'The model list')
    const json = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] }
    if (Array.isArray(json.data)) return json.data.map((m) => m.id).filter(Boolean)
    if (Array.isArray(json.models)) return json.models.map((m) => m.name).filter(Boolean)
    return []
  },
}
