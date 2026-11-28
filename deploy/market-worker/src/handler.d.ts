export interface MarketObjectStore {
  getJson(key: string): Promise<unknown>
  putJson(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface MarketHandlerOptions {
  authOrigin?: string
  githubRepo?: string
  githubToken?: string
  coContributorEmails?: string
  coContributorGithubLogins?: string
  reviewerEmails?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export function extractGithubLoginFromProfile(user: unknown): string | null
export function parseEmailSet(raw: string | undefined): Set<string>
export function sanitizeBundlePath(rawPath: string): string | null
export function validateAvatar(raw: unknown): string | null
export function summarizeBundleFiles(
  files: Array<{ path: string; content: string; encoding: 'utf8' | 'base64'; size: number }>,
): {
  skillNames: string[]
  commandNames: string[]
  ruleFiles: string[]
  mcpCount: number
  hasHooks: boolean
  hasScripts: boolean
  fileCount: number
  totalBytes: number
}
export function handleMarketRequest(
  request: Request,
  store: MarketObjectStore | null,
  opts?: MarketHandlerOptions,
): Promise<Response>
