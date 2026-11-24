// Streaming & static terminal Markdown renderer with syntax highlighting, aligned Unicode tables, and word wrapping.
import { visibleWidth, padVisible, type CliPalette } from './theme.ts'

export interface MarkdownState {
  inFence: boolean
  fenceLang: string
  tableRows: string[]
  started: boolean
}

export interface MarkdownRenderOptions {
  indent?: number
  firstLinePrefixWidth?: number
}

export function createMarkdownState(): MarkdownState {
  return {
    inFence: false,
    fenceLang: '',
    tableRows: [],
    started: false,
  }
}

const JS_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'from', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
  'new', 'null', 'of', 'package', 'private', 'protected', 'public', 'readonly', 'return',
  'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var',
  'void', 'while', 'with', 'yield',
])

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
])

const RUST_GO_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'chan', 'const', 'continue', 'crate', 'default', 'defer',
  'else', 'enum', 'extern', 'fallthrough', 'false', 'fn', 'for', 'func', 'go', 'goto', 'if',
  'impl', 'in', 'interface', 'let', 'loop', 'make', 'map', 'match', 'mod', 'move', 'mut',
  'nil', 'package', 'pub', 'range', 'ref', 'return', 'select', 'self', 'Self', 'static',
  'struct', 'super', 'switch', 'trait', 'true', 'type', 'unsafe', 'use', 'var', 'where', 'while',
])

const SHELL_KEYWORDS = new Set([
  'case', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'exit', 'export', 'fi', 'for',
  'function', 'if', 'in', 'local', 'return', 'set', 'source', 'then', 'unset', 'until', 'while',
  'param', 'foreach', 'try', 'catch', 'finally', 'throw',
])

const SQL_KEYWORDS = new Set([
  'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CREATE', 'DELETE',
  'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'FROM', 'GROUP', 'HAVING', 'IN',
  'INDEX', 'INNER', 'INSERT', 'INTO', 'IS', 'JOIN', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL',
  'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN',
  'UNION', 'UPDATE', 'VALUES', 'WHEN', 'WHERE',
])

const TYPE_NAMES = new Set([
  'string', 'number', 'boolean', 'unknown', 'never', 'any', 'object', 'symbol', 'bigint',
  'Promise', 'Record', 'Array', 'Map', 'Set', 'Buffer', 'Error', 'Date', 'Partial', 'Readonly',
  'int', 'str', 'float', 'bool', 'list', 'dict', 'tuple', 'usize', 'isize', 'i32', 'i64',
  'u32', 'u64', 'f32', 'f64', 'String', 'Vec', 'Option', 'Result', 'error', 'any',
])

function normalizeCodeLang(raw: string): string {
  const clean = raw.trim().toLowerCase().split(/\s+/)[0] ?? ''
  if (clean === 'typescript' || clean === 'ts' || clean === 'tsx' || clean === 'mts' || clean === 'cts') return 'ts'
  if (clean === 'javascript' || clean === 'js' || clean === 'jsx' || clean === 'mjs' || clean === 'cjs') return 'js'
  if (clean === 'python' || clean === 'py') return 'py'
  if (clean === 'json' || clean === 'jsonc') return clean
  if (clean === 'bash' || clean === 'sh' || clean === 'zsh' || clean === 'shell' || clean === 'ps1' || clean === 'powershell' || clean === 'pwsh') {
    return 'sh'
  }
  if (clean === 'yaml' || clean === 'yml') return 'yaml'
  if (clean === 'rust' || clean === 'rs' || clean === 'go' || clean === 'golang') return clean
  if (clean === 'sql') return 'sql'
  if (clean === 'css' || clean === 'scss' || clean === 'less') return 'css'
  if (clean === 'diff' || clean === 'patch') return 'diff'
  return clean
}

function readQuotedSpan(line: string, start: number, quote: string): number {
  let i = start + 1
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      i += 2
      continue
    }
    if (line[i] === quote) return i + 1
    i += 1
  }
  return line.length
}

