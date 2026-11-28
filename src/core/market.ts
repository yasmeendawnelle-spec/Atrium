// The official MCP registry (registry.modelcontextprotocol.io) plus GitHub
// import. GitHub import reads files over the API; it never clones or runs
// anything. The user reviews every proposal before it is saved.
import { ATRIUM_MARKET_DEFAULT_ORIGIN } from '../shared/relaypulse.ts'
import type {
  GithubImportResult,
  GithubPluginProposal,
  InstallOption,
  MarketCatalogResult,
  MarketExternalHit,
  MarketExternalSource,
  MarketIdentity,
  MarketItem,
  MarketPluginDetail,
  MarketPluginListing,
  MarketReviewDecisionRequest,
  MarketReviewQueueResult,
  MarketSearchResult,
  MarketSearchScope,
  MarketSubmitRequest,
  MarketUnifiedSearchResult,
  McpServerConfig,
  PluginCandidate,
  PluginImportResult,
  RelayPulseAccountState,
} from '../shared/types.ts'
import { describeNetworkError, netFetch } from './net.ts'
import { configsFromMarkdown, optionFromEntry, parseConfigText } from './mcp/parse.ts'
import { inspectGithubTreeForPlugin, type PluginManager } from './plugins.ts'

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0.1/servers'
const GITHUB_API = 'https://api.github.com'

type ServerDraft = Omit<McpServerConfig, 'id' | 'enabled'>

interface RegistryPackage {
  registryType?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  transport?: { type?: string; url?: string }
  runtimeArguments?: { type?: string; value?: string; isRepeated?: boolean }[]
  packageArguments?: { type?: string; value?: string; valueHint?: string; isSecret?: boolean }[]
  environmentVariables?: {
    name: string
    description?: string
    isRequired?: boolean
    isSecret?: boolean
    default?: string
  }[]
}

interface RegistryServer {
  name: string
  description?: string
  version?: string
  repository?: { url?: string; source?: string; subfolder?: string }
  websiteUrl?: string
  packages?: RegistryPackage[]
  remotes?: { type?: string; url?: string }[]
}

interface RegistryEntry {
  server: RegistryServer
  _meta?: { 'io.modelcontextprotocol.registry/official'?: { status?: string; isLatest?: boolean } }
}

export async function searchRegistry(
  query: string,
  cursor?: string,
  fetchImpl: typeof netFetch = netFetch,
): Promise<MarketSearchResult> {
  const url = new URL(REGISTRY)
  if (query.trim()) url.searchParams.set('search', query.trim())
  url.searchParams.set('limit', '20')
  url.searchParams.set('version', 'latest')
  if (cursor) url.searchParams.set('cursor', cursor)
  const res = await get(url.href, false, fetchImpl)
  const body = (await res.json()) as { servers?: RegistryEntry[]; metadata?: { nextCursor?: string } }
  const items = (body.servers ?? [])
    .filter((e) => e._meta?.['io.modelcontextprotocol.registry/official']?.status !== 'deprecated')
    .map(toMarketItem)
    .filter((item) => item.installs.length > 0)
  return { items, nextCursor: body.metadata?.nextCursor }
}

function toMarketItem(entry: RegistryEntry): MarketItem {
  const server = entry.server
  const source: ServerDraft['source'] = { kind: 'registry', ref: server.name }
  const installs: InstallOption[] = []
  for (const pkg of server.packages ?? []) {
    const option = optionFromPackage(server.name, pkg, source)
    if (option) installs.push(option)
  }
  for (const remote of server.remotes ?? []) {
    if (!remote.url) continue
    installs.push({
      label: remote.url,
      config: { name: shortName(server.name), transport: 'http', url: remote.url, source },
      inputs: [],
      note: remote.type,
    })
  }
  return {
    id: server.name,
    name: shortName(server.name),
    title: server.name,
    description: server.description ?? '',
    version: server.version,
    repositoryUrl: server.repository?.url,
    websiteUrl: server.websiteUrl,
    installs,
  }
}

