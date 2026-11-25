// Horizontal drag-style reasoning effort slider (← / → to move, u to toggle Ultracode) for the CLI.
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process'
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from '../shared/types.ts'
import {
  gradientText,
  heatStops,
  mixRgb,
  motionEnabled,
  paintRgb,
  renderMeter,
  sampleStops,
  sparkFrame,
  ultraStops,
} from './fx.ts'
import { createThemePalette, justifyRow, truncateVisible, type CliPalette } from './theme.ts'
import { getViewportForStream, type TerminalViewport } from './viewport.ts'

const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const FRAME_MS = 40
const MAX_SHINE_MS = 650
const ULTRA_INTRO_MS = 900

export const EFFORT_HINTS: Record<ReasoningEffort, string> = {
  auto: 'Model picks its own depth',
  low: 'Fastest, fewest tokens',
  medium: 'Balanced speed and depth',
  high: 'Deep reasoning for hard problems',
  xhigh: 'Extra depth for long agentic work',
  max: 'No limit on thinking (slowest, most tokens)',
}

export interface EffortSliderState {
  index: number
  ultracode: boolean
}

export type EffortSliderAction = 'move' | 'confirm' | 'cancel' | 'noop'

/** Applies one decoded key to the slider state. Pure, so tests can drive it without a TTY. */
export function applyEffortSliderKey(
  seq: string,
  state: EffortSliderState,
  count = REASONING_EFFORT_LEVELS.length,
): { state: EffortSliderState; action: EffortSliderAction } {
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i))
  const move = (index: number) => ({ state: { ...state, index: clamp(index) }, action: 'move' as const })
  switch (seq) {
    case '\x1b[D':
    case '\x1bOD':
    case 'h':
    case 'H':
    case '-':
      return move(state.index - 1)
    case '\x1b[C':
    case '\x1bOC':
    case 'l':
    case 'L':
    case '+':
    case '=':
      return move(state.index + 1)
    case '\x1b[H':
    case '\x1bOH':
    case '\x1b[1~':
      return move(0)
    case '\x1b[F':
    case '\x1bOF':
    case '\x1b[4~':
      return move(count - 1)
    case 'u':
    case 'U':
    case '\t':
      return { state: { ...state, ultracode: !state.ultracode }, action: 'move' }
    case '\r':
    case '\n':
    case '\r\n':
      return { state, action: 'confirm' }
    case '\x1b':
    case '\u0003':
    case 'q':
      return { state, action: 'cancel' }
    default:
      if (seq.length === 1 && seq >= '1' && seq <= '9') {
        const idx = Number(seq) - 1
        if (idx < count) return move(idx)
      }
      return { state, action: 'noop' }
  }
}

/** Animation state for one frame. Every field is optional: without it the slider draws still. */
export interface EffortSliderFx {
  /** Knob position in stops (fractional while it glides to the new stop). */
  knobPos?: number
  /** Frame counter that drives the Ultracode colour flow. */
  tick?: number
  /** 0..1 progress of the one-off shine that runs along the track when `max` is reached. */
  maxShine?: number
  /** Milliseconds since Ultracode was switched on; the workflow steps light up one by one. */
  ultraAge?: number
}

const ULTRA_STEPS = ['plan', 'explore', 'build', 'verify'] as const
const ULTRA_STEP_MS = 110

