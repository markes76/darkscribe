// Whisper API transcription service
// Sends WAV recordings to OpenAI's /v1/audio/transcriptions for high-quality post-call transcription
// Handles chunking for files > 25MB (Whisper API limit)

import fs from 'fs'
import { keychainGet } from './keychain'

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_FILE_SIZE = 24 * 1024 * 1024 // 24MB safety margin under 25MB limit
const SAMPLE_RATE = 16000 // recording-writer.ts saves at 16kHz
const BYTES_PER_SAMPLE = 2 // Int16
const CHUNK_DURATION_S = 600 // 10 minutes per chunk
const CHUNK_SAMPLES = CHUNK_DURATION_S * SAMPLE_RATE
const CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE

export interface WhisperSegment {
  id: number
  start: number    // seconds
  end: number      // seconds
  text: string
}

export interface WhisperResult {
  text: string
  segments: WhisperSegment[]
  language: string
  duration: number
}

type ProgressCallback = (message: string, pct: number) => void

function createWavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44)
  let pos = 0
  header.write('RIFF', pos); pos += 4
  header.writeUInt32LE(36 + pcmBytes, pos); pos += 4
  header.write('WAVE', pos); pos += 4
  header.write('fmt ', pos); pos += 4
  header.writeUInt32LE(16, pos); pos += 4
  header.writeUInt16LE(1, pos); pos += 2  // PCM
  header.writeUInt16LE(1, pos); pos += 2  // mono
  header.writeUInt32LE(SAMPLE_RATE, pos); pos += 4
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, pos); pos += 4
  header.writeUInt16LE(BYTES_PER_SAMPLE, pos); pos += 2
  header.writeUInt16LE(16, pos); pos += 2
  header.write('data', pos); pos += 4
  header.writeUInt32LE(pcmBytes, pos)
  return header
}

async function transcribeChunk(
  wavBuffer: Buffer,
  apiKey: string,
  chunkIndex: number,
  timeOffset: number
): Promise<WhisperResult> {
  const blob = new Blob([wavBuffer], { type: 'audio/wav' })
  const formData = new FormData()
  formData.append('file', blob, `chunk_${chunkIndex}.wav`)
  formData.append('model', 'whisper-1')
  formData.append('response_format', 'verbose_json')
  formData.append('timestamp_granularities[]', 'segment')
  // NO language parameter — Whisper auto-detects the actual spoken language.
  // Forcing a language here caused the Hebrew translation bug where English
  // meetings were re-transcribed entirely in Hebrew.

  const resp = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Whisper API error ${resp.status}: ${errText.substring(0, 200)}`)
  }

  const data = await resp.json() as {
    text: string
    segments: Array<{ id: number; start: number; end: number; text: string }>
    language: string
    duration: number
  }

  // Offset timestamps by the chunk's position in the full recording
  const segments: WhisperSegment[] = (data.segments || []).map((s, i) => ({
    id: chunkIndex * 10000 + i,
    start: s.start + timeOffset,
    end: s.end + timeOffset,
    text: s.text
  }))

  return {
    text: data.text,
    segments,
    language: data.language || 'auto',
    duration: data.duration || 0
  }
}

export async function transcribeWav(
  filePath: string,
  onProgress?: ProgressCallback
): Promise<WhisperResult> {
  const apiKey = await keychainGet('openai-api-key')
  if (!apiKey) throw new Error('OpenAI API key not configured')

  // DO NOT read preferred_languages here. Whisper must auto-detect the actual
  // spoken language from the audio. The user's language preference is only for
  // the live Realtime API, not for post-call re-transcription.

  if (!fs.existsSync(filePath)) throw new Error(`WAV file not found: ${filePath}`)

  const fileBuffer = fs.readFileSync(filePath)
  const fileSize = fileBuffer.length
  const pcmData = fileBuffer.subarray(44) // Skip WAV header
  const totalSamples = pcmData.length / BYTES_PER_SAMPLE
  const totalDuration = totalSamples / SAMPLE_RATE

  onProgress?.(`Preparing transcription (${(fileSize / 1048576).toFixed(1)} MB, ${Math.round(totalDuration)}s)`, 0)

  // If file is small enough, send it directly
  if (fileSize <= MAX_FILE_SIZE) {
    onProgress?.('Transcribing...', 10)
    const result = await transcribeChunk(fileBuffer, apiKey, 0, 0)
    onProgress?.('Transcription complete', 100)
    return result
  }

  // Split into chunks
  const numChunks = Math.ceil(pcmData.length / CHUNK_BYTES)
  onProgress?.(`Splitting into ${numChunks} chunks for processing`, 5)

  const chunkPromises: Promise<WhisperResult>[] = []
  for (let i = 0; i < numChunks; i++) {
    const startByte = i * CHUNK_BYTES
    const endByte = Math.min(startByte + CHUNK_BYTES, pcmData.length)
    const chunkPcm = pcmData.subarray(startByte, endByte)
    const chunkWav = Buffer.concat([createWavHeader(chunkPcm.length), chunkPcm])
    const timeOffset = (startByte / BYTES_PER_SAMPLE) / SAMPLE_RATE

    chunkPromises.push(
      transcribeChunk(chunkWav, apiKey, i, timeOffset).then(result => {
        const pct = Math.round(10 + (80 * (i + 1) / numChunks))
        onProgress?.(`Analyzed ${i + 1} of ${numChunks} segments`, pct)
        return result
      })
    )
  }

  const results = await Promise.all(chunkPromises)

  // Concatenate results
  const allSegments: WhisperSegment[] = []
  const textParts: string[] = []
  let totalDur = 0

  for (const r of results) {
    allSegments.push(...r.segments)
    textParts.push(r.text)
    totalDur = Math.max(totalDur, r.duration + (r.segments[0]?.start ?? 0))
  }

  // Sort segments by start time (parallel execution may return out of order)
  allSegments.sort((a, b) => a.start - b.start)

  onProgress?.('Transcription complete', 100)

  return {
    text: textParts.join(' '),
    segments: allSegments,
    language: results[0]?.language || 'auto',
    duration: totalDur
  }
}
