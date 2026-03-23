import React, { useState, useEffect } from 'react'
import type { ContextCard } from '../../services/context-surfacer'

interface Props {
  cards: ContextCard[]
  loading: boolean
  enabled: boolean
  onToggle: (enabled: boolean) => void
  debugStatus?: string
}

export default function ContextPanel({ cards, loading, enabled, onToggle, debugStatus }: Props): React.ReactElement {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  // Reset dismissed when a new call starts (cards empty)
  useEffect(() => {
    if (cards.length === 0) setDismissed(new Set())
  }, [cards.length === 0])

  const dismiss = (id: string) => {
    setDismissed(prev => new Set(prev).add(id))
  }

  const openInObsidian = async (notePath: string) => {
    try {
      const config = await window.darkscribe.config.read()
      const vaultName = (config.obsidian_vault_name as string) || 'MyVault'
      const encodedVault = encodeURIComponent(vaultName)
      const encodedPath = encodeURIComponent(notePath.replace(/\.md$/, ''))
      const url = `obsidian://open?vault=${encodedVault}&file=${encodedPath}`
      window.darkscribe.shell.openUrl(url)
    } catch {}
  }

  const visibleCards = cards.filter(c => !dismissed.has(c.id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 'var(--sp-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Context
          </span>
          {loading && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', animation: 'pulse 1.5s infinite' }} />
          )}
          {visibleCards.length > 0 && !loading && (
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-subtle)', padding: '1px 6px', borderRadius: 'var(--radius-full)' }}>
              {visibleCards.length}
            </span>
          )}
        </div>
        <button
          onClick={() => onToggle(!enabled)}
          style={{
            padding: '2px 8px', background: 'none',
            border: `1px solid ${enabled ? 'var(--positive)' : 'var(--border-1)'}`,
            borderRadius: 'var(--radius-xs)', fontSize: 9,
            color: enabled ? 'var(--positive)' : 'var(--ink-4)',
            cursor: 'pointer', fontWeight: 600
          }}
        >
          {enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {!enabled && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)', textAlign: 'center', padding: 'var(--sp-4)' }}>
            Context surfacing is paused
          </div>
        )}

        {enabled && visibleCards.length === 0 && !loading && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)', textAlign: 'center', padding: 'var(--sp-4)' }}>
            Relevant notes will appear here during the call
          </div>
        )}

        {visibleCards.map((card) => (
          <div
            key={card.id}
            style={{
              padding: 'var(--sp-2) var(--sp-3)', marginBottom: 'var(--sp-2)',
              background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)', animation: 'fadeInUp 0.3s ease',
              position: 'relative'
            }}
          >
            {/* Dismiss button */}
            <button
              onClick={() => dismiss(card.id)}
              style={{
                position: 'absolute', top: 4, right: 6,
                background: 'none', border: 'none', color: 'var(--ink-4)',
                fontSize: 12, cursor: 'pointer', lineHeight: 1, padding: '2px'
              }}
              title="Dismiss"
            >
              x
            </button>

            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-1)', marginBottom: 2, paddingRight: 16 }}>
              {card.title}
            </div>
            {card.excerpt && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', lineHeight: 1.5, marginBottom: 4 }}>
                {card.excerpt.substring(0, 150)}{card.excerpt.length > 150 ? '...' : ''}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
              <span style={{ fontSize: 9, color: 'var(--purple)', fontWeight: 600 }}>
                {card.relevanceHint}
              </span>
              <button
                onClick={() => openInObsidian(card.notePath)}
                style={{
                  padding: '1px 6px', background: 'none',
                  border: '1px solid var(--border-1)', borderRadius: 'var(--radius-xs)',
                  fontSize: 9, color: 'var(--primary)', cursor: 'pointer', fontWeight: 600
                }}
              >
                Open in Obsidian
              </button>
            </div>
          </div>
        ))}
      </div>

      {debugStatus && (
        <div style={{ fontSize: 9, color: 'var(--ink-4)', textAlign: 'center', padding: '4px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          {debugStatus}
        </div>
      )}
    </div>
  )
}
