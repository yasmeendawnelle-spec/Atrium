import { useEffect, useRef, useState } from 'react'
import { ArchiveScene } from '../rhine-archive/scene.ts'
import type { RenderQuality } from '../rhine-archive/render-quality.ts'
import { playRhineSound, unlockRhineAudio } from '../lib/rhineAudio.ts'

interface Props {
  paused?: boolean
  density?: 'vivid' | 'subtle'
  activityKey?: string
  sessionKey?: string
  sessionIndex?: number
  sessionCode?: string
  sessionTitle?: string
  enableAudio?: boolean
}

const BACKDROP_SLOTS = [0, 5, 11, 18, 25, 31, 37, 14] as const
const TRIGGER_SELECTOR = '.side-item, .starter-card, .market-card-v2, .send-btn'
const CYCLE_INTERVAL_MS = 11000
const INTERACTION_DEBOUNCE_MS = 700
const SWITCH_EFFECT_DURATION_MS = 1900

const BACKDROP_QUALITY: RenderQuality = {
  scale: 85,
  pixelRatio: 1.5,
  antialias: 'off',
  shadows: 1024,
  aoSamples: 16,
  aoResolution: 0.75,
  depthOfField: 115,
  transmission: 0.75,
  anisotropy: 8,
}

/**
 * Ambient 1:1 Three.js PBR CAD Rhine Lab archive cassette matrix rendered behind
 * Standard Workbench views with non-interactive pointer parallax, gentle periodic
 * extraction pulses, smooth light/dark ThemeWave polarity shifts, directional
 * 3D archive-switch choreography on conversation changes, and non-WebGL fallback.
 */
