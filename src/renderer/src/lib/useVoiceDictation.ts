// Reusable microphone dictation hook producing 16kHz 16-bit mono PCM WAV for local OS or Whisper STT.
import { useEffect, useRef, useState } from 'react'
import { call, errorMessage } from './api.ts'
import { toast } from './store.ts'

function downsampleTo16k(samples: Float32Array, sampleRate: number): Int16Array {
  if (sampleRate === 16000) {
    const out = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]!))
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return out
  }
  const ratio = sampleRate / 16000
  const outLength = Math.max(1, Math.round(samples.length / ratio))
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const idx = i * ratio
    const low = Math.floor(idx)
    const high = Math.min(samples.length - 1, low + 1)
    const frac = idx - low
    const val = samples[low]! * (1 - frac) + samples[high]! * frac
    const clamped = Math.max(-1, Math.min(1, val))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}

function encodeWavBase64(chunks: Float32Array[], sampleRate: number): string {
  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0)
  const merged = new Float32Array(totalLen)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }
  const pcm = downsampleTo16k(merged, sampleRate)
  const buffer = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(buffer)
  const writeStr = (pos: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))

  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function useVoiceDictation(onTranscript: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [level, setLevel] = useState(0)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const sampleRateRef = useRef(16000)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  const releaseAudio = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    try {
      procRef.current?.disconnect()
    } catch {
      /* ignore */
    }
    procRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => undefined)
      ctxRef.current = null
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
  }

  useEffect(() => () => releaseAudio(), [])

  const stop = async (cancel = false) => {
    const captured = [...chunksRef.current]
    const rate = sampleRateRef.current
    chunksRef.current = []
    releaseAudio()
    setRecording(false)
    setLevel(0)
    if (cancel || captured.length === 0) return

    setTranscribing(true)
    try {
      const wavBase64 = encodeWavBase64(captured, rate)
      const res = await call('speech.transcribe', { wavBase64 })
      if (res.text.trim()) {
        onTranscriptRef.current(res.text.trim())
      } else {
        toast('No speech detected in recording.', 'error')
      }
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setTranscribing(false)
    }
  }

  const start = async () => {
    if (recording || transcribing) return
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Microphone capture is unavailable in this environment.', 'error')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      sampleRateRef.current = ctx.sampleRate
      const source = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      proc.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(input))
        let peak = 0
        for (let i = 0; i < input.length; i += 8) {
          const v = Math.abs(input[i]!)
          if (v > peak) peak = v
        }
        setLevel(Math.min(1, peak * 3))
      }
      source.connect(proc)
      proc.connect(ctx.destination)
      streamRef.current = stream
      ctxRef.current = ctx
      procRef.current = proc
      setSeconds(0)
      setRecording(true)
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= 60) {
            void stop(false)
            return 60
          }
          return s + 1
        })
      }, 1000)
    } catch (err) {
      releaseAudio()
      toast(errorMessage(err), 'error')
    }
  }

  const toggle = () => {
    if (recording) void stop(false)
    else void start()
  }

  return { recording, transcribing, seconds, level, toggle, cancel: () => void stop(true) }
}
