import { Settings } from './screens/Settings'

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">FeynMind</span>
      </header>
      <main className="app-main">
        <Settings />
      </main>
    </div>
  )
}
