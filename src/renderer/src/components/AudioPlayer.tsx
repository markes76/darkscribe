import React, { useState, useEffect, useRef, useCallback } from 'react'

interface Props {
  filePath: string | null
  deleted?: boolean
}

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2]

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function AudioPlayer({ filePath, deleted }: Props): React.ReactElement {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [waveform, setWaveform] = useState<number[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const animRef = useRef<number | null>(null)

  // Load the WAV file and create a Blob URL
  useEffect(() => {
    if (!filePath || deleted) return
    let cancelled = false
    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const result = await window.darkscribe.file.readBinary(filePath)
        if (cancelled) return
        if (result.error || !result.data) {
          setError(result.error || 'Failed to load audio')
          setLoading(false)
          return
        }
        const blob = new Blob([result.data], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)
        setBlobUrl(url)

        // Generate waveform from raw PCM data (skip 44-byte WAV header)
        const samples = new Int16Array(result.data, 44)
        const bars = 120
        const step = Math.floor(samples.length / bars)
        const peaks: number[] = []
        let maxPeak = 0
        for (let i = 0; i < bars; i++) {
          let peak = 0
          for (let j = 0; j < step && i * step + j < samples.length; j++) {
            peak = Math.max(peak, Math.abs(samples[i * step + j]))
          }
          peaks.push(peak)
          maxPeak = Math.max(maxPeak, peak)
        }
        setWaveform(maxPeak > 0 ? peaks.map(p => p / maxPeak) : peaks)
        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [filePath, deleted])

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [])

  const updateTime = useCallback(() => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime)
      if (!audioRef.current.paused) {
        animRef.current = requestAnimationFrame(updateTime)
      }
    }
  }, [])

  const togglePlay = useCallback(() => {
    if (!audioRef.current) return
    if (audioRef.current.paused) {
      audioRef.current.play()
      setIsPlaying(true)
      animRef.current = requestAnimationFrame(updateTime)
    } else {
      audioRef.current.pause()
      setIsPlaying(false)
      if (animRef.current) cancelAnimationFrame(animRef.current)
    }
  }, [updateTime])

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    audioRef.current.currentTime = pct * duration
    setCurrentTime(pct * duration)
  }, [duration])

  const handleSpeedChange = useCallback(() => {
    const idx = SPEED_OPTIONS.indexOf(speed)
    const next = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length]
    setSpeed(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }, [speed])

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    setVolume(v)
    if (audioRef.current) audioRef.current.volume = v
  }, [])

  if (deleted || (!filePath && !deleted)) {
    return (
      <div style={{
        padding: 'var(--sp-4)', background: 'var(--surface-3)',
        borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-1)',
        textAlign: 'center', color: 'var(--ink-4)', fontSize: 'var(--text-xs)', fontWeight: 500
      }}>
        {deleted ? 'Recording deleted' : 'No recording available'}
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{
        padding: 'var(--sp-4)', background: 'var(--surface-3)',
        borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-1)',
        textAlign: 'center', color: 'var(--ink-4)', fontSize: 'var(--text-xs)'
      }}>
        Loading audio...
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        padding: 'var(--sp-4)', background: 'var(--surface-3)',
        borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-1)',
        textAlign: 'center', color: 'var(--negative)', fontSize: 'var(--text-xs)'
      }}>
        {error}
      </div>
    )
  }

  const progress = duration > 0 ? currentTime / duration : 0

  return (
    <div style={{
      padding: 'var(--sp-4)', background: 'var(--surface-3)',
      borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-1)'
    }}>
      {blobUrl && (
        <audio
          ref={audioRef}
          src={blobUrl}
          onLoadedMetadata={() => {
            if (audioRef.current) setDuration(audioRef.current.duration)
          }}
          onEnded={() => {
            setIsPlaying(false)
            if (animRef.current) cancelAnimationFrame(animRef.current)
          }}
        />
      )}

      {/* Waveform visualization + seek bar */}
      <div
        onClick={handleSeek}
        style={{
          height: 48, display: 'flex', alignItems: 'center', gap: 1,
          cursor: 'pointer', marginBottom: 'var(--sp-3)', borderRadius: 'var(--radius-sm)',
          overflow: 'hidden', position: 'relative'
        }}
      >
        {waveform.map((v, i) => {
          const barProgress = i / waveform.length
          const isPast = barProgress <= progress
          return (
            <div
              key={i}
              style={{
                flex: 1, height: `${Math.max(4, v * 100)}%`,
                background: isPast ? 'var(--accent)' : 'var(--surface-4)',
                borderRadius: 1, transition: 'background 0.1s ease',
                minWidth: 1
              }}
            />
          )
        })}
      </div>

      {/* Controls row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          disabled={!blobUrl}
          style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'var(--accent)', color: 'var(--accent-ink)',
            border: 'none', cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 14, fontWeight: 700, flexShrink: 0
          }}
        >
          {isPlaying ? '||' : '\u25B6'}
        </button>

        {/* Time display */}
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-3)',
          fontWeight: 500, minWidth: 80, flexShrink: 0
        }}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Speed toggle */}
        <button
          onClick={handleSpeedChange}
          style={{
            padding: '2px 8px', background: 'var(--surface-4)',
            border: '1px solid var(--border-1)', borderRadius: 'var(--radius-full)',
            fontSize: 10, fontWeight: 700, color: 'var(--ink-3)',
            cursor: 'pointer', fontFamily: 'var(--font-mono)',
            flexShrink: 0
          }}
        >
          {speed}x
        </button>

        {/* Volume */}
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={handleVolumeChange}
          style={{
            width: 60, height: 4, accentColor: 'var(--accent)',
            cursor: 'pointer', flexShrink: 0
          }}
        />
      </div>
    </div>
  )
}
