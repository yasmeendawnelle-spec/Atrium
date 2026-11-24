// Claude-Code-style transparent pinned composer with effort indicator, ? shortcuts drawer, / & @ dropdowns, paste folding, and Ctrl+G.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import type { AgentMode, ReasoningEffort } from '../shared/types.ts'
import {
  createThemePalette,
  justifyRow,
  padVisible,
  truncateVisible,
  visibleWidth,
  type CliPalette,
} from './theme.ts'
import { formatCompactTokens, formatEffortBadge } from './ui.ts'
import { getViewportForStream, type TerminalViewport } from './viewport.ts'

export interface ComposerCommandItem {
  cmd: string
  hint: string
}

export interface ComposerStatusMeta {
  mode: AgentMode
  model?: string
  effort: ReasoningEffort
  gitBranch?: string
  gitDirty?: number
  contextUsed: number
  contextLimit: number
  sessionName?: string
}

export interface ComposerDropdownItem {
  insertText: string
  label: string
  hint?: string
  submitOnEnter?: boolean
}

export interface ComposerDropdownState {
  kind: 'command' | 'file'
  replaceStart: number
  replaceEnd: number
  items: ComposerDropdownItem[]
}

export interface ComposerPromptOptions {
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  viewport?: TerminalViewport
  palette?: CliPalette
  commands: readonly ComposerCommandItem[]
  getWorkspaceFiles: () => readonly string[]
  getStatusMeta: () => ComposerStatusMeta
  history: string[]
  placeholder?: string
  onCycleMode?: () => Promise<AgentMode> | AgentMode
  onToggleThinking?: () => boolean
  onClearScreen?: () => Promise<void> | void
  onOpenEditor?: (currentText: string) => Promise<string | null>
}

export type ComposerResult = { kind: 'submit'; text: string } | { kind: 'exit' }

export const COMPOSER_PLACEHOLDERS: readonly string[] = [
  'Try "fix typecheck errors"',
  'Try "explain how this repository works"',
  'Try "add unit tests for this module"',
  'Try "/init to create AGENTS.md"',
  'Try "@file to inspect specific code"',
]

const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'
const BRACKETED_PASTE_DISABLE = '\x1b[?2004l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const DROPDOWN_VIEWPORT = 8

export function formatModeBadge(mode: AgentMode, palette: CliPalette): string {
  switch (mode) {
    case 'manual':
      return `${palette.cyan('⏸')} ${palette.cyan('manual mode on')}`
    case 'plan':
      return `${palette.cyan('⏸')} ${palette.cyan('plan mode on')}`
    case 'accept_edits':
      return `${palette.purple('▸▸')} ${palette.purple('accept edits on')}`
    case 'bypass':
      return `${palette.red('⚠')} ${palette.red('bypass permissions')}`
    case 'auto':
    default:
      return `${palette.accent('▸▸')} ${palette.accent('auto mode')}`
  }
}

/** Formats submitted user prompts as a subtle shaded block above the assistant response. */
export function renderSubmittedPromptBlock(text: string, palette: CliPalette, cols = 80): string {
  const boxW = Math.max(36, cols - 1)
  const rawLines = text.replace(/\r\n/g, '\n').split('\n')
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]?.trim() === '') rawLines.pop()
  if (rawLines.length === 0) return ''

  const maxEchoLines = 6
  const shownLines = rawLines.slice(0, maxEchoLines)
  const overflow = rawLines.length - shownLines.length
  const out: string[] = ['']
  shownLines.forEach((line, idx) => {
    const prefix = idx === 0 ? palette.muted('❯') : ' '
    const fitted = truncateVisible(line, Math.max(16, boxW - 5))
    out.push(palette.surfaceLine(` ${prefix} ${palette.bold(fitted)}`, boxW))
  })
  if (overflow > 0) {
    out.push(palette.surfaceLine(`   ${palette.subtle(`… (+${overflow} more lines)`)}`, boxW))
  }
  return `${out.join('\n')}\n`
}

/** Computes a quiet 5-row bottom dock shown while a turn is running in viewport mode. */
export function renderWorkingDockLines(
  meta: { mode: AgentMode; effort: ReasoningEffort; status?: string },
  palette: CliPalette,
  cols = 80,
): string[] {
  const boxW = Math.max(36, cols - 1)
  const effortRight = `${formatEffortBadge(meta.effort, palette)} ${palette.subtle('· /effort')}`
  const rule = palette.border('─'.repeat(boxW))
  const statusLine = truncateVisible(
    `  ${palette.accent('✳')} ${palette.muted(meta.status ?? 'Working...')} ${palette.subtle('· esc / ctrl+c to interrupt')}`,
    boxW,
  )
  const bottomLine = truncateVisible(`  ${formatModeBadge(meta.mode, palette)} ${palette.subtle('· running turn')}`, boxW)
  return [justifyRow('', effortRight, boxW), rule, statusLine, rule, bottomLine]
}

