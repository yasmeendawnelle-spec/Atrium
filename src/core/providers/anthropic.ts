// Anthropic Messages API adapter (streaming + tool use), hand-rolled over HTTP.
// Raw HTTP is deliberate: one code path serves api.anthropic.com and the
// Anthropic-compatible proxies (cc-switch and friends), all through the
// proxy-aware fetch. The official SDK is a better fit for first-party-only apps.
import type { Message, ThinkingBlock, TokenUsage, ToolCall } from '../../shared/types.ts'
import { buildAnthropicThinking } from '../../shared/thinking.ts'
import { netFetch } from '../net.ts'
import { readSse } from './sse.ts'
import {
  formatUserMessagePrompt,
  httpError,
  joinUrl,
  parseDataUrl,
  ProviderError,
  repairHistory,
  retainRecentToolImages,
  type ChatRequest,
  type ChatResult,
  type ProviderAdapter,
  type ProviderEndpoint,
  type StreamHandlers,
} from './types.ts'

// Pinning the version keeps hand-built requests on the behavior they were
// written for. Newer versions reject temperature/top_p/top_k, which we never send.
const VERSION = '2023-06-01'

type CacheControl = { type: 'ephemeral' }

type ToolResultBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

type Block =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string }; cache_control?: CacheControl }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: CacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string | ToolResultBlock[]; is_error?: boolean; cache_control?: CacheControl }

interface WireMessage {
  role: 'user' | 'assistant'
  content: Block[]
}

function headers(endpoint: ProviderEndpoint): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': VERSION,
    'x-api-key': endpoint.apiKey,
  }
}

/** Anthropic wants base URLs without `/v1`; accept both. */
function messagesUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? joinUrl(trimmed, path) : joinUrl(trimmed, `v1/${path}`)
}

/**
 * Replays stored thinking blocks ahead of the text. Blocks that were saved
 * without a signature (except `redacted_thinking`, which carries `data`)
 * cannot be replayed: the API rejects them, so invalid blocks are dropped.
 */
function assistantBlocks(m: Extract<Message, { role: 'assistant' }>): Block[] {
  const blocks: Block[] = []
  for (const t of m.thinking ?? []) {
    if (t.type === 'redacted_thinking' && t.data) {
      blocks.push({ type: 'redacted_thinking', data: t.data })
    } else if (t.signature) {
      blocks.push({ type: 'thinking', thinking: t.thinking, signature: t.signature })
    }
  }
  if (m.text.trim()) blocks.push({ type: 'text', text: m.text })
  for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
  return blocks.length ? blocks : [{ type: 'text', text: '(no response)' }]
}

function attachCacheControl(block: Block | undefined): void {
  if (!block || block.type === 'thinking' || block.type === 'redacted_thinking') return
  block.cache_control = { type: 'ephemeral' }
}

export function toAnthropicMessages(messages: Message[], opts?: { cache?: boolean }): WireMessage[] {
  const out: WireMessage[] = []
  const push = (role: WireMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    // Consecutive same-role messages must be merged.
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  for (const m of retainRecentToolImages(repairHistory(messages))) {
    if (m.role === 'user') {
      const blocks: Block[] = []
      for (const img of m.images ?? []) {
        const parsed = parseDataUrl(img.dataUrl)
        if (parsed) blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } })
      }
      const promptText = formatUserMessagePrompt(m)
      if (promptText || blocks.length === 0) blocks.push({ type: 'text', text: promptText || ' ' })
      push('user', blocks)
    } else if (m.role === 'assistant') push('assistant', assistantBlocks(m))
    else {
      const imageBlocks: ToolResultBlock[] = []
      for (const img of m.images ?? []) {
        const parsed = parseDataUrl(img.dataUrl)
        if (parsed) imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } })
      }
      const content: string | ToolResultBlock[] =
        imageBlocks.length > 0 ? [{ type: 'text', text: m.output || '(empty)' }, ...imageBlocks] : m.output || '(empty)'
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content, is_error: m.isError || undefined }])
    }
  }
  if (opts?.cache) {
    // Up to 2 conversation cache breakpoints (+1 system +1 tools = 4 max allowed by Anthropic).
    const userTurns = out.filter((m) => m.role === 'user')
    for (const turn of userTurns.slice(-2)) {
      attachCacheControl(turn.content[turn.content.length - 1])
    }
  }
  return out
}

