const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
}

const CATALOG_KEY = 'catalog:index'
const GITHUB_CONTRIBUTORS_CACHE_KEY = 'cache:github-contributors'
const CONTRIBUTORS_CACHE_TTL_MS = 10 * 60 * 1000
const MAX_BUNDLE_FILES = 100
const MAX_SINGLE_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BUNDLE_BYTES = 2 * 1024 * 1024
const MAX_AVATAR_CHARS = 200_000
const PLUGIN_MANIFEST_SET = new Set([
  'plugin.json',
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
])
const MCP_FILE_SET = new Set(['.mcp.json', 'mcp.json', 'mcp_config.json'])

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  })
}

export function parseEmailSet(raw) {
  const out = new Set()
  if (!raw || typeof raw !== 'string') return out
  for (const part of raw.split(/[\s,;]+/)) {
    const clean = part.trim().toLowerCase()
    if (clean) out.add(clean)
  }
  return out
}

export function sanitizeBundlePath(rawPath) {
  if (typeof rawPath !== 'string') return null
  if (rawPath.includes('\0')) return null
  const normalized = rawPath.replace(/\\/g, '/').trim()
  if (!normalized || normalized.length > 240) return null
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return null
  for (const seg of parts) {
    if (seg === '.' || seg === '..') return null
    if (seg === '.git' || seg === 'node_modules' || seg === '__pycache__' || seg === '.venv') return null
  }
  return parts.join('/')
}

