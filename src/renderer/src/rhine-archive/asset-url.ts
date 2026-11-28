export function assetUrl(path: string): string {
  const normalized = path.replace(/^\/+/, '')
  return `./${normalized}`
}
