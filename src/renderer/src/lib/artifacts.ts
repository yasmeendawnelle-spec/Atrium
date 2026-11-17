// Extracts interactive artifacts (<antArtifact>, <artifact>, and standalone rich
// mermaid / svg / html fenced blocks) from conversation messages and live deltas.
import type { Message } from '../../../shared/types.ts'

export type ArtifactKind = 'html' | 'svg' | 'mermaid' | 'react' | 'code'

export interface ParsedArtifact {
  uid: string
  identifier: string
  title: string
  kind: ArtifactKind
  language?: string
  content: string
  streaming: boolean
  messageIndex: number
  version: number
}

export type MessageSegment =
  | { kind: 'markdown'; text: string }
  | { kind: 'artifact'; artifact: Omit<ParsedArtifact, 'messageIndex' | 'version'> }

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? ''
  }
  return attrs
}

function normalizeKind(typeAttr?: string, langAttr?: string, content?: string): ArtifactKind {
  const t = (typeAttr ?? '').toLowerCase()
  const l = (langAttr ?? '').toLowerCase()
  if (t.includes('mermaid') || l === 'mermaid') return 'mermaid'
  if (t.includes('svg') || l === 'svg') return 'svg'
  if (t.includes('react') || t === 'jsx' || t === 'tsx' || l === 'jsx' || l === 'tsx' || l === 'react') return 'react'
  if (t.includes('html') || l === 'html' || l === 'htm') return 'html'
  if (!t && !l && content) {
    const trimmed = content.trim().toLowerCase()
    if (trimmed.startsWith('<svg')) return 'svg'
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')) return 'html'
    if (/export\s+default\s+/.test(content) && /<[A-Za-z]/.test(content)) return 'react'
  }
  return 'code'
}

export function suggestedFilename(artifact: Pick<ParsedArtifact, 'title' | 'kind' | 'language'>): string {
  const base =
    artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, '-')
      .replace(/^-+|-+$/g, '') || 'artifact'
  const ext =
    artifact.kind === 'html'
      ? 'html'
      : artifact.kind === 'svg'
        ? 'svg'
        : artifact.kind === 'mermaid'
          ? 'mmd'
          : artifact.kind === 'react'
            ? artifact.language === 'jsx'
              ? 'jsx'
              : 'tsx'
            : artifact.language || 'txt'
  return `${base}.${ext}`
}

function isSubstantiveHtml(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length < 60) return false
  return /<!doctype|<html|<head|<body|<style|<script|<canvas|<svg|<div[\s>]/i.test(trimmed)
}

function isSubstantiveReact(code: string): boolean {
  const trimmed = code.trim()
  if (trimmed.length < 60) return false
  return /(?:export\s+default|function\s+[A-Z]\w*|const\s+[A-Z]\w*\s*=)/.test(trimmed) && /<[A-Za-z][A-Za-z0-9.]*[\s/>]/.test(trimmed)
}

