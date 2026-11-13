// Atrium official account lifecycle, OAuth loopback login, and managed provider sync.
import { createServer } from 'node:http'
import { join } from 'node:path'
import QRCode from 'qrcode'
import {
  CATEGORY_DEFAULT_KEY_GROUPS,
  classifyModelSubscriptionCategory,
  estimateModelUsageCostUsd,
  getCategoryPlan,
  getCategoryPlanById,
  getDefaultKeyGroupForModel,
  getNextMondayUtcIso,
  isModelEligibleForCategorySubscription,
  isStagingOrigin,
  isValidAvatarValue,
  RELAYPULSE_DEFAULT_ORIGIN,
  RELAYPULSE_PROD_ORIGIN,
} from '../shared/relaypulse.ts'
import type {
  CategorySubscriptionInfo,
  RechargeCreateOrderRequest,
  RechargeOrderInfo,
  RechargeOrderStatusResult,
  RelayPulseAccountState,
  RelayPulseOAuthResult,
  RelayPulseSubscriptionInfo,
  SubscriptionCategory,
  SubscriptionTierLevel,
  TokenUsage,
} from '../shared/types.ts'
import { netFetch } from './net.ts'
import { renderAtriumOAuthPage } from './oauth_page.ts'
import { getSecret, secretKey, setSecret } from './secrets.ts'
import type { SettingsStore } from './settings.ts'
import { readJson, removeFile, writeJson } from './store.ts'

const SESSION_SECRET_NAME = 'sessionToken'
const API_KEY_SECRET_NAME = 'apiKey'
const ACCOUNT_ID = 'relaypulse'
const SUBSCRIPTION_CATEGORIES: readonly SubscriptionCategory[] = ['gpt', 'claude', 'gemini', 'deepseek', 'zhipu', 'kimi']
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

interface PersistedAccount {
  origin: string
  stagingAgreementAccepted?: boolean
  stagingAgreementAcceptedAt?: number
  connected: boolean
  email?: string
  displayName?: string
  oauthProvider?: string | null
  hasPassword?: boolean
  avatar?: string | null
  avatarCustom?: boolean
  remoteAvatar?: string | null
  balanceCny?: number
  specialBalanceUsd?: number
  usedCny?: number
  todayUsedCny?: number
  todayCalls?: number
  keyGroup?: string
  subscription?: RelayPulseSubscriptionInfo | null
  subscriptions?: Partial<Record<SubscriptionCategory, CategorySubscriptionInfo>>
  sessionExpiresAt?: number
  sessionValid?: boolean
  providerId?: string
  availableModels?: string[]
  lastSyncedAt?: number
}

interface PortalUserPayload {
  email?: string
  display_name?: string
  oauth_provider?: string | null
  oauth_username?: string | null
  has_password?: boolean
  apiKey?: string
  avatar?: string | null
  balance_cny?: number
  special_balance_usd?: number
  used_cny?: number
  today_used_cny?: number
  today_calls?: number
  group?: string
  key_group?: string
  subscription?: {
    tier?: string
    name?: string
    status?: string
    active?: boolean
    remaining_percent?: number
    used_percent?: number
    days_remaining?: number | null
    expires_at_formatted?: string | null
  } | null
  subscriptions?: Partial<Record<SubscriptionCategory, Partial<CategorySubscriptionInfo>>>
}

