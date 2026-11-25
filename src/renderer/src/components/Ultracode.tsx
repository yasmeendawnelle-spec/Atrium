// Ultracode controls: the switch card (model popover + Settings) and the composer chip shown while it is on.
import { Hammer, ListTree, ShieldCheck, Sparkles, Telescope, X } from 'lucide-react'
import { Fragment, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

const STEPS = [
  { key: 'plan', Icon: ListTree },
  { key: 'explore', Icon: Telescope },
  { key: 'build', Icon: Hammer },
  { key: 'verify', Icon: ShieldCheck },
] as const

/** Plan → Explore → Build → Verify. The stages light up in turn once, when Ultracode is switched on. */
function UltracodeFlow({ detailed }: { detailed: boolean }) {
  const { t } = useTranslation()
  return (
    <ol className={`ultra-flow${detailed ? ' detailed' : ''}`} aria-label={t('ultracode.flowLabel')}>
      {!detailed && <li className="ultra-beam" role="presentation" aria-hidden />}
      {STEPS.map(({ key, Icon }, i) => (
        <Fragment key={key}>
          {i > 0 && !detailed && <li className="ultra-sep" role="presentation" aria-hidden />}
          <li className="ultra-step" style={{ '--step': i } as CSSProperties}>
            <span className="ultra-step-icon" aria-hidden>
              <Icon size={detailed ? 13 : 12} strokeWidth={2.2} />
            </span>
            <span className="ultra-step-text">
              <span className="ultra-step-label">{t(`ultracode.steps.${key}`)}</span>
              {detailed && <span className="ultra-step-hint">{t(`ultracode.stepHints.${key}`)}</span>}
            </span>
          </li>
        </Fragment>
      ))}
    </ol>
  )
}

export function UltracodeToggle({
  checked,
  onChange,
  variant = 'compact',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  /** `compact` for the model popover, `card` for Settings (always shows the workflow). */
  variant?: 'compact' | 'card'
}) {
  const { t } = useTranslation()
  const card = variant === 'card'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`ultra ultra-${variant}${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      {checked && <span className="ultra-aura" aria-hidden />}
      <span className="ultra-main">
        <span className="ultra-glyph" aria-hidden>
          <Sparkles size={card ? 17 : 14} strokeWidth={2} />
          {checked && <UltraBurst />}
        </span>
        <span className="ultra-body">
          <span className="ultra-title-row">
            <span className="ultra-title">Ultracode</span>
            <span className="ultra-state">{checked ? t('ultracode.on') : t('ultracode.off')}</span>
          </span>
          <span className="ultra-sub">{card ? t('ultracode.cardHint') : t('ultracode.hint')}</span>
        </span>
        <span className="ultra-switch" aria-hidden>
          <span />
        </span>
      </span>
      {(card || checked) && <UltracodeFlow detailed={card} />}
      {card && <span className="ultra-note">{t('ultracode.note')}</span>}
    </button>
  )
}

// Sparks thrown out once from the glyph when Ultracode turns on (mounting replays it).
const SPARKS = Array.from({ length: 10 }, (_, i) => ({
  angle: i * 36 + (i % 2 ? 12 : -6),
  dist: i % 2 ? 22 : 30,
  delay: (i % 3) * 40,
}))

function UltraBurst() {
  return (
    <span className="ultra-burst">
      {SPARKS.map((s, i) => (
        <i
          key={i}
          style={{ '--a': `${s.angle}deg`, '--d': `${s.dist}px`, '--delay': `${s.delay}ms` } as CSSProperties}
        />
      ))}
    </span>
  )
}

/** Composer chip while Ultracode is on; the × turns it off. */
export function UltracodeChip({ onDisable }: { onDisable: () => void }) {
  const { t } = useTranslation()
  return (
    <span className="ultra-chip" title={t('ultracode.hint')}>
      <span className="ultra-chip-aura" aria-hidden />
      <span className="ultra-chip-glyph" aria-hidden>
        <Sparkles size={12} strokeWidth={2.2} />
        <i className="ultra-twinkle t1" />
        <i className="ultra-twinkle t2" />
      </span>
      <span className="ultra-chip-label">Ultracode</span>
      <button type="button" className="ultra-chip-off" aria-label={t('ultracode.turnOff')} onClick={onDisable}>
        <X size={11} strokeWidth={2.4} />
      </button>
    </span>
  )
}
