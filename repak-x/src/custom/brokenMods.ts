// repakxtra: mods that will not work in the installed game version (xtra_broken.rs decides), checked quietly in the
// background whenever the installed mods change. A mod row shows a Broken, Needs VFX update or May crash badge with the reason, and the
// Library's All / Enabled / Disabled switch gains Broken while any are.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { releaseScan, scanEnded, scanHeld, scanStarted } from './scanProgress'

/** usmapWait (Needs VFX update only): files it rebuilds that a patch newer than the saved USMAP changed. While it is not
 *  0 the update waits for that patch's USMAP (xtra_broken.rs changed_since_usmap). */
export type Verdict = { path: string; kind: 'broken' | 'vfx' | 'risky' | 'unknown'; reason: string; usmapWait?: number; offOnly?: boolean }
/** A verdict's badge text. */
export const verdictLabel = (kind: Verdict['kind']) => (kind === 'broken' ? 'Broken' : kind === 'vfx' ? 'Needs update' : kind === 'unknown' ? 'Safety unknown' : 'May crash')

/** Mods the Mod Updater never offers: built-ins (another app's too, in .repakxtra-builtin) and project loaders
 *  (!Project<Name>_9999999_P, or a bare Project<Name>), which the app that made them keeps current.
 *  shortcut: by file name, a mod named exactly like Projectiles.pak is skipped too (Add .utoc still takes it). */
export const skipsUpdater = (path: string) =>
  /[\\/]\.repakxtra-builtin[\\/]/i.test(path) || /^(!project[a-z]+(-repacked)?(_\d+)?(_p)?|project[a-z]+(-repacked)?)$/i.test(path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''))
/** What the Library's notice and the Mod Updater's Needs an update both count: a mod that needs an update, or one that
 *  may crash and is on (Update turns it off), never one it skips. */
export const needsUpdater = (path: string, v?: { kind: string }, on = !/\.bak_repak$/i.test(path)) =>
  Boolean(v) && !skipsUpdater(path) && (v!.kind === 'vfx' || (v!.kind === 'risky' && on))

/** One spelling per mod: slashes and case may differ between the mod list and the backend, and turning a mod on or off
 *  renames .bak_repak to .pak (or back), so the badge stays put through a switch instead of waiting for the next check. */
const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')

let verdicts = new Map<string, Verdict>()
/** Mods the Mod Updater made for the installed game (xtra_stamp.rs): their Updated or Partly updated tag. */
let made = new Map<string, { partial: boolean; current: boolean }>()
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
/** Runs every check again once the scan in flight (if any) is done. True when it ran to its end, false when it failed,
 *  stopped with mods left (the game, an update or a check took over), or the library changed under it. Null when no
 *  library is watched yet (no mods loaded). gameUpdate.ts waits on it. */
export const fullScan = (): Promise<boolean> | null => (runFull ? runFull() : null)
/** Each quick check's turn: a slower, older answer never replaces a newer one (one that waited on the game's asset list
 *  could bring back a flag Nothing to update just cleared). */
