import { memo, useId } from 'react'

export type OculusState = 'idle' | 'thinking' | 'tool' | 'approval' | 'error'

interface OculusProps {
  state?: OculusState
  size?: number
  label?: string
}

/**
 * Outer 3D isometric portal blade spanning two rounded outer hexagonal corners
 * (R = 10) and two inner courtyard walls (r = 6) with 30deg isometric bevel seams.
 * Rotated at 0deg, 120deg, and 240deg to form an interlocking architectural prism.
 */
const BLADE = 'M 6.63 5.1 L 10.61 2.8 Q 12 2 13.39 2.8 L 19.45 6.3 Q 20.66 7 20.66 8.4 L 20.66 9.2 L 17.2 11.2 L 17.2 9 L 12 6 L 10.09 7.1 Z'

/** Inner 3D faceted agent cursor-crystal suspended inside the central courtyard. */
const CORE_LEFT = 'M 12 7.2 L 8.15 13.5 L 12 11.95 Z'
const CORE_RIGHT = 'M 12 7.2 L 15.85 13.5 L 12 11.95 Z'
const CORE_BASE = 'M 8.15 13.5 L 12 11.95 L 15.85 13.5 L 12 16.3 Z'

interface Palette {
  a1: string
  a2: string
  b1: string
  b2: string
  c1: string
  c2: string
  coreLeft: string
  coreRight: string
  coreBase: string
}

const PALETTES: Record<'default' | 'approval' | 'error', Palette> = {
  default: {
    a1: 'var(--oculus-a1, #F7B796)',
    a2: 'var(--oculus-a2, #DE7B58)',
    b1: 'var(--oculus-b1, #DF7A55)',
    b2: 'var(--oculus-b2, #B55132)',
    c1: 'var(--oculus-c1, #C05837)',
    c2: 'var(--oculus-c2, #89341B)',
    coreLeft: 'var(--oculus-core-left, #FAD0BA)',
    coreRight: 'var(--oculus-core-right, #D46B48)',
    coreBase: 'var(--oculus-core-base, #923A20)',
  },
  approval: {
    a1: '#FCE09B',
    a2: '#E19D2B',
    b1: '#E19C28',
    b2: '#B4710B',
    c1: '#C27A10',
    c2: '#854D03',
    coreLeft: '#FDEAB8',
    coreRight: '#D68C16',
    coreBase: '#8D5405'
  },
  error: {
    a1: '#FBB7A8',
    a2: '#DE5A48',
    b1: '#D9513E',
    b2: '#A92E1F',
    c1: '#B53525',
    c2: '#7D1B12',
    coreLeft: '#FDCEC4',
    coreRight: '#CC4332',
    coreBase: '#821D13'
  }
}

/**
 * The Atrium AI mark: a 3D isometric interlocking architectural prism
 * housing a faceted autonomous cursor-crystal in warm terracotta tones.
 * Rotates smoothly while the inner crystal levitates in active states.
 */
export const Oculus = memo(function Oculus({ state = 'idle', size = 20, label }: OculusProps) {
  const uid = useId().replace(/:/g, '')
  const pal = state === 'approval' ? PALETTES.approval : state === 'error' ? PALETTES.error : PALETTES.default
  const ga = `oculus-pa-${uid}`
  const gb = `oculus-pb-${uid}`
  const gc = `oculus-pc-${uid}`

  return (
    <span
      className={`oculus oculus-${state}`}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span className="oculus-glow" aria-hidden="true" />
      <svg className="oculus-prism" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={ga} x1="7" y1="2" x2="20" y2="11" gradientUnits="userSpaceOnUse">
            <stop offset="0%" style={{ stopColor: pal.a1 }} />
            <stop offset="100%" style={{ stopColor: pal.a2 }} />
          </linearGradient>
          <linearGradient id={gb} x1="20" y1="9" x2="9" y2="21" gradientUnits="userSpaceOnUse">
            <stop offset="0%" style={{ stopColor: pal.b1 }} />
            <stop offset="100%" style={{ stopColor: pal.b2 }} />
          </linearGradient>
          <linearGradient id={gc} x1="9" y1="20" x2="6" y2="5" gradientUnits="userSpaceOnUse">
            <stop offset="0%" style={{ stopColor: pal.c1 }} />
            <stop offset="100%" style={{ stopColor: pal.c2 }} />
          </linearGradient>
        </defs>
        <path d={BLADE} fill={`url(#${ga})`} />
        <path d={BLADE} fill={`url(#${gb})`} transform="rotate(120 12 12)" />
        <path d={BLADE} fill={`url(#${gc})`} transform="rotate(240 12 12)" />
      </svg>
      <svg className="oculus-core" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d={CORE_LEFT} style={{ fill: pal.coreLeft }} />
        <path d={CORE_RIGHT} style={{ fill: pal.coreRight }} />
        <path d={CORE_BASE} style={{ fill: pal.coreBase }} />
      </svg>
    </span>
  )
})
