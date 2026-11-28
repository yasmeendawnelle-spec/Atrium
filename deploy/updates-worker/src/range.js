/**
 * Pure HTTP download/Range/proxy/chunk-streaming helpers for the Atrium update feed Worker.
 * Kept runtime-agnostic (Web Fetch API + Web Streams) so Node tests verify the exact same logic.
 */

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/
const MULTIPART_BOUNDARY = 'atrium-range-boundary-7f9e3c'
const CHANNEL_PATH_RE = /^\/(win|linux|mac|latest)\/(.+)$/
const INDEX_PATHS = new Set([
  '/',
  '/healthz',
  '/win',
  '/win/',
  '/linux',
  '/linux/',
  '/mac',
  '/mac/',
  '/latest',
  '/latest/',
])
const VERSIONED_ASSET_RE =
  /(?:^|[-_])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)??)(?=\.(?:exe|dmg|zip|AppImage|deb|blockmap|yml|yaml)(?:\.blockmap)?$|-mac-|-linux-|-win-)/
const CHANNELS = ['/win', '/linux', '/mac', '/latest']
const WORKER_USER_AGENT = 'atrium-updates-worker/2.0'
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
 * Extract the release tag (`vX.Y.Z`) from a versioned installer/blockmap filename,
 * or return `null` for unversioned manifests such as `latest.yml`.
 */
export function extractReleaseTagFromFilename(filename) {
  if (typeof filename !== 'string' || !filename) return null
  const match = VERSIONED_ASSET_RE.exec(filename)
  if (!match?.[1]) return null
  return `v${match[1]}`
}

/**
 * Build candidate GitHub Release download URLs for an asset name.
 * Versioned artifacts try their exact tag first so historical `.blockmap` files resolve
 * even after newer releases ship, then fall back to `releases/latest/download`.
 */
