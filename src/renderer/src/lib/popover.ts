import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useState } from 'react'

export interface PopoverPosOptions {
  width: number
  direction: 'up' | 'down'
  align: 'left' | 'right'
  gap?: number
  minHeight?: number
  maxHeight?: number
}

/** Closes an open popover on outside pointer clicks or Escape key presses. */
export function useDismissPopover(
  wrapRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, wrapRef, onClose])
}

/**
 * Computes viewport- and pane-clamped `position: fixed` coordinates for composer popovers
 * so they remain unclipped regardless of Studio drawer width, sidebar state, or window height.
 */
export function useAnchoredPopover(
  triggerRef: RefObject<HTMLElement | null>,
  popRef: RefObject<HTMLElement | null>,
  open: boolean,
  { width, direction, align, gap = 10, minHeight = 180, maxHeight = 440 }: PopoverPosOptions,
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined)

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const margin = 12
      const popW = Math.min(popRef.current?.offsetWidth || width, window.innerWidth - margin * 2)
      const paneRect = trigger.closest('.chat-pane, .chat-col, .main')?.getBoundingClientRect()
      const paneLeft = (paneRect?.left ?? 0) + margin
      const paneRight = (paneRect?.right ?? window.innerWidth) - margin

      let left: number
      if (align === 'left') {
        left =
          rect.left + popW <= window.innerWidth - margin
            ? Math.max(paneLeft, rect.left)
            : Math.max(margin, Math.min(rect.right - popW, window.innerWidth - popW - margin))
      } else {
        const rightAligned = rect.right - popW
        const maxRight = Math.min(window.innerWidth - margin, Math.max(paneRight, rect.right))
        left =
          rightAligned < paneLeft && rect.left + popW <= window.innerWidth - margin
            ? Math.max(paneLeft, rect.left)
            : Math.max(margin, Math.min(rightAligned, maxRight - popW))
      }

      const composerRect = trigger.closest('.composer')?.getBoundingClientRect()
      const anchorTop = composerRect ? composerRect.top : rect.top
      const availDown = window.innerHeight - rect.bottom - gap - margin
      const availUp = anchorTop - gap - margin
      const useDown =
        direction === 'down' && !(availDown < Math.min(maxHeight, 330) && availUp > availDown + 40)

      if (useDown) {
        const avail = Math.max(minHeight, availDown)
        setStyle({
          left,
          top: rect.bottom + gap,
          maxHeight: Math.min(maxHeight, avail),
        })
      } else {
        const avail = Math.max(minHeight, availUp)
        setStyle({
          left,
          bottom: Math.max(margin, window.innerHeight - anchorTop + gap),
          maxHeight: Math.min(maxHeight, avail),
        })
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, triggerRef, popRef, width, direction, align, gap, minHeight, maxHeight])

  return style
}
