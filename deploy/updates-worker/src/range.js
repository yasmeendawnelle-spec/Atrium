/**
 * Pure HTTP download/Range/chunk-streaming helpers for the Atrium update feed Worker.
 * Kept runtime-agnostic (Web Fetch API + Web Streams) so Node tests verify the exact same logic.
 */

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/
const MULTIPART_BOUNDARY = 'atrium-range-boundary-7f9e3c'
const encoder = new TextEncoder()

export function sanitizeAssetName(raw) {
  if (typeof raw !== 'string') return null
  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!SAFE_NAME_RE.test(decoded) || decoded.includes('..')) return null
  return decoded
}

/**
 * Parse an HTTP `Range: bytes=...` header per RFC 9110.
 * Returns:
 * - `{ kind: 'none' }` when absent or non-bytes (ignore header -> 200 full body)
 * - `{ kind: 'unsatisfiable' }` when syntactically invalid bytes spec or outside `[0, size - 1]` -> 416
 * - `{ kind: 'ranges', ranges: Array<{ start: number, end: number }> }`
 */
export function parseRangeHeader(headerValue, totalSize) {
  if (!headerValue) return { kind: 'none' }
  if (!Number.isFinite(totalSize) || totalSize <= 0) {
    return { kind: 'unsatisfiable' }
  }
  const trimmed = headerValue.trim()
  if (!/^bytes=/i.test(trimmed)) return { kind: 'none' }
  const specList = trimmed.slice(6).split(',')
  const ranges = []
  for (const partRaw of specList) {
    const part = partRaw.trim()
    if (!part) return { kind: 'unsatisfiable' }
    const match = /^(\d*)-(\d*)$/.exec(part)
    if (!match) return { kind: 'unsatisfiable' }
    const [, startStr, endStr] = match
    if (!startStr && !endStr) return { kind: 'unsatisfiable' }
    if (!startStr) {
      // Suffix byte-range: last N bytes
      const suffix = Number(endStr)
      if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' }
      const start = Math.max(0, totalSize - suffix)
      ranges.push({ start, end: totalSize - 1 })
    } else if (!endStr) {
      const start = Number(startStr)
      if (!Number.isFinite(start) || start >= totalSize) return { kind: 'unsatisfiable' }
      ranges.push({ start, end: totalSize - 1 })
    } else {
      const start = Number(startStr)
      const end = Number(endStr)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalSize) {
        return { kind: 'unsatisfiable' }
      }
      ranges.push({ start, end: Math.min(end, totalSize - 1) })
    }
  }
  if (ranges.length === 0) return { kind: 'unsatisfiable' }
  return { kind: 'ranges', ranges }
}

function isImmutableManifestOrDoc(name) {
  return name.endsWith('.yml') || name.endsWith('.yaml') || name.endsWith('.json')
}

function baseHeadersFor(name, meta) {
  const headers = new Headers()
  headers.set('Content-Type', meta.contentType || 'application/octet-stream')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set(
    'Cache-Control',
    isImmutableManifestOrDoc(name) ? 'no-store, no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
  )
  if (meta.sha512) {
    headers.set('ETag', `"${meta.sha512}"`)
  }
  return headers
}

/**
 * Create a ReadableStream yielding `[start..end]` (inclusive) from either an inline blob stream
 * or sequential fixed-size chunk streams.
 */
export function createByteRangeStream(meta, filename, start, end, store) {
  const chunkSize = meta.kind === 'chunked' ? meta.chunkSize : meta.size
  const firstChunk = Math.floor(start / chunkSize)
  const lastChunk = Math.floor(end / chunkSize)
  let currentChunk = firstChunk
  let reader = null
  let chunkBaseOffset = 0
  let chunkPos = 0

  async function openNextChunk() {
    if (reader) {
      try {
        await reader.cancel()
      } catch {
        // ignore cancel errors
      }
      reader = null
    }
    if (currentChunk > lastChunk) return false
    const key = meta.kind === 'chunked' ? `chunk:win:${filename}:${currentChunk}` : `blob:win:${filename}`
    const stream = await store.getStream(key)
    if (!stream) {
      throw new Error(`Missing release object key: ${key}`)
    }
    chunkBaseOffset = meta.kind === 'chunked' ? currentChunk * chunkSize : 0
    chunkPos = chunkBaseOffset
    currentChunk += 1
    reader = stream.getReader()
    return true
  }

  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            const opened = await openNextChunk()
            if (!opened) {
              controller.close()
              return
            }
          }
          const { done, value } = await reader.read()
          if (done) {
            reader = null
            continue
          }
          const buf = value instanceof Uint8Array ? value : new Uint8Array(value)
          const bufStart = chunkPos
          const bufEnd = bufStart + buf.byteLength - 1
          chunkPos += buf.byteLength

          if (bufEnd < start) {
            continue
          }
          if (bufStart > end) {
            await reader.cancel().catch(() => undefined)
            reader = null
            controller.close()
            return
          }
          const sliceStart = Math.max(0, start - bufStart)
          const sliceEnd = Math.min(buf.byteLength, end - bufStart + 1)
          if (sliceEnd > sliceStart) {
            controller.enqueue(buf.subarray(sliceStart, sliceEnd))
            if (bufEnd >= end) {
              await reader.cancel().catch(() => undefined)
              reader = null
              controller.close()
              return
            }
            return
          }
        }
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel() {
      if (reader) {
        await reader.cancel().catch(() => undefined)
        reader = null
      }
    },
  })
}

