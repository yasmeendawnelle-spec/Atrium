import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types.ts'
import { call, errorMessage } from '../lib/api.ts'
import { setState, toast } from '../lib/store.ts'
import { splitToolName } from './ToolRow.tsx'
import { Oculus } from './Oculus.tsx'

export function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const { t } = useTranslation()
  const [sent, setSent] = useState(false)
  const title =
    request.kind === 'edit'
      ? t('chat.approval.edit')
      : request.kind === 'write'
        ? t('chat.approval.write')
        : request.kind === 'shell'
          ? t('chat.approval.shell')
          : request.kind === 'computer'
            ? t('chat.approval.computer')
            : t('chat.approval.mcp', { server: request.serverName ?? '' })

  const isDiff = Boolean(request.detail && (request.detail.startsWith('--- ') || request.detail.includes('\n@@ ')))

  const answer = async (decision: ApprovalDecision) => {
    setSent(true)
    try {
      await call('agent.approve', request.approvalId, decision)
      if (decision === 'allow_always') {
        void call('settings.get').then((settings) => setState({ settings })).catch(() => undefined)
      }
    } catch (err) {
      setSent(false)
      toast(errorMessage(err), 'error')
    }
  }

  const summary = request.kind === 'mcp' ? splitToolName(request.toolName).tool : request.summary
  return (
    <section className="approval" aria-live="assertive">
      <h3>
        <Oculus state="approval" size={18} />
        {title}
      </h3>
      <code className="approval-summary">{summary}</code>
      {request.detail &&
        (isDiff ? (
          <div className="approval-detail diff-view" role="region" aria-label="Diff">
            {request.detail.split('\n').map((line, idx) => {
              const cls =
                line.startsWith('---') || line.startsWith('+++')
                  ? 'diff-line diff-file'
                  : line.startsWith('@@')
                    ? 'diff-line diff-hunk'
                    : line.startsWith('+')
                      ? 'diff-line diff-add'
                      : line.startsWith('-')
                        ? 'diff-line diff-del'
                        : 'diff-line diff-ctx'
              return (
                <div key={idx} className={cls}>
                  {line || ' '}
                </div>
              )
            })}
          </div>
        ) : (
          <pre className="approval-detail">{request.detail}</pre>
        ))}
      <div className="approval-actions">
        <button className="btn" disabled={sent} onClick={() => void answer('deny')}>
          {t('chat.approval.deny')}
        </button>
        <button className="btn" disabled={sent} onClick={() => void answer('allow_session')}>
          {t('chat.approval.allowSession')}
        </button>
        <button
          className="btn"
          disabled={sent}
          title={
            request.alwaysRuleLabel
              ? t('chat.approval.allowAlwaysRule', { rule: request.alwaysRuleLabel })
              : t('chat.approval.allowAlways')
          }
          onClick={() => void answer('allow_always')}
        >
          {t('chat.approval.allowAlways')}
        </button>
        <button className="btn btn-approve" disabled={sent} onClick={() => void answer('allow')} autoFocus>
          {t('chat.approval.allow')}
        </button>
      </div>
    </section>
  )
}
