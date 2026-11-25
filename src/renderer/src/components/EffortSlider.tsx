// Reasoning effort slider (auto → max): drag, click a stop, or use the keyboard.
// The knob follows the pointer while dragging and springs onto the nearest stop on release.
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { WandSparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from '@shared/types.ts'

const LEVELS = REASONING_EFFORT_LEVELS
const LAST = LEVELS.length - 1
const KEY_COMMIT_MS = 260

const indexOf = (level: ReasoningEffort) => Math.max(0, LEVELS.indexOf(level))
const clampPos = (p: number) => Math.max(0, Math.min(LAST, p))

// Bar geometry in whole pixels, drawn as one SVG so every bar and gap renders the same width.
// (Separate flex boxes with %/fractional sizes snap to device pixels one by one and look uneven.)
const METER = {
  md: { bar: 3, gap: 2, base: 3, step: 2 }, // 23×11
  sm: { bar: 2, gap: 2, base: 2, step: 2 }, // 18×10
} as const

/** Five ascending bars lit up to the level; `auto` shows a wand instead (the model decides). */
export function EffortMeter({
  level,
  size = 'md',
  className = '',
}: {
  level: ReasoningEffort
  size?: keyof typeof METER
  className?: string
}) {
  const m = METER[size]
  const bars = LAST
  const height = m.base + (bars - 1) * m.step
  if (level === 'auto') {
    return (
      <span className={`effort-meter is-auto ${className}`} style={{ height }} aria-hidden>
        <WandSparkles size={height} strokeWidth={2.2} />
      </span>
    )
  }
  const lit = indexOf(level)
  const width = bars * m.bar + (bars - 1) * m.gap
  return (
    <span className={`effort-meter ${className}`} aria-hidden>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {Array.from({ length: bars }, (_, i) => {
          const h = m.base + i * m.step
          return (
            <rect
              key={i}
              className={i < lit ? 'on' : ''}
              x={i * (m.bar + m.gap)}
              y={height - h}
              width={m.bar}
              height={h}
              rx={m.bar / 2}
            />
          )
        })}
      </svg>
    </span>
  )
}

export function EffortSlider({
  value,
  onChange,
  compact = false,
  title,
  ariaLabel,
}: {
  value: ReasoningEffort
  onChange: (level: ReasoningEffort) => void
  compact?: boolean
  /** Shown on the left of the readout row (the popover uses it; Settings has its own label). */
  title?: string
  ariaLabel?: string
}) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(() => indexOf(value))
  const [dragPos, setDragPos] = useState<number | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef(false)

  // Follow outside changes (CLI, another window) unless the user is mid-change.
  useEffect(() => {
    if (dragPos === null && !pending.current) setIndex(indexOf(value))
  }, [value, dragPos])
  useEffect(() => () => clearTimeout(timer.current), [])

  const commit = (i: number, delay = 0) => {
    clearTimeout(timer.current)
    pending.current = true
    timer.current = setTimeout(() => {
      pending.current = false
      const next = LEVELS[i]
      if (next && next !== value) onChange(next)
    }, delay)
  }
  const select = (i: number, delay = 0) => {
    const next = Math.round(clampPos(i))
    setIndex(next)
    commit(next, delay)
  }

  const posAt = (clientX: number) => {
    const rect = railRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return index
    return clampPos(((clientX - rect.left) / rect.width) * LAST)
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    railRef.current?.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = posAt(e.clientX)
    setDragPos(p)
    setIndex(Math.round(p))
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragPos === null) return
    const p = posAt(e.clientX)
    setDragPos(p)
    setIndex(Math.round(p))
  }
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (dragPos === null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragPos(null)
    select(posAt(e.clientX))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowDown: -1,
      ArrowRight: 1,
      ArrowUp: 1,
      PageDown: -2,
      PageUp: 2,
    }
    let next: number | undefined
    if (e.key in step) next = index + (step[e.key] ?? 0)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = LAST
    if (next === undefined) return
    e.preventDefault()
    select(next, KEY_COMMIT_MS)
  }

  const level = LEVELS[index] ?? 'auto'
  const pos = dragPos ?? index
  const heat = index / LAST
  const style = {
    '--effort-pct': `${(pos / LAST) * 100}%`,
    '--effort-heat': heat.toFixed(3),
    '--effort-glow': `${Math.round(heat * heat * 55)}%`,
  } as CSSProperties

  return (
    <div
      className={`effort${compact ? ' effort-compact' : ''}${dragPos !== null ? ' is-dragging' : ''}`}
      data-level={level}
      style={style}
    >
      <div className="effort-head">
        {title ? (
          <span className="effort-title">{title}</span>
        ) : (
          // Without a title (Settings), the level description sits beside the readout.
          <p key={level} className="effort-hint effort-hint-inline" aria-live="polite">
            {t(`chat.effortHints.${level}`)}
          </p>
        )}
        <span className="effort-readout" aria-hidden>
          <EffortMeter level={level} />
          <span key={level} className="effort-readout-label">
            {t(`chat.effortLevels.${level}`)}
          </span>
        </span>
      </div>

      <div
        ref={railRef}
        className="effort-rail"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel ?? t('chat.effort')}
        aria-valuemin={0}
        aria-valuemax={LAST}
        aria-valuenow={index}
        aria-valuetext={`${t(`chat.effortLevels.${level}`)}: ${t(`chat.effortHints.${level}`)}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <span className="effort-track">
          <span className="effort-fill" />
        </span>
        {LEVELS.map((lvl, i) => (
          <span
            key={lvl}
            className={`effort-stop${i <= index ? ' passed' : ''}${i === 0 ? ' is-auto' : ''}`}
            style={{ left: `${(i / LAST) * 100}%` }}
          />
        ))}
        <span className="effort-knob">
          <span className="effort-knob-core" />
        </span>
      </div>

      <div className="effort-labels">
        {LEVELS.map((lvl, i) => (
          <button
            key={lvl}
            type="button"
            tabIndex={-1}
            className={`effort-label${i === index ? ' active' : ''}${i < index ? ' passed' : ''}`}
            style={{ left: `${(i / LAST) * 100}%` }}
            onClick={() => select(i)}
          >
            {t(`chat.effortLevels.${lvl}`)}
          </button>
        ))}
      </div>

      {title && (
        <p key={level} className="effort-hint" aria-live="polite">
          {t(`chat.effortHints.${level}`)}
        </p>
      )}
    </div>
  )
}
