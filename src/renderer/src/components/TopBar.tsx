import type { ReactNode } from 'react'
import { Download, PanelLeft, RotateCw, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { installAppUpdate, openUpdatePrompt, toggleSidebar, useStore } from '../lib/store.ts'
import { HistoryNavButtons, WorkSceneSwitch } from './HeaderControls.tsx'

/** The strip along the top of the page. It drags the window; its right edge stays clear for the window buttons. */
export function TopBar({ children, trailing }: { children?: ReactNode; trailing?: ReactNode }) {
  const { t } = useTranslation()
  const open = useStore((s) => s.sidebarOpen)
  const update = useStore((s) => s.update)
  const settings = useStore((s) => s.settings)
  const skippedAvailable =
    update?.status === 'available' &&
    update.source !== 'manual' &&
    Boolean(update.version && settings?.skippedUpdateVersion === update.version)
  const showUpgrade = !open && update?.status === 'downloaded'
  const showDownloading = !open && update?.status === 'downloading'
  const showAvailable = !open && update?.status === 'available' && !skippedAvailable
  return (
    <div className="topbar drag">
      <div className="topbar-left">
        {!open && (
          <>
            <button className="icon-btn" onClick={toggleSidebar} aria-label={t('nav.showSidebar')} title={t('nav.showSidebar')}>
              <PanelLeft size={18} />
            </button>
            <HistoryNavButtons />
            <WorkSceneSwitch />
          </>
        )}
        {children}
      </div>
      {(trailing || showUpgrade || showDownloading || showAvailable) && (
        <div className="topbar-right">
          {showUpgrade && (
            <button
              type="button"
              className="topbar-upgrade-btn"
              onClick={() => void installAppUpdate()}
              title={update.version ? t('updates.ready', { version: update.version }) : t('updates.restartToUpgrade')}
            >
              <RotateCw size={13} strokeWidth={2} />
              <span>{t('updates.restartToUpgrade')}</span>
              {update.version && <span className="topbar-upgrade-ver">v{update.version}</span>}
            </button>
          )}
          {showDownloading && (
            <button
              type="button"
              className="topbar-update-pill"
              onClick={openUpdatePrompt}
              title={t('updates.downloading', { version: update.version ?? '', percent: update.percent ?? 0 })}
            >
              <Download size={13} strokeWidth={2} />
              <span>{t('updates.downloadingShort', { percent: update.percent ?? 0 })}</span>
            </button>
          )}
          {showAvailable && (
            <button
              type="button"
              className="topbar-update-pill"
              onClick={openUpdatePrompt}
              title={t('updates.available', { version: update.version ?? '' })}
            >
              <Sparkles size={13} strokeWidth={2} />
              <span>{t('updates.availableShort', { version: update.version ?? '' })}</span>
            </button>
          )}
          {trailing}
        </div>
      )}
    </div>
  )
}
