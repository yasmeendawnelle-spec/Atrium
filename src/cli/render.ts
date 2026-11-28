// Terminal ANSI, live Markdown streaming, star spinner, Claude-Code tool tree, line-numbered diffs, and NDJSON renderer.
import type { AgentEvent, TokenUsage, ToolCall } from '../shared/types.ts'
import { getPlanStats } from '../shared/plan.ts'
import { createMarkdownStream } from './markdown.ts'
import {
  CLI_THEMES,
  createThemePalette,
  normalizeCliTheme,
  renderThemeSwatch,
  truncateVisible,
  type CliPalette,
  type CliThemeId,
} from './theme.ts'
import { createSpinner, formatCompactTokens } from './ui.ts'

export { CLI_THEMES, normalizeCliTheme, renderThemeSwatch, type CliPalette, type CliThemeId }

export interface CliRendererOptions {
  color?: boolean
  theme?: CliThemeId
  showThinking?: boolean
  json?: boolean
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  /** Read on every spinner frame, so toggling `/ultracode` mid-session restyles the next turn. */
  ultracode?: () => boolean
}

function isStreamTty(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as NodeJS.WriteStream).isTTY)
}

export function createPalette(enabled: boolean, themeId?: CliThemeId): CliPalette {
  return createThemePalette(enabled, themeId)
}

export function formatToolDisplayName(call: ToolCall, serverName?: string): string {
  if (serverName) return `MCP(${serverName}) · ${call.name}`
  switch (call.name) {
    case 'read_file':
      return 'Read'
    case 'edit_file':
      return 'Edit'
    case 'write_file':
      return 'Write'
    case 'delete_file':
      return 'Delete'
    case 'apply_patch':
    case 'apply_prepared_patch':
      return 'Patch'
    case 'run_command':
      return 'Bash'
    case 'grep':
    case 'search_files':
    case 'ripgrep':
      return 'Search'
    case 'glob':
      return 'Glob'
    case 'list_dir':
    case 'list_files':
      return 'List'
    case 'web_search':
      return 'WebSearch'
    case 'web_fetch':
      return 'Fetch'
    case 'exit_plan_mode':
      return 'PlanHandoff'
    case 'request_plan_review':
      return 'PlanReview'
    default:
      return call.name
  }
}

export function summarizeToolInput(call: ToolCall): string {
  const inp = call.input
  const firstKey =
    (call.name === 'exit_plan_mode' &&
      ((typeof inp.summary === 'string' && inp.summary) ||
        (typeof inp.plan === 'string' &&
          inp.plan
            .split(/\r?\n/)
            .map((l) => l.replace(/^#+\s*/, '').trim())
            .find(Boolean)))) ||
    (call.name === 'request_plan_review' && typeof inp.reason === 'string' && inp.reason) ||
    (typeof inp.path === 'string' && inp.path) ||
    (typeof inp.command === 'string' && inp.command) ||
    (typeof inp.query === 'string' && inp.query) ||
    (typeof inp.url === 'string' && inp.url) ||
    (typeof inp.name === 'string' && inp.name) ||
    (typeof inp.pattern === 'string' && inp.pattern)
  if (firstKey) {
    const clean = firstKey.replace(/\s+/g, ' ').trim()
    return clean.length > 72 ? `${clean.slice(0, 69)}...` : clean
  }
  const json = JSON.stringify(inp)
  if (!json || json === '{}') return ''
  return json.length > 72 ? `${json.slice(0, 69)}...` : json
}

/** Formats unified diffs with parsed old/new line-number gutters and full-width tinted add/delete highlights. */
export function formatColoredDiff(
  diff: string,
  palette: CliPalette,
  maxLines = 40,
  maxWidth = 84,
): string {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const slice = lines.slice(0, maxLines)
  const useTint = palette.enabled && palette.themeId !== 'minimal'

  let oldLine = 0
  let newLine = 0
  let sawHunk = false
  const out: string[] = []

  const formatNums = (leftNum: number | null, rightNum: number | null, sign: string): string => {
    if (!sawHunk) return `${sign} `
    const a = leftNum !== null ? String(leftNum).padStart(4) : '    '
    const b = rightNum !== null ? String(rightNum).padStart(4) : '    '
    return `${a} ${b} ${sign} `
  }

  for (const line of slice) {
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
      out.push(palette.bold(palette.muted(line)))
      continue
    }
    const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/.exec(line)
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1] ?? 1)
      newLine = Number(hunkMatch[2] ?? 1)
      sawHunk = true
      out.push(palette.cyan(line))
      continue
    }
    if (line.startsWith('+')) {
      const gutter = formatNums(null, sawHunk ? newLine : null, '+')
      if (sawHunk) newLine += 1
      const body = line.slice(1)
      const styled = `${palette.subtle(gutter)}${palette.green(body)}`
      out.push(useTint ? palette.diffAddLine(styled, maxWidth) : palette.green(`${gutter}${body}`))
      continue
    }
    if (line.startsWith('-')) {
      const gutter = formatNums(sawHunk ? oldLine : null, null, '-')
      if (sawHunk) oldLine += 1
      const body = line.slice(1)
      const styled = `${palette.subtle(gutter)}${palette.red(body)}`
      out.push(useTint ? palette.diffDelLine(styled, maxWidth) : palette.red(`${gutter}${body}`))
      continue
    }
    const gutter = formatNums(sawHunk ? oldLine : null, sawHunk ? newLine : null, ' ')
    if (sawHunk) {
      oldLine += 1
      newLine += 1
    }
    const body = line.startsWith(' ') ? line.slice(1) : line
    out.push(`${palette.subtle(gutter)}${palette.muted(body)}`)
  }

  if (lines.length > maxLines) {
    out.push(palette.subtle(`... (${lines.length - maxLines} more lines)`))
  }
  return out.join('\n')
}

