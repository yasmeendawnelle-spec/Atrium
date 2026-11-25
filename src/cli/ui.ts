// Terminal UI chrome: star/braille spinner, effort & progress gauges, Claude-Code hero header, and clean hairline cards.
import type { AgentMode, ReasoningEffort, WorkScene } from '../shared/types.ts'
import { gradientText, mixRgb, motionEnabled, paintRgb, sparkFrame, toneRgb, ultraStops } from './fx.ts'
import {
  padVisible,
  truncateVisible,
  visibleWidth,
  type CliPalette,
} from './theme.ts'

export interface Spinner {
  start: (label: string) => void
  update: (label: string) => void
  setMeta: (meta: string) => void
  stop: () => void
  succeed: (msg: string) => void
  fail: (msg: string) => void
  isActive: () => boolean
}

const STAR_FRAMES = ['✳', '✢', '✽', '✶', '✻', '·'] as const
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Animated star/braille spinner with elapsed timer, live metadata, and interrupt hint. */
export function createSpinner(opts: {
  stream: NodeJS.WritableStream
  palette: CliPalette
  enabled: boolean
  /** While it returns true, the label flows in the Ultracode colours with a moving shine. */
  ultracode?: () => boolean
}): Spinner {
  const { stream, palette, enabled } = opts
  const frames = palette.themeId === 'minimal' ? BRAILLE_FRAMES : STAR_FRAMES
  const motion = motionEnabled(stream)
  let timer: ReturnType<typeof setInterval> | null = null
  let frameIdx = 0
  let startedAt = 0
  let label = ''
  let metaText = ''

  const clearLine = () => {
    if (enabled) stream.write('\r\x1b[2K')
  }

  const draw = () => {
    if (!enabled) return
    const frame = frames[frameIdx % frames.length]!
    frameIdx += 1
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    const cols = Math.max(40, (stream as NodeJS.WriteStream).columns || 80)
    const ultra = opts.ultracode?.() === true
    let head = `${palette.accent(frame)} ${palette.bold(label)}`
    if (ultra) {
      const stops = ultraStops(palette)
      const f = motion ? frameIdx : 0
      const spark = gradientText(sparkFrame(Math.floor(f / 2)), palette, stops, { wrap: true, phase: f * 0.05 })
      const shine = motion ? (f * 0.7) % (label.length + 10) - 4 : undefined
      head = `${spark} ${gradientText(label, palette, stops, { wrap: true, phase: f * 0.03, bold: true, ...(shine !== undefined ? { shine } : {}) })}`
    }
    const left = `${head}${metaText ? ` ${palette.muted(metaText)}` : ''} ${palette.subtle(`(${elapsed}s)`)}`
    const hint = palette.subtle('esc / ctrl+c to interrupt')
    const full =
      visibleWidth(left) + visibleWidth(hint) + 3 < cols
        ? `${left}  ${palette.subtle('·')} ${hint}`
        : left
    stream.write(`\r\x1b[2K${truncateVisible(full, cols - 2)}`)
  }

  const stopTimer = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    start(nextLabel: string) {
      if (!enabled) return
      label = nextLabel
      metaText = ''
      if (!timer) {
        startedAt = Date.now()
        frameIdx = 0
        draw()
        timer = setInterval(draw, 95)
        timer.unref?.()
      } else {
        draw()
      }
    },
    update(nextLabel: string) {
      if (!enabled) return
      label = nextLabel
      if (!timer) {
        this.start(nextLabel)
      }
    },
    setMeta(nextMeta: string) {
      metaText = nextMeta.trim()
      if (enabled && timer) draw()
    },
    stop() {
      if (!timer) return
      stopTimer()
      clearLine()
    },
    succeed(msg: string) {
      stopTimer()
      metaText = ''
      if (enabled) clearLine()
      stream.write(`  ${palette.green('✓')} ${msg}\n`)
    },
    fail(msg: string) {
      stopTimer()
      metaText = ''
      if (enabled) clearLine()
      stream.write(`  ${palette.red('✗')} ${msg}\n`)
    },
    isActive() {
      return timer !== null
    },
  }
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.max(0, Math.round(tokens)))
}

