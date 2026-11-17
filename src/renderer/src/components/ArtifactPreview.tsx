import { useEffect, useMemo, useState } from 'react'
import { Check, Code2, Copy, Eye, FolderDown, Maximize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { call, errorMessage, shell } from '../lib/api.ts'
import { suggestedFilename, type ParsedArtifact } from '../lib/artifacts.ts'
import { highlightCode } from '../lib/highlight.ts'
import { ARTIFACT_META_CSP, buildReactArtifactHtml } from '../lib/reactArtifactHost.ts'
import { toast } from '../lib/store.ts'
import { Dialog } from './Dialog.tsx'

let cachedReactRuntime: string | null = null
let loadingReactRuntime: Promise<string> | null = null

async function loadReactArtifactRuntime(): Promise<string> {
  if (cachedReactRuntime) return cachedReactRuntime
  if (!loadingReactRuntime) {
    loadingReactRuntime = import('../generated/artifact-runtime.bundle.txt?raw')
      .then((m) => {
        cachedReactRuntime = m.default
        return m.default
      })
      .finally(() => {
        loadingReactRuntime = null
      })
  }
  return loadingReactRuntime
}

function buildSandboxedDocument(artifact: ParsedArtifact, dark: boolean): string {
  const palette = dark
    ? 'body{background:#181614;color:#eee8e0;}'
    : 'body{background:#ffffff;color:#1d1b18;}'

  if (artifact.kind === 'svg') {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_CSP}" />
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:16px;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;${palette}}
  svg{max-width:100%;max-height:calc(100vh - 32px);height:auto}
</style>
</head>
<body>${artifact.content}</body>
</html>`
  }

  const trimmed = artifact.content.trim()
  const isFullDoc = /^<!doctype/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)
  if (isFullDoc) {
    if (/<head[\s>]/i.test(trimmed)) {
      return trimmed.replace(/<head([^>]*)>/i, `<head$1><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_CSP}" />`)
    }
    return trimmed.replace(/<html([^>]*)>/i, `<html$1><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_CSP}" /></head>`)
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_META_CSP}" />
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.55;${palette}}
</style>
</head>
<body>${artifact.content}</body>
</html>`
}

let mermaidRenderSeq = 0

function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === 'dark')
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

function SandboxedFrame({ artifact, dark, className }: { artifact: ParsedArtifact; dark: boolean; className?: string }) {
  const { t } = useTranslation()
  const [runtimeBundle, setRuntimeBundle] = useState<string | null>(
    artifact.kind === 'react' ? cachedReactRuntime : '',
  )
  const [blobUrl, setBlobUrl] = useState<string>('')

  useEffect(() => {
    if (artifact.kind !== 'react') {
      setRuntimeBundle('')
      return
    }
    if (cachedReactRuntime) {
      setRuntimeBundle(cachedReactRuntime)
      return
    }
    let alive = true
    void loadReactArtifactRuntime().then((bundle) => {
      if (alive) setRuntimeBundle(bundle)
    })
    return () => {
      alive = false
    }
  }, [artifact.kind])

  const srcDoc = useMemo(() => {
    if (artifact.kind === 'react') {
      if (!runtimeBundle) return ''
      if (artifact.streaming) return ''
      return buildReactArtifactHtml(artifact.content, runtimeBundle, dark)
    }
    return buildSandboxedDocument(artifact, dark)
  }, [artifact, dark, runtimeBundle])

  useEffect(() => {
    if (!srcDoc) {
      setBlobUrl('')
      return
    }
    let active = true
    let revokeUrl = ''
    const apply = async () => {
      try {
        const frameUrl = await shell.stageArtifact(srcDoc)
        if (active) setBlobUrl(frameUrl)
      } catch {
        if (!active) return
        const blob = new Blob([srcDoc], { type: 'text/html;charset=utf-8' })
        revokeUrl = URL.createObjectURL(blob)
        setBlobUrl(revokeUrl)
      }
    }
    const timer = artifact.streaming ? setTimeout(() => void apply(), 180) : null
    if (!artifact.streaming) void apply()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      if (revokeUrl) URL.revokeObjectURL(revokeUrl)
    }
  }, [srcDoc, artifact.streaming])

  if (artifact.kind === 'react' && (!runtimeBundle || artifact.streaming)) {
    return (
      <div className="artifact-loading">
        {artifact.streaming ? t('studio.streaming') : t('common.loading')}
      </div>
    )
  }

  return (
    <iframe
      key={`${artifact.uid}:${artifact.version}:${dark ? 'd' : 'l'}`}
      className={className ?? 'artifact-frame'}
      sandbox="allow-scripts"
      title={artifact.title}
      src={blobUrl || undefined}
    />
  )
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

function MermaidCanvas({ artifact, dark }: { artifact: ParsedArtifact; dark: boolean }) {
  const { t } = useTranslation()
  const [svg, setSvg] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void loadMermaid()
        .then((mermaid) => {
          if (!active) return null
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: dark ? 'dark' : 'neutral',
          })
          const id = `atrium-mmd-${++mermaidRenderSeq}`
          return mermaid.render(id, artifact.content.trim())
        })
        .then((res) => {
          if (!active || !res) return
          setSvg(res.svg)
          setErr(null)
        })
        .catch((e) => {
          if (!active) return
          if (!artifact.streaming) {
            setErr(e instanceof Error ? e.message : String(e))
          }
        })
    }, artifact.streaming ? 220 : 20)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [artifact.content, artifact.streaming, dark])

  if (err) {
    return (
      <div className="artifact-mmd-error">
        <p>{t('studio.diagramError')}</p>
        <pre>{err}</pre>
      </div>
    )
  }
  if (!svg) {
    return <div className="artifact-loading">{t('common.loading')}</div>
  }
  return <div className="artifact-mermaid-stage" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function ArtifactPreview({
  artifact,
  versions,
  onSelectVersion,
  workspace,
  onSavedToWorkspace,
}: {
  artifact: ParsedArtifact
  versions: ParsedArtifact[]
  onSelectVersion?: (artifact: ParsedArtifact) => void
  workspace?: string
  onSavedToWorkspace?: () => void
}) {
  const { t } = useTranslation()
  const dark = useIsDarkTheme()
  const canPreview =
    artifact.kind === 'html' || artifact.kind === 'svg' || artifact.kind === 'mermaid' || artifact.kind === 'react'
  const [mode, setMode] = useState<'preview' | 'code'>(canPreview ? 'preview' : 'code')
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [savingPath, setSavingPath] = useState<string | null>(null)

  useEffect(() => {
    setMode(canPreview ? 'preview' : 'code')
    setSavingPath(null)
  }, [artifact.uid, canPreview])

  const copySource = () => {
    void navigator.clipboard.writeText(artifact.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    })
  }

  const commitSave = async () => {
    if (!savingPath?.trim()) return
    try {
      const res = await call('workspace.saveArtifact', savingPath.trim(), artifact.content, workspace)
      setSavingPath(null)
      onSavedToWorkspace?.()
      toast(t('studio.savedFile', { path: res.path }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  const lang =
    artifact.language ||
    (artifact.kind === 'svg'
      ? 'xml'
      : artifact.kind === 'mermaid'
        ? 'markdown'
        : artifact.kind === 'react'
          ? 'tsx'
          : artifact.kind)

  return (
    <div className="artifact-view">
      <div className="artifact-bar">
        <div className="artifact-bar-meta">
          <strong title={artifact.title}>{artifact.title}</strong>
          <div className="artifact-bar-pills">
            <span className="artifact-kind-pill">{artifact.kind.toUpperCase()}</span>
            {artifact.streaming && <span className="artifact-stream-pill">{t('studio.streaming')}</span>}
            {versions.length > 1 && (
              <div className="artifact-ver-group" role="group" aria-label={t('studio.versions')}>
                {versions.map((v) => (
                  <button
                    key={v.uid}
                    type="button"
                    className={`artifact-ver-btn${v.uid === artifact.uid ? ' active' : ''}`}
                    onClick={() => onSelectVersion?.(v)}
                  >
                    v{v.version}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="artifact-bar-actions">
          {canPreview && (
            <div className="seg seg-mini" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'preview'}
                className={`seg-btn${mode === 'preview' ? ' active' : ''}`}
                onClick={() => setMode('preview')}
              >
                <Eye size={12} />
                <span>{t('studio.preview')}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'code'}
                className={`seg-btn${mode === 'code' ? ' active' : ''}`}
                onClick={() => setMode('code')}
              >
                <Code2 size={12} />
                <span>{t('studio.code')}</span>
              </button>
            </div>
          )}

          <button type="button" className="icon-btn" onClick={copySource} title={t('chat.copyCode')} aria-label={t('chat.copyCode')}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>

          {workspace && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setSavingPath((p) => (p === null ? suggestedFilename(artifact) : null))}
              title={t('studio.saveToWorkspace')}
              aria-label={t('studio.saveToWorkspace')}
            >
              <FolderDown size={14} />
            </button>
          )}

          {canPreview && (
            <button
              type="button"
              className="icon-btn"
              onClick={() => setExpanded(true)}
              title={t('studio.expand')}
              aria-label={t('studio.expand')}
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      </div>

      {savingPath !== null && (
        <form
          className="artifact-save-bar"
          onSubmit={(e) => {
            e.preventDefault()
            void commitSave()
          }}
        >
          <input
            className="input mono artifact-save-input"
            value={savingPath}
            onChange={(e) => setSavingPath(e.target.value)}
            placeholder={t('studio.savePathPlaceholder')}
            autoFocus
          />
          <button type="submit" className="btn btn-small btn-primary">
            {t('common.save')}
          </button>
          <button type="button" className="btn btn-small" onClick={() => setSavingPath(null)}>
            {t('common.cancel')}
          </button>
        </form>
      )}

      <div className="artifact-stage">
        {mode === 'preview' && canPreview ? (
          artifact.kind === 'mermaid' ? (
            <MermaidCanvas artifact={artifact} dark={dark} />
          ) : (
            <SandboxedFrame artifact={artifact} dark={dark} />
          )
        ) : (
          <pre className="artifact-code">
            <code>{highlightCode(artifact.content, lang)}</code>
          </pre>
        )}
      </div>

      {expanded && canPreview && (
        <Dialog title={artifact.title} onClose={() => setExpanded(false)} wide>
          <div className="artifact-modal-stage">
            {artifact.kind === 'mermaid' ? (
              <MermaidCanvas artifact={artifact} dark={dark} />
            ) : (
              <SandboxedFrame artifact={artifact} dark={dark} className="artifact-frame artifact-frame-wide" />
            )}
          </div>
        </Dialog>
      )}
    </div>
  )
}