export function formatUsageLine(
  usage: TokenUsage,
  palette: CliPalette,
  durationMs?: number,
  toolCallCount?: number,
): string {
  const parts: string[] = []
  if (durationMs !== undefined && durationMs > 0) {
    parts.push(`${(durationMs / 1000).toFixed(1)}s`)
  }
  if (toolCallCount && toolCallCount > 0) {
    parts.push(`${toolCallCount} tool${toolCallCount === 1 ? '' : 's'}`)
  }
  parts.push(`in ${formatCompactTokens(usage.inputTokens)}`, `out ${formatCompactTokens(usage.outputTokens)}`)
  if (usage.cacheReadTokens) {
    const denom = usage.inputTokens + usage.cacheReadTokens
    const pct = denom > 0 ? Math.round((usage.cacheReadTokens / denom) * 100) : 0
    parts.push(`cache ${formatCompactTokens(usage.cacheReadTokens)}${pct > 0 ? ` (${pct}%)` : ''}`)
  }
  return `  ${palette.accent('✦')} ${palette.subtle(parts.join(' · '))}`
}

function isDiffOutput(text: string): boolean {
  const lines = text.split('\n', 10)
  return lines.some((l) => l.startsWith('@@') || l.startsWith('+++ ') || l.startsWith('--- '))
}

function countDiffStats(text: string): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) adds += 1
    else if (line.startsWith('-')) dels += 1
  }
  return { adds, dels }
}

function summarizeToolOutcome(
  toolName: string,
  displayName: string,
  output: string | undefined,
  palette: CliPalette,
): string {
  const trimmed = (output ?? '').replace(/\r\n/g, '\n').trim()
  if (!trimmed) return `${displayName} completed`
  if (isDiffOutput(trimmed)) {
    const { adds, dels } = countDiffStats(trimmed)
    return `Updated (${palette.green(`+${adds}`)} ${palette.red(`-${dels}`)})`
  }
  const lines = trimmed.split('\n')
  if (toolName === 'read_file') {
    return `Read ${lines.length} line${lines.length === 1 ? '' : 's'}`
  }
  if (toolName === 'write_file') {
    return `Wrote file`
  }
  if (toolName === 'grep' || toolName === 'search_files' || toolName === 'ripgrep' || toolName === 'glob' || toolName === 'list_dir' || toolName === 'list_files') {
    const count = lines.filter((l) => l.trim().length > 0).length
    const unit = toolName === 'grep' || toolName === 'search_files' ? 'match' : 'item'
    return `Found ${count} ${unit}${count === 1 ? '' : toolName === 'grep' || toolName === 'search_files' ? 'es' : 's'}`
  }
  if (toolName === 'run_command') {
    return `Ran command · ${lines.length} line${lines.length === 1 ? '' : 's'}`
  }
  return `${displayName} completed (${lines.length} line${lines.length === 1 ? '' : 's'})`
}

