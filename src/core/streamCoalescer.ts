import type { CoreEvent } from '../shared/ipc.ts'
import type { AgentEvent } from '../shared/types.ts'
import type { PlatformEvent } from '../shared/platform.ts'

interface PendingAgentDelta {
  type: 'text_delta' | 'reasoning_delta'
  conversationId: string
  text: string
}

interface PendingPlatformDelta {
  sessionId: string
  taskId: string
  field: 'output' | 'thinking'
  delta: string
}

function conversationIdOfAgentEvent(e: AgentEvent): string | undefined {
  if (e.type === 'approval') return e.request.conversationId
  if (e.type === 'conversation_sync') return e.conversation.id
  return e.conversationId
}

function sessionIdOfPlatformEvent(p: PlatformEvent): string | undefined {
  switch (p.type) {
    case 'session_update':
      return p.session.id
    case 'task_log':
    case 'task_delta':
      return p.sessionId
    default:
      return undefined
  }
}

/**
 * Coalesces high-frequency text/reasoning/platform stream deltas inside the core
 * process over a short frame window (~16ms) so MessagePort/electron IPC is never
 * flooded with hundreds of tiny per-token payloads, while strictly preserving
 * chronological order across reasoning -> text transitions and non-delta events.
 */
export function createCoreEventCoalescer(
  send: (event: CoreEvent) => void,
  intervalMs = 16,
): { emit: (event: CoreEvent) => void; flush: () => void; dispose: () => void } {
  const agentDeltas = new Map<string, PendingAgentDelta>()
  const platformDeltas = new Map<string, PendingPlatformDelta>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flushAgent = (conversationId?: string) => {
    if (conversationId) {
      const pending = agentDeltas.get(conversationId)
      if (!pending) return
      agentDeltas.delete(conversationId)
      send({
        channel: 'agent',
        payload: { type: pending.type, conversationId: pending.conversationId, text: pending.text },
      })
      return
    }
    if (agentDeltas.size === 0) return
    for (const [cid, pending] of agentDeltas) {
      agentDeltas.delete(cid)
      send({
        channel: 'agent',
        payload: { type: pending.type, conversationId: pending.conversationId, text: pending.text },
      })
    }
  }

  const flushPlatform = (sessionId?: string) => {
    if (platformDeltas.size === 0) return
    for (const [key, pending] of platformDeltas) {
      if (sessionId && pending.sessionId !== sessionId) continue
      platformDeltas.delete(key)
      send({
        channel: 'platform',
        payload: {
          type: 'task_delta',
          sessionId: pending.sessionId,
          taskId: pending.taskId,
          field: pending.field,
          delta: pending.delta,
        },
      })
    }
  }

  const flush = () => {
    clearTimer()
    flushAgent()
    flushPlatform()
  }

  const schedule = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, intervalMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      ;(timer as { unref: () => void }).unref()
    }
  }

  const emit = (event: CoreEvent) => {
    if (event.channel === 'agent') {
      const p = event.payload
      if (p.type === 'text_delta' || p.type === 'reasoning_delta') {
        if (!p.text) return
        const prev = agentDeltas.get(p.conversationId)
        if (prev && prev.type === p.type) {
          prev.text += p.text
        } else {
          if (prev) flushAgent(p.conversationId)
          agentDeltas.set(p.conversationId, {
            type: p.type,
            conversationId: p.conversationId,
            text: p.text,
          })
        }
        schedule()
        return
      }
      flushAgent(conversationIdOfAgentEvent(p))
      send(event)
      return
    }

    if (event.channel === 'platform') {
      const p = event.payload
      if (p.type === 'task_delta') {
        if (!p.delta) return
        const key = `${p.sessionId}::${p.taskId}`
        const prev = platformDeltas.get(key)
        if (prev && prev.field === p.field) {
          prev.delta += p.delta
        } else {
          if (prev) {
            platformDeltas.delete(key)
            send({
              channel: 'platform',
              payload: {
                type: 'task_delta',
                sessionId: prev.sessionId,
                taskId: prev.taskId,
                field: prev.field,
                delta: prev.delta,
              },
            })
          }
          platformDeltas.set(key, {
            sessionId: p.sessionId,
            taskId: p.taskId,
            field: p.field,
            delta: p.delta,
          })
        }
        schedule()
        return
      }
      flushPlatform(sessionIdOfPlatformEvent(p))
      send(event)
      return
    }

    send(event)
  }

  const dispose = () => {
    flush()
  }

  return { emit, flush, dispose }
}
