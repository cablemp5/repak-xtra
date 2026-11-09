// repakxtra: Check Conflicts' Duplicates (xtra_dupes.rs): the same mod installed more than once, byte for byte or from the
// same download. Shown only when there are real duplicates, folded like the hidden mods below a clash (Occam). In each
// set one copy stays, picked for you (Hick): the one that is on, then the one in the most loadouts, then one with tags,
// then the original name over a numbered copy, then the newest. The other copies come checked, and one button moves them to Recently deleted.
import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import { formatFileSize } from '../utils/format'
import { modKey, nameKey, useLoadouts, type Loadout } from './loadoutStore'
import { canonKey } from './loadoutIdentity'
import { ModName } from './modName'
import { useShownBusy } from './shownBusy'
import { cue } from './sounds'

export type DupMod = { path: string; enabled?: boolean; custom_tags?: unknown; modified_date?: number; file_size?: number; folder_id?: string }

const copies = (n: number) => `${n} ${n === 1 ? 'copy' : 'copies'}`
const inLoadouts = (path: string, loadouts: Loadout[]) => {
  const k = modKey(path)
  return loadouts.filter(l => [...l.on, ...l.scope].some(x => canonKey(x) === k)).length
}
const tagged = (m: DupMod) => (Array.isArray(m.custom_tags) ? m.custom_tags.length > 0 : Boolean(m.custom_tags))

/** The copy that stays: on, then in the most loadouts, then tagged, then the one without a copy number ("Name" over
 *  "Name (1)"), then the newest. Pure. */
export function keeper(set: DupMod[], loadoutsOf: (path: string) => number) {
  const score = (m: DupMod) => [m.enabled ? 1 : 0, loadoutsOf(m.path), tagged(m) ? 1 : 0, / \(\d+\)$/.test(nameKey(m.path)) ? 0 : 1, m.modified_date ?? 0]
  return [...set].sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0 })[0]
}

export default function Duplicates({ mods, onRemove }: { mods: DupMod[]; onRemove?: (paths: string[]) => Promise<unknown> }) {
  const loadouts = useLoadouts()
  const [sets, setSets] = useState<string[][] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set()) // copies the user chose to keep after all
  const req = useRef(0)
  const load = () => {
    const id = ++req.current
    setFailed(false)
    invoke<string[][]>('xtra_find_duplicates').then(r => { if (id === req.current) setSets(r) }, () => { if (id === req.current) setFailed(true) })
  }
  useEffect(load, [])
  const spin = useShownBusy(sets === null && !failed)

  const byPath = useMemo(() => new Map(mods.map(m => [m.path.toLowerCase(), m])), [mods])
  const shown = useMemo(() => (sets ?? []).map(paths => {
    const set = paths.map(p => byPath.get(p.toLowerCase()) ?? { path: p })
    const stays = keeper(set, p => inLoadouts(p, loadouts))
    return { stays, rest: set.filter(m => m !== stays) }
  }).filter(s => s.rest.length > 0), [sets, byPath, loadouts])
  const picked = shown.flatMap(s => s.rest.map(m => m.path)).filter(p => !unchecked.has(p))

  if (spin) return <p className="su-note why-checking"><LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" /> Checking for duplicates…</p>
  if (failed) return <p className="su-note">Could not check for duplicates.</p>
  if (!shown.length) return null

  const remove = async () => {
    if (!onRemove || !picked.length) return
    setBusy(true)
    cue('close', { emphasis: 'strong' })
    try { await onRemove(picked) } finally { setBusy(false); setUnchecked(new Set()); load() }
  }
  const meta = (m: DupMod) => {
    const n = inLoadouts(m.path, loadouts)
    return [m.folder_id, m.enabled ? 'On' : 'Off', n ? `${n} ${n === 1 ? 'loadout' : 'loadouts'}` : ''].filter(Boolean).join(' · ')
  }
  return (
    <section className="cf-hidden" aria-labelledby="cf-dupes-title">
      <h3 id="cf-dupes-title" className="cf-section">
        <button type="button" aria-expanded={open} aria-controls="cf-dupes-list" onClick={() => setOpen(v => !v)}>
          <ChevronRight size={14} className="cf-caret" aria-hidden="true" />Duplicates<span className="cf-dupe-count">{shown.length}</span>
        </button>
      </h3>
      <div id="cf-dupes-list" className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)}>
        <div className="t-acc-panel-inner">
          <p className="cf-sub">The same mod installed more than once. The copy marked Stays is kept. The checked copies go to Recently deleted, where they wait 7 days.</p>
          {shown.map(({ stays, rest }) => (
            <section key={stays.path} className="cf-group">
              <div className="cf-head">
                <div className="cf-what">
                  <h3>{nameKey(stays.path)} is installed {rest.length + 1} times</h3>
                  <p>Same files{stays.file_size ? ` · ${formatFileSize(stays.file_size)} each` : ''}</p>
                </div>
              </div>
              <ul className="cf-mods">
                <li className="cf-mod">
                  <Checkbox size="sm" checked={false} tabIndex={-1} aria-hidden="true" style={{ visibility: 'hidden' }} />{/* keeps the names in one column */}
                  <span className="cf-mod-name" title={stays.path}><ModName name={nameKey(stays.path)} /></span>
                  <span className="cf-stays">Stays</span>
                  <span className="cf-dupe-meta">{meta(stays)}</span>
                </li>
                {rest.map(m => (
                  <li key={m.path} className={`cf-mod${m.enabled ? '' : ' is-off'}`}>
                    <Checkbox size="sm" color="primary" checked={!unchecked.has(m.path)} disabled={busy} aria-label={`Move ${nameKey(m.path)} to Recently deleted`}
                      onChange={(v: boolean) => setUnchecked(prev => { const next = new Set(prev); if (v) next.delete(m.path); else next.add(m.path); return next })} />
                    <span className="cf-mod-name" title={m.path}><ModName name={nameKey(m.path)} /></span>
                    <span className="cf-dupe-meta">{meta(m)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <div className="cf-dupe-actions">
            <button type="button" className="lo-text-btn cf-keep" disabled={busy || !picked.length || !onRemove} onClick={() => void remove()}>
              {busy ? <><LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" />Moving…</> : `Move ${copies(picked.length)} to Recently deleted`}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}

if (import.meta.env.DEV) {
  const none = () => 0
  console.assert(keeper([{ path: 'a', enabled: false, modified_date: 9 }, { path: 'b', enabled: true, modified_date: 1 }], none).path === 'b', 'the one that is on stays')
  console.assert(keeper([{ path: 'a', modified_date: 9 }, { path: 'b', modified_date: 1 }], p => (p === 'b' ? 2 : 0)).path === 'b', 'then the one in more loadouts')
  console.assert(keeper([{ path: 'a', modified_date: 9 }, { path: 'b', custom_tags: ['Mine'], modified_date: 1 }], none).path === 'b', 'then a tagged one')
  console.assert(keeper([{ path: 'm/A (1)_9999999_P.pak', modified_date: 9 }, { path: 'm/A_9999999_P.pak', modified_date: 1 }], none).path === 'm/A_9999999_P.pak', 'then the original name')
  console.assert(keeper([{ path: 'a', modified_date: 1 }, { path: 'b', modified_date: 9 }], none).path === 'b', 'then the newest')
}
