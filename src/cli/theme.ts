// Cross-platform truecolor / 256-color CLI theme system, ANSI width helpers, and surface painters.
import { CLI_THEME_IDS, type CliThemeId } from '../shared/types.ts'

export { CLI_THEME_IDS, type CliThemeId }

export type CliColorDepth = 'none' | '256' | 'truecolor'
export type CliPillTone = 'accent' | 'green' | 'yellow' | 'red' | 'cyan' | 'purple' | 'muted'

// eslint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g

/** Strips ANSI SGR color sequences to measure visible length accurately. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_RE, '')
}

export function charDisplayWidth(cp: number): number {
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      cp >= 0x1f300)
  ) {
    return 2
  }
  return 1
}

/** Measures terminal display width ignoring ANSI SGR escape sequences. */
export function visibleWidth(text: string): number {
  const plain = stripAnsi(text)
  let width = 0
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0
    width += charDisplayWidth(cp)
  }
  return width
}

/** Truncates ANSI-styled text so a rendered row never wraps past terminal columns. */
export function truncateVisible(text: string, maxCols: number): string {
  if (maxCols <= 0) return ''
  if (maxCols <= 2 || visibleWidth(text) <= maxCols) return text
  const target = maxCols - 1
  let out = ''
  let used = 0
  let i = 0
  let hasAnsi = false
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(text.slice(i))
      if (match) {
        out += match[0]
        hasAnsi = true
        i += match[0].length
        continue
      }
    }
    const cp = text.codePointAt(i) ?? 0
    const ch = String.fromCodePoint(cp)
    const w = charDisplayWidth(cp)
    if (used + w > target) break
    out += ch
    used += w
    i += ch.length
  }
  return `${out}…${hasAnsi ? '\x1b[0m' : ''}`
}

/** Truncates and right-pads ANSI-styled text to an exact terminal column width. */
export function padVisible(text: string, targetWidth: number): string {
  if (targetWidth <= 0) return ''
  const truncated = truncateVisible(text, targetWidth)
  const diff = Math.max(0, targetWidth - visibleWidth(truncated))
  return `${truncated}${' '.repeat(diff)}`
}

/** Builds a clean two-sided row (`left` on left edge, `right` flush on right edge). */
export function justifyRow(left: string, right: string, totalWidth: number): string {
  if (totalWidth <= 0) return ''
  const rightW = visibleWidth(right)
  if (rightW === 0) return padVisible(left, totalWidth)
  if (rightW >= totalWidth) return truncateVisible(right, totalWidth)
  const maxLeft = Math.max(0, totalWidth - rightW - 1)
  const fittedLeft = truncateVisible(left, maxLeft)
  const gap = Math.max(1, totalWidth - visibleWidth(fittedLeft) - rightW)
  return `${fittedLeft}${' '.repeat(gap)}${right}`
}

interface ColorSpec {
  rgb: readonly [number, number, number]
  c256: number
}

export interface CliThemeMeta {
  id: CliThemeId
  name: string
  description: string
  hasSurface: boolean
  tokens: {
    accent: ColorSpec
    accentSoft: ColorSpec
    border: ColorSpec
    bgSurface: ColorSpec | null
    bgActive: ColorSpec | null
    bgCode: ColorSpec | null
    bgDiffAdd: ColorSpec | null
    bgDiffDel: ColorSpec | null
    green: ColorSpec
    red: ColorSpec
    yellow: ColorSpec
    cyan: ColorSpec
    blue: ColorSpec
    purple: ColorSpec
    muted: ColorSpec
    subtle: ColorSpec
    synKeyword: ColorSpec
    synString: ColorSpec
    synComment: ColorSpec
    synNumber: ColorSpec
    synType: ColorSpec
    synFunc: ColorSpec
  }
}

