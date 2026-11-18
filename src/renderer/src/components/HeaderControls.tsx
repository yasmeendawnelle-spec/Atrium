import { Briefcase, ChevronLeft, ChevronRight, Code2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkScene } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { useGlider } from '../lib/glider.ts'
import { canGoBack, canGoForward, goBack, goForward, setState, toast, useStore } from '../lib/store.ts'

export function HistoryNavButtons() {
  const { t } = useTranslation()
  const backOk = useStore(canGoBack)
  const forwardOk = useStore(canGoForward)

  return (
    <div className="hist-nav" role="group" aria-label={t('nav.historyGroup')}>
      <button
        type="button"
        className="icon-btn hist-nav-btn"
        disabled={!backOk}
        onClick={() => void goBack()}
        aria-label={t('nav.backHistory')}
        title={`${t('nav.backHistory')} (Alt+←)`}
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        className="icon-btn hist-nav-btn"
        disabled={!forwardOk}
        onClick={() => void goForward()}
        aria-label={t('nav.forwardHistory')}
        title={`${t('nav.forwardHistory')} (Alt+→)`}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

export function WorkSceneSwitch({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const workScene: WorkScene = useStore((s) => (s.settings?.workScene === 'work' ? 'work' : 'code'))
  const { containerRef, ready, animate, gliderStyle } = useGlider('.scene-btn.active', [workScene, compact])

  const select = async (next: WorkScene) => {
    if (next === workScene) return
    try {
      const settings = await call('settings.update', { workScene: next })
      setState({ settings })
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <div
      ref={containerRef}
      className={`scene-seg${compact ? ' compact' : ''}${ready ? ' has-glider' : ''}`}
      role="group"
      aria-label={t('scene.switchLabel')}
      title={t('scene.switchLabel')}
    >
      {ready && <span className={`scene-glider${animate ? ' animate' : ''}`} style={gliderStyle} aria-hidden="true" />}
      <button
        type="button"
        className={`scene-btn${workScene === 'work' ? ' active' : ''}`}
        onClick={() => void select('work')}
        aria-pressed={workScene === 'work'}
        title={t('scene.workHint')}
      >
        <Briefcase size={13} strokeWidth={2} />
        {!compact && <span>{t('scene.work')}</span>}
      </button>
      <button
        type="button"
        className={`scene-btn${workScene === 'code' ? ' active' : ''}`}
        onClick={() => void select('code')}
        aria-pressed={workScene === 'code'}
        title={t('scene.codeHint')}
      >
        <Code2 size={14} strokeWidth={2.1} />
        {!compact && <span>{t('scene.code')}</span>}
      </button>
    </div>
  )
}
