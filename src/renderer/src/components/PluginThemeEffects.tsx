import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import type { ActivePluginThemePayload } from '@shared/types.ts'
import { setArchiveModeOpen, useStore } from '../lib/store.ts'
import {
  isRhineAudioMuted,
  playRhineSound,
  RHINE_AUDIO_MUTE_EVENT,
  setRhineAudioMuted,
  unlockRhineAudio,
} from '../lib/rhineAudio.ts'

const INTERACTIVE_SELECTOR = [
  'button',
  '[role="button"]',
  '.side-item',
  '.chat-item-open',
  '.seg-btn',
  '.scene-btn',
  '.switch',
  '.starter-card',
  '.market-card',
  '.market-card-v2',
  '.market-scope-pill',
  '.settings-nav-item',
  '.palette-item',
  '.studio-tab',
  '.model-option',
  '.model-suggestion-item',
  '.perm-option',
  '.plus-item',
  '.ctx-menu-item',
  '.studio-select-option',
  '.platform-role-btn',
  '.platform-preset-btn',
  '.platform-topo-node-main',
  '.tool-chip',
  '.worktree-toggle',
  '.kind',
  '.preset-pill',
  '.row-toggle',
  '.cmd-pill',
].join(', ')

const TOGGLE_AUDIO_SELECTOR =
  '.switch, .seg-btn, .scene-btn, .studio-tab, .preset-pill, .market-scope-pill'

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
const CLOCK_SLOTS = [0, 1, 2, 3, 4, 5] as const
const MAX_RETICLES = 5