let checkSeq = 0
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
    // the mods that are on first: their answers matter before a play session, the off ones can wait
    const paths = mods.map(m => m.path).sort((a, b) => Number(/\.bak_repak$/i.test(a)) - Number(/\.bak_repak$/i.test(b)))
    const check = () => {
      const turn = ++checkSeq
      return Promise.all([invoke<Verdict[]>('xtra_broken_mods', { modPaths: paths }), invoke<{ path: string; partial: boolean; current: boolean }[]>('xtra_made_mods', { modPaths: paths }).catch(() => [])])
        .then(([r, m]) => { if (live && turn === checkSeq) { verdicts = new Map(r.map(v => [norm(v.path), v])); made = new Map(m.map(x => [norm(x.path), x])); version++; listeners.forEach(l => l()) } return true })
        // the badges so far stay (the game runs and its file list is not read yet, or the call failed)
        .catch(e => { console.warn('[brokenMods] check failed', e); return false })
    }
    // then VFX mods newer than the update whose Niagara files may still be in the old layout: decoded once each in the
    // background (xtra_niagara.rs), and checked again when one is. Then the mods the date calls current: their materials
    // checked once each per game update (xtra_vfx_check.rs), so one made before the update, or installed before
    // repakxtra kept made dates, is flagged too. Both need the game's USMAP: fetched first (an ETag check when it has
    // it), so a library whose VFX Updater was never opened is checked as well. Last, the Blueprint mods: their classes
    // compared with the game's once each per game update (xtra_layout.rs). One the update changed gets May crash with
    // what changed, one that matches loses the date-only warning, so the badges follow each one checked
    // `first`: the quick check just started at launch, reused so the chain does not run the same check beside it
    // `finished` is false when a scan stopped with mods left (xtra_scan_stopped, read and cleared at both ends)
    // a run the library outdated before it began checked nothing: not finished (gameUpdate.ts asks the new one instead)
    const chain = (first?: Promise<boolean>): Promise<boolean> => !live ? Promise.resolve(false) : (scanStarted(), invoke('xtra_scan_stopped').catch(() => false))
      .then(() => first ?? check())
      .then(ok => { if (!ok) throw new Error('the first check failed') })
      .then(() => (live ? invoke('vfx_check_usmap_update', { force: false }).catch(() => null) : null))
      .then(() => (live ? invoke<number>('xtra_vfx_layout_scan', { modPaths: paths }) : 0))
      .then(found => (live && found ? check() : undefined))
      .then(() => (live ? invoke<number>('xtra_vfx_check_scan', { modPaths: paths }) : 0))
      .then(found => (live && found ? check() : undefined))
      .then(() => (live ? invoke<number>('xtra_layout_scan', { modPaths: paths }) : 0))
      .then(checked => (live && checked ? check() : undefined))
      // and mesh mods whose skeleton the game rebuilt: more bones than it has gets May crash (xtra_mesh.rs)
      .then(() => (live ? invoke<number>('xtra_mesh_scan', { modPaths: paths }) : 0))
      .then(checked => (live && checked ? check() : undefined))
      .then(() => (live ? invoke<boolean>('xtra_scan_stopped').catch(() => false) : true))
      .then(stopped => live && !stopped, e => { console.warn('[brokenMods] background scan failed', e); return false })
      // runs take turns (queued), so this one's end is never another's. One the library outdated is not "paused":
      // the new list's own run follows
      .then(finished => { unfinished = !finished; scanEnded(finished || !live); return finished })
    let unfinished = false
    // one run waiting its turn is enough: a focus, a Rescan and the game update notice asking meanwhile all get that one
    let waiting: Promise<boolean> | null = null
    const full = (first?: Promise<boolean>) => waiting ?? (waiting = queued(() => { waiting = null; return chain(first) }))
    runFull = full
    // the quick check at once (1.5 s after the list stops changing: an install renames and reloads it a few times),
    // never behind a background scan in flight (one can run for many minutes after a game update), so new mods get
    // their badges in the Library and on loadouts right away. The chain starts from it
    const t = setTimeout(() => { void full(check()) }, 1500)
    // only a run that stopped with mods left goes on when the window is back (the game, an update or a check took
    // over: xtra_vfx.rs background_may_run). Nothing changed, nothing runs. A game update is gameUpdate.ts's to start
    let lastResume = 0
    const resume = () => { if (unfinished && !scanHeld() && Date.now() - lastResume > 30_000) { lastResume = Date.now(); void full() } }
    window.addEventListener('focus', resume)
    const again = listen(VERDICTS_CHANGED, () => { void check() })
    // a Refresh list or Resume: checks the header paused or cancelled run again
    const rescan = listen(VERDICTS_RESCAN, () => { void releaseScan().then(() => full()) })
    return () => { live = false; window.removeEventListener('focus', resume); if (runFull === full) runFull = null; clearTimeout(t); void again.then(f => f()); void rescan.then(f => f()) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** This mod's verdict, if it will not work or may crash. */
export const useVerdict = (path: string) => useSyncExternalStore(subscribe, () => verdicts.get(norm(path)))
/** Re-renders when the verdicts change. */
export const useBrokenVersion = () => useSyncExternalStore(subscribe, () => version)
export const verdictOf = (path: string) => verdicts.get(norm(path))
/** Made by the Mod Updater, whether it left files out, and whether for the installed game. */
export const useMade = (path: string) => useSyncExternalStore(subscribe, () => made.get(norm(path)))

if (import.meta.env.DEV) {
  console.assert(verdictLabel('unknown') === 'Safety unknown', 'inconclusive checks do not claim a confirmed crash risk')
  console.assert(verdictLabel('risky') === 'May crash', 'confirmed risks keep their warning')
  console.assert(norm('C:/Games/~mods/A_9999999_P.pak') === norm('c:\\games\\~MODS\\a_9999999_p.pak'), 'broken paths match across slashes and case')
  console.assert(norm('C:/Games/~mods/A_9999999_P.pak') === norm('C:/Games/~mods/A_9999999_P.bak_repak'), 'a mod keeps its verdict on and off')
  console.assert(skipsUpdater('C:/G/~mods/!ProjectFoo_9999999_P.pak') && skipsUpdater('C:/G/~mods/ProjectFoo.bak_repak') && skipsUpdater('C:/G/~mods/.repakxtra-builtin/repakxtra-a_9999999_P.pak')
    && !skipsUpdater('C:/G/~mods/Project Hail Mary Skin_9999999_P.pak') && !skipsUpdater('C:/G/~mods/A_9999999_P.pak'), 'loaders and built-ins only')
  console.assert(needsUpdater('a.pak', { kind: 'risky' }) && !needsUpdater('a.bak_repak', { kind: 'risky' }) && needsUpdater('a.bak_repak', { kind: 'vfx' }) && !needsUpdater('a.pak', { kind: 'broken' }), 'needs the updater')
}
