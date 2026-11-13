import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALLOWED_EMAIL_DOMAINS,
  CATEGORY_DEFAULT_KEY_GROUPS,
  RELAYPULSE_DEFAULT_ORIGIN,
  RELAYPULSE_PROD_ORIGIN,
  RELAYPULSE_STAGING_ORIGIN,
  classifyModelSubscriptionCategory,
  classifyModelVendor,
  getDefaultKeyGroupForCategory,
  getDefaultKeyGroupForModel,
  groupModelsByVendor,
  isAllowedWhitelistEmail,
  isModelEligibleForCategorySubscription,
  isStagingOrigin,
  isValidAvatarValue,
} from '../src/shared/relaypulse.ts'
import { RelayPulseAccountManager } from '../src/core/account.ts'
import { describeNetworkError } from '../src/core/net.ts'
import { renderAtriumOAuthPage } from '../src/core/oauth_page.ts'
import { SettingsStore } from '../src/core/settings.ts'
import { bindSecrets } from '../src/core/secrets.ts'

test('whitelist email validation allows only the 5 approved domains', () => {
  for (const domain of ALLOWED_EMAIL_DOMAINS) {
    assert.equal(isAllowedWhitelistEmail(`user@${domain}`), true, `expected ${domain} to pass`)
    assert.equal(isAllowedWhitelistEmail(`USER@${domain.toUpperCase()}`), true)
  }
  assert.equal(isAllowedWhitelistEmail('user@tempmail.xyz'), false)
  assert.equal(isAllowedWhitelistEmail('user@foxmail.com'), false)
  assert.equal(isAllowedWhitelistEmail('invalid-email'), false)
})

