import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/** Tracks the active pill element inside a segmented control so a gliding indicator can slide smoothly. */
export function useGlider(selector: string, deps: readonly unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ x: number; w: number; animate: boolean }>({
    x: 0,
    w: 0,
    animate: false,
  })

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const measure = () => {
      const active = el.querySelector<HTMLElement>(selector)
      if (!active) return
      const x = active.offsetLeft
      const w = active.offsetWidth
      if (w <= 0) return
      setState((prev) => {
        if (prev.w === w && prev.x === x) return prev
        return { x, w, animate: prev.w > 0 }
      })
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of el.children) {
      if (child instanceof HTMLElement && !child.hasAttribute('aria-hidden')) {
        ro.observe(child)
      }
    }
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const ready = state.w > 0
  const gliderStyle: CSSProperties | undefined = ready
    ? { transform: `translateX(${state.x}px)`, width: `${state.w}px` }
    : undefined

  return { containerRef, ready, animate: state.animate, gliderStyle }
}
