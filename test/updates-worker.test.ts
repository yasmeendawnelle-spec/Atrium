import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGitHubAssetUrls,
  extractReleaseTagFromFilename,
  handleUpdateRequest,
  parseRangeHeader,
  sanitizeAssetName,
  type UpdateObjectStore,
} from '../deploy/updates-worker/src/range.js'

function createMockStore(entries: Record<string, string | Uint8Array>): UpdateObjectStore {
  const map = new Map<string, string | Uint8Array>(Object.entries(entries))
  return {
    async getJson(key: string) {
      const val = map.get(key)
      return typeof val === 'string' ? (JSON.parse(val) as Record<string, unknown>) : null
    },
    async getStream(key: string) {
      const val = map.get(key)
      if (val == null) return null
      const bytes = val instanceof Uint8Array ? val : new TextEncoder().encode(val)
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    },
    async getArrayBuffer(key: string) {
      const val = map.get(key)
      if (val == null) return null
      const bytes = val instanceof Uint8Array ? val : new TextEncoder().encode(val)
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      return copy.buffer
    },
  }
}

test('sanitizeAssetName rejects traversal and invalid characters', () => {
  assert.equal(sanitizeAssetName('latest.yml'), 'latest.yml')
  assert.equal(sanitizeAssetName('Atrium-Setup-0.2.0.exe'), 'Atrium-Setup-0.2.0.exe')
  assert.equal(sanitizeAssetName('..%2Fsecret'), null)
  assert.equal(sanitizeAssetName('foo/bar'), null)
  assert.equal(sanitizeAssetName('.hidden'), null)
})

test('parseRangeHeader handles single, suffix, open-ended, multi, and unsatisfiable ranges', () => {
  assert.deepEqual(parseRangeHeader(null, 100), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('bytes=0-9', 100), { kind: 'ranges', ranges: [{ start: 0, end: 9 }] })
  assert.deepEqual(parseRangeHeader('bytes=80-', 100), { kind: 'ranges', ranges: [{ start: 80, end: 99 }] })
  assert.deepEqual(parseRangeHeader('bytes=-25', 100), { kind: 'ranges', ranges: [{ start: 75, end: 99 }] })
  assert.deepEqual(parseRangeHeader('bytes=10-20, 40-50', 100), {
    kind: 'ranges',
    ranges: [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ],
  })
  assert.deepEqual(parseRangeHeader('bytes=100-120', 100), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRangeHeader('bytes=50-10', 100), { kind: 'unsatisfiable' })
})

