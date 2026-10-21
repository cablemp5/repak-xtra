// repakxtra: a mod's Nexus Mods source, read off the archive name at install (xtra_nexus.rs) and kept in localStorage
// under the mod's key (its name without on/off extension or priority suffix, like loadouts), so it survives switching,
// priority changes and renames (App.tsx follows renames). Mods from anywhere else record nothing and show nothing.
// Mods installed before that (or by another app) get theirs once, from the Nexus downloads still in Downloads.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLink } from 'lucide-react'
import { modKey } from './loadoutStore'
import { installedKey } from './installLoadout'
import { savedItem } from './storageCarryOver'
import nexusLogo from './logos/nexus.png'

export type NexusSource = { id: number; version: string; uploaded: number }
type Found = NexusSource & { paks?: string[] }
type Store = Record<string, NexusSource>

const STORAGE = 'repakxtra.nexusSources'
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const norm = (key: string) => key.replace(/(_\d+_P)+$/i, '').toLowerCase()
const read = (): Store => { try { return JSON.parse(savedItem(STORAGE) || '{}') } catch { return {} } }
const write = (s: Store) => { localStorage.setItem(STORAGE, JSON.stringify(s)); listeners.forEach(l => l()) }

/** The Types filter's name for mods installed from Nexus (FilterPanel.tsx, matched in App.tsx): not a real mod type */
export const NEXUS_TYPE = 'Nexus'

export const pageUrl = (id: number) => `https://www.nexusmods.com/marvelrivals/mods/${id}`
export const sourceOf = (path: string): NexusSource | undefined => read()[norm(modKey(path))]

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
      const installed = new Set(mods.map(m => norm(modKey(m.path))))
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
export function renameSource(oldKey: string, newKey: string) {
  const store = read(), from = norm(oldKey), to = norm(newKey)
  if (from === to || !store[from]) return
  store[to] = store[from]
  delete store[from]
  write(store)
}

/** Re-renders when any source is recorded or renamed; returns a value that changes with them. */
export const useNexusVersion = () => useSyncExternalStore(subscribe, () => savedItem(STORAGE) || '')

const useSource = (path: string) => {
  useNexusVersion()
  return sourceOf(path)
}

const open = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** ModDetailsPanel's source line: "Nexus Mods, uploaded Sep 13, 2026 · Open page". */
export function NexusSourceLine({ path }: { path: string }) {
  const s = useSource(path)
  if (!s) return null
  return (
    <div className="detail-item nx-source">
      <span className="detail-label">Source:</span>
      <span className="detail-value" title={`File version ${s.version}, uploaded ${new Date(s.uploaded * 1000).toUTCString()}`}>
        Nexus Mods, uploaded {day(s.uploaded)}
        <button type="button" className="su-link nx-open" onClick={() => open(pageUrl(s.id))}><ExternalLink size={12} /> Open page</button>
      </span>
    </div>
  )
}

/** The Library row's Nexus tag (Settings > Optional controls hides it): a click opens the mod's Nexus page. */
export function NexusTag({ path }: { path: string }) {
  const s = useSource(path)
  if (!s) return null
  return (
    <button type="button" className="mod-type-badge nexus-badge" title={`Installed from Nexus Mods, uploaded ${day(s.uploaded)}. Click to open its page`}
      onClick={e => { e.stopPropagation(); open(pageUrl(s.id)) }}><img className="tag-logo" src={nexusLogo} alt="" />Nexus</button>
  )
}

if (import.meta.env.DEV) {
  console.assert(norm(modKey('C:/m/~mods/Pucci_Skin_9999999_P.bak_repak')) === norm(installedKey({ mod_name: 'Pucci_Skin_9999999_P' })), 'installed and listed keys match')
}
