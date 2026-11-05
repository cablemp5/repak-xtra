// repakxtra: Setup's Snapshots card (backend: xtra_snapshot.rs). A full copy of ~mods and the bypass files, made before
// a Steam Verify integrity of game files, a reinstall, or a game update. Restore puts back only what is gone.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'
import { savedItem } from './storageCarryOver'

type Alert = ReturnType<typeof useAlert>
export type Snapshot = { id: string; created: number; files: number; bytes: number }

export const size = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`
const when = (s: number) => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function SnapshotCard({ alert }: { alert: Alert }) {
  const [list, setList] = useState<Snapshot[] | null>(null)
  const [estimate, setEstimate] = useState<[number, number] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null) // the snapshot whose Delete asks first
  const refresh = () => {
    invoke<Snapshot[]>('snapshot_list').then(setList).catch(() => setList([]))
    invoke<[number, number]>('snapshot_estimate').then(setEstimate).catch(() => {})
  }
  useEffect(refresh, [])
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what)
    try { await f() } catch (e) { alert.warning('Snapshots', String(e)) } finally { setBusy(null); refresh() }
  }
  const make = () => run('make', async () => {
    const s = await invoke<Snapshot>('snapshot_create')
    alert.success('Snapshot saved', `${plural(s.files, 'file')}, ${size(s.bytes)}. You can verify game files in Steam now.`)
  })
  const restore = (id: string) => run(id, async () => {
    const r = await invoke<{ mods: number; setup: number }>('snapshot_restore', { id })
    alert.success('Snapshot restored', r.mods + r.setup === 0 ? 'Nothing was missing.'
      : [r.mods && `${plural(r.mods, 'mod file')} put back`, r.setup && `${plural(r.setup, 'bypass file')} put back`].filter(Boolean).join(', ') + '.')
  })
  const remove = (id: string) => run(id, async () => { setAsking(null); await invoke('snapshot_delete', { id }) })

  return (
    <section className="su-card su-snapshots">
      <div className="su-card-head">
        <div>
          <h3>Snapshots</h3>
          <p>A full copy of your mods and the bypass files. Restore puts back only what is missing, so later changes stay.</p>
        </div>
        <span className={`su-chip ${list?.length ? 'is-installed' : 'is-missing'}`}>{!list ? 'Checking…' : list.length ? `${list.length} saved` : 'None yet'}</span>
      </div>
      <p className="su-note">Before you run Verify integrity of game files in Steam, reinstall, or move the game: make a snapshot here. If mods or the bypass are missing afterwards, come back and press Restore.</p>
      {list && list.length > 0 && <ul className="su-parts">
        {list.map(s => (
          <li key={s.id} className="su-part">
            <div className="su-part-text">
              <b>{when(s.created)}</b>
              <span>{plural(s.files, 'file')} · {size(s.bytes)}</span>
            </div>
            <span className="su-part-links">
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => restore(s.id)}
                title="Puts back the files this snapshot has that are gone now. Never overwrites a file">{busy === s.id ? 'Restoring…' : 'Restore'}</button>
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => setAsking(s.id)}>Delete</button>
            </span>
          </li>
        ))}
      </ul>}
      {/* asks in the card like Setup's other removes (its ConfirmRow) */}
      {asking && <div className="su-confirm" role="alert">
        <span>Delete this snapshot? Its copies are gone for good. Your mods stay as they are.</span>
        <button type="button" className="lo-text-btn" onClick={() => setAsking(null)}>Cancel</button>
        <button type="button" className="lo-text-btn" onClick={() => remove(asking)}>Delete</button>
      </div>}
      <div className="su-actions">
        <button type="button" className="btn-primary su-main" disabled={Boolean(busy)} onClick={make}>{busy === 'make' ? 'Copying…' : 'Make a snapshot'}</button>
        {estimate && <span className="su-meta">{plural(estimate[0], 'file')}, about {size(estimate[1])} of disk space. The newest 3 are kept.</span>}
      </div>
    </section>
  )
}

const SEEN = 'repakxtra.snapshot.lossSeen'
/** At start: when much of the newest snapshot is gone (a verify, reinstall, or update), offer to open Setup and restore. */
let lossChecked = false // once per app start, even when React mounts Setup's button twice
export function checkSnapshotLoss(alert: Alert, openSetup: () => void) {
  if (lossChecked) return
  lossChecked = true
  invoke<[Snapshot, number, number] | null>('snapshot_missing').then(r => {
    if (!r) return
    const [s, mods, setup] = r
    const key = `${s.id}:${mods}:${setup}`
    // shortcut: half the snapshot gone stands in for "not a few deliberate deletes", tune it if people report noise
    if ((mods * 2 < s.files && setup === 0) || savedItem(SEEN) === key) return
    try { localStorage.setItem(SEEN, key) } catch { /* private window: it may ask again */ }
    const what = [mods && plural(mods, 'mod file'), setup && plural(setup, 'bypass file')].filter(Boolean).join(' and ')
    const id = alert.warning('Files missing since your snapshot', `${what} from your snapshot of ${when(s.created)} are gone. A game update or a Steam verify can do this.`, {
      duration: 15000,
      action: { label: 'Restore…', onClick: () => { alert.dismissAlert(id); openSetup() } },
    })
  }).catch(() => {})
}