function optionFromPackage(serverName: string, pkg: RegistryPackage, source: ServerDraft['source']): InstallOption | null {
  if (pkg.registryType !== 'npm' || !pkg.identifier) return null
  const args = ['-y', pkg.identifier]
  for (const arg of [...(pkg.runtimeArguments ?? []), ...(pkg.packageArguments ?? [])]) {
    if (arg.value && arg.value !== '-y') args.push(arg.value)
  }
  const env: Record<string, string> = {}
  const inputs = (pkg.environmentVariables ?? []).map((v) => {
    env[v.name] = ''
    return {
      key: v.name,
      target: 'env' as const,
      description: v.description,
      required: v.isRequired !== false,
      secret: v.isSecret === true,
      defaultValue: v.default,
    }
  })
  const secretKeys = inputs.filter((i) => i.secret).map((i) => `env:${i.key}`)
  const config: ServerDraft = {
    name: shortName(serverName),
    transport: 'stdio',
    command: pkg.runtimeHint || 'npx',
    args,
    env,
    source,
  }
  if (secretKeys.length) config.secretKeys = secretKeys
  return { label: `npx ${args.join(' ')}`, config, inputs }
}

function shortName(registryName: string): string {
  return registryName.split('/').pop() ?? registryName
}

// ---- GitHub import ----

const README_NAMES = ['README.md', 'readme.md', 'README.mdx']
const CONFIG_NAMES = ['.mcp.json', 'mcp.json', '.cursor/mcp.json', 'claude_desktop_config.json']