/** Draws the slider: title row, stop labels, a filled track with a knob, the level hint, the Ultracode row and key help. */
export function renderEffortSliderLines(
  state: EffortSliderState,
  palette: CliPalette,
  cols = 80,
  levels: readonly ReasoningEffort[] = REASONING_EFFORT_LEVELS,
  fx: EffortSliderFx = {},
): string[] {
  const boxW = Math.max(36, cols - 1)
  const trackW = Math.max(levels.length * 6, Math.min(boxW - 4, 72))
  const cell = Math.floor(trackW / levels.length)
  const width = cell * levels.length
  const centerOf = (i: number) => i * cell + Math.floor(cell / 2)
  const last = levels.length - 1
  const knobPos = Math.max(0, Math.min(last, fx.knobPos ?? state.index))
  const knobAt = Math.round(knobPos * cell + Math.floor(cell / 2))
  const level = levels[state.index] ?? 'auto'
  const heat = heatStops(palette)
  const tick = fx.tick ?? 0
  // Track colour depends on position, so the fill heats up as it reaches further right.
  const heatAt = (x: number) => sampleStops(heat, x / Math.max(1, width - 1))
  const shineX = fx.maxShine !== undefined ? -4 + fx.maxShine * (knobAt + 8) : undefined
  const fillColor = (x: number) => {
    const base = heatAt(x)
    if (shineX === undefined) return base
    const d = Math.abs(x - shineX)
    return d < 4 ? mixRgb(base, [255, 255, 255], 0.8 * (1 - d / 4)) : base
  }

  let labels = ''
  levels.forEach((lvl, i) => {
    const pad = Math.max(0, cell - lvl.length)
    const left = Math.floor(pad / 2)
    const text =
      i === state.index
        ? palette.bold(i === 0 ? palette.accent(lvl) : paintRgb(lvl, heatAt(centerOf(i)), palette))
        : i < state.index
          ? palette.muted(lvl)
          : palette.subtle(lvl)
    labels += `${' '.repeat(left)}${text}${' '.repeat(pad - left)}`
  })

  let track = ''
  for (let x = 0; x < width; x += 1) {
    const isStop = levels.some((_, i) => centerOf(i) === x)
    if (x === knobAt) {
      track += palette.bold(paintRgb('●', fillColor(x), palette))
    } else if (x < knobAt) {
      // Brighter cells right behind the knob read as a glow.
      const glow = knobAt - x <= 1 ? mixRgb(fillColor(x), [255, 255, 255], 0.25) : fillColor(x)
      track += paintRgb(isStop ? '┿' : '━', glow, palette)
    } else {
      track += palette.border(isStop ? '┼' : '─')
    }
  }

  const meter = state.index === 0 ? palette.muted('✧') : renderMeter(state.index, palette)
  const ultra = state.ultracode
    ? gradientText(`${sparkFrame(Math.floor(tick / 3))} ULTRACODE ON`, palette, ultraStops(palette), {
        wrap: true,
        phase: tick * 0.025,
        shine: (tick * 0.6) % 26 - 6,
        bold: true,
      })
    : palette.subtle('ultracode off')

  return [
    palette.border('─'.repeat(boxW)),
    justifyRow(` ${palette.bold('Reasoning effort')}  ${meter} ${palette.bold(level)}`, `${ultra} `, boxW),
    '',
    truncateVisible(`  ${labels}`, boxW),
    truncateVisible(`  ${track}`, boxW),
    truncateVisible(`  ${palette.muted(EFFORT_HINTS[level])}`, boxW),
    truncateVisible(`  ${renderUltraFlow(state.ultracode, palette, tick, fx.ultraAge)}`, boxW),
    truncateVisible(`  ${palette.subtle('←→ drag · 1-6 jump · u ultracode · Enter save · Esc cancel')}`, boxW),
  ]
}

/** `✦ plan › explore › build › verify`: steps appear one by one after switch-on, then a highlight keeps cycling. */
function renderUltraFlow(on: boolean, palette: CliPalette, tick: number, ageMs?: number): string {
  if (!on) return palette.subtle('u · plan, explore, build and verify with parallel subagents')
  const stops = ultraStops(palette)
  const shown = ageMs === undefined ? ULTRA_STEPS.length : Math.min(ULTRA_STEPS.length, Math.floor(ageMs / ULTRA_STEP_MS) + 1)
  const active = Math.floor(tick / 8) % ULTRA_STEPS.length
  const parts = ULTRA_STEPS.map((step, i) => {
    if (i >= shown) return palette.border('·'.repeat(step.length))
    const rgb = sampleStops(stops, i / (ULTRA_STEPS.length - 1))
    const bright = ageMs !== undefined && ageMs < ULTRA_STEP_MS * ULTRA_STEPS.length ? i === shown - 1 : i === active
    return bright ? palette.bold(paintRgb(step, mixRgb(rgb, [255, 255, 255], 0.35), palette)) : paintRgb(step, rgb, palette)
  })
  const glyph = gradientText(sparkFrame(Math.floor(tick / 3)), palette, stops, { wrap: true, phase: tick * 0.03 })
  return `${glyph} ${parts.join(` ${palette.subtle('›')} `)}`
}

export interface EffortSliderOptions {
  effort: ReasoningEffort
  ultracode: boolean
  palette?: CliPalette
  viewport?: TerminalViewport
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
}

