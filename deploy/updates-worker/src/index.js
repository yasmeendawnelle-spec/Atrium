import { handleUpdateRequest } from './range.js'

export default {
  async fetch(request, env) {
    const kv = env.ATRIUM_RELEASES_KV
    const store = {
      getJson: (key) => kv.get(key, { type: 'json' }),
      getStream: (key) => kv.get(key, { type: 'stream' }),
      getArrayBuffer: (key) => kv.get(key, { type: 'arrayBuffer' }),
    }
    return handleUpdateRequest(request, store)
  },
}
