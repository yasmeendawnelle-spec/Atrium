import { handleMarketRequest } from './handler.js'

const DEFAULT_AUTH_ORIGIN = 'https://api.rpulse.top'
const DEFAULT_GITHUB_REPO = 'yasmeendawnelle-spec/Atrium'

export default {
  async fetch(request, env) {
    const kv = env.ATRIUM_MARKET_KV
    const store = kv
      ? {
          getJson: (key) => kv.get(key, { type: 'json' }),
          putJson: (key, value) => kv.put(key, JSON.stringify(value)),
          delete: (key) => kv.delete(key),
        }
      : null

    return handleMarketRequest(request, store, {
      authOrigin: (env.AUTH_ORIGIN || DEFAULT_AUTH_ORIGIN).trim(),
      githubRepo: (env.GITHUB_REPO || DEFAULT_GITHUB_REPO).trim(),
      githubToken: env.GITHUB_TOKEN || '',
      coContributorEmails: env.COCONTRIBUTOR_EMAILS || '',
      coContributorGithubLogins: env.COCONTRIBUTOR_GITHUB_LOGINS || '',
      reviewerEmails: env.REVIEWER_EMAILS || '',
    })
  },
}
