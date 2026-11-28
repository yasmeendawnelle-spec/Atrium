// Collapsible live task plan checklist dock rendered above the chat composer.
import { memo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  ListChecks,
  Loader2,
  MinusCircle,
  X,
  XCircle,
} from 'lucide-react'
import type { ConversationPlan, PlanStepStatus } from '@shared/types.ts'
import { getPlanStats } from '@shared/plan.ts'
import { useFeatureText } from '../locales/features.ts'

function StepIcon({ status, busy }: { status: PlanStepStatus; busy: boolean }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 size={14} className="plan-step-icon is-done" />
    case 'in_progress':
      return busy ? (
        <Loader2 size={14} className="plan-step-icon is-running plan-spin" />
      ) : (
        <CircleDot size={14} className="plan-step-icon is-paused" />
      )
    case 'failed':
      return <XCircle size={14} className="plan-step-icon is-failed" />
    case 'skipped':
      return <MinusCircle size={14} className="plan-step-icon is-skipped" />
    default:
      return <Circle size={14} className="plan-step-icon is-pending" />
  }
}

export const PlanProgressCard = memo(function PlanProgressCard({
  chatId,
  plan,
  busy,
}: {
  chatId: string | null
  plan: ConversationPlan
  busy: boolean
}) {
  const ft = useFeatureText()
  const stats = getPlanStats(plan)
  const key = chatId ?? '__default__'

  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})
  const [dismissedStampMap, setDismissedStampMap] = useState<Record<string, number>>({})

  const isDismissed = !busy && stats.isAllDone && dismissedStampMap[key] === plan.updatedAt
  if (isDismissed || stats.total === 0) return null

  const defaultCollapsed = !busy && stats.isAllDone && !stats.hasFailure
  const collapsed = key in collapsedMap ? Boolean(collapsedMap[key]) : defaultCollapsed
  const expanded = !collapsed

  const stateClass = stats.hasFailure
    ? 'is-failed'
    : stats.isAllDone
      ? 'is-done'
      : busy
        ? 'is-running'
        : stats.inProgress > 0
          ? 'is-paused'
          : 'is-pending'

  const headerTitle =
    plan.focus ??
    stats.activeStep?.title ??
    (stats.hasFailure ? ft('plan.withIssues') : stats.isAllDone ? ft('plan.completed') : ft('plan.title'))

  const StatusLeadIcon = stats.hasFailure
    ? AlertCircle
    : stats.isAllDone
      ? CheckCircle2
      : busy
        ? Loader2
        : stats.inProgress > 0
          ? CircleDot
          : ListChecks

  const spinLead = StatusLeadIcon === Loader2

  return (
    <section className={`plan-dock ${stateClass}${expanded ? ' is-open' : ''}`} aria-label={ft('plan.title')}>
      <div className="plan-dock-head">
        <button
          type="button"
          className="plan-dock-toggle"
          onClick={() => setCollapsedMap((prev) => ({ ...prev, [key]: expanded }))}
          aria-expanded={expanded}
          title={expanded ? ft('plan.collapse') : ft('plan.expand')}
        >
          <StatusLeadIcon size={15} className={`plan-dock-lead${spinLead ? ' plan-spin' : ''}`} />
          <span className="plan-dock-kicker">{ft('plan.title')}</span>
          <span className="plan-dock-title">{headerTitle}</span>
          <span className="plan-dock-count">
            <span>{ft('plan.stepsProgress', { done: stats.done, total: stats.total })}</span>
            <span className="plan-dock-pct">{stats.percent}%</span>
          </span>
          <ChevronDown size={14} className={`plan-dock-chev${expanded ? ' open' : ''}`} />
        </button>
        {!busy && stats.isAllDone && (
          <button
            type="button"
            className="plan-dock-dismiss"
            onClick={() => setDismissedStampMap((prev) => ({ ...prev, [key]: plan.updatedAt }))}
            title={ft('plan.dismiss')}
            aria-label={ft('plan.dismiss')}
          >
            <X size={13} />
          </button>
        )}
      </div>

      <div className="plan-dock-rail" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stats.percent}>
        <div
          className={`plan-dock-fill${busy && !stats.isAllDone ? ' is-active' : ''}`}
          style={{ width: `${stats.percent}%` }}
        />
      </div>

      <div className={`plan-dock-expand${expanded ? ' open' : ''}`} aria-hidden={!expanded}>
        <div className="plan-dock-expand-inner">
          {plan.explanation && (
            <div className="plan-dock-note">
              <span className="plan-dock-note-label">{ft('plan.note')}:</span>
              <span>{plan.explanation}</span>
            </div>
          )}
          <ol className="plan-steps">
            {plan.steps.map((step, i) => (
              <li key={`${i}-${step.title}`} className={`plan-step is-${step.status}${step.status === 'in_progress' && !busy ? ' is-idle' : ''}`}>
                <StepIcon status={step.status} busy={busy} />
                <span className="plan-step-index">{String(i + 1).padStart(2, '0')}</span>
                <span className="plan-step-title">{step.title}</span>
                {(step.status === 'in_progress' || step.status === 'failed' || step.status === 'skipped') && (
                  <span className={`plan-step-badge is-${step.status === 'in_progress' && !busy ? 'paused' : step.status}`}>
                    {ft(step.status === 'in_progress' && !busy ? 'plan.status.paused' : `plan.status.${step.status}`)}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
})
