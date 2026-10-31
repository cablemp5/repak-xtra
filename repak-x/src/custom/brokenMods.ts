// repakxtra: mods that will not work in the installed game version (xtra_broken.rs decides), checked quietly in the
// background whenever the installed mods change. A mod row shows a Broken, Needs VFX update or May crash badge with the reason, and the
// Library's All / Enabled / Disabled switch gains Broken while any are.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'

/** usmapWait (Needs VFX update only): files it rebuilds that a patch newer than the saved USMAP changed. While it is not
 *  0 the update waits for that patch's USMAP (xtra_broken.rs changed_since_usmap). */
export type Verdict = { path: string; kind: 'broken' | 'vfx' | 'risky'; reason: string; usmapWait?: number }
/** A verdict's badge text. */
export const verdictLabel = (kind: Verdict['kind']) => (kind === 'broken' ? 'Broken' : kind === 'vfx' ? 'Needs update' : 'May crash')

/** One spelling per mod: slashes and case may differ between the mod list and the backend, and turning a mod on or off
 *  renames .bak_repak to .pak (or back), so the badge stays put through a switch instead of waiting for the next check. */
const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')

let verdicts = new Map<string, Verdict>()
let version = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }

/** What changes a verdict without changing a mod's file (Check for VFX update, Nothing to update, xtra_broken.rs's record):
 *  any window sends it, the Library checks again. */
export const VERDICTS_CHANGED = 'xtra-verdicts-changed'
export const verdictsChanged = () => emit(VERDICTS_CHANGED).catch(() => {})

/** Scan (Refresh list, Ctrl+Shift+R) sends it: the Library runs every check again, the background ones too. */
export const VERDICTS_RESCAN = 'xtra-verdicts-rescan'
export const rescanVerdicts = () => emit(VERDICTS_RESCAN).catch(() => {})

/** Full scans run one at a time: the backend's background checks skip a call while one runs (they answer 0), so a scan
 *  started beside another would end early with half the answers. Each waits for the one before it. */
let queue: Promise<unknown> = Promise.resolve()
let runFull: (() => Promise<boolean>) | null = null
const queued = (run: () => Promise<boolean>) => { const next = queue.then(run, run); queue = next; return next }
/** Runs every check again once the scan in flight (if any) is done. True when it ran to its end, false when it failed or
 *  the library changed under it. Null when no library is watched yet (no mods loaded). gameUpdate.ts waits on it. */
export const fullScan = (): Promise<boolean> | null => (runFull ? queued(runFull) : null)
/** How many mods carry a verdict now. */
export const flaggedCount = () => verdicts.size
/** Of those, how many need an update that waits for the USMAP of the installed game build. */
export const waitingCount = () => [...verdicts.values()].filter(v => v.usmapWait).length

/** Re-checks a moment after mods are added, removed or replaced, at every launch and on every Scan (the first run after a
 *  game update reads the game's asset list, which takes a while: the badges appear when it is done). */
export function useBrokenWatch(mods: { path: string; modified_date?: number; file_size?: number }[]) {
  const key = mods.map(m => `${norm(m.path)}|${m.modified_date ?? ''}|${m.file_size ?? ''}`).sort().join('\n')
  useEffect(() => {
    if (!key) return
    let live = true
    const check = () => invoke<Verdict[]>('xtra_broken_mods', { modPaths: mods.map(m => m.path) })
      .then(r => { if (live) { verdicts = new Map(r.map(v => [norm(v.path), v])); version++; listeners.forEach(l => l()) } return true })
      .catch(e => { console.warn('[brokenMods] check failed', e); return false })
    // then VFX mods newer than the update whose Niagara files may still be in the old layout: decoded once each in the
    // background (xtra_niagara.rs), and checked again when one is. Then the mods the date calls current: their materials
    // checked once each per game update (xtra_vfx_check.rs), so one made before the update, or installed before
    // repakxtra kept made dates, is flagged too. Both need the game's USMAP: fetched first (an ETag check when it has
    // it), so a library whose VFX Updater was never opened is checked as well. Last, the Blueprint mods: their classes
    // compared with the game's once each per game update (xtra_layout.rs). One the update changed gets May crash with
    // what changed, one that matches loses the date-only warning, so the badges follow each one checked
    const chain = () => check()
      .then(ok => { if (!ok) throw new Error('the first check failed') })
      .then(() => (live ? invoke('vfx_check_usmap_update', { force: false }).catch(() => null) : null))
      .then(() => (live ? invoke<number>('xtra_vfx_layout_scan', { modPaths: mods.map(m => m.path) }) : 0))
      .then(found => (live && found ? check() : undefined))
      .then(() => (live ? invoke<number>('xtra_vfx_check_scan', { modPaths: mods.filter(m => verdicts.get(norm(m.path))?.kind !== 'vfx').map(m => m.path) }) : 0))
      .then(found => (live && found ? check() : undefined))
      .then(() => (live ? invoke<number>('xtra_layout_scan', { modPaths: mods.map(m => m.path) }) : 0))
      .then(checked => (live && checked ? check() : undefined))
      // and mesh mods whose skeleton the game rebuilt: more bones than it has gets May crash (xtra_mesh.rs)
      .then(() => (live ? invoke<number>('xtra_mesh_scan', { modPaths: mods.map(m => m.path) }) : 0))
      .then(checked => (live && checked ? check() : undefined))
      .then(() => live, e => { console.warn('[brokenMods] background scan failed', e); return false })
    const full = () => queued(chain)
    runFull = chain
    // the quick check at once, never behind a background scan in flight (one can run for many minutes after a game
    // update), so new mods get their badges in the Library and on loadouts right away
    const t = setTimeout(() => { void check(); void full() }, 1500)
    // the background scans stop for the game, an update or a check (xtra_vfx.rs background_may_run): back in the app,
    // they go on where they stopped, at most every 5 minutes (a scan with nothing left to do is quick)
    let lastResume = Date.now()
    const resume = () => { if (Date.now() - lastResume > 300_000) { lastResume = Date.now(); void full() } }
    window.addEventListener('focus', resume)
    const again = listen(VERDICTS_CHANGED, () => { void check() })
    const rescan = listen(VERDICTS_RESCAN, () => { void full() })
    return () => { live = false; window.removeEventListener('focus', resume); if (runFull === chain) runFull = null; clearTimeout(t); void again.then(f => f()); void rescan.then(f => f()) }
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
