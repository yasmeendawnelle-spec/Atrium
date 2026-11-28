import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginBootConfig } from '@shared/types.ts'
import { playRhineSound, setRhineAudioMuted, unlockRhineAudio } from '../lib/rhineAudio.ts'

interface Props {
  boot: PluginBootConfig
  themeId: string
  tactileAudio?: boolean
  onDone: () => void
}

const OUTER_AZIMUTH_TICKS = Array.from({ length: 72 }, (_, i) => i)
const GAUGE_SEGMENTS = Array.from({ length: 24 }, (_, i) => i)

const RHINE_CONTOUR_PATH =
  'M295 73C295 41 273 15 240 15C221 15 207 23 192 38C186 43 181 47 176 52C127 96 103 128 70 128C38 128 15 101 15 70C15 39 37 15 70 15C103 15 127 48 156 75C182 99 208 128 240 128C273 128 295 105 295 73Z'

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t)
const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3)
const easeOutQuart = (t: number) => 1 - Math.pow(1 - clamp01(t), 4)
const smoothstep = (t: number) => {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

function arcPath(r: number, startRad: number, sweepRad: number, cx = 960, cy = 540): string {
  if (sweepRad <= 0.002) return ''
  const pt = (a: number) => `${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`
  if (sweepRad >= Math.PI * 1.999) {
    return `M${pt(startRad)}A${r},${r} 0 1 1 ${pt(startRad + Math.PI)}A${r},${r} 0 1 1 ${pt(startRad + Math.PI * 2)}`
  }
  return `M${pt(startRad)}A${r},${r} 0 ${sweepRad > Math.PI ? 1 : 0} 1 ${pt(startRad + sweepRad)}`
}

/**
 * 5-act boot choreography modeled after Arknights "Rhine Lab: Access" & LBEILC/RhineLabUI:
 * 1) Access prompt type-in
 * 2) Broken-infinity +/- emblem stroke draw & identity confirmation
 * 3) Concentric permission scan rings, amber orbiters & six orbital satellites
 * 4) High-contrast welcome strobe & directional black-bar redaction wipe
 * 5) Optical scale-out & veil crossfade
 */
function RhineAccessBoot({
  boot,
  themeId,
  tactileAudio = false,
  onDone,
}: Props) {
  const { i18n } = useTranslation()
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh')
  const [phase, setPhase] = useState<'gate' | 'playing'>(() => (boot.confirmEntry ? 'gate' : 'playing'))
  const [exiting, setExiting] = useState(false)
  const silentEntryRef = useRef(false)
  const doneCalledRef = useRef(false)
  const gateEnterBtnRef = useRef<HTMLButtonElement>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const isDarkPolarity = useMemo(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
    [],
  )

  const totalMs = reducedMotion ? 700 : Math.max(1200, Math.min(4500, boot.durationMs || 4500))
  const exitMs = reducedMotion ? 160 : 280

  const rootRef = useRef<HTMLDivElement>(null)
  const bgSvgRef = useRef<SVGSVGElement>(null)
  const mastheadLinesRef = useRef<Array<HTMLElement | null>>([])
  const poweredRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLDivElement>(null)
  const logoWrapRef = useRef<HTMLDivElement>(null)
  const contourRef = useRef<SVGPathElement>(null)
  const plusRef = useRef<SVGPathElement>(null)
  const minusRef = useRef<SVGPathElement>(null)
  const logoTextRef = useRef<SVGTextElement>(null)
  const authWrapRef = useRef<HTMLDivElement>(null)
  const authTextRef = useRef<HTMLSpanElement>(null)
  const scanWrapRef = useRef<HTMLDivElement>(null)
  const scanGroupRef = useRef<SVGGElement>(null)
  const scanPathsRef = useRef<Array<SVGPathElement | null>>([])
  const orbitDotsRef = useRef<Array<SVGCircleElement | null>>([])
  const capsRef = useRef<Array<SVGCircleElement | null>>([])
  const satellitesRef = useRef<Array<SVGCircleElement | null>>([])
  const scanCoreRef = useRef<SVGCircleElement>(null)
  const scanTextRef = useRef<HTMLSpanElement>(null)
  const welcomeWrapRef = useRef<HTMLDivElement>(null)
  const wPanelRef = useRef<HTMLDivElement>(null)
  const wHeadingRef = useRef<HTMLDivElement>(null)
  const wCompanyRef = useRef<HTMLDivElement>(null)
  const wHighlightRef = useRef<HTMLElement>(null)
  const wDbRef = useRef<HTMLDivElement>(null)
  const wLogoRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)

  const paletteStyle = useMemo<CSSProperties>(() => {
    const p = boot.palette ?? {}
    const darkPalette = isDarkPolarity
      ? {
          bg: '#11181b',
          bgEdge: '#0b1012',
          surface: '#1b2429',
          ink: '#e0e3dc',
          muted: '#a6b0b1',
          line: '#536166',
          brass: p.brass ?? '#c5a16b',
          olive: p.olive ?? '#8b9882',
          amber: p.accent ?? '#ed821b',
        }
      : {
          bg: p.bg ?? '#e8e5e1',
          bgEdge: '#e1ddd7',
          surface: p.surface ?? '#edebe4',
          ink: p.ink ?? '#080a08',
          muted: p.muted ?? '#77756d',
          line: '#ffffff',
          brass: p.brass ?? '#9b7247',
          olive: p.olive ?? '#565c46',
          amber: p.accent ?? '#ed821b',
        }
    return {
      '--boot-bg': darkPalette.bg,
      '--boot-bg-edge': darkPalette.bgEdge,
      '--boot-surface': darkPalette.surface,
      '--boot-ink': darkPalette.ink,
      '--boot-muted': darkPalette.muted,
      '--boot-scan-contrast': darkPalette.line,
      '--boot-brass': darkPalette.brass,
      '--boot-olive': darkPalette.olive,
      '--boot-accent': darkPalette.amber,
    } as CSSProperties
  }, [boot.palette, isDarkPolarity])

  const labels = useMemo(() => {
    const mastheadOsRaw = (boot.mastheadOs || 'ANALYSIS OS').trim()
    const lastSpace = mastheadOsRaw.lastIndexOf(' ')
    const mastLead = lastSpace > 0 ? mastheadOsRaw.slice(0, lastSpace) : mastheadOsRaw
    const mastTail = lastSpace > 0 ? mastheadOsRaw.slice(lastSpace + 1) : ''

    return {
      brand: boot.brand || 'RHINE LAB',
      mastheadSub: boot.mastheadSub || 'SYNTHESIZE INFORMATION',
      mastLead,
      mastTail,
      accessPrompt: boot.accessPrompt || 'ACCESS PERMISSION REQUIRED',
      identityText: boot.identityText || 'ID CONFIRMED : ATRIUM',
      requestText: boot.requestText || 'REQUEST RECEIVED',
      processingText: boot.processingText || 'START PROCESSING',
      authorizedText: boot.authorizedText || 'PERMISSION AUTHORIZED',
      welcomePrefix: boot.welcomePrefix || 'WELCOME TO',
      companyTag: boot.companyTag || 'RHINE LAB.LLC.',
      databaseTag: boot.databaseTag || 'INTERNAL DATABASE',
      poweredBy: boot.poweredBy || 'POWERED BY RHINE LAB',
      skipLabel: isZh ? '进入系统' : 'ENTER SYSTEM',
      entryReadyText: boot.entryReadyText || 'INTERNAL DATABASE / READY',
      entryButtonText: boot.entryButtonText || (isZh ? '点击进入' : 'ENTER TERMINAL'),
      entryHintText: boot.entryHintText || (isZh ? '轻触屏幕或按 Enter 开始' : 'Click or press Enter to begin'),
      entrySilentLabel: isZh ? '静音进入' : 'Enter silently',
      entryDirectLabel: isZh ? '跳过片头直接进入 ↗' : 'Skip intro ↗',
    }
  }, [boot, isZh])

  const triggerExit = useCallback((delayMs = exitMs) => {
    if (doneCalledRef.current) return
    setExiting(true)
    window.setTimeout(() => {
      if (!doneCalledRef.current) {
        doneCalledRef.current = true
        onDoneRef.current()
      }
    }, delayMs)
  }, [exitMs])

  const enterFromGate = useCallback((silent: boolean) => {
    if (phase !== 'gate') return
    silentEntryRef.current = silent
    if (silent) {
      setRhineAudioMuted(true)
    } else if (tactileAudio) {
      unlockRhineAudio()
      playRhineSound('ui-open')
    }
    setPhase('playing')
  }, [phase, tactileAudio])

  useEffect(() => {
    if (phase !== 'gate') return
    gateEnterBtnRef.current?.focus({ preventScroll: true })
    const onGateKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        e.stopPropagation()
        enterFromGate(false)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        triggerExit(180)
      }
    }
    window.addEventListener('keydown', onGateKeyDown)
    return () => window.removeEventListener('keydown', onGateKeyDown)
  }, [phase, enterFromGate, triggerExit])

  useEffect(() => {
    if (phase !== 'playing') return
    let rafId = 0
    let doneTimer: number | undefined
    const firedCues = new Set<string>()
    let lastKeySoundCount = -1
    let lastProgressBucket = -1

    const fireAudio = (cue: 'key' | 'brand' | 'confirm' | 'scan' | 'welcome') => {
      if (!tactileAudio || reducedMotion || silentEntryRef.current) return
      if (cue !== 'key') {
        if (firedCues.has(cue)) return
        firedCues.add(cue)
      }
      playRhineSound(cue)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        if (!silentEntryRef.current) unlockRhineAudio()
        triggerExit(reducedMotion ? 120 : 220)
      }
    }
    window.addEventListener('keydown', onKeyDown)

    if (reducedMotion) {
      if (promptRef.current) promptRef.current.style.opacity = '0'
      if (logoWrapRef.current) logoWrapRef.current.style.opacity = '0'
      if (authWrapRef.current) authWrapRef.current.style.opacity = '0'
      if (scanWrapRef.current) scanWrapRef.current.style.opacity = '0'
      if (welcomeWrapRef.current) welcomeWrapRef.current.style.opacity = '1'
      if (wCompanyRef.current) wCompanyRef.current.style.opacity = '1'
      if (wHighlightRef.current) wHighlightRef.current.style.clipPath = 'inset(0 0% 0 0)'
      if (wDbRef.current) wDbRef.current.style.opacity = '1'
      if (wLogoRef.current) wLogoRef.current.style.opacity = '1'
      if (poweredRef.current) poweredRef.current.style.clipPath = 'inset(0 0% 0 0)'
      mastheadLinesRef.current.forEach((node) => {
        if (!node) return
        node.style.opacity = '1'
        node.style.transform = 'translateX(0px)'
      })
      doneTimer = window.setTimeout(() => triggerExit(160), 540)
      return () => {
        window.clearTimeout(doneTimer)
        window.removeEventListener('keydown', onKeyDown)
      }
    }

    const startTime = performance.now()
    const stepFrame = (now: number) => {
      const elapsed = now - startTime
      const u = clamp01(elapsed / totalMs)

      const bucket = Math.round(u * 100)
      if (bucket !== lastProgressBucket && rootRef.current) {
        lastProgressBucket = bucket
        rootRef.current.dataset.bootProgress = String(bucket)
      }

      // Gentle ambient drift of background organic curves
      if (bgSvgRef.current) {
        bgSvgRef.current.style.transform = `translate3d(${(Math.sin(u * Math.PI * 1.4) * 16).toFixed(1)}px, ${(-u * 28).toFixed(1)}px, 0) scale(1.08)`
      }

      // Top-left masthead 3-line staggered Swiss entry (u: 0.23 -> 0.36, stays until 0.92 exit fade)
      const globalFade = u > 0.91 ? 1 - smoothstep((u - 0.91) / 0.08) : 1
      mastheadLinesRef.current.forEach((node, idx) => {
        if (!node) return
        const local = clamp01((u - (0.23 + idx * 0.022)) / 0.11)
        const slide = (1 - easeOutQuart(local)) * 84
        const op = Math.min(1, local * 2.4) * globalFade
        node.style.opacity = op.toFixed(3)
        node.style.transform = `translate3d(${slide.toFixed(1)}px, 0, 0)`
      })

      // Bottom-right POWERED BY RHINE LAB bar wipe
      if (poweredRef.current) {
        const pw = easeOutCubic((u - 0.25) / 0.09)
        poweredRef.current.style.opacity = (pw > 0.01 ? globalFade : 0).toFixed(3)
        poweredRef.current.style.clipPath = `inset(0 ${(100 * (1 - pw)).toFixed(1)}% 0 0)`
      }

      // ACT 1 (u: 0.00 -> 0.16): Access Prompt Type-in
      if (promptRef.current) {
        if (u < 0.16) {
          const p = clamp01((u - 0.015) / 0.11)
          const count = Math.round(easeOutCubic(p) * labels.accessPrompt.length)
          const shown = labels.accessPrompt.slice(0, count)
          if (promptRef.current.textContent !== shown) {
            promptRef.current.textContent = shown
            if (count > 0 && Math.floor(count / 3) !== lastKeySoundCount) {
              lastKeySoundCount = Math.floor(count / 3)
              fireAudio('key')
            }
          }
          promptRef.current.style.opacity = u > 0.152 ? '0.25' : '1'
        } else {
          promptRef.current.style.opacity = '0'
        }
      }

      // ACT 2 (u: 0.16 -> 0.43): Broken-Infinity Logo Draw + Identity Handshake
      const logoVisible = u >= 0.16 && u < 0.43
      if (logoVisible) fireAudio('brand')
      if (logoWrapRef.current) {
        logoWrapRef.current.style.opacity = logoVisible ? '1' : '0'
        const shiftP = easeOutCubic((u - 0.23) / 0.085)
        logoWrapRef.current.style.setProperty('--pbo-logo-shift', shiftP.toFixed(4))
      }
      if (logoVisible) {
        const drawP = easeOutCubic((u - 0.16) / 0.09)
        const strokeW = lerp(0.8, 26, clamp01((u - 0.16) / 0.04))
        const travel = u >= 0.365 ? easeOutCubic((u - 0.365) / 0.065) * 0.78 : 0
        const len = Math.max(0, u >= 0.365 ? 0.965 - travel * 0.35 : drawP)
        if (contourRef.current) {
          contourRef.current.style.strokeDasharray = `${len.toFixed(4)} ${(1 - len).toFixed(4)}`
          contourRef.current.style.strokeDashoffset = (-travel).toFixed(4)
          contourRef.current.setAttribute('stroke-width', strokeW.toFixed(2))
        }
        const symScale = easeOutCubic((u - 0.2) / 0.045)
        const plusX = lerp(155, 72, easeOutCubic((u - 0.2) / 0.055))
        const minusX = lerp(155, 238, easeOutCubic((u - 0.2) / 0.055))
        const plusAngle = lerp(0, -90, easeOutCubic((u - 0.215) / 0.045))
        const minusWidth = lerp(15, 45, easeOutCubic((u - 0.215) / 0.045))
        if (plusRef.current) {
          plusRef.current.style.opacity = symScale > 0.02 ? '1' : '0'
          plusRef.current.setAttribute(
            'transform',
            `translate(${plusX.toFixed(1)} 70) rotate(${plusAngle.toFixed(1)}) scale(${symScale.toFixed(3)}) translate(-69 -70)`,
          )
        }
        if (minusRef.current) {
          minusRef.current.style.opacity = symScale > 0.02 ? '1' : '0'
          minusRef.current.setAttribute('d', `M${(-minusWidth / 2).toFixed(1)} 0h${minusWidth.toFixed(1)}`)
          minusRef.current.setAttribute(
            'transform',
            `translate(${minusX.toFixed(1)} 70) scale(${symScale.toFixed(3)})`,
          )
        }
        if (logoTextRef.current) {
          const markWord = 'RHINE·LAB'
          const lettersCount = Math.round(clamp01((u - 0.168) / 0.055) * markWord.length)
          const nextLetters = markWord.slice(0, lettersCount)
          if (logoTextRef.current.textContent !== nextLetters) {
            logoTextRef.current.textContent = nextLetters
          }
        }
      }

      if (authWrapRef.current && authTextRef.current) {
        const authVisible = u >= 0.265 && u < 0.43
        authWrapRef.current.style.opacity = authVisible ? '1' : '0'
        if (authVisible) {
          if (u >= 0.265 && u < 0.33) {
            fireAudio('confirm')
            const p = clamp01((u - 0.265) / 0.05)
            const msg = labels.identityText.slice(0, Math.round(easeOutCubic(p) * labels.identityText.length))
            if (authTextRef.current.textContent !== msg) authTextRef.current.textContent = msg
          } else if (u < 0.38) {
            const p = clamp01((u - 0.33) / 0.036)
            const msg = labels.requestText.slice(0, Math.round(easeOutCubic(p) * labels.requestText.length))
            if (authTextRef.current.textContent !== msg) authTextRef.current.textContent = msg
          } else {
            const p = clamp01((u - 0.38) / 0.028)
            const base = labels.processingText.slice(0, Math.round(easeOutCubic(p) * labels.processingText.length))
            const dots = p >= 1 ? '.'.repeat(Math.min(3, 1 + Math.floor(((u - 0.408) / 0.022) * 3))) : ''
            const msg = base + dots
            if (authTextRef.current.textContent !== msg) authTextRef.current.textContent = msg
          }
        }
      }

      // ACT 3 (u: 0.43 -> 0.70): Concentric Permission Scan Ring + Six Satellites
      const scanVisible = u >= 0.43 && u < 0.70
      if (scanVisible) fireAudio('scan')
      if (scanWrapRef.current) {
        scanWrapRef.current.style.opacity = scanVisible ? '1' : '0'
      }
      if (scanVisible) {
        const sP = clamp01((u - 0.43) / 0.27)
        const deg = Math.PI / 180
        const radius = lerp(1150, 246, easeOutQuart(Math.min(1, sP / 0.72)))
        const whiteRadius = lerp(840, 224, easeOutQuart(Math.min(1, sP / 0.72)))
        const outerStart = lerp(470, -90, easeOutQuart(sP)) * deg
        const outerSweep = lerp(30, 360, easeOutCubic(Math.min(1, sP / 0.85))) * deg
        const whiteStart = lerp(-100, 270, easeOutQuart(sP)) * deg
        const whiteSweep = outerSweep
        const innerRadius = lerp(124, 88.5, easeOutCubic(sP))
        const innerStart = lerp(-20, 201.5, easeOutQuart(sP)) * deg
        const innerSweep = lerp(0, 136, easeOutCubic(Math.min(1, sP / 0.78))) * deg

        const isGlitch = sP >= 0.34 && sP <= 0.38
        if (scanGroupRef.current) {
          scanGroupRef.current.setAttribute(
            'transform',
            `translate(960 540) scale(${isGlitch ? '1.38' : '1'}) translate(-960 -540)`,
          )
          scanGroupRef.current.style.opacity = isGlitch
            ? '0.32'
            : String(Math.min(1, sP / 0.08))
          scanGroupRef.current.style.filter = isGlitch ? 'blur(1.8px)' : 'none'
        }

        scanPathsRef.current[0]?.setAttribute('d', arcPath(radius, outerStart, outerSweep))
        scanPathsRef.current[1]?.setAttribute('d', arcPath(whiteRadius, whiteStart, whiteSweep))
        scanPathsRef.current[2]?.setAttribute('d', arcPath(innerRadius, innerStart, innerSweep))
        scanPathsRef.current[3]?.setAttribute('d', arcPath(innerRadius, innerStart + Math.PI, innerSweep))

        // 2 amber orbit dots
        const orbitAngle = lerp(0.4, 3.85, easeOutCubic(sP))
        const orbitRadius = lerp(410, 235, easeOutQuart(Math.min(1, sP / 0.72)))
        const dotRadius = lerp(4, 8, Math.min(1, sP / 0.25))
        orbitDotsRef.current.forEach((dot, i) => {
          if (!dot) return
          const a = orbitAngle + i * Math.PI
          dot.setAttribute('cx', (960 + Math.cos(a) * orbitRadius).toFixed(1))
          dot.setAttribute('cy', (540 + Math.sin(a) * orbitRadius).toFixed(1))
          dot.setAttribute('r', dotRadius.toFixed(1))
        })

        // Terminal caps on outer rings
        capsRef.current.forEach((cap, i) => {
          if (!cap) return
          const a = i ? whiteStart : outerStart + outerSweep
          const rCap = i ? whiteRadius : radius
          cap.setAttribute('cx', (960 + Math.cos(a) * rCap).toFixed(1))
          cap.setAttribute('cy', (540 + Math.sin(a) * rCap).toFixed(1))
          cap.setAttribute('r', sP < 0.85 ? '5.2' : '0')
        })

        // Counter-rotating side arcs & 6 satellites in tail of Act 3 (sP >= 0.65)
        const ornamentOn = sP >= 0.65
        if (ornamentOn) fireAudio('confirm')
        const tailT = clamp01((sP - 0.65) / 0.35)
        const sideSweep = lerp(4, 336, easeOutCubic(tailT)) * deg
        const sideRadius = lerp(38.7, 37.2, tailT)
        const lx = lerp(827.5, 831.6, tailT)
        const ly = lerp(561, 539.5, easeOutCubic(tailT))
        const rx = lerp(1091, 1086.6, tailT)
        const ry = lerp(518, 539.5, easeOutCubic(tailT))
        const lStart = lerp(260, 599, easeOutCubic(tailT)) * deg
        const rStart = lerp(250, -404, easeOutCubic(tailT)) * deg

        if (scanPathsRef.current[4]) {
          scanPathsRef.current[4].style.opacity = ornamentOn ? '1' : '0'
          scanPathsRef.current[4].setAttribute('d', arcPath(sideRadius, lStart, sideSweep, lx, ly))
        }
        if (scanPathsRef.current[5]) {
          scanPathsRef.current[5].style.opacity = ornamentOn ? '1' : '0'
          scanPathsRef.current[5].setAttribute('d', arcPath(sideRadius, rStart, sideSweep, rx, ry))
        }

        if (scanCoreRef.current) {
          const coreFlash = tailT > 0.04 && tailT < 0.16
          const coreR = ornamentOn ? (coreFlash ? 38 : lerp(6, 11.4, Math.min(1, tailT / 0.35))) : 0
          scanCoreRef.current.style.opacity = ornamentOn ? '1' : '0'
          scanCoreRef.current.setAttribute('r', coreR.toFixed(1))
        }

        satellitesRef.current.forEach((sat, i) => {
          if (!sat) return
          const satPhase = lerp(2.7, 0.72, easeOutCubic(tailT)) + (i * Math.PI) / 3
          const satDist = lerp(36.8, 34.8, tailT)
          const satShow = clamp01((tailT - i * 0.08) / 0.25)
          const satR = ornamentOn ? lerp(0, 4.2, easeOutCubic(satShow)) : 0
          sat.setAttribute('cx', (959.5 + Math.cos(satPhase) * satDist).toFixed(1))
          sat.setAttribute('cy', (539.5 + Math.sin(satPhase) * satDist).toFixed(1))
          sat.setAttribute('r', satR.toFixed(1))
        })

        if (scanTextRef.current) {
          const tracking = lerp(26, 1.5, easeOutCubic(Math.min(1, sP / 0.56)))
          const permOp = sP < 0.65 ? clamp01(sP / 0.14) : 1 - clamp01((sP - 0.65) / 0.12)
          scanTextRef.current.style.letterSpacing = `${tracking.toFixed(1)}px`
          scanTextRef.current.style.paddingLeft = `${tracking.toFixed(1)}px`
          scanTextRef.current.style.opacity = permOp.toFixed(3)
        }
      }

      // ACT 4 & 5 (u: 0.70 -> 1.00): Welcome Flash Strobe + Black-Bar Redaction Wipe + Scale Exit
      const welcomeVisible = u >= 0.70
      if (welcomeVisible) fireAudio('welcome')
      if (welcomeWrapRef.current) {
        const exitT = clamp01((u - 0.90) / 0.10)
        const exitSmooth = smoothstep(exitT)
        const scale = 1 - 0.42 * exitSmooth
        const blur = 7 * exitSmooth
        const op = welcomeVisible ? 1 - Math.pow(exitSmooth, 2.4) : 0
        welcomeWrapRef.current.style.opacity = op.toFixed(3)
        welcomeWrapRef.current.style.transform = `scale(${scale.toFixed(4)})`
        welcomeWrapRef.current.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none'
      }

      if (welcomeVisible) {
        const wP = clamp01((u - 0.70) / 0.20)
        if (wPanelRef.current) {
          const flash = wP < 0.03 ? 1 : wP < 0.06 ? 0 : wP < 0.09 ? 0.35 : 0
          wPanelRef.current.style.opacity = String(flash)
        }
        if (wHeadingRef.current) {
          const inv = wP < 0.03 || (wP >= 0.06 && wP < 0.09)
          wHeadingRef.current.style.opacity = inv ? '0.88' : '1'
        }
        const compShow = wP >= 0.16 && !(wP >= 0.20 && wP < 0.22)
        if (wCompanyRef.current) {
          wCompanyRef.current.style.opacity = compShow ? '1' : '0'
        }
        if (wHighlightRef.current) {
          const wipeP = easeOutQuart((wP - 0.16) / 0.44)
          wHighlightRef.current.style.clipPath = `inset(0 ${(100 * (1 - wipeP)).toFixed(1)}% 0 0)`
        }
        if (wDbRef.current) {
          const dbOn = wP >= 0.56 && !(wP >= 0.60 && wP < 0.625)
          wDbRef.current.style.opacity = dbOn ? '1' : '0'
        }
        if (wLogoRef.current) {
          wLogoRef.current.style.opacity = compShow ? '1' : '0'
        }
      }

      if (veilRef.current) {
        const exitT = clamp01((u - 0.89) / 0.11)
        veilRef.current.style.opacity = smoothstep(exitT).toFixed(3)
      }

      if (u < 1 && !doneCalledRef.current) {
        rafId = window.requestAnimationFrame(stepFrame)
      } else if (!doneCalledRef.current) {
        doneCalledRef.current = true
        onDoneRef.current()
      }
    }

    rafId = window.requestAnimationFrame(stepFrame)
    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(doneTimer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [labels, phase, reducedMotion, tactileAudio, totalMs, triggerExit])

  return (
    <div
      ref={rootRef}
      className={`plugin-boot-overlay${exiting ? ' is-exiting' : ''}${reducedMotion ? ' reduced-motion' : ''}`}
      data-boot-theme={themeId}
      data-boot-style="rhine-lab-access"
      data-boot-mode={isDarkPolarity ? 'dark' : 'light'}
      data-boot-phase={phase}
      style={paletteStyle}
      role="dialog"
      aria-modal="true"
      aria-label={labels.brand}
      onClick={() => {
        if (phase === 'gate') {
          enterFromGate(false)
          return
        }
        if (!silentEntryRef.current) unlockRhineAudio()
        triggerExit(reducedMotion ? 120 : 220)
      }}
    >
      {/* Entry Confirmation Gate (unlocks Web Audio before 5-act boot playback) */}
      {phase === 'gate' && (
        <div className="pbo-gate">
          <div className="pbo-gate-logo" aria-hidden="true">
            <svg viewBox="0 0 310 185" fill="none">
              <path
                d="M156 75C127 48 103 15 70 15C37 15 15 39 15 70S38 128 70 128C103 128 127 96 176 52M155 75C182 99 208 128 240 128C273 128 295 105 295 73S273 15 240 15C221 15 207 23 192 38"
                stroke="currentColor"
                strokeWidth="26"
              />
              <path d="M44 70h50M69 45v50M219 70h44" stroke="currentColor" strokeWidth="15" />
              <text
                x="155"
                y="174"
                textAnchor="middle"
                fill="currentColor"
                fontSize="16"
                fontWeight="700"
                letterSpacing="16"
              >
                RHINE·LAB
              </text>
            </svg>
          </div>
          <div className="pbo-gate-ready">{labels.entryReadyText}</div>
          <div className="pbo-gate-rule" aria-hidden="true" />
          <div className="pbo-gate-frame">
            <button
              ref={gateEnterBtnRef}
              type="button"
              className="pbo-gate-enter"
              onClick={(e) => {
                e.stopPropagation()
                enterFromGate(false)
              }}
            >
              <span>{labels.entryButtonText}</span>
              <span className="pbo-gate-arrow" aria-hidden="true">
                →
              </span>
            </button>
          </div>
          <p className="pbo-gate-hint">{labels.entryHintText}</p>
          <div className="pbo-gate-secondary">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                enterFromGate(true)
              }}
            >
              {labels.entrySilentLabel}
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                triggerExit(180)
              }}
            >
              {labels.entryDirectLabel}
            </button>
          </div>
        </div>
      )}

      {/* Soft ambient topographic contours */}
      <div className="pbo-access-bg" aria-hidden="true">
        <svg ref={bgSvgRef} viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">
          <g fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113" />
            <path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130" />
            <circle cx="1450" cy="648" r="346" />
            <circle cx="1450" cy="648" r="348" />
          </g>
        </svg>
      </div>

      {/* Persistent Swiss Top-Left Masthead & Top-Right Quiet Skip */}
      <header className="pbo-access-masthead" aria-hidden="true">
        <h1
          className="pbo-access-mast-title"
          ref={(el) => {
            mastheadLinesRef.current[0] = el
          }}
        >
          {labels.brand}
        </h1>
        <div
          className="pbo-access-mast-sub"
          ref={(el) => {
            mastheadLinesRef.current[1] = el
          }}
        >
          {labels.mastheadSub}
        </div>
        <div
          className="pbo-access-mast-os"
          ref={(el) => {
            mastheadLinesRef.current[2] = el
          }}
        >
          <span>{labels.mastLead}</span>
          {labels.mastTail && <strong>{labels.mastTail}</strong>}
        </div>
      </header>

      {phase === 'playing' && (
        <button
          type="button"
          className="pbo-access-skip"
          onClick={(e) => {
            e.stopPropagation()
            if (!silentEntryRef.current) unlockRhineAudio()
            triggerExit(reducedMotion ? 120 : 220)
          }}
        >
          <span>{labels.skipLabel}</span>
          <span aria-hidden="true">↗</span>
        </button>
      )}

      {/* Act 1: Access Type-in */}
      <div ref={promptRef} className="pbo-access-prompt" aria-live="polite" />

      {/* Act 2: Broken-Infinity Emblem + Identity Handshake */}
      <div className="pbo-access-stage" aria-hidden="true">
        <div ref={logoWrapRef} className="pbo-access-logo">
          <svg viewBox="0 0 310 185" fill="none">
            <path
              ref={contourRef}
              d={RHINE_CONTOUR_PATH}
              pathLength={1}
              stroke="currentColor"
              strokeWidth={26}
            />
            <path ref={plusRef} d="M44 70h50M69 45v50" stroke="currentColor" strokeWidth={15} />
            <path ref={minusRef} d="M-22 0h44" stroke="currentColor" strokeWidth={15} />
            <text
              ref={logoTextRef}
              x="155"
              y="174"
              textAnchor="middle"
              fill="currentColor"
              fontSize="16"
              fontWeight="700"
              letterSpacing="16"
            />
          </svg>
        </div>

        <div ref={authWrapRef} className="pbo-access-auth">
          <span className="pbo-access-pip" />
          <span ref={authTextRef} className="pbo-access-auth-msg" />
          <i className="pbo-access-cursor" />
        </div>
      </div>

      {/* Act 3: Concentric Permission Scan Ring + Six Satellites */}
      <div ref={scanWrapRef} className="pbo-access-scan" aria-hidden="true">
        <svg viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid meet">
          <g ref={scanGroupRef} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path
              ref={(el) => {
                scanPathsRef.current[0] = el
              }}
              strokeWidth="2.6"
            />
            <path
              ref={(el) => {
                scanPathsRef.current[1] = el
              }}
              className="pbo-access-scan-contrast"
              strokeWidth="4"
            />
            <path
              ref={(el) => {
                scanPathsRef.current[2] = el
              }}
              strokeWidth="2"
            />
            <path
              ref={(el) => {
                scanPathsRef.current[3] = el
              }}
              strokeWidth="2"
            />
            <path
              ref={(el) => {
                scanPathsRef.current[4] = el
              }}
              strokeWidth="2.2"
            />
            <path
              ref={(el) => {
                scanPathsRef.current[5] = el
              }}
              strokeWidth="2.2"
            />
            {Array.from({ length: 6 }, (_, i) => (
              <circle
                key={i}
                ref={(el) => {
                  satellitesRef.current[i] = el
                }}
                fill="currentColor"
                stroke="none"
              />
            ))}
            <circle
              ref={(el) => {
                orbitDotsRef.current[0] = el
              }}
              className="pbo-access-orbit-dot"
              r="8"
              stroke="none"
            />
            <circle
              ref={(el) => {
                orbitDotsRef.current[1] = el
              }}
              className="pbo-access-orbit-dot"
              r="8"
              stroke="none"
            />
            <circle
              ref={(el) => {
                capsRef.current[0] = el
              }}
              fill="currentColor"
              stroke="none"
            />
            <circle
              ref={(el) => {
                capsRef.current[1] = el
              }}
              className="pbo-access-cap-contrast"
              stroke="none"
            />
            <circle ref={scanCoreRef} cx="960" cy="540" r="0" fill="currentColor" stroke="none" />
          </g>
        </svg>
        <span ref={scanTextRef} className="pbo-access-scan-text">
          {labels.authorizedText}
        </span>
      </div>

      {/* Act 4 & 5: Welcome Strobe + Redaction Wipe + Scale Exit */}
      <div className="pbo-access-welcome-outer" aria-hidden="true">
        <div ref={welcomeWrapRef} className="pbo-access-welcome">
          <div ref={wPanelRef} className="pbo-access-wpanel" />
          <div ref={wHeadingRef} className="pbo-access-wheading">
            {labels.welcomePrefix}
          </div>
          <div ref={wCompanyRef} className="pbo-access-wcompany">
            <strong className="pbo-access-wcompany-base">{labels.companyTag}</strong>
            <strong ref={wHighlightRef} className="pbo-access-whighlight" aria-hidden="true">
              {labels.companyTag}
            </strong>
          </div>
          <div ref={wDbRef} className="pbo-access-wdb">
            {labels.databaseTag}
          </div>
          <div ref={wLogoRef} className="pbo-access-wlogo">
            <svg viewBox="0 0 310 185" fill="none">
              <path
                d="M156 75C127 48 103 15 70 15C37 15 15 39 15 70S38 128 70 128C103 128 127 96 176 52M155 75C182 99 208 128 240 128C273 128 295 105 295 73S273 15 240 15C221 15 207 23 192 38"
                stroke="currentColor"
                strokeWidth="26"
              />
              <path d="M44 70h50M69 45v50M219 70h44" stroke="currentColor" strokeWidth="15" />
              <text
                x="155"
                y="174"
                textAnchor="middle"
                fill="currentColor"
                fontSize="16"
                fontWeight="700"
                letterSpacing="16"
              >
                RHINE·LAB
              </text>
            </svg>
          </div>
        </div>
      </div>

      {/* Bottom-right Powered By */}
      <footer ref={poweredRef} className="pbo-access-powered" aria-hidden="true">
        <span>{labels.poweredBy}</span>
        <i />
      </footer>

      {/* Act 5 Transition Veil */}
      <div ref={veilRef} className="pbo-access-veil" aria-hidden="true" />
    </div>
  )
}

