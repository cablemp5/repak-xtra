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

export const SAFE_OFF = 'repakxtra.vfx.safeOff' // a mod known to crash that nothing rebuilds: '1' (or an old 'trash') turned off, '0' stays on
export type Safety = 'off' | 'on'
/** What happens to a mod known to crash the game that the updater has nothing to rebuild: off (the default) or left on.
 *  Never deleted, and never applied to a failed update, which leaves the mod as it was. */
export const readSafety = (): Safety => (localStorage.getItem(SAFE_OFF) === '0' ? 'on' : 'off')
/** Turns the mod off (xtra_safe_off.rs keeps it off, with why). 'off', or false when it was already off. Throws when it
 *  could not be turned off. Its Needs update flag stays. */
export async function retireUnsafe(modPath: string, reason: string): Promise<'off' | false> {
  return (await invoke<string | null>('xtra_vfx_turn_off', { modPath, reason })) ? 'off' : false
}
export const REPAIR_POLICY = 'repakxtra.vfx.repairPolicy'
export type RepairPolicy = 'strict' | 'bestEffort'
/** Best effort with a review of each candidate (the default), or Strict, which installs only what it can prove whole. */
export const readRepairPolicy = (): RepairPolicy => (localStorage.getItem(REPAIR_POLICY) === 'strict' ? 'strict' : 'bestEffort')
export const ASK_REVIEW = 'repakxtra.vfx.askReview' // '1': a Best effort candidate waits for Use candidate or Keep original
/** Whether a Best effort candidate waits for a review (off by default: the candidate is used, its report says what it could not prove). */
export const readAskReview = () => localStorage.getItem(ASK_REVIEW) === '1'
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
