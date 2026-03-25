import React, { useEffect, useState, useCallback } from 'react'
import type { TranscriptSegment } from '../services/openai-realtime'
import { generateSummary, CallSummary } from '../services/summarizer'
import ShareableSummaryModal from './ShareableSummaryModal'
import AudioPlayer from './AudioPlayer'
import type { WebSearchResult } from './SearchPanel/VaultSearchPanel'

function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function buildFilename(dateTime: string, recordingName?: string): string {
  const date = new Date(dateTime)
  const dateStr = date.toISOString().split('T')[0]
  const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-').substring(0, 5)
  if (recordingName) {
    return `${dateStr}_${timeStr}_${sanitizeName(recordingName)}`
  }
  return `${dateStr}_${timeStr}`
}

function filterParticipants(participants: string[]): string[] {
  return participants.filter(p => p !== 'You' && p !== 'Them' && p !== 'Speaker 1' && p !== 'Speaker 2')
}

function buildSummaryMarkdown(sum: CallSummary, segments: TranscriptSegment[] | any[], sessionName?: string, participants?: string, audioFile?: string | null, webSearches?: WebSearchResult[], audioDeleted?: boolean, txVersion?: string): string {
  const realParticipants = filterParticipants(sum.participants)
  const participantList = participants
    ? participants.split(',').map(p => p.trim()).filter(Boolean)
    : realParticipants

  const recordingStatus = audioDeleted ? 'deleted' : audioFile ? 'available' : 'none'
  const durationStr = `${sum.durationMinutes}min`

  const lines: string[] = [
    '---',
    'tags: [call, summary]',
    `date: "${sum.dateTime.split('T')[0]}"`,
    sessionName ? `title: "${sessionName}"` : '',
    participantList.length ? `participants: [${participantList.map(p => `"${p}"`).join(', ')}]` : 'participants: []',
    `duration: "${durationStr}"`,
    `recording_status: "${recordingStatus}"`,
    `recording_duration: "${durationStr}"`,
    txVersion ? `transcript_version: "${txVersion}"` : '',
    '---',
    '',
    '## Overview',
    sum.overview,
    ''
  ]

  if (sum.keyTopics.length) {
    lines.push('## Key Topics', ...sum.keyTopics.map(t => `- ${t}`), '')
  }
  if (sum.actionItems.length) {
    lines.push('## Action Items', ...sum.actionItems.map(a => `- [ ] ${a.item}${a.owner ? ` (@${a.owner})` : ''}`), '')
  }
  if (sum.decisions.length) {
    lines.push('## Decisions', ...sum.decisions.map(d => `- ${d}`), '')
  }
  if (sum.followUps.length) {
    lines.push('## Follow-ups', ...sum.followUps.map(f => `- ${f}`), '')
  }

  // Sentiment Analysis
  if (sum.sentiment?.overallTone) {
    lines.push('## Sentiment Analysis', '')
    lines.push(`**Overall Tone:** ${sum.sentiment.overallTone}`, '')
    if (sum.sentiment.emotionalArc) lines.push(`**Emotional Arc:** ${sum.sentiment.emotionalArc}`, '')
    if (sum.sentiment.participantDynamics) lines.push(`**Participant Dynamics:** ${sum.sentiment.participantDynamics}`, '')
    if (sum.sentiment.engagementLevel) lines.push(`**Engagement:** ${sum.sentiment.engagementLevel}`, '')

    if (sum.sentiment.topicSentiments?.length) {
      lines.push('### Sentiment by Topic')
      for (const ts of sum.sentiment.topicSentiments) {
        lines.push(`- **${ts.topic}** — *${ts.sentiment}*: ${ts.detail}`)
      }
      lines.push('')
    }

    if (sum.sentiment.keyMoments?.length) {
      lines.push('### Key Moments')
      for (const km of sum.sentiment.keyMoments) {
        lines.push(`- **${km.topic}** [${km.sentiment}]: ${km.indicator}`)
      }
      lines.push('')
    }

    if (sum.sentiment.positiveSignals?.length) {
      lines.push('### Positive Signals', ...sum.sentiment.positiveSignals.map(s => `- ${s}`), '')
    }
    if (sum.sentiment.concerns?.length) {
      lines.push('### Concerns Detected', ...sum.sentiment.concerns.map(c => `- ${c}`), '')
    }
    if (sum.sentiment.risksDetected?.length) {
      lines.push('### Risks', ...sum.sentiment.risksDetected.map(r => `- ${r}`), '')
    }
    if (sum.sentiment.recommendation) {
      lines.push(`**Recommendation:** ${sum.sentiment.recommendation}`, '')
    }
  }

  if (webSearches && webSearches.length > 0) {
    lines.push('## Web Searches', '')
    for (const ws of webSearches) {
      lines.push(`### ${ws.title}`)
      if (ws.url) lines.push(`Source: [${ws.url}](${ws.url})`)
      lines.push(`Query: *${ws.query}*`)
      lines.push('', ws.snippet, '')
    }
  }

  // Full transcript embedded in summary note
  const finalSegments = segments.filter((s: any) => (s.isFinal !== false) && s.text?.trim())
  if (finalSegments.length > 0) {
    const versionLabel = txVersion === 'gemini' ? ' (Gemini Corrected)' : txVersion === 'whisper' ? ' (Whisper)' : ''
    lines.push(`## Full Transcript${versionLabel}`, '')
    for (const seg of finalSegments) {
      // Handle both live segments (timestamp) and processed segments (startSeconds)
      let time: string
      if ((seg as any).startSeconds != null) {
        const ss = (seg as any).startSeconds
        time = `${Math.floor(ss / 60)}:${String(Math.floor(ss % 60)).padStart(2, '0')}`
      } else {
        time = new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      }
      const speaker = (seg as any).speakerName ?? ((seg as any).speaker === 'mic' ? 'You' : (seg as any).speaker === 'sys' ? 'Them' : (seg as any).speaker !== 'mixed' && (seg as any).speaker ? (seg as any).speaker : '')
      lines.push(`*(${time})*${speaker ? ` **${speaker}:**` : ''} ${seg.text}`, '')
    }
  }

  return lines.filter(l => l !== undefined).join('\n')
}

