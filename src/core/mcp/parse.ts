// Turns pasted MCP config snippets into install proposals. Accepts the shapes
// READMEs usually show: Claude Desktop / Cursor (`mcpServers`), VS Code
// (`servers` or `mcp.servers`), a bare `"name": {...}` fragment, or one server
// object. Nothing is run here.
import type { InstallInput, InstallOption, McpServerConfig } from '../../shared/types.ts'

type ServerDraft = Omit<McpServerConfig, 'id' | 'enabled'>

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|AUTH/i
const PLACEHOLDER = /^(<.*>|\$\{.*\}|your[_-].*|xxx+|\.\.\.|.*_here|changeme|replace[_-]?me)$/i

/** Removes // and /* *\/ comments and trailing commas outside strings (JSONC). */
export function stripJsonc(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i++
      } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else out += ch
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

function tryParse(text: string): unknown {
  const cleaned = stripJsonc(text.trim())
  for (const candidate of [cleaned, `{${cleaned}}`]) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try the next shape */
    }
  }
  return undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function looksLikeServer(v: unknown): v is Record<string, unknown> {
  return isObject(v) && (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.serverUrl === 'string' || typeof v.httpUrl === 'string')
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isObject(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) out[k] = ''
    else out[k] = String(val)
  }
  return out
}

function isPlaceholder(value: string): boolean {
  return value.trim() === '' || PLACEHOLDER.test(value.trim())
}

/** Builds one install proposal from a single server entry. */
export function optionFromEntry(name: string, raw: Record<string, unknown>, source: ServerDraft['source']): InstallOption {
  const url = (raw.url ?? raw.serverUrl ?? raw.httpUrl) as string | undefined
  const inputs: InstallInput[] = []
  let config: ServerDraft
  if (typeof raw.command === 'string') {
    const env = stringRecord(raw.env) ?? {}
    for (const [key, value] of Object.entries(env)) {
      if (isPlaceholder(value)) {
        inputs.push({ key, target: 'env', required: true, secret: SECRET_NAME.test(key) })
        env[key] = ''
      } else if (SECRET_NAME.test(key)) {
        inputs.push({ key, target: 'env', required: true, secret: true, defaultValue: value })
      }
    }
    config = {
      name,
      transport: 'stdio',
      command: raw.command,
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      source,
    }
  } else {
    const headers = stringRecord(raw.headers) ?? {}
    for (const [key, value] of Object.entries(headers)) {
      const secret = SECRET_NAME.test(key) || /^authorization$/i.test(key)
      const placeholder = isPlaceholder(value) || /^Bearer\s+(<.*>|\$\{.*\}|your.*)$/i.test(value)
      if (placeholder) {
        inputs.push({ key, target: 'header', required: true, secret })
        headers[key] = ''
      } else if (secret) inputs.push({ key, target: 'header', required: true, secret: true, defaultValue: value })
    }
    config = { name, transport: 'http', url: url ?? '', headers, source }
  }
  const secretKeys = inputs.filter((i) => i.secret && i.target !== 'arg').map((i) => `${i.target}:${i.key}`)
  if (secretKeys.length) config.secretKeys = secretKeys
  const label = config.transport === 'stdio' ? `${config.command} ${(config.args ?? []).join(' ')}`.trim() : config.url ?? ''
  return { label, config, inputs }
}

/** Parses pasted text. Returns an empty list when nothing usable was found. */
export function parseConfigText(text: string, source: ServerDraft['source'] = { kind: 'import' }): InstallOption[] {
  const parsed = tryParse(text)
  if (!isObject(parsed)) return []
  const mcpBlock = isObject(parsed.mcp) ? parsed.mcp : undefined
  const containers = [parsed.mcpServers, parsed.servers, mcpBlock?.servers, parsed.context_servers]
  for (const container of containers) {
    if (!isObject(container)) continue
    const options = Object.entries(container)
      .filter(([, v]) => looksLikeServer(v))
      .map(([name, v]) => optionFromEntry(name, v as Record<string, unknown>, source))
    if (options.length) return options
  }
  if (looksLikeServer(parsed)) {
    const name = typeof parsed.name === 'string' ? parsed.name : 'server'
    return [optionFromEntry(name, parsed, source)]
  }
  // A bare fragment such as `"github": { "command": ... }` parses as {github: {...}}.
  const entries = Object.entries(parsed).filter(([, v]) => looksLikeServer(v))
  return entries.map(([name, v]) => optionFromEntry(name, v as Record<string, unknown>, source))
}

const CONFIG_LANGS = new Set(['', 'json', 'jsonc', 'json5', 'javascript', 'js'])

/**
 * Splits Markdown into fenced code blocks, line by line, so a closing fence is
 * never mistaken for an opening one. Fences may be indented (list items) and
 * use ``` or ~~~; a block closes on a bare fence of the same kind and length.
 */
export function fencedBlocks(markdown: string): { lang: string; body: string }[] {
  const blocks: { lang: string; body: string }[] = []
  let open: { fence: string; lang: string; lines: string[] } | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.trimStart().match(/^(`{3,}|~{3,})(.*)$/)
    if (!open) {
      if (match) open = { fence: match[1]!, lang: match[2]!.trim().split(/\s+/)[0]!.toLowerCase(), lines: [] }
      continue
    }
    const closes = match && match[1]![0] === open.fence[0] && match[1]!.length >= open.fence.length && match[2]!.trim() === ''
    if (closes) {
      blocks.push({ lang: open.lang, body: open.lines.join('\n') })
      open = null
    } else open.lines.push(line)
  }
  return blocks
}

/** Pulls JSON code blocks that contain MCP server configs out of a README. */
export function configsFromMarkdown(markdown: string, source: ServerDraft['source']): InstallOption[] {
  const blocks = fencedBlocks(markdown)
    .filter((b) => CONFIG_LANGS.has(b.lang))
    .map((b) => b.body)
  const seen = new Set<string>()
  const out: InstallOption[] = []
  for (const block of blocks) {
    if (!/"(command|url|serverUrl)"\s*:/.test(block)) continue
    for (const option of parseConfigText(block, source)) {
      const key = JSON.stringify([option.config.command, option.config.args, option.config.url])
      if (seen.has(key)) continue
      seen.add(key)
      out.push(option)
    }
  }
  return out
}
