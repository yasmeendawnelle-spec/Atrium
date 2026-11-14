// Pure coordinate translation helpers shared between Electron desktop capture, Win32 input mapping, and tests.

export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Computes aspect-preserving screenshot dimensions scaled so neither width nor height
 * exceeds `maxDim` (default 1280px). Avoids upscaling displays already smaller than `maxDim`.
 */
export function computeScreenshotDimensions(
  dipWidth: number,
  dipHeight: number,
  maxDim = 1280,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(dipWidth))
  const h = Math.max(1, Math.round(dipHeight))
  const peak = Math.max(w, h)
  if (peak <= maxDim) return { width: w, height: h }
  const scale = maxDim / peak
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  }
}

/** Maps a screenshot pixel `(x, y)` inside `0..shotWidth-1` / `0..shotHeight-1` into Electron DIP coordinates. */
export function mapScreenshotPointToDip(
  x: number,
  y: number,
  meta: { bounds: DisplayRect; shotWidth: number; shotHeight: number },
): { x: number; y: number } {
  const sw = Math.max(1, meta.shotWidth)
  const sh = Math.max(1, meta.shotHeight)
  const cx = Math.max(0, Math.min(sw - 1, Number.isFinite(x) ? x : 0))
  const cy = Math.max(0, Math.min(sh - 1, Number.isFinite(y) ? y : 0))
  return {
    x: Math.round(meta.bounds.x + ((cx + 0.5) / sw) * meta.bounds.width),
    y: Math.round(meta.bounds.y + ((cy + 0.5) / sh) * meta.bounds.height),
  }
}

/** Maps an Electron DIP point back into screenshot pixel coordinates and indicates whether it lies on the display. */
export function mapDipPointToScreenshot(
  dipX: number,
  dipY: number,
  meta: { bounds: DisplayRect; shotWidth: number; shotHeight: number },
): { x: number; y: number; inDisplay: boolean } {
  const bw = Math.max(1, meta.bounds.width)
  const bh = Math.max(1, meta.bounds.height)
  const inDisplay =
    dipX >= meta.bounds.x &&
    dipX < meta.bounds.x + bw &&
    dipY >= meta.bounds.y &&
    dipY < meta.bounds.y + bh
  const rawX = Math.floor(((dipX - meta.bounds.x) / bw) * meta.shotWidth)
  const rawY = Math.floor(((dipY - meta.bounds.y) / bh) * meta.shotHeight)
  return {
    x: Math.max(0, Math.min(Math.max(0, meta.shotWidth - 1), rawX)),
    y: Math.max(0, Math.min(Math.max(0, meta.shotHeight - 1), rawY)),
    inDisplay,
  }
}

/** Maps a DIP window rectangle into screenshot pixel coordinates relative to the target display. */
export function mapDipRectToScreenshot(
  rect: DisplayRect,
  meta: { bounds: DisplayRect; shotWidth: number; shotHeight: number },
): DisplayRect {
  const bw = Math.max(1, meta.bounds.width)
  const bh = Math.max(1, meta.bounds.height)
  const sx = meta.shotWidth / bw
  const sy = meta.shotHeight / bh
  return {
    x: Math.round((rect.x - meta.bounds.x) * sx),
    y: Math.round((rect.y - meta.bounds.y) * sy),
    width: Math.max(1, Math.round(rect.width * sx)),
    height: Math.max(1, Math.round(rect.height * sy)),
  }
}
