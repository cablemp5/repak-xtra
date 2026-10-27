import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/** Appears only when standard finds an older setup still enabled in the game. */
export default function LegacySetup({ gamePath, reload }: { gamePath: string; reload: () => void }) {
  const [items, setItems] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    invoke<string[]>('legacy_setup_status').then(value => { if (live) setItems(value) }).catch(() => {})
    return () => { live = false }
  }, [gamePath])
  if (!items.length) return null
  return <section className="legacy-setup" aria-label="Older setup">
    <strong>An older setup is still enabled</strong>
    <p>{items.join(', ')}. These stay installed after updating the app.</p>
    {confirming && <p>Disable these files and keep backups beside them? Your other mods and settings stay as they are. Close the game first.</p>}
    {error && <p role="alert">{error}</p>}
    <button className="btn-primary" disabled={busy} onClick={async () => {
      if (!confirming) { setConfirming(true); return }
      setBusy(true); setError('')
      try { await invoke('legacy_setup_disable'); setItems(await invoke<string[]>('legacy_setup_status')); reload() }
      catch (e) { setError(String(e)) }
      finally { setBusy(false) }
    }}>{busy ? 'Disabling…' : confirming ? 'Disable and keep backups' : 'Review older setup'}</button>
    {confirming && <button className="lo-text-btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>}
  </section>
}
