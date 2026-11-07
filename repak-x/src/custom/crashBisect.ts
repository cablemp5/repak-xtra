// repakxtra: Find the crashing mod (guided bisect). Three kinds of test, each one game launch:
//   baseline  every mod off: a crash then means the cause is not one of these mods, and the test stops
//   halve     the mods proven fine (`ok`) and half of the suspects on, everything else off: a crash keeps that half,
//             no crash proves it fine and keeps the other half
//   confirm   the starting setup with only the last suspect (and any found before) off: proves it before it is named
// When the confirm test still crashes, another mod crashes the game too: the suspect stays off (`found`) and the search
// goes on among the mods not yet proven fine, so two or more mods that each crash it are all named. Only mods proven
// fine stay on during a search: a second crashing mod left on would make every test crash. The run is saved before any
// file changes and kept until the mods are back, so an app restart (or a crash of repakxtra itself) resumes it. The end and Stop put every mod back.
import { invoke } from '@tauri-apps/api/core'
import { type KeepDeps, flipAll, stem } from './keepOne'
import { isModLoader, nameKey } from './loadoutStore'

type Mod = { path: string; enabled?: boolean }
export type Phase = 'baseline' | 'halve' | 'confirm'
/** `start`: the paths that were on at the start (stems match them after a switch). `off`: the suspects off in this test.
 *  `found`: mods that crash the game but are not the only cause, kept off in every later test. `tests`: answers so far.
 *  `prev`: the test before, for Undo last answer. */
export type Bisect = { start: string[]; candidates: string[]; off: string[]; phase: Phase; tests: number; found?: string[]; ok?: string[]; prev?: Bisect }
export type Outcome =
  | { kind: 'run'; run: Bisect }
  | { kind: 'found'; culprits: string[] }   // turning these off stopped the crash
  | { kind: 'not-mods' }                    // it crashed with every suspect off
  | { kind: 'unsure'; culprit: string }     // still crashed with every suspect but this one ruled out: an unsteady crash

const KEY = 'repakxtra.bisect'
export const OPEN_BISECT = 'repakxtra-crash-bisect'

/** The first half (rounded up) stays on, the rest turns off. */
export const halve = (c: string[]): [on: string[], off: string[]] => {
  const n = Math.ceil(c.length / 2)
  return [c.slice(0, n), c.slice(n)]
}

/** Worst-case halving tests to get from n suspects to one. */
export const roundsLeft = (n: number) => (n <= 1 ? 0 : Math.ceil(Math.log2(n)))

/** Tests in this run so far plus the ones still to come in the worst case (this one included). */
export const estimate = (b: Bisect) => b.tests + (
  b.phase === 'baseline' ? 1 + (b.candidates.length > 1 ? roundsLeft(b.candidates.length) + 1 : 0)
  : b.phase === 'halve' ? roundsLeft(b.candidates.length) + 1
  : 1)

/** The mods off in a test. Confirm: the suspect and the ones found. Otherwise: all but the proven fine and the suspects'
 *  half that is on. */
export function testOff(b: Bisect) {
  if (b.phase === 'confirm') return [...b.candidates, ...(b.found ?? [])]
  const on = new Set([...(b.ok ?? []), ...b.candidates.filter(p => !b.off.includes(p))])
  return b.start.filter(p => !on.has(p))
}

/** The first test: every suspect off. */
export const firstTest = (on: string[]): Bisect => ({ start: on, candidates: on, off: on, phase: 'baseline', tests: 0 })

