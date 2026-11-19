import { FileSpreadsheet, FileText, Presentation, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { DocumentAttachment } from '@shared/types.ts'
import { Dialog } from './Dialog.tsx'

export function DocumentIcon({ kind, size = 12 }: { kind?: DocumentAttachment['docKind']; size?: number }) {
  if (kind === 'xlsx') return <FileSpreadsheet size={size} />
  if (kind === 'pptx') return <Presentation size={size} />
  return <FileText size={size} />
}

export function formatDocMeta(doc: Partial<DocumentAttachment>, t: TFunction): string {
  const parts: string[] = []
  if (doc.docKind && doc.docKind !== 'text') parts.push(doc.docKind.toUpperCase())
  if (doc.pageCount) parts.push(t('chat.docPages', { count: doc.pageCount }))
  if (doc.sheetCount) parts.push(t('chat.docSheets', { count: doc.sheetCount }))
  if (doc.slideCount) parts.push(t('chat.docSlides', { count: doc.slideCount }))
  return parts.join(' · ')
}

export function DocumentChip({
  doc,
  onPreview,
  onRemove,
}: {
  doc: Partial<DocumentAttachment> & { id: string; name: string }
  onPreview?: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  const meta = formatDocMeta(doc, t)
  return (
    <span className={`context-chip doc-chip${doc.docKind ? ` doc-${doc.docKind}` : ''}`} title={doc.path || doc.name}>
      <button
        type="button"
        className="doc-chip-open"
        onClick={onPreview}
        disabled={!onPreview}
        title={doc.path || doc.name}
      >
        <DocumentIcon kind={doc.docKind} size={12} />
        <span className="doc-chip-name">{doc.name}</span>
        {meta && <span className="doc-chip-meta">{meta}</span>}
      </button>
      {onRemove && (
        <button
          type="button"
          className="context-chip-rm"
          onClick={onRemove}
          aria-label={t('common.remove')}
        >
          <X size={11} />
        </button>
      )}
    </span>
  )
}

export function DocumentPreviewModal({
  doc,
  onClose,
}: {
  doc: Pick<DocumentAttachment, 'name' | 'docKind' | 'content' | 'truncated' | 'pageCount' | 'sheetCount' | 'slideCount'> | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  if (!doc) return null
  const meta = formatDocMeta(doc, t)
  return (
    <Dialog title={t('chat.docPreviewTitle', { name: doc.name })} onClose={onClose} wide>
      <div className="preview-modal">
        {(meta || doc.truncated) && (
          <p className="preview-note">
            {[meta, doc.truncated ? t('chat.previewTruncated') : ''].filter(Boolean).join(' · ')}
          </p>
        )}
        <pre className="preview-code doc-preview-text">{doc.content}</pre>
      </div>
    </Dialog>
  )
}
