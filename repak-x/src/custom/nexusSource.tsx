// repakxtra: a mod's Nexus Mods source, read off the archive name at install (xtra_nexus.rs) and kept in localStorage
// under the mod's key (its name without on/off extension or priority suffix, like loadouts), so it survives switching,
// priority changes and renames (App.tsx follows renames). Mods from anywhere else record nothing and show nothing.
// Mods installed before that (or by another app) get theirs once, from the Nexus downloads still in Downloads.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowUpCircle, ExternalLink } from 'lucide-react'
import { nameKey } from './loadoutStore'
import { installedKey } from './installLoadout'
import { savedItem } from './storageCarryOver'
import nexusLogo from './logos/nexus.png'
import { getNexusFile, openNexusPage, pageUrl, updateOf, useNexusUpdates } from './nexus'

export type NexusSource = { id: number; version: string; uploaded: number }
type Found = NexusSource & { paks?: string[] }
type Store = Record<string, NexusSource>

const STORAGE = 'repakxtra.nexusSources'
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
// without the load priority: its _9999999_P suffix, and the ! that priority zero puts in front
const norm = (key: string) => key.replace(/^!+/, '').replace(/(_\d+_P)+$/i, '').toLowerCase()
// keys saved before norm dropped the ! read as today's (a tiny object, so every read redoes it)
let parsed = { raw: '', store: {} as Store } // every Library row reads it: parsed once per change
const read = (): Store => {
  const raw = savedItem(STORAGE) || '{}'
  if (raw !== parsed.raw) {
    try { parsed = { raw, store: Object.fromEntries(Object.entries(JSON.parse(raw)).map(([k, v]) => [norm(k), v])) as Store } } catch { parsed = { raw, store: {} } }
  }
  return { ...parsed.store } // a copy: callers change it before writing
}
const write = (s: Store) => { localStorage.setItem(STORAGE, JSON.stringify(s)); listeners.forEach(l => l()) }

/** The Types filter's name for mods installed from Nexus (FilterPanel.tsx, matched in App.tsx): not a real mod type */
export const NEXUS_TYPE = 'Nexus'

export { pageUrl }
export const sourceOf = (path: string): NexusSource | undefined => read()[norm(nameKey(path))]
/** The saved sources as stored (a string, so it compares by value): changes whenever a source is recorded. */
export const useNexusSources = () => useSyncExternalStore(subscribe, () => savedItem(STORAGE))

/** After an install: each mod from a Nexus-named archive gets its source (an archive's paks all get the same one).
 *  Kept under the name the install panel showed and under each pak's own name: an archive holding one pak installs it
 *  under the pak's name, not the archive's. */
export async function recordSources(installed: { path?: string; customName?: string; mod_name?: string }[]) {
  const fromArchive = installed.filter(m => m.path && /\.(zip|rar|7z)$/i.test(m.path))
  if (!fromArchive.length) return
  const found = await invoke<(Found | null)[]>('xtra_nexus_sources', { paths: fromArchive.map(m => m.path) }).catch(() => [])
  const store = read()
  let changed = false
  fromArchive.forEach((m, i) => {
    const f = found[i]
    if (!f) return
    const { paks = [], ...s } = f
    for (const key of [installedKey(m), ...paks.map(p => installedKey({ mod_name: p }))]) store[norm(key)] = s
    changed = true
  })
  if (changed) write(store)
}

/** The archive's source for exactly these installed mods (name keys): an update's mod, or the paks picked in the
 *  browser extension's installer under the names they got. Nothing else, so an archive's other paks keep theirs. A
 *  non-Nexus archive records nothing. */
export async function recordSourceAs(archive: string, keys: string[]) {
  const [f] = await invoke<(Found | null)[]>('xtra_nexus_sources', { paths: [archive] }).catch(() => [])
  if (!f || !keys.length) return
  const { paks: _, ...s } = f // eslint-disable-line @typescript-eslint/no-unused-vars
  const store = read()
  for (const k of keys) store[norm(k)] = s
  write(store)
}

const SCANNED = 'repakxtra.nexusScanned'
let scanning = false

/** Once (the first launch, or the first after an update brought this): each installed mod whose pak is in a Nexus
 *  download still in the Downloads folder gets that source, the newest upload when several hold it. A source already
 *  recorded at install is kept. */