function sanitizeUpstreamMessage(text: string): string {
  return text
    .replace(/https?:\/\/[a-z0-9.-]*rpulse\.top[^\s)"']*/gi, 'Atrium Cloud')
    .replace(/\b[a-z0-9.-]*rpulse\.top\b/gi, 'Atrium Cloud')
    .replace(/RelayPulse/gi, 'Atrium')
}

function normalizeOrigin(raw?: string): string {
  const clean = (raw || '').trim().replace(/\/+$/, '')
  if (!clean) return RELAYPULSE_DEFAULT_ORIGIN
  try {
    const u = new URL(clean)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return RELAYPULSE_DEFAULT_ORIGIN
    return u.origin
  } catch {
    return RELAYPULSE_DEFAULT_ORIGIN
  }
}

function mapSubscription(raw: PortalUserPayload['subscription']): RelayPulseSubscriptionInfo | null {
  if (!raw || !raw.active) return null
  return {
    tier: String(raw.tier || ''),
    name: String(raw.name || '月度订阅'),
    status: String(raw.status || 'active'),
    active: Boolean(raw.active),
    remainingPercent: Number(raw.remaining_percent ?? 100),
    usedPercent: Number(raw.used_percent ?? 0),
    daysRemaining: raw.days_remaining ?? null,
    expiresAtFormatted: raw.expires_at_formatted ?? null,
  }
}

function formatDateYmd(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso.slice(0, 10)
  return new Date(ms).toISOString().slice(0, 10)
}

function normalizeCategorySubscription(
  raw: Partial<CategorySubscriptionInfo> | undefined,
  nowMs = Date.now(),
): CategorySubscriptionInfo | null {
  if (!raw) return null
  const plan =
    (raw.planId ? getCategoryPlanById(raw.planId) : undefined) ||
    (raw.category && raw.level ? getCategoryPlan(raw.category, raw.level) : undefined)
  if (!plan) return null

  const startedAt = raw.startedAt && Number.isFinite(Date.parse(raw.startedAt))
    ? raw.startedAt
    : new Date(nowMs).toISOString()
  const expiresAt = raw.expiresAt && Number.isFinite(Date.parse(raw.expiresAt))
    ? raw.expiresAt
    : new Date(nowMs + THIRTY_DAYS_MS).toISOString()
  const expiresMs = Date.parse(expiresAt)
  const active = Number.isFinite(expiresMs) && expiresMs > nowMs

  let cycleResetAt = raw.cycleResetAt && Number.isFinite(Date.parse(raw.cycleResetAt))
    ? raw.cycleResetAt
    : getNextMondayUtcIso(nowMs)
  let weeklyUsedUsd = Math.max(0, Number(raw.weeklyUsedUsd ?? 0) || 0)
  if (active && nowMs >= Date.parse(cycleResetAt)) {
    weeklyUsedUsd = 0
    cycleResetAt = getNextMondayUtcIso(nowMs)
  }

  const weeklyLimitUsd = Math.max(0.01, Number(raw.weeklyLimitUsd ?? plan.weeklyLimitUsd) || plan.weeklyLimitUsd)
  const monthlyLimitUsd = Math.max(weeklyLimitUsd, Number(raw.monthlyLimitUsd ?? plan.monthlyLimitUsd) || plan.monthlyLimitUsd)
  const monthlyUsedUsd = Math.max(weeklyUsedUsd, Number(raw.monthlyUsedUsd ?? weeklyUsedUsd) || 0)
  const rawUsedPct = Math.min(100, Math.max(0, (weeklyUsedUsd / weeklyLimitUsd) * 100))
  const usedPercent = Math.round(rawUsedPct)
  const remainingPercent = Math.max(0, 100 - usedPercent)
  const daysRemaining = active ? Math.max(1, Math.ceil((expiresMs - nowMs) / 86_400_000)) : 0

  return {
    category: plan.category,
    level: plan.level,
    planId: plan.id,
    name: plan.name,
    status: active ? 'active' : 'expired',
    active,
    priceCny: plan.priceCny,
    weeklyLimitUsd,
    weeklyUsedUsd: Math.round(weeklyUsedUsd * 1_000_000) / 1_000_000,
    monthlyLimitUsd,
    monthlyUsedUsd: Math.round(monthlyUsedUsd * 1_000_000) / 1_000_000,
    remainingPercent,
    usedPercent,
    daysRemaining,
    cycleResetAt,
    startedAt,
    expiresAt,
    expiresAtFormatted: formatDateYmd(expiresAt),
    preferredKeyGroup: plan.preferredKeyGroup,
    source: raw.source === 'remote' ? 'remote' : 'atrium',
  }
}

function normalizeCategorySubscriptionsMap(
  raw: (Partial<Record<SubscriptionCategory, Partial<CategorySubscriptionInfo>>> & { domestic?: Partial<CategorySubscriptionInfo> }) | undefined,
  nowMs = Date.now(),
): Partial<Record<SubscriptionCategory, CategorySubscriptionInfo>> | undefined {
  if (!raw) return undefined
  const out: Partial<Record<SubscriptionCategory, CategorySubscriptionInfo>> = {}
  let count = 0
  for (const cat of SUBSCRIPTION_CATEGORIES) {
    const normalized = normalizeCategorySubscription(raw[cat], nowMs)
    if (normalized) {
      out[cat] = normalized
      count += 1
    }
  }
  // Migrate legacy combined 'domestic' entry to 'deepseek' smoothly if no explicit 'deepseek' exists.
  if (!out.deepseek && raw.domestic) {
    const legacyDomestic = raw.domestic
    const migratedPlanId = legacyDomestic.level === 'pro' ? 'deepseek_pro' : 'deepseek_standard'
    const normalized = normalizeCategorySubscription({ ...legacyDomestic, category: 'deepseek', planId: migratedPlanId }, nowMs)
    if (normalized) {
      out.deepseek = normalized
      count += 1
    }
  }
  return count > 0 ? out : undefined
}

function formatDisplayName(user: PortalUserPayload, fallbackEmail?: string): string | undefined {
  if (user.display_name) return user.display_name
  if (user.oauth_username) return user.oauth_username
  const email = user.email || fallbackEmail
  if (email && !email.endsWith('@oauth.rpulse.local')) return email
  return email ? 'OAuth 用户' : undefined
}

export class RelayPulseAccountManager {
  private dir: string
  private settings: SettingsStore
  private openExternal: (url: string) => Promise<void>
  private focusApp?: () => Promise<void>
  private onChange: (state: RelayPulseAccountState) => void
  private state: PersistedAccount = { origin: RELAYPULSE_DEFAULT_ORIGIN, connected: false }

  constructor(opts: {
    dir: string
    settings: SettingsStore
    openExternal: (url: string) => Promise<void>
    focusApp?: () => Promise<void>
    onChange: (state: RelayPulseAccountState) => void
  }) {
    this.dir = opts.dir
    this.settings = opts.settings
    this.openExternal = opts.openExternal
    this.focusApp = opts.focusApp
    this.onChange = opts.onChange
  }

  private filePath(): string {
    return join(this.dir, 'relaypulse-account.json')
  }

  async load(): Promise<RelayPulseAccountState> {
    const saved = await readJson(this.filePath(), {} as Partial<PersistedAccount>)
    const connected = Boolean(saved.connected && saved.email)
    const stagingAgreementAccepted = Boolean(saved.stagingAgreementAccepted)
    let origin = normalizeOrigin(saved.origin)
    // Auto-migrate legacy disconnected staging configs back to Production
    // unless the user explicitly accepted the staging risk agreement.
    if (!connected && isStagingOrigin(origin) && !stagingAgreementAccepted) {
      origin = RELAYPULSE_DEFAULT_ORIGIN
    }
    const avatarCustom = Boolean(saved.avatarCustom)
    const remoteAvatar = saved.remoteAvatar ?? (!avatarCustom ? (saved.avatar ?? null) : null)
    this.state = {
      origin,
      stagingAgreementAccepted,
      stagingAgreementAcceptedAt: stagingAgreementAccepted ? saved.stagingAgreementAcceptedAt : undefined,
      connected,
      email: saved.email,
      displayName: saved.displayName,
      oauthProvider: saved.oauthProvider ?? null,
      hasPassword: saved.hasPassword,
      avatar: saved.avatar ?? null,
      avatarCustom,
      remoteAvatar,
      balanceCny: saved.balanceCny,
      specialBalanceUsd: saved.specialBalanceUsd,
      usedCny: saved.usedCny,
      todayUsedCny: saved.todayUsedCny,
      todayCalls: saved.todayCalls,
      keyGroup: saved.keyGroup,
      subscription: saved.subscription ?? null,
      subscriptions: normalizeCategorySubscriptionsMap(saved.subscriptions),
      sessionExpiresAt: saved.sessionExpiresAt,
      sessionValid: saved.sessionValid,
      providerId: saved.providerId,
      availableModels: saved.availableModels,
      lastSyncedAt: saved.lastSyncedAt,
    }
    return this.getState()
  }

  getState(): RelayPulseAccountState {
    const { remoteAvatar: _remoteAvatar, ...publicState } = this.state
    const subscriptions = normalizeCategorySubscriptionsMap(publicState.subscriptions)
    return {
      ...publicState,
      ...(subscriptions ? { subscriptions } : { subscriptions: undefined }),
    }
  }

  isConnected(): boolean {
    return Boolean(this.state.connected && this.state.email)
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath(), this.state)
    this.onChange(this.getState())
  }

  async setOrigin(
    rawOrigin: string,
    options?: { acceptStagingRisk?: boolean },
  ): Promise<RelayPulseAccountState> {
    const nextOrigin = normalizeOrigin(rawOrigin)
    if (isStagingOrigin(nextOrigin)) {
      if (!options?.acceptStagingRisk && !this.state.stagingAgreementAccepted) {
        throw new Error('切换到测试线路前，必须先阅读并同意《测试线路不稳定及费率风险协议》')
      }
      this.state.stagingAgreementAccepted = true
      this.state.stagingAgreementAcceptedAt = Date.now()
    } else if (nextOrigin === RELAYPULSE_PROD_ORIGIN) {
      this.state.stagingAgreementAccepted = false
      this.state.stagingAgreementAcceptedAt = undefined
    }
    this.state.origin = nextOrigin
    await this.persist()
    return this.getState()
  }

  private async requestJson<T>(
    path: string,
    init: { method?: string; body?: unknown; token?: string | null } = {},
  ): Promise<{ status: number; data: T & { error?: string; message?: string } }> {
    const url = `${this.state.origin}${path}`
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.token) headers['authorization'] = `Bearer ${init.token}`
    const res = await netFetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string }
    return { status: res.status, data }
  }

  async sendCode(email: string): Promise<{ ok: boolean; message: string }> {
    const clean = email.trim().toLowerCase()
    const { status, data } = await this.requestJson<{ success?: boolean; message?: string }>('/api/auth/send-code', {
      method: 'POST',
      body: { email: clean },
    })
    if (status >= 400) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `发送验证码失败 (${status})`))
    }
    return { ok: true, message: sanitizeUpstreamMessage(data.message || '验证码已发送，请查收邮件') }
  }

  async loginEmail(req: {
    email: string
    code?: string
    password?: string
    newPassword?: string
  }): Promise<RelayPulseAccountState> {
    const clean = req.email.trim().toLowerCase()
    const payload: Record<string, string> = { email: clean }
    if (req.code?.trim()) {
      payload.code = req.code.trim()
      if (req.newPassword !== undefined) {
        const newPwd = req.newPassword.trim()
        if (newPwd) {
          if (newPwd.length < 6 || newPwd.length > 128) {
            throw new Error('登录密码长度需为 6 至 128 位')
          }
          payload.new_password = newPwd
        }
      }
    }
    if (req.password) payload.password = req.password

    const endpoint = req.password && !req.code ? '/api/auth/password-login' : '/api/auth/login'
    const { status, data } = await this.requestJson<{
      success?: boolean
      user?: PortalUserPayload
      token?: string
      session_expires_at?: number
    }>(endpoint, { method: 'POST', body: payload })

    if (status >= 400 || !data.user || !data.token) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `登录失败 (${status})`))
    }
    return this.applyLoginResult(data.user, data.token, data.session_expires_at, true)
  }

  async resetPassword(req: {
    email: string
    code: string
    newPassword: string
  }): Promise<{ ok: boolean; message: string; state: RelayPulseAccountState }> {
    const cleanEmail = req.email.trim().toLowerCase()
    const cleanCode = req.code.trim()
    const cleanPwd = req.newPassword.trim()
    if (!cleanEmail) throw new Error('请输入邮箱地址')
    if (!cleanCode) throw new Error('请输入 6 位验证码')
    if (cleanPwd.length < 6 || cleanPwd.length > 128) {
      throw new Error('新密码长度需为 6 至 128 位')
    }

    const { status, data } = await this.requestJson<{
      success?: boolean
      message?: string
      user?: PortalUserPayload
      token?: string
      session_expires_at?: number
    }>('/api/auth/reset-password', {
      method: 'POST',
      body: { email: cleanEmail, code: cleanCode, new_password: cleanPwd },
    })

    if (status >= 400 || !data.user || !data.token) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `重置密码失败 (${status})`))
    }
    const state = await this.applyLoginResult(data.user, data.token, data.session_expires_at, true)
    return {
      ok: true,
      message: sanitizeUpstreamMessage(data.message || '密码设置成功，已自动登录'),
      state,
    }
  }

  async updatePassword(req: {
    oldPassword?: string
    newPassword: string
  }): Promise<{ ok: boolean; message: string; state: RelayPulseAccountState }> {
    if (!this.isConnected()) {
      throw new Error('请先登录 Atrium 账号后再设置密码')
    }
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    if (!token) {
      this.state.sessionValid = false
      await this.persist()
      throw new Error('会话已过期，请先重新验证登录再设置密码')
    }
    const cleanPwd = req.newPassword.trim()
    if (cleanPwd.length < 6 || cleanPwd.length > 128) {
      throw new Error('新密码长度需为 6 至 128 位')
    }
    if (this.state.hasPassword && !req.oldPassword) {
      throw new Error('请输入当前原密码')
    }

    const { status, data } = await this.requestJson<{ success?: boolean; message?: string }>(
      '/api/user/password/update',
      {
        method: 'POST',
        body: {
          ...(req.oldPassword ? { old_password: req.oldPassword } : {}),
          new_password: cleanPwd,
        },
        token,
      },
    )

    if (status === 401) {
      this.state.sessionValid = false
      await this.persist()
      throw new Error('会话已过期，请先重新验证登录再设置密码')
    }
    if (status >= 400 || data.success === false) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `保存密码失败 (${status})`))
    }

    this.state.hasPassword = true
    await this.persist()
    return {
      ok: true,
      message: sanitizeUpstreamMessage(data.message || '登录密码已保存'),
      state: this.getState(),
    }
  }

  async oauthStart(provider: 'google' | 'github', timeoutMs = 180_000): Promise<RelayPulseOAuthResult> {
    let resolveCb: (q: URLSearchParams) => void = () => undefined
    let rejectCb: (err: Error) => void = () => undefined
    const callbackPromise = new Promise<URLSearchParams>((resolve, reject) => {
      resolveCb = resolve
      rejectCb = reject
    })

    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (reqUrl.pathname !== '/oauth/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const providerLabel = provider === 'google' ? 'Google 账号登录' : 'GitHub 账号登录'
      const errParam = reqUrl.searchParams.get('error')
      if (errParam) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          renderAtriumOAuthPage({
            ok: false,
            title: '授权未完成',
            heading: '本次登录授权未完成',
            message: errParam,
            providerLabel,
          }),
        )
        rejectCb(new Error(errParam))
        return
      }
      if (reqUrl.searchParams.get('pending_token')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          renderAtriumOAuthPage({
            ok: true,
            title: '请返回 Atrium',
            heading: '授权验证通过',
            message: '请回到 Atrium 完成最后一步确认。',
            providerLabel,
          }),
        )
        resolveCb(reqUrl.searchParams)
        return
      }
      if (!reqUrl.searchParams.get('code')) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          renderAtriumOAuthPage({
            ok: false,
            title: '缺少授权码',
            heading: '未能读取到授权凭证',
            message: '请返回 Atrium 重新点击登录授权。',
            providerLabel,
          }),
        )
        rejectCb(new Error('未收到有效授权码'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        renderAtriumOAuthPage({
          ok: true,
          title: '登录成功',
          heading: '欢迎来到 Atrium',
          message: `已通过 ${provider === 'google' ? 'Google' : 'GitHub'} 完成登录与账号就绪，现在可以关闭此页面。`,
          providerLabel,
        }),
      )
      resolveCb(reqUrl.searchParams)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })

    const timer = setTimeout(() => {
      rejectCb(new Error('浏览器授权超时，请重试。'))
    }, timeoutMs)

    try {
      const port = (server.address() as { port: number }).port
      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`
      const startUrl = `${this.state.origin}/api/auth/oauth/${provider}?mode=desktop&redirect_uri=${encodeURIComponent(redirectUri)}`
      await this.openExternal(startUrl)

      const params = await callbackPromise
      const pendingToken = params.get('pending_token')
      if (pendingToken) {
        return {
          status: 'needs_email',
          pendingToken,
          provider,
          username: params.get('username') || undefined,
        }
      }

      const code = params.get('code')!
      const { status, data } = await this.requestJson<{
        success?: boolean
        user?: PortalUserPayload
        token?: string
        session_expires_at?: number
      }>('/api/auth/oauth/exchange', { method: 'POST', body: { code } })

      if (status >= 400 || !data.user || !data.token) {
        throw new Error(sanitizeUpstreamMessage(data.error || data.message || `OAuth 换取会话失败 (${status})`))
      }
      const state = await this.applyLoginResult(data.user, data.token, data.session_expires_at, true)
      void this.focusApp?.().catch(() => undefined)
      return { status: 'signed_in', state }
    } finally {
      clearTimeout(timer)
      server.close()
    }
  }

  async oauthBindEmail(req: { pendingToken: string; email: string; code: string }): Promise<RelayPulseAccountState> {
    const { status, data } = await this.requestJson<{
      success?: boolean
      user?: PortalUserPayload
      token?: string
      session_expires_at?: number
    }>('/api/auth/oauth/bind-email', {
      method: 'POST',
      body: {
        pending_token: req.pendingToken,
        email: req.email.trim().toLowerCase(),
        code: req.code.trim(),
      },
    })
    if (status >= 400 || !data.user || !data.token) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `绑定邮箱失败 (${status})`))
    }
    return this.applyLoginResult(data.user, data.token, data.session_expires_at, true)
  }

  private async applyLoginResult(
    user: PortalUserPayload,
    token: string | undefined,
    sessionExpiresAt: number | undefined,
    activateProvider: boolean,
  ): Promise<RelayPulseAccountState> {
    if (token) {
      await setSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME), token)
    }
    if (user.apiKey) {
      await setSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME), user.apiKey)
    }

    const apiKey = user.apiKey || (await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))) || ''
    const remoteSubs = normalizeCategorySubscriptionsMap(user.subscriptions)
    const mergedSubs = normalizeCategorySubscriptionsMap({
      ...(this.state.subscriptions ?? {}),
      ...(remoteSubs ?? {}),
    })
    const nextRemoteAvatar = user.avatar !== undefined ? (user.avatar ?? null) : (this.state.remoteAvatar ?? null)
    const nextAvatar = this.state.avatarCustom
      ? (this.state.avatar ?? null)
      : (nextRemoteAvatar ?? this.state.avatar ?? null)
    this.state = {
      ...this.state,
      connected: true,
      email: user.email || this.state.email,
      displayName: formatDisplayName(user, this.state.email) || this.state.displayName,
      oauthProvider: user.oauth_provider ?? this.state.oauthProvider ?? null,
      hasPassword: user.has_password !== undefined ? Boolean(user.has_password) : this.state.hasPassword,
      remoteAvatar: nextRemoteAvatar,
      avatar: nextAvatar,
      balanceCny: user.balance_cny ?? this.state.balanceCny,
      specialBalanceUsd: user.special_balance_usd ?? this.state.specialBalanceUsd,
      usedCny: user.used_cny ?? this.state.usedCny,
      todayUsedCny: user.today_used_cny ?? this.state.todayUsedCny,
      todayCalls: user.today_calls ?? this.state.todayCalls,
      keyGroup: user.key_group || user.group || this.state.keyGroup || CATEGORY_DEFAULT_KEY_GROUPS.gpt,
      subscription: mapSubscription(user.subscription),
      subscriptions: mergedSubs,
      sessionExpiresAt: sessionExpiresAt ?? this.state.sessionExpiresAt,
      sessionValid: token ? true : this.state.sessionValid,
      lastSyncedAt: Date.now(),
    }

    if (apiKey) {
      await this.syncManagedProvider(apiKey, activateProvider, false, activateProvider)
    } else {
      await this.persist()
    }
    return this.getState()
  }

  private async fetchModelsWithKey(apiKey: string): Promise<string[]> {
    try {
      const res = await netFetch(`${this.state.origin}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) return this.state.availableModels ?? []
      const body = (await res.json()) as { data?: Array<{ id?: string }> }
      const ids = Array.isArray(body.data)
        ? body.data.map((m) => (typeof m?.id === 'string' ? m.id.trim() : '')).filter(Boolean)
        : []
      return Array.from(new Set(ids)).slice(0, 120)
    } catch {
      return this.state.availableModels ?? []
    }
  }

  private async patchDefaultGroupQuietly(group: string, token: string): Promise<boolean> {
    try {
      const { status, data } = await this.requestJson<{ success?: boolean; item?: { group?: string } }>(
        '/api/user/keys/default',
        { method: 'PATCH', body: { group }, token },
      )
      if (status === 401) {
        this.state.sessionValid = false
        return false
      }
      if (status < 400) {
        this.state.keyGroup = data.item?.group || group
        return true
      }
    } catch {
      /* ignore silent route switch failures */
    }
    return false
  }

  private async fetchAllDefaultCategoryModels(apiKey: string, restoreModel?: string): Promise<string[]> {
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    if (!token) return this.fetchModelsWithKey(apiKey)

    const defaultGroups = Array.from(
      new Set([
        CATEGORY_DEFAULT_KEY_GROUPS.gpt,
        CATEGORY_DEFAULT_KEY_GROUPS.claude,
        CATEGORY_DEFAULT_KEY_GROUPS.gemini,
        CATEGORY_DEFAULT_KEY_GROUPS.deepseek,
        CATEGORY_DEFAULT_KEY_GROUPS.zhipu,
        CATEGORY_DEFAULT_KEY_GROUPS.kimi,
      ]),
    )
    const restoreGroup =
      (restoreModel ? getDefaultKeyGroupForModel(restoreModel) : null) ||
      (this.state.keyGroup && this.state.keyGroup !== 'gpt' ? this.state.keyGroup : CATEGORY_DEFAULT_KEY_GROUPS.gpt)

    const aggregated: string[] = []
    const seen = new Set<string>()
    for (const group of defaultGroups) {
      const switched = await this.patchDefaultGroupQuietly(group, token)
      if (!switched) continue
      const list = await this.fetchModelsWithKey(apiKey)
      for (const id of list) {
        if (!seen.has(id)) {
          seen.add(id)
          aggregated.push(id)
        }
      }
    }
    if (restoreGroup) {
      await this.patchDefaultGroupQuietly(restoreGroup, token)
    }
    if (aggregated.length > 0) return aggregated.slice(0, 160)
    return this.fetchModelsWithKey(apiKey)
  }

  private async syncManagedProvider(
    apiKey: string,
    activate: boolean,
    replaceModels = false,
    sweepAllCategories = false,
  ): Promise<void> {
    const existing =
      (this.state.providerId && this.settings.getProvider(this.state.providerId)) ||
      this.settings.listProviders().find((p) => p.managedBy === 'relaypulse')

    const models = sweepAllCategories
      ? await this.fetchAllDefaultCategoryModels(apiKey, existing?.model)
      : await this.fetchModelsWithKey(apiKey)
    this.state.availableModels = models

    const fetchedSet = new Set(models)
    const fetchedCategories = new Set(
      models.map((m) => classifyModelSubscriptionCategory(m)).filter(Boolean),
    )

    let nextModels: string[]
    if ((replaceModels && models.length > 0) || !existing?.models?.length) {
      nextModels = models
    } else if (models.length === 0) {
      nextModels = existing.models
    } else {
      // Replace stale/legacy-suffixed entries within the categories returned by this sync,
      // while keeping clean cached models from other categories intact.
      const hasStaleInFetchedCategory = existing.models.some((m) => {
        if (fetchedSet.has(m)) return false
        const cat = classifyModelSubscriptionCategory(m)
        return cat !== null && fetchedCategories.has(cat)
      })
      if (sweepAllCategories) {
        nextModels = models
      } else if (hasStaleInFetchedCategory) {
        const preservedOtherCats = existing.models.filter((m) => {
          const cat = classifyModelSubscriptionCategory(m)
          return cat === null || !fetchedCategories.has(cat)
        })
        nextModels = Array.from(new Set([...preservedOtherCats, ...models]))
      } else {
        const additions = models.filter((m) => !existing.models!.includes(m))
        nextModels = additions.length > 0 ? [...existing.models, ...additions] : existing.models
      }
    }

    const defaultModel =
      (existing?.model && (nextModels.length === 0 || nextModels.includes(existing.model)) ? existing.model : '') ||
      nextModels.find((m) => m.includes('gpt-6') || m.includes('gpt-5') || m.includes('claude')) ||
      nextModels[0] ||
      models[0] ||
      'gpt-5.4'

    const saved = await this.settings.saveProvider({
      ...(existing ? { id: existing.id } : {}),
      name: 'Atrium Cloud',
      protocol: 'openai',
      baseUrl: `${this.state.origin}/v1`,
      model: defaultModel,
      models: nextModels,
      managedBy: 'relaypulse',
      apiKey,
    })
    this.state.providerId = saved.id
    if (activate || !this.settings.get().activeProviderId) {
      await this.settings.update({ activeProviderId: saved.id })
    }
    await this.persist()
  }

  async refresh(): Promise<RelayPulseAccountState> {
    if (!this.state.connected) return this.getState()
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    if (token) {
      const { status, data } = await this.requestJson<{ user?: PortalUserPayload; session_expires_at?: number }>(
        '/api/user/profile',
        { token },
      )
      if (status === 200 && data.user) {
        return this.applyLoginResult(data.user, token, data.session_expires_at, false)
      }
      if (status === 401) {
        this.state.sessionValid = false
      }
    }

    // Fallback to API-key usage endpoint so balance stays visible even after 24h portal session expires
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    if (apiKey) {
      const { status, data } = await this.requestJson<{
        balance_cny?: number
        special_balance_usd?: number
        group?: string
        has_password?: boolean
        subscription?: PortalUserPayload['subscription']
      }>(`/api/user/usage?key=${encodeURIComponent(apiKey)}`)
      if (status === 200) {
        this.state = {
          ...this.state,
          balanceCny: data.balance_cny ?? this.state.balanceCny,
          specialBalanceUsd: data.special_balance_usd ?? this.state.specialBalanceUsd,
          keyGroup: data.group || this.state.keyGroup,
          hasPassword: data.has_password !== undefined ? Boolean(data.has_password) : this.state.hasPassword,
          subscription: data.subscription !== undefined ? mapSubscription(data.subscription) : this.state.subscription,
          subscriptions: normalizeCategorySubscriptionsMap(this.state.subscriptions),
          lastSyncedAt: Date.now(),
        }
      }
    }
    this.state.subscriptions = normalizeCategorySubscriptionsMap(this.state.subscriptions)
    await this.persist()
    return this.getState()
  }

  async syncModels(replaceModels = true): Promise<RelayPulseAccountState> {
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    if (!apiKey) throw new Error('尚未登录 Atrium 账号')
    await this.syncManagedProvider(apiKey, false, replaceModels, true)
    return this.getState()
  }

  async redeem(cardCode: string): Promise<{ ok: boolean; message: string; state: RelayPulseAccountState }> {
    const clean = cardCode.trim()
    if (!clean) throw new Error('请输入卡密')
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    const authToken = token || apiKey
    if (!authToken) throw new Error('请先登录账号')

    const { status, data } = await this.requestJson<{ success?: boolean; message?: string }>('/api/user/redeem', {
      method: 'POST',
      body: { code: clean },
      token: authToken,
    })
    if (status >= 400) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `兑换失败 (${status})`))
    }
    const nextState = await this.refresh()
    return { ok: true, message: sanitizeUpstreamMessage(data.message || '兑换成功！'), state: nextState }
  }

  private async fetchRemoteImageAsDataUrl(rawUrl: string): Promise<string | null> {
    try {
      const target = new URL(rawUrl, this.state.origin).href
      const res = await netFetch(target)
      if (!res.ok) return null
      const ctype = (res.headers.get('content-type') || 'image/png').split(';')[0]!.trim()
      if (!ctype.startsWith('image/')) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) return null
      return `data:${ctype};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }

  private async resolveQrImageDataUrl(opts: {
    qrImageData?: string
    qrImageUrl?: string
    qrCode?: string
    payUrl?: string
  }): Promise<string> {
    const embedded = (opts.qrImageData ?? '').trim()
    if (embedded.startsWith('data:image/')) return embedded

    const rawQr = (opts.qrCode || opts.payUrl || '').trim()
    if (rawQr.startsWith('data:image/')) return rawQr

    if (rawQr && /^https?:\/\/(?:.*\.(?:png|jpe?g|webp|gif)(?:\?.*)?$|.*\/qrcode\.php)/i.test(rawQr)) {
      const fetched = await this.fetchRemoteImageAsDataUrl(rawQr)
      if (fetched) return fetched
    }

    if (rawQr) {
      const svg = await QRCode.toString(rawQr, {
        type: 'svg',
        width: 240,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#18181b', light: '#ffffff' },
      })
      return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
    }

    if (opts.qrImageUrl) {
      const fetched = await this.fetchRemoteImageAsDataUrl(opts.qrImageUrl)
      if (fetched) return fetched
    }

    throw new Error('生成收款二维码失败，请稍后重试')
  }

  async createRechargeOrder(req: RechargeCreateOrderRequest): Promise<RechargeOrderInfo> {
    if (!this.isConnected()) {
      throw new Error('请先登录 Atrium 账号后再充值')
    }
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    const authToken = token || apiKey
    if (!authToken) {
      throw new Error('请先登录 Atrium 账号后再充值')
    }

    const payChannel = req.payChannel === 'alipay' ? 'alipay' : 'wxpay'
    const cny = Number(req.amountCny)
    if (!Number.isFinite(cny) || cny < 1 || cny > 50_000) {
      throw new Error('充值金额需在 ¥1 ~ ¥50,000 之间')
    }
    const roundedCny = Math.round(cny * 100) / 100

    const body: Record<string, unknown> = {
      pay_type: 'standard',
      pay_channel: payChannel,
      amount_cny: roundedCny,
    }

    const { status, data } = await this.requestJson<{
      success?: boolean
      order_id?: string
      out_trade_no?: string
      amount_cny?: number
      pay_cny?: number
      exchange_rate?: number
      qr_code?: string
      pay_url?: string
      qr_image?: string
      qr_image_data?: string
      pay_mode?: string
      pay_channel?: string
      pay_method?: string
      manual_confirmation?: boolean
      is_demo?: boolean
      message?: string
    }>('/api/pay/create-order', {
      method: 'POST',
      body,
      token: authToken,
    })

    if (status >= 400 || data.success === false) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `创建充值订单失败 (${status})`))
    }

    const outTradeNo = String(data.out_trade_no || data.order_id || '').trim()
    if (!outTradeNo) {
      throw new Error('创建充值订单失败：未返回订单号')
    }

    const qrImageDataUrl = await this.resolveQrImageDataUrl({
      qrImageData: data.qr_image_data,
      qrImageUrl: data.qr_image,
      qrCode: data.qr_code,
      payUrl: data.pay_url,
    })

    const payMode = String(data.pay_mode || data.pay_channel || payChannel)
    const manualConfirmation = Boolean(
      data.manual_confirmation || payMode === 'personal' || payMode === 'personal_qr',
    )

    return {
      outTradeNo,
      amountCny: Number(data.amount_cny ?? data.pay_cny ?? roundedCny),
      payCny: Number(data.pay_cny ?? data.amount_cny ?? roundedCny),
      ...(Number.isFinite(Number(data.exchange_rate)) ? { exchangeRate: Number(data.exchange_rate) } : {}),
      qrImageDataUrl,
      payMode,
      payChannel: String(data.pay_channel || payChannel),
      payMethod: String(data.pay_method || payChannel),
      manualConfirmation,
      ...(data.is_demo ? { isDemo: true } : {}),
      ...(data.message ? { message: sanitizeUpstreamMessage(String(data.message)) } : {}),
    }
  }

  async checkRechargeOrder(outTradeNo: string): Promise<RechargeOrderStatusResult> {
    const clean = outTradeNo.trim()
    if (!clean) throw new Error('订单号不能为空')
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    const authToken = token || apiKey

    const { status, data } = await this.requestJson<{
      paid?: boolean
      status?: string
      amount_cny?: number
    }>(`/api/pay/check-order?out_trade_no=${encodeURIComponent(clean)}`, {
      token: authToken,
    })

    if (status === 404) {
      return { outTradeNo: clean, paid: false, status: 'expired' }
    }
    if (status >= 400) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `查询订单状态失败 (${status})`))
    }

    const paid = Boolean(data.paid || data.status === 'paid')
    const amountCny = data.amount_cny !== undefined ? Number(data.amount_cny) : undefined

    if (paid) {
      const state = await this.refresh().catch(() => this.getState())
      return {
        outTradeNo: clean,
        paid: true,
        status: 'paid',
        ...(amountCny !== undefined && Number.isFinite(amountCny) ? { amountCny } : {}),
        state,
      }
    }

    const normalizedStatus: RechargeOrderStatusResult['status'] =
      data.status === 'submitted'
        ? 'submitted'
        : data.status === 'expired'
          ? 'expired'
          : data.status === 'amount_mismatch'
            ? 'amount_mismatch'
            : 'pending'

    return {
      outTradeNo: clean,
      paid: false,
      status: normalizedStatus,
      ...(amountCny !== undefined && Number.isFinite(amountCny) ? { amountCny } : {}),
    }
  }

  async reportRechargePaid(outTradeNo: string): Promise<{ ok: boolean; message: string }> {
    const clean = outTradeNo.trim()
    if (!clean) throw new Error('订单号不能为空')
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    const authToken = token || apiKey

    const { status, data } = await this.requestJson<{ success?: boolean; message?: string }>('/api/pay/report-paid', {
      method: 'POST',
      body: { out_trade_no: clean },
      token: authToken,
    })
    if (status >= 400 || data.success === false) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `提交付款确认失败 (${status})`))
    }
    return {
      ok: true,
      message: sanitizeUpstreamMessage(data.message || '已提交付款核账请求，系统正在确认入账'),
    }
  }

  async setKeyGroup(group: string): Promise<RelayPulseAccountState> {
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    if (!token) throw new Error('会话已过期，请重新登录账号后再切换分组')
    const { status, data } = await this.requestJson<{ success?: boolean; item?: { group?: string } }>(
      '/api/user/keys/default',
      { method: 'PATCH', body: { group }, token },
    )
    if (status === 401) {
      this.state.sessionValid = false
      await this.persist()
      throw new Error('会话已过期，请重新登录账号后再切换分组')
    }
    if (status >= 400) {
      throw new Error(sanitizeUpstreamMessage(data.error || data.message || `切换分组失败 (${status})`))
    }
    this.state.keyGroup = data.item?.group || group
    const apiKey = await getSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME))
    if (apiKey) {
      await this.syncManagedProvider(apiKey, false, true, false).catch(() => this.persist())
    } else {
      await this.persist()
    }
    return this.getState()
  }

  async ensureKeyGroupForModel(modelId: string): Promise<boolean> {
    if (!this.isConnected()) return false
    const targetGroup = getDefaultKeyGroupForModel(modelId)
    if (!targetGroup || this.state.keyGroup === targetGroup) return false
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    if (!token) return false
    const ok = await this.patchDefaultGroupQuietly(targetGroup, token)
    if (ok) await this.persist()
    return ok
  }

  async subscribeCategory(req: {
    category: SubscriptionCategory
    level: SubscriptionTierLevel
    switchKeyGroup?: boolean
  }): Promise<{ ok: boolean; message: string; source: 'remote' | 'atrium'; state: RelayPulseAccountState }> {
    if (!this.isConnected()) {
      throw new Error('请先登录 Atrium 官方账号后再开通订阅')
    }

    const plan = getCategoryPlan(req.category, req.level)
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))

    let source: 'remote' | 'atrium' = 'atrium'
    if (token) {
      try {
        const { status, data } = await this.requestJson<{ success?: boolean; subscription?: PortalUserPayload['subscription'] }>(
          '/api/user/subscribe',
          {
            method: 'POST',
            body: { tier: plan.id, category: req.category, level: req.level },
            token,
          },
        )
        if (status >= 200 && status < 300 && data.success !== false) {
          source = 'remote'
        }
      } catch {
        // Ignore network errors and manage category subscription locally in Atrium preview mode.
      }
    }

    const nowMs = Date.now()
    const currentSubs = normalizeCategorySubscriptionsMap(this.state.subscriptions, nowMs) ?? {}
    const prev = currentSubs[req.category]
    const prevActive = Boolean(prev?.active)
    const prevExpiresMs = prev ? Date.parse(prev.expiresAt) : NaN

    let startedAt = new Date(nowMs).toISOString()
    let expiresAt = new Date(nowMs + THIRTY_DAYS_MS).toISOString()
    let cycleResetAt = getNextMondayUtcIso(nowMs)
    let weeklyUsedUsd = 0
    let monthlyUsedUsd = 0

    if (prev && prevActive && Number.isFinite(prevExpiresMs)) {
      startedAt = prev.startedAt
      cycleResetAt = prev.cycleResetAt
      weeklyUsedUsd = prev.weeklyUsedUsd
      monthlyUsedUsd = prev.monthlyUsedUsd
      if (prev.level === req.level) {
        // Renewal (+30 days from existing expiry)
        expiresAt = new Date(prevExpiresMs + THIRTY_DAYS_MS).toISOString()
      } else {
        // Tier switch/upgrade preserves remaining window or extends to at least 30 days
        expiresAt = new Date(Math.max(prevExpiresMs, nowMs + THIRTY_DAYS_MS)).toISOString()
      }
    }

    const updatedEntry = normalizeCategorySubscription(
      {
        category: plan.category,
        level: plan.level,
        planId: plan.id,
        weeklyLimitUsd: plan.weeklyLimitUsd,
        monthlyLimitUsd: plan.monthlyLimitUsd,
        weeklyUsedUsd,
        monthlyUsedUsd,
        cycleResetAt,
        startedAt,
        expiresAt,
        source,
      },
      nowMs,
    )

    if (updatedEntry) {
      this.state.subscriptions = {
        ...currentSubs,
        [req.category]: updatedEntry,
      }
    }
    await this.persist()

    if (req.switchKeyGroup !== false && this.state.keyGroup !== plan.preferredKeyGroup && token) {
      const switched = await this.patchDefaultGroupQuietly(plan.preferredKeyGroup, token)
      if (switched) await this.persist()
    }

    const verb = prevActive ? (prev?.level === req.level ? '已续订' : '已切换为') : '已开通'
    const message =
      source === 'remote'
        ? `${verb} ${plan.name}（有效期 30 天）`
        : `${verb} ${plan.name}（本地测试订阅，不扣除钱包余额）`

    return {
      ok: true,
      message,
      source,
      state: this.getState(),
    }
  }

  async cancelCategorySubscription(category: SubscriptionCategory): Promise<RelayPulseAccountState> {
    if (!this.isConnected()) {
      throw new Error('尚未登录 Atrium 账号')
    }
    const current = { ...(normalizeCategorySubscriptionsMap(this.state.subscriptions) ?? {}) }
    delete current[category]
    this.state.subscriptions = Object.keys(current).length > 0 ? current : undefined
    await this.persist()
    return this.getState()
  }

  async setAvatar(avatar: string | null): Promise<RelayPulseAccountState> {
    if (!this.isConnected()) {
      throw new Error('尚未登录 Atrium 账号')
    }
    if (!isValidAvatarValue(avatar)) {
      throw new Error('头像图片格式不支持或体积过大')
    }
    if (avatar === null) {
      this.state.avatarCustom = false
      this.state.avatar = this.state.remoteAvatar ?? null
    } else {
      this.state.avatarCustom = true
      this.state.avatar = avatar.trim()
    }
    await this.persist()
    return this.getState()
  }

  async recordSubscriptionUsage(modelId: string, usage: TokenUsage): Promise<void> {
    if (!this.isConnected()) return
    if (!isModelEligibleForCategorySubscription(modelId, this.state.keyGroup)) return
    const category = classifyModelSubscriptionCategory(modelId, this.state.keyGroup)
    if (!category) return

    const nowMs = Date.now()
    const currentSubs = normalizeCategorySubscriptionsMap(this.state.subscriptions, nowMs)
    const entry = currentSubs?.[category]
    if (!entry || !entry.active) return

    const costUsd = estimateModelUsageCostUsd(modelId, usage, this.state.keyGroup)
    if (costUsd <= 0) return

    const nextEntry = normalizeCategorySubscription(
      {
        ...entry,
        weeklyUsedUsd: entry.weeklyUsedUsd + costUsd,
        monthlyUsedUsd: entry.monthlyUsedUsd + costUsd,
      },
      nowMs,
    )
    if (!nextEntry) return

    this.state.subscriptions = {
      ...currentSubs,
      [category]: nextEntry,
    }
    await this.persist()
  }

  async logout(): Promise<RelayPulseAccountState> {
    const token = await getSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME))
    if (token) {
      await this.requestJson('/api/auth/logout', { method: 'POST', token }).catch(() => undefined)
    }
    await setSecret(secretKey('account', ACCOUNT_ID, SESSION_SECRET_NAME), null)
    await setSecret(secretKey('account', ACCOUNT_ID, API_KEY_SECRET_NAME), null)

    const managed =
      (this.state.providerId && this.settings.getProvider(this.state.providerId)) ||
      this.settings.listProviders().find((p) => p.managedBy === 'relaypulse')
    if (managed) {
      await this.settings.removeProvider(managed.id)
    }

    this.state = {
      origin: RELAYPULSE_DEFAULT_ORIGIN,
      connected: false,
      stagingAgreementAccepted: false,
    }
    await removeFile(this.filePath())
    this.onChange(this.getState())
    return this.getState()
  }
}
