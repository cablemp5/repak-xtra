// repakxtra: Settings > Recently deleted (backend: xtra_trash.rs). A deleted mod waits in repakxtra's trash for 7 days,
// then goes for good; here it can be put back where it was, or deleted now. The delete toast's Undo does the same for
// the last delete. Deleted loadouts wait 7 days too (loadoutStore.ts deleteLoadout), listed below the mods: a separate
// kind of recovery, kept in storage (no files move).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useAlert } from '../components/AlertHandler'
import { formatFileSize } from '../utils/format'
import { type DeletedLoadout, forgetDeleted, nameKey, restoreLoadout, useDeletedLoadouts } from './loadoutStore'
import { ModName, plural } from './modName'

type Trashed = { id: string; paths: string[]; size: number; deleted: number; expires: number }

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
/** "5 minutes ago", "yesterday", "in 6 days": seconds since 1970 against now. */
export const relative = (secs: number, now = Date.now() / 1000) => {
  const d = secs - now
  const a = Math.abs(d)
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] = a < 60 ? [d, 'second'] : a < 3600 ? [d / 60, 'minute'] : a < 86400 ? [d / 3600, 'hour'] : [d / 86400, 'day']
  return a < 45 ? 'just now' : rtf.format(Math.round(n), unit)
}

export default function RecentlyDeleted() {
  const alert = useAlert()
  const [items, setItems] = useState<Trashed[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [asking, setAsking] = useState<string | null>(null) // the row whose delete-for-good waits for a yes
  const load = () => invoke<Trashed[]>('list_trashed_mods').then(setItems).catch(e => { setItems([]); alert.warning('Recently deleted', String(e)) })
  useEffect(() => { load() }, [])
  const name = (t: Trashed) => nameKey(t.paths[0])

  /** The backend refuses while the game runs or Repak X is open, and says so. */
  const restore = async (t: Trashed) => {
    setBusy(t.id)
    try {
      await invoke('restore_trashed_mods', { ids: [t.id] })
      alert.success('Restored', `${name(t)} is back in the mods folder.`)
    } catch (e) {
      alert.error('Not restored', String(e))
    } finally {
      setBusy(null)
      load()
    }
  }
  const remove = async (ids: string[]) => {
    setBusy(ids.length === 1 ? ids[0] : 'all')
    setConfirm(false)
    setAsking(null)
    try {
      await invoke('empty_trashed_mods', { ids })
    } catch (e) {
      alert.error('Not deleted', String(e))
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><Trash2 size={18} aria-hidden="true" />Recently deleted</h3>
      <p className="setting-subtext">Deleted mods stay here for 7 days, then they are deleted for good. Restore puts a mod back where it was.</p>
      <div className="setting-group">
        {items === null
          ? <p className="rd-empty">Loading…</p>
          : items.length === 0
            ? <p className="rd-empty">Nothing deleted in the last 7 days.</p>
            : (
              <ul className="rd-list">
                {items.map(t => (
                  <li key={t.id} className="rd-row">
                    <div className="rd-text">
                      <span className="rd-name" title={t.paths.join('\n')}><ModName name={name(t)} /></span>
                      <span className="rd-meta">
                        Deleted {relative(t.deleted)} · {formatFileSize(t.size)}{t.paths.length > 1 ? ` · ${plural(t.paths.length, 'file')}` : ''} · gone {relative(t.expires)}
                      </span>
                    </div>
                    {asking === t.id
                      ? <>
                          <span className="rd-ask" role="alert">Delete for good?</span>
                          <button type="button" className="lo-text-btn" onClick={() => setAsking(null)}>Keep</button>
                          <button type="button" className="lo-text-btn" disabled={Boolean(busy)} onClick={() => remove([t.id])}>Delete</button>
                        </>
                      : <>
                          <button type="button" className="lo-text-btn" disabled={Boolean(busy)} onClick={() => restore(t)}>
                            <RotateCcw size={14} /> {busy === t.id ? 'Restoring…' : 'Restore'}
                          </button>
                          <button type="button" className="lo-icon" disabled={Boolean(busy)} onClick={() => setAsking(t.id)}
                            title={`Delete ${name(t)} for good`} aria-label={`Delete ${name(t)} for good`}>
                            <Trash2 size={14} />
                          </button>
                        </>}
                  </li>
                ))}
              </ul>
            )}
        {items && items.length > 0 && (
          confirm
            ? (
              <div className="rd-confirm" role="alert">
                <span>Delete all {plural(items.length, 'mod')} in the trash for good? This cannot be undone.</span>
                <button type="button" className="lo-text-btn" onClick={() => setConfirm(false)}>Keep them</button>
                <button type="button" className="lo-text-btn" onClick={() => remove(items.map(t => t.id))}>Delete all</button>
              </div>
            )
            : <button type="button" className="lo-text-btn rd-empty-btn" disabled={Boolean(busy)} onClick={() => setConfirm(true)}>
                {busy === 'all' ? 'Emptying…' : 'Empty trash'}
              </button>
        )}
      </div>
      <DeletedLoadouts />
    </div>
  )
}

/** Deleted loadouts: Restore puts one back where it was (its mods are not switched), Delete for good drops it and its
 *  pictures now. */
function DeletedLoadouts() {
  const alert = useAlert()
  const items = useDeletedLoadouts()
  const [asking, setAsking] = useState<string | null>(null)
  const restore = (r: DeletedLoadout) => {
    try {
      const done = restoreLoadout(r.loadout.id)
      if (!done) return
      const notes = [
        done.already ? `${done.name} is already with your loadouts.` : `${done.name} is back with your loadouts. Its mods were not switched.`,
        done.unsorted ? 'Its collection is gone, so it is in Unsorted.' : '',
        done.lostHotkey ? `Ctrl+${done.lostHotkey} stays with the loadout that has it now.` : '',
      ]
      alert.success('Restored', notes.filter(Boolean).join(' '))
    } catch (e) {
      alert.warning('Not restored', String(e))
    }
  }
  const forget = (r: DeletedLoadout) => {
    setAsking(null)
    try { forgetDeleted([r.loadout.id]) } catch (e) { alert.warning('Not deleted', String(e)) }
  }
  return (
    <>
      <h3 className="setting-icon-label"><Trash2 size={18} aria-hidden="true" />Deleted loadouts</h3>
      <p className="setting-subtext">Deleted loadouts stay here for 7 days, then they are deleted for good. Restore puts one back with its mods and pictures, and switches no mods.</p>
      <div className="setting-group">
        {items === null
          ? <p className="rd-empty">The deleted loadouts could not be read. Nothing is cleaned up until they can.</p>
          : items.length === 0
            ? <p className="rd-empty">No loadouts deleted in the last 7 days.</p>
            : (
              <ul className="rd-list">
                {items.map(r => (
                  <li key={r.loadout.id} className="rd-row">
                    <div className="rd-text">
                      <span className="rd-name">{r.loadout.name}</span>
                      <span className="rd-meta">
                        Deleted {relative(r.deleted / 1000)} · {plural(r.loadout.on.length, 'mod')} · gone {relative(r.expires / 1000)}
                      </span>
                    </div>
                    {asking === r.loadout.id
                      ? <>
                          <span className="rd-ask" role="alert">Delete for good?</span>
                          <button type="button" className="lo-text-btn" onClick={() => setAsking(null)}>Keep</button>
                          <button type="button" className="lo-text-btn" onClick={() => forget(r)}>Delete</button>
                        </>
                      : <>
                          <button type="button" className="lo-text-btn" onClick={() => restore(r)}>
                            <RotateCcw size={14} /> Restore
                          </button>
                          <button type="button" className="lo-icon" onClick={() => setAsking(r.loadout.id)}
                            title={`Delete ${r.loadout.name} for good`} aria-label={`Delete ${r.loadout.name} for good`}>
                            <Trash2 size={14} />
                          </button>
                        </>}
                  </li>
                ))}
              </ul>
            )}
      </div>
    </>
  )
}

if (import.meta.env.DEV) {
  console.assert(relative(1000, 1010) === 'just now' && /2/.test(relative(0, 7200)) && /6/.test(relative(6 * 86400 + 100, 100)), 'relative times')
}
