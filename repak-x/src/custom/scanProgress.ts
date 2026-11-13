// repakxtra: the background mod checks' progress (brokenMods.ts runs them, each backend scan sends `mod-scan-progress`
// for a mod it is about to read). After a game or app update they can read every mod for many minutes. The header
// button (ScanStatus.tsx) is the only sign: it shows once work has gone on for a moment, says which check, which mod and
// how far, and a run stopped with mods left says so until it picks up again. Never a toast. A run is a fixed list of
// steps (brokenMods.ts says which one starts and what each weighs: reading the game's files, each scan for the mods that
// are on, then for the ones that are off, the textures), each weighing about as much as the mods it reads, so its whole
// progress is the steps done plus the share of the current step's mods read. It shows as one count over every mod the
// run scans and one bar, never stepping back.
import { useEffect, useSyncExternalStore } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

export type ScanStep = { step: 'effects' | 'materials' | 'blueprints' | 'meshes'; at: number; total: number; path: string }
/** Sent when a full run of the checks ends (finished, stopped for the game, or failed) */
export const SCAN_DONE = 'repakxtra-scan-done'

/** "C:/x/Cool Mod_9999999_P.bak_repak" is "Cool Mod". Pure. */
export const modLabel = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.(pak|bak_repak|utoc)$/i, '').replace(/_\d+_P$/i, '')
/** The mods scanned so far, out of every mod the run scans, as the whole run's share of its work: "57 of 200". Pure. */
export const modsDone = (pct: number, mods: number) => Math.min(mods, Math.max(1, Math.round((pct / 100) * mods)))
/** "Cool Mod (57 of 200)". Pure. */
export const progressLine = (path: string, pct: number, mods: number) => `${modLabel(path)} (${modsDone(pct, mods)} of ${mods})`
const SHOW_AFTER_MS = 1500

/** `shown`: the run has read mods for a moment. `paused`: the last run stopped with mods left.
 *  `held`: the header's Pause or Cancel stopped them (xtra_vfx.rs HELD): they stay stopped until Resume or Refresh list. */
/** `pct`: the whole run's progress as shown, which only rises in a run (a scan that counts again from 0 never lowers it). */
/** `stage`: the step the run is on, of `weights` (what each step weighs). `mods`: how many mods it scans. `counting`:
 *  the mods read now belong to that step (false before the first, while a manual Check's mods go first). */
