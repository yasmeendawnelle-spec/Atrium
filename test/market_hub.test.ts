import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleMarketRequest, type MarketObjectStore } from '../deploy/market-worker/src/handler.js'
import { MarketHub } from '../src/core/market.ts'
import { PluginManager, type PluginMcpAdapter } from '../src/core/plugins.ts'
import type { McpServerConfig, RelayPulseAccountState } from '../src/shared/types.ts'

function createKvMockStore(): MarketObjectStore {
  const map = new Map<string, unknown>()
  return {
    async getJson(key: string) {
      return map.has(key) ? structuredClone(map.get(key)) : null
    },
    async putJson(key: string, value: unknown) {
      map.set(key, structuredClone(value))
    },
    async delete(key: string) {
      map.delete(key)
    },
  }
}

function makeMockMcpAdapter(): PluginMcpAdapter {
  const servers: McpServerConfig[] = []
  return {
    list: () => [...servers],
    save: async (draft) => {
      const id = draft.id || `mcp_${servers.length + 1}`
      const saved: McpServerConfig = {
        ...draft,
        id,
        enabled: draft.enabled !== false,
      }
      const idx = servers.findIndex((s) => s.id === id)
      if (idx >= 0) servers[idx] = saved
      else servers.push(saved)
      return saved
    },
    remove: async (id) => {
      const idx = servers.findIndex((s) => s.id === id)
      if (idx >= 0) servers.splice(idx, 1)
    },
    setEnabled: async (id, enabled) => {
      const item = servers.find((s) => s.id === id)
      if (item) item.enabled = enabled
    },
  }
}

