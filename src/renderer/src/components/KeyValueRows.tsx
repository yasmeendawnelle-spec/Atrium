import { Lock, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Row } from '../lib/serverForm.ts'

export function KeyValueRows({ rows, onChange }: { rows: Row[]; onChange: (rows: Row[]) => void }) {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <div className="kv">
      {rows.map((row, i) => (
        <div key={i} className="kv-row">
          <input
            className="input mono kv-key"
            value={row.key}
            placeholder={t('wizard.key')}
            onChange={(e) => update(i, { key: e.target.value })}
            aria-label={t('wizard.key')}
          />
          <input
            className="input mono kv-value"
            type={row.secret ? 'password' : 'text'}
            value={row.value}
            placeholder={row.saved ? t('common.secretSaved') : row.required ? t('wizard.required') : t('wizard.value')}
            onChange={(e) => update(i, { value: e.target.value, saved: e.target.value ? false : row.saved })}
            aria-label={row.key || t('wizard.value')}
            aria-invalid={row.required && !row.value && !row.saved}
          />
          <button
            type="button"
            className={`icon-btn${row.secret ? ' on' : ''}`}
            title={t('wizard.secret')}
            aria-pressed={row.secret}
            onClick={() => update(i, { secret: !row.secret })}
          >
            <Lock size={14} />
          </button>
          <button type="button" className="icon-btn" aria-label={t('common.remove')} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <X size={14} />
          </button>
          {row.hint && <p className="kv-hint">{row.hint}</p>}
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-small" onClick={() => onChange([...rows, { key: '', value: '', secret: false }])}>
        <Plus size={14} />
        {t('wizard.addRow')}
      </button>
    </div>
  )
}
