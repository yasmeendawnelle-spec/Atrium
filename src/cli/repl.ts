// Interactive terminal login flow, welcome dashboard, live composer REPL, and slash commands.
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { listWorkspaceFiles } from '../core/tools/files.ts'
import { getGitRepoStatus } from '../core/tools/git.ts'
import type {
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  CliThemeId,
  Conversation,
  WorkScene,
} from '../shared/types.ts'
import {
  AGENT_MODES,
  CLI_THEME_IDS,
  CONTEXT_WINDOW_PRESETS,
  normalizeContextWindowTokens,
  resolveEffectiveContextLimit,
} from '../shared/types.ts'
import type { ParsedCliArgs } from './args.ts'
import {
  buildInitPrompt,
  detectEnvProviderCandidates,
  detectInstructionFiles,
  estimateConversationTokens,
  expandFileMentions,
  exportConversationMarkdown,
  handleAccountCommand,
  handleCommitCommand,
  handleConfigCommand,
  handleEffortCommand,
  handleGitCommand,
  handleMcpCommand,
  handleMemoryCommand,
  handlePermissionsCommand,
  handlePluginCommand,
  handleProviderCommand,
  handleSkillsCommand,
  handleUsageCommand,
  resolveExistingDirectory,
  runAddProviderFlow,
  runDoctorCheck,
  runInlineShellCommand,
  type AskFn,
  type CommandIo,
} from './commands.ts'
import {
  readComposerInput,
  renderSubmittedPromptBlock,
  renderWorkingDockLines,
  type ComposerCommandItem,
} from './composer.ts'
import {
  CLI_THEMES,
  createPalette,
  formatColoredDiff,
  normalizeCliTheme,
  renderThemeSwatch,
  type CliPalette,
  type CliRenderer,
} from './render.ts'
import type { CliRuntime } from './runtime.ts'
import { selectOption, type SelectOption } from './select.ts'
import { renderFramedCard, renderHelpCard, renderWelcomeScreen, setTerminalTitle } from './ui.ts'
import type { TerminalViewport } from './viewport.ts'

export { runAddProviderFlow }

export interface LoginIo {
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  palette?: CliPalette
  ask?: AskFn
}

export interface ReplOptions {
  conversation: Conversation
  version: string
  autoApprove?: boolean
  viewport?: TerminalViewport
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
}

const SLASH_COMMANDS: readonly ComposerCommandItem[] = [
  { cmd: '/help', hint: 'Show categorized command & shortcut reference' },
  { cmd: '/theme', hint: 'Switch CLI color theme (warm-studio/claude/codex/agy/minimal)' },
  { cmd: '/model', hint: 'Select active model' },
  { cmd: '/provider', hint: 'Switch, add preset/env BYOK, test, or sync providers' },
  { cmd: '/effort', hint: 'Adjust reasoning effort level' },
  { cmd: '/mode', hint: 'Switch permission mode (auto/accept_edits/plan/manual/bypass)' },
  { cmd: '/scene', hint: 'Switch work scene (code/work)' },
  { cmd: '/context', hint: 'Configure context window size' },
  { cmd: '/config', hint: 'Open interactive settings menu' },
  { cmd: '/usage', hint: 'Inspect context meter and spend breakdown' },
  { cmd: '/status', hint: 'Inspect active workspace, model, and MCP summary' },
  { cmd: '/doctor', hint: 'Run CLI installation, Git, instructions, and MCP check' },
  { cmd: '/init', hint: 'Analyze repository and generate/update AGENTS.md' },
  { cmd: '/login', hint: 'Sign in to Atrium Account' },
  { cmd: '/logout', hint: 'Sign out of Atrium Account' },
  { cmd: '/account', hint: 'View Atrium balance, subscription, or sync models' },
  { cmd: '/mcp', hint: 'Manage and test MCP servers' },
  { cmd: '/plugin', hint: 'Manage, discover, and import plugins' },
  { cmd: '/skills', hint: 'Browse and toggle skills' },
  { cmd: '/memory', hint: 'View, add, search, or remove memories' },
  { cmd: '/git', hint: 'Inspect Git status or switch/create branches' },
  { cmd: '/commit', hint: 'Stage and commit workspace changes' },
  { cmd: '/diff', hint: 'Inspect uncommitted & checkpointed file diffs' },
  { cmd: '/undo', hint: 'Revert last user turn and checkpointed file edits' },
  { cmd: '/rewind', hint: 'Alias for /undo — rewind last user turn & file edits' },
  { cmd: '/new', hint: 'Start a fresh conversation' },
  { cmd: '/resume', hint: 'Switch to a saved conversation' },
  { cmd: '/retry', hint: 'Regenerate last assistant reply' },
  { cmd: '/fork', hint: 'Fork conversation into a new branch' },
  { cmd: '/rename', hint: 'Rename active conversation' },
  { cmd: '/compact', hint: 'Summarize earlier conversation context' },
  { cmd: '/export', hint: 'Export conversation transcript to Markdown' },
  { cmd: '/cwd', hint: 'Change active workspace directory' },
  { cmd: '/permissions', hint: 'Inspect or clear workspace allow rules' },
  { cmd: '/thinking', hint: 'Toggle streaming reasoning display (or Ctrl+O)' },
  { cmd: '/clear', hint: 'Clear terminal and redraw welcome dashboard (or Ctrl+L)' },
  { cmd: '/exit', hint: 'Exit Atrium CLI' },
]

const MODE_CYCLE: readonly AgentMode[] = ['auto', 'accept_edits', 'plan', 'manual', 'bypass']

function sanitizeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/https?:\/\/(?:[\w.-]+\.)?rpulse\.top/gi, 'Atrium Cloud')
    .replace(/\brpulse\.top\b/gi, 'Atrium Cloud')
    .replace(/RelayPulse/gi, 'Atrium Cloud')
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  return `${Math.round(tokens / 1_000)}k`
}

function formatDisplayPath(targetPath: string | undefined): string {
  if (!targetPath) return '(none)'
  const home = homedir()
  if (targetPath === home) return '~'
  const sepPrefix = home.endsWith('/') || home.endsWith('\\') ? home : `${home}/`
  const winSepPrefix = `${home}\\`
  if (targetPath.startsWith(sepPrefix)) return `~/${targetPath.slice(sepPrefix.length)}`
  if (targetPath.startsWith(winSepPrefix)) return `~\\${targetPath.slice(winSepPrefix.length)}`
  return targetPath
}

