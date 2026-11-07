// repakxtra: a render error anywhere shows this instead of a blank window, with the error to report and a Reload.
import { Component, type ReactNode } from 'react'

export default class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) {
    console.error('repakxtra: the window crashed', error)
    document.getElementById('splash-screen')?.remove() // a crash before the mod list loads would stay hidden under it
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <h2>Something broke on this screen</h2>
        <p>Your mods and loadouts are safe. Reload to keep going.</p>
        <pre>{error.message}</pre>
        <button type="button" className="btn-primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
