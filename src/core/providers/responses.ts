// OpenAI Responses API adapter (/v1/responses), aligned with Codex CLI / Desktop.
// Supports stateless zero-retention multi-turn tool loops (store: false +
// include: ['reasoning.encrypted_content']), prompt_cache_key session routing,
// streamed reasoning summaries, function_call / function_call_output items,
// and automatic minimal-body fallback for compatible third-party proxies.
import type { ImageAttachment, Message, ResponsesReasoning, TokenUsage, ToolCall } from '../../shared/types.ts'
import {
  capEffort,
  isEffortRejection,
  lowerEffort,
  responsesEffort,
  supportsResponsesReasoning,
  type WireEffort,
} from '../../shared/thinking.ts'
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

function headers(endpoint: ProviderEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (endpoint.apiKey) h.authorization = `Bearer ${endpoint.apiKey}`
  return h
}

/** Accepts either `https://api.openai.com/v1`, `https://api.openai.com`, or custom base paths. */
function responsesUrl(base: string, path: string): string {
  try {
    const parsed = new URL(base)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname || pathname === '') return joinUrl(base, `v1/${path}`)
    return joinUrl(base, path)
  } catch {
    const trimmed = base.replace(/\/+$/, '')
    return trimmed.endsWith('/v1') ? joinUrl(trimmed, path) : joinUrl(trimmed, `v1/${path}`)
  }
}

export function toResponsesInput(messages: Message[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let pendingToolImages: ImageAttachment[] = []
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    out.push({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '[Screenshot(s) captured by the tool call(s) above]' },
        ...pendingToolImages.map((img) => ({ type: 'input_image', image_url: img.dataUrl })),
      ],
    })
    pendingToolImages = []
  }

  for (const m of retainRecentToolImages(repairHistory(messages))) {
    if (m.role !== 'tool') flushToolImages()
    if (m.role === 'user') {
      const content: Record<string, unknown>[] = []
      const promptText = formatUserMessagePrompt(m)
      if (promptText || !m.images?.length) content.push({ type: 'input_text', text: promptText || ' ' })
      for (const img of m.images ?? []) {
        content.push({ type: 'input_image', image_url: img.dataUrl })
      }
      out.push({
        type: 'message',
        role: 'user',
        content,
      })
    } else if (m.role === 'assistant') {
      for (const r of m.reasoningItems ?? []) {
        const item: Record<string, unknown> = {
          type: 'reasoning',
          id: r.id,
          summary: r.summary ? [{ type: 'summary_text', text: r.summary }] : [],
        }
        if (r.encryptedContent) item.encrypted_content = r.encryptedContent
        out.push(item)
      }
      if (m.text.trim() || (m.toolCalls.length === 0 && !(m.reasoningItems?.length))) {
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.text || '(no response)' }],
        })
      }
      for (const c of m.toolCalls) {
        const fc: Record<string, unknown> = {
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input ?? {}),
        }
        if (c.itemId) fc.id = c.itemId
        out.push(fc)
      }
    } else {
      out.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: m.output || '(empty)',
      })
      if (m.images?.length) pendingToolImages.push(...m.images)
    }
  }
  flushToolImages()
  return out
}

function buildBody(req: ChatRequest, rich: boolean, effortCap?: WireEffort): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    input: toResponsesInput(req.messages),
    stream: true,
  }
  if (req.system) body.instructions = req.system
  if (req.maxTokens) body.max_output_tokens = req.maxTokens
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }))
  }
  if (rich) {
    body.store = false
    body.include = ['reasoning.encrypted_content']
    if (req.cacheKey) body.prompt_cache_key = req.cacheKey
    if (supportsResponsesReasoning(req.model) && (req.maxTokens ?? 1024) > 64) {
      body.reasoning = {
        effort: capEffort(responsesEffort(req.model, req.effort), effortCap),
        summary: 'auto',
      }
    }
  }
  return body
}

interface PartialFn {
  itemId?: string
  callId: string
  name: string
  args: string
}

