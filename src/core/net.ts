// Proxy-aware fetch for the core process.
// Node's built-in fetch ignores proxies, and many users (especially in mainland
// China) can only reach model APIs through a local proxy, so every outbound
// request goes through `netFetch`.
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { ProxyMode } from '../shared/types.ts'

export type ResolveSystemProxy = (url: string) => Promise<string>

let mode: ProxyMode = 'system'
let customUrl: string | undefined
let resolveSystem: ResolveSystemProxy | undefined

const STREAM_TIMEOUT_MS = 600_000
const direct = new Agent({
  connect: { timeout: 20_000 },
  headersTimeout: STREAM_TIMEOUT_MS,
  bodyTimeout: STREAM_TIMEOUT_MS,
})
const proxyAgents = new Map<string, ProxyAgent>()
const systemCache = new Map<string, string | null>()

export function configureNetwork(opts: { mode: ProxyMode; url?: string; resolveSystem?: ResolveSystemProxy }): void {
  mode = opts.mode
  customUrl = opts.url?.trim() || undefined
  if (opts.resolveSystem) resolveSystem = opts.resolveSystem
  systemCache.clear()
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  )
}

function envProxy(protocol: string): string | undefined {
  const env = process.env
  const value =
    protocol === 'http:'
      ? env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy
      : env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  return value?.trim() || undefined
}

function bypassedByNoProxy(hostname: string): boolean {
  const list = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase())
  const host = hostname.toLowerCase()
  return list.some((entry) => {
    if (!entry) return false
    if (entry === '*') return true
    const bare = entry.replace(/^\*?\./, '')
    return host === bare || host.endsWith(`.${bare}`)
  })
}

/** Parses Chromium's resolveProxy output, e.g. "PROXY 127.0.0.1:7897; DIRECT". */
export function parseChromiumProxy(result: string): string | null {
  for (const part of result.split(';')) {
    const [kind, hostPort] = part.trim().split(/\s+/)
    if (!kind) continue
    const k = kind.toUpperCase()
    if (k === 'DIRECT') return null
    if ((k === 'PROXY' || k === 'HTTP') && hostPort) return `http://${hostPort}`
    if (k === 'HTTPS' && hostPort) return `https://${hostPort}`
    // SOCKS proxies are not supported by undici's ProxyAgent; try the next entry.
  }
  return null
}

/** Returns the proxy URL to use for `url`, or null for a direct connection. */
export async function proxyFor(url: string): Promise<string | null> {
  const u = new URL(url)
  if (isLocalHost(u.hostname)) return null
  if (mode === 'none') return null
  if (mode === 'custom') return customUrl ?? null
  const fromEnv = envProxy(u.protocol)
  if (fromEnv) return bypassedByNoProxy(u.hostname) ? null : fromEnv
  if (!resolveSystem) return null
  const key = `${u.protocol}//${u.host}`
  if (systemCache.has(key)) return systemCache.get(key) ?? null
  let resolved: string | null = null
  try {
    resolved = parseChromiumProxy(await resolveSystem(key))
  } catch {
    resolved = null
  }
  systemCache.set(key, resolved)
  return resolved
}

async function dispatcherFor(url: string): Promise<Dispatcher> {
  const proxy = await proxyFor(url)
  if (!proxy) return direct
  let agent = proxyAgents.get(proxy)
  if (!agent) {
    agent = new ProxyAgent({
      uri: proxy,
      connect: { timeout: 20_000 },
      headersTimeout: STREAM_TIMEOUT_MS,
      bodyTimeout: STREAM_TIMEOUT_MS,
    })
    proxyAgents.set(proxy, agent)
  }
  return agent
}

/** Drop-in replacement for `fetch` that applies the configured proxy. */
export const netFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const dispatcher = await dispatcherFor(url)
  // undici's fetch is spec-compatible with the global one; the cast bridges the two type sets.
  return (await undiciFetch(input as never, { ...(init as object), dispatcher } as never)) as unknown as Response
}) as typeof fetch

/** Environment variables that make child processes (npx, uvx, pip) use the same proxy. */
export async function proxyEnvFor(url = 'https://registry.npmjs.org'): Promise<Record<string, string>> {
  const proxy = await proxyFor(url)
  if (!proxy) return {}
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy }
}

function redactUpstreamText(text: string): string {
  return text
    .replace(/https?:\/\/[a-z0-9.-]*rpulse\.top[^\s)"']*/gi, 'Atrium Cloud')
    .replace(/\b[a-z0-9.-]*rpulse\.top\b/gi, 'Atrium Cloud')
}

/** Turns low-level network failures into a sentence a beginner can act on. */
export function describeNetworkError(err: unknown, url: string): string {
  let host = url
  try {
    const u = new URL(url)
    host = /(?:^|\.)rpulse\.top$/i.test(u.hostname) ? 'Atrium Cloud' : u.host
  } catch {
    host = redactUpstreamText(url)
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (e?.name === 'AbortError') return 'Stopped.'
  const code = e?.cause?.code ?? ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return `Couldn't find ${host}. Check the address and your internet connection.`
  if (code === 'ECONNREFUSED') return `${host} refused the connection. Check that the server is running.`
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT')
    return `Timed out connecting to ${host}. If you use a proxy, check it in Settings > Network.`
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT')
    return `Timed out waiting for a streamed response from ${host} (${code}).`
  if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || e?.message === 'terminated')
    return `The connection to ${host} dropped mid-response (${code || 'terminated'}).`
  if (code.startsWith('CERT_') || code.includes('SSL') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return `The secure connection to ${host} failed (${code}).`
  const detail = redactUpstreamText(e?.cause?.message || e?.message || String(err))
  return `Couldn't reach ${host}: ${detail}`
}
