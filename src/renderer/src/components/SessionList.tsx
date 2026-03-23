import React, { useEffect, useState } from 'react'

interface Session {
  id: string
  name?: string
  calls: Array<{ date: string; durationMinutes?: number; tags?: string[] }>
  createdAt: string
  updatedAt: string
}

interface Props {
  onNewCall: () => void
  onNewVoiceNote?: () => void
  onSelectSession: (session: Session) => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diff === 0) return `Today ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  if (diff === 1) return `Yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function SessionList({ onNewCall, onNewVoiceNote, onSelectSession }: Props): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  useEffect(() => {
    window.darkscribe.session.list().then((list) => setSessions(list as Session[]))
  }, [])

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    await window.darkscribe.session.delete(id)
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  return (
    <div className="page-enter" style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-8) var(--sp-6)' }}>
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-6)' }}>
          <div>
            <h1 style={{ fontSize: 'var(--text-2xl)', color: 'var(--ink-1)', marginBottom: 'var(--sp-1)' }}>Darkscribe</h1>
            <p style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)' }}>Call transcription & notes</p>
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            {onNewVoiceNote && (
              <button
                onClick={onNewVoiceNote}
                style={{
                  padding: '10px 20px', background: 'var(--purple-subtle)', color: 'var(--purple)',
                  border: '1px solid var(--purple)', borderRadius: 'var(--radius-md)', fontWeight: 700,
                  fontSize: 'var(--text-sm)', cursor: 'pointer'
                }}
              >
                Voice Note
              </button>
            )}
            <button
              onClick={onNewCall}
              style={{
                padding: '10px 24px', background: 'var(--primary)', color: 'white',
                border: 'none', borderRadius: 'var(--radius-md)', fontWeight: 700,
                fontSize: 'var(--text-sm)', cursor: 'pointer', boxShadow: 'var(--shadow-sm)'
              }}
            >
              New Call
            </button>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 'var(--sp-16) 0', color: 'var(--ink-4)' }}>
            <div style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--sp-2)' }}>No sessions yet</div>
            <div style={{ fontSize: 'var(--text-sm)' }}>Start a new call to begin transcribing.</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            {sessions.map(session => {
              const lastCall = session.calls[session.calls.length - 1]
              const isHovered = hoveredId === session.id
              return (
                <div
                  key={session.id}
                  className="card-interactive"
                  onClick={() => onSelectSession(session)}
                  onMouseEnter={() => setHoveredId(session.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  style={{
                    padding: 'var(--sp-4)', background: 'var(--surface-raised)',
                    border: `1px solid ${isHovered ? 'var(--primary)' : 'var(--border-1)'}`,
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--ink-1)', fontSize: 'var(--text-sm)' }}>
                      {session.name || 'Untitled Session'}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', marginTop: 2 }}>
                      {formatDate(session.updatedAt)} · {session.calls.length} call{session.calls.length !== 1 ? 's' : ''}
                      {lastCall?.durationMinutes ? ` · ${lastCall.durationMinutes}min` : ''}
                    </div>
                  </div>
                  {isHovered && (
                    <button
                      onClick={(e) => handleDelete(e, session.id)}
                      style={{ background: 'var(--negative-subtle)', border: '1px solid var(--negative)', borderRadius: 'var(--radius-sm)', color: 'var(--negative)', fontSize: 'var(--text-xs)', padding: '2px 8px', cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
