// MCP OAuth 2.1 manager using the official @modelcontextprotocol/sdk auth orchestrator.
// Tokens and client registrations are encrypted at rest via `secrets.ts`.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpServerConfig } from '../../shared/types.ts'
import { netFetch } from '../net.ts'
import { renderAtriumOAuthPage } from '../oauth_page.ts'
import { getSecret, secretKey, setSecret } from '../secrets.ts'

const OAUTH_SECRET_NAME = '__oauth__'
const AUTH_TIMEOUT_MS = 180_000

export interface StoredOAuthBundle {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
}

async function readBundle(serverId: string): Promise<StoredOAuthBundle> {
  try {
    const raw = await getSecret(secretKey('mcp', serverId, OAUTH_SECRET_NAME))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as StoredOAuthBundle
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeBundle(serverId: string, bundle: StoredOAuthBundle): Promise<void> {
  const empty =
    !bundle.clientInformation &&
    !bundle.tokens &&
    !bundle.codeVerifier &&
    !bundle.discoveryState
  await setSecret(secretKey('mcp', serverId, OAUTH_SECRET_NAME), empty ? null : JSON.stringify(bundle))
}

export async function clearMcpOAuth(serverId: string): Promise<void> {
  await setSecret(secretKey('mcp', serverId, OAUTH_SECRET_NAME), null)
}

export async function hasStoredOAuthBundle(serverId: string): Promise<boolean> {
  const b = await readBundle(serverId)
  return Boolean(b.tokens?.access_token || b.tokens?.refresh_token)
}

function callbackPage(ok: boolean, message: string): string {
  return renderAtriumOAuthPage({
    ok,
    title: ok ? '连接成功' : '授权失败',
    heading: ok ? 'MCP 服务已连接至 Atrium' : 'MCP OAuth 授权失败',
    message,
    providerLabel: 'MCP OAuth',
  })
}

class AtriumMcpOAuthProvider implements OAuthClientProvider {
  private readonly config: McpServerConfig
  private readonly redirectUri: string
  private readonly interactive: boolean
  private readonly onRedirect?: (url: URL) => Promise<void> | void
  private readonly onInteractiveNeeded?: () => void
  private readonly stateToken: string
  private cache: StoredOAuthBundle | null = null

  constructor(opts: {
    config: McpServerConfig
    redirectUri: string
    interactive: boolean
    stateToken?: string
    onRedirect?: (url: URL) => Promise<void> | void
    onInteractiveNeeded?: () => void
  }) {
    this.config = opts.config
    this.redirectUri = opts.redirectUri
    this.interactive = opts.interactive
    this.stateToken = opts.stateToken ?? randomBytes(16).toString('hex')
    this.onRedirect = opts.onRedirect
    this.onInteractiveNeeded = opts.onInteractiveNeeded
  }

  private async load(): Promise<StoredOAuthBundle> {
    if (!this.cache) this.cache = await readBundle(this.config.id)
    return this.cache
  }

  private async save(patch: Partial<StoredOAuthBundle>, persistWhenNonInteractive = false): Promise<StoredOAuthBundle> {
    const cur = await this.load()
    const next = { ...cur, ...patch }
    this.cache = next
    if (this.interactive || persistWhenNonInteractive) {
      await writeBundle(this.config.id, next)
    }
    return next
  }

  get redirectUrl(): string {
    return this.redirectUri
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.config.oauth?.scopes?.trim()
    return {
      client_name: 'Atrium Desktop',
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scope ? { scope } : {}),
    }
  }

  state(): string {
    return this.stateToken
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.oauth?.clientId?.trim()) {
      return { client_id: this.config.oauth.clientId.trim() }
    }
    const b = await this.load()
    return b.clientInformation
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    if (this.config.oauth?.clientId?.trim()) return
    await this.save({ clientInformation })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const b = await this.load()
    return b.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt =
      typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
        ? Date.now() + tokens.expires_in * 1000
        : undefined
    await this.save({ tokens, expiresAt }, true)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.save({ codeVerifier })
  }

  async codeVerifier(): Promise<string> {
    const b = await this.load()
    if (!b.codeVerifier) throw new Error('OAuth PKCE code verifier is missing.')
    return b.codeVerifier
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const b = await this.load()
    return b.discoveryState
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.save({ discoveryState: state })
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const cur = await this.load()
    const next: StoredOAuthBundle = { ...cur }
    if (scope === 'all') {
      await clearMcpOAuth(this.config.id)
      this.cache = {}
      return
    }
    if (scope === 'client') delete next.clientInformation
    if (scope === 'tokens') {
      delete next.tokens
      delete next.expiresAt
    }
    if (scope === 'verifier') delete next.codeVerifier
    if (scope === 'discovery') delete next.discoveryState
    this.cache = next
    await writeBundle(this.config.id, next)
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (this.onRedirect) {
      await this.onRedirect(authorizationUrl)
      return
    }
    this.onInteractiveNeeded?.()
  }
}

