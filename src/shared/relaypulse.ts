import type { SubscriptionCategory, SubscriptionTierLevel, TokenUsage } from './types'

// Shared constants and helpers for RelayPulse Account Mode.

const envOrigin = (key: string): string | undefined => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const val = proc?.env?.[key]?.trim()
  return val || undefined
}

export const RELAYPULSE_PROD_ORIGIN = envOrigin('ATRIUM_CLOUD_ORIGIN') ?? 'https://api.rpulse.top'
export const RELAYPULSE_STAGING_ORIGIN = envOrigin('ATRIUM_STAGING_ORIGIN') ?? 'https://api1991.rpulse.top'
export const RELAYPULSE_DEFAULT_ORIGIN = RELAYPULSE_PROD_ORIGIN

export function isStagingOrigin(rawOrigin?: string | null): boolean {
  const clean = (rawOrigin || '').trim()
  if (!clean) return false
  try {
    return new URL(clean).origin.toLowerCase() === RELAYPULSE_STAGING_ORIGIN.toLowerCase()
  } catch {
    return clean.replace(/\/+$/, '').toLowerCase() === RELAYPULSE_STAGING_ORIGIN.toLowerCase()
  }
}

export const ALLOWED_EMAIL_DOMAINS = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'qq.com',
  '163.com',
] as const

export function isAllowedWhitelistEmail(email: string): boolean {
  const clean = email.trim().toLowerCase()
  const at = clean.lastIndexOf('@')
  if (at <= 0) return false
  const domain = clean.slice(at + 1)
  return (ALLOWED_EMAIL_DOMAINS as readonly string[]).includes(domain)
}

export interface RelayPulseGroupOption {
  id: string
  label: string
}

export const RELAYPULSE_KEY_GROUPS: readonly RelayPulseGroupOption[] = [
  { id: 'gpt', label: 'GPT 官Key 0.35x (gpt)' },
  { id: 'gpt-040', label: 'GPT 官Key 0.40x (gpt-040)' },
  { id: 'gpt-pro', label: 'GPT Pro 20x 0.30x (gpt-pro)' },
  { id: 'gpt-pro-normal', label: 'GPT Pro 常规 0.25x (gpt-pro-normal)' },
  { id: 'gpt-plus', label: 'GPT Pro/Plus 混池 0.20x (gpt-plus)' },
  { id: 'gpt-own-plus', label: 'GPT 自有 Plus 0.17x (gpt-own-plus)' },
  { id: 'gpt-plus-012', label: 'GPT Plus 特惠 0.12x (gpt-plus-012)' },
  { id: 'gpt-plus-007', label: 'GPT Plus/Team 特惠 0.07x (gpt-plus-007)' },
  { id: 'claude', label: 'Claude 满血组 1.12x (claude)' },
  { id: 'claude-external', label: 'Claude 满血可外接 1.30x (claude-external)' },
  { id: 'claude-kiro', label: 'Claude Kiro 企业 0.25x (claude-kiro)' },
  { id: 'gemini', label: 'Gemini 0.45x (gemini)' },
  { id: 'gemini-ultra', label: 'Gemini Ultra 0.50x (gemini-ultra)' },
  { id: 'gemini-official', label: 'Gemini 官Key Argon 1.80x (gemini-official)' },
  { id: 'grok', label: 'Grok 0.32x (grok)' },
  { id: 'grok-special', label: 'Grok 特惠 0.20x (grok-special)' },
  { id: 'deepseek', label: 'DeepSeek 0.20x (deepseek)' },
  { id: 'deepseek-max', label: 'DeepSeek 满血满速 0.30x (deepseek-max)' },
  { id: 'deepseek-bailian-1017', label: '百炼 DeepSeek 1017 (deepseek-bailian-1017)' },
  { id: 'zhipu', label: '智谱 GLM 0.15x (zhipu)' },
  { id: 'kimi', label: 'Kimi 0.20x (kimi)' },
  { id: 'kimi-max', label: 'Kimi 官转满血 0.30x (kimi-max)' },
]

export interface SubscriptionCategorySpec {
  id: SubscriptionCategory
  shortName: string
  title: string
  tagline: string
  recommendedModels: readonly string[]
  excludedNote: string
}

