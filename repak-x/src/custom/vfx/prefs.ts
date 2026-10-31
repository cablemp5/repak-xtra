// repakxtra: the VFX Updater's choices (Advanced > Names and Originals), read by its window and by an update started from
// a right-click (quick.ts), and the run lock that keeps the two apart: both use one temp folder, and a run clears what
// other runs left there (xtra_vfx.rs make_dirs). The lock lives in the backend (xtra_vfx.rs RunLock), so taking it is
// atomic across windows; each run has its own token, keeps it until it is done (however long a step takes), and the
// lock goes when the window holding it closes. Every window hears when it changes.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const TURN_OFF = 'repakxtra.vfx.turnOff' // before Originals had three choices: '0' left them on
export const KEEP_NAME = 'repakxtra.vfx.keepName' // '0': updates end in _UPDATED
export const ORIGINALS = 'repakxtra.vfx.originals' // what happens to an original: off, trash or keep
export type Naming = 'broken' | 'updated'
export type Originals = 'off' | 'trash' | 'keep'

export const SAFE_OFF = 'repakxtra.vfx.safeOff' // '0': a flagged mod that could not be made safe stays on
/** Whether a flagged mod an update could not make safe is turned off (the default), rather than left on to crash. */
export const readSafeOff = () => localStorage.getItem(SAFE_OFF) !== '0'
export const readNaming = (): Naming => (localStorage.getItem(KEEP_NAME) === '0' ? 'updated' : 'broken')
export function readOriginals(): Originals {
  const v = localStorage.getItem(ORIGINALS)
  if (v === 'off' || v === 'trash' || v === 'keep') return v
  // a choice saved before Originals had three: '1' turned them off, '0' left them on. Only never-chosen gets the new default
  const old = localStorage.getItem(TURN_OFF)
  return old === '1' ? 'off' : old === '0' ? 'keep' : 'trash' // untouched: the original goes to Recently deleted, out of the way and one click back
}

export type RunLock = { token: string; window: string; name?: string | null }
/** A fresh token for one run. */
export const newRunToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
/** Takes the lock for this run (or renews what it is updating). False when another run holds it. */
export const claimRun = (token: string, name?: string) => invoke<boolean>('xtra_vfx_claim', { token, name: name ?? null }).catch(() => false)
export const releaseRun = (token: string) => invoke('xtra_vfx_release', { token }).catch(() => {})
/** The run holding the lock now, if any. */
export const runLock = () => invoke<RunLock | null>('xtra_vfx_lock').catch(() => null)
/** Calls fn with the holder whenever the lock is taken or let go, in any window. */
export function onRunChange(fn: (held: RunLock | null) => void) {
  const un = listen<RunLock | null>('vfx_lock_changed', e => fn(e.payload ?? null))
  return () => { un.then(f => f()) }
}
