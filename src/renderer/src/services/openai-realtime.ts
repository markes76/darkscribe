// OpenAI Realtime API — Dual-Channel WebSocket transcription service
//
// Architecture: TWO separate Realtime API sessions, both always active
//   Session 1 (mic):    in-room audio → "You"
//   Session 2 (system): remote audio  → "Them"
//
// Audio format: Int16 PCM, 24kHz, mono.

export type TranscriptSegment = {
  id: string
  speaker: 'mic' | 'sys'
  speakerName?: string
  speakerColor?: string
  text: string
  isFinal: boolean
  timestamp: number
  language?: string
}

export type TranscriptCallback = (segment: TranscriptSegment) => void
export type StatusCallback = (status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?: string) => void

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview'
const MAX_RETRIES = 5
const BASE_RETRY_MS = 1000

function base64FromInt16(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 65536
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function rmsEnergy(buffer: ArrayBuffer): number {
  const samples = new Int16Array(buffer)
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

const SILENCE_THRESHOLD = 200

let idCounter = 0
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${idCounter++}`
}

class RealtimeChannel {
  private ws: WebSocket | null = null
  private retryCount = 0
  private retryTimeout: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private pendingSegments = new Map<string, TranscriptSegment>()
  private channel: 'mic' | 'sys'
  private languages: string[]
  private onTranscript: TranscriptCallback
  private onStatus: StatusCallback

  constructor(channel: 'mic' | 'sys', onTranscript: TranscriptCallback, onStatus: StatusCallback, languages: string[] = []) {
    this.channel = channel
    this.onTranscript = onTranscript
    this.onStatus = onStatus
    this.languages = languages
  }

  connect(): void {
    this.stopped = false
    this.openWebSocket()
  }

  private openWebSocket(): void {
    this.onStatus('connecting', `${this.channel} channel`)
    this.ws = new WebSocket(REALTIME_URL)

    this.ws.onopen = () => {
      this.retryCount = 0
      this.onStatus('connected', `${this.channel} channel`)
      this.sendSessionConfig()
    }

    this.ws.onmessage = (e: MessageEvent) => {
      try { this.handleEvent(JSON.parse(e.data as string)) } catch {}
    }

    this.ws.onerror = () => this.onStatus('error', `${this.channel} WebSocket error`)

    this.ws.onclose = () => {
      if (!this.stopped) this.scheduleReconnect()
      else this.onStatus('disconnected', `${this.channel} channel`)
    }
  }

  private sendSessionConfig(): void {
    const transcriptionConfig: Record<string, unknown> = { model: 'whisper-1' }
    if (this.languages.length === 1 && this.languages[0] !== 'auto') {
      transcriptionConfig.language = this.languages[0]
    }

    this.send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm16',
        input_audio_transcription: transcriptionConfig,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    })
  }

  appendAudio(buffer: ArrayBuffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    if (this.channel === 'sys' && rmsEnergy(buffer) < SILENCE_THRESHOLD) return
    this.send({ type: 'input_audio_buffer.append', audio: base64FromInt16(buffer) })
  }

  private handleEvent(event: Record<string, unknown>): void {
    const type = event.type as string

    if (type === 'error') {
      console.error(`[Realtime:${this.channel}]`, event.error)
    }

    const speakerName = this.channel === 'mic' ? 'You' : 'Them'
    const speakerColor = this.channel === 'mic' ? '#2563eb' : '#059669'

    switch (type) {
      case 'conversation.item.input_audio_transcription.delta': {
        const itemId = event.item_id as string
        const delta = event.delta as string
        if (!delta) break
        let seg = this.pendingSegments.get(itemId)
        if (!seg) {
          seg = { id: nextId(this.channel), speaker: this.channel, speakerName, speakerColor, text: '', isFinal: false, timestamp: Date.now() }
          this.pendingSegments.set(itemId, seg)
        }
        seg.text += delta
        this.onTranscript({ ...seg })
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = event.item_id as string
        const transcript = event.transcript as string
        let seg = this.pendingSegments.get(itemId)
        if (!seg) {
          seg = { id: nextId(this.channel), speaker: this.channel, speakerName, speakerColor, text: '', isFinal: false, timestamp: Date.now() }
        }
        seg.text = transcript ?? seg.text
        seg.isFinal = true
        this.onTranscript({ ...seg })
        this.pendingSegments.delete(itemId)
        break
      }
      case 'error': {
        const err = event.error as Record<string, unknown> | undefined
        this.onStatus('error', (err?.message as string) ?? 'Realtime API error')
        break
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= MAX_RETRIES) { this.onStatus('error', `${this.channel}: max retries`); return }
    const delay = BASE_RETRY_MS * Math.pow(2, this.retryCount)
    this.retryCount++
    this.onStatus('connecting', `${this.channel}: reconnecting ${this.retryCount}/${MAX_RETRIES}`)
    this.retryTimeout = setTimeout(() => this.openWebSocket(), delay)
  }

  private send(obj: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj))
  }

  disconnect(): void {
    this.stopped = true
    if (this.retryTimeout) { clearTimeout(this.retryTimeout); this.retryTimeout = null }
    if (this.ws) { this.ws.close(); this.ws = null }
    this.pendingSegments.clear()
  }
}

export class RealtimeTranscriptionService {
  private micChannel: RealtimeChannel | null = null
  private sysChannel: RealtimeChannel | null = null
  private onTranscript: TranscriptCallback
  private onStatus: StatusCallback
  private languages: string[]
  private micConnected = false
  private sysConnected = false

  constructor(onTranscript: TranscriptCallback, onStatus: StatusCallback, languages: string[] = []) {
    this.onTranscript = onTranscript
    this.onStatus = onStatus
    this.languages = languages
  }

  connect(): void {
    this.micConnected = false
    this.sysConnected = false

    this.micChannel = new RealtimeChannel('mic', this.onTranscript, (status) => {
      if (status === 'connected') this.micConnected = true
      this.updateOverallStatus()
    }, this.languages)

    this.sysChannel = new RealtimeChannel('sys', this.onTranscript, (status) => {
      if (status === 'connected') this.sysConnected = true
      this.updateOverallStatus()
    }, this.languages)

    this.onStatus('connecting', 'Opening dual channels...')
    this.micChannel.connect()
    this.sysChannel.connect()
  }

  private updateOverallStatus(): void {
    if (this.micConnected && this.sysConnected) {
      this.onStatus('connected', 'Dual channels active')
    } else if (this.micConnected || this.sysConnected) {
      this.onStatus('connecting', `${this.micConnected ? 'Mic' : 'System'} connected, waiting for other...`)
    }
  }

  appendAudio(buffer: ArrayBuffer, channel: 'mic' | 'sys'): void {
    if (channel === 'mic') {
      this.micChannel?.appendAudio(buffer)
    } else {
      this.sysChannel?.appendAudio(buffer)
    }
  }

  disconnect(): void {
    this.micChannel?.disconnect()
    this.sysChannel?.disconnect()
    this.micChannel = null
    this.sysChannel = null
  }
}