export interface SubscriptionCategoryPlan {
  id: string
  category: SubscriptionCategory
  level: SubscriptionTierLevel
  name: string
  badge: string
  priceCny: number
  weeklyLimitUsd: number
  monthlyLimitUsd: number
  preferredKeyGroup: string
  eligibleGroups: readonly string[]
  highlights: readonly string[]
}

export const CATEGORY_DEFAULT_KEY_GROUPS: Record<SubscriptionCategory, string> = {
  gpt: 'gpt-pro',
  claude: 'claude-kiro',
  gemini: 'gemini',
  deepseek: 'deepseek',
  zhipu: 'zhipu',
  kimi: 'kimi',
}

export function getDefaultKeyGroupForCategory(category: SubscriptionCategory): string {
  return CATEGORY_DEFAULT_KEY_GROUPS[category]
}

export function getDefaultKeyGroupForModel(modelId: string): string | null {
  const category = classifyModelSubscriptionCategory(modelId)
  return category ? CATEGORY_DEFAULT_KEY_GROUPS[category] : null
}

export const SUBSCRIPTION_CATEGORY_SPECS: readonly SubscriptionCategorySpec[] = [
  {
    id: 'gpt',
    shortName: 'GPT',
    title: 'OpenAI GPT 专区',
    tagline: '覆盖 GPT-5.x / GPT-6.x / Codex 系列代码与推理模型',
    recommendedModels: ['gpt-6.2', 'gpt-6.2-astra', 'gpt-5.6-codex'],
    excludedNote: '周配额每周期自动刷新，独立计额',
  },
  {
    id: 'claude',
    shortName: 'Claude',
    title: 'Anthropic Claude 专区',
    tagline: '高稳定长程编程与深度推理，覆盖 Sonnet / Haiku / Opus',
    recommendedModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
    excludedNote: '周配额每周期自动刷新，独立计额',
  },
  {
    id: 'gemini',
    shortName: 'Gemini',
    title: 'Google Gemini 专区',
    tagline: '超长 2M 上下文多模态推理与跨文件文档分析',
    recommendedModels: ['gemini-4-pro', 'gemini-4-ultra', 'gemini-3.5-flash'],
    excludedNote: '周配额每周期自动刷新，独立计额',
  },
  {
    id: 'deepseek',
    shortName: 'DeepSeek',
    title: 'DeepSeek 深度求索专区',
    tagline: '覆盖 DeepSeek V4 / V4.1 / Pro 高性价比推理与编程主力',
    recommendedModels: ['deepseek-v4', 'deepseek-v4.1-flash', 'deepseek-v4-pro'],
    excludedNote: '周配额每周期自动刷新，独立计额',
  },
  {
    id: 'zhipu',
    shortName: '智谱 GLM',
    title: '智谱 GLM 大模型专区',
    tagline: '覆盖 GLM-5.3 / 5.2 全能长文本与代码专精模型',
    recommendedModels: ['glm-5.3', 'glm-5.2', 'glm-5.3-flash'],
    excludedNote: '周配额每周期自动刷新，独立计额',
  },
  {
    id: 'kimi',
    shortName: 'Kimi',
    title: 'Kimi 月之暗面专区',
    tagline: '覆盖 Kimi K3 旗舰推理与 K2.7 Code 编码系列',
    recommendedModels: ['kimi-k3', 'kimi-k2.7-code'],
    excludedNote: '周配额每周期自动刷新，独立计额',
  },
] as const

