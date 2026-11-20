import { Globe, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { InstallOption } from '@shared/types.ts'

/** A list of install proposals, each showing the exact command or address. */
export function OptionList({ options, onPick }: { options: InstallOption[]; onPick: (option: InstallOption) => void }) {
  const { t } = useTranslation()
  return (
    <ul className="options">
      {options.map((option, i) => (
        <li key={i} className="option">
          {option.config.transport === 'stdio' ? <Terminal size={14} /> : <Globe size={14} />}
          <div className="option-text">
            <span className="option-name">{option.config.name}</span>
            <code>{option.label}</code>
            {option.inputs.length > 0 && <span className="option-inputs">{option.inputs.map((input) => input.key).join(', ')}</span>}
          </div>
          <button className="btn btn-small" onClick={() => onPick(option)}>
            {t('market.install')}
          </button>
        </li>
      ))}
    </ul>
  )
}