/** Lightweight zero-dependency single-line syntax highlighter for terminal code blocks. */
export function highlightCodeLine(line: string, rawLang: string, palette: CliPalette): string {
  if (!palette.enabled || !line) return line
  const lang = normalizeCodeLang(rawLang)

  if (lang === 'diff') {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      return palette.bold(palette.muted(line))
    }
    if (line.startsWith('@@')) return palette.cyan(line)
    if (line.startsWith('+')) return palette.green(line)
    if (line.startsWith('-')) return palette.red(line)
    return line
  }

  if (lang === 'yaml') {
    const commentIdx = line.search(/(?:^|\s)#/)
    const codePart = commentIdx >= 0 ? line.slice(0, commentIdx === 0 ? 0 : commentIdx + 1) : line
    const commentPart = commentIdx >= 0 ? line.slice(commentIdx === 0 ? 0 : commentIdx + 1) : ''
    const keyMatch = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*:)(.*)$/.exec(codePart)
    if (keyMatch) {
      const lead = keyMatch[1] ?? ''
      const key = palette.cyan(keyMatch[2] ?? '')
      const colon = palette.subtle(keyMatch[3] ?? ':')
      const val = highlightCodeLine(keyMatch[4] ?? '', 'json', palette)
      return `${lead}${key}${colon}${val}${commentPart ? palette.synComment(commentPart) : ''}`
    }
    if (commentPart) {
      return `${codePart}${palette.synComment(commentPart)}`
    }
  }

  const slashComment = lang === 'ts' || lang === 'js' || lang === 'jsonc' || lang === 'rust' || lang === 'rs' || lang === 'go' || lang === 'golang' || lang === 'css' || lang === ''
  const hashComment = lang === 'py' || lang === 'sh' || lang === 'yaml' || lang === ''
  const sqlComment = lang === 'sql'

  const kwSet =
    lang === 'py'
      ? PY_KEYWORDS
      : lang === 'rust' || lang === 'rs' || lang === 'go' || lang === 'golang'
        ? RUST_GO_KEYWORDS
        : lang === 'sh'
          ? SHELL_KEYWORDS
          : lang === 'sql'
            ? SQL_KEYWORDS
            : JS_KEYWORDS

  let out = ''
  let i = 0
  while (i < line.length) {
    const rest = line.slice(i)

    if (slashComment && rest.startsWith('//')) {
      out += palette.synComment(rest)
      break
    }
    if (sqlComment && rest.startsWith('--')) {
      out += palette.synComment(rest)
      break
    }
    if (hashComment && rest.startsWith('#')) {
      out += palette.synComment(rest)
      break
    }
    if (slashComment && rest.startsWith('/*')) {
      const closeIdx = line.indexOf('*/', i + 2)
      const end = closeIdx >= 0 ? closeIdx + 2 : line.length
      out += palette.synComment(line.slice(i, end))
      i = end
      continue
    }

    const ch = line[i]!
    if (ch === '"' || ch === "'" || (ch === '`' && lang !== 'sql')) {
      const end = readQuotedSpan(line, i, ch)
      const token = line.slice(i, end)
      if ((lang === 'json' || lang === 'jsonc') && ch === '"' && /^\s*:/.test(line.slice(end))) {
        out += palette.cyan(token)
      } else {
        out += palette.synString(token)
      }
      i = end
      continue
    }

    // Shell / CSS / decorator tokens
    if (ch === '$' && (lang === 'sh' || lang === '')) {
      const varMatch = /^\$(?:\{[A-Za-z0-9_:-]+\}|[A-Za-z0-9_?@*#-]+)/.exec(rest)
      if (varMatch) {
        out += palette.cyan(varMatch[0])
        i += varMatch[0].length
        continue
      }
    }

    if (ch === '@' && (lang === 'py' || lang === 'ts' || lang === 'js')) {
      const decMatch = /^@[A-Za-z_$][A-Za-z0-9_$.]*/.exec(rest)
      if (decMatch) {
        out += palette.synType(decMatch[0])
        i += decMatch[0].length
        continue
      }
    }

    // Numbers (only when not attached to end of an identifier)
    const prev = i > 0 ? line[i - 1]! : ''
    if (!/[A-Za-z0-9_$]/.test(prev)) {
      const numMatch = /^(?:0x[0-9a-fA-F]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![A-Za-z0-9_$])/.exec(rest)
      if (numMatch) {
        out += palette.synNumber(numMatch[0])
        i += numMatch[0].length
        continue
      }
    }

    // Identifiers & keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const idMatch = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(rest)
      if (idMatch) {
        const word = idMatch[0]
        const nextSlice = line.slice(i + word.length)
        const lookup = lang === 'sql' ? word.toUpperCase() : word
        if (kwSet.has(lookup)) {
          out += palette.synKeyword(word)
        } else if (TYPE_NAMES.has(word) || /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
          out += palette.synType(word)
        } else if (/^\s*\(/.test(nextSlice)) {
          out += palette.synFunc(word)
        } else {
          out += word
        }
        i += word.length
        continue
      }
    }

    out += ch
    i += 1
  }

  return out
}

export function renderInlineMarkdown(text: string, palette: CliPalette): string {
  const codeSpans: string[] = []
  let s = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const styled =
      palette.enabled && palette.themeId !== 'minimal'
        ? palette.bgCode(palette.cyan(` ${code} `))
        : palette.cyan(code)
    const idx = codeSpans.push(styled) - 1
    return `\u0000CODE${idx}\u0000`
  })

  // Markdown links: [label](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    return `${palette.underline(palette.blue(label))} ${palette.subtle(`(${url})`)}`
  })

  // Strikethrough: ~~text~~
  s = s.replace(/~~([^~\n]+)~~/g, (_m, inner: string) => palette.strike(inner))

  // Bold: **text**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_m, inner: string) => palette.bold(inner))

  // Italic: *text*
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_m, inner: string) => palette.italic(inner))

  return s.replace(/\u0000CODE(\d+)\u0000/g, (_m, idxStr: string) => codeSpans[Number(idxStr)] ?? '')
}

