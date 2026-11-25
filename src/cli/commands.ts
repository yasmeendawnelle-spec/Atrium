// Modular CLI workflows: presets, env BYOK detection, /config, /mcp, /plugin, /memory, /skills, /usage, /git, /commit, @file & !shell.
import { execFile, spawn } from 'node:child_process'
import { access, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fetchProviderModels, testConnection } from '../core/providers/index.ts'
import {
  evaluateCommandPolicy,
  evaluateFileReadPolicy,
  evaluateFileWritePolicy,
  inspectWorkspacePolicy,
  saveWorkspacePolicy,
} from '../core/policy.ts'
import { readWorkspacePreview } from '../core/tools/files.ts'
import {
  checkoutGitBranch,
  commitGitChanges,
  getGitAheadBehind,
  getGitChanges,
  getGitRepoStatus,
  listGitBranches,
} from '../core/tools/git.ts'
import { PROVIDER_PRESETS, presetById } from '../shared/presets.ts'
import type {
  AgentMode,
  Conversation,
  McpServerConfig,
  McpTransport,
  Protocol,
  ProxyMode,
  ReasoningEffort,
  WorkScene,
} from '../shared/types.ts'
import type { FleetWorkerSnapshot, ProjectPolicyConfig } from '../shared/studio_features.ts'

const execFileAsync = promisify(execFile)
import {
  AGENT_MODES,
  CONTEXT_WINDOW_PRESETS,
  normalizeContextWindowTokens,
  normalizeReasoningEffort,
  REASONING_EFFORT_LEVELS,
  resolveEffectiveContextLimit,
} from '../shared/types.ts'
import { gradientText, motionEnabled, paintRgb, sampleStops, sparkFrame, ultraStops } from './fx.ts'
import { createPalette, formatColoredDiff, type CliPalette, type CliRenderer } from './render.ts'
import type { CliRuntime } from './runtime.ts'
import { selectOption, type SelectOption } from './select.ts'
import { formatEffortScale, selectEffortSlider } from './slider.ts'
import { formatCompactTokens, createSpinner, renderFramedCard, renderProgressBar } from './ui.ts'

export type AskFn = (question: string, opts?: { secret?: boolean }) => Promise<string>

export interface CommandIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  palette: CliPalette
  isTty: boolean
}

export interface EnvProviderCandidate {
  envVar: string
  apiKey: string
  presetId: string
  name: string
  protocol: Protocol
  baseUrl: string
  model: string
}

const EFFORT_LEVELS: readonly ReasoningEffort[] = REASONING_EFFORT_LEVELS

export function detectEnvProviderCandidates(): EnvProviderCandidate[] {
  const candidates: EnvProviderCandidate[] = []
  const check = (envVar: string, presetId: string, overrideBase?: string, overrideModel?: string) => {
    const key = process.env[envVar]?.trim()
    if (!key) return
    const preset = presetById(presetId)
    candidates.push({
      envVar,
      apiKey: key,
      presetId,
      name: preset?.name ?? 'Custom OpenAI',
      protocol: preset?.protocol ?? 'openai',
      baseUrl: (overrideBase?.trim() || preset?.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: overrideModel?.trim() || preset?.model || 'gpt-5',
    })
  }
  check('ANTHROPIC_API_KEY', 'anthropic')
  check('OPENAI_API_KEY', 'openai')
  check('DEEPSEEK_API_KEY', 'deepseek')
  check('OPENROUTER_API_KEY', 'openrouter')
  if (process.env.ATRIUM_API_KEY?.trim()) {
    candidates.push({
      envVar: 'ATRIUM_API_KEY',
      apiKey: process.env.ATRIUM_API_KEY.trim(),
      presetId: 'custom',
      name: 'Env Provider (ATRIUM_API_KEY)',
      protocol: 'openai',
      baseUrl: (process.env.ATRIUM_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      model: process.env.ATRIUM_MODEL?.trim() || 'gpt-5',
    })
  }
  return candidates
}

/** Estimates current context tokens from API usage metadata or raw transcript characters. */
export function estimateConversationTokens(conversation: Conversation): number {
  for (let i = conversation.messages.length - 1; i >= 0; i -= 1) {
    const m = conversation.messages[i]
    if (m?.role === 'assistant' && m.usage) {
      return m.usage.inputTokens + (m.usage.cacheReadTokens ?? 0) + m.usage.outputTokens
    }
  }
  let chars = 0
  for (const m of conversation.messages) {
    if (m.role === 'user') chars += m.text.length + 24
    else if (m.role === 'assistant') chars += m.text.length + (m.reasoning?.length ?? 0) + 24
    else chars += m.output.length + 24
  }
  return Math.ceil(chars / 3.5)
}

/** Preset & environment-aware BYOK provider onboarding wizard with live connection probe. */
export async function runAddProviderFlow(
  runtime: CliRuntime,
  ask: AskFn,
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr?: NodeJS.WritableStream; palette: CliPalette },
): Promise<{ id: string; name: string; model: string } | null> {
  const { stdin, stdout, palette } = io
  const stderr = io.stderr ?? stdout
  const envCandidates = detectEnvProviderCandidates()

  type Choice =
    | { kind: 'env'; env: EnvProviderCandidate }
    | { kind: 'preset'; presetId: string }
    | { kind: 'custom' }

  const options: Array<SelectOption<Choice>> = []
  for (const cand of envCandidates) {
    options.push({
      value: { kind: 'env', env: cand },
      label: `Use ${cand.envVar} (${cand.name})`,
      hint: `${cand.protocol} · ${cand.model}`,
    })
  }
  for (const p of PROVIDER_PRESETS) {
    options.push({
      value: { kind: 'preset', presetId: p.id },
      label: p.name,
      hint: `${p.protocol} · ${p.baseUrl}`,
    })
  }
  options.push({
    value: { kind: 'custom' },
    label: 'Custom OpenAI / Anthropic / Responses endpoint',
    hint: 'Enter URL & protocol manually',
  })

  stdout.write('\n')
  const choice = await selectOption<Choice>({
    title: 'Select model provider preset',
    searchable: true,
    options,
    pageSize: 11,
    palette,
    stdin,
    stdout,
  })
  if (!choice) return null

  let presetId: string | undefined
  let protocol: Protocol = 'openai'
  let name = 'Custom OpenAI'
  let baseUrl = 'https://api.openai.com/v1'
  let defaultModel = 'gpt-5'
  let apiKey = ''
  let suggestedModels: string[] = []

  if (choice.kind === 'env') {
    presetId = choice.env.presetId !== 'custom' ? choice.env.presetId : undefined
    protocol = choice.env.protocol
    name = choice.env.name
    baseUrl = choice.env.baseUrl
    defaultModel = choice.env.model
    apiKey = choice.env.apiKey
    const preset = presetById(choice.env.presetId)
    suggestedModels = preset?.suggestedModels?.map((s) => s.id) ?? []
  } else if (choice.kind === 'preset') {
    const preset = presetById(choice.presetId)!
    presetId = preset.id
    protocol = preset.protocol
    name = preset.name
    baseUrl = preset.baseUrl
    defaultModel = preset.model || preset.suggestedModels?.[0]?.id || 'gpt-5'
    suggestedModels = preset.suggestedModels?.map((s) => s.id) ?? []
  } else {
    const protoPick = await selectOption<Protocol>({
      title: 'Select API protocol',
      options: [
        { value: 'openai', label: 'OpenAI Compatible', hint: 'Chat Completions / vLLM / DeepSeek' },
        { value: 'anthropic', label: 'Anthropic', hint: 'Claude Messages API' },
        { value: 'responses', label: 'OpenAI Responses', hint: 'GPT-5 / Codex Responses API' },
      ],
      palette,
      stdin,
      stdout,
    })
    if (!protoPick) return null
    protocol = protoPick
    const fallbackName = protocol === 'anthropic' ? 'Anthropic' : 'Custom OpenAI'
    const fallbackUrl = protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'
    defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-5'
    name = (await ask(`Provider name [${fallbackName}]: `)).trim() || fallbackName
    baseUrl = (await ask(`Base URL [${fallbackUrl}]: `)).trim() || fallbackUrl
  }

  if (choice.kind === 'preset') {
    baseUrl = (await ask(`Base URL [${baseUrl}]: `)).trim() || baseUrl
  }

  if (!apiKey) {
    const isLocal = /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(baseUrl)
    apiKey = (await ask(`API Key${isLocal ? ' (optional for localhost)' : ''}: `, { secret: true })).trim()
  }

  const draftForProbe = { name, protocol, baseUrl, model: defaultModel, ...(presetId ? { presetId } : {}) }
  const isTtyOut = Boolean((stderr as NodeJS.WriteStream).isTTY)
  const spinner = createSpinner({ stream: stderr, palette, enabled: isTtyOut })
  let discoveredModels: string[] = []

  if (apiKey || /^https?:\/\/(localhost|127\.)/i.test(baseUrl)) {
    spinner.start(`Testing ${name} & fetching models...`)
    const modelProbe = await fetchProviderModels(draftForProbe, apiKey).catch(() => ({ ok: false, models: [] as string[] }))
    if (modelProbe.ok && modelProbe.models?.length) {
      discoveredModels = modelProbe.models
      spinner.succeed(`Connected to ${name} (${discoveredModels.length} models found)`)
    } else {
      const ping = await testConnection(draftForProbe, apiKey).catch((e) => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }))
      if (ping.ok) {
        spinner.succeed(`Verified connection to ${name}`)
      } else {
        spinner.fail(`Connection check warning: ${ping.error ?? 'endpoint did not respond'} (saving anyway)`)
      }
    }
  }

  const pool = [...new Set([...discoveredModels, ...suggestedModels, defaultModel].filter(Boolean))]
  let selectedModel = defaultModel
  if (pool.length > 1) {
    const modelPick = await selectOption<string>({
      title: `Select default model (${name})`,
      searchable: true,
      options: [
        ...pool.slice(0, 48).map((m) => ({ value: m, label: m })),
        { value: '__custom__', label: '+ Enter custom model ID...' },
      ],
      initialIndex: Math.max(0, pool.indexOf(defaultModel)),
      palette,
      stdin,
      stdout,
    })
    if (modelPick === '__custom__') {
      selectedModel = (await ask(`Model ID [${defaultModel}]: `)).trim() || defaultModel
    } else if (modelPick) {
      selectedModel = modelPick
    }
  } else {
    selectedModel = (await ask(`Default model [${defaultModel}]: `)).trim() || defaultModel
  }

  const saved = await runtime.settings.saveProvider({
    name,
    protocol,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: selectedModel,
    models: [...new Set([selectedModel, ...pool])],
    ...(presetId ? { presetId } : {}),
    ...(apiKey ? { apiKey } : {}),
  })
  await runtime.settings.update({ activeProviderId: saved.id })
  stdout.write(`  ${palette.green('✓')} Activated provider "${saved.name}" (${saved.model}).\n`)
  return { id: saved.id, name: saved.name, model: saved.model }
}

