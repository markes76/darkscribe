// Background Processing Pipeline
// After a call ends, processes the audio recording through Whisper + GPT-4o
// for a higher-quality transcript and summary than the live Realtime API provides.

import { BrowserWindow, ipcMain } from 'electron'
import { transcribeWav, WhisperResult } from './whisper-transcriber'
import { keychainGet } from './keychain'
import { readConfig } from './config'
import {
  saveTranscript, saveSummary, loadTranscript, loadSummary,
  saveMetadata, loadMetadata, updateSession, getSession
} from './session-manager'
import { saveNote, testConnection } from './obsidian-api'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

interface ProcessingJob {
  sessionId: string
  audioFilePath: string
  sessionName?: string
  participants?: string
  status: 'queued' | 'transcribing' | 'summarizing' | 'gemini' | 'complete' | 'failed'
  error?: string
}

const activeJobs = new Map<string, ProcessingJob>()

function getMainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function notifyRenderer(event: string, data: unknown): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(event, data)
  }
}

async function updateProcessingStatus(sessionId: string, status: string, error?: string): Promise<void> {
  const existing = loadMetadata(sessionId) as Record<string, unknown> || {}
  saveMetadata(sessionId, { ...existing, processing_status: status, processing_error: error || undefined })
  notifyRenderer('processing:status-update', { sessionId, status, error })
}

async function generateSummaryFromWhisper(
  whisperResult: WhisperResult,
  sessionName?: string,
  participants?: string,
  skillContent?: string
): Promise<Record<string, unknown>> {
  const apiKey = await keychainGet('openai-api-key')
  if (!apiKey) throw new Error('OpenAI API key not configured')

  const transcript = whisperResult.segments
    .map(s => `[${formatTime(s.start)}] ${s.text}`)
    .join('\n')

  const durationMinutes = Math.round(whisperResult.duration / 60)

  const systemPrompt = `You are an expert call analyst. Analyze the transcript and return a single flat JSON object with ALL of these top-level fields:

"participants": string[] — speaker names identified
"keyTopics": string[] — 3-5 main topics discussed
"actionItems": {"item": string, "owner": string}[] — tasks mentioned
"decisions": string[] — key decisions made
"followUps": string[] — things needing follow-up
"overview": string — 2-3 sentence summary of the call
"sentiment": object with: "overallTone", "emotionalArc", "keyMoments" (array of {topic, sentiment, indicator}), "participantDynamics", "engagementLevel", "topicSentiments" (array of {topic, sentiment, detail}), "concerns" (string[]), "positiveSignals" (string[]), "risksDetected" (string[]), "recommendation"

For sentiment: be specific, cite actual language from the transcript.

CRITICAL LANGUAGE RULE: Write your summary in the SAME LANGUAGE the conversation was conducted in. If the conversation was in English, write everything in English. If it was in Hebrew, write in Hebrew. If it was mixed, use the dominant language. Do NOT translate the transcript or the summary into a different language. The output language must match the input language.
${participants ? `Known participants: ${participants}` : ''}
${skillContent ? `\nFollow these learned preferences:\n${skillContent}` : ''}
Return ONLY the JSON object. All fields at the top level.`

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Summarize this ${durationMinutes}-minute call transcript:\n\n${transcript}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 4096
    })
  })

  if (!resp.ok) throw new Error(`Summary API error: ${resp.status}`)

  const data = await resp.json() as { choices: Array<{ message: { content: string } }> }
  const content = data.choices[0]?.message?.content
  if (!content) throw new Error('Empty summary response')

  const parsed = JSON.parse(content)

  return {
    dateTime: new Date().toISOString(),
    durationMinutes,
    participants: parsed.participants ?? ['You', 'Them'],
    keyTopics: parsed.keyTopics ?? [],
    actionItems: parsed.actionItems ?? [],
    decisions: parsed.decisions ?? [],
    followUps: parsed.followUps ?? [],
    overview: parsed.overview ?? '',
    sentiment: parsed.sentiment ?? {},
    source: 'whisper'  // Mark as generated from Whisper transcript
  }
}

interface GeminiResult {
  transcription: string | null      // Corrected transcript text
  summary: Record<string, unknown> | null  // Structured summary
  voiceInsights: Record<string, unknown> | null  // Sentiment/voice analysis
}