/**
 * Stream RFC-compliant `multipart/byteranges` response body for multiple byte ranges,
 * reusing the most recently loaded chunk buffer so differential updates only fetch touched chunks once.
 */
function createMultipartRangeResponse(meta, filename, ranges, store, headers) {
  const boundary = MULTIPART_BOUNDARY
  const partHeaders = ranges.map((r, idx) => {
    const prefix = idx === 0 ? `--${boundary}\r\n` : `\r\n--${boundary}\r\n`
    return encoder.encode(
      `${prefix}Content-Type: ${meta.contentType || 'application/octet-stream'}\r\nContent-Range: bytes ${r.start}-${r.end}/${meta.size}\r\n\r\n`,
    )
  })
  const closing = encoder.encode(`\r\n--${boundary}--\r\n`)

  let totalLength = closing.byteLength
  for (let i = 0; i < ranges.length; i += 1) {
    totalLength += partHeaders[i].byteLength + (ranges[i].end - ranges[i].start + 1)
  }

  headers.set('Content-Type', `multipart/byteranges; boundary=${boundary}`)
  headers.set('Content-Length', String(totalLength))

  const chunkSize = meta.kind === 'chunked' ? meta.chunkSize : meta.size
  let partIdx = 0
  let phase = 'header' // 'header' | 'data' | 'done'
  let offsetInRange = 0
  let cachedChunkIdx = -1
  let cachedChunkBytes = null

  async function getChunkBytes(chunkIdx) {
    if (chunkIdx === cachedChunkIdx && cachedChunkBytes) return cachedChunkBytes
    const key = meta.kind === 'chunked' ? `chunk:win:${filename}:${chunkIdx}` : `blob:win:${filename}`
    const ab = await store.getArrayBuffer(key)
    if (!ab) throw new Error(`Missing release object key: ${key}`)
    cachedChunkIdx = chunkIdx
    cachedChunkBytes = new Uint8Array(ab)
    return cachedChunkBytes
  }

  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (partIdx < ranges.length) {
          if (phase === 'header') {
            controller.enqueue(partHeaders[partIdx])
            phase = 'data'
            offsetInRange = 0
            return
          }
          const range = ranges[partIdx]
          const rangeLen = range.end - range.start + 1
          if (offsetInRange >= rangeLen) {
            partIdx += 1
            phase = 'header'
            continue
          }
          const absPos = range.start + offsetInRange
          const chunkIdx = Math.floor(absPos / chunkSize)
          const chunkBytes = await getChunkBytes(chunkIdx)
          const chunkBase = meta.kind === 'chunked' ? chunkIdx * chunkSize : 0
          const localStart = absPos - chunkBase
          const remainingInRange = rangeLen - offsetInRange
          const localEnd = Math.min(chunkBytes.byteLength, localStart + remainingInRange)
          const slice = chunkBytes.subarray(localStart, localEnd)
          offsetInRange += slice.byteLength
          controller.enqueue(slice)
          return
        }
        if (phase !== 'done') {
          phase = 'done'
          controller.enqueue(closing)
          controller.close()
        }
      } catch (err) {
        cachedChunkBytes = null
        controller.error(err)
      }
    },
    cancel() {
      cachedChunkBytes = null
    },
  })

  return new Response(body, { status: 206, headers })
}

export async function handleUpdateRequest(request, store) {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  if (url.pathname === '/' || url.pathname === '/healthz' || url.pathname === '/win' || url.pathname === '/win/') {
    const index = await store.getJson('index:win')
    return new Response(
      JSON.stringify(
        {
          ok: true,
          service: 'atrium-updates',
          channel: '/win',
          latest: index?.latest ?? null,
          updatedAt: index?.updatedAt ?? null,
        },
        null,
        2,
      ),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      },
    )
  }

  if (!url.pathname.startsWith('/win/')) {
    return new Response('Not Found', { status: 404 })
  }

  const rawName = url.pathname.slice('/win/'.length)
  const filename = sanitizeAssetName(rawName)
  if (!filename) {
    return new Response('Not Found', { status: 404 })
  }

  const meta = await store.getJson(`meta:win:${filename}`)
  if (!meta) {
    return new Response('Not Found', { status: 404 })
  }

  const headers = baseHeadersFor(filename, meta)
  if (method === 'HEAD') {
    headers.set('Content-Length', String(meta.size))
    return new Response(null, { status: 200, headers })
  }

  const parsedRange = parseRangeHeader(request.headers.get('Range'), meta.size)
  if (parsedRange.kind === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${meta.size}`)
    headers.set('Content-Length', '0')
    return new Response(null, { status: 416, headers })
  }

  if (parsedRange.kind === 'ranges' && parsedRange.ranges.length === 1) {
    const { start, end } = parsedRange.ranges[0]
    const len = end - start + 1
    headers.set('Content-Range', `bytes ${start}-${end}/${meta.size}`)
    headers.set('Content-Length', String(len))
    const stream = createByteRangeStream(meta, filename, start, end, store)
    return new Response(stream, { status: 206, headers })
  }

  if (parsedRange.kind === 'ranges' && parsedRange.ranges.length > 1) {
    return createMultipartRangeResponse(meta, filename, parsedRange.ranges, store, headers)
  }

  headers.set('Content-Length', String(meta.size))
  if (meta.size === 0) {
    return new Response(new Uint8Array(0), { status: 200, headers })
  }
  const stream = createByteRangeStream(meta, filename, 0, meta.size - 1, store)
  return new Response(stream, { status: 200, headers })
}