/** Handles `/provider` interactive manager and subcommands (add/test/sync/remove/<name>). */
export async function handleProviderCommand(
  runtime: CliRuntime,
  conversationId: string,
  arg: string,
  ask: AskFn,
  io: CommandIo,
): Promise<string | undefined> {
  const { stdin, stdout, stderr, palette, isTty } = io
  const lower = arg.trim().toLowerCase()
  const parts = arg.trim().split(/\s+/)
  const sub = parts[0]?.toLowerCase() ?? ''
  const rest = parts.slice(1).join(' ').trim()

  if (!sub) {
    const providers = runtime.settings.listProviders()
    const activeId = runtime.settings.activeProvider()?.id
    if (!isTty) {
      if (providers.length === 0) {
        stdout.write('No providers configured. Run /provider add or /login.\n')
        return undefined
      }
      for (const p of providers) {
        const mark = p.id === activeId ? palette.green('*') : ' '
        stdout.write(`  ${mark} ${p.name} [${p.protocol}] model=${p.model} id=${palette.dim(p.id)}\n`)
      }
      return undefined
    }

    const choices: Array<SelectOption<string>> = providers.map((p) => ({
      value: p.id,
      label: p.name,
      hint: `${p.protocol} · ${p.model}`,
    }))
    choices.push({ value: '__add__', label: '+ Add BYOK / preset provider', hint: 'OpenAI / Anthropic / DeepSeek / Ollama' })
    if (providers.length > 0) {
      choices.push({ value: '__test__', label: 'Test active provider connection', hint: 'Verify endpoint & key' })
      choices.push({ value: '__sync__', label: 'Sync models from active provider', hint: 'Call /models endpoint' })
    }
    const picked = await selectOption({
      title: 'Providers',
      options: choices,
      initialIndex: Math.max(0, providers.findIndex((p) => p.id === activeId)),
      palette,
      stdin,
      stdout,
    })
    if (!picked) return undefined
    if (picked === '__add__') {
      const saved = await runAddProviderFlow(runtime, ask, { stdin, stdout, stderr, palette })
      return saved?.id
    }
    if (picked === '__test__') {
      await testActiveProvider(runtime, io)
      return undefined
    }
    if (picked === '__sync__') {
      await syncActiveProviderModels(runtime, io)
      return undefined
    }
    await runtime.settings.update({ activeProviderId: picked })
    await runtime.chats.setProvider(conversationId, picked)
    return picked
  }

  if (sub === 'add') {
    const saved = await runAddProviderFlow(runtime, ask, { stdin, stdout, stderr, palette })
    if (saved) await runtime.chats.setProvider(conversationId, saved.id)
    return saved?.id
  }

  if (sub === 'test') {
    await testActiveProvider(runtime, io, rest)
    return undefined
  }

  if (sub === 'sync') {
    await syncActiveProviderModels(runtime, io, rest)
    return undefined
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const providers = runtime.settings.listProviders()
    let target = rest ? runtime.findProvider(rest) : undefined
    if (!target && isTty && providers.length > 0) {
      const picked = await selectOption<string>({
        title: 'Remove which provider?',
        options: providers.map((p) => ({ value: p.id, label: p.name, hint: `${p.protocol} · ${p.model}` })),
        palette,
        stdin,
        stdout,
      })
      if (picked) target = runtime.settings.getProvider(picked)
    }
    if (!target) {
      stdout.write('Provider not found.\n')
      return undefined
    }
    if (target.managedBy === 'relaypulse') {
      stdout.write('Managed Atrium Cloud provider is removed automatically on /logout.\n')
      return undefined
    }
    await runtime.settings.removeProvider(target.id)
    stdout.write(`Removed provider "${target.name}".\n`)
    return runtime.settings.activeProvider()?.id
  }

  const target = runtime.findProvider(arg) || runtime.findProvider(lower)
  if (!target) {
    stdout.write(`Provider "${arg}" not found.\n`)
    return undefined
  }
  await runtime.settings.update({ activeProviderId: target.id })
  await runtime.chats.setProvider(conversationId, target.id)
  stdout.write(`Active provider switched to ${palette.green(target.name)} (${target.model}).\n`)
  return target.id
}

async function testActiveProvider(runtime: CliRuntime, io: CommandIo, query?: string): Promise<void> {
  const provider = (query ? runtime.findProvider(query) : undefined) ?? runtime.settings.activeProvider()
  if (!provider) {
    io.stdout.write('No provider configured.\n')
    return
  }
  const key = await runtime.settings.providerKey(provider.id)
  const spinner = createSpinner({ stream: io.stderr, palette: io.palette, enabled: io.isTty })
  spinner.start(`Testing ${provider.name} (${provider.model})...`)
  const res = await testConnection(provider, key)
  if (res.ok) {
    if (res.models?.length) await runtime.settings.mergeProviderModels(provider.id, res.models)
    spinner.succeed(`Connection OK (${provider.name} · ${provider.model})`)
  } else {
    spinner.fail(`Connection failed: ${res.error ?? 'unknown error'}`)
  }
}

async function syncActiveProviderModels(runtime: CliRuntime, io: CommandIo, query?: string): Promise<void> {
  const provider = (query ? runtime.findProvider(query) : undefined) ?? runtime.settings.activeProvider()
  if (!provider) {
    io.stdout.write('No provider configured.\n')
    return
  }
  if (provider.managedBy === 'relaypulse') {
    const spinner = createSpinner({ stream: io.stderr, palette: io.palette, enabled: io.isTty })
    spinner.start('Syncing Atrium Cloud model catalog...')
    const state = await runtime.account.syncModels(true)
    spinner.succeed(`Synced ${state.availableModels?.length ?? 0} models from Atrium Cloud`)
    return
  }
  const key = await runtime.settings.providerKey(provider.id)
  const spinner = createSpinner({ stream: io.stderr, palette: io.palette, enabled: io.isTty })
  spinner.start(`Fetching models from ${provider.baseUrl}...`)
  const res = await fetchProviderModels(provider, key)
  if (res.ok && res.models?.length) {
    await runtime.settings.mergeProviderModels(provider.id, res.models)
    spinner.succeed(`Synced ${res.models.length} models into ${provider.name}`)
  } else {
    spinner.fail(res.error ?? 'Provider returned no models')
  }
}

/** Handles `/effort [auto|low|medium|high|xhigh|max|ultracode]`; no argument opens the slider. */
export async function handleEffortCommand(runtime: CliRuntime, arg: string, io: CommandIo): Promise<void> {
  const s = runtime.settings.get()
  const cur = s.reasoningEffort ?? 'auto'
  const ultracode = s.ultracode === true
  const raw = arg.trim().toLowerCase()
  if (!raw) {
    const picked = io.isTty
      ? await selectEffortSlider({ effort: cur, ultracode, palette: io.palette, stdin: io.stdin, stdout: io.stdout })
      : null
    if (!io.isTty) {
      io.stdout.write(`Reasoning effort: ${formatEffortScale(cur)}${ultracode ? ' · ultracode on' : ''}\n`)
      return
    }
    if (picked) await runtime.settings.update({ reasoningEffort: picked.effort, ultracode: picked.ultracode })
    return
  }

  // Claude-Code parity: `/effort ultracode` switches the Ultracode workflow on.
  if (raw === 'ultracode') {
    await handleUltracodeCommand(runtime, 'on', io)
    return
  }
  const next = normalizeReasoningEffort(raw, 'auto')
  if (next === 'auto' && raw !== 'auto') {
    io.stdout.write(`Invalid effort "${arg}". Expected one of: ${EFFORT_LEVELS.join(', ')}, ultracode.\n`)
    return
  }
  await runtime.settings.update({ reasoningEffort: next })
  io.stdout.write(`Reasoning effort set to ${io.palette.green(next)}  ${io.palette.subtle(formatEffortScale(next))}\n`)
}

/** Handles `/ultracode [on|off]`; no argument toggles. */
export async function handleUltracodeCommand(runtime: CliRuntime, arg: string, io: CommandIo): Promise<void> {
  const cur = runtime.settings.get().ultracode === true
  const raw = arg.trim().toLowerCase()
  let next: boolean
  if (!raw || raw === 'toggle') next = !cur
  else if (raw === 'on' || raw === 'true' || raw === '1') next = true
  else if (raw === 'off' || raw === 'false' || raw === '0') next = false
  else {
    io.stdout.write(`Usage: /ultracode [on|off]\n`)
    return
  }
  await runtime.settings.update({ ultracode: next })
  if (!next) {
    io.stdout.write(`Ultracode ${io.palette.muted('off')}.\n`)
    return
  }
  const p = io.palette
  const stops = ultraStops(p)
  const title = 'ULTRACODE ON'
  if (io.isTty && p.enabled && motionEnabled(io.stdout)) await playUltracodeIntro(io, title)
  const effort = runtime.settings.get().reasoningEffort ?? 'auto'
  const flow = ['plan', 'explore', 'build', 'verify']
    .map((step, i, all) => paintRgb(step, sampleStops(stops, i / (all.length - 1)), p))
    .join(` ${p.subtle('›')} `)
  io.stdout.write(
    `${gradientText(`✦ ${title}`, p, stops, { bold: true })}  ${p.muted(
      `substantive tasks run as parallel subagent workflows (effort stays ${effort})`,
    )}\n  ${flow}\n`,
  )
}

/** A short shine across `✦ ULTRACODE ON` (about 0.7 s) before the final line is printed in its place. */
async function playUltracodeIntro(io: CommandIo, title: string): Promise<void> {
  const p = io.palette
  const stops = ultraStops(p)
  const frames = 18
  for (let f = 0; f <= frames; f += 1) {
    const shine = -3 + (f / frames) * (title.length + 6)
    const spark = gradientText(sparkFrame(f), p, stops, { wrap: true, phase: f * 0.06 })
    const text = gradientText(title, p, stops, { wrap: true, phase: f * 0.04, shine, bold: true })
    io.stdout.write(`\r\x1b[2K${spark} ${text}`)
    await new Promise((r) => setTimeout(r, 40))
  }
  io.stdout.write('\r\x1b[2K')
}

/** Handles interactive `/config` menu across CLI runtime settings. */
export async function handleConfigCommand(
  runtime: CliRuntime,
  renderer: CliRenderer,
  ask: AskFn,
  io: CommandIo,
): Promise<void> {
  const s = runtime.settings.get()
  const printStatic = () => {
    io.stdout.write(`${io.palette.bold('Atrium Configuration')}\n`)
    io.stdout.write(`  reasoningEffort:  ${s.reasoningEffort ?? 'auto'}\n`)
    io.stdout.write(`  ultracode:        ${s.ultracode === true ? 'on' : 'off'}\n`)
    io.stdout.write(`  agentMode:        ${s.agentMode ?? 'auto'}\n`)
    io.stdout.write(`  workScene:        ${s.workScene ?? 'code'}\n`)
    io.stdout.write(`  contextWindow:    ${s.contextWindowTokens ? formatCompactTokens(s.contextWindowTokens) : 'auto'}\n`)
    io.stdout.write(`  autoCompact:      ${s.autoCompact !== false ? 'on' : 'off'}\n`)
    io.stdout.write(`  webEnabled:       ${s.webEnabled !== false ? 'on' : 'off'}\n`)
    io.stdout.write(`  showThinking:     ${renderer.showThinking ? 'on' : 'off'}\n`)
    io.stdout.write(`  maxAgentRounds:   ${s.maxAgentRounds ?? 40}\n`)
    io.stdout.write(`  proxyMode:        ${s.proxyMode}\n`)
  }

  if (!io.isTty) {
    printStatic()
    return
  }

  type ConfigKey =
    | 'effort'
    | 'mode'
    | 'scene'
    | 'context'
    | 'autoCompact'
    | 'webEnabled'
    | 'thinking'
    | 'maxRounds'
    | 'proxyMode'

  const picked = await selectOption<ConfigKey>({
    title: 'Configure Atrium settings',
    options: [
      {
        value: 'effort',
        label: 'Reasoning effort & Ultracode',
        hint: `currently: ${s.reasoningEffort ?? 'auto'}${s.ultracode === true ? ' · ultracode' : ''}`,
      },
      { value: 'mode', label: 'Permission mode', hint: `currently: ${s.agentMode ?? 'auto'}` },
      { value: 'scene', label: 'Work scene', hint: `currently: ${s.workScene ?? 'code'}` },
      {
        value: 'context',
        label: 'Context window limit',
        hint: `currently: ${s.contextWindowTokens ? formatCompactTokens(s.contextWindowTokens) : 'auto'}`,
      },
      { value: 'autoCompact', label: 'Auto-compact context', hint: `currently: ${s.autoCompact !== false ? 'on' : 'off'}` },
      { value: 'webEnabled', label: 'Web search & fetch tools', hint: `currently: ${s.webEnabled !== false ? 'on' : 'off'}` },
      { value: 'thinking', label: 'Stream thinking text', hint: `currently: ${renderer.showThinking ? 'on' : 'off'}` },
      { value: 'maxRounds', label: 'Max tool rounds per turn', hint: `currently: ${s.maxAgentRounds ?? 40}` },
      { value: 'proxyMode', label: 'Network proxy mode', hint: `currently: ${s.proxyMode}` },
    ],
    palette: io.palette,
    stdin: io.stdin,
    stdout: io.stdout,
  })
  if (!picked) return

  switch (picked) {
    case 'effort':
      await handleEffortCommand(runtime, '', io)
      break
    case 'mode': {
      const cur = s.agentMode ?? 'auto'
      const next = await selectOption<AgentMode>({
        title: 'Permission mode',
        options: AGENT_MODES.map((m) => ({ value: m, label: m })),
        initialIndex: Math.max(0, AGENT_MODES.indexOf(cur)),
        palette: io.palette,
        stdin: io.stdin,
        stdout: io.stdout,
      })
      if (next) await runtime.settings.update({ agentMode: next })
      break
    }
    case 'scene': {
      const next = await selectOption<WorkScene>({
        title: 'Work scene',
        options: [
          { value: 'code', label: 'code', hint: 'Software engineering' },
          { value: 'work', label: 'work', hint: 'Docs, writing & general tasks' },
        ],
        initialIndex: s.workScene === 'work' ? 1 : 0,
        palette: io.palette,
        stdin: io.stdin,
        stdout: io.stdout,
      })
      if (next) await runtime.settings.update({ workScene: next })
      break
    }
    case 'context': {
      const curCustom = normalizeContextWindowTokens(s.contextWindowTokens)
      const next = await selectOption<number>({
        title: 'Context window limit',
        options: CONTEXT_WINDOW_PRESETS.map((p) => ({
          value: p,
          label: p === 0 ? 'auto' : formatCompactTokens(p),
        })),
        initialIndex: Math.max(0, CONTEXT_WINDOW_PRESETS.indexOf(curCustom as (typeof CONTEXT_WINDOW_PRESETS)[number])),
        palette: io.palette,
        stdin: io.stdin,
        stdout: io.stdout,
      })
      if (next !== null) await runtime.settings.update({ contextWindowTokens: next })
      break
    }
    case 'autoCompact': {
      const next = s.autoCompact === false
      await runtime.settings.update({ autoCompact: next })
      io.stdout.write(`Auto-compact ${next ? 'enabled' : 'disabled'}.\n`)
      break
    }
    case 'webEnabled': {
      const next = s.webEnabled === false
      await runtime.settings.update({ webEnabled: next })
      io.stdout.write(`Web tools ${next ? 'enabled' : 'disabled'}.\n`)
      break
    }
    case 'thinking': {
      const next = !renderer.showThinking
      renderer.setShowThinking(next)
      io.stdout.write(`Streaming thinking ${next ? 'enabled' : 'disabled'}.\n`)
      break
    }
    case 'maxRounds': {
      const raw = (await ask(`Max tool rounds per turn (10-100) [${s.maxAgentRounds ?? 40}]: `)).trim()
      if (!raw) break
      const n = Math.max(10, Math.min(100, Math.floor(Number(raw) || 40)))
      await runtime.settings.update({ maxAgentRounds: n })
      io.stdout.write(`maxAgentRounds set to ${n}.\n`)
      break
    }
    case 'proxyMode': {
      const next = await selectOption<ProxyMode>({
        title: 'Network proxy mode',
        options: [
          { value: 'system', label: 'system', hint: 'Use HTTP(S)_PROXY environment / system settings' },
          { value: 'none', label: 'none', hint: 'Direct connection (ignore proxy env)' },
          { value: 'custom', label: 'custom', hint: 'Specify custom HTTP/SOCKS proxy URL' },
        ],
        palette: io.palette,
        stdin: io.stdin,
        stdout: io.stdout,
      })
      if (!next) break
      if (next === 'custom') {
        const url = (await ask(`Proxy URL [${s.proxyUrl || 'http://127.0.0.1:7890'}]: `)).trim() || s.proxyUrl || 'http://127.0.0.1:7890'
        await runtime.settings.update({ proxyMode: 'custom', proxyUrl: url })
      } else {
        await runtime.settings.update({ proxyMode: next })
      }
      break
    }
  }
}

