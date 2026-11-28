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
      const target = e.target as Node | null
      const el = target instanceof Element ? target : null
      if (el?.closest('.studio-select-popover')) return
      if (!wrapRef.current?.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('.studio-select-popover')) return
        onClose()
      }
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
 * Returns the bounding rect of the nearest ancestor creating a CSS containing block
 * for `position: fixed` descendants (e.g. transform, filter, backdrop-filter, contain),
 * or null when coordinates are relative to the viewport.
 */
function findFixedContainingBlockRect(el: HTMLElement | null): DOMRect | null {
  let cur = el?.parentElement ?? null
  while (cur && cur !== document.documentElement) {
    const cs = getComputedStyle(cur)
    if (
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      (cs.backdropFilter && cs.backdropFilter !== 'none') ||
      cs.perspective !== 'none' ||
      /\b(paint|layout|strict|content)\b/.test(cs.contain)
    ) {
      return cur.getBoundingClientRect()
    }
    cur = cur.parentElement
  }
  return null
}

/**
 * Computes viewport- and pane-clamped `position: fixed` coordinates for composer popovers
 * so they remain unclipped regardless of Studio drawer width, sidebar state, window height,
 * HUD stamp clearance, or any ancestor CSS containing block.
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
      const bottomMargin = document.querySelector('.rl-hud-stamp') ? 38 : margin
      const paneRect = trigger.closest('.chat-pane, .chat-col, .main')?.getBoundingClientRect()
      const paneLeft = Math.max(margin, (paneRect?.left ?? 0) + margin)
      const paneRight = Math.min(window.innerWidth - margin, (paneRect?.right ?? window.innerWidth) - margin)
      const paneWidth = Math.max(240, paneRight - paneLeft)
      const popW = Math.min(popRef.current?.offsetWidth || width, paneWidth, window.innerWidth - margin * 2)

      let left: number
      if (align === 'left') {
        const minLeft = popW <= paneWidth ? paneLeft : margin
        const maxLeft = popW <= paneWidth ? paneRight - popW : window.innerWidth - margin - popW
        left = Math.max(minLeft, Math.min(rect.left, Math.max(minLeft, maxLeft)))
      } else {
        const minLeft = popW <= paneWidth ? paneLeft : margin
        const maxLeft = popW <= paneWidth ? paneRight - popW : window.innerWidth - margin - popW
        left = Math.max(minLeft, Math.min(rect.right - popW, Math.max(minLeft, maxLeft)))
      }

      const composerEl = trigger.closest('.composer')
      const composerRect = composerEl?.getBoundingClientRect()
      const anchorTop = Math.min(rect.top, composerRect ? composerRect.top : rect.top)
      const anchorBottom = rect.bottom
      const availDown = Math.max(0, window.innerHeight - anchorBottom - gap - bottomMargin)
      const availUp = Math.max(0, anchorTop - gap - margin)
      const useDown =
        direction === 'down' && !(availDown < Math.min(maxHeight, 320) && availUp > availDown + 32)

      if (popRef.current) {
        popRef.current.dataset.dir = useDown ? 'down' : 'up'
      }

      const cbRect = findFixedContainingBlockRect(popRef.current)
      const adjLeft = cbRect ? left - cbRect.left : left

      if (useDown) {
        const viewportTop = anchorBottom + gap
        const avail = Math.max(Math.min(minHeight, availDown), Math.min(maxHeight, availDown))
        setStyle({
          left: adjLeft,
          top: cbRect ? viewportTop - cbRect.top : viewportTop,
          maxWidth: paneWidth,
          maxHeight: Math.min(maxHeight, avail),
        })
      } else {
        const viewportBottom = Math.max(bottomMargin, window.innerHeight - anchorTop + gap)
        const avail = Math.max(Math.min(minHeight, availUp), Math.min(maxHeight, availUp))
        setStyle({
          left: adjLeft,
          bottom: cbRect ? cbRect.bottom - (window.innerHeight - viewportBottom) : viewportBottom,
          maxWidth: paneWidth,
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