export const CLI_THEMES: Record<CliThemeId, CliThemeMeta> = {
  'warm-studio': {
    id: 'warm-studio',
    name: 'Warm Studio',
    description: 'Atrium terracotta clay on warm charcoal surfaces',
    hasSurface: true,
    tokens: {
      accent: { rgb: [217, 119, 87], c256: 173 },
      accentSoft: { rgb: [229, 166, 140], c256: 180 },
      border: { rgb: [72, 72, 76], c256: 239 },
      bgSurface: { rgb: [34, 34, 36], c256: 235 },
      bgActive: { rgb: [48, 48, 52], c256: 237 },
      bgCode: { rgb: [26, 26, 28], c256: 234 },
      bgDiffAdd: { rgb: [20, 46, 30], c256: 22 },
      bgDiffDel: { rgb: [54, 22, 26], c256: 52 },
      green: { rgb: [111, 207, 151], c256: 78 },
      red: { rgb: [235, 111, 111], c256: 203 },
      yellow: { rgb: [230, 185, 108], c256: 179 },
      cyan: { rgb: [121, 192, 230], c256: 116 },
      blue: { rgb: [122, 162, 247], c256: 111 },
      purple: { rgb: [196, 155, 255], c256: 141 },
      muted: { rgb: [158, 158, 164], c256: 247 },
      subtle: { rgb: [112, 112, 118], c256: 243 },
      synKeyword: { rgb: [217, 138, 188], c256: 175 },
      synString: { rgb: [152, 195, 121], c256: 114 },
      synComment: { rgb: [116, 116, 122], c256: 243 },
      synNumber: { rgb: [224, 159, 108], c256: 173 },
      synType: { rgb: [229, 192, 123], c256: 180 },
      synFunc: { rgb: [121, 192, 230], c256: 116 },
    },
  },
  claude: {
    id: 'claude',
    name: 'Claude Coral',
    description: 'Warm coral clay accent with cool dark slate panels',
    hasSurface: true,
    tokens: {
      accent: { rgb: [218, 119, 86], c256: 173 },
      accentSoft: { rgb: [234, 164, 138], c256: 180 },
      border: { rgb: [72, 74, 80], c256: 239 },
      bgSurface: { rgb: [34, 35, 38], c256: 235 },
      bgActive: { rgb: [48, 50, 56], c256: 237 },
      bgCode: { rgb: [26, 27, 30], c256: 234 },
      bgDiffAdd: { rgb: [19, 44, 30], c256: 22 },
      bgDiffDel: { rgb: [52, 23, 27], c256: 52 },
      green: { rgb: [126, 231, 135], c256: 114 },
      red: { rgb: [255, 123, 114], c256: 203 },
      yellow: { rgb: [240, 194, 112], c256: 221 },
      cyan: { rgb: [130, 196, 238], c256: 117 },
      blue: { rgb: [137, 180, 250], c256: 111 },
      purple: { rgb: [203, 166, 247], c256: 183 },
      muted: { rgb: [158, 162, 170], c256: 247 },
      subtle: { rgb: [112, 116, 124], c256: 243 },
      synKeyword: { rgb: [235, 138, 164], c256: 175 },
      synString: { rgb: [158, 206, 136], c256: 114 },
      synComment: { rgb: [122, 128, 140], c256: 243 },
      synNumber: { rgb: [232, 162, 110], c256: 173 },
      synType: { rgb: [238, 198, 130], c256: 222 },
      synFunc: { rgb: [137, 180, 250], c256: 111 },
    },
  },
  codex: {
    id: 'codex',
    name: 'Codex Ice',
    description: 'Crisp monochrome steel & electric sky blue',
    hasSurface: true,
    tokens: {
      accent: { rgb: [102, 179, 255], c256: 75 },
      accentSoft: { rgb: [168, 212, 255], c256: 153 },
      border: { rgb: [68, 76, 88], c256: 239 },
      bgSurface: { rgb: [30, 34, 42], c256: 235 },
      bgActive: { rgb: [44, 52, 66], c256: 237 },
      bgCode: { rgb: [24, 27, 34], c256: 234 },
      bgDiffAdd: { rgb: [18, 46, 33], c256: 22 },
      bgDiffDel: { rgb: [54, 22, 28], c256: 52 },
      green: { rgb: [102, 217, 152], c256: 78 },
      red: { rgb: [255, 118, 122], c256: 203 },
      yellow: { rgb: [242, 201, 108], c256: 221 },
      cyan: { rgb: [110, 214, 240], c256: 81 },
      blue: { rgb: [102, 179, 255], c256: 75 },
      purple: { rgb: [192, 158, 255], c256: 141 },
      muted: { rgb: [174, 182, 194], c256: 249 },
      subtle: { rgb: [116, 125, 138], c256: 243 },
      synKeyword: { rgb: [102, 179, 255], c256: 75 },
      synString: { rgb: [134, 218, 162], c256: 114 },
      synComment: { rgb: [116, 125, 138], c256: 243 },
      synNumber: { rgb: [242, 178, 102], c256: 215 },
      synType: { rgb: [168, 212, 255], c256: 153 },
      synFunc: { rgb: [110, 214, 240], c256: 81 },
    },
  },
  agy: {
    id: 'agy',
    name: 'AGY Cobalt',
    description: 'Vibrant cobalt-violet gradient on deep obsidian',
    hasSurface: true,
    tokens: {
      accent: { rgb: [124, 156, 255], c256: 105 },
      accentSoft: { rgb: [180, 154, 255], c256: 141 },
      border: { rgb: [74, 78, 105], c256: 60 },
      bgSurface: { rgb: [29, 31, 41], c256: 235 },
      bgActive: { rgb: [44, 48, 66], c256: 237 },
      bgCode: { rgb: [23, 25, 34], c256: 234 },
      bgDiffAdd: { rgb: [19, 45, 34], c256: 22 },
      bgDiffDel: { rgb: [54, 23, 30], c256: 52 },
      green: { rgb: [114, 224, 168], c256: 78 },
      red: { rgb: [247, 118, 142], c256: 204 },
      yellow: { rgb: [224, 175, 104], c256: 179 },
      cyan: { rgb: [125, 207, 255], c256: 117 },
      blue: { rgb: [124, 156, 255], c256: 105 },
      purple: { rgb: [187, 154, 247], c256: 141 },
      muted: { rgb: [169, 177, 214], c256: 249 },
      subtle: { rgb: [115, 122, 162], c256: 60 },
      synKeyword: { rgb: [187, 154, 247], c256: 141 },
      synString: { rgb: [158, 206, 106], c256: 149 },
      synComment: { rgb: [115, 122, 162], c256: 60 },
      synNumber: { rgb: [255, 158, 100], c256: 209 },
      synType: { rgb: [125, 207, 255], c256: 117 },
      synFunc: { rgb: [122, 162, 247], c256: 111 },
    },
  },
  minimal: {
    id: 'minimal',
    name: 'Minimal ANSI',
    description: 'Transparent 16-color palette with no background fills',
    hasSurface: false,
    tokens: {
      accent: { rgb: [217, 119, 87], c256: 173 },
      accentSoft: { rgb: [229, 166, 140], c256: 180 },
      border: { rgb: [128, 128, 128], c256: 244 },
      bgSurface: null,
      bgActive: null,
      bgCode: null,
      bgDiffAdd: null,
      bgDiffDel: null,
      green: { rgb: [80, 200, 120], c256: 34 },
      red: { rgb: [220, 80, 80], c256: 160 },
      yellow: { rgb: [220, 180, 70], c256: 178 },
      cyan: { rgb: [80, 190, 220], c256: 38 },
      blue: { rgb: [90, 145, 240], c256: 33 },
      purple: { rgb: [185, 130, 240], c256: 141 },
      muted: { rgb: [160, 160, 160], c256: 247 },
      subtle: { rgb: [118, 118, 118], c256: 243 },
      synKeyword: { rgb: [195, 120, 220], c256: 176 },
      synString: { rgb: [90, 190, 110], c256: 34 },
      synComment: { rgb: [125, 125, 125], c256: 243 },
      synNumber: { rgb: [215, 145, 80], c256: 173 },
      synType: { rgb: [220, 180, 85], c256: 178 },
      synFunc: { rgb: [90, 175, 225], c256: 38 },
    },
  },
}