/** Handles `/mcp [add|reconnect|test|remove]` with interactive manager on TTY. */
export async function handleMcpCommand(
  runtime: CliRuntime,
  arg: string,
  ask: AskFn,
  io: CommandIo,
): Promise<void> {
  const { stdin, stdout, stderr, palette, isTty } = io
  const parts = arg.trim().split(/\s+/)
  const sub = parts[0]?.toLowerCase() ?? ''
  const rest = parts.slice(1).join(' ').trim()

  const addFlow = async () => {
    const name = (await ask('MCP server name: ')).trim()
    if (!name) return
    const transport = await selectOption<McpTransport>({
      title: 'MCP transport',
      options: [
        { value: 'stdio', label: 'stdio (local command)', hint: 'e.g. npx -y @modelcontextprotocol/server-github' },
        { value: 'http', label: 'http / streamable HTTP (remote URL)', hint: 'e.g. https://mcp.example.com/mcp' },
      ],
      palette,
      stdin,
      stdout,
    })
    if (!transport) return

    let draft: Omit<McpServerConfig, 'id'>
    if (transport === 'stdio') {
      const command = (await ask('Command (e.g. npx, node, uvx): ')).trim()
      if (!command) throw new Error('Command is required.')
      const rawArgs = (await ask('Arguments (space-separated, optional): ')).trim()
      draft = {
        name,
        enabled: true,
        transport: 'stdio',
        command,
        args: rawArgs ? rawArgs.split(/\s+/) : [],
      }
    } else {
      const url = (await ask('MCP HTTP URL: ')).trim()
      if (!url) throw new Error('URL is required.')
      draft = {
        name,
        enabled: true,
        transport: 'http',
        url,
      }
    }

    const spinner = createSpinner({ stream: stderr, palette, enabled: isTty })
    spinner.start(`Testing MCP server "${name}"...`)
    const testRes = await runtime.mcp.test(draft)
    if (testRes.ok) {
      spinner.succeed(`Verified "${name}" (${testRes.tools.length} tools)`)
    } else {
      spinner.fail(`Test warning: ${testRes.error ?? 'failed'} (saving config anyway)`)
    }
    await runtime.mcp.save(draft)
    stdout.write(`Saved MCP server "${name}".\n`)
  }

  if (sub === 'add') {
    await addFlow()
    return
  }

  const configs = runtime.mcp.list()
  const statuses = new Map(runtime.mcp.statuses().map((s) => [s.id, s]))

  if (!sub && !isTty) {
    if (configs.length === 0) {
      stdout.write('No MCP servers configured. Use "/mcp add" interactively to configure one.\n')
      return
    }
    for (const cfg of configs) {
      const st = statuses.get(cfg.id)
      const state = st?.state ?? (cfg.enabled ? 'off' : 'off')
      const toolCount = st?.tools.length ?? 0
      stdout.write(`  - ${cfg.name} [${cfg.transport}]: ${state} (${toolCount} tools)${st?.error ? ` · ${st.error}` : ''}\n`)
    }
    return
  }

  if (!sub && isTty) {
    const pickedServer = await selectOption<string>({
      title: 'MCP servers',
      options: [
        ...configs.map((cfg) => {
          const st = statuses.get(cfg.id)
          const state = st?.state ?? 'off'
          const count = st?.tools.length ?? 0
          return {
            value: cfg.id,
            label: cfg.name,
            hint: `${cfg.enabled ? state : 'disabled'} · ${count} tools · ${cfg.transport}`,
          }
        }),
        { value: '__add__', label: '+ Add MCP server', hint: 'Configure stdio or HTTP MCP server' },
      ],
      palette,
      stdin,
      stdout,
    })
    if (!pickedServer) return
    if (pickedServer === '__add__') {
      await addFlow()
      return
    }
    const targetCfg = configs.find((c) => c.id === pickedServer)
    if (!targetCfg) return
    const action = await selectOption<'toggle' | 'reconnect' | 'test' | 'remove'>({
      title: `Action for "${targetCfg.name}"`,
      options: [
        { value: 'toggle', label: targetCfg.enabled ? 'Disable server' : 'Enable & connect server' },
        { value: 'reconnect', label: 'Reconnect server' },
        { value: 'test', label: 'Test connection & list tools' },
        { value: 'remove', label: 'Remove server configuration' },
      ],
      palette,
      stdin,
      stdout,
    })
    if (!action) return
    if (action === 'toggle') {
      const next = await runtime.mcp.setEnabled(targetCfg.id, !targetCfg.enabled)
      stdout.write(`MCP "${targetCfg.name}" -> ${next.state} (${next.tools.length} tools).\n`)
    } else if (action === 'reconnect') {
      const next = await runtime.mcp.reconnect(targetCfg.id)
      stdout.write(`MCP "${targetCfg.name}" -> ${next.state} (${next.tools.length} tools).\n`)
    } else if (action === 'test') {
      const res = await runtime.mcp.test(targetCfg)
      stdout.write(res.ok ? `OK (${res.tools.length} tools)\n` : `Failed: ${res.error ?? 'error'}\n`)
    } else {
      await runtime.mcp.remove(targetCfg.id)
      stdout.write(`Removed MCP server "${targetCfg.name}".\n`)
    }
    return
  }

  const target = rest
    ? configs.find((c) => c.id === rest || c.name.toLowerCase() === rest.toLowerCase())
    : configs[0]
  if (!target) {
    stdout.write(`MCP server "${rest || '(none)'}" not found.\n`)
    return
  }
  if (sub === 'reconnect') {
    const st = await runtime.mcp.reconnect(target.id)
    stdout.write(`MCP "${target.name}" -> ${st.state} (${st.tools.length} tools).\n`)
  } else if (sub === 'test') {
    const res = await runtime.mcp.test(target)
    stdout.write(res.ok ? `OK (${res.tools.length} tools)\n` : `Failed: ${res.error ?? 'error'}\n`)
  } else if (sub === 'remove' || sub === 'rm') {
    await runtime.mcp.remove(target.id)
    stdout.write(`Removed MCP server "${target.name}".\n`)
  } else {
    stdout.write('Usage: /mcp [add | reconnect [name] | test [name] | remove [name]]\n')
  }
}

/** Handles `/memory [add <text>|search <q>|remove]` backed by MemoryStore. */
export async function handleMemoryCommand(runtime: CliRuntime, arg: string, io: CommandIo): Promise<void> {
  const { stdin, stdout, palette, isTty } = io
  const trimmed = arg.trim()
  const spaceIdx = trimmed.indexOf(' ')
  const sub = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase()
  const rest = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : ''

  if (sub === 'add' && rest) {
    const saved = await runtime.memory.save({
      content: rest,
      category: 'preference',
      scope: runtime.workspace ? 'workspace' : 'global',
      ...(runtime.workspace ? { workspace: runtime.workspace } : {}),
    })
    stdout.write(`Saved memory (${saved.scope}): "${saved.content}"\n`)
    return
  }

  if (sub === 'search' && rest) {
    const hits = runtime.memory.search(rest, runtime.workspace, 15)
    if (hits.length === 0) {
      stdout.write(`No memories matching "${rest}".\n`)
      return
    }
    for (const m of hits) {
      stdout.write(`  - [${m.category} · ${m.scope}] ${m.content} ${palette.dim(`(${m.id})`)}\n`)
    }
    return
  }

  if (sub === 'remove' && rest) {
    await runtime.memory.remove(rest)
    stdout.write(`Removed memory ${rest}.\n`)
    return
  }

  const items = runtime.memory.list(runtime.workspace)
  if (items.length === 0) {
    stdout.write('No saved memories yet. Use "/memory add <fact or preference>" to store one.\n')
    return
  }

  if (!isTty) {
    for (const m of items) {
      stdout.write(`  - [${m.category} · ${m.scope}${m.pinned ? ' ★' : ''}] ${m.content} (${m.id})\n`)
    }
    return
  }

  const pickedId = await selectOption<string>({
    title: 'Saved memories (select to delete, Esc to close)',
    options: items.slice(0, 20).map((m) => ({
      value: m.id,
      label: m.content.slice(0, 68),
      hint: `${m.category} · ${m.scope}${m.pinned ? ' · pinned' : ''}`,
    })),
    palette,
    stdin,
    stdout,
  })
  if (!pickedId) return
  const target = items.find((m) => m.id === pickedId)
  if (!target) return
  const act = await selectOption<'pin' | 'delete'>({
    title: 'Memory action',
    options: [
      { value: 'pin', label: target.pinned ? 'Unpin memory' : 'Pin memory' },
      { value: 'delete', label: 'Delete memory' },
    ],
    palette,
    stdin,
    stdout,
  })
  if (act === 'pin') {
    await runtime.memory.save({
      id: target.id,
      content: target.content,
      category: target.category,
      scope: target.scope,
      ...(target.workspace ? { workspace: target.workspace } : {}),
      pinned: !target.pinned,
    })
    stdout.write(`${!target.pinned ? 'Pinned' : 'Unpinned'} memory.\n`)
  } else if (act === 'delete') {
    await runtime.memory.remove(target.id)
    stdout.write('Deleted memory.\n')
  }
}