const GEMINI_TRANSCRIPTION_PROMPT = `You are a professional transcription service. You will listen to this audio recording and perform THREE tasks.

TASK 1 — CORRECTED TRANSCRIPTION:
Listen to the entire recording carefully. Produce a complete, accurate transcription of everything that was said.

Rules:
- Transcribe in the EXACT language that was spoken. If the speaker spoke English, transcribe in English. If they spoke Hebrew, transcribe in Hebrew. If they switched between languages, transcribe each segment in the language it was spoken in.
- Do NOT translate anything. Do NOT change the language of what was said.
- Include timestamps at the start of each paragraph or natural speech segment (format: [HH:MM:SS])
- Fix any words that a real-time transcription system might have gotten wrong (proper nouns, technical terms, numbers, acronyms)
- If multiple speakers are detectable, label them (Speaker 1, Speaker 2, etc.)
- If a word is genuinely unclear in the audio, mark it as [inaudible] rather than guessing
- Preserve the speaker's actual words. Do not paraphrase, summarize, or clean up their grammar. You may omit filler words like "um" or "uh" but keep the actual content intact.

TASK 2 — STRUCTURED SUMMARY:
After the transcription, provide a structured summary with:
- Overview (2-3 sentences)
- Key Topics discussed (list)
- Action Items (format: @PersonName: task description, due: date if mentioned)
- Decisions Made (list)
- Follow-ups needed (list)

Write the summary in the SAME LANGUAGE as the conversation. Do not translate.

TASK 3 — VOICE INSIGHTS:
Provide brief voice/sentiment analysis:
- Overall tone
- Energy level
- Speaker dynamics
- Key emotional moments

FORMAT YOUR RESPONSE EXACTLY AS:
---TRANSCRIPTION---
[your corrected transcription here]
---SUMMARY---
[your structured summary here]
---VOICE_INSIGHTS---
[your voice insights here]
---END---`

function parseGeminiResponse(text: string): { transcription: string; summary: string; voiceInsights: string } {
  const txMatch = text.match(/---TRANSCRIPTION---\s*([\s\S]*?)\s*---SUMMARY---/)
  const sumMatch = text.match(/---SUMMARY---\s*([\s\S]*?)\s*---VOICE_INSIGHTS---/)
  const viMatch = text.match(/---VOICE_INSIGHTS---\s*([\s\S]*?)\s*---END---/)

  return {
    transcription: txMatch?.[1]?.trim() || '',
    summary: sumMatch?.[1]?.trim() || '',
    voiceInsights: viMatch?.[1]?.trim() || ''
  }
}

function parseGeminiTranscriptToSegments(text: string): Array<{ id: string; speaker: string; text: string; isFinal: boolean; timestamp: number; startSeconds: number }> {
  if (!text) return []

  const segments: Array<{ id: string; speaker: string; text: string; isFinal: boolean; timestamp: number; startSeconds: number }> = []
  // Split on timestamp markers like [00:01:30] or [HH:MM:SS]
  const parts = text.split(/\[(\d{1,2}:\d{2}:\d{2})\]/)

  let currentTime = 0
  for (let i = 1; i < parts.length; i += 2) {
    const timeStr = parts[i]
    const content = parts[i + 1]?.trim()
    if (!content) continue

    // Parse HH:MM:SS
    const timeParts = timeStr.split(':').map(Number)
    currentTime = (timeParts[0] || 0) * 3600 + (timeParts[1] || 0) * 60 + (timeParts[2] || 0)

    // Detect speaker label (Speaker 1:, Speaker 2:, etc.)
    const speakerMatch = content.match(/^(Speaker\s*\d+)\s*:\s*/)
    const speaker = speakerMatch ? speakerMatch[1] : 'mixed'
    const spokenText = speakerMatch ? content.slice(speakerMatch[0].length).trim() : content

    if (spokenText) {
      segments.push({
        id: `gemini-${i}`,
        speaker,
        text: spokenText,
        isFinal: true,
        timestamp: Date.now() - currentTime * 1000,
        startSeconds: currentTime
      })
    }
  }

  // If no timestamp markers found, treat the whole text as one segment
  if (segments.length === 0 && text.trim()) {
    segments.push({
      id: 'gemini-0',
      speaker: 'mixed',
      text: text.trim(),
      isFinal: true,
      timestamp: Date.now(),
      startSeconds: 0
    })
  }

  return segments
}