export type ScanRun = { running: boolean; shown: boolean; paused: boolean; last: ScanStep | null; read: number; held: 'paused' | 'cancelled' | null; stage: number; weights: number[]; mods: number; counting: boolean; pct: number }
let run: ScanRun = { running: false, shown: false, paused: false, last: null, read: 0, held: null, stage: 0, weights: [1], mods: 0, counting: false, pct: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<ScanRun>) => {
  run = { ...run, ...next }
  run.pct = Math.max(run.pct, runPercent(run.stage, run.weights, run.counting ? run.last : null))
  listeners.forEach(l => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useScanRun = () => useSyncExternalStore(subscribe, () => run)

/** The whole run's progress, 0 to 100: the steps before this one, plus the share of this step's mods read, each step by
 *  its weight. Pure. */
export const runPercent = (stage: number, weights: number[], last: { at: number; total: number } | null) => {
  const all = weights.reduce((a, w) => a + w, 0)
  if (all <= 0) return 0
  const done = weights.slice(0, stage).reduce((a, w) => a + w, 0) + (weights[stage] ?? 0) * (last && last.total > 0 ? Math.min(1, last.at / last.total) : 0)
  return Math.min(100, (done / all) * 100)
}
/** Where step `stage` ends, 0 to 100: how far a step with no count yet may creep. Pure. */
export const stageEnd = (stage: number, weights: number[]) => runPercent(stage + 1, weights, null)

let showTimer: number | undefined
/** Shows the header status once a run has gone on for a moment (a quick run never flashes it). */
const showSoon = () => {
  if (run.shown || showTimer !== undefined) return
  showTimer = window.setTimeout(() => { showTimer = undefined; if (run.running) set({ shown: true }) }, SHOW_AFTER_MS)
}
/** brokenMods.ts: a run of the checks starts, reading the game's files first (step 0). */
export const scanStarted = () => { set({ running: true, last: null, read: 0, stage: 0, weights: [1], mods: 0, counting: false, pct: 0 }); run.pct = 0; showSoon() }
/** brokenMods.ts: what the run's steps weigh and how many mods it scans, known before its first step counts. */
export const scanPlan = (weights: number[], mods: number) => set({ weights, mods })
/** brokenMods.ts: step `stage` of `weights` starts (its mods are counted from 0), in a run that scans `mods` mods.
 *  `count`: textures, which the frontend counts itself. */
export const scanStage = (stage: number, weights: number[], mods: number, count?: { at: number; total: number; path: string }) => {
  set({ stage, weights, mods, counting: true, last: count ? { step: 'materials', ...count } : null })
  showSoon()
}
/** brokenMods.ts: the run ended. `finished`: false when it stopped with mods left to read, or failed. */
export const scanEnded = (finished: boolean) => {
  set({ running: false, paused: !finished && run.held !== 'cancelled' })
  window.dispatchEvent(new Event(SCAN_DONE))
  void emit(SCAN_DONE).catch(() => {}) // and the Mod Updater window, which follows the run (its Scan starts one)
}

/** The header's Pause or Cancel: the checks stop at the next mod. Cancel also hides the header's status once they do. */
export const holdScan = (kind: 'paused' | 'cancelled') => {
  set({ held: kind, ...(kind === 'cancelled' && !run.running ? { paused: false } : {}) })
  return invoke('xtra_scan_hold', { on: true }).catch(() => undefined)
}
/** Resume, Refresh list or a Scan: the checks may run again (the caller starts them). */
export const releaseScan = () => {
  if (run.held) set({ held: null })
  return invoke('xtra_scan_hold', { on: false }).catch(() => undefined)
}
/** The person stopped the checks: a focus does not start them again. */
export const scanHeld = () => run.held !== null

/** The header button (ScanStatus.tsx) is the only sign of the checks: no toast. `shown` once a run has read mods for a moment. */
export function useScanProgress() {
  useEffect(() => {
    const off = listen<ScanStep>('mod-scan-progress', e => {
      // a mod being read means a run is on, whatever the start and end calls said
      set({ last: e.payload, read: run.read + 1, running: true, paused: false })
      showSoon()
    })
    const done = () => { clearTimeout(showTimer); showTimer = undefined; set({ shown: false, last: null, read: 0, stage: 0 }); run.pct = 0 }
    window.addEventListener(SCAN_DONE, done)
    return () => { off.then(f => f()).catch(() => undefined); window.removeEventListener(SCAN_DONE, done) }
  }, [])
}

if (import.meta.env.DEV) {
  console.assert(modLabel('C:\\Paks\\~mods\\Cool Mod_9999999_P.bak_repak') === 'Cool Mod' && modLabel('a/b_P.pak') === 'b_P', 'mod label')
  console.assert(progressLine('x/Cyan_9999999_P.pak', 50, 200) === 'Cyan (100 of 200)' && progressLine('x/A_P.pak', 0, 200) === 'A_P (1 of 200)', 'progress line')
  // three mods on (five quick steps) and 200 off: the first pass is a sliver of the run, not five twelfths of it
  const w = [10, ...Array(5).fill(3), ...Array(5).fill(200), 20]
  console.assert(runPercent(0, w, null) === 0 && runPercent(6, w, null) < 5 && runPercent(11, w, { at: 9, total: 9 }) === 100, 'run percent by weight', runPercent(6, w, null))
  console.assert(stageEnd(0, w) === runPercent(1, w, null), 'stage end')
  // a manual Check's mods first: their counts move nothing until the run's own first step
  const keep = run
  run = { ...run, running: true, stage: 0, weights: w, mods: 205, counting: false, pct: 0 }
  set({ last: { step: 'meshes', at: 9, total: 9, path: 'a' } })
  const before = run.pct
  scanStage(1, w, 205)
  console.assert(before === 0 && run.pct < 5, 'priority mods move nothing', before, run.pct)
  run = keep
}