/** Handles `/skills`: interactive toggle on TTY or list on non-TTY. */
export async function handleSkillsCommand(runtime: CliRuntime, io: CommandIo): Promise<void> {
  const skills = await runtime.listSkills()
  if (skills.length === 0) {
    io.stdout.write('No skills discovered.\n')
    return
  }
  if (!io.isTty) {
    for (const sk of skills) {
      const state = sk.enabled ? io.palette.green('on') : io.palette.dim('off')
      io.stdout.write(`  - ${io.palette.bold(sk.name)} [${state}, ${sk.source}] ${io.palette.dim(sk.description)}\n`)
    }
    return
  }

  const picked = await selectOption<string>({
    title: 'Workspace & User Skills (Enter to toggle)',
    searchable: true,
    options: skills.map((sk) => ({
      value: sk.name,
      label: `${sk.enabled ? '●' : '○'} ${sk.name}`,
      hint: `${sk.source} · ${sk.description.slice(0, 48)}`,
    })),
    palette: io.palette,
    stdin: io.stdin,
    stdout: io.stdout,
  })
  if (!picked) return
  const target = skills.find((s) => s.name === picked)
  if (!target) return
  await runtime.skills.setEnabled(target.name, !target.enabled, runtime.workspace)
  io.stdout.write(`Skill "${target.name}" is now ${!target.enabled ? io.palette.green('enabled') : io.palette.dim('disabled')}.\n`)
}

/** Handles `/usage` and `/cost`: current context bar + cross-session spend summary. */
export async function handleUsageCommand(
  runtime: CliRuntime,
  conversation: Conversation,
  io: CommandIo,
): Promise<void> {
  const { stdout, palette, isTty } = io
  const settings = runtime.settings.get()
  const provider = runtime.settings.activeProvider()
  const limit = resolveEffectiveContextLimit(provider?.model, settings.contextWindowTokens)
  const used = estimateConversationTokens(conversation)
  const summary = await runtime.chats.summarizeUsage()

  const cardLines: string[] = [
    `${palette.muted('Current chat:')}  ${renderProgressBar(used / limit, 16, palette)} ${formatCompactTokens(used)} / ${formatCompactTokens(limit)}`,
    `${palette.muted('All history:')}   ${summary.conversations} chats · ${summary.userMessages} user / ${summary.assistantMessages} assistant msgs`,
    `${palette.muted('Totals:')}        in ${formatCompactTokens(summary.inputTokens)} · out ${formatCompactTokens(summary.outputTokens)} · cache-read ${formatCompactTokens(summary.cacheReadTokens)}`,
  ]
  if (summary.byProvider.length > 0) {
    cardLines.push('---')
    cardLines.push(palette.bold('By provider'))
    for (const row of summary.byProvider) {
      const pName = runtime.settings.getProvider(row.providerId)?.name ?? row.providerId
      cardLines.push(
        `  ${palette.cyan('•')} ${palette.bold(pName)}: ${row.conversations} chats · in ${formatCompactTokens(row.inputTokens)} · out ${formatCompactTokens(row.outputTokens)}`,
      )
    }
  }

  if (isTty) {
    const card = renderFramedCard({
      title: 'Context & Token Usage',
      badge: provider?.model ?? 'usage',
      lines: cardLines,
      cols: (stdout as NodeJS.WriteStream).columns,
      palette,
    })
    stdout.write(`\n${card}\n`)
    return
  }

  stdout.write(`${palette.bold('Context & Token Usage')}\n`)
  stdout.write(
    `  Current chat:  ${renderProgressBar(used / limit, 16, palette)} ${formatCompactTokens(used)} / ${formatCompactTokens(limit)}\n`,
  )
  stdout.write(
    `  All history:   ${summary.conversations} chats · ${summary.userMessages} user / ${summary.assistantMessages} assistant msgs\n`,
  )
  stdout.write(
    `  Totals:        in ${formatCompactTokens(summary.inputTokens)} · out ${formatCompactTokens(summary.outputTokens)} · cache-read ${formatCompactTokens(summary.cacheReadTokens)}\n`,
  )
  if (summary.byProvider.length > 0) {
    stdout.write(`  By provider:\n`)
    for (const row of summary.byProvider) {
      const pName = runtime.settings.getProvider(row.providerId)?.name ?? row.providerId
      stdout.write(
        `    - ${pName}: ${row.conversations} chats · in ${formatCompactTokens(row.inputTokens)} · out ${formatCompactTokens(row.outputTokens)}\n`,
      )
    }
  }
}

/** Handles `/git [status|branch [name]|diff]`. */
export async function handleGitCommand(runtime: CliRuntime, arg: string, io: CommandIo): Promise<void> {
  const { stdout, palette, stdin, isTty } = io
  const ws = runtime.workspace
  if (!ws) {
    stdout.write('No workspace directory active.\n')
    return
  }
  const status = await getGitRepoStatus(ws)
  if (!status.isRepo) {
    stdout.write(`Workspace "${ws}" is not a Git repository.\n`)
    return
  }

  const parts = arg.trim().split(/\s+/)
  const sub = parts[0]?.toLowerCase() ?? ''
  const rest = parts.slice(1).join(' ').trim()

  if (sub === 'branch') {
    const branches = await listGitBranches(ws)
    let target = rest
    if (!target && isTty && branches.length > 0) {
      const picked = await selectOption<string>({
        title: `Switch branch (current: ${status.branch ?? 'HEAD'})`,
        options: branches.map((b) => ({ value: b, label: b })),
        initialIndex: Math.max(0, branches.indexOf(status.branch ?? '')),
        palette,
        stdin,
        stdout,
      })
      if (!picked) return
      target = picked
    }
    if (!target) {
      stdout.write(`Branches: ${branches.join(', ')}\n`)
      return
    }
    const createNew = !branches.includes(target)
    const next = await checkoutGitBranch(ws, target, createNew)
    stdout.write(`Switched to branch ${palette.green(next.branch ?? target)}${createNew ? ' (new)' : ''}.\n`)
    return
  }

  const [ab, changes] = await Promise.all([getGitAheadBehind(ws), getGitChanges(ws)])
  stdout.write(`${palette.bold('Git Status')}\n`)
  stdout.write(
    `  Branch:   ${palette.green(status.branch ?? 'HEAD')} (${status.head ?? ''}) · ahead ${ab.ahead} / behind ${ab.behind}\n`,
  )
  if (status.githubRepo) stdout.write(`  Remote:   ${status.githubRepo}\n`)
  stdout.write(`  Changes:  ${changes.length} file(s)\n`)
  for (const item of changes.slice(0, 15)) {
    stdout.write(`    ${item.status.padEnd(8)} ${item.path} ${palette.green(`+${item.additions}`)}/${palette.red(`-${item.deletions}`)}\n`)
  }
  if (changes.length > 15) stdout.write(palette.dim(`    ... and ${changes.length - 15} more\n`))
}

/** Handles `/commit [message]` using workspace Git staging & commit. */
export async function handleCommitCommand(
  runtime: CliRuntime,
  arg: string,
  ask: AskFn,
  io: CommandIo,
): Promise<void> {
  const ws = runtime.workspace
  if (!ws) {
    io.stdout.write('No workspace directory active.\n')
    return
  }
  const msg = arg.trim() || (await ask('Commit message: ')).trim()
  if (!msg) {
    io.stdout.write('Commit cancelled (empty message).\n')
    return
  }
  const res = await commitGitChanges(ws, msg)
  io.stdout.write(
    `  ${io.palette.green('✓')} Committed ${io.palette.bold(res.commitHash)} on ${res.branch ?? 'HEAD'}: ${res.summary}\n`,
  )
}

/** Handles `/account [refresh|sync]` without leaking internal gateway domain names. */
export async function handleAccountCommand(runtime: CliRuntime, arg: string, io: CommandIo): Promise<void> {
  const sub = arg.trim().toLowerCase()
  if (sub === 'refresh') {
    await runtime.account.refresh()
  } else if (sub === 'sync') {
    await runtime.account.syncModels(true)
  }
  const st = runtime.account.getState()
  if (!st.connected) {
    io.stdout.write('Not signed in to an Atrium account. Run "/login" to connect.\n')
    return
  }
  io.stdout.write(`${io.palette.bold('Atrium Account')}\n`)
  io.stdout.write(`  User:     ${st.displayName || st.email || 'signed in'}${st.email && st.displayName ? ` (${st.email})` : ''}\n`)
  if (st.balanceCny !== undefined) io.stdout.write(`  Balance:  ¥${st.balanceCny.toFixed(2)}\n`)
  if (st.subscription?.active) {
    io.stdout.write(
      `  Plan:     ${st.subscription.name} (${st.subscription.remainingPercent}% remaining, ${st.subscription.daysRemaining ?? 0}d left)\n`,
    )
  }
  io.stdout.write(`  Models:   ${st.availableModels?.length ?? 0} synced\n`)
}

/** Handles `/permissions [clear]` showing persistent & session-level tool rules. */
export async function handlePermissionsCommand(
  runtime: CliRuntime,
  conversation: Conversation,
  arg: string,
  io: CommandIo,
): Promise<void> {
  const ws = conversation.workspace ?? runtime.workspace
  if (arg.trim().toLowerCase() === 'clear') {
    runtime.agent.clearSessionAllows(ws)
    for (const rule of runtime.settings.allowedRulesFor(ws)) {
      await runtime.settings.removeAllowedRule(ws, rule)
    }
    io.stdout.write('Cleared session and persistent workspace allow rules.\n')
    return
  }
  const persistent = runtime.settings.allowedRulesFor(ws)
  const session = runtime.agent.sessionAllowsFor(ws)
  io.stdout.write(`${io.palette.bold('Workspace Permissions')} (${ws ?? 'global'})\n`)
  io.stdout.write(`  Session allows:    ${session.length > 0 ? session.join(', ') : '(none)'}\n`)
  io.stdout.write(`  Persistent rules:  ${persistent.length > 0 ? persistent.join(', ') : '(none)'}\n`)
}

/** Exports a conversation to Markdown in the workspace or current directory. */
export async function exportConversationMarkdown(
  conversation: Conversation,
  requestedPath: string,
  workspace: string | undefined,
): Promise<string> {
  const baseDir = workspace ?? process.cwd()
  const safeDefault = `atrium-chat-${conversation.id}.md`
  const outPath = resolve(baseDir, requestedPath.trim() || safeDefault)
  const lines: string[] = [
    `# ${conversation.title || 'Atrium Conversation'}`,
    '',
    `- **ID**: \`${conversation.id}\``,
    `- **Workspace**: \`${conversation.workspace ?? '(none)'}\``,
    `- **Updated**: ${new Date(conversation.updatedAt).toISOString()}`,
    '',
    '---',
    '',
  ]
  for (const m of conversation.messages) {
    if (m.role === 'user') {
      lines.push(`## User${m.isSummary ? ' (Compact Summary)' : ''}`, '', m.text, '')
    } else if (m.role === 'assistant') {
      lines.push('## Assistant', '')
      if (m.text.trim()) lines.push(m.text, '')
      for (const tc of m.toolCalls) {
        lines.push(`- Tool Call: \`${tc.name}\` \`${JSON.stringify(tc.input)}\``)
      }
      if (m.toolCalls.length > 0) lines.push('')
    } else {
      lines.push(`### Tool Result: \`${m.name}\`${m.isError ? ' (ERROR)' : ''}`, '', '```text', m.output, '```', '')
    }
  }
  await writeFile(outPath, lines.join('\n'), 'utf8')
  return outPath
}

/** Validates new workspace path for `/cwd <dir>`. */
export async function resolveExistingDirectory(rawDir: string): Promise<string> {
  const target = resolve(rawDir.trim())
  const st = await stat(target)
  if (!st.isDirectory()) throw new Error(`Not a directory: ${target}`)
  return target
}

/** Expands `@relative/file` mentions inside a prompt into safe workspace file context blocks. */
export async function expandFileMentions(
  prompt: string,
  workspace: string | undefined,
  stdout: NodeJS.WritableStream,
  palette: CliPalette,
): Promise<string> {
  if (!workspace || !prompt.includes('@')) return prompt
  const mentionRe = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_./\\-]+)/g
  const seen = new Set<string>()
  const blocks: string[] = []

  for (const match of prompt.matchAll(mentionRe)) {
    const rel = match[1]?.trim()
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    if (blocks.length >= 8) break
    try {
      const preview = await readWorkspacePreview(workspace, rel)
      stdout.write(`  ${palette.cyan('📎')} ${palette.dim(`Attached ${preview.path} (${preview.size.toLocaleString()} chars)` )}\n`)
      blocks.push(`<attached_file path="${preview.path}">\n${preview.content}\n</attached_file>`)
    } catch {
      // Ignore non-existent paths, @handles, or outside-workspace traversal attempts cleanly.
    }
  }

  if (blocks.length === 0) return prompt
  return `${prompt}\n\n${blocks.join('\n\n')}`
}

