// Server-sent events parser for streaming model responses.

export interface SseEvent {
  event: string
  data: string
}

const BOUNDARY_RE = /\r?\n\r?\n/

function drainBlocks(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  let rest = buffer
  let match: RegExpExecArray | null
  while ((match = BOUNDARY_RE.exec(rest)) !== null) {
    const block = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)
    const evt = parseBlock(block)
    if (evt) events.push(evt)
  }
  return { events, rest }
}

/** Yields one event per blank-line-terminated block. Handles LF, CRLF, mixed delimiters, and split chunks. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = () => void reader.cancel().catch(() => undefined)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const drained = drainBlocks(buffer + decoder.decode(value, { stream: true }))
      buffer = drained.rest
      for (const evt of drained.events) yield evt
    }
    const drained = drainBlocks(buffer + decoder.decode())
    for (const evt of drained.events) yield evt
    const tail = parseBlock(drained.rest)
    if (tail) yield tail
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

export function parseBlock(block: string): SseEvent | null {
  let event = 'message'
  const data: string[] = []
  for (const raw of block.split(/\r?\n/)) {
    if (!raw || raw.startsWith(':')) continue
    const idx = raw.indexOf(':')
    const field = idx === -1 ? raw : raw.slice(0, idx)
    let value = idx === -1 ? '' : raw.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}