export const SUBSCRIPTION_CATEGORY_PLANS: readonly SubscriptionCategoryPlan[] = [
  {
    id: 'gpt_standard',
    category: 'gpt',
    level: 'standard',
    name: 'GPT 标准版',
    badge: '月度基础',
    priceCny: 39.9,
    weeklyLimitUsd: 9.5,
    monthlyLimitUsd: 38,
    preferredKeyGroup: 'gpt-pro',
    eligibleGroups: ['gpt-pro'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '满足日常编码协作、对话与推理需求', '覆盖 GPT 主力与 Codex 代码模型'],
  },
  {
    id: 'gpt_pro',
    category: 'gpt',
    level: 'pro',
    name: 'GPT 进阶版',
    badge: '高额进阶',
    priceCny: 79.9,
    weeklyLimitUsd: 19,
    monthlyLimitUsd: 76,
    preferredKeyGroup: 'gpt-pro',
    eligibleGroups: ['gpt-pro'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '更高并发吞吐与双倍以上周期可用空间', '适合长程 Agent 任务与重度深度推理'],
  },
  {
    id: 'claude_standard',
    category: 'claude',
    level: 'standard',
    name: 'Claude 标准版',
    badge: '月度基础',
    priceCny: 69.9,
    weeklyLimitUsd: 17,
    monthlyLimitUsd: 68,
    preferredKeyGroup: 'claude-kiro',
    eligibleGroups: ['claude-kiro'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '高性价比日常编程与稳定工程主力', '覆盖 Sonnet / Haiku 全场景协作'],
  },
  {
    id: 'claude_pro',
    category: 'claude',
    level: 'pro',
    name: 'Claude 进阶版',
    badge: '高额进阶',
    priceCny: 139.9,
    weeklyLimitUsd: 34,
    monthlyLimitUsd: 136,
    preferredKeyGroup: 'claude-kiro',
    eligibleGroups: ['claude-kiro'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '充沛周期用量支撑大型重构与高频任务', '适合复杂多轮代码推演与连续开发'],
  },
  {
    id: 'gemini_standard',
    category: 'gemini',
    level: 'standard',
    name: 'Gemini 标准版',
    badge: '月度基础',
    priceCny: 34.9,
    weeklyLimitUsd: 8.5,
    monthlyLimitUsd: 34,
    preferredKeyGroup: 'gemini',
    eligibleGroups: ['gemini'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '超长 2M 上下文阅读与代码理解', '适合日常文档梳理与多模态问答'],
  },
  {
    id: 'gemini_pro',
    category: 'gemini',
    level: 'pro',
    name: 'Gemini 进阶版',
    badge: '高额进阶',
    priceCny: 69.9,
    weeklyLimitUsd: 17,
    monthlyLimitUsd: 68,
    preferredKeyGroup: 'gemini',
    eligibleGroups: ['gemini'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '更大可用余量，支持高频视觉与仓库扫描', '从容应对连续多模态长文检索任务'],
  },
  {
    id: 'deepseek_standard',
    category: 'deepseek',
    level: 'standard',
    name: 'DeepSeek 标准版',
    badge: '月度基础',
    priceCny: 14.9,
    weeklyLimitUsd: 3.5,
    monthlyLimitUsd: 14,
    preferredKeyGroup: 'deepseek',
    eligibleGroups: ['deepseek', 'deepseek-max', 'deepseek-bailian-1017'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '高性价比日常推理、问答与代码协作', '覆盖 DeepSeek V4 / V4.1 / Pro 主力'],
  },
  {
    id: 'deepseek_pro',
    category: 'deepseek',
    level: 'pro',
    name: 'DeepSeek 进阶版',
    badge: '高额进阶',
    priceCny: 29.9,
    weeklyLimitUsd: 7.25,
    monthlyLimitUsd: 29,
    preferredKeyGroup: 'deepseek',
    eligibleGroups: ['deepseek', 'deepseek-max', 'deepseek-bailian-1017'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '双倍以上周可用空间，长程推演更从容', '适合重度代码分析与全天候深度推理'],
  },
  {
    id: 'zhipu_standard',
    category: 'zhipu',
    level: 'standard',
    name: '智谱 GLM 标准版',
    badge: '月度基础',
    priceCny: 14.9,
    weeklyLimitUsd: 3.5,
    monthlyLimitUsd: 14,
    preferredKeyGroup: 'zhipu',
    eligibleGroups: ['zhipu'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '轻量高效中文写作与日常开发辅助', '覆盖 GLM-5.3 / 5.2 / Flash 全系模型'],
  },
  {
    id: 'zhipu_pro',
    category: 'zhipu',
    level: 'pro',
    name: '智谱 GLM 进阶版',
    badge: '高额进阶',
    priceCny: 29.9,
    weeklyLimitUsd: 7.25,
    monthlyLimitUsd: 29,
    preferredKeyGroup: 'zhipu',
    eligibleGroups: ['zhipu'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '更大可用周期容量，支持海量文档阅读', '适合长程多轮任务与全库代码辅助'],
  },
  {
    id: 'kimi_standard',
    category: 'kimi',
    level: 'standard',
    name: 'Kimi 标准版',
    badge: '月度基础',
    priceCny: 24.9,
    weeklyLimitUsd: 6,
    monthlyLimitUsd: 24,
    preferredKeyGroup: 'kimi',
    eligibleGroups: ['kimi', 'kimi-max'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '长文精读与结构化深度分析优选', '覆盖 Kimi K3 与 K2.7 Code 主力'],
  },
  {
    id: 'kimi_pro',
    category: 'kimi',
    level: 'pro',
    name: 'Kimi 进阶版',
    badge: '高额进阶',
    priceCny: 49.9,
    weeklyLimitUsd: 12,
    monthlyLimitUsd: 48,
    preferredKeyGroup: 'kimi',
    eligibleGroups: ['kimi', 'kimi-max'],
    highlights: ['每周一 00:00 UTC 自动刷新周期额度', '充裕周度配额满足高频旗舰 K3 调用', '适合长文档综合与大型代码工程'],
  },
] as const

