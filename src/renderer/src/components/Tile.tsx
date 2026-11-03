/** A quiet square with the first letter of a name and a deterministic soft duotone tint. */
export function Tile({ name }: { name: string }) {
  const trimmed = name.trim()
  const letter = [...trimmed][0]?.toUpperCase() ?? '?'
  let hash = 0
  for (let i = 0; i < trimmed.length; i++) hash = (hash * 31 + trimmed.charCodeAt(i)) | 0
  const tone = Math.abs(hash) % 5
  return (
    <span className={`tile tile-tone-${tone}`} aria-hidden>
      {letter}
    </span>
  )
}