function formatToolPreview(
  toolName: string,
  output: string,
  palette: CliPalette,
  maxWidth: number,
): string {
  const trimmed = output.replace(/\r\n/g, '\n').trim()
  if (!trimmed) return ''
  const previewW = Math.max(36, Math.min(82, maxWidth - 8))
  if (isDiffOutput(trimmed)) {
    return formatColoredDiff(trimmed, palette, 8, previewW)
      .split('\n')
      .map((l) => `     ${l}`)
      .join('\n')
  }
  const lines = trimmed.split('\n')
  if (toolName === 'run_command' || toolName === 'grep' || toolName === 'search_files' || toolName === 'glob' || lines.length <= 4) {
    const preview = lines.slice(0, 4).map((l) => `     ${palette.muted(truncateVisible(l, previewW))}`)
    if (lines.length > 4) {
      preview.push(`     ${palette.subtle(`... (${lines.length - 4} more lines)`)}`)
    }
    return preview.join('\n')
  }
  return ''
}

export interface CliRenderer {
  readonly palette: CliPalette
  showThinking: boolean
  setShowThinking: (next: boolean) => void
  setPalette: (next: CliPalette) => void
  onEvent: (event: AgentEvent) => void
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  pauseStreamForPrompt: () => void
  dispose: () => void
}

