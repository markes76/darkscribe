import React, { useState } from 'react'

interface Props {
  activeTab: 'home' | 'call' | 'settings'
  isCapturing: boolean
  onNavigate: (tab: string) => void
}

export default function TopNav({ activeTab, isCapturing, onNavigate }: Props): React.ReactElement {
  const [settingsHovered, setSettingsHovered] = useState(false)

  return (
    <nav style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 var(--sp-4)', height: 44,
      background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-1)',
      flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 160 }}>
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-base)', fontWeight: 700, color: 'var(--ink-1)', letterSpacing: '-0.02em' }}>
          Darkscribe
        </span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <button
          onClick={() => onNavigate('home')}
          style={{
            padding: '6px var(--sp-3)', background: 'none',
            border: 'none', borderRadius: 'var(--radius-sm) var(--radius-sm) 0 0',
            fontSize: 'var(--text-sm)', fontWeight: activeTab === 'home' ? 700 : 500,
            color: activeTab === 'home' ? 'var(--ink-1)' : 'var(--ink-3)',
            cursor: 'pointer',
            borderBottom: activeTab === 'home' ? '2px solid var(--primary)' : '2px solid transparent'
          }}
        >
          Home
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', minWidth: 160, justifyContent: 'flex-end' }}>
        {isCapturing && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 10px', background: 'var(--positive-subtle)', borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700, color: 'var(--positive)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--positive)', animation: 'pulse 2s infinite' }} />
            LIVE
          </span>
        )}
        <button
          onClick={() => onNavigate('settings')}
          onMouseEnter={() => setSettingsHovered(true)}
          onMouseLeave={() => setSettingsHovered(false)}
          style={{
            background: activeTab === 'settings' ? 'var(--primary-subtle)' : settingsHovered ? 'var(--surface-2)' : 'none',
            border: activeTab === 'settings' ? '1px solid var(--primary)' : '1px solid transparent',
            borderRadius: 'var(--radius-sm)',
            fontSize: 16,
            color: activeTab === 'settings' ? 'var(--primary)' : settingsHovered ? 'var(--ink-2)' : 'var(--ink-3)',
            cursor: 'pointer',
            padding: '4px 8px'
          }}
          title="Settings"
        >
          Settings
        </button>
      </div>
    </nav>
  )
}