export interface CliPalette {
  enabled: boolean
  themeId: CliThemeId
  colorDepth: CliColorDepth
  accent: (s: string) => string
  accentSoft: (s: string) => string
  bold: (s: string) => string
  dim: (s: string) => string
  italic: (s: string) => string
  underline: (s: string) => string
  strike: (s: string) => string
  green: (s: string) => string
  red: (s: string) => string
  yellow: (s: string) => string
  cyan: (s: string) => string
  blue: (s: string) => string
  purple: (s: string) => string
  muted: (s: string) => string
  subtle: (s: string) => string
  border: (s: string) => string
  synKeyword: (s: string) => string
  synString: (s: string) => string
  synComment: (s: string) => string
  synNumber: (s: string) => string
  synType: (s: string) => string
  synFunc: (s: string) => string
  bgCode: (s: string) => string
  pill: (text: string, tone?: CliPillTone) => string
  surfaceLine: (content: string, width: number) => string
  activeLine: (content: string, width: number) => string
  codeLine: (content: string, width: number) => string
  diffAddLine: (content: string, width: number) => string
  diffDelLine: (content: string, width: number) => string
}

/** Detects whether the active terminal supports 24-bit Truecolor or 256-color SGR escapes. */
export function detectColorDepth(): CliColorDepth {
  if (process.env.NO_COLOR) return 'none'
  const colorTerm = process.env.COLORTERM ?? ''
  if (/truecolor|24bit/i.test(colorTerm)) return 'truecolor'
  if (process.env.WT_SESSION) return 'truecolor'
  const termProgram = process.env.TERM_PROGRAM ?? ''
  if (/iTerm|WezTerm|vscode|ghostty|Warp|Hyper/i.test(termProgram)) return 'truecolor'
  return '256'
}

