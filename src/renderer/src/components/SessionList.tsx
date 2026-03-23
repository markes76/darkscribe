import React, { useEffect, useState } from 'react'

interface CallRecord {
  date: string
  durationMinutes?: number
  tags?: string[]
  status?: string
  vaultNotePath?: string
}

interface Session {
  id: string
  name?: string
  calls: CallRecord[]
  createdAt: string
  updatedAt: string
}

interface SessionMeta {
  status?: string
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

function getSessionStatus(session: Session, meta: SessionMeta | null): { label: string; color: string } {
  const lastCall = session.calls[session.calls.length - 1]
  const status = lastCall?.status || meta?.status

  if (status === 'complete' || lastCall?.vaultNotePath) return { label: 'Saved', color: 'var(--positive)' }
  if (status === 'summarized') return { label: 'Summarized', color: 'var(--primary)' }
  if (status === 'interrupted') return { label: 'Interrupted', color: 'var(--negative)' }
  if (status === 'recording') return { label: 'In Progress', color: 'var(--warning)' }
  if (session.calls.length === 0) return { label: 'Empty', color: 'var(--ink-4)' }
  return { label: 'Draft', color: 'var(--ink-3)' }
}

export default function SessionList({ onNewCall, onNewVoiceNote, onSelectSession }: Props): React.ReactElement {
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionMetas, setSessionMetas] = useState<Record<string, SessionMeta | null>>({})
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    window.darkscribe.session.list().then(async (list) => {
      const sessions = list as Session[]
      setSessions(sessions)
      // Load metadata for status indicators
      const metas: Record<string, SessionMeta | null> = {}
      for (const s of sessions) {
        try {
          metas[s.id] = await window.darkscribe.session.loadMetadata(s.id) as SessionMeta | null
        } catch {
          metas[s.id] = null
        }
      }
      setSessionMetas(metas)
    })
  }, [])

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (confirmDelete !== id) {
      setConfirmDelete(id)
      return
    }
    await window.darkscribe.session.delete(id)
    setSessions(prev => prev.filter(s => s.id !== id))
    setConfirmDelete(null)
  }

  const openInObsidian = async (e: React.MouseEvent, vaultPath: string) => {
    e.stopPropagation()
    try {
      const config = await window.darkscribe.config.read()
      const vaultName = encodeURIComponent((config.obsidian_vault_name as string) || 'MyVault')
      const filePath = encodeURIComponent(vaultPath.replace(/\.md$/, ''))
      window.darkscribe.shell.openUrl(`obsidian://open?vault=${vaultName}&file=${filePath}`)
    } catch {}
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
              const meta = sessionMetas[session.id]
              const { label: statusLabel, color: statusColor } = getSessionStatus(session, meta)
              const isHovered = hoveredId === session.id
              const hasVaultPath = !!lastCall?.vaultNotePath

              return (
                <div
                  key={session.id}
                  className="card-interactive"
                  onClick={() => onSelectSession(session)}
                  onMouseEnter={() => setHoveredId(session.id)}
                  onMouseLeave={() => { setHoveredId(null); if (confirmDelete === session.id) setConfirmDelete(null) }}
                  style={{
                    padding: 'var(--sp-4)', background: 'var(--surface-raised)',
                    border: `1px solid ${isHovered ? 'var(--primary)' : 'var(--border-1)'}`,
                    borderRadius: 'var(--radius-md)', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: 'var(--ink-1)', fontSize: 'var(--text-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {session.name || formatDate(session.updatedAt)}
                      </span>
                      <span style={{ fontSize: 9, fontWeight: 600, color: statusColor, flexShrink: 0 }}>{statusLabel}</span>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', marginTop: 2, paddingLeft: 15 }}>
                      {formatDate(session.updatedAt)}
                      {lastCall?.durationMinutes ? ` · ${lastCall.durationMinutes}min` : ''}
                      {lastCall?.tags?.length ? ` · ${lastCall.tags.join(', ')}` : ''}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexShrink: 0 }}>
                    {hasVaultPath && (
                      <button
                        onClick={(e) => openInObsidian(e, lastCall.vaultNotePath!)}
                        title="Open in Obsidian"
                        style={{ background: 'none', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-xs)', padding: '2px 6px', cursor: 'pointer', fontSize: 9, color: 'var(--primary)', fontWeight: 600 }}
                      >
                        Obsidian
                      </button>
                    )}
                    {isHovered && (
                      <button
                        onClick={(e) => handleDelete(e, session.id)}
                        style={{
                          background: confirmDelete === session.id ? 'var(--negative)' : 'var(--negative-subtle)',
                          border: '1px solid var(--negative)', borderRadius: 'var(--radius-sm)',
                          color: confirmDelete === session.id ? 'white' : 'var(--negative)',
                          fontSize: 'var(--text-xs)', padding: '2px 8px', cursor: 'pointer'
                        }}
                      >
                        {confirmDelete === session.id ? 'Confirm?' : 'Delete'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
