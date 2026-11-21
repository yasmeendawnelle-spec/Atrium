import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Camera,
  Cat,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Coins,
  Compass,
  CreditCard,
  Crown,
  Flame,
  KeyRound,
  Leaf,
  Lock,
  LogOut,
  Mail,
  QrCode,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Upload,
  Wallet,
  X,
} from 'lucide-react'
import {
  ALLOWED_EMAIL_DOMAINS,
  AVATAR_PRESETS,
  RELAYPULSE_PROD_ORIGIN,
  RELAYPULSE_STAGING_ORIGIN,
  SUBSCRIPTION_CATEGORY_SPECS,
  getAvatarPreset,
  getCategoryPlans,
  isAllowedWhitelistEmail,
  isStagingOrigin,
} from '@shared/relaypulse.ts'
import type {
  RechargeOrderInfo,
  RechargeOrderStatusResult,
  RechargePayChannel,
  RelayPulseAccountState,
  SubscriptionCategory,
  SubscriptionTierLevel,
} from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { closeAccountModal, setState, toast, useStore } from '../lib/store.ts'
import { Dialog } from './Dialog.tsx'
import { Oculus } from './Oculus.tsx'

function renderPresetIcon(presetId: string, size: number) {
  switch (presetId) {
    case 'ember':
      return <Flame size={size} strokeWidth={2} />
    case 'cat':
      return <Cat size={size} strokeWidth={2} />
    case 'ocean':
      return <Compass size={size} strokeWidth={2} />
    case 'sage':
      return <Leaf size={size} strokeWidth={2} />
    case 'plum':
      return <Sparkles size={size} strokeWidth={2} />
    default:
      return <Crown size={size} strokeWidth={2} />
  }
}

export function AccountAvatar({
  account,
  size = 'lg',
  overrideAvatar,
}: {
  account: Pick<RelayPulseAccountState, 'avatar' | 'displayName' | 'email'>
  size?: 'sm' | 'lg'
  overrideAvatar?: string | null
}) {
  const value = overrideAvatar !== undefined ? overrideAvatar : account.avatar
  const [imgBroken, setImgBroken] = useState(false)

  useEffect(() => {
    setImgBroken(false)
  }, [value])

  const preset = getAvatarPreset(value)
  const cls = size === 'sm' ? 'rp-side-avatar' : 'rp-avatar'
  const iconSize = size === 'sm' ? 12 : 18

  if (preset) {
    return (
      <span className={cls} style={{ background: preset.bg, color: preset.fg }} aria-hidden>
        {renderPresetIcon(preset.id, iconSize)}
      </span>
    )
  }

  if (value && !imgBroken) {
    return (
      <span className={`${cls} has-image`} aria-hidden>
        <img
          src={value}
          alt=""
          className="rp-avatar-img"
          onError={() => setImgBroken(true)}
        />
      </span>
    )
  }

  return (
    <span className={cls} aria-hidden>
      {(account.displayName || account.email)?.slice(0, 1).toUpperCase() || 'R'}
    </span>
  )
}

const MAX_RAW_AVATAR_BYTES = 12 * 1024 * 1024
const MAX_GIF_DIRECT_BYTES = 350 * 1024

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(file)
  })
}

async function processAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/') || file.size > MAX_RAW_AVATAR_BYTES) {
    throw new Error('INVALID_AVATAR_FILE')
  }
  const rawUrl = await readFileAsDataUrl(file)
  if (file.type === 'image/gif' && rawUrl.length <= MAX_GIF_DIRECT_BYTES) {
    return rawUrl
  }
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('INVALID_AVATAR_FILE'))
    el.src = rawUrl
  })
  const side = Math.min(img.naturalWidth || img.width, img.naturalHeight || img.height)
  if (!side) throw new Error('INVALID_AVATAR_FILE')
  const sx = Math.floor(((img.naturalWidth || img.width) - side) / 2)
  const sy = Math.floor(((img.naturalHeight || img.height) - side) / 2)
  const target = 192
  const canvas = document.createElement('canvas')
  canvas.width = target
  canvas.height = target
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('INVALID_AVATAR_FILE')
  ctx.drawImage(img, sx, sy, side, side, 0, 0, target, target)
  const webp = canvas.toDataURL('image/webp', 0.88)
  if (webp.startsWith('data:image/webp')) return webp
  return canvas.toDataURL('image/png')
}

type PlanTranslationId =
  | 'gpt_standard'
  | 'gpt_pro'
  | 'claude_standard'
  | 'claude_pro'
  | 'gemini_standard'
  | 'gemini_pro'
  | 'deepseek_standard'
  | 'deepseek_pro'
  | 'zhipu_standard'
  | 'zhipu_pro'
  | 'kimi_standard'
  | 'kimi_pro'

function asPlanKey(planId: string): PlanTranslationId {
  switch (planId) {
    case 'gpt_standard':
    case 'gpt_pro':
    case 'claude_standard':
    case 'claude_pro':
    case 'gemini_standard':
    case 'gemini_pro':
    case 'deepseek_standard':
    case 'deepseek_pro':
    case 'zhipu_standard':
    case 'zhipu_pro':
    case 'kimi_standard':
    case 'kimi_pro':
      return planId
    default:
      return 'gpt_standard'
  }
}

interface PendingOAuthState {
  pendingToken: string
  provider: 'google' | 'github'
  username?: string
}

function GoogleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  )
}

function GitHubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.17-.02-2.12-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .3.2.66.79.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  )
}

