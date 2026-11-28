// CLI command & flag parser for Atrium across Windows, macOS, and Linux (Claude-Code compatible).
import {
  normalizeReasoningEffort,
  REASONING_EFFORT_LEVELS,
  type AgentMode,
  type ReasoningEffort,
  type WorkScene,
} from '../shared/types.ts'

export type CliCommand =
  | 'chat'
  | 'auth'
  | 'login'
  | 'logout'
  | 'status'
  | 'models'
  | 'chats'
  | 'doctor'
  | 'usage'
  | 'mcp'
  | 'plugin'
  | 'plugins'
  | 'import'
  | 'policy'
  | 'fleet'

export type CliOutputFormat = 'text' | 'json' | 'stream-json'

export interface ParsedCliArgs {
  command: CliCommand
  subArgs: string[]
  prompt?: string
  printMode: boolean
  workspace?: string
  model?: string
  provider?: string
  mode?: AgentMode
  scene?: WorkScene
  effort?: ReasoningEffort
  ultracode?: boolean
  orchestrator?: boolean
  executorModel?: string
  resume?: string | true
  continueWorkspace: boolean
  forkSession: boolean
  sessionName?: string
  worktree?: string | true
  outputFormat: CliOutputFormat
  systemPrompt?: string
  appendSystemPrompt?: string
  maxTurns?: number
  noPersistence: boolean
  yes: boolean
  thinking: boolean
  json: boolean
  color: boolean
  help: boolean
  version: boolean
  email?: string
  password?: string
  code?: string
  google: boolean
  github: boolean
}

const KNOWN_COMMANDS = new Set<CliCommand>([
  'chat',
  'auth',
  'login',
  'logout',
  'status',
  'models',
  'chats',
  'doctor',
  'usage',
  'mcp',
  'plugin',
  'plugins',
  'import',
  'policy',
  'fleet',
])

const PASSTHROUGH_SUBCOMMANDS = new Set<CliCommand>(['auth', 'mcp', 'plugin', 'plugins', 'import', 'policy', 'fleet'])

function takeValue(argv: readonly string[], idx: number, flag: string): string {
  const val = argv[idx + 1]
  if (val === undefined || val.startsWith('-')) {
    throw new Error(`Option ${flag} requires a value.`)
  }
  return val
}

function parseMode(raw: string): AgentMode {
  const clean = raw.trim()
  const v = clean.toLowerCase()
  if (v === 'auto' || v === 'manual' || v === 'accept_edits' || v === 'plan' || v === 'bypass') return v
  if (v === 'acceptedits') return 'accept_edits'
  if (v === 'bypasspermissions' || v === 'dontask') return 'bypass'
  throw new Error(
    `Invalid permission mode "${raw}". Expected one of: auto, manual, accept_edits (acceptEdits), plan, bypass (bypassPermissions).`,
  )
}

function parseScene(raw: string): WorkScene {
  const v = raw.trim().toLowerCase()
  if (v === 'code' || v === 'work') return v
  throw new Error(`Invalid --scene "${raw}". Expected "code" or "work".`)
}

function parseEffort(raw: string): ReasoningEffort {
  const v = normalizeReasoningEffort(raw, 'auto')
  if (v !== 'auto' || raw.trim().toLowerCase() === 'auto') return v
  throw new Error(`Invalid --effort "${raw}". Expected one of: ${REASONING_EFFORT_LEVELS.join(', ')}.`)
}

function parseOutputFormat(raw: string): CliOutputFormat {
  const v = raw.trim().toLowerCase()
  if (v === 'text' || v === 'json' || v === 'stream-json') return v
  throw new Error(`Invalid --output-format "${raw}". Expected one of: text, json, stream-json.`)
}

