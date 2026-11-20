import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstallOption } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { Dialog } from './Dialog.tsx'
import { OptionList } from './OptionList.tsx'

export function PasteDialog({ onPick, onClose }: { onPick: (option: InstallOption) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [options, setOptions] = useState<InstallOption[] | null>(null)
  const [error, setError] = useState('')

  const read = async () => {
    setError('')
    try {
      const found = await call('mcp.parseConfig', text)
      if (found.length === 0) setError(t('wizard.nothingFound'))
      else if (found.length === 1) onPick(found[0]!)
      else setOptions(found)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog title={t('wizard.pasteTitle')} onClose={onClose} wide>
      {options ? (
        <>
          <p className="dialog-note">{t('wizard.choose')}</p>
          <OptionList options={options} onPick={onPick} />
        </>
      ) : (
        <>
          <p className="dialog-note">{t('wizard.pasteHint')}</p>
          <textarea
            className="input mono paste-area"
            rows={12}
            value={text}
            spellCheck={false}
            placeholder={'{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }\n  }\n}'}
            onChange={(e) => setText(e.target.value)}
          />
          {error && <p className="warn">{error}</p>}
          <div className="dialog-actions">
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={() => void read()} disabled={!text.trim()}>
              {t('wizard.read')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  )
}
