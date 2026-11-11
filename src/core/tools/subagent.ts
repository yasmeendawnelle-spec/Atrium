// Subagent tool definition, input normalization, progress formatting, and child system prompts.
import type { AgentMode, ToolInfo } from '../../shared/types.ts'

export type SubagentRole = 'explorer' | 'worker'

export const RUN_SUBAGENT_TOOL: ToolInfo = {
  name: 'run_subagent',
  description:
    'Launch an isolated sub-agent to focus on a self-contained subtask and return a concise summary. Multiple "explorer" calls in the same turn run in parallel.',
  inputSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        enum: ['explorer', 'worker'],
        description:
          '"explorer" (default) is strictly read-only and safe to run concurrently. "worker" can edit files and run commands.',
      },
      task: {
        type: 'string',
        description: 'Self-contained goal and relevant file paths or constraints for the sub-agent.',
      },
      max_rounds: {
        type: 'number',
        description: 'Maximum tool rounds before wrapping up (1-20, default 10).',
      },
    },
    required: ['task'],
  },
}

export interface ParsedSubagentTask {
  role: SubagentRole
  task: string
  maxRounds: number
}

export function parseSubagentInput(input: Record<string, unknown>, parentMode: AgentMode): ParsedSubagentTask {
  const requestedRole = input.role === 'worker' ? 'worker' : 'explorer'
  // Plan mode must never escalate privileges through a subagent.
  const role: SubagentRole = parentMode === 'plan' ? 'explorer' : requestedRole
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  const rawMax = typeof input.max_rounds === 'number' && Number.isFinite(input.max_rounds) ? Math.floor(input.max_rounds) : 10
  const maxRounds = Math.max(1, Math.min(20, rawMax))
  return { role, task, maxRounds }
}

export function formatSubagentStep(toolName: string, input: Record<string, unknown>): string {
  const path = typeof input.path === 'string' ? input.path : ''
  const query = typeof input.query === 'string' ? input.query : ''
  const cmd = typeof input.command === 'string' ? input.command : ''
  const name = typeof input.name === 'string' ? input.name : ''
  const detail = path || query || name || (cmd ? cmd.slice(0, 48) : '')
  return detail ? `${toolName}(${detail})` : toolName
}

export function buildSubagentProgressText(role: SubagentRole, steps: string[], activeStep?: string): string {
  const header = role === 'explorer' ? 'Explorer subagent researching…' : 'Worker subagent executing…'
  const recent = steps.slice(-5)
  const lines = [header, ...recent.map((s) => `  ✓ ${s}`)]
  if (activeStep) lines.push(`  • ${activeStep}`)
  return lines.join('\n')
}

export function buildSubagentPrompt(basePrompt: string, role: SubagentRole): string {
  const directive =
    role === 'explorer'
      ? [
          '',
          '<subagent_role>',
          'You are a focused read-only Explorer subagent.',
          '- Investigate carefully using read-only tools and report concrete findings with exact file paths and symbol names.',
          '- Do NOT fabricate paths or test outputs. Do NOT attempt to edit files.',
          '- Keep your final response concise, structured, and directly actionable for the parent agent.',
          '</subagent_role>',
        ].join('\n')
      : [
          '',
          '<subagent_role>',
          'You are a focused Worker subagent.',
          '- Complete the assigned scoped change cleanly and verify your work before finishing.',
          '- Report exact modified files, symbols, and command/test results to the parent agent.',
          '</subagent_role>',
        ].join('\n')
  return `${basePrompt}${directive}`
}

export function formatSubagentReport(role: SubagentRole, steps: string[], summary: string, stoppedEarly?: string): string {
  const head = `[Subagent (${role}) · ${steps.length} tool step${steps.length === 1 ? '' : 's'}]`
  const trace = steps.length ? `Steps: ${steps.slice(-8).join(' -> ')}` : ''
  const warn = stoppedEarly ? `Note: ${stoppedEarly}` : ''
  return [head, trace, warn, '', summary.trim() || '(no text summary returned)'].filter(Boolean).join('\n')
}
