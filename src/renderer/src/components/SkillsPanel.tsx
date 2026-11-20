import { useState } from 'react'
import { BookOpen, ChevronRight, FileCode2, FolderOpen, Plus, Sparkles, Terminal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkillDetail, SkillInfo } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { refreshSkills, setState, toast, useStore } from '../lib/store.ts'
import { ConfirmDialog, Dialog } from './Dialog.tsx'
import { Tile } from './Tile.tsx'

function SkillRow({ skill, workspace }: { skill: SkillInfo; workspace?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const toggleOpen = async () => {
    const next = !open
    setOpen(next)
    if (next && !detail) {
      try {
        const res = await call('skills.get', skill.name, workspace)
        setDetail(res)
      } catch (err) {
        toast(errorMessage(err), 'error')
      }
    }
  }

  const toggleEnabled = async (enabled: boolean) => {
    setBusy(true)
    try {
      const nextList = await call('skills.setEnabled', skill.name, enabled, workspace)
      setState({ skills: nextList })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await call('skills.remove', skill.name, workspace)
      await refreshSkills(workspace)
      toast(t('skills.removed', { name: skill.name }))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`row${skill.enabled ? '' : ' row-muted'}`}>
      <Tile name={skill.name} />
      <div className="row-main">
        <button type="button" className="row-toggle" onClick={() => void toggleOpen()} aria-expanded={open}>
          <ChevronRight size={14} className={`chev${open ? ' open' : ''}`} />
          <span className="row-title">/{skill.name}</span>
          <span className={`skill-scope-pill scope-${skill.scope}`}>{t(`skills.scopeTag.${skill.scope}`)}</span>
          <code className="row-cmd">{skill.source}</code>
          {skill.hasScripts && (
            <span className="skill-asset-chip">
              <Terminal size={11} />
              <span>{t('skills.scriptsTag')}</span>
            </span>
          )}
          {skill.hasReferences && (
            <span className="skill-asset-chip">
              <FileCode2 size={11} />
              <span>{t('skills.refsTag')}</span>
            </span>
          )}
        </button>
        <p className="row-desc">{skill.description}</p>
      </div>
      <div className="row-actions">
        <label className="switch" title={skill.name}>
          <input
            type="checkbox"
            checked={skill.enabled}
            disabled={busy}
            onChange={(e) => void toggleEnabled(e.target.checked)}
            aria-label={skill.name}
          />
          <span />
        </label>
        <button
          type="button"
          className="icon-btn danger"
          disabled={busy}
          onClick={() => setConfirmRemove(true)}
          aria-label={t('common.remove')}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className={`row-expand${open ? ' open' : ''}`}>
        <div className="row-expand-inner">
          {detail && (
            <div className="row-detail skill-detail">
              {detail.files.length > 0 && (
                <div className="skill-files-bar">
                  <FolderOpen size={12} />
                  <span>{t('skills.viewFiles')}:</span>
                  <div className="skill-files-list">
                    {detail.files.map((f) => (
                      <code key={f}>{f}</code>
                    ))}
                  </div>
                </div>
              )}
              <pre className="log skill-doc-pre">{detail.content}</pre>
            </div>
          )}
        </div>
      </div>
      {confirmRemove && (
        <ConfirmDialog
          title={t('common.remove')}
          message={t('skills.removeConfirm', { name: skill.name })}
          confirmLabel={t('common.remove')}
          onConfirm={() => {
            setConfirmRemove(false)
            void remove()
          }}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </li>
  )
}

export function NewSkillDialog({
  workspace,
  onClose,
}: {
  workspace?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'workspace' | 'user'>(workspace ? 'workspace' : 'user')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      const created = await call('skills.create', { name, scope, description, content }, workspace)
      await refreshSkills(workspace)
      toast(t('skills.created', { name: created.name }))
      onClose()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={t('skills.createTitle')} onClose={onClose} wide>
      <form className="provider-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{t('skills.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('skills.namePlaceholder')}
            required
          />
        </label>

        <div className="field">
          <span>{t('skills.scope')}</span>
          <div className="seg">
            <button
              type="button"
              className={`seg-btn${scope === 'workspace' ? ' active' : ''}`}
              disabled={!workspace}
              onClick={() => setScope('workspace')}
            >
              {t('skills.scopeWorkspace')}
            </button>
            <button
              type="button"
              className={`seg-btn${scope === 'user' ? ' active' : ''}`}
              onClick={() => setScope('user')}
            >
              {t('skills.scopeUser')}
            </button>
          </div>
        </div>

        <label className="field">
          <span>{t('skills.description')}</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('skills.descriptionPlaceholder')}
          />
        </label>

        <label className="field">
          <span>{t('skills.instructions')}</span>
          <textarea
            className="paste-area"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t('skills.instructionsPlaceholder')}
          />
        </label>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            <Sparkles size={14} />
            <span>{t('skills.create')}</span>
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function SkillsPanel({ onNewSkill }: { onNewSkill: () => void }) {
  const { t } = useTranslation()
  const skills = useStore((s) => s.skills)
  const workspace = useStore((s) => s.settings?.workspace)

  if (skills.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <BookOpen size={36} strokeWidth={1.3} />
        </div>
        <h2>{t('skills.emptyTitle')}</h2>
        <p>{t('skills.emptyHint')}</p>
        <div className="empty-state-actions">
          <button type="button" className="btn btn-primary" onClick={onNewSkill}>
            <Plus size={14} />
            <span>{t('skills.newSkill')}</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <ul className="rows">
      {skills.map((skill) => (
        <SkillRow key={`${skill.scope}:${skill.name}:${skill.path}`} skill={skill} workspace={workspace} />
      ))}
    </ul>
  )
}