/** What one answer leads to. Pure: the file changes happen in the async steps below. */
export function next(b: Bisect, crashed: boolean): Outcome {
  const found = b.found ?? []
  const ok = b.ok ?? []
  const run = (phase: Phase, candidates: string[], off: string[], f: string[], k: string[]): Outcome =>
    ({ kind: 'run', run: { start: b.start, candidates, off, phase, tests: b.tests + 1, found: f, ok: k, prev: b } })
  // a search among `rest`: halving, or straight to the confirm test when one is left
  const search = (rest: string[], f: string[], k: string[]) => rest.length > 1 ? run('halve', rest, halve(rest)[1], f, k) : run('confirm', rest, rest, f, k)
  if (b.phase === 'baseline') {
    if (crashed) return { kind: 'not-mods' }
    return b.candidates.length === 1 ? { kind: 'found', culprits: b.candidates } : search(b.candidates, found, ok)
  }
  if (b.phase === 'confirm') {
    const [c] = b.candidates
    if (!crashed) return { kind: 'found', culprits: [...found, c] }
    // it crashed with this one off too: another mod crashes it. This one stays off while the rest are searched.
    const rest = b.start.filter(p => p !== c && !found.includes(p) && !ok.includes(p))
    return rest.length ? search(rest, [...found, c], ok) : { kind: 'unsure', culprit: c }
  }
  const off = new Set(b.off)
  const onHalf = b.candidates.filter(p => !off.has(p))
  // no crash: every mod that was on is fine
  return crashed ? search(onHalf, found, ok) : search(b.candidates.filter(p => off.has(p)), found, [...ok, ...onHalf])
}

export const readBisect = (): Bisect | null => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch { return null }
}
const save = (b: Bisect | null) => {
  try { if (b) localStorage.setItem(KEY, JSON.stringify(b)); else localStorage.removeItem(KEY); return true } catch { return false }
}

/** The game process itself (not the app's game lock, which a setting can bypass). Throws when it cannot be checked. */
export const gameRunning = () => invoke<boolean>('check_game_running').then(Boolean)

/** What changed in the mod list since the start, in words, or null. Mods added or removed mid-test make the answers
 *  mean something else. */
export function drift(now: Mod[], b: Bisect): string | null {
  const have = new Set(now.map(m => stem(m.path)))
  const start = new Set(b.start.map(stem))
  const gone = b.start.filter(p => !have.has(stem(p))).length
  const added = now.filter(m => m.enabled !== false && !isModLoader(m.path) && !start.has(stem(m.path))).length // a loader is never tested
  if (!gone && !added) return null
  return [gone && `${gone} of the tested mods ${gone === 1 ? 'is' : 'are'} gone`, added && `${added} other mod${added === 1 ? ' was' : 's were'} turned on`]
    .filter(Boolean).join(' and ') + '.'
}

/** Mods with two files in the folder (an on copy and an off copy of the same name): a switch matches mods by name, so it
 *  could turn on the wrong copy or overwrite one. The test refuses them instead of guessing. */
export function duplicates(now: Mod[], start: string[]) {
  const want = new Set(start.map(stem))
  const count = new Map<string, number>()
  for (const m of now) if (want.has(stem(m.path))) count.set(stem(m.path), (count.get(stem(m.path)) ?? 0) + 1)
  return [...new Set(now.filter(m => (count.get(stem(m.path)) ?? 0) > 1).map(m => nameKey(m.path)))]
}

/** Start mods whose on/off state is not what this test (its `off`) needs. */
const mismatched = (now: Mod[], b: Bisect, off: string[]) => {
  const offStems = new Set(off.map(stem))
  const start = new Set(b.start.map(stem))
  return now.filter(m => start.has(stem(m.path)) && (m.enabled !== false) === offStems.has(stem(m.path))).length
}

/** Is the mod setup on disk the one this test needs? The answer only means something then. Null when it is. */
export async function verify(b: Bisect) {
  let now: Mod[]
  try { now = await invoke<Mod[]>('get_pak_files') } catch (e) { return `The mod list could not be read: ${String(e)}` }
  const hand = mismatched(now, b, testOff(b))
  const changed = drift(now, b) ?? (hand ? `${hand === 1 ? '1 mod was' : `${hand} mods were`} switched by hand.` : null)
  return changed && `Your mods changed during this test: ${changed} Stop and restore mods, then start testing again.`
}

/** Switches the start mods so that exactly those not in `off` are on. Returns the refusal, or null. All or none.
 *  `strict`: refuse when the mod list changed since the start (tests), not when putting mods back. */
/** Runs whole steps (check, switch, save) one at a time: an overlapping one (a double click, a remount, Stop while a
 *  resume runs) starts from what the last one left, so it never flips the same mods back or revives a stopped test. */
let busy: Promise<unknown> = Promise.resolve()
const serial = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => {
  const run = busy.then(() => fn(...a))
  busy = run.catch(() => {})
  return run
}

