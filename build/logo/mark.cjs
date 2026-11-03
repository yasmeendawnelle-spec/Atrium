// Atrium mark generator. Run: node build/logo/mark.cjs
// BRIEF: As calm and warm as the Claude spark, without copying it: one flat
// clay colour, hand-made shapes, a single clear silhouette. Leaf-shaped blades
// turn around a round opening, the oculus of an atrium where light comes in.
// The turn lets the mark spin as the "thinking" indicator. Clay #C46342 on
// cream, #E08A66 on dark, cream on a clay tile for the app icon.
const fs = require('fs')
const path = require('path')
const OUT = __dirname
const f = (n) => +n.toFixed(2)
const deg = Math.PI / 180

// Small seeded random, so the hand-made variation is the same on every run.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const polar = (r, a) => [r * Math.cos(a * deg), r * Math.sin(a * deg)]

// One blade from A (inner) to B (outer), bowed sideways by `bend`.
// profile(s) gives the width along the blade, 0..1.
function blade(A, B, wa, wb, bend, profile, roundEnds) {
  const N = 64, dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy)
  const P = [-dy / len, dx / len], L = [], R = []
  let ends = []
  for (let i = 0; i <= N; i++) {
    const s = i / N, k = bend * Math.sin(Math.PI * s), dk = bend * Math.PI * Math.cos(Math.PI * s)
    const c = [A[0] + dx * s + P[0] * k, A[1] + dy * s + P[1] * k]
    const t = [dx + P[0] * dk, dy + P[1] * dk], tl = Math.hypot(t[0], t[1])
    const n = [-t[1] / tl, t[0] / tl], h = (wa + (wb - wa) * profile(s)) / 2
    L.push([c[0] + n[0] * h, c[1] + n[1] * h]); R.push([c[0] - n[0] * h, c[1] - n[1] * h])
    if (i === 0 || i === N) ends.push({ c, n, h })
  }
  if (!roundEnds) return [...L, ...R.reverse()]
  const cap = ({ c, n, h }, sign) => {
    const fwd = [n[1] * sign, -n[0] * sign], pts = []
    for (let j = 1; j < 16; j++) {
      const ph = (j / 16) * Math.PI
      pts.push([c[0] + h * (sign * n[0] * Math.cos(ph) + fwd[0] * Math.sin(ph)), c[1] + h * (sign * n[1] * Math.cos(ph) + fwd[1] * Math.sin(ph))])
    }
    return pts
  }
  return [...L, ...cap(ends[1], 1), ...R.reverse(), ...cap(ends[0], -1)]
}

// Rosette: pointed leaf blades, widest near the outer end, around an open centre.
function rosette({ n = 10, r0 = 25, r1 = 100, wb = 21, swirl = 30, bend = 10, belly = 0.75, jitter = 0.4, seed = 1 }) {
  const r = rng(seed), out = []
  const profile = (s) => Math.pow(Math.sin(Math.PI * Math.pow(s, belly)), 0.9)
  for (let i = 0; i < n; i++) {
    const a = -90 + i * (360 / n) + (r() - 0.5) * 6 * jitter
    const len = r1 * (1 + (r() - 0.5) * 0.1 * jitter)
    const w = wb * (1 + (r() - 0.5) * 0.15 * jitter)
    out.push(blade(polar(r0, a), polar(len, a + swirl), 0, w, bend, profile, false))
  }
  return out
}

// Petals: slender tails, round heads, turning around an open centre.
function petals({ n = 6, r0 = 26, r1 = 92, wa = 3, wb = 42, swirl = 46, bend = 18, tail = 2.4, jitter = 0.35, seed = 3 }) {
  const r = rng(seed), out = []
  const profile = (s) => Math.pow(Math.sin((s * Math.PI) / 2), tail)
  for (let i = 0; i < n; i++) {
    const a = -90 + i * (360 / n) + (r() - 0.5) * 5 * jitter
    const len = r1 * (1 + (r() - 0.5) * 0.08 * jitter)
    const w = wb * (1 + (r() - 0.5) * 0.12 * jitter)
    out.push(blade(polar(r0, a), polar(len, a + swirl), wa, w, bend, profile, true))
  }
  return out
}

// Scale and centre the shapes into a `size` box in a 256 canvas.
function fit(shapes, size) {
  const all = shapes.flat(), xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const s = size / Math.max(x1 - x0, y1 - y0), tx = 128 - ((x0 + x1) / 2) * s, ty = 128 - ((y0 + y1) / 2) * s
  return shapes.map((pts) => pts.map(([x, y]) => [x * s + tx, y * s + ty]))
}

const toPath = (pts) => 'M' + pts.map(([x, y]) => `${f(x)},${f(y)}`).join('L') + 'Z'

function squircle(half, n = 5, steps = 180) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t)
    pts.push([128 + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * half, 128 + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * half])
  }
  return toPath(pts)
}

function file(shapes, colour, tile) {
  const bg = tile ? `<path id="tile" d="${squircle(116)}" fill="${tile}"/>\n` : ''
  const body = shapes.map((pts, i) => `<path id="blade-${i + 1}" d="${toPath(pts)}"/>`).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">\n${bg}<g id="mark" fill="${colour}">\n${body}\n</g>\n</svg>\n`
}

const CLAY = '#C46342', CLAY_ON_DARK = '#E08A66', CREAM = '#FBF6EF'
const MARKS = { rosette: () => rosette({}), petals: () => petals({}) }

for (const [name, make] of Object.entries(MARKS)) {
  fs.writeFileSync(path.join(OUT, `atrium-${name}.svg`), file(fit(make(), 216), CLAY))
  fs.writeFileSync(path.join(OUT, `atrium-${name}-dark.svg`), file(fit(make(), 216), CLAY_ON_DARK))
  fs.writeFileSync(path.join(OUT, `atrium-${name}-icon.svg`), file(fit(make(), 152), CREAM, CLAY))
}
console.log('ok')
