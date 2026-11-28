// Built-in Atrium agent runner for Atrium Platform tasks (Commander or Worker).
import type { Message, ProviderConfig, ReasoningEffort, ToolCall } from '../../shared/types.ts'
import type { PlatformLogEntry, PlatformPermissionMode } from '../../shared/platform.ts'
import { isLocalProviderUrl } from '../../shared/orchestrator.ts'
import type { SettingsStore } from '../settings.ts'
import { newId } from '../store.ts'
import { chat, endpointFor } from '../providers/index.ts'
import type { ToolDef } from '../providers/types.ts'
import { FILE_TOOLS, prepareEdit, runReadTool, writeApproved } from '../tools/files.ts'
import { applyPreparedPatch, preparePatch } from '../tools/patch.ts'
import { SHELL_TOOL, runCommand } from '../tools/shell.ts'
import { PLATFORM_TOOL_DEFS, type PlatformBusDispatcher } from './bus.ts'

const MAX_ROUNDS = 24
const READ_ONLY_NAMES = new Set(['list_dir', 'read_file', 'search'])

export interface AtriumRunnerOptions {
  settings: SettingsStore
  onBeforeModelCall?: (provider: ProviderConfig, model: string) => Promise<void>
  taskId: string
  prompt: string
  systemPrompt: string
  cwd: string
  permissionMode: PlatformPermissionMode
  modelOverride?: string
  providerId?: string
  reasoningEffort?: ReasoningEffort
  enablePlatformTools: boolean
  busDispatcher?: PlatformBusDispatcher
  priorHistory?: Message[]
  signal: AbortSignal
  onDelta: (field: 'output' | 'thinking', delta: string) => void
  onLog: (entry: PlatformLogEntry) => void
}

export interface AtriumRunnerResult {
  output: string
  thinking: string
  history: Message[]
  model: string
  error?: string
}