// Split a WAV file into chunks of maxDurationSec seconds
// Returns an array of { buffer, offsetSeconds }
function chunkWavFile(filePath: string, maxDurationSec: number = 1800): Array<{ buffer: Buffer; offsetSeconds: number }> {
  const fullBuffer = fs.readFileSync(filePath)

  // Parse WAV header to get sample rate and bit depth
  const sampleRate = fullBuffer.readUInt32LE(24)
  const bitsPerSample = fullBuffer.readUInt16LE(34)
  const numChannels = fullBuffer.readUInt16LE(22)
  const bytesPerSample = (bitsPerSample / 8) * numChannels
  const dataOffset = 44  // Standard WAV header size
  const totalDataBytes = fullBuffer.length - dataOffset
  const totalDuration = totalDataBytes / (sampleRate * bytesPerSample)

  if (totalDuration <= maxDurationSec) {
    return [{ buffer: fullBuffer, offsetSeconds: 0 }]
  }

  const chunks: Array<{ buffer: Buffer; offsetSeconds: number }> = []
  const chunkDataBytes = maxDurationSec * sampleRate * bytesPerSample

  for (let offset = 0; offset < totalDataBytes; offset += chunkDataBytes) {
    const end = Math.min(offset + chunkDataBytes, totalDataBytes)
    const chunkData = fullBuffer.subarray(dataOffset + offset, dataOffset + end)
    const chunkSize = chunkData.length

    // Build a new WAV header for this chunk
    const header = Buffer.alloc(44)
    fullBuffer.copy(header, 0, 0, 44)  // Copy original header
    header.writeUInt32LE(chunkSize + 36, 4)   // RIFF chunk size
    header.writeUInt32LE(chunkSize, 40)        // data chunk size

    chunks.push({
      buffer: Buffer.concat([header, chunkData]),
      offsetSeconds: offset / (sampleRate * bytesPerSample)
    })
  }

  console.log(`[Gemini] Split ${Math.round(totalDuration)}s recording into ${chunks.length} chunks`)
  return chunks
}

async function callGeminiWithAudio(base64Audio: string, geminiKey: string, prompt: string): Promise<string | null> {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'audio/wav', data: base64Audio } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384 }
    })
  })

  if (!resp.ok) {
    console.error('[Gemini] API error:', resp.status, await resp.text().catch(() => ''))
    return null
  }

  const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null
}

