// Built-in provider presets. Base URLs and model ids are the public defaults
// as of November 2026; the user can edit both after picking a preset.
import type { Protocol } from './types.ts'

export interface SuggestedModel {
  id: string
  labelZh: string
  labelEn: string
}

export interface ProviderPreset {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  /** Suggested model. Empty means "pick one after testing the key". */
  model: string
  /** Curated model suggestions shown in the expandable selector. */
  suggestedModels?: readonly SuggestedModel[]
  /** First-party Anthropic endpoint: gets Anthropic-only request fields. */
  anthropicDirect?: boolean
  /** Shown under the form so the user knows where the key comes from. */
  keyHint: string
  keyHintZh: string
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-5-5',
    suggestedModels: [
      { id: 'claude-sonnet-5-5', labelZh: '均衡旗舰', labelEn: 'Balanced' },
      { id: 'claude-opus-5-5', labelZh: '超强旗舰', labelEn: 'Flagship' },
      { id: 'claude-opus-4-5', labelZh: '深度创作', labelEn: 'Deep reasoning' },
      { id: 'claude-haiku-4-5', labelZh: '轻快响应', labelEn: 'Fast' },
    ],
    anthropicDirect: true,
    keyHint: 'An API key from console.anthropic.com.',
    keyHintZh: '来自 console.anthropic.com 的 API 密钥。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5',
    suggestedModels: [
      { id: 'gpt-5', labelZh: '旗舰通用', labelEn: 'Flagship' },
      { id: 'gpt-5-codex', labelZh: '编程专精', labelEn: 'Codex' },
      { id: 'gpt-5-mini', labelZh: '高速轻量', labelEn: 'Fast' },
      { id: 'o3', labelZh: '深度推理', labelEn: 'Reasoning' },
    ],
    keyHint: 'An API key from platform.openai.com.',
    keyHintZh: '来自 platform.openai.com 的 API 密钥。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    suggestedModels: [
      { id: 'deepseek-chat', labelZh: '通用对话 V3', labelEn: 'General' },
      { id: 'deepseek-reasoner', labelZh: '深度思考 R1', labelEn: 'Reasoning' },
    ],
    keyHint: 'An API key from platform.deepseek.com.',
    keyHintZh: '来自 platform.deepseek.com 的 API 密钥。',
  },
  {
    id: 'glm',
    name: 'GLM (Zhipu)',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    suggestedModels: [
      { id: 'glm-4.6', labelZh: '旗舰模型', labelEn: 'Flagship' },
      { id: 'glm-4-air', labelZh: '高性价比', labelEn: 'Fast' },
      { id: 'glm-zero-preview', labelZh: '深度推理', labelEn: 'Reasoning' },
    ],
    keyHint: 'An API key from open.bigmodel.cn.',
    keyHintZh: '来自 open.bigmodel.cn 的 API 密钥。',
  },
  {
    id: 'qwen',
    name: 'Qwen (Alibaba)',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    suggestedModels: [
      { id: 'qwen-plus', labelZh: '均衡主力', labelEn: 'Balanced' },
      { id: 'qwen-max', labelZh: '旗舰模型', labelEn: 'Flagship' },
      { id: 'qwen-coder-plus', labelZh: '代码专精', labelEn: 'Coding' },
    ],
    keyHint: 'An API key from Alibaba Cloud Model Studio.',
    keyHintZh: '来自阿里云百炼的 API 密钥。',
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2',
    suggestedModels: [
      { id: 'kimi-k2', labelZh: '新一代主力', labelEn: 'Flagship' },
      { id: 'moonshot-v1-128k', labelZh: '长文本 128K', labelEn: 'Long context' },
    ],
    keyHint: 'An API key from platform.moonshot.cn.',
    keyHintZh: '来自 platform.moonshot.cn 的 API 密钥。',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    suggestedModels: [
      { id: 'anthropic/claude-sonnet-4', labelZh: 'Claude Sonnet', labelEn: 'Claude Sonnet' },
      { id: 'openai/gpt-5', labelZh: 'GPT-5', labelEn: 'GPT-5' },
      { id: 'deepseek/deepseek-r1', labelZh: 'DeepSeek R1', labelEn: 'DeepSeek R1' },
    ],
    keyHint: 'An API key from openrouter.ai/keys.',
    keyHintZh: '来自 openrouter.ai/keys 的 API 密钥。',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    suggestedModels: [
      { id: 'qwen3:8b', labelZh: '本地均衡', labelEn: 'Local balanced' },
      { id: 'deepseek-r1:8b', labelZh: '本地推理', labelEn: 'Local reasoning' },
      { id: 'llama3.3:8b', labelZh: '通用对话', labelEn: 'General' },
    ],
    keyHint: 'No key needed. Make sure Ollama is running.',
    keyHintZh: '不需要密钥。请先启动 Ollama。',
  },
]

export function presetById(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDER_PRESETS.find((p) => p.id === id) : undefined
}
