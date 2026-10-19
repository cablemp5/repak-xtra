// repakxtra: "Create desktop shortcut" (backend: xtra_shortcut.rs), offered on the first-launch setup and kept in
// Settings > General. A shortcut already on the desktop is never replaced, so the button then says it is there.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check } from 'lucide-react'
import { useAlert } from '../components/AlertHandler'

/** Whether repakxtra.lnk is on the desktop (null while asking), and the button that makes it. */
export function useShortcut() {
  const alert = useAlert()
  const [exists, setExists] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { invoke<{ exists: boolean }>('shortcut_status').then(s => setExists(s.exists)).catch(() => setExists(false)) }, [])
  const create = async () => {
    setBusy(true)
    try {
      await invoke('shortcut_create')
      setExists(true)
      alert.success('Desktop shortcut', 'repakxtra is on your desktop.')
    } catch (e) {
      alert.warning('Shortcut not made', String(e))
      invoke<{ exists: boolean }>('shortcut_status').then(s => setExists(s.exists)).catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }
  return { exists, busy, create }
}

/** The button: Create desktop shortcut, or a quiet "On the desktop" once there is one. `s` is the caller's useShortcut,
 *  so a step that shows it done updates when the shortcut is made. */
export function ShortcutButton({ s, className = 'lo-text-btn' }: { s: ReturnType<typeof useShortcut>; className?: string }) {
  return s.exists
    ? <span className="shortcut-done"><Check size={14} /> On the desktop</span>
    : <button type="button" className={className} disabled={s.exists === null || s.busy} onClick={s.create}
        title="Puts a repakxtra shortcut on your desktop (an existing one is never replaced)">
        {s.busy ? 'Creating…' : 'Create desktop shortcut'}
      </button>
}

/** Settings > General: the same button, in a section of its own. */
export function ShortcutSetting() {
  const s = useShortcut()
  return (
    <div className="setting-section">
      <h3>Desktop shortcut</h3>
      <div className="setting-group shortcut-setting">
        <p className="setting-hint">Start repakxtra from your desktop. An existing repakxtra shortcut stays as it is.</p>
        <ShortcutButton s={s} className="action-btn" />
      </div>
    </div>
  )
}
