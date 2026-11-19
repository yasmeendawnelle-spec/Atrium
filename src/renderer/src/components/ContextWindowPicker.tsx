import { useMemo, useRef, useState } from 'react'
import { ChevronRight, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CONTEXT_WINDOW_PRESETS, normalizeContextWindowTokens } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { formatCompactTokens, type ContextBreakdown } from '../lib/contextUsage.ts'
import { useAnchoredPopover, useDismissPopover } from '../lib/popover.ts'
import { setState, toast, useStore } from '../lib/store.ts'

export function ContextWindowPicker({
  context,
  direction = 'up',
  onCompact,
}: {
  context: ContextBreakdown
  direction?: 'up' | 'down'
  onCompact?: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [openSection, setOpenSection] = useState<'mcp' | 'memory' | 'skills' | null>(null)
  const servers = useStore((s) => s.servers)
  const statuses = useStore((s) => s.statuses)
  const skills = useStore((s) => s.skills)
  const memories = useStore((s) => s.memories)
  const memoryEnabled = useStore((s) => s.settings?.memoryEnabled !== false)
  const workspace = useStore((s) => s.settings?.workspace)
  const contextWindowTokens = useStore((s) => normalizeContextWindowTokens(s.settings?.contextWindowTokens))
  const [savingLimit, setSavingLimit] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useDismissPopover(wrapRef, open, () => {
    setOpen(false)
    setExpanded(false)
    setOpenSection(null)
  })
  const popStyle = useAnchoredPopover(wrapRef, popRef, open, {
    width: 328,
    direction,
    align: 'right',
    maxHeight: 480,
  })

  const mcpServersList = useMemo(
    () =>
      servers
        .filter((srv) => srv.enabled)
        .map((srv) => ({
          id: srv.id,
          name: srv.name,
          count: statuses[srv.id]?.tools?.length ?? 0,
        })),
    [servers, statuses],
  )
  const totalMcpTools = useMemo(
    () => mcpServersList.reduce((acc, s) => acc + s.count, 0),
    [mcpServersList],
  )
  const activeMemories = useMemo(() => {
    if (!memoryEnabled) return []
    const norm = (p?: string) => (p ? p.replace(/\\/g, '/').toLowerCase() : '')
    const curWs = norm(workspace)
    return memories.filter((m) => m.scope === 'global' || (curWs && norm(m.workspace) === curWs))
  }, [memories, memoryEnabled, workspace])
  const enabledSkills = useMemo(() => skills.filter((s) => s.enabled !== false), [skills])

  const limit = Math.max(1, context.limitTokens)
  const total = Math.max(0, context.totalTokens)
  const pct = Math.min(100, Math.round((total / limit) * 100))
  const buffer = Math.min(Math.max(0, limit - total), context.autocompactBufferTokens)
  const remaining = Math.max(0, limit - total - buffer)
  const remainingPct = Math.round((remaining / limit) * 1000) / 10
  const bufferPct = Math.round((buffer / limit) * 1000) / 10

  const ringR = 5.8
  const ringC = 2 * Math.PI * ringR
  const ringRatio = total > 0 ? Math.max(0.06, Math.min(1, total / limit)) : 0.08
  const ringDash = ringC * ringRatio
  const ringTone = pct >= 90 ? 'var(--danger)' : pct >= 75 ? 'var(--warn)' : 'var(--accent)'

  const segments = [
    { key: 'system', color: '#5b94f6', label: t('chat.ctxSystem'), tokens: context.systemTokens },
    { key: 'tools', color: '#d67a5a', label: t('chat.ctxTools'), tokens: context.toolsTokens },
    { key: 'messages', color: '#4aa87b', label: t('chat.ctxMessages'), tokens: context.messagesTokens },
    { key: 'toolOutputs', color: '#d99b3c', label: t('chat.ctxToolOutputs'), tokens: context.toolOutputsTokens },
    { key: 'reasoning', color: '#8c8982', label: t('chat.ctxReasoning'), tokens: context.reasoningTokens },
  ].filter((seg) => seg.tokens > 0)

  const summaryLabel = `${formatCompactTokens(total)} / ${formatCompactTokens(limit)} (${pct}%)`

  const selectLimitPreset = async (tokens: number) => {
    if (savingLimit || tokens === contextWindowTokens) return
    setSavingLimit(true)
    try {
      const updated = await call('settings.update', { contextWindowTokens: tokens })
      setState({ settings: updated })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSavingLimit(false)
    }
  }

  return (
    <div className={`context-picker${open ? ' open' : ''} dir-${direction}`} ref={wrapRef}>
      <button
        type="button"
        className={`context-ring-btn${open ? ' open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('chat.contextWindowTitle')}
        title={`${t('chat.contextWindowTitle')}: ${summaryLabel}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={ringR} fill="none" stroke="currentColor" strokeOpacity="0.24" strokeWidth="1.85" />
          <circle
            cx="8"
            cy="8"
            r={ringR}
            fill="none"
            stroke={ringTone}
            strokeWidth="1.85"
            strokeLinecap="round"
            strokeDasharray={`${ringDash} ${ringC}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>

      <div
        ref={popRef}
        style={popStyle}
        className="context-popover"
        role="region"
        aria-label={t('chat.contextWindowTitle')}
      >
        <button
          type="button"
          className="context-pop-head"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="context-pop-title">{t('chat.contextWindowTitle')}</span>
          <span className="context-pop-stats">
            <span>{summaryLabel}</span>
            <ChevronRight size={13} className={`context-pop-chev${expanded ? ' open' : ''}`} />
          </span>
        </button>

        <div className="context-bar-track" aria-hidden="true">
          {segments.map((seg) => {
            const widthPct = Math.max(1.2, (seg.tokens / limit) * 100)
            return (
              <span
                key={seg.key}
                className="context-bar-seg"
                style={{ width: `${widthPct}%`, backgroundColor: seg.color }}
              />
            )
          })}
        </div>

        <div className="context-limit-picker">
          <div className="context-limit-head">
            <span>{t('chat.ctxLimitLabel')}</span>
            <code>{contextWindowTokens > 0 ? formatCompactTokens(contextWindowTokens) : t('chat.ctxLimitAuto')}</code>
          </div>
          <div className="context-limit-pills" role="radiogroup" aria-label={t('chat.ctxLimitLabel')}>
            {CONTEXT_WINDOW_PRESETS.map((preset) => {
              const selected = contextWindowTokens === preset
              const label = preset === 0 ? t('chat.ctxLimitAuto') : formatCompactTokens(preset)
              return (
                <button
                  key={preset}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={savingLimit}
                  className={`context-limit-pill${selected ? ' active' : ''}`}
                  onClick={() => void selectLimitPreset(preset)}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="context-pop-divider" />

        {!expanded ? (
          <div className="context-pop-foot">
            <button
              type="button"
              className="context-breakdown-btn"
              onClick={() => setExpanded(true)}
            >
              {t('chat.seeDetailedBreakdown')}
            </button>
          </div>
        ) : (
          <div className="context-breakdown">
            <div className="context-breakdown-list">
              {segments.length === 0 ? (
                <div className="context-breakdown-empty">{t('chat.ctxEmpty')}</div>
              ) : (
                segments.map((seg) => {
                  const segPct = Math.round((seg.tokens / limit) * 1000) / 10
                  return (
                    <div key={seg.key} className="context-breakdown-row">
                      <span className="context-dot" style={{ backgroundColor: seg.color }} aria-hidden="true" />
                      <span className="context-row-label">{seg.label}</span>
                      <span className="context-row-val">
                        {formatCompactTokens(seg.tokens)}
                        <em>{segPct >= 0.1 ? ` (${segPct.toFixed(1)}%)` : ''}</em>
                      </span>
                    </div>
                  )
                })
              )}
              {context.cacheReadTokens > 0 && (
                <div className="context-breakdown-row meta">
                  <span className="context-dot meta" aria-hidden="true" />
                  <span className="context-row-label">{t('chat.ctxCacheRead')}</span>
                  <span className="context-row-val">{formatCompactTokens(context.cacheReadTokens)}</span>
                </div>
              )}
              {buffer > 0 && (
                <div className="context-breakdown-row meta">
                  <span className="context-dot buffer" aria-hidden="true" />
                  <span className="context-row-label">{t('chat.ctxAutocompact')}</span>
                  <span className="context-row-val">
                    {formatCompactTokens(buffer)}
                    <em>{bufferPct >= 0.1 ? ` (${bufferPct.toFixed(1)}%)` : ''}</em>
                  </span>
                </div>
              )}
              <div className="context-breakdown-row meta">
                <span className="context-dot meta" aria-hidden="true" />
                <span className="context-row-label">{t('chat.ctxRemaining')}</span>
                <span className="context-row-val">
                  {formatCompactTokens(remaining)}
                  <em>{remainingPct >= 0.1 ? ` (${remainingPct.toFixed(1)}%)` : ''}</em>
                </span>
              </div>
            </div>

            <div className="context-detail-groups">
              <div className="context-detail-group">
                <button
                  type="button"
                  className="context-detail-toggle"
                  onClick={() => setOpenSection((s) => (s === 'mcp' ? null : 'mcp'))}
                  aria-expanded={openSection === 'mcp'}
                >
                  <ChevronRight size={12} className={`context-detail-chev${openSection === 'mcp' ? ' open' : ''}`} />
                  <span>{t('chat.ctxMcpDetails', { count: totalMcpTools })}</span>
                </button>
                {openSection === 'mcp' && (
                  <div className="context-detail-items">
                    {mcpServersList.length === 0 ? (
                      <div className="context-detail-empty">{t('chat.ctxNoItems')}</div>
                    ) : (
                      mcpServersList.map((srv) => (
                        <div key={srv.id} className="context-detail-item">
                          <span>{srv.name}</span>
                          <em>{srv.count}</em>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="context-detail-group">
                <button
                  type="button"
                  className="context-detail-toggle"
                  onClick={() => setOpenSection((s) => (s === 'memory' ? null : 'memory'))}
                  aria-expanded={openSection === 'memory'}
                >
                  <ChevronRight size={12} className={`context-detail-chev${openSection === 'memory' ? ' open' : ''}`} />
                  <span>{t('chat.ctxMemoryDetails', { count: activeMemories.length })}</span>
                </button>
                {openSection === 'memory' && (
                  <div className="context-detail-items">
                    {activeMemories.length === 0 ? (
                      <div className="context-detail-empty">{t('chat.ctxNoItems')}</div>
                    ) : (
                      activeMemories.slice(0, 6).map((m) => (
                        <div key={m.id} className="context-detail-item">
                          <span>{m.content}</span>
                          <em>{m.pinned ? 'pin' : m.scope}</em>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              <div className="context-detail-group">
                <button
                  type="button"
                  className="context-detail-toggle"
                  onClick={() => setOpenSection((s) => (s === 'skills' ? null : 'skills'))}
                  aria-expanded={openSection === 'skills'}
                >
                  <ChevronRight size={12} className={`context-detail-chev${openSection === 'skills' ? ' open' : ''}`} />
                  <span>{t('chat.ctxSkillsDetails', { count: enabledSkills.length })}</span>
                </button>
                {openSection === 'skills' && (
                  <div className="context-detail-items">
                    {enabledSkills.length === 0 ? (
                      <div className="context-detail-empty">{t('chat.ctxNoItems')}</div>
                    ) : (
                      enabledSkills.slice(0, 8).map((sk) => (
                        <div key={`${sk.scope}:${sk.name}`} className="context-detail-item">
                          <span>{sk.name}</span>
                          <em>{sk.scope}</em>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="context-breakdown-acts">
              <button type="button" className="context-breakdown-btn" onClick={() => setExpanded(false)}>
                {t('chat.hideBreakdown')}
              </button>
              {onCompact && (
                <button
                  type="button"
                  className="context-breakdown-btn"
                  onClick={() => {
                    setOpen(false)
                    setExpanded(false)
                    onCompact()
                  }}
                >
                  <Minimize2 size={12} />
                  <span>{t('chat.compact')}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
