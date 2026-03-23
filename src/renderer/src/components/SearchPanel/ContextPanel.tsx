import React from 'react'
import type { ContextCard } from '../../services/context-surfacer'

interface Props {
  cards: ContextCard[]
  loading: boolean
  enabled: boolean
  onToggle: (enabled: boolean) => void
}

export default function ContextPanel({ cards, loading, enabled, onToggle }: Props): React.ReactElement {
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
          {cards.length > 0 && !loading && (
            <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--primary)', background: 'var(--primary-subtle)', padding: '1px 6px', borderRadius: 'var(--radius-full)' }}>
              {cards.length}
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

        {enabled && cards.length === 0 && !loading && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-4)', textAlign: 'center', padding: 'var(--sp-4)' }}>
            Relevant notes will appear here during the call
          </div>
        )}

        {cards.slice(0, 5).map((card) => (
          <div
            key={card.id}
            style={{
              padding: 'var(--sp-2) var(--sp-3)', marginBottom: 'var(--sp-2)',
              background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)', animation: 'fadeInUp 0.3s ease'
            }}
          >
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-1)', marginBottom: 2 }}>
              {card.title}
            </div>
            {card.excerpt && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)', lineHeight: 1.5, marginBottom: 4 }}>
                {card.excerpt.substring(0, 120)}{card.excerpt.length > 120 ? '...' : ''}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 9, color: 'var(--purple)', fontWeight: 600 }}>
                {card.relevanceHint}
              </span>
              <span style={{ fontSize: 9, color: 'var(--ink-4)' }}>
                {card.notePath.split('/').slice(-2, -1)[0]}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
