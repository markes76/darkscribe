import React, { useEffect, useState, useCallback } from 'react'
import OnboardingFlow from './components/Onboarding/OnboardingFlow'
import TopNav from './components/TopNav'
import SessionList from './components/SessionList'
import MainApp from './components/MainApp'
import PostCallSummary from './components/PostCallSummary'
import Settings from './components/Settings'
import type { TranscriptSegment } from './services/openai-realtime'

type AppState = 'loading' | 'onboarding' | 'home' | 'call' | 'summary' | 'settings'

interface ActiveSession {
  id: string
  name?: string
}

export default function App(): React.ReactElement {
  const [state, setState] = useState<AppState>('loading')
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null)
  const [completedSegments, setCompletedSegments] = useState<TranscriptSegment[]>([])
  const [completedAudioFile, setCompletedAudioFile] = useState<string | null>(null)

  useEffect(() => {
    window.darkscribe.config.read().then((config) => {
      if (config.onboarding_complete) {
        setState('home')
      } else {
        setState('onboarding')
      }
    })
  }, [])

  const handleCallEnd = useCallback((segments: TranscriptSegment[], audioFile: string | null) => {
    setCompletedSegments(segments)
    setCompletedAudioFile(audioFile)
    setState('summary')
  }, [])

  if (state === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={{
          width: 40, height: 40, borderRadius: 'var(--radius-md)',
          background: 'var(--primary-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: 20, height: 20, borderRadius: '50%',
            border: '2px solid var(--primary)', borderTopColor: 'transparent',
            animation: 'spin 0.8s linear infinite'
          }} />
        </div>
        <div style={{ color: 'var(--ink-3)', fontSize: 'var(--text-sm)', fontWeight: 500 }}>Loading Darkscribe...</div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    )
  }

  if (state === 'onboarding') {
    return (
      <OnboardingFlow
        onComplete={() => {
          window.darkscribe.config.write({ onboarding_complete: true })
          setState('home')
        }}
      />
    )
  }

  const handleNav = (tab: string) => {
    if (tab === 'home') { setActiveSession(null); setState('home') }
    else if (tab === 'settings') setState('settings')
  }

  const activeTab: 'home' | 'call' | 'settings' = state === 'home' ? 'home' : state === 'settings' ? 'settings' : 'call'

  const renderContent = () => {
    if (state === 'settings') return <Settings onBack={() => setState('home')} />

    if (state === 'home') {
      return (
        <SessionList
          onNewCall={() => {
            window.darkscribe.session.create({ name: undefined }).then((session: any) => {
              setActiveSession({ id: session.id, name: session.name })
              setState('call')
            })
          }}
          onSelectSession={(session) => {
            setActiveSession({ id: session.id, name: session.name })
            setState('call')
          }}
        />
      )
    }

    if (state === 'summary' && activeSession) {
      return (
        <PostCallSummary
          segments={completedSegments}
          sessionId={activeSession.id}
          sessionName={activeSession.name}
          audioFile={completedAudioFile}
          onBack={() => { setActiveSession(null); setState('home') }}
          onNewCall={() => {
            setActiveSession(null)
            window.darkscribe.session.create({ name: undefined }).then((session: any) => {
              setActiveSession({ id: session.id, name: session.name })
              setState('call')
            })
          }}
        />
      )
    }

    if (state === 'call' && activeSession) {
      return (
        <MainApp
          sessionId={activeSession.id}
          sessionName={activeSession.name}
          onEndCall={handleCallEnd}
          onBack={() => { setActiveSession(null); setState('home') }}
        />
      )
    }

    return null
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--surface-1)', paddingTop: 28 }}>
      <TopNav activeTab={activeTab} isCapturing={state === 'call' && !!activeSession} onNavigate={handleNav} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {renderContent()}
      </div>
    </div>
  )
}
