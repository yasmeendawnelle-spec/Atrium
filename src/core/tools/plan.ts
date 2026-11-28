// Built-in `update_plan` tool definition and re-exported pure helpers.
import {
  derivePlanFromMessages,
  formatPlanToolOutput,
  getPlanStats,
  MAX_PLAN_STEPS,
  normalizePlanStatus,
  parsePlanInput,
  UPDATE_PLAN_TOOL_NAME,
} from '../../shared/plan.ts'
import type { ToolDef } from '../providers/types.ts'

export {
  derivePlanFromMessages,
  formatPlanToolOutput,
  getPlanStats,
  MAX_PLAN_STEPS,
  normalizePlanStatus,
  parsePlanInput,
  UPDATE_PLAN_TOOL_NAME,
}

export const UPDATE_PLAN_TOOL: ToolDef = {
  name: UPDATE_PLAN_TOOL_NAME,
  description:
    'Create or update a structured step-by-step task plan shown live to the user above the input bar. ' +
    'Use this for multi-step engineering or research tasks (3+ distinct steps) to publish an ordered checklist, track progress as you move between steps, and mark all steps terminal before finishing. ' +
    'Skip for simple Q&A, casual chat, or trivial 1-2 step requests. Pass an empty `steps` array (`[]`) to clear an active plan.',
  inputSchema: {
    type: 'object',
    properties: {
      focus: {
        type: 'string',
        description:
          'Concise present-tense activity phrase shown in the plan header and thinking bar (e.g. "Implementing update_plan tool" or "Running test suite").',
      },
      explanation: {
        type: 'string',
        description: 'Optional brief note explaining plan creation or why the plan was revised.',
      },
      steps: {
        type: 'array',
        description: `Full ordered checklist of steps (up to ${MAX_PLAN_STEPS} items, sending the full list on every update).`,
        items: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Short imperative step title (2-8 words, plain user-facing language).',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done', 'skipped', 'failed'],
              description: 'Current status of this step.',
            },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['steps'],
  },
}