/** Runs an inline `!command` directly inside the workspace and streams live output. */
export async function runInlineShellCommand(
  command: string,
  workspace: string | undefined,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  palette: CliPalette,
): Promise<number> {
  const clean = command.trim()
  if (!clean) return 0
  return new Promise<number>((resolveExit) => {
    const child = spawn(clean, [], {
      cwd: workspace ?? process.cwd(),
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
      env: process.env,
    })
    child.stdout?.on('data', (d) => stdout.write(d))
    child.stderr?.on('data', (d) => stderr.write(d))
    child.on('error', (err) => {
      stderr.write(`${palette.red(`! ${err.message}`)}\n`)
      resolveExit(1)
    })
    child.on('close', (code) => {
      const exitCode = code ?? 0
      const badge = exitCode === 0 ? palette.green(`✓ exited 0`) : palette.red(`✗ exited ${exitCode}`)
      stderr.write(`  ${badge}\n`)
      resolveExit(exitCode)
    })
  })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Detects repository agent instruction files (`AGENTS.md`, `CLAUDE.md`, etc.) in workspace. */
export async function detectInstructionFiles(workspace?: string): Promise<string[]> {
  if (!workspace) return []
  const candidates = ['AGENTS.override.md', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md']
  const found: string[] = []
  for (const rel of candidates) {
    if (await fileExists(join(workspace, rel))) found.push(rel)
  }
  return found
}

async function detectStandaloneSea(): Promise<boolean> {
  try {
    const sea = (await import('node:sea')) as { isSea?: () => boolean }
    return Boolean(sea.isSea?.())
  } catch {
    return false
  }
}

async function detectGitVersion(): Promise<string | null> {
  try {
    const res = await execFileAsync('git', ['--version'], { timeout: 3000 })
    return res.stdout.trim() || null
  } catch {
    return null
  }
}

/** Runs full CLI diagnostics (shared by `atrium doctor` and interactive `/doctor`). */
export async function runDoctorCheck(
  runtime: CliRuntime,
  version: string,
  stdout: NodeJS.WritableStream,
  json = false,
  paletteArg?: CliPalette,
): Promise<void> {
  const [standalone, gitVersion, gitRepo, instructionFiles] = await Promise.all([
    detectStandaloneSea(),
    detectGitVersion(),
    runtime.workspace ? getGitRepoStatus(runtime.workspace).catch(() => null) : Promise.resolve(null),
    detectInstructionFiles(runtime.workspace),
  ])
  const providers = runtime.settings.listProviders()
  const activeProvider = runtime.settings.activeProvider()
  const account = runtime.account.getState()
  const mcpStatuses = runtime.mcp.statuses()
  const plugins = runtime.plugins.list()
  const envProviders = detectEnvProviderCandidates().map((c) => c.envVar)

  const report = {
    version,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    standalone,
    executable: process.execPath,
    homeDir: runtime.homeDir,
    workspace: runtime.workspace ?? null,
    accountConnected: account.connected,
    accountEmail: account.email ?? null,
    activeProvider: activeProvider
      ? {
          id: activeProvider.id,
          name: activeProvider.name,
          protocol: activeProvider.protocol,
          model: activeProvider.model,
          hasKey: activeProvider.hasKey,
        }
      : null,
    providerCount: providers.length,
    envProviders,
    mcpCount: mcpStatuses.length,
    mcpConnected: mcpStatuses.filter((m) => m.state === 'connected').length,
    pluginCount: plugins.length,
    pluginsEnabled: plugins.filter((p) => p.enabled).length,
    instructionFiles,
    gitAvailable: Boolean(gitVersion),
    gitVersion,
    workspaceIsGitRepo: Boolean(gitRepo?.isRepo),
    workspaceBranch: gitRepo?.branch ?? null,
  }

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }

  const isTtyOut = Boolean((stdout as NodeJS.WriteStream).isTTY)
  const palette =
    paletteArg ?? createPalette(!process.env.NO_COLOR && isTtyOut, runtime.settings.get().cliTheme)
  const providerOk = Boolean(
    activeProvider && (activeProvider.hasKey || /^https?:\/\/(localhost|127\.)/i.test(activeProvider.baseUrl)),
  )

  if (isTtyOut) {
    const mark = (ok: boolean) => (ok ? palette.green('✓') : palette.yellow('!'))
    const cardLines: string[] = [
      `${mark(true)} ${palette.muted('Runtime:')}       ${process.platform}/${process.arch} · Node ${process.version}${standalone ? ' (standalone SEA)' : ''}`,
      `${mark(true)} ${palette.muted('Binary:')}        ${process.execPath}`,
      `${mark(true)} ${palette.muted('Home:')}          ${runtime.homeDir}`,
      `${mark(providerOk)} ${palette.muted('Provider:')}      ${activeProvider ? `${palette.bold(activeProvider.name)} (${palette.cyan(activeProvider.model)})` : palette.yellow('none — run /login or /provider add')}`,
      `${mark(account.connected)} ${palette.muted('Account:')}       ${account.connected ? palette.green(account.email ?? account.displayName ?? 'signed in') : palette.subtle('not signed in (optional for BYOK)')}`,
    ]
    if (envProviders.length > 0) {
      cardLines.push(`${mark(true)} ${palette.muted('Env Keys:')}      ${envProviders.join(', ')}`)
    }
    cardLines.push(
      `${mark(report.gitAvailable)} ${palette.muted('Git:')}           ${gitVersion ?? palette.yellow('not found in PATH')}${gitRepo?.isRepo ? palette.cyan(` (${gitRepo.branch ?? 'HEAD'})`) : ''}`,
      `${mark(true)} ${palette.muted('Instructions:')}  ${instructionFiles.length > 0 ? palette.cyan(instructionFiles.join(', ')) : palette.subtle('(none in workspace)')}`,
      `${mark(true)} ${palette.muted('Plugins:')}       ${report.pluginsEnabled}/${report.pluginCount} enabled`,
      `${mark(true)} ${palette.muted('MCP:')}           ${report.mcpConnected}/${report.mcpCount} connected`,
    )
    const card = renderFramedCard({
      title: 'Atrium CLI Doctor',
      badge: `v${version}`,
      lines: cardLines,
      cols: (stdout as NodeJS.WriteStream).columns,
      palette,
    })
    stdout.write(`\n${card}\n`)
    return
  }

  const okMark = (ok: boolean) => (ok ? '✓' : '!')
  stdout.write(`Atrium CLI Doctor (v${version})\n`)
  stdout.write(`  ✓ Runtime:      ${process.platform}/${process.arch} · Node ${process.version}${standalone ? ' (standalone SEA binary)' : ''}\n`)
  stdout.write(`  ✓ Binary:       ${process.execPath}\n`)
  stdout.write(`  ✓ Home:         ${runtime.homeDir}\n`)
  stdout.write(
    `  ${okMark(providerOk)} Provider:     ${activeProvider ? `${activeProvider.name} (${activeProvider.model})` : 'none — run "atrium login" or "/provider add"'}\n`,
  )
  stdout.write(
    `  ${okMark(account.connected)} Account:      ${account.connected ? account.email ?? account.displayName ?? 'signed in' : 'not signed in (optional for BYOK)'}\n`,
  )
  if (envProviders.length > 0) {
    stdout.write(`  ✓ Env Keys:     ${envProviders.join(', ')}\n`)
  }
  stdout.write(
    `  ${okMark(report.gitAvailable)} Git:          ${gitVersion ?? 'not found in PATH'}${gitRepo?.isRepo ? ` (branch: ${gitRepo.branch ?? 'HEAD'})` : ''}\n`,
  )
  stdout.write(`  ✓ Instructions: ${instructionFiles.length > 0 ? instructionFiles.join(', ') : '(none in workspace)'}\n`)
  stdout.write(`  ✓ Plugins:      ${report.pluginsEnabled}/${report.pluginCount} enabled\n`)
  stdout.write(`  ✓ MCP:          ${report.mcpConnected}/${report.mcpCount} connected\n`)
}

/** Handles `/plugin` interactive plugin discovery, toggle, import, and removal. */
export async function handlePluginCommand(
  runtime: CliRuntime,
  arg: string,
  ask: AskFn,
  io: CommandIo,
): Promise<void> {
  const { stdin, stdout, stderr, palette, isTty } = io
  const parts = arg.trim().split(/\s+/)
  const sub = parts[0]?.toLowerCase() ?? ''
  const rest = parts.slice(1).join(' ').trim()

  const importSource = async (rawSource: string) => {
    const clean = rawSource.trim()
    if (!clean) return
    const spinner = createSpinner({ stream: stderr, palette, enabled: isTty })
    spinner.start(`Importing plugin from ${clean}...`)
    try {
      const res = /^https?:\/\//i.test(clean)
        ? await runtime.plugins.importGithub(clean)
        : await runtime.plugins.importFolder(resolve(runtime.workspace ?? process.cwd(), clean))
      spinner.succeed(
        `Imported ${res.installed.length} plugin(s)${res.createdMcpServers.length ? ` and ${res.createdMcpServers.length} MCP server(s)` : ''}`,
      )
      for (const w of res.warnings) stderr.write(`  ${palette.yellow(`! ${w}`)}\n`)
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : String(err))
    }
  }

  if (sub === 'discover') {
    const candidates = await runtime.plugins.discoverLocal(runtime.workspace)
    if (candidates.length === 0) {
      stdout.write('No local Claude Code / Codex / Antigravity / Workspace plugins discovered.\n')
      return
    }
    if (!isTty) {
      for (const c of candidates) {
        stdout.write(`  - ${c.displayName || c.name} [${c.originLabel}] ${c.alreadyImported ? '(imported)' : '(available)'}\n`)
      }
      return
    }
    const available = candidates.filter((c) => !c.alreadyImported)
    if (available.length === 0) {
      stdout.write(`All ${candidates.length} discovered local plugins are already imported.\n`)
      return
    }
    const pickedKey = await selectOption<string>({
      title: 'Import discovered local plugin',
      options: available.map((c) => ({
        value: c.key,
        label: c.displayName || c.name,
        hint: `${c.originLabel} · ${c.skillNames.length} skills · ${c.mcpProposals.length} MCP`,
      })),
      palette,
      stdin,
      stdout,
    })
    if (!pickedKey) return
    const chosen = available.find((c) => c.key === pickedKey)
    if (!chosen) return
    const res = await runtime.plugins.importLocal([chosen.sourcePath])
    stdout.write(`Imported ${res.installed.length} plugin(s).\n`)
    return
  }

  if (sub === 'import' && rest) {
    await importSource(rest)
    return
  }

  const installed = runtime.plugins.list()
  const findTarget = (q: string) =>
    installed.find((p) => p.id === q || p.name.toLowerCase() === q.toLowerCase() || (p.displayName ?? '').toLowerCase() === q.toLowerCase())

  if (sub === 'enable' || sub === 'disable') {
    const t = rest ? findTarget(rest) : undefined
    if (!t) {
      stdout.write(`Plugin "${rest || '(none)'}" not found.\n`)
      return
    }
    await runtime.plugins.setEnabled(t.id, sub === 'enable')
    stdout.write(`Plugin "${t.displayName || t.name}" ${sub === 'enable' ? 'enabled' : 'disabled'}.\n`)
    return
  }

  if ((sub === 'remove' || sub === 'rm' || sub === 'uninstall') && rest) {
    const t = findTarget(rest)
    if (!t) {
      stdout.write(`Plugin "${rest}" not found.\n`)
      return
    }
    await runtime.plugins.remove(t.id)
    stdout.write(`Removed plugin "${t.displayName || t.name}".\n`)
    return
  }

  if (!isTty) {
    if (installed.length === 0) {
      stdout.write('No plugins installed. Run "atrium plugin discover" or "/plugin discover".\n')
      return
    }
    for (const p of installed) {
      stdout.write(
        `  - ${p.displayName || p.name} [${p.enabled ? 'on' : 'off'}, ${p.originLabel}] ${p.skillNames.length} skills · id=${p.id}\n`,
      )
    }
    return
  }

  const pickedId = await selectOption<string>({
    title: 'Plugins',
    searchable: true,
    options: [
      ...installed.map((p) => ({
        value: p.id,
        label: `${p.enabled ? '●' : '○'} ${p.displayName || p.name}`,
        hint: `${p.originLabel} · ${p.skillNames.length} skills · ${p.mcpServerIds.length} MCP`,
      })),
      { value: '__discover__', label: '+ Discover Claude Code / Codex / Workspace plugins', hint: 'Scan local configs' },
      { value: '__import__', label: '+ Import plugin from local folder or GitHub URL', hint: 'Folder path or owner/repo URL' },
    ],
    palette,
    stdin,
    stdout,
  })
  if (!pickedId) return
  if (pickedId === '__discover__') {
    await handlePluginCommand(runtime, 'discover', ask, io)
    return
  }
  if (pickedId === '__import__') {
    const src = (await ask('Local plugin folder path or GitHub repo URL: ')).trim()
    if (src) await importSource(src)
    return
  }

  const target = installed.find((p) => p.id === pickedId)
  if (!target) return
  const action = await selectOption<'toggle' | 'remove'>({
    title: `Plugin "${target.displayName || target.name}"`,
    options: [
      { value: 'toggle', label: target.enabled ? 'Disable plugin' : 'Enable plugin' },
      { value: 'remove', label: 'Uninstall plugin' },
    ],
    palette,
    stdin,
    stdout,
  })
  if (action === 'toggle') {
    await runtime.plugins.setEnabled(target.id, !target.enabled)
    stdout.write(`Plugin "${target.displayName || target.name}" -> ${!target.enabled ? 'enabled' : 'disabled'}.\n`)
  } else if (action === 'remove') {
    await runtime.plugins.remove(target.id)
    stdout.write(`Removed plugin "${target.displayName || target.name}".\n`)
  }
}

