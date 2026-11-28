import { handleUpdateRequest } from './range.js'

const DEFAULT_GITHUB_REPO = 'yasmeendawnelle-spec/Atrium'

export default {
  async fetch(request, env) {
    const kv = env.ATRIUM_RELEASES_KV
    const store = kv
      ? {
          getJson: (key) => kv.get(key, { type: 'json' }),
          getStream: (key) => kv.get(key, { type: 'stream' }),
          getArrayBuffer: (key) => kv.get(key, { type: 'arrayBuffer' }),
        }
      : null
    const githubRepo = (env.GITHUB_REPO || DEFAULT_GITHUB_REPO).trim()
    const fetchImpl = (url, init, meta) => {
      const cfInit = meta?.noStore ? { ...init, cf: { cacheTtl: 0, cacheEverything: false } } : init
      return fetch(url, cfInit)
    }
    return handleUpdateRequest(request, store, { githubRepo, fetchImpl })
  },
}