function clockDigits(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}${mm}${ss}`
}

/**
 * Sandboxed, purely visual & Web Audio tactile UI overlay enabled declaratively by theme plugins.
 * All high-frequency DOM updates (precision click reticles & rolling 6-digit clock strips) mutate
 * refs directly with zero React re-renders so typing, scrolling, and streaming stay silky smooth.
 */
export function PluginThemeEffects({ theme }: { theme: ActivePluginThemePayload }) {
  const layerRef = useRef<HTMLDivElement>(null)
  const clockWrapRef = useRef<HTMLSpanElement>(null)
  const stripRefs = useRef<Array<HTMLSpanElement | null>>([])
  const lastDigitsRef = useRef<string>('')
  const [muted, setMuted] = useState<boolean>(isRhineAudioMuted)
  const archiveModeOpen = useStore((s) => s.archiveModeOpen)

  const enableReticle = Boolean(theme.effects?.clickReticle)
  const enableAudio = Boolean(theme.effects?.tactileAudio)
  const enableHud = theme.chrome === 'rhine-lab' && Boolean(theme.effects?.telemetryHud) && !archiveModeOpen
  const enableArchiveMode = Boolean(theme.effects?.archiveMode)
  const enableRollingClock = Boolean(theme.effects?.rollingClock ?? enableHud)

  useEffect(() => {
    const onMuteSync = (ev: Event) => {
      const detail = (ev as CustomEvent<{ muted?: boolean }>).detail
      if (typeof detail?.muted === 'boolean') setMuted(detail.muted)
      else setMuted(isRhineAudioMuted())
    }
    window.addEventListener(RHINE_AUDIO_MUTE_EVENT, onMuteSync)
    return () => window.removeEventListener(RHINE_AUDIO_MUTE_EVENT, onMuteSync)
  }, [])

  useEffect(() => {
    if (!enableReticle && !enableAudio) return
    const reduced =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      const target = e.target as HTMLElement | null
      if (!target) return
      const hit = target.closest(INTERACTIVE_SELECTOR) as HTMLElement | null
      if (!hit || hit.hasAttribute('disabled') || hit.getAttribute('aria-disabled') === 'true') return

      if (enableAudio && !hit.closest('.rl-sfx-btn')) {
        unlockRhineAudio()
        playRhineSound(hit.matches(TOGGLE_AUDIO_SELECTOR) || hit.closest('.switch') ? 'ui-toggle' : 'ui-tick')
      }

      if (!enableReticle || reduced) return
      const layer = layerRef.current
      if (!layer) return

      while (layer.childElementCount >= MAX_RETICLES) {
        layer.firstElementChild?.remove()
      }

      const reticle = document.createElement('span')
      reticle.className = 'rl-click-reticle'
      reticle.style.left = `${Math.round(e.clientX)}px`
      reticle.style.top = `${Math.round(e.clientY)}px`
      layer.appendChild(reticle)

      const cleanup = () => reticle.remove()
      reticle.addEventListener('animationend', cleanup, { once: true })
      window.setTimeout(cleanup, 320)
    }

    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      if (layerRef.current) layerRef.current.innerHTML = ''
    }
  }, [enableAudio, enableReticle])

  useEffect(() => {
    if (!enableHud) return

    const syncClock = () => {
      const next = clockDigits()
      const formatted = `${next.slice(0, 2)}:${next.slice(2, 4)}:${next.slice(4, 6)}`
      if (clockWrapRef.current) {
        clockWrapRef.current.setAttribute('aria-label', formatted)
        if (!enableRollingClock) {
          clockWrapRef.current.textContent = formatted
          return
        }
      }
      if (!enableRollingClock) return
      const prev = lastDigitsRef.current
      for (let i = 0; i < 6; i++) {
        if (prev[i] === next[i]) continue
        const strip = stripRefs.current[i]
        if (strip) {
          strip.style.transform = `translate3d(0, -${next[i]}em, 0)`
        }
      }
      lastDigitsRef.current = next
    }

    syncClock()
    const timer = window.setInterval(syncClock, 1000)
    return () => {
      window.clearInterval(timer)
      lastDigitsRef.current = ''
    }
  }, [enableHud, enableRollingClock])

  const toggleMute = () => {
    const nextMuted = !muted
    setRhineAudioMuted(nextMuted)
    setMuted(nextMuted)
    if (!nextMuted) {
      unlockRhineAudio()
      playRhineSound('ui-toggle')
    }
  }

  return (
    <>
      {enableReticle && <div ref={layerRef} className="rl-effects-layer" aria-hidden="true" />}
      {enableHud && (
        <div className="rl-chrome-layer" aria-hidden="true">
          <div className="rl-hud-stamp">
            <span className="rl-hud-dot" />
            <span>SESSION AUTHORIZED</span>
            <span className="rl-hud-sep">·</span>
            {enableRollingClock ? (
              <span ref={clockWrapRef} className="rl-clock" role="timer">
                {CLOCK_SLOTS.map((slot) => (
                  <span key={slot} className="rl-clock-unit">
                    {slot === 2 || slot === 4 ? <span className="rl-clock-colon">:</span> : null}
                    <span className="rl-digit-slot" aria-hidden="true">
                      <span
                        ref={(el) => {
                          stripRefs.current[slot] = el
                        }}
                        className="rl-digit-strip"
                      >
                        {DIGITS.map((d) => (
                          <span key={d} className="rl-digit-cell">
                            {d}
                          </span>
                        ))}
                      </span>
                    </span>
                  </span>
                ))}
              </span>
            ) : (
              <span ref={clockWrapRef} className="rl-clock" role="timer" />
            )}
            {enableAudio && (
              <>
                <span className="rl-hud-sep">·</span>
                <button
                  type="button"
                  className="rl-sfx-btn"
                  onClick={toggleMute}
                  aria-label={muted ? 'Unmute Rhine Lab UI Audio' : 'Mute Rhine Lab UI Audio'}
                  title={muted ? 'SFX OFF' : 'SFX ON'}
                >
                  {muted ? <VolumeX size={10} /> : <Volume2 size={10} />}
                  <span>{muted ? 'MUTE' : 'SFX'}</span>
                </button>
              </>
            )}
            {enableArchiveMode && (
              <>
                <span className="rl-hud-sep">·</span>
                <div className="rl-mode-switch" role="group" aria-label="Rhine Lab 界面模式切换">
                  <button
                    type="button"
                    className={`rl-mode-btn${!archiveModeOpen ? ' active' : ''}`}
                    onClick={() => setArchiveModeOpen(false)}
                    aria-pressed={!archiveModeOpen}
                  >
                    工作台
                  </button>
                  <button
                    type="button"
                    className={`rl-mode-btn${archiveModeOpen ? ' active' : ''}`}
                    onClick={() => {
                      unlockRhineAudio()
                      playRhineSound('array')
                      setArchiveModeOpen(true)
                    }}
                    aria-pressed={archiveModeOpen}
                    title="进入 3D 莱茵生命档案提取模式 (Ctrl+Shift+A)"
                  >
                    档案模式
                  </button>
                </div>
              </>
            )}
            <span className="rl-hud-sep">·</span>
            <span className="rl-hud-powered">POWERED BY RHINE LAB</span>
            <i className="rl-hud-bar" />
          </div>
        </div>
      )}
    </>
  )
}
