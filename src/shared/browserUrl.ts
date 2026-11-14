// Shared browser URL normalization, Edge/Google dual-mode profiles & safety checks.
import type { BrowserMode } from './types.ts'

export interface BrowserModeProfile {
  mode: BrowserMode
  label: string
  homeUrl: string
  homeTitle: string
  searchPrefix: string
  presets: string[]
}

export const BROWSER_MODE_PROFILES: Record<BrowserMode, BrowserModeProfile> = {
  edge: {
    mode: 'edge',
    label: 'Edge',
    homeUrl: 'https://cn.bing.com/',
    homeTitle: 'Bing',
    searchPrefix: 'https://cn.bing.com/search?q=',
    presets: ['https://cn.bing.com/', 'http://localhost:8000', 'http://localhost:5173', 'http://localhost:3000'],
  },
  google: {
    mode: 'google',
    label: 'Google',
    homeUrl: 'https://www.google.com/',
    homeTitle: 'Google',
    searchPrefix: 'https://www.google.com/search?q=',
    presets: ['https://www.google.com/', 'http://localhost:8000', 'http://localhost:5173', 'http://localhost:3000'],
  },
}

const MODE_SEARCH_HOSTS = new Set(['www.google.com', 'google.com', 'cn.bing.com', 'www.bing.com', 'bing.com'])
const MODE_HOME_PATHS = new Set(['', '/', '/search', '/webhp'])

export function normalizeBrowserMode(value: unknown, fallback: BrowserMode = 'google'): BrowserMode {
  if (value === 'edge' || value === 'google') return value
  return fallback
}

export function defaultBrowserModeForLocale(localeTag?: string): BrowserMode {
  return (localeTag || '').trim().toLowerCase().startsWith('zh') ? 'edge' : 'google'
}

export function getBrowserProfile(mode: BrowserMode = 'google'): BrowserModeProfile {
  return BROWSER_MODE_PROFILES[mode === 'edge' ? 'edge' : 'google']
}

export function isModeHomeOrSearchUrl(rawUrl: string | undefined): boolean {
  const clean = (rawUrl || '').trim()
  if (!clean || clean === 'about:blank' || clean.startsWith('chrome-error://')) return true
  try {
    const parsed = new URL(clean)
    const host = parsed.hostname.toLowerCase()
    if (!MODE_SEARCH_HOSTS.has(host)) return false
    const normPath = parsed.pathname.replace(/\/+$/, '')
    return MODE_HOME_PATHS.has(normPath || '/')
  } catch {
    return false
  }
}

export function buildBrowserUserAgent(baseUa: string, mode: BrowserMode): string {
  const cleaned = (baseUa || '')
    .replace(/\b(?:Atrium|Electron|Edg|Edge)\/[^\s)]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  const base =
    cleaned ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
  if (mode !== 'edge') return base
  const chromeMatch = /\bChrome\/(\d+(?:\.\d+)*)/i.exec(base)
  const ver = chromeMatch?.[1] || '134.0.0.0'
  return `${base} Edg/${ver}`
}

const BLOCKED_METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata'])
const EXPLICIT_BLOCKED_PROTOCOLS = /^(file|javascript|data|vbscript|blob|about|chrome|chrome-extension|ftp|ws|wss):/i
const PUBLIC_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i
const IPV4_HOST_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:[/?#].*)?$/

function isLocalOrPrivateHost(hostWithPort: string): boolean {
  const withoutPath = hostWithPort.split(/[/?#]/, 1)[0] ?? ''
  // Handle bracketed IPv6 like [::1]:3000 or [::1]
  if (withoutPath.startsWith('[')) {
    const closeIdx = withoutPath.indexOf(']')
    const host = (closeIdx > 1 ? withoutPath.slice(1, closeIdx) : withoutPath).toLowerCase()
    const rest = closeIdx >= 0 ? withoutPath.slice(closeIdx + 1) : ''
    if (host === '::1') return true
    if (/^:\d+$/.test(rest) && rest !== ':443') return true
    return false
  }
  const colonIdx = withoutPath.lastIndexOf(':')
  const port = colonIdx > 0 && /^\d+$/.test(withoutPath.slice(colonIdx + 1)) ? withoutPath.slice(colonIdx + 1) : ''
  const host = (colonIdx > 0 && port ? withoutPath.slice(0, colonIdx) : withoutPath).toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) return true
  const m172 = /^172\.(\d+)\./.exec(host)
  if (m172) {
    const second = Number(m172[1])
    if (second >= 16 && second <= 31) return true
  }
  if (port && port !== '443') return true
  return false
}

export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Please enter a browser URL.')
  }
  let candidate: string
  if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed
  } else if (EXPLICIT_BLOCKED_PROTOCOLS.test(trimmed)) {
    const proto = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()
    throw new Error(`Blocked browser protocol "${proto}". Only http:// and https:// are permitted.`)
  } else {
    candidate = isLocalOrPrivateHost(trimmed) ? `http://${trimmed}` : `https://${trimmed}`
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Invalid browser URL: "${raw}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked browser protocol "${parsed.protocol}". Only http:// and https:// are permitted.`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (BLOCKED_METADATA_HOSTS.has(host)) {
    throw new Error(`Blocked cloud metadata host "${host}".`)
  }
  return parsed.toString()
}

/**
 * Resolves omnibox input into a safe URL: explicit URLs and hostnames normalize directly,
 * while plain search queries route through Edge (cn.bing.com) or Google (google.com).
 */
export function resolveBrowserInput(raw: string, mode: BrowserMode = 'google'): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('Please enter a browser URL.')
  }
  if (/^https?:\/\//i.test(trimmed) || EXPLICIT_BLOCKED_PROTOCOLS.test(trimmed)) {
    return normalizeBrowserUrl(trimmed)
  }
  const hasWhitespace = /\s/.test(trimmed)
  const looksLikeUrl =
    !hasWhitespace &&
    (isLocalOrPrivateHost(trimmed) || IPV4_HOST_PATTERN.test(trimmed) || PUBLIC_HOST_PATTERN.test(trimmed))
  if (looksLikeUrl) {
    return normalizeBrowserUrl(trimmed)
  }
  const profile = getBrowserProfile(mode)
  return `${profile.searchPrefix}${encodeURIComponent(trimmed)}`
}
