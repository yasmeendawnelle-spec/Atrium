import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function Dialog({ title, onClose, wide, compact, children }: { title: string; onClose: () => void; wide?: boolean; compact?: boolean; children: ReactNode }) {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  // Parents pass inline closures; a ref keeps the effect below from re-running
  // (and stealing focus) on every render.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const overlays = document.querySelectorAll('.overlay')
      if (overlays.length > 0 && overlays[overlays.length - 1] !== overlayRef.current) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.activeElement as HTMLElement | null
    const field = ref.current?.querySelector<HTMLElement>('input, textarea, select')
    if (field) field.focus()
    else ref.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [])

  return createPortal(
    <div ref={overlayRef} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`dialog${wide ? ' dialog-wide' : compact ? ' dialog-compact' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn dialog-close" onClick={onClose} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = true,
  onConfirm,
  onClose,
}: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const confirmRef = useRef(onConfirm)
  confirmRef.current = onConfirm

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      const active = document.activeElement as HTMLElement | null
      if (active?.tagName === 'BUTTON') return
      e.preventDefault()
      confirmRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <Dialog title={title} onClose={onClose} compact>
      <p className="confirm-msg">{message}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={onConfirm}
        >
          {confirmLabel ?? (danger ? t('common.delete') : t('common.save'))}
        </button>
      </div>
    </Dialog>
  )
}
