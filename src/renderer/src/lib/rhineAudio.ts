/**
 * Zero-dependency Web Audio tactile synthesizer inspired by LBEILC/RhineLabUI.
 * Synthesizes glass touches, harmonic confirmations, filtered scan air sweeps,
 * and a crystalline D-major-9 shimmer without shipping external audio assets.
 */

export type RhineSound =
  | 'key'
  | 'brand'
  | 'confirm'
  | 'scan'
  | 'welcome'
  | 'ui-tick'
  | 'ui-toggle'
  | 'ui-open'
  | 'array'
  | 'column'
  | 'explode'
  | 'assemble'
  | 'back'

const MUTE_STORAGE_KEY = 'atrium:rhine-sfx-muted'
export const RHINE_AUDIO_MUTE_EVENT = 'atrium:rhine-audio-mute'

const MIN_INTERVAL_MS = 38
const MASTER_GAIN = 0.18

let audioCtx: AudioContext | null = null
let cachedNoiseBuffer: AudioBuffer | null = null
const lastPlayedAt = new Map<RhineSound, number>()

export function isRhineAudioMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function setRhineAudioMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? 'true' : 'false')
  } catch {
    /* ignore storage error */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RHINE_AUDIO_MUTE_EVENT, { detail: { muted } }))
  }
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!audioCtx) {
    try {
      audioCtx = new Ctor()
    } catch {
      return null
    }
  }
  return audioCtx
}

function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (cachedNoiseBuffer && cachedNoiseBuffer.sampleRate === ctx.sampleRate) {
    return cachedNoiseBuffer
  }
  const length = ctx.sampleRate * 2
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  let seed = 773
  for (let i = 0; i < length; i++) {
    seed = (seed * 16807) % 2147483647
    data[i] = ((seed - 1) / 1073741823.5) - 1
  }
  cachedNoiseBuffer = buffer
  return buffer
}

export function unlockRhineAudio(): void {
  if (isRhineAudioMuted()) return
  const ctx = getAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
}

function scheduleTone(
  ctx: AudioContext,
  dest: AudioNode,
  freqStart: number,
  freqEnd: number,
  gainPeak: number,
  duration: number,
  delay = 0,
  attack = 0.005,
): void {
  const start = ctx.currentTime + delay
  const osc = ctx.createOscillator()
  const env = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freqStart, start)
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + duration)
  env.gain.setValueAtTime(0.0001, start)
  env.gain.linearRampToValueAtTime(gainPeak, start + Math.min(attack, duration * 0.35))
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  env.gain.linearRampToValueAtTime(0, start + duration + 0.012)
  osc.connect(env)
  env.connect(dest)
  osc.onended = () => {
    osc.disconnect()
    env.disconnect()
  }
  osc.start(start)
  osc.stop(start + duration + 0.015)
}

function scheduleAir(
  ctx: AudioContext,
  dest: AudioNode,
  freqStart: number,
  freqEnd: number,
  gainPeak: number,
  duration: number,
  delay = 0,
  attack = 0.015,
  q = 2.2,
): void {
  const start = ctx.currentTime + delay
  const src = ctx.createBufferSource()
  src.buffer = getNoiseBuffer(ctx)
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = q
  filter.frequency.setValueAtTime(freqStart, start)
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), start + duration)
  const env = ctx.createGain()
  env.gain.setValueAtTime(0.0001, start)
  env.gain.linearRampToValueAtTime(gainPeak, start + Math.min(attack, duration * 0.35))
  env.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  env.gain.linearRampToValueAtTime(0, start + duration + 0.012)
  src.connect(filter)
  filter.connect(env)
  env.connect(dest)
  src.onended = () => {
    src.disconnect()
    filter.disconnect()
    env.disconnect()
  }
  src.start(start)
  src.stop(start + duration + 0.015)
}

function scheduleGlass(
  ctx: AudioContext,
  dest: AudioNode,
  freq: number,
  gainPeak: number,
  duration: number,
  delay = 0,
): void {
  scheduleTone(ctx, dest, freq, freq * 0.996, gainPeak, duration, delay, 0.003)
  scheduleTone(ctx, dest, freq * 2.012, freq * 2.0, gainPeak * 0.32, duration * 0.72, delay, 0.003)
  scheduleAir(ctx, dest, Math.min(6000, freq * 1.65), Math.min(7200, freq * 2.1), gainPeak * 0.18, Math.min(0.045, duration * 0.45), delay, 0.003, 3.0)
}

