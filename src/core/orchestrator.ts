// Dual-Model Orchestrator tools, phase system directives, and cross-model replay sanitizer.
import type { ExecMode, Message, OrchestratorPhase } from '../shared/types.ts'
import type { ToolDef } from './providers/types.ts'

export const EXIT_PLAN_MODE_TOOL: ToolDef = {
  name: 'exit_plan_mode',
  description:
    'Turn plan mode off and hand the concrete, executable plan to the fast Executor model. Call this once your read-only investigation is complete and all design decisions are settled. Skip this tool for pure questions, explanations, or reviews that need no edits or actions.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'Complete step-by-step plan for the executor: ordered steps, target file paths & symbols, exact changes, verification commands & expected outcomes, edge cases/pitfalls, and a short "Re-plan if:" list.',
      },
      summary: {
        type: 'string',
        description: 'Optional 1-line summary of the handoff shown in UI/logs.',
      },
    },
    required: ['plan'],
  },
}

export const REQUEST_PLAN_REVIEW_TOOL: ToolDef = {
  name: 'request_plan_review',
  description:
    'Hand control back to the frontier Planner model for [plan review] when a plan assumption turned out wrong, an unexpected failure persists after retry, a new architectural decision is required, or a "Re-plan if:" condition is triggered.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Concise reason why planner review is needed.',
      },
      report: {
        type: 'string',
        description:
          'What has been completed so far, exact command/error outputs observed, and the concrete question or blocker for the planner.',
      },
    },
    required: ['reason', 'report'],
  },
}

export const ORCHESTRATOR_TOOL_NAMES = new Set(['exit_plan_mode', 'request_plan_review'])

export function orchestratorDirective(opts: {
  phase: OrchestratorPhase
  plannerModel: string
  executorModel: string
  handoffCount: number
  maxHandoffs: number
  execMode: ExecMode
  ultracode?: boolean
}): string {
  if (opts.phase === 'plan') {
    const lines = [
      '<orchestrator_plan_mode>',
      `DUAL-MODEL ORCHESTRATOR — PLANNING PHASE (Planner: ${opts.plannerModel} → Executor: ${opts.executorModel})`,
      'You are the frontier Planning Model operating in strictly read-only mode. File edits, patches, shell execution, and mutating tools are disabled in this phase.',
      '',
      'Match your workflow to the request:',
      '- Pure questions, explanations, or read-only reviews that require no edits or commands: answer the user directly and stop WITHOUT calling `exit_plan_mode`.',
      '- Small, settled follow-up actions (apply an edit just discussed, fix an obvious typo, run a check): call `exit_plan_mode` immediately with a crisp 1-2 sentence plan.',
      '- Substantive engineering or multi-step tasks: investigate thoroughly first using read-only tools (`list_dir`, `read_file`, `search`, `load_skill`, `web_search`, `web_fetch`, and read-only `run_subagent` with role="explorer"), make EVERY architectural and design decision yourself, publish the ordered checklist via `update_plan` for the user, and then call `exit_plan_mode` with a self-contained plan naming exact file paths, symbols, concrete changes, edge cases, verification commands, and a brief `"Re-plan if:"` list.',
      '- If the user explicitly asked only to see or approve a plan before any execution, present the plan (and publish it via `update_plan` if multi-step) directly and stop WITHOUT calling `exit_plan_mode`.',
    ]
    if (opts.ultracode) {
      lines.push(
        '- Ultracode is also enabled: you may dispatch parallel read-only `run_subagent` (role="explorer") calls to map the codebase before calling `exit_plan_mode`.',
      )
    }
    lines.push('</orchestrator_plan_mode>')
    return lines.join('\n')
  }

  if (opts.phase === 'execute') {
    const remaining = Math.max(0, opts.maxHandoffs - opts.handoffCount)
    return [
      '<orchestrator_execute_mode>',
      `DUAL-MODEL ORCHESTRATOR — EXECUTION PHASE (Executor: ${opts.executorModel} · Planner: ${opts.plannerModel})`,
      `You are the fast Execution Model carrying out the plan handed off by the Planner in the preceding \`exit_plan_mode\` call (active permission mode: ${opts.execMode}).`,
      '- Execute the plan cleanly in order, make exact file edits, and run the verification commands specified by the plan.',
      '- Keep the live checklist current with `update_plan` (updating `focus` and step statuses as you advance) and mark all steps terminal before your final summary.',
      '- Do not improvise unrequested redesigns or deviate silently from settled decisions.',
      `- Call \`request_plan_review\` (${remaining} hand-back${remaining === 1 ? '' : 's'} remaining this turn) ONLY if a "Re-plan if:" condition triggers, a key assumption proves false, a verification failure persists after a concrete fix attempt, or a genuine architectural decision not covered by the plan arises.`,
      '- Do NOT call `request_plan_review` just to report routine completion — when finished and verified, present the concise summary of actual changes and observed test/build outputs directly to the user.',
      '</orchestrator_execute_mode>',
    ].join('\n')
  }

  return [
    '<orchestrator_review_mode>',
    `[plan review] DUAL-MODEL ORCHESTRATOR — PLANNER REVIEW PHASE (Planner: ${opts.plannerModel} · Executor: ${opts.executorModel})`,
    `The Execution Model (${opts.executorModel}) handed back control via \`request_plan_review\` (review ${opts.handoffCount}/${opts.maxHandoffs}). You are back in strictly read-only plan review mode.`,
    '- Review the Executor’s report carefully and inspect modified workspace files read-only if needed.',
    '- Update `update_plan` (with `explanation`) if steps change or fail during review.',
    '- If the work is actually complete or requires clarification/decision from the user, answer the user directly and stop WITHOUT calling `exit_plan_mode`.',
    '- Otherwise, resolve the blocker, make the missing decision, and call `exit_plan_mode` with a clear updated/remaining plan so the Executor can finish.',
    '</orchestrator_review_mode>',
  ].join('\n')
}

/**
 * Strips provider/model-specific opaque replay payloads (thinking signatures,
 * encrypted reasoning items, Responses itemIds, and foreign tool-chain reasoning)
 * whenever preparing message history for a different target `(providerId, model)`.
 * Never mutates the original conversation history.
 */
export function prepareMessagesForModel(
  messages: readonly Message[],
  targetProviderId: string,
  targetModel: string,
): Message[] {
  return messages.map((m) => {
    if (m.role !== 'assistant') return m
    const sameModel = !m.model || m.model === targetModel
    const sameProvider = !m.providerId || m.providerId === targetProviderId
    if (sameModel && sameProvider) return m

    const {
      thinking: _droppedThinking,
      reasoningItems: _droppedReasoningItems,
      reasoning: _droppedReasoning,
      toolCalls,
      ...rest
    } = m
    return {
      ...rest,
      toolCalls: toolCalls.map((tc) => {
        if (!tc.itemId) return tc
        const { itemId: _droppedItemId, ...cleanCall } = tc
        return cleanCall
      }),
    }
  })
}