function buildToolsForTask(mode: PlatformPermissionMode, enablePlatformTools: boolean): ToolDef[] {
  const baseTools =
    mode === 'plan'
      ? FILE_TOOLS.filter((t) => READ_ONLY_NAMES.has(t.name))
      : mode === 'accept_edits'
        ? FILE_TOOLS
        : [...FILE_TOOLS, SHELL_TOOL]

  const platformTools: ToolDef[] = enablePlatformTools
    ? PLATFORM_TOOL_DEFS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    : []

  return [...baseTools, ...platformTools].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

async function runWorkspaceTool(
  cwd: string,
  mode: PlatformPermissionMode,
  call: ToolCall,
  signal: AbortSignal,
): Promise<{ output: string; isError: boolean }> {
  if (READ_ONLY_NAMES.has(call.name)) {
    return runReadTool(cwd, call.name, call.input)
  }
  if (mode === 'plan') {
    return {
      output: `Tool "${call.name}" is disabled in read-only plan mode.`,
      isError: true,
    }
  }
  if (call.name === 'edit_file') {
    try {
      const prepared = await prepareEdit(cwd, call.input)
      await writeApproved(cwd, prepared.path, prepared.nextContent)
      return { output: `Updated ${prepared.path} (${prepared.replacements} replacement(s)).`, isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
  if (call.name === 'write_file') {
    try {
      const path = typeof call.input.path === 'string' ? call.input.path : ''
      const content = typeof call.input.content === 'string' ? call.input.content : ''
      if (!path) return { output: 'File path is required.', isError: true }
      await writeApproved(cwd, path, content)
      return { output: `Wrote ${path}.`, isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
  if (call.name === 'apply_patch') {
    try {
      const prepared = await preparePatch(cwd, call.input)
      await applyPreparedPatch(prepared)
      return { output: prepared.summary, isError: false }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  }
  if (call.name === 'run_command') {
    if (mode !== 'full_auto') {
      return {
        output: 'run_command requires full_auto permission mode for this Platform agent.',
        isError: true,
      }
    }
    const command = typeof call.input.command === 'string' ? call.input.command : ''
    if (!command.trim()) return { output: 'Command is required.', isError: true }
    const timeoutSec = typeof call.input.timeoutSeconds === 'number' ? call.input.timeoutSeconds : 120
    const res = await runCommand(cwd, command, timeoutSec, signal)
    return { output: res.output, isError: res.isError }
  }
  return { output: `Unsupported tool "${call.name}".`, isError: true }
}

export function resolveAtriumProviderAndModel(
  settings: SettingsStore,
  modelOverride?: string,
  providerIdOverride?: string,
): { provider: ProviderConfig; model: string } {
  const providers = settings.listProviders()
  const active = settings.activeProvider()
  const cleanModel = modelOverride?.trim() || ''
  const cleanProviderId = providerIdOverride?.trim() || ''

  if (cleanProviderId) {
    const explicit = providers.find((item) => item.id === cleanProviderId)
    if (explicit) {
      return { provider: explicit, model: cleanModel || explicit.model }
    }
  }

  if (cleanModel) {
    if (active && (active.model === cleanModel || active.models?.includes(cleanModel))) {
      return { provider: active, model: cleanModel }
    }
    const usableMatch = providers.find(
      (p) => (p.hasKey || isLocalProviderUrl(p.baseUrl)) && (p.model === cleanModel || p.models?.includes(cleanModel)),
    )
    if (usableMatch) {
      return { provider: usableMatch, model: cleanModel }
    }
    const anyMatch = providers.find((p) => p.model === cleanModel || p.models?.includes(cleanModel))
    if (anyMatch) {
      return { provider: anyMatch, model: cleanModel }
    }
    if (active) {
      return { provider: active, model: cleanModel }
    }
  }

  if (!active) {
    throw new Error('No active Atrium model provider is configured. Add or select one in Settings > Models.')
  }
  return { provider: active, model: active.model }
}

export async function runAtriumPlatformAgent(opts: AtriumRunnerOptions): Promise<AtriumRunnerResult> {
  const { provider, model } = resolveAtriumProviderAndModel(opts.settings, opts.modelOverride, opts.providerId)
  const apiKey = await opts.settings.providerKey(provider.id)
  const endpoint = endpointFor(provider, apiKey)
  const tools = buildToolsForTask(opts.permissionMode, opts.enablePlatformTools && Boolean(opts.busDispatcher))

  const messages: Message[] = [...(opts.priorHistory ?? []), { role: 'user', text: opts.prompt }]
  let fullOutput = ''
  let fullThinking = ''

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal.aborted) {
      return {
        output: fullOutput.trim(),
        thinking: fullThinking.trim(),
        history: messages,
        model,
        error: 'Cancelled by user.',
      }
    }

    if (opts.onBeforeModelCall) {
      await opts.onBeforeModelCall(provider, model)
    }

    let roundText = ''
    let roundThinking = ''
    const result = await chat(
      provider.protocol,
      endpoint,
      {
        model,
        system: opts.systemPrompt,
        messages,
        tools,
        effort: opts.reasoningEffort ?? opts.settings.get().reasoningEffort,
        signal: opts.signal,
      },
      {
        onText: (delta) => {
          roundText += delta
          fullOutput += delta
          opts.onDelta('output', delta)
        },
        onReasoning: (delta) => {
          roundThinking += delta
          fullThinking += delta
          opts.onDelta('thinking', delta)
        },
      },
    )

    if (roundThinking.trim()) {
      opts.onLog({
        id: newId('plog'),
        ts: Date.now(),
        kind: 'thinking',
        content: roundThinking.trim(),
      })
    }

    if (result.toolCalls.length === 0) {
      const assistantMsg: Message = { role: 'assistant', text: result.text || roundText, toolCalls: [] }
      messages.push(assistantMsg)
      if ((result.text || roundText).trim()) {
        opts.onLog({
          id: newId('plog'),
          ts: Date.now(),
          kind: 'text',
          content: (result.text || roundText).trim(),
        })
      }
      return {
        output: fullOutput.trim() || result.text.trim(),
        thinking: fullThinking.trim(),
        history: messages,
        model,
      }
    }

    const assistantMsg: Message = {
      role: 'assistant',
      text: result.text || roundText,
      toolCalls: result.toolCalls,
      ...(result.thinking ? { thinking: result.thinking } : {}),
      ...(result.reasoningItems ? { reasoningItems: result.reasoningItems } : {}),
    }
    messages.push(assistantMsg)

    for (const tc of result.toolCalls) {
      opts.onLog({
        id: newId('plog'),
        ts: Date.now(),
        kind: 'tool_call',
        title: tc.name,
        content: JSON.stringify(tc.input ?? {}, null, 2),
      })

      let outText: string
      let isError = false

      if (tc.name.startsWith('platform_') && opts.busDispatcher) {
        try {
          const res = await opts.busDispatcher(tc.name, tc.input ?? {}, { callerTaskId: opts.taskId })
          outText = JSON.stringify(res, null, 2)
        } catch (err) {
          outText = err instanceof Error ? err.message : String(err)
          isError = true
        }
      } else {
        const res = await runWorkspaceTool(opts.cwd, opts.permissionMode, tc, opts.signal)
        outText = res.output
        isError = res.isError
      }

      opts.onLog({
        id: newId('plog'),
        ts: Date.now(),
        kind: 'tool_result',
        title: tc.name,
        content: outText.slice(0, 4000),
      })

      messages.push({
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        output: outText,
        isError,
      })
    }
  }

  return {
    output: fullOutput.trim(),
    thinking: fullThinking.trim(),
    history: messages,
    model,
    error: `Reached max tool rounds (${MAX_ROUNDS}).`,
  }
}