export function playRhineSound(type: RhineSound, volumeScale = 1): void {
  if (typeof document !== 'undefined' && document.hidden) return
  if (isRhineAudioMuted()) return

  const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const prevMs = lastPlayedAt.get(type) ?? 0
  if (nowMs - prevMs < MIN_INTERVAL_MS) return

  const ctx = getAudioContext()
  if (!ctx) return

  if (
    type === 'ui-tick' ||
    type === 'ui-toggle' ||
    type === 'ui-open' ||
    type === 'array' ||
    type === 'column' ||
    type === 'explode' ||
    type === 'assemble' ||
    type === 'back'
  ) {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }
  }
  if (ctx.state !== 'running') return

  lastPlayedAt.set(type, nowMs)

  const scale = Math.max(0, Math.min(1.5, volumeScale))
  const master = ctx.createGain()
  master.gain.value = MASTER_GAIN * scale
  master.connect(ctx.destination)

  switch (type) {
    case 'key':
      scheduleTone(ctx, master, 1950, 1820, 0.09, 0.024, 0, 0.002)
      scheduleAir(ctx, master, 3200, 4200, 0.04, 0.02, 0, 0.002, 3.5)
      break
    case 'brand':
      scheduleGlass(ctx, master, 1180, 0.15, 0.24, 0)
      scheduleGlass(ctx, master, 1770, 0.1, 0.22, 0.045)
      scheduleAir(ctx, master, 1400, 2900, 0.07, 0.36, 0, 0.04, 1.8)
      break
    case 'confirm':
      scheduleTone(ctx, master, 640, 640, 0.16, 0.09, 0, 0.006)
      scheduleTone(ctx, master, 960, 960, 0.12, 0.14, 0.09, 0.007)
      break
    case 'scan':
      scheduleAir(ctx, master, 1800, 3400, 0.11, 0.55, 0, 0.09, 2.0)
      for (let i = 0; i < 3; i++) {
        scheduleTone(ctx, master, 760, 760, 0.1, 0.06, i * 0.15 + 0.08, 0.005)
      }
      break
    case 'welcome':
      ;[293.66, 440, 659.25, 739.99].forEach((freq, i) => {
        scheduleTone(ctx, master, freq, freq, 0.12, 1.1, i * 0.075, 0.04)
      })
      scheduleAir(ctx, master, 650, 1850, 0.14, 0.72, 0, 0.12, 1.5)
      break
    case 'ui-tick':
      scheduleGlass(ctx, master, 1680, 0.16, 0.14, 0)
      break
    case 'ui-toggle':
      scheduleGlass(ctx, master, 1280, 0.18, 0.16, 0)
      scheduleGlass(ctx, master, 2050, 0.11, 0.11, 0.035)
      break
    case 'ui-open':
      scheduleGlass(ctx, master, 1150, 0.2, 0.24, 0)
      scheduleGlass(ctx, master, 2180, 0.12, 0.18, 0.07)
      scheduleAir(ctx, master, 2800, 4200, 0.05, 0.18, 0.02, 0.02, 2.4)
      break
    case 'array':
      scheduleGlass(ctx, master, 980, 0.14, 0.24, 0)
      scheduleGlass(ctx, master, 1320, 0.13, 0.24, 0.055)
      scheduleGlass(ctx, master, 1760, 0.11, 0.28, 0.11)
      scheduleAir(ctx, master, 1200, 3200, 0.08, 0.36, 0, 0.04, 1.9)
      break
    case 'column':
      scheduleGlass(ctx, master, 1120, 0.15, 0.16, 0)
      scheduleGlass(ctx, master, 1480, 0.11, 0.14, 0.04)
      break
    case 'explode':
      scheduleGlass(ctx, master, 780, 0.14, 0.22, 0)
      scheduleGlass(ctx, master, 1460, 0.13, 0.25, 0.05)
      scheduleAir(ctx, master, 1600, 3600, 0.07, 0.24, 0, 0.02, 2.1)
      break
    case 'assemble':
      scheduleGlass(ctx, master, 1380, 0.14, 0.2, 0)
      scheduleGlass(ctx, master, 720, 0.16, 0.24, 0.055)
      scheduleAir(ctx, master, 2600, 900, 0.06, 0.22, 0, 0.02, 2.2)
      break
    case 'back':
      scheduleGlass(ctx, master, 1420, 0.13, 0.16, 0)
      scheduleGlass(ctx, master, 1020, 0.12, 0.18, 0.045)
      break
  }

  window.setTimeout(() => {
    try {
      master.disconnect()
    } catch {
      /* ignore */
    }
  }, 1500)
}
