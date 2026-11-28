import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { shell } from '../lib/api.ts'

export type ArchiveModelName = 'archive-cassette.glb' | 'archive-assembly.glb'

const rawGlbCache = new Map<ArchiveModelName, Promise<ArrayBuffer>>()

async function fetchArchiveBuffer(name: ArchiveModelName): Promise<ArrayBuffer> {
  try {
    const raw = await shell.readArchiveModel(name)
    if (raw && raw.byteLength > 0) {
      return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
    }
  } catch {
    // Fall back to renderer asset fetch when running outside Electron IPC
  }
  const res = await fetch(`./assets/${name}`)
  if (!res.ok) {
    throw new Error(`Failed to fetch ${name}: ${res.status} ${res.statusText}`)
  }
  return await res.arrayBuffer()
}

export function loadRawGlb(name: ArchiveModelName): Promise<ArrayBuffer> {
  const cached = rawGlbCache.get(name)
  if (cached) return cached
  const pending = fetchArchiveBuffer(name).catch((err) => {
    rawGlbCache.delete(name)
    throw err
  })
  rawGlbCache.set(name, pending)
  return pending
}

export async function loadArchiveGlb(name: ArchiveModelName): Promise<GLTF> {
  const loader = new GLTFLoader()
  const buf = await loadRawGlb(name)
  // Pass an isolated slice so GLTFLoader never mutates or transfers the cached buffer
  return await loader.parseAsync(buf.slice(0), '')
}
