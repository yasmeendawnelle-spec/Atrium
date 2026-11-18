import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ContextMenuEntry =
  | {
      kind?: 'item'
      id: string
      label: string
      icon?: ReactNode
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'separator'; id: string }

/** Portal-mounted floating context menu that clamps within viewport bounds and dismisses cleanly. */
export function ContextMenu({
  x,
  y,
  entries,
  ariaLabel,
  onClose,
}: {
  x: number
  y: number
  entries: ContextMenuEntry[]
  ariaLabel: string
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad))
    const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad))
    setPos({ left, top })
  }, [x, y, entries.length])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeRef.current()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const el = menuRef.current
      if (!el) return
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('.ctx-menu-item:not(:disabled)')]
      if (buttons.length === 0) return
      e.preventDefault()
      const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        e.key === 'ArrowDown'
          ? (idx + 1) % buttons.length
          : idx <= 0
            ? buttons.length - 1
            : idx - 1
      buttons[next]?.focus()
    }
    const dismiss = () => closeRef.current()

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      aria-label={ariaLabel}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry) => {
        if (entry.kind === 'separator') {
          return <div key={entry.id} className="ctx-menu-sep" role="separator" />
        }
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={`ctx-menu-item${entry.danger ? ' danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {entry.icon && <span className="ctx-menu-ico">{entry.icon}</span>}
            <span className="ctx-menu-label">{entry.label}</span>
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
