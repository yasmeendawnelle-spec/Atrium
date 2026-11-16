import type { PointerEvent as ReactPointerEvent } from 'react'

export interface ColumnResizeOptions {
  event: ReactPointerEvent<HTMLDivElement>
  startWidth: number
  computeWidth: (startWidth: number, deltaX: number) => number
  onStart: () => void
  onMove: (width: number) => void
  onEnd: (finalWidth: number) => void
}

/**
 * Starts a pointer-captured horizontal column resize drag.
 * Keeps pointer capture locked on the resizer handle across the entire window.
 */
export function startColumnResize(opts: ColumnResizeOptions): () => void {
  const { event, startWidth, computeWidth, onStart, onMove, onEnd } = opts
  const target = event.currentTarget
  const pointerId = event.pointerId
  const startX = event.clientX
  let latestWidth = startWidth
  let finished = false

  onStart()

  try {
    target.setPointerCapture(pointerId)
  } catch {
    /* ignore if pointer capture is unavailable */
  }

  const handleMove = (ev: PointerEvent) => {
    latestWidth = computeWidth(startWidth, ev.clientX - startX)
    onMove(latestWidth)
  }

  const finish = () => {
    if (finished) return
    finished = true
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    target.removeEventListener('lostpointercapture', finish)
    try {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId)
      }
    } catch {
      /* ignore if capture already ended */
    }
    onEnd(latestWidth)
  }

  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  target.addEventListener('lostpointercapture', finish)
  return finish
}
