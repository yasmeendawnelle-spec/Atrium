// Cross-platform Atrium CLI entrypoint (Windows / macOS / Linux).
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from 'node:process'
import type { TokenUsage } from '../shared/types.ts'
import { resolveEffectiveContextLimit } from '../shared/types.ts'
import { formatHelpText, parseCliArgs } from './args.ts'
import {
  expandFileMentions,
  runDoctorCheck,
  runFleetSubcommand,
  runImportSubcommand,
  runMcpSubcommand,
  runPluginSubcommand,
  runPolicySubcommand,
} from './commands.ts'
import { createPalette, createRenderer } from './render.ts'
import { runInteractiveRepl, runLoginFlow } from './repl.ts'
import { createCliRuntime } from './runtime.ts'
import { formatCompactTokens, renderFramedCard } from './ui.ts'
import { createTerminalViewport } from './viewport.ts'

export const CLI_VERSION = process.env.ATRIUM_CLI_VERSION || '0.3.7'

export interface CliIo {
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  stderr?: NodeJS.WritableStream
  homeDir?: string
  requireAccount?: boolean
}

function sanitizeCliError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw
    .replace(/https?:\/\/(?:[\w.-]+\.)?rpulse\.top/gi, 'Atrium Cloud')
    .replace(/\brpulse\.top\b/gi, 'Atrium Cloud')
    .replace(/RelayPulse/gi, 'Atrium Cloud')
}

function isStreamTty(stream: NodeJS.ReadableStream): boolean {
  return Boolean((stream as NodeJS.ReadStream).isTTY)
}