export function formatEffortBadge(effort: ReasoningEffort, palette: CliPalette, ultracode = false): string {
  const base = formatEffortLevelBadge(effort, palette)
  return ultracode ? `${base} ${gradientText('✦ ultracode', palette, ultraStops(palette), { bold: true })}` : base
}

function formatEffortLevelBadge(effort: ReasoningEffort, palette: CliPalette): string {
  switch (effort) {
    case 'max':
      return `${palette.accent('◆')} ${palette.bold('max')}`
    case 'low':
      return `${palette.subtle('○')} ${palette.muted('low')}`
    case 'medium':
      return `${palette.muted('◐ medium')}`
    case 'high':
      return `${palette.accentSoft('●')} ${palette.muted('high')}`
    case 'xhigh':
      return `${palette.accent('◉')} ${palette.muted('xhigh')}`
    case 'auto':
    default:
      return `${palette.subtle('◌')} ${palette.muted('auto')}`
  }
}

export function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return `${Math.floor(diffDays / 30)}mo ago`
}

/** Color-coded visual context window usage gauge. */
export function renderProgressBar(ratio: number, width = 14, palette: CliPalette): string {
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  const filledCount = Math.round(clamped * width)
  const emptyCount = Math.max(0, width - filledCount)
  const useModernGlyphs = palette.enabled && palette.themeId !== 'minimal'
  const fillChar = useModernGlyphs ? '▰' : '█'
  const emptyChar = useModernGlyphs ? '▱' : '░'
  const filledStr = fillChar.repeat(filledCount)
  const emptyStr = emptyChar.repeat(emptyCount)
  const colorFn =
    clamped >= 0.85 ? palette.red : clamped >= 0.65 ? palette.yellow : palette.green
  const pct = Math.round(clamped * 100)
  return `${palette.border('[')}${colorFn(filledStr)}${palette.subtle(`${emptyStr}`)}${palette.border(']')} ${pct}%`
}

export interface FramedCardOptions {
  title: string
  badge?: string
  lines: readonly string[]
  footer?: string
  cols?: number
  maxWidth?: number
  palette: CliPalette
  borderColor?: (s: string) => string
}

/** Open top/bottom-hairline card used across /status, /doctor, /usage, /diff, and approvals. */
export function renderFramedCard(opts: FramedCardOptions): string {
  const { palette } = opts
  const border = opts.borderColor ?? palette.border
  const termCols = Math.max(44, opts.cols ?? (process.stdout as NodeJS.WriteStream).columns ?? 90)
  const ruleW = Math.max(36, Math.min(opts.maxWidth ?? 100, termCols - 2))

  const badgePart = opts.badge ? ` ${palette.subtle(`(${opts.badge})`)} ` : ''
  const titleRun = `── ${palette.bold(opts.title)} `
  const maxTitleW = Math.max(12, ruleW - visibleWidth(badgePart) - 4)
  const fittedTitle = visibleWidth(titleRun) <= maxTitleW ? titleRun : truncateVisible(titleRun, maxTitleW)
  const topFill = Math.max(2, ruleW - visibleWidth(fittedTitle) - visibleWidth(badgePart))
  const topRule = `${border('──')}${fittedTitle.slice(2)}${border('─'.repeat(topFill))}${badgePart}`

  const out: string[] = [topRule]
  for (const line of opts.lines) {
    if (line === '---') {
      out.push(border('─'.repeat(Math.min(72, ruleW))))
      continue
    }
    out.push(truncateVisible(`  ${line}`, ruleW))
  }

  if (opts.footer) {
    const fRun = `── ${palette.subtle(opts.footer)} `
    const fittedFooter = visibleWidth(fRun) <= ruleW - 2 ? fRun : truncateVisible(fRun, ruleW - 2)
    const botFill = Math.max(1, ruleW - visibleWidth(fittedFooter))
    out.push(`${border('──')}${fittedFooter.slice(2)}${border('─'.repeat(botFill))}`)
  } else {
    out.push(border('─'.repeat(ruleW)))
  }
  return out.join('\n')
}

