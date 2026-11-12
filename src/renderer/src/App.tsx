import { useState } from 'react'
import { Materials } from './screens/Materials'
import { Settings } from './screens/Settings'

type Screen = 'materials' | 'settings'

const SCREENS: { id: Screen; label: string }[] = [
  { id: 'materials', label: 'Materials' },
  { id: 'settings', label: 'Settings' }
]

export function App() {
  const [screen, setScreen] = useState<Screen>('materials')
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
      <main className="app-main">{screen === 'materials' ? <Materials /> : <Settings />}</main>
    </div>
  )
}
