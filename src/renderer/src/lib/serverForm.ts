// Converts between saved MCP configs, install proposals, and the wizard form.
import type { InstallOption, McpServerConfig, McpTransport } from '@shared/types.ts'

export interface Row {
  key: string
  value: string
  secret: boolean
  hint?: string
  required?: boolean
  /** True when a value is already stored encrypted for this key. */
  saved?: boolean
}

export interface ServerForm {
  id?: string
  enabled: boolean
  name: string
  transport: McpTransport
  command: string
  args: string
  cwd: string
  url: string
  env: Row[]
  headers: Row[]
  authMode: 'none' | 'oauth'
  oauthClientId: string
  oauthScopes: string
  oauthAuthorized?: boolean
  source?: McpServerConfig['source']
}

type Draft = Omit<McpServerConfig, 'id' | 'enabled'> & { id?: string; enabled?: boolean }
type SaveDraft = Omit<McpServerConfig, 'id'> & { id?: string }

export function blankForm(transport: McpTransport = 'stdio'): ServerForm {
  return {
    enabled: true,
    name: '',
    transport,
    command: 'npx',
    args: '',
    cwd: '',
    url: '',
    env: [],
    headers: [],
    authMode: 'none',
    oauthClientId: '',
    oauthScopes: '',
    source: { kind: 'manual' },
  }
}

function rowsFrom(bag: Record<string, string> | undefined, prefix: 'env' | 'header', draft: Draft, option?: InstallOption): Row[] {
  const secrets = new Set(draft.secretKeys ?? [])
  return Object.entries(bag ?? {}).map(([key, value]) => {
    const input = option?.inputs.find((i) => i.key === key && i.target === prefix)
    const secret = secrets.has(`${prefix}:${key}`) || input?.secret === true
    return {
      key,
      value: value || input?.defaultValue || '',
      secret,
      hint: input?.description,
      required: input?.required,
      saved: Boolean(draft.id) && secret && !value,
    }
  })
}

function fromDraft(draft: Draft, option?: InstallOption): ServerForm {
  return {
    id: draft.id,
    enabled: draft.enabled ?? true,
    name: draft.name,
    transport: draft.transport,
    command: draft.command ?? '',
    args: (draft.args ?? []).join('\n'),
    cwd: draft.cwd ?? '',
    url: draft.url ?? '',
    env: rowsFrom(draft.env, 'env', draft, option),
    headers: rowsFrom(draft.headers, 'header', draft, option),
    authMode: draft.authMode ?? 'none',
    oauthClientId: draft.oauth?.clientId ?? '',
    oauthScopes: draft.oauth?.scopes ?? '',
    oauthAuthorized: draft.oauth?.authorized,
    source: draft.source,
  }
}

export const formFromOption = (option: InstallOption): ServerForm => fromDraft(option.config, option)
export const formFromConfig = (config: McpServerConfig): ServerForm => fromDraft(config)

export function configFromForm(form: ServerForm): SaveDraft {
  const clean = (rows: Row[]) => rows.filter((r) => r.key.trim())
  const bag = (rows: Row[]) => Object.fromEntries(clean(rows).map((r) => [r.key.trim(), r.value]))
  const secretKeys = [
    ...clean(form.env).filter((r) => r.secret).map((r) => `env:${r.key.trim()}`),
    ...clean(form.headers).filter((r) => r.secret).map((r) => `header:${r.key.trim()}`),
  ]
  const base: SaveDraft = { id: form.id, enabled: form.enabled, name: form.name.trim(), transport: form.transport, source: form.source }
  if (secretKeys.length) base.secretKeys = secretKeys
  if (form.transport === 'stdio') {
    return {
      ...base,
      command: form.command.trim(),
      args: form.args.split('\n').map((a) => a.trim()).filter(Boolean),
      env: bag(form.env),
      cwd: form.cwd.trim() || undefined,
    }
  }
  const oauth =
    form.authMode === 'oauth'
      ? {
          ...(form.oauthClientId.trim() ? { clientId: form.oauthClientId.trim() } : {}),
          ...(form.oauthScopes.trim() ? { scopes: form.oauthScopes.trim() } : {}),
          ...(form.oauthAuthorized ? { authorized: true } : {}),
        }
      : undefined
  return {
    ...base,
    url: form.url.trim(),
    headers: form.authMode === 'oauth' ? {} : bag(form.headers),
    ...(form.authMode === 'oauth' ? { authMode: 'oauth', oauth } : { authMode: 'none' }),
  }
}

/** Names of required fields that are still empty. */
export function missingFields(form: ServerForm): string[] {
  const missing: string[] = []
  if (!form.name.trim()) missing.push('name')
  if (form.transport === 'stdio' && !form.command.trim()) missing.push('command')
  if (form.transport === 'http' && !/^https?:\/\/\S+$/.test(form.url.trim())) missing.push('url')
  for (const r of [...form.env, ...form.headers]) if (r.required && !r.value && !r.saved) missing.push(r.key)
  return missing
}

/** The command line exactly as it will be started, for the review step. */
export function commandLine(form: ServerForm): string {
  const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)
  const args = form.args.split('\n').map((a) => a.trim()).filter(Boolean)
  return [form.command.trim(), ...args].map(quote).join(' ')
}