interface OpenBlock {
  kind: 'text' | 'tool' | 'thinking' | 'redacted_thinking' | 'other'
  id?: string
  name?: string
  json: string
  thinking: string
  signature: string
  data: string
}

function buildBody(endpoint: ProviderEndpoint, req: ChatRequest, rich: boolean): Record<string, unknown> {
  const maxTokens = req.maxTokens ?? 64_000
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(req.messages, { cache: rich }),
    stream: true,
  }
  if (req.system) {
    body.system = rich ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] : req.system
  }
  if (req.tools.length) {
    body.tools = req.tools.map((t, i) => {
      const def: Record<string, unknown> = { name: t.name, description: t.description, input_schema: t.inputSchema }
      if (rich && i === req.tools.length - 1) def.cache_control = { type: 'ephemeral' }
      return def
    })
  }
  if (rich && endpoint.anthropicDirect) {
    const { thinking, outputConfig } = buildAnthropicThinking(req.model, maxTokens, req.effort)
    if (thinking) body.thinking = thinking
    if (outputConfig) body.output_config = outputConfig
  }
  return body
}

/** Remembers endpoints/models that rejected rich Anthropic fields so subsequent rounds skip the 400/422 probe. */
const plainFallbackHosts = new Set<string>()

export const anthropicAdapter: ProviderAdapter = {
  async chat(endpoint: ProviderEndpoint, req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const url = messagesUrl(endpoint.baseUrl, 'messages')
    const cacheKey = `${endpoint.baseUrl}::${req.model}`
    const wantRich = Boolean(endpoint.anthropicDirect) && (req.maxTokens ?? 64_000) > 64 && !plainFallbackHosts.has(cacheKey)
    let res = await netFetch(url, {
      method: 'POST',
      headers: headers(endpoint),
      body: JSON.stringify(buildBody(endpoint, req, wantRich)),
      signal: req.signal,
    })
    // Some third-party Anthropic proxies forward unknown fields verbatim and 400/422 on
    // cache_control/output_config/thinking. Fall back once and cache per host+model.
    if (wantRich && (res.status === 400 || res.status === 422)) {
      const errText = await res.text().catch(() => '')
      const isContextOverflow =
        /context[_ ]?length|maximum context|too many tokens|prompt is too long|exceeds.*(?:context|limit)|reduce the length/i.test(errText)
      if (isContextOverflow) {
        throw await httpError(new Response(errText, { status: res.status, headers: res.headers }), 'The model API')
      }
      if (plainFallbackHosts.size > 200) plainFallbackHosts.clear()
      plainFallbackHosts.add(cacheKey)
      res = await netFetch(url, {
        method: 'POST',
        headers: headers(endpoint),
        body: JSON.stringify(buildBody(endpoint, req, false)),
        signal: req.signal,
      })
    }
    if (!res.ok || !res.body) throw await httpError(res, 'The model API')

    let text = ''
    let reasoning = ''
    let stopReason = 'end_turn'
    let sawTerminal = false
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    const toolCalls: ToolCall[] = []
    const thinking: ThinkingBlock[] = []
    const badArguments: Record<string, string> = {}
    const open = new Map<number, OpenBlock>()

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
      switch (data.type) {
        case 'message_start': {
          const u = data.message?.usage
          if (typeof u?.input_tokens === 'number') inputTokens = u.input_tokens
          if (typeof u?.output_tokens === 'number') outputTokens = u.output_tokens
          if (typeof u?.cache_read_input_tokens === 'number') cacheReadTokens = u.cache_read_input_tokens
          if (typeof u?.cache_creation_input_tokens === 'number') cacheWriteTokens = u.cache_creation_input_tokens
          break
        }
        case 'content_block_start': {
          const block = data.content_block ?? {}
          if (block.type === 'tool_use') {
            open.set(data.index, { kind: 'tool', id: block.id, name: block.name, json: '', thinking: '', signature: '', data: '' })
          } else if (block.type === 'thinking') {
            open.set(data.index, { kind: 'thinking', json: '', thinking: block.thinking ?? '', signature: '', data: '' })
            if (block.thinking) {
              reasoning += block.thinking
              handlers.onReasoning?.(block.thinking)
            }
          } else if (block.type === 'redacted_thinking') {
            open.set(data.index, { kind: 'redacted_thinking', json: '', thinking: '', signature: '', data: block.data ?? '' })
          } else if (block.type === 'text') {
            open.set(data.index, { kind: 'text', json: '', thinking: '', signature: '', data: '' })
            if (block.text) {
              text += block.text
              handlers.onText(block.text)
            }
          } else open.set(data.index, { kind: 'other', json: '', thinking: '', signature: '', data: '' })
          break
        }
        case 'content_block_delta': {
          const d = data.delta ?? {}
          const blk = open.get(data.index)
          if (d.type === 'text_delta' && d.text) {
            text += d.text
            handlers.onText(d.text)
          } else if (d.type === 'input_json_delta' && blk) {
            blk.json += d.partial_json ?? ''
          } else if (d.type === 'thinking_delta' && d.thinking) {
            if (blk?.kind === 'thinking') blk.thinking += d.thinking
            reasoning += d.thinking
            handlers.onReasoning?.(d.thinking)
          } else if (d.type === 'signature_delta' && blk?.kind === 'thinking') {
            // The signature arrives as one delta when the block closes.
            blk.signature += d.signature ?? ''
          }
          break
        }
        case 'content_block_stop': {
          const blk = open.get(data.index)
          if (blk?.kind === 'tool' && blk.id && blk.name) {
            let input: Record<string, unknown> = {}
            if (blk.json.trim()) {
              try {
                const parsed = JSON.parse(blk.json)
                input = parsed && typeof parsed === 'object' ? parsed : {}
              } catch {
                badArguments[blk.id] = blk.json
              }
            }
            toolCalls.push({ id: blk.id, name: blk.name, input })
          } else if (blk?.kind === 'thinking') {
            thinking.push({ type: 'thinking', thinking: blk.thinking, signature: blk.signature })
          } else if (blk?.kind === 'redacted_thinking' && blk.data) {
            thinking.push({ type: 'redacted_thinking', thinking: '', signature: '', data: blk.data })
          }
          open.delete(data.index)
          break
        }
        case 'message_delta':
          if (data.delta?.stop_reason) {
            stopReason = data.delta.stop_reason
            sawTerminal = true
          }
          if (typeof data.usage?.output_tokens === 'number') outputTokens = data.usage.output_tokens
          if (typeof data.usage?.input_tokens === 'number') inputTokens = data.usage.input_tokens
          if (typeof data.usage?.cache_read_input_tokens === 'number') cacheReadTokens = data.usage.cache_read_input_tokens
          if (typeof data.usage?.cache_creation_input_tokens === 'number') cacheWriteTokens = data.usage.cache_creation_input_tokens
          break
        case 'message_stop':
          sawTerminal = true
          break
        case 'error':
          throw new ProviderError(`The model API reported an error: ${data.error?.message ?? 'unknown error'}`)
        default:
          break
      }
    }

    // Anthropic splits uncached, cache-read, and cache-write counts; sum them so
    // `inputTokens` represents total context tokens consistently across providers.
    const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens
    const usage: TokenUsage | undefined =
      totalInput > 0 || outputTokens > 0
        ? {
            inputTokens: totalInput,
            outputTokens,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
          }
        : undefined

    // A refusal can arrive with a half-built tool call. Nothing from that turn
    // may run, so the calls are dropped and the caller ends the turn.
    if (stopReason === 'refusal') {
      return {
        text,
        reasoning: reasoning || undefined,
        toolCalls: [],
        badArguments: {},
        stopReason,
        refusal: 'The model declined this request.',
        usage,
      }
    }
    if (!sawTerminal) {
      return {
        text,
        reasoning: reasoning || undefined,
        thinking: thinking.length ? thinking : undefined,
        toolCalls: [],
        badArguments: {},
        stopReason: 'incomplete_stream',
        incompleteStream: true,
        usage,
      }
    }
    return {
      text,
      reasoning: reasoning || undefined,
      thinking: thinking.length ? thinking : undefined,
      toolCalls,
      badArguments,
      stopReason,
      usage,
    }
  },

  async listModels(endpoint: ProviderEndpoint, signal?: AbortSignal): Promise<string[]> {
    const res = await netFetch(messagesUrl(endpoint.baseUrl, 'models?limit=100'), {
      headers: headers(endpoint),
      signal,
    })
    if (!res.ok) throw await httpError(res, 'The model list')
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).map((m) => m.id)
  },
}
