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

async function runGeminiAnalysis(audioFilePath: string): Promise<Record<string, unknown> | null> {
  const geminiKey = await keychainGet('gemini-api-key')
  if (!geminiKey) return null

  try {
    // Read audio file and encode as base64
    const audioBuffer = fs.readFileSync(audioFilePath)
    const base64Audio = audioBuffer.toString('base64')

    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: 'audio/wav',
                data: base64Audio
              }
            },
            {
              text: `Analyze this audio recording and return a JSON object with:
- "overallTone": string — overall emotional tone of the conversation
- "energyLevel": string — energy level throughout
- "speakerDynamics": string — who dominated, how they interacted
- "emotionalShifts": array of {timestamp_approx: string, description: string}
- "confidenceIndicators": array of {statement: string, confidence: "high"|"medium"|"low"}
Return ONLY valid JSON.`
            }
          ]
        }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json'
        }
      })
    })

    if (!resp.ok) {
      console.error('[Gemini] API error:', resp.status)
      return null
    }

    const data = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return null

    return JSON.parse(text)
  } catch (e) {
    console.error('[Gemini] Analysis failed:', (e as Error).message)
    return null
  }
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
  geminiInsights?: Record<string, unknown> | null
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
    `transcript_version: "final"`,
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

  // Voice insights from Gemini
  if (geminiInsights) {
    lines.push('## Voice Insights (Gemini)', '')
    if ((geminiInsights as any).overallTone) lines.push(`**Tone:** ${(geminiInsights as any).overallTone}`, '')
    if ((geminiInsights as any).energyLevel) lines.push(`**Energy:** ${(geminiInsights as any).energyLevel}`, '')
    if ((geminiInsights as any).speakerDynamics) lines.push(`**Dynamics:** ${(geminiInsights as any).speakerDynamics}`, '')
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

    // Also update the main summary.json with the improved version
    saveSummary(sessionId, summary)

    // Step 3: Optional Gemini analysis
    job.status = 'gemini'
    const geminiInsights = await runGeminiAnalysis(audioFilePath)
    if (geminiInsights) {
      fs.writeFileSync(
        path.join(sessDir, 'gemini_insights.json'),
        JSON.stringify(geminiInsights, null, 2)
      )
      // Merge voice insights into summary
      const mergedSummary = { ...summary, voiceInsights: geminiInsights }
      saveSummary(sessionId, mergedSummary)
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

            // Build improved summary markdown
            const finalSummary = summary as Record<string, unknown>
            const processedWith = geminiInsights ? 'whisper-1 + gpt-4o + gemini' : 'whisper-1 + gpt-4o'
            const summaryMd = buildVaultSummaryMarkdown(finalSummary, whisperResult, sessionName, participants, processedWith, geminiInsights)

            // Build improved transcript markdown
            const transcriptMd = buildVaultTranscriptMarkdown(whisperResult, finalSummary, sessionName, participants, processedWith)

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
}