function makeMockAuthFetch(usersByToken: Record<string, { email: string; display_name: string; avatar: string | null }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/api/user/profile')) {
      const headers = new Headers(init?.headers)
      const auth = headers.get('authorization') || ''
      const token = auth.replace(/^Bearer\s+/i, '').trim()
      const user = usersByToken[token]
      if (!user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      return new Response(JSON.stringify({ user }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as typeof fetch
}

test('Cloudflare Worker market handler enforces Official Co-contributor publishing, community review queue, and security checks', async () => {
  const store = createKvMockStore()
  const authFetch = makeMockAuthFetch({
    'tok-co': {
      email: 'alice@gmail.com',
      display_name: 'Alice Co',
      avatar: 'https://avatars.example.com/alice.png',
    },
    'tok-user': {
      email: 'bob@outlook.com',
      display_name: 'Bob Builder',
      avatar: 'https://avatars.example.com/bob.png',
    },
    'tok-other': {
      email: 'eve@qq.com',
      display_name: 'Eve',
      avatar: null,
    },
  })
  const opts = {
    authOrigin: 'https://auth.example.com',
    coContributorEmails: 'alice@gmail.com',
    fetchImpl: authFetch,
  }

  // 1. Regular user cannot publish directly to Official Plugins
  const blockedOfficial = await handleMarketRequest(
    new Request('https://market.example.com/api/market/plugins', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-user', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Sneaky Official',
        description: 'Attempt official section',
        submissionKind: 'github',
        repoUrl: 'https://github.com/bob/sneaky',
        targetSection: 'official',
      }),
    }),
    store,
    opts,
  )
  assert.equal(blockedOfficial.status, 403)

  // 2. Co-contributor publishes directly to Official section with avatar preserved
  const officialRes = await handleMarketRequest(
    new Request('https://market.example.com/api/market/plugins', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-co', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Official Helper',
        version: '1.2.0',
        description: 'Verified official workflow bundle',
        submissionKind: 'bundle',
        targetSection: 'official',
        files: [
          { path: 'plugin.json', content: JSON.stringify({ name: 'Official Helper' }), encoding: 'utf8', size: 28 },
          { path: 'skills/helper/SKILL.md', content: '---\nname: helper\ndescription: Helps cleanly\n---\nBody', encoding: 'utf8', size: 60 },
        ],
      }),
    }),
    store,
    opts,
  )
  assert.equal(officialRes.status, 201)
  const officialJson = (await officialRes.json()) as { plugin: { id: string; status: string; section: string; author: { avatar: string; role: string } } }
  assert.equal(officialJson.plugin.status, 'approved')
  assert.equal(officialJson.plugin.section, 'official')
  assert.equal(officialJson.plugin.author.avatar, 'https://avatars.example.com/alice.png')
  assert.equal(officialJson.plugin.author.role, 'co-contributor')

  // 3. Regular user uploads custom bundle -> goes to pending queue, invisible in public catalog
  const traversalAttempt = await handleMarketRequest(
    new Request('https://market.example.com/api/market/plugins', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-user', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Path Plugin',
        description: 'bad path',
        submissionKind: 'bundle',
        files: [{ path: '../etc/passwd', content: 'x', encoding: 'utf8', size: 1 }],
      }),
    }),
    store,
    opts,
  )
  assert.equal(traversalAttempt.status, 400)

  const submitRes = await handleMarketRequest(
    new Request('https://market.example.com/api/market/plugins', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-user', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Community Formatter',
        version: '0.9.0',
        description: 'Formats code cleanly',
        tags: ['format', 'code'],
        submissionKind: 'bundle',
        files: [
          { path: 'plugin.json', content: JSON.stringify({ name: 'Community Formatter' }), encoding: 'utf8', size: 32 },
          { path: 'commands/fmt.md', content: '# Format', encoding: 'utf8', size: 8 },
        ],
      }),
    }),
    store,
    opts,
  )
  assert.equal(submitRes.status, 201)
  const submitJson = (await submitRes.json()) as { plugin: { id: string; status: string; section: string } }
  assert.equal(submitJson.plugin.status, 'pending')
  assert.equal(submitJson.plugin.section, 'community')

  // Public catalog shows official only while community item is pending
  const catBefore = (await (await handleMarketRequest(new Request('https://market.example.com/api/market/catalog'), store, opts)).json()) as {
    official: Array<{ id: string }>
    community: Array<{ id: string }>
  }
  assert.equal(catBefore.official.length, 1)
  assert.equal(catBefore.community.length, 0)

  // Non-reviewer cannot inspect pending detail or access review queue
  const queueDenied = await handleMarketRequest(
    new Request('https://market.example.com/api/market/review/queue', {
      headers: { authorization: 'Bearer tok-other' },
    }),
    store,
    opts,
  )
  assert.equal(queueDenied.status, 403)

  // Reviewer approves community submission -> now visible in catalog.community
  const queueOk = (await (
    await handleMarketRequest(
      new Request('https://market.example.com/api/market/review/queue', {
        headers: { authorization: 'Bearer tok-co' },
      }),
      store,
      opts,
    )
  ).json()) as { pending: Array<{ id: string }> }
  assert.equal(queueOk.pending.length, 1)

  const approveRes = await handleMarketRequest(
    new Request(`https://market.example.com/api/market/review/${submitJson.plugin.id}`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-co', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', note: 'Safe and helpful!' }),
    }),
    store,
    opts,
  )
  assert.equal(approveRes.status, 200)

  const catAfter = (await (await handleMarketRequest(new Request('https://market.example.com/api/market/catalog'), store, opts)).json()) as {
    official: Array<{ id: string }>
    community: Array<{ id: string }>
  }
  assert.equal(catAfter.official.length, 1)
  assert.equal(catAfter.community.length, 1)
  assert.equal(catAfter.community[0]?.id, submitJson.plugin.id)

  // Author can inspect their submission list and delete it
  const myRes = (await (
    await handleMarketRequest(
      new Request('https://market.example.com/api/market/my-submissions', {
        headers: { authorization: 'Bearer tok-user' },
      }),
      store,
      opts,
    )
  ).json()) as { items: Array<{ id: string; status: string; reviewNote?: string }> }
  assert.equal(myRes.items.length, 1)
  assert.equal(myRes.items[0]?.status, 'approved')
  assert.equal(myRes.items[0]?.reviewNote, 'Safe and helpful!')
})

