import React, { useEffect, useState, useCallback } from 'react'
import OnboardingFlow from './components/Onboarding/OnboardingFlow'
import TopNav from './components/TopNav'
import SessionList from './components/SessionList'
import CallSetup from './components/CallSetup'
import VoiceNoteSetup from './components/VoiceNoteSetup'
import type { VoiceNoteCategory } from './components/VoiceNoteSetup'
import MainApp from './components/MainApp'
import PostCallSummary from './components/PostCallSummary'
import VoiceNoteSummary from './components/VoiceNoteSummary'
import Settings from './components/Settings'
import type { TranscriptSegment } from './services/openai-realtime'
import type { WebSearchResult } from './components/SearchPanel/VaultSearchPanel'
import type { NoteReference } from './components/ReferencePanel'

type AppState = 'loading' | 'onboarding' | 'home' | 'setup' | 'voice-setup' | 'call' | 'voice-call' | 'summary' | 'voice-summary' | 'review' | 'settings'

interface ActiveSession {
  id: string
  name?: string
  participants?: string
}

interface VoiceNoteState {
  topic: string
  category: VoiceNoteCategory
}

export default function App(): React.ReactElement {
  const [state, setState] = useState<AppState>('loading')
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null)
  const [completedSegments, setCompletedSegments] = useState<TranscriptSegment[]>([])
  const [completedAudioFile, setCompletedAudioFile] = useState<string | null>(null)
  const [completedWebSearches, setCompletedWebSearches] = useState<WebSearchResult[]>([])
  const [voiceNote, setVoiceNote] = useState<VoiceNoteState>({ topic: '', category: 'Ideas' })
  const [toast, setToast] = useState<{ message: string; sessionId?: string } | null>(null)
  // Track previous state before navigation (for returning to active call)
  const [prevState, setPrevState] = useState<AppState | null>(null)

  // Listen for background processing completion (toast when not on summary screen)
  useEffect(() => {
    const removeComplete = window.darkscribe.processing.onComplete((data) => {
      if (state !== 'summary' || activeSession?.id !== data.sessionId) {
        setToast({ message: `Summary ready: ${data.sessionName || 'Recording'}`, sessionId: data.sessionId })
        setTimeout(() => setToast(null), 6000)
      }
    })
    const removeVaultUpdated = window.darkscribe.processing.onVaultUpdated((data) => {
      setToast({ message: `Enhanced summary saved to vault: ${data.sessionName || 'Recording'}`, sessionId: data.sessionId })
      setTimeout(() => setToast(null), 6000)
    })
    return () => { removeComplete(); removeVaultUpdated() }
  }, [state, activeSession?.id])

  useEffect(() => {
    window.darkscribe.config.read().then((config) => {
      setState(config.onboarding_complete ? 'home' : 'onboarding')
    })
  }, [])

  const handleCallEnd = useCallback((segments: TranscriptSegment[], audioFile: string | null, webSearches?: WebSearchResult[]) => {
    setCompletedSegments(segments)
    setCompletedAudioFile(audioFile)
    setCompletedWebSearches(webSearches ?? [])
    setState(prev => prev === 'voice-call' ? 'voice-summary' : 'summary')
  }, [])

  const startCallFromSetup = useCallback(async (recordingName: string, participants: string, references?: NoteReference[]) => {
    const session = await window.darkscribe.session.create({ name: recordingName || undefined }) as any
    if (references?.length) {
      await window.darkscribe.session.saveReferences(session.id, references).catch(() => {})
    }
    setActiveSession({ id: session.id, name: recordingName || undefined, participants: participants || undefined })
    setState('call')
  }, [])

  const startVoiceNote = useCallback(async (topic: string, category: VoiceNoteCategory) => {
    setVoiceNote({ topic, category })
    const session = await window.darkscribe.session.create({ name: topic || 'Voice Note' }) as any
    setActiveSession({ id: session.id, name: topic || undefined })
    setState('voice-call')
  }, [])

  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={{ width: 40, height: 40, borderRadius: 'var(--radius-md)', background: 'var(--primary-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 20, height: 20, borderRadius: '50%', border: '2px solid var(--primary)', borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>Loading Darkscribe...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (state === 'onboarding') {
    return <OnboardingFlow onComplete={() => { window.darkscribe.config.write({ onboarding_complete: true }); setState('home') }} />
  }

  const handleNav = (tab: string) => {
    const currentlyRecording = state === 'call' || state === 'voice-call' ||
      (prevState === 'call' || prevState === 'voice-call')

    if (tab === 'settings') {
      // Remember where we came from so we can return
      if (state === 'call' || state === 'voice-call') {
        setPrevState(state)
      }
      setState('settings')
    } else if (tab === 'home') {
      if (currentlyRecording && activeSession) {
        // Recording is active — go to home but keep activeSession alive
        // so user can return via banner or session card click
        if (state === 'call' || state === 'voice-call') {
          setPrevState(state)
        }
        setState('home')
      } else {
        setActiveSession(null)
        setPrevState(null)
        setState('home')
      }
    }
  }

  const isRecording = !!activeSession && (state === 'call' || state === 'voice-call' || ((state === 'settings' || state === 'home') && (prevState === 'call' || prevState === 'voice-call')))
  const activeTab: 'home' | 'call' | 'settings' = (state === 'home' || state === 'setup' || state === 'voice-setup') ? 'home' : state === 'settings' ? 'settings' : 'call'

  const renderContent = () => {
    if (state === 'settings') return <Settings onBack={() => {
      // Return to active recording if one exists
      if (activeSession && (prevState === 'call' || prevState === 'voice-call')) {
        setState(prevState)
        setPrevState(null)
      } else {
        setState('home')
        setPrevState(null)
      }
    }} />

    if (state === 'home') {
      return (
        <>
          {/* Recording in progress banner */}
          {isRecording && activeSession && (
            <div
              onClick={() => { setState(prevState === 'voice-call' ? 'voice-call' : 'call'); setPrevState(null) }}
              style={{
                padding: 'var(--sp-3) var(--sp-5)', background: 'var(--negative-subtle)',
                border: '1px solid rgba(217,83,79,0.3)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
                margin: '0 var(--sp-4) var(--sp-4)'
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%', background: 'var(--negative)',
                animation: 'breathe 2s infinite', flexShrink: 0
              }} />
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', fontWeight: 600, flex: 1 }}>
                Recording in progress: {activeSession.name || 'Untitled'}
              </span>
              <span style={{
                padding: '4px 12px', background: 'var(--negative)', color: 'white',
                borderRadius: 'var(--radius-full)', fontSize: 'var(--text-xs)', fontWeight: 700
              }}>
                Return to Call
              </span>
            </div>
          )}
          <SessionList
            onNewCall={() => setState('setup')}
            onNewVoiceNote={() => setState('voice-setup')}
            onSelectSession={async (session) => {
              // If this is the active recording session, return to live call
              if (activeSession && session.id === activeSession.id && isRecording) {
                setState(prevState === 'voice-call' ? 'voice-call' : 'call')
                setPrevState(null)
                return
              }
              // Check if session is still recording (shouldn't happen, but guard)
              const meta = await window.darkscribe.session.loadMetadata(session.id) as any
              if (meta?.status === 'recording') {
                // Can't view an in-progress session from another recording
                return
              }
              // Load session data from disk and open in review mode
              const transcript = await window.darkscribe.session.loadTranscript(session.id) as any[] | null
              const searches = await window.darkscribe.session.loadWebSearches(session.id) as any[] | null
              // Load audio file path from session call record
              const sess = await window.darkscribe.session.get(session.id) as any
              const lastCall = sess?.calls?.[sess.calls.length - 1]
              const audioPath = lastCall?.audioFile || null
              setCompletedSegments(transcript ?? [])
              setCompletedWebSearches(searches ?? [])
              setCompletedAudioFile(audioPath)
              setActiveSession({ id: session.id, name: session.name })
              setState('review')
            }}
          />
        </>
      )
    }

    if (state === 'setup') {
      return <CallSetup onStart={startCallFromSetup} onCancel={() => setState('home')} />
    }

    if (state === 'voice-setup') {
      return <VoiceNoteSetup onStart={startVoiceNote} onCancel={() => setState('home')} />
    }

    if (state === 'summary' && activeSession) {
      return (
        <PostCallSummary
          segments={completedSegments}
          sessionId={activeSession.id}
          sessionName={activeSession.name}
          participants={activeSession.participants}
          webSearches={completedWebSearches}
          audioFile={completedAudioFile}
          onBack={() => { setActiveSession(null); setState('home') }}
          onNewCall={() => { setActiveSession(null); setState('setup') }}
        />
      )
    }

    if (state === 'review' && activeSession) {
      return (
        <PostCallSummary
          segments={completedSegments}
          sessionId={activeSession.id}
          sessionName={activeSession.name}
          participants={activeSession.participants}
          webSearches={completedWebSearches}
          audioFile={completedAudioFile}
          readOnly={true}
          onBack={() => { setActiveSession(null); setState('home') }}
          onNewCall={() => { setActiveSession(null); setState('setup') }}
        />
      )
    }

    if (state === 'voice-summary') {
      return (
        <VoiceNoteSummary
          segments={completedSegments}
          topic={voiceNote.topic}
          category={voiceNote.category}
          audioFile={completedAudioFile}
          onBack={() => { setActiveSession(null); setState('home') }}
          onNew={() => { setActiveSession(null); setState('voice-setup') }}
        />
      )
    }

    // For non-call states when recording is active, MainApp is rendered
    // separately below (kept alive but hidden) — don't render it here too
    if ((state === 'call' || state === 'voice-call') && activeSession) {
      // MainApp is rendered in the always-alive slot below
      return null
    }

    return null
  }

  // Is the call view currently visible?
  const callViewVisible = (state === 'call' || state === 'voice-call') && !!activeSession

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--surface-1)', paddingTop: 28 }}>
      <TopNav activeTab={activeTab} isCapturing={isRecording} onNavigate={handleNav} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Non-call content (home, settings, summary, etc.) */}
        {!callViewVisible && renderContent()}

        {/* MainApp stays mounted for the entire recording lifecycle.
            Hidden via CSS when user navigates away — preserves WebSocket
            connections, transcript state, and audio capture. */}
        {isRecording && activeSession && (
          <div style={{
            flex: 1, minHeight: 0, display: callViewVisible ? 'flex' : 'none',
            flexDirection: 'column'
          }}>
            <MainApp
              sessionId={activeSession.id}
              sessionName={activeSession.name}
              onEndCall={handleCallEnd}
              onBack={() => {
                setPrevState(state)
                setState('home')
              }}
            />
          </div>
        )}
      </div>

      {/* Toast notification */}
      {toast && (
        <div
          onClick={() => setToast(null)}
          style={{
            position: 'fixed', bottom: 24, right: 24,
            padding: 'var(--sp-3) var(--sp-5)', background: 'var(--surface-glass)',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-lg)', cursor: 'pointer',
            animation: 'fadeInUp 0.3s ease', zIndex: 9999,
            display: 'flex', alignItems: 'center', gap: 'var(--sp-2)'
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--positive)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-1)', fontWeight: 500 }}>
            {toast.message}
          </span>
        </div>
      )}
    </div>
  )
}
