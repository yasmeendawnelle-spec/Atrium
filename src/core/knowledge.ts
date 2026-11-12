// Per-workspace Project Knowledge Base & bilingual (EN + CJK) BM25 search index.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { DocumentKind, KnowledgeHit, KnowledgeSource, KnowledgeStats } from '../shared/types.ts'
import { newId, readJson, writeJson } from './store.ts'
import { classifyDocumentExt, extractDocument, MAX_DOCUMENT_BYTES } from './tools/documents.ts'

interface KnowledgeChunk {
  id: string
  sourceId: string
  title: string
  path?: string
  section?: string
  text: string
  length: number
  tf: Record<string, number>
}

interface WorkspaceKnowledgeIndex {
  workspace: string
  sources: KnowledgeSource[]
  chunks: KnowledgeChunk[]
}

const MAX_TEXT_SOURCE_BYTES = 512 * 1024
const CHUNK_TARGET_CHARS = 850
const CHUNK_OVERLAP_CHARS = 120
const GLOBAL_KB_KEY = '__global__'

function wsScopeKey(workspace?: string): string {
  const trimmed = workspace?.trim()
  if (!trimmed) return GLOBAL_KB_KEY
  const norm = resolve(trimmed).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm.toLowerCase() : norm
}

function wsHash(workspace?: string): string {
  return createHash('sha1').update(wsScopeKey(workspace)).digest('hex').slice(0, 16)
}

/** Hybrid EN identifier + CJK bigram/unigram tokenizer for fast offline BM25 retrieval. */
export function tokenizeForSearch(input: string): string[] {
  const lower = input.toLowerCase()
  const tokens: string[] = []

  const latinMatches = lower.match(/[a-z0-9_.-]{2,}/g)
  if (latinMatches) {
    for (const tok of latinMatches) {
      tokens.push(tok)
      if (tok.includes('_') || tok.includes('-') || tok.includes('.')) {
        for (const sub of tok.split(/[._-]+/)) {
          if (sub.length >= 2) tokens.push(sub)
        }
      }
    }
  }

  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g)
  if (cjkRuns) {
    for (const run of cjkRuns) {
      if (run.length === 1) {
        tokens.push(run)
      } else {
        for (let i = 0; i < run.length; i++) {
          tokens.push(run[i]!)
          if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
        }
      }
    }
  }

  return tokens
}

function buildTf(tokens: string[]): Record<string, number> {
  const tf: Record<string, number> = {}
  for (const t of tokens) {
    tf[t] = (tf[t] ?? 0) + 1
  }
  return tf
}

