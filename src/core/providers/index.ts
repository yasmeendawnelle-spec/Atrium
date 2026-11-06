// Picks the adapter for a provider and runs a connection test.
import type { Protocol, ProviderDraft } from '../../shared/types.ts'
import { describeNetworkError } from '../net.ts'
import { anthropicAdapter } from './anthropic.ts'
import { openAiAdapter } from './openai.ts'
import { responsesAdapter } from './responses.ts'
import { ProviderError, type ChatRequest, type ChatResult, type ProviderEndpoint, type StreamHandlers } from './types.ts'

export function adapterFor(protocol: Protocol) {
  if (protocol === 'anthropic') return anthropicAdapter
  if (protocol === 'responses') return responsesAdapter
  return openAiAdapter
}

export function endpointFor(draft: { protocol: Protocol; baseUrl: string; presetId?: string }, apiKey: string): ProviderEndpoint {
  return {
    baseUrl: draft.baseUrl,
    apiKey,
    anthropicDirect: draft.protocol === 'anthropic',
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [350, 900]

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function chat(
  protocol: Protocol,
  endpoint: ProviderEndpoint,
  req: ChatRequest,
  handlers: StreamHandlers,
): Promise<ChatResult> {
  let streamed = false
  const trackedHandlers: StreamHandlers = {
    onText: (delta) => {
      streamed = true
      handlers.onText(delta)
    },
    ...(handlers.onReasoning
      ? {
          onReasoning: (delta: string) => {
            streamed = true
            handlers.onReasoning!(delta)
          },
        }
      : {}),
  }
  const adapter = adapterFor(protocol)
  for (let attempt = 0; ; attempt++) {
    try {
      return await adapter.chat(endpoint, req, trackedHandlers)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError' || req.signal?.aborted) throw err
      const retryableStatus = err instanceof ProviderError && err.status !== undefined && RETRY_STATUS.has(err.status)
      const transientNet = !(err instanceof ProviderError)
      if (!streamed && attempt < RETRY_DELAYS_MS.length && (retryableStatus || transientNet)) {
        const jitter = Math.floor(Math.random() * 120)
        await sleepAbortable(RETRY_DELAYS_MS[attempt]! + jitter, req.signal)
        continue
      }
      if (err instanceof ProviderError) throw err
      throw new ProviderError(describeNetworkError(err, endpoint.baseUrl))
    }
  }
}

export interface ConnectionTest {
  ok: boolean
  error?: string
  models?: string[]
}

/** Fetches remote model catalog via the provider's `/models` endpoint without billing a chat turn. */
export async function fetchProviderModels(draft: ProviderDraft, apiKey: string, signal?: AbortSignal): Promise<ConnectionTest> {
  const endpoint = endpointFor(draft, apiKey)
  const adapter = adapterFor(draft.protocol)
  try {
    const raw = await adapter.listModels(endpoint, signal)
    const models = [...new Set(raw.map((m) => String(m || '').trim()).filter(Boolean))]
    return { ok: true, models }
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return { ok: false, error: 'Stopped.' }
    const message = err instanceof ProviderError ? err.message : describeNetworkError(err, endpoint.baseUrl)
    return { ok: false, error: message }
  }
}

/** Lists models when the endpoint supports it, then sends a one-token ping. */
export async function testConnection(draft: ProviderDraft, apiKey: string, signal?: AbortSignal): Promise<ConnectionTest> {
  const endpoint = endpointFor(draft, apiKey)
  const adapter = adapterFor(draft.protocol)
  let models: string[] | undefined
  try {
    models = await adapter.listModels(endpoint, signal)
  } catch (err) {
    if (err instanceof ProviderError && err.status && err.status !== 404) {
      return { ok: false, error: err.message }
    }
    // Many compatible endpoints have no model list. The ping below is the real test.
  }
  try {
    await adapter.chat(
      endpoint,
      {
        model: draft.model || models?.[0] || '',
        system: 'Reply with the single word: ok',
        messages: [{ role: 'user', text: 'ok' }],
        tools: [],
        signal: signal ?? new AbortController().signal,
        maxTokens: 16,
      },
      { onText: () => undefined },
    )
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') return { ok: false, error: 'Stopped.' }
    const message = err instanceof ProviderError ? err.message : describeNetworkError(err, endpoint.baseUrl)
    return { ok: false, error: message, models }
  }
  return { ok: true, models }
}
