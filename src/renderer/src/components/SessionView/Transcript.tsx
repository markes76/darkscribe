import React, { useEffect, useRef } from 'react'
import type { TranscriptSegment } from '../../services/openai-realtime'

interface Props {
  segments: TranscriptSegment[]
  isCapturing: boolean
}

export default function Transcript({ segments, isCapturing }: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isCapturing) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [segments, isCapturing])

  const finalSegments = segments.filter(s => s.text.trim())

  // Channel indicator: mic = blue dot, sys = green dot (no speaker labels)
  const channelColor = (speaker: string) => speaker === 'mic' ? '#2563eb' : '#059669'

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 'var(--sp-4)' }}>
      {finalSegments.length === 0 && (
        <div style={{ textAlign: 'center', padding: 'var(--sp-16) 0', color: 'var(--ink-4)', fontSize: 'var(--text-sm)' }}>
          {isCapturing ? 'Listening...' : 'No transcript yet. Start a call to begin.'}
        </div>
      )}
      {finalSegments.map((seg) => (
        <div key={seg.id} style={{ marginBottom: 'var(--sp-3)', animation: seg.isFinal ? 'none' : 'pulse 1.5s infinite' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: channelColor(seg.speaker),
              flexShrink: 0, marginTop: 6
            }} />
            <span style={{ fontSize: 10, color: 'var(--ink-4)', minWidth: 70, flexShrink: 0 }}>
              {new Date(seg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span style={{ fontSize: 'var(--text-sm)', color: seg.isFinal ? 'var(--ink-1)' : 'var(--ink-3)', lineHeight: 1.6 }}>
              {seg.text}
            </span>
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
