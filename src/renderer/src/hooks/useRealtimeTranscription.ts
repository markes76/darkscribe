import { useState, useRef, useCallback, useEffect } from 'react'
import { RealtimeTranscriptionService, TranscriptSegment } from '../services/openai-realtime'

// ─── Post-processing filter ────────────────────────────────────────────
// Filters out hallucinated, duplicate, and wrong-language segments

// Detect script of text to identify language
function detectScript(text: string): 'hebrew' | 'latin' | 'cjk' | 'arabic' | 'cyrillic' | 'mixed' | 'unknown' {
  const clean = text.replace(/[\s\d\p{P}\p{S}]/gu, '')
  if (clean.length === 0) return 'unknown'
  let hebrew = 0, latin = 0, cjk = 0, arabic = 0, cyrillic = 0
  for (const ch of clean) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0x0590 && cp <= 0x05FF) hebrew++
    else if ((cp >= 0x0041 && cp <= 0x007A) || (cp >= 0x00C0 && cp <= 0x024F)) latin++
    else if (cp >= 0x4E00 && cp <= 0x9FFF) cjk++
    else if (cp >= 0x0600 && cp <= 0x06FF) arabic++
    else if (cp >= 0x0400 && cp <= 0x04FF) cyrillic++
  }
  const total = hebrew + latin + cjk + arabic + cyrillic
  if (total === 0) return 'unknown'
  if (hebrew / total > 0.6) return 'hebrew'
  if (latin / total > 0.6) return 'latin'
  if (cjk / total > 0.6) return 'cjk'
  if (arabic / total > 0.6) return 'arabic'
  if (cyrillic / total > 0.6) return 'cyrillic'
  return 'mixed'
}

// Map ISO language codes to expected scripts
const LANG_SCRIPTS: Record<string, string[]> = {
  he: ['hebrew'], en: ['latin'], es: ['latin'], fr: ['latin'], de: ['latin'],
  pt: ['latin'], it: ['latin'], nl: ['latin'], ru: ['cyrillic'], uk: ['cyrillic'],
  ar: ['arabic'], zh: ['cjk'], ja: ['cjk'], ko: ['cjk']
}

function detectLanguageCode(text: string): string {
  const script = detectScript(text)
  if (script === 'hebrew') return 'he'
  if (script === 'latin') return 'en' // Default latin to English
  if (script === 'arabic') return 'ar'
  if (script === 'cyrillic') return 'ru'
  if (script === 'cjk') return 'zh'
  if (script === 'mixed') return 'mixed'
  return 'unknown'
}

function isSegmentAllowedByLanguage(text: string, preferredLanguages: string[]): boolean {
  if (preferredLanguages.length === 0) return true
  const script = detectScript(text)
  if (script === 'unknown' || script === 'mixed') return true
  const allowedScripts = new Set(preferredLanguages.flatMap(l => LANG_SCRIPTS[l] ?? []))
  if (allowedScripts.size === 0) return true
  return allowedScripts.has(script)
}

function charOverlap(a: string, b: string): number {
  const shorter = a.length < b.length ? a : b
  const longer = a.length >= b.length ? a : b
  if (shorter.length === 0) return 0
  let matches = 0
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++
  }
  return matches / shorter.length
}

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected'

export interface Speaker {
  id: string
  name: string
  color: string
  source: 'mic' | 'sys'
}

export interface TranscriptionState {
  status: SessionStatus
  statusDetail: string
  segments: TranscriptSegment[]
  speakers: Speaker[]
  isCapturing: boolean
  sysChunkCount: number
  micChunkCount: number
  audioError: string
  callDuration: number
}

export interface TranscriptionActions {
  startSession: (sessionId: string) => Promise<void>
  stopSession: () => Promise<{ filePath: string; durationMs: number } | null>
}

const MIC_SAMPLE_RATE = 24000
const MIC_CHUNK_FRAMES = 2400