export function createBackgroundOAuthProvider(
  config: McpServerConfig,
  onInteractiveNeeded: () => void,
): OAuthClientProvider {
  return new AtriumMcpOAuthProvider({
    config,
    redirectUri: 'http://127.0.0.1:49152/oauth/callback',
    interactive: false,
    onInteractiveNeeded,
  })
}

export function isUnauthorizedMcpError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /\b401\b|unauthorized|invalid_token|authentication required/i.test(msg)
}

export async function startMcpOAuthFlow(
  config: McpServerConfig,
  openExternal: (url: string) => Promise<void>,
  timeoutMs = AUTH_TIMEOUT_MS,
): Promise<{ expiresAt?: number }> {
  if (config.transport !== 'http' || !config.url) {
    throw new Error('OAuth 2.1 is only supported on remote HTTP MCP servers.')
  }
  const serverUrl = config.url
  const stateToken = randomBytes(16).toString('hex')
  let authRedirectUrl: URL | null = null

  let resolveCode: (code: string) => void = () => undefined
  let rejectCode: (err: Error) => void = () => undefined
  const callbackPromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const callbackServer = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (reqUrl.pathname !== '/oauth/callback') {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const errParam = reqUrl.searchParams.get('error')
    const errDesc = reqUrl.searchParams.get('error_description')
    if (errParam) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(callbackPage(false, errDesc || errParam))
      rejectCode(new Error(`OAuth authorization declined: ${errDesc || errParam}`))
      return
    }
    const returnedState = reqUrl.searchParams.get('state')
    if (returnedState !== stateToken) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(callbackPage(false, 'State verification failed. Please retry from Atrium.'))
      rejectCode(new Error('OAuth state mismatch.'))
      return
    }
    const code = reqUrl.searchParams.get('code')
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(callbackPage(false, 'Authorization code was missing in the callback.'))
      rejectCode(new Error('OAuth callback did not contain an authorization code.'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(callbackPage(true, 'Authorization complete. You can close this browser tab and return to Atrium.'))
    resolveCode(code)
  })

  await new Promise<void>((resolve, reject) => {
    callbackServer.once('error', reject)
    callbackServer.listen(0, '127.0.0.1', () => {
      callbackServer.off('error', reject)
      resolve()
    })
  })

  const timer = setTimeout(() => {
    rejectCode(new Error('Timed out waiting for browser OAuth confirmation.'))
  }, timeoutMs)

  try {
    const port = (callbackServer.address() as { port: number }).port
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`

    const provider = new AtriumMcpOAuthProvider({
      config,
      redirectUri,
      interactive: true,
      stateToken,
      onRedirect: async (url) => {
        authRedirectUrl = url
        await openExternal(url.href)
      },
    })

    // Invalidate stale dynamic client info if previous registration used another callback port
    // so authorization server binds cleanly to the current loopback URI when no fixed clientId is set.
    if (!config.oauth?.clientId) {
      await provider.invalidateCredentials('client')
    }

    const scope = config.oauth?.scopes?.trim() || undefined
    const initial = await auth(provider, {
      serverUrl,
      scope,
      fetchFn: netFetch as never,
    })

    if (initial === 'REDIRECT') {
      if (!authRedirectUrl) {
        throw new Error('Authorization redirect was expected but no authorization URL was provided.')
      }
      const code = await callbackPromise
      const completed = await auth(provider, {
        serverUrl,
        authorizationCode: code,
        scope,
        fetchFn: netFetch as never,
      })
      if (completed !== 'AUTHORIZED') {
        throw new Error('Failed to exchange authorization code for OAuth tokens.')
      }
    }

    const bundle = await readBundle(config.id)
    return { expiresAt: bundle.expiresAt }
  } finally {
    clearTimeout(timer)
    callbackServer.close()
  }
}