function parseMaxTurns(raw: string): number {
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new Error(`Invalid --max-turns "${raw}". Expected integer between 1 and 100.`)
  }
  return n
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    command: 'chat',
    subArgs: [],
    printMode: false,
    continueWorkspace: false,
    forkSession: false,
    outputFormat: 'text',
    noPersistence: false,
    yes: false,
    thinking: false,
    json: false,
    color: !process.env.NO_COLOR,
    help: false,
    version: false,
    google: false,
    github: false,
  }

  const positional: string[] = []
  let i = 0
  if (argv[0] && !argv[0].startsWith('-') && KNOWN_COMMANDS.has(argv[0] as CliCommand)) {
    result.command = argv[0] as CliCommand
    i = 1
  }

  // Dedicated subcommand trees keep their own flag surface (e.g. `mcp add -e KEY=1 -- npx pkg`).
  if (PASSTHROUGH_SUBCOMMANDS.has(result.command)) {
    const rest = argv.slice(i)
    const filtered: string[] = []
    for (let j = 0; j < rest.length; j += 1) {
      const tok = rest[j]!
      if (tok === '--json') {
        result.json = true
        result.outputFormat = 'stream-json'
      } else if (tok === '--no-color') {
        result.color = false
      } else if ((tok === '-C' || tok === '--cwd' || tok === '--workspace') && rest[j + 1] && !rest[j + 1]!.startsWith('-')) {
        result.workspace = rest[++j]!
      } else {
        filtered.push(tok)
      }
    }
    if (filtered.length === 0 || (filtered.length === 1 && (filtered[0] === '-h' || filtered[0] === '--help'))) {
      if (filtered[0] === '-h' || filtered[0] === '--help') {
        result.help = true
      }
    }
    result.subArgs = filtered
    return result
  }

  let endOfFlags = false
  for (; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (endOfFlags) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      endOfFlags = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }
    if (arg === '-v' || arg === '--version') {
      result.version = true
      continue
    }
    if (arg === '-y' || arg === '--yes') {
      result.yes = true
      continue
    }
    if (arg === '--dangerously-skip-permissions') {
      result.mode = 'bypass'
      result.yes = true
      continue
    }
    if (arg === '--thinking') {
      result.thinking = true
      continue
    }
    if (arg === '--json') {
      result.json = true
      result.outputFormat = 'stream-json'
      continue
    }
    if (arg === '--no-color') {
      result.color = false
      continue
    }
    if (arg === '--google') {
      result.google = true
      continue
    }
    if (arg === '--github') {
      result.github = true
      continue
    }
    if (arg === '-c' || arg === '--continue') {
      result.continueWorkspace = true
      continue
    }
    if (arg === '--fork-session') {
      result.forkSession = true
      continue
    }
    if (arg === '--no-session-persistence') {
      result.noPersistence = true
      continue
    }

    const eqIdx = arg.indexOf('=')
    const flag = eqIdx > 0 ? arg.slice(0, eqIdx) : arg
    const inlineVal = eqIdx > 0 ? arg.slice(eqIdx + 1) : undefined

    const readVal = (): string => {
      if (inlineVal !== undefined) return inlineVal
      const v = takeValue(argv, i, flag)
      i += 1
      return v
    }

    switch (flag) {
      case '-p':
      case '--print':
        result.printMode = true
        if (inlineVal !== undefined) {
          result.prompt = inlineVal
        } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) {
          result.prompt = argv[++i]!
        }
        break
      case '-C':
      case '--cwd':
      case '--workspace':
        result.workspace = readVal()
        break
      case '-m':
      case '--model':
        result.model = readVal()
        break
      case '--provider':
        result.provider = readVal()
        break
      case '--mode':
      case '--permission-mode':
        result.mode = parseMode(readVal())
        break
      case '--scene':
        result.scene = parseScene(readVal())
        break
      case '--effort': {
        const raw = readVal()
        // `--effort ultracode` mirrors `/effort ultracode`: it turns the Ultracode switch on.
        if (raw.trim().toLowerCase() === 'ultracode') result.ultracode = true
        else result.effort = parseEffort(raw)
        break
      }
      case '--ultracode':
        result.ultracode = true
        break
      case '--no-ultracode':
        result.ultracode = false
        break
      case '--orchestrator':
        result.orchestrator = true
        break
      case '--no-orchestrator':
        result.orchestrator = false
        break
      case '--executor-model':
      case '--fast-model':
        result.executorModel = readVal()
        break
      case '-n':
      case '--name':
        result.sessionName = readVal()
        break
      case '--output-format':
        result.outputFormat = parseOutputFormat(readVal())
        if (result.outputFormat === 'stream-json') result.json = true
        break
      case '--system-prompt':
        result.systemPrompt = readVal()
        break
      case '--append-system-prompt':
        result.appendSystemPrompt = readVal()
        break
      case '--max-turns':
        result.maxTurns = parseMaxTurns(readVal())
        break
      case '-w':
      case '--worktree': {
        if (inlineVal !== undefined) {
          result.worktree = inlineVal || true
        } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) {
          result.worktree = argv[++i]!
        } else {
          result.worktree = true
        }
        break
      }
      case '-r':
      case '--resume': {
        if (inlineVal !== undefined) {
          result.resume = inlineVal || true
        } else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) {
          result.resume = argv[++i]!
        } else {
          result.resume = true
        }
        break
      }
      case '--email':
        result.email = readVal()
        break
      case '--password':
        result.password = readVal()
        break
      case '--code':
        result.code = readVal()
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}. Run "atrium --help" for usage.`)
        }
        positional.push(arg)
        break
    }
  }

  if (result.prompt === undefined && positional.length > 0 && result.command === 'chat') {
    result.prompt = positional.join(' ')
  } else if (positional.length > 0 && result.command === 'login' && !result.email && positional[0]?.includes('@')) {
    result.email = positional[0]
  } else if (positional.length > 0 && result.resume === true) {
    result.resume = positional[0]
  }

  return result
}

export function formatHelpText(version: string): string {
  return `Atrium CLI v${version} — Cross-platform AI Agent Workbench (Windows / macOS / Linux)

