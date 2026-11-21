import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, Plus, RefreshCw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProviderTestResult } from '@shared/ipc.ts'
import { PROVIDER_PRESETS, presetById } from '@shared/presets.ts'
import { groupModelsByVendor } from '@shared/relaypulse.ts'
import type { ProviderConfig, ProviderDraft } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { setState, toast } from '../lib/store.ts'
import { ModelCatalogDialog } from './ModelCatalogDialog.tsx'
import { Tile } from './Tile.tsx'

function uniqueModels(activeModel: string, list?: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (m: string | undefined) => {
    const clean = typeof m === 'string' ? m.trim() : ''
    if (!clean || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  push(activeModel)
  for (const m of list ?? []) push(m)
  return out
}

function draftFrom(existing?: ProviderConfig): ProviderDraft {
  if (existing) {
    return {
      ...existing,
      name: existing.managedBy === 'relaypulse' && existing.name === 'RelayPulse' ? 'Atrium Cloud' : existing.name,
      models: uniqueModels(existing.model, existing.models),
    }
  }
  const p = PROVIDER_PRESETS[0]!
  return {
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    model: p.model,
    models: uniqueModels(p.model, p.suggestedModels?.map((s) => s.id)),
    presetId: p.id,
  }
}

export function ProviderForm({ existing, onSaved, onCancel }: { existing?: ProviderConfig; onSaved: (p: ProviderConfig) => void; onCancel?: () => void }) {
  const { t, i18n } = useTranslation()
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFrom(existing))
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<ProviderTestResult | 'testing' | null>(null)
  const [saving, setSaving] = useState(false)
  const [listOpen, setListOpen] = useState(false)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [extraModelInput, setExtraModelInput] = useState('')
  const [expandedVendorGroups, setExpandedVendorGroups] = useState<Record<string, boolean>>({})
  const preset = presetById(draft.presetId)
  const configuredModels = uniqueModels(draft.model, draft.models)
  const set = (patch: Partial<ProviderDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setTest(null)
  }
  const addConfiguredModel = (rawId: string, makeDefault = false) => {
    const clean = rawId.trim()
    if (!clean) return
    setDraft((d) => ({
      ...d,
      model: makeDefault ? clean : d.model,
      models: uniqueModels(makeDefault ? clean : d.model, [...(d.models ?? []), clean]),
    }))
  }
  const removeConfiguredModel = (id: string) => {
    setDraft((d) => {
      const remaining = uniqueModels(d.model, d.models).filter((m) => m !== id)
      const nextDefault = d.model === id ? (remaining[0] ?? '') : d.model
      return { ...d, model: nextDefault, models: remaining }
    })
  }
  const toggleConfiguredModel = (id: string) => {
    if (configuredModels.includes(id)) {
      if (configuredModels.length > 1) removeConfiguredModel(id)
    } else {
      addConfiguredModel(id, false)
    }
  }
  const pickPreset = (id: string) => {
    const p = presetById(id)
    if (p) {
      set({
        presetId: p.id,
        name: p.name,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        model: p.model,
        models: uniqueModels(p.model, p.suggestedModels?.map((s) => s.id)),
      })
    } else {
      set({ presetId: undefined, name: 'Custom', baseUrl: '', model: '', models: [] })
    }
  }
  const withKey = (): ProviderDraft => ({
    ...draft,
    models: uniqueModels(draft.model, draft.models),
    apiKey: apiKey ? apiKey : undefined,
  })

  const runTest = async () => {
    setTest('testing')
    try {
      const result = await call('providers.test', withKey())
      setTest(result)
      if (!draft.model && result.models?.[0]) set({ model: result.models[0] })
      if (result.models?.length) setListOpen(true)
    } catch (err) {
      setTest({ ok: false, error: errorMessage(err) })
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const saved = await call('providers.save', withKey())
      const [providers, settings] = await Promise.all([call('providers.list'), call('settings.get')])
      setState({ providers, settings })
      onSaved(saved)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const apiModels = test && test !== 'testing' ? (test.models ?? []) : []
  const zh = i18n.language.startsWith('zh')
  const optionsMap = new Map<string, string | undefined>()
  for (const s of preset?.suggestedModels ?? []) {
    optionsMap.set(s.id, zh ? s.labelZh : s.labelEn)
  }
  for (const m of apiModels) {
    if (!optionsMap.has(m)) optionsMap.set(m, 'API')
  }
  const modelOptions = Array.from(optionsMap, ([id, badge]) => ({ id, badge }))

  const hint = preset ? (zh ? preset.keyHintZh : preset.keyHint) : undefined
  const activePreset = draft.presetId ?? 'custom'
  const isManaged = existing?.managedBy === 'relaypulse'

  return (
    <div className="provider-form">
      {isManaged ? (
        <div className="rp-pending-banner">
          <p style={{ margin: 0 }}>{t('settings.managedConnectionHint')}</p>
        </div>
      ) : (
        <>
          <div className="field">
            <span>{t('settings.provider')}</span>
            <div className="preset-pills" role="group" aria-label={t('settings.provider')}>
              {PROVIDER_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`preset-pill${activePreset === p.id ? ' active' : ''}`}
                  onClick={() => pickPreset(p.id)}
                >
                  {p.name}
                </button>
              ))}
              <button
                type="button"
                className={`preset-pill${activePreset === 'custom' ? ' active' : ''}`}
                onClick={() => pickPreset('custom')}
              >
                Custom
              </button>
            </div>
          </div>
          {!preset && (
            <label className="field">
              <span>{t('settings.name')}</span>
              <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </label>
          )}
          {(!preset || existing || preset.id === 'openai') && (
            <div className="field">
              <span>{t('settings.protocol')}</span>
              <div className="seg" role="group" aria-label={t('settings.protocol')}>
                <button
                  type="button"
                  className={`seg-btn${draft.protocol === 'anthropic' ? ' active' : ''}`}
                  onClick={() => set({ protocol: 'anthropic' })}
                >
                  {t('settings.protocolAnthropic')}
                </button>
                <button
                  type="button"
                  className={`seg-btn${draft.protocol === 'responses' ? ' active' : ''}`}
                  onClick={() => set({ protocol: 'responses' })}
                >
                  {t('settings.protocolResponses')}
                </button>
                <button
                  type="button"
                  className={`seg-btn${draft.protocol === 'openai' ? ' active' : ''}`}
                  onClick={() => set({ protocol: 'openai' })}
                >
                  {t('settings.protocolOpenai')}
                </button>
              </div>
            </div>
          )}
          <label className="field">
            <span>{t('settings.baseUrl')}</span>
            <input className="input" value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>{t('settings.apiKey')}</span>
            <input className="input" type="password" value={apiKey} autoComplete="off" placeholder={existing?.hasKey ? t('common.secretSaved') : ''} onChange={(e) => (setApiKey(e.target.value), setTest(null))} />
            {hint && <em className="field-hint">{hint}</em>}
          </label>
        </>
      )}
      <div className="field">
        <div className="rp-model-field-head">
          <span>{t('settings.model')}</span>
          <button
            type="button"
            className="btn btn-small"
            disabled={!draft.baseUrl.trim()}
            onClick={() => setCatalogOpen(true)}
          >
            <RefreshCw size={12} />
            <span>拉取并选择模型</span>
          </button>
        </div>
        <div className={`model-combo${listOpen ? ' open' : ''}`}>
          <div className="model-combo-bar">
            <input
              className="model-combo-input"
              value={draft.model}
              placeholder={t('settings.noModels')}
              onFocus={() => modelOptions.length > 0 && setListOpen(true)}
              onChange={(e) => set({ model: e.target.value })}
            />
            {modelOptions.length > 0 && (
              <button
                type="button"
                className={`model-combo-toggle${listOpen ? ' open' : ''}`}
                onClick={() => setListOpen((v) => !v)}
                aria-expanded={listOpen}
                aria-label={t('settings.pickModel')}
              >
                <span className="model-combo-count">{modelOptions.length}</span>
                <ChevronDown size={15} className="model-combo-chev" />
              </button>
            )}
          </div>
          {modelOptions.length > 0 && (
            <div className={`model-drawer${listOpen ? ' open' : ''}`}>
              <div className="model-drawer-inner">
                <div className="model-suggestion-list">
                  <div className="model-suggestion-head">{t('settings.suggestedModels')}</div>
                  {modelOptions.map((item) => {
                    const selected = draft.model === item.id
                    const pinned = configuredModels.includes(item.id)
                    return (
                      <div key={item.id} className={`model-suggestion-row${selected ? ' active' : ''}`}>
                        <button
                          type="button"
                          className={`model-suggestion-item${selected ? ' active' : ''}`}
                          onClick={() => {
                            addConfiguredModel(item.id, true)
                            setListOpen(false)
                          }}
                        >
                          <span className="model-suggestion-dot" aria-hidden />
                          <span className="model-suggestion-name">{item.id}</span>
                          {item.badge && <span className="model-suggestion-badge">{item.badge}</span>}
                          {selected && <Check size={14} className="model-suggestion-check" />}
                        </button>
                        <button
                          type="button"
                          className={`btn btn-small model-pin-btn${pinned ? ' active' : ''}`}
                          title={pinned ? '从供应商模型列表中移除' : '加入该供应商的模型列表'}
                          onClick={() => toggleConfiguredModel(item.id)}
                        >
                          {pinned ? '已加入' : '+ 加入'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
        {configuredModels.length > 0 && (() => {
          const vendorGroups = groupModelsByVendor(configuredModels)
          const activeModel = draft.model.trim()
          return (
            <div className="settings-vendor-groups">
              {vendorGroups.map((vg) => {
                const vOpen = Boolean(expandedVendorGroups[vg.id])
                const hasDefault = vg.models.includes(activeModel)
                return (
                  <div key={vg.id} className="settings-vendor-group">
                    <button
                      type="button"
                      className={`settings-vendor-toggle${vOpen ? ' open' : ''}${hasDefault ? ' has-active' : ''}`}
                      aria-expanded={vOpen}
                      onClick={() =>
                        setExpandedVendorGroups((prev) => ({
                          ...prev,
                          [vg.id]: !prev[vg.id],
                        }))
                      }
                    >
                      <span className="model-group-label">
                        <ChevronRight size={13} className={`chev${vOpen ? ' open' : ''}`} />
                        <Tile name={vg.tileName} />
                        <span>{vg.label}</span>
                      </span>
                      <span className="model-group-right">
                        {!vOpen && hasDefault && <span className="model-group-active">{activeModel}</span>}
                        <span className="model-group-count">{vg.models.length}</span>
                      </span>
                    </button>
                    {vOpen && (
                      <div className="provider-models-chips settings-model-chips">
                        {vg.models.map((m) => {
                          const isDefault = m === activeModel
                          return (
                            <span key={m} className={`provider-model-chip${isDefault ? ' active' : ''}`}>
                              <button
                                type="button"
                                className="provider-model-chip-btn"
                                title="设为该供应商当前默认模型"
                                onClick={() => set({ model: m })}
                              >
                                {isDefault && <Check size={11} />}
                                <span>{m}</span>
                              </button>
                              {configuredModels.length > 1 && (
                                <button
                                  type="button"
                                  className="provider-model-chip-rm"
                                  title="移除此模型"
                                  onClick={() => removeConfiguredModel(m)}
                                >
                                  <X size={11} />
                                </button>
                              )}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )
        })()}
        <div className="provider-add-model-row">
          <input
            className="input"
            value={extraModelInput}
            placeholder="追加其他模型 ID 到此供应商（回车或点右侧添加）"
            onChange={(e) => setExtraModelInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addConfiguredModel(extraModelInput, false)
                setExtraModelInput('')
              }
            }}
          />
          <button
            type="button"
            className="btn btn-small"
            disabled={!extraModelInput.trim()}
            onClick={() => {
              addConfiguredModel(extraModelInput, false)
              setExtraModelInput('')
            }}
          >
            <Plus size={13} />
            <span>添加模型</span>
          </button>
        </div>
      </div>
      {test && test !== 'testing' && (
        <p className={test.ok ? 'test-ok' : 'test-fail'}>
          {test.ok ? <Check size={14} /> : <AlertCircle size={14} />} {test.ok ? t('settings.ok') : test.error}
          {test.ok && apiModels.length > 0 && ` · ${t('settings.modelsFound', { count: apiModels.length })}`}
        </p>
      )}
      <div className="dialog-actions">
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button className={`btn${test && test !== 'testing' && test.ok ? '' : ' btn-primary'}`} onClick={() => void runTest()} disabled={test === 'testing'}>
          {test === 'testing' ? t('settings.testing') : t('settings.test')}
        </button>
        <button className={`btn${test && test !== 'testing' && test.ok ? ' btn-primary' : ''}`} onClick={() => void save()} disabled={saving || !draft.model.trim() || !draft.baseUrl.trim()}>
          {t('common.save')}
        </button>
      </div>
      {catalogOpen && (
        <ModelCatalogDialog
          title={`${draft.name || '供应商'} · 拉取模型列表`}
          target={withKey()}
          initialSelected={configuredModels}
          initialDefault={draft.model}
          suggestedIds={preset?.suggestedModels?.map((s) => s.id) ?? []}
          onConfirm={(selectedModels, defaultModel) => {
            setDraft((d) => ({
              ...d,
              model: defaultModel,
              models: selectedModels,
            }))
          }}
          onClose={() => setCatalogOpen(false)}
        />
      )}
    </div>
  )
}
