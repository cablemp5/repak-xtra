import { useEffect, useRef, useState, type PropsWithChildren } from 'react'
import { invoke } from '@tauri-apps/api/core'
import Wordmark from './Wordmark'
import TitleBar from '../components/TitleBar'
import CableDiscord from './CableDiscord'

/** The app and secondary windows do not mount until Rust validates the saved receipt or code. */
export default function ExtendedAccess({ children }: PropsWithChildren) {
  const [unlocked, setUnlocked] = useState(false)
  const [checking, setChecking] = useState(true)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let live = true
    // App normally dismisses this splash, but it has not mounted on the locked screen.
    document.getElementById('splash-screen')?.remove()
    invoke<boolean>('extended_access_status').then(value => { if (live) setUnlocked(value) })
      .catch(() => { if (live) setError('Could not check access. Reopen the app and try again.') })
      .finally(() => { if (live) setChecking(false) })
    return () => { live = false }
  }, [])
  useEffect(() => { if (!checking && !unlocked) input.current?.focus() }, [checking, unlocked])
  if (unlocked) return <>{children}</>
  return <div className="app"><TitleBar title="repakxploit" /><main className="extended-access">
    <form className="extended-access-card" aria-label="Unlock repakxploit" onSubmit={async event => {
      event.preventDefault()
      const submitted = code
      setCode(''); setError(''); setBusy(true)
      try { await invoke('extended_unlock', { code: submitted }); setUnlocked(true) }
      catch { setError('Code not recognized, or access could not be saved.') }
      finally { setBusy(false) }
    }}>
      <Wordmark height={32} />
      <label htmlFor="extended-code">Key</label>
      <input ref={input} id="extended-code" type="password" value={code} autoComplete="off" maxLength={1024}
        disabled={checking || busy} onChange={event => setCode(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button className="btn-primary" type="submit" disabled={checking || busy || !code.trim()}>{checking ? 'Checking…' : busy ? 'Unlocking…' : 'Unlock'}</button>
      <div className="extended-access-community">
        <p>Get your key in cable's Discord server.</p>
        <CableDiscord claim={false} />
      </div>
    </form>
  </main></div>
}
