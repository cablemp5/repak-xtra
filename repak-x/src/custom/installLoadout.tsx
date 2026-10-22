// repakxtra: loadouts in the install panel (custom/InstallPanel.tsx): each mod can join existing loadouts (InstallToLoadouts)
// and the whole install is saved as a new loadout unless unticked (InstallAsLoadout). The panel's options are a draft until Install
// is pressed (commitInstallLoadout); App's install flow calls finishInstallLoadout once the files are in place, which
// adds the mods that actually landed and, if asked, queues the new loadout's previews.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { Plus, X } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import type { useAlert } from '../components/AlertHandler'
import { normalizeModBaseName } from '../utils/format'
import { type Mod, displayName, memberName, modKey, nameKey, openLoadout, openLoadoutId, readLoadouts, useLoadouts, withMods, writeLoadouts } from './loadoutStore'
import { plural } from './modName'
import { PreviewsUnavailable, generatePreviews, previewSetKey, usePreviewsAvailable } from './previews'

/** A new loadout (name, collection) or an existing one the mods join (into), and whether to render its preview. */
type Options = { name: string; preview: boolean; label?: string } | { into: string; preview: boolean }
let draft: Options | null = null   // what the open panel shows
let pending: Options | null = null // what the install in progress asked for
let before: Promise<Set<string> | null> | null = null // the mods folder just before that install
const draftListeners = new Set<() => void>()
const setDraft = (next: Options | null) => {
  if (JSON.stringify(next) === JSON.stringify(draft)) return
  draft = next
  draftListeners.forEach(l => l())
}

/** Install pressed: the panel's choice applies to this install (Cancel never gets here, so it never leaks). The mods
 *  folder is listed now, before the files land, so what is new afterwards counts as installed whatever its name. */
export const commitInstallLoadout = () => {
  pending = draft
  before = invoke<Mod[]>('get_pak_files').then(l => new Set(l.map(m => modKey(m.path))), () => null)
}

/** The install dialog's choice (custom/InstallPanel.tsx), or null to install without a loadout. */
export const setInstallDraft = (next: Options | null) => setDraft(next)

/** The new loadout the open panel will make, if any (its footer says so in words). */
export const useInstallLoadoutDraft = () =>
  useSyncExternalStore(l => { draftListeners.add(l); return () => { draftListeners.delete(l) } }, () => draft)

/** The install's outcome: save the mods as a new loadout and generate its preview, both on by default (off when
 *  installing from a loadout's page, whose loadout the mods join). The name field shows the suggested name until
 *  something is typed. */
export function InstallAsLoadout({ count, suggested = 'New loadout', startOn = true }: { count: number; suggested?: string; startOn?: boolean }) {
  const [on, setOn] = useState(startOn)
  const [name, setName] = useState('')
  const [preview, setPreview] = useState(true)
  const canGenerate = usePreviewsAvailable() // no preview kit: nothing is queued, and the row says where to set it up
  useEffect(() => { setDraft(on && count > 0 ? { name: name.trim() || suggested, preview: preview && canGenerate } : null) }, [on, name, preview, count, canGenerate, suggested])
  useEffect(() => () => setDraft(null), [])
  if (count < 1) return null
  return (
    <section className={`ip-loadout${on ? '' : ' is-off'}`} aria-label="After installing">
      <Checkbox checked={on} onChange={(v: boolean) => setOn(v)} size="sm" color="primary" className="ip-loadout-check">
        <span>{count === 1 ? 'Save as a new loadout' : `Save these ${count} mods as a new loadout`}</span>
      </Checkbox>
      <input className="ip-loadout-name" value={name} placeholder={suggested} aria-label="New loadout name" disabled={!on} spellCheck={false}
        onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key !== 'Enter') e.stopPropagation() }} />
      {canGenerate
        ? <Checkbox checked={preview} onChange={(v: boolean) => setPreview(v)} size="sm" color="primary" isDisabled={!on} disabled={!on} className="ip-loadout-check">
            <span>Generate its preview</span>
          </Checkbox>
        : <PreviewsUnavailable className="lo-text-btn ip-loadout-setup" label="Preview" />}
    </section>
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
    <div className="ip-field ip-joins">
      <span className="ip-label">Add to</span>
      {loadouts.filter(l => ids.includes(l.id)).map(l => (
        <span key={l.id} className="ip-chip">
          {l.name}
          <button type="button" aria-label={`Do not add to ${l.name}`} title={`Do not add to ${l.name}`} onClick={() => onChange(ids.filter(i => i !== l.id))}><X size={12} /></button>
        </span>
      ))}
      <span className="ip-join-wrap" onClick={e => e.stopPropagation()}>
        <button type="button" className={`ip-join${ids.length ? ' is-icon' : ''}`} aria-haspopup="menu" aria-expanded={Boolean(at)}
          title="Also add this mod to a loadout you have"
          onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAt(at ? null : { x: r.left, y: r.bottom + 4 }) }}>
          <Plus size={13} />{ids.length ? null : <span>Loadout</span>}
        </button>
        {/* On the page itself: inside the dialog's moving (transformed) sheet a fixed menu would be placed from the sheet */}
        {at && createPortal(
          <div className="sigeon-menu ip-join-menu" role="menu" style={{ position: 'fixed', top: at.y, left: at.x }} onClick={e => e.stopPropagation()}>
            {rest.length === 0
              ? <div className="ip-join-empty">{loadouts.length ? 'Already in every loadout' : 'No loadouts yet'}</div>
              : rest.map(l => (
                <button type="button" role="menuitem" key={l.id} className="sigeon-item" onClick={() => { onChange([...ids, l.id]); setAt(null) }}>
                  {l.name}
                </button>
              ))}
          </div>, document.body)}
      </span>
    </div>
  )
}