/** Computes live `/` command or `@` workspace-file suggestions for the current cursor offset. */
export function filterComposerDropdown(
  text: string,
  cursorOffset: number,
  commands: readonly ComposerCommandItem[],
  workspaceFiles: readonly string[],
): ComposerDropdownState | null {
  const beforeCursor = text.slice(0, cursorOffset)

  if (beforeCursor.startsWith('/') && !/[\s\n]/.test(beforeCursor)) {
    const query = beforeCursor.toLowerCase()
    const prefixHits = commands.filter((c) => c.cmd.toLowerCase().startsWith(query))
    const substrHits = commands.filter(
      (c) => !c.cmd.toLowerCase().startsWith(query) && c.cmd.toLowerCase().includes(query.slice(1)),
    )
    const items = [...prefixHits, ...substrHits].slice(0, 40).map((c) => ({
      insertText: c.cmd,
      label: c.cmd,
      hint: c.hint,
      submitOnEnter: true,
    }))
    if (items.length === 0) return null
    return { kind: 'command', replaceStart: 0, replaceEnd: cursorOffset, items }
  }

  const atMatch = /(?:^|[\s\n])(@[^\s\n]*)$/.exec(beforeCursor)
  if (atMatch && workspaceFiles.length > 0) {
    const token = atMatch[1]!
    const replaceStart = beforeCursor.length - token.length
    const query = token.slice(1).toLowerCase()
    const prefixHits: string[] = []
    const containHits: string[] = []
    for (const f of workspaceFiles) {
      const lower = f.toLowerCase()
      if (!query || lower.startsWith(query)) prefixHits.push(f)
      else if (lower.includes(query)) containHits.push(f)
      if (prefixHits.length + containHits.length >= 60) break
    }
    const items = [...prefixHits, ...containHits].slice(0, 40).map((f) => ({
      insertText: `@${f} `,
      label: `@${f}`,
      hint: 'workspace file',
      submitOnEnter: false,
    }))
    if (items.length === 0) return null
    return { kind: 'file', replaceStart, replaceEnd: cursorOffset, items }
  }

  return null
}

function isWideCp(cp: number): boolean {
  return (
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
  )
}

interface WrappedLayout {
  lines: string[]
  cursorRow: number
  cursorCol: number
}

function layoutBuffer(
  buffer: string,
  cursorOffset: number,
  maxTextWidth: number,
  palette: CliPalette,
  placeholder: string,
): WrappedLayout {
  if (!buffer) {
    const ph = truncateVisible(placeholder, maxTextWidth)
    return {
      lines: [`${palette.muted('❯')} ${palette.subtle(ph)}`],
      cursorRow: 0,
      cursorCol: 2,
    }
  }

  const lines: string[] = []
  let cursorRow = 0
  let cursorCol = 2
  let cursorPlaced = false

  let rowIdx = 0
  let currentText = ''
  let colUsed = 0
  let isFirstLogicalRow = true

  const flushVisualRow = () => {
    const prefix = isFirstLogicalRow ? `${palette.accent('❯')} ` : '  '
    lines.push(`${prefix}${currentText}`)
    rowIdx += 1
    currentText = ''
    colUsed = 0
    isFirstLogicalRow = false
  }

  let offset = 0
  while (offset < buffer.length) {
    if (!cursorPlaced && offset === cursorOffset) {
      cursorRow = rowIdx
      cursorCol = 2 + colUsed
      cursorPlaced = true
    }

    const ch = buffer[offset]!
    if (ch === '\n') {
      flushVisualRow()
      isFirstLogicalRow = false
      offset += 1
      continue
    }

    const cp = buffer.codePointAt(offset) ?? 0
    const glyph = String.fromCodePoint(cp)
    const w = isWideCp(cp) ? 2 : 1
    if (colUsed > 0 && colUsed + w > maxTextWidth) {
      flushVisualRow()
    }
    currentText += glyph
    colUsed += w
    offset += glyph.length
  }

  if (!cursorPlaced) {
    cursorRow = rowIdx
    cursorCol = 2 + colUsed
  }
  const prefix = lines.length === 0 ? `${palette.accent('❯')} ` : '  '
  lines.push(`${prefix}${currentText}`)

  return { lines, cursorRow, cursorCol }
}

