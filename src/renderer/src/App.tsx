import { useEffect, useState } from 'react'
import { api } from './lib'
import { Course } from './screens/Course'
import { Learn } from './screens/Learn'
import { Materials } from './screens/Materials'
import { Settings } from './screens/Settings'

type Screen = 'materials' | 'course' | 'learn' | 'settings'

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'materials', label: 'Materials' },
  { id: 'course', label: 'Course' },
  { id: 'learn', label: 'Learn' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const [screen, setScreen] = useState<Screen>('materials')

  // A lesson left part way reopens where it stopped.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const session = await api['sessions:current']()
      if (!session.ok || cancelled) return
      const open = await api['lesson:current']({ sessionId: session.value.id })
      if (!cancelled && open.ok && open.value) setScreen('learn')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">FeynMind</span>
        <nav aria-label="Main">
          {SCREENS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={screen === s.id ? 'nav-item active' : 'nav-item'}
              aria-current={screen === s.id ? 'page' : undefined}
              onClick={() => setScreen(s.id)}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {screen === 'materials' && <Materials />}
        {screen === 'course' && <Course />}
        {screen === 'learn' && <Learn />}
        {screen === 'settings' && <Settings />}
      </main>
    </div>
  )
}
