// Zero-dependency cross-platform arrow-key Claude-Code-style hairline picker with search and viewport docking.
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  createThemePalette,
  justifyRow,
  padVisible,
  stripAnsi,
  truncateVisible,
  visibleWidth,
  type CliPalette,
} from './theme.ts'
import { getViewportForStream, type TerminalViewport } from './viewport.ts'

export { stripAnsi, visibleWidth, truncateVisible }

const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'

export interface SelectOption<T = string> {
  value: T
  label: string
  hint?: string
  shortcut?: string
}

export interface SelectPromptOptions<T = string> {
  title: string
  subtitle?: string
  searchable?: boolean
  options: readonly SelectOption<T>[]
  initialIndex?: number
  pageSize?: number
  cancelable?: boolean
  viewport?: TerminalViewport
  palette?: CliPalette
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
}

export type ParsedSelectKey =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'digit'; index: number }
  | { kind: 'shortcut'; index: number }
  | { kind: 'noop' }

/** Decodes raw terminal key sequences for interactive option selection. */
export function parseSelectKey<T>(
  raw: string,
  options?: readonly SelectOption<T>[],
): ParsedSelectKey {
  if (!raw) return { kind: 'noop' }

  if (raw === '\x1b[A' || raw === '\x1bOA' || raw === '[A' || raw === 'OA') return { kind: 'up' }
  if (raw === '\x1b[B' || raw === '\x1bOB' || raw === '[B' || raw === 'OB') return { kind: 'down' }
  if (raw === '\x1b[H' || raw === '\x1bOH' || raw === '\x1b[1~') return { kind: 'home' }
  if (raw === '\x1b[F' || raw === '\x1bOF' || raw === '\x1b[4~') return { kind: 'end' }
  if (raw === '\r' || raw === '\n' || raw === '\r\n') return { kind: 'confirm' }
  if (raw === '\x1b' || raw === '\u0003') return { kind: 'cancel' }

  if (raw.length === 1 && options) {
    const lower = raw.toLowerCase()
    const matchIdx = options.findIndex((o) => o.shortcut?.toLowerCase() === lower)
    if (matchIdx >= 0) return { kind: 'shortcut', index: matchIdx }
  }

  if (raw === 'k' || raw === 'K') return { kind: 'up' }
  if (raw === 'j' || raw === 'J') return { kind: 'down' }
  if (raw.length === 1 && raw >= '1' && raw <= '9') {
    return { kind: 'digit', index: Number(raw) - 1 }
  }

  return { kind: 'noop' }
}

async function runFallbackNumberPrompt<T>(opts: {
  title: string
  options: readonly SelectOption<T>[]
  defaultIndex: number
  cancelable: boolean
  palette: CliPalette
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}): Promise<T | null> {
  const { title, options, defaultIndex, cancelable, palette, input, output } = opts
  output.write(`${palette.bold(title)}\n`)
  options.forEach((opt, idx) => {
    const shortcutTag = opt.shortcut ? `[${opt.shortcut}] ` : ''
    const hintText = opt.hint ? ` ${palette.dim(`— ${opt.hint}`)}` : ''
    output.write(`  [${idx + 1}] ${shortcutTag}${opt.label}${hintText}\n`)
  })
  const rl = createInterface({ input, output, terminal: false })
  try {
    const answer = (await rl.question(`Selection [${defaultIndex + 1}]: `)).trim()
    if (!answer) return options[defaultIndex]?.value ?? null
    const lower = answer.toLowerCase()
    const byShortcut = options.findIndex((o) => o.shortcut?.toLowerCase() === lower)
    if (byShortcut >= 0) return options[byShortcut]!.value
    const num = Number(answer)
    if (Number.isInteger(num) && num >= 1 && num <= options.length) {
      return options[num - 1]!.value
    }
    if (cancelable && (lower === 'q' || lower === 'cancel' || lower === 'esc')) {
      return null
    }
    return options[defaultIndex]?.value ?? null
  } catch {
    return cancelable ? null : options[defaultIndex]?.value ?? null
  } finally {
    rl.close()
  }
}

/**
 * Interactive arrow-key (↑ / ↓ + Enter) Claude-Code-style hairline selector.
 * Supports optional live filtering (`searchable: true`), viewport bottom docking,
 * resize handling, synchronized ANSI redraws, and clean non-TTY fallback.
 */
