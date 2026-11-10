// The official MCP registry (registry.modelcontextprotocol.io) plus GitHub
// import. GitHub import reads files over the API; it never clones or runs
// anything. The user reviews every proposal before it is saved.
import type { GithubImportResult, GithubPluginProposal, InstallOption, MarketItem, MarketSearchResult, McpServerConfig } from '../shared/types.ts'
import { describeNetworkError, netFetch } from './net.ts'
import { configsFromMarkdown, optionFromEntry, parseConfigText } from './mcp/parse.ts'
import { inspectGithubTreeForPlugin } from './plugins.ts'

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

export async function searchRegistry(query: string, cursor?: string): Promise<MarketSearchResult> {
  const url = new URL(REGISTRY)
  if (query.trim()) url.searchParams.set('search', query.trim())
  url.searchParams.set('limit', '20')
  url.searchParams.set('version', 'latest')
  if (cursor) url.searchParams.set('cursor', cursor)
  const res = await get(url.href)
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

async function get(url: string, allow404 = false): Promise<Response> {
  try {
    const res = await netFetch(url, {
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