const CATEGORY_SPEC_MAP = new Map<SubscriptionCategory, SubscriptionCategorySpec>(
  SUBSCRIPTION_CATEGORY_SPECS.map((s) => [s.id, s]),
)

const PLAN_BY_ID = new Map<string, SubscriptionCategoryPlan>(
  SUBSCRIPTION_CATEGORY_PLANS.map((p) => [p.id, p]),
)

export function getCategorySpec(category: SubscriptionCategory): SubscriptionCategorySpec {
  return CATEGORY_SPEC_MAP.get(category) ?? SUBSCRIPTION_CATEGORY_SPECS[0]!
}

export function getCategoryPlan(
  category: SubscriptionCategory,
  level: SubscriptionTierLevel,
): SubscriptionCategoryPlan {
  return (
    SUBSCRIPTION_CATEGORY_PLANS.find((p) => p.category === category && p.level === level) ??
    SUBSCRIPTION_CATEGORY_PLANS[0]!
  )
}

export function getCategoryPlanById(planId: string): SubscriptionCategoryPlan | undefined {
  return PLAN_BY_ID.get(planId)
}

export function getCategoryPlans(category: SubscriptionCategory): readonly SubscriptionCategoryPlan[] {
  return SUBSCRIPTION_CATEGORY_PLANS.filter((p) => p.category === category)
}

export function classifyModelSubscriptionCategory(
  modelId: string,
  keyGroup?: string,
): SubscriptionCategory | null {
  const m = modelId.trim().toLowerCase()
  const g = (keyGroup || '').trim().toLowerCase()
  if (m) {
    if (m.startsWith('gpt-') || /^o[134](-|$)/.test(m) || m.includes('codex') || m.includes('openai')) {
      return 'gpt'
    }
    if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku') || m.includes('fable')) {
      return 'claude'
    }
    if (m.includes('gemini') || m.includes('gemma')) {
      return 'gemini'
    }
    if (m.includes('deepseek')) return 'deepseek'
    if (m.includes('glm') || m.includes('zhipu')) return 'zhipu'
    if (m.includes('kimi') || m.includes('moonshot')) return 'kimi'
  }
  if (g.startsWith('gpt')) return 'gpt'
  if (g.startsWith('claude')) return 'claude'
  if (g.startsWith('gemini')) return 'gemini'
  if (g.startsWith('deepseek')) return 'deepseek'
  if (g.startsWith('zhipu')) return 'zhipu'
  if (g.startsWith('kimi')) return 'kimi'
  return null
}

export function isModelEligibleForCategorySubscription(
  modelId: string,
  keyGroup?: string,
): boolean {
  const m = modelId.trim().toLowerCase()
  const g = (keyGroup || '').trim().toLowerCase()
  if (g.endsWith('-external') || g === 'gemini-official') return false
  if (m.includes('gemini4argon') || m.endsWith('-external')) return false
  return classifyModelSubscriptionCategory(modelId, keyGroup) !== null
}