export function useRealtimeTranscription(): TranscriptionState & TranscriptionActions {
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [statusDetail, setStatusDetail] = useState('')
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [speakers, setSpeakers] = useState<Speaker[]>([
    { id: 'mic', name: 'You', color: '#2563eb', source: 'mic' },
    { id: 'sys', name: 'Them', color: '#059669', source: 'sys' }
  ])
  const [isCapturing, setIsCapturing] = useState(false)
  const [sysChunkCount, setSysChunkCount] = useState(0)
  const [micChunkCount, setMicChunkCount] = useState(0)
  const [audioError, setAudioError] = useState('')
  const [callDuration, setCallDuration] = useState(0)

  const serviceRef = useRef<RealtimeTranscriptionService | null>(null)
  const removeListenersRef = useRef<Array<() => void>>([])
  const micStreamRef = useRef<MediaStream | null>(null)
  const micContextRef = useRef<AudioContext | null>(null)
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const preferredLangsRef = useRef<string[]>([])
  const lastFinalTextRef = useRef<string>('')

  const handleTranscriptSegment = useCallback((seg: TranscriptSegment) => {
    const text = seg.text.trim()

    // Add detected language to segment
    seg.detectedLanguage = detectLanguageCode(text)

    // Post-processing filters (only apply to final segments)
    if (seg.isFinal) {
      // Filter 1: Minimum length — discard segments under 2 chars
      if (text.length < 2) {
        console.log(`[Filter] Discarded <2 chars: "${text}"`)
        return
      }

      // Filter 2: Language check — discard if entirely in a non-preferred script
      if (!isSegmentAllowedByLanguage(text, preferredLangsRef.current)) {
        console.log(`[Filter] Discarded wrong language: "${text.substring(0, 50)}..." (detected: ${seg.detectedLanguage}, preferred: ${preferredLangsRef.current.join(',')})`)
        return
      }

      // Filter 3: Dedup — discard if >90% character overlap with previous final segment
      if (lastFinalTextRef.current && charOverlap(text, lastFinalTextRef.current) > 0.9) {
        console.log(`[Filter] Discarded duplicate: "${text.substring(0, 50)}..."`)
        return
      }

      lastFinalTextRef.current = text
    }

    setSegments(prev => {
      const idx = prev.findIndex(s => s.id === seg.id)
      if (idx !== -1) {
        const next = [...prev]
        next[idx] = seg
        return next
      }
      const next = [...prev, seg]
      if (prev.length > 0 && seg.timestamp < prev[prev.length - 1].timestamp) {
        next.sort((a, b) => a.timestamp - b.timestamp)
      }
      return next
    })
  }, [])

  const startMicCapture = useCallback(async (service: RealtimeTranscriptionService) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: MIC_SAMPLE_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      micStreamRef.current = stream
      const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE })
      micContextRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      micProcessorRef.current = processor
      let acc = new Int16Array(MIC_CHUNK_FRAMES), pos = 0
      processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const input = e.inputBuffer.getChannelData(0)
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]))
          acc[pos++] = s < 0 ? s * 0x8000 : s * 0x7FFF
          if (pos >= MIC_CHUNK_FRAMES) {
            const chunk = acc.buffer.slice(0)
            service.appendAudio(chunk, 'mic')
            window.darkscribe.recording.micChunk(chunk)
            setMicChunkCount(p => p + 1)
            acc = new Int16Array(MIC_CHUNK_FRAMES)
            pos = 0
          }
        }
      }
      source.connect(processor); processor.connect(ctx.destination)
    } catch (err) { setAudioError(`Mic: ${(err as Error).message}`) }
  }, [])

  const stopMicCapture = useCallback(() => {
    micProcessorRef.current?.disconnect(); micProcessorRef.current = null
    micContextRef.current?.close(); micContextRef.current = null
    micStreamRef.current?.getTracks().forEach(t => t.stop()); micStreamRef.current = null
  }, [])

  const startSession = useCallback(async (sessionId: string) => {
    setSysChunkCount(0); setMicChunkCount(0); setAudioError(''); setCallDuration(0)
    setSpeakers([
      { id: 'mic', name: 'You', color: '#2563eb', source: 'mic' },
      { id: 'sys', name: 'Them', color: '#059669', source: 'sys' }
    ])
    setSegments([])

    const audioResult = await window.darkscribe.audio.start()
    if (audioResult.error) { setStatus('error'); setStatusDetail(audioResult.error); return }
    setIsCapturing(true)

    window.darkscribe.recording.start(sessionId).catch(() => {})
    timerRef.current = setInterval(() => setCallDuration(p => p + 1), 1000)

    // Read language settings and vocabulary hints from config + skill file
    let languages: string[] = []
    let vocabularyHints = ''
    try {
      const config = await window.darkscribe.config.read()
      if (config.transcription_mode === 'preferred' && config.preferred_languages?.length) {
        languages = config.preferred_languages as string[]
      }
      // Store for post-processing filter
      preferredLangsRef.current = languages

      // Load vocabulary from Notetaker Skill file
      const prefix = (config.vault_subfolder as string) || ''
      const skillPath = prefix ? `${prefix}/System/Notetaker Skill.md` : 'System/Notetaker Skill.md'
      try {
        const skillResult = await window.darkscribe.vault.readNote(skillPath)
        if (skillResult?.content) {
          // Extract the "Vocabulary and Corrections" section
          const vocabMatch = skillResult.content.match(/## Vocabulary and Corrections\n([\s\S]*?)(?=\n## |\n---|\Z)/)
          if (vocabMatch?.[1]?.trim()) {
            vocabularyHints = vocabMatch[1].trim()
          }
        }
      } catch {} // Vault may not be connected — that's fine
    } catch {}

    const service = new RealtimeTranscriptionService(
      handleTranscriptSegment,
      (s, detail) => {
        setStatus(s === 'connecting' ? 'connecting' : s === 'connected' ? 'connected' : s === 'disconnected' ? 'disconnected' : 'error')
        setStatusDetail(detail ?? '')
      },
      languages,
      vocabularyHints
    )
    serviceRef.current = service; service.connect()
    startMicCapture(service)

    const removeChunk = window.darkscribe.audio.onChunk((buffer: ArrayBuffer) => { service.appendAudio(buffer, 'sys'); setSysChunkCount(p => p + 1) })
    const removeStopped = window.darkscribe.audio.onStopped(() => {})
    const removePermDenied = window.darkscribe.audio.onPermissionDenied(() => {})
    const removeError = window.darkscribe.audio.onError((msg: string) => setAudioError(msg))
    removeListenersRef.current = [removeChunk, removeStopped, removePermDenied, removeError]
  }, [handleTranscriptSegment, startMicCapture])

  const stopSession = useCallback(async () => {
    await window.darkscribe.audio.stop(); setIsCapturing(false); stopMicCapture()
    serviceRef.current?.disconnect(); serviceRef.current = null
    removeListenersRef.current.forEach(fn => fn()); removeListenersRef.current = []
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    setStatus('idle'); setStatusDetail('')
    try {
      return await window.darkscribe.recording.stop()
    } catch {
      return null
    }
  }, [stopMicCapture])

  useEffect(() => {
    return () => {
      serviceRef.current?.disconnect(); removeListenersRef.current.forEach(fn => fn()); stopMicCapture(); window.darkscribe.audio.stop()
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [stopMicCapture])

  return { status, statusDetail, segments, speakers, isCapturing, sysChunkCount, micChunkCount, audioError, callDuration, startSession, stopSession }
}