export function validateAvatar(raw) {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  const clean = raw.trim()
  if (!clean || clean.length > MAX_AVATAR_CHARS) return null
  if (/^https?:\/\/[^\s"'<>]+$/i.test(clean)) return clean
  if (/^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(clean)) {
    return clean
  }
  return null
}

function slugify(raw) {
  const clean = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return clean || 'plugin'
}

export function summarizeBundleFiles(files) {
  const skillSet = new Set()
  const cmdSet = new Set()
  const ruleFiles = []
  let mcpCount = 0
  let hasHooks = false
  let hasScripts = false
  let hasTheme = false
  let hasBootAnimation = false
  let totalBytes = 0

  for (const file of files) {
    const p = file.path
    const lower = p.toLowerCase()
    totalBytes += Number(file.size) || 0

    if (lower === 'skill.md') {
      skillSet.add('default')
    } else {
      const mSkill = /^skills\/([^/]+)\/skill\.md$/i.exec(p)
      if (mSkill) skillSet.add(mSkill[1])
    }

    const mCmd = /^commands\/([^/]+)\.md$/i.exec(p)
    if (mCmd) cmdSet.add(slugify(mCmd[1]))

    if (/^rules\/.+\.md$/i.test(p)) ruleFiles.push(p)

    if (lower === 'hooks/hooks.json') hasHooks = true

    if (lower === 'theme/theme.css') hasTheme = true
    if (lower === 'theme/boot.json') {
      hasTheme = true
      hasBootAnimation = true
    }

    if (
      /^scripts\//i.test(p) ||
      /\.(?:sh|bash|ps1|py|js|mjs|cjs|ts)$/i.test(lower)
    ) {
      hasScripts = true
    }

    if (MCP_FILE_SET.has(lower) && file.encoding === 'utf8') {
      try {
        const parsed = JSON.parse(file.content)
        if (parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers) {
          mcpCount += Object.keys(parsed.mcpServers).length
        }
      } catch {
        /* ignore invalid json */
      }
    }

    if (PLUGIN_MANIFEST_SET.has(lower) && file.encoding === 'utf8') {
      try {
        const manifest = JSON.parse(file.content)
        if (manifest?.hooks) hasHooks = true
        if (manifest?.theme && typeof manifest.theme === 'object') {
          hasTheme = true
          if (manifest.theme.bootFile) hasBootAnimation = true
        }
        if (manifest?.mcpServers && typeof manifest.mcpServers === 'object') {
          mcpCount += Object.keys(manifest.mcpServers).length
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    skillNames: Array.from(skillSet),
    commandNames: Array.from(cmdSet),
    ruleFiles,
    mcpCount,
    hasHooks,
    hasScripts,
    hasTheme,
    hasBootAnimation,
    fileCount: files.length,
    totalBytes,
  }
}

function hasRecognizablePluginContent(files) {
  return files.some((f) => {
    const lower = f.path.toLowerCase()
    return (
      PLUGIN_MANIFEST_SET.has(lower) ||
      MCP_FILE_SET.has(lower) ||
      lower === 'skill.md' ||
      /^skills\/[^/]+\/skill\.md$/i.test(f.path) ||
      /^commands\/[^/]+\.md$/i.test(f.path) ||
      /^rules\/.+\.md$/i.test(f.path) ||
      /^theme\/(?:theme\.css|boot\.json)$/i.test(f.path)
    )
  })
}

export function extractGithubLoginFromProfile(user) {
  if (!user || typeof user !== 'object') return null
  const oauthProvider = typeof user.oauth_provider === 'string' ? user.oauth_provider.trim().toLowerCase() : ''
  const oauthUsername = typeof user.oauth_username === 'string' ? user.oauth_username.trim().toLowerCase() : ''
  if (oauthProvider === 'github' && oauthUsername) return oauthUsername
  const explicit =
    typeof user.github_username === 'string'
      ? user.github_username.trim().toLowerCase()
      : typeof user.github_login === 'string'
        ? user.github_login.trim().toLowerCase()
        : ''
  if (explicit) return explicit
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
  const noreplyMatch = /^(?:\d+\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email)
  if (noreplyMatch) return noreplyMatch[1].toLowerCase()
  return null
}

async function loadGithubContributors(store, opts = {}) {
  const githubRepo = typeof opts.githubRepo === 'string' ? opts.githubRepo.trim() : ''
  const result = new Map()
  if (!githubRepo) return result

  const owner = githubRepo.split('/')[0]?.trim().toLowerCase()
  if (owner) result.set(owner, { login: owner, avatar: null })

  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const now = nowFn()
  let cached = null
  try {
    cached = await store.getJson(GITHUB_CONTRIBUTORS_CACHE_KEY)
  } catch {
    cached = null
  }

  if (
    cached &&
    cached.repo === githubRepo &&
    Array.isArray(cached.contributors) &&
    typeof cached.fetchedAt === 'number' &&
    now - cached.fetchedAt < CONTRIBUTORS_CACHE_TTL_MS
  ) {
    for (const c of cached.contributors) {
      if (c?.login) result.set(String(c.login).toLowerCase(), { login: c.login, avatar: c.avatar || null })
    }
    return result
  }

  const fetcher = opts.fetchImpl || fetch
  try {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'atrium-market',
    }
    if (opts.githubToken) {
      headers.authorization = `Bearer ${opts.githubToken}`
    }
    const res = await fetcher(`https://api.github.com/repos/${githubRepo}/contributors?per_page=100`, {
      method: 'GET',
      headers,
    })
    if (res.ok) {
      const list = await res.json().catch(() => null)
      if (Array.isArray(list)) {
        const normalized = []
        for (const entry of list) {
          const login = typeof entry?.login === 'string' ? entry.login.trim() : ''
          if (!login) continue
          const avatar = validateAvatar(entry?.avatar_url)
          normalized.push({ login, avatar })
          result.set(login.toLowerCase(), { login, avatar })
        }
        await store
          .putJson(GITHUB_CONTRIBUTORS_CACHE_KEY, {
            repo: githubRepo,
            fetchedAt: now,
            contributors: normalized,
          })
          .catch(() => undefined)
        return result
      }
    }
  } catch {
    /* fall through to stale cache + owner */
  }

  if (cached && cached.repo === githubRepo && Array.isArray(cached.contributors)) {
    for (const c of cached.contributors) {
      if (c?.login) result.set(String(c.login).toLowerCase(), { login: c.login, avatar: c.avatar || null })
    }
  }
  return result
}

async function verifyUser(request, store, opts) {
  const auth = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (!match) return null
  const token = match[1].trim()
  if (!token) return null

  const authOrigin = String(opts.authOrigin || 'https://api.rpulse.top').replace(/\/+$/, '')
  const fetcher = opts.fetchImpl || fetch
  try {
    const res = await fetcher(`${authOrigin}/api/user/profile`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    const user = body?.user ?? body
    const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : ''
    if (!email) return null

    const coContributors = parseEmailSet(opts.coContributorEmails)
    const reviewers = parseEmailSet(opts.reviewerEmails)
    const extraLogins = parseEmailSet(opts.coContributorGithubLogins)
    const githubLogin = extractGithubLoginFromProfile(user)
    const ghContributors = githubLogin ? await loadGithubContributors(store, opts) : new Map()
    const matchedGh = githubLogin
      ? (ghContributors.get(githubLogin) ?? (extraLogins.has(githubLogin) ? { login: githubLogin, avatar: null } : null))
      : null

    const isCoContributor = coContributors.has(email) || Boolean(matchedGh)
    const isReviewer = isCoContributor || reviewers.has(email)
    const displayName = String(user.display_name || user.oauth_username || email).trim().slice(0, 64)
    const avatar = validateAvatar(user.avatar) ?? validateAvatar(matchedGh?.avatar) ?? null
    return { email, displayName, avatar, githubLogin, isCoContributor, isReviewer }
  } catch {
    return null
  }
}

async function loadCatalog(store) {
  const raw = await store.getJson(CATALOG_KEY)
  return Array.isArray(raw) ? raw : []
}

async function saveCatalog(store, list) {
  await store.putJson(CATALOG_KEY, list)
}

function sortNewestFirst(items) {
  return [...items].sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
}

function matchesQuery(item, q) {
  if (!q) return true
  const hay = [
    item.name,
    item.displayName || '',
    item.description || '',
    item.author?.name || '',
    ...(Array.isArray(item.tags) ? item.tags : []),
    ...(Array.isArray(item.skillNames) ? item.skillNames : []),
    ...(Array.isArray(item.commandNames) ? item.commandNames : []),
  ]
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
}

function isValidGithubUrl(raw) {
  if (typeof raw !== 'string') return false
  return /^https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+/i.test(raw.trim())
}

function sanitizeTags(rawTags) {
  if (!Array.isArray(rawTags)) return []
  const seen = new Set()
  const out = []
  for (const tag of rawTags) {
    if (typeof tag !== 'string') continue
    const clean = tag.trim().slice(0, 32)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= 8) break
  }
  return out
}

export async function handleMarketRequest(request, store, opts = {}) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (!store) {
    return jsonResponse({ error: 'Marketplace KV storage is not configured.' }, 503)
  }

  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now()

  if (request.method === 'GET' && path === '/healthz') {
    const [items, ghContributors] = await Promise.all([
      loadCatalog(store),
      loadGithubContributors(store, opts),
    ])
    return jsonResponse({
      ok: true,
      githubRepo: typeof opts.githubRepo === 'string' && opts.githubRepo.trim() ? opts.githubRepo.trim() : null,
      contributorCount: ghContributors.size,
      officialCount: items.filter((i) => i.status === 'approved' && i.section === 'official').length,
      communityCount: items.filter((i) => i.status === 'approved' && i.section !== 'official').length,
      pendingCount: items.filter((i) => i.status === 'pending').length,
    })
  }

  if (request.method === 'GET' && path === '/api/market/me') {
    const user = await verifyUser(request, store, opts)
    if (!user) {
      return jsonResponse({
        authenticated: false,
        isCoContributor: false,
        isReviewer: false,
        pendingCount: 0,
      })
    }
    let pendingCount = 0
    if (user.isReviewer) {
      const items = await loadCatalog(store)
      pendingCount = items.filter((i) => i.status === 'pending').length
    }
    return jsonResponse({
      authenticated: true,
      email: user.email,
      displayName: user.displayName,
      avatar: user.avatar,
      ...(user.githubLogin ? { githubLogin: user.githubLogin } : {}),
      isCoContributor: user.isCoContributor,
      isReviewer: user.isReviewer,
      pendingCount,
    })
  }

  if (request.method === 'GET' && path === '/api/market/catalog') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    const section = (url.searchParams.get('section') || '').trim().toLowerCase()
    const approved = sortNewestFirst((await loadCatalog(store)).filter((i) => i.status === 'approved'))
    const official =
      !section || section === 'official'
        ? approved.filter((i) => i.section === 'official' && matchesQuery(i, q))
        : []
    const community =
      !section || section === 'community'
        ? approved.filter((i) => i.section !== 'official' && matchesQuery(i, q))
        : []
    return jsonResponse({ official, community })
  }

  if (request.method === 'GET' && path === '/api/market/my-submissions') {
    const user = await verifyUser(request, store, opts)
    if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)
    const items = sortNewestFirst(
      (await loadCatalog(store)).filter((i) => i.author?.email?.toLowerCase() === user.email),
    )
    return jsonResponse({ items })
  }

  if (request.method === 'GET' && path === '/api/market/review/queue') {
    const user = await verifyUser(request, store, opts)
    if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)
    if (!user.isReviewer) return jsonResponse({ error: 'Reviewer permission required.' }, 403)
    const all = sortNewestFirst(await loadCatalog(store))
    return jsonResponse({
      pending: all.filter((i) => i.status === 'pending'),
      approved: all.filter((i) => i.status === 'approved'),
      rejected: all.filter((i) => i.status === 'rejected'),
    })
  }

  const pingMatch = /^\/api\/market\/plugins\/([^/]+)\/install-ping$/.exec(path)
  if (request.method === 'POST' && pingMatch) {
    const id = decodeURIComponent(pingMatch[1])
    const items = await loadCatalog(store)
    const idx = items.findIndex((i) => i.id === id)
    if (idx === -1) return jsonResponse({ error: 'Plugin not found.' }, 404)
    if (items[idx].status !== 'approved') return jsonResponse({ error: 'Plugin is not published.' }, 403)
    const updated = { ...items[idx], installCount: Number(items[idx].installCount || 0) + 1 }
    items[idx] = updated
    await saveCatalog(store, items)
    return jsonResponse({ ok: true, installCount: updated.installCount })
  }

  const pluginMatch = /^\/api\/market\/plugins\/([^/]+)$/.exec(path)
  if (request.method === 'GET' && pluginMatch) {
    const id = decodeURIComponent(pluginMatch[1])
    const items = await loadCatalog(store)
    const plugin = items.find((i) => i.id === id)
    if (!plugin) return jsonResponse({ error: 'Plugin not found.' }, 404)
    if (plugin.status !== 'approved') {
      const user = await verifyUser(request, store, opts)
      if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)
      const isAuthor = plugin.author?.email?.toLowerCase() === user.email
      if (!isAuthor && !user.isReviewer) {
        return jsonResponse({ error: 'Not authorized to inspect unapproved plugin.' }, 403)
      }
    }
    const bundle = plugin.submissionKind === 'bundle' ? await store.getJson(`bundle:${plugin.id}`) : null
    return jsonResponse({
      plugin,
      ...(Array.isArray(bundle?.files) ? { files: bundle.files } : {}),
    })
  }

  if (request.method === 'POST' && path === '/api/market/plugins') {
    const user = await verifyUser(request, store, opts)
    if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)

    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON request body.' }, 400)
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 80) : undefined
    const version = typeof body.version === 'string' && body.version.trim() ? body.version.trim().slice(0, 32) : '1.0.0'
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const submissionKind = body.submissionKind === 'github' ? 'github' : body.submissionKind === 'bundle' ? 'bundle' : null

    if (name.length < 2 || name.length > 80) {
      return jsonResponse({ error: 'Plugin name must be between 2 and 80 characters.' }, 400)
    }
    if (!description || description.length > 1200) {
      return jsonResponse({ error: 'Description is required and must be <= 1200 characters.' }, 400)
    }
    if (!submissionKind) {
      return jsonResponse({ error: 'submissionKind must be "bundle" or "github".' }, 400)
    }

    const targetSection = body.targetSection === 'official' ? 'official' : 'community'
    if (targetSection === 'official' && !user.isCoContributor) {
      return jsonResponse({ error: 'Only verified Co-contributors can publish directly to Official Plugins.' }, 403)
    }

    let sanitizedFiles = []
    let summary = {
      skillNames: Array.isArray(body.skillNames) ? body.skillNames.filter((s) => typeof s === 'string').slice(0, 40) : [],
      commandNames: Array.isArray(body.commandNames) ? body.commandNames.filter((s) => typeof s === 'string').slice(0, 40) : [],
      ruleFiles: Array.isArray(body.ruleFiles) ? body.ruleFiles.filter((s) => typeof s === 'string').slice(0, 40) : [],
      mcpCount: Number.isFinite(Number(body.mcpCount)) ? Math.max(0, Math.floor(Number(body.mcpCount))) : 0,
      hasHooks: Boolean(body.hasHooks),
      hasScripts: false,
      hasTheme: Boolean(body.hasTheme),
      hasBootAnimation: Boolean(body.hasBootAnimation),
      fileCount: 0,
      totalBytes: 0,
    }
    let repoUrl

    if (submissionKind === 'github') {
      if (!isValidGithubUrl(body.repoUrl)) {
        return jsonResponse({ error: 'Valid GitHub repository URL is required.' }, 400)
      }
      repoUrl = body.repoUrl.trim()
    } else {
      if (!Array.isArray(body.files) || body.files.length === 0) {
        return jsonResponse({ error: 'Bundle submission requires at least one file.' }, 400)
      }
      if (body.files.length > MAX_BUNDLE_FILES) {
        return jsonResponse({ error: `Bundle exceeds maximum of ${MAX_BUNDLE_FILES} files.` }, 400)
      }
      let totalSize = 0
      const seenPaths = new Set()
      for (const rawFile of body.files) {
        const cleanPath = sanitizeBundlePath(rawFile?.path)
        if (!cleanPath) {
          return jsonResponse({ error: `Invalid or forbidden bundle path: ${String(rawFile?.path || '')}` }, 400)
        }
        if (seenPaths.has(cleanPath)) continue
        seenPaths.add(cleanPath)

        const encoding = rawFile?.encoding === 'base64' ? 'base64' : 'utf8'
        const content = typeof rawFile?.content === 'string' ? rawFile.content : ''
        const approxSize = encoding === 'base64' ? Math.floor((content.length * 3) / 4) : content.length
        if (approxSize > MAX_SINGLE_FILE_BYTES) {
          return jsonResponse({ error: `File "${cleanPath}" exceeds 512KB limit.` }, 400)
        }
        totalSize += approxSize
        if (totalSize > MAX_TOTAL_BUNDLE_BYTES) {
          return jsonResponse({ error: 'Total plugin bundle size exceeds 2MB limit.' }, 400)
        }
        sanitizedFiles.push({ path: cleanPath, content, encoding, size: approxSize })
      }
      if (!hasRecognizablePluginContent(sanitizedFiles)) {
        return jsonResponse({ error: 'Plugin bundle must include plugin.json, SKILL.md, commands, rules, or MCP config.' }, 400)
      }
      summary = summarizeBundleFiles(sanitizedFiles)
    }

    const now = nowFn()
    const items = await loadCatalog(store)
    const baseId = slugify(name)
    let id = baseId
    let suffix = 2
    while (items.some((i) => i.id === id)) {
      id = `${baseId}-${suffix++}`
    }

    const authorNameRaw = typeof body.authorDisplayName === 'string' ? body.authorDisplayName.trim().slice(0, 64) : ''
    const authorAvatar = validateAvatar(body.authorAvatar) ?? user.avatar ?? null
    const isOfficial = targetSection === 'official'

    const listing = {
      id,
      name,
      ...(displayName ? { displayName } : {}),
      version,
      description,
      ...(typeof body.category === 'string' && body.category.trim() ? { category: body.category.trim().slice(0, 32) } : {}),
      tags: sanitizeTags(body.tags),
      section: targetSection,
      status: isOfficial ? 'approved' : 'pending',
      submissionKind,
      ...(repoUrl ? { repoUrl } : {}),
      ...(typeof body.homepage === 'string' && /^https?:\/\//i.test(body.homepage.trim()) ? { homepage: body.homepage.trim() } : {}),
      author: {
        name: authorNameRaw || user.displayName || user.email,
        email: user.email,
        avatar: authorAvatar,
        role: user.isCoContributor ? 'co-contributor' : 'community',
      },
      skillNames: summary.skillNames,
      commandNames: summary.commandNames,
      ruleFiles: summary.ruleFiles,
      mcpCount: summary.mcpCount,
      hasHooks: summary.hasHooks,
      hasScripts: summary.hasScripts,
      ...(summary.hasTheme ? { hasTheme: true } : {}),
      ...(summary.hasBootAnimation ? { hasBootAnimation: true } : {}),
      fileCount: summary.fileCount,
      totalBytes: summary.totalBytes,
      installCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(isOfficial ? { reviewedBy: user.email, reviewedAt: now } : {}),
    }

    if (submissionKind === 'bundle') {
      await store.putJson(`bundle:${id}`, { files: sanitizedFiles })
    }
    await saveCatalog(store, [listing, ...items])
    return jsonResponse({ plugin: listing }, 201)
  }

  const reviewMatch = /^\/api\/market\/review\/([^/]+)$/.exec(path)
  if (request.method === 'POST' && reviewMatch) {
    const user = await verifyUser(request, store, opts)
    if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)
    if (!user.isReviewer) return jsonResponse({ error: 'Reviewer permission required.' }, 403)

    const id = decodeURIComponent(reviewMatch[1])
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON request body.' }, 400)
    }

    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null
    if (!decision) return jsonResponse({ error: 'decision must be "approve" or "reject".' }, 400)

    const items = await loadCatalog(store)
    const idx = items.findIndex((i) => i.id === id)
    if (idx === -1) return jsonResponse({ error: 'Plugin not found.' }, 404)

    const existing = items[idx]
    const now = nowFn()
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
    let nextSection = existing.section || 'community'
    if (decision === 'approve' && body.section === 'official' && user.isCoContributor) {
      nextSection = 'official'
    } else if (decision === 'approve' && body.section === 'community') {
      nextSection = 'community'
    }

    const updated = {
      ...existing,
      section: nextSection,
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewedBy: user.email,
      reviewedAt: now,
      updatedAt: now,
      ...(note ? { reviewNote: note } : { reviewNote: undefined }),
    }
    if (!note) delete updated.reviewNote

    items[idx] = updated
    await saveCatalog(store, items)
    return jsonResponse({ plugin: updated })
  }

  if (request.method === 'DELETE' && pluginMatch) {
    const user = await verifyUser(request, store, opts)
    if (!user) return jsonResponse({ error: 'Authentication required.' }, 401)

    const id = decodeURIComponent(pluginMatch[1])
    const items = await loadCatalog(store)
    const target = items.find((i) => i.id === id)
    if (!target) return jsonResponse({ error: 'Plugin not found.' }, 404)

    const isAuthor = target.author?.email?.toLowerCase() === user.email
    if (!isAuthor && !user.isReviewer) {
      return jsonResponse({ error: 'Only the author or an official reviewer can delete this submission.' }, 403)
    }

    if (target.submissionKind === 'bundle') {
      await store.delete(`bundle:${id}`)
    }
    await saveCatalog(store, items.filter((i) => i.id !== id))
    return jsonResponse({ ok: true })
  }

  return jsonResponse({ error: 'Not found.' }, 404)
}
