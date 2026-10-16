// repakxtra: loadouts in the install panel: each mod can join existing loadouts (InstallToLoadouts, in place of tags)
// and the whole install can be saved as a new loadout (InstallAsLoadout). The panel's options are a draft until Install
// is pressed (commitInstallLoadout); App's install flow calls finishInstallLoadout once the files are in place, which
// adds the mods that actually landed and, if asked, queues the new loadout's previews.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Plus } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import type { useAlert } from '../components/AlertHandler'
import { normalizeModBaseName } from '../utils/format'
import { type Mod, modKey, readLoadouts, useLoadouts, withMods, writeLoadouts } from './loadoutStore'
import { generatePreviews, previewSetKey } from './previews'

type Options = { name: string; preview: boolean }
let draft: Options | null = null   // what the open panel shows
let pending: Options | null = null // what the install in progress asked for

/** Install pressed: the panel's choice applies to this install (Cancel never gets here, so it never leaks). */
export const commitInstallLoadout = () => { pending = draft }

export function InstallAsLoadout({ count }: { count: number }) {
  const [on, setOn] = useState(false)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState(true)
  useEffect(() => { draft = on && count > 0 ? { name: name.trim() || 'New loadout', preview } : null }, [on, name, preview, count])
  useEffect(() => () => { draft = null }, [])
  if (count < 1) return null
  return (
    <div className="install-loadout">
      <Checkbox checked={on} onChange={(v: boolean) => setOn(v)} size="sm" color="primary">
        <span>{count === 1 ? 'Save as a new loadout' : `Save these ${count} mods as a new loadout`}</span>
      </Checkbox>
      {on && (
        <>
          <input className="install-loadout-name" value={name} placeholder="Loadout name" aria-label="Loadout name" autoFocus
            onChange={e => setName(e.target.value)} onKeyDown={e => e.stopPropagation()} />
          <Checkbox checked={preview} onChange={(v: boolean) => setPreview(v)} size="sm" color="primary">
            <span>Generate its preview</span>
          </Checkbox>
        </>
      )}
    </div>
  )
}

/** One mod's row in the install panel: the loadouts it joins once installed (ids, kept in the mod's settings). */
export function InstallToLoadouts({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const loadouts = useLoadouts()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!at) return
    const close = () => setAt(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [at])
  const rest = loadouts.filter(l => !ids.includes(l.id))
  return (
    <div className="install-mod-card__row">
      <span className="field-label">Add to loadout</span>
      <div className="tags-cell">
        <div className="tags-list">
          {loadouts.filter(l => ids.includes(l.id)).map(l => (
            <span key={l.id} className="tag">
              {l.name}
              <button type="button" className="tag-remove" aria-label={`Leave ${l.name}`} onClick={() => onChange(ids.filter(i => i !== l.id))}>×</button>
            </span>
          ))}
        </div>
        <div className="add-tag-wrapper" onClick={e => e.stopPropagation()}>
          <button type="button" className="add-tag-btn" title="Add to a loadout" aria-label="Add to a loadout" aria-expanded={Boolean(at)}
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom }) }}><Plus size={14} /></button>
          {at && (
            <div className="tag-dropdown install-loadout-menu" role="menu" style={{ position: 'fixed', top: at.y, left: at.x }}>
              {rest.length === 0
                ? <div className="dropdown-item is-empty">{loadouts.length ? 'Already in every loadout' : 'No loadouts yet'}</div>
                : rest.map(l => (
                  <button type="button" role="menuitem" key={l.id} className="dropdown-item" onClick={() => { onChange([...ids, l.id]); setAt(null) }}>
                    <span className="dropdown-item-label">{l.name}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** The installed file's loadout key, the same name App's install flow gives the file (normalizeModBaseName). */
export const installedKey = (m: { customName?: string; mod_name?: string }) =>
  modKey(`${normalizeModBaseName(m.customName || m.mod_name || 'Unnamed_Mod')}.pak`)

type Installed = { customName?: string; mod_name?: string; loadouts?: string[] }

/** Each loadout's id with the keys of the mods that join it (only mods found on disk). Pure. */
export const joinsByLoadout = (installed: Installed[], onDisk: Set<string>) => {
  const joins = new Map<string, string[]>()
  for (const m of installed) {
    const key = installedKey(m)
    if (onDisk.has(key)) for (const id of m.loadouts ?? []) joins.set(id, [...(joins.get(id) ?? []), key])
  }
  return joins
}

/** After a successful install: add the mods now on disk to the loadouts picked for them, make the new loadout, then
 *  queue its previews. */
export async function finishInstallLoadout(installed: Installed[], alert: ReturnType<typeof useAlert>) {
  const job = pending
  pending = null
  const joining = installed.filter(m => m.loadouts?.length)
  if (!job && joining.length === 0) return
  const all = await invoke<Mod[]>('get_pak_files').catch(() => [] as Mod[])
  if (joining.length) {
    const here = new Set(all.map(m => modKey(m.path)))
    const joins = joinsByLoadout(joining, here)
    writeLoadouts(readLoadouts().map(l => joins.has(l.id) ? { ...l, ...withMods(l, joins.get(l.id)!) } : l))
    const lost = joining.filter(m => !here.has(installedKey(m))).length
    if (lost) alert.warning('Not added to its loadout', `${lost} installed mod${lost === 1 ? ' was' : 's were'} not found in the mods folder.`)
  }
  if (!job) return
  const wanted = new Set(installed.map(installedKey))
  const onDisk = all.filter(m => wanted.has(modKey(m.path)))
  const keys = [...new Set(onDisk.map(m => modKey(m.path)))]
  if (keys.length === 0) {
    alert.warning('Loadout not created', `None of the ${wanted.size} installed mods were found in the mods folder.`)
    return
  }
  const id = crypto.randomUUID()
  writeLoadouts([...readLoadouts(), { id, name: job.name, label: 'Other', scope: keys, on: keys }])
  const missing = wanted.size - keys.length
  alert.success(`Loadout ${job.name} created`, `${keys.length} mod${keys.length === 1 ? '' : 's'}${missing ? `; ${missing} could not be found` : ''}.${job.preview ? ' Generating its preview.' : ''}`)
  if (!job.preview) return
  const error = await generatePreviews({ paths: onDisk.map(m => m.path), set: previewSetKey(id), name: job.name })
  if (error) alert.warning('Preview not started', error)
}

if (import.meta.env.DEV) {
  console.assert(installedKey({ customName: 'My Mod v2' }) === 'My_Mod_v2', 'installed key matches the file name the install writes')
  console.assert(installedKey({ mod_name: 'ElectricBluePantherIcons_UPDATED_9999999_P' }) === 'ElectricBluePantherIcons_UPDATED', 'existing priority suffix is dropped')
  const j = joinsByLoadout([{ customName: 'A', loadouts: ['x', 'y'] }, { customName: 'B', loadouts: ['x'] }, { customName: 'Gone', loadouts: ['x'] }], new Set(['A', 'B']))
  console.assert(j.get('x')?.join() === 'A,B' && j.get('y')?.join() === 'A' && j.size === 2, 'mods join their picked loadouts; missing ones are skipped')
}