/** Builds a `/init` prompt instructing the agent to analyze the repo and craft/update `AGENTS.md`. */
export async function buildInitPrompt(workspace: string | undefined): Promise<string> {
  const ws = workspace ?? process.cwd()
  const existing = await detectInstructionFiles(ws)
  const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
  const foundManifests: string[] = []
  for (const m of manifests) {
    if (await fileExists(join(ws, m))) foundManifests.push(m)
  }
  return [
    'Please explore this workspace and create (or update) a concise, accurate `AGENTS.md` file at the repository root.',
    existing.length > 0 ? `Existing instruction files detected: ${existing.join(', ')}.` : 'No AGENTS.md or CLAUDE.md exists yet.',
    foundManifests.length > 0 ? `Detected project manifests: ${foundManifests.join(', ')}.` : '',
    'Cover: 1) Project architecture & key directories, 2) Exact build, lint, typecheck, and test commands verified from manifests, 3) Coding conventions & important constraints. Keep it practical and concise.',
  ]
    .filter(Boolean)
    .join('\n')
}

function findMcpByNameOrId(runtime: CliRuntime, nameOrId: string): McpServerConfig | undefined {
  const clean = nameOrId.trim()
  const lower = clean.toLowerCase()
  return runtime.mcp.list().find((c) => c.id === clean || c.name.toLowerCase() === lower)
}

/** Non-interactive CLI subcommand handler for `atrium mcp ...`. */
export async function runMcpSubcommand(
  runtime: CliRuntime,
  subArgs: readonly string[],
  json: boolean,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const sub = subArgs[0]?.toLowerCase() ?? 'list'

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(`Usage: atrium mcp <command> [options]

Commands:
  list                                            List configured MCP servers and status
  get <name>                                      Show configuration and status of an MCP server
  add [options] <name> <commandOrUrl> [args...]   Add an MCP server (--transport stdio|http, -e K=V, --header "K: V")
  add-json <name> <json>                          Add an MCP server from JSON config
  remove <name>                                   Remove an MCP server
  login <name>                                    Run browser OAuth login for an HTTP MCP server
  logout <name>                                   Clear OAuth tokens for an MCP server
`)
    return 0
  }

  if (sub === 'list') {
    const configs = runtime.mcp.list()
    const statuses = new Map(runtime.mcp.statuses().map((s) => [s.id, s]))
    const rows = configs.map((c) => ({ ...c, status: statuses.get(c.id) ?? null }))
    if (json) {
      stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
      return 0
    }
    if (rows.length === 0) {
      stdout.write('No MCP servers configured. Use "atrium mcp add ..." or "/mcp add" in chat.\n')
      return 0
    }
    for (const r of rows) {
      const state = r.status?.state ?? (r.enabled ? 'off' : 'disabled')
      const count = r.status?.tools.length ?? 0
      stdout.write(`- ${r.name} [${r.transport}]: ${state} (${count} tools)${r.status?.error ? ` · ${r.status.error}` : ''}\n`)
    }
    return 0
  }

  if (sub === 'get') {
    const name = subArgs[1]
    if (!name) {
      stderr.write('Usage: atrium mcp get <name>\n')
      return 2
    }
    const cfg = findMcpByNameOrId(runtime, name)
    if (!cfg) {
      stderr.write(`MCP server "${name}" not found.\n`)
      return 1
    }
    const st = runtime.mcp.statuses().find((s) => s.id === cfg.id) ?? null
    if (json) {
      stdout.write(`${JSON.stringify({ ...cfg, status: st }, null, 2)}\n`)
      return 0
    }
    stdout.write(`${cfg.name} (${cfg.id})\n  transport: ${cfg.transport}\n  enabled: ${cfg.enabled}\n  state: ${st?.state ?? 'off'}\n`)
    if (cfg.url) stdout.write(`  url: ${cfg.url}\n`)
    if (cfg.command) stdout.write(`  command: ${cfg.command} ${(cfg.args ?? []).join(' ')}\n`)
    return 0
  }

  if (sub === 'add-json') {
    const name = subArgs[1]
    const rawJson = subArgs[2]
    if (!name || !rawJson) {
      stderr.write('Usage: atrium mcp add-json <name> <json>\n')
      return 2
    }
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    const transport: McpTransport =
      parsed.transport === 'http' || typeof parsed.url === 'string' ? 'http' : 'stdio'
    const draft: Omit<McpServerConfig, 'id'> = {
      name,
      enabled: parsed.enabled !== false,
      transport,
      ...(typeof parsed.command === 'string' ? { command: parsed.command } : {}),
      ...(Array.isArray(parsed.args) ? { args: parsed.args.map(String) } : {}),
      ...(parsed.env && typeof parsed.env === 'object' ? { env: parsed.env as Record<string, string> } : {}),
      ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
      ...(parsed.headers && typeof parsed.headers === 'object' ? { headers: parsed.headers as Record<string, string> } : {}),
    }
    const saved = await runtime.mcp.save(draft, { connect: false })
    stdout.write(json ? `${JSON.stringify(saved, null, 2)}\n` : `Added MCP server "${saved.name}" (${saved.id}).\n`)
    return 0
  }

  if (sub === 'add') {
    let transport: McpTransport | undefined
    const env: Record<string, string> = {}
    const headers: Record<string, string> = {}
    const positional: string[] = []
    let afterDashDash = false

    for (let i = 1; i < subArgs.length; i += 1) {
      const a = subArgs[i]!
      if (afterDashDash) {
        positional.push(a)
        continue
      }
      if (a === '--') {
        afterDashDash = true
        continue
      }
      if ((a === '--transport' || a === '-t') && subArgs[i + 1]) {
        const t = subArgs[++i]!.toLowerCase()
        transport = t === 'http' || t === 'sse' ? 'http' : 'stdio'
      } else if ((a === '-e' || a === '--env') && subArgs[i + 1]) {
        const kv = subArgs[++i]!
        const eq = kv.indexOf('=')
        if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
      } else if ((a === '-H' || a === '--header') && subArgs[i + 1]) {
        const hv = subArgs[++i]!
        const colon = hv.indexOf(':')
        if (colon > 0) headers[hv.slice(0, colon).trim()] = hv.slice(colon + 1).trim()
      } else {
        positional.push(a)
      }
    }

    const [name, target, ...extraArgs] = positional
    if (!name || !target) {
      stderr.write('Usage: atrium mcp add [--transport stdio|http] [-e K=V] [--header "K: V"] <name> <commandOrUrl> [args...]\n')
      return 2
    }
    const resolvedTransport: McpTransport = transport ?? (/^https?:\/\//i.test(target) ? 'http' : 'stdio')
    const draft: Omit<McpServerConfig, 'id'> =
      resolvedTransport === 'http'
        ? {
            name,
            enabled: true,
            transport: 'http',
            url: target,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          }
        : {
            name,
            enabled: true,
            transport: 'stdio',
            command: target,
            args: extraArgs,
            ...(Object.keys(env).length > 0 ? { env } : {}),
          }
    const saved = await runtime.mcp.save(draft, { connect: false })
    stdout.write(json ? `${JSON.stringify(saved, null, 2)}\n` : `Added MCP server "${saved.name}" [${saved.transport}] (${saved.id}).\n`)
    return 0
  }

  if (sub === 'remove' || sub === 'rm') {
    const name = subArgs[1]
    if (!name) {
      stderr.write('Usage: atrium mcp remove <name>\n')
      return 2
    }
    const cfg = findMcpByNameOrId(runtime, name)
    if (!cfg) {
      stderr.write(`MCP server "${name}" not found.\n`)
      return 1
    }
    await runtime.mcp.remove(cfg.id)
    stdout.write(`Removed MCP server "${cfg.name}".\n`)
    return 0
  }

  if (sub === 'login' || sub === 'logout') {
    const name = subArgs[1]
    if (!name) {
      stderr.write(`Usage: atrium mcp ${sub} <name>\n`)
      return 2
    }
    const cfg = findMcpByNameOrId(runtime, name)
    if (!cfg) {
      stderr.write(`MCP server "${name}" not found.\n`)
      return 1
    }
    const next = sub === 'login' ? await runtime.mcp.oauthStart(cfg.id) : await runtime.mcp.oauthRevoke(cfg.id)
    stdout.write(`MCP "${cfg.name}" -> ${next.state}\n`)
    return 0
  }

  stderr.write(`Unknown mcp subcommand "${sub}". Run "atrium mcp --help" for usage.\n`)
  return 2
}

/** Non-interactive CLI subcommand handler for `atrium plugin|plugins ...`. */
export async function runPluginSubcommand(
  runtime: CliRuntime,
  subArgs: readonly string[],
  json: boolean,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const sub = subArgs[0]?.toLowerCase() ?? 'list'

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(`Usage: atrium plugin <command> [options]

Commands:
  list                        List installed plugins
  discover                    Discover Claude Code, Codex, Antigravity & workspace plugins
  import <path-or-github-url> Import a plugin from a local directory or GitHub URL
  enable <name|id>            Enable an installed plugin
  disable <name|id>           Disable an installed plugin
  remove <name|id>            Uninstall a plugin
`)
    return 0
  }

  if (sub === 'list') {
    const list = runtime.plugins.list()
    if (json) {
      stdout.write(`${JSON.stringify(list, null, 2)}\n`)
      return 0
    }
    if (list.length === 0) {
      stdout.write('No plugins installed. Run "atrium plugin discover" or "atrium import --all".\n')
      return 0
    }
    for (const p of list) {
      stdout.write(`- ${p.displayName || p.name} [${p.enabled ? 'enabled' : 'disabled'}, ${p.originLabel}] id=${p.id}\n`)
    }
    return 0
  }

  if (sub === 'discover') {
    const candidates = await runtime.plugins.discoverLocal(runtime.workspace)
    if (json) {
      stdout.write(`${JSON.stringify(candidates, null, 2)}\n`)
      return 0
    }
    if (candidates.length === 0) {
      stdout.write('No local external plugins discovered.\n')
      return 0
    }
    for (const c of candidates) {
      stdout.write(
        `- ${c.displayName || c.name} [${c.originLabel}] ${c.alreadyImported ? 'imported' : 'available'} (${c.sourcePath})\n`,
      )
    }
    return 0
  }

  if (sub === 'import') {
    const target = subArgs[1]
    if (!target) {
      stderr.write('Usage: atrium plugin import <path-or-github-url>\n')
      return 2
    }
    const res = /^https?:\/\//i.test(target)
      ? await runtime.plugins.importGithub(target)
      : await runtime.plugins.importFolder(resolve(runtime.workspace ?? process.cwd(), target))
    if (json) {
      stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      return 0
    }
    stdout.write(`Imported ${res.installed.length} plugin(s).\n`)
    return 0
  }

  const targetQuery = subArgs[1]
  if (!targetQuery) {
    stderr.write(`Usage: atrium plugin ${sub} <name|id>\n`)
    return 2
  }
  const found = runtime.plugins
    .list()
    .find(
      (p) =>
        p.id === targetQuery ||
        p.name.toLowerCase() === targetQuery.toLowerCase() ||
        (p.displayName ?? '').toLowerCase() === targetQuery.toLowerCase(),
    )
  if (!found) {
    stderr.write(`Plugin "${targetQuery}" not found.\n`)
    return 1
  }

  if (sub === 'enable' || sub === 'disable') {
    await runtime.plugins.setEnabled(found.id, sub === 'enable')
    stdout.write(`Plugin "${found.displayName || found.name}" ${sub === 'enable' ? 'enabled' : 'disabled'}.\n`)
    return 0
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'uninstall') {
    await runtime.plugins.remove(found.id)
    stdout.write(`Removed plugin "${found.displayName || found.name}".\n`)
    return 0
  }

  stderr.write(`Unknown plugin subcommand "${sub}". Run "atrium plugin --help" for usage.\n`)
  return 2
}