export async function selectOption<T = string>(opts: SelectPromptOptions<T>): Promise<T | null> {
  const { title, options } = opts
  if (options.length === 0) return null

  const input = (opts.stdin ?? defaultStdin) as NodeJS.ReadStream
  const output = (opts.stdout ?? defaultStdout) as NodeJS.WriteStream
  const viewport = opts.viewport ?? getViewportForStream(output)
  const useViewport = Boolean(viewport?.enabled)
  const rawOut = useViewport && viewport ? (viewport.rawStdout as NodeJS.WriteStream) : output
  const cancelable = opts.cancelable !== false
  const searchable = Boolean(opts.searchable)
  const palette = opts.palette ?? createThemePalette(!process.env.NO_COLOR && Boolean(output.isTTY))
  const clampIndex = (idx: number, len: number) => (len <= 0 ? 0 : Math.max(0, Math.min(len - 1, idx)))
  const defaultIndex = clampIndex(opts.initialIndex ?? 0, options.length)

  const canUseRawTty = Boolean(input.isTTY) && typeof input.setRawMode === 'function'
  if (!canUseRawTty) {
    return runFallbackNumberPrompt({
      title,
      options,
      defaultIndex,
      cancelable,
      palette,
      input,
      output,
    })
  }

  const pageSize = Math.max(3, Math.min(options.length, opts.pageSize ?? 10))
  let filterQuery = ''
  let cursor = defaultIndex
  let scrollTop = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), options.length - pageSize))
  let renderedLines = 0
  const wasRaw = Boolean(input.isRaw)

  const getFiltered = (): readonly SelectOption<T>[] => {
    const q = filterQuery.trim().toLowerCase()
    if (!searchable || !q) return options
    return options.filter((o) => {
      const hay = `${o.label} ${o.hint ?? ''}`.toLowerCase()
      return hay.includes(q)
    })
  }

  const adjustScroll = (len: number) => {
    if (len === 0) {
      cursor = 0
      scrollTop = 0
      return
    }
    cursor = clampIndex(cursor, len)
    const effectivePage = Math.min(pageSize, len)
    if (cursor < scrollTop) {
      scrollTop = cursor
    } else if (cursor >= scrollTop + effectivePage) {
      scrollTop = cursor - effectivePage + 1
    }
    scrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, len - effectivePage)))
  }

  const draw = () => {
    const visibleOptions = getFiltered()
    adjustScroll(visibleOptions.length)
    const termCols = Math.max(40, output.columns || 80)
    const boxW = Math.max(36, termCols - 1)
    const lines: string[] = []

    const countLabel =
      searchable && filterQuery.trim() ? `${visibleOptions.length}/${options.length}` : `${options.length}`
    const subTag = opts.subtitle ? ` ${palette.subtle(`· ${opts.subtitle}`)}` : ''

    lines.push(palette.border('─'.repeat(boxW)))
    lines.push(justifyRow(` ${palette.bold(title)}${subTag}`, palette.subtle(`(${countLabel}) `), boxW))

    if (searchable) {
      const searchLabel = filterQuery
        ? ` ${palette.cyan('⌕')} ${palette.bold(filterQuery)}${palette.accent('▏')}`
        : ` ${palette.subtle('⌕ Type to filter...')}`
      lines.push(truncateVisible(searchLabel, boxW))
    }

    lines.push('')

    if (visibleOptions.length === 0) {
      lines.push(truncateVisible(`  ${palette.muted('No matches found — Backspace or Esc')}`, boxW))
    } else {
      if (scrollTop > 0) {
        lines.push(truncateVisible(palette.subtle(`  ↑ ${scrollTop} more above`), boxW))
      }

      const effectivePage = Math.min(pageSize, visibleOptions.length)
      const end = Math.min(visibleOptions.length, scrollTop + effectivePage)
      for (let idx = scrollTop; idx < end; idx += 1) {
        const opt = visibleOptions[idx]!
        const active = idx === cursor
        const pointer = active ? palette.accent('❯') : ' '
        const shortcutPrefix = opt.shortcut ? palette.subtle(`[${opt.shortcut}] `) : ''
        const label = active ? palette.bold(opt.label) : opt.label
        const leftPart = `  ${pointer} ${shortcutPrefix}${label}`

        const hintBudget = boxW - visibleWidth(leftPart) - 4
        let rowContent: string
        if (opt.hint && hintBudget >= 8) {
          const fittedHint = truncateVisible(opt.hint, hintBudget)
          rowContent = justifyRow(leftPart, active ? palette.muted(fittedHint) : palette.subtle(fittedHint), boxW - 1)
        } else {
          rowContent = padVisible(leftPart, boxW - 1)
        }

        lines.push(active ? palette.activeLine(rowContent, boxW) : rowContent)
      }

      const below = visibleOptions.length - end
      if (below > 0) {
        lines.push(truncateVisible(palette.subtle(`  ↓ ${below} more below`), boxW))
      }
    }

    const hintParts = ['↑↓ move', 'Enter select']
    if (searchable) hintParts.push('Type to filter')
    if (cancelable) hintParts.push(searchable && filterQuery ? 'Esc clear' : 'Esc cancel')
    lines.push(truncateVisible(`  ${palette.subtle(hintParts.join(' · '))}`, boxW))

    if (useViewport && viewport) {
      viewport.renderDock(lines, null)
      return
    }

    let seq = SYNC_BEGIN
    if (renderedLines > 0) {
      seq += `\x1b[${renderedLines}A\r\x1b[0J`
    }
    seq += `${lines.join('\n')}\n`
    seq += SYNC_END
    output.write(seq)
    renderedLines = lines.length
  }

  const clearMenu = () => {
    if (renderedLines > 0) {
      output.write(`\x1b[${renderedLines}A\r\x1b[0J`)
      renderedLines = 0
    }
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

  return new Promise<T | null>((resolve) => {
    let settled = false

    const finish = (pickedOption: SelectOption<T> | null, cancelled: boolean) => {
      if (settled) return
      settled = true
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

      if (useViewport && viewport) {
        const cols = Math.max(40, output.columns || 80)
        const boxW = Math.max(36, cols - 1)
        const quietBar = [
          '',
          palette.border('─'.repeat(boxW)),
          '  ',
          palette.border('─'.repeat(boxW)),
          `  ${palette.subtle('...')} `,
        ]
        viewport.renderDock(quietBar, null)
        rawOut.write('\x1b[?25h')
        if (!cancelled && pickedOption) {
          viewport.writeTranscript(
            `  ${palette.green('✓')} ${palette.muted(title)} ${palette.subtle('›')} ${palette.bold(pickedOption.label)}\n`,
          )
          resolve(pickedOption.value)
        } else {
          viewport.writeTranscript(`  ${palette.subtle(`× ${title} › cancelled`)}\n`)
          resolve(null)
        }
        return
      }

      clearMenu()
      rawOut.write('\x1b[?25h')

      if (!cancelled && pickedOption) {
        output.write(
          `  ${palette.green('✓')} ${palette.muted(title)} ${palette.subtle('›')} ${palette.bold(pickedOption.label)}\n`,
        )
        resolve(pickedOption.value)
      } else {
        output.write(`  ${palette.subtle(`× ${title} › cancelled`)}\n`)
        resolve(null)
      }
    }

    const handleSingleSequence = (seq: string) => {
      if (searchable) {
        if (seq === '\x7f' || seq === '\b') {
          const chars = [...filterQuery]
          if (chars.length > 0) {
            filterQuery = chars.slice(0, -1).join('')
            cursor = 0
            scrollTop = 0
            draw()
          }
          return
        }
        if (seq === '\x1b' && filterQuery.length > 0) {
          filterQuery = ''
          cursor = 0
          scrollTop = 0
          draw()
          return
        }
        if (seq === '\x1b[A' || seq === '\x1bOA') {
          const visibleOptions = getFiltered()
          if (visibleOptions.length > 0) {
            cursor = (cursor - 1 + visibleOptions.length) % visibleOptions.length
            draw()
          }
          return
        }
        if (seq === '\x1b[B' || seq === '\x1bOB') {
          const visibleOptions = getFiltered()
          if (visibleOptions.length > 0) {
            cursor = (cursor + 1) % visibleOptions.length
            draw()
          }
          return
        }
        if (seq === '\x1b[H' || seq === '\x1bOH' || seq === '\x1b[1~') {
          cursor = 0
          draw()
          return
        }
        if (seq === '\x1b[F' || seq === '\x1bOF' || seq === '\x1b[4~') {
          const visibleOptions = getFiltered()
          cursor = Math.max(0, visibleOptions.length - 1)
          draw()
          return
        }
        if (seq === '\r' || seq === '\n' || seq === '\r\n') {
          const visibleOptions = getFiltered()
          const picked = visibleOptions[cursor] ?? null
          if (picked) finish(picked, false)
          return
        }
        if (seq === '\x1b' || seq === '\u0003') {
          if (cancelable || seq === '\u0003') finish(null, true)
          return
        }
        if (!seq.startsWith('\x1b') && seq >= ' ') {
          filterQuery += seq
          cursor = 0
          scrollTop = 0
          draw()
        }
        return
      }

      const key = parseSelectKey(seq, options)
      switch (key.kind) {
        case 'up':
          cursor = (cursor - 1 + options.length) % options.length
          draw()
          break
        case 'down':
          cursor = (cursor + 1) % options.length
          draw()
          break
        case 'home':
          cursor = 0
          draw()
          break
        case 'end':
          cursor = options.length - 1
          draw()
          break
        case 'confirm': {
          const picked = options[cursor] ?? null
          finish(picked, !picked)
          break
        }
        case 'cancel':
          if (cancelable || seq === '\u0003') {
            finish(null, true)
          }
          break
        case 'shortcut':
          cursor = key.index
          finish(options[cursor] ?? null, false)
          break
        case 'digit':
          if (key.index < options.length) {
            cursor = key.index
            finish(options[cursor] ?? null, false)
          }
          break
        case 'noop':
          break
      }
    }

    const onData = (chunk: Buffer) => {
      if (settled) return
      const raw = chunk.toString('utf8')
      let i = 0
      while (i < raw.length && !settled) {
        if (raw[i] === '\x1b') {
          const escMatch = /^(?:\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z])/.exec(raw.slice(i))
          if (escMatch) {
            handleSingleSequence(escMatch[0])
            i += escMatch[0].length
            continue
          }
          handleSingleSequence('\x1b')
          i += 1
          continue
        }
        const cp = raw.codePointAt(i) ?? 0
        const ch = String.fromCodePoint(cp)
        handleSingleSequence(ch)
        i += ch.length
      }
    }

    input.on('data', onData)
  })
}
