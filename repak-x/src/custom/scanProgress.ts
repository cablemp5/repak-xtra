// repakxtra: the background mod checks' progress (brokenMods.ts runs them, each backend scan sends `mod-scan-progress`
// for a mod it is about to read). After a game or app update they can read every mod for many minutes. The header
// button (ScanStatus.tsx) is the only sign: it shows once work has gone on for a moment, says which check, which mod and
// how far, and a run stopped with mods left says so until it picks up again. Never a toast. A run goes through STAGES in
// order (brokenMods.ts says which one starts), so its whole progress is the stages done plus the share of the current
// stage's mods read: one bar for the whole run, which never steps back (GlideFill.tsx).
import { useEffect, useSyncExternalStore } from 'react'
import { emit, listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

export type ScanStep = { step: 'effects' | 'materials' | 'blueprints' | 'meshes'; at: number; total: number; path: string }
/** Sent when a full run of the checks ends (finished, stopped for the game, or failed) */
export const SCAN_DONE = 'repakxtra-scan-done'

const STEP = { effects: 'VFX effects', materials: 'VFX materials', blueprints: 'Blueprints', meshes: 'Meshes' }
/** A run's stages, in the order brokenMods.ts runs them. */
export const STAGES = ['Reading game files', 'VFX effects', 'VFX materials', 'Blueprints', 'Meshes', "The game's older files", 'Textures'] as const
export type Stage = (typeof STAGES)[number]
/** "C:/x/Cool Mod_9999999_P.bak_repak" is "Cool Mod". Pure. */
export const modLabel = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.(pak|bak_repak|utoc)$/i, '').replace(/_\d+_P$/i, '')
/** "VFX materials · Cool Mod (12 of 216)". Pure. */
export const progressLine = (p: ScanStep) => `${STEP[p.step] ?? 'Mods'} · ${modLabel(p.path)} (${p.at} of ${p.total})`
const SHOW_AFTER_MS = 1500

/** `shown`: the run has read mods for a moment. `paused`: the last run stopped with mods left.
 *  `held`: the header's Pause or Cancel stopped them (xtra_vfx.rs HELD): they stay stopped until Resume or Refresh list. */
/** `pct`: the whole run's progress as shown, which only rises in a run (a scan that counts again from 0 never lowers it). */
export type ScanRun = { running: boolean; shown: boolean; paused: boolean; last: ScanStep | null; read: number; held: 'paused' | 'cancelled' | null; stage: number; pct: number }
let run: ScanRun = { running: false, shown: false, paused: false, last: null, read: 0, held: null, stage: 0, pct: 0 }
const listeners = new Set<() => void>()
const set = (next: Partial<ScanRun>) => {
  run = { ...run, ...next }
  run.pct = Math.max(run.pct, runPercent(run.stage, run.last))
  listeners.forEach(l => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useScanRun = () => useSyncExternalStore(subscribe, () => run)

/** The whole run's progress, 0 to 100: the stages before this one, plus the share of this stage's mods read. Pure. */
export const runPercent = (stage: number, last: { at: number; total: number } | null) =>
  ((stage + (last && last.total > 0 ? Math.min(1, last.at / last.total) : 0)) / STAGES.length) * 100

let showTimer: number | undefined
/** Shows the header status once a run has gone on for a moment (a quick run never flashes it). */
const showSoon = () => {
  if (run.shown || showTimer !== undefined) return
  showTimer = window.setTimeout(() => { showTimer = undefined; if (run.running) set({ shown: true }) }, SHOW_AFTER_MS)
}
/** brokenMods.ts: a run of the checks starts, reading the game's files first. */
export const scanStarted = () => { set({ running: true, last: null, read: 0, stage: 0, pct: 0 }); run.pct = 0; showSoon() }
/** brokenMods.ts: the next stage starts (its mods are counted from 0). `count`: textures, which the frontend counts itself. */
export const scanStage = (stage: Stage, count?: { at: number; total: number }) => {
  set({ stage: STAGES.indexOf(stage), last: count ? { step: 'materials', path: '', ...count } : null })
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
  console.assert(progressLine({ step: 'materials', at: 12, total: 216, path: 'x/Cyan_9999999_P.pak' }) === 'VFX materials · Cyan (12 of 216)', 'progress line')
  console.assert(runPercent(0, null) === 0 && Math.round(runPercent(2, { at: 50, total: 100 })) === 36 && runPercent(STAGES.length - 1, { at: 9, total: 9 }) === 100, 'run percent')
}
