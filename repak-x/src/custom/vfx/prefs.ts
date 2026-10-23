// repakxtra: the VFX Updater's choices (Advanced > Names and Originals), read by its window and by an update started from
// a right-click (quick.ts), and the lock that keeps the two from running at once: both use one temp folder, and a run
// clears what other runs left there (xtra_vfx.rs make_dirs). The lock is a localStorage entry every window sees, renewed
// at each step: one that has not been renewed for STALE_MS (a window closed mid-run) no longer holds.
export const TURN_OFF = 'repakxtra.vfx.turnOff' // before Originals had three choices: '0' left them on
export const KEEP_NAME = 'repakxtra.vfx.keepName' // '0': updates end in _UPDATED
export const ORIGINALS = 'repakxtra.vfx.originals' // what happens to an original: off, trash or keep
export type Naming = 'broken' | 'updated'
export type Originals = 'off' | 'trash' | 'keep'

export const readNaming = (): Naming => (localStorage.getItem(KEEP_NAME) === '0' ? 'updated' : 'broken')
export function readOriginals(): Originals {
  const v = localStorage.getItem(ORIGINALS)
  return v === 'off' || v === 'trash' || v === 'keep' ? v : localStorage.getItem(TURN_OFF) === '0' ? 'keep' : 'off'
}

const LOCK = 'repakxtra-vfx:running' // not repakxtra.*: devStorage would copy it to the shared file
const STALE_MS = 120_000
type Lock = { owner: string; at: number; name?: string }

const read = (): Lock | null => { try { return JSON.parse(localStorage.getItem(LOCK) || 'null') } catch { return null } }
/** Who is updating now, if anyone else is (a lock not renewed for two minutes is gone). */
export function runningElsewhere(owner: string): Lock | null {
  const l = read()
  return l && l.owner !== owner && Date.now() - l.at < STALE_MS ? l : null
}
/** Takes the lock (or renews it, with what is being updated). False when another window holds it. */
export function claimRun(owner: string, name?: string) {
  if (runningElsewhere(owner)) return false
  localStorage.setItem(LOCK, JSON.stringify({ owner, at: Date.now(), name } satisfies Lock))
  return true
}
export function releaseRun(owner: string) {
  if (read()?.owner === owner) localStorage.removeItem(LOCK)
}

if (import.meta.env.DEV && !read()) { // never while a real run holds it
  console.assert(claimRun('a') && !claimRun('b') && runningElsewhere('b')?.owner === 'a', 'one run at a time')
  releaseRun('b')
  console.assert(runningElsewhere('b')?.owner === 'a', 'only its owner releases it')
  releaseRun('a')
  console.assert(!runningElsewhere('b') && claimRun('b'), 'free again')
  releaseRun('b')
}

/** Calls fn when another window takes or lets go of the lock. */
export function onRunChange(fn: () => void) {
  const l = (e: StorageEvent) => { if (e.key === LOCK) fn() }
  window.addEventListener('storage', l)
  return () => window.removeEventListener('storage', l)
}
