import { useState } from 'react'
import { Download, RotateCw, Settings2, SkipForward, Sparkles, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../lib/api.ts'
import {
  closeUpdatePrompt,
  downloadAppUpdate,
  installAppUpdate,
  openSettings,
  skipUpdateVersion,
  toast,
  useStore,
} from '../lib/store.ts'

function formatMb(bytes: number | undefined): string | null {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return null
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatReleaseDay(raw: string | undefined): string | null {
  if (!raw) return null
  const dt = new Date(raw)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString().slice(0, 10)
}

export function UpdatePrompt() {
  const { t } = useTranslation()
  const settingsOpen = useStore((s) => s.settingsOpen)
  const update = useStore((s) => s.update)
  const settings = useStore((s) => s.settings)
  const forced = useStore((s) => s.updatePromptForced)
  const snoozedKey = useStore((s) => s.snoozedUpdateKey)
  const [startingDownload, setStartingDownload] = useState(false)

  const status = update?.status
  const activeStage = status === 'available' || status === 'downloading' || status === 'downloaded'
  if (!update || !activeStage) return null

  const stageKey = `${status}:${update.version ?? ''}`
  const skippedThis =
    !forced &&
    status === 'available' &&
    update.source !== 'manual' &&
    Boolean(update.version && settings?.skippedUpdateVersion === update.version)
  const hiddenOnSettings = !forced && settingsOpen
  const snoozedThis = !forced && snoozedKey === stageKey
  if (skippedThis || hiddenOnSettings || snoozedThis) return null

  const sizeLabel = formatMb(update.downloadSize)
  const dateLabel = formatReleaseDay(update.releaseDate)
  const notes = update.releaseNotes?.trim() || t('updates.defaultNotes')
  const pct = update.percent ?? 0

  const badgeLabel =
    status === 'downloaded'
      ? t('updates.readyBadge')
      : status === 'downloading'
        ? t('updates.downloadingBadge')
        : t('updates.newVersionBadge')

  const title =
    status === 'downloaded'
      ? update.version
        ? t('updates.readyTitle', { version: update.version })
        : t('updates.restartToUpgrade')
      : status === 'downloading'
        ? t('updates.downloadingTitle', { version: update.version ?? '' })
        : t('updates.availableTitle', { version: update.version ?? '' })

  const onDownloadNow = async () => {
    setStartingDownload(true)
    try {
      const next = await downloadAppUpdate()
      if (next?.status === 'error' && next.error) {
        toast(t('updates.failed', { message: next.error }), 'error')
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setStartingDownload(false)
    }
  }

  const onSkip = async () => {
    if (!update.version) return
    try {
      await skipUpdateVersion(update.version)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <aside className="update-prompt" role="region" aria-label={title}>
      <div className="update-prompt-head">
        <span className={`update-prompt-badge state-${status}`}>
          {status === 'downloaded' ? (
            <RotateCw size={12} strokeWidth={2.2} />
          ) : status === 'downloading' ? (
            <Download size={12} strokeWidth={2.2} />
          ) : (
            <Sparkles size={12} strokeWidth={2.2} />
          )}
          {badgeLabel}
        </span>
        <button
          type="button"
          className="icon-btn update-prompt-close"
          onClick={() => closeUpdatePrompt(true)}
          aria-label={t('updates.later')}
          title={t('updates.later')}
        >
          <X size={15} />
        </button>
      </div>

      <div className="update-prompt-body">
        <h3 className="update-prompt-title">{title}</h3>
        <div className="update-prompt-meta">
          <span className="summary-pill mono">
            v{update.currentVersion} → v{update.version ?? '?'}
          </span>
          {sizeLabel && <span className="summary-pill">{sizeLabel}</span>}
          {dateLabel && <span className="summary-pill">{dateLabel}</span>}
        </div>

        {status === 'downloading' ? (
          <div className="update-progress-box">
            <div className="update-progress-head">
              <span>{t('updates.downloading', { version: update.version ?? '', percent: pct })}</span>
              <span className="mono small">{pct}%</span>
            </div>
            <div className="update-progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="update-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : (
          <div className="update-prompt-notes-wrap">
            <div className="update-prompt-notes-label">{t('updates.releaseNotesTitle')}</div>
            <div className="update-prompt-notes">{notes}</div>
          </div>
        )}
      </div>

      <div className="update-prompt-foot">
        <div className="update-prompt-actions">
          {status === 'available' && (
            <>
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={startingDownload}
                onClick={() => void onDownloadNow()}
              >
                <Download size={13} />
                {t('updates.updateNow')}
              </button>
              <button type="button" className="btn btn-small" onClick={() => closeUpdatePrompt(true)}>
                {t('updates.later')}
              </button>
              {update.version && (
                <button type="button" className="btn btn-ghost btn-small" onClick={() => void onSkip()}>
                  <SkipForward size={13} />
                  {t('updates.skipVersion')}
                </button>
              )}
            </>
          )}
          {status === 'downloading' && (
            <button type="button" className="btn btn-small" onClick={() => closeUpdatePrompt(true)}>
              {t('updates.minimize')}
            </button>
          )}
          {status === 'downloaded' && (
            <>
              <button type="button" className="btn btn-primary btn-small" onClick={() => void installAppUpdate()}>
                <RotateCw size={13} />
                {t('updates.restartToUpgrade')}
              </button>
              <button type="button" className="btn btn-small" onClick={() => closeUpdatePrompt(true)}>
                {t('updates.installOnQuit')}
              </button>
            </>
          )}
        </div>
        <button
          type="button"
          className="update-prompt-settings-link"
          onClick={() => {
            closeUpdatePrompt(false)
            openSettings('system')
          }}
        >
          <Settings2 size={12} />
          <span>{t('updates.openSettings')}</span>
        </button>
      </div>
    </aside>
  )
}