async function runGeminiAnalysis(audioFilePath: string): Promise<GeminiResult> {
  const geminiKey = await keychainGet('gemini-api-key')
  if (!geminiKey) return { transcription: null, summary: null, voiceInsights: null }

  try {
    const chunks = chunkWavFile(audioFilePath, 1800)  // 30-minute chunks

    if (chunks.length === 1) {
      // Single chunk — straightforward
      const base64Audio = chunks[0].buffer.toString('base64')
      const responseText = await callGeminiWithAudio(base64Audio, geminiKey, GEMINI_TRANSCRIPTION_PROMPT)
      if (!responseText) return { transcription: null, summary: null, voiceInsights: null }

      const parsed = parseGeminiResponse(responseText)
      return {
        transcription: parsed.transcription || null,
        summary: parsed.summary ? { raw: parsed.summary } : null,
        voiceInsights: parsed.voiceInsights ? { raw: parsed.voiceInsights } : null
      }
    }

    // Multiple chunks — transcribe each, then summarize combined
    console.log(`[Gemini] Processing ${chunks.length} audio chunks...`)
    const allTranscriptions: string[] = []

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      console.log(`[Gemini] Processing chunk ${i + 1}/${chunks.length} (offset: ${Math.round(chunk.offsetSeconds)}s)`)

      const base64Audio = chunk.buffer.toString('base64')
      const chunkPrompt = `You are a professional transcription service. Listen to this audio segment and produce a complete, accurate transcription.

Rules:
- Transcribe in the EXACT language that was spoken. Do NOT translate.
- Include timestamps at the start of each paragraph (format: [HH:MM:SS])
- IMPORTANT: This segment starts at offset ${formatTimeHMS(chunk.offsetSeconds)} in the full recording. Adjust all timestamps accordingly.
- Fix any words that a real-time transcription system might have gotten wrong
- If multiple speakers are detectable, label them (Speaker 1, Speaker 2, etc.)
- If a word is genuinely unclear, mark it as [inaudible]
- Preserve the speaker's actual words. You may omit filler words.

Output ONLY the transcription text with timestamps. No summary or analysis.`

      const chunkResult = await callGeminiWithAudio(base64Audio, geminiKey, chunkPrompt)
      if (chunkResult) allTranscriptions.push(chunkResult.trim())
    }

    const combinedTranscription = allTranscriptions.join('\n\n')

    // Now get summary + voice insights from a final pass with the full transcript
    const summaryPrompt = `Based on this transcription of an audio recording, provide:

TASK 1 — STRUCTURED SUMMARY:
- Overview (2-3 sentences)
- Key Topics discussed (list)
- Action Items (format: @PersonName: task description, due: date if mentioned)
- Decisions Made (list)
- Follow-ups needed (list)

Write the summary in the SAME LANGUAGE as the transcription. Do not translate.

TASK 2 — VOICE INSIGHTS:
- Overall tone
- Energy level
- Speaker dynamics
- Key emotional moments

FORMAT YOUR RESPONSE EXACTLY AS:
---SUMMARY---
[your structured summary here]
---VOICE_INSIGHTS---
[your voice insights here]
---END---

TRANSCRIPTION:
${combinedTranscription.substring(0, 30000)}`

    // Use text-only API call for summary (no audio needed)
    const summaryResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: summaryPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
      })
    })

    let summary: Record<string, unknown> | null = null
    let voiceInsights: Record<string, unknown> | null = null

    if (summaryResp.ok) {
      const sData = await summaryResp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      const sText = sData.candidates?.[0]?.content?.parts?.[0]?.text
      if (sText) {
        const sumMatch = sText.match(/---SUMMARY---\s*([\s\S]*?)\s*---VOICE_INSIGHTS---/)
        const viMatch = sText.match(/---VOICE_INSIGHTS---\s*([\s\S]*?)\s*---END---/)
        if (sumMatch?.[1]) summary = { raw: sumMatch[1].trim() }
        if (viMatch?.[1]) voiceInsights = { raw: viMatch[1].trim() }
      }
    }

    return { transcription: combinedTranscription, summary, voiceInsights }
  } catch (e) {
    console.error('[Gemini] Analysis failed:', (e as Error).message)
    return { transcription: null, summary: null, voiceInsights: null }
  }
}

