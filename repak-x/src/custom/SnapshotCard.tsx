// repakxtra: Setup's Snapshots card (backend: xtra_snapshot.rs). A full copy of ~mods and the bypass files, made before
// a Steam Verify integrity of game files, a reinstall, or a game update. Restore puts back only what is gone.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as pickFile } from '@tauri-apps/plugin-dialog'
import { History } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'

type Alert = ReturnType<typeof useAlert>
export type Snapshot = { id: string; created: number; files: number; bytes: number }

export const size = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : '0 bytes'
const when = (s: number) => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

export function SnapshotCard({ alert }: { alert: Alert }) {
  const [list, setList] = useState<Snapshot[] | null>(null)
  const [estimate, setEstimate] = useState<[number, number] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<string | null>(null) // the snapshot whose Delete asks first, in its own row
  const [failed, setFailed] = useState<string | null>(null)
  const refresh = () => {
    // a failed read says so, it never reads as None yet
    invoke<Snapshot[]>('snapshot_list').then(l => { setList(l); setFailed(null) }).catch(e => setFailed(String(e)))
    invoke<[number, number]>('snapshot_estimate').then(setEstimate).catch(() => {})
  }
  useEffect(refresh, [])
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what)
    try { await f() } catch (e) { alert.warning('Snapshots', String(e)) } finally { setBusy(null); refresh() }
  }
  const oldest = list && list.length >= 3 ? list[list.length - 1] : null // making one more drops it
  const make = () => run('make', async () => {
    const s = await invoke<Snapshot>('snapshot_create')
    alert.success('Snapshot saved', `${plural(s.files, 'file')}, ${size(s.bytes)}.${oldest ? ` The oldest one, from ${when(oldest.created)}, was removed.` : ''} You can verify game files in Steam now.`)
  })
  // a .zip of a snapshot or of mod files becomes the newest snapshot (snapshot_import keeps only mod files)
  const importZip = async () => {
    const f = await pickFile({ title: 'A snapshot or mod files zip', filters: [{ name: 'Zip', extensions: ['zip'] }] }).catch(() => null)
    if (typeof f !== 'string') return
    await run('import', async () => {
      const s = await invoke<Snapshot>('snapshot_import', { path: f })
      alert.success('Snapshot imported', `${plural(s.files, 'mod file')}, ${size(s.bytes)}. Restore puts them back when they go missing.`)
    })
  }
  const restore = (id: string) => run(`restore:${id}`, async () => {
    const r = await invoke<{ mods: number; setup: number }>('snapshot_restore', { id })
    alert.success('Snapshot restored', r.mods + r.setup === 0 ? 'Nothing was missing.'
      : [r.mods && `${plural(r.mods, 'mod file')} put back`, r.setup && `${plural(r.setup, 'bypass file')} put back`].filter(Boolean).join(', ') + '.')
  })
  const remove = (id: string) => run(`delete:${id}`, async () => { setAsking(null); await invoke('snapshot_delete', { id }) })
  const locked = Boolean(busy || asking)

  return (
    <section className="su-card su-snapshots">
      <div className="su-card-head">
        <div>
          <h3>Snapshots</h3>
          {/* one lede: what it is, when to make one, what Restore does (was two stacked paragraphs) */}
          <p>A full copy of your mods and the bypass files. Make one before you verify game files in Steam, reinstall, or move the game. Restore puts back only what went missing, so later changes stay.</p>
        </div>
        {/* optional, so None yet is the plain gray chip, not the blue one that means an install is needed */}
        <span className={`su-chip${list?.length ? ' is-installed' : ''}`}>{failed ? 'Unknown' : !list ? 'Checking…' : list.length ? `${list.length} saved` : 'None yet'}</span>
      </div>
      {failed && <p className="su-note">Could not read your snapshots. {failed} <button type="button" className="su-link" onClick={refresh}>Try again</button></p>}
      {list && list.length > 0 && <ul className="su-parts">
        {list.map(s => (
          <li key={s.id} className="su-part">
            <History size={16} className="su-risk-icon" aria-hidden="true" />
            <div className="su-part-text">
              <b>{when(s.created)}</b>
              <span>{plural(s.files, 'file')} · {size(s.bytes)}</span>
            </div>
            <span className="su-part-links">
              <button type="button" className="su-link" disabled={locked} onClick={() => restore(s.id)}
                title="Puts back the files this snapshot has that are gone now. Never overwrites a file">{busy === `restore:${s.id}` ? 'Restoring…' : 'Restore'}</button>
              <button type="button" className="su-link" disabled={locked} onClick={() => setAsking(s.id)}>{busy === `delete:${s.id}` ? 'Deleting…' : 'Delete'}</button>
            </span>
            {/* asks in its own row, naming it, like Setup's other removes (Law of Proximity) */}
            {asking === s.id && <div className="su-confirm su-row-confirm" role="alert">
              {/* one line, the same row and buttons as the bypass's Remove (Jakob's Law: one confirm look in Setup) */}
              <span>Delete the {when(s.created)} snapshot ({size(s.bytes)})? Your mods stay.</span>
              <button type="button" className="lo-text-btn" autoFocus onClick={() => setAsking(null)}>Cancel</button>
              <button type="button" className="lo-text-btn" onClick={() => remove(s.id)}>Delete</button>
            </div>}
          </li>
        ))}
      </ul>}
      <div className="su-actions">
        {/* only once the list is read: its warning about the oldest one has to be right before a snapshot can drop it */}
        <button type="button" className="btn-primary su-main" disabled={locked || !list || Boolean(failed)} onClick={make}>{busy === 'make' ? 'Copying…' : 'Make a snapshot'}</button>
        <button type="button" className="lo-text-btn" disabled={locked || !list} onClick={importZip}>{busy === 'import' ? 'Importing…' : 'Import a snapshot…'}</button>
        {list && <span className="su-meta">{estimate ? `${plural(estimate[0], 'file')}, about ${size(estimate[1])} each. ` : ''}{oldest ? `Making one removes the oldest, from ${when(oldest.created)}.` : 'The newest 3 are kept.'}</span>}
      </div>
      <p className="su-note">Import takes a .zip of a snapshot or of mod files. Only the mod files come in, never the loader or plugins.</p>
    </section>
  )
}

/** At start: when much of the newest snapshot is gone (a verify, reinstall, or update), offer to open Setup and restore. */
let lossChecked = false // once per app start, even when React mounts Setup's button twice
export function checkSnapshotLoss(alert: Alert, openSetup: () => void) {
  if (lossChecked) return
  lossChecked = true
  invoke<[Snapshot, number, number] | null>('snapshot_missing').then(r => {
    if (!r) return
    const [s, mods, setup] = r
    // shortcut: half the snapshot gone stands in for "not a few deliberate deletes", tune it if people report noise
    if (mods * 2 < s.files && setup === 0) return
    const what = [mods && plural(mods, 'mod file'), setup && plural(setup, 'bypass file')].filter(Boolean).join(' and ')
    const id = alert.warning('Files missing since your snapshot', `${what} from your snapshot of ${when(s.created)} are gone. A game update or a Steam verify can do this. If you removed them yourself, make a new snapshot to stop this notice.`, {
      duration: 15000,
      action: { label: 'Restore…', onClick: () => { alert.dismissAlert(id); openSetup() } },
    })
  }).catch(() => {})
}
