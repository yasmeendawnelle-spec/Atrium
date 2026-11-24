// Full-viewport DECSTBM scroll-region & pinned-bottom dock controller for Atrium CLI.
import { Writable } from 'node:stream'
import { charDisplayWidth, visibleWidth } from './theme.ts'

const SYNC_BEGIN = '\x1b[?2026h'
const SYNC_END = '\x1b[?2026l'
const MAX_TAIL_LINES = 200

export interface TerminalViewport {
  readonly enabled: boolean
  readonly rawStdout: NodeJS.WritableStream
  readonly transcriptStream: NodeJS.WritableStream
  init: (baseDockHeight?: number) => void
  writeTranscript: (chunk: string) => void
  renderDock: (dockLines: readonly string[], cursorInDock?: { row: number; col: number } | null) => void
  clearScreen: () => void
  handleResize: () => void
  dispose: () => void
}

const STREAM_TO_VIEWPORT = new WeakMap<NodeJS.WritableStream, TerminalViewport>()

export function getViewportForStream(stream: NodeJS.WritableStream | undefined): TerminalViewport | undefined {
  return stream ? STREAM_TO_VIEWPORT.get(stream) : undefined
}

export function createTerminalViewport(rawStdout: NodeJS.WritableStream): TerminalViewport {
  const ttyOut = rawStdout as NodeJS.WriteStream
  const enabled = Boolean(ttyOut.isTTY && typeof ttyOut.rows === 'number' && ttyOut.rows >= 14)

  if (!enabled) {
    return {
      enabled: false,
      rawStdout,
      transcriptStream: rawStdout,
      init: () => undefined,
      writeTranscript: (chunk: string) => {
        rawStdout.write(chunk)
      },
      renderDock: () => undefined,
      clearScreen: () => undefined,
      handleResize: () => undefined,
      dispose: () => undefined,
    }
  }

  let baseDock = 5
  let tailLines: string[] = ['']
  let transcriptRow = 1
  let transcriptCol = 1
  let lastDockHeight = 0
  let lastDockStartRow = 0
  let cursorInDock = false
  let disposed = false

  const getDims = () => ({
    rows: Math.max(14, ttyOut.rows || 24),
    cols: Math.max(40, ttyOut.columns || 80),
  })

  const scrollBottomRow = (rows: number) => Math.max(2, rows - baseDock)

  const trackChunkIntoTail = (chunk: string, cols: number, scrollBottom: number) => {
    const pushNewLine = () => {
      tailLines.push('')
      if (tailLines.length > MAX_TAIL_LINES) {
        tailLines.splice(0, tailLines.length - MAX_TAIL_LINES)
      }
      if (transcriptRow < scrollBottom) {
        transcriptRow += 1
      }
      transcriptCol = 1
    }

    let i = 0
    while (i < chunk.length) {
      if (chunk[i] === '\x1b') {
        if (chunk.startsWith('\x1b[2K', i)) {
          if (transcriptCol <= 1) {
            tailLines[tailLines.length - 1] = ''
          }
          i += 4
          continue
        }
        if (chunk.startsWith('\x1b[K', i)) {
          if (transcriptCol <= 1) {
            tailLines[tailLines.length - 1] = ''
          }
          i += 3
          continue
        }
        const sgrMatch = /^\x1b\[[0-9;]*m/.exec(chunk.slice(i))
        if (sgrMatch) {
          tailLines[tailLines.length - 1] += sgrMatch[0]
          i += sgrMatch[0].length
          continue
        }
        const otherEsc = /^(?:\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07|\x1bO[A-Za-z])/.exec(chunk.slice(i))
        if (otherEsc) {
          i += otherEsc[0].length
          continue
        }
        i += 1
        continue
      }

      const ch = chunk[i]!
      if (ch === '\r') {
        transcriptCol = 1
        i += 1
        continue
      }
      if (ch === '\n') {
        pushNewLine()
        i += 1
        continue
      }

      const cp = chunk.codePointAt(i) ?? 0
      const glyph = String.fromCodePoint(cp)
      const w = charDisplayWidth(cp)
      if (transcriptCol - 1 + w > cols) {
        pushNewLine()
      }
      tailLines[tailLines.length - 1] += glyph
      transcriptCol += w
      i += glyph.length
    }
  }

  const writeTranscript = (rawChunk: string) => {
    if (!rawChunk || disposed) return
    const { rows, cols } = getDims()
    const scrollBottom = scrollBottomRow(rows)
    const normalized = rawChunk.replace(/\r\n/g, '\n')

    let prefix = ''
    if (cursorInDock) {
      prefix = `\x1b[1;${scrollBottom}r\x1b[${transcriptRow};${transcriptCol}H`
      cursorInDock = false
    }
    rawStdout.write(`${prefix}${normalized}`)
    trackChunkIntoTail(normalized, cols, scrollBottom)
  }

  class TranscriptWritable extends Writable {
    get isTTY(): boolean {
      return Boolean(ttyOut.isTTY)
    }

    get columns(): number {
      return ttyOut.columns || 80
    }

    get rows(): number {
      return ttyOut.rows || 24
    }

    override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      try {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        writeTranscript(text)
        callback(null)
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  const transcriptStream = new TranscriptWritable() as unknown as NodeJS.WritableStream

  const api: TerminalViewport = {
    enabled: true,
    rawStdout,
    transcriptStream,

    init(baseDockHeight = 5) {
      baseDock = Math.max(1, baseDockHeight)
      const { rows } = getDims()
      const scrollBottom = scrollBottomRow(rows)
      tailLines = ['']
      transcriptRow = 1
      transcriptCol = 1
      lastDockHeight = 0
      lastDockStartRow = rows + 1
      cursorInDock = false
      disposed = false
      rawStdout.write(`\x1b[r\x1b[2J\x1b[H\x1b[1;${scrollBottom}r\x1b[1;1H`)
    },

    writeTranscript,

    renderDock(dockLines: readonly string[], cursorPos: { row: number; col: number } | null = null) {
      if (disposed) return
      const { rows } = getDims()
      const maxDock = Math.max(3, rows - 2)
      const lines = dockLines.length > maxDock ? dockLines.slice(-maxDock) : dockLines
      const dockStartRow = Math.max(2, rows - lines.length + 1)

      let seq = SYNC_BEGIN

      // Restore any upper transcript rows uncovered when a dropdown / modal shrinks back down.
      if (lastDockHeight > 0 && dockStartRow > lastDockStartRow) {
        for (let r = lastDockStartRow; r < dockStartRow; r += 1) {
          const idx = tailLines.length - 1 - (transcriptRow - r)
          const restore = r <= transcriptRow && idx >= 0 && idx < tailLines.length ? tailLines[idx]! : ''
          seq += `\x1b[${r};1H\x1b[2K${restore}\x1b[0m`
        }
      }

      for (let i = 0; i < lines.length; i += 1) {
        seq += `\x1b[${dockStartRow + i};1H\x1b[2K${lines[i] ?? ''}`
      }

      if (cursorPos) {
        const targetRow = Math.max(dockStartRow, Math.min(rows, dockStartRow + cursorPos.row))
        const targetCol = Math.max(1, cursorPos.col + 1)
        seq += `\x1b[${targetRow};${targetCol}H\x1b[?25h`
      } else {
        seq += `\x1b[?25l`
      }

      seq += SYNC_END
      rawStdout.write(seq)

      lastDockHeight = lines.length
      lastDockStartRow = dockStartRow
      cursorInDock = true
    },

    clearScreen() {
      if (disposed) return
      const { rows } = getDims()
      const scrollBottom = scrollBottomRow(rows)
      tailLines = ['']
      transcriptRow = 1
      transcriptCol = 1
      lastDockHeight = 0
      lastDockStartRow = rows + 1
      cursorInDock = false
      rawStdout.write(`\x1b[r\x1b[2J\x1b[H\x1b[1;${scrollBottom}r\x1b[1;1H`)
    },

    handleResize() {
      if (disposed) return
      const { rows } = getDims()
      const scrollBottom = scrollBottomRow(rows)
      const shown = tailLines.slice(-scrollBottom)
      transcriptRow = Math.max(1, shown.length)
      transcriptCol = 1 + visibleWidth(shown[shown.length - 1] ?? '')
      lastDockHeight = 0
      lastDockStartRow = rows + 1
      cursorInDock = false
      rawStdout.write(`\x1b[r\x1b[2J\x1b[H\x1b[1;${scrollBottom}r\x1b[1;1H${shown.join('\n')}`)
    },

    dispose() {
      if (disposed) return
      disposed = true
      const { rows } = getDims()
      rawStdout.write(`\x1b[r\x1b[${rows};1H\x1b[?25h\n`)
    },
  }

  STREAM_TO_VIEWPORT.set(transcriptStream, api)
  return api
}