/** Handles `atrium import [--all] [--source claude-code|codex|antigravity|workspace]`. */
export async function runImportSubcommand(
  runtime: CliRuntime,
  subArgs: readonly string[],
  json: boolean,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    stdout.write(`Usage: atrium import [--all] [--source <claude-code|codex|antigravity|workspace>]

Scans local external AI agent plugins/skills and optionally imports them into Atrium.
`)
    return 0
  }

  const all = subArgs.includes('--all')
  let sourceFilter: string | undefined
  for (let i = 0; i < subArgs.length; i += 1) {
    if (subArgs[i] === '--source' && subArgs[i + 1]) {
      sourceFilter = subArgs[++i]!.toLowerCase()
    }
  }

  const discovered = await runtime.plugins.discoverLocal(runtime.workspace)
  const filtered = discovered.filter(
    (c) => !sourceFilter || c.origin.toLowerCase() === sourceFilter,
  )

  if (!all) {
    if (json) {
      stdout.write(`${JSON.stringify(filtered, null, 2)}\n`)
      return 0
    }
    if (filtered.length === 0) {
      stdout.write('No external plugins discovered.\n')
      return 0
    }
    stdout.write(`Discovered ${filtered.length} local plugin(s):\n`)
    for (const c of filtered) {
      stdout.write(`  - ${c.displayName || c.name} [${c.originLabel}] ${c.alreadyImported ? '(already imported)' : '(ready)'}\n`)
    }
    stdout.write('\nRun "atrium import --all" to import available items.\n')
    return 0
  }

  const paths = filtered.filter((c) => !c.alreadyImported).map((c) => c.sourcePath)
  if (paths.length === 0) {
    stdout.write(json ? `${JSON.stringify({ installed: [], skipped: [] })}\n` : 'All discovered plugins are already imported.\n')
    return 0
  }
  const res = await runtime.plugins.importLocal(paths)
  stdout.write(
    json
      ? `${JSON.stringify(res, null, 2)}\n`
      : `Imported ${res.installed.length} plugin(s) and ${res.createdMcpServers.length} MCP server(s).\n`,
  )
  return 0
}

// ---- Security Policy (`/policy`, `atrium policy`), Parallel Worktree Fleet (`/fleet`, `atrium fleet`), and Preview (`/preview`) ----

function splitCliTokens(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < raw.length) {
        current += raw[++i]!
      } else if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

function makeDefaultIo(stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): CommandIo {
  const isTty = Boolean((stdout as NodeJS.WriteStream).isTTY)
  return {
    stdin: process.stdin,
    stdout,
    stderr,
    palette: createPalette(!process.env.NO_COLOR && isTty),
    isTty,
  }
}

function resolvePolicyWorkspace(runtime: CliRuntime, conversation?: Conversation): string | undefined {
  return conversation?.worktreeBaseWorkspace ?? conversation?.workspace ?? runtime.workspace ?? runtime.settings.get().workspace
}

function appendUniqueRule(existing: string[] | undefined, rule: string): string[] {
  const list = existing ? [...existing] : []
  if (!list.includes(rule)) list.push(rule)
  return list
}

function formatPolicyUsage(): string {
  return `Usage:
  policy status                     Show active security policy rules & shield status
  policy check <path> [read|write]  Test whether reading/writing a path is allowed
  policy check-cmd <command...>     Test whether a shell command is allowed
  policy init [project|local]       Create .atrium/policy.json or .atrium/policy.local.json
  policy shield <on|off> [--local]  Toggle built-in sensitive-file shield
  policy deny-read <glob> [--local] Append a denyRead glob rule
  policy allow-read <glob> [--local] Append an allowRead glob rule
  policy deny-write <glob> [--local] Append a denyWrite glob rule
  policy allow-write <glob> [--local] Append an allowWrite glob rule
  policy deny-cmd <rule> [--local]  Append a denyCommands rule
  policy allow-cmd <rule> [--local] Append an allowCommands rule
`
}

async function executePolicyAction(
  runtime: CliRuntime,
  workspace: string | undefined,
  tokens: readonly string[],
  json: boolean,
  io: CommandIo,
): Promise<number> {
  const { stdout, stderr, palette, isTty } = io
  const sub = tokens[0]?.toLowerCase() || 'status'

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(formatPolicyUsage())
    return 0
  }

  if (sub === 'status' || sub === 'show') {
    const info = await inspectWorkspacePolicy(workspace)
    if (json) {
      stdout.write(`${JSON.stringify(info, null, 2)}\n`)
      return 0
    }
    const shieldText = info.protectSensitiveFiles
      ? palette.green('Active')
      : palette.yellow('Disabled')
    const listText = (arr: string[]) => (arr.length ? arr.join(', ') : palette.subtle('(none)'))
    const lines = [
      `${palette.muted('Workspace:')}     ${workspace ?? palette.subtle('(none)')}`,
      `${palette.muted('Shield:')}        ${shieldText} (${info.activeRuleCount} active rules)`,
      `${palette.muted('Project file:')}  ${info.projectFile.path} [${info.projectFile.exists ? (info.projectFile.parseError ? palette.red(`error: ${info.projectFile.parseError}`) : palette.green('loaded')) : palette.subtle('not created')}]`,
      `${palette.muted('Local file:')}    ${info.localFile.path} [${info.localFile.exists ? (info.localFile.parseError ? palette.red(`error: ${info.localFile.parseError}`) : palette.green('loaded')) : palette.subtle('not created')}]`,
      `${palette.muted('denyRead:')}      ${listText(info.effective.denyRead)}`,
      `${palette.muted('allowRead:')}     ${listText(info.effective.allowRead)}`,
      `${palette.muted('denyWrite:')}     ${listText(info.effective.denyWrite)}`,
      `${palette.muted('allowWrite:')}    ${listText(info.effective.allowWrite)}`,
      `${palette.muted('denyCommands:')}  ${listText(info.effective.denyCommands)}`,
      `${palette.muted('allowCommands:')} ${listText(info.effective.allowCommands)}`,
      `${palette.muted('Sandbox floor:')} ${info.effective.sandboxMode ?? palette.subtle('(inherit)')} · net: ${info.effective.allowNetwork === false ? palette.yellow('blocked') : 'inherit'}`,
    ]
    if (isTty) {
      const cols = (stdout as NodeJS.WriteStream).columns || 90
      stdout.write(
        `\n${renderFramedCard({ title: 'Project Security Policy', badge: info.protectSensitiveFiles ? 'shield:on' : 'shield:off', lines, cols, maxWidth: 96, palette })}\n\n`,
      )
    } else {
      stdout.write(`${lines.join('\n')}\n`)
    }
    return 0
  }

  if (sub === 'check' || sub === 'test') {
    const targetPath = tokens[1]
    if (!targetPath) {
      stderr.write('Usage: policy check <path> [read|write]\n')
      return 2
    }
    const rawOp = (tokens[2] ?? 'read').toLowerCase()
    const op = rawOp === 'write' ? 'write' : 'read'
    const decision = op === 'write'
      ? await evaluateFileWritePolicy(workspace, targetPath)
      : await evaluateFileReadPolicy(workspace, targetPath)
    if (json) {
      stdout.write(`${JSON.stringify({ path: targetPath, operation: op, ...decision }, null, 2)}\n`)
      return 0
    }
    const verdict = decision.allowed ? palette.green('ALLOWED') : palette.red('BLOCKED')
    const detail = decision.reason ?? (decision.matchedRule ? `${decision.source ?? 'default'}: ${decision.matchedRule}` : 'No blocking rules matched.')
    stdout.write(`${verdict} [${op}] ${targetPath} — ${detail}\n`)
    return 0
  }

  if (sub === 'check-cmd' || sub === 'test-cmd') {
    const cmdTokens = tokens.slice(1).filter((t) => t !== '--')
    const command = cmdTokens.join(' ').trim()
    if (!command) {
      stderr.write('Usage: policy check-cmd <command...>\n')
      return 2
    }
    const decision = await evaluateCommandPolicy(workspace, command)
    if (json) {
      stdout.write(`${JSON.stringify({ command, ...decision }, null, 2)}\n`)
      return 0
    }
    const verdict = decision.allowed ? palette.green('ALLOWED') : palette.red('BLOCKED')
    const detail = decision.reason ?? (decision.matchedRule ? `${decision.source ?? 'default'}: ${decision.matchedRule}` : 'Command allowed.')
    stdout.write(`${verdict} [cmd] ${command} — ${detail}\n`)
    return 0
  }

  if (!workspace) {
    stderr.write('No active workspace folder. Switch to a workspace via -C or /cwd first.\n')
    return 1
  }

  const useLocal = tokens.includes('--local')
  const scope: 'project' | 'local' = useLocal ? 'local' : 'project'
  const current = await inspectWorkspacePolicy(workspace)
  const baseConfig: ProjectPolicyConfig = structuredClone(
    scope === 'local' ? current.localConfig : current.projectConfig,
  )

  if (sub === 'init') {
    const argScope = tokens[1]?.toLowerCase() === 'local' || useLocal ? 'local' : 'project'
    const seed: ProjectPolicyConfig =
      argScope === 'local'
        ? { ...current.localConfig }
        : { protectSensitiveFiles: current.projectConfig.protectSensitiveFiles ?? true, ...current.projectConfig }
    const saved = await saveWorkspacePolicy(workspace, argScope, seed)
    const targetPath = argScope === 'local' ? saved.localFile.path : saved.projectFile.path
    if (json) stdout.write(`${JSON.stringify(saved, null, 2)}\n`)
    else stdout.write(`Initialized ${argScope} security policy -> ${targetPath}\n`)
    return 0
  }

  if (sub === 'shield') {
    const val = tokens.find((t, idx) => idx > 0 && t !== '--local')?.toLowerCase()
    if (val !== 'on' && val !== 'off') {
      stderr.write('Usage: policy shield <on|off> [--local]\n')
      return 2
    }
    baseConfig.protectSensitiveFiles = val === 'on'
    const saved = await saveWorkspacePolicy(workspace, scope, baseConfig)
    if (json) stdout.write(`${JSON.stringify(saved, null, 2)}\n`)
    else stdout.write(`Sensitive-file shield set to ${val} in ${scope === 'local' ? saved.localFile.path : saved.projectFile.path}.\n`)
    return 0
  }

  const ruleMap: Record<string, keyof Pick<ProjectPolicyConfig, 'denyRead' | 'allowRead' | 'denyWrite' | 'allowWrite' | 'denyCommands' | 'allowCommands'>> = {
    'deny-read': 'denyRead',
    'allow-read': 'allowRead',
    'deny-write': 'denyWrite',
    'allow-write': 'allowWrite',
    'deny-cmd': 'denyCommands',
    'allow-cmd': 'allowCommands',
  }
  const field = ruleMap[sub]
  if (field) {
    const rule = tokens.slice(1).filter((t) => t !== '--local').join(' ').trim()
    if (!rule) {
      stderr.write(`Usage: policy ${sub} <pattern> [--local]\n`)
      return 2
    }
    baseConfig[field] = appendUniqueRule(baseConfig[field], rule)
    const saved = await saveWorkspacePolicy(workspace, scope, baseConfig)
    if (json) stdout.write(`${JSON.stringify(saved, null, 2)}\n`)
    else stdout.write(`Added ${field} rule "${rule}" to ${scope === 'local' ? saved.localFile.path : saved.projectFile.path}.\n`)
    return 0
  }

  stderr.write(`Unknown policy subcommand "${sub}". Run "policy help" for usage.\n`)
  return 2
}

export async function handlePolicyCommand(
  runtime: CliRuntime,
  conversation: Conversation,
  arg: string,
  io: CommandIo,
): Promise<void> {
  const ws = resolvePolicyWorkspace(runtime, conversation)
  const tokens = splitCliTokens(arg)
  await executePolicyAction(runtime, ws, tokens, false, io)
}

export async function runPolicySubcommand(
  runtime: CliRuntime,
  subArgs: readonly string[],
  json: boolean,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const io = makeDefaultIo(stdout, stderr)
  return executePolicyAction(runtime, resolvePolicyWorkspace(runtime), subArgs, json, io)
}

