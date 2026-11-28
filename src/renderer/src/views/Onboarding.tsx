import { useState } from 'react'
import { Check, FolderInput, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { View } from '../lib/store.ts'
import { call } from '../lib/api.ts'
import { openSessionImportModal, setState, useStore } from '../lib/store.ts'
import { useFeatureText } from '../locales/features.ts'
import { Oculus } from '../components/Oculus.tsx'
import { ProviderForm } from '../components/ProviderForm.tsx'
import { pickWorkspace } from './ChatView.tsx'

async function finish(view: View) {
  const settings = await call('settings.update', { onboarded: true })
  setState({ settings, view })
}

export function Onboarding() {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const account = useStore((s) => s.account)
  const providers = useStore((s) => s.providers)
  const workspace = useStore((s) => s.settings?.workspace)
  const [step, setStep] = useState(1)
  const [showByokForm, setShowByokForm] = useState(false)
  const steps = [t('onboarding.step1'), t('onboarding.step2'), t('onboarding.step3')]

  return (
    <div className="onboarding">
      <div className="drag-strip drag" />
      <div className="onboarding-card">
        <div className="onboarding-hero">
          <span className="brand-badge" style={{ width: 42, height: 42, borderRadius: 12 }}>
            <Oculus state="idle" size={26} />
          </span>
          <div>
            <h1 className="display">{t('onboarding.title')}</h1>
            <p className="onboarding-sub">{t('onboarding.intro')}</p>
          </div>
        </div>
        <ol className="steps">
          {steps.map((label, i) => (
            <li key={label} className={i + 1 === step ? 'current' : i + 1 < step ? 'done' : ''}>
              <span className="step-num">{i + 1 < step ? <Check size={12} /> : i + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        {step === 1 && (
          <div className="onboarding-step">
            <div className="rp-pending-banner" style={{ marginBottom: 12 }}>
              <Check size={16} />
              <div>
                <strong>{t('account.onboardingSignedIn', { name: account.displayName || account.email })}</strong>
                <p>{t('account.onboardingReadyHint')}</p>
              </div>
            </div>
            {showByokForm ? (
              <>
                <ProviderForm onSaved={() => setStep(2)} />
                <div style={{ marginTop: 10 }}>
                  <button type="button" className="btn btn-small" onClick={() => setShowByokForm(false)}>
                    {t('account.onboardingBackOfficial')}
                  </button>
                </div>
              </>
            ) : (
              <div className="dialog-actions" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="btn" onClick={() => setShowByokForm(true)}>
                  {t('account.onboardingAddByok')}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
                  {t('account.onboardingContinue', {
                    name:
                      (providers[0]?.managedBy === 'relaypulse' && providers[0]?.name === 'RelayPulse'
                        ? 'Atrium Cloud'
                        : providers[0]?.name) || 'Atrium Cloud',
                  })}
                </button>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step">
            <p className="muted">{t('onboarding.step2Hint')}</p>
            <div className="setting-line">
              <code>{workspace ?? t('settings.noFolder')}</code>
              <button className="btn btn-small" onClick={() => void pickWorkspace()}>
                <FolderOpen size={14} />
                {t('settings.chooseFolder')}
              </button>
            </div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setStep(1)}>
                {t('common.back')}
              </button>
              <button className="btn btn-primary" onClick={() => setStep(3)}>
                {workspace ? t('common.next') : t('common.skip')}
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-step">
            <p className="muted">{t('onboarding.step3Hint')}</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void finish('chat').then(() => {
                    openSessionImportModal()
                  })
                }
              >
                <FolderInput size={14} />
                {ft('sessionImport.onboardingBtn')}
              </button>
              <button className="btn" onClick={() => void finish('market')}>
                {t('connections.browse')}
              </button>
              <button className="btn btn-primary" onClick={() => void finish('chat')}>
                {t('onboarding.finish')}
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <button className="btn btn-ghost later" onClick={() => void finish('settings')}>
            {t('onboarding.later')}
          </button>
        )}
      </div>
    </div>
  )
}