function isUnifiedDiff(text: string): boolean {
  const lines = text.split('\n', 10)
  return lines.some((l) => l.startsWith('@@') || l.startsWith('+++ ') || l.startsWith('--- '))
}

async function promptSecretTty(
  question: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  output.write(question)
  const wasRaw = Boolean(input.isRaw)
  input.setRawMode(true)
  input.resume()

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      input.removeListener('data', onData)
      if (!wasRaw) {
        try {
          input.setRawMode(false)
        } catch {
          // Ignore restore errors on closed streams
        }
      }
      input.pause()
    }

    const onData = (chunk: Buffer) => {
      const str = chunk.toString('utf8')
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') {
          output.write('\n')
          cleanup()
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          output.write('\n')
          cleanup()
          reject(new Error('Cancelled by user.'))
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          continue
        }
        if (ch === '\u0015') {
          while (value.length > 0) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          continue
        }
        if (ch >= ' ') {
          value += ch
          output.write('*')
        }
      }
    }

    input.on('data', onData)
  })
}

async function askOnce(
  question: string,
  opts: {
    secret?: boolean
    stdin: NodeJS.ReadableStream
    stdout: NodeJS.WritableStream
  },
): Promise<string> {
  const input = opts.stdin as NodeJS.ReadStream
  const output = opts.stdout
  if (opts.secret && input.isTTY && typeof input.setRawMode === 'function') {
    return promptSecretTty(question, input, output)
  }

  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY),
  })
  const onSigint = () => rl.close()
  rl.on('SIGINT', onSigint)
  try {
    return await rl.question(question)
  } finally {
    rl.off('SIGINT', onSigint)
    rl.close()
  }
}

async function completeOAuthFlow(
  runtime: CliRuntime,
  provider: 'google' | 'github',
  args: ParsedCliArgs,
  ask: AskFn,
  stderr: NodeJS.WritableStream,
): Promise<void> {
  stderr.write(`Starting ${provider === 'google' ? 'Google' : 'GitHub'} sign-in in your browser...\n`)
  const result = await runtime.account.oauthStart(provider)
  if (result.status === 'signed_in') return

  stderr.write(
    `Your ${provider === 'google' ? 'Google' : 'GitHub'} account${result.username ? ` (${result.username})` : ''} needs a verified email to finish setup.\n`,
  )
  const email = args.email?.trim() || (await ask('Email address: ')).trim()
  if (!email) throw new Error('Email address is required.')

  let code = args.code?.trim()
  if (!code) {
    const sent = await runtime.account.sendCode(email)
    stderr.write(`${sent.message}\n`)
    code = (await ask('Verification code: ')).trim()
  }
  if (!code) throw new Error('Verification code is required.')

  await runtime.account.oauthBindEmail({
    pendingToken: result.pendingToken,
    email,
    code,
  })
}

/** Runs interactive or flag-driven Atrium Cloud account login across Windows/macOS/Linux. */
export async function runLoginFlow(
  runtime: CliRuntime,
  args: ParsedCliArgs,
  io: LoginIo = {},
): Promise<boolean> {
  const input = io.stdin ?? defaultStdin
  const stdout = io.stdout ?? defaultStdout
  const stderr = io.stderr ?? defaultStderr
  const palette =
    io.palette ?? createPalette(!process.env.NO_COLOR && Boolean((stdout as NodeJS.WriteStream).isTTY))
  const ask: AskFn =
    io.ask ?? ((question, askOpts) => askOnce(question, { ...askOpts, stdin: input, stdout }))

  try {
    if (args.google || args.github) {
      const provider = args.google ? 'google' : 'github'
      await completeOAuthFlow(runtime, provider, args, ask, stderr)
    } else if (args.email && (args.password || args.code)) {
      await runtime.account.loginEmail({
        email: args.email.trim(),
        ...(args.password ? { password: args.password } : { code: args.code?.trim() }),
      })
    } else {
      let method: 'password' | 'code' | 'google' | 'github' | null
      if (!args.email) {
        stdout.write('\n')
        method = await selectOption<'password' | 'code' | 'google' | 'github'>({
          title: 'Choose Atrium sign-in method',
          options: [
            { value: 'password', label: 'Email & Password', hint: 'Sign in with existing password' },
            { value: 'code', label: 'Email Verification Code', hint: 'One-time 6-digit code' },
            { value: 'google', label: 'Google OAuth', hint: 'Open browser window' },
            { value: 'github', label: 'GitHub OAuth', hint: 'Open browser window' },
          ],
          palette,
          stdin: input,
          stdout,
        })
      } else {
        stdout.write('\n')
        method = await selectOption<'password' | 'code'>({
          title: `Sign in as ${args.email}`,
          options: [
            { value: 'password', label: 'Password' },
            { value: 'code', label: 'Email Verification Code' },
          ],
          palette,
          stdin: input,
          stdout,
        })
      }

      if (!method) return false

      if (method === 'google' || method === 'github') {
        await completeOAuthFlow(runtime, method, args, ask, stderr)
      } else {
        const email = args.email?.trim() || (await ask('Email address: ')).trim()
        if (!email) throw new Error('Email address is required.')
        if (method === 'code') {
          const sent = await runtime.account.sendCode(email)
          stderr.write(`${sent.message}\n`)
          const code = (await ask('Verification code: ')).trim()
          if (!code) throw new Error('Verification code is required.')
          await runtime.account.loginEmail({ email, code })
        } else {
          const password = await ask('Password: ', { secret: true })
          if (!password) throw new Error('Password is required.')
          await runtime.account.loginEmail({ email, password })
        }
      }
    }

    const st = runtime.account.getState()
    const modelCount = st.availableModels?.length ?? runtime.settings.activeProvider()?.models?.length ?? 0
    stdout.write(`Signed in as ${st.displayName || st.email || 'Atrium user'} (${modelCount} models available).\n`)
    return true
  } catch (err) {
    throw new Error(sanitizeMessage(err))
  }
}

function parseContextLimitInput(raw: string): number {
  const lower = raw.trim().toLowerCase()
  if (lower === 'auto' || lower === '0') return 0
  const mMatch = /^(\d+(?:\.\d+)?)\s*m$/.exec(lower)
  if (mMatch) return normalizeContextWindowTokens(Math.round(Number(mMatch[1]) * 1_000_000))
  const kMatch = /^(\d+(?:\.\d+)?)\s*k$/.exec(lower)
  if (kMatch) return normalizeContextWindowTokens(Math.round(Number(kMatch[1]) * 1_000))
  const numeric = Number(lower)
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`Invalid context size "${raw}". Expected "auto" or token count like "128k" / "200000".`)
  }
  return normalizeContextWindowTokens(numeric)
}