function buildTranscriptMarkdown(txSegments: TranscriptSegment[] | any[], sum: CallSummary, sessionName?: string, participants?: string, audioFile?: string | null, txVersion?: string): string {
  const participantList = participants
    ? participants.split(',').map(p => p.trim()).filter(Boolean)
    : filterParticipants(sum.participants)

  const recordingStatus = audioFile ? 'available' : 'none'

  const lines: string[] = [
    '---',
    'tags: [call, transcript]',
    `date: "${sum.dateTime.split('T')[0]}"`,
    sessionName ? `title: "${sessionName}"` : '',
    participantList.length ? `participants: [${participantList.map(p => `"${p}"`).join(', ')}]` : 'participants: []',
    `duration: "${sum.durationMinutes}min"`,
    `recording_status: "${recordingStatus}"`,
    txVersion ? `transcript_version: "${txVersion}"` : '',
    '---',
    '',
    '## Transcript',
    ''
  ]

  for (const seg of txSegments.filter((s: any) => (s.isFinal !== false) && s.text?.trim())) {
    let time: string
    if ((seg as any).startSeconds != null) {
      const ss = (seg as any).startSeconds
      time = `${Math.floor(ss / 60)}:${String(Math.floor(ss % 60)).padStart(2, '0')}`
    } else {
      time = new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }
    const speaker = (seg as any).speakerName ?? ((seg as any).speaker === 'mic' ? 'You' : (seg as any).speaker === 'sys' ? 'Them' : (seg as any).speaker !== 'mixed' && (seg as any).speaker ? (seg as any).speaker : '')
    lines.push(`*(${time})*${speaker ? ` **${speaker}:**` : ''} ${seg.text}`, '')
  }

  return lines.filter(l => l !== undefined).join('\n')
}

interface Props {
  segments: TranscriptSegment[]
  sessionId: string
  sessionName?: string
  participants?: string
  webSearches?: WebSearchResult[]
  audioFile?: string | null
  readOnly?: boolean
  onBack: () => void
  onNewCall: () => void
}

