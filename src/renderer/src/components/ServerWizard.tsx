import { useEffect, useState } from 'react'
import { AlertCircle, Check, Globe, Terminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { McpTestResult, RuntimeInfo } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { setState, toast } from '../lib/store.ts'
import { commandLine, configFromForm, missingFields, type ServerForm } from '../lib/serverForm.ts'
import { KeyValueRows } from './KeyValueRows.tsx'
import { Dialog } from './Dialog.tsx'

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'done'; result: McpTestResult }

function runtimeFor(command: string): RuntimeInfo['id'] | null {
  const c = command.trim().toLowerCase().replace(/\.(cmd|exe)$/, '')
  if (c === 'npx' || c === 'npm') return 'npx'
  if (c === 'node') return 'node'
  if (c === 'uvx' || c === 'uv') return 'uvx'
  if (c === 'docker') return 'docker'
  if (c === 'python' || c === 'python3') return 'python'
  return null
}

export function ServerWizard({ title, initial, note, onClose }: { title: string; initial: ServerForm; note?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [form, setForm] = useState(initial)
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const [saving, setSaving] = useState(false)
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([])
  useEffect(() => {
    call('system.runtimes').then(setRuntimes, () => undefined)
  }, [])

  const set = (patch: Partial<ServerForm>) => {
    setForm((f) => ({ ...f, ...patch }))
    setTest({ state: 'idle' })
  }
  const missing = missingFields(form)
  const runtime = form.transport === 'stdio' ? runtimeFor(form.command) : null
  const runtimeMissing = runtime !== null && runtimes.find((r) => r.id === runtime)?.found === false

  const runTest = async () => {
    if (missing.length) return toast(t('wizard.fillRequired'), 'error')
    setTest({ state: 'testing' })
    try {
      setTest({ state: 'done', result: await call('mcp.test', configFromForm(form)) })
    } catch (err) {
      setTest({ state: 'done', result: { ok: false, tools: [], error: errorMessage(err) } })
    }
  }

  const save = async () => {
    if (missing.length) return toast(t('wizard.fillRequired'), 'error')
    setSaving(true)
    try {
      await call('mcp.save', configFromForm(form))
      setState({ servers: await call('mcp.list') })
      toast(t('wizard.saved'))
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  const passed = test.state === 'done' && test.result.ok
  return (
    <Dialog title={title} onClose={onClose} wide>
      {note && <p className="dialog-note">{note}</p>}
      <div className="kind-picker" role="radiogroup">
        {(['stdio', 'http'] as const).map((kind) => (
          <button key={kind} role="radio" aria-checked={form.transport === kind} className={`kind${form.transport === kind ? ' on' : ''}`} onClick={() => set({ transport: kind })}>
            {kind === 'stdio' ? <Terminal size={16} /> : <Globe size={16} />}
            <span className="kind-title">{t(kind === 'stdio' ? 'wizard.kindStdio' : 'wizard.kindHttp')}</span>
            <span className="kind-hint">{t(kind === 'stdio' ? 'wizard.kindStdioHint' : 'wizard.kindHttpHint')}</span>
          </button>
        ))}
      </div>
      <label className="field">
        <span>{t('wizard.name')}</span>
        <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={missing.includes('name')} />
      </label>
      {form.transport === 'stdio' ? (
        <>
          <label className="field">
            <span>{t('wizard.command')}</span>
            <input className="input mono" value={form.command} onChange={(e) => set({ command: e.target.value })} />
          </label>
          {runtimeMissing && <p className="warn">{t('wizard.missingRuntime', { program: form.command })}</p>}
          <label className="field">
            <span>
              {t('wizard.args')} <em>{t('wizard.argsHint')}</em>
            </span>
            <textarea className="input mono" rows={3} value={form.args} onChange={(e) => set({ args: e.target.value })} />
          </label>
          <div className="field">
            <span>{t('wizard.env')}</span>
            <KeyValueRows rows={form.env} onChange={(env) => set({ env })} />
          </div>
          <div className="field">
            <span>{t('wizard.willRun')}</span>
            <code className="command-preview">{commandLine(form)}</code>
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span>{t('wizard.url')}</span>
            <input className="input mono" value={form.url} placeholder="https://" onChange={(e) => set({ url: e.target.value })} aria-invalid={missing.includes('url')} />
          </label>
          <div className="field">
            <span>{t('wizard.authMethod')}</span>
            <div className="seg" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={form.authMode !== 'oauth'}
                className={`seg-btn${form.authMode !== 'oauth' ? ' active' : ''}`}
                onClick={() => set({ authMode: 'none' })}
              >
                {t('wizard.authHeaders')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={form.authMode === 'oauth'}
                className={`seg-btn${form.authMode === 'oauth' ? ' active' : ''}`}
                onClick={() => set({ authMode: 'oauth' })}
              >
                {t('wizard.authOAuth')}
              </button>
            </div>
          </div>
          {form.authMode === 'oauth' ? (
            <>
              <label className="field">
                <span>{t('wizard.oauthClientId')}</span>
                <input
                  className="input mono"
                  value={form.oauthClientId}
                  placeholder={t('wizard.oauthClientIdPlaceholder')}
                  onChange={(e) => set({ oauthClientId: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('wizard.oauthScopes')}</span>
                <input
                  className="input mono"
                  value={form.oauthScopes}
                  placeholder={t('wizard.oauthScopesPlaceholder')}
                  onChange={(e) => set({ oauthScopes: e.target.value })}
                />
              </label>
              <p className="dialog-note">{t('wizard.oauthHint')}</p>
            </>
          ) : (
            <div className="field">
              <span>{t('wizard.headers')}</span>
              <KeyValueRows rows={form.headers} onChange={(headers) => set({ headers })} />
            </div>
          )}
        </>
      )}
      {test.state === 'done' && <TestOutcome result={test.result} />}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className={`btn${passed ? '' : ' btn-primary'}`} onClick={() => void runTest()} disabled={test.state === 'testing'}>
          {test.state === 'testing' ? t('wizard.testing') : t('wizard.test')}
        </button>
        <button className={`btn${passed ? ' btn-primary' : ''}`} onClick={() => void save()} disabled={saving}>
          {t('wizard.save')}
        </button>
      </div>
    </Dialog>
  )
}

function TestOutcome({ result }: { result: McpTestResult }) {
  const { t } = useTranslation()
  if (result.ok) {
    return (
      <div className="test-ok">
        <p>
          <Check size={14} /> {t('wizard.found', { count: result.tools.length })}
        </p>
        <div className="chips">
          {result.tools.slice(0, 24).map((tool) => (
            <span key={tool.name} className="chip" title={tool.description}>
              {tool.name}
            </span>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="test-fail">
      <p>
        <AlertCircle size={14} /> {t('wizard.failed')} {result.error}
      </p>
      {result.stderrTail && <pre>{result.stderrTail}</pre>}
    </div>
  )
}