async function apply(d: KeepDeps, b: Bisect, off: string[], strict: boolean) {
  const want = new Map(b.start.map(p => [stem(p), true]))
  for (const p of off) want.set(stem(p), false)
  let now: Mod[]
  try { now = await invoke<Mod[]>('get_pak_files') } catch (e) { return `The mod list could not be read: ${String(e)}` }
  const twice = duplicates(now, b.start)
  if (twice.length) return `${twice.join(', ')} ${twice.length === 1 ? 'is' : 'are'} in the mods folder twice, once on and once off. Delete the extra copy, then try again.`
  const changed = strict ? drift(now, b) : null
  if (changed) return `Your mods changed during this test: ${changed} Stop and restore mods, then start testing again.`
  const refused = await flipAll(now.filter(m => want.has(stem(m.path)) && (m.enabled !== false) !== want.get(stem(m.path))))
  await d.reload()
  return refused
}

/** True (and said in a toast) while the game runs, or when that cannot be checked: mods never switch under it. */
export const gameOpen = async (d: KeepDeps) => {
  let running: boolean
  try { running = await gameRunning() } catch { d.alert.warning('Nothing changed', 'repakxtra could not check whether the game is running. Try again in a moment.'); return true }
  if (running) d.alert.warning('Game running', 'Close the game first. Mods can only change while it is closed.')
  return running
}

/** Moves to `to`: saved first, so a restart mid-switch still knows how to put mods back. On a refusal the saved run goes
 *  back to `from` (null: none). */
async function goTo(d: KeepDeps, from: Bisect | null, to: Bisect) {
  if (!save(to)) { d.alert.warning('Nothing changed', 'The test could not be saved, so no mods were switched.'); return null }
  const refused = await apply(d, to, testOff(to), true)
  if (!refused) return to
  // the saved run goes back only when the files did too: otherwise it stays, so Stop and restore mods can still fix them
  const now = await invoke<Mod[]>('get_pak_files').catch(() => null)
  const back = now && mismatched(now, to, from ? testOff(from) : []) === 0
  if (back) save(from)
  d.alert.warning(back ? 'Nothing changed' : 'Some mods did not switch', back ? refused : `${refused} Stop and restore mods to put them all back.`)
  return null
}

/** A saved test after a restart: finishes a switch the restart cut off. `changed`: files had to be switched, so any
 *  play before the restart was with other mods. */
export const resumeBisect = serial(async (d: KeepDeps, b: Bisect): Promise<{ refused?: string; changed: boolean }> => {
  if (!readBisect()) return { refused: 'This test was already stopped.', changed: false }
  if (!(await verify(b))) return { changed: false }
  if (await gameOpen(d)) return { refused: 'Close the game, then reopen this.', changed: false }
  const refused = await apply(d, b, testOff(b), true)
  return { refused: refused ?? undefined, changed: true }
})

/** The mods a search tests: the ones on now, never a mod loader (every mod made for it needs it on). */
export const suspects = (mods: Mod[]) => mods.filter(m => m.enabled && !isModLoader(m.path))

/** Starts from the mods that are on now: the first test turns them all off. */
export const startBisect = serial(async (d: KeepDeps, mods: Mod[]) => {
  const on = suspects(mods).map(m => m.path)
  if (!on.length) { d.alert.warning('No mods are on', 'Turn on the mods you played with when it crashed, then try again.'); return null }
  if (await gameOpen(d)) return null
  return goTo(d, null, firstTest(on))
})

/** One answer: the next test, or the outcome with every mod already back as it was. Null when nothing changed. */
export const answerBisect = serial(async (d: KeepDeps, b: Bisect, crashed: boolean): Promise<Outcome | null> => {
  if (!readBisect()) return null   // stopped while this answer waited its turn
  if (await gameOpen(d)) return null
  const wrong = await verify(b)
  if (wrong) { d.alert.warning('Answer not counted', wrong); return null }
  const o = next(b, crashed)
  if (o.kind === 'run') { const r = await goTo(d, b, o.run); return r && o }
  return (await restore(d, b)) ? o : null
})

