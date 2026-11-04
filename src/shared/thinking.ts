// Which Anthropic and OpenAI Responses models accept which reasoning parameters.
//
// The model list moves fast, so this is conservative on purpose: a wrong
// `thinking` field is a 400 that breaks the whole request, while omitting it
// only means the user sees no reasoning. When in doubt, send nothing.
//
// Anthropic rules (as of November 2026):
//  - Claude 4.6 and newer accept `thinking: {type: "adaptive"}` and `output_config.effort`.
//  - Fable 5.x, Mythos 5.x, Sonnet 5.5/5, Opus 5.5/5, Opus 4.8/4.7 reject
//    `budget_tokens` and `thinking: {type: "disabled"}` with a 400.
//  - On Fable, Mythos, Opus 5.x/4.8/4.7 and Sonnet 5.x the reasoning text is
//    omitted by default; `display: "summarized"` opts in.
//  - Claude 3.7 Sonnet and 4.0..4.5 models use `thinking: {type: "enabled", budget_tokens: N}`.

import type { ReasoningEffort } from './types.ts'

export type ThinkingMode = 'adaptive' | 'budget' | 'none'

interface DatedModel {
  family: string
  major: number
  minor: number
}

/** Parses `claude-sonnet-5-5` or `claude-3-7-sonnet` into {family, major, minor}. */
function parseModel(model: string): DatedModel | null {
  const lower = model.toLowerCase()
  const modern = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(lower)
  if (modern?.[1] && modern[2]) {
    return { family: modern[1], major: Number(modern[2]), minor: modern[3] ? Number(modern[3]) : 0 }
  }
  const legacy = /claude-(\d+)[.-](\d+)-(opus|sonnet|haiku)/.exec(lower)
  if (legacy?.[1] && legacy[2] && legacy[3]) {
    return { family: legacy[3], major: Number(legacy[1]), minor: Number(legacy[2]) }
  }
  return null
}

export function thinkingMode(model: string): ThinkingMode {
  const parsed = parseModel(model)
  if (!parsed) return 'none'
  const { family, major, minor } = parsed
  if (family === 'fable' || family === 'mythos') return major >= 5 ? 'adaptive' : 'none'
  if (family === 'opus' || family === 'sonnet' || family === 'haiku') {
    if (major > 4 || (major === 4 && minor >= 6)) return 'adaptive'
    if (major === 4 || (major === 3 && minor >= 7 && family === 'sonnet')) return 'budget'
  }
  return 'none'
}

/** Models whose reasoning text is empty unless `display: "summarized"` is sent. */
export function needsSummarizedDisplay(model: string): boolean {
  const parsed = parseModel(model)
  if (!parsed || thinkingMode(model) !== 'adaptive') return false
  const { family, major, minor } = parsed
  if (family === 'fable' || family === 'mythos') return true
  if (family === 'opus') return major > 4 || (major === 4 && minor >= 7)
  if (family === 'sonnet') return major >= 5
  return false
}

/** Builds Anthropic `thinking` and `output_config` fields for the target Claude model. */
export function buildAnthropicThinking(
  model: string,
  maxTokens: number,
  effort?: ReasoningEffort,
): { thinking?: Record<string, unknown>; outputConfig?: Record<string, unknown> } {
  if (maxTokens <= 64) return {}
  const mode = thinkingMode(model)
  if (mode === 'adaptive') {
    const thinking: Record<string, unknown> = needsSummarizedDisplay(model)
      ? { type: 'adaptive', display: 'summarized' }
      : { type: 'adaptive' }
    const mapped = effort === 'xhigh' ? 'high' : effort
    const outputConfig = mapped && mapped !== 'auto' ? { effort: mapped } : undefined
    return { thinking, outputConfig }
  }
  if (mode === 'budget') {
    const rawBudget = effort === 'low' ? 4096 : effort === 'xhigh' ? 32768 : effort === 'high' ? 24576 : 10240
    const budget_tokens = Math.min(rawBudget, Math.max(1024, maxTokens - 2048))
    return { thinking: { type: 'enabled', budget_tokens } }
  }
  return {}
}

/** OpenAI Responses models that accept `reasoning: { effort, summary }`. */
export function supportsResponsesReasoning(model: string): boolean {
  const lower = model.toLowerCase().trim()
  if (!lower) return false
  if (/^gpt-4(o|(\.1))/.test(lower)) return false
  return /^(o[134]|gpt-5|gpt-6|codex|computer-use)/.test(lower) || /coder|codex/.test(lower)
}

/** DeepSeek chat models (V3.x / V3.2) accept `thinking: { type: "enabled" }` on Chat Completions. */
export function supportsDeepSeekThinking(baseUrl: string, model: string): boolean {
  const lowerUrl = baseUrl.toLowerCase()
  const lowerModel = model.toLowerCase().trim()
  if (!lowerUrl.includes('deepseek') && !lowerModel.includes('deepseek')) return false
  // `deepseek-reasoner` already thinks unconditionally.
  return !lowerModel.includes('reasoner')
}
