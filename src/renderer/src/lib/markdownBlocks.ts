/**
 * Splits Markdown into top-level blocks at blank lines outside fenced code blocks
 * so streaming updates only re-parse the trailing incomplete block while earlier blocks remain memoized.
 */
export function splitStreamingMarkdownBlocks(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fenceChar: string | null = null
  let fenceLen = 0
  let pendingBlank = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    const fenceMatch = /^(`{3,}|~{3,})(.*)$/.exec(trimmed)

    if (!fenceChar && fenceMatch) {
      if (pendingBlank && current.length > 0) {
        blocks.push(current.join('\n'))
        current = []
        pendingBlank = false
      }
      fenceChar = fenceMatch[1]![0]!
      fenceLen = fenceMatch[1]!.length
      current.push(line)
      continue
    }

    if (fenceChar) {
      current.push(line)
      const closeMatch = new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`).test(trimmed)
      if (closeMatch) {
        fenceChar = null
        fenceLen = 0
      }
      continue
    }

    if (trimmed === '') {
      if (current.length > 0) {
        pendingBlank = true
      } else {
        current.push(line)
      }
      continue
    }

    if (pendingBlank) {
      // Keep indented continuations or consecutive list items together only inside a list block
      // so headings and fenced code blocks split cleanly from subsequent lists.
      const inListBlock = /^\s{0,3}(?:[-*+]\s|\d+\.\s)/.test(current[0] ?? '')
      const isIndentedOrList = inListBlock && /^(?:\s{2,}|\t|[-*+]\s|\d+\.\s)/.test(line)
      if (isIndentedOrList) {
        current.push('')
      } else {
        blocks.push(current.join('\n'))
        current = []
      }
      pendingBlank = false
    }

    current.push(line)
  }

  if (current.length > 0) {
    if (pendingBlank) current.push('')
    blocks.push(current.join('\n'))
  }
  return blocks
}