export function estimateModelUsageCostUsd(
  modelId: string,
  usage: TokenUsage,
  keyGroup?: string,
): number {
  const m = modelId.trim().toLowerCase()
  const g = (keyGroup || '').trim().toLowerCase()
  const inTok = Math.max(0, usage.inputTokens || 0)
  const outTok = Math.max(0, usage.outputTokens || 0)
  const cacheReadTok = Math.max(0, usage.cacheReadTokens || 0)
  const cacheWriteTok = Math.max(0, usage.cacheWriteTokens || 0)
  if (inTok + outTok + cacheReadTok + cacheWriteTok === 0) return 0

  // Calibrated to RelayPulse actual channel cost in RMB/quota units per 1M tokens.
  let inRate = 1.25
  let outRate = 7.5
  let cacheRate = 0.125
  let writeRate = 1.25

  const cat = classifyModelSubscriptionCategory(m, g)
  if (cat === 'gpt') {
    if (m.includes('6-astra')) {
      inRate = 2.5; outRate = 12.5; cacheRate = 0.25; writeRate = 3.125
    } else if (m.includes('astra')) {
      inRate = 2.0; outRate = 10.0; cacheRate = 0.2; writeRate = 2.5
    } else if (m.includes('mini') || m.includes('nano') || m.includes('luna')) {
      inRate = 0.1875; outRate = 1.125; cacheRate = 0.01875; writeRate = 0.23
    } else if (m.includes('6.2-sol') || m.includes('6.1-sol') || m.includes('6-sol') || m.includes('terra')) {
      inRate = 0.5; outRate = 2.5; cacheRate = 0.025; writeRate = 0.625
    } else {
      inRate = 1.25; outRate = 7.5; cacheRate = 0.125; writeRate = 1.5625
    }
  } else if (cat === 'claude') {
    if (m.includes('opus-5-5') || m.includes('opus-5.5')) {
      inRate = 1.2; outRate = 6.0; cacheRate = 0.12; writeRate = 1.5
    } else if (m.includes('opus') || m.includes('fable')) {
      inRate = 1.5; outRate = 7.5; cacheRate = 0.15; writeRate = 1.875
    } else if (m.includes('haiku')) {
      inRate = 0.24; outRate = 1.2; cacheRate = 0.024; writeRate = 0.3
    } else {
      inRate = 0.9; outRate = 4.5; cacheRate = 0.09; writeRate = 1.125
    }
  } else if (cat === 'gemini') {
    if (m.includes('flash-lite')) {
      inRate = 0.12; outRate = 0.45; cacheRate = 0.012; writeRate = 0.12
    } else if (m.includes('flash')) {
      inRate = 0.45; outRate = 2.2; cacheRate = 0.045; writeRate = 0.45
    } else {
      inRate = 0.9; outRate = 5.4; cacheRate = 0.09; writeRate = 0.9
    }
  } else if (cat === 'deepseek') {
    if (m.includes('v4-pro') || m.includes('reasoner') || m.includes('-r1')) {
      inRate = 4.5; outRate = 12.0; cacheRate = 0.12; writeRate = 4.5
    } else if (m.includes('v4.1')) {
      inRate = 1.5; outRate = 4.2; cacheRate = 0.02; writeRate = 0.02
    } else {
      inRate = 2.0; outRate = 6.0; cacheRate = 0.05; writeRate = 2.0
    }
  } else if (cat === 'zhipu') {
    if (m.includes('flash')) {
      inRate = 0.12; outRate = 0.42; cacheRate = 0.035; writeRate = 0.12
    } else {
      inRate = 1.2; outRate = 4.2; cacheRate = 0.3; writeRate = 1.2
    }
  } else if (cat === 'kimi') {
    if (m.includes('k2.7') || m.includes('code')) {
      inRate = 1.3; outRate = 5.6; cacheRate = 0.22; writeRate = 1.3
    } else {
      inRate = 4.0; outRate = 20.0; cacheRate = 0.4; writeRate = 4.0
    }
  }

  const cost =
    (inTok * inRate +
      outTok * outRate +
      cacheReadTok * cacheRate +
      cacheWriteTok * writeRate) /
    1_000_000
  return Math.round(cost * 1_000_000) / 1_000_000
}

export interface AvatarPresetSpec {
  id: string
  bg: string
  fg: string
}