function formatApprovalPreview(req: ApprovalRequest, renderer: CliRenderer, cols = 90): string {
  const palette = renderer.palette
  const termCols = Math.max(44, cols)
  const detailWidth = Math.min(82, Math.max(40, termCols - 10))
  const cardLines: string[] = [
    `${palette.bold(req.summary)}`,
  ]
  if (req.serverName) cardLines.push(`${palette.muted('MCP server:')}  ${palette.cyan(req.serverName)}`)
  if (req.alwaysRuleLabel) cardLines.push(`${palette.muted('Always rule:')} ${palette.subtle(req.alwaysRuleLabel)}`)

  if (req.detail?.trim()) {
    cardLines.push('---')
    if (isUnifiedDiff(req.detail)) {
      cardLines.push(...formatColoredDiff(req.detail, palette, 28, detailWidth).split('\n'))
    } else {
      const detailLines = req.detail.replace(/\r\n/g, '\n').split('\n')
      for (const dl of detailLines.slice(0, 14)) {
        cardLines.push(palette.muted(dl))
      }
      if (detailLines.length > 14) {
        cardLines.push(palette.subtle(`... (${detailLines.length - 14} more lines)`))
      }
    }
  }

  const borderColor =
    req.kind === 'shell' || req.toolName.includes('delete')
      ? palette.yellow
      : req.kind === 'mcp'
        ? palette.cyan
        : palette.accent

  const card = renderFramedCard({
    title: `Approval Required · ${req.kind}`,
    badge: req.toolName,
    lines: cardLines,
    cols: termCols,
    maxWidth: 94,
    palette,
    borderColor,
  })
  return `\n${card}`
}

const MODE_HINTS: Record<AgentMode, string> = {
  auto: 'Run safe edits & reads automatically; prompt on risky shell commands',
  manual: 'Ask approval before every file edit, shell command, or MCP write',
  accept_edits: 'Auto-approve file edits; ask before running shell commands',
  plan: 'Read-only analysis & planning mode (blocks all mutating tools)',
  bypass: 'Auto-approve all tool calls without confirmation prompts',
}