export interface WelcomeScreenOptions {
  version: string
  model?: string
  providerName?: string
  protocol?: string
  mode: AgentMode
  scene: WorkScene
  effort: ReasoningEffort
  ultracode?: boolean
  workspace: string
  accountLabel: string
  userName?: string
  mcpConnected: number
  mcpTotal: number
  skillCount: number
  pluginCount?: number
  instructionFiles?: string[]
  recentSessions?: Array<{ title: string; updatedAt: number; messageCount?: number }>
  themeName?: string
  gitBranch?: string
  gitDirty?: number
  contextUsed: number
  contextLimit: number
  cols: number
  palette: CliPalette
}

/** Updates the terminal window / tab title via OSC 0 when stdout is a TTY. */
export function setTerminalTitle(stream: NodeJS.WritableStream, title: string): void {
  if (!(stream as NodeJS.WriteStream).isTTY) return
  // Strip control sequences so user workspace names cannot inject OSC escapes.
  // eslint-disable-next-line no-control-regex
  const safe = title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 96)
  stream.write(`\x1b]0;${safe}\x07`)
}

interface EmblemColorSpec {
  readonly rgb: readonly [number, number, number]
  readonly c256: number
}

type EmblemColorMap = Readonly<Record<string, EmblemColorSpec>>

// 14x14 pixel mask rasterized from build/icon.svg (5x5 supersampling of the real paths): three hexagonal
// arms with their 120-degree gaps, around the three-facet crystal. Two pixel rows share one terminal row
// through half blocks, so it draws as 14 columns x 7 rows with square pixels.
const ATRIUM_EMBLEM_GRID: readonly string[] = [
  '......11......',
  '....111112....',
  '....1111222...',
  '.555.....2222.',
  '.555......222.',
  '.65...LR...2..',
  '.66..LLRR.....',
  '.66..LDDR..43.',
  '.66..DDDD..33.',
  '.666..DD..333.',
  '.6666....3333.',
  '...66.33333...',
  '......3333....',
  '......33......',
]

const EMBLEM_TERRACOTTA_PALETTE: EmblemColorMap = {
  '1': { rgb: [247, 183, 150], c256: 216 },
  '2': { rgb: [228, 133, 96], c256: 173 },
  '3': { rgb: [220, 117, 79], c256: 173 },
  '4': { rgb: [189, 88, 54], c256: 167 },
  '5': { rgb: [175, 76, 45], c256: 130 },
  '6': { rgb: [154, 63, 35], c256: 130 },
  L: { rgb: [253, 225, 207], c256: 224 },
  R: { rgb: [220, 115, 78], c256: 173 },
  D: { rgb: [154, 61, 34], c256: 130 },
}

const EMBLEM_CODEX_PALETTE: EmblemColorMap = {
  '1': { rgb: [188, 224, 255], c256: 153 },
  '2': { rgb: [132, 194, 255], c256: 111 },
  '3': { rgb: [102, 179, 255], c256: 75 },
  '4': { rgb: [72, 142, 224], c256: 68 },
  '5': { rgb: [58, 116, 192], c256: 67 },
  '6': { rgb: [46, 94, 162], c256: 61 },
  L: { rgb: [232, 245, 255], c256: 195 },
  R: { rgb: [108, 180, 250], c256: 75 },
  D: { rgb: [52, 102, 172], c256: 61 },
}

const EMBLEM_AGY_PALETTE: EmblemColorMap = {
  '1': { rgb: [206, 184, 255], c256: 183 },
  '2': { rgb: [164, 158, 255], c256: 141 },
  '3': { rgb: [124, 156, 255], c256: 105 },
  '4': { rgb: [94, 122, 228], c256: 69 },
  '5': { rgb: [82, 98, 196], c256: 62 },
  '6': { rgb: [68, 78, 168], c256: 61 },
  L: { rgb: [238, 232, 255], c256: 189 },
  R: { rgb: [134, 158, 255], c256: 105 },
  D: { rgb: [72, 82, 172], c256: 61 },
}

function getEmblemPalette(palette: CliPalette): EmblemColorMap {
  if (palette.themeId === 'codex') return EMBLEM_CODEX_PALETTE
  if (palette.themeId === 'agy') return EMBLEM_AGY_PALETTE
  return EMBLEM_TERRACOTTA_PALETTE
}