/**
 * Full-viewport declarative boot overlay for theme plugins (e.g. Rhine Lab · 莱茵生命).
 * Supports both the 5-act `rhine-lab-access` PV choreography and legacy `rhine-lab-orbital` / `minimal-telemetry` modes.
 */
export function PluginBootOverlay({ boot, themeId, tactileAudio = false, onDone }: Props) {
  if (boot.style === 'rhine-lab-access') {
    return <RhineAccessBoot boot={boot} themeId={themeId} tactileAudio={tactileAudio} onDone={onDone} />
  }

  return <OrbitalBootOverlay boot={boot} themeId={themeId} onDone={onDone} />
}

function OrbitalBootOverlay({ boot, themeId, onDone }: Omit<Props, 'tactileAudio'>) {
  const { i18n } = useTranslation()
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh')
  const uid = useId().replace(/:/g, '')
  const [exiting, setExiting] = useState(false)
  const pctRef = useRef<HTMLSpanElement>(null)
  const doneCalledRef = useRef(false)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const effectiveDuration = reducedMotion ? 700 : Math.max(1200, Math.min(4500, boot.durationMs || 3000))
  const exitDuration = reducedMotion ? 180 : 460

  const paletteStyle = useMemo<CSSProperties>(() => {
    const p = boot.palette ?? {}
    return {
      '--boot-bg': p.bg ?? '#0d100e',
      '--boot-surface': p.surface ?? '#141916',
      '--boot-ink': p.ink ?? '#f2f1ea',
      '--boot-muted': p.muted ?? '#85968b',
      '--boot-olive': p.olive ?? '#5f8a73',
      '--boot-accent': p.accent ?? '#f06d2b',
      '--boot-accent-2': p.accent2 ?? '#8ec4a6',
      '--boot-grid': p.grid ?? 'rgba(133, 150, 139, 0.16)',
      '--boot-duration': `${effectiveDuration}ms`,
    } as CSSProperties
  }, [boot.palette, effectiveDuration])

  useEffect(() => {
    const finishExit = () => {
      if (doneCalledRef.current) return
      doneCalledRef.current = true
      onDoneRef.current()
    }

    let exitTimer: number | undefined
    let unmountTimer: number | undefined
    let rafId = 0

    const triggerExit = (delayMs = exitDuration) => {
      setExiting(true)
      window.clearTimeout(exitTimer)
      window.clearTimeout(unmountTimer)
      unmountTimer = window.setTimeout(finishExit, delayMs)
    }

    const startTime = performance.now()
    const fillMs = Math.max(450, effectiveDuration - exitDuration - 120)

    const tickPct = (now: number) => {
      const elapsed = now - startTime
      const rawT = Math.min(1, elapsed / fillMs)
      const eased = 1 - Math.pow(1 - rawT, 2.35)
      const pct = Math.min(100, Math.round(eased * 100))
      if (pctRef.current) {
        pctRef.current.textContent = `${String(pct).padStart(2, '0')}%`
      }
      if (rawT < 1) {
        rafId = window.requestAnimationFrame(tickPct)
      }
    }
    rafId = window.requestAnimationFrame(tickPct)

    exitTimer = window.setTimeout(() => triggerExit(exitDuration), Math.max(300, effectiveDuration - exitDuration))

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        triggerExit(reducedMotion ? 120 : 280)
      }
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.cancelAnimationFrame(rafId)
      window.clearTimeout(exitTimer)
      window.clearTimeout(unmountTimer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [effectiveDuration, exitDuration, reducedMotion])

  const skipLabel = isZh ? '[ 点击屏幕或按 ESC 跳过 ]' : '[ ESC / CLICK TO SKIP ]'
  const lines = boot.telemetryLines.length > 0
    ? boot.telemetryLines
    : [
        '[RL-01] RHINE LAB // CONTROL KERNEL ...... OK',
        '[RL-02] INTERFACE TELEMETRY ............. SYNCED',
      ]

  const isOrbital = boot.style !== 'minimal-telemetry'

  return (
    <div
      className={`plugin-boot-overlay${exiting ? ' is-exiting' : ''}${reducedMotion ? ' reduced-motion' : ''}`}
      data-boot-theme={themeId}
      data-boot-style={boot.style}
      style={paletteStyle}
      role="dialog"
      aria-modal="true"
      aria-label={boot.brand}
      onClick={() => {
        if (doneCalledRef.current) return
        setExiting(true)
        window.setTimeout(() => {
          if (!doneCalledRef.current) {
            doneCalledRef.current = true
            onDoneRef.current()
          }
        }, 280)
      }}
    >
      <div className="pbo-shutter pbo-shutter-top" aria-hidden="true" />
      <div className="pbo-shutter pbo-shutter-bottom" aria-hidden="true" />
      <div className="pbo-horizon-flash" aria-hidden="true" />

      <div className="pbo-grid" aria-hidden="true" />
      <div className="pbo-vignette" aria-hidden="true" />
      <div className="pbo-scanband" aria-hidden="true" />

      <div className="pbo-reticle pbo-reticle-tl" aria-hidden="true" />
      <div className="pbo-reticle pbo-reticle-tr" aria-hidden="true" />
      <div className="pbo-reticle pbo-reticle-bl" aria-hidden="true" />
      <div className="pbo-reticle pbo-reticle-br" aria-hidden="true" />

      <header className="pbo-hud-top">
        <div className="pbo-hud-block">
          <div className="pbo-hud-title-row">
            <span className="pbo-led" aria-hidden="true" />
            <span className="pbo-hud-primary">{boot.subBrand || boot.brand}</span>
          </div>
          {boot.division && <div className="pbo-hud-sub">{boot.division}</div>}
        </div>
        <div className="pbo-hud-block align-right">
          {boot.coordinates && <div className="pbo-hud-primary">{boot.coordinates}</div>}
          {(boot.specCode || boot.versionTag) && (
            <div className="pbo-hud-sub">{[boot.specCode, boot.versionTag].filter(Boolean).join(' · ')}</div>
          )}
        </div>
      </header>

      <div className="pbo-center">
        {isOrbital ? (
          <div className="pbo-astrolabe" aria-hidden="true">
            <svg className="pbo-svg" viewBox="0 0 380 380" fill="none">
              <defs>
                <radialGradient id={`pbo-glow-${uid}`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" style={{ stopColor: 'var(--boot-olive)', stopOpacity: 0.44 }} />
                  <stop offset="50%" style={{ stopColor: 'var(--boot-accent)', stopOpacity: 0.14 }} />
                  <stop offset="100%" style={{ stopColor: 'var(--boot-olive)', stopOpacity: 0 }} />
                </radialGradient>
                <linearGradient id={`pbo-prism-a-${uid}`} x1="158" y1="138" x2="218" y2="205" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" style={{ stopColor: 'var(--boot-ink)' }} />
                  <stop offset="100%" style={{ stopColor: 'var(--boot-accent)' }} />
                </linearGradient>
                <linearGradient id={`pbo-prism-b-${uid}`} x1="158" y1="190" x2="222" y2="245" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" style={{ stopColor: 'var(--boot-accent)' }} />
                  <stop offset="100%" style={{ stopColor: 'var(--boot-olive)' }} />
                </linearGradient>
              </defs>

              <circle cx="190" cy="190" r="138" fill={`url(#pbo-glow-${uid})`} />

              <g className="pbo-ring-cw">
                <circle
                  cx="190"
                  cy="190"
                  r="164"
                  stroke="var(--boot-grid)"
                  strokeWidth="1"
                  strokeDasharray="3 7"
                />
                {OUTER_AZIMUTH_TICKS.map((idx) => {
                  const angle = idx * 5
                  const isMajor = idx % 6 === 0
                  return (
                    <line
                      key={idx}
                      x1="190"
                      y1={isMajor ? 16 : 22}
                      x2="190"
                      y2={isMajor ? 28 : 26}
                      stroke={isMajor ? 'var(--boot-accent)' : 'var(--boot-olive)'}
                      strokeOpacity={isMajor ? 0.9 : 0.45}
                      strokeWidth={isMajor ? 1.5 : 0.9}
                      transform={`rotate(${angle} 190 190)`}
                    />
                  )
                })}
              </g>

              <g className="pbo-ring-ccw">
                <circle
                  className="pbo-arc-draw"
                  cx="190"
                  cy="190"
                  r="142"
                  stroke="var(--boot-olive)"
                  strokeWidth="1.6"
                  strokeOpacity="0.88"
                  strokeDasharray="116 28 24 28 168 30"
                />
                <circle
                  cx="190"
                  cy="190"
                  r="133"
                  stroke="var(--boot-accent)"
                  strokeWidth="1"
                  strokeOpacity="0.48"
                  strokeDasharray="2 11"
                />
              </g>

              <g transform="rotate(-22 190 190)">
                <ellipse
                  className="pbo-orbit-draw"
                  cx="190"
                  cy="190"
                  rx="154"
                  ry="50"
                  stroke="var(--boot-accent-2)"
                  strokeOpacity="0.58"
                  strokeWidth="1.15"
                  strokeDasharray="6 6"
                />
                <rect x="341" y="187" width="6" height="6" fill="var(--boot-accent-2)" />
              </g>
              <g transform="rotate(28 190 190)">
                <ellipse
                  className="pbo-orbit-draw-delay"
                  cx="190"
                  cy="190"
                  rx="156"
                  ry="44"
                  stroke="var(--boot-accent)"
                  strokeOpacity="0.72"
                  strokeWidth="1.2"
                />
                <rect x="31" y="187" width="6" height="6" fill="var(--boot-accent)" />
              </g>

              <g className="pbo-hex-lock">
                <polygon
                  points="190,82 266,114 298,190 266,266 190,298 114,266 82,190 114,114"
                  stroke="var(--boot-ink)"
                  strokeOpacity="0.32"
                  strokeWidth="1.2"
                />
                <polygon
                  className="pbo-hex-draw"
                  points="190,98 255,125 282,190 255,255 190,282 125,255 98,190 125,125"
                  stroke="var(--boot-olive)"
                  strokeOpacity="0.92"
                  strokeWidth="1.8"
                />
                <path d="M 185 72 H 195 M 190 67 V 77" stroke="var(--boot-accent)" strokeWidth="1.7" />
                <path d="M 184 308 H 196" stroke="var(--boot-ink)" strokeOpacity="0.7" strokeWidth="1.7" />
                <path d="M 74 184 L 66 190 L 74 196" stroke="var(--boot-accent-2)" strokeWidth="1.7" />
                <path d="M 306 184 L 314 190 L 306 196" stroke="var(--boot-accent-2)" strokeWidth="1.7" />
              </g>

              <g className="pbo-emblem-core">
                <polygon
                  points="146,154 190,126 234,154 222,222 190,244 158,222"
                  stroke="var(--boot-ink)"
                  strokeOpacity="0.22"
                  strokeWidth="1"
                />
                <path d="M 190 144 L 222 184 L 190 173 Z" fill={`url(#pbo-prism-a-${uid})`} opacity="0.96" />
                <path d="M 190 144 L 158 184 L 190 173 Z" fill="var(--boot-ink)" opacity="0.92" />
                <path d="M 158 184 L 190 173 L 222 184 L 190 232 Z" fill={`url(#pbo-prism-b-${uid})`} opacity="0.94" />
                <circle cx="190" cy="186" r="3.6" fill="var(--boot-ink)" />
              </g>
            </svg>
          </div>
        ) : (
          <div className="pbo-minimal-mark" aria-hidden="true">
            <span className="pbo-minimal-diamond" />
          </div>
        )}

        <div className="pbo-brand-stack">
          <div className="pbo-kicker">RHINE LAB · COLUMBIA RESEARCH CONSOLE</div>
          <h1 className="pbo-brand-title">{boot.brand}</h1>
          <div className="pbo-divider" aria-hidden="true" />
          {boot.systemTag && <div className="pbo-system-tag">{boot.systemTag}</div>}

          <div className="pbo-gauge-wrap">
            <div className="pbo-seg-gauge" aria-hidden="true">
              <div className="pbo-seg-cells">
                {GAUGE_SEGMENTS.map((seg) => (
                  <span key={seg} className="pbo-seg-cell" />
                ))}
              </div>
              <div className="pbo-seg-wipe" />
            </div>
            <span className="pbo-gauge-pct" ref={pctRef}>
              00%
            </span>
          </div>

          {boot.motto && <p className="pbo-motto">{boot.motto}</p>}
        </div>
      </div>

      <footer className="pbo-hud-bottom">
        <ul className="pbo-telemetry-list" aria-live="polite">
          {lines.map((line, i) => (
            <li
              key={`${i}-${line}`}
              className="pbo-telemetry-line"
              style={{ animationDelay: `${200 + i * 220}ms` }}
            >
              {line}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="pbo-skip-btn"
          onClick={(e) => {
            e.stopPropagation()
            if (doneCalledRef.current) return
            setExiting(true)
            window.setTimeout(() => {
              if (!doneCalledRef.current) {
                doneCalledRef.current = true
                onDoneRef.current()
              }
            }, 280)
          }}
        >
          {skipLabel}
        </button>
      </footer>
    </div>
  )
}
