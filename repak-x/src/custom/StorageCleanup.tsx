// repakxtra: Settings > General > Storage (backend: xtra_cleanup.rs), its own section. Lists what repakxtra keeps on
// this PC with each section's size and what deleting it costs. Nothing is picked at first. The button under the list
// asks again in place, in one line, before anything goes (Law of Proximity: the action sits with what it acts on). Two sections (the VFX game files in %TEMP%, the window's browser caches) are in use while the app runs:
// picking them marks them, and they clear at the next start. Settings, loadouts, and Repak X's own files are never listed.
import ConfirmRow from './ConfirmRow'
import { Fragment, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { HardDrive } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import Checkbox from '../components/ui/Checkbox'
import { APP_NAME } from './edition'
import { size } from './SnapshotCard'

type Section = { id: string; bytes: number; pending: boolean }

/** Each section's name, and what deleting it does. */
const INFO: Record<string, { name: string; warn: string }> = {
  caches: { name: 'Caches', warn: 'The next mod check reads the game files again and takes longer.' },
  'preview-work': { name: 'Preview work files', warn: 'The next preview run takes longer while it rebuilds its cache.' },
  vfx: { name: 'VFX game files', warn: 'The next mod check or VFX update decodes the game again and takes longer.' },
  browser: { name: 'Browser cache', warn: 'The window loads a little slower the first time. Nothing you saved is lost.' },
  previews: { name: 'Mod previews', warn: 'Deletes every preview you made. Making them again needs the preview kit and takes a while.' },
  kit: { name: 'Preview kit', warn: 'Previews cannot be made until you install the kit again in Setup.' },
  trash: { name: 'Recently deleted', warn: 'Mods you deleted can no longer be restored.' },
  snapshots: { name: 'Snapshots', warn: 'Your mods folder can no longer be restored from them.' },
  encryption: { name: 'Encryption backups', warn: 'Deletes the unencrypted originals of mods you encrypted, for good.' },
  plugins: { name: 'Removed plugins', warn: 'Plugins the Ban risk check moved out can no longer be put back.' },
}
/** Two groups under their own titles (Law of Common Region, Law of Proximity): what the app rebuilds by itself first,
 *  the safe pick (Hick's Law), then what only the person can bring back. */
const GROUPS: { title: string; ids: string[] }[] = [
  { title: `Rebuilt by ${APP_NAME} on its own`, ids: ['caches', 'preview-work', 'vfx', 'browser'] },
  { title: 'What you made or kept', ids: ['previews', 'kit', 'trash', 'snapshots', 'encryption', 'plugins'] },
]
/** Sections that clear at the next start (xtra_storage_clear_at_start), the rest clear now. */
const AT_START = new Set(['vfx', 'browser'])
const AT_NEXT_START = `the next time ${APP_NAME} starts`

export default function StorageCleanup({ alert }: { alert: ReturnType<typeof useAlert> }) {
  const [sections, setSections] = useState<Section[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  // a failed read keeps the last list and says so, instead of looking empty
  const load = () => invoke<Section[]>('xtra_storage_sections').then(s => { setSections(s); setFailed(null) }).catch(e => setFailed(String(e)))
  useEffect(() => { void load() }, [])
  const shown = (sections ?? []).filter(s => s.bytes > 0 && INFO[s.id])
  const chosen = shown.filter(s => picked.has(s.id))
  const sum = (l: Section[]) => l.reduce((n, s) => n + s.bytes, 0)
  const now = chosen.filter(s => !AT_START.has(s.id)), later = chosen.filter(s => AT_START.has(s.id))
  const total = sum(chosen)
  const toggle = (id: string, on: boolean) => setPicked(p => { const n = new Set(p); on ? n.add(id) : n.delete(id); return n })
  const clear = async () => {
    setBusy(true)
    try {
      // the files in use are only marked, after the clear-now part went (a busy error leaves nothing marked)
      const freed = now.length ? await invoke<number>('xtra_storage_clear', { ids: now.map(s => s.id) }) : 0
      const marked = later.length ? await invoke<number>('xtra_storage_clear_at_start', { ids: later.map(s => s.id) }) : 0
      const what = [now.length ? `${size(freed)} freed` : '', later.length ? `${size(marked)}${now.length ? ' more' : ''} clears ${AT_NEXT_START}` : ''].filter(Boolean).join(', and ')
      alert.success('Storage', `${what}.${now.some(s => s.id === 'previews' || s.id === 'kit') ? ` Restart ${APP_NAME} so previews are not shown from memory.` : ''}`)
      setPicked(new Set()); setAsking(false)
    } catch (e) { alert.warning('Could not free the space', String(e)) } finally { setBusy(false); void load() }
  }
  // one or two picks are named, more are counted, then one consequence at most (Miller's Law) and the now/next-start split
  const names = chosen.map(s => INFO[s.id].name)
  const kept = chosen.filter(s => GROUPS[1].ids.includes(s.id))
  const question = `Delete ${names.length <= 2 ? names.join(' and ') : `${names.length} sections`} (${size(total)})?`
    + (kept.length === 1 ? ` ${INFO[kept[0].id].warn}` : kept.length > 1 ? ' This cannot be undone.' : '')
    + (later.length ? (now.length ? ` ${size(sum(later))} of it clears ${AT_NEXT_START}.` : ` It clears ${AT_NEXT_START}.`) : '')
  const row = (s: Section) => s.pending ? (
    // marked already: a locked, ticked box with the reason in place of the warning, so its unchanged size is no surprise
    <Checkbox key={s.id} checked isDisabled>
      <span className="xs-storage-name">{INFO[s.id].name} <span className="xs-storage-size">{size(s.bytes)}</span></span>
      <span className="xs-storage-note">Clears {AT_NEXT_START}.</span>
    </Checkbox>
  ) : (
    <Checkbox key={s.id} checked={picked.has(s.id)} disabled={busy || asking} onChange={(v: boolean) => toggle(s.id, v)}>
      <span className="xs-storage-name">{INFO[s.id].name} <span className="xs-storage-size">{size(s.bytes)}</span></span>
      <span className="xs-storage-note">{INFO[s.id].warn}</span>
    </Checkbox>
  )

  return (
    <div className="setting-section xs-storage">
      <h3 className="setting-icon-label"><HardDrive size={18} aria-hidden="true" />Storage</h3>
      <div className="setting-group">
        <p className="setting-subtext">
          What {APP_NAME} keeps on this PC{sections ? `, ${size(sum(shown))} in all` : ''}. Your mods, settings, and loadouts are never part of it.
        </p>
        {!sections && !failed && <p className="setting-subtext">Measuring…</p>}
        {failed && <p className="setting-subtext xs-storage-fail">Could not measure the storage. {failed} <button type="button" className="su-link" onClick={() => void load()}>Try again</button></p>}
        {shown.length > 0 && <div className="xs-storage-list">
          {GROUPS.map(g => {
            const rows = shown.filter(s => g.ids.includes(s.id))
            return rows.length > 0 && <Fragment key={g.title}><span className="xs-storage-group">{g.title}</span>{rows.map(row)}</Fragment>
          })}
        </div>}
        {asking && chosen.length > 0 ? (
          // the same one-line question and plain buttons as Setup's removes (Jakob's Law: one confirm look in the app)
          <ConfirmRow className="xs-storage-confirm" text={question} yes={busy ? 'Deleting…' : 'Delete'} busy={busy} onYes={() => void clear()} onNo={() => setAsking(false)} />
        ) : shown.length > 0 && (
          <div className="xs-buttons xs-storage-actions">
            <button type="button" className="action-btn settings-reset-btn" disabled={!chosen.length || busy} onClick={() => setAsking(true)}
              title={chosen.length ? 'Asks once more before anything is deleted' : 'Tick what to delete first'}>
              <HardDrive size={14} /> {chosen.length ? `Delete ${size(total)}` : 'Delete'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