function buildShortcutDrawerLines(boxW: number, palette: CliPalette): string[] {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ['!', 'for bash mode'],
    ['Shift+Tab', 'cycle mode'],
    ['Ctrl+O', 'toggle thinking'],
    ['/', 'for commands'],
    ['Ctrl+G', 'open in $EDITOR'],
    ['Alt+Enter', 'insert newline'],
    ['@', 'for file paths'],
    ['Ctrl+L', 'clear screen'],
    ['Ctrl+C ×2', 'exit Atrium'],
  ]

  const numCols = boxW >= 78 ? 3 : 2
  const colW = Math.floor((boxW - 4) / numCols)
  const out: string[] = []
  for (let i = 0; i < entries.length; i += numCols) {
    const rowCells: string[] = []
    for (let c = 0; c < numCols; c += 1) {
      const pair = entries[i + c]
      if (!pair) continue
      const cell = `${palette.bold(palette.muted(pair[0]))} ${palette.subtle(pair[1])}`
      rowCells.push(padVisible(cell, colW))
    }
    out.push(truncateVisible(`  ${rowCells.join('')}`, boxW))
  }
  out.push(truncateVisible(`  ${palette.subtle('Press ? or Esc to close shortcuts')}`, boxW))
  return out
}

function prevCodePointOffset(str: string, pos: number): number {
  if (pos <= 0) return 0
  const prevUnit = str.charCodeAt(pos - 1)
  if (prevUnit >= 0xdc00 && prevUnit <= 0xdfff && pos >= 2) {
    const hiUnit = str.charCodeAt(pos - 2)
    if (hiUnit >= 0xd800 && hiUnit <= 0xdbff) return pos - 2
  }
  return pos - 1
}

function nextCodePointOffset(str: string, pos: number): number {
  if (pos >= str.length) return str.length
  const cp = str.codePointAt(pos) ?? 0
  return pos + String.fromCodePoint(cp).length
}

function moveWordLeft(str: string, pos: number): number {
  let i = pos
  while (i > 0 && /\s/.test(str[i - 1]!)) i -= 1
  while (i > 0 && !/\s/.test(str[i - 1]!)) i -= 1
  return i
}

function moveWordRight(str: string, pos: number): number {
  let i = pos
  while (i < str.length && !/\s/.test(str[i]!)) i += 1
  while (i < str.length && /\s/.test(str[i]!)) i += 1
  return i
}