function chunkText(sourceId: string, title: string, path: string | undefined, content: string): KnowledgeChunk[] {
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const blocks = normalized.split(/\n{2,}/)
  const chunks: KnowledgeChunk[] = []
  let activeSection: string | undefined
  let buffer = ''

  const flush = () => {
    const clean = buffer.trim()
    if (!clean) return
    const tokens = tokenizeForSearch(`${title} ${activeSection ?? ''} ${clean}`)
    chunks.push({
      id: `${sourceId}_${chunks.length + 1}`,
      sourceId,
      title,
      path,
      section: activeSection,
      text: clean,
      length: tokens.length || 1,
      tf: buildTf(tokens),
    })
  }

  for (const rawBlock of blocks) {
    const block = rawBlock.trim()
    if (!block) continue
    const heading = /^(?:#{1,4}\s+(.+)|---\s+(Slide \d+)\s+---)$/.exec(block.split('\n')[0] ?? '')
    if (heading) {
      if (buffer.trim().length > 220) {
        flush()
        buffer = ''
      }
      activeSection = (heading[1] ?? heading[2] ?? '').trim().slice(0, 80) || activeSection
    }

    if (buffer.length + block.length + 2 > CHUNK_TARGET_CHARS && buffer.trim()) {
      flush()
      const tail = buffer.trim().slice(-CHUNK_OVERLAP_CHARS)
      buffer = tail ? `${tail}\n\n${block}` : block
    } else {
      buffer = buffer ? `${buffer}\n\n${block}` : block
    }

    while (buffer.length > CHUNK_TARGET_CHARS * 1.6) {
      const slice = buffer.slice(0, CHUNK_TARGET_CHARS)
      buffer = buffer.slice(Math.max(1, CHUNK_TARGET_CHARS - CHUNK_OVERLAP_CHARS))
      const tokens = tokenizeForSearch(`${title} ${activeSection ?? ''} ${slice}`)
      chunks.push({
        id: `${sourceId}_${chunks.length + 1}`,
        sourceId,
        title,
        path,
        section: activeSection,
        text: slice.trim(),
        length: tokens.length || 1,
        tf: buildTf(tokens),
      })
    }
  }
  flush()
  return chunks
}

async function loadIndexFile(filePath: string, workspaceLabel: string): Promise<WorkspaceKnowledgeIndex> {
  const saved = await readJson<WorkspaceKnowledgeIndex>(filePath, {
    workspace: workspaceLabel,
    sources: [],
    chunks: [],
  })
  return {
    workspace: saved.workspace || workspaceLabel,
    sources: Array.isArray(saved.sources) ? saved.sources : [],
    chunks: Array.isArray(saved.chunks) ? saved.chunks : [],
  }
}

export class KnowledgeBaseManager {
  private readonly dir: string
  private readonly cache = new Map<string, WorkspaceKnowledgeIndex>()
  private readonly onChange?: (stats: KnowledgeStats) => void

  constructor(dir: string, onChange?: (stats: KnowledgeStats) => void) {
    this.dir = dir
    this.onChange = onChange
  }

  private indexFilePath(workspace?: string): string {
    return join(this.dir, 'knowledge', `${wsHash(workspace)}.json`)
  }

  private async ensureLoaded(workspace?: string): Promise<WorkspaceKnowledgeIndex> {
    const key = wsScopeKey(workspace)
    const cached = this.cache.get(key)
    if (cached) return cached
    const loaded = await loadIndexFile(this.indexFilePath(workspace), workspace?.trim() || 'Global')
    this.cache.set(key, loaded)
    return loaded
  }

  private toStats(idx: WorkspaceKnowledgeIndex, workspace?: string): KnowledgeStats {
    return {
      workspace,
      sourceCount: idx.sources.length,
      chunkCount: idx.chunks.length,
      sources: [...idx.sources].sort((a, b) => b.updatedAt - a.updatedAt),
    }
  }

  private async persist(idx: WorkspaceKnowledgeIndex, workspace?: string): Promise<KnowledgeStats> {
    this.cache.set(wsScopeKey(workspace), idx)
    await writeJson(this.indexFilePath(workspace), idx)
    const stats = this.toStats(idx, workspace)
    this.onChange?.(stats)
    return stats
  }

  async status(workspace?: string): Promise<KnowledgeStats> {
    const idx = await this.ensureLoaded(workspace)
    return this.toStats(idx, workspace)
  }

  async addNote(title: string, content: string, workspace?: string): Promise<KnowledgeStats> {
    const cleanTitle = title.trim().slice(0, 120) || 'Project Note'
    const cleanContent = content.trim()
    if (!cleanContent) throw new Error('Note content cannot be empty.')
    const idx = await this.ensureLoaded(workspace)
    const existing = idx.sources.find((s) => s.kind === 'note' && s.title.toLowerCase() === cleanTitle.toLowerCase())
    const sourceId = existing?.id ?? newId('kb')
    const chunks = chunkText(sourceId, cleanTitle, undefined, cleanContent)
    const source: KnowledgeSource = {
      id: sourceId,
      title: cleanTitle,
      kind: 'note',
      docKind: 'text',
      chunkCount: chunks.length,
      charCount: cleanContent.length,
      updatedAt: Date.now(),
    }
    idx.sources = [...idx.sources.filter((s) => s.id !== sourceId), source]
    idx.chunks = [...idx.chunks.filter((c) => c.sourceId !== sourceId), ...chunks]
    return this.persist(idx, workspace)
  }

  async addFiles(rawPaths: string[], workspace?: string): Promise<KnowledgeStats> {
    const idx = await this.ensureLoaded(workspace)
    const wsRoot = workspace?.trim() ? resolve(workspace.trim()) : undefined

    for (const rawPath of rawPaths.slice(0, 20)) {
      const absPath = wsRoot && !/^(?:[a-z]:[\\/]|\/)/i.test(rawPath) ? resolve(wsRoot, rawPath) : resolve(rawPath)
      const st = await stat(absPath).catch(() => null)
      if (!st || !st.isFile()) continue

      let text = ''
      let docKind: DocumentKind = 'text'
      const classified = classifyDocumentExt(absPath)
      if (classified === 'legacy_office') {
        throw new Error(`Legacy Office format (${basename(absPath)}) is not supported; save as .docx/.xlsx/.pptx or PDF.`)
      }
      if (classified) {
        if (st.size > MAX_DOCUMENT_BYTES) {
          throw new Error(`File "${basename(absPath)}" exceeds maximum document size (24 MB).`)
        }
        const buf = await readFile(absPath)
        const extracted = await extractDocument(absPath, buf)
        text = extracted.content
        docKind = extracted.docKind
      } else {
        const buf = await readFile(absPath)
        if (buf.subarray(0, 8192).includes(0)) {
          throw new Error(`File "${basename(absPath)}" appears to be binary and cannot be text-indexed.`)
        }
        text = (buf.byteLength > MAX_TEXT_SOURCE_BYTES ? buf.subarray(0, MAX_TEXT_SOURCE_BYTES) : buf).toString('utf8')
      }

      const relOrAbs = (() => {
        if (!wsRoot) return absPath
        const rel = relative(wsRoot, absPath).replace(/\\/g, '/')
        return rel && !rel.startsWith('..') ? rel : absPath
      })()

      const existing = idx.sources.find((s) => s.path?.toLowerCase() === relOrAbs.toLowerCase())
      const sourceId = existing?.id ?? newId('kb')
      const title = basename(absPath)
      const chunks = chunkText(sourceId, title, relOrAbs, text)
      const source: KnowledgeSource = {
        id: sourceId,
        title,
        kind: 'file',
        path: relOrAbs,
        docKind,
        chunkCount: chunks.length,
        charCount: text.length,
        updatedAt: Date.now(),
      }
      idx.sources = [...idx.sources.filter((s) => s.id !== sourceId), source]
      idx.chunks = [...idx.chunks.filter((c) => c.sourceId !== sourceId), ...chunks]
    }

    return this.persist(idx, workspace)
  }

  async remove(sourceId: string, workspace?: string): Promise<KnowledgeStats> {
    const idx = await this.ensureLoaded(workspace)
    idx.sources = idx.sources.filter((s) => s.id !== sourceId)
    idx.chunks = idx.chunks.filter((c) => c.sourceId !== sourceId)
    return this.persist(idx, workspace)
  }

  async reindex(workspace?: string): Promise<KnowledgeStats> {
    const idx = await this.ensureLoaded(workspace)
    const filePaths = idx.sources.filter((s) => s.kind === 'file' && s.path).map((s) => s.path!)
    if (filePaths.length > 0) {
      await this.addFiles(filePaths, workspace)
    }
    return this.status(workspace)
  }

  async search(query: string, workspace?: string, topK = 6): Promise<KnowledgeHit[]> {
    const idx = await this.ensureLoaded(workspace)
    const chunks = idx.chunks
    if (chunks.length === 0) return []
    const qTerms = [...new Set(tokenizeForSearch(query))]
    if (qTerms.length === 0) {
      return chunks.slice(0, topK).map((c) => ({
        sourceId: c.sourceId,
        title: c.title,
        path: c.path,
        section: c.section,
        score: 1,
        snippet: c.text.slice(0, 420),
      }))
    }

    const N = chunks.length
    const avgLen = Math.max(1, chunks.reduce((sum, c) => sum + c.length, 0) / N)
    const k1 = 1.5
    const b = 0.75

    const df = new Map<string, number>()
    for (const term of qTerms) {
      let count = 0
      for (const c of chunks) {
        if ((c.tf[term] ?? 0) > 0) count++
      }
      df.set(term, count)
    }

    const qLower = query.trim().toLowerCase()
    const hits: KnowledgeHit[] = []
    for (const c of chunks) {
      let score = 0
      for (const term of qTerms) {
        const tf = c.tf[term] ?? 0
        if (tf === 0) continue
        const docFreq = df.get(term) ?? 0
        const idf = Math.log(1 + (N - docFreq + 0.5) / (docFreq + 0.5))
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.length) / avgLen)))
      }
      if (score > 0 && c.text.toLowerCase().includes(qLower)) {
        score *= 1.35
      }
      if (score > 0) {
        hits.push({
          sourceId: c.sourceId,
          title: c.title,
          path: c.path,
          section: c.section,
          score: Number(score.toFixed(3)),
          snippet: c.text.length > 520 ? `${c.text.slice(0, 520)}…` : c.text,
        })
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, Math.min(12, Math.max(1, topK)))
  }

  async formatPromptHint(workspace?: string): Promise<string | undefined> {
    const st = await this.status(workspace)
    if (st.sourceCount === 0 || st.chunkCount === 0) return undefined
    const titles = st.sources
      .slice(0, 6)
      .map((s) => s.title)
      .join(', ')
    return `<project_knowledge sources="${st.sourceCount}" chunks="${st.chunkCount}">\nIndexed workspace knowledge docs: ${titles}. Use \`knowledge_search(query)\` whenever the question relies on project specs, uploaded documents, PDFs, or internal design notes.\n</project_knowledge>`
  }
}
