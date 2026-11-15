import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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