export function buildGitHubAssetUrls(repo, filename) {
  const cleanRepo = String(repo).trim().replace(/^\/+|\/+$/g, '')
  const encoded = encodeURIComponent(filename)
  const tag = extractReleaseTagFromFilename(filename)
  if (tag) {
    return [
      `https://github.com/${cleanRepo}/releases/download/${encodeURIComponent(tag)}/${encoded}`,
      `https://github.com/${cleanRepo}/releases/latest/download/${encoded}`,
    ]
  }
  return [`https://github.com/${cleanRepo}/releases/latest/download/${encoded}`]
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

function resolveContentType(name, fallbackType) {
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'text/yaml; charset=utf-8'
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  return fallbackType || 'application/octet-stream'
}

function stripOptionalYamlQuotes(raw) {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseLatestManifestSummary(ymlText) {
  const versionMatch = /^\s*version:\s*(.+?)\s*$/m.exec(ymlText)
  const dateMatch = /^\s*releaseDate:\s*(.+?)\s*$/m.exec(ymlText)
  const latest = versionMatch?.[1] ? stripOptionalYamlQuotes(versionMatch[1]) : null
  const updatedAt = dateMatch?.[1] ? stripOptionalYamlQuotes(dateMatch[1]) : null
  return { latest, updatedAt }
}

function baseHeadersFor(name, meta, source) {
  const headers = new Headers()
  headers.set('Content-Type', resolveContentType(name, meta.contentType))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set(
    'Cache-Control',
    isImmutableManifestOrDoc(name) ? 'no-store, no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
  )
  if (source) {
    headers.set('X-Atrium-Source', source)
  }
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

async function serveFromKv(request, method, filename, meta, store) {
  const headers = baseHeadersFor(filename, meta, 'kv')
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

function buildSanitizedGitHubHeaders(filename, upstreamHeaders, noStore) {
  const headers = new Headers()
  headers.set('Content-Type', resolveContentType(filename, upstreamHeaders.get('content-type')))
  headers.set('Accept-Ranges', 'bytes')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Atrium-Source', 'github-releases')
  headers.set(
    'Cache-Control',
    noStore ? 'no-store, no-cache, must-revalidate' : 'public, max-age=31536000, immutable',
  )
  for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
    const val = upstreamHeaders.get(name)
    if (val) headers.set(name, val)
  }
  return headers
}

async function handleIndexRequest(method, store, githubRepo, fetchImpl) {
  if (githubRepo) {
    const cleanRepo = String(githubRepo).trim().replace(/^\/+|\/+$/g, '')
    const manifestUrl = `https://github.com/${cleanRepo}/releases/latest/download/latest.yml`
    try {
      const res = await fetchImpl(
        manifestUrl,
        {
          method: 'GET',
          headers: { 'User-Agent': WORKER_USER_AGENT },
          redirect: 'follow',
        },
        { noStore: true },
      )
      if (res.ok) {
        const ymlText = await res.text()
        const { latest, updatedAt } = parseLatestManifestSummary(ymlText)
        if (latest) {
          const payload = JSON.stringify(
            {
              ok: true,
              service: 'atrium-updates',
              source: 'github-releases',
              repo: cleanRepo,
              channel: '/win',
              channels: CHANNELS,
              latest,
              updatedAt,
            },
            null,
            2,
          )
          return new Response(method === 'HEAD' ? null : payload, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
          })
        }
      } else {
        await res.body?.cancel().catch(() => undefined)
      }
    } catch {
      // Fall back to KV index below if GitHub manifest lookup fails.
    }
  }

  const index = store ? await store.getJson('index:win') : null
  const payload = JSON.stringify(
    {
      ok: true,
      service: 'atrium-updates',
      source: 'kv',
      repo: githubRepo ? String(githubRepo).trim().replace(/^\/+|\/+$/g, '') : null,
      channel: '/win',
      channels: CHANNELS,
      latest: index?.latest ?? null,
      updatedAt: index?.updatedAt ?? null,
    },
    null,
    2,
  )
  return new Response(method === 'HEAD' ? null : payload, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}

export async function handleUpdateRequest(request, store, options = {}) {
  const url = new URL(request.url)
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  const githubRepo = typeof options.githubRepo === 'string' && options.githubRepo.trim() ? options.githubRepo.trim() : undefined
  const fetchImpl = options.fetchImpl ?? ((targetUrl, init) => fetch(targetUrl, init))

  if (INDEX_PATHS.has(url.pathname)) {
    return handleIndexRequest(method, store, githubRepo, fetchImpl)
  }

  const pathMatch = CHANNEL_PATH_RE.exec(url.pathname)
  if (!pathMatch) {
    return new Response('Not Found', { status: 404 })
  }

  const rawName = pathMatch[2]
  const filename = sanitizeAssetName(rawName)
  if (!filename) {
    return new Response('Not Found', { status: 404 })
  }

  let upstreamErrored = false

  if (githubRepo) {
    const rangeHeader = method === 'GET' ? request.headers.get('Range') : null
    if (rangeHeader && rangeHeader.includes(',')) {
      const kvMeta = store ? await store.getJson(`meta:win:${filename}`) : null
      if (kvMeta) {
        return serveFromKv(request, method, filename, kvMeta, store)
      }
      return new Response('Multi-range requests are not supported on GitHub-backed assets', {
        status: 501,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Atrium-Source': 'github-releases',
        },
      })
    }

    const candidateUrls = buildGitHubAssetUrls(githubRepo, filename)
    const noStore = isImmutableManifestOrDoc(filename)

    for (const targetUrl of candidateUrls) {
      const upstreamHeaders = new Headers({ 'User-Agent': WORKER_USER_AGENT })
      if (rangeHeader) {
        upstreamHeaders.set('Range', rangeHeader)
      }
      try {
        const res = await fetchImpl(
          targetUrl,
          {
            method,
            headers: upstreamHeaders,
            redirect: 'follow',
          },
          { noStore },
        )
        if (res.status === 404) {
          await res.body?.cancel().catch(() => undefined)
          continue
        }
        if (res.status === 200 || res.status === 206 || res.status === 416) {
          const headers = buildSanitizedGitHubHeaders(filename, res.headers, noStore)
          if (method === 'HEAD') {
            await res.body?.cancel().catch(() => undefined)
            return new Response(null, { status: res.status, headers })
          }
          return new Response(res.body, { status: res.status, headers })
        }
        await res.body?.cancel().catch(() => undefined)
        upstreamErrored = true
        break
      } catch {
        upstreamErrored = true
        break
      }
    }
  }

  const kvMeta = store ? await store.getJson(`meta:win:${filename}`) : null
  if (kvMeta) {
    return serveFromKv(request, method, filename, kvMeta, store)
  }

  if (upstreamErrored) {
    return new Response('Bad Gateway', { status: 502 })
  }
  return new Response('Not Found', { status: 404 })
}