/** Interactive slider. Resolves to the new values, or `null` when cancelled or not on a TTY. */
export async function selectEffortSlider(
  opts: EffortSliderOptions,
): Promise<{ effort: ReasoningEffort; ultracode: boolean } | null> {
  const input = (opts.stdin ?? defaultStdin) as NodeJS.ReadStream
  const output = (opts.stdout ?? defaultStdout) as NodeJS.WriteStream
  if (!input.isTTY || typeof input.setRawMode !== 'function') return null
  const viewport = opts.viewport ?? getViewportForStream(output)
  const useViewport = Boolean(viewport?.enabled)
  const rawOut = useViewport && viewport ? (viewport.rawStdout as NodeJS.WriteStream) : output
  const palette = opts.palette ?? createThemePalette(!process.env.NO_COLOR && Boolean(output.isTTY))
  const levels = REASONING_EFFORT_LEVELS
  let state: EffortSliderState = { index: Math.max(0, levels.indexOf(opts.effort)), ultracode: opts.ultracode }
  let renderedLines = 0
  const wasRaw = Boolean(input.isRaw)

  // Motion: the knob glides to its stop, a shine runs along the track at max, and the Ultracode row flows.
  const motion = palette.enabled && motionEnabled(rawOut)
  let knobPos = state.index
  let tick = 0
  let maxShineAt: number | null = null
  let ultraOnAt: number | null = null
  let timer: ReturnType<typeof setInterval> | undefined

  const fxNow = (): EffortSliderFx => {
    const now = Date.now()
    return {
      knobPos,
      tick,
      ...(maxShineAt !== null ? { maxShine: Math.min(1, (now - maxShineAt) / MAX_SHINE_MS) } : {}),
      ...(ultraOnAt !== null ? { ultraAge: now - ultraOnAt } : {}),
    }
  }
  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }
  const frame = () => {
    tick += 1
    const diff = state.index - knobPos
    knobPos = Math.abs(diff) < 0.05 ? state.index : knobPos + diff * 0.4
    const now = Date.now()
    if (maxShineAt !== null && now - maxShineAt > MAX_SHINE_MS) maxShineAt = null
    if (ultraOnAt !== null && now - ultraOnAt > ULTRA_INTRO_MS) ultraOnAt = null
    draw()
    if (knobPos === state.index && maxShineAt === null && !state.ultracode) stopTimer()
  }
  const kick = () => {
    if (!motion || timer) return
    timer = setInterval(frame, FRAME_MS)
    timer.unref?.()
  }

  const draw = () => {
    const lines = renderEffortSliderLines(state, palette, output.columns || 80, levels, fxNow())
    if (useViewport && viewport) {
      viewport.renderDock(lines, null)
      return
    }
    let seq = SYNC_BEGIN
    if (renderedLines > 0) seq += `\x1b[${renderedLines}A\r\x1b[0J`
    seq += `${lines.join('\n')}\n${SYNC_END}`
    output.write(seq)
    renderedLines = lines.length
  }
  const onResize = () => {
    if (useViewport && viewport) viewport.handleResize()
    draw()
  }

  rawOut.on?.('resize', onResize)
  rawOut.write('\x1b[?25l')
  input.setRawMode(true)
  input.resume()
  draw()
  if (state.ultracode) kick()

  return new Promise((resolve) => {
    let settled = false
    const finish = (confirmed: boolean) => {
      if (settled) return
      settled = true
      stopTimer()
      input.removeListener('data', onData)
      rawOut.off?.('resize', onResize)
      if (!wasRaw) {
        try {
          input.setRawMode(false)
        } catch {
          // Ignore restore failures on closed streams
        }
      }
      input.pause()
      const level = levels[state.index] ?? 'auto'
      const summary = confirmed
        ? `  ${palette.green('✓')} ${palette.muted('Reasoning effort')} ${palette.subtle('›')} ${palette.bold(level)}${
            state.ultracode ? ` ${gradientText('✦ ultracode', palette, ultraStops(palette), { bold: true })}` : ''
          }\n`
        : `  ${palette.subtle('× Reasoning effort › cancelled')}\n`
      if (useViewport && viewport) {
        const boxW = Math.max(36, (output.columns || 80) - 1)
        viewport.renderDock(['', palette.border('─'.repeat(boxW)), '  ', palette.border('─'.repeat(boxW)), `  ${palette.subtle('...')} `], null)
        rawOut.write('\x1b[?25h')
        viewport.writeTranscript(summary)
      } else {
        if (renderedLines > 0) output.write(`\x1b[${renderedLines}A\r\x1b[0J`)
        rawOut.write('\x1b[?25h')
        output.write(summary)
      }
      resolve(confirmed ? { effort: level, ultracode: state.ultracode } : null)
    }

    const onData = (chunk: Buffer) => {
      const raw = chunk.toString('utf8')
      let i = 0
      while (i < raw.length && !settled) {
        const esc = raw[i] === '\x1b' ? /^(?:\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z])/.exec(raw.slice(i)) : null
        const seq = esc ? esc[0] : String.fromCodePoint(raw.codePointAt(i) ?? 0)
        i += seq.length
        const prev = state
        const next = applyEffortSliderKey(seq, state, levels.length)
        state = next.state
        if (next.action === 'confirm') finish(true)
        else if (next.action === 'cancel') finish(false)
        else if (next.action === 'move') {
          if (!motion) knobPos = state.index
          if (motion && state.index === levels.length - 1 && prev.index !== state.index) maxShineAt = Date.now()
          if (motion && state.ultracode && !prev.ultracode) ultraOnAt = Date.now()
          draw()
          kick()
        }
      }
    }
    input.on('data', onData)
  })
}

/** Plain one-line slider for non-TTY output, e.g. `auto ─ low ─ [high] ─ xhigh ─ max`. */
export function formatEffortScale(effort: ReasoningEffort, levels: readonly ReasoningEffort[] = REASONING_EFFORT_LEVELS): string {
  return levels.map((l) => (l === effort ? `[${l}]` : l)).join(' ─ ')
}
