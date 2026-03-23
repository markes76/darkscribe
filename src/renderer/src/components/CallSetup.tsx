import React, { useState } from 'react'

interface Props {
  onStart: (recordingName: string, participants: string) => void
  onCancel: () => void
}

export default function CallSetup({ onStart, onCancel }: Props): React.ReactElement {
  const [recordingName, setRecordingName] = useState('')
  const [participants, setParticipants] = useState('')

  const handleStart = () => {
    onStart(recordingName.trim(), participants.trim())
  }

  return (
    <div className="page-enter" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--sp-8)' }}>
      <div style={{ width: 440, background: 'var(--surface-raised)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 'var(--sp-8)', boxShadow: 'var(--shadow-md)' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)', color: 'var(--ink-1)', marginBottom: 'var(--sp-2)' }}>New Call</h2>
        <p style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)', marginBottom: 'var(--sp-6)' }}>
          Name your recording and add participants. Both are optional.
        </p>

        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>Recording Name</label>
          <input
            value={recordingName}
            onChange={e => setRecordingName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleStart() }}
            placeholder="e.g., Weekly sync with Sarah"
            autoFocus
            style={{
              width: '100%', padding: '10px 14px', border: '1px solid var(--border-1)',
              borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)',
              background: 'var(--surface-2)', color: 'var(--ink-1)'
            }}
          />
        </div>

        <div style={{ marginBottom: 'var(--sp-6)' }}>
          <label style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-2)', marginBottom: 4 }}>Participants</label>
          <input
            value={participants}
            onChange={e => setParticipants(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleStart() }}
            placeholder="e.g., Sarah, John, Marketing team"
            style={{
              width: '100%', padding: '10px 14px', border: '1px solid var(--border-1)',
              borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)',
              background: 'var(--surface-2)', color: 'var(--ink-1)'
            }}
          />
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)', marginTop: 4 }}>
            Used in filenames and summary metadata. Leave empty to use timestamp only.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--sp-3)', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            padding: '10px 20px', background: 'var(--surface-2)', color: 'var(--ink-2)',
            border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-sm)', cursor: 'pointer'
          }}>Cancel</button>
          <button onClick={handleStart} style={{
            padding: '10px 24px', background: 'var(--primary)', color: 'white',
            border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 700,
            fontSize: 'var(--text-sm)', cursor: 'pointer', boxShadow: 'var(--shadow-sm)'
          }}>Start Call</button>
        </div>
      </div>
    </div>
  )
}
