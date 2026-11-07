// Local document extractor for PDF, DOCX, XLSX, and PPTX files.
// Pure JS/ESM dependencies only (no native addons) and lazy-imported on demand so app startup stays instant.
import { extname } from 'node:path'
import type { DocumentKind } from '../../shared/types.ts'

export type SupportedDocumentKind = Exclude<DocumentKind, 'text'>

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_CHARS = 160_000
const MAX_XLSX_ROWS_PER_SHEET = 400
const MAX_XLSX_COLS_PER_ROW = 40

export interface ExtractedDocument {
  docKind: SupportedDocumentKind
  content: string
  truncated: boolean
  byteSize: number
  pageCount?: number
  sheetCount?: number
  slideCount?: number
  sheetNames?: string[]
}

export function classifyDocumentExt(filePath: string): SupportedDocumentKind | 'legacy_office' | null {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'docx'
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx'
  if (ext === '.pptx') return 'pptx'
  if (ext === '.doc' || ext === '.xls' || ext === '.ppt') return 'legacy_office'
  return null
}

function clampText(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()
  if (normalized.length <= maxChars) return { text: normalized, truncated: false }
  return {
    text: `${normalized.slice(0, maxChars).trimEnd()}\n\n… [Document output truncated at ${maxChars.toLocaleString()} characters]`,
    truncated: true,
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = Number(n)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

function extractDrawingTextRuns(xml: string): string[] {
  const paragraphs: string[] = []
  const pMatches = xml.match(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g) ?? []
  for (const p of pMatches) {
    const tokens: string[] = []
    const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
    let match: RegExpExecArray | null
    while ((match = tRe.exec(p)) !== null) {
      if (match[1]) tokens.push(decodeXmlEntities(match[1]))
    }
    const line = tokens.join('').replace(/\s+/g, ' ').trim()
    if (line) paragraphs.push(line)
  }
  return paragraphs
}

function formatCellValue(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) {
    return Number.isNaN(cell.getTime()) ? '' : cell.toISOString().slice(0, 10)
  }
  return String(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

async function extractPdf(buf: Buffer, maxChars: number): Promise<Omit<ExtractedDocument, 'docKind' | 'byteSize'>> {
  const { extractText } = await import('unpdf')
  const res = await extractText(new Uint8Array(buf), { mergePages: false })
  const pages = Array.isArray(res.text) ? res.text : [String(res.text ?? '')]
  const totalPages = Number(res.totalPages) || pages.length
  const sections: string[] = []
  for (let i = 0; i < pages.length; i++) {
    const cleaned = (pages[i] ?? '').replace(/\u0000/g, '').trim()
    if (cleaned) sections.push(`## Page ${i + 1}\n${cleaned}`)
  }
  const raw =
    sections.length > 0
      ? sections.join('\n\n')
      : `[PDF has ${totalPages} page(s) with no extractable selectable text; it may be a scanned image PDF.]`
  const clamped = clampText(raw, maxChars)
  return {
    content: clamped.text,
    truncated: clamped.truncated,
    pageCount: totalPages,
  }
}

async function extractDocx(buf: Buffer, maxChars: number): Promise<Omit<ExtractedDocument, 'docKind' | 'byteSize'>> {
  const mod = (await import('mammoth')) as { default?: typeof import('mammoth') } & typeof import('mammoth')
  const mammoth = mod.default ?? mod
  const md = await mammoth.convertToMarkdown({ buffer: buf }).catch(() => null)
  let raw = md?.value?.trim() ?? ''
  if (!raw) {
    const plain = await mammoth.extractRawText({ buffer: buf })
    raw = plain.value?.trim() ?? ''
  }
  const clamped = clampText(raw || '(empty Word document)', maxChars)
  return {
    content: clamped.text,
    truncated: clamped.truncated,
  }
}

async function extractXlsx(buf: Buffer, maxChars: number): Promise<Omit<ExtractedDocument, 'docKind' | 'byteSize'>> {
  const mod = await import('read-excel-file/node')
  const readXlsxFile = mod.default
  const sheets = await readXlsxFile(buf)
  const sheetNames = sheets.map((s) => s.sheet)
  const blocks: string[] = []

  for (const sheet of sheets) {
    const nonEmptyRows = sheet.data.filter((row) => row.some((c) => c !== null && c !== undefined && String(c).trim() !== ''))
    if (nonEmptyRows.length === 0) {
      blocks.push(`### Sheet: ${sheet.sheet}\n_(empty sheet)_`)
      continue
    }
    const maxCols = Math.min(
      MAX_XLSX_COLS_PER_ROW,
      Math.max(1, ...nonEmptyRows.slice(0, MAX_XLSX_ROWS_PER_SHEET).map((r) => r.length)),
    )
    const sliceRows = nonEmptyRows.slice(0, MAX_XLSX_ROWS_PER_SHEET)
    const lines: string[] = [`### Sheet: ${sheet.sheet} (${nonEmptyRows.length} non-empty rows)`]
    const renderRow = (row: unknown[]) =>
      `| ${Array.from({ length: maxCols }, (_, idx) => formatCellValue(row[idx])).join(' | ')} |`
    lines.push(renderRow(sliceRows[0]!))
    lines.push(`| ${Array.from({ length: maxCols }, () => '---').join(' | ')} |`)
    for (let i = 1; i < sliceRows.length; i++) {
      lines.push(renderRow(sliceRows[i]!))
    }
    if (nonEmptyRows.length > MAX_XLSX_ROWS_PER_SHEET) {
      lines.push(`\n_… ${nonEmptyRows.length - MAX_XLSX_ROWS_PER_SHEET} more rows omitted_`)
    }
    blocks.push(lines.join('\n'))
  }

  const clamped = clampText(blocks.join('\n\n') || '(empty workbook)', maxChars)
  return {
    content: clamped.text,
    truncated: clamped.truncated,
    sheetCount: sheets.length,
    sheetNames,
  }
}

async function extractPptx(buf: Buffer, maxChars: number): Promise<Omit<ExtractedDocument, 'docKind' | 'byteSize'>> {
  const { strFromU8, unzipSync } = await import('fflate')
  const entries = unzipSync(new Uint8Array(buf))
  const slideEntries = Object.keys(entries)
    .map((name) => {
      const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)
      return m ? { name, num: Number(m[1]) } : null
    })
    .filter((v): v is { name: string; num: number } => v !== null)
    .sort((a, b) => a.num - b.num)

  const sections: string[] = []
  for (const slide of slideEntries) {
    const rawXml = entries[slide.name]
    if (!rawXml) continue
    const lines = extractDrawingTextRuns(strFromU8(rawXml))
    const noteEntry = entries[`ppt/notesSlides/notesSlide${slide.num}.xml`]
    const noteLines = noteEntry ? extractDrawingTextRuns(strFromU8(noteEntry)) : []
    const body = lines.length ? lines.join('\n') : '(empty slide)'
    const noteBlock = noteLines.length ? `\n\n_Speaker notes: ${noteLines.join(' ')}_` : ''
    sections.push(`## Slide ${slide.num}\n${body}${noteBlock}`)
  }

  const clamped = clampText(sections.join('\n\n') || '(empty PowerPoint deck)', maxChars)
  return {
    content: clamped.text,
    truncated: clamped.truncated,
    slideCount: slideEntries.length,
  }
}

export async function extractDocument(
  filePathOrName: string,
  buf: Buffer,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ExtractedDocument> {
  const kind = classifyDocumentExt(filePathOrName)
  if (!kind || kind === 'legacy_office') {
    throw new Error(`Unsupported document format for "${filePathOrName}".`)
  }
  const base =
    kind === 'pdf'
      ? await extractPdf(buf, maxChars)
      : kind === 'docx'
        ? await extractDocx(buf, maxChars)
        : kind === 'xlsx'
          ? await extractXlsx(buf, maxChars)
          : await extractPptx(buf, maxChars)
  return {
    docKind: kind,
    byteSize: buf.byteLength,
    ...base,
  }
}