function resolveFleetTarget(workers: FleetWorkerSnapshot[], raw: string | undefined): FleetWorkerSnapshot | null {
  const clean = (raw ?? '').trim()
  if (!clean) return null
  const num = Number(clean)
  if (Number.isInteger(num) && num >= 1 && num <= workers.length) {
    return workers[num - 1] ?? null
  }
  return (
    workers.find((w) => w.conversationId === clean || w.conversationId.startsWith(clean)) ??
    workers.find((w) => w.branch === clean || w.branch.replace(/^atrium\//, '') === clean) ??
    null
  )
}

function formatFleetUsage(): string {
  return `Usage:
  fleet list                        List isolated worktree workers & diff stats
  fleet launch <task1> [;; task2]   Create isolated worktrees and run tasks in parallel
  fleet diff <idx|id|branch>        Show changed files & unified diffs for a worker
  fleet open <idx|id|branch>        Switch active CLI session to a worktree chat (REPL)
  fleet merge <idx|id|branch> [--keep] Merge worktree branch into base branch cleanly
  fleet discard <idx|id|branch>     Stop worker and delete its worktree & branch
  fleet stop [idx|id|all]           Stop running worktree task(s)
`
}

async function executeFleetAction(
  runtime: CliRuntime,
  workspace: string | undefined,
  currentConversation: Conversation | undefined,
  tokens: readonly string[],
  opts: {
    json: boolean
    interactive: boolean
    io: CommandIo
    onSwitchChat?: (conv: Conversation) => Promise<void> | void
  },
): Promise<number> {
  const { stdout, stderr, palette, isTty } = opts.io
  const sub = tokens[0]?.toLowerCase() || 'list'

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(formatFleetUsage())
    return 0
  }

  if (sub === 'list' || sub === 'ls') {
    const workers = await runtime.fleet.list(workspace)
    if (opts.json) {
      stdout.write(`${JSON.stringify(workers, null, 2)}\n`)
      return 0
    }
    if (workers.length === 0) {
      stdout.write('No active isolated worktrees found for this workspace.\n')
      return 0
    }
    const lines = workers.map((w, idx) => {
      const badge =
        w.status === 'running'
          ? palette.accent('running')
          : w.status === 'waiting_approval'
            ? palette.yellow('approval')
            : w.status === 'error'
              ? palette.red('error')
              : palette.green('ready')
      const diffPart = `${w.changedFiles} file(s) ${palette.green(`+${w.additions}`)}/${palette.red(`-${w.deletions}`)}`
      const branchPart = `${w.branch}${w.baseBranch ? ` -> ${w.baseBranch}` : ''}`
      const previewPart = w.previewUrl ? ` · ${palette.cyan(w.previewUrl)}` : ''
      return `[${idx + 1}] ${badge}  ${palette.bold(w.title)} · ${branchPart} · ${diffPart}${previewPart}`
    })
    if (isTty) {
      const cols = (stdout as NodeJS.WriteStream).columns || 96
      stdout.write(`\n${renderFramedCard({ title: 'Parallel Worktree Fleet', badge: `${workers.length}`, lines, cols, maxWidth: 100, palette })}\n\n`)
    } else {
      stdout.write(`${lines.join('\n')}\n`)
    }
    return 0
  }

  if (sub === 'launch') {
    if (!workspace) {
      stderr.write('Select a Git workspace folder before launching worktrees.\n')
      return 1
    }
    const noWait = tokens.includes('--no-wait')
    const rawTasks = tokens.slice(1).filter((t) => t !== '--wait' && t !== '--no-wait')
    const joined = rawTasks.join(' ').trim()
    const prompts =
      rawTasks.length > 1
        ? rawTasks.map((s) => s.trim()).filter(Boolean)
        : joined
            .split(';;')
            .map((s) => s.trim())
            .filter(Boolean)

    if (prompts.length === 0) {
      stderr.write('Usage: fleet launch "<task1>" "<task2>" (or `/fleet launch task1 ;; task2` in REPL)\n')
      return 2
    }

    const res = await runtime.fleet.launch({
      baseWorkspace: workspace,
      tasks: prompts.map((prompt) => ({ prompt })),
    })

    if (!opts.interactive && !noWait && res.launched.length > 0) {
      const ids = res.launched.map((l) => l.conversationId)
      while (ids.some((id) => runtime.agent.busy(id))) {
        await new Promise((r) => setTimeout(r, 80))
      }
    }

    if (opts.json) {
      stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      return res.errors.length > 0 && res.launched.length === 0 ? 1 : 0
    }
    for (const item of res.launched) {
      stdout.write(`  ${palette.green('✓')} ${item.title} [${item.branch}] (${item.conversationId})\n`)
    }
    for (const err of res.errors) {
      stderr.write(`  ${palette.red('✗')} Task #${err.index + 1}: ${err.error}\n`)
    }
    return res.errors.length > 0 && res.launched.length === 0 ? 1 : 0
  }

  const workers = await runtime.fleet.list(workspace)

  if (sub === 'stop') {
    const rawTarget = tokens[1]
    if (!rawTarget || rawTarget.toLowerCase() === 'all') {
      const count = runtime.fleet.stopAll(workspace)
      if (opts.json) stdout.write(`${JSON.stringify({ stopped: count })}\n`)
      else stdout.write(`Stopped ${count} active worktree worker(s).\n`)
      return 0
    }
    const target = resolveFleetTarget(workers, rawTarget)
    if (!target) {
      stderr.write(`Worktree worker "${rawTarget}" not found. Run "fleet list" first.\n`)
      return 1
    }
    runtime.agent.stop(target.conversationId)
    if (opts.json) stdout.write(`${JSON.stringify({ stopped: 1, conversationId: target.conversationId })}\n`)
    else stdout.write(`Stopped worktree "${target.branch}".\n`)
    return 0
  }

  const target = resolveFleetTarget(workers, tokens[1])
  if (!target) {
    stderr.write(`Worktree worker "${tokens[1] ?? ''}" not found. Run "fleet list" first.\n`)
    return 1
  }

  if (sub === 'diff') {
    const res = await runtime.fleet.inspectDiff(target.conversationId)
    if (opts.json) {
      stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      return 0
    }
    if (res.files.length === 0) {
      stdout.write(`No changes yet in "${res.worker.branch}".\n`)
      return 0
    }
    const termCols = Math.max(48, (stdout as NodeJS.WriteStream).columns || 90)
    const diffW = Math.min(82, Math.max(40, termCols - 10))
    for (const file of res.files) {
      stdout.write(`\n${palette.bold(file.path)} [${file.status}] ${palette.green(`+${file.additions}`)}/${palette.red(`-${file.deletions}`)}\n`)
      if (file.diff.trim()) {
        stdout.write(`${formatColoredDiff(file.diff, palette, 24, diffW)}\n`)
      }
    }
    return 0
  }

  if (sub === 'open') {
    if (!opts.interactive || !opts.onSwitchChat) {
      stderr.write(`Run "atrium -r ${target.conversationId}" to resume this worktree session directly.\n`)
      return 1
    }
    const loaded = await runtime.chats.get(target.conversationId)
    if (!loaded) {
      stderr.write(`Could not load conversation "${target.conversationId}".\n`)
      return 1
    }
    await opts.onSwitchChat(loaded)
    stdout.write(`Switched to worktree "${target.branch}" (${loaded.workspace}).\n`)
    return 0
  }

  if (sub === 'merge') {
    const keep = tokens.includes('--keep')
    const merged = await runtime.fleet.merge(target.conversationId, { cleanupWorktree: !keep })
    if (currentConversation?.id === target.conversationId && opts.onSwitchChat) {
      const updated = await runtime.chats.get(target.conversationId)
      if (updated) await opts.onSwitchChat(updated)
    }
    if (opts.json) {
      stdout.write(`${JSON.stringify(merged, null, 2)}\n`)
      return 0
    }
    stdout.write(
      `Merged "${merged.branch}" -> ${merged.baseBranch || 'HEAD'}${merged.mergedCommit ? ` (${merged.mergedCommit})` : ''}${merged.cleanedUp ? ' and cleaned up worktree' : ''}.\n`,
    )
    return 0
  }

  if (sub === 'discard' || sub === 'rm' || sub === 'delete') {
    await runtime.fleet.discard(target.conversationId)
    if (currentConversation?.id === target.conversationId && opts.onSwitchChat) {
      const next = await runtime.openOrCreateChat()
      await opts.onSwitchChat(next)
    }
    if (opts.json) {
      stdout.write(`${JSON.stringify({ discarded: target.conversationId, branch: target.branch })}\n`)
      return 0
    }
    stdout.write(`Discarded worktree "${target.branch}" (${target.conversationId}).\n`)
    return 0
  }

  stderr.write(`Unknown fleet subcommand "${sub}". Run "fleet help" for usage.\n`)
  return 2
}

export async function handleFleetCommand(
  runtime: CliRuntime,
  conversation: Conversation,
  arg: string,
  io: CommandIo,
  onSwitchChat?: (conv: Conversation) => Promise<void> | void,
): Promise<void> {
  const ws = resolvePolicyWorkspace(runtime, conversation)
  const tokens = splitCliTokens(arg)
  await executeFleetAction(runtime, ws, conversation, tokens, {
    json: false,
    interactive: true,
    io,
    onSwitchChat,
  })
}

export async function runFleetSubcommand(
  runtime: CliRuntime,
  subArgs: readonly string[],
  json: boolean,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const io = makeDefaultIo(stdout, stderr)
  return executeFleetAction(runtime, resolvePolicyWorkspace(runtime), undefined, subArgs, {
    json,
    interactive: false,
    io,
  })
}

export async function handlePreviewCommand(
  runtime: CliRuntime,
  conversation: Conversation,
  arg: string,
  io: CommandIo,
): Promise<void> {
  const { stdout, stderr, palette } = io
  const tokens = splitCliTokens(arg)
  const sub = tokens[0]?.toLowerCase() || 'list'

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    stdout.write(`Usage:
  /preview list               Show managed dev servers in this workspace/session
  /preview start <command>    Start a dev server, wait for localhost URL, and show logs
  /preview logs [serverId]    Show recent stdout/stderr from a managed preview server
  /preview stop [serverId]    Stop a running preview server (defaults to all in this chat)
`)
    return
  }

  if (sub === 'list' || sub === 'ls') {
    const servers = runtime.previews.list(conversation.id)
    if (servers.length === 0) {
      stdout.write('No managed preview servers in this conversation.\n')
      return
    }
    for (const srv of servers) {
      const state = srv.status === 'running' ? palette.green(srv.status) : srv.status === 'error' ? palette.red(srv.status) : palette.muted(srv.status)
      stdout.write(`- ${srv.id} [${state}] ${srv.url ?? '(no URL)'} · ${srv.command}\n`)
    }
    return
  }

  if (sub === 'start') {
    const ws = conversation.workspace ?? runtime.workspace
    if (!ws) {
      stderr.write('No workspace folder is set.\n')
      return
    }
    const cmd = arg.trim().slice('start'.length).trim()
    if (!cmd) {
      stderr.write('Usage: /preview start <command>\n')
      return
    }
    const decision = await evaluateCommandPolicy(ws, cmd)
    if (!decision.allowed) {
      stderr.write(`${decision.reason ?? 'Blocked by project command security policy.'}\n`)
      return
    }
    const res = await runtime.previews.start({
      workspace: ws,
      command: cmd,
      conversationId: conversation.id,
    })
    stdout.write(`Preview ${res.server.id} [${res.server.status}] · URL: ${res.server.url ?? '(pending)'} · ready: ${res.ready ? 'yes' : 'no'}\n`)
    if (res.logTail.trim()) {
      stdout.write(`${palette.muted(res.logTail.trim())}\n`)
    }
    return
  }

  if (sub === 'logs') {
    const record = runtime.previews.logs({
      serverId: tokens[1],
      conversationId: conversation.id,
    })
    if (!record) {
      stdout.write('No managed preview server found for this conversation.\n')
      return
    }
    stdout.write(`Preview ${record.server.id} [${record.server.status}] ${record.server.url ?? ''}\n`)
    stdout.write(`${record.logs.trim() || '(no output yet)'}\n`)
    return
  }

  if (sub === 'stop') {
    const targetId = tokens[1]
    if (targetId && targetId.toLowerCase() !== 'all') {
      const ok = await runtime.previews.stop(targetId)
      stdout.write(ok ? `Stopped preview server ${targetId}.\n` : `Preview server "${targetId}" not found.\n`)
      return
    }
    const count = await runtime.previews.stopForConversation(conversation.id)
    stdout.write(count > 0 ? `Stopped ${count} preview server(s).\n` : 'No running preview server in this conversation.\n')
    return
  }

  stderr.write(`Unknown preview subcommand "${sub}". Type "/preview help" for usage.\n`)
}
