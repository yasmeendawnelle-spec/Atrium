// Built-in long-term memory tools (`save_memory`, `search_memory`, `delete_memory`).
import type { MemoryCategory, MemoryScope, ToolInfo } from '../../shared/types.ts'
import type { MemoryStore } from '../memory.ts'

export const MEMORY_TOOLS: ToolInfo[] = [
  {
    name: 'save_memory',
    description:
      'Save a durable user preference, architectural decision, project convention, or workflow note so future sessions remember it automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Concise self-contained statement to remember.' },
        category: {
          type: 'string',
          enum: ['preference', 'fact', 'workflow', 'decision'],
          description: 'Type of memory. Defaults to "preference".',
        },
        scope: {
          type: 'string',
          enum: ['global', 'workspace'],
          description: 'Use "workspace" for repo-specific facts or "global" for user-wide habits.',
        },
        pinned: { type: 'boolean', description: 'Pin important guidelines so they are always injected first.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_memory',
    description: 'Search saved cross-session memories relevant to a query or the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match against saved memories. Leave empty to list top memories.' },
      },
    },
  },
  {
    name: 'delete_memory',
    description: 'Remove an outdated or incorrect memory entry by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID (from <user_memories> or search_memory).' },
      },
      required: ['id'],
    },
  },
]

export async function runMemoryTool(
  memory: MemoryStore,
  name: string,
  input: Record<string, unknown>,
  workspace?: string,
  conversationId?: string,
): Promise<{ output: string; isError: boolean }> {
  try {
    if (name === 'search_memory') {
      const query = typeof input.query === 'string' ? input.query : ''
      const hits = memory.search(query, workspace, 12)
      if (hits.length === 0) return { output: 'No matching memories found.', isError: false }
      return {
        output: hits
          .map((m) => `- [${m.category} · ${m.scope}${m.pinned ? ' · pinned' : ''}] id=${m.id}: ${m.content}`)
          .join('\n'),
        isError: false,
      }
    }
    if (name === 'save_memory') {
      const content = typeof input.content === 'string' ? input.content.trim() : ''
      if (!content) return { output: '`content` is required.', isError: true }
      const rawCat = typeof input.category === 'string' ? input.category : 'preference'
      const category: MemoryCategory =
        rawCat === 'fact' || rawCat === 'workflow' || rawCat === 'decision' ? rawCat : 'preference'
      const scope: MemoryScope = input.scope === 'workspace' && workspace ? 'workspace' : input.scope === 'global' ? 'global' : workspace ? 'workspace' : 'global'
      const item = await memory.save({
        content,
        category,
        scope,
        workspace: scope === 'workspace' ? workspace : undefined,
        pinned: Boolean(input.pinned),
        sourceChatId: conversationId,
      })
      return { output: `Saved memory (${item.id}, ${item.scope}/${item.category}): ${item.content}`, isError: false }
    }
    if (name === 'delete_memory') {
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!id) return { output: '`id` is required.', isError: true }
      await memory.remove(id)
      return { output: `Removed memory "${id}".`, isError: false }
    }
    return { output: `Unknown memory tool "${name}".`, isError: true }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }
}
