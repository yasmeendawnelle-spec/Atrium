import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronRight, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { SandboxMode } from '@shared/types.ts'
import type { PolicyDecision, PolicyInspection, ProjectPolicyConfig } from '@shared/studio_features.ts'
import { call, errorMessage } from '../lib/api.ts'
import { closePolicyModal, toast, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { folderName } from './WorkspacePicker.tsx'

interface PolicyFormState {
  protectMode: 'inherit' | 'on' | 'off'
  denyReadText: string
  allowReadText: string
  denyWriteText: string
  allowWriteText: string
  denyCommandsText: string
  allowCommandsText: string
  sandboxMode: '' | SandboxMode
  allowNetwork: 'inherit' | 'allow' | 'deny'
}

function toLines(arr?: string[]): string {
  return (arr ?? []).join('\n')
}

function fromLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function configToForm(cfg: ProjectPolicyConfig): PolicyFormState {
  return {
    protectMode: cfg.protectSensitiveFiles === true ? 'on' : cfg.protectSensitiveFiles === false ? 'off' : 'inherit',
    denyReadText: toLines(cfg.denyRead),
    allowReadText: toLines(cfg.allowRead),
    denyWriteText: toLines(cfg.denyWrite),
    allowWriteText: toLines(cfg.allowWrite),
    denyCommandsText: toLines(cfg.denyCommands),
    allowCommandsText: toLines(cfg.allowCommands),
    sandboxMode: cfg.sandboxMode ?? '',
    allowNetwork: cfg.allowNetwork === true ? 'allow' : cfg.allowNetwork === false ? 'deny' : 'inherit',
  }
}

function formToConfig(form: PolicyFormState): ProjectPolicyConfig {
  const out: ProjectPolicyConfig = { version: 1 }
  if (form.protectMode === 'on') out.protectSensitiveFiles = true
  else if (form.protectMode === 'off') out.protectSensitiveFiles = false

  const denyRead = fromLines(form.denyReadText)
  if (denyRead.length) out.denyRead = denyRead
  const allowRead = fromLines(form.allowReadText)
  if (allowRead.length) out.allowRead = allowRead
  const denyWrite = fromLines(form.denyWriteText)
  if (denyWrite.length) out.denyWrite = denyWrite
  const allowWrite = fromLines(form.allowWriteText)
  if (allowWrite.length) out.allowWrite = allowWrite
  const denyCommands = fromLines(form.denyCommandsText)
  if (denyCommands.length) out.denyCommands = denyCommands
  const allowCommands = fromLines(form.allowCommandsText)
  if (allowCommands.length) out.allowCommands = allowCommands
  if (form.sandboxMode) out.sandboxMode = form.sandboxMode
  if (form.allowNetwork === 'allow') out.allowNetwork = true
  else if (form.allowNetwork === 'deny') out.allowNetwork = false
  return out
}

export function PolicyModal() {
  const ft = useFeatureText()
  const chats = useStore((s) => s.chats)
  const activeChatId = useStore((s) => s.activeChatId)
  const settings = useStore((s) => s.settings)

  const activeMeta = chats.find((c) => c.id === activeChatId)
  const workspace = activeMeta?.worktreeBaseWorkspace ?? activeMeta?.workspace ?? settings?.workspace

  const [scope, setScope] = useState<'project' | 'local'>('project')
  const [inspection, setInspection] = useState<PolicyInspection | null>(null)
  const [form, setForm] = useState<PolicyFormState>(() => configToForm({}))
  const [showDefaults, setShowDefaults] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testPath, setTestPath] = useState('.env')
  const [testResult, setTestResult] = useState<{ op: 'read' | 'write'; decision: PolicyDecision } | null>(null)

  const loadPolicy = useCallback(
    async (targetScope: 'project' | 'local') => {
      if (!workspace) {
        setInspection(null)
        return
      }
      try {
        const res = await call('policy.inspect', workspace)
        setInspection(res)
        setForm(configToForm(targetScope === 'local' ? res.localConfig : res.projectConfig))
      } catch (err) {
        toast(errorMessage(err), 'error')
      }
    },
    [workspace],
  )

  useEffect(() => {
    void loadPolicy(scope)
  }, [loadPolicy, scope])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePolicyModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const switchScope = (nextScope: 'project' | 'local') => {
    setScope(nextScope)
    if (inspection) {
      setForm(configToForm(nextScope === 'local' ? inspection.localConfig : inspection.projectConfig))
    }
  }

  const handleSave = async () => {
    if (!workspace || saving) return
    setSaving(true)
    try {
      const next = await call('policy.save', workspace, scope, formToConfig(form))
      setInspection(next)
      setForm(configToForm(scope === 'local' ? next.localConfig : next.projectConfig))
      toast(ft('policy.savedToast'))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const runCheckPath = async (op: 'read' | 'write') => {
    if (!workspace || !testPath.trim()) return
    try {
      const decision = await call('policy.checkPath', workspace, testPath.trim(), op)
      setTestResult({ op, decision })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && closePolicyModal()}>
      <div className="feature-modal" role="dialog" aria-modal="true" aria-label={ft('policy.title')}>
        <header className="feature-modal-head">
          <div className="feature-modal-title-wrap">
            <span className="feature-modal-ico">
              <ShieldCheck size={17} />
            </span>
            <div>
              <h2 className="feature-modal-title">{ft('policy.title')}</h2>
              <p className="feature-modal-sub">
                {workspace ? `${folderName(workspace) ?? workspace} · ` : ''}
                {ft('policy.subtitle')}
              </p>
            </div>
          </div>
          <div className="feature-modal-head-acts">
            <button type="button" className="icon-btn" onClick={closePolicyModal} aria-label={ft('fleet.close')}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="feature-modal-body">
          {!workspace ? (
            <div className="feature-banner warn">{ft('policy.noWorkspace')}</div>
          ) : (
            <>
              {inspection && (
                <div className={`feature-banner ${inspection.protectSensitiveFiles ? 'ok' : 'warn'}`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600 }}>
                    {inspection.protectSensitiveFiles ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
                    <span>{inspection.protectSensitiveFiles ? ft('policy.shieldActive') : ft('policy.shieldPaused')}</span>
                  </span>
                  <span className="small">{ft('policy.rulesCount', { count: inspection.activeRuleCount })}</span>
                </div>
              )}

              {inspection?.projectFile.parseError && (
                <div className="feature-banner err">
                  {ft('policy.parseError', { file: '.atrium/policy.json', error: inspection.projectFile.parseError })}
                </div>
              )}
              {inspection?.localFile.parseError && (
                <div className="feature-banner err">
                  {ft('policy.parseError', { file: '.atrium/policy.local.json', error: inspection.localFile.parseError })}
                </div>
              )}

              <div className="policy-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'project'}
                  className={`policy-tab${scope === 'project' ? ' active' : ''}`}
                  onClick={() => switchScope('project')}
                >
                  {ft('policy.scopeProject')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'local'}
                  className={`policy-tab${scope === 'local' ? ' active' : ''}`}
                  onClick={() => switchScope('local')}
                >
                  {ft('policy.scopeLocal')}
                </button>
              </div>

              {inspection && (
                <div className="policy-defaults-box">
                  <button
                    type="button"
                    className="browser-refs-head"
                    onClick={() => setShowDefaults((v) => !v)}
                    aria-expanded={showDefaults}
                  >
                    {showDefaults ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span>
                      {showDefaults
                        ? ft('policy.hideDefaults')
                        : ft('policy.showDefaults', { count: inspection.defaultSensitiveGlobs.length })}
                    </span>
                  </button>
                  {showDefaults && (
                    <>
                      <div className="policy-glob-grid">
                        {inspection.defaultSensitiveGlobs.map((g) => (
                          <code key={g} className="policy-glob-chip">
                            {g}
                          </code>
                        ))}
                      </div>
                      <div className="small muted">{ft('policy.safeExceptions')}</div>
                      <div className="policy-glob-grid">
                        {inspection.defaultSafeExceptions.map((g) => (
                          <code key={g} className="policy-glob-chip safe">
                            {g}
                          </code>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              <div className="policy-fields-grid">
                <div className="policy-field">
                  <label htmlFor="policy-protect-mode">{ft('policy.protectDefaultLabel')}</label>
                  <select
                    id="policy-protect-mode"
                    className="policy-select"
                    value={form.protectMode}
                    onChange={(e) => setForm((f) => ({ ...f, protectMode: e.target.value as PolicyFormState['protectMode'] }))}
                  >
                    <option value="inherit">
                      {ft('policy.protectInherit', {
                        state: (inspection?.protectSensitiveFiles ?? true) ? ft('policy.enabledText') : ft('policy.disabledText'),
                      })}
                    </option>
                    <option value="on">{ft('policy.protectOn')}</option>
                    <option value="off">{ft('policy.protectOff')}</option>
                  </select>
                </div>

                <div className="policy-field">
                  <label htmlFor="policy-sandbox">{ft('policy.sandboxFloor')}</label>
                  <select
                    id="policy-sandbox"
                    className="policy-select"
                    value={form.sandboxMode}
                    onChange={(e) => setForm((f) => ({ ...f, sandboxMode: e.target.value as PolicyFormState['sandboxMode'] }))}
                  >
                    <option value="">{ft('policy.sandboxInherit')}</option>
                    <option value="off">{ft('policy.sandboxOff')}</option>
                    <option value="workspace_write">{ft('policy.sandboxWorkspace')}</option>
                    <option value="read_only">{ft('policy.sandboxReadOnly')}</option>
                  </select>
                </div>

                <div className="policy-field">
                  <label htmlFor="policy-network">{ft('policy.networkAccess')}</label>
                  <select
                    id="policy-network"
                    className="policy-select"
                    value={form.allowNetwork}
                    onChange={(e) => setForm((f) => ({ ...f, allowNetwork: e.target.value as PolicyFormState['allowNetwork'] }))}
                  >
                    <option value="inherit">{ft('policy.networkInherit')}</option>
                    <option value="allow">{ft('policy.networkAllow')}</option>
                    <option value="deny">{ft('policy.networkDeny')}</option>
                  </select>
                </div>
              </div>

              <div className="policy-fields-grid">
                <div className="policy-field">
                  <label htmlFor="policy-deny-read">{ft('policy.denyRead')}</label>
                  <textarea
                    id="policy-deny-read"
                    className="policy-textarea"
                    value={form.denyReadText}
                    onChange={(e) => setForm((f) => ({ ...f, denyReadText: e.target.value }))}
                    placeholder={'config/secrets/**\n*.secret'}
                  />
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-allow-read">{ft('policy.allowRead')}</label>
                  <textarea
                    id="policy-allow-read"
                    className="policy-textarea"
                    value={form.allowReadText}
                    onChange={(e) => setForm((f) => ({ ...f, allowReadText: e.target.value }))}
                    placeholder={'.env.local'}
                  />
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-deny-write">{ft('policy.denyWrite')}</label>
                  <textarea
                    id="policy-deny-write"
                    className="policy-textarea"
                    value={form.denyWriteText}
                    onChange={(e) => setForm((f) => ({ ...f, denyWriteText: e.target.value }))}
                    placeholder={'infra/prod/**\npackage-lock.json'}
                  />
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-allow-write">{ft('policy.allowWrite')}</label>
                  <textarea
                    id="policy-allow-write"
                    className="policy-textarea"
                    value={form.allowWriteText}
                    onChange={(e) => setForm((f) => ({ ...f, allowWriteText: e.target.value }))}
                  />
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-deny-cmd">{ft('policy.denyCommands')}</label>
                  <textarea
                    id="policy-deny-cmd"
                    className="policy-textarea"
                    value={form.denyCommandsText}
                    onChange={(e) => setForm((f) => ({ ...f, denyCommandsText: e.target.value }))}
                    placeholder={'terraform destroy\n/deploy\\s+--prod/i'}
                  />
                </div>
                <div className="policy-field">
                  <label htmlFor="policy-allow-cmd">{ft('policy.allowCommands')}</label>
                  <textarea
                    id="policy-allow-cmd"
                    className="policy-textarea"
                    value={form.allowCommandsText}
                    onChange={(e) => setForm((f) => ({ ...f, allowCommandsText: e.target.value }))}
                  />
                </div>
              </div>

              <div className="policy-tester">
                <div className="small" style={{ fontWeight: 600 }}>
                  {ft('policy.testerTitle')}
                </div>
                <div className="policy-tester-row">
                  <input
                    className="fleet-input"
                    value={testPath}
                    onChange={(e) => setTestPath(e.target.value)}
                    placeholder={ft('policy.testerPlaceholder')}
                  />
                  <button type="button" className="btn btn-small" onClick={() => void runCheckPath('read')}>
                    {ft('policy.testRead')}
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => void runCheckPath('write')}>
                    {ft('policy.testWrite')}
                  </button>
                </div>
                {testResult && (
                  <div className="policy-tester-result">
                    <span className={`policy-verdict ${testResult.decision.allowed ? 'allow' : 'deny'}`}>
                      {testResult.decision.allowed ? ft('policy.resultAllowed') : ft('policy.resultBlocked')}
                    </span>
                    <span>
                      {testResult.decision.reason ||
                        (testResult.decision.matchedRule
                          ? `${testResult.decision.source ?? 'default'}: ${testResult.decision.matchedRule}`
                          : 'OK')}
                    </span>
                  </div>
                )}
              </div>

              <div className="fleet-launcher-foot">
                <span className="muted small">
                  {scope === 'local' ? inspection?.localFile.path : inspection?.projectFile.path}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={saving}
                  onClick={() => void handleSave()}
                >
                  <Check size={13} />
                  <span>{saving ? ft('policy.saving') : ft('policy.save')}</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