function formatTimeHMS(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function buildVaultSummaryMarkdown(
  summary: Record<string, unknown>,
  whisperResult: WhisperResult,
  sessionName?: string,
  participants?: string,
  processedWith?: string,
  geminiInsights?: Record<string, unknown> | null,
  geminiRawTranscript?: string | null,
  transcriptVersion?: string
): string {
  const date = new Date().toISOString().split('T')[0]
  const durationMin = Math.round(whisperResult.duration / 60)
  const participantList = participants ? participants.split(',').map(p => p.trim()).filter(Boolean) : (summary.participants as string[] || [])

  const lines: string[] = [
    '---',
    'tags: [call, summary]',
    `date: "${date}"`,
    sessionName ? `title: "${sessionName}"` : '',
    participantList.length ? `participants: [${participantList.map(p => `"${p}"`).join(', ')}]` : 'participants: []',
    `duration: "${durationMin}min"`,
    `recording_status: "available"`,
    `recording_duration: "${durationMin}min"`,
    `transcript_version: "${transcriptVersion || 'final'}"`,
    `processing_status: "completed"`,
    `processed_with: "${processedWith || 'whisper-1 + gpt-4o'}"`,
    `processed_at: "${new Date().toISOString()}"`,
    '---',
    '',
    '## Overview',
    (summary.overview as string) || '',
    ''
  ]

  const keyTopics = summary.keyTopics as string[] | undefined
  if (keyTopics?.length) lines.push('## Key Topics', ...keyTopics.map(t => `- ${t}`), '')

  const actionItems = summary.actionItems as Array<{ item: string; owner?: string }> | undefined
  if (actionItems?.length) lines.push('## Action Items', ...actionItems.map(a => `- [ ] ${a.item}${a.owner ? ` (@${a.owner})` : ''}`), '')

  const decisions = summary.decisions as string[] | undefined
  if (decisions?.length) lines.push('## Decisions', ...decisions.map(d => `- ${d}`), '')

  const followUps = summary.followUps as string[] | undefined
  if (followUps?.length) lines.push('## Follow-ups', ...followUps.map(f => `- ${f}`), '')

  // Sentiment Analysis
  const sentiment = summary.sentiment as Record<string, unknown> | undefined
  if (sentiment?.overallTone) {
    lines.push('## Sentiment Analysis', '')
    lines.push(`**Overall Tone:** ${sentiment.overallTone}`, '')
    if (sentiment.emotionalArc) lines.push(`**Emotional Arc:** ${sentiment.emotionalArc}`, '')
    if (sentiment.participantDynamics) lines.push(`**Participant Dynamics:** ${sentiment.participantDynamics}`, '')
    if (sentiment.engagementLevel) lines.push(`**Engagement:** ${sentiment.engagementLevel}`, '')

    const topicSentiments = sentiment.topicSentiments as Array<{ topic: string; sentiment: string; detail: string }> | undefined
    if (topicSentiments?.length) {
      lines.push('### Sentiment by Topic')
      for (const ts of topicSentiments) lines.push(`- **${ts.topic}** — *${ts.sentiment}*: ${ts.detail}`)
      lines.push('')
    }

    const keyMoments = sentiment.keyMoments as Array<{ topic: string; sentiment: string; indicator: string }> | undefined
    if (keyMoments?.length) {
      lines.push('### Key Moments')
      for (const km of keyMoments) lines.push(`- **${km.topic}** [${km.sentiment}]: ${km.indicator}`)
      lines.push('')
    }

    const positiveSignals = sentiment.positiveSignals as string[] | undefined
    if (positiveSignals?.length) lines.push('### Positive Signals', ...positiveSignals.map(s => `- ${s}`), '')
    const concerns = sentiment.concerns as string[] | undefined
    if (concerns?.length) lines.push('### Concerns Detected', ...concerns.map(c => `- ${c}`), '')
    const risks = sentiment.risksDetected as string[] | undefined
    if (risks?.length) lines.push('### Risks', ...risks.map(r => `- ${r}`), '')
    if (sentiment.recommendation) lines.push(`**Recommendation:** ${sentiment.recommendation}`, '')
  }

  // Voice insights from Gemini
  if (geminiInsights) {
    lines.push('## Voice Insights (Gemini)', '')
    if ((geminiInsights as any).overallTone) lines.push(`**Tone:** ${(geminiInsights as any).overallTone}`, '')
    if ((geminiInsights as any).energyLevel) lines.push(`**Energy:** ${(geminiInsights as any).energyLevel}`, '')
    if ((geminiInsights as any).speakerDynamics) lines.push(`**Dynamics:** ${(geminiInsights as any).speakerDynamics}`, '')
  }

  // Full Transcript — use Gemini corrected version when available, else Whisper
  if (geminiRawTranscript) {
    lines.push('## Full Transcript (Gemini Corrected)', '')
    lines.push(geminiRawTranscript, '')
  } else if (whisperResult.segments.length > 0) {
    lines.push('## Full Transcript', '')
    for (const seg of whisperResult.segments) {
      const time = formatTime(seg.start)
      lines.push(`*(${time})* ${seg.text.trim()}`, '')
    }
  }

  return lines.filter(l => l !== undefined).join('\n')
}

function buildVaultTranscriptMarkdown(
  whisperResult: WhisperResult,
  summary: Record<string, unknown>,
  sessionName?: string,
  participants?: string,
  processedWith?: string
): string {
  const date = new Date().toISOString().split('T')[0]
  const durationMin = Math.round(whisperResult.duration / 60)

  const lines: string[] = [
    '---',
    'tags: [call, transcript]',
    `date: "${date}"`,
    sessionName ? `title: "${sessionName}"` : '',
    `duration: "${durationMin}min"`,
    `transcript_version: "final"`,
    `processed_with: "${processedWith || 'whisper-1'}"`,
    `processed_at: "${new Date().toISOString()}"`,
    '---',
    '',
    '## Transcript',
    ''
  ]

  for (const seg of whisperResult.segments) {
    const time = formatTime(seg.start)
    lines.push(`*(${time})* ${seg.text.trim()}`, '')
  }

  return lines.join('\n')
}

function buildVaultGeminiTranscriptMarkdown(
  geminiRawTranscript: string,
  summary: Record<string, unknown>,
  sessionName?: string,
  participants?: string,
  processedWith?: string
): string {
  const date = new Date().toISOString().split('T')[0]

  const lines: string[] = [
    '---',
    'tags: [call, transcript]',
    `date: "${date}"`,
    sessionName ? `title: "${sessionName}"` : '',
    `transcript_version: "gemini"`,
    `processed_with: "${processedWith || 'gemini-2.0-flash'}"`,
    `processed_at: "${new Date().toISOString()}"`,
    '---',
    '',
    '## Transcript (Gemini Corrected)',
    '',
    geminiRawTranscript,
    ''
  ]

  return lines.filter(l => l !== undefined).join('\n')
}

export async function startBackgroundProcessing(
  sessionId: string,
  audioFilePath: string,
  sessionName?: string,
  participants?: string
): Promise<void> {
  if (activeJobs.has(sessionId)) {
    console.log(`[BgProcessor] Job already active for ${sessionId}`)
    return
  }

  const job: ProcessingJob = {
    sessionId,
    audioFilePath,
    sessionName,
    participants,
    status: 'queued'
  }
  activeJobs.set(sessionId, job)

  // Run asynchronously — don't await
  processSession(job).catch(err => {
    console.error(`[BgProcessor] Fatal error for ${sessionId}:`, err)
    updateProcessingStatus(sessionId, 'partial', (err as Error).message)
    activeJobs.delete(sessionId)
  })
}

async function processSession(job: ProcessingJob): Promise<void> {
  const { sessionId, audioFilePath, sessionName, participants } = job
  console.log(`[BgProcessor] Starting for session ${sessionId}`)

  try {
    // Step 1: Whisper transcription
    job.status = 'transcribing'
    await updateProcessingStatus(sessionId, 'processing')

    const whisperResult = await transcribeWav(audioFilePath, (msg, pct) => {
      console.log(`[BgProcessor:${sessionId}] ${msg} (${pct}%)`)
      notifyRenderer('processing:progress', { sessionId, message: msg, pct })
    })

    // Save final transcript
    const finalSegments = whisperResult.segments.map((s, i) => ({
      id: `whisper-${i}`,
      speaker: 'mixed' as const,
      text: s.text.trim(),
      isFinal: true,
      timestamp: Date.now() - (whisperResult.duration - s.start) * 1000,
      startSeconds: s.start,
      endSeconds: s.end
    }))

    // Save as transcript_final.json (keep transcript.json as the live version)
    const sessDir = path.join(app.getPath('userData'), 'sessions', sessionId)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, 'transcript_final.json'),
      JSON.stringify(finalSegments, null, 2)
    )

    // Step 2: GPT-4o summary from Whisper transcript
    job.status = 'summarizing'
    notifyRenderer('processing:progress', { sessionId, message: 'Generating summary...', pct: 85 })

    // Load skill content if available
    let skillContent = ''
    try {
      const config = readConfig()
      // Skill content loading would need vault access — skip in main process
    } catch {}

    const summary = await generateSummaryFromWhisper(whisperResult, sessionName, participants, skillContent)

    // Save final summary
    fs.writeFileSync(
      path.join(sessDir, 'summary_final.json'),
      JSON.stringify(summary, null, 2)
    )

    // DO NOT overwrite summary.json — that's the live-generated summary.
    // The improved version lives in summary_final.json only.
    // The renderer reads summary_final.json when available.

    // Step 3: Optional Gemini analysis (transcription + summary + voice insights)
    job.status = 'gemini'
    notifyRenderer('processing:progress', { sessionId, message: 'Gemini analysis...', pct: 90 })
    const geminiResult = await runGeminiAnalysis(audioFilePath)

    let geminiInsights: Record<string, unknown> | null = null

    if (geminiResult.transcription) {
      // Save Gemini corrected transcript
      const geminiSegments = parseGeminiTranscriptToSegments(geminiResult.transcription)
      fs.writeFileSync(
        path.join(sessDir, 'transcript_gemini.json'),
        JSON.stringify(geminiSegments, null, 2)
      )
      // Also save raw text version for vault
      fs.writeFileSync(
        path.join(sessDir, 'transcript_gemini_raw.txt'),
        geminiResult.transcription
      )
      console.log(`[BgProcessor] Gemini transcript saved: ${geminiSegments.length} segments`)
    }

    if (geminiResult.voiceInsights) {
      geminiInsights = geminiResult.voiceInsights
      fs.writeFileSync(
        path.join(sessDir, 'gemini_insights.json'),
        JSON.stringify(geminiInsights, null, 2)
      )
    }

    if (geminiResult.summary) {
      // Merge Gemini summary + voice insights into final summary
      const mergedSummary = { ...summary, geminiSummary: geminiResult.summary, voiceInsights: geminiInsights }
      fs.writeFileSync(
        path.join(sessDir, 'summary_final.json'),
        JSON.stringify(mergedSummary, null, 2)
      )
    } else if (geminiInsights) {
      const mergedSummary = { ...summary, voiceInsights: geminiInsights }
      fs.writeFileSync(
        path.join(sessDir, 'summary_final.json'),
        JSON.stringify(mergedSummary, null, 2)
      )
    }

    // Step 4: Sync to Obsidian vault if auto-update enabled
    const config = readConfig()
    if (config.auto_update_vault_after_processing !== false) {
      try {
        const session = getSession(sessionId)
        const lastCall = session?.calls[session.calls.length - 1]
        if (lastCall?.vaultNotePath) {
          const connResult = await testConnection()
          if (connResult.ok) {
            const prefix = config.vault_subfolder || ''
            const vp = (p: string) => prefix ? `${prefix}/${p}` : p

            // Determine best transcript version for vault
            const hasGeminiTranscript = geminiResult.transcription != null
            const processedWith = hasGeminiTranscript
              ? 'whisper-1 + gpt-4o + gemini-2.0-flash'
              : geminiInsights ? 'whisper-1 + gpt-4o + gemini' : 'whisper-1 + gpt-4o'
            const transcriptVersion = hasGeminiTranscript ? 'gemini' : 'whisper'

            // Build vault markdown — use Gemini raw transcript for the full transcript section if available
            const geminiRawText = hasGeminiTranscript ? geminiResult.transcription! : null
            const finalSummary = summary as Record<string, unknown>
            const summaryMd = buildVaultSummaryMarkdown(finalSummary, whisperResult, sessionName, participants, processedWith, geminiInsights, geminiRawText, transcriptVersion)

            // Build improved transcript markdown
            const transcriptMd = hasGeminiTranscript
              ? buildVaultGeminiTranscriptMarkdown(geminiResult.transcription!, finalSummary, sessionName, participants, processedWith)
              : buildVaultTranscriptMarkdown(whisperResult, finalSummary, sessionName, participants, processedWith)

            // Update the vault notes
            const summaryPath = lastCall.vaultNotePath
            await saveNote(summaryPath, summaryMd)

            // Try to update transcript note too (derive path from summary path)
            const txPath = summaryPath.replace('/Summaries/', '/Transcripts/')
            if (txPath !== summaryPath) {
              await saveNote(txPath, transcriptMd).catch(() => {})
            }

            console.log(`[BgProcessor] Vault updated for session ${sessionId}`)
            notifyRenderer('processing:vault-updated', { sessionId, sessionName, vaultNotePath: summaryPath })
          } else {
            console.log(`[BgProcessor] Vault not connected, skipping update for ${sessionId}`)
          }
        }
      } catch (e) {
        console.error(`[BgProcessor] Vault update failed for ${sessionId}:`, (e as Error).message)
        // Don't fail the whole pipeline for vault sync failure
      }
    }

    // Step 5: Mark complete
    job.status = 'complete'
    await updateProcessingStatus(sessionId, 'completed')
    notifyRenderer('processing:complete', { sessionId, sessionName })

    console.log(`[BgProcessor] Completed for session ${sessionId}`)
  } catch (err) {
    console.error(`[BgProcessor] Failed for ${sessionId}:`, (err as Error).message)
    job.status = 'failed'
    job.error = (err as Error).message
    await updateProcessingStatus(sessionId, 'partial', job.error)
    notifyRenderer('processing:failed', { sessionId, error: job.error })
  } finally {
    activeJobs.delete(sessionId)
  }
}

