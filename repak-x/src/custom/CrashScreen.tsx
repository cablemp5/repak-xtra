// repakxtra: a render error anywhere shows this instead of a blank window: Reload, and Copy error details (the error,
// where it happened, and the app version, without paths or ids) for a help message. The Logs drawer may be what broke,
// so the details are copied from here. It promises nothing about saved data: it cannot know what the error interrupted.
import { Component, type ReactNode } from 'react'
import { REPAKXTRA_VERSION } from './version'
import { scrub } from './scrub'
import { invoke } from '@tauri-apps/api/core'
import { APP_NAME } from './edition'

// CopySetupReport's copyText, without its imports: the crash may have come from one of them
const copyText = (text: string) => Promise.resolve().then(() => navigator.clipboard.writeText(text)).catch(() => invoke('copy_to_clipboard', { text }))

/** What Copy error details copies. Pure. */
export const errorDetails = (error: Error, where = '') => scrub([
  `${APP_NAME} ${REPAKXTRA_VERSION}: the window hit an error`,
  `${error.name}: ${error.message}`,
  ...(error.stack ?? '').split('\n').slice(1, 9).map(l => l.trim()).filter(Boolean),
  ...(where ? ['In:', ...where.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 6)] : []),
].join('\n'))

type State = { error: Error | null; where: string; copied: 'yes' | 'no' | null }
export default class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, where: '', copied: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('repakxtra: the window crashed', error)
    this.setState({ where: info.componentStack ?? '' })
    document.getElementById('splash-screen')?.remove() // a crash before the mod list loads would stay hidden under it
  }
  copy = () => {
    const { error, where } = this.state
    if (!error) return
    copyText(errorDetails(error, where)).then(() => this.setState({ copied: 'yes' }), () => this.setState({ copied: 'no' }))
  }
  render() {
    const { error, copied } = this.state
    if (!error) return this.props.children
    return (
      <div className="crash-screen" role="alert">
        <h2>Something broke on this screen</h2>
        <p>Reload to keep going. If it happens again, copy the error details and paste them in your help message.</p>
        <pre>{scrub(error.message)}</pre>
        <div className="crash-screen-actions">
          <button type="button" className="btn-primary" onClick={() => location.reload()}>Reload</button>
          <button type="button" className="btn-secondary" onClick={this.copy}>{copied === 'yes' ? 'Copied' : 'Copy error details'}</button>
        </div>
        {copied === 'no' && <p>Could not copy. Select the error above and copy it by hand.</p>}
      </div>
    )
  }
}

if (import.meta.env.DEV) {
  const e = new Error('Cannot read C:/Users/Alice/x.json'); e.stack = 'Error: x\n    at f (http://localhost/a.js:1:2)'
  const d = errorDetails(e, '\n    at ModList\n    at App')
  console.assert(d.includes('Error: Cannot read %USERPROFILE%') && !d.includes('Alice') && d.includes('at f (') && d.endsWith('In:\nat ModList\nat App'), 'error, stack, where, no user name', d)
}