export function useNexusScan(mods: { path: string }[]) {
  useEffect(() => {
    if (!mods.length || scanning || savedItem(SCANNED)) return
    scanning = true
    invoke<Found[]>('xtra_nexus_downloads').then(found => {
      localStorage.setItem(SCANNED, '1')
      const installed = new Set(mods.map(m => norm(nameKey(m.path))))
      const store = read(), had = new Set(Object.keys(store))
      let changed = false
      for (const { paks = [], ...s } of [...found].sort((a, b) => a.uploaded - b.uploaded)) { // newest last, so it wins
        for (const p of paks) {
          const key = norm(installedKey({ mod_name: p }))
          if (installed.has(key) && !had.has(key)) { store[key] = s; changed = true }
        }
      }
      if (changed) write(store)
    }).catch(() => undefined).finally(() => { scanning = false })
  }, [mods.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** A renamed mod keeps its source. */
/** With several new keys each gets it (a VFX update and the original it kept). The old key goes unless it is one. */
export function renameSource(oldKey: string, ...newKeys: string[]) {
  const store = read(), from = norm(oldKey), to = newKeys.map(norm)
  if (!store[from] || to.every(k => k === from)) return
  for (const k of to) store[k] = store[from]
  if (!to.includes(from)) delete store[from]
  write(store)
}

/** Re-renders when any source is recorded or renamed; returns a value that changes with them. */
export const useNexusVersion = () => useSyncExternalStore(subscribe, () => savedItem(STORAGE) || '')

const useSource = (path: string) => {
  useNexusVersion()
  useNexusUpdates()
  return sourceOf(path)
}

const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** ModDetailsPanel's source line: "Nexus Mods, uploaded Sep 13, 2026 · Open page". */
export function NexusSourceLine({ path }: { path: string }) {
  const s = useSource(path)
  if (!s) return null
  const u = updateOf(s)
  return (
    <div className="detail-item nx-source">
      <span className="detail-label">Source:</span>
      <span className="detail-value" title={`File version ${s.version}, uploaded ${new Date(s.uploaded * 1000).toUTCString()}`}>
        Nexus Mods, uploaded {day(s.uploaded)}
        <button type="button" className="su-link nx-open" onClick={() => openNexusPage(s.id)}><ExternalLink size={12} /> Open page</button>
        {u && <button type="button" className="su-link nx-open nx-update" onClick={() => getNexusFile(u.modId, u.fileId, path)}
          title={`${u.name}, uploaded ${day(u.date)}`}><ArrowUpCircle size={12} /> Update to {u.version}</button>}
      </span>
    </div>
  )
}

/** The Library row's Nexus tag (Settings > On each mod hides it): a click opens the mod's Nexus page. With a newer
 *  version out the tag splits: its blue half shows the version, and a click there gets it in place of this one (nexus.tsx getNexusFile). */
export function NexusTag({ path }: { path: string }) {
  const s = useSource(path)
  if (!s) return null
  const u = updateOf(s)
  const tag = (
    <button type="button" className="mod-type-badge nexus-badge" title={`Installed from Nexus Mods, uploaded ${day(s.uploaded)}. Click to open its page`}
      onClick={e => { e.stopPropagation(); openNexusPage(s.id) }}><img className="tag-logo" src={nexusLogo} alt="" />Nexus</button>
  )
  if (!u) return tag
  // a newer version: one split badge, the orange Nexus half opens the page, the blue half with the version updates
  const v = /^v/i.test(u.version) ? u.version : `v${u.version}`
  return (
    <span className="nexus-split">
      {tag}
      <button type="button" className="mod-type-badge nexus-update-chip" title={`Version ${u.version} is on Nexus Mods (uploaded ${day(u.date)}). Click to update`}
        aria-label={`Update from Nexus Mods to ${v}`} onClick={e => { e.stopPropagation(); getNexusFile(u.modId, u.fileId, path) }}>
        <ArrowUpCircle size={13} strokeWidth={2.25} aria-hidden="true" />{v}</button>
    </span>
  )
}

if (import.meta.env.DEV) {
  console.assert(norm(nameKey('C:/m/~mods/Pucci_Skin_9999999_P.bak_repak')) === norm(installedKey({ mod_name: 'Pucci_Skin_9999999_P' })), 'installed and listed keys match')
  console.assert(norm(nameKey('C:/m/~mods/!Pucci_Skin_9999999_P.pak')) === norm(nameKey('C:/m/~mods/Pucci_Skin_99999999_P.pak')), 'priority zero keeps its source')
}