interface PartialReasoning {
  id: string
  summary: string
  encryptedContent?: string
}

function summaryTextFromItem(item: Record<string, any>): string {
  if (!Array.isArray(item.summary)) return ''
  return item.summary
    .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

const plainFallbackHosts = new Set<string>()
/** Highest effort level each host+model accepted after a higher level was rejected. */
const effortCaps = new Map<string, WireEffort>()

export const responsesAdapter: ProviderAdapter = {
  async chat(endpoint: ProviderEndpoint, req: ChatRequest, handlers: StreamHandlers): Promise<ChatResult> {
    const url = responsesUrl(endpoint.baseUrl, 'responses')
    const hostKey = `${endpoint.baseUrl}::${req.model}`
    const wantRich = (req.maxTokens ?? 1024) > 64 && !plainFallbackHosts.has(hostKey)
    const post = (body: Record<string, unknown>) =>
      netFetch(url, { method: 'POST', headers: headers(endpoint), body: JSON.stringify(body), signal: req.signal })
    let body = buildBody(req, wantRich, effortCaps.get(hostKey))
    let res = await post(body)
    // A model that rejects only the effort level (e.g. `max` on a model that tops out at
    // `xhigh`) steps down one level at a time and keeps the rich fields.
    if (wantRich && (res.status === 400 || res.status === 422)) {
      let errText = await res.text().catch(() => '')
      let sent = (body.reasoning as { effort?: WireEffort } | undefined)?.effort
      let lower = sent ? lowerEffort(sent) : undefined
      while (lower && isEffortRejection(errText)) {
        body = buildBody(req, true, lower)
        res = await post(body)
        if (res.ok) {
          if (effortCaps.size > 200) effortCaps.clear()
          effortCaps.set(hostKey, lower)
          break
        }
        if (res.status !== 400 && res.status !== 422) break
        errText = await res.text().catch(() => '')
        sent = lower
        lower = lowerEffort(sent)
      }
    }
    // Compatible Responses proxies may reject `include`, `store`, or `prompt_cache_key`.
    if (wantRich && (res.status === 400 || res.status === 422)) {
      if (plainFallbackHosts.size > 200) plainFallbackHosts.clear()
      plainFallbackHosts.add(hostKey)
      res = await netFetch(url, {
        method: 'POST',
        headers: headers(endpoint),
        body: JSON.stringify(buildBody(req, false)),
        signal: req.signal,
      })
    }
    if (!res.ok || !res.body) throw await httpError(res, 'The model API')

    let text = ''
    let reasoning = ''
    let refusal = ''
    let stopReason = 'completed'
    let sawTerminal = false
    let usage: TokenUsage | undefined

    const fnByKey = new Map<string, PartialFn>()
    const fnOrder: string[] = []
    const reasoningByKey = new Map<string, PartialReasoning>()
    const reasoningOrder: string[] = []

    const keyFor = (data: Record<string, any>): string =>
      String(data.item_id ?? data.item?.id ?? `idx_${data.output_index ?? 0}`)

    const upsertFn = (key: string, patch: Partial<PartialFn>) => {
      let cur = fnByKey.get(key)
      if (!cur) {
        cur = { callId: '', name: '', args: '' }
        fnByKey.set(key, cur)
        fnOrder.push(key)
      }
      if (patch.itemId) cur.itemId = patch.itemId
      if (patch.callId) cur.callId = patch.callId
      if (patch.name) cur.name = patch.name
      if (patch.args !== undefined) cur.args = patch.args
      return cur
    }

    const upsertReasoning = (key: string, id: string): PartialReasoning => {
      let cur = reasoningByKey.get(key)
      if (!cur) {
        cur = { id, summary: '' }
        reasoningByKey.set(key, cur)
        reasoningOrder.push(key)
      }
      if (id && !cur.id) cur.id = id
      return cur
    }

    const recordUsage = (u: Record<string, any> | undefined) => {
      if (!u) return
      const inputTokens = typeof u.input_tokens === 'number' ? u.input_tokens : 0
      const outputTokens = typeof u.output_tokens === 'number' ? u.output_tokens : 0
      const cached = typeof u.input_tokens_details?.cached_tokens === 'number' ? u.input_tokens_details.cached_tokens : 0
      if (inputTokens > 0 || outputTokens > 0) {
        usage = {
          inputTokens,
          outputTokens,
          ...(cached > 0 ? { cacheReadTokens: cached } : {}),
        }
      }
    }

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
      if (data.error) {
        const msg = typeof data.error === 'string' ? data.error : data.error.message ?? JSON.stringify(data.error)
        throw new ProviderError(`The model API reported an error: ${msg}`)
      }
      const type = String(data.type ?? evt.event ?? '')
      switch (type) {
        case 'response.output_item.added': {
          const item = data.item ?? {}
          const key = keyFor(data)
          if (item.type === 'function_call') {
            upsertFn(key, {
              itemId: typeof item.id === 'string' ? item.id : undefined,
              callId: String(item.call_id ?? item.id ?? ''),
              name: String(item.name ?? ''),
              args: typeof item.arguments === 'string' ? item.arguments : '',
            })
          } else if (item.type === 'reasoning') {
            upsertReasoning(key, String(item.id ?? key))
          }
          break
        }
        case 'response.output_text.delta': {
          if (typeof data.delta === 'string' && data.delta) {
            text += data.delta
            handlers.onText(data.delta)
          }
          break
        }
        case 'response.output_text.done': {
          if (!text && typeof data.text === 'string' && data.text) {
            text = data.text
            handlers.onText(data.text)
          }
          break
        }
        case 'response.reasoning_summary_part.added': {
          const key = keyFor(data)
          const item = reasoningByKey.get(key) ?? upsertReasoning(key, String(data.item_id ?? key))
          if (item.summary && !item.summary.endsWith('\n')) item.summary += '\n\n'
          if (reasoning && !reasoning.endsWith('\n')) {
            reasoning += '\n\n'
            handlers.onReasoning?.('\n\n')
          }
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          if (typeof data.delta === 'string' && data.delta) {
            reasoning += data.delta
            handlers.onReasoning?.(data.delta)
            const key = keyFor(data)
            const item = reasoningByKey.get(key) ?? upsertReasoning(key, String(data.item_id ?? key))
            item.summary += data.delta
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const key = keyFor(data)
          const cur = upsertFn(key, {})
          if (typeof data.delta === 'string') cur.args += data.delta
          break
        }
        case 'response.function_call_arguments.done': {
          const key = keyFor(data)
          const cur = upsertFn(key, {})
          if (typeof data.arguments === 'string' && !cur.args) cur.args = data.arguments
          break
        }
        case 'response.refusal.delta': {
          if (typeof data.delta === 'string') refusal += data.delta
          break
        }
        case 'response.output_item.done': {
          const item = data.item ?? {}
          const key = keyFor(data)
          if (item.type === 'function_call') {
            upsertFn(key, {
              itemId: typeof item.id === 'string' ? item.id : undefined,
              callId: String(item.call_id ?? item.id ?? ''),
              name: String(item.name ?? ''),
              args: typeof item.arguments === 'string' ? item.arguments : undefined,
            })
          } else if (item.type === 'reasoning') {
            const rec = upsertReasoning(key, String(item.id ?? key))
            const sum = summaryTextFromItem(item)
            if (sum && !rec.summary) {
              rec.summary = sum
              const delta = reasoning && !reasoning.endsWith('\n') ? `\n\n${sum}` : sum
              reasoning += delta
              handlers.onReasoning?.(delta)
            }
            if (typeof item.encrypted_content === 'string' && item.encrypted_content) {
              rec.encryptedContent = item.encrypted_content
            }
          } else if (item.type === 'message' && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part?.type === 'refusal' && typeof part.refusal === 'string' && !refusal) {
                refusal = part.refusal
              } else if (part?.type === 'output_text' && typeof part.text === 'string' && !text) {
                text = part.text
                handlers.onText(part.text)
              }
            }
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete': {
          sawTerminal = true
          const r = data.response ?? {}
          stopReason = String(r.status ?? (type === 'response.incomplete' ? 'incomplete' : 'completed'))
          recordUsage(r.usage)
          // Fallback if a proxy emitted only a terminal response object without output_item.done events.
          if (Array.isArray(r.output)) {
            for (let idx = 0; idx < r.output.length; idx++) {
              const item = r.output[idx]
              const key = String(item?.id ?? `idx_${idx}`)
              if (item?.type === 'function_call' && !fnByKey.has(key)) {
                upsertFn(key, {
                  itemId: typeof item.id === 'string' ? item.id : undefined,
                  callId: String(item.call_id ?? item.id ?? ''),
                  name: String(item.name ?? ''),
                  args: typeof item.arguments === 'string' ? item.arguments : '',
                })
              } else if (item?.type === 'reasoning') {
                const rec = upsertReasoning(key, String(item.id ?? key))
                if (typeof item.encrypted_content === 'string' && !rec.encryptedContent) {
                  rec.encryptedContent = item.encrypted_content
                }
                const sum = summaryTextFromItem(item)
                if (sum && !rec.summary) rec.summary = sum
              } else if (item?.type === 'message' && Array.isArray(item.content)) {
                for (const part of item.content) {
                  if (part?.type === 'refusal' && typeof part.refusal === 'string' && !refusal) {
                    refusal = part.refusal
                  } else if (part?.type === 'output_text' && typeof part.text === 'string' && !text) {
                    text = part.text
                    handlers.onText(part.text)
                  }
                }
              }
            }
          }
          break
        }
        case 'response.failed': {
          const msg = data.response?.error?.message ?? 'Response generation failed.'
          throw new ProviderError(`The model API reported an error: ${msg}`)
        }
        case 'error': {
          const msg = data.message ?? data.error?.message ?? 'unknown error'
          throw new ProviderError(`The model API reported an error: ${msg}`)
        }
        default:
          break
      }
    }

    if (refusal && !text) {
      return {
        text,
        reasoning: reasoning || undefined,
        toolCalls: [],
        badArguments: {},
        stopReason: 'refusal',
        refusal,
        usage,
      }
    }

    const toolCalls: ToolCall[] = []
    const badArguments: Record<string, string> = {}
    for (let i = 0; i < fnOrder.length; i++) {
      const fn = fnByKey.get(fnOrder[i]!)
      if (!fn || !fn.name) continue
      const id = fn.callId || fn.itemId || `call_${i}_${Date.now().toString(36)}`
      let input: Record<string, unknown> = {}
      if (fn.args.trim()) {
        try {
          const parsed = JSON.parse(fn.args)
          input = parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
          badArguments[id] = fn.args
        }
      }
      toolCalls.push({ id, ...(fn.itemId ? { itemId: fn.itemId } : {}), name: fn.name, input })
    }

    const reasoningItems: ResponsesReasoning[] = []
    for (const key of reasoningOrder) {
      const item = reasoningByKey.get(key)
      if (!item) continue
      if (item.encryptedContent || item.summary) {
        reasoningItems.push({
          id: item.id,
          ...(item.summary ? { summary: item.summary } : {}),
          ...(item.encryptedContent ? { encryptedContent: item.encryptedContent } : {}),
        })
      }
    }

    if (!sawTerminal) {
      return {
        text,
        reasoning: reasoning || undefined,
        reasoningItems: reasoningItems.length ? reasoningItems : undefined,
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
      reasoningItems: reasoningItems.length ? reasoningItems : undefined,
      toolCalls,
      badArguments,
      stopReason,
      ...(refusal ? { refusal } : {}),
      usage,
    }
  },

  async listModels(endpoint: ProviderEndpoint, signal?: AbortSignal): Promise<string[]> {
    const res = await netFetch(responsesUrl(endpoint.baseUrl, 'models'), { headers: headers(endpoint), signal })
    if (!res.ok) throw await httpError(res, 'The model list')
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).map((m) => m.id).filter(Boolean)
  },
}