Usage:
  atrium [options] [prompt]
  atrium <command> [options]

Commands:
  chat                            Start interactive terminal session (default)
  auth <login|logout|status>      Manage Atrium account authentication
  login                           Shortcut for "auth login" (--email/--password/--code/--google/--github)
  logout                          Shortcut for "auth logout"
  mcp <list|add|get|remove|...>   Configure and inspect MCP servers
  plugin <list|discover|import|...> Manage Atrium / Claude-Code-compatible plugins
  import [--all]                  Import plugins & skills discovered from Claude Code / Codex / Workspace
  import sessions [--all]         Import conversations from Claude Code, Codex, DSH, Antigravity, Cursor, etc.
  policy <status|check|...>       Inspect/test/configure .atrium/policy.json security guardrails
  fleet <list|launch|diff|...>    Orchestrate parallel Git worktree tasks from the terminal
  doctor                          Check CLI installation, credentials, instructions, plugins, and Git
  usage                           Show token usage summary across chats and providers
  status                          Show active provider/model, workspace, account, and MCP status
  models                          List available providers and models
  chats                           List recent conversations

Options:
  -p, --print [prompt]            Run non-interactive turn and exit (reads piped stdin too)
  -C, --cwd <dir>                 Set workspace directory (aliases: --workspace)
  -c, --continue                  Continue the most recent conversation in this workspace
  -r, --resume [id]               Resume most recent chat or a specific conversation id
  --fork-session                  Create a new branched copy when resuming/continuing
  -n, --name <name>               Set a display title for the session
  -w, --worktree [name]           Create an isolated Git worktree for this session
  -m, --model <id>                Override active model for this session
  --provider <name>               Override active provider by name or id
  --mode, --permission-mode <m>   auto | manual | accept_edits (acceptEdits) | plan | bypass
  --dangerously-skip-permissions  Bypass all tool confirmation prompts (same as --mode bypass -y)
  --scene <scene>                 Work scene focus: code | work
  --effort <level>                Reasoning effort: auto | low | medium | high | xhigh | max
  --ultracode, --no-ultracode     Plan a multi-subagent workflow for each task (independent of effort)
  --orchestrator, --no-orchestrator  Strong planner model directs a fast executor model (Plan → Execute → Review)
  --executor-model <id>           Pin the fast executor model for Orchestrator (or use auto-selection)
  --output-format <fmt>           Print output format: text | json | stream-json
  --system-prompt <prompt>        Replace default system prompt
  --append-system-prompt <p>      Append instructions to the default system prompt
  --max-turns <n>                 Limit max tool rounds per turn (1-100)
  --no-session-persistence        Do not save session history to disk
  -y, --yes                       Auto-approve tool actions in one-shot mode
  --thinking                      Stream model reasoning/thinking tokens
  --json                          Alias for --output-format stream-json (or JSON subcommand output)
  --no-color                      Disable ANSI colors
  -v, --version                   Print CLI version
  -h, --help                      Show this help message

Interactive Slash Commands & Composer Shortcuts:
  /help /theme /login /logout /account /status /doctor /model /provider /effort /ultracode /orchestrator /mode
  /scene /context /config /usage /thinking /new /resume /retry /fork /rename /compact
  /export /cwd /init /mcp /plugin /skills /memory /permissions /policy /diff /undo /rewind /git
  /commit /fleet /preview /import /clear /exit
  Shift+Tab (cycle mode)  Ctrl+O (thinking)  Ctrl+G (editor)  Ctrl+L (clear)  /  @file  !cmd
`
}
