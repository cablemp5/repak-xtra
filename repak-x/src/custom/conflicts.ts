// repakxtra: which enabled mods clash with another enabled mod (same load priority, same files: the existing
// check_mod_clashes), checked quietly in the background whenever the set of enabled mods changes. The Library's Check
// conflicts button shows a red dot while any do, and each clashing mod's row a red Conflict badge (cable asked for red
// here).
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'

type Clash = { file_path: string; mod_paths: string[] }

/** One spelling per file: the clash check walks the folder itself, so slashes and case may differ from the mod list. */
const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase()

let clashing = new Set<string>()
let groups = 0
let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const set = (next: Set<string>, n = 0) => { clashing = next; groups = n; version++; listeners.forEach(l => l()) }

/** How many groups of mods clash: mods joined by any shared clash are one group (A with B and B with C is one). */
export function countGroups(clashes: Clash[]) {
  const parent = new Map<string, string>()
  const root = (k: string): string => { const p = parent.get(k) ?? k; if (p === k) return k; const r = root(p); parent.set(k, r); return r }
  for (const c of clashes) {
    const [first, ...rest] = c.mod_paths.map(norm)
    if (!first) continue
    parent.set(root(first), root(first))
    for (const k of rest) parent.set(root(k), root(first))
  }
  return new Set([...parent.keys()].map(root)).size
}

/** Re-checks a moment after the enabled mods change, or one of them is replaced in place (its date or size changes); a
 *  loadout switch flips several at once: one check. */
export function useConflictWatch(mods: { path: string; enabled?: boolean; modified_date?: number; file_size?: number }[]) {
  const key = mods.filter(m => m.enabled).map(m => `${norm(m.path)}|${m.modified_date ?? ''}|${m.file_size ?? ''}`).sort().join('\n')
  useEffect(() => {
    if (!key) { if (clashing.size) set(new Set()); return }
    let live = true
    const t = setTimeout(() => {
      invoke<Clash[]>('check_mod_clashes', { quiet: true })
        .then(r => { if (live) set(new Set(r.flatMap(c => c.mod_paths.map(norm))), countGroups(r)) })
        .catch(() => { if (live && clashing.size) set(new Set()) }) // no game folder (or the check failed): no stale red marks
    }, 600)
    return () => { live = false; clearTimeout(t) }
  }, [key])
}

/** How many groups of enabled mods clash right now (one per set of mods that clash with each other). */
export const useConflictCount = () => { useSyncExternalStore(subscribe, () => version); return groups }
/** Whether this mod clashes with another enabled one. */
export const useIsConflicting = (path: string) => useSyncExternalStore(subscribe, () => clashing.has(norm(path)))

if (import.meta.env.DEV) {
  console.assert(norm('C:/Games/~mods/A_9999999_P.pak') === norm('c:\\games\\~MODS\\a_9999999_p.pak'), 'conflict paths match across slashes and case')
  const c = (...mod_paths: string[]) => ({ file_path: '', mod_paths })
  console.assert(countGroups([c('a', 'b'), c('b', 'c'), c('d', 'e')]) === 2, 'chained clashes are one group')
  console.assert(countGroups([]) === 0, 'no clashes, no groups')
}
