// repakxtra: Find the crashing mod (guided bisect). Starts from the mods that are on, turns half the candidates off each
// round, and the answer (still crashes / fixed) keeps the half the crash must be in. Mods outside the candidates stay as
// they were at the start, so only one half ever changes. The end and Cancel put every mod back as it was at the start.
// The run is kept in localStorage, so it survives an app restart between rounds.
import { invoke } from '@tauri-apps/api/core'
import { type KeepDeps, GAME_RUNNING, flipAll, stem } from './keepOne'

type Mod = { path: string; enabled?: boolean }
/** Paths as they were at the start (stems match them after a switch). `off`: the half turned off this round. */
export type Bisect = { start: string[]; candidates: string[]; off: string[]; round: number }

const KEY = 'repakxtra.bisect'
export const OPEN_BISECT = 'repakxtra-crash-bisect'

/** The first half (rounded up) stays on, the rest turns off. */
export const halve = (c: string[]): [on: string[], off: string[]] => {
  const n = Math.ceil(c.length / 2)
  return [c.slice(0, n), c.slice(n)]
}

/** The next candidates: still crashes = the half still on, fixed = the half turned off. */
export const narrow = (b: Bisect, crashes: boolean): string[] => {
  const off = new Set(b.off)
  return b.candidates.filter(p => off.has(p) !== crashes)
}

/** Rounds left in the worst case (the bigger half each time). */
export const roundsLeft = (n: number) => (n <= 1 ? 0 : Math.ceil(Math.log2(n)))

export const readBisect = (): Bisect | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch { return null }
}
const save = (b: Bisect | null) => {
  try { if (b) localStorage.setItem(KEY, JSON.stringify(b)); else localStorage.removeItem(KEY) } catch { /* the run just does not survive a restart */ }
}

/** Switches the start mods so that exactly those not in `off` are on. Returns the refusal, or null. All or none. */
async function apply(d: KeepDeps, b: Bisect, off: string[]) {
  const want = new Map(b.start.map(p => [stem(p), true]))
  for (const p of off) want.set(stem(p), false)
  let now: Mod[]
  try { now = await invoke<Mod[]>('get_pak_files') } catch (e) { return `The mod list could not be read: ${String(e)}` }
  const refused = await flipAll(now.filter(m => want.has(stem(m.path)) && (m.enabled !== false) !== want.get(stem(m.path))))
  await d.reload()
  return refused
}

const blocked = (d: KeepDeps) => {
  if (!d.isBlocked()) return false
  d.alert.warning(...GAME_RUNNING)
  return true
}

/** One round with these candidates: half off, saved. Null when nothing changed (said in a toast). */
async function round(d: KeepDeps, b: Bisect, candidates: string[]) {
  const next = { ...b, candidates, off: halve(candidates)[1], round: b.round + 1 }
  const refused = await apply(d, b, next.off)
  if (refused) { d.alert.warning('Nothing changed', refused); return null }
  save(next)
  return next
}

/** Starts from the mods that are on now. A single mod on is the culprit at once. */
export async function startBisect(d: KeepDeps, mods: Mod[]): Promise<Bisect | string | null> {
  const on = mods.filter(m => m.enabled).map(m => m.path)
  if (!on.length) { d.alert.warning('No mods are on', 'Turn on the mods that crash the game, then try again.'); return null }
  if (on.length === 1) return on[0]
  if (blocked(d)) return null
  return round(d, { start: on, candidates: on, off: [], round: 0 }, on)
}

/** The answer for this round: the next round, or the culprit's path once one is left (every mod already back as it
 *  was). Null when nothing changed. */
export async function answerBisect(d: KeepDeps, b: Bisect, crashes: boolean): Promise<Bisect | string | null> {
  if (blocked(d)) return null
  const left = narrow(b, crashes)
  if (left.length > 1) return round(d, b, left)
  return (await restoreBisect(d, b)) ? left[0] : null
}

/** Every start mod on again (mods off at the start were never touched). False when the restore was refused. */
export async function restoreBisect(d: KeepDeps, b: Bisect) {
  if (blocked(d)) return false
  const refused = await apply(d, b, [])
  if (refused) { d.alert.warning('Mods not restored', refused); return false }
  save(null)
  return true
}

if (import.meta.env.DEV) {
  const mods = Array.from({ length: 30 }, (_, i) => `m${i}.pak`)
  console.assert(halve(['a', 'b', 'c']).join('|') === 'a,b|c', 'odd counts keep the bigger half on')
  // finds every possible culprit among 30 in at most 5 rounds, whichever half it sits in
  for (const culprit of mods) {
    let b: Bisect = { start: mods, candidates: mods, off: halve(mods)[1], round: 1 }
    while (true) {
      const left = narrow(b, !b.off.includes(culprit))
      if (left.length === 1) { console.assert(left[0] === culprit && b.round <= 5, `bisect finds ${culprit}`, b); break }
      b = { ...b, candidates: left, off: halve(left)[1], round: b.round + 1 }
    }
  }
  console.assert(roundsLeft(30) === 5 && roundsLeft(2) === 1 && roundsLeft(1) === 0, 'about log2(n) rounds')
}
