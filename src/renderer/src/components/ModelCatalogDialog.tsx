import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, ChevronRight, Plus, RefreshCw, Search } from 'lucide-react'
import { groupModelsByVendor } from '@shared/relaypulse.ts'
import type { ProviderDraft } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { Dialog } from './Dialog.tsx'
import { Tile } from './Tile.tsx'

export function ModelCatalogDialog({
  title,
  target,
  initialSelected,
  initialDefault,
  suggestedIds = [],
  onConfirm,
  onClose,
}: {
  title: string
  target: ProviderDraft | string
  initialSelected: readonly string[]
  initialDefault: string
  suggestedIds?: readonly string[]
  onConfirm: (selectedModels: string[], defaultModel: string) => Promise<void> | void
  onClose: () => void
}) {
  const [fetching, setFetching] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [fetched, setFetched] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [customInput, setCustomInput] = useState('')
  const [selected, setSelected] = useState<string[]>(() => {
    const clean = [...new Set(initialSelected.map((m) => m.trim()).filter(Boolean))]
    return clean.length > 0 ? clean : initialDefault.trim() ? [initialDefault.trim()] : []
  })
  const [defaultModel, setDefaultModel] = useState<string>(initialDefault.trim())
  const [saving, setSaving] = useState(false)
  const [expandedVendors, setExpandedVendors] = useState<Record<string, boolean>>({})

  const runFetch = async () => {
    setFetching(true)
    setFetchError(null)
    try {
      const res = await call('providers.fetchModels', target)
      if (!res.ok) {
        setFetchError(res.error || '拉取模型列表失败')
      } else {
        setFetched(res.models ?? [])
        if ((res.models?.length ?? 0) === 0) {
          setFetchError('服务端返回了空的模型列表，你可以手动输入模型 ID 添加。')
        }
      }
    } catch (err) {
      setFetchError(errorMessage(err))
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    void runFetch()
  }, [])

  const fetchedSet = useMemo(() => new Set(fetched), [fetched])
  const suggestedSet = useMemo(() => new Set(suggestedIds), [suggestedIds])

  const catalog = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (id: string) => {
      const clean = id.trim()
      if (!clean || seen.has(clean)) return
      seen.add(clean)
      out.push(clean)
    }
    for (const id of fetched) push(id)
    for (const id of selected) push(id)
    for (const id of suggestedIds) push(id)
    return out
  }, [fetched, selected, suggestedIds])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter((id) => id.toLowerCase().includes(q))
  }, [catalog, query])

  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((m) => m !== id)
        if (defaultModel === id) setDefaultModel(next[0] ?? '')
        return next
      }
      if (!defaultModel) setDefaultModel(id)
      return [...prev, id]
    })
  }

  const makeDefault = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setDefaultModel(id)
  }

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = [...prev]
      const set = new Set(next)
      for (const id of filtered) {
        if (!set.has(id)) {
          set.add(id)
          next.push(id)
        }
      }
      if (!defaultModel && next[0]) setDefaultModel(next[0])
      return next
    })
  }

  const clearFiltered = () => {
    const filterSet = new Set(filtered)
    setSelected((prev) => {
      const next = prev.filter((id) => !filterSet.has(id) || id === defaultModel)
      return next
    })
  }

  const addCustom = () => {
    const clean = customInput.trim()
    if (!clean) return
    setSelected((prev) => (prev.includes(clean) ? prev : [...prev, clean]))
    if (!defaultModel) setDefaultModel(clean)
    setCustomInput('')
  }

  const handleConfirm = async () => {
    if (selected.length === 0) return
    setSaving(true)
    try {
      const finalDefault = selected.includes(defaultModel) ? defaultModel : selected[0]!
      await onConfirm(selected, finalDefault)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={title} onClose={onClose} wide>
      <div className="rp-catalog">
        <div className="rp-catalog-top">
          <div className="rp-catalog-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`搜索模型（已发现 ${fetched.length}，共 ${catalog.length} 个）…`}
            />
          </div>
          <button type="button" className="btn btn-small" disabled={fetching} onClick={() => void runFetch()}>
            <RefreshCw size={13} className={fetching ? 'spin' : ''} />
            <span>{fetching ? '拉取中…' : '重新拉取'}</span>
          </button>
        </div>

        <div className="rp-catalog-bar">
          <span className="rp-catalog-count">已勾选 {selected.length} 个模型</span>
          <div className="rp-catalog-bar-actions">
            <button type="button" className="btn btn-small" disabled={filtered.length === 0} onClick={selectAllFiltered}>
              全选当前筛选
            </button>
            <button type="button" className="btn btn-small" disabled={filtered.length === 0} onClick={clearFiltered}>
              仅保留默认
            </button>
          </div>
        </div>

        {fetchError && (
          <div className="rp-alert-error" role="alert">
            <AlertCircle size={14} />
            <span>{fetchError}</span>
          </div>
        )}

        <div className="rp-catalog-list" role="group" aria-label="可选模型列表">
          {fetching && catalog.length === 0 ? (
            <div className="rp-catalog-empty">正在从接口拉取可用模型列表…</div>
          ) : filtered.length === 0 ? (
            <div className="rp-catalog-empty">没有找到匹配的模型，你可以在下方手动添加</div>
          ) : (
            (() => {
              const vendorGroups = groupModelsByVendor(filtered)
              const hasQuery = Boolean(query.trim())
              const renderCatalogRow = (id: string, idx: number) => {
                const checked = selectedSet.has(id)
                const isDef = checked && defaultModel === id
                return (
                  <div
                    key={id}
                    style={{ '--cat-i': Math.min(idx, 12) } as React.CSSProperties}
                    className={`rp-catalog-item${checked ? ' selected' : ''}`}
                  >
                    <label className="rp-catalog-check">
                      <input
                        type="checkbox"
                        className="rp-sr-checkbox"
                        checked={checked}
                        onChange={() => toggle(id)}
                      />
                      <span className={`rp-catalog-box${checked ? ' checked' : ''}`} aria-hidden="true">
                        {checked && <Check size={11} strokeWidth={2.8} />}
                      </span>
                      <span className="rp-catalog-id">{id}</span>
                    </label>
                    <div className="rp-catalog-right">
                      {fetchedSet.has(id) && <span className="model-suggestion-badge">接口</span>}
                      {!fetchedSet.has(id) && suggestedSet.has(id) && (
                        <span className="model-suggestion-badge">推荐</span>
                      )}
                      {isDef ? (
                        <span className="chip chip-done">
                          <Check size={11} />
                          默认
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-ghost btn-small rp-catalog-default-btn"
                          onClick={() => makeDefault(id)}
                        >
                          设为默认
                        </button>
                      )}
                    </div>
                  </div>
                )
              }

              return vendorGroups.map((vg) => {
                const isOpen = hasQuery || Boolean(expandedVendors[vg.id])
                const checkedCount = vg.models.filter((id) => selectedSet.has(id)).length
                return (
                  <div key={vg.id} className="rp-catalog-vendor-group">
                    <button
                      type="button"
                      className={`rp-catalog-vendor-head${isOpen ? ' open' : ''}`}
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpandedVendors((prev) => ({
                          ...prev,
                          [vg.id]: !prev[vg.id],
                        }))
                      }
                    >
                      <span className="model-group-label">
                        <ChevronRight size={13} className={`chev${isOpen ? ' open' : ''}`} />
                        <Tile name={vg.tileName} />
                        <span>{vg.label}</span>
                      </span>
                      <span className="model-group-right">
                        {checkedCount > 0 && <span className="model-group-active">已选 {checkedCount}</span>}
                        <span className="model-group-count">{vg.models.length}</span>
                      </span>
                    </button>
                    {isOpen && vg.models.map((id, idx) => renderCatalogRow(id, idx))}
                  </div>
                )
              })
            })()
          )}
        </div>

        <div className="provider-add-model-row">
          <input
            className="input"
            value={customInput}
            placeholder="手动输入未列出模型 ID（回车加入）"
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addCustom()
              }
            }}
          />
          <button type="button" className="btn btn-small" disabled={!customInput.trim()} onClick={addCustom}>
            <Plus size={13} />
            <span>添加</span>
          </button>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || selected.length === 0}
            onClick={() => void handleConfirm()}
          >
            {saving ? '保存中…' : `确认使用这 ${selected.length} 个模型`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