function emblemFg(spec: EmblemColorSpec, palette: CliPalette): string {
  if (palette.colorDepth === 'truecolor') {
    return `\x1b[38;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}m`
  }
  return `\x1b[38;5;${spec.c256}m`
}

function emblemBg(spec: EmblemColorSpec, palette: CliPalette): string {
  if (palette.colorDepth === 'truecolor') {
    return `\x1b[48;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}m`
  }
  return `\x1b[48;5;${spec.c256}m`
}

function isCrystalToken(ch: string): boolean {
  return ch === 'L' || ch === 'R' || ch === 'D'
}

/** Renders the 5-row multi-tone Atrium interlocking hexagon + faceted crystal emblem. */
export function renderAtriumEmblem(palette: CliPalette): string[] {
  const colors = getEmblemPalette(palette)
  const rows: string[] = []
  const width = ATRIUM_EMBLEM_GRID[0]?.length ?? 10

  for (let r = 0; r < ATRIUM_EMBLEM_GRID.length; r += 2) {
    const topRow = ATRIUM_EMBLEM_GRID[r] ?? ''
    const botRow = ATRIUM_EMBLEM_GRID[r + 1] ?? ''
    let line = ''

    for (let c = 0; c < width; c += 1) {
      const top = topRow[c] ?? '.'
      const bot = botRow[c] ?? '.'
      const hasTop = top !== '.'
      const hasBot = bot !== '.'

      if (!hasTop && !hasBot) {
        line += ' '
        continue
      }

      const block = hasTop && hasBot ? '█' : hasTop ? '▀' : '▄'
      if (!palette.enabled) {
        line += block
        continue
      }

      if (palette.themeId === 'minimal') {
        const useCrystal = isCrystalToken(top) || isCrystalToken(bot)
        line += useCrystal ? palette.yellow(block) : palette.accent(block)
        continue
      }

      const topSpec = hasTop ? colors[top] : undefined
      const botSpec = hasBot ? colors[bot] : undefined

      if (topSpec && botSpec) {
        if (top === bot) {
          line += `${emblemFg(topSpec, palette)}█\x1b[39m`
        } else {
          line += `${emblemFg(topSpec, palette)}${emblemBg(botSpec, palette)}▀\x1b[39;49m`
        }
      } else if (topSpec) {
        line += `${emblemFg(topSpec, palette)}▀\x1b[39m`
      } else if (botSpec) {
        line += `${emblemFg(botSpec, palette)}▄\x1b[39m`
      } else {
        line += block
      }
    }

    rows.push(line)
  }

  return rows
}

const WELCOME_TAGLINE = 'AI agent workbench for your terminal'
const WELCOME_BOX_MAX = 92
const WELCOME_BOX_MIN_COLS = 60

const MODE_LABELS: Record<AgentMode, string> = {
  auto: 'auto mode',
  manual: 'manual mode',
  accept_edits: 'accept-edits mode',
  plan: 'plan mode',
  bypass: 'bypass mode',
}

/**
 * Welcome hero: the prism emblem beside the session facts, in a rounded card, with a row of starter
 * keys underneath. Under 60 columns the card and emblem drop away and only the facts remain.
 */