test('RelayPulseAccountManager loads default disconnected state and normalizes origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-acct-test-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  try {
    const settings = new SettingsStore(dir)
    await settings.load()
    const events: unknown[] = []
    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: (s) => events.push(s),
    })

    const initial = await acct.load()
    assert.equal(initial.connected, false)
    assert.equal(acct.isConnected(), false)
    assert.equal(RELAYPULSE_DEFAULT_ORIGIN, RELAYPULSE_PROD_ORIGIN)
    assert.equal(initial.origin, RELAYPULSE_PROD_ORIGIN)
    assert.equal(initial.stagingAgreementAccepted, false)
    assert.equal(isStagingOrigin('HTTPS://API1991.RPULSE.TOP/'), true)
    assert.equal(isStagingOrigin(RELAYPULSE_PROD_ORIGIN), false)

    // Unconsented switch to staging is blocked
    await assert.rejects(
      () => acct.setOrigin(RELAYPULSE_STAGING_ORIGIN),
      /测试线路不稳定及费率风险协议/,
    )
    assert.equal(acct.getState().origin, RELAYPULSE_PROD_ORIGIN)
    assert.equal(acct.getState().stagingAgreementAccepted, false)

    // Explicit consent unlocks staging
    const stagingState = await acct.setOrigin(RELAYPULSE_STAGING_ORIGIN, { acceptStagingRisk: true })
    assert.equal(stagingState.origin, RELAYPULSE_STAGING_ORIGIN)
    assert.equal(stagingState.stagingAgreementAccepted, true)
    assert.equal(typeof stagingState.stagingAgreementAcceptedAt, 'number')

    // Switching back to Production clears staging consent
    const updated = await acct.setOrigin('https://api.rpulse.top/')
    assert.equal(updated.origin, 'https://api.rpulse.top')
    assert.equal(updated.stagingAgreementAccepted, false)
    assert.equal(updated.stagingAgreementAcceptedAt, undefined)
    await assert.rejects(() => acct.setOrigin(RELAYPULSE_STAGING_ORIGIN))

    // Invalid protocol falls back to default origin
    const fallback = await acct.setOrigin('ftp://evil.example')
    assert.equal(fallback.origin, RELAYPULSE_DEFAULT_ORIGIN)

    const out = await acct.logout()
    assert.equal(out.connected, false)
    assert.equal(out.origin, RELAYPULSE_PROD_ORIGIN)
    assert.equal(out.stagingAgreementAccepted, false)
    assert.equal(acct.isConnected(), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('renderAtriumOAuthPage renders Atrium Studio branding and close controls safely', () => {
  const html = renderAtriumOAuthPage({
    ok: true,
    title: '登录成功',
    heading: '欢迎来到 Atrium',
    message: '授权完成 <script>alert(1)</script>',
    providerLabel: 'Google 账号登录',
  })
  assert.ok(html.includes('Atrium Studio · Google 账号登录'))
  assert.ok(html.includes('#c46342'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('关闭此页面'))
})

test('SettingsStore supports multiple models per provider and model switching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atrium-models-test-'))
  try {
    const store = new SettingsStore(dir)
    await store.load()
    const saved = await store.saveProvider({
      name: 'RelayPulse',
      protocol: 'openai',
      baseUrl: 'https://api.rpulse.top/v1',
      model: 'gpt-5.4',
      models: ['gpt-5.4', 'claude-sonnet-5-5', 'deepseek-chat'],
    })
    assert.deepEqual(saved.models, ['gpt-5.4', 'claude-sonnet-5-5', 'deepseek-chat'])

    const switched = await store.selectProviderModel(saved.id, 'claude-sonnet-5-5')
    assert.equal(switched.settings.activeProviderId, saved.id)
    assert.equal(switched.providers[0]?.model, 'claude-sonnet-5-5')
    assert.deepEqual(switched.providers[0]?.models, ['gpt-5.4', 'claude-sonnet-5-5', 'deepseek-chat'])

    const merged = await store.mergeProviderModels(saved.id, ['gemini-4-pro', 'gpt-5.4'])
    assert.deepEqual(merged.models, ['gpt-5.4', 'claude-sonnet-5-5', 'deepseek-chat', 'gemini-4-pro'])

    const custom = await store.setProviderModels(saved.id, ['gemini-4-pro', 'deepseek-chat'], 'deepseek-chat')
    assert.equal(custom.model, 'deepseek-chat')
    assert.deepEqual(custom.models, ['gemini-4-pro', 'deepseek-chat'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RelayPulseAccountManager replaces stale/suffixed models on partition sync and group change', async () => {
  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-sync-test-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  let currentGroup = 'gpt-pro'
  const modelsByGroup: Record<string, string[]> = {
    'gpt-pro': ['gpt-6.2-astra', 'gpt-6.2-sol'],
    claude: ['claude-opus-5-5', 'claude-sonnet-5-5'],
  }

  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/v1/models') {
      const list = (modelsByGroup[currentGroup] || []).map((id) => ({ id, object: 'model' }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: list }))
      return
    }
    if (path === '/api/user/keys/default' && req.method === 'PATCH') {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { group?: string }
        if (parsed.group) currentGroup = parsed.group
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, item: { group: currentGroup } }))
      })
      return
    }
    if (path === '/api/user/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          user: {
            email: 'tester@gmail.com',
            apiKey: 'sk-rpu-test-key',
            group: currentGroup,
          },
        }),
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unmocked' }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  const origin = `http://127.0.0.1:${addr.port}`

  try {
    const settings = new SettingsStore(dir)
    await settings.load()
    const legacy = await settings.saveProvider({
      name: 'RelayPulse',
      protocol: 'openai',
      baseUrl: `${origin}/v1`,
      model: 'gpt-6.2-sol-20x',
      models: ['gpt-6.2-sol-20x', 'gpt-6.2-astra-20x'],
      managedBy: 'relaypulse',
      apiKey: 'sk-rpu-test-key',
    })
    await settings.update({ activeProviderId: legacy.id })

    secretStore.set('account:relaypulse:sessionToken', 'rps-session')
    secretStore.set('account:relaypulse:apiKey', 'sk-rpu-test-key')
    await writeFile(
      join(dir, 'relaypulse-account.json'),
      JSON.stringify({
        origin,
        connected: true,
        email: 'tester@gmail.com',
        providerId: legacy.id,
        keyGroup: 'gpt-pro',
      }),
    )

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    await acct.load()
    await acct.refresh()

    // Stale -20x suffixed models should be replaced automatically by clean canonical partition models
    const afterRefresh = settings.getProvider(legacy.id)!
    assert.deepEqual(afterRefresh.models, ['gpt-6.2-astra', 'gpt-6.2-sol'])
    assert.equal(afterRefresh.model, 'gpt-6.2-astra')

    // Switching partition to claude replaces GPT models with clean Claude models and updates active model
    const nextState = await acct.setKeyGroup('claude')
    assert.equal(nextState.keyGroup, 'claude')
    const afterSwitch = settings.getProvider(legacy.id)!
    assert.deepEqual(afterSwitch.models, ['claude-opus-5-5', 'claude-sonnet-5-5'])
    assert.equal(afterSwitch.model, 'claude-opus-5-5')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('classifyModelSubscriptionCategory and eligibility cover all 6 zones and exclude commercial groups', () => {
  assert.equal(classifyModelSubscriptionCategory('gpt-6.2-astra'), 'gpt')
  assert.equal(classifyModelSubscriptionCategory('claude-opus-5-5'), 'claude')
  assert.equal(classifyModelSubscriptionCategory('gemini-4-pro'), 'gemini')
  assert.equal(classifyModelSubscriptionCategory('deepseek-v4'), 'deepseek')
  assert.equal(classifyModelSubscriptionCategory('glm-5.3'), 'zhipu')
  assert.equal(classifyModelSubscriptionCategory('kimi-k3'), 'kimi')
  assert.equal(classifyModelSubscriptionCategory('grok-4'), null)

  assert.equal(isModelEligibleForCategorySubscription('claude-sonnet-5-5', 'claude-kiro'), true)
  assert.equal(isModelEligibleForCategorySubscription('claude-sonnet-5-5', 'claude-external'), false)
  assert.equal(isModelEligibleForCategorySubscription('Gemini4argon', 'gemini-official'), false)
})

test('RelayPulseAccountManager supports concurrent 4-category subscriptions, metering, upgrade, rotation, and legacy compat', async () => {
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-cat-subs-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  try {
    const settings = new SettingsStore(dir)
    await settings.load()

    await writeFile(
      join(dir, 'relaypulse-account.json'),
      JSON.stringify({
        origin: 'https://api1991.rpulse.top',
        connected: true,
        email: 'master@gmail.com',
        keyGroup: 'claude',
        subscription: {
          tier: 'pro',
          name: '全能 Pro (兼容)',
          status: 'active',
          active: true,
          remainingPercent: 88,
          usedPercent: 12,
          daysRemaining: 21,
          expiresAtFormatted: '2026-12-10',
        },
      }),
    )

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    const loaded = await acct.load()
    assert.equal(loaded.subscription?.active, true)

    // Subscribe simultaneously to GPT standard and Claude pro
    const subGpt = await acct.subscribeCategory({ category: 'gpt', level: 'standard' })
    assert.equal(subGpt.ok, true)
    assert.equal(subGpt.source, 'atrium')

    const subClaude = await acct.subscribeCategory({ category: 'claude', level: 'pro' })
    assert.equal(subClaude.state.subscriptions?.gpt?.active, true)
    assert.equal(subClaude.state.subscriptions?.claude?.active, true)
    // Legacy subscription remains untouched alongside category subscriptions
    assert.equal(subClaude.state.subscription?.tier, 'pro')

    // Token usage deducts only the matching category
    await acct.recordSubscriptionUsage('claude-opus-5-5', {
      inputTokens: 100_000,
      outputTokens: 50_000,
    })
    const afterClaudeSpend = acct.getState()
    assert.ok((afterClaudeSpend.subscriptions?.claude?.weeklyUsedUsd ?? 0) > 0)
    assert.equal(afterClaudeSpend.subscriptions?.gpt?.weeklyUsedUsd, 0)

    // GPT spend deducts GPT only
    await acct.recordSubscriptionUsage('gpt-6.2', {
      inputTokens: 200_000,
      outputTokens: 100_000,
    })
    const afterGptSpend = acct.getState()
    const gptSpentBeforeUpgrade = afterGptSpend.subscriptions?.gpt?.weeklyUsedUsd ?? 0
    assert.ok(gptSpentBeforeUpgrade > 0)

    // Upgrade GPT standard -> pro preserves spend and raises limit
    const upgraded = await acct.subscribeCategory({ category: 'gpt', level: 'pro' })
    assert.equal(upgraded.state.subscriptions?.gpt?.level, 'pro')
    assert.equal(upgraded.state.subscriptions?.gpt?.weeklyLimitUsd, 19)
    assert.equal(upgraded.state.subscriptions?.gpt?.monthlyLimitUsd, 76)
    assert.equal(upgraded.state.subscriptions?.gpt?.weeklyUsedUsd, gptSpentBeforeUpgrade)

    // Renew Claude pro (+30 days)
    const beforeRenewExp = Date.parse(upgraded.state.subscriptions!.claude!.expiresAt)
    const renewed = await acct.subscribeCategory({ category: 'claude', level: 'pro' })
    const afterRenewExp = Date.parse(renewed.state.subscriptions!.claude!.expiresAt)
    assert.ok(afterRenewExp - beforeRenewExp >= 29 * 86_400_000)

    // Verify persistence across reload and automatic weekly reset when cycleResetAt is in the past
    const persistedJson = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'relaypulse-account.json'), 'utf8'))
    persistedJson.subscriptions.gpt.cycleResetAt = new Date(Date.now() - 60_000).toISOString()
    persistedJson.subscriptions.claude.expiresAt = new Date(Date.now() - 60_000).toISOString()
    await writeFile(join(dir, 'relaypulse-account.json'), JSON.stringify(persistedJson))

    const reloaded = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    const reloadedState = await reloaded.load()
    assert.equal(reloadedState.subscriptions?.gpt?.weeklyUsedUsd, 0)
    assert.ok((reloadedState.subscriptions?.gpt?.monthlyUsedUsd ?? 0) > 0)
    assert.equal(reloadedState.subscriptions?.claude?.active, false)
    assert.equal(reloadedState.subscriptions?.claude?.status, 'expired')

    // Cancel GPT leaves remaining map state clean
    const afterCancel = await reloaded.cancelCategorySubscription('gpt')
    assert.equal(afterCancel.subscriptions?.gpt, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RelayPulseAccountManager silently routes all 6 categories to default groups and aggregates models cleanly', async () => {
  assert.equal(CATEGORY_DEFAULT_KEY_GROUPS.gpt, 'gpt-pro')
  assert.equal(CATEGORY_DEFAULT_KEY_GROUPS.claude, 'claude-kiro')
  assert.equal(CATEGORY_DEFAULT_KEY_GROUPS.gemini, 'gemini')
  assert.equal(CATEGORY_DEFAULT_KEY_GROUPS.deepseek, 'deepseek')
  assert.equal(CATEGORY_DEFAULT_KEY_GROUPS.zhipu, 'zhipu')
  assert.equal(CATEGORY_DEFAULT_KEY_GROUPS.kimi, 'kimi')
  assert.equal(getDefaultKeyGroupForCategory('gpt'), 'gpt-pro')
  assert.equal(getDefaultKeyGroupForCategory('claude'), 'claude-kiro')
  assert.equal(getDefaultKeyGroupForCategory('gemini'), 'gemini')
  assert.equal(getDefaultKeyGroupForCategory('deepseek'), 'deepseek')
  assert.equal(getDefaultKeyGroupForCategory('zhipu'), 'zhipu')
  assert.equal(getDefaultKeyGroupForCategory('kimi'), 'kimi')

  assert.equal(getDefaultKeyGroupForModel('gpt-6.2'), 'gpt-pro')
  assert.equal(getDefaultKeyGroupForModel('claude-sonnet-5-5'), 'claude-kiro')
  assert.equal(getDefaultKeyGroupForModel('gemini-4-pro'), 'gemini')
  assert.equal(getDefaultKeyGroupForModel('deepseek-v4'), 'deepseek')
  assert.equal(getDefaultKeyGroupForModel('glm-5.3'), 'zhipu')
  assert.equal(getDefaultKeyGroupForModel('kimi-k3'), 'kimi')

  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-silent-route-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  let currentGroup = 'gpt-pro'
  const modelsByGroup: Record<string, string[]> = {
    'gpt-pro': ['gpt-6.2', 'gpt-5.6-codex'],
    'claude-kiro': ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    gemini: ['gemini-4-pro'],
    deepseek: ['deepseek-v4'],
    zhipu: ['glm-5.3'],
    kimi: ['kimi-k3'],
  }

  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/v1/models') {
      const list = (modelsByGroup[currentGroup] || []).map((id) => ({ id, object: 'model' }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: list }))
      return
    }
    if (path === '/api/user/keys/default' && req.method === 'PATCH') {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { group?: string }
        if (parsed.group) currentGroup = parsed.group
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, item: { group: currentGroup } }))
      })
      return
    }
    if (path === '/api/user/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ user: { email: 'route@gmail.com', apiKey: 'sk-rpu-route', group: currentGroup } }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unmocked' }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  const origin = `http://127.0.0.1:${addr.port}`

  try {
    const settings = new SettingsStore(dir)
    await settings.load()
    const provider = await settings.saveProvider({
      name: 'RelayPulse',
      protocol: 'openai',
      baseUrl: `${origin}/v1`,
      model: 'gpt-6.2',
      models: ['gpt-6.2'],
      managedBy: 'relaypulse',
      apiKey: 'sk-rpu-route',
    })
    await settings.update({ activeProviderId: provider.id })

    secretStore.set('account:relaypulse:sessionToken', 'rps-session')
    secretStore.set('account:relaypulse:apiKey', 'sk-rpu-route')
    await writeFile(
      join(dir, 'relaypulse-account.json'),
      JSON.stringify({
        origin,
        connected: true,
        email: 'route@gmail.com',
        providerId: provider.id,
        keyGroup: 'gpt-pro',
      }),
    )

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    await acct.load()
    const synced = await acct.syncModels()
    assert.deepEqual(synced.availableModels, [
      'gpt-6.2',
      'gpt-5.6-codex',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'gemini-4-pro',
      'deepseek-v4',
      'glm-5.3',
      'kimi-k3',
    ])
    // Default group restored cleanly to active model's category (gpt -> gpt-pro)
    assert.equal(currentGroup, 'gpt-pro')

    // Single-category refresh preserves cached models from other categories
    await acct.refresh()
    assert.deepEqual(settings.getProvider(provider.id)?.models, [
      'gpt-6.2',
      'gpt-5.6-codex',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'gemini-4-pro',
      'deepseek-v4',
      'glm-5.3',
      'kimi-k3',
    ])

    // Selecting models silently routes backend group across all 6 families
    await acct.ensureKeyGroupForModel('claude-sonnet-5-5')
    assert.equal(currentGroup, 'claude-kiro')

    await acct.ensureKeyGroupForModel('gemini-4-pro')
    assert.equal(currentGroup, 'gemini')

    await acct.ensureKeyGroupForModel('glm-5.3')
    assert.equal(currentGroup, 'zhipu')

    await acct.ensureKeyGroupForModel('kimi-k3')
    assert.equal(currentGroup, 'kimi')

    await acct.ensureKeyGroupForModel('deepseek-v4')
    assert.equal(currentGroup, 'deepseek')

    await acct.ensureKeyGroupForModel('gpt-6.2')
    assert.equal(currentGroup, 'gpt-pro')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('RelayPulseAccountManager validates and persists custom avatars without being overwritten by OAuth refresh', async () => {
  assert.equal(isValidAvatarValue(null), true)
  assert.equal(isValidAvatarValue('preset:cat'), true)
  assert.equal(isValidAvatarValue('preset:nonexistent'), false)
  assert.equal(isValidAvatarValue('data:image/png;base64,iVBORw0KGgo='), true)
  assert.equal(isValidAvatarValue('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), false)
  assert.equal(isValidAvatarValue('javascript:alert(1)'), false)

  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-avatar-test-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/api/user/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          user: {
            email: 'avatar@gmail.com',
            avatar: 'https://example.com/oauth-avatar.png',
            apiKey: 'sk-rpu-avatar',
            group: 'gpt-pro',
          },
        }),
      )
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unmocked' }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as { port: number }
  const origin = `http://127.0.0.1:${addr.port}`

  try {
    const settings = new SettingsStore(dir)
    await settings.load()
    secretStore.set('account:relaypulse:sessionToken', 'rps-avatar')
    secretStore.set('account:relaypulse:apiKey', 'sk-rpu-avatar')
    await writeFile(
      join(dir, 'relaypulse-account.json'),
      JSON.stringify({
        origin,
        connected: true,
        email: 'avatar@gmail.com',
        avatar: 'https://example.com/oauth-avatar.png',
        keyGroup: 'gpt-pro',
      }),
    )

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    await acct.load()

    const customDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const withCustom = await acct.setAvatar(customDataUrl)
    assert.equal(withCustom.avatar, customDataUrl)
    assert.equal(withCustom.avatarCustom, true)

    // OAuth refresh must NOT overwrite user's custom avatar
    const afterRefresh = await acct.refresh()
    assert.equal(afterRefresh.avatar, customDataUrl)
    assert.equal(afterRefresh.avatarCustom, true)

    // Preset avatar also works & persists cleanly across reload
    await acct.setAvatar('preset:cat')
    const reloaded = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    const reloadedState = await reloaded.load()
    assert.equal(reloadedState.avatar, 'preset:cat')
    assert.equal(reloadedState.avatarCustom, true)

    // Resetting restores cached OAuth remote avatar cleanly
    const afterReset = await reloaded.setAvatar(null)
    assert.equal(afterReset.avatar, 'https://example.com/oauth-avatar.png')
    assert.equal(afterReset.avatarCustom, false)

    // Reject invalid payloads
    await assert.rejects(() => reloaded.setAvatar('javascript:alert(1)'))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('RelayPulseAccountManager handles in-app QR recharge, polling, personal confirmation, and offline SVG rendering', async () => {
  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-recharge-test-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  let balanceCny = 10
  const paidOrders = new Set<string>()
  const reportedOrders: string[] = []
  const personalQrDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    let rawBody = ''
    for await (const chunk of req) rawBody += String(chunk)
    const jsonBody = rawBody ? JSON.parse(rawBody) : {}

    if (reqUrl.pathname === '/api/pay/create-order' && req.method === 'POST') {
      assert.equal(jsonBody.pay_type, 'standard')
      if (jsonBody.pay_channel === 'alipay') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            success: true,
            out_trade_no: 'RP_ALI_PERSONAL_01',
            amount_cny: Number(jsonBody.amount_cny || 100),
            pay_cny: Number(jsonBody.amount_cny || 100),
            pay_mode: 'personal',
            pay_channel: 'personal',
            pay_method: 'alipay',
            qr_image_data: personalQrDataUrl,
            manual_confirmation: true,
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          out_trade_no: 'RP_STD_01',
          amount_cny: Number(jsonBody.amount_cny || 50),
          pay_cny: Number(jsonBody.amount_cny || 50),
          qr_code: 'weixin://wxpay/bizpayurl?pr=ATRIUMTEST',
          pay_url: 'https://rpulse.top/should-not-leak',
          pay_mode: 'epay',
          pay_channel: 'epay',
          pay_method: jsonBody.pay_channel || 'wxpay',
        }),
      )
      return
    }

    if (reqUrl.pathname === '/api/pay/check-order') {
      const otn = reqUrl.searchParams.get('out_trade_no') || ''
      const paid = paidOrders.has(otn)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          paid,
          status: paid ? 'paid' : 'pending',
          amount_cny: otn === 'RP_ALI_PERSONAL_01' ? 100 : 50,
        }),
      )
      return
    }

    if (reqUrl.pathname === '/api/pay/report-paid' && req.method === 'POST') {
      reportedOrders.push(String(jsonBody.out_trade_no || ''))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: '已收到转账反馈，核对后到账' }))
      return
    }

    if (reqUrl.pathname === '/api/user/profile') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          user: {
            email: 'buyer@gmail.com',
            balance_cny: balanceCny,
            key_group: 'gpt-pro',
          },
        }),
      )
      return
    }

    res.writeHead(404)
    res.end('{}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port

  try {
    const settings = new SettingsStore(dir)
    await settings.load()
    secretStore.set('account:relaypulse:sessionToken', 'sess-topup')
    secretStore.set('account:relaypulse:apiKey', 'sk-rpu-topup')
    await writeFile(
      join(dir, 'relaypulse-account.json'),
      JSON.stringify({
        origin: `http://127.0.0.1:${port}`,
        connected: true,
        email: 'buyer@gmail.com',
        balanceCny: 10,
      }),
    )

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => {
        throw new Error('openExternal must not be called during in-app recharge')
      },
      onChange: () => undefined,
    })
    await acct.load()

    const stdOrder = await acct.createRechargeOrder({ payChannel: 'wxpay', amountCny: 50 })
    assert.equal(stdOrder.outTradeNo, 'RP_STD_01')
    assert.equal(stdOrder.payCny, 50)
    assert.equal(stdOrder.manualConfirmation, false)
    assert.ok(stdOrder.qrImageDataUrl.startsWith('data:image/svg+xml;base64,'))
    const decodedSvg = Buffer.from(stdOrder.qrImageDataUrl.replace('data:image/svg+xml;base64,', ''), 'base64').toString('utf8')
    assert.ok(decodedSvg.includes('<svg'))
    assert.ok(!JSON.stringify(stdOrder).includes('rpulse.top'))

    const beforePay = await acct.checkRechargeOrder(stdOrder.outTradeNo)
    assert.equal(beforePay.paid, false)
    assert.equal(beforePay.status, 'pending')

    balanceCny = 60
    paidOrders.add(stdOrder.outTradeNo)
    const afterPay = await acct.checkRechargeOrder(stdOrder.outTradeNo)
    assert.equal(afterPay.paid, true)
    assert.equal(afterPay.status, 'paid')
    assert.equal(afterPay.state?.balanceCny, 60)

    const aliOrder = await acct.createRechargeOrder({ payChannel: 'alipay', amountCny: 100 })
    assert.equal(aliOrder.outTradeNo, 'RP_ALI_PERSONAL_01')
    assert.equal(aliOrder.manualConfirmation, true)
    assert.equal(aliOrder.qrImageDataUrl, personalQrDataUrl)

    const rep = await acct.reportRechargePaid(aliOrder.outTradeNo)
    assert.equal(rep.ok, true)
    assert.deepEqual(reportedOrders, ['RP_ALI_PERSONAL_01'])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('Upstream rpulse.top and RelayPulse strings are redacted across errors, locales, and AccountPanel', async () => {
  const errMsg = describeNetworkError(
    new Error('connect ECONNREFUSED https://api1991.rpulse.top/v1'),
    'https://api.rpulse.top/v1/chat/completions',
  )
  assert.ok(!/rpulse\.top/i.test(errMsg), `Expected rpulse.top redacted from: ${errMsg}`)
  assert.ok(errMsg.includes('Atrium Cloud'))

  const updateErr = describeNetworkError(
    Object.assign(new Error('timeout'), { cause: { code: 'ENOTFOUND' } }),
    'https://updates.rpulse.top/win/latest.yml',
  )
  assert.ok(!/rpulse\.top/i.test(updateErr), `Expected updates.rpulse.top redacted from: ${updateErr}`)
  assert.ok(updateErr.includes('Atrium Cloud'))

  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const [zhSrc, enSrc, accountPanelSrc] = await Promise.all([
    readFile(join(repoRoot, 'src', 'renderer', 'src', 'locales', 'zh.ts'), 'utf8'),
    readFile(join(repoRoot, 'src', 'renderer', 'src', 'locales', 'en.ts'), 'utf8'),
    readFile(join(repoRoot, 'src', 'renderer', 'src', 'components', 'AccountPanel.tsx'), 'utf8'),
  ])

  assert.equal(/rpulse\.top|RelayPulse/i.test(zhSrc), false, 'zh locale must not contain rpulse.top or RelayPulse')
  assert.equal(/rpulse\.top|RelayPulse/i.test(enSrc), false, 'en locale must not contain rpulse.top or RelayPulse')
  assert.equal(accountPanelSrc.includes('openExternal'), false, 'AccountPanel must not redirect externally')
  assert.equal(accountPanelSrc.includes('origin.replace'), false, 'AccountPanel must not render raw upstream host')
  assert.equal(
    /setOrigin['"],\s*RELAYPULSE_STAGING_ORIGIN\s*\)/.test(accountPanelSrc),
    false,
    'AccountPanel must require acceptStagingRisk before switching to staging',
  )
  assert.ok(accountPanelSrc.includes('acceptStagingRisk: true'))
})

test('RelayPulseAccountManager migrates legacy disconnected staging config back to Production and preserves consented config', async () => {
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-staging-migrate-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  try {
    const settings = new SettingsStore(dir)
    await settings.load()

    await writeFile(
      join(dir, 'relaypulse-account.json'),
      JSON.stringify({
        origin: RELAYPULSE_STAGING_ORIGIN,
        connected: false,
      }),
    )

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    const migrated = await acct.load()
    assert.equal(migrated.origin, RELAYPULSE_PROD_ORIGIN)
    assert.equal(migrated.stagingAgreementAccepted, false)

    // Consented staging config persists across reloads, and logout resets back to Production
    await acct.setOrigin(RELAYPULSE_STAGING_ORIGIN, { acceptStagingRisk: true })
    const acct2 = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    const consented = await acct2.load()
    assert.equal(consented.origin, RELAYPULSE_STAGING_ORIGIN)
    assert.equal(consented.stagingAgreementAccepted, true)

    const loggedOut = await acct2.logout()
    assert.equal(loggedOut.origin, RELAYPULSE_PROD_ORIGIN)
    assert.equal(loggedOut.stagingAgreementAccepted, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('RelayPulseAccountManager supports registration password, resetPassword, and updatePassword flows', async () => {
  const { createServer } = await import('node:http')
  const { writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'atrium-pwd-test-'))
  const secretStore = new Map<string, string>()
  bindSecrets((async (method: string, ...args: unknown[]) => {
    if (method === 'secrets.get') return secretStore.get(String(args[0])) ?? null
    if (method === 'secrets.set') {
      const [k, v] = args as [string, string | null]
      if (v === null) secretStore.delete(k)
      else secretStore.set(k, v)
      return undefined
    }
    return undefined
  }) as never)

  const seenCalls: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = []
  let hasPassword = false

  const server = createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
    const chunks: Buffer[] = []
    for await (const ch of req) chunks.push(ch as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {}

    if (reqUrl.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-6.2' }] }))
      return
    }
    if (reqUrl.pathname === '/api/auth/login') {
      seenCalls.push({ path: reqUrl.pathname, body })
      if (body.new_password) hasPassword = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          token: 'sess-reg-01',
          session_expires_at: Date.now() + 86_400_000,
          user: {
            email: String(body.email),
            apiKey: 'sk-rpu-pwd-01',
            balance_cny: 0,
            key_group: 'gpt-pro',
            has_password: hasPassword,
          },
        }),
      )
      return
    }
    if (reqUrl.pathname === '/api/auth/reset-password') {
      seenCalls.push({ path: reqUrl.pathname, body })
      hasPassword = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          success: true,
          message: '密码重置成功，已自动登录！',
          token: 'sess-reset-02',
          session_expires_at: Date.now() + 86_400_000,
          user: {
            email: String(body.email),
            apiKey: 'sk-rpu-pwd-01',
            balance_cny: 0,
            key_group: 'gpt-pro',
            has_password: true,
          },
        }),
      )
      return
    }
    if (reqUrl.pathname === '/api/user/password/update') {
      seenCalls.push({
        path: reqUrl.pathname,
        body,
        auth: String(req.headers.authorization || ''),
      })
      hasPassword = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, message: '登录密码已成功更新！' }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`

  try {
    const settings = new SettingsStore(dir)
    await settings.load()
    await writeFile(join(dir, 'relaypulse-account.json'), JSON.stringify({ origin, connected: false }))

    const acct = new RelayPulseAccountManager({
      dir,
      settings,
      openExternal: async () => undefined,
      onChange: () => undefined,
    })
    await acct.load()

    // Rejects short registration password client-side without calling server
    await assert.rejects(
      () => acct.loginEmail({ email: 'user@gmail.com', code: '123456', newPassword: '123' }),
      /6 至 128 位/,
    )
    assert.equal(seenCalls.length, 0)

    // 1. Register with code + newPassword -> forwards new_password & persists hasPassword: true
    const registered = await acct.loginEmail({
      email: 'user@gmail.com',
      code: '123456',
      newPassword: 'mySecret88',
    })
    assert.equal(registered.connected, true)
    assert.equal(registered.hasPassword, true)
    assert.equal(seenCalls[0]?.path, '/api/auth/login')
    assert.equal(seenCalls[0]?.body.new_password, 'mySecret88')

    // 2. Logged-in updatePassword when hasPassword === true requires oldPassword
    await assert.rejects(() => acct.updatePassword({ newPassword: 'nextSecret99' }), /原密码/)
    const updated = await acct.updatePassword({ oldPassword: 'mySecret88', newPassword: 'nextSecret99' })
    assert.equal(updated.ok, true)
    assert.equal(updated.state.hasPassword, true)
    assert.equal(seenCalls[1]?.path, '/api/user/password/update')
    assert.equal(seenCalls[1]?.auth, 'Bearer sess-reg-01')
    assert.deepEqual(seenCalls[1]?.body, { old_password: 'mySecret88', new_password: 'nextSecret99' })

    // 3. First-time set password when hasPassword === false does not require oldPassword
    hasPassword = false
    const codeOnly = await acct.loginEmail({ email: 'nopwd@gmail.com', code: '654321' })
    assert.equal(codeOnly.hasPassword, false)
    const setFirst = await acct.updatePassword({ newPassword: 'firstSetPwd77' })
    assert.equal(setFirst.ok, true)
    assert.equal(setFirst.state.hasPassword, true)
    assert.deepEqual(seenCalls[3]?.body, { new_password: 'firstSetPwd77' })

    // 4. Forgot / reset password flow logs user in and persists hasPassword: true
    hasPassword = false
    const resetRes = await acct.resetPassword({
      email: 'nopwd@gmail.com',
      code: '998877',
      newPassword: 'resetPwd66',
    })
    assert.equal(resetRes.ok, true)
    assert.equal(resetRes.state.hasPassword, true)
    assert.equal(seenCalls[4]?.path, '/api/auth/reset-password')
    assert.deepEqual(seenCalls[4]?.body, {
      email: 'nopwd@gmail.com',
      code: '998877',
      new_password: 'resetPwd66',
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('classifyModelVendor and groupModelsByVendor organize multi-vendor model lists accurately', () => {
  assert.equal(classifyModelVendor('claude-sonnet-5-5').label, 'Claude')
  assert.equal(classifyModelVendor('gpt-6.2').label, 'OpenAI')
  assert.equal(classifyModelVendor('gemini-4-pro').label, 'Gemini')
  assert.equal(classifyModelVendor('deepseek-v4.1-flash').label, 'DeepSeek')
  assert.equal(classifyModelVendor('glm-5.3').label, 'GLM')
  assert.equal(classifyModelVendor('kimi-k2.5').label, 'Kimi')
  assert.equal(classifyModelVendor('qwen3-coder').label, 'Qwen')
  assert.equal(classifyModelVendor('custom-local-model').id, 'other')

  const grouped = groupModelsByVendor([
    'gpt-6.2',
    'claude-sonnet-5-5',
    'gpt-5.6-codex',
    'gemini-4-pro',
    'claude-sonnet-5-5',
    'deepseek-v4.1-flash',
    'glm-5.3',
    'kimi-k2.5',
  ])
  assert.deepEqual(
    grouped.map((g) => ({ id: g.id, count: g.models.length })),
    [
      { id: 'gpt', count: 2 },
      { id: 'claude', count: 1 },
      { id: 'gemini', count: 1 },
      { id: 'deepseek', count: 1 },
      { id: 'zhipu', count: 1 },
      { id: 'kimi', count: 1 },
    ],
  )
})
