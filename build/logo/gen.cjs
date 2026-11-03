// Atrium logo generator. Run: node build/logo/gen.cjs
// BRIEF: Atrium = a courtyard open to the sky. Each concept is one strong
// geometric idea on a grid, solid fills, readable at 16px, brand clay #C46342.
const fs = require('fs')
const path = require('path')
const OUT = __dirname

const f = (n) => +n.toFixed(2)

// iOS-style superellipse squircle, |x|^n + |y|^n = 1
function squircle(cx, cy, half, n = 5, steps = 160) {
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const c = Math.cos(t), s = Math.sin(t)
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * half
    const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * half
    pts.push(`${f(cx + x)},${f(cy + y)}`)
  }
  return `M${pts.join('L')}Z`
}

// Concave 4-point star: the gap left between four touching circles.
function sparkle(cx, cy, r) {
  return `M${cx},${cy - r}A${r},${r} 0 0 0 ${cx + r},${cy}A${r},${r} 0 0 0 ${cx},${cy + r}` +
    `A${r},${r} 0 0 0 ${cx - r},${cy}A${r},${r} 0 0 0 ${cx},${cy - r}Z`
}

const TILE = squircle(128, 128, 112)
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">\n<defs>${defs}</defs>\n${body}\n</svg>\n`

// ── Concept 1: Oculus. Looking up a domed atrium toward the round skylight.
// Rings shrink and climb, so the bands are wide at the bottom, thin at the top.
// The tile itself is the outermost wall, so the dome fills the whole icon.
function oculus(dark) {
  const tile = dark ? '#2A140B' : '#B4532F'
  const rings = dark
    ? ['#4A2214', '#6E3019', '#96401F', '#C25B32']
    : ['#C46342', '#D4794F', '#E3966C', '#F0B794']
  const radii = [104, 82, 61, 42]
  const top = 26
  const defs = `<clipPath id="clip"><path d="${TILE}"/></clipPath>` +
    `<radialGradient id="sky-g" cx="0.5" cy="0.4" r="0.6"><stop offset="0" stop-color="#FFFFFF"/>` +
    `<stop offset="1" stop-color="${dark ? '#FFD9B8' : '#FFF1E4'}"/></radialGradient>`
  let body = `<path id="tile" d="${TILE}" fill="${tile}"/><g id="dome" clip-path="url(#clip)">`
  radii.forEach((r, i) => {
    body += `<circle cx="128" cy="${top + r + i * 9}" r="${r}" fill="${rings[i]}"/>`
  })
  body += `</g><circle id="sky" cx="128" cy="${top + 25 + 4 * 9 + 2}" r="25" fill="url(#sky-g)"/>`
  return svg(body, defs)
}

// ── Concept 2: Courtyard. Four blocks seen from above. The open court in the
// middle is the sparkle: the building makes room for the AI.
function courtyard(dark) {
  const S = 76, R = 44, G = 7
  const block = dark ? '#E58A63' : '#C46342'
  let defs = `<mask id="court"><rect width="256" height="256" fill="#000"/>` +
    `<rect x="${128 - S}" y="${128 - S}" width="${2 * S}" height="${2 * S}" rx="30" fill="#fff"/>` +
    `<rect x="${128 - G / 2}" y="0" width="${G}" height="256" fill="#000"/>` +
    `<rect x="0" y="${128 - G / 2}" width="256" height="${G}" fill="#000"/>` +
    `<path d="${sparkle(128, 128, R + 12)}" fill="#000"/></mask>`
  let body = `<path id="tile" d="${TILE}" fill="${dark ? '#1F1A17' : '#FBF6EF'}"/>`
  body += `<rect id="blocks" x="0" y="0" width="256" height="256" fill="${block}" mask="url(#court)"/>`
  body += `<path id="spark" d="${sparkle(128, 128, R)}" fill="${dark ? '#FFE7CF' : '#22211F'}"/>`
  return svg(body, defs)
}

// ── Concept 3: Colonnade. Three arches stepping back into the building,
// a bright doorway at the end. Also reads as a lowercase "n"/capital "A" form.
function colonnade(dark) {
  const arches = [
    { w: 140, h: 156, c: dark ? '#C46342' : '#C46342' },
    { w: 100, h: 118, c: dark ? '#8E3A1F' : '#E0A07F' },
    { w: 62, h: 82, c: dark ? '#5A2412' : '#F2CDB6' },
  ]
  const base = 204
  const arch = (w, h) => {
    const r = w / 2, x0 = 128 - r, x1 = 128 + r, yTop = base - h + r
    return `M${x0},${base}V${yTop}A${r},${r} 0 0 1 ${x1},${yTop}V${base}Z`
  }
  let body = `<path id="tile" d="${TILE}" fill="${dark ? '#1F1A17' : '#FBF6EF'}"/>`
  body += `<g id="arches">` + arches.map((a) => `<path d="${arch(a.w, a.h)}" fill="${a.c}"/>`).join('') + `</g>`
  body += `<path id="door" d="${arch(30, 50)}" fill="${dark ? '#FFE7CF' : '#FFFFFF'}"/>`
  return svg(body)
}

const concepts = {
  'atrium-1-oculus': oculus,
  'atrium-2-courtyard': courtyard,
}
for (const [name, fn] of Object.entries(concepts)) {
  fs.writeFileSync(path.join(OUT, `${name}.svg`), fn(false))
  fs.writeFileSync(path.join(OUT, `${name}-dark.svg`), fn(true))
}
console.log('ok')
