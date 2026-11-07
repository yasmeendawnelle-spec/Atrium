// Zero-config built-in web tools (`web_search` and `web_fetch`).
// Uses `netFetch` (respecting Atrium's proxy settings) and enforces strict SSRF guards.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { ToolInfo } from '../../shared/types.ts'
import { describeNetworkError, netFetch, proxyFor } from '../net.ts'

export const WEB_TOOLS: ToolInfo[] = [
  {
    name: 'web_search',
    description:
      'Search the public web for up-to-date information, documentation, releases, or articles without requiring an external MCP server or API key.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query string.' },
        limit: { type: 'number', description: 'Maximum number of results to return (1-10, default 6).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public web page (http:// or https://) and return clean readable text/Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public http:// or https:// URL to read.' },
        max_chars: { type: 'number', description: 'Maximum characters to return (default 18000, max 40000).' },
      },
      required: ['url'],
    },
  },
]

const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
const MAX_FETCH_BYTES = 2 * 1024 * 1024
const FETCH_TIMEOUT_MS = 18_000
const MAX_REDIRECTS = 5

export function isFakeIpBenchmarkRange(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0]!.trim().toLowerCase()
  if (isIP(ip) !== 4) return false
  const parts = ip.split('.').map(Number)
  const [a, b] = [parts[0]!, parts[1]!]
  // RFC 2544 benchmark range; also used as virtual Fake-IP DNS by TUN proxies (Clash / Mihomo / Surge).
  return a === 198 && (b === 18 || b === 19)
}

export function isPrivateOrReservedIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0]!.trim().toLowerCase()
  const v = isIP(ip)
  if (v === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = [parts[0]!, parts[1]!]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 192 && b === 0 && parts[2] === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (v === 6) {
    if (ip === '::' || ip === '::1') return true
    if (ip.startsWith('::ffff:')) {
      const embedded = ip.slice('::ffff:'.length)
      if (embedded.includes('.')) return isPrivateOrReservedIp(embedded)
      const hex = embedded.split(':')
      if (hex.length === 2) {
        const n1 = Number.parseInt(hex[0]!, 16)
        const n2 = Number.parseInt(hex[1]!, 16)
        if (!Number.isNaN(n1) && !Number.isNaN(n2)) {
          return isPrivateOrReservedIp(`${(n1 >> 8) & 255}.${n1 & 255}.${(n2 >> 8) & 255}.${n2 & 255}`)
        }
      }
      return true
    }
    const firstWord = Number.parseInt(ip.split(':')[0] || '0', 16)
    if (!Number.isNaN(firstWord)) {
      // fc00::/7 (Unique local), fe80::/10 (Link-local), ff00::/8 (Multicast)
      if ((firstWord & 0xfe00) === 0xfc00) return true
      if ((firstWord & 0xffc0) === 0xfe80) return true
      if ((firstWord & 0xff00) === 0xff00) return true
    }
    return false
  }
  return false
}