export function renderWelcomeScreen(opts: WelcomeScreenOptions): string {
  const { palette, cols } = opts
  const maxW = Math.max(40, cols - 2)

  const title = `${gradientText('Atrium', palette, [toneRgb(palette, 'accentSoft'), toneRgb(palette, 'accent')], {
    bold: true,
  })} ${palette.subtle(`v${opts.version}`)}`
  const modelLine = opts.model
    ? `${palette.green('●')} ${palette.muted('Using')} ${palette.bold(opts.model)} ${palette.muted(
        `(${opts.providerName ?? 'Atrium'}) · /model`,
      )}`
    : `${palette.yellow('○')} ${palette.yellow('No active model · Run /login or /provider add')}`
  const git = opts.gitBranch
    ? `  ${palette.subtle('git:')}${palette.cyan(opts.gitBranch)}${opts.gitDirty ? palette.yellow(`*${opts.gitDirty}`) : ''}`
    : ''
  const workspaceLine = `${palette.accent('▸')} ${palette.muted(opts.workspace)}${git}`
  const profileLine = `${formatEffortBadge(opts.effort, palette, opts.ultracode === true)} ${palette.subtle('·')} ${palette.muted(
    MODE_LABELS[opts.mode] ?? `${opts.mode} mode`,
  )}`

  const key = (k: string, label: string) => `${palette.accent(k)} ${palette.subtle(label)}`
  // Keep whole hints only: drop the tail ones on narrow terminals instead of cutting one in half.
  let tips = ''
  for (const tip of [key('/help', 'commands'), key('/model', 'models'), key('/effort', 'thinking'), key('@', 'files'), key('!', 'shell')]) {
    const next = tips ? `${tips}   ${tip}` : tip
    if (visibleWidth(next) + 2 > maxW) break
    tips = next
  }
  const footer: string[] = [`  ${tips}`]
  if (opts.instructionFiles && opts.instructionFiles.length > 0) {
    footer.push(truncateVisible(`  ${palette.subtle(`Loaded ${opts.instructionFiles.join(', ')} · /init`)}`, maxW))
  }

  if (cols < WELCOME_BOX_MIN_COLS) {
    const facts = [title, modelLine, workspaceLine, profileLine].map((l) => truncateVisible(` ${l}`, maxW))
    return ['', ...facts, '', ...footer, ''].join('\n')
  }

  // Emblem rows and fact rows line up one to one; blank fact rows keep the text centred on the prism.
  const emblem = renderAtriumEmblem(palette)
  const facts = ['', title, palette.muted(WELCOME_TAGLINE), '', modelLine, workspaceLine, profileLine]
  const boxW = Math.min(maxW, WELCOME_BOX_MAX)
  const innerW = boxW - 2
  const emblemW = visibleWidth(emblem[0] ?? '')
  const factW = Math.max(8, innerW - 3 - emblemW - 4)
  const frameRgb =
    palette.enabled && palette.themeId !== 'minimal' ? mixRgb(toneRgb(palette, 'border'), toneRgb(palette, 'accent'), 0.3) : null
  const frame = (s: string) => (frameRgb ? paintRgb(s, frameRgb, palette) : palette.border(s))

  const rows = emblem.map((art, i) => {
    const body = `   ${art}    ${truncateVisible(facts[i] ?? '', factW)}`
    return `${frame('│')}${padVisible(body, innerW)}${frame('│')}`
  })
  return [
    '',
    frame(`╭${'─'.repeat(innerW)}╮`),
    ...rows,
    frame(`╰${'─'.repeat(innerW)}╯`),
    '',
    ...footer,
    '',
  ].join('\n')
}

export interface StatusBarOptions {
  model?: string
  mode: AgentMode
  effort: ReasoningEffort
  gitBranch?: string
  gitDirty?: number
  contextUsed: number
  contextLimit: number
  cols: number
  palette: CliPalette
}

/** Compact one-line status strip rendered directly above fallback prompts. */
export function renderStatusBar(opts: StatusBarOptions): string {
  const { palette, cols } = opts
  const dot = opts.model ? palette.green('●') : palette.yellow('○')
  const parts: string[] = [
    `${dot} ${opts.model ? palette.bold(opts.model) : palette.yellow('no model')}`,
    `effort:${opts.effort}`,
    opts.mode,
  ]
  if (opts.gitBranch) {
    parts.push(`${opts.gitBranch}${opts.gitDirty ? `*${opts.gitDirty}` : ''}`)
  }
  const pct = opts.contextLimit > 0 ? Math.min(100, Math.round((opts.contextUsed / opts.contextLimit) * 100)) : 0
  parts.push(`ctx ${formatCompactTokens(opts.contextUsed)}/${formatCompactTokens(opts.contextLimit)} (${pct}%)`)
  return truncateVisible(`  ${palette.subtle(parts.join(' · '))}`, Math.max(32, cols - 2))
}