test('PluginManager discovers DSH plugins/skills, packs local plugin folders, and installs Marketplace bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-market-plugs-'))
  const prevDsh = process.env.DSH_HOME
  try {
    const appDir = join(root, 'app')
    const homeDir = join(root, 'home')
    const dshHome = join(homeDir, '.dsh')
    process.env.DSH_HOME = dshHome

    await mkdir(join(dshHome, 'skills', 'dsh-coder'), { recursive: true })
    await writeFile(
      join(dshHome, 'skills', 'dsh-coder', 'SKILL.md'),
      '---\nname: dsh-coder\ndescription: DSH coding workflow\n---\nInstructions',
      'utf8',
    )

    const customPluginDir = join(root, 'my-custom-plugin')
    await mkdir(join(customPluginDir, 'skills', 'reviewer'), { recursive: true })
    await writeFile(
      join(customPluginDir, 'plugin.json'),
      JSON.stringify({ name: 'custom-reviewer', version: '1.0.5', description: 'Reviews code diffs' }),
      'utf8',
    )
    await writeFile(
      join(customPluginDir, 'skills', 'reviewer', 'SKILL.md'),
      '---\nname: reviewer\ndescription: Diff reviewer\n---\nCheck bugs',
      'utf8',
    )

    const manager = new PluginManager({ dir: appDir, homeDir, mcp: makeMockMcpAdapter() })
    await manager.load()

    // 1. DSH discovery
    const local = await manager.discoverLocal()
    const dshHit = local.find((c) => c.origin === 'dsh' && c.name === 'dsh-coder')
    assert.ok(dshHit, 'Expected ~/.dsh/skills/dsh-coder to be discovered with origin dsh')

    // 2. Pack local folder + install from bundle
    const packed = await manager.packLocalFolder(customPluginDir)
    assert.equal(packed.name, 'custom-reviewer')
    assert.equal(packed.version, '1.0.5')
    assert.ok(packed.skillNames.includes('reviewer'))
    assert.ok(packed.files.some((f) => f.path === 'plugin.json'))

    const imported = await manager.installFromBundle({
      id: 'custom-reviewer-market',
      name: packed.name,
      version: packed.version,
      description: packed.description,
      author: 'Tester',
      files: packed.files,
      sourceRef: 'atrium-market:custom-reviewer-market',
    })
    assert.equal(imported.installed.length, 1)
    assert.equal(imported.installed[0]?.origin, 'atrium')
    assert.deepEqual(imported.installed[0]?.skillNames, ['reviewer'])
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    await rm(root, { recursive: true, force: true })
  }
})

