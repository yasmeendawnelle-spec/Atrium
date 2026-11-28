// Dual-Model Orchestrator controls (model popover toggle, Settings card, and active composer chip).
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  ListTree,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
  Zap,
} from 'lucide-react'
import type { ProviderConfig } from '@shared/types.ts'
import { groupModelsByVendor, type ModelVendorGroup } from '@shared/relaypulse.ts'
import {
  displayProviderName,
  isLocalProviderUrl,
  ORCHESTRATOR_DEFAULT_MAX_HANDOFFS,
  ORCHESTRATOR_MAX_HANDOFFS,
  ORCHESTRATOR_MIN_HANDOFFS,
  resolveOrchestratorExecutor,
  scoreFastExecutorCandidate,
  shortModelLabel,
} from '@shared/orchestrator.ts'
import { useFeatureText } from '../locales/features.ts'
import { Tile } from './Tile.tsx'

const STAGES = [
  { key: 'plan', Icon: ListTree },
  { key: 'execute', Icon: Wrench },
  { key: 'review', Icon: ShieldCheck },
] as const

interface ExecutorMenuPos {
  left: number
  width: number
  maxHeight: number
  direction: 'up' | 'down'
  top?: number
  bottom?: number
}

interface ExecutorProviderGroup {
  provider: ProviderConfig
  label: string
  vendorGroups: ModelVendorGroup[]
  totalCount: number
  fastSet: Set<string>
}

