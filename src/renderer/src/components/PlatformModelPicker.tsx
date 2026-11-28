// Direct, partitioned, searchable model picker for any Platform agent (with optional local CLI default sync).
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Cpu, Globe, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import type { ReasoningEffort } from '@shared/types.ts'
import type { PlatformAgentProfile, PlatformModelOption } from '@shared/platform.ts'
import { shortModelLabel } from '@shared/orchestrator.ts'
import { classifyModelVendor, type ModelVendorMeta } from '@shared/relaypulse.ts'
import { useFeatureText } from '../locales/features.ts'
import { EffortMeter, EffortSlider } from './EffortSlider.tsx'
import { Tile } from './Tile.tsx'

export interface PlatformModelSelection {
  model: string
  providerId?: string
  reasoningEffort?: ReasoningEffort | ''
  syncToCliConfig?: boolean
}

export interface PlatformModelPickerProps {
  agent: PlatformAgentProfile
  variant: 'pill' | 'topo' | 'field'
  displayModelOverride?: string
  disabled?: boolean
  refreshing?: boolean
  onOpen?: () => void
  onRefresh?: () => void
  onSelect: (selection: PlatformModelSelection) => Promise<void> | void
  onChangeEffort?: (effort: ReasoningEffort, syncToCliConfig: boolean) => Promise<void> | void
}

interface PickerPos {
  left: number
  width: number
  maxHeight: number
  direction: 'up' | 'down'
  top?: number
  bottom?: number
}

interface OptionVendorBucket {
  id: string
  label: string
  tileName: string
  options: PlatformModelOption[]
}

interface AtriumProviderBucket {
  providerId: string
  label: string
  vendorBuckets: OptionVendorBucket[]
  totalCount: number
}

function conciseModelBadge(raw: string): string {
  const clean = raw.trim()
  if (!clean) return ''
  // Keep readable multi-word display names (e.g. "Gemini 4 Argon (Medium)"); compact only raw/long slugs.
  if (clean.includes(' ') && clean.length <= 28) return clean
  return shortModelLabel(clean)
}

export function resolveAgentModelDisplay(
  agent: PlatformAgentProfile,
  fallbackLabel: string,
  overrideRaw?: string,
): { label: string; full: string; isOverride: boolean } {
  const raw = (overrideRaw || agent.modelOverride || agent.defaultModel || '').trim()
  const isOverride = Boolean(agent.modelOverride && (!overrideRaw || overrideRaw === agent.modelOverride))
  if (!raw) {
    return { label: fallbackLabel, full: fallbackLabel, isOverride: false }
  }
  const list = agent.availableModels ?? []
  const lower = raw.toLowerCase()
  const matched =
    list.find(
      (m) =>
        (!agent.modelProviderOverride || !m.providerId || m.providerId === agent.modelProviderOverride) &&
        (m.id === raw || (m.label && m.label.trim().toLowerCase() === lower)),
    ) ?? list.find((m) => m.id === raw || (m.label && m.label.trim().toLowerCase() === lower))
  const resolvedLabel = matched?.label?.trim() || raw
  return {
    label: resolvedLabel,
    full: matched?.label && matched.label !== matched.id ? `${matched.label} (${matched.id})` : resolvedLabel,
    isOverride,
  }
}

function optionMatchesValue(opt: PlatformModelOption, target?: string, providerOverride?: string): boolean {
  if (!target?.trim()) return false
  if (providerOverride && opt.providerId && opt.providerId !== providerOverride) return false
  const lower = target.trim().toLowerCase()
  return opt.id === target.trim() || Boolean(opt.label && opt.label.trim().toLowerCase() === lower)
}

function vendorMetaForOption(opt: PlatformModelOption): ModelVendorMeta {
  const viaId = classifyModelVendor(opt.id)
  if (viaId.id !== 'other' || !opt.label) return viaId
  return classifyModelVendor(opt.label)
}

function bucketOptionsByVendor(options: readonly PlatformModelOption[]): OptionVendorBucket[] {
  const map = new Map<string, OptionVendorBucket>()
  for (const opt of options) {
    const meta = vendorMetaForOption(opt)
    let bucket = map.get(meta.id)
    if (!bucket) {
      bucket = { id: meta.id, label: meta.label, tileName: meta.tileName, options: [] }
      map.set(meta.id, bucket)
    }
    bucket.options.push(opt)
  }
  return [...map.values()]
}

