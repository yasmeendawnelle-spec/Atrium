// Built-in Project Knowledge Base search tool (`knowledge_search`).
import type { ToolInfo } from '../../shared/types.ts'
import type { KnowledgeBaseManager } from '../knowledge.ts'

export const KNOWLEDGE_TOOLS: ToolInfo[] = [
  {
    name: 'knowledge_search',
    description:
      'Search indexed project knowledge sources (PDFs, Word/Excel/PowerPoint docs, Markdown design docs, and notes) for relevant excerpts and citations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or natural-language question to search inside project knowledge.' },
        top_k: { type: 'number', description: 'Maximum snippets to return (1-10, default 5).' },
      },
      required: ['query'],
    },
  },
]

export async function runKnowledgeTool(
  kb: KnowledgeBaseManager,
  input: Record<string, unknown>,
  workspace?: string,
): Promise<{ output: string; isError: boolean }> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (!query) return { output: '`query` is required.', isError: true }
  const topK = typeof input.top_k === 'number' && Number.isFinite(input.top_k) ? input.top_k : 5
  try {
    const hits = await kb.search(query, workspace, topK)
    if (hits.length === 0) {
      return { output: `No indexed knowledge passages matched "${query}".`, isError: false }
    }
    return {
      output: hits
        .map((h, i) => {
          const loc = [h.path || h.title, h.section].filter(Boolean).join(' · ')
          return `[${i + 1}] (${loc} | score=${h.score})\n${h.snippet}`
        })
        .join('\n\n---\n\n'),
      isError: false,
    }
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true }
  }
}