function OrchestratorExecutorPicker({
  providers,
  activeProvider,
  resolved,
  pinnedActive,
  selectedProviderId,
  selectedModel,
  autoOptionLabel,
  ariaLabel,
  onSelect,
}: {
  providers: readonly ProviderConfig[]
  activeProvider?: ProviderConfig
  resolved: ReturnType<typeof resolveOrchestratorExecutor> | null
  pinnedActive: boolean
  selectedProviderId?: string
  selectedModel?: string
  autoOptionLabel: string
  ariaLabel: string
  onSelect: (providerId: string | undefined, model: string | undefined) => void
}) {
  const ft = useFeatureText()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [query, setQuery] = useState('')
  const [fastOnly, setFastOnly] = useState(false)
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({})
  const [openVendors, setOpenVendors] = useState<Record<string, boolean>>({})
  const [pos, setPos] = useState<ExecutorMenuPos | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const popoverId = useId()

  const providerGroups = useMemo<ExecutorProviderGroup[]>(() => {
    const out: ExecutorProviderGroup[] = []
    const buildGroup = (p: ProviderConfig, extraModel?: string): ExecutorProviderGroup | null => {
      const rawList = p.models?.length ? p.models : [p.model]
      const seen = new Set<string>()
      const baseList: string[] = []
      for (const raw of rawList) {
        const clean = raw.trim()
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        baseList.push(clean)
      }
      if (extraModel) {
        const cleanExtra = extraModel.trim()
        if (cleanExtra && !seen.has(cleanExtra)) {
          seen.add(cleanExtra)
          baseList.push(cleanExtra)
        }
      }
      if (baseList.length === 0) return null
      const fastSet = new Set<string>()
      for (const m of baseList) {
        if (scoreFastExecutorCandidate({ provider: p, model: m }, activeProvider ?? p, activeProvider?.model ?? m) >= 90) {
          fastSet.add(m)
        }
      }
      return {
        provider: p,
        label: displayProviderName(p),
        vendorGroups: groupModelsByVendor(baseList),
        totalCount: baseList.length,
        fastSet,
      }
    }

    for (const p of providers) {
      const extra = pinnedActive && selectedProviderId === p.id ? selectedModel : undefined
      const grp = buildGroup(p, extra)
      if (grp) out.push(grp)
    }

    if (pinnedActive && resolved && !providers.some((p) => p.id === resolved.provider.id)) {
      const grp = buildGroup(resolved.provider, resolved.model)
      if (grp) out.push(grp)
    }
    return out
  }, [providers, activeProvider, pinnedActive, selectedProviderId, selectedModel, resolved])

  const totalModelCount = useMemo(
    () => providerGroups.reduce((sum, pg) => sum + pg.totalCount, 0),
    [providerGroups],
  )

  const q = query.trim().toLowerCase()

  const filteredProviderGroups = useMemo<ExecutorProviderGroup[]>(() => {
    const out: ExecutorProviderGroup[] = []
    for (const pg of providerGroups) {
      const pMatch = q ? pg.label.toLowerCase().includes(q) : false
      const nextVendors: ModelVendorGroup[] = []
      let filteredTotal = 0
      for (const vg of pg.vendorGroups) {
        const vMatch = q ? vg.label.toLowerCase().includes(q) : false
        const models = vg.models.filter((m) => {
          if (fastOnly && !pg.fastSet.has(m)) return false
          if (q && !pMatch && !vMatch && !m.toLowerCase().includes(q)) return false
          return true
        })
        if (models.length > 0) {
          nextVendors.push({ ...vg, models })
          filteredTotal += models.length
        }
      }
      if (nextVendors.length > 0) {
        out.push({ ...pg, vendorGroups: nextVendors, totalCount: filteredTotal })
      }
    }
    return out
  }, [providerGroups, q, fastOnly])

  const showAutoRow = useMemo(() => {
    if (!q) return true
    return (
      'auto'.includes(q) ||
      '自动'.includes(q) ||
      autoOptionLabel.toLowerCase().includes(q) ||
      (resolved?.model.toLowerCase().includes(q) ?? false) ||
      (resolved ? displayProviderName(resolved.provider).toLowerCase().includes(q) : false)
    )
  }, [q, autoOptionLabel, resolved])

  const showToolbar = totalModelCount >= 4 || providerGroups.length > 1

  const triggerBadge = useMemo(() => {
    if (!pinnedActive) return ft('orchestrator.badgeAuto')
    if (!selectedModel) return undefined
    const grp = providerGroups.find((pg) => pg.provider.id === selectedProviderId)
    if (grp?.fastSet.has(selectedModel)) return ft('orchestrator.badgeFast')
    return undefined
  }, [pinnedActive, selectedModel, selectedProviderId, providerGroups, ft])

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const closeMenu = () => {
    if (!open && !closing) return
    setClosing(true)
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
      setQuery('')
    }, 140)
  }

  const openMenu = () => {
    clearCloseTimer()
    setClosing(false)
    const focusProviderId = selectedProviderId || resolved?.provider.id || providerGroups[0]?.provider.id
    const focusModel = selectedModel || resolved?.model
    const nextProviders: Record<string, boolean> = {}
    if (providerGroups.length === 1 && providerGroups[0]) {
      nextProviders[providerGroups[0].provider.id] = true
    } else if (focusProviderId) {
      nextProviders[focusProviderId] = true
    }
    setOpenProviders(nextProviders)

    const nextVendors: Record<string, boolean> = {}
    if (focusProviderId && focusModel) {
      const pg = providerGroups.find((g) => g.provider.id === focusProviderId)
      const vg = pg?.vendorGroups.find((v) => v.models.includes(focusModel))
      if (vg) nextVendors[`${focusProviderId}:${vg.id}`] = true
    }
    setOpenVendors(nextVendors)
    setOpen(true)
  }

  const toggleMenu = () => {
    if (open && !closing) closeMenu()
    else openMenu()
  }

  useEffect(() => () => clearCloseTimer(), [])

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const btn = triggerRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      const margin = 12
      const gap = 6
      const availDown = window.innerHeight - rect.bottom - gap - margin
      const availUp = rect.top - gap - margin
      const direction: 'up' | 'down' = availDown < 260 && availUp > availDown + 36 ? 'up' : 'down'

      const targetW = Math.max(rect.width, 320)
      const width = Math.min(targetW, window.innerWidth - margin * 2)
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))

      setPos({
        left,
        width,
        direction,
        maxHeight: Math.min(400, Math.max(180, direction === 'down' ? availDown : availUp)),
        ...(direction === 'down'
          ? { top: rect.bottom + gap }
          : { bottom: window.innerHeight - rect.top + gap }),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      closeMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open || closing || !showToolbar) return
    const raf = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, closing, showToolbar])

  const handleSelect = (providerId: string | undefined, model: string | undefined) => {
    onSelect(providerId, model)
    closeMenu()
    triggerRef.current?.focus()
  }

  const menuVisible = open && pos !== null

  return (
    <div className={`studio-select full orch-studio-select${open && !closing ? ' open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`input studio-select-trigger${open && !closing ? ' open' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open && !closing}
        aria-controls={open ? popoverId : undefined}
        onClick={toggleMenu}
      >
        <span className="studio-select-value">
          <span className="studio-select-value-label">
            {pinnedActive && selectedModel ? selectedModel : autoOptionLabel}
          </span>
          {triggerBadge && <span className="studio-select-value-badge">{triggerBadge}</span>}
        </span>
        <ChevronDown size={14} className="studio-select-chev" aria-hidden />
      </button>

      {menuVisible &&
        createPortal(
          <div
            ref={menuRef}
            id={popoverId}
            role="dialog"
            aria-label={ariaLabel}
            data-state={closing ? 'closing' : 'open'}
            data-direction={pos.direction}
            className="studio-select-popover orch-picker-popover"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
            }}
          >
            {showToolbar && (
              <div className="orch-picker-toolbar">
                <div className="model-popover-search orch-picker-search">
                  <Search size={13} aria-hidden />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={ft('orchestrator.searchExecutor')}
                    aria-label={ft('orchestrator.searchExecutor')}
                  />
                  {query && (
                    <button
                      type="button"
                      className="orch-picker-clear"
                      aria-label="Clear search"
                      onClick={() => {
                        setQuery('')
                        searchRef.current?.focus()
                      }}
                    >
                      <X size={11} aria-hidden />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className={`orch-picker-fast-filter${fastOnly ? ' active' : ''}`}
                  aria-pressed={fastOnly}
                  onClick={() => setFastOnly((prev) => !prev)}
                >
                  <Zap size={11} aria-hidden />
                  <span>{ft('orchestrator.filterFast')}</span>
                </button>
              </div>
            )}

            <div className="orch-picker-list">
              {showAutoRow && (
                <button
                  type="button"
                  className={`orch-picker-auto${!pinnedActive ? ' active' : ''}`}
                  onClick={() => handleSelect(undefined, undefined)}
                >
                  <Sparkles size={13} className="orch-picker-auto-icon" aria-hidden />
                  <span className="orch-picker-auto-main">
                    <span className="orch-picker-auto-title">{autoOptionLabel}</span>
                    {resolved && (
                      <span className="orch-picker-auto-sub">
                        {ft('orchestrator.autoHint', { provider: displayProviderName(resolved.provider) })}
                      </span>
                    )}
                  </span>
                  <span className="studio-select-opt-badge">{ft('orchestrator.badgeAuto')}</span>
                  {!pinnedActive && <Check size={14} className="orch-picker-check" aria-hidden />}
                </button>
              )}

              {showAutoRow && filteredProviderGroups.length > 0 && (
                <div className="orch-picker-divider" aria-hidden />
              )}

              {filteredProviderGroups.map((pg) => {
                const isGroupOpen = Boolean(q || fastOnly || providerGroups.length === 1 || openProviders[pg.provider.id])
                const providerHasSelected = Boolean(pinnedActive && selectedProviderId === pg.provider.id)
                return (
                  <div key={pg.provider.id} className="model-popover-group">
                    <button
                      type="button"
                      className={`model-group-head model-group-toggle${isGroupOpen ? ' open' : ''}${providerHasSelected ? ' has-active' : ''}`}
                      aria-expanded={isGroupOpen}
                      onClick={() =>
                        setOpenProviders((prev) => ({
                          ...prev,
                          [pg.provider.id]: !isGroupOpen,
                        }))
                      }
                    >
                      <span className="model-group-label">
                        {isGroupOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                        <Tile name={pg.label} />
                        <span>{pg.label}</span>
                      </span>
                      <span className="model-group-right">
                        {providerHasSelected && !isGroupOpen && selectedModel && (
                          <span className="model-group-active" title={selectedModel}>
                            {shortModelLabel(selectedModel)}
                          </span>
                        )}
                        <span className="model-group-count">{pg.totalCount}</span>
                      </span>
                    </button>

                    {isGroupOpen && (
                      <div className="model-subgroups">
                        {pg.vendorGroups.map((vg) => {
                          const subKey = `${pg.provider.id}:${vg.id}`
                          const isSoleVendor =
                            pg.vendorGroups.length === 1 && pg.provider.managedBy !== 'relaypulse'
                          const isSubOpen = Boolean(q || fastOnly || isSoleVendor || openVendors[subKey])
                          const subHasSelected = Boolean(
                            providerHasSelected && selectedModel && vg.models.includes(selectedModel),
                          )
                          return (
                            <div key={vg.id} className="model-subgroup">
                              <button
                                type="button"
                                className={`model-subgroup-toggle${isSubOpen ? ' open' : ''}${subHasSelected ? ' has-active' : ''}`}
                                aria-expanded={isSubOpen}
                                onClick={() =>
                                  setOpenVendors((prev) => ({
                                    ...prev,
                                    [subKey]: !isSubOpen,
                                  }))
                                }
                              >
                                <span className="model-group-label">
                                  {isSubOpen ? (
                                    <ChevronDown size={12} aria-hidden />
                                  ) : (
                                    <ChevronRight size={12} aria-hidden />
                                  )}
                                  <Tile name={vg.tileName} />
                                  <span>{vg.label}</span>
                                </span>
                                <span className="model-group-right">
                                  {subHasSelected && !isSubOpen && selectedModel && (
                                    <span className="model-group-active" title={selectedModel}>
                                      {shortModelLabel(selectedModel)}
                                    </span>
                                  )}
                                  <span className="model-group-count">{vg.models.length}</span>
                                </span>
                              </button>

                              {isSubOpen && (
                                <div className="model-subgroup-items">
                                  {vg.models.map((m) => {
                                    const isSelected = Boolean(providerHasSelected && selectedModel === m)
                                    const isFast = pg.fastSet.has(m)
                                    return (
                                      <button
                                        key={`${pg.provider.id}:${m}`}
                                        type="button"
                                        className={`orch-picker-option${isSelected ? ' active' : ''}`}
                                        title={m}
                                        onClick={() => handleSelect(pg.provider.id, m)}
                                      >
                                        <span className="orch-picker-dot" aria-hidden />
                                        <span className="orch-picker-model">{m}</span>
                                        {isFast && (
                                          <span className="orch-picker-fast-badge">{ft('orchestrator.badgeFast')}</span>
                                        )}
                                        {isSelected && <Check size={13} className="orch-picker-check" aria-hidden />}
                                      </button>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}

              {!showAutoRow && filteredProviderGroups.length === 0 && (
                <div className="studio-select-empty">{ft('orchestrator.noMatchingModels')}</div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

export function OrchestratorToggle({
  checked,
  onChange,
  providers,
  activeProvider,
  executorProviderId,
  executorModel,
  maxHandoffs = ORCHESTRATOR_DEFAULT_MAX_HANDOFFS,
  subagentsUseExecutor = true,
  onSelectExecutor,
  onUpdateAdvanced,
  variant = 'compact',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  providers: readonly ProviderConfig[]
  activeProvider?: ProviderConfig
  executorProviderId?: string
  executorModel?: string
  maxHandoffs?: number
  subagentsUseExecutor?: boolean
  onSelectExecutor: (providerId: string | undefined, model: string | undefined) => void
  onUpdateAdvanced?: (patch: { maxHandoffs?: number; subagentsUseExecutor?: boolean }) => void
  variant?: 'compact' | 'card'
}) {
  const ft = useFeatureText()
  const card = variant === 'card'
  const resolved = useMemo(
    () =>
      activeProvider
        ? resolveOrchestratorExecutor(providers, activeProvider, {
            orchestratorExecutorProviderId: executorProviderId,
            orchestratorExecutorModel: executorModel,
          })
        : null,
    [providers, activeProvider, executorProviderId, executorModel],
  )
  const usableProviders = useMemo(
    () => providers.filter((p) => p.hasKey || isLocalProviderUrl(p.baseUrl) || p.id === activeProvider?.id),
    [providers, activeProvider?.id],
  )

  const pinnedActive = Boolean(executorModel?.trim())
  const selectedProviderId = pinnedActive && resolved ? resolved.provider.id : undefined
  const selectedModel = pinnedActive && resolved ? resolved.model : undefined

  const autoOptionLabel = resolved
    ? resolved.isSameAsPlanner && resolved.source !== 'pinned'
      ? ft('orchestrator.autoSameModel')
      : ft('orchestrator.autoPick', { model: shortModelLabel(resolved.model) })
    : ft('orchestrator.autoPick', { model: 'Auto' })

  return (
    <div className={`orch orch-${variant}${checked ? ' on' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className="orch-head"
        onClick={() => onChange(!checked)}
      >
        <span className="orch-glyph" aria-hidden>
          <GitCompareArrows size={card ? 17 : 14} strokeWidth={2} />
        </span>
        <span className="orch-body">
          <span className="orch-title-row">
            <span className="orch-title">{ft('orchestrator.title')}</span>
            <span className="orch-state">{checked ? ft('orchestrator.on') : ft('orchestrator.off')}</span>
          </span>
          <span className="orch-sub">{card ? ft('orchestrator.cardHint') : ft('orchestrator.hint')}</span>
        </span>
        <span className="orch-switch" aria-hidden>
          <span />
        </span>
      </button>

      {(card || checked) && (
        <div className="orch-panel">
          <div className={`orch-flow${card ? ' detailed' : ''}`} role="list" aria-label={ft('orchestrator.title')}>
            {!card && <span className="orch-beam" aria-hidden />}
            {STAGES.map(({ key, Icon }, i) => (
              <Fragment key={key}>
                {i > 0 && !card && <span className="orch-sep" aria-hidden />}
                <span className="orch-step" role="listitem" style={{ '--step': i } as CSSProperties}>
                  <span className="orch-step-icon" aria-hidden>
                    <Icon size={card ? 13 : 12} strokeWidth={2.2} />
                  </span>
                  <span className="orch-step-text">
                    <span className="orch-step-label">{ft(`orchestrator.steps.${key}`)}</span>
                    {card && <span className="orch-step-hint">{ft(`orchestrator.stepHints.${key}`)}</span>}
                  </span>
                </span>
              </Fragment>
            ))}
          </div>

          {activeProvider && resolved && (
            <div className="orch-route-pill" title={ft('orchestrator.chipTitle', { planner: activeProvider.model, executor: resolved.model })}>
              <span className="orch-route-node plan">{shortModelLabel(activeProvider.model)}</span>
              <ArrowRight size={11} className="orch-route-arrow" aria-hidden />
              <span className="orch-route-node exec">{shortModelLabel(resolved.model)}</span>
            </div>
          )}

          <div className="orch-executor-row">
            <span className="orch-executor-label">{ft('orchestrator.executorLabel')}</span>
            <OrchestratorExecutorPicker
              providers={usableProviders}
              activeProvider={activeProvider}
              resolved={resolved}
              pinnedActive={pinnedActive}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              autoOptionLabel={autoOptionLabel}
              ariaLabel={ft('orchestrator.executorLabel')}
              onSelect={onSelectExecutor}
            />
          </div>

          {card && onUpdateAdvanced && (
            <div className="orch-advanced">
              <div className="orch-subagent-row">
                <div className="orch-check-meta">
                  <strong>{ft('orchestrator.subagentsLabel')}</strong>
                  <span>{ft('orchestrator.subagentsHint')}</span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={subagentsUseExecutor}
                    onChange={(e) => onUpdateAdvanced({ subagentsUseExecutor: e.target.checked })}
                    aria-label={ft('orchestrator.subagentsLabel')}
                  />
                  <span />
                </label>
              </div>

              <div className="orch-handoffs-row">
                <span>{ft('orchestrator.maxHandoffsLabel')}</span>
                <div className="seg" role="group" aria-label={ft('orchestrator.maxHandoffsLabel')}>
                  {Array.from(
                    { length: ORCHESTRATOR_MAX_HANDOFFS - ORCHESTRATOR_MIN_HANDOFFS + 1 },
                    (_, i) => ORCHESTRATOR_MIN_HANDOFFS + i,
                  ).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`seg-btn${maxHandoffs === n ? ' active' : ''}`}
                      onClick={() => onUpdateAdvanced({ maxHandoffs: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {card && <span className="orch-note">{ft('orchestrator.note')}</span>}
        </div>
      )}
    </div>
  )
}

export function OrchestratorChip({
  plannerModel,
  executorModel,
  onDisable,
  onOpenSettings,
}: {
  plannerModel: string
  executorModel: string
  onDisable: () => void
  onOpenSettings?: () => void
}) {
  const ft = useFeatureText()
  const execShort = shortModelLabel(executorModel)
  return (
    <span
      className="orch-chip"
      title={ft('orchestrator.chipTitle', { planner: plannerModel, executor: executorModel })}
    >
      <button
        type="button"
        className="orch-chip-main"
        onClick={onOpenSettings}
        disabled={!onOpenSettings}
      >
        <span className="orch-chip-glyph" aria-hidden>
          <GitCompareArrows size={12} strokeWidth={2.2} />
        </span>
        <span className="orch-chip-label">{ft('orchestrator.title')}</span>
        <ArrowRight size={10} className="orch-chip-arrow" aria-hidden />
        <span className="orch-chip-model">{execShort}</span>
      </button>
      <button
        type="button"
        className="orch-chip-off"
        aria-label={ft('orchestrator.turnOff')}
        onClick={(e) => {
          e.stopPropagation()
          onDisable()
        }}
      >
        <X size={11} strokeWidth={2.4} />
      </button>
    </span>
  )
}
