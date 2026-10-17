// repakxtra: a mod's Nexus Mods source, read off the archive name at install (xtra_nexus.rs) and kept in localStorage
// under the mod's key (its name without on/off extension or priority suffix, like loadouts), so it survives switching,
// priority changes and renames (App.tsx follows renames). Mods from anywhere else record nothing and show nothing.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ExternalLink } from 'lucide-react'
import { modKey } from './loadoutStore'
import { installedKey } from './installLoadout'
import { savedItem } from './storageCarryOver'

export type NexusSource = { id: number; version: string; uploaded: number }
type Found = NexusSource & { paks?: string[] }
type Store = Record<string, NexusSource>

const STORAGE = 'repakxtra.nexusSources'
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const norm = (key: string) => key.replace(/(_\d+_P)+$/i, '').toLowerCase()
const read = (): Store => { try { return JSON.parse(savedItem(STORAGE) || '{}') } catch { return {} } }
const write = (s: Store) => { localStorage.setItem(STORAGE, JSON.stringify(s)); listeners.forEach(l => l()) }

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

/** A renamed mod keeps its source. */
export function renameSource(oldKey: string, newKey: string) {
  const store = read(), from = norm(oldKey), to = norm(newKey)
  if (from === to || !store[from]) return
  store[to] = store[from]
  delete store[from]
  write(store)
}

const useSource = (path: string) => {
  useSyncExternalStore(subscribe, () => savedItem(STORAGE) || '')
  return sourceOf(path)
}

const open = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** ModDetailsPanel's source line: "Nexus 12890, uploaded Sep 13, 2026 · Open page". */
export function NexusSourceLine({ path }: { path: string }) {
  const s = useSource(path)
  if (!s) return null
  return (
    <div className="detail-item nx-source">
      <span className="detail-label">Source:</span>
      <span className="detail-value" title={`File version ${s.version}, uploaded ${new Date(s.uploaded * 1000).toUTCString()}`}>
        Nexus {s.id}, uploaded {day(s.uploaded)}
        <button type="button" className="su-link nx-open" onClick={() => open(pageUrl(s.id))}><ExternalLink size={12} /> Open page</button>
      </span>
    </div>
  )
}

if (import.meta.env.DEV) {
  console.assert(norm(modKey('C:/m/~mods/Pucci_Skin_9999999_P.bak_repak')) === norm(installedKey({ mod_name: 'Pucci_Skin_9999999_P' })), 'installed and listed keys match')
}