function updateActiveSgrState(
  state: { attrs: Set<string>; fg: string | null; bg: string | null },
  seq: string,
): void {
  if (seq === '\x1b[0m' || seq === '\x1b[m') {
    state.attrs.clear()
    state.fg = null
    state.bg = null
    return
  }
  if (seq === '\x1b[22m') {
    state.attrs.delete('\x1b[1m')
    state.attrs.delete('\x1b[2m')
    return
  }
  if (seq === '\x1b[23m') {
    state.attrs.delete('\x1b[3m')
    return
  }
  if (seq === '\x1b[24m') {
    state.attrs.delete('\x1b[4m')
    return
  }
  if (seq === '\x1b[29m') {
    state.attrs.delete('\x1b[9m')
    return
  }
  if (seq === '\x1b[39m') {
    state.fg = null
    return
  }
  if (seq === '\x1b[49m') {
    state.bg = null
    return
  }
  if (seq === '\x1b[1m' || seq === '\x1b[2m' || seq === '\x1b[3m' || seq === '\x1b[4m' || seq === '\x1b[9m') {
    state.attrs.add(seq)
    return
  }
  if (/^\x1b\[48;|^\x1b\[4[0-7]m$|^\x1b\[10[0-7]m$/.test(seq)) {
    state.bg = seq
    return
  }
  state.fg = seq
}

function replaySgrState(state: { attrs: Set<string>; fg: string | null; bg: string | null }): string {
  return [...state.attrs, state.bg ?? '', state.fg ?? ''].join('')
}

/** Word-wraps an ANSI-styled line cleanly while preserving active SGR styles across line breaks. */
function wrapStyledLine(
  line: string,
  firstWidth: number,
  contWidth: number,
  firstPrefix: string,
  contPrefix: string,
): string[] {
  const safeFirstW = Math.max(12, firstWidth)
  if (visibleWidth(line) <= safeFirstW) {
    return [`${firstPrefix}${line}`]
  }

  // Split into breakable tokens (whitespace vs non-whitespace) keeping ANSI codes intact.
  const chunks: Array<{ text: string; isSpace: boolean; width: number }> = []
  let i = 0
  while (i < line.length) {
    if (line[i] === ' ') {
      let end = i + 1
      while (end < line.length && line[end] === ' ') end += 1
      const spaces = line.slice(i, end)
      chunks.push({ text: spaces, isSpace: true, width: spaces.length })
      i = end
      continue
    }
    let word = ''
    while (i < line.length && line[i] !== ' ') {
      if (line[i] === '\x1b') {
        const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i))
        if (m) {
          word += m[0]
          i += m[0].length
          continue
        }
      }
      const cp = line.codePointAt(i) ?? 0
      const ch = String.fromCodePoint(cp)
      word += ch
      i += ch.length
    }
    chunks.push({ text: word, isSpace: false, width: visibleWidth(word) })
  }

  const out: string[] = []
  const sgr = { attrs: new Set<string>(), fg: null as string | null, bg: null as string | null }
  let curLine = ''
  let curWidth = 0
  let curLimit = safeFirstW
  let isFirst = true

  const trackChunkSgr = (text: string) => {
    const matches = text.match(/\x1b\[[0-9;]*m/g)
    if (!matches) return
    for (const seq of matches) updateActiveSgrState(sgr, seq)
  }

  const flushCurrent = () => {
    const hadOpen = sgr.attrs.size > 0 || sgr.fg !== null || sgr.bg !== null
    const prefix = isFirst ? firstPrefix : contPrefix
    out.push(`${prefix}${curLine}${hadOpen ? '\x1b[0m' : ''}`)
    isFirst = false
    curLimit = Math.max(12, contWidth)
    curLine = replaySgrState(sgr)
    curWidth = 0
  }

  for (const chunk of chunks) {
    if (chunk.isSpace) {
      if (curWidth === 0) {
        trackChunkSgr(chunk.text)
        continue
      }
      if (curWidth + chunk.width <= curLimit) {
        curLine += chunk.text
        curWidth += chunk.width
      }
      trackChunkSgr(chunk.text)
      continue
    }

    if (curWidth > 0 && curWidth + chunk.width > curLimit) {
      flushCurrent()
    }
    curLine += chunk.text
    curWidth += chunk.width
    trackChunkSgr(chunk.text)
  }

  if (curWidth > 0 || out.length === 0) {
    const prefix = isFirst ? firstPrefix : contPrefix
    out.push(`${prefix}${curLine}`)
  }

  return out
}

function renderBufferedTable(
  rawRows: readonly string[],
  palette: CliPalette,
  maxWidth: number,
  gutter: string,
): string[] {
  const parsedRows = rawRows.map((row) =>
    row
      .trim()
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim()),
  )
  const isSepRow = (cells: readonly string[]) => cells.every((c) => /^:?-+:?$/.test(c) || c === '')

  const sepIdx = parsedRows.findIndex(isSepRow)
  const dataRows = parsedRows.filter((r, idx) => idx !== sepIdx && !isSepRow(r))
  if (dataRows.length === 0) {
    return rawRows.map((r) => `${gutter}${palette.muted(r)}`)
  }

  const colCount = Math.max(1, ...dataRows.map((r) => r.length))
  const hasHeader = sepIdx > 0 || dataRows.length > 1

  const styledRows = dataRows.map((row, rowIdx) => {
    const paddedCells: string[] = []
    for (let c = 0; c < colCount; c += 1) {
      const raw = row[c] ?? ''
      const inline = renderInlineMarkdown(raw, palette)
      paddedCells.push(hasHeader && rowIdx === 0 ? palette.bold(inline) : inline)
    }
    return paddedCells
  })

  const colWidths = Array.from({ length: colCount }, (_, c) =>
    Math.max(3, ...styledRows.map((r) => visibleWidth(r[c] ?? ''))),
  )

  // Shrink wider columns proportionally if table exceeds maxWidth.
  const overhead = gutter.length + 1 + colCount * 3
  const availForCells = Math.max(colCount * 4, maxWidth - overhead)
  let totalCellWidth = colWidths.reduce((a, b) => a + b, 0)
  while (totalCellWidth > availForCells) {
    let widestIdx = 0
    for (let c = 1; c < colWidths.length; c += 1) {
      if ((colWidths[c] ?? 0) > (colWidths[widestIdx] ?? 0)) widestIdx = c
    }
    if ((colWidths[widestIdx] ?? 0) <= 4) break
    colWidths[widestIdx] = (colWidths[widestIdx] ?? 4) - 1
    totalCellWidth -= 1
  }

  const makeRule = (left: string, mid: string, right: string) =>
    `${gutter}${palette.border(`${left}${colWidths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`)}`

  const out: string[] = [makeRule('┌', '┬', '┐')]
  styledRows.forEach((row, rowIdx) => {
    const cells = colWidths.map((w, c) => ` ${padVisible(row[c] ?? '', w)} `)
    out.push(`${gutter}${palette.border('│')}${cells.join(palette.border('│'))}${palette.border('│')}`)
    if (hasHeader && rowIdx === 0 && styledRows.length > 1) {
      out.push(makeRule('├', '┼', '┤'))
    }
  })
  out.push(makeRule('└', '┴', '┘'))
  return out
}

function flushTableIfAny(
  state: MarkdownState,
  palette: CliPalette,
  maxWidth: number,
  gutter: string,
): string[] {
  if (state.tableRows.length === 0) return []
  const rows = state.tableRows
  state.tableRows = []
  return renderBufferedTable(rows, palette, maxWidth, gutter)
}

function renderSingleMarkdownLine(
  rawLine: string,
  state: MarkdownState,
  palette: CliPalette,
  maxWidth: number,
  opts: MarkdownRenderOptions,
): string[] {
  const indent = Math.max(0, opts.indent ?? 0)
  const firstPrefixW = Math.max(0, opts.firstLinePrefixWidth ?? 0)
  const isFirst = !state.started
  const linePrefix = isFirst && firstPrefixW > 0 ? '' : ' '.repeat(indent)
  const contPrefix = ' '.repeat(indent)
  const blockGutter = isFirst && firstPrefixW > 0 ? '' : ' '.repeat(Math.max(2, indent))
  const availFirst = Math.max(24, isFirst && firstPrefixW > 0 ? maxWidth - firstPrefixW : maxWidth - indent)
  const availCont = Math.max(24, maxWidth - indent)

  const trimmed = rawLine.trim()

  // Buffer Markdown table rows until table ends (outside code fences).
  if (!state.inFence && trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 3) {
    state.tableRows.push(rawLine)
    return []
  }

  const emitted: string[] = []
  if (state.tableRows.length > 0) {
    emitted.push(...flushTableIfAny(state, palette, maxWidth, isFirst && firstPrefixW > 0 ? '' : blockGutter))
    state.started = true
  }

  const fenceMatch = /^\s*```(.*)$/.exec(rawLine)
  if (fenceMatch) {
    if (!state.inFence) {
      state.inFence = true
      state.fenceLang = (fenceMatch[1] ?? '').trim()
      const label = state.fenceLang ? `${palette.cyan(state.fenceLang)} ` : ''
      const ruleLen = Math.max(8, Math.min(54, availCont - 8 - state.fenceLang.length))
      emitted.push(`${blockGutter}${palette.border('╭─ ')}${label}${palette.border('─'.repeat(ruleLen))}`)
    } else {
      state.inFence = false
      state.fenceLang = ''
      emitted.push(`${blockGutter}${palette.border(`╰${'─'.repeat(Math.max(12, Math.min(60, availCont - 4)))}`)}`)
    }
    state.started = true
    return emitted
  }

  if (state.inFence) {
    const highlighted = highlightCodeLine(rawLine, state.fenceLang, palette)
    emitted.push(`${blockGutter}${palette.border('│')} ${highlighted}`)
    state.started = true
    return emitted
  }

  if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(rawLine)) {
    emitted.push(`${blockGutter}${palette.border('─'.repeat(Math.max(16, Math.min(60, availCont - 4))))}`)
    state.started = true
    return emitted
  }

  const headingMatch = /^(#{1,6})\s+(.*)$/.exec(rawLine)
  if (headingMatch) {
    const hashes = headingMatch[1]!
    const title = renderInlineMarkdown(headingMatch[2] ?? '', palette)
    const styled = hashes.length <= 2 ? palette.accent(palette.bold(title)) : palette.bold(title)
    emitted.push(...wrapStyledLine(styled, availFirst, availCont, linePrefix, contPrefix))
    state.started = true
    return emitted
  }

  const quoteMatch = /^\s*>\s?(.*)$/.exec(rawLine)
  if (quoteMatch) {
    const qPrefix = `${blockGutter}${palette.accent('┃')} `
    const body = palette.muted(renderInlineMarkdown(quoteMatch[1] ?? '', palette))
    emitted.push(...wrapStyledLine(body, availFirst - 2, availCont - 2, qPrefix, qPrefix))
    state.started = true
    return emitted
  }

  // Task list items `- [x] ...` or `- [ ] ...`
  const listLeadPad = indent >= 2 ? '' : '  '
  const taskMatch = /^(\s*)[*-]\s+\[([ xX])\]\s+(.*)$/.exec(rawLine)
  if (taskMatch) {
    const subLead = taskMatch[1] ?? ''
    const checked = (taskMatch[2] ?? ' ').toLowerCase() === 'x'
    const icon = checked ? palette.green('☑') : palette.subtle('☐')
    const firstBullet = `${linePrefix}${subLead}${listLeadPad}${icon} `
    const hangPad = ' '.repeat(subLead.length + listLeadPad.length + 2)
    const hangBullet = `${contPrefix}${hangPad}`
    const markerW = subLead.length + listLeadPad.length + 2
    const body = renderInlineMarkdown(taskMatch[3] ?? '', palette)
    emitted.push(...wrapStyledLine(body, availFirst - markerW, availCont - markerW, firstBullet, hangBullet))
    state.started = true
    return emitted
  }

  const bulletMatch = /^(\s*)[*-]\s+(.*)$/.exec(rawLine)
  if (bulletMatch) {
    const lead = bulletMatch[1] ?? ''
    const firstBullet = `${linePrefix}${lead}${listLeadPad}${palette.accent('•')} `
    const markerW = lead.length + listLeadPad.length + 2
    const hangBullet = `${contPrefix}${' '.repeat(markerW)}`
    const body = renderInlineMarkdown(bulletMatch[2] ?? '', palette)
    emitted.push(...wrapStyledLine(body, availFirst - markerW, availCont - markerW, firstBullet, hangBullet))
    state.started = true
    return emitted
  }

  const numMatch = /^(\s*)(\d+)\.\s+(.*)$/.exec(rawLine)
  if (numMatch) {
    const lead = numMatch[1] ?? ''
    const num = numMatch[2] ?? '1'
    const markerW = lead.length + listLeadPad.length + num.length + 2
    const firstBullet = `${linePrefix}${lead}${listLeadPad}${palette.accent(`${num}.`)} `
    const hangBullet = `${contPrefix}${' '.repeat(markerW)}`
    const body = renderInlineMarkdown(numMatch[3] ?? '', palette)
    emitted.push(...wrapStyledLine(body, availFirst - markerW, availCont - markerW, firstBullet, hangBullet))
    state.started = true
    return emitted
  }

  if (!trimmed) {
    emitted.push('')
    state.started = true
    return emitted
  }

  const inline = renderInlineMarkdown(rawLine, palette)
  emitted.push(...wrapStyledLine(inline, availFirst, availCont, linePrefix, contPrefix))
  state.started = true
  return emitted
}

export function renderMarkdownLine(
  rawLine: string,
  state: MarkdownState,
  palette: CliPalette,
  maxWidth = 96,
): string {
  const lines = renderSingleMarkdownLine(rawLine, state, palette, maxWidth, {})
  return lines.join('\n')
}

/** Renders complete multi-line Markdown text to terminal ANSI lines. */
export function renderMarkdown(
  text: string,
  palette: CliPalette,
  maxWidth = 96,
  opts: MarkdownRenderOptions = {},
): string {
  const state = createMarkdownState()
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    out.push(...renderSingleMarkdownLine(line, state, palette, maxWidth, opts))
  }
  const blockGutter = ' '.repeat(Math.max(2, opts.indent ?? 0))
  out.push(...flushTableIfAny(state, palette, maxWidth, blockGutter))
  if (state.inFence) {
    out.push(`${blockGutter}${palette.border(`╰${'─'.repeat(Math.max(12, Math.min(60, maxWidth - blockGutter.length - 2)))}`)}`)
  }
  return out.join('\n')
}

export interface MarkdownStream {
  push: (delta: string) => void
  flush: () => void
  reset: () => void
}

/** Incremental line-buffered Markdown stream suitable for live agent text output. */
export function createMarkdownStream(opts: {
  write: (chunk: string) => void
  palette: CliPalette
  maxWidth?: () => number
  indent?: number
  firstLinePrefixWidth?: number
}): MarkdownStream {
  const { write, palette } = opts
  const getWidth = opts.maxWidth ?? (() => 96)
  const renderOpts: MarkdownRenderOptions = {
    ...(opts.indent !== undefined ? { indent: opts.indent } : {}),
    ...(opts.firstLinePrefixWidth !== undefined ? { firstLinePrefixWidth: opts.firstLinePrefixWidth } : {}),
  }
  let buffer = ''
  let state = createMarkdownState()
  let cursorAtCol0 = !renderOpts.firstLinePrefixWidth
  let lastPushEndedWithNl = true

  const emitLine = (line: string, newline: boolean) => {
    const renderedLines = renderSingleMarkdownLine(line, state, palette, getWidth(), renderOpts)
    if (renderedLines.length === 0) return
    const text = renderedLines.join('\n')
    write(newline ? `${text}\n` : text)
    cursorAtCol0 = newline
  }

  return {
    push(delta: string) {
      const norm = delta.replace(/\r\n/g, '\n')
      if (norm.length > 0) lastPushEndedWithNl = norm.endsWith('\n')
      buffer += norm
      let nlIdx = buffer.indexOf('\n')
      while (nlIdx >= 0) {
        const line = buffer.slice(0, nlIdx)
        buffer = buffer.slice(nlIdx + 1)
        emitLine(line, true)
        nlIdx = buffer.indexOf('\n')
      }
    },
    flush() {
      if (buffer.length > 0) {
        emitLine(buffer, false)
        buffer = ''
      }
      const blockGutter = ' '.repeat(Math.max(2, renderOpts.indent ?? 0))
      const trailingTable = flushTableIfAny(state, palette, getWidth(), blockGutter)
      if (trailingTable.length > 0) {
        const lead = cursorAtCol0 ? '' : '\n'
        const tail = lastPushEndedWithNl ? '\n' : ''
        write(`${lead}${trailingTable.join('\n')}${tail}`)
        cursorAtCol0 = lastPushEndedWithNl
      }
      if (state.inFence) {
        state.inFence = false
        state.fenceLang = ''
        const lead = cursorAtCol0 ? '' : '\n'
        const tail = lastPushEndedWithNl ? '\n' : ''
        write(`${lead}${blockGutter}${palette.border(`╰${'─'.repeat(Math.max(12, Math.min(60, getWidth() - blockGutter.length - 2)))}`)}${tail}`)
      }
    },
    reset() {
      buffer = ''
      state = createMarkdownState()
      cursorAtCol0 = !renderOpts.firstLinePrefixWidth
      lastPushEndedWithNl = true
    },
  }
}
