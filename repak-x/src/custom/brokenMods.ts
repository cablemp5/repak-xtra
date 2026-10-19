// repakxtra: mods that will not work in the installed game version (xtra_broken.rs decides), checked quietly in the
// background whenever the installed mods change. A mod row shows a Broken or May crash badge with the reason, and the
// Library's All / Enabled / Disabled switch gains Broken while any are.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type Verdict = { path: string; kind: 'broken' | 'risky'; reason: string }

/** One spelling per file: slashes and case may differ between the mod list and the backend. */
const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase()

let verdicts = new Map<string, Verdict>()
let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** Re-checks a moment after mods are added, removed or replaced (the first run after a game update reads the game's
 *  asset list, which takes a while: the badges appear when it is done). */
export function useBrokenWatch(mods: { path: string; modified_date?: number; file_size?: number }[]) {
  const key = mods.map(m => `${norm(m.path)}|${m.modified_date ?? ''}|${m.file_size ?? ''}`).sort().join('\n')
  useEffect(() => {
    if (!key) return
    let live = true
    const t = setTimeout(() => {
      invoke<Verdict[]>('xtra_broken_mods', { modPaths: mods.map(m => m.path) })
        .then(r => { if (live) { verdicts = new Map(r.map(v => [norm(v.path), v])); version++; listeners.forEach(l => l()) } })
        .catch(e => console.warn('[brokenMods] check failed', e))
    }, 1500)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** This mod's verdict, if it will not work or may crash. */
export const useVerdict = (path: string) => useSyncExternalStore(subscribe, () => verdicts.get(norm(path)))
/** Re-renders when the verdicts change. */
export const useBrokenVersion = () => useSyncExternalStore(subscribe, () => version)
export const verdictOf = (path: string) => verdicts.get(norm(path))

if (import.meta.env.DEV) {
  console.assert(norm('C:/Games/~mods/A_9999999_P.pak') === norm('c:\\games\\~MODS\\a_9999999_p.pak'), 'broken paths match across slashes and case')
}
