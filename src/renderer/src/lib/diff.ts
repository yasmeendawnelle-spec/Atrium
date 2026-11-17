import type { DiffReviewComment } from '../../../shared/types.ts'

export interface ParsedDiffLine {
  index: number
  kind: 'file' | 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  oldLine?: number
  newLine?: number
  side?: 'old' | 'new'
  line?: number
}

const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

/** Parses unified diff output and attaches 1-based old/new file line coordinates. */
export function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  const raw = diff.split('\n')
  const out: ParsedDiffLine[] = []
  let oldPtr = 0
  let newPtr = 0

  for (let i = 0; i < raw.length; i++) {
    const text = raw[i] ?? ''
    if (text.startsWith('---') || text.startsWith('+++')) {
      out.push({ index: i, kind: 'file', text })
      continue
    }
    const hunk = HUNK_RE.exec(text)
    if (hunk) {
      oldPtr = Number(hunk[1])
      newPtr = Number(hunk[2])
      out.push({ index: i, kind: 'hunk', text })
      continue
    }
    if (text.startsWith('+')) {
      const line = newPtr++
      out.push({ index: i, kind: 'add', text, newLine: line, side: 'new', line })
      continue
    }
    if (text.startsWith('-')) {
      const line = oldPtr++
      out.push({ index: i, kind: 'del', text, oldLine: line, side: 'old', line })
      continue
    }
    const oLine = oldPtr > 0 ? oldPtr++ : undefined
    const nLine = newPtr > 0 ? newPtr++ : undefined
    out.push({
      index: i,
      kind: 'ctx',
      text,
      oldLine: oLine,
      newLine: nLine,
      ...(nLine !== undefined ? { side: 'new' as const, line: nLine } : {}),
    })
  }
  return out
}

export interface SplitDiffRow {
  index: number
  kind: 'file' | 'hunk' | 'pair'
  headerText?: string
  left?: ParsedDiffLine
  right?: ParsedDiffLine
}

/** Pairs unified diff entries into side-by-side Split view rows preserving line alignment. */
export function buildSplitDiffRows(parsed: ParsedDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = []
  let i = 0
  let rowIdx = 0
  while (i < parsed.length) {
    const cur = parsed[i]!
    if (cur.kind === 'file' || cur.kind === 'hunk') {
      rows.push({ index: rowIdx++, kind: cur.kind, headerText: cur.text })
      i++
      continue
    }
    if (cur.kind === 'ctx') {
      rows.push({ index: rowIdx++, kind: 'pair', left: cur, right: cur })
      i++
      continue
    }
    const dels: ParsedDiffLine[] = []
    const adds: ParsedDiffLine[] = []
    while (i < parsed.length && (parsed[i]!.kind === 'del' || parsed[i]!.kind === 'add')) {
      if (parsed[i]!.kind === 'del') dels.push(parsed[i]!)
      else adds.push(parsed[i]!)
      i++
    }
    const maxLen = Math.max(dels.length, adds.length)
    for (let k = 0; k < maxLen; k++) {
      rows.push({
        index: rowIdx++,
        kind: 'pair',
        left: dels[k],
        right: adds[k],
      })
    }
  }
  return rows
}

/** Formats pending inline diff comments into an actionable prompt for the agent. */
export function formatReviewPrompt(header: string, comments: DiffReviewComment[]): string {
  const blocks = comments.map((c, idx) => {
    const loc = `${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`
    const snippet = c.snippet.trim()
    return [
      `${idx + 1}. \`${loc}\``,
      ...(snippet ? [`   Code: \`${snippet.slice(0, 140)}\``] : []),
      `   Review note: ${c.body.trim()}`,
    ].join('\n')
  })
  return `${header}\n\n${blocks.join('\n\n')}`
}
