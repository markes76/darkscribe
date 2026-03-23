import React, { useEffect, useState } from 'react'
import type { TranscriptSegment } from '../services/openai-realtime'
import { generateSummary, CallSummary } from '../services/summarizer'
import ShareableSummaryModal from './ShareableSummaryModal'

function buildSummaryMarkdown(sum: CallSummary, segments: TranscriptSegment[], sessionName?: string, audioFile?: string | null): string {
  const lines: string[] = [
    '---',
    'tags: [call, summary]',
    `date: "${sum.dateTime.split('T')[0]}"`,
    `contact: "${sessionName ?? ''}"`,
    `duration: "${sum.durationMinutes}min"`,
    `participants: [${sum.participants.map(p => `"${p}"`).join(', ')}]`,
    audioFile ? `recording_path: "${audioFile}"` : '',
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

  return lines.filter(l => l !== undefined).join('\n')
}

function buildTranscriptMarkdown(segments: TranscriptSegment[], sum: CallSummary, sessionName?: string, audioFile?: string | null): string {
  const lines: string[] = [
    '---',
    'tags: [call, transcript]',
    `date: "${sum.dateTime.split('T')[0]}"`,
    `contact: "${sessionName ?? ''}"`,
    `duration: "${sum.durationMinutes}min"`,
    audioFile ? `recording_path: "${audioFile}"` : '',
    '---',
    '',
    '## Transcript',
    ''
  ]

  for (const seg of segments.filter(s => s.isFinal && s.text.trim())) {
    const speaker = seg.speakerName ?? (seg.speaker === 'mic' ? 'You' : 'Them')
    const time = new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    lines.push(`**[${speaker}]** *(${time})* ${seg.text}`, '')
  }

  return lines.filter(l => l !== undefined).join('\n')
}

interface Props {
  segments: TranscriptSegment[]
  sessionId: string
  sessionName?: string
  audioFile?: string | null
  onBack: () => void
  onNewCall: () => void
}

export default function PostCallSummary({ segments, sessionId, sessionName, audioFile, onBack, onNewCall }: Props): React.ReactElement {
  const [summary, setSummary] = useState<CallSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [savedToVault, setSavedToVault] = useState(false)
  const [savingToVault, setSavingToVault] = useState(false)
  const [summaryMarkdown, setSummaryMarkdown] = useState('')
  const [showShareable, setShowShareable] = useState(false)

  useEffect(() => {
    if (!segments.length) { setLoading(false); setError('No segments.'); return }
    ;(async () => {
      try {
        const key = await window.darkscribe.keychain.get('openai-api-key')
        if (!key) { setError('API key not found'); setLoading(false); return }

        // Get vault subfolder prefix
        const config = await window.darkscribe.config.read()
        const prefix = (config.vault_subfolder as string) || ''
        const vp = (p: string) => prefix ? `${prefix}/${p}` : p

        // Read Notetaker Skill file for summarization preferences
        let skillContent: string | undefined
        try {
          const skillResult = await window.darkscribe.vault.readNote(vp('System/Notetaker Skill.md'))
          if (skillResult.content) skillContent = skillResult.content
        } catch {}

        const sum = await generateSummary(segments, key, skillContent)
        setSummary(sum)

        // Build markdown for vault save
        const md = buildSummaryMarkdown(sum, segments, sessionName, audioFile)
        setSummaryMarkdown(md)

        // Save call record
        await window.darkscribe.session.addCall(sessionId, {
          date: sum.dateTime,
          durationMinutes: sum.durationMinutes,
          segmentCount: segments.filter(s => s.isFinal).length,
          audioFile: audioFile ?? undefined,
          tags: sum.keyTopics.slice(0, 3)
        })
        setSaved(true)
      } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
    })()
  }, [segments, sessionId, audioFile])

  const [vaultError, setVaultError] = useState('')

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

      const date = new Date(summary.dateTime)
      const dateStr = date.toISOString().split('T')[0]
      const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-').substring(0, 5)
      const name = (sessionName || 'Unknown').replace(/[/\\:*?"<>|]/g, '-')
      const notePath = vp(`Calls/Summaries/${dateStr}_${timeStr}_${name}.md`)

      // Use saveNote (create or overwrite) instead of createNote (fails if exists)
      const saveResult = await window.darkscribe.vault.saveNote(notePath, summaryMarkdown)
      if (!saveResult.ok) throw new Error(saveResult.error ?? 'Save failed')

      // Store vaultNotePath and originalSummary in session
      const session = await window.darkscribe.session.get(sessionId) as any
      if (session) {
        const callIdx = session.calls.length - 1
        if (callIdx >= 0) {
          await window.darkscribe.session.updateCall(sessionId, callIdx, {
            vaultNotePath: notePath,
            originalSummary: summaryMarkdown
          })
        }
      }

      // Also save transcript
      const txPath = vp(`Calls/Transcripts/${dateStr}_${timeStr}_${name}.md`)
      const txContent = buildTranscriptMarkdown(segments, summary, sessionName, audioFile)
      await window.darkscribe.vault.saveNote(txPath, txContent)

      setSavedToVault(true)
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
        <div style={{ width: 32, height: 32, borderRadius: '50%', border: '2px solid var(--primary)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
        <div style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}>Generating summary...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (error) {
    return (
      <div className="page-enter" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={{ color: 'var(--negative)', fontSize: 'var(--text-sm)' }}>Error: {error}</div>
        <button onClick={onBack} style={{ padding: '8px 20px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Back</button>
      </div>
    )
  }

  return (
    <div className="page-enter" style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-6)' }}>
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-6)' }}>
          <div>
            <h2 style={{ fontSize: 'var(--text-xl)', color: 'var(--ink-1)' }}>Call Summary</h2>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', marginTop: 4 }}>
              {sessionName && <span style={{ fontWeight: 600 }}>{sessionName} · </span>}
              {summary?.durationMinutes}min · {summary?.participants.join(', ')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button
              onClick={saveToVault}
              disabled={savingToVault || savedToVault}
              style={{
                padding: '8px 16px',
                background: savedToVault ? 'var(--positive-subtle)' : 'var(--purple-subtle)',
                color: savedToVault ? 'var(--positive)' : 'var(--purple)',
                border: `1px solid ${savedToVault ? 'var(--positive)' : 'var(--purple)'}`,
                borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', fontWeight: 600, cursor: savedToVault ? 'default' : 'pointer',
                opacity: savingToVault ? 0.6 : 1
              }}
            >
              {savedToVault ? 'Saved to Vault' : savingToVault ? 'Saving...' : 'Save to Vault'}
            </button>
            <button onClick={() => setShowShareable(true)} style={{
              padding: '8px 16px', background: 'var(--surface-raised)', color: 'var(--ink-2)',
              border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)', cursor: 'pointer'
            }}>
              Shareable Summary
            </button>
            <button onClick={onBack} style={{ padding: '8px 16px', background: 'var(--surface-2)', color: 'var(--ink-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
              Done
            </button>
            <button onClick={onNewCall} style={{ padding: '8px 16px', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer' }}>
              New Call
            </button>
          </div>
        </div>

        {saved && (
          <div style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--positive-subtle)', border: '1px solid var(--positive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--positive)', marginBottom: 'var(--sp-4)' }}>
            Session saved
          </div>
        )}

        {vaultError && (
          <div style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--negative-subtle)', border: '1px solid var(--negative)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--negative)', marginBottom: 'var(--sp-4)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Save failed: {vaultError}</span>
            <button onClick={saveToVault} style={{ padding: '2px 10px', background: 'var(--negative)', color: 'white', border: 'none', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', cursor: 'pointer', marginLeft: 8 }}>Retry</button>
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
                <span key={i} style={{ padding: '2px 10px', background: 'var(--primary-subtle)', color: 'var(--primary)', borderRadius: 'var(--radius-full)', fontSize: 'var(--text-xs)', fontWeight: 600 }}>{topic}</span>
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
                <span style={{ color: 'var(--primary)', fontWeight: 700 }}>-</span>
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

        {/* Transcript Toggle */}
        <details style={{ marginTop: 'var(--sp-4)' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-2)', padding: 'var(--sp-2) 0' }}>
            View Full Transcript ({segments.filter(s => s.isFinal).length} segments)
          </summary>
          <div style={{ padding: 'var(--sp-4)', background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', marginTop: 'var(--sp-2)', maxHeight: 400, overflow: 'auto' }}>
            {segments.filter(s => s.isFinal && s.text.trim()).map(seg => (
              <div key={seg.id} style={{ marginBottom: 'var(--sp-2)', fontSize: 'var(--text-sm)' }}>
                <span style={{ fontWeight: 700, color: seg.speakerColor ?? 'var(--ink-2)' }}>
                  [{seg.speakerName ?? (seg.speaker === 'mic' ? 'You' : 'Them')}]
                </span>{' '}
                <span style={{ color: 'var(--ink-1)' }}>{seg.text}</span>
              </div>
            ))}
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