/** Clean Claude-Code-style hairline interactive CLI reference printed by `/help`. */
export function renderHelpCard(palette: CliPalette, cols?: number): string {
  const sec = (title: string) => palette.accent(palette.bold(title))
  const cmd = (name: string, desc: string, pad = 16) => `  ${palette.cyan(name.padEnd(pad))} ${palette.muted(desc)}`

  const sessionSection = [
    sec('Session & Chat'),
    cmd('/new', 'Start a new conversation'),
    cmd('/resume [id]', 'Search & resume saved chat'),
    cmd('/retry', 'Regenerate last reply'),
    cmd('/fork [name]', 'Branch conversation history'),
    cmd('/rename <title>', 'Rename active conversation'),
    cmd('/compact', 'Summarize old turns'),
    cmd('/export [path]', 'Save Markdown transcript'),
    cmd('/clear, /exit', 'Clear screen or quit CLI'),
  ]

  const modelSection = [
    sec('Model, Auth & UI'),
    cmd('/theme [id]', 'Switch CLI theme (live)'),
    cmd('/model [id]', 'Searchable model picker'),
    cmd('/provider', 'Add, test, or switch BYOK'),
    cmd('/effort [lvl]', 'Slider: auto…xhigh|max'),
    cmd('/ultracode', 'Toggle multi-agent workflows'),
    cmd('/mode <name>', 'auto|accept_edits|plan|man'),
    cmd('/scene <kind>', 'Switch code or work focus'),
    cmd('/context <n>', 'Context cap (auto, 128k)'),
    cmd('/login /logout', 'Manage Atrium Cloud auth'),
    cmd('/account', 'Plan balance & sync models'),
    cmd('/usage', 'Context meter & spend card'),
  ]

  const toolsSection = [
    sec('Workspace, Git & Tools'),
    cmd('/cwd <dir>', 'Switch workspace folder'),
    cmd('/diff', 'Line-numbered git diffs'),
    cmd('/undo, /rewind', 'Revert turn & file edits'),
    cmd('/git [branch]', 'Git status or branch menu'),
    cmd('/commit [msg]', 'Stage & commit changes'),
    cmd('/mcp [add]', 'Manage & OAuth MCP servers'),
    cmd('/plugin', 'Browse & import plugins'),
    cmd('/skills', 'Browse & toggle skills'),
    cmd('/memory', 'Inspect or edit memories'),
    cmd('/init', 'Create/update AGENTS.md'),
    cmd('/doctor', 'CLI & Git health check'),
    cmd('/status', 'Active model & MCP card'),
    cmd('/config', 'Runtime safety settings'),
    cmd('/permissions', 'View/clear allow rules'),
  ]

  const keysSection = [
    sec('Composer Shortcuts'),
    cmd('?', 'Toggle shortcuts drawer'),
    cmd('Shift+Tab', 'Cycle permission mode'),
    cmd('Ctrl+O', 'Toggle thinking stream'),
    cmd('Ctrl+G', 'Open draft in $EDITOR'),
    cmd('Ctrl+L', 'Clear & redraw header'),
    cmd('/ and @file', 'Search commands or files'),
    cmd('!command', 'Run shell cmd in workspace'),
    cmd('Alt+Enter / \\', 'Insert multi-line newline'),
  ]

  const termCols = Math.max(48, cols ?? (process.stdout as NodeJS.WriteStream).columns ?? 100)
  let bodyLines: string[]
  if (termCols >= 100) {
    const colW = Math.floor((Math.min(104, termCols - 4) - 3) / 2)
    const leftCol = [...sessionSection, '', ...keysSection]
    const rightCol = [...modelSection, '', ...toolsSection]
    const count = Math.max(leftCol.length, rightCol.length)
    bodyLines = []
    for (let i = 0; i < count; i += 1) {
      const l = padVisible(leftCol[i] ?? '', colW)
      const r = rightCol[i] ?? ''
      bodyLines.push(`${l} ${palette.border('│')} ${r}`)
    }
  } else {
    bodyLines = [...sessionSection, '', ...modelSection, '', ...toolsSection, '', ...keysSection]
  }

  return renderFramedCard({
    title: 'Atrium CLI Reference',
    badge: '/help',
    lines: bodyLines,
    footer: 'Tip: Press ? on empty prompt for shortcuts · Tab in / or @ menu',
    cols: termCols,
    maxWidth: 106,
    palette,
  })
}
