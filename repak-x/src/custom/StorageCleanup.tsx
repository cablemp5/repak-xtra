// repakxtra: Settings > Updates > Storage (backend: xtra_cleanup.rs). Lists what repakxtra keeps in %APPDATA%\Repak-X
// with each section's size and what deleting it costs. Nothing is picked at first, and Delete asks again, naming every
// section and its warning, before anything goes. Settings, loadouts, and Repak X's own files are never listed.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { HardDrive, TriangleAlert } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import Checkbox from '../components/ui/Checkbox'
import { size } from './SnapshotCard'

type Section = { id: string; bytes: number }

/** Each section's name, and what is lost for good. `safe`: rebuilt on its own, no warning color. */
const INFO: Record<string, { name: string; warn: string; safe?: boolean }> = {
  caches: { name: 'Caches and logs', warn: 'Rebuilt on their own. The next mod check reads the game files again and takes longer.', safe: true },
  previews: { name: 'Mod previews', warn: 'Every preview you made is gone. Making them again needs the preview kit and takes a while.' },
  kit: { name: 'Preview kit', warn: 'Previews cannot be made until you install the kit again in Setup.' },
  trash: { name: 'Recently deleted', warn: 'Deleted mods can no longer be restored.' },
  snapshots: { name: 'Snapshots', warn: 'Your mods folder can no longer be restored from them.' },
  encryption: { name: 'Encryption backups', warn: 'The unencrypted originals of mods you encrypted are gone for good.' },
  plugins: { name: 'Removed plugins', warn: 'Plugins the Ban risk check moved out can no longer be put back.' },
}

export default function StorageCleanup({ alert }: { alert: ReturnType<typeof useAlert> }) {
  const [sections, setSections] = useState<Section[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = () => invoke<Section[]>('xtra_storage_sections').then(setSections).catch(() => setSections([]))
  useEffect(() => { void load() }, [])
  const shown = (sections ?? []).filter(s => s.bytes > 0 && INFO[s.id])
  const chosen = shown.filter(s => picked.has(s.id))
  const total = chosen.reduce((n, s) => n + s.bytes, 0)
  const toggle = (id: string, on: boolean) => { setAsking(false); setPicked(p => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n }) }
  const clear = async () => {
    setBusy(true)
    try {
      const freed = await invoke<number>('xtra_storage_clear', { ids: chosen.map(s => s.id) })
      alert.success('Storage', `${size(freed)} freed.${chosen.some(s => s.id === 'previews' || s.id === 'kit') ? ' Restart repakxtra so previews are not shown from memory.' : ''}`)
      setPicked(new Set()); setAsking(false)
    } catch (e) { alert.warning('Could not free the space', String(e)) } finally { setBusy(false); void load() }
  }

  return (
    <div className="xs-row xs-storage">
      <div className="xs-text">
        <span className="xs-label">Storage</span>
        <span className="setting-subtext">
          What repakxtra keeps in %APPDATA%\Repak-X, {sections ? size(shown.reduce((n, s) => n + s.bytes, 0)) : '…'} in all. Your mods, settings, and loadouts are never part of it.
        </span>
        {shown.length > 0 && <div className="xs-storage-list">
          {shown.map(s => (
            <Checkbox key={s.id} checked={picked.has(s.id)} onChange={(v: boolean) => toggle(s.id, v)}>
              <span className="xs-storage-name">{INFO[s.id].name} <span className="xs-storage-size">{size(s.bytes)}</span></span>
              <span className={`setting-subtext${INFO[s.id].safe ? '' : ' xs-storage-warn'}`}>{INFO[s.id].warn}</span>
            </Checkbox>
          ))}
        </div>}
        {asking && chosen.length > 0 && (
          <div className="setting-warn xs-storage-confirm" role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            <div>
              <b>Delete {size(total)} for good? This cannot be undone.</b>
              <ul>{chosen.map(s => <li key={s.id}>{INFO[s.id].name}: {INFO[s.id].warn}</li>)}</ul>
              <div className="xs-buttons">
                <button type="button" className="action-btn" onClick={() => setAsking(false)}>Cancel</button>
                <button type="button" className="action-btn" disabled={busy} onClick={clear}>{busy ? 'Deleting…' : `Delete ${size(total)}`}</button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="xs-buttons">
        <button type="button" className="action-btn" disabled={!chosen.length || busy || asking} onClick={() => setAsking(true)}
          title={chosen.length ? 'Asks once more before anything is deleted' : 'Tick what to delete first'}>
          <HardDrive size={14} /> {chosen.length ? `Free ${size(total)}…` : 'Free space…'}
        </button>
      </div>
    </div>
  )
}
