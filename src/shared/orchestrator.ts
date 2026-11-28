// Shared Dual-Model Orchestrator types helpers, fast-executor scoring, and display utilities.
import type { AppSettings, ProviderConfig, ReasoningEffort } from './types.ts'

export const ORCHESTRATOR_DEFAULT_MAX_HANDOFFS = 3
export const ORCHESTRATOR_MIN_HANDOFFS = 1
export const ORCHESTRATOR_MAX_HANDOFFS = 6

export function normalizeOrchestratorMaxHandoffs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return ORCHESTRATOR_DEFAULT_MAX_HANDOFFS
  return Math.max(ORCHESTRATOR_MIN_HANDOFFS, Math.min(ORCHESTRATOR_MAX_HANDOFFS, Math.floor(n)))
}

export function isLocalProviderUrl(baseUrl: string): boolean {
  return /^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(baseUrl.trim())
}

export function displayProviderName(provider: Pick<ProviderConfig, 'name' | 'managedBy'>): string {
  if (provider.managedBy === 'relaypulse' && provider.name === 'RelayPulse') return 'Atrium Cloud'
  return provider.name
}

export type OrchestratorVendor =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'zhipu'
  | 'kimi'
  | 'qwen'
  | 'grok'
  | 'other'

export function classifyModelVendor(model: string): OrchestratorVendor {
  const lower = model.toLowerCase()
  if (/claude/.test(lower)) return 'claude'
  if (/\bgpt\b|gpt-|chatgpt|o1|o3|o4|codex/.test(lower)) return 'openai'
  if (/gemini/.test(lower)) return 'gemini'
  if (/deepseek/.test(lower)) return 'deepseek'
  if (/\bglm\b|glm-|zhipu|chatglm/.test(lower)) return 'zhipu'
  if (/kimi|moonshot/.test(lower)) return 'kimi'
  if (/qwen|qwq/.test(lower)) return 'qwen'
  if (/grok/.test(lower)) return 'grok'
  return 'other'
}

export function isNonChatModel(model: string): boolean {
  return /embed|whisper|tts|dall-e|imagen|moderation|rerank|transcribe|audio-preview|realtime|sora|veo|music/i.test(
    model,
  )
}

export function isHeavyPlannerModel(model: string): boolean {
  const lower = model.toLowerCase().trim()
  if (!lower) return false
  if (/opus|mythos|fable|ultra|reasoner|-r1\b|\br1\b|o1-pro|o3-pro|codex-max|deep-research|deepseek-v4-pro|kimi-k3/.test(lower)) {
    return true
  }
  if (/^gpt-6/.test(lower) && !/mini|nano|flash|fast/.test(lower)) return true
  if (/^gpt-5\.[2-9]/.test(lower) && !/mini|nano|flash|fast/.test(lower)) return true
  if (/claude-.*-opus/.test(lower)) return true
  if (/gemini-.*-pro/.test(lower) && !/flash|lite/.test(lower)) return true
  return false
}

export function scoreFastExecutorCandidate(
  candidate: { provider: ProviderConfig; model: string },
  plannerProvider: ProviderConfig,
  plannerModel: string,
): number {
  const m = candidate.model.trim()
  if (!m || isNonChatModel(m)) return -1000
  const lower = m.toLowerCase()
  let score = 0

  if (/flash(?!-thinking)|mini|haiku|turbo|\bair\b|fast|spark/.test(lower)) {
    score += 110
  } else if (/lite|nano|small/.test(lower)) {
    score += 102
  } else if (/deepseek-(?:chat|v3|v4)(?!.*(?:pro|reasoner))/.test(lower)) {
    score += 95
  } else if (/sonnet/.test(lower) && /opus|mythos|fable/.test(plannerModel.toLowerCase())) {
    score += 90
  } else if (
    /(?:^|\/)(?:gpt-4o|gpt-4\.1|gpt-5(?:\.0)?$|kimi-k2|qwen.*coder|glm-(?:4|5)(?!.*pro)|claude-.*sonnet)/.test(
      lower,
    )
  ) {
    score += 60
  }

  if (isHeavyPlannerModel(lower)) score -= 70

  const vendor = classifyModelVendor(lower)
  const plannerVendor = classifyModelVendor(plannerModel)
  if (vendor !== 'other' && vendor === plannerVendor) score += 25
  if (candidate.provider.id === plannerProvider.id) score += 15

  return score
}

export interface ResolvedExecutorTarget {
  provider: ProviderConfig
  model: string
  source: 'pinned' | 'auto' | 'fallback_planner'
  isSameAsPlanner: boolean
}

export function resolveOrchestratorExecutor(
  providers: readonly ProviderConfig[],
  plannerProvider: ProviderConfig,
  settings: Pick<AppSettings, 'orchestratorExecutorProviderId' | 'orchestratorExecutorModel'>,
): ResolvedExecutorTarget {
  const usableProviders = providers.filter(
    (p) => p.hasKey || isLocalProviderUrl(p.baseUrl) || p.id === plannerProvider.id,
  )
  const pinnedModel = settings.orchestratorExecutorModel?.trim()
  if (pinnedModel) {
    const lowerPinned = pinnedModel.toLowerCase()
    const pinnedProvider =
      (settings.orchestratorExecutorProviderId
        ? usableProviders.find((p) => p.id === settings.orchestratorExecutorProviderId)
        : undefined) ??
      usableProviders.find((p) => {
        const list = p.models?.length ? p.models : [p.model]
        return list.some((m) => m.toLowerCase() === lowerPinned)
      }) ??
      plannerProvider
    const list = pinnedProvider.models?.length ? pinnedProvider.models : [pinnedProvider.model]
    const matchedModel = list.find((m) => m.toLowerCase() === lowerPinned) ?? pinnedModel
    return {
      provider: pinnedProvider,
      model: matchedModel,
      source: 'pinned',
      isSameAsPlanner: pinnedProvider.id === plannerProvider.id && matchedModel === plannerProvider.model,
    }
  }

  let best: { provider: ProviderConfig; model: string; score: number } | null = null
  const seen = new Set<string>()
  for (const p of usableProviders) {
    const models = p.models?.length ? p.models : [p.model]
    for (const rawModel of models) {
      const model = rawModel.trim()
      if (!model) continue
      if (p.id === plannerProvider.id && model === plannerProvider.model) continue
      const dedupKey = `${p.id}::${model}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      const score = scoreFastExecutorCandidate({ provider: p, model }, plannerProvider, plannerProvider.model)
      if (!best || score > best.score) {
        best = { provider: p, model, score }
      }
    }
  }

  if (best && (best.score > 0 || best.score > -50)) {
    return {
      provider: best.provider,
      model: best.model,
      source: 'auto',
      isSameAsPlanner: false,
    }
  }

  return {
    provider: plannerProvider,
    model: plannerProvider.model,
    source: 'fallback_planner',
    isSameAsPlanner: true,
  }
}

export function executorEffortFor(_plannerEffort?: ReasoningEffort): ReasoningEffort {
  return 'low'
}

export function shortModelLabel(model: string): string {
  const clean = model.trim()
  const slash = clean.lastIndexOf('/')
  return slash >= 0 && slash < clean.length - 1 ? clean.slice(slash + 1) : clean
}