export function AccountAuthPanel({ onSuccess }: { onSuccess?: () => void }) {
  const { t } = useTranslation()
  const account = useStore((s) => s.account)
  const [authMode, setAuthMode] = useState<'code' | 'register' | 'password' | 'reset'>('code')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [busy, setBusy] = useState<'google' | 'github' | 'send' | 'submit' | 'bind' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingOAuth, setPendingOAuth] = useState<PendingOAuthState | null>(null)
  const [showOriginSwitch, setShowOriginSwitch] = useState(false)
  const [stagingModalOpen, setStagingModalOpen] = useState(false)
  const [stagingAgreed, setStagingAgreed] = useState(false)
  const [switchingOrigin, setSwitchingOrigin] = useState(false)
  const onStaging = isStagingOrigin(account.origin)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  const syncAfterLogin = async () => {
    const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
    setState({ providers, settings })
    toast(t('account.loginSuccessToast'))
    onSuccess?.()
  }

  const handleOAuth = async (provider: 'google' | 'github') => {
    setError(null)
    setBusy(provider)
    try {
      const res = await call('account.oauthStart', provider)
      if (res.status === 'needs_email') {
        setPendingOAuth({ pendingToken: res.pendingToken, provider: res.provider, username: res.username })
        setAuthMode('code')
        setError(null)
        return
      }
      setState({ account: res.state })
      await syncAfterLogin()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const handleSendCode = async () => {
    const clean = email.trim().toLowerCase()
    if (!clean || !clean.includes('@')) {
      setError(t('account.emailInvalid'))
      return
    }
    setError(null)
    setBusy('send')
    try {
      const res = await call('account.sendCode', clean)
      setCooldown(50)
      toast(res.message)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = email.trim().toLowerCase()
    if (!clean) {
      setError(t('account.emailRequired'))
      return
    }

    if (pendingOAuth) {
      if (!code.trim()) {
        setError(t('account.codeRequired'))
        return
      }
      setError(null)
      setBusy('bind')
      try {
        const next = await call('account.oauthBindEmail', {
          pendingToken: pendingOAuth.pendingToken,
          email: clean,
          code: code.trim(),
        })
        setPendingOAuth(null)
        setState({ account: next })
        await syncAfterLogin()
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setBusy(null)
      }
      return
    }

    if (authMode === 'register' || authMode === 'reset') {
      if (!code.trim()) {
        setError(t('account.codeRequired'))
        return
      }
      const trimmedPwd = newPassword.trim()
      if (trimmedPwd.length < 6 || trimmedPwd.length > 128) {
        setError(t('account.passwordLengthError'))
        return
      }
      if (trimmedPwd !== confirmPassword.trim()) {
        setError(t('account.passwordMismatch'))
        return
      }
      setError(null)
      setBusy('submit')
      try {
        if (authMode === 'register') {
          const next = await call('account.loginEmail', {
            email: clean,
            code: code.trim(),
            newPassword: trimmedPwd,
          })
          setState({ account: next })
          await syncAfterLogin()
        } else {
          const res = await call('account.resetPassword', {
            email: clean,
            code: code.trim(),
            newPassword: trimmedPwd,
          })
          setState({ account: res.state })
          const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
          setState({ providers, settings })
          toast(res.message)
          onSuccess?.()
        }
      } catch (err) {
        setError(errorMessage(err))
      } finally {
        setBusy(null)
      }
      return
    }

    if (authMode === 'password') {
      if (!password) {
        setError(t('account.passwordRequired'))
        return
      }
    } else if (!code.trim()) {
      setError(t('account.codeRequired'))
      return
    }

    setError(null)
    setBusy('submit')
    try {
      const next = await call('account.loginEmail', {
        email: clean,
        ...(authMode === 'code' ? { code: code.trim() } : { password }),
      })
      setState({ account: next })
      await syncAfterLogin()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const domainWarning =
    email.includes('@') && email.split('@')[1]?.includes('.') && !isAllowedWhitelistEmail(email)
      ? t('account.domainWarning', { domains: ALLOWED_EMAIL_DOMAINS.join(' / ') })
      : null

  const handleSwitchToProd = async () => {
    if (switchingOrigin || !onStaging) return
    setError(null)
    setSwitchingOrigin(true)
    try {
      const next = await call('account.setOrigin', RELAYPULSE_PROD_ORIGIN)
      setState({ account: next })
      setShowOriginSwitch(false)
      toast(t('account.routeSwitchedProdToast'))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSwitchingOrigin(false)
    }
  }

  const handleRequestStaging = () => {
    if (switchingOrigin || onStaging) return
    setStagingAgreed(false)
    setStagingModalOpen(true)
  }

  const handleConfirmStaging = async () => {
    if (!stagingAgreed || switchingOrigin) return
    setError(null)
    setSwitchingOrigin(true)
    try {
      const next = await call('account.setOrigin', RELAYPULSE_STAGING_ORIGIN, { acceptStagingRisk: true })
      setState({ account: next })
      setStagingModalOpen(false)
      setShowOriginSwitch(false)
      toast(t('account.routeSwitchedStagingToast'))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSwitchingOrigin(false)
    }
  }

  return (
    <div className="rp-auth-panel">
      {pendingOAuth ? (
        <div className="rp-pending-banner">
          <ShieldCheck size={16} />
          <div>
            <strong>{t('account.pendingBindTitle')}</strong>
            <p>
              {t('account.pendingBindDesc', {
                provider: pendingOAuth.provider === 'github' ? 'GitHub' : 'Google',
                username: pendingOAuth.username ? ` (${pendingOAuth.username})` : '',
              })}
            </p>
          </div>
          <button type="button" className="btn btn-small" onClick={() => setPendingOAuth(null)}>
            {t('account.backBtn')}
          </button>
        </div>
      ) : (
        <>
          <div className="rp-oauth-row">
            <button
              type="button"
              className="btn rp-oauth-btn"
              disabled={busy !== null}
              onClick={() => void handleOAuth('google')}
            >
              <GoogleIcon />
              <span>{busy === 'google' ? t('account.waitingOAuth') : t('account.googleBtn')}</span>
            </button>
            <button
              type="button"
              className="btn rp-oauth-btn"
              disabled={busy !== null}
              onClick={() => void handleOAuth('github')}
            >
              <GitHubIcon />
              <span>{busy === 'github' ? t('account.waitingOAuth') : t('account.githubBtn')}</span>
            </button>
          </div>
          <p className="rp-oauth-bonus-hint">
            <Sparkles size={12} aria-hidden />
            <span>{t('account.oauthBonusHint')}</span>
          </p>
          <div className="rp-divider">
            <span>{t('account.emailDivider')}</span>
          </div>
        </>
      )}

      <form className="rp-auth-form" onSubmit={(e) => void handleEmailSubmit(e)}>
        {!pendingOAuth && (
          authMode === 'reset' ? (
            <div className="rp-reset-head">
              <button
                type="button"
                className="rp-inline-link"
                onClick={() => {
                  setAuthMode('password')
                  setNewPassword('')
                  setConfirmPassword('')
                  setError(null)
                }}
              >
                <ArrowLeft size={12} />
                <span>{t('account.backToPasswordLogin')}</span>
              </button>
              <span className="rp-reset-title">{t('account.resetPasswordTitle')}</span>
            </div>
          ) : (
            <div className="seg rp-auth-seg rp-auth-seg-3" role="tablist" aria-label={t('account.authMethodAria')}>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'code'}
                className={`seg-btn${authMode === 'code' ? ' active' : ''}`}
                onClick={() => {
                  setAuthMode('code')
                  setNewPassword('')
                  setConfirmPassword('')
                  setError(null)
                }}
              >
                {t('account.modeCode')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'register'}
                className={`seg-btn${authMode === 'register' ? ' active' : ''}`}
                onClick={() => {
                  setAuthMode('register')
                  setNewPassword('')
                  setConfirmPassword('')
                  setError(null)
                }}
              >
                {t('account.modeRegister')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={authMode === 'password'}
                className={`seg-btn${authMode === 'password' ? ' active' : ''}`}
                onClick={() => {
                  setAuthMode('password')
                  setNewPassword('')
                  setConfirmPassword('')
                  setError(null)
                }}
              >
                {t('account.modePassword')}
              </button>
            </div>
          )
        )}

        <label className="field">
          <span>{t('account.emailLabel')}</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('account.emailPlaceholder')}
            autoComplete="email"
          />
        </label>
        <p className="rp-hint">
          {domainWarning ? (
            <span className="rp-warn">{domainWarning}</span>
          ) : (
            t('account.emailWhitelistHint')
          )}
        </p>

        {authMode === 'code' || authMode === 'register' || authMode === 'reset' || pendingOAuth ? (
          <>
            <div className="rp-code-row">
              <label className="field" style={{ flex: 1 }}>
                <span>{t('account.codeLabel')}</span>
                <input
                  className="input rp-code-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t('account.codePlaceholder')}
                  maxLength={8}
                  inputMode="numeric"
                />
              </label>
              <button
                type="button"
                className="btn rp-send-code-btn"
                disabled={busy !== null || cooldown > 0}
                onClick={() => void handleSendCode()}
              >
                <Mail size={14} />
                <span>
                  {cooldown > 0
                    ? t('account.retryAfter', { sec: cooldown })
                    : busy === 'send'
                      ? t('account.sendingCode')
                      : t('account.sendCode')}
                </span>
              </button>
            </div>

            {!pendingOAuth && (authMode === 'register' || authMode === 'reset') && (
              <>
                <label className="field">
                  <span>{t('account.newPasswordLabel')}</span>
                  <input
                    className="input"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('account.newPasswordPlaceholder')}
                    autoComplete="new-password"
                  />
                </label>
                <label className="field">
                  <span>{t('account.confirmPasswordLabel')}</span>
                  <input
                    className="input"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder={t('account.confirmPasswordPlaceholder')}
                    autoComplete="new-password"
                  />
                </label>
              </>
            )}
          </>
        ) : (
          <div className="field">
            <div className="rp-field-head">
              <label htmlFor="rp-login-password">{t('account.passwordLabel')}</label>
              <button
                type="button"
                className="rp-inline-link"
                onClick={() => {
                  setAuthMode('reset')
                  setPassword('')
                  setNewPassword('')
                  setConfirmPassword('')
                  setError(null)
                }}
              >
                {t('account.forgotOrSetPassword')}
              </button>
            </div>
            <input
              id="rp-login-password"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('account.passwordPlaceholder')}
              autoComplete="current-password"
            />
          </div>
        )}

        {error && (
          <div className="rp-alert-error" role="alert">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        <button type="submit" className="btn btn-primary rp-submit-btn" disabled={busy !== null}>
          {busy === 'submit' || busy === 'bind'
            ? t('account.submittingLogin')
            : pendingOAuth
              ? t('account.submitBind')
              : authMode === 'register'
                ? t('account.submitRegister')
                : authMode === 'reset'
                  ? t('account.submitReset')
                  : authMode === 'password'
                    ? t('account.submitPasswordLogin')
                    : t('account.submitLogin')}
        </button>

        <div className="rp-origin-foot">
          {account.connected ? (
            <span className="rp-origin-readonly">
              <span className={`rp-origin-dot${onStaging ? ' staging' : ''}`} aria-hidden />
              <span>
                {t('account.routeCurrent', {
                  label: onStaging ? t('account.routeStaging') : t('account.routeProd'),
                })}
              </span>
            </span>
          ) : (
            <button
              type="button"
              className="rp-origin-toggle"
              aria-expanded={showOriginSwitch}
              onClick={() => setShowOriginSwitch((v) => !v)}
            >
              <span className={`rp-origin-dot${onStaging ? ' staging' : ''}`} aria-hidden />
              <span>
                {t('account.routeCurrent', {
                  label: onStaging ? t('account.routeStaging') : t('account.routeProd'),
                })}
              </span>
              <ChevronDown size={13} className={`rp-origin-chev${showOriginSwitch ? ' open' : ''}`} />
            </button>
          )}
        </div>

        {!account.connected && showOriginSwitch && (
          <>
            <div className="seg rp-origin-seg" role="group" aria-label={t('account.routeSwitchAria')}>
              <button
                type="button"
                className={`seg-btn${!onStaging ? ' active' : ''}`}
                disabled={switchingOrigin}
                onClick={() => void handleSwitchToProd()}
              >
                {t('account.routeProdFull')}
              </button>
              <button
                type="button"
                className={`seg-btn${onStaging ? ' active' : ''}`}
                disabled={switchingOrigin}
                onClick={handleRequestStaging}
              >
                {!onStaging && <Lock size={11} aria-hidden />}
                <span>{t('account.routeStagingFull')}</span>
              </button>
            </div>
            <p className={`rp-origin-note${onStaging ? ' warn' : ''}`}>
              {onStaging ? t('account.routeStagingWarnHint') : t('account.routeStagingLockedHint')}
            </p>
          </>
        )}
      </form>

      {stagingModalOpen && (
        <Dialog
          title={t('account.stagingRiskTitle')}
          onClose={() => !switchingOrigin && setStagingModalOpen(false)}
        >
          <div className="rp-staging-risk-body">
            <div className="rp-staging-risk-callout">
              <AlertTriangle size={16} aria-hidden />
              <p>{t('account.stagingRiskLead')}</p>
            </div>

            <ol className="rp-staging-risk-list">
              <li>
                <strong>{t('account.stagingRiskItem1Title')}</strong>
                <p>{t('account.stagingRiskItem1Desc')}</p>
              </li>
              <li>
                <strong>{t('account.stagingRiskItem2Title')}</strong>
                <p>{t('account.stagingRiskItem2Desc')}</p>
              </li>
              <li>
                <strong>{t('account.stagingRiskItem3Title')}</strong>
                <p>{t('account.stagingRiskItem3Desc')}</p>
              </li>
            </ol>

            <label className="rp-staging-consent-check">
              <input
                type="checkbox"
                checked={stagingAgreed}
                disabled={switchingOrigin}
                onChange={(e) => setStagingAgreed(e.target.checked)}
              />
              <span>{t('account.stagingRiskCheckbox')}</span>
            </label>

            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={switchingOrigin}
                onClick={() => setStagingModalOpen(false)}
              >
                {t('account.stagingRiskStayProd')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!stagingAgreed || switchingOrigin}
                onClick={() => void handleConfirmStaging()}
              >
                {switchingOrigin ? t('account.stagingRiskSwitching') : t('account.stagingRiskConfirm')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  )
}

const CNY_RECHARGE_PRESETS = [10, 20, 50, 100, 200] as const

export function AccountStatusCard() {
  const { t } = useTranslation()
  const account = useStore((s) => s.account)
  const [cardCode, setCardCode] = useState('')
  const [busy, setBusy] = useState<
    | 'refresh'
    | 'redeem'
    | 'sync'
    | 'logout'
    | 'subscribe'
    | 'avatar'
    | 'recharge'
    | 'checkOrder'
    | 'reportPaid'
    | 'password'
    | null
  >(null)
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<SubscriptionCategory>('gpt')
  const [reauthOpen, setReauthOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [topUpOpen, setTopUpOpen] = useState(false)
  const [payChannel, setPayChannel] = useState<RechargePayChannel>('wxpay')
  const [amountInput, setAmountInput] = useState('50')
  const [activeOrder, setActiveOrder] = useState<RechargeOrderInfo | null>(null)
  const [orderStatus, setOrderStatus] = useState<RechargeOrderStatusResult['status'] | null>(null)
  const [topUpError, setTopUpError] = useState<string | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!account.connected || !topUpOpen || !activeOrder) return
    if (orderStatus === 'paid' || orderStatus === 'expired') return
    const outTradeNo = activeOrder.outTradeNo
    let cancelled = false
    const timer = setInterval(() => {
      void call('account.checkRechargeOrder', outTradeNo)
        .then((res) => {
          if (cancelled) return
          setOrderStatus(res.status)
          if (res.paid) {
            if (res.state) setState({ account: res.state })
            toast(t('account.topUpPaidToast', { amount: activeOrder.payCny.toFixed(2) }))
          }
        })
        .catch(() => undefined)
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [account.connected, topUpOpen, activeOrder, orderStatus, t])

  if (!account.connected) {
    return <AccountAuthPanel />
  }

  const handleRefresh = async () => {
    setBusy('refresh')
    try {
      const next = await call('account.refresh')
      await syncProviderState(next)
      toast(t('account.refreshSuccessToast'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!cardCode.trim()) return
    setBusy('redeem')
    try {
      const res = await call('account.redeem', cardCode.trim())
      setCardCode('')
      setState({ account: res.state })
      toast(res.message)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const syncProviderState = async (next: typeof account) => {
    const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
    setState({ account: next, providers, settings })
  }

  const handleSyncModels = async () => {
    setBusy('sync')
    try {
      const next = await call('account.syncModels')
      await syncProviderState(next)
      toast(t('account.syncSuccessToast', { count: next.availableModels?.length ?? 0 }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleLogout = async () => {
    setBusy('logout')
    try {
      const next = await call('account.logout')
      const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
      setState({ account: next, providers, settings })
      toast(t('account.logoutToast'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleSubscribeCategory = async (
    category: SubscriptionCategory,
    level: SubscriptionTierLevel,
    planId: string,
  ) => {
    const prevEntry = account.subscriptions?.[category]
    const prevActive = Boolean(prevEntry?.active)
    setBusy('subscribe')
    setBusyPlanId(planId)
    try {
      const res = await call('account.subscribeCategory', { category, level })
      setState({ account: res.state })
      const planKey = asPlanKey(planId)
      const verb = prevActive
        ? prevEntry?.level === level
          ? t('account.subVerbRenewed')
          : t('account.subVerbSwitched')
        : t('account.subVerbActivated')
      const note = res.source === 'remote' ? t('account.subNoteRemote') : t('account.subNoteLocal')
      toast(t('account.subUpdatedToast', { verb, name: t(`account.plans.${planKey}.name`), note }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
      setBusyPlanId(null)
    }
  }

  const handleCancelCategorySubscription = async (category: SubscriptionCategory) => {
    setBusy('subscribe')
    setBusyPlanId(`cancel:${category}`)
    try {
      const next = await call('account.cancelCategorySubscription', category)
      setState({ account: next })
      toast(t('account.subCanceledToast', { title: t(`account.categories.${category}.title`) }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
      setBusyPlanId(null)
    }
  }

  const handleSetAvatar = async (nextAvatar: string | null) => {
    setBusy('avatar')
    try {
      const next = await call('account.setAvatar', nextAvatar)
      setState({ account: next })
      toast(nextAvatar === null ? t('account.avatarResetToast') : t('account.avatarUpdatedToast'))
      setAvatarOpen(false)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy('avatar')
    try {
      const dataUrl = await processAvatarFile(file)
      const next = await call('account.setAvatar', dataUrl)
      setState({ account: next })
      toast(t('account.avatarUpdatedToast'))
      setAvatarOpen(false)
    } catch (err) {
      toast(err instanceof Error && err.message === 'INVALID_AVATAR_FILE' ? t('account.avatarInvalidFile') : errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const openTopUpFor = () => {
    setActiveOrder(null)
    setOrderStatus(null)
    setTopUpError(null)
    setTopUpOpen(true)
  }

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault()
    const num = Number(amountInput)
    if (!Number.isFinite(num) || num < 1 || num > 50_000) {
      setTopUpError(t('account.topUpInvalidAmount'))
      return
    }
    setTopUpError(null)
    setBusy('recharge')
    try {
      const order = await call('account.createRechargeOrder', {
        payChannel,
        amountCny: num,
      })
      setActiveOrder(order)
      setOrderStatus('pending')
    } catch (err) {
      setTopUpError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const handleCheckOrderNow = async () => {
    if (!activeOrder) return
    setBusy('checkOrder')
    setTopUpError(null)
    try {
      const res = await call('account.checkRechargeOrder', activeOrder.outTradeNo)
      setOrderStatus(res.status)
      if (res.paid) {
        if (res.state) setState({ account: res.state })
        toast(t('account.topUpPaidToast', { amount: activeOrder.payCny.toFixed(2) }))
      } else if (res.status === 'expired') {
        setTopUpError(t('account.topUpExpired'))
      } else if (res.status === 'amount_mismatch') {
        setTopUpError(t('account.topUpMismatch'))
      }
    } catch (err) {
      setTopUpError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const handleReportPaid = async () => {
    if (!activeOrder) return
    setBusy('reportPaid')
    setTopUpError(null)
    try {
      const res = await call('account.reportRechargePaid', activeOrder.outTradeNo)
      setOrderStatus('submitted')
      toast(res.message)
    } catch (err) {
      setTopUpError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (account.hasPassword && !oldPwd) {
      setPasswordError(t('account.passwordRequired'))
      return
    }
    const trimmed = newPwd.trim()
    if (trimmed.length < 6 || trimmed.length > 128) {
      setPasswordError(t('account.passwordLengthError'))
      return
    }
    if (trimmed !== confirmPwd.trim()) {
      setPasswordError(t('account.passwordMismatch'))
      return
    }
    setPasswordError(null)
    setBusy('password')
    try {
      const res = await call('account.updatePassword', {
        ...(account.hasPassword ? { oldPassword: oldPwd } : {}),
        newPassword: trimmed,
      })
      setState({ account: res.state })
      setOldPwd('')
      setNewPwd('')
      setConfirmPwd('')
      setPasswordOpen(false)
      toast(res.message)
    } catch (err) {
      setPasswordError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const hasRealEmail = Boolean(account.email && !account.email.endsWith('@oauth.rpulse.local'))

  const sub = account.subscription
  const categorySubs = account.subscriptions ?? {}
  const activeCategorySubs = SUBSCRIPTION_CATEGORY_SPECS.map((s) => categorySubs[s.id]).filter(
    (item): item is NonNullable<typeof item> => Boolean(item && item.active),
  )
  const selectedPlans = getCategoryPlans(selectedCategory)
  const activeInSelected = categorySubs[selectedCategory]?.active ? categorySubs[selectedCategory] : undefined

  return (
    <div className="rp-status-card">
      <div className="rp-status-head">
        <div className="rp-user-meta">
          <button
            type="button"
            className="rp-avatar-btn"
            onClick={() => setAvatarOpen((v) => !v)}
            disabled={busy !== null}
            aria-expanded={avatarOpen}
            title={t('account.changeAvatar')}
          >
            <AccountAvatar account={account} size="lg" />
            <span className="rp-avatar-cam" aria-hidden>
              <Camera size={11} />
            </span>
          </button>
          <div>
            <div className="rp-user-email">{account.displayName || account.email}</div>
            <div className="rp-user-sub">
              <span>
                {account.displayName && account.email && account.displayName !== account.email
                  ? account.email
                  : t('account.officialAccountBadge')}
              </span>
              <button
                type="button"
                className="rp-avatar-link"
                onClick={() => setAvatarOpen((v) => !v)}
                disabled={busy !== null}
              >
                {t('account.changeAvatar')}
              </button>
              {account.sessionValid === false && (
                <button type="button" className="rp-reauth-link" onClick={() => setReauthOpen((v) => !v)}>
                  {t('account.sessionExpiredReauth')}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="rp-head-actions">
          <button type="button" className="btn btn-small" onClick={() => void handleRefresh()} disabled={busy !== null}>
            <RefreshCw size={13} className={busy === 'refresh' ? 'spin' : ''} />
            <span>{t('account.refresh')}</span>
          </button>
          <button
            type="button"
            className={`btn btn-small${topUpOpen ? '' : ' btn-primary'}`}
            onClick={() => {
              if (topUpOpen) setTopUpOpen(false)
              else openTopUpFor()
            }}
            aria-expanded={topUpOpen}
          >
            <Wallet size={13} />
            <span>{t('account.topUpBtn')}</span>
          </button>
        </div>
      </div>

      {isStagingOrigin(account.origin) && (
        <div className="rp-staging-banner" role="status">
          <AlertTriangle size={14} aria-hidden />
          <span>{t('account.stagingActiveBanner')}</span>
        </div>
      )}

      {avatarOpen && (
        <div className="rp-avatar-tray">
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/*"
            className="sr-only"
            style={{ display: 'none' }}
            onChange={(e) => void handleAvatarFileChange(e)}
          />
          <div className="rp-avatar-tray-head">
            <span className="rp-avatar-tray-title">{t('account.avatarPresetsLabel')}</span>
            <span className="rp-avatar-tray-hint">{t('account.avatarUploadHint')}</span>
          </div>
          <div className="rp-avatar-tray-row">
            <div className="rp-avatar-presets">
              {AVATAR_PRESETS.map((preset) => {
                const value = `preset:${preset.id}`
                const active = account.avatar === value
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`rp-avatar-preset-btn${active ? ' active' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void handleSetAvatar(value)}
                    aria-label={preset.id}
                  >
                    <AccountAvatar account={account} size="lg" overrideAvatar={value} />
                  </button>
                )
              })}
            </div>
            <div className="rp-avatar-tray-actions">
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={busy !== null}
                onClick={() => avatarInputRef.current?.click()}
              >
                <Upload size={13} />
                <span>{t('account.uploadAvatar')}</span>
              </button>
              {(account.avatarCustom || account.avatar) && (
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy !== null}
                  onClick={() => void handleSetAvatar(null)}
                >
                  <RotateCcw size={13} />
                  <span>{t('account.resetAvatar')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {reauthOpen && (
        <div className="rp-reauth-box">
          <AccountAuthPanel onSuccess={() => setReauthOpen(false)} />
        </div>
      )}

      <div className="rp-wallet-grid">
        <div className="rp-wallet-tile">
          <div className="rp-wallet-tile-head">
            <span className="rp-wallet-label">
              <Coins size={13} /> {t('account.balanceCny')}
            </span>
            <button type="button" className="rp-wallet-add-btn" onClick={openTopUpFor}>
              + {t('account.topUpQuick')}
            </button>
          </div>
          <strong className="rp-wallet-val">
            {account.balanceCny === -1 ? t('account.unlimited') : `¥${Number(account.balanceCny ?? 0).toFixed(2)}`}
          </strong>
        </div>
        <div className="rp-wallet-tile">
          <span className="rp-wallet-label">{t('account.todayUsage')}</span>
          <strong className="rp-wallet-val">
            {t('account.todayCallsValue', {
              used: Number(account.todayUsedCny ?? 0).toFixed(2),
              calls: account.todayCalls ?? 0,
            })}
          </strong>
        </div>
      </div>

      {topUpOpen && (
        <section className="rp-topup-tray" aria-label={t('account.topUpTitle')}>
          <div className="rp-topup-head">
            <div className="rp-topup-title-wrap">
              <div className="rp-sub-section-title">
                <QrCode size={14} />
                <span>{t('account.topUpTitle')}</span>
              </div>
              <p className="rp-topup-sub">{t('account.topUpSubtitle')}</p>
            </div>
            <button
              type="button"
              className="rp-active-cancel-btn"
              onClick={() => setTopUpOpen(false)}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>

          {!activeOrder ? (
            <form className="rp-topup-form" onSubmit={(e) => void handleCreateOrder(e)}>
              <div className="rp-topup-field">
                <span className="rp-topup-label">{t('account.topUpAmountLabel')}</span>
                <div className="rp-topup-amounts">
                  {CNY_RECHARGE_PRESETS.map((amt) => {
                    const isActive = Number(amountInput) === amt
                    return (
                      <button
                        key={amt}
                        type="button"
                        className={`rp-amount-chip${isActive ? ' active' : ''}`}
                        onClick={() => {
                          setAmountInput(String(amt))
                          setTopUpError(null)
                        }}
                      >
                        {`¥${amt}`}
                      </button>
                    )
                  })}
                  <div className="rp-amount-custom">
                    <span className="rp-amount-prefix">¥</span>
                    <input
                      className="input rp-amount-input"
                      type="number"
                      min={1}
                      max={50_000}
                      step="0.01"
                      value={amountInput}
                      onChange={(e) => {
                        setAmountInput(e.target.value)
                        setTopUpError(null)
                      }}
                      placeholder={t('account.topUpCustomPlaceholder')}
                    />
                  </div>
                </div>
              </div>

              <div className="rp-topup-field">
                <span className="rp-topup-label">{t('account.topUpChannelLabel')}</span>
                <div className="rp-channel-grid" role="group" aria-label={t('account.topUpChannelLabel')}>
                  <button
                    type="button"
                    className={`rp-channel-btn wxpay${payChannel === 'wxpay' ? ' active' : ''}`}
                    onClick={() => setPayChannel('wxpay')}
                  >
                    <span className="rp-channel-dot wxpay" aria-hidden />
                    <span>{t('account.topUpWxpay')}</span>
                  </button>
                  <button
                    type="button"
                    className={`rp-channel-btn alipay${payChannel === 'alipay' ? ' active' : ''}`}
                    onClick={() => setPayChannel('alipay')}
                  >
                    <span className="rp-channel-dot alipay" aria-hidden />
                    <span>{t('account.topUpAlipay')}</span>
                  </button>
                </div>
              </div>

              {topUpError && (
                <div className="rp-alert-error" role="alert">
                  <AlertCircle size={14} />
                  <span>{topUpError}</span>
                </div>
              )}

              <div className="rp-topup-submit-row">
                <span className="rp-topup-tip">{t('account.topUpRedeemTip')}</span>
                <button type="submit" className="btn btn-primary btn-small" disabled={busy !== null}>
                  <QrCode size={13} />
                  <span>{busy === 'recharge' ? t('account.topUpCreatingBtn') : t('account.topUpCreateBtn')}</span>
                </button>
              </div>
            </form>
          ) : orderStatus === 'paid' ? (
            <div className="rp-topup-paid-box">
              <CheckCircle2 size={30} className="rp-topup-paid-icon" />
              <strong>{t('account.topUpPaidTitle')}</strong>
              <span className="rp-topup-paid-meta">{`¥${activeOrder.payCny.toFixed(2)}`}</span>
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => {
                  setTopUpOpen(false)
                  setActiveOrder(null)
                  setOrderStatus(null)
                }}
              >
                {t('account.topUpDoneBtn')}
              </button>
            </div>
          ) : (
            <div className="rp-topup-checkout">
              <div className="rp-topup-qr-frame">
                <img
                  src={activeOrder.qrImageDataUrl}
                  alt={activeOrder.payMethod === 'wxpay' ? t('account.topUpWxpay') : t('account.topUpAlipay')}
                  className="rp-topup-qr-img"
                />
              </div>
              <div className="rp-topup-order-info">
                <div className="rp-topup-meta-row">
                  <span>{t('account.topUpAmountDue')}</span>
                  <strong className="rp-topup-due-val">¥{activeOrder.payCny.toFixed(2)}</strong>
                </div>
                <div className="rp-topup-meta-row">
                  <span>{t('account.topUpChannelLabel')}</span>
                  <span>{activeOrder.payMethod === 'wxpay' ? t('account.topUpWxpay') : t('account.topUpAlipay')}</span>
                </div>
                <div className="rp-topup-meta-row">
                  <span>{t('account.topUpOrderNo')}</span>
                  <span className="mono">{activeOrder.outTradeNo}</span>
                </div>

                <p className="rp-topup-scan-tip">
                  {activeOrder.manualConfirmation
                    ? t('account.topUpScanPersonal', { amount: activeOrder.payCny.toFixed(2) })
                    : activeOrder.payMethod === 'wxpay'
                      ? t('account.topUpScanWxpay')
                      : t('account.topUpScanAlipay')}
                </p>

                <div className={`rp-topup-poll-line${orderStatus === 'submitted' ? ' submitted' : ''}`}>
                  <Clock size={12} />
                  <span>
                    {orderStatus === 'submitted'
                      ? t('account.topUpSubmitted')
                      : orderStatus === 'expired'
                        ? t('account.topUpExpired')
                        : orderStatus === 'amount_mismatch'
                          ? t('account.topUpMismatch')
                          : t('account.topUpPolling')}
                  </span>
                </div>

                {topUpError && (
                  <div className="rp-alert-error" role="alert">
                    <AlertCircle size={14} />
                    <span>{topUpError}</span>
                  </div>
                )}

                <div className="rp-topup-order-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy !== null}
                    onClick={() => {
                      setActiveOrder(null)
                      setOrderStatus(null)
                      setTopUpError(null)
                    }}
                  >
                    <ArrowLeft size={13} />
                    <span>{t('account.topUpBackToForm')}</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy !== null}
                    onClick={() => void handleCheckOrderNow()}
                  >
                    <RefreshCw size={13} className={busy === 'checkOrder' ? 'spin' : ''} />
                    <span>{t('account.topUpCheckNow')}</span>
                  </button>
                  {activeOrder.manualConfirmation && (
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={busy !== null}
                      onClick={() => void handleReportPaid()}
                    >
                      <Check size={13} />
                      <span>{busy === 'reportPaid' ? t('account.topUpReportingBtn') : t('account.topUpReportPaid')}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {sub && sub.active && (
        <div className="rp-sub-bar-wrap">
          <div className="rp-sub-bar-head">
            <span>{t('account.legacySubTitle', { name: sub.name })}</span>
            <span>
              {t('account.weeklyRemainingPct', { pct: sub.remainingPercent })}
              {sub.daysRemaining !== null ? t('account.daysRemainingSuffix', { days: sub.daysRemaining }) : ''}
            </span>
          </div>
          <div className="rp-sub-bar">
            <div className="rp-sub-bar-fill" style={{ width: `${Math.max(4, sub.remainingPercent)}%` }} />
          </div>
        </div>
      )}

      <section className="rp-sub-section" aria-label={t('account.sectionTitle')}>
        <div className="rp-sub-section-head">
          <div className="rp-sub-section-title">
            <Crown size={14} />
            <span>{t('account.sectionTitle')}</span>
            <span className="rp-sub-count-pill">
              {activeCategorySubs.length > 0
                ? t('account.activeCountPill', { count: activeCategorySubs.length })
                : t('account.multiZoneHint')}
            </span>
          </div>
          <span className="rp-sub-reset-hint">{t('account.resetHint')}</span>
        </div>

        {activeCategorySubs.length > 0 && (
          <div className="rp-active-sub-grid">
            {activeCategorySubs.map((entry) => {
              const planKey = asPlanKey(entry.planId)
              const localizedName = t(`account.plans.${planKey}.name`)
              const categoryTitle = t(`account.categories.${entry.category}.title`)
              return (
                <div key={entry.category} className="rp-active-sub-card">
                  <div className="rp-active-sub-top">
                    <div className="rp-active-sub-name">
                      <strong>{localizedName}</strong>
                      <span className={`rp-sub-source-chip${entry.source === 'remote' ? ' remote' : ''}`}>
                        {entry.source === 'remote' ? t('account.sourceRemote') : t('account.sourceAtrium')}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="rp-active-cancel-btn"
                      onClick={() => void handleCancelCategorySubscription(entry.category)}
                      disabled={busy !== null}
                      title={t('account.cancelCategoryTitle', { title: categoryTitle })}
                      aria-label={t('account.cancelCategoryAria', { name: localizedName })}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  <div className="rp-sub-bar-head">
                    <span>{t('account.weeklyRemainingLabel')}</span>
                    <span>
                      {t('account.pctDaysLeft', {
                        pct: entry.remainingPercent,
                        days: entry.daysRemaining ?? 0,
                      })}
                    </span>
                  </div>
                  <div className="rp-sub-bar">
                    <div className="rp-sub-bar-fill" style={{ width: `${Math.max(4, entry.remainingPercent)}%` }} />
                  </div>
                  <div className="rp-active-sub-foot">
                    <span className="rp-active-sub-exp">
                      {t('account.expiresOn', { date: entry.expiresAtFormatted })}
                    </span>
                    <span className="rp-active-sub-exp">{t('account.monthlyStatusNote')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="rp-cat-tabs" role="tablist" aria-label={t('account.tabsAria')}>
          {SUBSCRIPTION_CATEGORY_SPECS.map((spec) => {
            const selected = spec.id === selectedCategory
            const hasActive = Boolean(categorySubs[spec.id]?.active)
            return (
              <button
                key={spec.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`rp-cat-tab${selected ? ' active' : ''}${hasActive ? ' subscribed' : ''}`}
                onClick={() => setSelectedCategory(spec.id)}
              >
                <span>{t(`account.categories.${spec.id}.shortName`)}</span>
                {hasActive && <span className="rp-cat-tab-dot" aria-label={t('account.currentActiveBadge')} />}
              </button>
            )
          })}
        </div>

        <div className="rp-cat-meta">
          <div className="rp-cat-meta-title">
            <strong>{t(`account.categories.${selectedCategory}.title`)}</strong>
            <span className="rp-cat-meta-note">{t('account.weeklyCycleNote')}</span>
          </div>
          <p className="rp-cat-meta-desc">{t(`account.categories.${selectedCategory}.tagline`)}</p>
        </div>

        <div className="rp-plan-grid">
          {selectedPlans.map((plan) => {
            const planKey = asPlanKey(plan.id)
            const isCurrentPlan = activeInSelected?.planId === plan.id
            const hasOtherTier = Boolean(activeInSelected && activeInSelected.planId !== plan.id)
            const actionLabel = isCurrentPlan
              ? t('account.actionRenew')
              : hasOtherTier
                ? plan.level === 'pro'
                  ? t('account.actionUpgrade')
                  : t('account.actionDowngrade')
                : t('account.actionSubscribe')
            const isPlanBusy = busy === 'subscribe' && busyPlanId === plan.id
            const badgeText = plan.level === 'pro' ? t('account.badgePro') : t('account.badgeStandard')
            const highlights = [
              t(`account.plans.${planKey}.h1`),
              t(`account.plans.${planKey}.h2`),
              t(`account.plans.${planKey}.h3`),
            ]

            return (
              <div
                key={plan.id}
                className={`rp-plan-card${plan.level === 'pro' ? ' pro' : ''}${isCurrentPlan ? ' active' : ''}`}
              >
                <div className="rp-plan-head">
                  <div className="rp-plan-title-row">
                    <strong>{t(`account.plans.${planKey}.name`)}</strong>
                    <span className="rp-plan-badge">{badgeText}</span>
                  </div>
                  {isCurrentPlan && <span className="rp-plan-current-tag">{t('account.currentActiveBadge')}</span>}
                </div>

                <div className="rp-plan-price-row">
                  <span className="rp-plan-price">¥{plan.priceCny.toFixed(1)}</span>
                  <span className="rp-plan-period">{t('account.per30Days')}</span>
                </div>

                <ul className="rp-plan-list">
                  {highlights.map((item) => (
                    <li key={item}>
                      <Check size={12} />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>

                <div className="rp-plan-actions">
                  <button
                    type="button"
                    className={`btn btn-small ${isCurrentPlan || plan.level === 'pro' ? 'btn-primary' : ''}`}
                    disabled={busy !== null}
                    onClick={() => void handleSubscribeCategory(plan.category, plan.level, plan.id)}
                  >
                    <span>{isPlanBusy ? t('account.actionProcessing') : actionLabel}</span>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <form className="rp-redeem-form" onSubmit={(e) => void handleRedeem(e)}>
        <label className="field" style={{ flex: 1 }}>
          <span className="rp-field-label">
            <CreditCard size={13} />
            {t('account.redeemLabel')}
          </span>
          <input
            className="input"
            value={cardCode}
            onChange={(e) => setCardCode(e.target.value)}
            placeholder={t('account.redeemPlaceholder')}
          />
        </label>
        <button type="submit" className="btn btn-primary rp-redeem-btn" disabled={busy !== null || !cardCode.trim()}>
          <Check size={13} />
          <span>{busy === 'redeem' ? t('account.redeemingBtn') : t('account.redeemBtn')}</span>
        </button>
      </form>

      {passwordOpen && hasRealEmail && (
        <section className="rp-password-tray" aria-label={account.hasPassword ? t('account.changePasswordTitle') : t('account.setPasswordTitle')}>
          <div className="rp-topup-head">
            <div className="rp-topup-title-wrap">
              <div className="rp-sub-section-title">
                <KeyRound size={14} />
                <span>{account.hasPassword ? t('account.changePasswordTitle') : t('account.setPasswordTitle')}</span>
              </div>
              <p className="rp-topup-sub">
                {account.hasPassword ? t('account.changePasswordSub') : t('account.setPasswordSub')}
              </p>
            </div>
            <button
              type="button"
              className="rp-active-cancel-btn"
              onClick={() => {
                setPasswordOpen(false)
                setPasswordError(null)
              }}
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
          <form className="rp-password-form" onSubmit={(e) => void handleSavePassword(e)}>
            <div className="rp-password-grid">
              {account.hasPassword && (
                <label className="field">
                  <span>{t('account.oldPasswordLabel')}</span>
                  <input
                    className="input"
                    type="password"
                    value={oldPwd}
                    onChange={(e) => setOldPwd(e.target.value)}
                    placeholder={t('account.oldPasswordPlaceholder')}
                    autoComplete="current-password"
                  />
                </label>
              )}
              <label className="field">
                <span>{t('account.newPasswordLabel')}</span>
                <input
                  className="input"
                  type="password"
                  value={newPwd}
                  onChange={(e) => setNewPwd(e.target.value)}
                  placeholder={t('account.newPasswordPlaceholder')}
                  autoComplete="new-password"
                />
              </label>
              <label className="field">
                <span>{t('account.confirmPasswordLabel')}</span>
                <input
                  className="input"
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  placeholder={t('account.confirmPasswordPlaceholder')}
                  autoComplete="new-password"
                />
              </label>
            </div>
            {passwordError && (
              <div className="rp-alert-error" role="alert">
                <AlertCircle size={14} />
                <span>{passwordError}</span>
              </div>
            )}
            <div className="dialog-actions" style={{ paddingTop: 0 }}>
              <button type="submit" className="btn btn-small btn-primary" disabled={busy !== null}>
                <Check size={13} />
                <span>{busy === 'password' ? t('account.savingPasswordBtn') : t('account.savePasswordBtn')}</span>
              </button>
            </div>
          </form>
        </section>
      )}

      <div className="rp-foot-actions">
        <button type="button" className="btn btn-small" onClick={() => void handleSyncModels()} disabled={busy !== null}>
          <RefreshCw size={13} className={busy === 'sync' ? 'spin' : ''} />
          <span>{t('account.syncModelsBtn', { count: account.availableModels?.length ?? 0 })}</span>
        </button>
        {hasRealEmail && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setPasswordOpen((v) => !v)
              setPasswordError(null)
            }}
            disabled={busy !== null}
            aria-expanded={passwordOpen}
          >
            <KeyRound size={13} />
            <span>{account.hasPassword ? t('account.changePasswordBtn') : t('account.setPasswordBtn')}</span>
          </button>
        )}
        <button type="button" className="btn btn-small danger" onClick={() => void handleLogout()} disabled={busy !== null}>
          <LogOut size={13} />
          <span>{t('account.logoutBtn')}</span>
        </button>
      </div>
    </div>
  )
}

export function AccountGateView() {
  const { t } = useTranslation()
  return (
    <div className="onboarding rp-gate">
      <div className="drag-strip drag" />
      <div className="onboarding-card rp-gate-card">
        <div className="onboarding-hero rp-gate-hero">
          <span className="brand-badge rp-gate-badge">
            <Oculus state="idle" size={24} />
          </span>
          <div className="rp-gate-copy">
            <h1 className="display">{t('account.gateTitle')}</h1>
            <p className="onboarding-sub">{t('account.gateSub')}</p>
          </div>
        </div>
        <AccountAuthPanel />
      </div>
    </div>
  )
}

export function AccountModal() {
  const { t } = useTranslation()
  const open = useStore((s) => s.accountModalOpen)
  const account = useStore((s) => s.account)
  if (!open) return null
  return (
    <Dialog
      title={account.connected ? t('account.modalTitleConnected') : t('account.modalTitleDisconnected')}
      onClose={closeAccountModal}
      wide
    >
      <AccountStatusCard />
    </Dialog>
  )
}