export const AVATAR_PRESETS: readonly AvatarPresetSpec[] = [
  { id: 'ember', bg: 'linear-gradient(145deg, #d67a5a, #c46342)', fg: '#ffffff' },
  { id: 'cat', bg: 'linear-gradient(145deg, #f0b892, #d46b4c)', fg: '#ffffff' },
  { id: 'ocean', bg: 'linear-gradient(145deg, #5b8fbe, #2f6191)', fg: '#ffffff' },
  { id: 'sage', bg: 'linear-gradient(145deg, #6ba683, #2e7a52)', fg: '#ffffff' },
  { id: 'plum', bg: 'linear-gradient(145deg, #9b7bbd, #67478b)', fg: '#ffffff' },
  { id: 'obsidian', bg: 'linear-gradient(145deg, #4b4844, #22211f)', fg: '#f4efe7' },
] as const

const AVATAR_PRESET_MAP = new Map<string, AvatarPresetSpec>(AVATAR_PRESETS.map((p) => [p.id, p]))

export function getAvatarPreset(avatar?: string | null): AvatarPresetSpec | undefined {
  if (!avatar || !avatar.startsWith('preset:')) return undefined
  return AVATAR_PRESET_MAP.get(avatar.slice('preset:'.length))
}

export function isValidAvatarValue(val: unknown): val is string | null {
  if (val === null) return true
  if (typeof val !== 'string') return false
  const clean = val.trim()
  if (clean.startsWith('preset:')) {
    return AVATAR_PRESET_MAP.has(clean.slice('preset:'.length))
  }
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(clean)) {
    return clean.length <= 524_288
  }
  if (/^https:\/\/[^\s<>"]+$/i.test(clean)) {
    return clean.length <= 2048
  }
  return false
}

/** Next Monday 00:00:00 UTC in ISO format (matches RelayPulse weekly rotation schedule). */
export function getNextMondayUtcIso(nowMs = Date.now()): string {
  const d = new Date(nowMs)
  const day = d.getUTCDay() // 0 = Sunday, 1 = Monday
  const daysUntilMonday = day === 0 ? 1 : 8 - day
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysUntilMonday, 0, 0, 0, 0)
  return new Date(next).toISOString()
}

export interface ModelVendorMeta {
  id: string
  label: string
  tileName: string
}

export interface ModelVendorGroup extends ModelVendorMeta {
  models: string[]
}

export function classifyModelVendor(modelId: string): ModelVendorMeta {
  const m = modelId.trim().toLowerCase()
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku') || m.includes('fable')) {
    return { id: 'claude', label: 'Claude', tileName: 'Claude' }
  }
  if (m.startsWith('gpt-') || /^o[134](-|$)/.test(m) || m.includes('codex') || m.includes('openai')) {
    return { id: 'gpt', label: 'OpenAI', tileName: 'OpenAI' }
  }
  if (m.includes('gemini') || m.includes('gemma')) {
    return { id: 'gemini', label: 'Gemini', tileName: 'Gemini' }
  }
  if (m.includes('deepseek')) {
    return { id: 'deepseek', label: 'DeepSeek', tileName: 'DeepSeek' }
  }
  if (m.includes('glm') || m.includes('zhipu')) {
    return { id: 'zhipu', label: 'GLM', tileName: 'GLM' }
  }
  if (m.includes('kimi') || m.includes('moonshot')) {
    return { id: 'kimi', label: 'Kimi', tileName: 'Kimi' }
  }
  if (m.includes('qwen') || m.includes('qwq')) {
    return { id: 'qwen', label: 'Qwen', tileName: 'Qwen' }
  }
  if (m.includes('llama')) {
    return { id: 'llama', label: 'Llama', tileName: 'Llama' }
  }
  if (m.includes('mistral') || m.includes('mixtral') || m.includes('codestral')) {
    return { id: 'mistral', label: 'Mistral', tileName: 'Mistral' }
  }
  if (m.includes('grok')) {
    return { id: 'grok', label: 'Grok', tileName: 'Grok' }
  }
  return { id: 'other', label: 'Other', tileName: 'AI' }
}

export function groupModelsByVendor(models: readonly string[]): ModelVendorGroup[] {
  const groups = new Map<string, ModelVendorGroup>()
  for (const raw of models) {
    const clean = raw.trim()
    if (!clean) continue
    const vendor = classifyModelVendor(clean)
    let group = groups.get(vendor.id)
    if (!group) {
      group = { ...vendor, models: [] }
      groups.set(vendor.id, group)
    }
    if (!group.models.includes(clean)) {
      group.models.push(clean)
    }
  }
  return [...groups.values()]
}
