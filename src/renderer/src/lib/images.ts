import type { ImageAttachment } from '@shared/types.ts'

const MAX_EDGE = 1600
const MAX_RAW_BYTES = 12 * 1024 * 1024

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image.'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not decode image.'))
    img.src = src
  })
}

function makeAttachmentId(): string {
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** Downscales large raster images onto canvas while keeping GIFs and compact PNGs verbatim. */
export async function normalizeImageDataUrl(
  name: string,
  mimeType: string,
  rawUrl: string,
  byteSize: number,
): Promise<ImageAttachment> {
  if (byteSize > MAX_RAW_BYTES) {
    throw new Error(`Image "${name}" is larger than 12 MB.`)
  }
  if (mimeType === 'image/gif' || byteSize <= 350_000) {
    return { id: makeAttachmentId(), name: name || 'image.png', mimeType, dataUrl: rawUrl }
  }
  try {
    const img = await loadImage(rawUrl)
    const scale = Math.min(1, MAX_EDGE / Math.max(img.width || 1, img.height || 1))
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))
    if (scale === 1 && byteSize <= 1_500_000) {
      return { id: makeAttachmentId(), name: name || 'image.png', mimeType, dataUrl: rawUrl }
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(img, 0, 0, width, height)
    const targetMime = mimeType === 'image/png' ? 'image/png' : 'image/jpeg'
    const dataUrl = canvas.toDataURL(targetMime, targetMime === 'image/jpeg' ? 0.88 : undefined)
    return { id: makeAttachmentId(), name: name || 'image', mimeType: targetMime, dataUrl }
  } catch {
    return { id: makeAttachmentId(), name: name || 'image', mimeType, dataUrl: rawUrl }
  }
}

/** Converts an image File/Blob into a bounded `ImageAttachment` data URL. */
export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`Unsupported file type: ${file.type || file.name}`)
  }
  if (file.size > MAX_RAW_BYTES) {
    throw new Error(`Image "${file.name}" is larger than 12 MB.`)
  }
  const rawUrl = await readAsDataUrl(file)
  return normalizeImageDataUrl(file.name || 'image.png', file.type, rawUrl, file.size)
}