export async function assertSafePublicUrl(
  rawUrl: string,
  opts?: { checkDns?: boolean },
): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}".`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL protocol "${url.protocol}". Only http:// and https:// are allowed.`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw new Error('URL has no hostname.')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal' ||
    host === 'metadata'
  ) {
    throw new Error(`Blocked private or local host "${host}".`)
  }
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error(`Blocked private or reserved IP address "${host}".`)
    }
    return url
  }

  if (opts?.checkDns !== false) {
    try {
      const resolved = await lookup(host, { all: true })
      for (const rec of resolved) {
        if (isPrivateOrReservedIp(rec.address) && !isFakeIpBenchmarkRange(rec.address)) {
          throw new Error(`Blocked host "${host}" resolving to private IP ${rec.address}.`)
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Blocked ')) throw err
      // If a proxy is active, external hostnames might not resolve locally via system DNS.
      const proxy = await proxyFor(url.href).catch(() => null)
      if (!proxy) {
        // Still allow fetch step to surface a clean describeNetworkError if offline.
      }
    }
  }
  return url
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

function unwrapDuckDuckGoHref(href: string): string {
  const clean = decodeHtmlEntities(href.trim())
  if (!clean) return ''
  try {
    const resolved = clean.startsWith('//') ? new URL(`https:${clean}`) : clean.startsWith('/') ? new URL(`https://duckduckgo.com${clean}`) : new URL(clean)
    const uddg = resolved.searchParams.get('uddg')
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg
    if (/^https?:\/\//i.test(resolved.href) && !resolved.hostname.endsWith('duckduckgo.com')) {
      return resolved.href
    }
    return /^https?:\/\//i.test(clean) ? clean : ''
  } catch {
    return /^https?:\/\//i.test(clean) ? clean : ''
  }
}

export function parseDuckDuckGoHtml(html: string, limit = 6): WebSearchHit[] {
  const hits: WebSearchHit[] = []
  const seen = new Set<string>()

  // 1. Standard HTML endpoint (<a class="result__a" ...> + <a class="result__snippet" ...>)
  const blocks = html.split(/<div[^>]*class=["'][^"']*result(?:\s+results_links|\s+web-result)[^"']*["']/i)
  for (const block of blocks.slice(1)) {
    const linkMatch = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!linkMatch) continue
    const url = unwrapDuckDuckGoHref(linkMatch[1]!)
    if (!url || seen.has(url)) continue
    const title = stripTags(linkMatch[2]!)
    if (!title) continue
    const snipMatch = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(block)
    const snippet = snipMatch ? stripTags(snipMatch[1]!) : ''
    seen.add(url)
    hits.push({ title, url, snippet })
    if (hits.length >= limit) return hits
  }

  // 2. Fallback: DuckDuckGo Lite table markup (<a class="result-link" href="..."> + <td class="result-snippet">)
  const linkRe = /<a[^>]*class=["'][^"']*result-link[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null) {
    const url = unwrapDuckDuckGoHref(m[1]!)
    const title = stripTags(m[2]!)
    if (!url || !title || seen.has(url)) continue
    const tail = html.slice(m.index, m.index + 1600)
    const snipMatch = /class=["'][^"']*result-snippet[^"']*["'][^>]*>([\s\S]*?)<\/td>/i.exec(tail)
    seen.add(url)
    hits.push({ title, url, snippet: snipMatch ? stripTags(snipMatch[1]!) : '' })
    if (hits.length >= limit) break
  }

  return hits
}

export function htmlToReadableText(raw: string, contentType: string, sourceUrl: string, maxChars = 18_000): string {
  const ct = contentType.toLowerCase()
  if (ct.includes('application/json')) {
    try {
      const formatted = JSON.stringify(JSON.parse(raw), null, 2)
      return capText(formatted, maxChars)
    } catch {
      return capText(raw, maxChars)
    }
  }
  if (!ct.includes('html') && !ct.includes('xml')) {
    return capText(raw.trim(), maxChars)
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  const title = titleMatch ? stripTags(titleMatch[1]!) : ''

  let body = raw
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<(nav|footer|aside)\b[^>]*class=["'][^"']*(?:nav|menu|footer|cookie|banner)[^"']*["'][\s\S]*?<\/\1>/gi, '\n')

  body = body
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner)}\n\n`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => `\n\n\`\`\`\n${decodeHtmlEntities(inner.replace(/<[^>]+>/g, ''))}\n\`\`\`\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}`)
    .replace(/<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const text = stripTags(inner)
      return text ? `[${text}](${href})` : href
    })
    .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|tr|blockquote|main|header)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeHtmlEntities(body)
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const header = title ? `# ${title}\nSource: ${sourceUrl}\n\n` : `Source: ${sourceUrl}\n\n`
  return capText(`${header}${cleaned}`, maxChars)
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…(truncated at ${maxChars} characters)`
}

async function readResponseCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return (await res.text()).slice(0, maxBytes)
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      chunks.push(value)
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  }
  const merged = Buffer.concat(chunks)
  return merged.slice(0, maxBytes).toString('utf8')
}

export async function webSearch(
  query: string,
  limit = 6,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ output: string; isError: boolean }> {
  const q = query.trim()
  if (!q) return { output: 'A search query is required.', isError: true }
  const max = Math.min(10, Math.max(1, Math.floor(limit || 6)))
  const fetcher = opts?.fetchImpl ?? netFetch
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
  ]

  let lastError = ''
  for (const endpoint of endpoints) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      const onAbort = () => ctrl.abort()
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await fetcher(endpoint, {
          method: 'GET',
          headers: {
            'user-agent': SEARCH_UA,
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-US,en;q=0.9',
          },
          signal: ctrl.signal,
        })
        if (!res.ok) {
          lastError = `Search returned HTTP ${res.status}.`
          continue
        }
        const html = await readResponseCapped(res, 1024 * 1024)
        const hits = parseDuckDuckGoHtml(html, max)
        if (hits.length === 0) continue
        const formatted = hits
          .map((h, idx) => `${idx + 1}. **${h.title}**\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
          .join('\n\n')
        return { output: formatted, isError: false }
      } finally {
        clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
      }
    } catch (err) {
      if (opts?.signal?.aborted) return { output: 'Stopped.', isError: true }
      lastError = describeNetworkError(err, endpoint)
    }
  }

  return {
    output: lastError || `No search results found for "${q}".`,
    isError: Boolean(lastError),
  }
}