function inferFenceTitle(kind: ArtifactKind, code: string, index: number): string {
  if (kind === 'react') {
    const comp = /export\s+default\s+(?:function\s+)?([A-Z]\w*)/.exec(code)?.[1]
    if (comp && comp !== 'App' && comp !== 'Component') return comp
    const h = /<h[1-3][^>]*>([^<{]{1,50})<\/h[1-3]>/i.exec(code)?.[1]?.trim()
    if (h) return h
    return index > 1 ? `React App #${index}` : 'Interactive React App'
  }
  if (kind === 'html') {
    const t = /<title[^>]*>([^<]{1,60})<\/title>/i.exec(code)?.[1]?.trim()
    if (t) return t
    const h = /<h[1-3][^>]*>([^<]{1,50})<\/h[1-3]>/i.exec(code)?.[1]?.trim()
    if (h) return h
    return index > 1 ? `HTML Preview #${index}` : 'Interactive HTML'
  }
  if (kind === 'svg') return index > 1 ? `SVG Graphic #${index}` : 'SVG Graphic'
  if (kind === 'mermaid') {
    const first = code.trim().split(/\r?\n/)[0]?.trim() ?? ''
    if (/^(flowchart|graph)/i.test(first)) return 'Flowchart Diagram'
    if (/^sequenceDiagram/i.test(first)) return 'Sequence Diagram'
    if (/^classDiagram/i.test(first)) return 'Class Diagram'
    if (/^erDiagram/i.test(first)) return 'ER Diagram'
    if (/^stateDiagram/i.test(first)) return 'State Diagram'
    return index > 1 ? `Mermaid Diagram #${index}` : 'Mermaid Diagram'
  }
  return `Artifact #${index}`
}

/** Splits an assistant message into markdown chunks and explicit `<artifact>` / `<antArtifact>` cards. */
export function splitMessageSegments(text: string, msgKey = 'm0'): MessageSegment[] {
  const segments: MessageSegment[] = []
  const openTagRe = /<(antArtifact|artifact)\b([^>]*)>/gi
  let cursor = 0
  let count = 0

  while (cursor < text.length) {
    openTagRe.lastIndex = cursor
    const openMatch = openTagRe.exec(text)
    if (!openMatch) {
      const rest = text.slice(cursor)
      if (rest) segments.push({ kind: 'markdown', text: rest })
      break
    }

    if (openMatch.index > cursor) {
      segments.push({ kind: 'markdown', text: text.slice(cursor, openMatch.index) })
    }

    const tagName = openMatch[1]!
    const attrs = parseAttrs(openMatch[2] ?? '')
    const bodyStart = openMatch.index + openMatch[0].length
    const closeRe = new RegExp(`</${tagName}>`, 'i')
    const tail = text.slice(bodyStart)
    const closeMatch = closeRe.exec(tail)

    const streaming = !closeMatch
    const content = (closeMatch ? tail.slice(0, closeMatch.index) : tail).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    const identifier = attrs.identifier || attrs.id || `${msgKey}-tag-${++count}`
    const kind = normalizeKind(attrs.type, attrs.language, content)
    const title = attrs.title || inferFenceTitle(kind, content, count)

    segments.push({
      kind: 'artifact',
      artifact: {
        uid: `${msgKey}:tag:${count}:${identifier}`,
        identifier,
        title,
        kind,
        language: attrs.language || undefined,
        content,
        streaming,
      },
    })

    cursor = closeMatch ? bodyStart + closeMatch.index + closeMatch[0].length : text.length
  }

  return segments
}

function extractFencedVisuals(markdown: string, msgKey: string, startIndex: number): Array<Omit<ParsedArtifact, 'messageIndex' | 'version'>> {
  const found: Array<Omit<ParsedArtifact, 'messageIndex' | 'version'>> = []
  const fenceRe = /```(mermaid|svg|html|htm|tsx|jsx)\b[^\n]*\r?\n([\s\S]*?)(?:```|$)/gi
  let m: RegExpExecArray | null
  let idx = 0

  while ((m = fenceRe.exec(markdown)) !== null) {
    const lang = m[1]!.toLowerCase()
    const raw = m[2]!.replace(/\r?\n$/, '')
    const full = m[0]!
    const streaming = !full.endsWith('```')
    if (lang === 'html' || lang === 'htm') {
      if (!isSubstantiveHtml(raw) && !streaming) continue
    } else if (lang === 'tsx' || lang === 'jsx') {
      if (!isSubstantiveReact(raw) && !streaming) continue
    } else if (raw.trim().length < 8) {
      continue
    }
    idx++
    const kind: ArtifactKind =
      lang === 'mermaid'
        ? 'mermaid'
        : lang === 'svg'
          ? 'svg'
          : lang === 'tsx' || lang === 'jsx'
            ? 'react'
            : 'html'
    const num = startIndex + idx
    const title = inferFenceTitle(kind, raw, num)
    const identifier = `fenced-${kind}-${msgKey}-${idx}`
    found.push({
      uid: `${msgKey}:fence:${idx}`,
      identifier,
      title,
      kind,
      language: lang,
      content: raw,
      streaming,
    })
  }
  return found
}

/** Collects all artifacts across saved messages and the optional currently streaming assistant text. */
export function extractConversationArtifacts(messages: Message[], liveText = ''): ParsedArtifact[] {
  const list: ParsedArtifact[] = []
  const versions = new Map<string, number>()

  const pushItem = (item: Omit<ParsedArtifact, 'messageIndex' | 'version'>, messageIndex: number) => {
    const vKey = item.identifier.toLowerCase()
    const version = (versions.get(vKey) ?? 0) + 1
    versions.set(vKey, version)
    list.push({ ...item, messageIndex, version })
  }

  messages.forEach((msg, mIdx) => {
    if (msg.role !== 'assistant' || !msg.text) return
    const msgKey = `m${mIdx}`
    for (const seg of splitMessageSegments(msg.text, msgKey)) {
      if (seg.kind === 'artifact') {
        pushItem(seg.artifact, mIdx)
      } else {
        for (const fenced of extractFencedVisuals(seg.text, msgKey, list.length)) {
          pushItem(fenced, mIdx)
        }
      }
    }
  })

  if (liveText) {
    const msgKey = `m${messages.length}`
    for (const seg of splitMessageSegments(liveText, msgKey)) {
      if (seg.kind === 'artifact') {
        pushItem(seg.artifact, messages.length)
      } else {
        for (const fenced of extractFencedVisuals(seg.text, msgKey, list.length)) {
          pushItem(fenced, messages.length)
        }
      }
    }
  }

  return list
}

/** Extracts artifacts only from live streaming text using existing saved artifacts for version continuity. */
export function extractLiveArtifactsTail(
  saved: ParsedArtifact[],
  messageIndex: number,
  liveText: string,
): ParsedArtifact[] {
  if (!liveText) return []
  const list: ParsedArtifact[] = []
  const versions = new Map<string, number>()
  for (const item of saved) {
    const key = item.identifier.toLowerCase()
    const prev = versions.get(key) ?? 0
    if (item.version > prev) versions.set(key, item.version)
  }

  const pushItem = (item: Omit<ParsedArtifact, 'messageIndex' | 'version'>) => {
    const vKey = item.identifier.toLowerCase()
    const version = (versions.get(vKey) ?? 0) + 1
    versions.set(vKey, version)
    list.push({ ...item, messageIndex, version })
  }

  const msgKey = `m${messageIndex}`
  for (const seg of splitMessageSegments(liveText, msgKey)) {
    if (seg.kind === 'artifact') {
      pushItem(seg.artifact)
    } else {
      for (const fenced of extractFencedVisuals(seg.text, msgKey, saved.length + list.length)) {
        pushItem(fenced)
      }
    }
  }
  return list
}