export async function importGithub(input: string): Promise<GithubImportResult> {
  const parsed = parseRepoUrl(input)
  if (!parsed) throw new Error('That does not look like a GitHub repository URL.')
  const { owner, repo, subpath } = parsed
  const repoRes = await get(`${GITHUB_API}/repos/${owner}/${repo}`)
  const repoBody = (await repoRes.json()) as { description?: string; default_branch?: string }
  const branch = repoBody.default_branch || 'main'
  const sources: string[] = []
  const source: ServerDraft['source'] = { kind: 'github', ref: `${owner}/${repo}` }

  const installs: InstallOption[] = []
  const seen = new Set<string>()
  const add = (options: InstallOption[], from: string) => {
    if (!options.length) return
    sources.push(from)
    for (const option of options) {
      const key = JSON.stringify([option.config.command, option.config.args, option.config.url])
      if (seen.has(key)) continue
      seen.add(key)
      installs.push(option)
    }
  }

  for (const name of CONFIG_NAMES) {
    const text = await readRepoFile(owner, repo, branch, joinSub(subpath, name))
    if (text) add(parseConfigText(text, source), name)
  }
  for (const name of README_NAMES) {
    const text = await readRepoFile(owner, repo, branch, joinSub(subpath, name))
    if (text) add(configsFromMarkdown(text, source), name)
  }

  let plugin: GithubPluginProposal | undefined
  const treeRes = await get(`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, true)
  if (treeRes.ok) {
    const treeBody = (await treeRes.json()) as { tree?: Array<{ path: string; type: string }> }
    const prefix = subpath ? `${subpath.replace(/\/$/, '')}/` : ''
    const relPaths = (treeBody.tree ?? [])
      .filter((n) => n.type === 'blob' && (!prefix || n.path.startsWith(prefix)))
      .map((n) => (prefix ? n.path.slice(prefix.length) : n.path))
    const foundPlugin = await inspectGithubTreeForPlugin(input, relPaths, (rel) =>
      readRepoFile(owner, repo, branch, joinSub(subpath, rel)),
    )
    if (foundPlugin) {
      plugin = {
        ...foundPlugin,
        repoUrl: input.trim(),
      }
      if (!sources.includes('plugin')) sources.push('plugin')
    }
  }

  let warning: string | undefined
  if (!installs.length && !plugin) {
    warning = `No MCP server config was found in ${owner}/${repo}. You can still add it by hand under Connections.`
  }
  return { repo: `${owner}/${repo}`, description: repoBody.description, installs, sources, ...(plugin ? { plugin } : {}), warning }
}

function parseRepoUrl(input: string): { owner: string; repo: string; subpath?: string } | null {
  const text = input.trim().replace(/\.git$/, '')
  const match = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/(?:tree|blob)\/[^/]+\/(.+))?$/)
  if (!match) return null
  return { owner: match[1]!, repo: match[2]!, subpath: match[3] }
}

function joinSub(subpath: string | undefined, name: string): string {
  return subpath ? `${subpath.replace(/\/$/, '')}/${name}` : name
}

async function readRepoFile(owner: string, repo: string, branch: string, path: string): Promise<string | null> {
  const res = await get(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, true)
  if (!res || res.status === 404) return null
  const body = (await res.json()) as { content?: string; encoding?: string }
  if (!body.content || body.encoding !== 'base64') return null
  return Buffer.from(body.content, 'base64').toString('utf8')
}

async function get(url: string, allow404 = false, fetchImpl: typeof netFetch = netFetch): Promise<Response> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'atrium' },
    })
    if (allow404 && res.status === 404) return res
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        throw new Error('GitHub is limiting requests right now. Try again in a minute.')
      }
      throw new Error(`The request failed (${res.status}).`)
    }
    return res
  } catch (err) {
    if (err instanceof Error && /limiting requests|failed \(/.test(err.message)) throw err
    throw new Error(describeNetworkError(err, url))
  }
}

/** Re-exported so the core entry point has one place to import parsing from. */
export { optionFromEntry }

// ---- Atrium Curated Marketplace & Multi-Ecosystem Search Hub ----

const EXTERNAL_SEARCH_CACHE_TTL_MS = 120_000

function sanitizeMarketMessage(text: string): string {
  return text
    .replace(/https?:\/\/[a-z0-9.-]*rpulse\.top[^\s)"']*/gi, 'Atrium Cloud')
    .replace(/\b[a-z0-9.-]*rpulse\.top\b/gi, 'Atrium Cloud')
    .replace(/RelayPulse/gi, 'Atrium')
}

function classifyGithubRepoSource(
  repo: { full_name?: string; description?: string | null; topics?: string[] },
  requestedScope: MarketSearchScope,
): MarketExternalSource {
  if (requestedScope === 'claude' || requestedScope === 'chatgpt' || requestedScope === 'dsh') {
    return requestedScope
  }
  const text = [repo.full_name || '', repo.description || '', ...(repo.topics ?? [])].join(' ').toLowerCase()
  if (/\b(?:dsh|deepseek)\b/.test(text)) return 'dsh'
  if (/\b(?:claude|anthropic|claude-code|claude-plugin)\b/.test(text)) return 'claude'
  if (/\b(?:codex|chatgpt|openai|codex-plugin)\b/.test(text)) return 'chatgpt'
  return 'github'
}

function classifyRegistryItemSource(item: MarketItem, requestedScope: MarketSearchScope): MarketExternalSource {
  if (requestedScope === 'claude' || requestedScope === 'chatgpt') return requestedScope
  const text = `${item.name} ${item.title} ${item.description}`.toLowerCase()
  if (/\b(?:claude|anthropic)\b/.test(text)) return 'claude'
  if (/\b(?:chatgpt|openai|codex)\b/.test(text)) return 'chatgpt'
  return 'github'
}

function localOriginToExternalSource(origin: PluginCandidate['origin']): MarketExternalSource | null {
  if (origin === 'claude-code') return 'claude'
  if (origin === 'codex') return 'chatgpt'
  if (origin === 'dsh') return 'dsh'
  return null
}

function matchesLocalCandidate(cand: PluginCandidate, needle: string): boolean {
  const hay = [
    cand.name,
    cand.displayName || '',
    cand.description,
    cand.originLabel,
    ...cand.skillNames,
    ...cand.commandNames,
    ...cand.ruleFiles,
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(needle)
}

export interface MarketHubDeps {
  baseUrl?: string
  getAuthToken: () => Promise<string | null>
  getAccountState: () => RelayPulseAccountState
  getWorkspace?: () => string | undefined
  plugins: PluginManager
  fetchImpl?: typeof netFetch
}

export class MarketHub {
  private deps: MarketHubDeps
  private externalCache = new Map<string, { ts: number; hits: MarketExternalHit[]; warnings: string[] }>()

  constructor(deps: MarketHubDeps) {
    this.deps = deps
  }

  private baseOrigin(): string {
    return (this.deps.baseUrl || ATRIUM_MARKET_DEFAULT_ORIGIN).replace(/\/+$/, '')
  }

  private fetcher(): typeof netFetch {
    return this.deps.fetchImpl ?? netFetch
  }

  private async requestJson<T>(
    path: string,
    opts?: { method?: string; body?: unknown; requireAuth?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const token = await this.deps.getAuthToken().catch(() => null)
    if (opts?.requireAuth && !token) {
      throw new Error('请先登录 Atrium 账号后再执行此操作。')
    }
    const url = `${this.baseOrigin()}${path}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    if (opts?.body !== undefined) headers['content-type'] = 'application/json'

    let res: Response
    try {
      res = await this.fetcher()(url, {
        method: opts?.method ?? 'GET',
        headers,
        ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 20_000),
      })
    } catch (err) {
      throw new Error(sanitizeMarketMessage(describeNetworkError(err, url)))
    }

    const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string }
    if (!res.ok) {
      throw new Error(sanitizeMarketMessage(data.error || data.message || `市场服务请求失败 (${res.status})`))
    }
    return data
  }

  async catalog(): Promise<MarketCatalogResult> {
    try {
      const res = await this.requestJson<{ official?: MarketPluginListing[]; community?: MarketPluginListing[] }>(
        '/api/market/catalog',
      )
      return {
        official: Array.isArray(res.official) ? res.official : [],
        community: Array.isArray(res.community) ? res.community : [],
      }
    } catch (err) {
      return {
        official: [],
        community: [],
        offline: true,
        error: err instanceof Error ? err.message : sanitizeMarketMessage(String(err)),
      }
    }
  }

  async me(): Promise<MarketIdentity> {
    const acct = this.deps.getAccountState()
    const token = await this.deps.getAuthToken().catch(() => null)
    if (!token) {
      return {
        authenticated: false,
        email: acct.email,
        displayName: acct.displayName,
        avatar: acct.avatar ?? null,
        isCoContributor: false,
        isReviewer: false,
        pendingCount: 0,
      }
    }
    try {
      const res = await this.requestJson<MarketIdentity>('/api/market/me')
      return {
        authenticated: Boolean(res.authenticated),
        email: res.email ?? acct.email,
        displayName: res.displayName ?? acct.displayName,
        avatar: res.avatar ?? acct.avatar ?? null,
        isCoContributor: Boolean(res.isCoContributor),
        isReviewer: Boolean(res.isReviewer),
        pendingCount: Number(res.pendingCount ?? 0),
      }
    } catch {
      return {
        authenticated: Boolean(acct.connected),
        email: acct.email,
        displayName: acct.displayName,
        avatar: acct.avatar ?? null,
        isCoContributor: false,
        isReviewer: false,
        pendingCount: 0,
        offline: true,
      }
    }
  }

  async pluginDetail(id: string): Promise<MarketPluginDetail> {
    return this.requestJson<MarketPluginDetail>(`/api/market/plugins/${encodeURIComponent(id)}`)
  }

  async mySubmissions(): Promise<MarketPluginListing[]> {
    const res = await this.requestJson<{ items?: MarketPluginListing[] }>('/api/market/my-submissions', {
      requireAuth: true,
    })
    return Array.isArray(res.items) ? res.items : []
  }

  async reviewQueue(): Promise<MarketReviewQueueResult> {
    const res = await this.requestJson<Partial<MarketReviewQueueResult>>('/api/market/review/queue', {
      requireAuth: true,
    })
    return {
      pending: Array.isArray(res.pending) ? res.pending : [],
      approved: Array.isArray(res.approved) ? res.approved : [],
      rejected: Array.isArray(res.rejected) ? res.rejected : [],
    }
  }

  async submit(req: MarketSubmitRequest): Promise<MarketPluginListing> {
    const acct = this.deps.getAccountState()
    const payload = {
      ...req,
      authorDisplayName: acct.displayName || acct.email,
      authorAvatar: acct.avatar ?? null,
    }
    const res = await this.requestJson<{ plugin: MarketPluginListing }>('/api/market/plugins', {
      method: 'POST',
      body: payload,
      requireAuth: true,
    })
    return res.plugin
  }

  async reviewDecision(id: string, req: MarketReviewDecisionRequest): Promise<MarketPluginListing> {
    const res = await this.requestJson<{ plugin: MarketPluginListing }>(
      `/api/market/review/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        body: req,
        requireAuth: true,
      },
    )
    return res.plugin
  }

  async deleteSubmission(id: string): Promise<void> {
    await this.requestJson(`/api/market/plugins/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      requireAuth: true,
    })
  }

  async installPlugin(id: string): Promise<PluginImportResult> {
    const detail = await this.pluginDetail(id)
    const { plugin, files } = detail
    let res: PluginImportResult
    if (plugin.submissionKind === 'github' && plugin.repoUrl) {
      res = await this.deps.plugins.importGithub(plugin.repoUrl)
    } else if (files && files.length > 0) {
      res = await this.deps.plugins.installFromBundle({
        id: plugin.id,
        name: plugin.displayName || plugin.name,
        displayName: plugin.displayName,
        version: plugin.version,
        description: plugin.description,
        author: plugin.author.name,
        repository: plugin.repoUrl,
        files,
        sourceRef: `atrium-market:${plugin.id}`,
      })
    } else {
      throw new Error('This plugin listing does not contain installable files or a repository URL.')
    }
    void this.requestJson(`/api/market/plugins/${encodeURIComponent(id)}/install-ping`, {
      method: 'POST',
    }).catch(() => undefined)
    return res
  }

  async searchAll(query: string, scope: MarketSearchScope = 'all'): Promise<MarketUnifiedSearchResult> {
    const clean = query.trim()
    if (!clean) {
      return { query: '', scope, official: [], community: [], external: [], warnings: [] }
    }

    const warnings: string[] = []
    const catalogPromise: Promise<MarketCatalogResult> =
      scope === 'all' || scope === 'atrium'
        ? this.requestJson<{ official?: MarketPluginListing[]; community?: MarketPluginListing[] }>(
            `/api/market/catalog?q=${encodeURIComponent(clean)}`,
          )
            .then((r) => ({
              official: Array.isArray(r.official) ? r.official : [],
              community: Array.isArray(r.community) ? r.community : [],
            }))
            .catch((err) => {
              warnings.push(err instanceof Error ? err.message : sanitizeMarketMessage(String(err)))
              return { official: [], community: [] }
            })
        : Promise.resolve({ official: [], community: [] })

    const externalPromise: Promise<{ hits: MarketExternalHit[]; warnings: string[] }> =
      scope === 'atrium'
        ? Promise.resolve({ hits: [], warnings: [] })
        : this.searchExternalEcosystems(clean, scope)

    const [catalogRes, externalRes] = await Promise.all([catalogPromise, externalPromise])
    return {
      query: clean,
      scope,
      official: catalogRes.official,
      community: catalogRes.community,
      external: externalRes.hits,
      warnings: [...warnings, ...externalRes.warnings],
    }
  }

  private async searchExternalEcosystems(
    query: string,
    scope: MarketSearchScope,
  ): Promise<{ hits: MarketExternalHit[]; warnings: string[] }> {
    const needle = query.toLowerCase()
    const cacheKey = `${scope}::${needle}`
    const cached = this.externalCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < EXTERNAL_SEARCH_CACHE_TTL_MS) {
      return { hits: cached.hits, warnings: cached.warnings }
    }

    const warnings: string[] = []
    const hits: MarketExternalHit[] = []
    const seenIds = new Set<string>()
    const pushHit = (hit: MarketExternalHit) => {
      if (seenIds.has(hit.id)) return
      seenIds.add(hit.id)
      hits.push(hit)
    }

    // 1. Local installed/cached plugins from Claude Code, Codex (ChatGPT), and DeepSeek Harness (DSH)
    if (scope === 'all' || scope === 'claude' || scope === 'chatgpt' || scope === 'dsh') {
      try {
        const localCandidates = await this.deps.plugins.discoverLocal(this.deps.getWorkspace?.())
        for (const cand of localCandidates) {
          const src = localOriginToExternalSource(cand.origin)
          if (!src) continue
          if (scope !== 'all' && scope !== src) continue
          if (!matchesLocalCandidate(cand, needle)) continue
          pushHit({
            id: `local:${cand.key}`,
            source: src,
            originKind: 'local',
            name: cand.displayName || cand.name,
            title: `${cand.originLabel} · ${cand.name}`,
            description: cand.description,
            version: cand.version,
            authorName: cand.author,
            localSourcePath: cand.sourcePath,
            alreadyImported: cand.alreadyImported,
            skillNames: cand.skillNames,
            commandNames: cand.commandNames,
            ruleFiles: cand.ruleFiles,
            mcpCount: cand.mcpProposals.length,
          })
        }
      } catch {
        /* ignore local discovery warnings */
      }
    }

    // 2. GitHub Search API (GitHub / Claude / ChatGPT(Codex) / DSH plugins & skills)
    const ghPromise = (async () => {
      let qStr = `${query} (mcp OR claude-plugin OR codex-plugin OR deepseek OR skill)`
      if (scope === 'claude') qStr = `${query} ("claude-plugin" OR "claude-code" OR ".claude-plugin" OR anthropic)`
      else if (scope === 'chatgpt') qStr = `${query} ("codex-plugin" OR "chatgpt-plugin" OR openai OR codex)`
      else if (scope === 'dsh') qStr = `${query} (deepseek OR dsh) (plugin OR mcp OR skill)`

      try {
        const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(qStr)}&per_page=10&sort=stars`
        const res = await this.fetcher()(url, {
          headers: { accept: 'application/json', 'user-agent': 'atrium' },
          signal: AbortSignal.timeout(12_000),
        })
        if (!res.ok) {
          if (res.status === 403 || res.status === 429) {
            warnings.push('GitHub 搜索请求触发频率限制，请稍后重试。')
          }
          return
        }
        const json = (await res.json()) as {
          items?: Array<{
            id: number
            name: string
            full_name: string
            description?: string | null
            html_url: string
            stargazers_count?: number
            topics?: string[]
            owner?: { login?: string; avatar_url?: string }
          }>
        }
        for (const repo of json.items ?? []) {
          const source = classifyGithubRepoSource(repo, scope)
          if (scope !== 'all' && scope !== source) continue
          pushHit({
            id: `github:${repo.full_name}`,
            source,
            originKind: 'github',
            name: repo.name,
            title: repo.full_name,
            description: repo.description || '',
            authorName: repo.owner?.login,
            authorAvatar: repo.owner?.avatar_url ?? null,
            stars: repo.stargazers_count ?? 0,
            repositoryUrl: repo.html_url,
          })
        }
      } catch {
        warnings.push('GitHub 仓库搜索暂时不可用，已返回其他来源结果。')
      }
    })()

    // 3. Official MCP Registry search (compatible with Claude / ChatGPT / GitHub clients)
    const regPromise =
      scope === 'dsh'
        ? Promise.resolve()
        : searchRegistry(query, undefined, this.fetcher())
            .then((reg) => {
              for (const item of reg.items.slice(0, 8)) {
                const source = classifyRegistryItemSource(item, scope)
                if (scope !== 'all' && scope !== source) continue
                pushHit({
                  id: `registry:${item.id}`,
                  source,
                  originKind: 'registry',
                  name: item.name,
                  title: item.title,
                  description: item.description,
                  version: item.version,
                  repositoryUrl: item.repositoryUrl,
                  installs: item.installs,
                  mcpCount: 1,
                })
              }
            })
            .catch(() => {
              warnings.push('MCP 官方注册表搜索暂时不可用。')
            })

    await Promise.all([ghPromise, regPromise])

    this.externalCache.set(cacheKey, { ts: Date.now(), hits, warnings })
    if (this.externalCache.size > 40) {
      const oldest = this.externalCache.keys().next().value
      if (oldest) this.externalCache.delete(oldest)
    }
    return { hits, warnings }
  }
}