test('Worker serves latest.yml, chunked full GET, HEAD, single Range 206, multipart 206, and 416', async () => {
  const totalPayload = new Uint8Array(250)
  for (let i = 0; i < totalPayload.length; i += 1) {
    totalPayload[i] = i % 251
  }
  const chunkSize = 100
  const ymlText = 'version: 0.2.0\npath: Atrium-Setup-0.2.0.exe\n'

  const store = createMockStore({
    'index:win': JSON.stringify({ latest: '0.2.0', updatedAt: '2026-11-15T00:00:00.000Z' }),
    'meta:win:latest.yml': JSON.stringify({
      kind: 'inline',
      contentType: 'text/yaml; charset=utf-8',
      size: Buffer.byteLength(ymlText),
    }),
    'blob:win:latest.yml': ymlText,
    'meta:win:Atrium-Setup-0.2.0.exe': JSON.stringify({
      kind: 'chunked',
      contentType: 'application/octet-stream',
      size: totalPayload.byteLength,
      sha512: 'fake-sha512',
      chunkSize,
      chunkCount: 3,
    }),
    'chunk:win:Atrium-Setup-0.2.0.exe:0': totalPayload.slice(0, 100),
    'chunk:win:Atrium-Setup-0.2.0.exe:1': totalPayload.slice(100, 200),
    'chunk:win:Atrium-Setup-0.2.0.exe:2': totalPayload.slice(200, 250),
  })

  // Healthz
  const health = await handleUpdateRequest(new Request('https://updates.rpulse.top/healthz'), store)
  assert.equal(health.status, 200)
  const healthJson = (await health.json()) as { ok: boolean; latest: string }
  assert.equal(healthJson.ok, true)
  assert.equal(healthJson.latest, '0.2.0')

  // Manifest latest.yml has no-store
  const ymlRes = await handleUpdateRequest(new Request('https://updates.rpulse.top/win/latest.yml?noCache=1'), store)
  assert.equal(ymlRes.status, 200)
  assert.match(ymlRes.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(await ymlRes.text(), ymlText)

  // HEAD installer
  const headRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.2.0.exe', { method: 'HEAD' }),
    store,
  )
  assert.equal(headRes.status, 200)
  assert.equal(headRes.headers.get('content-length'), '250')
  assert.equal(headRes.headers.get('accept-ranges'), 'bytes')

  // Full streamed GET across 3 chunks
  const fullRes = await handleUpdateRequest(new Request('https://updates.rpulse.top/win/Atrium-Setup-0.2.0.exe'), store)
  assert.equal(fullRes.status, 200)
  const fullBytes = new Uint8Array(await fullRes.arrayBuffer())
  assert.deepEqual(fullBytes, totalPayload)

  // Single Range spanning chunk 0 -> chunk 1 boundary
  const partRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.2.0.exe', {
      headers: { Range: 'bytes=75-135' },
    }),
    store,
  )
  assert.equal(partRes.status, 206)
  assert.equal(partRes.headers.get('content-range'), 'bytes 75-135/250')
  assert.equal(partRes.headers.get('content-length'), '61')
  assert.deepEqual(new Uint8Array(await partRes.arrayBuffer()), totalPayload.slice(75, 136))

  // Multi-range multipart/byteranges response
  const multiRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.2.0.exe', {
      headers: { Range: 'bytes=5-14, 190-209' },
    }),
    store,
  )
  assert.equal(multiRes.status, 206)
  const ct = multiRes.headers.get('content-type') ?? ''
  assert.match(ct, /^multipart\/byteranges; boundary=/)
  const multiBuf = Buffer.from(await multiRes.arrayBuffer())
  assert.equal(String(multiBuf.byteLength), multiRes.headers.get('content-length'))
  const multiText = multiBuf.toString('latin1')
  assert.match(multiText, /Content-Range: bytes 5-14\/250/)
  assert.match(multiText, /Content-Range: bytes 190-209\/250/)
  assert.ok(multiBuf.includes(Buffer.from(totalPayload.slice(5, 15))))
  assert.ok(multiBuf.includes(Buffer.from(totalPayload.slice(190, 210))))

  // Unsatisfiable range
  const badRange = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.2.0.exe', {
      headers: { Range: 'bytes=500-600' },
    }),
    store,
  )
  assert.equal(badRange.status, 416)
  assert.equal(badRange.headers.get('content-range'), 'bytes */250')
})

test('extractReleaseTagFromFilename and buildGitHubAssetUrls resolve versioned assets and unversioned manifests', () => {
  assert.equal(extractReleaseTagFromFilename('latest.yml'), null)
  assert.equal(extractReleaseTagFromFilename('latest-linux.yml'), null)
  assert.equal(extractReleaseTagFromFilename('latest-mac.yml'), null)
  assert.equal(extractReleaseTagFromFilename('Atrium-Setup-0.3.7.exe'), 'v0.3.7')
  assert.equal(extractReleaseTagFromFilename('Atrium-Setup-0.3.7.exe.blockmap'), 'v0.3.7')
  assert.equal(extractReleaseTagFromFilename('Atrium-0.3.7-linux-x86_64.AppImage'), 'v0.3.7')
  assert.equal(extractReleaseTagFromFilename('Atrium-0.3.7-linux-amd64.deb'), 'v0.3.7')
  assert.equal(extractReleaseTagFromFilename('Atrium-0.3.7-mac-arm64.dmg'), 'v0.3.7')
  assert.equal(extractReleaseTagFromFilename('Atrium-0.3.7-mac-x64.zip'), 'v0.3.7')

  assert.deepEqual(buildGitHubAssetUrls('yasmeendawnelle-spec/Atrium', 'latest.yml'), [
    'https://github.com/yasmeendawnelle-spec/Atrium/releases/latest/download/latest.yml',
  ])
  assert.deepEqual(buildGitHubAssetUrls('yasmeendawnelle-spec/Atrium', 'Atrium-Setup-0.3.7.exe'), [
    'https://github.com/yasmeendawnelle-spec/Atrium/releases/download/v0.3.7/Atrium-Setup-0.3.7.exe',
    'https://github.com/yasmeendawnelle-spec/Atrium/releases/latest/download/Atrium-Setup-0.3.7.exe',
  ])
})