/** The installed file's name, the same name App's install flow gives the file (normalizeModBaseName). */
export const installedKey = (m: { customName?: string; mod_name?: string }) =>
  nameKey(`${normalizeModBaseName(m.customName || m.mod_name || 'Unnamed_Mod')}.pak`)

type Installed = { path?: string; customName?: string; mod_name?: string; loadouts?: string[] }
type Landed = { keys: string[]; loadouts?: string[] }

/** One spelling per name for matching: the backend keeps a name as typed ("mesh+matSwap", spaces) where
 *  normalizeModBaseName drops such characters, so only letters and digits count. */
export const looseKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The keys an install source may land under: the name the panel showed, and each pak inside it (an archive or folder
 *  installs its paks under their own names, not the archive's). */
const landedKeys = (m: Installed, paks: string[] = []) => [...new Set([installedKey(m), ...paks.map(p => installedKey({ mod_name: p }))])]

/** The on-disk member keys an install source landed under: its expected names matched loosely against the mods
 *  folder's (a file new since the install started wins a name two folders hold), or (one source installed, nothing
 *  matched) the files that are new since the install started. Pure. */
export const resolveLanded = (expected: string[], onDisk: Set<string>, fresh: string[]) => {
  const byLoose = new Map([...onDisk, ...fresh].map(k => [looseKey(memberName(k)), k]))
  const keys = [...new Set(expected.map(k => byLoose.get(looseKey(k))).filter((k): k is string => Boolean(k)))]
  return keys.length ? keys : fresh
}

/** Each loadout's id with the keys of the mods that join it (only mods found on disk). Pure. */
export const joinsByLoadout = (installed: Landed[], onDisk: Set<string>) => {
  const joins = new Map<string, string[]>()
  for (const m of installed) {
    for (const key of m.keys.filter(k => onDisk.has(k))) for (const id of m.loadouts ?? []) joins.set(id, [...(joins.get(id) ?? []), key])
  }
  return joins
}

/** A new install card joins the loadout whose page is open, so installing from a loadout adds to it. */
export const startingLoadouts = () => { const id = openLoadoutId(); return id && readLoadouts().some(l => l.id === id) ? [id] : [] }

/** After a successful install: add the mods now on disk to the loadouts picked for them, make the new loadout, then
 *  queue its previews. */
export async function finishInstallLoadout(installed: Installed[], alert: ReturnType<typeof useAlert>) {
  const job = pending
  pending = null
  const joining = installed.filter(m => m.loadouts?.length)
  if (!job && joining.length === 0) return
  const [all, paks, had] = await Promise.all([
    invoke<Mod[]>('get_pak_files').catch(() => [] as Mod[]),
    invoke<string[][]>('xtra_install_paks', { paths: installed.map(m => m.path ?? '') }).catch(() => [] as string[][]),
    before ?? Promise.resolve(null),
  ])
  before = null
  const here = new Set(all.map(m => modKey(m.path)))
  const fresh = had ? [...here].filter(k => !had.has(k)) : [] // files the install added, whatever their names
  const landed = installed.map((m, i) => ({ keys: resolveLanded(landedKeys(m, paks[i]), here, installed.length === 1 ? fresh : []), loadouts: m.loadouts }))
  const found = (l: Landed) => l.keys.length > 0
  if (joining.length) {
    const joins = joinsByLoadout(landed, here)
    writeLoadouts(readLoadouts().map(l => joins.has(l.id) ? { ...l, ...withMods(l, joins.get(l.id)!) } : l))
    const lost = landed.filter(l => l.loadouts?.length && !found(l)).length
    if (lost) alert.warning('Not added to its loadout', `${lost} installed mod${lost === 1 ? ' was' : 's were'} not found in the mods folder.`)
  }
  if (!job) return
  if ('into' in job) { // the mods joined an existing loadout above: render its preview again with them in it
    const into = readLoadouts().find(l => l.id === job.into)
    if (!into || !job.preview) return
    const keys = new Set(into.on.map(displayName))
    const error = await generatePreviews({ paths: all.filter(m => keys.has(modKey(m.path))).map(m => m.path), set: previewSetKey(into.id), name: into.name, force: true })
    if (error) alert.warning('Preview not started', error)
    return
  }
  const wanted = new Set([...landed.flatMap(l => l.keys), ...fresh])
  const onDisk = all.filter(m => wanted.has(modKey(m.path)))
  const keys = [...new Set(onDisk.map(m => modKey(m.path)))]
  if (keys.length === 0) {
    alert.warning('Loadout not created', `None of the ${plural(installed.length, 'installed mod')} were found in the mods folder.`)
    return
  }
  const id = crypto.randomUUID()
  writeLoadouts([...readLoadouts(), { id, name: job.name, label: job.label || 'Other', scope: keys, on: keys }])
  const missing = landed.filter(l => !found(l)).length
  // the end of an install: one click to the new loadout's page (its switch, mods and preview)
  alert.success(`Loadout ${job.name} created`, `${keys.length} mod${keys.length === 1 ? '' : 's'}${missing ? `. ${missing} could not be found` : ''}.${job.preview ? ' Generating its preview.' : ''}`,
    { duration: 10000, action: { label: 'Open', onClick: () => openLoadout(id) } })
  if (!job.preview) return
  const error = await generatePreviews({ paths: onDisk.map(m => m.path), set: previewSetKey(id), name: job.name, show: true })
  if (error) alert.warning('Preview not started', error)
}

if (import.meta.env.DEV) {
  console.assert(installedKey({ customName: 'My Mod v2' }) === 'My_Mod_v2', 'installed key matches the file name the install writes')
  console.assert(installedKey({ mod_name: 'ElectricBluePantherIcons_UPDATED_9999999_P' }) === 'ElectricBluePantherIcons_UPDATED', 'existing priority suffix is dropped')
  const j = joinsByLoadout([{ keys: ['A'], loadouts: ['x', 'y'] }, { keys: ['B'], loadouts: ['x'] }, { keys: ['Gone'], loadouts: ['x'] }], new Set(['A', 'B']))
  console.assert(j.get('x')?.join() === 'A,B' && j.get('y')?.join() === 'A' && j.size === 2, 'mods join their picked loadouts; missing ones are skipped')
  // a Nexus zip with one pak lands under the pak's name, not the archive's
  const zip = landedKeys({ mod_name: 'Mialygosa Magik 1.3.1 12984 5 2026-09-21T17-38Z YLrVJSM1X' }, ['MialygosaMagik_9999999_P'])
  // the backend keeps "+" and spaces that the predicted name drops (bp-inferno-king_mesh+matSwap...)
  const disk = new Set(['|bp-inferno-king_mesh+matSwap_outline_noPG_v11', 'skins|Other', '|Other'])
  console.assert(resolveLanded([installedKey({ mod_name: 'bp-inferno-king_mesh+matSwap_outline_noPG_v11.pak' })], disk, []).join() === '|bp-inferno-king_mesh+matSwap_outline_noPG_v11', 'a + in the name still matches')
  console.assert(resolveLanded(['Nothing_like_it'], disk, ['|New_File']).join() === '|New_File', 'no name match: the new files count')
  console.assert(resolveLanded(['Other'], disk, ['skins|Other']).join() === 'skins|Other', 'a name in two folders: the new file is the one installed')
  console.assert(zip.includes('MialygosaMagik') && resolveLanded(zip, new Set(['|MialygosaMagik']), []).join() === '|MialygosaMagik', 'an archive is found by its paks')
}