export function getProcessingStatus(sessionId: string): string {
  const job = activeJobs.get(sessionId)
  if (job) return job.status
  const meta = loadMetadata(sessionId) as Record<string, unknown> | null
  return (meta?.processing_status as string) || 'unknown'
}

export function setupBackgroundProcessorIpc(): void {
  ipcMain.handle('processing:start', async (_e, sessionId: string, audioFilePath: string, sessionName?: string, participants?: string) => {
    startBackgroundProcessing(sessionId, audioFilePath, sessionName, participants)
    return { ok: true }
  })

  ipcMain.handle('processing:status', (_e, sessionId: string) => {
    return { status: getProcessingStatus(sessionId) }
  })

  // Load final transcript
  ipcMain.handle('processing:load-final-transcript', (_e, sessionId: string) => {
    const sessDir = path.join(app.getPath('userData'), 'sessions', sessionId)
    const finalPath = path.join(sessDir, 'transcript_final.json')
    if (!fs.existsSync(finalPath)) return null
    try { return JSON.parse(fs.readFileSync(finalPath, 'utf-8')) } catch { return null }
  })

  // Load final summary
  ipcMain.handle('processing:load-final-summary', (_e, sessionId: string) => {
    const sessDir = path.join(app.getPath('userData'), 'sessions', sessionId)
    const finalPath = path.join(sessDir, 'summary_final.json')
    if (!fs.existsSync(finalPath)) return null
    try { return JSON.parse(fs.readFileSync(finalPath, 'utf-8')) } catch { return null }
  })

  // Load Gemini insights
  ipcMain.handle('processing:load-gemini-insights', (_e, sessionId: string) => {
    const sessDir = path.join(app.getPath('userData'), 'sessions', sessionId)
    const geminiPath = path.join(sessDir, 'gemini_insights.json')
    if (!fs.existsSync(geminiPath)) return null
    try { return JSON.parse(fs.readFileSync(geminiPath, 'utf-8')) } catch { return null }
  })

  // Load Gemini transcript
  ipcMain.handle('processing:load-gemini-transcript', (_e, sessionId: string) => {
    const sessDir = path.join(app.getPath('userData'), 'sessions', sessionId)
    const geminiPath = path.join(sessDir, 'transcript_gemini.json')
    if (!fs.existsSync(geminiPath)) return null
    try { return JSON.parse(fs.readFileSync(geminiPath, 'utf-8')) } catch { return null }
  })

  // Load best available transcript (gemini > whisper/final > live)
  ipcMain.handle('processing:load-best-transcript', (_e, sessionId: string) => {
    const sessDir = path.join(app.getPath('userData'), 'sessions', sessionId)

    // Try Gemini first
    const geminiPath = path.join(sessDir, 'transcript_gemini.json')
    if (fs.existsSync(geminiPath)) {
      try { return { data: JSON.parse(fs.readFileSync(geminiPath, 'utf-8')), version: 'gemini' } } catch {}
    }

    // Then Whisper
    const finalPath = path.join(sessDir, 'transcript_final.json')
    if (fs.existsSync(finalPath)) {
      try { return { data: JSON.parse(fs.readFileSync(finalPath, 'utf-8')), version: 'whisper' } } catch {}
    }

    // Then live
    const livePath = path.join(sessDir, 'transcript.json')
    if (fs.existsSync(livePath)) {
      try { return { data: JSON.parse(fs.readFileSync(livePath, 'utf-8')), version: 'live' } } catch {}
    }

    return null
  })
}
