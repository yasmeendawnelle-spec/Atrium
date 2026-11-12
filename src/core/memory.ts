// Cross-session persistent user and project memory store.
import { join, resolve } from 'node:path'
import type { Conversation, MemoryCategory, MemoryDraft, MemoryItem, MemoryScope } from '../shared/types.ts'
import { chat, endpointFor } from './providers/index.ts'
import type { SettingsStore } from './settings.ts'
import { newId, readJson, writeJson } from './store.ts'

function normWs(ws: string | undefined): string | undefined {
  const trimmed = ws?.trim()
  if (!trimmed) return undefined
  const r = resolve(trimmed).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? r.toLowerCase() : r
}

function normContent(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

export class MemoryStore {
  private items: MemoryItem[] = []
  private readonly dir: string
  private readonly onChange?: (items: MemoryItem[]) => void

  constructor(dir: string, onChange?: (items: MemoryItem[]) => void) {
    this.dir = dir
    this.onChange = onChange
  }

  private filePath(): string {
    return join(this.dir, 'memory.json')
  }

  async load(): Promise<void> {
    const raw = await readJson<MemoryItem[]>(this.filePath(), [])
    this.items = Array.isArray(raw) ? raw.filter((m) => m && typeof m.id === 'string' && typeof m.content === 'string') : []
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath(), this.items)
    this.onChange?.(this.listAll())
  }

  listAll(): MemoryItem[] {
    return [...this.items].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
  }

  list(workspace?: string): MemoryItem[] {
    const target = normWs(workspace)
    return this.listAll().filter((m) => {
      if (m.scope === 'global') return true
      if (!target) return false
      return normWs(m.workspace) === target
    })
  }

  async save(draft: MemoryDraft): Promise<MemoryItem> {
    const content = draft.content.trim().slice(0, 600)
    if (!content) throw new Error('Memory content cannot be empty.')
    const category: MemoryCategory =
      draft.category === 'preference' || draft.category === 'fact' || draft.category === 'workflow' || draft.category === 'decision'
        ? draft.category
        : 'fact'
    const scope: MemoryScope = draft.scope === 'workspace' && draft.workspace?.trim() ? 'workspace' : 'global'
    const ws = scope === 'workspace' ? resolve(draft.workspace!.trim()) : undefined
    const now = Date.now()

    if (draft.id) {
      const idx = this.items.findIndex((m) => m.id === draft.id)
      if (idx >= 0) {
        const updated: MemoryItem = {
          ...this.items[idx]!,
          content,
          category,
          scope,
          workspace: ws,
          pinned: draft.pinned ?? this.items[idx]!.pinned,
          sourceChatId: draft.sourceChatId ?? this.items[idx]!.sourceChatId,
          updatedAt: now,
        }
        this.items[idx] = updated
        await this.persist()
        return updated
      }
    }

    const nText = normContent(content)
    const dup = this.items.find(
      (m) => m.scope === scope && normWs(m.workspace) === normWs(ws) && normContent(m.content) === nText,
    )
    if (dup) {
      const refreshed: MemoryItem = {
        ...dup,
        category,
        pinned: draft.pinned ?? dup.pinned,
        updatedAt: now,
      }
      this.items = this.items.map((m) => (m.id === dup.id ? refreshed : m))
      await this.persist()
      return refreshed
    }

    const created: MemoryItem = {
      id: newId('mem'),
      content,
      category,
      scope,
      ...(ws ? { workspace: ws } : {}),
      pinned: Boolean(draft.pinned),
      ...(draft.sourceChatId ? { sourceChatId: draft.sourceChatId } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.items = [created, ...this.items].slice(0, 200)
    await this.persist()
    return created
  }

  async remove(id: string): Promise<void> {
    const before = this.items.length
    this.items = this.items.filter((m) => m.id !== id)
    if (this.items.length !== before) await this.persist()
  }

  search(query: string, workspace?: string, limit = 10): MemoryItem[] {
    const pool = this.list(workspace)
    const q = query.trim().toLowerCase()
    if (!q) return pool.slice(0, limit)
    const terms = q.split(/\s+/).filter(Boolean)
    const scored = pool
      .map((item) => {
        const hay = `${item.content} ${item.category}`.toLowerCase()
        let score = 0
        if (hay.includes(q)) score += 6
        for (const t of terms) {
          if (hay.includes(t)) score += 2
        }
        if (item.pinned) score += 1
        return { item, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
    return scored.slice(0, limit).map((e) => e.item)
  }

  formatPromptBlock(workspace?: string, maxChars = 3200): string | undefined {
    const relevant = this.list(workspace)
    if (relevant.length === 0) return undefined
    const lines = [
      '<user_memories>',
      'Remembered preferences and durable facts from past sessions (apply silently unless explicitly overridden):',
    ]
    let total = lines.join('\n').length
    for (const item of relevant) {
      const scopeTag = item.scope === 'workspace' ? 'workspace' : 'global'
      const pinTag = item.pinned ? ', pinned' : ''
      const line = `- [${item.category} · ${scopeTag}${pinTag}] (id=${item.id}) ${item.content}`
      if (total + line.length + 1 > maxChars) break
      lines.push(line)
      total += line.length + 1
    }
    lines.push('</user_memories>')
    return lines.length > 3 ? lines.join('\n') : undefined
  }

  async extractFromConversation(settings: SettingsStore, conversation: Conversation): Promise<MemoryItem[]> {
    const recent = conversation.messages
      .filter((m): m is Extract<Conversation['messages'][number], { role: 'user' | 'assistant' }> => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 700)}`)
      .join('\n\n')
    if (!recent.trim()) return []

    const candidates: Array<{ content: string; category: MemoryCategory; scope: MemoryScope }> = []
    const provider = settings.activeProvider()
    const existingList = this.list(conversation.workspace)
      .slice(0, 20)
      .map((m) => `- ${m.content}`)
      .join('\n')

    if (provider && (provider.hasKey || /^https?:\/\/(localhost|127\.)/.test(provider.baseUrl))) {
      try {
        const apiKey = await settings.providerKey(provider.id)
        const endpoint = endpointFor(provider, apiKey)
        const res = await chat(
          provider.protocol,
          endpoint,
          {
            model: provider.model,
            system:
              'Extract up to 4 durable, high-signal facts, coding/workflow preferences, or project decisions worth remembering in future conversations. Skip ephemeral tasks. Return strictly a JSON array of objects: [{"content": string, "category": "preference"|"fact"|"workflow"|"decision", "scope": "global"|"workspace"}]. Return [] if nothing durable.',
            messages: [
              {
                role: 'user',
                text: `Existing memories:\n${existingList || '(none)'}\n\nConversation excerpt:\n${recent}`,
              },
            ],
            tools: [],
            maxTokens: 500,
            signal: AbortSignal.timeout(15_000),
          },
          { onText: () => undefined },
        )
        const raw = res.text.trim()
        const jsonMatch = /\[[\s\S]*\]/.exec(raw)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>
          if (Array.isArray(parsed)) {
            for (const entry of parsed) {
              const content = typeof entry.content === 'string' ? entry.content.trim() : ''
              if (!content || content.length < 6) continue
              const category: MemoryCategory =
                entry.category === 'preference' || entry.category === 'workflow' || entry.category === 'decision'
                  ? entry.category
                  : 'fact'
              const scope: MemoryScope =
                entry.scope === 'workspace' && conversation.workspace ? 'workspace' : 'global'
              candidates.push({ content, category, scope })
            }
          }
        }
      } catch {
        /* fallback cleanly to rule-based extraction below */
      }
    }

    if (candidates.length === 0) {
      for (const msg of conversation.messages) {
        if (msg.role !== 'user') continue
        const lines = msg.text.split(/[\n。！？]/).map((s) => s.trim())
        for (const line of lines) {
          if (
            line.length >= 8 &&
            line.length <= 160 &&
            /(?:记住|以后都|始终使用|偏好|规范|约定|always use|prefer |never use|remember that|our convention)/i.test(line)
          ) {
            candidates.push({
              content: line.replace(/^(?:请记住|记住|note that|remember that)[:：\s]*/i, '').trim(),
              category: 'preference',
              scope: conversation.workspace ? 'workspace' : 'global',
            })
          }
        }
      }
    }

    const saved: MemoryItem[] = []
    for (const c of candidates.slice(0, 5)) {
      saved.push(
        await this.save({
          content: c.content,
          category: c.category,
          scope: c.scope,
          workspace: conversation.workspace,
          sourceChatId: conversation.id,
        }),
      )
    }
    return saved
  }
}