function inferDisplayEffort(model?: string): ReasoningEffort | undefined {
  const clean = model?.trim()
  if (!clean) return undefined
  const paren = /\((low|medium|high|xhigh|max)\)\s*$/i.exec(clean)
  if (paren?.[1]) return paren[1].toLowerCase() as ReasoningEffort
  const slug = /-(low|medium|high|xhigh|max)\s*$/i.exec(clean)
  if (slug?.[1]) return slug[1].toLowerCase() as ReasoningEffort
  return undefined
}

export function PlatformModelPicker({
  agent,
  variant,
  displayModelOverride,
  disabled = false,
  refreshing = false,
  onOpen,
  onRefresh,
  onSelect,
  onChangeEffort,
}: PlatformModelPickerProps) {
  const { t } = useTranslation()
  const ft = useFeatureText()
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [query, setQuery] = useState('')
  const [syncToCliConfig, setSyncToCliConfig] = useState(false)
  const [openProviders, setOpenProviders] = useState<Record<string, boolean>>({})
  const [openVendors, setOpenVendors] = useState<Record<string, boolean>>({})
  const [pos, setPos] = useState<PickerPos | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const popoverId = useId()

  const models = agent.availableModels ?? []
  const display = useMemo(
    () => resolveAgentModelDisplay(agent, ft('platform.modelDefaultGeneric'), displayModelOverride),
    [agent, displayModelOverride, ft],
  )
  const effectiveEffort: ReasoningEffort = useMemo(() => {
    if (agent.reasoningEffortOverride) return agent.reasoningEffortOverride
    const fromOverride = agent.modelOverride ? inferDisplayEffort(agent.modelOverride) : undefined
    if (fromOverride) return fromOverride
    return agent.defaultReasoningEffort ?? 'auto'
  }, [agent.reasoningEffortOverride, agent.modelOverride, agent.defaultReasoningEffort])

  const q = query.trim().toLowerCase()

  const filteredModels = useMemo(() => {
    if (!q) return models
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.label && m.label.toLowerCase().includes(q)) ||
        (m.hint && m.hint.toLowerCase().includes(q)) ||
        (m.group && m.group.toLowerCase().includes(q)),
    )
  }, [models, q])

  // Atrium Agent partitions by Provider -> Vendor.
  const atriumBuckets = useMemo<AtriumProviderBucket[]>(() => {
    if (agent.kind !== 'atrium') return []
    const byProvider = new Map<string, { label: string; options: PlatformModelOption[] }>()
    for (const opt of filteredModels) {
      const pid = opt.providerId || opt.group || opt.hint || 'atrium'
      const pLabel = opt.group || opt.hint || 'Atrium'
      let entry = byProvider.get(pid)
      if (!entry) {
        entry = { label: pLabel, options: [] }
        byProvider.set(pid, entry)
      }
      entry.options.push(opt)
    }
    return [...byProvider.entries()].map(([providerId, entry]) => ({
      providerId,
      label: entry.label,
      vendorBuckets: bucketOptionsByVendor(entry.options),
      totalCount: entry.options.length,
    }))
  }, [agent.kind, filteredModels])

  // External multi-vendor catalogs (e.g. AGY or cc-switch Claude gateway) collapse by vendor, preserving Aliases at top.
  const multiVendorBuckets = useMemo<OptionVendorBucket[]>(() => {
    if (agent.kind === 'atrium') return []
    const aliases = filteredModels.filter((m) => m.group === 'Aliases')
    const rest = filteredModels.filter((m) => m.group !== 'Aliases')
    const buckets = bucketOptionsByVendor(rest)
    if (aliases.length > 0) {
      buckets.unshift({ id: 'aliases', label: 'Aliases', tileName: 'Claude', options: aliases })
    }
    return buckets
  }, [agent.kind, filteredModels])

  const useAccordionVendors = useMemo(() => {
    if (agent.kind === 'atrium') return false
    if (models.length < 7) return false
    const nonAliases = models.filter((m) => m.group !== 'Aliases')
    return bucketOptionsByVendor(nonAliases).length >= 2 || (models.some((m) => m.group === 'Aliases') && nonAliases.length >= 4)
  }, [agent.kind, models])

  const compactSections = useMemo(() => {
    if (agent.kind === 'atrium' || useAccordionVendors) return []
    const groups = new Set(filteredModels.map((m) => m.group || '').filter(Boolean))
    if (groups.size < 2) return [{ key: '__all__', label: '', options: filteredModels }]
    const map = new Map<string, PlatformModelOption[]>()
    for (const opt of filteredModels) {
      const key = opt.group || 'Other'
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(opt)
    }
    return [...map.entries()].map(([key, options]) => ({ key, label: key, options }))
  }, [agent.kind, useAccordionVendors, filteredModels])

  const defaultOptionLabel = agent.defaultModel
    ? ft('platform.modelDefaultOption', { model: agent.defaultModel })
    : ft('platform.modelDefaultGeneric')

  const showDefaultRow = useMemo(() => {
    if (!q) return true
    return (
      'default'.includes(q) ||
      '默认'.includes(q) ||
      defaultOptionLabel.toLowerCase().includes(q) ||
      (agent.defaultModel?.toLowerCase().includes(q) ?? false)
    )
  }, [q, defaultOptionLabel, agent.defaultModel])

  const cleanCustomQuery = query.trim()
  const showCustomRow = Boolean(
    cleanCustomQuery &&
      !models.some((m) => m.id.toLowerCase() === cleanCustomQuery.toLowerCase()),
  )

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
    if (disabled) return
    clearCloseTimer()
    setClosing(false)
    setSyncToCliConfig(false)

    // Pre-expand the provider/vendor currently active (override or default)
    const activeTarget = agent.modelOverride || agent.defaultModel
    const nextProviders: Record<string, boolean> = {}
    const nextVendors: Record<string, boolean> = {}

    if (agent.kind === 'atrium') {
      const allProviders = new Map<string, PlatformModelOption[]>()
      for (const opt of models) {
        const pid = opt.providerId || opt.group || opt.hint || 'atrium'
        const list = allProviders.get(pid) ?? []
        list.push(opt)
        allProviders.set(pid, list)
      }
      if (allProviders.size === 1) {
        const onlyPid = [...allProviders.keys()][0]!
        nextProviders[onlyPid] = true
      }
      for (const [pid, list] of allProviders) {
        const matchedOpt = list.find((opt) =>
          optionMatchesValue(opt, activeTarget, agent.modelProviderOverride),
        )
        if (matchedOpt) {
          nextProviders[pid] = true
          nextVendors[`${pid}:${vendorMetaForOption(matchedOpt).id}`] = true
        }
      }
      if (Object.keys(nextProviders).length === 0 && allProviders.size > 0) {
        nextProviders[[...allProviders.keys()][0]!] = true
      }
    } else if (models.length >= 7) {
      if (models.some((m) => m.group === 'Aliases')) nextVendors.aliases = true
      const matchedOpt = models.find((opt) => optionMatchesValue(opt, activeTarget))
      if (matchedOpt) {
        nextVendors[matchedOpt.group === 'Aliases' ? 'aliases' : vendorMetaForOption(matchedOpt).id] = true
      } else {
        const firstBucket = bucketOptionsByVendor(models)[0]
        if (firstBucket) nextVendors[firstBucket.id] = true
      }
    }

    setOpenProviders(nextProviders)
    setOpenVendors(nextVendors)
    setOpen(true)
    onOpen?.()
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
      const direction: 'up' | 'down' = availDown < 280 && availUp > availDown + 36 ? 'up' : 'down'

      const targetW = Math.max(rect.width, 336)
      const width = Math.min(targetW, window.innerWidth - margin * 2)
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))

      setPos({
        left,
        width,
        direction,
        maxHeight: Math.min(520, Math.max(220, direction === 'down' ? availDown : availUp)),
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
    if (!open || closing) return
    const raf = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [open, closing])

  const commitSelection = (sel: PlatformModelSelection) => {
    closeMenu()
    triggerRef.current?.focus()
    void onSelect(sel)
  }

  const menuVisible = open && pos !== null
  const isOpenState = open && !closing

  const renderModelOptionRow = (opt: PlatformModelOption, keyPrefix = '') => {
    const selected = Boolean(
      agent.modelOverride && optionMatchesValue(opt, agent.modelOverride, agent.modelProviderOverride),
    )
    const isLocalDefault = Boolean(
      agent.defaultModel && optionMatchesValue(opt, agent.defaultModel),
    )
    const primary = opt.label?.trim() || opt.id
    const secondary =
      opt.label && opt.label.trim() !== opt.id
        ? opt.hint && opt.group === 'Aliases'
          ? `${opt.id} ${opt.hint}`
          : opt.id
        : opt.hint && opt.hint !== primary
          ? opt.hint
          : undefined
    return (
      <button
        key={`${keyPrefix}${opt.providerId ?? ''}:${opt.id}`}
        type="button"
        className={`orch-picker-option platform-model-option${selected ? ' active' : ''}`}
        title={secondary ? `${primary} (${secondary})` : primary}
        onClick={() =>
          commitSelection({
            model: opt.id,
            providerId: opt.providerId,
            syncToCliConfig,
          })
        }
      >
        <span className="orch-picker-dot" aria-hidden />
        <span className="platform-model-opt-main">
          <span className="orch-picker-model">{primary}</span>
          {secondary && <span className="platform-model-opt-sub">{secondary}</span>}
        </span>
        {isLocalDefault && (
          <span className="studio-select-opt-badge">{ft('platform.modelDefaultBadge')}</span>
        )}
        {selected && <Check size={13} className="orch-picker-check" aria-hidden />}
      </button>
    )
  }

  return (
    <>
      {variant === 'pill' && (
        <button
          ref={triggerRef}
          type="button"
          className={`platform-model-pill${display.isOverride || Boolean(agent.reasoningEffortOverride) ? ' is-override' : ''}${isOpenState ? ' open' : ''}`}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={isOpenState}
          aria-controls={open ? popoverId : undefined}
          title={`${ft('platform.modelLabel')}: ${display.full}${agent.supportsReasoningEffort ? ` · ${t('chat.effort')}: ${t(`chat.effortLevels.${effectiveEffort}`)}` : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            toggleMenu()
          }}
        >
          <Cpu size={10} aria-hidden />
          <span className="platform-model-pill-text">{conciseModelBadge(display.label)}</span>
          {agent.supportsReasoningEffort && effectiveEffort !== 'auto' && (
            <EffortMeter level={effectiveEffort} size="sm" className="platform-pill-effort" />
          )}
          <ChevronDown size={10} className="platform-model-chev" aria-hidden />
        </button>
      )}

      {variant === 'topo' && (
        <button
          ref={triggerRef}
          type="button"
          className={`platform-topo-model-btn${display.isOverride || Boolean(agent.reasoningEffortOverride) ? ' is-override' : ''}${isOpenState ? ' open' : ''}`}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={isOpenState}
          aria-controls={open ? popoverId : undefined}
          title={`${ft('platform.modelLabel')}: ${display.full}${agent.supportsReasoningEffort ? ` · ${t('chat.effort')}: ${t(`chat.effortLevels.${effectiveEffort}`)}` : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            toggleMenu()
          }}
        >
          <span>{conciseModelBadge(display.label)}</span>
          {agent.supportsReasoningEffort && effectiveEffort !== 'auto' && (
            <EffortMeter level={effectiveEffort} size="sm" className="platform-pill-effort" />
          )}
          <ChevronDown size={10} className="platform-model-chev" aria-hidden />
        </button>
      )}

      {variant === 'field' && (
        <div className={`studio-select full${isOpenState ? ' open' : ''}`}>
          <button
            ref={triggerRef}
            type="button"
            className={`input studio-select-trigger${isOpenState ? ' open' : ''}`}
            disabled={disabled}
            aria-label={ft('platform.modelLabel')}
            aria-haspopup="dialog"
            aria-expanded={isOpenState}
            aria-controls={open ? popoverId : undefined}
            onClick={toggleMenu}
          >
            <span className="studio-select-value">
              <span className="studio-select-value-label">{display.label}</span>
              <span className="studio-select-value-badge">
                {display.isOverride ? ft('platform.modelOverrideBadge') : ft('platform.modelDefaultBadge')}
              </span>
            </span>
            <ChevronDown size={14} className="studio-select-chev" aria-hidden />
          </button>
        </div>
      )}

      {menuVisible &&
        createPortal(
          <div
            ref={menuRef}
            id={popoverId}
            role="dialog"
            aria-label={`${agent.name} ${ft('platform.modelLabel')}`}
            data-state={closing ? 'closing' : 'open'}
            data-direction={pos.direction}
            className="studio-select-popover orch-picker-popover platform-model-popover"
            style={{
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxHeight,
              ...(pos.top !== undefined ? { top: pos.top } : {}),
              ...(pos.bottom !== undefined ? { bottom: pos.bottom } : {}),
            }}
          >
            {/* Search / Custom Model Input + Refresh */}
            <div className="orch-picker-toolbar platform-model-toolbar">
              <div className="model-popover-search orch-picker-search">
                <Search size={13} aria-hidden />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && cleanCustomQuery) {
                      e.preventDefault()
                      const exact = models.find(
                        (m) =>
                          m.id.toLowerCase() === cleanCustomQuery.toLowerCase() ||
                          m.label?.toLowerCase() === cleanCustomQuery.toLowerCase(),
                      )
                      commitSelection({
                        model: exact ? exact.id : cleanCustomQuery,
                        providerId: exact?.providerId,
                        syncToCliConfig,
                      })
                    }
                  }}
                  placeholder={ft('platform.modelSearchOrType')}
                  aria-label={ft('platform.modelSearchOrType')}
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
              {onRefresh && (
                <button
                  type="button"
                  className="platform-model-refresh-btn"
                  disabled={refreshing}
                  title={ft('platform.refreshModels')}
                  aria-label={ft('platform.refreshModels')}
                  onClick={() => onRefresh()}
                >
                  <RefreshCw size={12} className={refreshing ? 'spin' : undefined} />
                </button>
              )}
            </div>

            {agent.endpointLabel && (
              <div className="platform-model-endpoint" title={agent.endpointLabel}>
                <Globe size={11} aria-hidden />
                <span>{ft('platform.endpointBanner', { host: agent.endpointLabel })}</span>
              </div>
            )}

            <div className="orch-picker-list">
              {refreshing && (
                <div className="platform-model-loading">
                  <RefreshCw size={12} className="spin" aria-hidden />
                  <span>{ft('platform.loadingModels')}</span>
                </div>
              )}

              {/* Reset to Local / CLI Default */}
              {showDefaultRow && (
                <button
                  type="button"
                  className={`orch-picker-auto${!agent.modelOverride && !agent.reasoningEffortOverride ? ' active' : ''}`}
                  onClick={() => commitSelection({ model: '', reasoningEffort: '' })}
                >
                  <Sparkles size={13} className="orch-picker-auto-icon" aria-hidden />
                  <span className="orch-picker-auto-main">
                    <span className="orch-picker-auto-title">{defaultOptionLabel}</span>
                    {agent.cliConfigPath && (
                      <span className="orch-picker-auto-sub">{agent.cliConfigPath}</span>
                    )}
                  </span>
                  <span className="studio-select-opt-badge">{ft('platform.modelDefaultBadge')}</span>
                  {!agent.modelOverride && <Check size={14} className="orch-picker-check" aria-hidden />}
                </button>
              )}

              {showDefaultRow && (filteredModels.length > 0 || showCustomRow) && (
                <div className="orch-picker-divider" aria-hidden />
              )}

              {/* Partition 1: Atrium Agent (Provider -> Vendor Accordions) */}
              {agent.kind === 'atrium' &&
                atriumBuckets.map((pb) => {
                  const isGroupOpen = Boolean(q || atriumBuckets.length === 1 || openProviders[pb.providerId])
                  const providerHasSelected = Boolean(
                    agent.modelOverride &&
                      pb.vendorBuckets.some((vb) =>
                        vb.options.some((opt) =>
                          optionMatchesValue(opt, agent.modelOverride, agent.modelProviderOverride),
                        ),
                      ),
                  )
                  return (
                    <div key={pb.providerId} className="model-popover-group">
                      <button
                        type="button"
                        className={`model-group-head model-group-toggle${isGroupOpen ? ' open' : ''}${providerHasSelected ? ' has-active' : ''}`}
                        aria-expanded={isGroupOpen}
                        onClick={() =>
                          setOpenProviders((prev) => ({
                            ...prev,
                            [pb.providerId]: !isGroupOpen,
                          }))
                        }
                      >
                        <span className="model-group-label">
                          {isGroupOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                          <Tile name={pb.label} />
                          <span>{pb.label}</span>
                        </span>
                        <span className="model-group-right">
                          {providerHasSelected && !isGroupOpen && agent.modelOverride && (
                            <span className="model-group-active" title={agent.modelOverride}>
                              {shortModelLabel(agent.modelOverride)}
                            </span>
                          )}
                          <span className="model-group-count">{pb.totalCount}</span>
                        </span>
                      </button>

                      {isGroupOpen && (
                        <div className="model-subgroups">
                          {pb.vendorBuckets.map((vb) => {
                            const subKey = `${pb.providerId}:${vb.id}`
                            const isSubOpen = Boolean(q || pb.vendorBuckets.length === 1 || openVendors[subKey])
                            const subHasSelected = Boolean(
                              agent.modelOverride &&
                                vb.options.some((opt) =>
                                  optionMatchesValue(opt, agent.modelOverride, agent.modelProviderOverride),
                                ),
                            )
                            return (
                              <div key={vb.id} className="model-subgroup">
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
                                    <Tile name={vb.tileName} />
                                    <span>{vb.label}</span>
                                  </span>
                                  <span className="model-group-right">
                                    <span className="model-group-count">{vb.options.length}</span>
                                  </span>
                                </button>
                                {isSubOpen && (
                                  <div className="model-subgroup-items">
                                    {vb.options.map((opt) => renderModelOptionRow(opt, pb.providerId))}
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

              {/* Partition 2: Multi-vendor external CLIs (e.g. AGY) */}
              {agent.kind !== 'atrium' &&
                useAccordionVendors &&
                multiVendorBuckets.map((vb) => {
                  const isOpen = Boolean(q || multiVendorBuckets.length === 1 || openVendors[vb.id])
                  const hasSelected = Boolean(
                    agent.modelOverride && vb.options.some((opt) => optionMatchesValue(opt, agent.modelOverride)),
                  )
                  return (
                    <div key={vb.id} className="model-popover-group">
                      <button
                        type="button"
                        className={`model-group-head model-group-toggle${isOpen ? ' open' : ''}${hasSelected ? ' has-active' : ''}`}
                        aria-expanded={isOpen}
                        onClick={() =>
                          setOpenVendors((prev) => ({
                            ...prev,
                            [vb.id]: !isOpen,
                          }))
                        }
                      >
                        <span className="model-group-label">
                          {isOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                          <Tile name={vb.tileName} />
                          <span>{vb.label}</span>
                        </span>
                        <span className="model-group-right">
                          {hasSelected && !isOpen && agent.modelOverride && (
                            <span className="model-group-active" title={agent.modelOverride}>
                              {conciseModelBadge(display.label)}
                            </span>
                          )}
                          <span className="model-group-count">{vb.options.length}</span>
                        </span>
                      </button>

                      {isOpen && (
                        <div className="model-subgroup-items">
                          {vb.options.map((opt) => renderModelOptionRow(opt))}
                        </div>
                      )}
                    </div>
                  )
                })}

              {/* Partition 3: Compact external CLI catalogs (Claude / Gemini / Codex / DSH) */}
              {agent.kind !== 'atrium' &&
                !useAccordionVendors &&
                compactSections.map((sec) => (
                  <div key={sec.key} className="platform-model-section">
                    {sec.label && <div className="platform-model-section-head">{sec.label}</div>}
                    {sec.options.map((opt) => renderModelOptionRow(opt))}
                  </div>
                ))}

              {models.length === 0 && !cleanCustomQuery && (
                <div className="model-popover-empty">{ft('platform.modelCustomEmptyHint')}</div>
              )}

              {/* Custom arbitrary model ID option */}
              {showCustomRow && (
                <button
                  type="button"
                  className="platform-model-custom-btn"
                  onClick={() =>
                    commitSelection({
                      model: cleanCustomQuery,
                      syncToCliConfig,
                    })
                  }
                >
                  <Plus size={13} aria-hidden />
                  <span>{ft('platform.modelUseCustom', { model: cleanCustomQuery })}</span>
                </button>
              )}
            </div>

            {agent.supportsReasoningEffort && (
              <div className="platform-model-effort-section">
                <EffortSlider
                  compact
                  title={t('chat.effort')}
                  value={effectiveEffort}
                  onChange={(lvl) => {
                    void onChangeEffort?.(lvl, syncToCliConfig)
                  }}
                />
              </div>
            )}

            {/* Footer: Option to persist selection into local CLI / Atrium default config */}
            {agent.supportsCliConfigSync && (
              <div className="platform-model-footer">
                <label className="platform-model-sync-toggle" title={agent.cliConfigPath}>
                  <input
                    type="checkbox"
                    checked={syncToCliConfig}
                    onChange={(e) => setSyncToCliConfig(e.target.checked)}
                  />
                  <span>
                    {agent.kind === 'atrium'
                      ? ft('platform.modelSyncAtriumCheckbox')
                      : ft('platform.modelSyncCheckbox')}
                  </span>
                </label>

                {(agent.modelOverride || agent.reasoningEffortOverride) && (
                  <button
                    type="button"
                    className="platform-text-btn platform-model-save-default"
                    title={agent.cliConfigPath}
                    onClick={() =>
                      commitSelection({
                        model: agent.modelOverride || agent.defaultModel || '',
                        providerId: agent.modelProviderOverride,
                        reasoningEffort: agent.reasoningEffortOverride,
                        syncToCliConfig: true,
                      })
                    }
                  >
                    {ft('platform.modelSaveAsDefault')}
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