export function normalizeCliTheme(raw?: string): CliThemeId {
  const clean = raw?.trim().toLowerCase()
  if (clean && (CLI_THEME_IDS as readonly string[]).includes(clean)) {
    return clean as CliThemeId
  }
  return 'warm-studio'
}

function fgCode(spec: ColorSpec, depth: CliColorDepth): string {
  if (depth === 'truecolor') {
    return `\x1b[38;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}m`
  }
  return `\x1b[38;5;${spec.c256}m`
}

function bgCodeSeq(spec: ColorSpec, depth: CliColorDepth): string {
  if (depth === 'truecolor') {
    return `\x1b[48;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}m`
  }
  return `\x1b[48;5;${spec.c256}m`
}

function wrapFg(spec: ColorSpec, depth: CliColorDepth, basicOpen?: string): (s: string) => string {
  const open = basicOpen ?? fgCode(spec, depth)
  return (s: string) => (s ? `${open}${s}\x1b[39m` : s)
}

function wrapAttr(open: string, close: string): (s: string) => string {
  return (s: string) => (s ? `${open}${s}${close}` : s)
}

function makeBgLinePainter(
  bgOpen: string | null,
  fallbackFg?: (s: string) => string,
): (content: string, width: number) => string {
  return (content: string, width: number) => {
    const padded = padVisible(content, width)
    if (!bgOpen) {
      return fallbackFg ? fallbackFg(padded) : padded
    }
    const preserved = padded
      .replace(/\x1b\[0m/g, `\x1b[0m${bgOpen}`)
      .replace(/\x1b\[49m/g, bgOpen)
    return `${bgOpen}${preserved}\x1b[0m`
  }
}

export function createThemePalette(enabled: boolean, rawThemeId?: CliThemeId): CliPalette {
  const themeId = normalizeCliTheme(rawThemeId)
  const meta = CLI_THEMES[themeId]
  const idWrap = (s: string) => s

  if (!enabled) {
    const noopLine = (content: string, width: number) => padVisible(content, width)
    return {
      enabled: false,
      themeId,
      colorDepth: 'none',
      accent: idWrap,
      accentSoft: idWrap,
      bold: idWrap,
      dim: idWrap,
      italic: idWrap,
      underline: idWrap,
      strike: idWrap,
      green: idWrap,
      red: idWrap,
      yellow: idWrap,
      cyan: idWrap,
      blue: idWrap,
      purple: idWrap,
      muted: idWrap,
      subtle: idWrap,
      border: idWrap,
      synKeyword: idWrap,
      synString: idWrap,
      synComment: idWrap,
      synNumber: idWrap,
      synType: idWrap,
      synFunc: idWrap,
      bgCode: idWrap,
      pill: (text: string) => `[${text}]`,
      surfaceLine: noopLine,
      activeLine: noopLine,
      codeLine: noopLine,
      diffAddLine: noopLine,
      diffDelLine: noopLine,
    }
  }

  const detected = detectColorDepth()
  const colorDepth: CliColorDepth = detected === 'none' ? '256' : detected
  const t = meta.tokens
  const isMinimal = themeId === 'minimal'

  const greenFn = wrapFg(t.green, colorDepth, isMinimal ? '\x1b[32m' : undefined)
  const redFn = wrapFg(t.red, colorDepth, isMinimal ? '\x1b[31m' : undefined)
  const yellowFn = wrapFg(t.yellow, colorDepth, isMinimal ? '\x1b[33m' : undefined)
  const cyanFn = wrapFg(t.cyan, colorDepth, isMinimal ? '\x1b[36m' : undefined)
  const blueFn = wrapFg(t.blue, colorDepth, isMinimal ? '\x1b[34m' : undefined)
  const purpleFn = wrapFg(t.purple, colorDepth, isMinimal ? '\x1b[35m' : undefined)
  const accentFn = wrapFg(t.accent, colorDepth, isMinimal ? '\x1b[33m' : undefined)
  const accentSoftFn = wrapFg(t.accentSoft, colorDepth, isMinimal ? '\x1b[33m' : undefined)
  const mutedFn = wrapFg(t.muted, colorDepth, isMinimal ? '\x1b[37m' : undefined)
  const subtleFn = wrapFg(t.subtle, colorDepth, isMinimal ? '\x1b[90m' : undefined)
  const borderFn = wrapFg(t.border, colorDepth, isMinimal ? '\x1b[90m' : undefined)
  const boldFn = wrapAttr('\x1b[1m', '\x1b[22m')

  const surfaceBg = t.bgSurface ? bgCodeSeq(t.bgSurface, colorDepth) : null
  const activeBg = t.bgActive ? bgCodeSeq(t.bgActive, colorDepth) : null
  const codeBg = t.bgCode ? bgCodeSeq(t.bgCode, colorDepth) : null
  const diffAddBg = t.bgDiffAdd ? bgCodeSeq(t.bgDiffAdd, colorDepth) : null
  const diffDelBg = t.bgDiffDel ? bgCodeSeq(t.bgDiffDel, colorDepth) : null

  return {
    enabled: true,
    themeId,
    colorDepth,
    accent: accentFn,
    accentSoft: accentSoftFn,
    bold: boldFn,
    dim: wrapAttr('\x1b[2m', '\x1b[22m'),
    italic: wrapAttr('\x1b[3m', '\x1b[23m'),
    underline: wrapAttr('\x1b[4m', '\x1b[24m'),
    strike: wrapAttr('\x1b[9m', '\x1b[29m'),
    green: greenFn,
    red: redFn,
    yellow: yellowFn,
    cyan: cyanFn,
    blue: blueFn,
    purple: purpleFn,
    muted: mutedFn,
    subtle: subtleFn,
    border: borderFn,
    synKeyword: wrapFg(t.synKeyword, colorDepth),
    synString: wrapFg(t.synString, colorDepth),
    synComment: wrapFg(t.synComment, colorDepth),
    synNumber: wrapFg(t.synNumber, colorDepth),
    synType: wrapFg(t.synType, colorDepth),
    synFunc: wrapFg(t.synFunc, colorDepth),
    bgCode: (s: string) => (codeBg && s ? `${codeBg}${s}\x1b[49m` : cyanFn(s)),
    pill: (text: string, tone: CliPillTone = 'accent') => {
      const toneFn =
        tone === 'green'
          ? greenFn
          : tone === 'yellow'
            ? yellowFn
            : tone === 'red'
              ? redFn
              : tone === 'cyan'
                ? cyanFn
                : tone === 'purple'
                  ? purpleFn
                  : tone === 'muted'
                    ? mutedFn
                    : accentFn
      const inner = boldFn(toneFn(` ${text} `))
      return activeBg ? `${activeBg}${inner}\x1b[49m` : toneFn(`[${text}]`)
    },
    surfaceLine: makeBgLinePainter(surfaceBg),
    activeLine: makeBgLinePainter(activeBg),
    codeLine: makeBgLinePainter(codeBg),
    diffAddLine: makeBgLinePainter(diffAddBg, greenFn),
    diffDelLine: makeBgLinePainter(diffDelBg, redFn),
  }
}

/** Renders 4 color swatch squares illustrating a CLI theme's accent, semantic, and syntax colors. */
export function renderThemeSwatch(themeId: CliThemeId, enabled: boolean): string {
  if (!enabled) return '[swatch]'
  const meta = CLI_THEMES[themeId]
  const depth = detectColorDepth()
  const useDepth: CliColorDepth = depth === 'none' ? '256' : depth
  const colors = [meta.tokens.accent, meta.tokens.cyan, meta.tokens.green, meta.tokens.purple]
  return colors.map((c) => `${fgCode(c, useDepth)}■\x1b[39m`).join(' ')
}