export async function webFetch(
  rawUrl: string,
  maxChars = 18_000,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal; checkDns?: boolean },
): Promise<{ output: string; isError: boolean }> {
  const cap = Math.min(40_000, Math.max(1000, Math.floor(maxChars || 18_000)))
  const fetcher = opts?.fetchImpl ?? netFetch
  let current: URL
  try {
    current = await assertSafePublicUrl(rawUrl, { checkDns: opts?.checkDns })
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const onAbort = () => ctrl.abort()
    opts?.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await fetcher(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': SEARCH_UA,
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
        },
        signal: ctrl.signal,
      })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) return { output: `Redirect (${res.status}) with no Location header.`, isError: true }
        const nextUrl = new URL(location, current).href
        current = await assertSafePublicUrl(nextUrl, { checkDns: opts?.checkDns })
        continue
      }
      if (!res.ok) {
        return { output: `HTTP ${res.status} fetching ${current.href}.`, isError: true }
      }
      const ct = res.headers.get('content-type') ?? ''
      if (ct && !/text\/|json|xml|javascript|xhtml|rss|atom/i.test(ct)) {
        return { output: `Unsupported binary content-type "${ct}" at ${current.href}.`, isError: true }
      }
      const raw = await readResponseCapped(res, MAX_FETCH_BYTES)
      return { output: htmlToReadableText(raw, ct, current.href, cap), isError: false }
    } catch (err) {
      if (opts?.signal?.aborted) return { output: 'Stopped.', isError: true }
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.startsWith('Blocked ') || msg.startsWith('Invalid URL')) return { output: msg, isError: true }
      return { output: describeNetworkError(err, current.href), isError: true }
    } finally {
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onAbort)
    }
  }
  return { output: `Too many redirects fetching ${rawUrl}.`, isError: true }
}

export async function runWebTool(
  name: string,
  input: Record<string, unknown>,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal; checkDns?: boolean },
): Promise<{ output: string; isError: boolean }> {
  try {
    if (name === 'web_search') {
      return await webSearch(String(input.query ?? ''), Number(input.limit ?? 6), opts)
    }
    if (name === 'web_fetch') {
      return await webFetch(String(input.url ?? ''), Number(input.max_chars ?? 18_000), opts)
    }
    return { output: `Unknown web tool: ${name}`, isError: true }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }
}
