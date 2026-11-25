// Terminal colour effects: per-character gradients, a moving shine, heat colours for effort, and the
// Ultracode palette. Pure string builders (no I/O), so they behave the same on Windows, macOS and Linux:
// truecolor where the terminal has it, the nearest xterm-256 colour otherwise, plain text without colour.
import { CLI_THEMES, type CliPalette } from './theme.ts'

export type Rgb = readonly [number, number, number]

const WHITE: Rgb = [255, 255, 255]

/** Animation is skipped for dumb terminals, CI logs, non-TTY output, or when the user opts out. */
export function motionEnabled(stream?: NodeJS.WritableStream): boolean {
  const env = process.env
  if (env.ATRIUM_REDUCED_MOTION === '1' || env.ATRIUM_NO_ANIMATION === '1') return false
  if (env.CI || env.TERM === 'dumb') return false
  return stream ? Boolean((stream as NodeJS.WriteStream).isTTY) : true
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

/** Nearest colour in the xterm-256 6×6×6 cube. */
export function rgbTo256(rgb: Rgb): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  return 16 + 36 * level(rgb[0]) + 6 * level(rgb[1]) + level(rgb[2])
}

/** Wraps text in a foreground colour at the palette's depth; no-op without colour. */
export function paintRgb(text: string, rgb: Rgb, palette: CliPalette): string {
  if (!text || !palette.enabled || palette.colorDepth === 'none') return text
  // The minimal theme sticks to the basic 16 colours.
  if (palette.themeId === 'minimal') return palette.accent(text)
  const open =
    palette.colorDepth === 'truecolor' ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1b[38;5;${rgbTo256(rgb)}m`
  return `${open}${text}\x1b[39m`
}

type ToneKey = 'accent' | 'accentSoft' | 'yellow' | 'purple' | 'subtle' | 'border' | 'muted'

export function toneRgb(palette: CliPalette, key: ToneKey): Rgb {
  return CLI_THEMES[palette.themeId].tokens[key].rgb
}

/** Samples a multi-stop gradient at `t` (0..1). With `wrap`, the end blends back into the start. */
export function sampleStops(stops: readonly Rgb[], t: number, wrap = false): Rgb {
  const first = stops[0] ?? WHITE
  if (stops.length < 2) return first
  const ring = wrap ? [...stops, first] : stops
  const x = wrap ? ((t % 1) + 1) % 1 : Math.max(0, Math.min(1, t))
  const span = x * (ring.length - 1)
  const i = Math.min(ring.length - 2, Math.floor(span))
  return mixRgb(ring[i] ?? first, ring[i + 1] ?? first, span - i)
}

/** Ultracode's three colours: the theme accent, gold and violet (the desktop ring uses the same trio). */
export function ultraStops(palette: CliPalette): Rgb[] {
  return [toneRgb(palette, 'accent'), toneRgb(palette, 'yellow'), toneRgb(palette, 'purple')]
}

/** Effort heat: cool and quiet at `low`, the full accent at `max`. */
export function heatStops(palette: CliPalette): Rgb[] {
  const accent = toneRgb(palette, 'accent')
  return [mixRgb(toneRgb(palette, 'subtle'), toneRgb(palette, 'accentSoft'), 0.55), toneRgb(palette, 'accentSoft'), accent]
}

export interface GradientOptions {
  /** Shifts the gradient along the text; animate it for a flowing look. Requires `wrap`. */
  phase?: number
  /** Colours repeat around the text instead of running end to end. */
  wrap?: boolean
  /** Character index of a moving white highlight (fractional is fine); omit for none. */
  shine?: number
  /** Half-width of the highlight in characters. */
  shineWidth?: number
  bold?: boolean
}

/**
 * Colours each character along a gradient. Minimal theme and colourless palettes fall back to one tone,
 * so the visible text is always the same.
 */
export function gradientText(text: string, palette: CliPalette, stops: readonly Rgb[], opts: GradientOptions = {}): string {
  if (!text || !palette.enabled || palette.colorDepth === 'none') return text
  const bold = opts.bold ? palette.bold : (s: string) => s
  if (palette.themeId === 'minimal') return bold(palette.accent(text))
  const chars = Array.from(text)
  const n = Math.max(1, chars.length - 1)
  const width = opts.shineWidth ?? 2.2
  let out = ''
  chars.forEach((ch, i) => {
    if (ch === ' ') {
      out += ch
      return
    }
    const t = opts.wrap ? i / chars.length + (opts.phase ?? 0) : i / n
    let rgb = sampleStops(stops, t, opts.wrap)
    if (opts.shine !== undefined) {
      const d = Math.abs(i - opts.shine)
      if (d < width) rgb = mixRgb(rgb, WHITE, 0.75 * (1 - d / width))
    }
    out += paintRgb(ch, rgb, palette)
  })
  return bold(out)
}

/** Five ascending bars (one cell each, so always evenly spaced), lit up to `lit` along the heat colours. */
export function renderMeter(lit: number, palette: CliPalette): string {
  const bars = ['▁', '▂', '▄', '▆', '█']
  const heat = heatStops(palette)
  return bars
    .map((bar, i) => {
      if (i >= lit) return palette.border(bar)
      return palette.themeId === 'minimal' ? palette.accent(bar) : paintRgb(bar, sampleStops(heat, i / 4), palette)
    })
    .join('')
}

const SPARKS = ['✦', '✧', '✶', '✷', '✸', '✹'] as const

/** One frame of the Ultracode sparkle glyph. */
export function sparkFrame(tick: number): string {
  return SPARKS[((tick % SPARKS.length) + SPARKS.length) % SPARKS.length] ?? '✦'
}
