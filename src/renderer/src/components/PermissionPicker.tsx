import { useRef, useState } from 'react'
import { Check, ChevronDown, FileCheck2, ListChecks, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AGENT_MODES, type AgentMode } from '@shared/types.ts'
import { useAnchoredPopover, useDismissPopover } from '../lib/popover.ts'
import { useStore } from '../lib/store.ts'

const MODE_ICONS: Record<AgentMode, typeof Sparkles> = {
  auto: Sparkles,
  manual: ShieldCheck,
  accept_edits: FileCheck2,
  plan: ListChecks,
  bypass: ShieldAlert,
}

export function PermissionPicker({
  mode,
  direction = 'up',
  disabled,
  onSelect,
}: {
  mode: AgentMode
  direction?: 'up' | 'down'
  disabled?: boolean
  onSelect: (mode: AgentMode) => void
}) {
  const { t } = useTranslation()
  const allowBypass = useStore((s) => s.settings?.allowBypassPermissions !== false)
  const visibleModes = AGENT_MODES.filter((m) => allowBypass || m !== 'bypass')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const ActiveIcon = MODE_ICONS[mode] ?? Sparkles

  useDismissPopover(wrapRef, open, () => setOpen(false))
  const popStyle = useAnchoredPopover(wrapRef, popRef, open, {
    width: 318,
    direction,
    align: 'right',
    maxHeight: 460,
  })

  return (
    <div className={`perm-picker${open ? ' open' : ''} dir-${direction}`} ref={wrapRef}>
      <button
        type="button"
        className={`perm-pick mode-${mode}${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t('mode.switchHint')}
      >
        <ActiveIcon size={13} strokeWidth={2} />
        <span>{t(`mode.modes.${mode}.short`)}</span>
        <ChevronDown size={13} className="perm-pick-chev" />
      </button>

      <div
        ref={popRef}
        style={popStyle}
        className="perm-popover"
        role="listbox"
        aria-label={t('mode.menuTitle')}
      >
        <div className="perm-popover-head">{t('mode.menuTitle')}</div>
        <div className="perm-popover-list">
          {visibleModes.map((m, idx) => {
            const active = m === mode
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={active}
                style={{ transitionDelay: open ? `${Math.min(idx, 8) * 18}ms` : '0ms' }}
                className={`perm-option mode-${m}${active ? ' active' : ''}`}
                onClick={() => {
                  setOpen(false)
                  onSelect(m)
                }}
              >
                <span className="perm-option-main">
                  <span className="perm-option-title">{t(`mode.modes.${m}.label`)}</span>
                  <span className="perm-option-desc">{t(`mode.modes.${m}.desc`)}</span>
                </span>
                <span className="perm-option-check" aria-hidden>
                  {active && <Check size={15} strokeWidth={2.4} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
