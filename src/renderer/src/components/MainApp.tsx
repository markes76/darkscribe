import React, { useState } from 'react'
import { useRealtimeTranscription } from '../hooks/useRealtimeTranscription'
import { useContextSurfacing } from '../hooks/useContextSurfacing'
import Transcript from './SessionView/Transcript'
import VaultSearchPanel from './SearchPanel/VaultSearchPanel'
import ContextPanel from './SearchPanel/ContextPanel'
import type { TranscriptSegment } from '../services/openai-realtime'

interface Props {
  sessionId: string
  sessionName?: string
  onEndCall: (segments: TranscriptSegment[], audioFile: string | null) => void
  onBack: () => void
}

export default function MainApp({ sessionId, sessionName, onEndCall, onBack }: Props): React.ReactElement {
  const {
    status, statusDetail, segments, isCapturing,
    sysChunkCount, micChunkCount, audioError, callDuration,
    startSession, stopSession
  } = useRealtimeTranscription()

  const { cards: contextCards, loading: contextLoading, enabled: contextEnabled, setEnabled: setContextEnabled } = useContextSurfacing(segments, isCapturing)
  const [rightTab, setRightTab] = useState<'context' | 'search'>('context')

  const [contactName, setContactName] = useState(sessionName ?? '')
  const [editingContact, setEditingContact] = useState(false)
  const [contactDraft, setContactDraft] = useState('')
  const isActive = isCapturing || status === 'connecting' || status === 'connected'

  const handleStop = async () => {
    const recording = await stopSession()
    onEndCall(segments, recording?.filePath ?? null)
  }

  const saveContact = async (name: string) => {
    const trimmed = name.trim()
    setContactName(trimmed)
    setEditingContact(false)
    await window.darkscribe.session.update(sessionId, { name: trimmed || undefined })
  }

  const statusColor = status === 'connected' ? 'var(--positive)' : status === 'error' ? 'var(--negative)' : 'var(--warning)'
  const statusLabel = status === 'idle' ? 'Ready' : status === 'connecting' ? 'Connecting' : status === 'connected' ? 'Live' : status === 'error' ? 'Error' : 'Offline'

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--surface-1)' }}>
      {/* Controls bar */}
      <div style={{ padding: '8px 20px', borderBottom: '1px solid var(--border-1)', background: 'var(--surface-raised)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: 'var(--ink-3)', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
          Back
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border-1)' }} />

        <button onClick={isActive ? handleStop : () => startSession(sessionId)} style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '7px 18px',
          background: isActive ? 'var(--negative)' : 'var(--primary)',
          color: 'white', border: 'none', borderRadius: 'var(--radius-full)', fontSize: 'var(--text-xs)', fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--shadow-sm)'
        }}>
          <span style={{ width: 6, height: 6, borderRadius: isActive ? 1 : '50%', background: 'white' }} />
          {isActive ? 'Stop' : 'Start'}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor }} />
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: statusColor, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{statusLabel}</span>
        </div>
        {statusDetail && status !== 'connected' && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>{statusDetail}</span>}

        {/* Contact name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {editingContact ? (
            <input
              autoFocus
              value={contactDraft}
              onChange={e => setContactDraft(e.target.value)}
              onBlur={() => saveContact(contactDraft)}
              onKeyDown={e => { if (e.key === 'Enter') saveContact(contactDraft); if (e.key === 'Escape') setEditingContact(false) }}
              placeholder="Contact name..."
              style={{ padding: '3px 8px', background: 'var(--surface-2)', border: '1px solid var(--primary)', borderRadius: 'var(--radius-sm)', color: 'var(--ink-1)', fontSize: 'var(--text-xs)', outline: 'none', width: 160 }}
            />
          ) : contactName ? (
            <button onClick={() => { setContactDraft(contactName); setEditingContact(true) }} style={{ padding: '3px 10px', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-full)', color: 'var(--ink-2)', fontSize: 'var(--text-xs)', fontWeight: 600, cursor: 'pointer' }}>
              {contactName}
            </button>
          ) : (
            <button onClick={() => { setContactDraft(''); setEditingContact(true) }} style={{ padding: '3px 10px', background: 'transparent', border: '1px dashed var(--border-1)', borderRadius: 'var(--radius-full)', color: 'var(--ink-4)', fontSize: 'var(--text-xs)', cursor: 'pointer' }}>
              + Contact name
            </button>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {isActive && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>{formatDuration(callDuration)}</span>
            <span style={{ padding: '2px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)' }}>SYS {sysChunkCount || '0'}</span>
            <span style={{ padding: '2px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700, color: 'var(--ink-3)' }}>MIC {micChunkCount || '0'}</span>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)' }}>{segments.length} seg</span>
          </div>
        )}
      </div>

      {audioError && (
        <div style={{ padding: '4px 20px', background: 'var(--negative-subtle)', borderBottom: '1px solid var(--negative)', fontSize: 'var(--text-xs)', color: 'var(--negative)', flexShrink: 0 }}>{audioError}</div>
      )}

      {/* 2-panel layout: Transcript + Search */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={{ flex: 3, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Transcript segments={segments} isCapturing={isCapturing} />
        </div>
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: '1px solid var(--border-1)' }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-1)', flexShrink: 0 }}>
            <button
              onClick={() => setRightTab('context')}
              style={{
                flex: 1, padding: '6px 0', background: 'none', border: 'none',
                borderBottom: rightTab === 'context' ? '2px solid var(--primary)' : '2px solid transparent',
                fontSize: 'var(--text-xs)', fontWeight: rightTab === 'context' ? 700 : 500,
                color: rightTab === 'context' ? 'var(--primary)' : 'var(--ink-3)', cursor: 'pointer'
              }}
            >
              Context
              {contextCards.length > 0 && (
                <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-subtle)', padding: '0 4px', borderRadius: 'var(--radius-full)' }}>
                  {contextCards.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setRightTab('search')}
              style={{
                flex: 1, padding: '6px 0', background: 'none', border: 'none',
                borderBottom: rightTab === 'search' ? '2px solid var(--primary)' : '2px solid transparent',
                fontSize: 'var(--text-xs)', fontWeight: rightTab === 'search' ? 700 : 500,
                color: rightTab === 'search' ? 'var(--primary)' : 'var(--ink-3)', cursor: 'pointer'
              }}
            >
              Search
            </button>
          </div>
          {/* Tab content */}
          {rightTab === 'context' ? (
            <ContextPanel cards={contextCards} loading={contextLoading} enabled={contextEnabled} onToggle={setContextEnabled} />
          ) : (
            <VaultSearchPanel />
          )}
        </div>
      </div>
    </div>
  )
}
