const palette = {
  ink: ['#080a08', '#e0e3dc'],
  muted: ['#77756d', '#a6b0b1'],
  line: ['#aaa59a', '#536166'],
  paper: ['#eae5e1', '#11181b'],
  panel: ['#edebe4', '#202a2f'],
  field: ['#e7e3d9', '#2a363b'],
  accent: ['#9b7247', '#c5a16b'],
} as const

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
}

export class ScopedThemePainter {
  private host: HTMLElement
  private previous = -1

  constructor(host: HTMLElement) {
    this.host = host
  }

  paint(amount: number): void {
    if (Math.abs(amount - this.previous) < 0.0001) return
    this.previous = amount
    this.host.dataset.darkSurface = String(amount > 0.0001)
    for (const [name, values] of Object.entries(palette)) {
      const from = rgb(values[0])
      const to = rgb(values[1])
      const value = from.map((v, i) => Math.round(v + ((to[i] ?? 0) - v) * amount)).join(', ')
      this.host.style.setProperty(`--theme-${name}`, `rgb(${value})`)
      this.host.style.setProperty(`--theme-${name}-rgb`, value)
    }
  }
}
