// repakxtra: mods that will not work in the installed game version (xtra_broken.rs decides), checked quietly in the
// background whenever the installed mods change. A mod row shows a Broken, Needs VFX update or May crash badge with the reason, and the
// Library's All / Enabled / Disabled switch gains Broken while any are.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type Verdict = { path: string; kind: 'broken' | 'vfx' | 'risky'; reason: string }
/** A verdict's badge text. */
export const verdictLabel = (kind: Verdict['kind']) => (kind === 'broken' ? 'Broken' : kind === 'vfx' ? 'Needs VFX update' : 'May crash')

/** One spelling per mod: slashes and case may differ between the mod list and the backend, and turning a mod on or off
 *  renames .bak_repak to .pak (or back), so the badge stays put through a switch instead of waiting for the next check. */
const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')

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
    const check = () => invoke<Verdict[]>('xtra_broken_mods', { modPaths: mods.map(m => m.path) })
      .then(r => { if (live) { verdicts = new Map(r.map(v => [norm(v.path), v])); version++; listeners.forEach(l => l()) } })
      .catch(e => console.warn('[brokenMods] check failed', e))
    const t = setTimeout(() => {
      // then VFX mods newer than the update whose Niagara files may still be in the old layout: decoded once each in the
      // background (xtra_niagara.rs), and checked again when one is
      void check().then(() => (live ? invoke<number>('xtra_vfx_layout_scan', { modPaths: mods.map(m => m.path) }) : 0))
        .then(found => { if (live && found) void check() })
        .catch(e => console.warn('[brokenMods] layout scan failed', e))
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
  console.assert(norm('C:/Games/~mods/A_9999999_P.pak') === norm('C:/Games/~mods/A_9999999_P.bak_repak'), 'a mod keeps its verdict on and off')
}