async function readStreamText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  io: CliIo = {},
): Promise<number> {
  const stdin = io.stdin ?? defaultStdin
  const stdout = io.stdout ?? defaultStdout
  const stderr = io.stderr ?? defaultStderr

  let args
  try {
    args = parseCliArgs(argv)
  } catch (err) {
    stderr.write(`Error: ${sanitizeCliError(err)}\n`)
    return 2
  }

  if (args.version) {
    stdout.write(`atrium v${CLI_VERSION}\n`)
    return 0
  }

  if (args.help) {
    stdout.write(formatHelpText(CLI_VERSION))
    return 0
  }

  const stdinIsTty = isStreamTty(stdin)
  let pipedPrompt = ''
  if (args.command === 'chat' && !stdinIsTty) {
    pipedPrompt = await readStreamText(stdin)
  }

  const combinedPrompt = [pipedPrompt.trim(), args.prompt?.trim()].filter(Boolean).join('\n\n')
  const isOneShot =
    args.command === 'chat' && (args.printMode || args.prompt !== undefined || combinedPrompt.length > 0)

  const runtime = await createCliRuntime({
    ...(io.homeDir ? { homeDir: io.homeDir } : {}),
    ...(args.workspace ? { workspace: args.workspace } : {}),
    ...(io.requireAccount !== undefined ? { requireAccount: io.requireAccount } : {}),
    ...(args.systemPrompt !== undefined ? { systemPromptOverride: args.systemPrompt } : {}),
    ...(args.appendSystemPrompt !== undefined ? { appendSystemPrompt: args.appendSystemPrompt } : {}),
    ...(args.maxTurns !== undefined ? { maxRounds: args.maxTurns } : {}),
    ...(args.noPersistence ? { noPersistence: true } : {}),
    connectMcp: args.command === 'chat',
    // The REPL starts MCP servers right after its first screen (see runInteractiveRepl).
    deferMcpConnect: args.command === 'chat' && !isOneShot,
    unattended: isOneShot && !args.yes,
    autoApprove: args.yes,
  })

  const savedTheme = runtime.settings.get().cliTheme
  const stdoutColor = args.color && !process.env.NO_COLOR && Boolean((stdout as NodeJS.WriteStream).isTTY)

  try {
    switch (args.command) {
      case 'auth': {
        const sub = args.subArgs[0]?.toLowerCase() ?? 'status'
        if (sub === 'help' || sub === '--help' || sub === '-h') {
          stdout.write(`Usage: atrium auth <login|logout|status> [options]

Commands:
  login    Sign in to Atrium account (--email/--password/--code/--google/--github)
  logout   Sign out of the Atrium account on this machine
  status   Show account sign-in state
`)
          return 0
        }
        if (sub === 'logout') {
          await runtime.account.logout()
          stdout.write('Signed out of Atrium account.\n')
          return 0
        }
        if (sub === 'login') {
          const authParsed = parseCliArgs(['login', ...args.subArgs.slice(1)])
          const loginPalette = createPalette(stdoutColor, savedTheme)
          const ok = await runLoginFlow(runtime, authParsed, { stdin, stdout, stderr, palette: loginPalette })
          return ok ? 0 : 1
        }
        if (sub === 'status') {
          const acc = runtime.account.getState()
          const provider = runtime.settings.activeProvider()
          if (args.json) {
            stdout.write(
              `${JSON.stringify(
                {
                  connected: acc.connected,
                  email: acc.email ?? null,
                  displayName: acc.displayName ?? null,
                  oauthProvider: acc.oauthProvider ?? null,
                  sessionValid: acc.sessionValid ?? false,
                  activeModel: provider?.model ?? null,
                },
                null,
                2,
              )}\n`,
            )
            return 0
          }
          stdout.write(`Account: ${acc.connected ? acc.email ?? acc.displayName ?? 'signed in' : 'not signed in'}\n`)
          return 0
        }
        stderr.write(`Unknown auth subcommand "${sub}". Run "atrium auth --help" for usage.\n`)
        return 2
      }

      case 'login': {
        const loginPalette = createPalette(stdoutColor, savedTheme)
        const ok = await runLoginFlow(runtime, args, { stdin, stdout, stderr, palette: loginPalette })
        return ok ? 0 : 1
      }

      case 'logout': {
        await runtime.account.logout()
        stdout.write('Signed out of Atrium account.\n')
        return 0
      }

      case 'status': {
        const settings = runtime.settings.get()
        const provider = runtime.settings.activeProvider()
        const account = runtime.account.getState()
        const mcpStatuses = runtime.mcp.statuses()
        const chats = runtime.chats.list()
        if (args.json) {
          stdout.write(
            `${JSON.stringify(
              {
                version: CLI_VERSION,
                homeDir: runtime.homeDir,
                workspace: runtime.workspace ?? null,
                account: {
                  connected: account.connected,
                  email: account.email ?? null,
                  displayName: account.displayName ?? null,
                },
                activeProvider: provider ?? null,
                mode: settings.agentMode ?? 'auto',
                scene: settings.workScene ?? 'code',
                effort: settings.reasoningEffort ?? 'auto',
                orchestrator: {
                  enabled: settings.orchestratorEnabled === true,
                  executorProviderId: settings.orchestratorExecutorProviderId ?? null,
                  executorModel: settings.orchestratorExecutorModel ?? null,
                },
                mcp: mcpStatuses,
                recentChats: chats.length,
              },
              null,
              2,
            )}\n`,
          )
          return 0
        }
        if (Boolean((stdout as NodeJS.WriteStream).isTTY)) {
          const p = createPalette(stdoutColor, savedTheme)
          const mcpConn = mcpStatuses.filter((m) => m.state === 'connected').length
          const orchSummary =
            settings.orchestratorEnabled === true
              ? `on${settings.orchestratorExecutorModel ? ` (${settings.orchestratorExecutorModel})` : ' (auto)'}`
              : 'off'
          const card = renderFramedCard({
            title: 'Atrium CLI Status',
            badge: `v${CLI_VERSION}`,
            palette: p,
            cols: (stdout as NodeJS.WriteStream).columns,
            lines: [
              `${p.muted('Home:')}       ${runtime.homeDir}`,
              `${p.muted('Workspace:')}  ${runtime.workspace ?? p.subtle('(none)')}`,
              `${p.muted('Account:')}    ${account.connected ? p.green(account.email ?? account.displayName ?? 'connected') : p.subtle('not signed in')}`,
              `${p.muted('Provider:')}   ${provider ? `${p.bold(provider.name)} [${provider.protocol}] (${p.cyan(provider.model)})` : p.yellow('none')}`,
              `${p.muted('Profile:')}    ${settings.agentMode ?? 'auto'} · ${settings.workScene ?? 'code'} · effort:${settings.reasoningEffort ?? 'auto'} · orch:${orchSummary} · theme:${p.themeId}`,
              `${p.muted('MCP:')}        ${mcpConn}/${mcpStatuses.length} connected`,
              `${p.muted('Chats:')}      ${chats.length} saved`,
            ],
          })
          stdout.write(`\n${card}\n`)
          return 0
        }
        stdout.write(`Atrium CLI v${CLI_VERSION}\n`)
        stdout.write(`Home:      ${runtime.homeDir}\n`)
        stdout.write(`Workspace: ${runtime.workspace ?? '(none)'}\n`)
        stdout.write(
          `Account:   ${account.connected ? account.email ?? account.displayName ?? 'connected' : 'not signed in'}\n`,
        )
        stdout.write(
          `Provider:  ${provider ? `${provider.name} [${provider.protocol}] (${provider.model})` : 'none'}\n`,
        )
        stdout.write(
          `Profile:   ${settings.agentMode ?? 'auto'} · ${settings.workScene ?? 'code'} · effort:${settings.reasoningEffort ?? 'auto'} · orch:${settings.orchestratorEnabled === true ? (settings.orchestratorExecutorModel ?? 'auto') : 'off'}\n`,
        )
        stdout.write(`MCP:       ${mcpStatuses.filter((m) => m.state === 'connected').length}/${mcpStatuses.length} connected\n`)
        stdout.write(`Chats:     ${chats.length} saved\n`)
        return 0
      }

      case 'models': {
        const providers = runtime.settings.listProviders()
        const activeId = runtime.settings.activeProvider()?.id ?? null
        if (args.json) {
          stdout.write(`${JSON.stringify({ activeProviderId: activeId, providers }, null, 2)}\n`)
          return 0
        }
        if (providers.length === 0) {
          stdout.write('No providers configured. Run "atrium login" or use "/provider add" inside chat.\n')
          return 0
        }
        for (const p of providers) {
          const activeMark = p.id === activeId ? '* ' : '  '
          stdout.write(`${activeMark}${p.name} [${p.protocol}] (id=${p.id})\n`)
          for (const m of p.models?.length ? p.models : [p.model]) {
            const selected = p.id === activeId && p.model === m ? '*' : ' '
            stdout.write(`    ${selected} ${m}\n`)
          }
        }
        return 0
      }

      case 'chats': {
        const list = runtime.chats.list()
        if (args.json) {
          stdout.write(`${JSON.stringify(list, null, 2)}\n`)
          return 0
        }
        if (list.length === 0) {
          stdout.write('No saved conversations yet.\n')
          return 0
        }
        for (const meta of list.slice(0, 25)) {
          const ts = new Date(meta.updatedAt).toISOString()
          stdout.write(`- ${meta.id}  [${meta.messageCount ?? 0} msgs]  ${ts}  ${meta.title || 'Untitled'}\n`)
        }
        return 0
      }

      case 'doctor': {
        await runDoctorCheck(runtime, CLI_VERSION, stdout, args.json, createPalette(stdoutColor, savedTheme))
        return 0
      }

      case 'usage': {
        const summary = await runtime.chats.summarizeUsage()
        const activeProvider = runtime.settings.activeProvider()
        const contextLimit = resolveEffectiveContextLimit(
          activeProvider?.model,
          runtime.settings.get().contextWindowTokens,
        )
        if (args.json) {
          stdout.write(
            `${JSON.stringify(
              {
                summary,
                activeProvider: activeProvider
                  ? { id: activeProvider.id, name: activeProvider.name, model: activeProvider.model }
                  : null,
                contextLimitTokens: contextLimit,
              },
              null,
              2,
            )}\n`,
          )
          return 0
        }
        stdout.write(`Atrium Token Usage\n`)
        stdout.write(
          `  Chats:       ${summary.conversations} (${summary.userMessages} user / ${summary.assistantMessages} assistant msgs)\n`,
        )
        stdout.write(
          `  Tokens:      in ${formatCompactTokens(summary.inputTokens)} · out ${formatCompactTokens(summary.outputTokens)} · cache-read ${formatCompactTokens(summary.cacheReadTokens)}\n`,
        )
        stdout.write(`  Context cap: ${formatCompactTokens(contextLimit)}\n`)
        if (summary.byProvider.length > 0) {
          stdout.write('  By provider:\n')
          for (const row of summary.byProvider) {
            const pName = runtime.settings.getProvider(row.providerId)?.name ?? row.providerId
            stdout.write(
              `    - ${pName}: ${row.conversations} chats · in ${formatCompactTokens(row.inputTokens)} · out ${formatCompactTokens(row.outputTokens)}\n`,
            )
          }
        }
        return 0
      }

      case 'mcp':
        return runMcpSubcommand(runtime, args.subArgs, args.json, stdout, stderr)

      case 'plugin':
      case 'plugins':
        return runPluginSubcommand(runtime, args.subArgs, args.json, stdout, stderr)

      case 'import':
        return runImportSubcommand(runtime, args.subArgs, args.json, stdout)

      case 'policy':
        return runPolicySubcommand(runtime, args.subArgs, args.json, stdout, stderr)

      case 'fleet':
        return runFleetSubcommand(runtime, args.subArgs, args.json, stdout, stderr)

      case 'chat': {
        await runtime.applyOverrides({
          ...(args.provider !== undefined ? { provider: args.provider } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.scene !== undefined ? { scene: args.scene } : {}),
          ...(args.effort !== undefined ? { effort: args.effort } : {}),
          ...(args.ultracode !== undefined ? { ultracode: args.ultracode } : {}),
          ...(args.orchestrator !== undefined ? { orchestrator: args.orchestrator } : {}),
          ...(args.executorModel !== undefined ? { executorModel: args.executorModel } : {}),
          ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
        })

        const singleJson = args.outputFormat === 'json'
        const streamJson = args.outputFormat === 'stream-json' || args.json

        if (isOneShot) {
          const renderer = createRenderer({
            color: args.color,
            theme: savedTheme,
            showThinking: args.thinking,
            json: streamJson,
            stdout,
            stderr,
            ultracode: () => runtime.settings.get().ultracode === true,
          })
          if (!combinedPrompt) {
            renderer.dispose()
            stderr.write('Error: Prompt cannot be empty.\n')
            return 2
          }
          runtime.assertReady()
          const expandedPrompt = await expandFileMentions(combinedPrompt, runtime.workspace, stderr, renderer.palette)
          const conversation = await runtime.openOrCreateChat({
            ...(args.resume !== undefined ? { resume: args.resume } : {}),
            ...(args.continueWorkspace ? { continueWorkspace: true } : {}),
            ...(args.forkSession ? { forkSession: true } : {}),
            ...(args.sessionName ? { name: args.sessionName } : {}),
            ...(args.worktree !== undefined ? { worktree: args.worktree } : {}),
          })

          let collectedText = ''
          let collectedUsage: TokenUsage | undefined
          const t0 = Date.now()
          const off = runtime.onEvent((ev) => {
            if (singleJson) {
              if (ev.type === 'text_delta') collectedText += ev.text
              else if (ev.type === 'message_saved' && ev.message.role === 'assistant' && ev.message.usage) {
                collectedUsage = ev.message.usage
              }
              return
            }
            renderer.onEvent(ev)
          })

          try {
            const outcome = await runtime.runTurn(conversation, expandedPrompt)
            if (singleJson) {
              const activeProvider = runtime.settings.activeProvider()
              stdout.write(
                `${JSON.stringify(
                  {
                    session_id: conversation.id,
                    result: collectedText.trim(),
                    reason: outcome.reason,
                    model: activeProvider?.model ?? null,
                    duration_ms: Date.now() - t0,
                    usage: collectedUsage ?? null,
                    ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
                  },
                  null,
                  2,
                )}\n`,
              )
            }
            return outcome.reason === 'done' || outcome.reason === 'truncated' ? 0 : 1
          } finally {
            off()
            renderer.dispose()
          }
        }

        if (!stdinIsTty) {
          stderr.write(
            'Error: Interactive REPL requires a TTY terminal, or pass a prompt via -p "..." or stdin.\n',
          )
          return 2
        }

        const viewport = createTerminalViewport(stdout)
        const renderer = createRenderer({
          color: args.color,
          theme: savedTheme,
          showThinking: args.thinking,
          json: streamJson,
          stdout: viewport.enabled ? viewport.transcriptStream : stdout,
          stderr: viewport.enabled ? viewport.transcriptStream : stderr,
          ultracode: () => runtime.settings.get().ultracode === true,
        })

        const conversation = await runtime.openOrCreateChat({
          ...(args.resume !== undefined ? { resume: args.resume } : {}),
          ...(args.continueWorkspace ? { continueWorkspace: true } : {}),
          ...(args.forkSession ? { forkSession: true } : {}),
          ...(args.sessionName ? { name: args.sessionName } : {}),
          ...(args.worktree !== undefined ? { worktree: args.worktree } : {}),
        })
        const off = runtime.onEvent((ev) => renderer.onEvent(ev))
        try {
          await runInteractiveRepl(runtime, renderer, {
            conversation,
            version: CLI_VERSION,
            autoApprove: args.yes,
            viewport,
            stdin,
            stdout,
            stderr,
          })
          return 0
        } finally {
          off()
          renderer.dispose()
          viewport.dispose()
        }
      }
    }
  } catch (err) {
    stderr.write(`Error: ${sanitizeCliError(err)}\n`)
    return 1
  } finally {
    await runtime.dispose()
  }
}

function isDirectMainExecution(): boolean {
  if (typeof require !== 'undefined' && typeof module !== 'undefined') {
    return require.main === module
  }
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/')
  return entry.endsWith('/src/cli/index.ts') || entry === 'src/cli/index.ts'
}

if (isDirectMainExecution()) {
  runCli().then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      defaultStderr.write(`Fatal: ${sanitizeCliError(err)}\n`)
      process.exitCode = 1
    },
  )
}