export function createRenderer(opts: CliRendererOptions = {}): CliRenderer {
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const stdoutTty = isStreamTty(stdout)
  const stderrTty = isStreamTty(stderr)
  const useColor = opts.color !== false && !process.env.NO_COLOR && stdoutTty
  let palette = createPalette(useColor, opts.theme)
  let showThinking = Boolean(opts.showThinking)
  const jsonMode = Boolean(opts.json)

  const buildSpinner = () =>
    createSpinner({
      stream: stderr,
      palette,
      enabled: !jsonMode && stderrTty,
      ...(opts.ultracode ? { ultracode: opts.ultracode } : {}),
    })

  const buildMarkdownStream = () =>
    createMarkdownStream({
      write: (chunk) => stdout.write(chunk),
      palette,
      maxWidth: () => Math.max(48, ((stdout as NodeJS.WriteStream).columns || 96) - 4),
      indent: 2,
      firstLinePrefixWidth: 2,
    })

  let spinner = buildSpinner()
  let markdownStream = buildMarkdownStream()

  let inThinking = false
  let receivedThinking = false
  let thinkingLoggedCollapsed = false
  let thinkingStartedAt = 0
  let inText = false
  let trailingNewline = true
  let turnStartedAt = 0
  let toolCallCount = 0
  let lastUsage: TokenUsage | undefined
  const activeCalls = new Map<string, { call: ToolCall; serverName?: string }>()
  const callStartedAt = new Map<string, number>()

  const closeThinking = () => {
    if (inThinking) {
      const sec = ((Date.now() - thinkingStartedAt) / 1000).toFixed(1)
      stderr.write(`\n  ${palette.border('╰─')} ${palette.subtle(`Thought for ${sec}s`)}\n`)
      inThinking = false
    } else if (receivedThinking && !showThinking && !thinkingLoggedCollapsed && stderrTty) {
      thinkingLoggedCollapsed = true
      const sec = ((Date.now() - thinkingStartedAt) / 1000).toFixed(1)
      stderr.write(`  ${palette.subtle(`∴ Thought for ${sec}s (ctrl+o to expand)`)}\n`)
    }
  }

  const closeTextLine = () => {
    if (stdoutTty && !jsonMode) {
      markdownStream.flush()
    }
    if (inText && !trailingNewline) {
      stdout.write('\n')
      trailingNewline = true
    }
    inText = false
  }

  return {
    get palette() {
      return palette
    },
    get showThinking() {
      return showThinking
    },
    setShowThinking(next: boolean) {
      showThinking = next
    },
    setPalette(next: CliPalette) {
      spinner.stop()
      palette = next
      spinner = buildSpinner()
      markdownStream = buildMarkdownStream()
    },
    info(msg: string) {
      spinner.stop()
      if (!jsonMode) stderr.write(`${msg}\n`)
    },
    warn(msg: string) {
      spinner.stop()
      if (!jsonMode) stderr.write(`${palette.yellow(msg)}\n`)
    },
    error(msg: string) {
      spinner.stop()
      if (!jsonMode) stderr.write(`${palette.red(`Error: ${msg}`)}\n`)
    },
    pauseStreamForPrompt() {
      spinner.stop()
      closeThinking()
      closeTextLine()
    },
    dispose() {
      spinner.stop()
    },
    onEvent(event: AgentEvent) {
      if (jsonMode) {
        stdout.write(`${JSON.stringify(event)}\n`)
        return
      }

      switch (event.type) {
        case 'turn_start':
          inThinking = false
          receivedThinking = false
          thinkingLoggedCollapsed = false
          thinkingStartedAt = 0
          inText = false
          trailingNewline = true
          turnStartedAt = Date.now()
          toolCallCount = 0
          lastUsage = undefined
          activeCalls.clear()
          callStartedAt.clear()
          markdownStream.reset()
          spinner.start('Thinking...')
          break

        case 'reasoning_delta':
          if (!event.text) break
          if (!receivedThinking) {
            receivedThinking = true
            thinkingStartedAt = Date.now()
          }
          if (!showThinking) {
            spinner.update('Thinking...')
            break
          }
          spinner.stop()
          if (!inThinking) {
            closeTextLine()
            stderr.write(`\n  ${palette.border('╭─')} ${palette.purple('Thinking')}\n  ${palette.border('│')} `)
            inThinking = true
          }
          stderr.write(palette.subtle(event.text.replace(/\n/g, `\n  ${palette.border('│')} `)))
          break

        case 'text_delta':
          if (!event.text) break
          spinner.stop()
          closeThinking()
          if (!inText) {
            inText = true
            if (stdoutTty) {
              stdout.write(`\n${palette.accent('●')} `)
            }
          }
          if (stdoutTty) {
            markdownStream.push(event.text)
          } else {
            stdout.write(event.text)
          }
          trailingNewline = event.text.endsWith('\n')
          break

        case 'tool_call': {
          spinner.stop()
          closeThinking()
          closeTextLine()
          toolCallCount += 1
          activeCalls.set(event.call.id, { call: event.call, serverName: event.serverName })
          callStartedAt.set(event.call.id, Date.now())
          const displayName = formatToolDisplayName(event.call, event.serverName)
          const detail = summarizeToolInput(event.call)
          const argsText = detail ? `${palette.muted('(')}${palette.cyan(detail)}${palette.muted(')')}` : ''
          stderr.write(`\n${palette.accent('●')} ${palette.bold(displayName)}${argsText}\n`)
          spinner.start(`Running ${displayName}...`, `#${toolCallCount}`)
          break
        }

        case 'tool_status': {
          if (event.status === 'running' || event.status === 'awaiting_approval') break
          spinner.stop()
          const entry = activeCalls.get(event.toolCallId)
          const name = entry?.call.name ?? 'tool'
          const displayName = entry ? formatToolDisplayName(entry.call, entry.serverName) : 'tool'
          const t0 = callStartedAt.get(event.toolCallId)
          const elapsed = t0 ? `${((Date.now() - t0) / 1000).toFixed(2)}s` : ''
          const maxCols = Math.max(48, (stderr as NodeJS.WriteStream).columns || 96)

          if (event.status === 'done') {
            const summary = summarizeToolOutcome(name, displayName, event.output, palette)
            stderr.write(
              `  ${palette.border('⎿')}  ${palette.green('✓')} ${summary}${elapsed ? ` ${palette.subtle(`(${elapsed})`)}` : ''}\n`,
            )
            if (stdoutTty && event.output) {
              const preview = formatToolPreview(name, event.output, palette, maxCols)
              if (preview) stderr.write(`${preview}\n`)
            }
          } else if (event.status === 'denied') {
            stderr.write(`  ${palette.border('⎿')}  ${palette.yellow('✕')} ${palette.yellow(`${displayName} denied by user`)}\n`)
          } else if (event.status === 'error') {
            const firstLine = (event.output ?? 'failed').split('\n')[0]?.slice(0, 140) ?? 'failed'
            stderr.write(`  ${palette.border('⎿')}  ${palette.red('✗')} ${palette.red(`${displayName}: ${firstLine}`)}\n`)
          }
          break
        }

        case 'hook_event': {
          spinner.stop()
          closeThinking()
          closeTextLine()
          const colorFn =
            event.decision === 'block' ? palette.red : event.decision === 'warn' ? palette.yellow : palette.subtle
          stderr.write(
            `  ${palette.border('⎿')}  ${colorFn(`[hook:${event.pluginName}] ${event.event} → ${event.decision}${event.message ? `: ${event.message}` : ''}`)}\n`,
          )
          break
        }

        case 'orchestrator_phase': {
          spinner.stop()
          closeThinking()
          closeTextLine()
          const phaseLabel =
            event.phase === 'plan' ? 'Plan' : event.phase === 'execute' ? 'Execute' : 'Plan Review'
          const phaseColor =
            event.phase === 'execute' ? palette.green : event.phase === 'review' ? palette.yellow : palette.cyan
          const reviewSuffix = event.phase === 'review' ? ` #${event.handoffCount}` : ''
          const providerSuffix = event.providerName ? ` (${event.providerName})` : ''
          stderr.write(
            `  ${phaseColor('▸')} ${palette.bold(phaseColor(`${phaseLabel}${reviewSuffix}`))} ${palette.muted('·')} ${palette.cyan(event.model)}${palette.subtle(providerSuffix)}\n`,
          )
          const verb =
            event.phase === 'plan' ? 'Planning' : event.phase === 'execute' ? 'Executing' : 'Reviewing'
          spinner.start(`${verb} (${event.model})...`)
          break
        }

        case 'plan_update': {
          spinner.stop()
          closeThinking()
          closeTextLine()
          if (!event.plan || event.plan.steps.length === 0) {
            stderr.write(`  ${palette.muted('Plan cleared.')}\n`)
            break
          }
          const stats = getPlanStats(event.plan)
          const focusPart = event.plan.focus ? ` ${palette.muted('·')} ${palette.cyan(event.plan.focus)}` : ''
          stderr.write(
            `  ${palette.cyan('▸')} ${palette.bold(`Plan (${stats.done}/${stats.total})`)}${focusPart}\n`,
          )
          for (const step of event.plan.steps) {
            const glyph =
              step.status === 'done'
                ? palette.green('✓')
                : step.status === 'in_progress'
                  ? palette.cyan('●')
                  : step.status === 'failed'
                    ? palette.red('✗')
                    : step.status === 'skipped'
                      ? palette.subtle('–')
                      : palette.muted('○')
            const label = step.status === 'done' || step.status === 'skipped' ? palette.muted(step.title) : step.title
            stderr.write(`    ${glyph} ${label}\n`)
          }
          if (!stats.isAllDone) {
            spinner.start(event.plan.focus ?? stats.activeStep?.title ?? 'Working...')
          }
          break
        }

        case 'compacting':
          if (event.active) {
            spinner.stop()
            closeThinking()
            closeTextLine()
            spinner.start(`Compacting ${event.auto ? 'overflowing ' : ''}context...`)
          } else {
            spinner.stop()
          }
          break

        case 'message_saved':
          if (event.message.role === 'assistant' && event.message.usage) {
            lastUsage = event.message.usage
          }
          break

        case 'error':
          spinner.stop()
          closeThinking()
          closeTextLine()
          stderr.write(`${palette.red(`✗ Error: ${event.message}`)}\n`)
          break

        case 'turn_end': {
          spinner.stop()
          closeThinking()
          closeTextLine()
          if (event.reason === 'max_rounds') {
            stderr.write(`${palette.yellow('! Reached maximum tool call rounds for this turn.')}\n`)
          } else if (event.reason === 'truncated') {
            stderr.write(`${palette.yellow(`! Response truncated (${event.truncation ?? 'limit'}).`)}\n`)
          }
          const durationMs = turnStartedAt > 0 ? Date.now() - turnStartedAt : undefined
          if (lastUsage && stderrTty) {
            stderr.write(`${formatUsageLine(lastUsage, palette, durationMs, toolCallCount)}\n`)
          }
          break
        }

        default:
          break
      }
    },
  }
}
