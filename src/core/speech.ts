// Speech-to-text transcription for Atrium Voice Dictation.
// Supports OpenAI-compatible Whisper `/audio/transcriptions` endpoints AND offline Windows `System.Speech`.
import { execFile } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SpeechTranscribeRequest, SpeechTranscribeResult } from '../shared/types.ts'
import { netFetch } from './net.ts'
import { getSecret, secretKey, setSecret } from './secrets.ts'
import type { SettingsStore } from './settings.ts'

const execFileAsync = promisify(execFile)

export async function saveSpeechApiKey(apiKey: string | null): Promise<{ hasKey: boolean }> {
  const clean = apiKey?.trim() ?? ''
  await setSecret(secretKey('speech', 'default', 'apiKey'), clean || null)
  return { hasKey: Boolean(clean) }
}

export async function hasSpeechApiKey(): Promise<{ hasKey: boolean }> {
  const val = await getSecret(secretKey('speech', 'default', 'apiKey'))
  return { hasKey: Boolean(val?.trim()) }
}

async function transcribeWithWindowsSpeech(wavBuffer: Buffer, language?: string): Promise<SpeechTranscribeResult> {
  if (process.platform !== 'win32') {
    throw new Error('Offline Windows speech recognition is only available on Windows.')
  }
  const wavPath = join(tmpdir(), `atrium-voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`)
  writeFileSync(wavPath, wavBuffer)
  const langPref = (language ?? '').trim()
  const ps = `
Add-Type -AssemblyName System.Speech
$recs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
if ($recs.Count -eq 0) {
  Write-Error "NO_RECOGNIZER"
  exit 2
}
$lang = ${JSON.stringify(langPref)}
$chosen = $null
if ($lang -and $lang -ne 'auto') {
  $chosen = $recs | Where-Object { $_.Culture.Name -ieq $lang } | Select-Object -First 1
  if (-not $chosen) {
    $prefix = $lang.Split('-')[0]
    $chosen = $recs | Where-Object { $_.Culture.TwoLetterISOLanguageName -ieq $prefix } | Select-Object -First 1
  }
}
if (-not $chosen) { $chosen = $recs[0] }
$eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine($chosen.Culture)
$eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$eng.InitialSilenceTimeout = [TimeSpan]::FromSeconds(1.5)
$eng.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(450)
$eng.BabbleTimeout = [TimeSpan]::FromSeconds(2.5)
$eng.SetInputToWaveFile(${JSON.stringify(wavPath)})
$parts = New-Object System.Collections.Generic.List[string]
while ($true) {
  $res = $eng.Recognize()
  if ($null -eq $res) { break }
  if ($res.Text) { $parts.Add($res.Text) }
}
$eng.SetInputToNull()
$eng.Dispose()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Write-Output ($parts -join ' ')
`
  try {
    const encoded = Buffer.from(ps, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 25_000, maxBuffer: 512 * 1024 },
    )
    return { text: stdout.trim(), backend: 'windows-speech' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('NO_RECOGNIZER')) {
      throw new Error(
        'No Windows offline speech pack installed. Configure a Whisper API endpoint/key in Settings -> System or install a Windows Speech language pack.',
      )
    }
    throw new Error(`Windows speech dictation failed: ${msg}`)
  } finally {
    try {
      rmSync(wavPath, { force: true })
    } catch {
      /* ignore temp cleanup race */
    }
  }
}

async function resolveWhisperConfig(settings: SettingsStore): Promise<{ url: string; apiKey: string; model: string } | null> {
  const s = settings.get()
  const customUrl = s.voiceEndpoint?.trim().replace(/\/+$/, '')
  const speechKey = (await getSecret(secretKey('speech', 'default', 'apiKey')))?.trim() || ''
  const model = s.voiceModel?.trim() || 'whisper-1'

  if (customUrl) {
    const url = /\/(?:transcriptions|inference)$/.test(customUrl)
      ? customUrl
      : `${customUrl}/audio/transcriptions`
    return { url, apiKey: speechKey, model }
  }

  if (speechKey) {
    return { url: 'https://api.openai.com/v1/audio/transcriptions', apiKey: speechKey, model }
  }

  const active = settings.activeProvider()
  if (active && (active.protocol === 'openai' || active.protocol === 'responses') && /openai|groq|siliconflow/i.test(active.baseUrl)) {
    const provKey = (await settings.providerKey(active.id)).trim()
    if (provKey) {
      const base = active.baseUrl.replace(/\/+$/, '')
      return {
        url: `${base}/audio/transcriptions`,
        apiKey: provKey,
        model: /groq/i.test(base) ? 'whisper-large-v3' : model,
      }
    }
  }
  return null
}

async function transcribeWithWhisper(
  cfg: { url: string; apiKey: string; model: string },
  audioBuf: Buffer,
  filename: string,
  mimeType: string,
  language?: string,
): Promise<SpeechTranscribeResult> {
  const boundary = `----AtriumVoiceBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const parts: Buffer[] = []
  const pushField = (name: string, val: string) => {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`,
        'utf8',
      ),
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
    audioBuf,
    Buffer.from('\r\n', 'utf8'),
  )
  pushField('model', cfg.model)
  if (language && language !== 'auto') {
    pushField('language', language.split('-')[0]!)
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  const bodyBuf = Buffer.concat(parts)

  const headers: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
  const res = await netFetch(cfg.url, {
    method: 'POST',
    headers,
    body: bodyBuf,
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Whisper transcription HTTP ${res.status}: ${errText.slice(0, 240) || res.statusText}`)
  }
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as { text?: string }
    return { text: (data.text ?? '').trim(), backend: 'whisper' }
  }
  return { text: (await res.text()).trim(), backend: 'whisper' }
}

export async function transcribeSpeech(settings: SettingsStore, req: SpeechTranscribeRequest): Promise<SpeechTranscribeResult> {
  const s = settings.get()
  const mode = s.voiceMode ?? 'auto'
  const language = req.language ?? s.voiceLanguage ?? (s.locale === 'en' ? 'en-US' : 'zh-CN')

  const wavBuf = req.wavBase64 ? Buffer.from(req.wavBase64, 'base64') : null
  const audioBuf = wavBuf ?? (req.audioBase64 ? Buffer.from(req.audioBase64, 'base64') : null)
  if (!audioBuf || audioBuf.byteLength < 64) {
    throw new Error('Recorded audio is empty.')
  }

  const whisperCfg = mode === 'system' ? null : await resolveWhisperConfig(settings)
  if (mode === 'whisper' && !whisperCfg) {
    throw new Error('Whisper voice mode is selected, but no Whisper endpoint or API key is configured in Settings -> System.')
  }

  if (whisperCfg) {
    const isWav = Boolean(wavBuf)
    return transcribeWithWhisper(
      whisperCfg,
      audioBuf,
      isWav ? 'dictation.wav' : 'dictation.webm',
      isWav ? 'audio/wav' : req.mimeType || 'audio/webm',
      language,
    )
  }

  if (process.platform === 'win32' && wavBuf) {
    return transcribeWithWindowsSpeech(wavBuf, language)
  }

  throw new Error(
    'No local speech engine available on this platform. Set a Whisper API endpoint or local whisper.cpp server in Settings -> System.',
  )
}
