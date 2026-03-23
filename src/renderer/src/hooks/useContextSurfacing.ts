import { useState, useRef, useEffect, useCallback } from 'react'
import type { TranscriptSegment } from '../services/openai-realtime'
import { extractEntities, searchForContext, parseVocabulary, ContextCard } from '../services/context-surfacer'

const DEFAULT_INTERVAL_MS = 30000

export interface ContextSurfacingState {
  cards: ContextCard[]
  loading: boolean
  enabled: boolean
}

export interface ContextSurfacingActions {
  setEnabled: (enabled: boolean) => void
}

export function useContextSurfacing(
  segments: TranscriptSegment[],
  isCapturing: boolean
): ContextSurfacingState & ContextSurfacingActions {
  const [cards, setCards] = useState<ContextCard[]>([])
  const [loading, setLoading] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const seenPathsRef = useRef(new Set<string>())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastCheckRef = useRef(0)

  const runCheck = useCallback(async () => {
    if (!isCapturing || !enabled) return

    // Get last ~60 seconds of transcript
    const now = Date.now()
    const recentSegments = segments.filter(
      s => s.isFinal && s.text.trim() && (now - s.timestamp) < 60000
    )
    if (recentSegments.length === 0) return

    const chunk = recentSegments.map(s => s.text).join(' ')
    if (chunk.length < 20) return // Too short to extract entities from

    setLoading(true)
    try {
      const apiKey = await window.darkscribe.keychain.get('openai-api-key')
      if (!apiKey) return

      // Read skill file vocabulary
      let vocabulary: Record<string, string> = {}
      try {
        const config = await window.darkscribe.config.read()
        const prefix = (config.vault_subfolder as string) || ''
        const skillPath = prefix ? `${prefix}/System/Notetaker Skill.md` : 'System/Notetaker Skill.md'
        const skillResult = await window.darkscribe.vault.readNote(skillPath)
        if (skillResult.content) {
          vocabulary = parseVocabulary(skillResult.content)
        }
      } catch {}

      const entities = await extractEntities(chunk, apiKey)
      if (entities.length === 0) return

      const newCards = await searchForContext(entities, seenPathsRef.current, vocabulary)
      if (newCards.length > 0) {
        setCards(prev => [...newCards, ...prev].slice(0, 10)) // Keep max 10
      }
    } catch (err) {
      console.error('[ContextSurfacing] Error:', err)
    } finally {
      setLoading(false)
    }
  }, [segments, isCapturing, enabled])

  // Set up polling interval
  useEffect(() => {
    if (!isCapturing || !enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    // Run immediately on first capture, then every 30s
    const timer = setInterval(runCheck, DEFAULT_INTERVAL_MS)
    intervalRef.current = timer

    // Run first check after 10 seconds of capturing
    const firstCheck = setTimeout(runCheck, 10000)

    return () => {
      clearInterval(timer)
      clearTimeout(firstCheck)
      intervalRef.current = null
    }
  }, [isCapturing, enabled, runCheck])

  // Reset when a new call starts
  useEffect(() => {
    if (isCapturing) {
      seenPathsRef.current = new Set()
      setCards([])
    }
  }, [isCapturing])

  return { cards, loading, enabled, setEnabled }
}
