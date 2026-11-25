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

/** Concrete effort levels a provider can receive (`auto` means "send nothing"). */
export type WireEffort = Exclude<ReasoningEffort, 'auto'>

export interface EffortSupport {
  /** Accepts `output_config.effort` at all. */
  effort: boolean
  xhigh: boolean
  max: boolean
}

const NO_EFFORT: EffortSupport = { effort: false, xhigh: false, max: false }

/**
 * Which `output_config.effort` values a Claude model accepts (platform docs, November 2026):
 *  - max:   Fable/Mythos 5+, Opus 4.6+, Sonnet 4.6+, Haiku 5.5+.
 *  - xhigh: Fable/Mythos 5+, Opus 4.7+, Sonnet 5+, Haiku 5.5+ (NOT Opus 4.6 / Sonnet 4.6).
 * Unknown newer majors are assumed to keep both.
 */
export function anthropicEffortSupport(model: string): EffortSupport {
  const parsed = parseModel(model)
  if (!parsed || thinkingMode(model) !== 'adaptive') return NO_EFFORT
  const { family, major, minor } = parsed
  const at = (m: number, n: number) => major > m || (major === m && minor >= n)
  if (family === 'fable' || family === 'mythos') return { effort: true, xhigh: true, max: true }
  if (family === 'opus') return { effort: true, xhigh: at(4, 7), max: true }
  if (family === 'sonnet') return { effort: true, xhigh: at(5, 0), max: true }
  if (family === 'haiku') {
    const ok = at(5, 5)
    return { effort: ok, xhigh: ok, max: ok }
  }
  return NO_EFFORT
}

/** Next level down, used when a provider rejects a level (`max` -> `xhigh` -> `high`). */
export function lowerEffort(effort: WireEffort): WireEffort | undefined {
  if (effort === 'max') return 'xhigh'
  if (effort === 'xhigh') return 'high'
  return undefined
}

/** Clamps a requested level to the highest one the model accepts. */
export function clampEffort(effort: WireEffort, support: Pick<EffortSupport, 'xhigh' | 'max'>): WireEffort {
  if (effort === 'max' && !support.max) return support.xhigh ? 'xhigh' : 'high'
  if (effort === 'xhigh' && !support.xhigh) return 'high'
  return effort
}

/** Thinking budgets for Claude 3.7 / 4.0..4.5 (`budget_tokens`). */
const BUDGET_TOKENS: Record<WireEffort, number> = {
  low: 4096,
  medium: 10240,
  high: 24576,
  xhigh: 32768,
  max: 49152,
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
    const support = anthropicEffortSupport(model)
    if (!effort || effort === 'auto' || !support.effort) return { thinking, outputConfig: undefined }
    return { thinking, outputConfig: { effort: clampEffort(effort, support) } }
  }
  if (mode === 'budget') {
    const rawBudget = BUDGET_TOKENS[effort && effort !== 'auto' ? effort : 'medium']
    const budget_tokens = Math.min(rawBudget, Math.max(1024, maxTokens - 2048))
    return { thinking: { type: 'enabled', budget_tokens } }
  }
  return {}
}

/**
 * OpenAI Responses `reasoning.effort` for a model. `auto` stays `medium` (the common default).
 * Models before GPT-5.1-Codex-Max / GPT-5.2 have no `xhigh` or `max`, so those clamp to `high`.
 * Newer models get the level as asked; the adapter steps down once if a model rejects it.
 */
export function responsesEffort(model: string, effort?: ReasoningEffort): WireEffort {
  if (!effort || effort === 'auto') return 'medium'
  if (effort !== 'xhigh' && effort !== 'max') return effort
  return responsesHasXhigh(model) ? effort : 'high'
}

function responsesHasXhigh(model: string): boolean {
  const lower = model.toLowerCase().trim()
  if (/codex-max/.test(lower)) return true
  if (/^o\d/.test(lower) || /^codex-mini/.test(lower)) return false
  const gpt = /^gpt-(\d+)(?:\.(\d+))?/.exec(lower)
  if (gpt?.[1]) {
    const major = Number(gpt[1])
    const minor = gpt[2] ? Number(gpt[2]) : 0
    return major > 5 || (major === 5 && minor >= 2)
  }
  // Unknown names (proxies, coder models): let the server decide, the adapter steps down on 400.
  return true
}

const EFFORT_RANK: Record<WireEffort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }

/** Returns `effort` limited to `cap` (a level the server already accepted for this model). */
export function capEffort(effort: WireEffort, cap: WireEffort | undefined): WireEffort {
  return cap && EFFORT_RANK[effort] > EFFORT_RANK[cap] ? cap : effort
}

/** True when an HTTP error body blames the effort/reasoning level rather than other fields. */
export function isEffortRejection(errText: string): boolean {
  return /effort|xhigh|["'`]max["'`]/i.test(errText)
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