export default function PostCallSummary({ segments, sessionId, sessionName, participants, webSearches = [], audioFile, readOnly = false, onBack, onNewCall }: Props): React.ReactElement {
  const [summary, setSummary] = useState<CallSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [savedToVault, setSavedToVault] = useState(false)
  const [savingToVault, setSavingToVault] = useState(false)
  const [summaryMarkdown, setSummaryMarkdown] = useState('')
  const [showShareable, setShowShareable] = useState(false)
  const [audioDeleted, setAudioDeleted] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [audioFileSize, setAudioFileSize] = useState<string | null>(null)
  const [processingStatus, setProcessingStatus] = useState<string>('idle')
  const [processingMessage, setProcessingMessage] = useState('')
  const [transcriptVersion, setTranscriptVersion] = useState<'live' | 'whisper' | 'gemini'>('live')
  const [finalTranscript, setFinalTranscript] = useState<unknown[] | null>(null)
  const [geminiTranscript, setGeminiTranscript] = useState<unknown[] | null>(null)
  const [voiceInsights, setVoiceInsights] = useState<Record<string, unknown> | null>(null)

  // Listen for background processing events
  useEffect(() => {
    const removeProgress = window.darkscribe.processing.onProgress((data) => {
      if (data.sessionId === sessionId) {
        setProcessingMessage(data.message)
      }
    })
    const removeComplete = window.darkscribe.processing.onComplete(async (data) => {
      if (data.sessionId === sessionId) {
        setProcessingStatus('completed')
        setProcessingMessage('Analysis complete — improved transcript ready')
        // Load all transcript versions
        const ft = await window.darkscribe.processing.loadFinalTranscript(sessionId)
        if (ft) setFinalTranscript(ft)
        const gt = await window.darkscribe.processing.loadGeminiTranscript(sessionId) as unknown[] | null
        if (gt) { setGeminiTranscript(gt); setTranscriptVersion('gemini') }
        else if (ft) { setTranscriptVersion('whisper') }
        // Load summary and insights
        const fs = await window.darkscribe.processing.loadFinalSummary(sessionId) as CallSummary | null
        if (fs) {
          setSummary(fs)
          const md = buildSummaryMarkdown(fs, segments, sessionName, participants, audioFile, webSearches)
          setSummaryMarkdown(md)
        }
        const gi = await window.darkscribe.processing.loadGeminiInsights(sessionId) as Record<string, unknown> | null
        if (gi) setVoiceInsights(gi)
      }
    })
    const removeFailed = window.darkscribe.processing.onFailed((data) => {
      if (data.sessionId === sessionId) {
        setProcessingStatus('partial')
        setProcessingMessage(`Background analysis failed: ${data.error}`)
      }
    })

    // Check if final data already exists (e.g., returning to a completed session)
    ;(async () => {
      const status = await window.darkscribe.processing.status(sessionId)
      if (status.status === 'completed') {
        setProcessingStatus('completed')
        const ft = await window.darkscribe.processing.loadFinalTranscript(sessionId)
        if (ft) setFinalTranscript(ft)
        const gt = await window.darkscribe.processing.loadGeminiTranscript(sessionId) as unknown[] | null
        if (gt) { setGeminiTranscript(gt); setTranscriptVersion('gemini') }
        else if (ft) { setTranscriptVersion('whisper') }
        const gi = await window.darkscribe.processing.loadGeminiInsights(sessionId) as Record<string, unknown> | null
        if (gi) setVoiceInsights(gi)
      } else if (status.status === 'partial') {
        setProcessingStatus('partial')
      }
    })()

    return () => { removeProgress(); removeComplete(); removeFailed() }
  }, [sessionId])

  useEffect(() => {
    ;(async () => {
      try {
        // REVIEW MODE: load from disk, no API call
        if (readOnly) {
          const savedSum = await window.darkscribe.session.loadSummary(sessionId) as CallSummary | null
          if (savedSum) {
            setSummary(savedSum)
            const md = buildSummaryMarkdown(savedSum, segments, sessionName, participants, audioFile, webSearches)
            setSummaryMarkdown(md)
            setSaved(true)
            // Check if already saved to vault
            const session = await window.darkscribe.session.get(sessionId) as any
            const lastCall = session?.calls?.[session.calls.length - 1]
            if (lastCall?.vaultNotePath) {
              setSavedToVault(true)
              setSavedNotePath(lastCall.vaultNotePath)
            }
          } else {
            // Check session status — don't show error for recording/processing sessions
            const meta = await window.darkscribe.session.loadMetadata(sessionId) as any
            if (meta?.status === 'recording') {
              setError('This session is still recording. Return to the live call view.')
            } else if (meta?.processing_status === 'processing') {
              setProcessingStatus('processing')
              setProcessingMessage('Background analysis in progress...')
            } else {
              setError('No saved summary found. The session data may be incomplete.')
            }
          }
          setLoading(false)
          return
        }

        // GENERATE MODE: call OpenAI, then persist
        if (!segments.length) { setLoading(false); setError('No segments.'); return }

        const key = await window.darkscribe.keychain.get('openai-api-key')
        if (!key) { setError('API key not found'); setLoading(false); return }

        const config = await window.darkscribe.config.read()
        const prefix = (config.vault_subfolder as string) || ''
        const vp = (p: string) => prefix ? `${prefix}/${p}` : p

        let skillContent: string | undefined
        try {
          const skillResult = await window.darkscribe.vault.readNote(vp('System/Notetaker Skill.md'))
          if (skillResult.content) skillContent = skillResult.content
        } catch {}

        // Load references if attached to this session
        let refs: Array<{ title: string; content?: string }> = []
        try {
          const savedRefs = await window.darkscribe.session.loadReferences(sessionId) as any[] | null
          if (savedRefs?.length) {
            refs = savedRefs.map(r => ({ title: r.title, content: r.content }))
          }
        } catch {}

        const sum = await generateSummary(segments, key, skillContent, refs.length > 0 ? refs : undefined)
        setSummary(sum)

        const md = buildSummaryMarkdown(sum, segments, sessionName, participants, audioFile, webSearches)
        setSummaryMarkdown(md)

        // Persist summary + transcript + metadata to disk
        await window.darkscribe.session.saveSummary(sessionId, sum).catch(() => {})
        await window.darkscribe.session.saveTranscript(sessionId, segments).catch(() => {})
        if (webSearches.length > 0) {
          await window.darkscribe.session.saveWebSearches(sessionId, webSearches).catch(() => {})
        }
        await window.darkscribe.session.saveMetadata(sessionId, { status: 'summarized', participants: sessionName }).catch(() => {})

        // Save call record
        await window.darkscribe.session.addCall(sessionId, {
          date: sum.dateTime,
          durationMinutes: sum.durationMinutes,
          segmentCount: segments.filter(s => s.isFinal).length,
          audioFile: audioFile ?? undefined,
          tags: sum.keyTopics.slice(0, 3),
          status: 'summarized'
        })
        setSaved(true)

        // Start background processing for higher-quality Whisper transcript + summary
        if (audioFile) {
          setProcessingStatus('processing')
          setProcessingMessage('Starting background analysis...')
          window.darkscribe.processing.start(sessionId, audioFile, sessionName, participants).catch(() => {})
        }

        // Auto-save to vault if enabled
        if (config.auto_save_to_vault) {
          try {
            const vaultStatus = await window.darkscribe.vault.status()
            if (vaultStatus.connected) {
              const baseName = buildFilename(sum.dateTime, sessionName)
              const notePath = vp(`Calls/Summaries/${baseName}.md`)
              const saveResult = await window.darkscribe.vault.saveNote(notePath, md)
              if (saveResult.ok !== false) {
                // Save transcript too
                const txPath = vp(`Calls/Transcripts/${baseName}.md`)
                const txContent = buildTranscriptMarkdown(segments, sum, sessionName, participants, audioFile)
                await window.darkscribe.vault.saveNote(txPath, txContent).catch(() => {})

                // Update call record with vault path
                const sess = await window.darkscribe.session.get(sessionId) as any
                if (sess) {
                  const ci = sess.calls.length - 1
                  if (ci >= 0) {
                    await window.darkscribe.session.updateCall(sessionId, ci, {
                      vaultNotePath: notePath,
                      originalSummary: md,
                      status: 'complete'
                    })
                  }
                }
                await window.darkscribe.session.saveMetadata(sessionId, { status: 'complete' }).catch(() => {})
                setSavedToVault(true)
                setSavedNotePath(notePath)
                console.log('[AutoSave] Saved to vault:', notePath)
              }
            } else {
              console.log('[AutoSave] Vault not connected, skipping auto-save')
            }
          } catch (autoErr) {
            console.error('[AutoSave] Failed:', (autoErr as Error).message)
          }
        }
      } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
    })()
  }, [segments, sessionId, audioFile, readOnly])

  const [vaultError, setVaultError] = useState('')
  const [savedNotePath, setSavedNotePath] = useState('')

  const openInObsidian = async (filePath: string) => {
    const config = await window.darkscribe.config.read()
    const vaultName = encodeURIComponent((config.obsidian_vault_name as string) || 'MyVault')
    const encodedPath = encodeURIComponent(filePath)
    await window.darkscribe.shell.openUrl(`obsidian://open?vault=${vaultName}&file=${encodedPath}`)
  }

  const saveToVault = async () => {
    if (!summary || savingToVault) return
    setSavingToVault(true)
    setVaultError('')
    try {
      // Check vault connection first
      const status = await window.darkscribe.vault.status()
      if (!status.connected) {
        // Try to reconnect
        const config = await window.darkscribe.config.read()
        const vaultRoot = config.vault_path as string
        if (vaultRoot) {
          const conn = await window.darkscribe.vault.connect(vaultRoot)
          if (!conn.ok) throw new Error(`Vault not connected: ${conn.error}`)
        } else {
          throw new Error('No vault configured. Go to Settings to set up your vault.')
        }
      }

      // Get vault subfolder prefix
      const config = await window.darkscribe.config.read()
      const prefix = (config.vault_subfolder as string) || ''
      const vp = (p: string) => prefix ? `${prefix}/${p}` : p

      const baseName = buildFilename(summary.dateTime, sessionName)
      const notePath = vp(`Calls/Summaries/${baseName}.md`)

      // Determine which transcript segments to save based on user's selected version
      let saveSegments: any[] = segments
      let saveTxVersion = transcriptVersion
      if (transcriptVersion === 'gemini' && geminiTranscript) {
        saveSegments = geminiTranscript as any[]
      } else if (transcriptVersion === 'whisper' && finalTranscript) {
        saveSegments = finalTranscript as any[]
      } else {
        saveSegments = segments
        saveTxVersion = 'live'
      }

      // Build markdown with the selected transcript version
      const vaultSummaryMd = buildSummaryMarkdown(summary, saveSegments, sessionName, participants, audioFile, webSearches, false, saveTxVersion)

      const saveResult = await window.darkscribe.vault.saveNote(notePath, vaultSummaryMd)
      if (!saveResult.ok) throw new Error(saveResult.error ?? 'Save failed')

      // Store vaultNotePath and originalSummary in session
      const session = await window.darkscribe.session.get(sessionId) as any
      if (session) {
        const callIdx = session.calls.length - 1
        if (callIdx >= 0) {
          await window.darkscribe.session.updateCall(sessionId, callIdx, {
            vaultNotePath: notePath,
            originalSummary: vaultSummaryMd
          })
        }
      }

      // Also save transcript note with same version
      const txPath = vp(`Calls/Transcripts/${baseName}.md`)
      const txContent = buildTranscriptMarkdown(saveSegments, summary, sessionName, participants, audioFile, saveTxVersion)
      await window.darkscribe.vault.saveNote(txPath, txContent)

      // Save individual web search references
      for (const ws of webSearches) {
        const date = summary.dateTime.split('T')[0]
        const safeQuery = ws.query.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').substring(0, 60)
        const refPath = vp(`Resources/References/${date}_${safeQuery}.md`)
        const refContent = `---\ntags: [reference, web-search]\ndate: "${date}"\nsource_url: "${ws.url}"\nquery: "${ws.query}"\nsession: "${baseName}"\n---\n\n# ${ws.title}\n\nSource: [${ws.url}](${ws.url})\n\n## Content\n\n${ws.snippet}\n`
        await window.darkscribe.vault.saveNote(refPath, refContent).catch(() => {})
      }

      setSavedToVault(true)
      setSavedNotePath(notePath)
    } catch (e) {
      const msg = (e as Error).message
      console.error('Save to vault failed:', msg)
      setVaultError(msg)
    }
    setSavingToVault(false)
  }

  if (loading) {
    return (
      <div className="page-enter" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          border: '2px solid var(--accent)', borderTopColor: 'transparent',
          animation: 'spin 0.8s linear infinite'
        }} />
        <div style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>Generating summary...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page-enter" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={{ color: 'var(--negative)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>Error: {error}</div>
        <button onClick={onBack} style={{
          padding: '10px 24px', background: 'var(--accent)', color: 'var(--accent-ink)',
          border: 'none', borderRadius: 'var(--radius-lg)', fontWeight: 700, cursor: 'pointer'
        }}>Back</button>
      </div>
    )
  }

  return (
    <div className="page-enter" style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-8) var(--sp-6)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'var(--sp-8)' }}>
          <div>
            <h2 style={{
              fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)',
              fontWeight: 800, color: 'var(--ink-1)', letterSpacing: '-0.03em'
            }}>
              Call Summary
            </h2>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', marginTop: 6, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
              {sessionName && <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{sessionName} · </span>}
              {summary?.durationMinutes}min · {summary?.participants.join(', ')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <button
              onClick={saveToVault}
              disabled={savingToVault || savedToVault}
              style={{
                padding: '8px 18px',
                background: savedToVault ? 'var(--positive-subtle)' : 'var(--accent)',
                color: savedToVault ? 'var(--positive)' : 'var(--accent-ink)',
                border: savedToVault ? '1px solid rgba(92,181,131,0.2)' : 'none',
                borderRadius: 'var(--radius-lg)', fontSize: 'var(--text-sm)', fontWeight: 700,
                cursor: savedToVault ? 'default' : 'pointer',
                opacity: savingToVault ? 0.6 : 1,
                boxShadow: savedToVault ? 'none' : 'var(--shadow-glow-amber)'
              }}
            >
              {savedToVault ? 'Saved' : savingToVault ? 'Saving...' : 'Save to Vault'}
            </button>
            {savedToVault && savedNotePath && (
              <button
                onClick={() => openInObsidian(savedNotePath)}
                style={{
                  padding: '8px 18px', background: 'var(--surface-3)', color: 'var(--purple)',
                  border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)',
                  fontSize: 'var(--text-sm)', cursor: 'pointer', fontWeight: 600
                }}
              >
                Open in Obsidian
              </button>
            )}
            {savedToVault && (
              <button
                onClick={async () => {
                  // Re-save to vault with the currently selected transcript version
                  setSavedToVault(false)
                  await saveToVault()
                }}
                style={{
                  padding: '8px 18px', background: 'var(--positive-subtle)', color: 'var(--positive)',
                  border: '1px solid rgba(92,181,131,0.2)', borderRadius: 'var(--radius-lg)',
                  fontSize: 'var(--text-sm)', cursor: 'pointer', fontWeight: 600
                }}
              >
                Update Obsidian ({transcriptVersion === 'gemini' ? 'Gemini' : transcriptVersion === 'whisper' ? 'Whisper' : 'Live'})
              </button>
            )}
            <button onClick={() => setShowShareable(true)} style={{
              padding: '8px 18px', background: 'var(--surface-3)', color: 'var(--ink-2)',
              border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)',
              fontSize: 'var(--text-sm)', cursor: 'pointer', fontWeight: 500
            }}>
              Shareable Summary
            </button>
            <button onClick={onBack} style={{
              padding: '8px 18px', background: 'var(--surface-3)', color: 'var(--ink-3)',
              border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)',
              fontSize: 'var(--text-sm)', cursor: 'pointer', fontWeight: 500
            }}>
              Done
            </button>
            <button onClick={onNewCall} style={{
              padding: '8px 18px', background: 'var(--accent)', color: 'var(--accent-ink)',
              border: 'none', borderRadius: 'var(--radius-lg)',
              fontSize: 'var(--text-sm)', fontWeight: 700, cursor: 'pointer',
              boxShadow: 'var(--shadow-glow-amber)'
            }}>
              New Call
            </button>
          </div>
        </div>

        {saved && (
          <div style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--positive-subtle)', border: '1px solid var(--positive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--positive)', marginBottom: 'var(--sp-4)' }}>
            Session saved{savedNotePath && (
              <span style={{ color: 'var(--ink-4)', marginLeft: 8 }}>
                {savedNotePath}
              </span>
            )}
          </div>
        )}

        {vaultError && (
          <div style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--negative-subtle)', border: '1px solid var(--negative)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--negative)', marginBottom: 'var(--sp-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Save failed: {vaultError}</span>
            <button onClick={saveToVault} style={{ padding: '2px 10px', background: 'var(--negative)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', cursor: 'pointer', marginLeft: 8 }}>Retry</button>
          </div>
        )}

        {/* Processing Status */}
        {processingStatus === 'processing' && (
          <div style={{
            padding: 'var(--sp-3) var(--sp-4)', background: 'var(--accent-subtle)',
            border: '1px solid rgba(212,175,55,0.2)', borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--sp-4)', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)'
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)',
              animation: 'breathe 2s infinite', flexShrink: 0
            }} />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', fontWeight: 500 }}>
              {processingMessage || 'Analyzing recording for improved transcript...'}
            </span>
          </div>
        )}
        {processingStatus === 'completed' && (
          <div style={{
            padding: 'var(--sp-2) var(--sp-4)', background: 'var(--positive-subtle)',
            border: '1px solid rgba(92,181,131,0.2)', borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--sp-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between'
          }}>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--positive)', fontWeight: 600 }}>
              Improved transcript and summary available
            </span>
          </div>
        )}
        {processingStatus === 'partial' && (
          <div style={{
            padding: 'var(--sp-2) var(--sp-4)', background: 'var(--warning-subtle)',
            border: '1px solid rgba(212,175,55,0.2)', borderRadius: 'var(--radius-md)',
            marginBottom: 'var(--sp-4)', fontSize: 'var(--text-xs)', color: 'var(--warning)', fontWeight: 500
          }}>
            {processingMessage || 'Background analysis incomplete — showing live transcript only'}
          </div>
        )}

        {/* Audio Player */}
        {audioFile && (
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <AudioPlayer filePath={audioDeleted ? null : audioFile} deleted={audioDeleted} />
            {!audioDeleted && !showDeleteConfirm && (
              <button
                onClick={async () => {
                  const stat = await window.darkscribe.file.stat(audioFile)
                  if (stat.exists && stat.size) {
                    setAudioFileSize(`${(stat.size / 1048576).toFixed(1)} MB`)
                  }
                  setShowDeleteConfirm(true)
                }}
                style={{
                  marginTop: 'var(--sp-2)', padding: '4px 12px',
                  background: 'none', border: '1px solid var(--border-1)',
                  borderRadius: 'var(--radius-full)', fontSize: 10,
                  color: 'var(--ink-4)', cursor: 'pointer', fontWeight: 500
                }}
              >
                Delete Recording
              </button>
            )}
            {showDeleteConfirm && (
              <div style={{
                marginTop: 'var(--sp-2)', padding: 'var(--sp-3)',
                background: 'var(--negative-subtle)', border: '1px solid var(--negative)',
                borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)'
              }}>
                <div style={{ color: 'var(--ink-1)', marginBottom: 'var(--sp-2)' }}>
                  Delete the audio recording? The transcript and summary will be kept.
                  {audioFileSize && <span style={{ color: 'var(--ink-3)' }}> This frees up {audioFileSize} of disk space.</span>}
                  <strong> This cannot be undone.</strong>
                </div>
                <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                  <button
                    onClick={async () => {
                      await window.darkscribe.recording.delete(audioFile)
                      await window.darkscribe.session.saveMetadata(sessionId, {
                        recording_deleted: true,
                        recording_deleted_at: new Date().toISOString()
                      })
                      setAudioDeleted(true)
                      setShowDeleteConfirm(false)
                    }}
                    style={{
                      padding: '4px 14px', background: 'var(--negative)',
                      color: 'white', border: 'none', borderRadius: 'var(--radius-md)',
                      fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer'
                    }}
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    style={{
                      padding: '4px 14px', background: 'var(--surface-3)',
                      color: 'var(--ink-3)', border: '1px solid var(--border-1)',
                      borderRadius: 'var(--radius-md)', fontSize: 'var(--text-xs)',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Overview */}
        {summary?.overview && (
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--sp-4)' }}>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)', marginBottom: 'var(--sp-2)' }}>Overview</h3>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.6 }}>{summary.overview}</p>
          </div>
        )}

        {/* Key Topics */}
        {summary?.keyTopics.length ? (
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--sp-4)' }}>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)', marginBottom: 'var(--sp-2)' }}>Key Topics</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
              {summary.keyTopics.map((topic, i) => (
                <span key={i} style={{ padding: '2px 10px', background: 'var(--primary-subtle)', color: 'var(--accent)', borderRadius: 'var(--radius-full)', fontSize: 'var(--text-xs)', fontWeight: 600 }}>{topic}</span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Action Items */}
        {summary?.actionItems.length ? (
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--sp-4)' }}>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)', marginBottom: 'var(--sp-2)' }}>Action Items</h3>
            {summary.actionItems.map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 'var(--sp-2)', marginBottom: 'var(--sp-1)', fontSize: 'var(--text-sm)', color: 'var(--ink-1)' }}>
                <span style={{ color: 'var(--accent)', fontWeight: 700 }}>-</span>
                <span>{item.item}{item.owner ? ` (${item.owner})` : ''}</span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Decisions */}
        {summary?.decisions.length ? (
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--sp-4)' }}>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)', marginBottom: 'var(--sp-2)' }}>Decisions</h3>
            {summary.decisions.map((d, i) => (
              <div key={i} style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', marginBottom: 'var(--sp-1)' }}>- {d}</div>
            ))}
          </div>
        ) : null}

        {/* Follow-ups */}
        {summary?.followUps.length ? (
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--sp-4)' }}>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)', marginBottom: 'var(--sp-2)' }}>Follow-ups</h3>
            {summary.followUps.map((f, i) => (
              <div key={i} style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', marginBottom: 'var(--sp-1)' }}>- {f}</div>
            ))}
          </div>
        ) : null}

        {/* Sentiment Analysis */}
        {summary?.sentiment?.overallTone && (
          <details style={{ marginTop: 'var(--sp-4)' }}>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-2)', padding: 'var(--sp-2) 0' }}>
              Sentiment Analysis
            </summary>
            <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginTop: 'var(--sp-2)' }}>
              <div style={{ marginBottom: 'var(--sp-3)' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', marginBottom: 4 }}>Overall Tone</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.6 }}>{summary.sentiment.overallTone}</div>
              </div>
              {summary.sentiment.emotionalArc && (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', marginBottom: 4 }}>Emotional Arc</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.6 }}>{summary.sentiment.emotionalArc}</div>
                </div>
              )}
              {summary.sentiment.participantDynamics && (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', marginBottom: 4 }}>Participant Dynamics</div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', lineHeight: 1.6 }}>{summary.sentiment.participantDynamics}</div>
                </div>
              )}
              {summary.sentiment.topicSentiments?.length ? (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', marginBottom: 'var(--sp-2)' }}>By Topic</div>
                  {summary.sentiment.topicSentiments.map((ts, i) => (
                    <div key={i} style={{ padding: 'var(--sp-2)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', marginBottom: 'var(--sp-1)', fontSize: 'var(--text-xs)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink-1)' }}>{ts.topic}</span>
                      <span style={{ color: 'var(--ink-3)', margin: '0 6px' }}>—</span>
                      <span style={{ fontStyle: 'italic', color: ts.sentiment?.includes('positive') ? 'var(--positive)' : ts.sentiment?.includes('negative') || ts.sentiment?.includes('tense') ? 'var(--negative)' : 'var(--ink-2)' }}>{ts.sentiment}</span>
                      <div style={{ color: 'var(--ink-2)', marginTop: 2 }}>{ts.detail}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {summary.sentiment.keyMoments?.length ? (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', marginBottom: 'var(--sp-2)' }}>Key Moments</div>
                  {summary.sentiment.keyMoments.map((km, i) => (
                    <div key={i} style={{ padding: 'var(--sp-2)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', marginBottom: 'var(--sp-1)', fontSize: 'var(--text-xs)' }}>
                      <span style={{ fontWeight: 600, color: 'var(--ink-1)' }}>{km.topic}</span>
                      <span style={{ padding: '1px 6px', marginLeft: 6, background: km.sentiment === 'very positive' || km.sentiment === 'positive' ? 'var(--positive-subtle)' : km.sentiment === 'negative' || km.sentiment === 'tense' ? 'var(--negative-subtle)' : 'var(--surface-3)', borderRadius: 'var(--radius-xs)', fontSize: 9, fontWeight: 600, color: km.sentiment === 'very positive' || km.sentiment === 'positive' ? 'var(--positive)' : km.sentiment === 'negative' || km.sentiment === 'tense' ? 'var(--negative)' : 'var(--ink-3)' }}>{km.sentiment}</span>
                      <div style={{ color: 'var(--ink-2)', marginTop: 2, fontStyle: 'italic' }}>{km.indicator}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {summary.sentiment.positiveSignals?.length ? (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--positive)', marginBottom: 4 }}>Positive Signals</div>
                  {summary.sentiment.positiveSignals.map((s, i) => <div key={i} style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', marginBottom: 2 }}>+ {s}</div>)}
                </div>
              ) : null}
              {summary.sentiment.risksDetected?.length ? (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--negative)', marginBottom: 4 }}>Risks Detected</div>
                  {summary.sentiment.risksDetected.map((r, i) => <div key={i} style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', marginBottom: 2 }}>! {r}</div>)}
                </div>
              ) : null}
              {summary.sentiment.concerns?.length ? (
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--warning)', marginBottom: 4 }}>Concerns</div>
                  {summary.sentiment.concerns.map((c, i) => <div key={i} style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', marginBottom: 2 }}>? {c}</div>)}
                </div>
              ) : null}
              {summary.sentiment.recommendation && (
                <div style={{ padding: 'var(--sp-3)', background: 'var(--primary-subtle)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--ink-1)' }}>
                  <span style={{ fontWeight: 700, color: 'var(--accent)' }}>Recommendation: </span>
                  {summary.sentiment.recommendation}
                </div>
              )}
            </div>
          </details>
        )}

        {/* Web Searches added during call */}
        {webSearches.length > 0 && (
          <div style={{ marginTop: 'var(--sp-4)', padding: 'var(--sp-4)', background: 'var(--surface-raised)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--ink-1)', marginBottom: 'var(--sp-3)' }}>
              Web Searches ({webSearches.length})
            </div>
            {webSearches.map((ws, i) => (
              <div key={i} style={{ marginBottom: 'var(--sp-3)', padding: 'var(--sp-3)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-1)' }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-1)', marginBottom: 2 }}>{ws.title}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', marginBottom: 4 }}>Query: {ws.query}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.5 }}>{ws.snippet.substring(0, 200)}{ws.snippet.length > 200 ? '...' : ''}</div>
                {ws.url && (
                  <button onClick={() => window.darkscribe.shell.openUrl(ws.url)} style={{ marginTop: 4, padding: 0, background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--text-xs)', cursor: 'pointer', textDecoration: 'underline' }}>
                    Open source
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Voice Insights (Gemini) */}
        {voiceInsights && (
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', marginBottom: 'var(--sp-4)' }}>
            <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--purple)', marginBottom: 'var(--sp-2)' }}>Voice Insights</h3>
            {(voiceInsights as any).overallTone && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.6, marginBottom: 4 }}>
                <strong>Tone:</strong> {(voiceInsights as any).overallTone}
              </p>
            )}
            {(voiceInsights as any).energyLevel && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.6, marginBottom: 4 }}>
                <strong>Energy:</strong> {(voiceInsights as any).energyLevel}
              </p>
            )}
            {(voiceInsights as any).speakerDynamics && (
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
                <strong>Dynamics:</strong> {(voiceInsights as any).speakerDynamics}
              </p>
            )}
          </div>
        )}

        {/* Transcript Toggle */}
        <details style={{ marginTop: 'var(--sp-4)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-2)', padding: 'var(--sp-2) 0', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
            <span>View Full Transcript ({segments.filter(s => s.isFinal).length} segments)</span>
          </summary>

          {/* Version selector */}
          {(finalTranscript || geminiTranscript) && (
            <div style={{ display: 'flex', gap: 'var(--sp-1)', marginTop: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
              {geminiTranscript && (
                <button
                  onClick={() => setTranscriptVersion('gemini')}
                  style={{
                    padding: '3px 10px',
                    background: transcriptVersion === 'gemini' ? 'var(--accent)' : 'var(--surface-3)',
                    border: `1px solid ${transcriptVersion === 'gemini' ? 'var(--accent)' : 'var(--border-1)'}`,
                    borderRadius: 'var(--radius-full)', fontSize: 9, fontWeight: 700,
                    color: transcriptVersion === 'gemini' ? 'var(--accent-ink)' : 'var(--ink-4)',
                    cursor: 'pointer', letterSpacing: '0.04em'
                  }}
                >
                  GEMINI (BEST)
                </button>
              )}
              {finalTranscript && (
                <button
                  onClick={() => setTranscriptVersion('whisper')}
                  style={{
                    padding: '3px 10px',
                    background: transcriptVersion === 'whisper' ? 'var(--positive-subtle)' : 'var(--surface-3)',
                    border: `1px solid ${transcriptVersion === 'whisper' ? 'rgba(92,181,131,0.2)' : 'var(--border-1)'}`,
                    borderRadius: 'var(--radius-full)', fontSize: 9, fontWeight: 700,
                    color: transcriptVersion === 'whisper' ? 'var(--positive)' : 'var(--ink-4)',
                    cursor: 'pointer', letterSpacing: '0.04em'
                  }}
                >
                  WHISPER
                </button>
              )}
              <button
                onClick={() => setTranscriptVersion('live')}
                style={{
                  padding: '3px 10px',
                  background: transcriptVersion === 'live' ? 'var(--surface-4)' : 'var(--surface-3)',
                  border: `1px solid ${transcriptVersion === 'live' ? 'var(--ink-4)' : 'var(--border-1)'}`,
                  borderRadius: 'var(--radius-full)', fontSize: 9, fontWeight: 700,
                  color: transcriptVersion === 'live' ? 'var(--ink-2)' : 'var(--ink-4)',
                  cursor: 'pointer', letterSpacing: '0.04em'
                }}
              >
                LIVE (ORIGINAL)
              </button>
            </div>
          )}

          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', marginTop: 'var(--sp-2)', maxHeight: 400, overflow: 'auto' }}>
            {transcriptVersion === 'gemini' && geminiTranscript ? (
              (geminiTranscript as any[]).map((seg: any, i: number) => (
                <div key={seg.id || i} style={{ marginBottom: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                  {seg.startSeconds != null && (
                    <span style={{ color: 'var(--accent)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', marginRight: 8 }}>
                      {Math.floor(seg.startSeconds / 60)}:{String(Math.floor(seg.startSeconds % 60)).padStart(2, '0')}
                    </span>
                  )}
                  {seg.speaker && seg.speaker !== 'mixed' && (
                    <span style={{ color: 'var(--purple)', fontSize: 'var(--text-xs)', fontWeight: 600, marginRight: 6 }}>{seg.speaker}:</span>
                  )}
                  <span style={{ color: 'var(--ink-1)' }}>{seg.text}</span>
                </div>
              ))
            ) : transcriptVersion === 'whisper' && finalTranscript ? (
              (finalTranscript as any[]).map((seg: any, i: number) => (
                <div key={seg.id || i} style={{ marginBottom: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                  {seg.startSeconds != null && (
                    <span style={{ color: 'var(--ink-4)', fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', marginRight: 8 }}>
                      {Math.floor(seg.startSeconds / 60)}:{String(Math.floor(seg.startSeconds % 60)).padStart(2, '0')}
                    </span>
                  )}
                  <span style={{ color: 'var(--ink-1)' }}>{seg.text}</span>
                </div>
              ))
            ) : (
              segments.filter(s => s.isFinal && s.text.trim()).map(seg => {
                const time = new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                return (
                  <div key={seg.id} style={{ marginBottom: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                    <span style={{ color: 'var(--ink-4)', fontSize: 'var(--text-xs)', marginRight: 8 }}>{time}</span>
                    <span style={{ color: 'var(--ink-1)' }}>{seg.text}</span>
                  </div>
                )
              })
            )}
          </div>
        </details>
      </div>

      {showShareable && summary && (
        <ShareableSummaryModal
          segments={segments}
          summary={summary}
          sessionId={sessionId}
          sessionName={sessionName}
          onClose={() => setShowShareable(false)}
        />
      )}
    </div>
  )
}