test('MarketHub keeps external plugins out of default catalog and searches GitHub, Claude, ChatGPT, and DSH on demand', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atrium-markethub-test-'))
  const prevDsh = process.env.DSH_HOME
  try {
    const appDir = join(root, 'app')
    const homeDir = join(root, 'home')
    const dshHome = join(homeDir, '.dsh')
    process.env.DSH_HOME = dshHome

    // Create local Claude Code, Codex (ChatGPT), and DSH items
    await mkdir(join(homeDir, '.claude', 'plugins', 'cache', 'mkt', 'claude-linter', '1.0.0', 'skills', 'lint'), { recursive: true })
    await writeFile(
      join(homeDir, '.claude', 'plugins', 'cache', 'mkt', 'claude-linter', '1.0.0', 'plugin.json'),
      JSON.stringify({ name: 'claude-linter', description: 'Claude linter helper' }),
      'utf8',
    )
    await mkdir(join(homeDir, '.codex', 'plugins', 'cache', 'mkt', 'codex-helper', '1.0.0', 'skills', 'code'), { recursive: true })
    await writeFile(
      join(homeDir, '.codex', 'plugins', 'cache', 'mkt', 'codex-helper', '1.0.0', 'plugin.json'),
      JSON.stringify({ name: 'codex-helper', description: 'ChatGPT Codex linter' }),
      'utf8',
    )
    await mkdir(join(dshHome, 'skills', 'dsh-linter'), { recursive: true })
    await writeFile(
      join(dshHome, 'skills', 'dsh-linter', 'SKILL.md'),
      '---\nname: dsh-linter\ndescription: DSH linter skill\n---\nRun lint',
      'utf8',
    )

    const kv = createKvMockStore()
    const workerFetch = makeMockAuthFetch({
      'tok-co': { email: 'alice@gmail.com', display_name: 'Alice', avatar: 'https://img/alice.png' },
    })

    const manager = new PluginManager({ dir: appDir, homeDir, mcp: makeMockMcpAdapter() })
    await manager.load()

    const acct: RelayPulseAccountState = {
      origin: 'https://api.example.com',
      connected: true,
      email: 'alice@gmail.com',
      displayName: 'Alice',
      avatar: 'https://img/alice.png',
    }

    const hubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith('https://market.example.com/')) {
        return handleMarketRequest(new Request(url, init), kv, {
          authOrigin: 'https://auth.example.com',
          coContributorEmails: 'alice@gmail.com',
          fetchImpl: workerFetch,
        })
      }
      if (url.startsWith('https://api.github.com/search/repositories')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 101,
                name: 'gh-linter-mcp',
                full_name: 'acme/gh-linter-mcp',
                description: 'Generic GitHub MCP server for linting',
                html_url: 'https://github.com/acme/gh-linter-mcp',
                stargazers_count: 42,
                topics: ['mcp'],
                owner: { login: 'acme', avatar_url: 'https://img/acme.png' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url.startsWith('https://registry.modelcontextprotocol.io/')) {
        return new Response(JSON.stringify({ servers: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch

    const hub = new MarketHub({
      baseUrl: 'https://market.example.com',
      getAuthToken: async () => 'tok-co',
      getAccountState: () => acct,
      plugins: manager,
      fetchImpl: hubFetch as never,
    })

    await hub.submit({
      name: 'Atrium Official Linter',
      description: 'Official Atrium plugin for code linting',
      submissionKind: 'bundle',
      targetSection: 'official',
      files: [{ path: 'plugin.json', content: '{"name":"Atrium Official Linter"}', encoding: 'utf8', size: 32 }],
    })

    const cat = await hub.catalog()
    assert.equal(cat.official.length, 1)
    assert.equal(cat.community.length, 0)
    assert.equal(cat.official[0]?.author.avatar, 'https://img/alice.png')

    // Empty query searchAll returns zero external results
    const emptySearch = await hub.searchAll('', 'all')
    assert.equal(emptySearch.external.length, 0)

    // Searching 'linter' discovers Atrium Official + GitHub + local Claude + ChatGPT(Codex) + DSH
    const searchRes = await hub.searchAll('linter', 'all')
    assert.equal(searchRes.official.length, 1)
    const sources = new Set(searchRes.external.map((e) => e.source))
    assert.ok(sources.has('claude'))
    assert.ok(sources.has('chatgpt'))
    assert.ok(sources.has('dsh'))
    assert.ok(sources.has('github'))

    // Brand hygiene check in features.ts
    const featuresSrc = await readFile(
      fileURLToPath(new URL('../src/renderer/src/locales/features.ts', import.meta.url)),
      'utf8',
    )
    assert.equal(/rpulse\.top|RelayPulse/i.test(featuresSrc), false)
  } finally {
    if (prevDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevDsh
    await rm(root, { recursive: true, force: true })
  }
})

test('Cloudflare Worker automatically recognizes GitHub Atrium contributors, caches list in KV, and falls back to GitHub avatar', async () => {
  const store = createKvMockStore()
  let contributorsFetchCount = 0
  let clock = 1_700_000_000_000

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === 'https://api.github.com/repos/yasmeendawnelle-spec/Atrium/contributors?per_page=100') {
      contributorsFetchCount++
      return new Response(
        JSON.stringify([
          { login: 'yasmeendawnelle-spec', avatar_url: 'https://avatars.githubusercontent.com/u/358171577?v=4' },
          { login: 'Reimu-miu', avatar_url: 'https://avatars.githubusercontent.com/u/276154778?v=4' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.endsWith('/api/user/profile')) {
      const token = (new Headers(init?.headers).get('authorization') || '').replace(/^Bearer\s+/i, '').trim()
      if (token === 'tok-gh-contrib') {
        return new Response(
          JSON.stringify({
            user: {
              email: 'reimu@oauth.rpulse.local',
              oauth_provider: 'github',
              oauth_username: 'Reimu-miu',
              display_name: 'Reimu',
              avatar: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (token === 'tok-gh-stranger') {
        return new Response(
          JSON.stringify({
            user: {
              email: 'stranger@oauth.rpulse.local',
              oauth_provider: 'github',
              oauth_username: 'random-stranger',
              display_name: 'Stranger',
              avatar: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const opts = {
    authOrigin: 'https://auth.example.com',
    githubRepo: 'yasmeendawnelle-spec/Atrium',
    coContributorEmails: '',
    fetchImpl,
    now: () => clock,
  }

  // 1. Contributor signed in with GitHub OAuth is recognized & gets GitHub avatar fallback
  const meContribRes = await handleMarketRequest(
    new Request('https://market.example.com/api/market/me', {
      headers: { authorization: 'Bearer tok-gh-contrib' },
    }),
    store,
    opts,
  )
  assert.equal(meContribRes.status, 200)
  const meContrib = (await meContribRes.json()) as {
    isCoContributor: boolean
    isReviewer: boolean
    avatar: string | null
    githubLogin?: string
  }
  assert.equal(meContrib.isCoContributor, true)
  assert.equal(meContrib.isReviewer, true)
  assert.equal(meContrib.githubLogin, 'reimu-miu')
  assert.equal(meContrib.avatar, 'https://avatars.githubusercontent.com/u/276154778?v=4')
  assert.equal(contributorsFetchCount, 1)

  // 2. Contributor can publish directly to Official Plugins and uses GitHub avatar as plugin icon
  const pubRes = await handleMarketRequest(
    new Request('https://market.example.com/api/market/plugins', {
      method: 'POST',
      headers: { authorization: 'Bearer tok-gh-contrib', 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'GitHub Contributor Official Plugin',
        description: 'Official plugin published by repo contributor',
        submissionKind: 'bundle',
        targetSection: 'official',
        files: [{ path: 'plugin.json', content: '{"name":"gh-contrib"}', encoding: 'utf8', size: 22 }],
      }),
    }),
    store,
    opts,
  )
  assert.equal(pubRes.status, 201)
  const pubJson = (await pubRes.json()) as { plugin: { section: string; status: string; author: { avatar: string } } }
  assert.equal(pubJson.plugin.section, 'official')
  assert.equal(pubJson.plugin.status, 'approved')
  assert.equal(pubJson.plugin.author.avatar, 'https://avatars.githubusercontent.com/u/276154778?v=4')
  // Second check within 10-minute TTL hits KV cache cleanly
  assert.equal(contributorsFetchCount, 1)

  // 3. Non-contributor GitHub OAuth user does NOT get Official / Reviewer access
  const meStrangerRes = await handleMarketRequest(
    new Request('https://market.example.com/api/market/me', {
      headers: { authorization: 'Bearer tok-gh-stranger' },
    }),
    store,
    opts,
  )
  const meStranger = (await meStrangerRes.json()) as { isCoContributor: boolean; isReviewer: boolean }
  assert.equal(meStranger.isCoContributor, false)
  assert.equal(meStranger.isReviewer, false)
})
