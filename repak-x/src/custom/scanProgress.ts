// repakxtra: the background mod checks' progress (brokenMods.ts runs them, each backend scan sends `mod-scan-progress`
// for a mod it is about to read). After a game or app update they can read every mod for many minutes, so a loading
// toast says which check, which mod and how far, and closes when the run ends. Short runs (one new mod) stay quiet: it
// shows only once work has gone on for a moment. The same state feeds ScanStatus.tsx in the header, so a closed or
// missed toast still leaves the progress in view, and a run stopped with mods left says so until it picks up again.
import { useEffect, useSyncExternalStore } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'

type Progress = { step: 'effects' | 'materials' | 'blueprints' | 'meshes'; at: number; total: number; path: string }
/** Sent when a full run of the checks ends (finished, stopped for the game, or failed) */
export const SCAN_DONE = 'repakxtra-scan-done'

const STEP = { effects: 'VFX effects', materials: 'VFX materials', blueprints: 'Blueprints', meshes: 'Meshes' }
/** "C:/x/Cool Mod_9999999_P.bak_repak" is "Cool Mod". Pure. */
export const modLabel = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.(pak|bak_repak|utoc)$/i, '').replace(/_\d+_P$/i, '')
/** "VFX materials · Cool Mod (12 of 216)". Pure. */
export const progressLine = (p: Progress) => `${STEP[p.step] ?? 'Mods'} · ${modLabel(p.path)} (${p.at} of ${p.total})`
const SHOW_AFTER_MS = 1500

/** `shown`: the run has read mods for a moment (its toast is up, or was). `paused`: the last run stopped with mods left.
 *  `held`: the header's Pause or Cancel stopped them (xtra_vfx.rs HELD): they stay stopped until Resume or Refresh list. */
export type ScanRun = { running: boolean; shown: boolean; paused: boolean; last: Progress | null; read: number; held: 'paused' | 'cancelled' | null }
let run: ScanRun = { running: false, shown: false, paused: false, last: null, read: 0, held: null }
const listeners = new Set<() => void>()
const set = (next: Partial<ScanRun>) => { run = { ...run, ...next }; listeners.forEach(l => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
export const useScanRun = () => useSyncExternalStore(subscribe, () => run)

/** brokenMods.ts: a run of the checks starts. */
export const scanStarted = () => set({ running: true, last: null, read: 0 })
/** brokenMods.ts: the run ended. `finished`: false when it stopped with mods left to read, or failed. */
export const scanEnded = (finished: boolean) => {
  set({ running: false, paused: !finished && run.held !== 'cancelled' })
  window.dispatchEvent(new Event(SCAN_DONE))
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

export function useScanProgress(alert: ReturnType<typeof useAlert>) {
  useEffect(() => {
    let id: number | null = null
    let timer: number | undefined
    const show = () => {
      timer = undefined
      if (!run.last) return
      const description = `${progressLine(run.last)}. Pauses while the game runs.`
      if (id === null) id = alert.showAlert({ color: 'default', title: 'Checking mods', description, isLoading: true, duration: 0 })
      else alert.updateToast(id, { description })
      if (!run.shown) set({ shown: true })
    }
    const off = listen<Progress>('mod-scan-progress', e => {
      // a mod being read means a run is on, whatever the start and end calls said
      set({ last: e.payload, read: run.read + 1, running: true, paused: false })
      if (id !== null) show()
      else if (timer === undefined) timer = window.setTimeout(show, SHOW_AFTER_MS)
    })
    const done = () => {
      clearTimeout(timer)
      timer = undefined
      const n = run.read
      if (id !== null) {
        alert.updateToast(id, run.held === 'cancelled'
          ? { color: 'default', title: 'Mod checks cancelled', description: 'Mods not read yet can crash the game without a warning. Refresh list (Ctrl+Shift+R) or the next app start checks them.', isLoading: false, duration: 8000 }
          : run.held === 'paused'
          ? { color: 'default', title: 'Mod checks paused', description: 'Resume them from Checks paused at the top, or with Refresh list (Ctrl+Shift+R).', isLoading: false, duration: 6000 }
          : run.paused
          ? { color: 'default', title: 'Mod checks paused', description: 'Mods are left to read. The checks pick up where they stopped next time you come back with the game closed.', isLoading: false, duration: 6000 }
          : { color: 'success', title: 'Mods checked', description: `${n} ${n === 1 ? 'mod' : 'mods'} read for compatibility.`, isLoading: false, duration: 4000 })
      }
      id = null
      set({ shown: false, last: null, read: 0 })
    }
    window.addEventListener(SCAN_DONE, done)
    return () => { clearTimeout(timer); off.then(f => f()).catch(() => undefined); window.removeEventListener(SCAN_DONE, done) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

if (import.meta.env.DEV) {
  console.assert(modLabel('C:\\Paks\\~mods\\Cool Mod_9999999_P.bak_repak') === 'Cool Mod' && modLabel('a/b_P.pak') === 'b_P', 'mod label')
  console.assert(progressLine({ step: 'materials', at: 12, total: 216, path: 'x/Cyan_9999999_P.pak' }) === 'VFX materials · Cyan (12 of 216)', 'progress line')
}
