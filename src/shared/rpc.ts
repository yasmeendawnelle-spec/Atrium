// Minimal request/response + event protocol over any MessagePort-like object.
// Used by preload <-> core (MessagePort) and core <-> main (parentPort).

export interface PortLike {
  postMessage(message: unknown): void
}

export type RpcMessage =
  | { kind: 'req'; id: number; method: string; args: unknown[] }
  | { kind: 'res'; id: number; ok: true; value: unknown }
  | { kind: 'res'; id: number; ok: false; error: string }
  | { kind: 'evt'; channel: string; payload: unknown }

export type Handler = (...args: never[]) => unknown

export class RpcPeer {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private port: PortLike
  private handlers: Record<string, Handler>
  private onEvent?: (channel: string, payload: unknown) => void

  constructor(port: PortLike, handlers: Record<string, Handler> = {}, onEvent?: (channel: string, payload: unknown) => void) {
    this.port = port
    this.handlers = handlers
    this.onEvent = onEvent
  }

  /** Replaces the request handlers, e.g. once startup has finished. */
  setHandlers(handlers: Record<string, Handler>): void {
    this.handlers = handlers
  }

  /** Feed every message received on the port into this method. */
  async receive(data: unknown): Promise<void> {
    const msg = data as RpcMessage
    if (!msg || typeof msg !== 'object' || !('kind' in msg)) return
    if (msg.kind === 'res') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error))
      return
    }
    if (msg.kind === 'evt') {
      this.onEvent?.(msg.channel, msg.payload)
      return
    }
    if (msg.kind === 'req') {
      const handler = this.handlers[msg.method]
      try {
        if (!handler) throw new Error(`Unknown method: ${msg.method}`)
        const value = await (handler as (...a: unknown[]) => unknown)(...msg.args)
        this.port.postMessage({ kind: 'res', id: msg.id, ok: true, value: value ?? null })
      } catch (err) {
        this.port.postMessage({ kind: 'res', id: msg.id, ok: false, error: errorText(err) })
      }
    }
  }

  call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.port.postMessage({ kind: 'req', id, method, args })
    })
  }

  emit(channel: string, payload: unknown): void {
    this.port.postMessage({ kind: 'evt', channel, payload })
  }

  /** Reject everything in flight, e.g. when the other side went away. */
  dispose(reason = 'Connection closed'): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