test('GitHub Releases proxy handles healthz, manifests, versioned/historical assets, single Range, HEAD, multi-range 501, and KV fallback', async () => {
  const installerBytes = new Uint8Array(128)
  for (let i = 0; i < installerBytes.length; i += 1) {
    installerBytes[i] = (i * 3) % 256
  }
  const latestYml = "version: 0.3.7\npath: Atrium-Setup-0.3.7.exe\nreleaseDate: '2026-11-26T05:12:44.777Z'\n"
  const linuxYml = 'version: 0.3.7\npath: Atrium-0.3.7-linux-x86_64.AppImage\n'
  const blockmap034 = new TextEncoder().encode('blockmap-0.3.4')
  const legacyKvBytes = new TextEncoder().encode('legacy-kv-payload-123456')

  const calls: Array<{ url: string; method: string; range: string | null; noStore?: boolean }> = []
  let failHealthGitHub = false

  const mockFetch = async (url: string, init?: RequestInit, meta?: { noStore?: boolean }) => {
    const headers = new Headers(init?.headers)
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method, range: headers.get('Range'), noStore: meta?.noStore })

    if (url === 'https://github.com/yasmeendawnelle-spec/Atrium/releases/latest/download/latest.yml') {
      if (failHealthGitHub) return new Response('Upstream Error', { status: 503 })
      return new Response(latestYml, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(Buffer.byteLength(latestYml)),
          'Set-Cookie': '_gh_sess=secret; HttpOnly',
          'X-GitHub-Request-Id': 'abc123',
        },
      })
    }

    if (url === 'https://github.com/yasmeendawnelle-spec/Atrium/releases/latest/download/latest-linux.yml') {
      return new Response(linuxYml, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(Buffer.byteLength(linuxYml)),
        },
      })
    }

    if (url === 'https://github.com/yasmeendawnelle-spec/Atrium/releases/download/v0.3.7/Atrium-Setup-0.3.7.exe') {
      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(installerBytes.byteLength),
            'Accept-Ranges': 'bytes',
          },
        })
      }
      const range = headers.get('Range')
      if (range === 'bytes=0-63') {
        return new Response(installerBytes.slice(0, 64), {
          status: 206,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Range': `bytes 0-63/${installerBytes.byteLength}`,
            'Content-Length': '64',
            'Accept-Ranges': 'bytes',
          },
        })
      }
      return new Response(installerBytes, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(installerBytes.byteLength),
        },
      })
    }

    if (url === 'https://github.com/yasmeendawnelle-spec/Atrium/releases/download/v0.3.4/Atrium-Setup-0.3.4.exe.blockmap') {
      return new Response(blockmap034, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(blockmap034.byteLength),
        },
      })
    }

    // Force tag miss -> fallback to latest/download for v9.9.9 asset
    if (url === 'https://github.com/yasmeendawnelle-spec/Atrium/releases/download/v9.9.9/Atrium-Setup-9.9.9.exe') {
      return new Response('Not Found', { status: 404 })
    }
    if (url === 'https://github.com/yasmeendawnelle-spec/Atrium/releases/latest/download/Atrium-Setup-9.9.9.exe') {
      return new Response(new TextEncoder().encode('latest-fallback-ok'), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '18' },
      })
    }

    return new Response('Not Found', { status: 404 })
  }

  const store = createMockStore({
    'index:win': JSON.stringify({ latest: '0.3.4', updatedAt: '2026-11-23T14:42:10.701Z' }),
    'meta:win:legacy-0.3.4.bin': JSON.stringify({
      kind: 'inline',
      contentType: 'application/octet-stream',
      size: legacyKvBytes.byteLength,
    }),
    'blob:win:legacy-0.3.4.bin': legacyKvBytes,
  })

  const opts = { githubRepo: 'yasmeendawnelle-spec/Atrium', fetchImpl: mockFetch }

  // 1. /healthz reads latest.yml from GitHub Releases and falls back to KV on upstream failure
  const healthGh = await handleUpdateRequest(new Request('https://updates.rpulse.top/healthz'), store, opts)
  assert.equal(healthGh.status, 200)
  const healthGhJson = (await healthGh.json()) as Record<string, unknown>
  assert.equal(healthGhJson.ok, true)
  assert.equal(healthGhJson.source, 'github-releases')
  assert.equal(healthGhJson.latest, '0.3.7')
  assert.equal(healthGhJson.updatedAt, '2026-11-26T05:12:44.777Z')

  failHealthGitHub = true
  const healthKv = await handleUpdateRequest(new Request('https://updates.rpulse.top/healthz'), store, opts)
  assert.equal(healthKv.status, 200)
  const healthKvJson = (await healthKv.json()) as Record<string, unknown>
  assert.equal(healthKvJson.source, 'kv')
  assert.equal(healthKvJson.latest, '0.3.4')
  failHealthGitHub = false

  // 2. Manifests on /win, /latest, /linux normalize Content-Type, no-store, source, and strip cookies
  for (const manifestUrl of [
    'https://updates.rpulse.top/win/latest.yml',
    'https://updates.rpulse.top/latest/latest.yml',
  ]) {
    const res = await handleUpdateRequest(new Request(manifestUrl), store, opts)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/yaml; charset=utf-8')
    assert.match(res.headers.get('cache-control') ?? '', /no-store/)
    assert.equal(res.headers.get('x-atrium-source'), 'github-releases')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.equal(res.headers.get('x-github-request-id'), null)
    assert.equal(await res.text(), latestYml)
  }

  const linuxRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/linux/latest-linux.yml'),
    store,
    opts,
  )
  assert.equal(linuxRes.status, 200)
  assert.equal(linuxRes.headers.get('content-type'), 'text/yaml; charset=utf-8')
  assert.equal(await linuxRes.text(), linuxYml)

  // 3. Versioned asset + historical blockmap + tag-miss fallback to latest/download
  const blockRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.3.4.exe.blockmap'),
    store,
    opts,
  )
  assert.equal(blockRes.status, 200)
  assert.deepEqual(new Uint8Array(await blockRes.arrayBuffer()), blockmap034)

  const fallbackTagRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-9.9.9.exe'),
    store,
    opts,
  )
  assert.equal(fallbackTagRes.status, 200)
  assert.equal(await fallbackTagRes.text(), 'latest-fallback-ok')

  // 4. KV asset fallback when GitHub returns 404
  const kvFallback = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/legacy-0.3.4.bin'),
    store,
    opts,
  )
  assert.equal(kvFallback.status, 200)
  assert.equal(kvFallback.headers.get('x-atrium-source'), 'kv')
  assert.deepEqual(new Uint8Array(await kvFallback.arrayBuffer()), legacyKvBytes)

  // 5. Single Range request forwarded cleanly
  const singleRangeRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.3.7.exe', {
      headers: { Range: 'bytes=0-63' },
    }),
    store,
    opts,
  )
  assert.equal(singleRangeRes.status, 206)
  assert.equal(singleRangeRes.headers.get('content-range'), `bytes 0-63/${installerBytes.byteLength}`)
  assert.deepEqual(new Uint8Array(await singleRangeRes.arrayBuffer()), installerBytes.slice(0, 64))

  // 6. HEAD returns 200 with Content-Length and empty body
  const headRes = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.3.7.exe', { method: 'HEAD' }),
    store,
    opts,
  )
  assert.equal(headRes.status, 200)
  assert.equal(headRes.headers.get('content-length'), String(installerBytes.byteLength))
  assert.equal(await headRes.text(), '')

  // 7. Multi-range returns 501 without hitting upstream for GitHub-only asset, or 206 multipart for KV asset
  const callCountBeforeMulti = calls.length
  const multiGh = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/Atrium-Setup-0.3.7.exe', {
      headers: { Range: 'bytes=0-15, 100-115' },
    }),
    store,
    opts,
  )
  assert.equal(multiGh.status, 501)
  assert.equal(multiGh.headers.get('x-atrium-source'), 'github-releases')
  assert.equal(calls.length, callCountBeforeMulti)

  const multiKv = await handleUpdateRequest(
    new Request('https://updates.rpulse.top/win/legacy-0.3.4.bin', {
      headers: { Range: 'bytes=0-3, 10-15' },
    }),
    store,
    opts,
  )
  assert.equal(multiKv.status, 206)
  assert.equal(multiKv.headers.get('x-atrium-source'), 'kv')
  assert.match(multiKv.headers.get('content-type') ?? '', /^multipart\/byteranges; boundary=/)
})
