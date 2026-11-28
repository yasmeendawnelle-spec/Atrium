export interface UpdateObjectMeta {
  kind: 'inline' | 'chunked'
  contentType?: string
  size: number
  sha512?: string
  chunkSize?: number
  chunkCount?: number
  version?: string
  updatedAt?: string
}

export interface UpdateObjectStore {
  getJson(key: string): Promise<Record<string, unknown> | UpdateObjectMeta | null>
  getStream(key: string): Promise<ReadableStream<Uint8Array> | null>
  getArrayBuffer(key: string): Promise<ArrayBuffer | null>
}

export type ParsedRangeResult =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'ranges'; ranges: Array<{ start: number; end: number }> }

export interface UpdateRequestOptions {
  githubRepo?: string
  fetchImpl?: (url: string, init?: RequestInit, meta?: { noStore?: boolean }) => Promise<Response>
}

export function sanitizeAssetName(raw: string): string | null
export function extractReleaseTagFromFilename(filename: string): string | null
export function buildGitHubAssetUrls(repo: string, filename: string): string[]
export function parseRangeHeader(headerValue: string | null, totalSize: number): ParsedRangeResult
export function handleUpdateRequest(
  request: Request,
  store: UpdateObjectStore | null,
  options?: UpdateRequestOptions,
): Promise<Response>
