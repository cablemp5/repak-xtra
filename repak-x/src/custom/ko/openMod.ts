// repakxtra: Library right-click > Open in KO Editor. Which mods are KO prompt mods (xtra_ko_is_mod, read from the mod's
// file list), and the open request the KO Editor takes once it is up. Kept out of KoEditor.tsx so the Library does not
// load the editor's code.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { setView } from '../loadoutStore'

// shortcut: by path for the session, a Replace file that turns a KO mod into another kind still shows the row (opening it then says so)
const known = new Map<string, boolean>()
/** Whether the mod is a KO prompt mod, or undefined when not read yet. */
export const knownKoMod = (path: string) => known.get(path)
export const checkKoMod = (path: string) => invoke<boolean>('xtra_ko_is_mod', { modPath: path }).catch(() => false).then(ko => { known.set(path, ko); return ko })

export type KoOpen = { path: string; name: string }
let request: KoOpen | null = null
const subs = new Set<() => void>()
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f) } }

/** The mod's file name as the editor's Name field: its Install then finds the mod and offers to replace it. */
export const koModName = (path: string) => (path.split(/[\\/]/).pop() ?? '').replace(/\..*$/, '').replace(/(_\d+)?_P$/i, '').replace(/_/g, ' ').trim()

export function openInKoEditor(path: string) {
  request = { path, name: koModName(path) }
  subs.forEach(f => f())
  setView('ko')
}
export const useKoOpen = () => useSyncExternalStore(subscribe, () => request)
export const takeKoOpen = () => { const r = request; request = null; subs.forEach(f => f()); return r }

if (import.meta.env.DEV) {
  console.assert(koModName('C:/g/~mods/Hela_Gold_KO_9999999_P.utoc') === 'Hela Gold KO' && koModName('D:\\m\\Red_P.pak') === 'Red', 'koModName')
}