/** Back to a test: Undo last answer (its `prev`), or from the outcome the last test again (mods were already back). */
export const returnTo = serial(async (d: KeepDeps, from: Bisect | null, to: Bisect) => {
  // an Undo that waited its turn behind Stop (or another answer) must not bring that test back
  if (from && JSON.stringify(readBisect()) !== JSON.stringify(from)) return null
  if (await gameOpen(d)) return null
  return goTo(d, from, to)
})

/** Every start mod on again (mods off at the start were never touched). The run stays saved until this works. */
export const restoreBisect = serial((d: KeepDeps, b: Bisect) => restore(d, b))
async function restore(d: KeepDeps, b: Bisect) {
  if (await gameOpen(d)) return false
  const refused = await apply(d, b, [], false)
  if (refused) { d.alert.warning('Mods not restored yet', `${refused} The test stays open so you can try again.`); return false }
  save(null)
  return true
}

if (import.meta.env.DEV) {
  const mods = Array.from({ length: 30 }, (_, i) => `m${i}.pak`)
  console.assert(halve(['a', 'b', 'c']).join('|') === 'a,b|c', 'odd counts keep the bigger half on')
  console.assert(drift([{ path: 'C:/g/~mods/!ProjectGalacta_9999999_P.pak', enabled: true }, { path: 'C:/g/~mods/a.pak', enabled: true }], firstTest(['C:/g/~mods/a.pak'])) === null, 'an enabled loader is no drift')
  // a player who answers truthfully: the game crashes while `cause` is on
  const play = (cause: (on: (p: string) => boolean) => boolean, start = mods) => {
    let b = firstTest(start)
    for (let i = 0; i < 40; i++) {
      const off = new Set(testOff(b))
      const o = next(b, cause(p => start.includes(p) && !off.has(p)))
      if (o.kind !== 'run') return { o, tests: b.tests + 1, est: estimate(firstTest(start)) }
      b = o.run
    }
    return null
  }
  for (const culprit of mods) {
    const r = play(on => on(culprit))
    console.assert(r?.o.kind === 'found' && r.o.culprits.join() === culprit && r.tests <= r.est && r.tests <= 7, `finds ${culprit} within 7 tests`, r)
  }
  console.assert(play(() => true)?.o.kind === 'not-mods', 'a crash with every mod off blames no mod')
  // two mods that only crash together: either one is a true answer (turning it off stops the crash)
  const pair = play(on => on('m3.pak') && on('m20.pak'))?.o
  console.assert(pair?.kind === 'found' && pair.culprits.length === 1 && ['m3.pak', 'm20.pak'].includes(pair.culprits[0]), 'two mods crashing together: names one that stops it', pair)
  // two (or three) mods that each crash it on their own: every one is named, each kept off while the next is found
  for (const bad of [['m3.pak', 'm20.pak'], ['m0.pak', 'm1.pak'], ['m5.pak', 'm17.pak', 'm29.pak'], ['m2.pak', 'm9.pak', 'm16.pak', 'm23.pak']]) {
    const r = play(on => bad.some(on))?.o
    console.assert(r?.kind === 'found' && [...r.culprits].sort().join() === [...bad].sort().join(), `names every mod that crashes it alone: ${bad}`, r)
  }
  console.assert(play(on => on('m0.pak'), ['m0.pak'])?.o.kind === 'found', 'one mod on: the first test proves it')
  console.assert(duplicates([{ path: 'a.bak_repak', enabled: false }, { path: 'a.pak_disabled', enabled: false }, { path: 'b.pak', enabled: true }], ['a.pak', 'b.pak']).join() === 'a',
    'an on copy and an off copy of one mod are refused')
  console.assert(duplicates([{ path: 'a.pak', enabled: true }, { path: 'b.pak_disabled', enabled: false }], ['a.pak']).length === 0, 'one file per mod is fine')
  const b = firstTest(['a.pak', 'zz.pak'])
  console.assert(drift([{ path: 'a.pak', enabled: true }], b) === '1 of the tested mods is gone.', 'a removed mod is drift')
  console.assert(drift([{ path: 'a.pak_disabled', enabled: false }, { path: 'zz.pak', enabled: true }, { path: 'new.pak', enabled: true }], b) === '1 other mod was turned on.', 'a new mod turned on is drift, a switched one is not')
}