export function RhineArchiveBackdrop({
  paused = false,
  density = 'subtle',
  activityKey = 'home',
  sessionKey = 'home',
  sessionIndex = -1,
  sessionCode = 'X-000',
  sessionTitle = 'WELCOME // STANDBY',
  enableAudio = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneHostRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const [ready, setReady] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [switchBanner, setSwitchBanner] = useState<{
    seq: number
    fromCode: string
    toCode: string
    title: string
  } | null>(null)

  const sceneRef = useRef<ArchiveScene | null>(null)
  const slotIdxRef = useRef(0)
  const lastSelectAtRef = useRef(0)
  const lastCycleAtRef = useRef(performance.now())
  const reducedMotionRef = useRef(false)
  const themeSettlingUntilRef = useRef(0)

  const prevSessionRef = useRef({ key: sessionKey, index: sessionIndex, code: sessionCode })
  const prevViewRef = useRef(activityKey.split(':')[0] ?? 'chat')
  const switchTimerRef = useRef<number | null>(null)
  const switchSeqRef = useRef(0)
  const latestSessionCodeRef = useRef(sessionCode)
  latestSessionCodeRef.current = sessionCode

  // Choreograph 3D rail glide + prominent cassette extraction on session switch
  useEffect(() => {
    const prev = prevSessionRef.current
    if (prev.key === sessionKey) {
      if (prev.code !== sessionCode || prev.index !== sessionIndex) {
        prevSessionRef.current = { key: sessionKey, index: sessionIndex, code: sessionCode }
        sceneRef.current?.setLabelCode(sessionCode)
      }
      return
    }

    let dir = 1
    let rowDelta = 7
    if (sessionIndex >= 0 && prev.index >= 0 && sessionIndex !== prev.index) {
      dir = sessionIndex > prev.index ? 1 : -1
      rowDelta = dir * Math.min(10, Math.max(6, Math.abs(sessionIndex - prev.index) + 5))
    } else {
      dir = switchSeqRef.current % 2 === 0 ? 1 : -1
      rowDelta = dir * 7
    }
    const laneDelta = dir * 2
    const targetSlot = sessionIndex >= 0 ? (sessionIndex * 5 + 3) % 40 : 0

    prevSessionRef.current = { key: sessionKey, index: sessionIndex, code: sessionCode }
    const now = performance.now()
    lastSelectAtRef.current = now
    lastCycleAtRef.current = now

    if (sceneRef.current && !pausedRef.current) {
      sceneRef.current.triggerArchiveSwitch(targetSlot, {
        labelCode: sessionCode,
        laneDelta,
        rowDelta,
        holdSec: 1.25,
      })
      if (reducedMotionRef.current) {
        sceneRef.current.update(now / 1000)
      }
    }

    if (enableAudio && !reducedMotionRef.current && !pausedRef.current) {
      unlockRhineAudio()
      playRhineSound('column')
    }

    switchSeqRef.current += 1
    setSwitchBanner({
      seq: switchSeqRef.current,
      fromCode: prev.code,
      toCode: sessionCode,
      title: sessionTitle,
    })
    setSwitching(true)
    if (switchTimerRef.current !== null) {
      window.clearTimeout(switchTimerRef.current)
    }
    switchTimerRef.current = window.setTimeout(() => {
      switchTimerRef.current = null
      setSwitching(false)
    }, SWITCH_EFFECT_DURATION_MS)
  }, [sessionKey, sessionIndex, sessionCode, sessionTitle, enableAudio])

  // Subtle step only when switching top-level views (connections / market / automations)
  // without colliding with conversation switches
  useEffect(() => {
    const viewPrefix = activityKey.split(':')[0] ?? 'chat'
    if (prevViewRef.current === viewPrefix) return
    prevViewRef.current = viewPrefix
    const scene = sceneRef.current
    if (!scene || pausedRef.current) return
    const now = performance.now()
    if (now - lastSelectAtRef.current < INTERACTION_DEBOUNCE_MS) return
    lastSelectAtRef.current = now
    lastCycleAtRef.current = now
    slotIdxRef.current = (slotIdxRef.current + 1) % BACKDROP_SLOTS.length
    scene.select(BACKDROP_SLOTS[slotIdxRef.current]!)
    if (reducedMotionRef.current) {
      scene.update(now / 1000)
    }
  }, [activityKey])

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const wrap = wrapRef.current
    const sceneHost = sceneHostRef.current
    if (!wrap || !sceneHost) return

    const reducedMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    reducedMotionRef.current = reducedMotion

    let scene: ArchiveScene
    try {
      scene = new ArchiveScene(sceneHost, undefined, false, 'refined', false)
    } catch {
      setFallback(true)
      return
    }
    sceneRef.current = scene

    scene.setArchiveCoverage(true)
    scene.setQuality({
      ...BACKDROP_QUALITY,
      pixelRatio: typeof window !== 'undefined' && window.devicePixelRatio >= 2 ? 1.5 : 1,
    })
    if (reducedMotion) {
      scene.setReduced(true)
    }

    let disposed = false
    let sceneReady = false
    let rafId = 0
    let pointerTargetX = 0
    let pointerTargetY = 0
    let pointerX = 0
    let pointerY = 0
    lastCycleAtRef.current = performance.now()

    const isDarkTheme = () => document.documentElement.dataset.theme === 'dark'
    scene.setTheme(isDarkTheme(), true)

    const renderOnce = () => {
      if (disposed || !sceneReady) return
      scene.update(performance.now() / 1000)
    }

    const mo = new MutationObserver(() => {
      if (disposed) return
      scene.setTheme(isDarkTheme(), reducedMotion)
      themeSettlingUntilRef.current = performance.now() + 2600
      if (reducedMotion) renderOnce()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    const onPointerMove = (e: PointerEvent) => {
      pointerTargetX = e.clientX / Math.max(1, window.innerWidth) - 0.5
      pointerTargetY = e.clientY / Math.max(1, window.innerHeight) - 0.5
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    const onPointerDown = (e: PointerEvent) => {
      if (pausedRef.current || !sceneReady) return
      const target = e.target as HTMLElement | null
      if (!target?.closest(TRIGGER_SELECTOR)) return
      const now = performance.now()
      if (now - lastSelectAtRef.current < INTERACTION_DEBOUNCE_MS) return
      lastSelectAtRef.current = now
      lastCycleAtRef.current = now
      slotIdxRef.current = (slotIdxRef.current + 1) % BACKDROP_SLOTS.length
      scene.select(BACKDROP_SLOTS[slotIdxRef.current]!)
      if (reducedMotion) renderOnce()
    }
    window.addEventListener('pointerdown', onPointerDown, { passive: true })

    const ro = new ResizeObserver(() => {
      if (disposed) return
      if (wrap.clientWidth > 0 && wrap.clientHeight > 0) {
        scene.resize()
        if (reducedMotion) renderOnce()
      }
    })
    ro.observe(wrap)

    void scene
      .load()
      .then(() => {
        if (disposed) return
        sceneReady = true
        const initIdx = prevSessionRef.current.index
        const initSlot = initIdx >= 0 ? (initIdx * 5 + 3) % 40 : BACKDROP_SLOTS[slotIdxRef.current]!
        scene.setLabelCode(latestSessionCodeRef.current)
        scene.enterArchiveImmediately(initSlot)
        scene.resize()
        scene.update(performance.now() / 1000)
        setReady(true)
        lastCycleAtRef.current = performance.now()

        if (reducedMotion) return
        let prevNow = performance.now()
        const tick = (now: number) => {
          if (disposed) return
          rafId = window.requestAnimationFrame(tick)
          const dt = Math.min(0.05, Math.max(0.001, (now - prevNow) / 1000))
          prevNow = now

          const activeTick = !pausedRef.current || now < themeSettlingUntilRef.current
          if (!activeTick) return

          pointerX += (pointerTargetX - pointerX) * Math.min(1, dt * 4.5)
          pointerY += (pointerTargetY - pointerY) * Math.min(1, dt * 4.5)
          scene.setExternalPointer(pointerX, pointerY)

          if (!pausedRef.current && now - lastCycleAtRef.current >= CYCLE_INTERVAL_MS) {
            lastCycleAtRef.current = now
            lastSelectAtRef.current = now
            slotIdxRef.current = (slotIdxRef.current + 1) % BACKDROP_SLOTS.length
            scene.select(BACKDROP_SLOTS[slotIdxRef.current]!)
          }

          scene.update(now / 1000)
        }
        rafId = window.requestAnimationFrame(tick)
      })
      .catch(() => {
        if (!disposed) setFallback(true)
      })

    return () => {
      disposed = true
      sceneRef.current = null
      window.cancelAnimationFrame(rafId)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerdown', onPointerDown)
      scene.dispose()
    }
  }, [])

  return (
    <div
      ref={wrapRef}
      className="rl-archive-backdrop"
      data-density={density}
      data-ready={ready ? 'true' : 'false'}
      data-fallback={fallback ? 'true' : 'false'}
      data-switching={switching ? 'true' : 'false'}
      aria-hidden="true"
    >
      <div ref={sceneHostRef} className="rl-archive-scene" />
      <div className="rl-archive-veil" />
      {switching && switchBanner && (
        <>
          <div key={`scan-${switchBanner.seq}`} className="rl-archive-switch-scan" />
          <div key={`banner-${switchBanner.seq}`} className="rl-archive-switch-banner">
            <span className="rl-corner-pip" />
            <span className="rl-switch-kicker">ARCHIVE SWITCH</span>
            <span className="rl-switch-route">
              {switchBanner.fromCode} → NO.{switchBanner.toCode}
            </span>
            <span className="rl-switch-sep">·</span>
            <span className="rl-switch-title">{switchBanner.title}</span>
          </div>
        </>
      )}
      {density === 'vivid' && !switching && (
        <div className="rl-archive-corner-tag">
          <span className="rl-corner-pip" />
          <span>ARCHIVE MATRIX</span>
          <i>//</i>
          <span>5×8 VAULT LIVE</span>
        </div>
      )}
    </div>
  )
}
