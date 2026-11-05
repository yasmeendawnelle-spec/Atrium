// Content-addressed image blob store (<dataDir>/blobs/<sha256>.<ext>) so chat JSON stays fast & compact.
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Conversation, ImageAttachment, Message } from '../shared/types.ts'

export const BLOB_PREFIX = 'atrium-blob://'
export const BLOB_THRESHOLD_CHARS = 8192

const MAX_BLOB_LRU = 64
const BLOB_NAME_RE = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/i

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
}

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

function extForMime(mime: string): string {
  const clean = mime.toLowerCase().trim()
  if (MIME_TO_EXT[clean]) return MIME_TO_EXT[clean]
  const rawSub = clean.split('/')[1]?.split('+')[0]?.replace(/[^a-z0-9]/g, '') ?? ''
  return rawSub.slice(0, 8) || 'bin'
}

function mimeForExt(ext: string, fallbackMime?: string): string {
  if (fallbackMime?.startsWith('image/')) return fallbackMime
  return EXT_TO_MIME[ext.toLowerCase()] ?? 'image/png'
}

export class BlobStore {
  private readonly blobsDir: string
  private readonly lru = new Map<string, string>()

  constructor(dataDir: string) {
    this.blobsDir = join(dataDir, 'blobs')
  }

  get cacheSize(): number {
    return this.lru.size
  }

  private lruGet(key: string): string | undefined {
    const val = this.lru.get(key)
    if (val === undefined) return undefined
    this.lru.delete(key)
    this.lru.set(key, val)
    return val
  }

  private lruSet(key: string, val: string): void {
    if (this.lru.has(key)) this.lru.delete(key)
    else if (this.lru.size >= MAX_BLOB_LRU) {
      const oldest = this.lru.keys().next().value
      if (oldest !== undefined) this.lru.delete(oldest)
    }
    this.lru.set(key, val)
  }

  private safeBlobPath(blobRef: string): { path: string; ext: string } | null {
    if (!blobRef.startsWith(BLOB_PREFIX)) return null
    const rel = blobRef.slice(BLOB_PREFIX.length)
    const match = BLOB_NAME_RE.exec(rel)
    if (!match) return null
    const target = join(this.blobsDir, rel)
    if (dirname(target) !== this.blobsDir) return null
    return { path: target, ext: match[2]! }
  }

  async offloadDataUrl(dataUrl: string, mimeType?: string): Promise<string> {
    if (!dataUrl || dataUrl.startsWith(BLOB_PREFIX)) return dataUrl
    if (!dataUrl.startsWith('data:image/') || dataUrl.length <= BLOB_THRESHOLD_CHARS) return dataUrl

    const match = /^data:(image\/[^;,]+)(?:;([^,]*))?,([\s\S]*)$/i.exec(dataUrl)
    if (!match) return dataUrl

    const headerMime = match[1]!.toLowerCase()
    const params = (match[2] ?? '').toLowerCase().split(';').map((p) => p.trim()).filter(Boolean)
    if (!params.includes('base64')) return dataUrl

    const payload = match[3]!.replace(/\s+/g, '')
    const bytes = Buffer.from(payload, 'base64')
    if (bytes.length === 0 || bytes.toString('base64') !== payload) return dataUrl

    const hash = createHash('sha256').update(bytes).digest('hex')
    const ext = extForMime(mimeType || headerMime)
    const fileName = `${hash}.${ext}`
    const target = join(this.blobsDir, fileName)
    const ref = `${BLOB_PREFIX}${fileName}`

    let exists = false
    try {
      await access(target)
      exists = true
    } catch {
      exists = false
    }

    if (!exists) {
      await mkdir(this.blobsDir, { recursive: true })
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      await writeFile(tmp, bytes)
      await rename(tmp, target)
    }

    this.lruSet(`${ref}::${mimeType || headerMime}`, dataUrl)
    return ref
  }

  async hydrateDataUrl(refOrUrl: string, mimeType?: string): Promise<string> {
    if (!refOrUrl || !refOrUrl.startsWith(BLOB_PREFIX)) return refOrUrl
    const parsed = this.safeBlobPath(refOrUrl)
    if (!parsed) return refOrUrl

    const mime = mimeForExt(parsed.ext, mimeType)
    const cacheKey = `${refOrUrl}::${mime}`
    const cached = this.lruGet(cacheKey)
    if (cached !== undefined) return cached

    try {
      const bytes = await readFile(parsed.path)
      const hydrated = `data:${mime};base64,${bytes.toString('base64')}`
      this.lruSet(cacheKey, hydrated)
      return hydrated
    } catch {
      return refOrUrl
    }
  }

  private async mapConversationImages(
    conversation: Conversation,
    transform: (img: ImageAttachment) => Promise<ImageAttachment>,
  ): Promise<Conversation> {
    let anyChanged = false
    const nextMessages: Message[] = new Array(conversation.messages.length)

    for (let i = 0; i < conversation.messages.length; i++) {
      const msg = conversation.messages[i]!
      if ((msg.role === 'user' || msg.role === 'tool') && msg.images && msg.images.length > 0) {
        let msgChanged = false
        const nextImages = await Promise.all(
          msg.images.map(async (img) => {
            const nextImg = await transform(img)
            if (nextImg !== img) msgChanged = true
            return nextImg
          }),
        )
        if (msgChanged) {
          anyChanged = true
          nextMessages[i] = { ...msg, images: nextImages }
          continue
        }
      }
      nextMessages[i] = msg
    }

    return anyChanged ? { ...conversation, messages: nextMessages } : conversation
  }

  /** Returns a non-mutated copy of `conversation` with large data:image URLs offloaded to disk blobs. */
  async offloadConversation(conversation: Conversation): Promise<Conversation> {
    return this.mapConversationImages(conversation, async (img) => {
      const nextUrl = await this.offloadDataUrl(img.dataUrl, img.mimeType)
      return nextUrl === img.dataUrl ? img : { ...img, dataUrl: nextUrl }
    })
  }

  /** Returns a non-mutated copy of `conversation` with `atrium-blob://` references hydrated back to data URLs. */
  async hydrateConversation(conversation: Conversation): Promise<Conversation> {
    return this.mapConversationImages(conversation, async (img) => {
      const nextUrl = await this.hydrateDataUrl(img.dataUrl, img.mimeType)
      return nextUrl === img.dataUrl ? img : { ...img, dataUrl: nextUrl }
    })
  }
}
