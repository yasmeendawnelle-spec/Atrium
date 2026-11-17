import { createElement, type ReactNode } from 'react'

export type TokenKind = 'comment' | 'string' | 'keyword' | 'type' | 'number' | 'func' | 'prop' | 'op' | 'add' | 'del' | 'hunk' | 'plain'

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'def', 'defer', 'delete', 'do', 'elif', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'fn', 'for', 'from', 'func', 'function', 'go', 'if', 'impl', 'import',
  'in', 'interface', 'is', 'let', 'loop', 'match', 'mut', 'namespace', 'new', 'nil', 'none',
  'None', 'not', 'null', 'or', 'package', 'pass', 'private', 'pub', 'public', 'raise',
  'readonly', 'return', 'self', 'select', 'static', 'struct', 'super', 'switch', 'this',
  'throw', 'trait', 'true', 'True', 'False', 'try', 'type', 'typeof', 'undefined', 'use',
  'var', 'void', 'while', 'with', 'yield', 'and', 'SELECT', 'FROM', 'WHERE', 'INSERT',
  'UPDATE', 'DELETE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON', 'AS', 'ORDER', 'BY', 'GROUP',
  'LIMIT', 'CREATE', 'TABLE', 'ALTER', 'DROP', 'VALUES', 'INTO', 'SET',
])

const BUILTIN_TYPES = new Set([
  'string', 'number', 'boolean', 'unknown', 'any', 'never', 'object', 'symbol', 'bigint',
  'Promise', 'Record', 'Array', 'Map', 'Set', 'Error', 'Date', 'RegExp', 'Buffer',
  'int', 'float', 'str', 'bool', 'list', 'dict', 'tuple', 'set', 'i32', 'i64', 'u32', 'u64',
  'usize', 'f64', 'Option', 'Result', 'Vec', 'String',
])

const CODE_LANGS = new Set([
  'ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript', 'mjs', 'cjs', 'py', 'python',
  'json', 'jsonc', 'sh', 'bash', 'zsh', 'shell', 'ps1', 'powershell', 'pwsh',
  'css', 'scss', 'less', 'html', 'xml', 'svg', 'yaml', 'yml', 'toml', 'sql',
  'rs', 'rust', 'go', 'golang', 'java', 'c', 'cpp', 'cs', 'csharp', 'md', 'markdown', 'diff', 'patch',
])

function isDiffLang(lang: string): boolean {
  return lang === 'diff' || lang === 'patch'
}

function isHashCommentLang(lang: string): boolean {
  return ['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'ps1', 'powershell', 'pwsh', 'yaml', 'yml', 'toml'].includes(lang)
}

function isSlashCommentLang(lang: string): boolean {
  return !isHashCommentLang(lang) && !['html', 'xml', 'svg', 'sql', 'md', 'markdown'].includes(lang)
}

function highlightDiff(text: string): ReactNode[] {
  const lines = text.split('\n')
  return lines.map((line, i) => {
    const cls =
      line.startsWith('+++') || line.startsWith('---')
        ? 'tok-hunk'
        : line.startsWith('@@')
          ? 'tok-hunk'
          : line.startsWith('+')
            ? 'tok-add'
            : line.startsWith('-')
              ? 'tok-del'
              : 'tok-plain'
    const suffix = i < lines.length - 1 ? '\n' : ''
    return cls === 'tok-plain' ? `${line}${suffix}` : createElement('span', { key: i, className: cls }, `${line}${suffix}`)
  })
}

/** Highlights a single line or block of source code into safe React elements. */
export function highlightCode(code: string, rawLang = ''): ReactNode {
  const lang = rawLang.trim().toLowerCase()
  if (!code) return code
  if (isDiffLang(lang)) return highlightDiff(code)
  if (lang && !CODE_LANGS.has(lang) && lang !== 'code') return code

  const out: ReactNode[] = []
  let i = 0
  let plainStart = 0
  let key = 0

  const flushPlain = (end: number) => {
    if (end > plainStart) out.push(code.slice(plainStart, end))
    plainStart = end
  }
  const emit = (kind: TokenKind, start: number, end: number) => {
    flushPlain(start)
    out.push(createElement('span', { key: key++, className: `tok-${kind}` }, code.slice(start, end)))
    plainStart = end
  }

  const slashComments = isSlashCommentLang(lang)
  const hashComments = isHashCommentLang(lang) || lang === 'code' || !lang
  const isJson = lang === 'json' || lang === 'jsonc'
  const isMarkup = lang === 'html' || lang === 'xml' || lang === 'svg'
  const len = code.length

  while (i < len) {
    const ch = code[i]!
    const next = code[i + 1]

    // Comments: //, /* */, #, -- (SQL), <!-- -->
    if (slashComments && ch === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? len : nl
      emit('comment', i, end)
      i = end
      continue
    }
    if (slashComments && ch === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2)
      const end = close === -1 ? len : close + 2
      emit('comment', i, end)
      i = end
      continue
    }
    if (hashComments && ch === '#' && (i === 0 || /\s/.test(code[i - 1]!))) {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? len : nl
      emit('comment', i, end)
      i = end
      continue
    }
    if (lang === 'sql' && ch === '-' && next === '-') {
      const nl = code.indexOf('\n', i)
      const end = nl === -1 ? len : nl
      emit('comment', i, end)
      i = end
      continue
    }
    if (isMarkup && code.startsWith('<!--', i)) {
      const close = code.indexOf('-->', i + 4)
      const end = close === -1 ? len : close + 3
      emit('comment', i, end)
      i = end
      continue
    }

    // Strings: ', ", `
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < len) {
        const c = code[j]!
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === ch) {
          j++
          break
        }
        if (c === '\n' && ch !== '`') break
        j++
      }
      // JSON property keys: "..." followed by ':'
      if (isJson && ch === '"') {
        let k = j
        while (k < len && (code[k] === ' ' || code[k] === '\t')) k++
        if (code[k] === ':') {
          emit('prop', i, j)
          i = j
          continue
        }
      }
      emit('string', i, j)
      i = j
      continue
    }

    // Markup tags <tag> / </tag>
    if (isMarkup && ch === '<' && (next === '/' || /[a-zA-Z!]/.test(next ?? ''))) {
      let j = i + 1
      if (code[j] === '/') j++
      const nameStart = j
      while (j < len && /[a-zA-Z0-9_:-]/.test(code[j]!)) j++
      if (j > nameStart) {
        emit('keyword', i, j)
        i = j
        continue
      }
    }

    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$]/.test(code[i - 1]!))) {
      let j = i + 1
      while (j < len && /[0-9a-fA-FxXoObB_.]/.test(code[j]!)) j++
      emit('number', i, j)
      i = j
      continue
    }

    // Identifiers, keywords, types, functions
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1
      while (j < len && /[a-zA-Z0-9_$-]/.test(code[j]!)) j++
      const word = code.slice(i, j)
      if (KEYWORDS.has(word)) {
        emit('keyword', i, j)
      } else if (BUILTIN_TYPES.has(word) || (/^[A-Z][a-zA-Z0-9_]*$/.test(word) && !/^[A-Z0-9_]+$/.test(word))) {
        emit('type', i, j)
      } else {
        // Peek ahead for '(' => function call or definition
        let k = j
        while (k < len && (code[k] === ' ' || code[k] === '\t')) k++
        if (code[k] === '(') emit('func', i, j)
        else if (code[k] === ':' && !isJson) emit('prop', i, j)
      }
      i = j
      continue
    }

    i++
  }

  flushPlain(len)
  return out
}
