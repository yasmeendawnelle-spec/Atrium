// Pure helpers for normalizing, validating, summarizing, and deriving task plan progress.
import type { ConversationPlan, Message, PlanStep, PlanStepStatus } from './types.ts'

export const UPDATE_PLAN_TOOL_NAME = 'update_plan' as const
export const MAX_PLAN_STEPS = 15

const STATUS_ALIASES: Record<string, PlanStepStatus> = {
  pending: 'pending',
  todo: 'pending',
  queued: 'pending',
  not_started: 'pending',
  'not-started': 'pending',
  'not started': 'pending',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  'in progress': 'in_progress',
  running: 'in_progress',
  active: 'in_progress',
  working: 'in_progress',
  done: 'done',
  completed: 'done',
  complete: 'done',
  finished: 'done',
  skipped: 'skipped',
  skip: 'skipped',
  cancelled: 'skipped',
  canceled: 'skipped',
  failed: 'failed',
  fail: 'failed',
  error: 'failed',
}

/** Normalizes a candidate step status string into a valid PlanStepStatus, or null if invalid. */
export function normalizePlanStatus(raw: unknown): PlanStepStatus | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  return STATUS_ALIASES[key] ?? null
}

function trimBounded(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const clean = raw.replace(/\s+/g, ' ').trim()
  if (!clean) return undefined
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean
}

/** Validates and normalizes `update_plan` tool arguments into a ConversationPlan (or null when cleared). */
export function parsePlanInput(
  input: Record<string, unknown>,
  now = Date.now(),
): { ok: true; plan: ConversationPlan | null } | { ok: false; error: string } {
  if (!Array.isArray(input.steps)) {
    return { ok: false, error: 'update_plan requires a `steps` array of { title, status } items.' }
  }
  if (input.steps.length === 0) {
    return { ok: true, plan: null }
  }
  const steps: PlanStep[] = []
  const rawSteps = input.steps.slice(0, MAX_PLAN_STEPS)
  for (let i = 0; i < rawSteps.length; i++) {
    const item = rawSteps[i]
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `steps[${i}] must be an object with \`title\` and \`status\`.` }
    }
    const rec = item as Record<string, unknown>
    const title = trimBounded(rec.title ?? rec.step, 160)
    if (!title) {
      return { ok: false, error: `steps[${i}].title must be a non-empty string.` }
    }
    const status = normalizePlanStatus(rec.status)
    if (!status) {
      return {
        ok: false,
        error: `steps[${i}].status "${String(rec.status ?? '')}" is invalid. Use pending, in_progress, done, skipped, or failed.`,
      }
    }
    steps.push({ title, status })
  }

  const focus = trimBounded(input.focus, 120)
  const explanation = trimBounded(input.explanation, 240)
  return {
    ok: true,
    plan: {
      ...(focus ? { focus } : {}),
      ...(explanation ? { explanation } : {}),
      steps,
      updatedAt: now,
    },
  }
}

export interface PlanStats {
  total: number
  done: number
  inProgress: number
  failed: number
  skipped: number
  pending: number
  terminal: number
  percent: number
  activeStep?: PlanStep
  isAllDone: boolean
  hasFailure: boolean
}

/** Computes aggregate completion counters and status flags for a ConversationPlan. */
export function getPlanStats(plan: ConversationPlan): PlanStats {
  let done = 0
  let inProgress = 0
  let failed = 0
  let skipped = 0
  let pending = 0
  let activeStep: PlanStep | undefined
  for (const s of plan.steps) {
    if (s.status === 'done') done++
    else if (s.status === 'in_progress') {
      inProgress++
      if (!activeStep) activeStep = s
    } else if (s.status === 'failed') failed++
    else if (s.status === 'skipped') skipped++
    else pending++
  }
  const total = plan.steps.length
  const terminal = done + skipped + failed
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const isAllDone = total > 0 && pending === 0 && inProgress === 0
  return {
    total,
    done,
    inProgress,
    failed,
    skipped,
    pending,
    terminal,
    percent,
    activeStep,
    isAllDone,
    hasFailure: failed > 0,
  }
}

/** Formats a concise textual representation of the plan for the tool result message. */
export function formatPlanToolOutput(plan: ConversationPlan | null): string {
  if (!plan || plan.steps.length === 0) return 'Plan cleared.'
  const stats = getPlanStats(plan)
  const header = `Plan updated (${stats.done}/${stats.total} done${plan.focus ? ` · ${plan.focus}` : ''}):`
  const lines = plan.steps.map((s, idx) => `${idx + 1}. [${s.status}] ${s.title}`)
  if (plan.explanation) lines.push(`Note: ${plan.explanation}`)
  return `${header}\n${lines.join('\n')}`
}

/** Reconstructs the latest valid plan snapshot from conversation messages (for rewind/fork/reload fallback). */
export function derivePlanFromMessages(messages: readonly Message[]): ConversationPlan | undefined {
  const toolErrorByCallId = new Map<string, boolean>()
  for (const msg of messages) {
    if (msg.role === 'tool') {
      toolErrorByCallId.set(msg.toolCallId, Boolean(msg.isError))
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.toolCalls)) continue
    for (let j = msg.toolCalls.length - 1; j >= 0; j--) {
      const tc = msg.toolCalls[j]
      if (!tc || tc.name !== UPDATE_PLAN_TOOL_NAME) continue
      if (toolErrorByCallId.get(tc.id) === true) continue
      const parsed = parsePlanInput(tc.input ?? {}, 0)
      if (parsed.ok) {
        return parsed.plan ?? undefined
      }
    }
  }
  return undefined
}