async function openExternalEditor(initialText: string): Promise<string | null> {
  const editorCmd =
    process.env.VISUAL?.trim() ||
    process.env.EDITOR?.trim() ||
    (process.platform === 'win32' ? 'notepad' : 'vi')
  const tempDir = await mkdtemp(join(tmpdir(), 'atrium-editor-'))
  const filePath = join(tempDir, 'prompt.md')
  try {
    await writeFile(filePath, initialText, 'utf8')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(`${editorCmd} "${filePath}"`, {
        stdio: 'inherit',
        shell: true,
        windowsHide: false,
      })
      child.on('error', reject)
      child.on('close', () => resolve())
    })
    const edited = await readFile(filePath, 'utf8')
    return edited.replace(/\r\n/g, '\n')
  } catch {
    return null
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runFallbackLineInput(opts: ComposerPromptOptions): Promise<ComposerResult> {
  const input = opts.stdin ?? defaultStdin
  const output = opts.stdout ?? defaultStdout
  const rl = createInterface({ input, output, terminal: false, history: [...opts.history], historySize: 200 })
  try {
    const line = await rl.question('❯ ')
    return { kind: 'submit', text: line }
  } catch {
    return { kind: 'exit' }
  } finally {
    rl.close()
  }
}

/**
 * Interactive raw-mode multi-line composer styled like Claude Code:
 * flush effort indicator above top hairline, transparent input area, bottom hairline,
 * mode pill + `?` shortcuts drawer, borderless `/` & `@file` dropdowns, paste folding, and `Ctrl+G`.
 */
export async function readComposerInput(opts: ComposerPromptOptions): Promise<ComposerResult> {
  const input = (opts.stdin ?? defaultStdin) as NodeJS.ReadStream
  const output = (opts.stdout ?? defaultStdout) as NodeJS.WriteStream
  const viewport = opts.viewport ?? getViewportForStream(output)
  const useViewport = Boolean(viewport?.enabled)
  const rawOut = useViewport && viewport ? (viewport.rawStdout as NodeJS.WriteStream) : output
  const palette = opts.palette ?? createThemePalette(!process.env.NO_COLOR && Boolean(output.isTTY))

  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return runFallbackLineInput(opts)
  }

  const placeholder =
    opts.placeholder ?? COMPOSER_PLACEHOLDERS[opts.history.length % COMPOSER_PLACEHOLDERS.length]!
  const workspaceFiles = opts.getWorkspaceFiles()
  const wasRaw = Boolean(input.isRaw)

  let buffer = ''
  let cursorOffset = 0
  let dropdownIdx = 0
  let dropdownScroll = 0
  let dropdownDismissed = false
  let showShortcuts = false
  let historyIdx = -1
  let draftBeforeHistory = ''
  let prevCursorRow = 0
  let lastSigintAt = 0
  let toastText = ''
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let inBracketedPaste = false
  let pasteAccumulator = ''
  let pasteSeq = 0
  const pastedBlocks: Array<{ token: string; content: string }> = []
  let busyCallback = false

  const clearToast = () => {
    if (toastTimer) {
      clearTimeout(toastTimer)
      toastTimer = null
    }
    toastText = ''
  }

  const setToast = (msg: string, drawFn: () => void) => {
    clearToast()
    toastText = msg
    drawFn()
    toastTimer = setTimeout(() => {
      toastText = ''
      drawFn()
    }, 2400)
    toastTimer.unref?.()
  }

  const expandPastedTokens = (text: string): string => {
    let resolved = text
    for (const block of pastedBlocks) {
      if (resolved.includes(block.token)) {
        resolved = resolved.split(block.token).join(block.content)
      }
    }
    return resolved
  }

  const computeDropdown = () => {
    if (dropdownDismissed) return null
    return filterComposerDropdown(buffer, cursorOffset, opts.commands, workspaceFiles)
  }

  const eraseInline = () => {
    if (prevCursorRow > 0) {
      output.write(`\x1b[${prevCursorRow}A`)
    }
    output.write('\r\x1b[0J')
    prevCursorRow = 0
  }

  const draw = () => {
    const cols = Math.max(40, output.columns || 80)
    const boxW = Math.max(36, cols - 1)
    const maxTextWidth = Math.max(16, boxW - 4)
    const layout = layoutBuffer(buffer, cursorOffset, maxTextWidth, palette, placeholder)
    const meta = opts.getStatusMeta()

    const effortRight = `${formatEffortBadge(meta.effort, palette)} ${palette.subtle('· /effort')}`
    const effortRow = justifyRow(toastText ? `  ${palette.yellow(toastText)}` : '', effortRight, boxW)
    const hairline = palette.border('─'.repeat(boxW))
    const inputRows = layout.lines.map((l) => truncateVisible(l, boxW))

    const rows: string[] = [effortRow, hairline, ...inputRows, hairline]

    const dd = computeDropdown()
    if (dd && dd.items.length > 0) {
      showShortcuts = false
      dropdownIdx = Math.max(0, Math.min(dropdownIdx, dd.items.length - 1))
      const viewSize = Math.min(DROPDOWN_VIEWPORT, dd.items.length)
      if (dropdownIdx < dropdownScroll) dropdownScroll = dropdownIdx
      else if (dropdownIdx >= dropdownScroll + viewSize) dropdownScroll = dropdownIdx - viewSize + 1
      dropdownScroll = Math.max(0, Math.min(dropdownScroll, Math.max(0, dd.items.length - viewSize)))

      const slice = dd.items.slice(dropdownScroll, dropdownScroll + viewSize)
      const labelW = Math.min(28, Math.max(14, ...slice.map((x) => visibleWidth(x.label))))
      slice.forEach((item, offsetIdx) => {
        const realIdx = dropdownScroll + offsetIdx
        const active = realIdx === dropdownIdx
        const pointer = active ? palette.accent('❯') : ' '
        const styledLabel = active ? palette.bold(palette.cyan(item.label)) : palette.cyan(item.label)
        const leftLabel = padVisible(styledLabel, labelW)
        const hintBudget = Math.max(0, boxW - 4 - labelW - 2)
        const hint =
          item.hint && hintBudget >= 6
            ? `  ${active ? palette.muted(truncateVisible(item.hint, hintBudget)) : palette.subtle(truncateVisible(item.hint, hintBudget))}`
            : ''
        const line = `  ${pointer} ${leftLabel}${hint}`
        rows.push(active ? palette.activeLine(line, boxW) : truncateVisible(line, boxW))
      })

      if (dd.items.length > viewSize) {
        rows.push(
          truncateVisible(
            palette.subtle(
              `  ${dropdownScroll + 1}-${dropdownScroll + viewSize} of ${dd.items.length} · Tab fill · Enter ${dd.kind === 'command' ? 'run' : 'insert'} · Esc close`,
            ),
            boxW,
          ),
        )
      }
    } else if (showShortcuts) {
      rows.push(...buildShortcutDrawerLines(boxW, palette))
    } else {
      const leftIdle = `  ${formatModeBadge(meta.mode, palette)} ${palette.subtle('· ? for shortcuts · / for commands')}`
      const pct =
        meta.contextLimit > 0 ? Math.min(100, Math.round((meta.contextUsed / meta.contextLimit) * 100)) : 0
      const rightParts: string[] = []
      if (meta.gitBranch) {
        rightParts.push(palette.subtle(`${meta.gitBranch}${meta.gitDirty ? `*${meta.gitDirty}` : ''}`))
      }
      if (pct > 0) {
        rightParts.push(palette.subtle(`${formatCompactTokens(meta.contextUsed)} ctx (${pct}%)`))
      }
      if (meta.sessionName) {
        rightParts.push(palette.subtle(`[${meta.sessionName}]`))
      }
      rows.push(justifyRow(leftIdle, rightParts.join(palette.subtle(' · ')), boxW))
    }

    const targetCursorRow = 2 + layout.cursorRow
    const targetCursorCol = layout.cursorCol

    if (useViewport && viewport) {
      viewport.renderDock(rows, { row: targetCursorRow, col: targetCursorCol })
      return
    }

    const deltaUp = Math.max(0, rows.length - 1 - targetCursorRow)
    let seq = SYNC_BEGIN
    if (prevCursorRow > 0) seq += `\x1b[${prevCursorRow}A`
    seq += '\r\x1b[0J'
    seq += rows.join('\n')
    if (deltaUp > 0) seq += `\x1b[${deltaUp}A`
    seq += '\r'
    if (targetCursorCol > 0) seq += `\x1b[${targetCursorCol}C`
    seq += SYNC_END

    output.write(seq)
    prevCursorRow = targetCursorRow
  }

  const insertAtCursor = (text: string) => {
    showShortcuts = false
    buffer = buffer.slice(0, cursorOffset) + text + buffer.slice(cursorOffset)
    cursorOffset += text.length
    dropdownDismissed = false
    dropdownIdx = 0
    dropdownScroll = 0
  }

  const insertPastedText = (rawPasted: string) => {
    const normalized = rawPasted.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const lineCount = normalized.split('\n').length
    if (lineCount >= 5 || normalized.length >= 320) {
      pasteSeq += 1
      const token = `[Pasted text #${pasteSeq} +${lineCount} lines]`
      pastedBlocks.push({ token, content: normalized })
      insertAtCursor(token)
      return
    }
    insertAtCursor(normalized)
  }

  const deleteWordBack = () => {
    if (cursorOffset === 0) return
    const nextCursor = moveWordLeft(buffer, cursorOffset)
    buffer = buffer.slice(0, nextCursor) + buffer.slice(cursorOffset)
    cursorOffset = nextCursor
    dropdownDismissed = false
  }

  const findTokenBeforeCursor = (): { token: string } | undefined => {
    const before = buffer.slice(0, cursorOffset)
    return pastedBlocks.find((b) => before.endsWith(b.token))
  }

  const findTokenAtCursor = (): { token: string } | undefined => {
    const after = buffer.slice(cursorOffset)
    return pastedBlocks.find((b) => after.startsWith(b.token))
  }

  const onResize = () => {
    if (useViewport && viewport) viewport.handleResize()
    draw()
  }
  rawOut.on?.('resize', onResize)
  rawOut.write(BRACKETED_PASTE_ENABLE)
  input.setRawMode(true)
  input.resume()
  draw()

  return new Promise<ComposerResult>((resolve) => {
    let settled = false

    const finalize = (result: ComposerResult) => {
      if (settled) return
      settled = true
      clearToast()
      input.removeListener('data', onData)
      rawOut.off?.('resize', onResize)
      rawOut.write(BRACKETED_PASTE_DISABLE)
      if (!wasRaw) {
        try {
          input.setRawMode(false)
        } catch {
          // Ignore restore errors on closed streams
        }
      }
      input.pause()

      if (useViewport && viewport) {
        // Shrink any expanded dropdown / shortcut drawer cleanly back to the 5-row base dock before transcript writes.
        const meta = opts.getStatusMeta()
        const cols = Math.max(40, output.columns || 80)
        if (result.kind === 'submit') {
          const expanded = expandPastedTokens(result.text)
          viewport.renderDock(renderWorkingDockLines({ mode: meta.mode, effort: meta.effort }, palette, cols), null)
          resolve({ kind: 'submit', text: expanded })
        } else {
          rawOut.write('\x1b[?25h')
          resolve(result)
        }
        return
      }

      eraseInline()
      rawOut.write('\x1b[?25h')

      if (result.kind === 'submit') {
        const expanded = expandPastedTokens(result.text)
        const block = renderSubmittedPromptBlock(expanded, palette, output.columns || 80)
        if (block) output.write(block)
        resolve({ kind: 'submit', text: expanded })
        return
      }
      resolve(result)
    }

    const applyDropdownItem = (item: ComposerDropdownItem, dd: ComposerDropdownState) => {
      buffer = buffer.slice(0, dd.replaceStart) + item.insertText + buffer.slice(dd.replaceEnd)
      cursorOffset = dd.replaceStart + item.insertText.length
      dropdownDismissed = dd.kind === 'file'
      dropdownIdx = 0
      dropdownScroll = 0
    }

    const tryMoveVerticalInBuffer = (dir: -1 | 1): boolean => {
      const lineStart = buffer.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1
      const col = cursorOffset - lineStart
      if (dir === -1) {
        if (lineStart === 0) return false
        const prevEnd = lineStart - 1
        const prevStart = buffer.lastIndexOf('\n', Math.max(0, prevEnd - 1)) + 1
        cursorOffset = Math.min(prevStart + col, prevEnd)
        return true
      }
      const nextNl = buffer.indexOf('\n', cursorOffset)
      if (nextNl < 0) return false
      const nextStart = nextNl + 1
      const nextNextNl = buffer.indexOf('\n', nextStart)
      const nextEnd = nextNextNl >= 0 ? nextNextNl : buffer.length
      cursorOffset = Math.min(nextStart + col, nextEnd)
      return true
    }

    const handleKey = (seq: string) => {
      if (settled) return

      // Toggle shortcuts drawer when pressing `?` on an empty buffer.
      if (seq === '?' && buffer.length === 0) {
        showShortcuts = !showShortcuts
        draw()
        return
      }

      // Shift+Tab cycles permission mode live without leaving the composer.
      if (seq === '\x1b[Z') {
        if (opts.onCycleMode && !busyCallback) {
          busyCallback = true
          Promise.resolve(opts.onCycleMode())
            .then(() => draw())
            .finally(() => {
              busyCallback = false
            })
        }
        return
      }

      // Ctrl+O toggles streaming thinking display live.
      if (seq === '\x0f') {
        if (opts.onToggleThinking) {
          const next = opts.onToggleThinking()
          setToast(next ? 'Thinking stream on' : 'Thinking stream off', draw)
        }
        return
      }

      // Ctrl+G opens current draft in external $VISUAL/$EDITOR.
      if (seq === '\x07') {
        if (busyCallback) return
        busyCallback = true
        const currentExpanded = expandPastedTokens(buffer)
        if (!useViewport) eraseInline()
        rawOut.write(BRACKETED_PASTE_DISABLE)
        if (!wasRaw) {
          try {
            input.setRawMode(false)
          } catch {
            // ignore
          }
        }
        input.pause()
        const editorFn = opts.onOpenEditor ?? openExternalEditor
        editorFn(currentExpanded)
          .then((edited) => {
            if (settled) return
            if (typeof edited === 'string') {
              pastedBlocks.length = 0
              buffer = edited
              cursorOffset = edited.length
              dropdownDismissed = true
              showShortcuts = false
            }
          })
          .finally(() => {
            busyCallback = false
            if (settled) return
            rawOut.write(BRACKETED_PASTE_ENABLE)
            try {
              input.setRawMode(true)
            } catch {
              // ignore
            }
            input.resume()
            if (useViewport && viewport) viewport.handleResize()
            draw()
          })
        return
      }

      // Ctrl+L clears screen and refreshes welcome/composer.
      if (seq === '\x0c') {
        if (useViewport && viewport) {
          viewport.clearScreen()
        } else {
          eraseInline()
          output.write('\x1b[2J\x1b[0f')
        }
        if (opts.onClearScreen && !busyCallback) {
          busyCallback = true
          Promise.resolve(opts.onClearScreen())
            .then(() => draw())
            .finally(() => {
              busyCallback = false
            })
        } else {
          draw()
        }
        return
      }

      // Ctrl+C clears current buffer or double-taps to exit cleanly.
      if (seq === '\u0003') {
        showShortcuts = false
        if (buffer.length > 0) {
          buffer = ''
          cursorOffset = 0
          dropdownIdx = 0
          dropdownScroll = 0
          dropdownDismissed = false
          pastedBlocks.length = 0
          setToast('Cleared input (Ctrl+C again to exit)', draw)
          return
        }
        const now = Date.now()
        if (now - lastSigintAt < 2000) {
          finalize({ kind: 'exit' })
          return
        }
        lastSigintAt = now
        setToast('Press Ctrl+C again or type /exit to quit', draw)
        return
      }

      // Ctrl+D exits when buffer is empty.
      if (seq === '\u0004') {
        if (buffer.length === 0) {
          finalize({ kind: 'exit' })
        }
        return
      }

      // Multiline newline shortcuts: Shift+Enter, Alt+Enter, Ctrl+J.
      if (seq === '\x1b[13;2u' || seq === '\x1b[27;2;13~' || seq === '\x1b\r' || seq === '\n') {
        insertAtCursor('\n')
        draw()
        return
      }

      // Enter key handling (dropdown confirm vs backslash continuation vs submit).
      if (seq === '\r' || seq === '\r\n') {
        showShortcuts = false
        const dd = computeDropdown()
        if (dd && dd.items[dropdownIdx]) {
          const picked = dd.items[dropdownIdx]!
          if (dd.kind === 'command' && picked.submitOnEnter) {
            finalize({ kind: 'submit', text: picked.insertText })
            return
          }
          applyDropdownItem(picked, dd)
          draw()
          return
        }
        if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
          buffer = `${buffer.slice(0, -1)}\n`
          cursorOffset = buffer.length
          draw()
          return
        }
        finalize({ kind: 'submit', text: buffer })
        return
      }

      // Tab accepts active dropdown item.
      if (seq === '\t') {
        const dd = computeDropdown()
        if (dd && dd.items[dropdownIdx]) {
          applyDropdownItem(dd.items[dropdownIdx]!, dd)
          draw()
        }
        return
      }

      // Esc dismisses shortcuts drawer or dropdown cleanly.
      if (seq === '\x1b') {
        if (showShortcuts) {
          showShortcuts = false
          draw()
          return
        }
        if (computeDropdown()) {
          dropdownDismissed = true
          draw()
        }
        return
      }

      // Arrow Up / Down: navigate dropdown first, else multi-line cursor move, else history.
      if (seq === '\x1b[A' || seq === '\x1bOA') {
        const dd = computeDropdown()
        if (dd && dd.items.length > 0) {
          dropdownIdx = (dropdownIdx - 1 + dd.items.length) % dd.items.length
          draw()
          return
        }
        if (tryMoveVerticalInBuffer(-1)) {
          draw()
          return
        }
        if (opts.history.length > 0 && historyIdx + 1 < opts.history.length) {
          if (historyIdx === -1) draftBeforeHistory = buffer
          historyIdx += 1
          buffer = opts.history[historyIdx] ?? ''
          cursorOffset = buffer.length
          dropdownDismissed = true
          draw()
        }
        return
      }

      if (seq === '\x1b[B' || seq === '\x1bOB') {
        const dd = computeDropdown()
        if (dd && dd.items.length > 0) {
          dropdownIdx = (dropdownIdx + 1) % dd.items.length
          draw()
          return
        }
        if (tryMoveVerticalInBuffer(1)) {
          draw()
          return
        }
        if (historyIdx > -1) {
          historyIdx -= 1
          buffer = historyIdx >= 0 ? (opts.history[historyIdx] ?? '') : draftBeforeHistory
          cursorOffset = buffer.length
          dropdownDismissed = true
          draw()
        }
        return
      }

      // Word jump Left / Right (Ctrl+Left/Right, Alt+B/F).
      if (seq === '\x1b[1;5D' || seq === '\x1b[5D' || seq === '\x1bb') {
        const next = moveWordLeft(buffer, cursorOffset)
        if (next !== cursorOffset) {
          cursorOffset = next
          draw()
        }
        return
      }
      if (seq === '\x1b[1;5C' || seq === '\x1b[5C' || seq === '\x1bf') {
        const next = moveWordRight(buffer, cursorOffset)
        if (next !== cursorOffset) {
          cursorOffset = next
          draw()
        }
        return
      }

      // Left / Right / Home / End cursor navigation (code-point safe).
      if (seq === '\x1b[D' || seq === '\x1bOD') {
        const prev = prevCodePointOffset(buffer, cursorOffset)
        if (prev !== cursorOffset) {
          cursorOffset = prev
          draw()
        }
        return
      }
      if (seq === '\x1b[C' || seq === '\x1bOC') {
        const next = nextCodePointOffset(buffer, cursorOffset)
        if (next !== cursorOffset) {
          cursorOffset = next
          draw()
        }
        return
      }
      if (seq === '\x1b[H' || seq === '\x1bOH' || seq === '\x1b[1~' || seq === '\x01') {
        const lineStart = buffer.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1
        cursorOffset = lineStart
        draw()
        return
      }
      if (seq === '\x1b[F' || seq === '\x1bOF' || seq === '\x1b[4~' || seq === '\x05') {
        const nextNl = buffer.indexOf('\n', cursorOffset)
        cursorOffset = nextNl >= 0 ? nextNl : buffer.length
        draw()
        return
      }

      // Backspace / Delete (including whole pasted-pill removal) / Ctrl+W / Ctrl+U / Ctrl+K.
      if (seq === '\x7f' || seq === '\b') {
        if (cursorOffset > 0) {
          const pillBefore = findTokenBeforeCursor()
          const nextCursor = pillBefore
            ? cursorOffset - pillBefore.token.length
            : prevCodePointOffset(buffer, cursorOffset)
          buffer = buffer.slice(0, nextCursor) + buffer.slice(cursorOffset)
          cursorOffset = nextCursor
          dropdownDismissed = false
          dropdownIdx = 0
          dropdownScroll = 0
          draw()
        }
        return
      }
      if (seq === '\x1b[3~') {
        if (cursorOffset < buffer.length) {
          const pillAt = findTokenAtCursor()
          const nextOffset = pillAt
            ? cursorOffset + pillAt.token.length
            : nextCodePointOffset(buffer, cursorOffset)
          buffer = buffer.slice(0, cursorOffset) + buffer.slice(nextOffset)
          dropdownDismissed = false
          dropdownIdx = 0
          dropdownScroll = 0
          draw()
        }
        return
      }
      if (seq === '\x17') {
        deleteWordBack()
        draw()
        return
      }
      if (seq === '\x15') {
        const lineStart = buffer.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1
        buffer = buffer.slice(0, lineStart) + buffer.slice(cursorOffset)
        cursorOffset = lineStart
        dropdownDismissed = false
        draw()
        return
      }
      if (seq === '\x0b') {
        const nextNl = buffer.indexOf('\n', cursorOffset)
        const lineEnd = nextNl >= 0 ? nextNl : buffer.length
        buffer = buffer.slice(0, cursorOffset) + buffer.slice(lineEnd)
        draw()
        return
      }

      // Ignore unhandled escape sequences cleanly.
      if (seq.startsWith('\x1b')) return

      // Printable text insertion.
      if (seq >= ' ') {
        insertAtCursor(seq)
        draw()
      }
    }

    const onData = (chunk: Buffer) => {
      if (settled) return
      let raw = chunk.toString('utf8')

      while (raw.length > 0 && !settled) {
        if (inBracketedPaste) {
          const endIdx = raw.indexOf(PASTE_END)
          if (endIdx < 0) {
            pasteAccumulator += raw
            return
          }
          pasteAccumulator += raw.slice(0, endIdx)
          const fullPaste = pasteAccumulator
          pasteAccumulator = ''
          inBracketedPaste = false
          raw = raw.slice(endIdx + PASTE_END.length)
          insertPastedText(fullPaste)
          draw()
          continue
        }

        const startIdx = raw.indexOf(PASTE_START)
        if (startIdx === 0) {
          inBracketedPaste = true
          pasteAccumulator = ''
          raw = raw.slice(PASTE_START.length)
          continue
        }
        if (startIdx > 0) {
          const before = raw.slice(0, startIdx)
          raw = raw.slice(startIdx)
          for (const part of splitInputTokens(before)) handleKey(part)
          continue
        }

        for (const token of splitInputTokens(raw)) {
          if (settled) break
          handleKey(token)
        }
        break
      }
    }

    input.on('data', onData)
  })
}

function splitInputTokens(raw: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < raw.length) {
    if (raw[i] === '\x1b') {
      const m = /^(?:\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[bf\r])/.exec(raw.slice(i))
      if (m) {
        tokens.push(m[0])
        i += m[0].length
        continue
      }
      tokens.push('\x1b')
      i += 1
      continue
    }
    const cp = raw.codePointAt(i) ?? 0
    const glyph = String.fromCodePoint(cp)
    tokens.push(glyph)
    i += glyph.length
  }
  return tokens
}