/** Starts the interactive Atrium terminal REPL session. */
export async function runInteractiveRepl(
  runtime: CliRuntime,
  renderer: CliRenderer,
  opts: ReplOptions,
): Promise<void> {
  const input = (opts.stdin ?? defaultStdin) as NodeJS.ReadStream
  const rawStdout = opts.stdout ?? defaultStdout
  const rawStderr = opts.stderr ?? defaultStderr
  const viewport = opts.viewport
  const useViewport = Boolean(viewport?.enabled)
  const stdout = useViewport && viewport ? viewport.transcriptStream : rawStdout
  const stderr = useViewport && viewport ? viewport.transcriptStream : rawStderr
  const isTty = Boolean(input.isTTY)

  let conversation = opts.conversation
  let turnActive = false
  const history: string[] = []
  let cachedWorkspaceFiles: string[] = []
  let cachedGitBranch: string | undefined
  let cachedGitDirty = 0

  const commandIo: CommandIo = {
    stdin: input,
    stdout,
    stderr,
    get palette() {
      return renderer.palette
    },
    isTty,
  }

  const refreshWorkspaceMeta = async () => {
    const ws = conversation.workspace ?? runtime.workspace
    if (!ws) {
      cachedGitBranch = undefined
      cachedGitDirty = 0
      cachedWorkspaceFiles = []
      return
    }
    const [gitSt, files] = await Promise.all([
      getGitRepoStatus(ws).catch(() => null),
      listWorkspaceFiles(ws, 400).catch(() => []),
    ])
    cachedGitBranch = gitSt?.isRepo ? gitSt.branch : undefined
    cachedGitDirty = gitSt?.isRepo ? gitSt.dirtyCount : 0
    cachedWorkspaceFiles = files
  }

  const updateWindowTitle = (busy: boolean) => {
    const ws = conversation.workspace ?? runtime.workspace
    const folder = ws ? basename(ws) || ws : 'Atrium'
    setTerminalTitle(rawStdout, busy ? `✳ Atrium (${folder}) · Working...` : `✳ Atrium (${folder})`)
  }

  const askWithPrompt: AskFn = (question, askOpts) =>
    askOnce(question, {
      ...askOpts,
      stdin: input,
      stdout,
    })

  const syncConversationProvider = async (providerId: string): Promise<void> => {
    const meta = await runtime.chats.setProvider(conversation.id, providerId)
    conversation = {
      ...conversation,
      providerId: meta.providerId,
      updatedAt: meta.updatedAt,
    }
  }

  let approvalQueue: Promise<ApprovalDecision> = Promise.resolve('deny')
  if (!opts.autoApprove) {
    runtime.setApprovalHandler((req) => {
      const next = approvalQueue
        .catch(() => 'deny' as ApprovalDecision)
        .then(async (): Promise<ApprovalDecision> => {
          renderer.pauseStreamForPrompt()
          const termCols = (stdout as NodeJS.WriteStream).columns || 90
          stdout.write(`${formatApprovalPreview(req, renderer, termCols)}\n\n`)
          const decision = await selectOption<ApprovalDecision>({
            title: 'Allow this action?',
            options: [
              { value: 'allow', label: 'Allow once', shortcut: 'y', hint: 'Permit this single call' },
              {
                value: 'allow_session',
                label: 'Allow for this session',
                shortcut: 's',
                hint: 'Same workspace & tool kind',
              },
              {
                value: 'allow_always',
                label: 'Allow always',
                shortcut: 'a',
                hint: req.alwaysRuleLabel || 'Persist workspace allow rule',
              },
              { value: 'deny', label: 'Deny', shortcut: 'n', hint: 'Decline and tell the model' },
            ],
            viewport,
            palette: renderer.palette,
            stdin: input,
            stdout,
          })
          if (useViewport && viewport) {
            const st = runtime.settings.get()
            const cols = (rawStdout as NodeJS.WriteStream).columns || 80
            viewport.renderDock(
              renderWorkingDockLines(
                { mode: st.agentMode ?? 'auto', effort: st.reasoningEffort ?? 'auto' },
                renderer.palette,
                cols,
              ),
              null,
            )
          }
          return decision ?? 'deny'
        })
      approvalQueue = next
      return next
    })
  }

  const onProcessSigint = () => {
    if (turnActive && runtime.agent.busy(conversation.id)) {
      runtime.agent.stop(conversation.id)
      stderr.write(`\n${renderer.palette.yellow('Interrupted current turn.')}\n`)
    }
  }

  process.on('SIGINT', onProcessSigint)

  const printBanner = async () => {
    await refreshWorkspaceMeta()
    const palette = renderer.palette
    const ws = conversation.workspace ?? runtime.workspace
    const [skills, instructionFiles] = await Promise.all([
      runtime.listSkills().catch(() => []),
      detectInstructionFiles(ws).catch(() => []),
    ])
    const settings = runtime.settings.get()
    const provider = runtime.settings.activeProvider()
    const acc = runtime.account.getState()
    const mcpStatuses = runtime.mcp.statuses()
    const mcpConnected = mcpStatuses.filter((m) => m.state === 'connected').length
    const pluginCount = runtime.plugins.list().filter((p) => p.enabled).length
    const limit = resolveEffectiveContextLimit(provider?.model, settings.contextWindowTokens)
    const used = estimateConversationTokens(conversation)
    const who = acc.connected ? acc.email || acc.displayName || 'Atrium Cloud' : provider ? 'BYOK / Local' : 'Not configured'
    const rawUser = acc.connected ? (acc.displayName || acc.email || '') : ''
    const userName = rawUser.includes('@') ? rawUser.split('@')[0]?.trim() : rawUser.trim()

    const recentCandidates = runtime.chats
      .list()
      .filter((m) => !(m.id === conversation.id && conversation.messages.length === 0))
    recentCandidates.sort((a, b) => {
      const aSame = ws && a.workspace === ws ? 1 : 0
      const bSame = ws && b.workspace === ws ? 1 : 0
      if (aSame !== bSame) return bSame - aSame
      return b.updatedAt - a.updatedAt
    })
    const recentSessions = recentCandidates.slice(0, 3).map((m) => ({
      title: m.title || 'Untitled session',
      updatedAt: m.updatedAt,
      messageCount: m.messageCount,
    }))

    updateWindowTitle(false)
    stdout.write(
      renderWelcomeScreen({
        version: opts.version,
        model: provider?.model,
        providerName: provider?.name,
        protocol: provider?.protocol,
        mode: settings.agentMode ?? 'auto',
        scene: settings.workScene ?? 'code',
        effort: settings.reasoningEffort ?? 'auto',
        workspace: formatDisplayPath(ws),
        accountLabel: who,
        ...(userName ? { userName } : {}),
        mcpConnected,
        mcpTotal: mcpStatuses.length,
        skillCount: skills.filter((s) => s.enabled).length,
        pluginCount,
        instructionFiles,
        recentSessions,
        themeName: CLI_THEMES[palette.themeId].name,
        gitBranch: cachedGitBranch,
        gitDirty: cachedGitDirty,
        contextUsed: used,
        contextLimit: limit,
        cols: (stdout as NodeJS.WriteStream).columns || 80,
        palette,
      }),
    )
  }

  const runPromptTurn = async (promptText: string) => {
    runtime.assertReady()
    const expandedPrompt = await expandFileMentions(
      promptText,
      conversation.workspace ?? runtime.workspace,
      stdout,
      renderer.palette,
    )
    if (useViewport && viewport) {
      const st = runtime.settings.get()
      const cols = (rawStdout as NodeJS.WriteStream).columns || 80
      viewport.renderDock(
        renderWorkingDockLines(
          { mode: st.agentMode ?? 'auto', effort: st.reasoningEffort ?? 'auto', status: 'Thinking...' },
          renderer.palette,
          cols,
        ),
        null,
      )
    }
    turnActive = true
    updateWindowTitle(true)
    try {
      const outcome = await runtime.runTurn(conversation, expandedPrompt)
      const latest = await runtime.chats.get(conversation.id)
      if (latest) conversation = latest
      if (outcome.reason === 'error' && outcome.errorMessage) {
        stderr.write('\n')
      }
    } finally {
      turnActive = false
      updateWindowTitle(false)
      await refreshWorkspaceMeta()
    }
  }

  const handleSlashCommand = async (rawLine: string): Promise<'continue' | 'exit'> => {
    const palette = renderer.palette
    const trimmed = rawLine.trim()
    const spaceIdx = trimmed.indexOf(' ')
    const cmd = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase()
    const arg = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : ''

    switch (cmd) {
      case '/help':
      case '/h':
        stdout.write(`\n${renderHelpCard(palette, (stdout as NodeJS.WriteStream).columns)}\n\n`)
        return 'continue'

      case '/theme': {
        const cur = normalizeCliTheme(runtime.settings.get().cliTheme)
        let nextTheme: CliThemeId | null = null
        if (!arg) {
          if (!isTty) {
            for (const id of CLI_THEME_IDS) {
              const mark = id === cur ? palette.green('✓') : ' '
              stdout.write(`  ${mark} ${palette.bold(id.padEnd(12))} ${CLI_THEMES[id].description}\n`)
            }
            return 'continue'
          }
          nextTheme = await selectOption<CliThemeId>({
            title: 'CLI Color Theme',
            subtitle: `current: ${cur}`,
            searchable: true,
            options: CLI_THEME_IDS.map((id) => ({
              value: id,
              label: `${renderThemeSwatch(id, palette.enabled)}  ${CLI_THEMES[id].name} (${id})`,
              hint: CLI_THEMES[id].description,
            })),
            initialIndex: Math.max(0, CLI_THEME_IDS.indexOf(cur)),
            viewport,
            palette,
            stdin: input,
            stdout,
          })
          if (!nextTheme) return 'continue'
        } else {
          const candidate = arg.trim().toLowerCase()
          if (!(CLI_THEME_IDS as readonly string[]).includes(candidate)) {
            stdout.write(
              `Unknown theme "${arg}". Available themes: ${CLI_THEME_IDS.join(', ')}.\n`,
            )
            return 'continue'
          }
          nextTheme = candidate as CliThemeId
        }
        await runtime.settings.update({ cliTheme: nextTheme })
        const updatedPalette = createPalette(palette.enabled, nextTheme)
        renderer.setPalette(updatedPalette)
        if (isTty) {
          if (useViewport && viewport) {
            viewport.clearScreen()
          }
          await printBanner()
        }
        stdout.write(
          `  ${updatedPalette.green('✓')} Theme switched to ${updatedPalette.bold(CLI_THEMES[nextTheme].name)} (${nextTheme}).\n`,
        )
        return 'continue'
      }

      case '/exit':
      case '/quit':
      case '/q':
        return 'exit'

      case '/clear':
        if (useViewport && viewport) {
          viewport.clearScreen()
        } else {
          stdout.write('\x1b[2J\x1b[0f')
        }
        await printBanner()
        return 'continue'

      case '/doctor':
        await runDoctorCheck(runtime, opts.version, stdout, false, palette)
        return 'continue'

      case '/init': {
        const initPrompt = await buildInitPrompt(conversation.workspace ?? runtime.workspace)
        await runPromptTurn(initPrompt)
        return 'continue'
      }

      case '/login': {
        const parsedArg = arg.toLowerCase()
        const loginArgs: ParsedCliArgs = {
          command: 'login',
          subArgs: [],
          printMode: false,
          continueWorkspace: false,
          forkSession: false,
          outputFormat: 'text',
          noPersistence: false,
          yes: false,
          thinking: false,
          json: false,
          color: palette.enabled,
          help: false,
          version: false,
          google: parsedArg === 'google',
          github: parsedArg === 'github',
          ...(parsedArg.includes('@') ? { email: arg } : {}),
        }
        const ok = await runLoginFlow(runtime, loginArgs, {
          stdin: input,
          stdout,
          stderr,
          palette,
          ask: askWithPrompt,
        })
        if (ok) {
          const active = runtime.settings.activeProvider()
          if (active && conversation.providerId !== active.id) {
            await syncConversationProvider(active.id)
          }
        }
        return 'continue'
      }

      case '/logout': {
        await runtime.account.logout()
        stdout.write('Signed out of Atrium account.\n')
        return 'continue'
      }

      case '/account':
        await handleAccountCommand(runtime, arg, commandIo)
        return 'continue'

      case '/status': {
        const settings = runtime.settings.get()
        const provider = runtime.settings.activeProvider()
        const acc = runtime.account.getState()
        const limit = resolveEffectiveContextLimit(provider?.model, settings.contextWindowTokens)
        const mcpStatuses = runtime.mcp.statuses()
        const connectedMcp = mcpStatuses.filter((m) => m.state === 'connected').length
        if (isTty) {
          const card = renderFramedCard({
            title: 'Atrium Session Status',
            badge: `v${opts.version}`,
            cols: (stdout as NodeJS.WriteStream).columns,
            palette,
            lines: [
              `${palette.muted('Account:')}   ${acc.connected ? palette.green(acc.email ?? acc.displayName ?? 'connected') : palette.subtle('not signed in')}`,
              `${palette.muted('Provider:')}  ${provider ? `${palette.bold(provider.name)} [${provider.protocol}]` : palette.yellow('none')}`,
              `${palette.muted('Model:')}     ${provider ? palette.cyan(provider.model) : palette.yellow('none')} (context: ${formatTokenCount(limit)}${settings.contextWindowTokens ? ' custom' : ' auto'})`,
              `${palette.muted('Profile:')}   ${settings.agentMode ?? 'auto'} · ${settings.workScene ?? 'code'} · effort:${settings.reasoningEffort ?? 'auto'} · theme:${palette.themeId}`,
              `${palette.muted('Workspace:')} ${conversation.workspace ?? runtime.workspace ?? '(none)'}`,
              `${palette.muted('MCP:')}       ${connectedMcp}/${mcpStatuses.length} connected`,
              `${palette.muted('Chat:')}      ${conversation.id} (${conversation.messages.length} messages)`,
            ],
          })
          stdout.write(`\n${card}\n\n`)
          return 'continue'
        }
        stdout.write(`${palette.bold('Atrium Status')}\n`)
        stdout.write(`  Account:   ${acc.connected ? `${acc.email ?? acc.displayName ?? 'connected'}` : 'not signed in'}\n`)
        stdout.write(`  Provider:  ${provider ? `${provider.name} [${provider.protocol}]` : 'none'}\n`)
        stdout.write(
          `  Model:     ${provider ? provider.model : 'none'} (context: ${formatTokenCount(limit)}${settings.contextWindowTokens ? ' custom' : ' auto'})\n`,
        )
        stdout.write(
          `  Profile:   ${settings.agentMode ?? 'auto'} · ${settings.workScene ?? 'code'} · effort:${settings.reasoningEffort ?? 'auto'}\n`,
        )
        stdout.write(`  Workspace: ${conversation.workspace ?? runtime.workspace ?? '(none)'}\n`)
        stdout.write(`  MCP:       ${connectedMcp}/${mcpStatuses.length} connected\n`)
        stdout.write(`  Chat:      ${conversation.id} (${conversation.messages.length} messages)\n`)
        return 'continue'
      }

      case '/model': {
        if (!arg) {
          const providers = runtime.settings.listProviders()
          const active = runtime.settings.activeProvider()
          if (providers.length === 0) {
            stdout.write('No providers configured. Run /login or /provider add.\n')
            return 'continue'
          }
          if (!isTty) {
            for (const p of providers) {
              const isActiveProvider = active?.id === p.id
              stdout.write(`${isActiveProvider ? palette.accent('* ') : '  '}${palette.bold(p.name)} (${p.protocol}):\n`)
              for (const m of p.models?.length ? p.models : [p.model]) {
                const selected = isActiveProvider && p.model === m
                stdout.write(`    ${selected ? palette.green(`● ${m}`) : palette.dim(`  ${m}`)}\n`)
              }
            }
            return 'continue'
          }
          const choices: Array<SelectOption<{ providerId: string; model: string }>> = []
          let initialIndex = 0
          for (const p of providers) {
            for (const m of p.models?.length ? p.models : [p.model]) {
              if (active?.id === p.id && p.model === m) {
                initialIndex = choices.length
              }
              choices.push({
                value: { providerId: p.id, model: m },
                label: m,
                hint: `${p.name} [${p.protocol}]`,
              })
            }
          }
          const picked = await selectOption({
            title: 'Select model',
            searchable: true,
            options: choices,
            initialIndex,
            palette,
            stdin: input,
            stdout,
          })
          if (!picked) return 'continue'
          const selected = await runtime.selectModel(picked.model, picked.providerId)
          await syncConversationProvider(selected.provider.id)
          return 'continue'
        }
        const selected = await runtime.selectModel(arg)
        await syncConversationProvider(selected.provider.id)
        stdout.write(`Active model set to ${palette.green(selected.model)} (${selected.provider.name}).\n`)
        return 'continue'
      }

      case '/provider': {
        const nextId = await handleProviderCommand(runtime, conversation.id, arg, askWithPrompt, commandIo)
        if (nextId) await syncConversationProvider(nextId)
        return 'continue'
      }

      case '/effort':
        await handleEffortCommand(runtime, arg, commandIo)
        return 'continue'

      case '/config':
        await handleConfigCommand(runtime, renderer, askWithPrompt, commandIo)
        return 'continue'

      case '/usage':
      case '/cost':
        await handleUsageCommand(runtime, conversation, commandIo)
        return 'continue'

      case '/mode': {
        if (!arg) {
          const cur = runtime.settings.get().agentMode ?? 'auto'
          if (!isTty) {
            stdout.write(`Current mode: ${palette.bold(cur)} (choices: ${AGENT_MODES.join(', ')})\n`)
            return 'continue'
          }
          const next = await selectOption<AgentMode>({
            title: 'Permission mode',
            options: AGENT_MODES.map((m) => ({
              value: m,
              label: m,
              hint: MODE_HINTS[m],
            })),
            initialIndex: Math.max(0, AGENT_MODES.indexOf(cur)),
            palette,
            stdin: input,
            stdout,
          })
          if (!next) return 'continue'
          await runtime.settings.update({ agentMode: next })
          return 'continue'
        }
        const next = arg.toLowerCase() as AgentMode
        if (!AGENT_MODES.includes(next)) {
          stdout.write(`Invalid mode "${arg}". Expected one of: ${AGENT_MODES.join(', ')}.\n`)
          return 'continue'
        }
        await runtime.settings.update({ agentMode: next })
        stdout.write(`Permission mode set to ${palette.green(next)}.\n`)
        return 'continue'
      }

      case '/scene': {
        if (!arg) {
          const cur = runtime.settings.get().workScene ?? 'code'
          if (!isTty) {
            stdout.write(`Current scene: ${palette.bold(cur)} (choices: code, work)\n`)
            return 'continue'
          }
          const next = await selectOption<WorkScene>({
            title: 'Work scene',
            options: [
              { value: 'code', label: 'code', hint: 'Software engineering & repository coding' },
              { value: 'work', label: 'work', hint: 'General writing, docs & office tasks' },
            ],
            initialIndex: cur === 'work' ? 1 : 0,
            palette,
            stdin: input,
            stdout,
          })
          if (!next) return 'continue'
          await runtime.settings.update({ workScene: next })
          return 'continue'
        }
        const next = arg.toLowerCase() as WorkScene
        if (next !== 'code' && next !== 'work') {
          stdout.write(`Invalid scene "${arg}". Expected "code" or "work".\n`)
          return 'continue'
        }
        await runtime.settings.update({ workScene: next })
        stdout.write(`Work scene set to ${palette.green(next)}.\n`)
        return 'continue'
      }

      case '/context': {
        const provider = runtime.settings.activeProvider()
        if (!arg) {
          const curCustom = runtime.settings.get().contextWindowTokens ?? 0
          const eff = resolveEffectiveContextLimit(provider?.model, curCustom)
          if (!isTty) {
            const presets = CONTEXT_WINDOW_PRESETS.map((p) => (p === 0 ? 'auto' : formatTokenCount(p))).join(', ')
            stdout.write(`Context window: ${formatTokenCount(eff)} (${curCustom ? 'custom' : 'auto'}) · presets: ${presets}\n`)
            return 'continue'
          }
          const options: Array<SelectOption<number>> = CONTEXT_WINDOW_PRESETS.map((preset) => ({
            value: preset,
            label:
              preset === 0
                ? `auto (${formatTokenCount(resolveEffectiveContextLimit(provider?.model, 0))})`
                : formatTokenCount(preset),
            hint: preset === 0 ? 'Detect from active model' : `${preset.toLocaleString()} tokens`,
          }))
          const initialIndex = Math.max(0, options.findIndex((o) => o.value === curCustom))
          const picked = await selectOption<number>({
            title: 'Context window limit',
            options,
            initialIndex,
            palette,
            stdin: input,
            stdout,
          })
          if (picked === null) return 'continue'
          await runtime.settings.update({ contextWindowTokens: picked })
          return 'continue'
        }
        const tokens = parseContextLimitInput(arg)
        await runtime.settings.update({ contextWindowTokens: tokens })
        const eff = resolveEffectiveContextLimit(provider?.model, tokens)
        stdout.write(`Context window updated to ${formatTokenCount(eff)} (${tokens === 0 ? 'auto' : 'custom'}).\n`)
        return 'continue'
      }

      case '/thinking': {
        const next =
          arg.toLowerCase() === 'on'
            ? true
            : arg.toLowerCase() === 'off'
              ? false
              : !renderer.showThinking
        renderer.setShowThinking(next)
        stdout.write(`Thinking stream ${next ? palette.green('enabled') : palette.dim('disabled')}.\n`)
        return 'continue'
      }

      case '/new': {
        conversation = await runtime.openOrCreateChat()
        stdout.write(`Started new conversation ${palette.dim(conversation.id)}.\n`)
        return 'continue'
      }

      case '/resume': {
        const metas = runtime.chats.list()
        if (!arg) {
          if (metas.length === 0) {
            stdout.write('No saved conversations yet.\n')
            return 'continue'
          }
          const top = metas.slice(0, 15)
          if (!isTty) {
            top.forEach((m, idx) => {
              const cur = m.id === conversation.id ? palette.green('*') : ' '
              stdout.write(`  ${cur} [${idx + 1}] ${m.title || 'Untitled'} ${palette.dim(`(${m.id}, ${m.messageCount ?? 0} msgs)`)}\n`)
            })
            stdout.write(palette.dim('  Use /resume <index> or /resume <id>.\n'))
            return 'continue'
          }
          const pickedId = await selectOption<string>({
            title: 'Resume conversation',
            searchable: true,
            options: top.map((m) => ({
              value: m.id,
              label: m.title || 'Untitled',
              hint: `${m.messageCount ?? 0} msgs · ${m.id}`,
            })),
            initialIndex: Math.max(0, top.findIndex((m) => m.id === conversation.id)),
            palette,
            stdin: input,
            stdout,
          })
          if (!pickedId) return 'continue'
          const loaded = await runtime.chats.get(pickedId)
          if (!loaded) {
            stdout.write(`Conversation "${pickedId}" could not be loaded.\n`)
            return 'continue'
          }
          conversation = loaded
          return 'continue'
        }
        const idx = Number(arg)
        const targetMeta =
          Number.isInteger(idx) && idx >= 1 && idx <= metas.length
            ? metas[idx - 1]
            : metas.find((m) => m.id === arg || m.id.startsWith(arg))
        if (!targetMeta) {
          stdout.write(`Conversation "${arg}" not found.\n`)
          return 'continue'
        }
        const loaded = await runtime.chats.get(targetMeta.id)
        if (!loaded) {
          stdout.write(`Conversation "${targetMeta.id}" could not be loaded.\n`)
          return 'continue'
        }
        conversation = loaded
        stdout.write(`Resumed "${conversation.title}" (${conversation.messages.length} messages).\n`)
        return 'continue'
      }

      case '/retry': {
        runtime.assertReady()
        turnActive = true
        updateWindowTitle(true)
        try {
          await runtime.agent.regenerate(conversation)
          const latest = await runtime.chats.get(conversation.id)
          if (latest) conversation = latest
        } finally {
          turnActive = false
          updateWindowTitle(false)
        }
        return 'continue'
      }

      case '/fork': {
        const forked = await runtime.chats.fork(conversation.id, undefined, arg || 'branch')
        conversation = forked
        stdout.write(`Forked conversation -> ${palette.green(forked.title)} ${palette.dim(`(${forked.id})`)}.\n`)
        return 'continue'
      }

      case '/rename': {
        const title = arg.trim() || (await askWithPrompt('New conversation title: ')).trim()
        if (!title) return 'continue'
        const meta = await runtime.chats.rename(conversation.id, title)
        conversation = { ...conversation, title: meta.title, updatedAt: meta.updatedAt }
        stdout.write(`Renamed conversation to "${meta.title}".\n`)
        return 'continue'
      }

      case '/compact': {
        conversation = await runtime.agent.compact(conversation)
        stdout.write(`Conversation compacted (${conversation.messages.length} messages remaining).\n`)
        return 'continue'
      }

      case '/export': {
        const writtenPath = await exportConversationMarkdown(
          conversation,
          arg,
          conversation.workspace ?? runtime.workspace,
        )
        stdout.write(`Exported Markdown transcript -> ${writtenPath}\n`)
        return 'continue'
      }

      case '/cwd': {
        const targetRaw = arg.trim() || (await askWithPrompt('Workspace directory path: ')).trim()
        if (!targetRaw) return 'continue'
        const resolvedDir = await resolveExistingDirectory(targetRaw)
        runtime.workspace = resolvedDir
        await runtime.settings.update({ workspace: resolvedDir })
        if (conversation.messages.length === 0 && !conversation.workspace) {
          const meta = await runtime.chats.setWorkspace(conversation.id, resolvedDir)
          conversation = { ...conversation, workspace: meta.workspace, updatedAt: meta.updatedAt }
        } else {
          conversation = await runtime.openOrCreateChat()
        }
        await refreshWorkspaceMeta()
        updateWindowTitle(false)
        stdout.write(`Workspace switched to ${palette.green(resolvedDir)} (chat ${palette.dim(conversation.id)}).\n`)
        return 'continue'
      }

      case '/mcp':
        await handleMcpCommand(runtime, arg, askWithPrompt, commandIo)
        return 'continue'

      case '/plugin':
      case '/plugins':
        await handlePluginCommand(runtime, arg, askWithPrompt, commandIo)
        return 'continue'

      case '/skills':
        await handleSkillsCommand(runtime, commandIo)
        return 'continue'

      case '/memory':
        await handleMemoryCommand(runtime, arg, commandIo)
        return 'continue'

      case '/permissions':
        await handlePermissionsCommand(runtime, conversation, arg, commandIo)
        return 'continue'

      case '/diff': {
        const changes = await runtime.listChanges(conversation.id)
        if (changes.length === 0) {
          stdout.write('No workspace changes detected.\n')
          return 'continue'
        }
        const termCols = Math.max(48, (stdout as NodeJS.WriteStream).columns || 90)
        const diffW = Math.min(82, Math.max(40, termCols - 10))
        if (isTty) {
          const diffLines: string[] = []
          changes.forEach((item, idx) => {
            if (idx > 0) diffLines.push('---')
            diffLines.push(
              `${palette.bold(item.path)} ${palette.subtle(`[${item.status}]`)} ${palette.green(`+${item.additions}`)}${palette.subtle('/')}${palette.red(`-${item.deletions}`)}`,
            )
            if (item.diff.trim()) {
              diffLines.push(...formatColoredDiff(item.diff, palette, 24, diffW).split('\n'))
            }
          })
          const card = renderFramedCard({
            title: 'Workspace Diff',
            badge: `${changes.length} file${changes.length === 1 ? '' : 's'}`,
            lines: diffLines,
            cols: termCols,
            maxWidth: 94,
            palette,
          })
          stdout.write(`\n${card}\n\n`)
          return 'continue'
        }
        for (const item of changes) {
          stdout.write(`\n${palette.bold(item.path)} [${item.status}] ${palette.green(`+${item.additions}`)}/${palette.red(`-${item.deletions}`)}\n`)
          if (item.diff.trim()) {
            stdout.write(`${formatColoredDiff(item.diff, palette, 24, diffW)}\n`)
          }
        }
        return 'continue'
      }

      case '/undo':
      case '/rewind': {
        const res = await runtime.undoLastTurn(conversation.id)
        conversation = res.conversation
        const fileNote =
          res.revertedFiles.length > 0 ? ` and reverted ${res.revertedFiles.join(', ')}` : ''
        stdout.write(`Undid last turn${fileNote}.\n`)
        await refreshWorkspaceMeta()
        return 'continue'
      }

      case '/git':
        await handleGitCommand(runtime, arg, commandIo)
        await refreshWorkspaceMeta()
        return 'continue'

      case '/commit':
        await handleCommitCommand(runtime, arg, askWithPrompt, commandIo)
        await refreshWorkspaceMeta()
        return 'continue'

      default:
        stdout.write(`Unknown command "${cmd}". Type /help for available commands.\n`)
        return 'continue'
    }
  }

  if (useViewport && viewport) {
    viewport.init(5)
  }
  await printBanner()

  if (isTty && !runtime.account.isConnected() && runtime.settings.listProviders().length === 0) {
    const palette = renderer.palette
    try {
      const envCandidates = detectEnvProviderCandidates()
      type SetupAction =
        | { kind: 'env'; envVar: string }
        | { kind: 'account' }
        | { kind: 'byok' }
        | { kind: 'skip' }

      const setupOptions: Array<SelectOption<SetupAction>> = envCandidates.map((cand) => ({
        value: { kind: 'env', envVar: cand.envVar },
        label: `Import ${cand.envVar} (${cand.name})`,
        hint: `Detected in environment · ${cand.model}`,
      }))
      setupOptions.push(
        { value: { kind: 'account' }, label: 'Sign in with Atrium Account', hint: 'Email / Google / GitHub' },
        {
          value: { kind: 'byok' },
          label: 'Configure BYOK / Preset Provider',
          hint: 'Anthropic / OpenAI / DeepSeek / GLM / Qwen / Ollama',
        },
        { value: { kind: 'skip' }, label: 'Skip for now', hint: 'Explore /help or configure later' },
      )

      const setupChoice = await selectOption<SetupAction>({
        title: 'First-time setup — connect a model source',
        options: setupOptions,
        palette,
        stdin: input,
        stdout,
      })

      if (setupChoice?.kind === 'env') {
        const cand = envCandidates.find((c) => c.envVar === setupChoice.envVar)
        if (cand) {
          const saved = await runtime.settings.saveProvider({
            name: cand.name,
            protocol: cand.protocol,
            baseUrl: cand.baseUrl,
            model: cand.model,
            models: [cand.model],
            presetId: cand.presetId !== 'custom' ? cand.presetId : undefined,
            apiKey: cand.apiKey,
          })
          await runtime.settings.update({ activeProviderId: saved.id })
          await syncConversationProvider(saved.id)
          stdout.write(`  ${palette.green('✓')} Imported "${saved.name}" (${saved.model}).\n`)
        }
      } else if (setupChoice?.kind === 'account') {
        const loginArgs: ParsedCliArgs = {
          command: 'login',
          subArgs: [],
          printMode: false,
          continueWorkspace: false,
          forkSession: false,
          outputFormat: 'text',
          noPersistence: false,
          yes: false,
          thinking: false,
          json: false,
          color: palette.enabled,
          help: false,
          version: false,
          google: false,
          github: false,
        }
        const ok = await runLoginFlow(runtime, loginArgs, {
          stdin: input,
          stdout,
          stderr,
          palette,
          ask: askWithPrompt,
        })
        if (ok) {
          const active = runtime.settings.activeProvider()
          if (active) await syncConversationProvider(active.id)
        }
      } else if (setupChoice?.kind === 'byok') {
        const saved = await runAddProviderFlow(runtime, askWithPrompt, {
          stdin: input,
          stdout,
          stderr,
          palette,
        })
        if (saved) await syncConversationProvider(saved.id)
      }
    } catch (err) {
      renderer.error(sanitizeMessage(err))
    }
    stdout.write('\n')
  }

  try {
    while (true) {
      const palette = renderer.palette
      const result = await readComposerInput({
        stdin: input,
        stdout,
        viewport,
        palette,
        commands: SLASH_COMMANDS,
        getWorkspaceFiles: () => cachedWorkspaceFiles,
        getStatusMeta: () => {
          const settings = runtime.settings.get()
          const provider = runtime.settings.activeProvider()
          return {
            mode: settings.agentMode ?? 'auto',
            model: provider?.model,
            effort: settings.reasoningEffort ?? 'auto',
            gitBranch: cachedGitBranch,
            gitDirty: cachedGitDirty,
            contextUsed: estimateConversationTokens(conversation),
            contextLimit: resolveEffectiveContextLimit(provider?.model, settings.contextWindowTokens),
            sessionName: conversation.titleSource === 'user' ? conversation.title : undefined,
          }
        },
        history,
        onCycleMode: async () => {
          const cur = runtime.settings.get().agentMode ?? 'auto'
          const nextIdx = (MODE_CYCLE.indexOf(cur) + 1) % MODE_CYCLE.length
          const next = MODE_CYCLE[nextIdx] ?? 'auto'
          await runtime.settings.update({ agentMode: next })
          return next
        },
        onToggleThinking: () => {
          const next = !renderer.showThinking
          renderer.setShowThinking(next)
          return next
        },
        onClearScreen: () => printBanner(),
      })

      if (result.kind === 'exit') break

      const fullInput = result.text
      const trimmed = fullInput.trim()
      if (!trimmed) continue

      if (history[0] !== fullInput) {
        history.unshift(fullInput)
        if (history.length > 200) history.pop()
      }

      // Bare `/` opens interactive command selector cleanly as fallback/shortcut.
      if (trimmed === '/' && isTty) {
        const chosenCmd = await selectOption<string>({
          title: 'Command palette',
          searchable: true,
          options: SLASH_COMMANDS.map((c) => ({ value: c.cmd, label: c.cmd, hint: c.hint })),
          pageSize: 12,
          viewport,
          palette,
          stdin: input,
          stdout,
        })
        if (chosenCmd) {
          try {
            const action = await handleSlashCommand(chosenCmd)
            if (action === 'exit') break
          } catch (err) {
            renderer.error(sanitizeMessage(err))
          }
        }
        continue
      }

      if (
        useViewport &&
        viewport &&
        trimmed !== '/clear' &&
        trimmed !== '/exit' &&
        trimmed !== '/quit' &&
        trimmed !== '/q'
      ) {
        const cols = (rawStdout as NodeJS.WriteStream).columns || 80
        const echoBlock = renderSubmittedPromptBlock(fullInput, palette, cols)
        if (echoBlock) stdout.write(echoBlock)
      }

      if (trimmed.startsWith('!')) {
        if (useViewport && viewport) {
          const st = runtime.settings.get()
          const cols = (rawStdout as NodeJS.WriteStream).columns || 80
          viewport.renderDock(
            renderWorkingDockLines(
              { mode: st.agentMode ?? 'auto', effort: st.reasoningEffort ?? 'auto', status: 'Running shell command...' },
              palette,
              cols,
            ),
            null,
          )
        }
        await runInlineShellCommand(
          trimmed.slice(1),
          conversation.workspace ?? runtime.workspace,
          stdout,
          stderr,
          palette,
        )
        await refreshWorkspaceMeta()
        continue
      }

      if (trimmed.startsWith('/')) {
        try {
          const action = await handleSlashCommand(trimmed)
          if (action === 'exit') break
        } catch (err) {
          renderer.error(sanitizeMessage(err))
        }
        continue
      }

      try {
        await runPromptTurn(fullInput)
      } catch (err) {
        renderer.error(sanitizeMessage(err))
      }
    }
  } finally {
    setTerminalTitle(rawStdout, 'Atrium')
    renderer.dispose()
    if (useViewport && viewport) viewport.dispose()
    runtime.setApprovalHandler(undefined)
    process.off('SIGINT', onProcessSigint)
  }
}
