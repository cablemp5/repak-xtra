// repakxtra: Find the crashing mod (guided bisect). Four kinds of test, each one game launch:
//   baseline  every mod off: a crash then means the cause is not one of these mods, and the test stops
//   halve     the mods proven fine (`ok`) and half of the suspects on, everything else off: a crash keeps that half,
//             no crash proves it fine and keeps the other half. When the newest crash report names a file some suspects
//             replace (`likely`), those alone are the half turned off: when they are the cause, only they are left
//   confirm   the starting setup with only the last suspect (and any found before) off: proves it before it is named
//   reproduce the last suspect back on with every mod proven fine, when the setup without it already played fine but no
//             test with it on has crashed yet (every answer so far was No crash): a mod is named only once a test with it
//             on crashed. When the last suspect was on in the crash just answered, nothing is left to test: it is named
// When the confirm test still crashes, another mod crashes the game too: the suspect stays off (`found`) and the search
// goes on among the mods not yet proven fine, so two or more mods that each crash it are all named. Only mods proven
// fine stay on during a search: a second crashing mod left on would make every test crash. The run is saved before any
// file changes and kept until the mods are back, so an app restart (or a crash of repakxtra itself) resumes it. The end and Stop put every mod back.
import { invoke } from '@tauri-apps/api/core'
import { type KeepDeps, flipAll, stem } from './keepOne'
import { isModLoader, nameKey } from './loadoutStore'
import { MOD_LOADERS } from './edition'

type Mod = { path: string; enabled?: boolean }
export type Phase = 'baseline' | 'halve' | 'confirm' | 'reproduce'
/** `start`: the paths that were on at the start (stems match them after a switch). `off`: the suspects off in this test.
 *  `found`: mods that crash the game but are not the only cause, kept off in every later test. `tests`: answers so far.
 *  `prev`: the test before, for Undo last answer. */
export type Bisect = { start: string[]; candidates: string[]; off: string[]; phase: Phase; tests: number; found?: string[]; ok?: string[]; likely?: string[]; prev?: Bisect }
export type Outcome =
  | { kind: 'run'; run: Bisect }
  | { kind: 'found'; culprits: string[] }   // turning these off stopped the crash
  | { kind: 'not-mods' }                    // it crashed with every suspect off
  | { kind: 'unsure'; culprit: string }     // still crashed with every suspect but this one ruled out: an unsteady crash
  | { kind: 'no-repro'; culprit: string }   // no crash with the last suspect back on either: the crash did not come back

const KEY = 'repakxtra.bisect'
export const OPEN_BISECT = 'repakxtra-crash-bisect'

/** The first half (rounded up) stays on, the rest turns off. */
export const halve = (c: string[]): [on: string[], off: string[]] => {
  const n = Math.ceil(c.length / 2)
  return [c.slice(0, n), c.slice(n)]
}

/** The `likely` mods among `c`, when testing them first finds a cause among them in fewer tests than halving `c`. */
export const likelyIn = (c: string[], likely: string[] = []) => {
  const l = c.filter(p => likely.includes(p))
  return l.length && roundsLeft(l.length) + 1 < roundsLeft(c.length) ? l : []
}

/** The part that turns off in a halving test: the likely mods when there are any, else the second half. */
const split = (c: string[], likely?: string[]) => {
  const l = likelyIn(c, likely)
  return l.length ? l : halve(c)[1]
}

/** Worst-case halving tests to get from n suspects to one. */
export const roundsLeft = (n: number) => (n <= 1 ? 0 : Math.ceil(Math.log2(n)))

/** Worst-case tests to name one of n suspects by halving: the halvings and the last test (confirm or reproduce). */
const cost = (n: number) => roundsLeft(n) + 1
/** The same for these suspects, splitting them the way the search will (the likely ones first where that is faster). */
const worst = (c: string[], likely?: string[]): number => {
  if (c.length <= 1) return 1
  const off = new Set(split(c, likely))
  return 1 + Math.max(worst(c.filter(p => off.has(p)), likely), worst(c.filter(p => !off.has(p)), likely))
}
/** Worst-case tests when the `likely` mods (this many) hold the cause: the first test, theirs, then the search among them. */
export const estimateLikely = (likely: number) => 2 + cost(likely)

/** Tests in this run so far plus the ones still to come in the worst case (this one included). */
export const estimate = (b: Bisect) => b.tests + (
  b.phase === 'baseline' ? 1 + worst(b.candidates, b.likely)
  : b.phase === 'halve' ? 1 + Math.max(worst(b.candidates.filter(p => b.off.includes(p)), b.likely), worst(b.candidates.filter(p => !b.off.includes(p)), b.likely))
  : 1)

/** The mods off in a test. Confirm: the suspect and the ones found. Otherwise: all but the proven fine and the suspects'
 *  half that is on (reproduce: its `off` is empty, so only the ones found stay off). */
export function testOff(b: Bisect) {
  if (b.phase === 'confirm') return [...b.candidates, ...(b.found ?? [])]
  const on = new Set([...(b.ok ?? []), ...b.candidates.filter(p => !b.off.includes(p))])
  return b.start.filter(p => !on.has(p))
}

/** The first test: every suspect off. `likely`: the ones the newest crash report points at, tested first. */
export const firstTest = (on: string[], likely?: string[]): Bisect => ({ start: on, candidates: on, off: on, phase: 'baseline', tests: 0, ...(likely?.length ? { likely } : {}) })

/** What one answer leads to. Pure: the file changes happen in the async steps below. */
export function next(b: Bisect, crashed: boolean): Outcome {
  const found = b.found ?? []
  const ok = b.ok ?? []
  const run = (phase: Phase, candidates: string[], off: string[], f: string[], k: string[]): Outcome =>
    ({ kind: 'run', run: { start: b.start, candidates, off, phase, tests: b.tests + 1, found: f, ok: k, likely: b.likely, prev: b } })
  // a search among `rest` (`hit`: they were on in the crash just answered): halving, or the last test when one is left.
  // The setup with every other mod proven fine (or found, off) and that one off is the last no-crash test: the proven
  // fine set only grows by a whole no-crash test. So confirm would repeat it: after a crash with it on it is named,
  // else the reproduce test turns it back on to see the crash come back
  const search = (rest: string[], f: string[], k: string[], hit: boolean): Outcome => {
    if (rest.length > 1) return run('halve', rest, split(rest, b.likely), f, k)
    const [x] = rest
    if (!b.start.every(p => p === x || f.includes(p) || k.includes(p))) return run('confirm', rest, rest, f, k)
    return hit ? { kind: 'found', culprits: [...f, x] } : run('reproduce', rest, [], f, k)
  }
  if (b.phase === 'baseline') return crashed ? { kind: 'not-mods' } : search(b.candidates, found, ok, false)
  if (b.phase === 'confirm') {
    const [c] = b.candidates
    if (!crashed) return { kind: 'found', culprits: [...found, c] }
    // it crashed with this one off too: another mod crashes it. This one stays off while the rest are searched.
    const rest = b.start.filter(p => p !== c && !found.includes(p) && !ok.includes(p))
    return rest.length ? search(rest, [...found, c], ok, true) : { kind: 'unsure', culprit: c }
  }
  if (b.phase === 'reproduce') {
    const [x] = b.candidates
    if (crashed) return { kind: 'found', culprits: [...found, x] }
    // the setup with the ones found off played fine before too: they stand, this one is cleared
    return found.length ? { kind: 'found', culprits: found } : { kind: 'no-repro', culprit: x }
  }
  const off = new Set(b.off)
  const onHalf = b.candidates.filter(p => !off.has(p))
  // no crash: every mod that was on is fine
  return crashed ? search(onHalf, found, ok, true) : search(b.candidates.filter(p => off.has(p)), found, [...ok, ...onHalf], false)
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
export const startBisect = serial(async (d: KeepDeps, mods: Mod[], likely?: string[]) => {
  const on = suspects(mods).map(m => m.path)
  if (!on.length) { d.alert.warning('No mods are on', 'Turn on the mods you played with when it crashed, then try again.'); return null }
  if (await gameOpen(d)) return null
  return goTo(d, null, firstTest(on, likely?.filter(p => on.includes(p))))
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

/** When the last test ended (ms): App keeps a crash toast quiet for 30 s after, as the test's own crash can be found
 *  by the game poll only after the answer put every mod back. A new run of the game ends that early (gameSeen). */
let ended = 0
export const testRecent = () => readBisect() !== null || Date.now() - ended < 30_000
export const gameSeen = () => { ended = 0 }

/** Every start mod on again (mods off at the start were never touched). The run stays saved until this works. */
export const restoreBisect = serial((d: KeepDeps, b: Bisect) => restore(d, b))
async function restore(d: KeepDeps, b: Bisect) {
  if (await gameOpen(d)) return false
  const refused = await apply(d, b, [], false)
  if (refused) { d.alert.warning('Mods not restored yet', `${refused} The test stays open so you can try again.`); return false }
  save(null)
  ended = Date.now()
  return true
}

if (import.meta.env.DEV) {
  const mods = Array.from({ length: 30 }, (_, i) => `m${i}.pak`)
  console.assert(halve(['a', 'b', 'c']).join('|') === 'a,b|c', 'odd counts keep the bigger half on')
  // this edition's own loader (another edition's is an ordinary mod)
  console.assert(drift([{ path: `C:/g/~mods/!${MOD_LOADERS[0]}_9999999_P.pak`, enabled: true }, { path: 'C:/g/~mods/a.pak', enabled: true }], firstTest(['C:/g/~mods/a.pak'])) === null, 'an enabled loader is no drift')
  // a player who answers truthfully: the game crashes while `cause` is on
  const play = (cause: (on: (p: string) => boolean) => boolean, start = mods, likely?: string[]) => {
    let b = firstTest(start, likely)
    for (let i = 0; i < 40; i++) {
      const off = new Set(testOff(b))
      const o = next(b, cause(p => start.includes(p) && !off.has(p)))
      if (o.kind !== 'run') return { o, tests: b.tests + 1, est: estimate(firstTest(start, likely)) }
      b = o.run
    }
    return null
  }
  for (const culprit of mods) {
    const r = play(on => on(culprit))
    console.assert(r?.o.kind === 'found' && r.o.culprits.join() === culprit && r.tests <= r.est && r.tests <= 7, `finds ${culprit} within 7 tests`, r)
  }
  console.assert(play(() => true)?.o.kind === 'not-mods', 'a crash with every mod off blames no mod')
  // the crash report points at one of 30 mods: right, 3 tests
  const hit1 = play(on => on('m7.pak'), mods, ['m7.pak'])
  console.assert(hit1?.o.kind === 'found' && hit1.o.culprits.join() === 'm7.pak' && hit1.tests === 3 && hit1.tests <= estimateLikely(1), 'a right one-mod crash report finds it in 3 tests', hit1)
  // the crash report points at two of 30 mods: right, 4 tests instead of 7, wrong, at most 8
  const likely = ['m7.pak', 'm21.pak']
  const hit = play(on => on('m21.pak'), mods, likely)
  console.assert(hit?.o.kind === 'found' && hit.o.culprits.join() === 'm21.pak' && hit.tests === 4 && hit.tests === estimateLikely(2) && hit.est === 8, 'a right crash report finds it in 4 tests', hit)
  for (const culprit of mods) {
    const r = play(on => on(culprit), mods, likely)
    console.assert(r?.o.kind === 'found' && r.o.culprits.join() === culprit && r.tests <= r.est, `with a crash report hint, finds ${culprit} within the estimate`, r)
  }
  for (const bad of [['m7.pak', 'm20.pak'], ['m3.pak', 'm9.pak'], ['m7.pak', 'm21.pak']]) {
    const r = play(on => bad.some(on), mods, likely)?.o
    console.assert(r?.kind === 'found' && [...r.culprits].sort().join() === [...bad].sort().join(), `with a crash report hint, names every mod that crashes it alone: ${bad}`, r)
  }
  console.assert(likelyIn(['a', 'b', 'c', 'd'], ['a', 'b']).length === 0 && likelyIn(['a', 'b', 'c', 'd'], ['a']).join() === 'a'
    && likelyIn(mods, mods.slice(0, 8)).length === 8 && likelyIn(mods, mods.slice(0, 9)).length === 0, 'likely mods lead only when that is faster when they are right')
  // the progress total never grows while the first crashing mod is looked for, with any hint size
  for (const n of [1, 2, 5, 8, 9, 15]) for (const culprit of ['m0.pak', 'm14.pak', 'm29.pak']) {
    let b = firstTest(mods, mods.slice(0, n))
    const top = estimate(b)
    for (let i = 0; i < 40; i++) {
      const o = next(b, !testOff(b).includes(culprit))
      if (o.kind !== 'run') { console.assert(b.tests + 1 <= top, 'never more tests than the first estimate', n, culprit); break }
      console.assert(estimate(o.run) <= top, 'the total never grows', n, culprit, o.run)
      b = o.run
    }
  }
  // two mods that only crash together: either one is a true answer (turning it off stops the crash)
  const pair = play(on => on('m3.pak') && on('m20.pak'))?.o
  console.assert(pair?.kind === 'found' && pair.culprits.length === 1 && ['m3.pak', 'm20.pak'].includes(pair.culprits[0]), 'two mods crashing together: names one that stops it', pair)
  // two (or three) mods that each crash it on their own: every one is named, each kept off while the next is found
  for (const bad of [['m3.pak', 'm20.pak'], ['m0.pak', 'm1.pak'], ['m5.pak', 'm17.pak', 'm29.pak'], ['m2.pak', 'm9.pak', 'm16.pak', 'm23.pak']]) {
    const r = play(on => bad.some(on))?.o
    console.assert(r?.kind === 'found' && [...r.culprits].sort().join() === [...bad].sort().join(), `names every mod that crashes it alone: ${bad}`, r)
  }
  const one = play(on => on('m0.pak'), ['m0.pak'])
  console.assert(one?.o.kind === 'found' && one.tests === 2 && one.est === 2, 'one mod on: all off, then back on', one)
  // a crash that never comes back names no mod (every answer No crash), with or without a crash report hint
  for (const [start, hint] of [[mods, undefined], [mods.slice(0, 4), ['m2.pak']], [['m0.pak'], undefined]] as const) {
    const r = play(() => false, [...start], hint && [...hint])
    console.assert(r?.o.kind === 'no-repro' && r.tests <= r.est, 'a crash that never comes back names no mod', r)
  }
  // no test repeats the setup of the test before it
  {
    let b = firstTest(mods, ['m7.pak'])
    for (let i = 0; i < 40; i++) {
      const o = next(b, ['m7.pak', 'm12.pak'].some(p => !testOff(b).includes(p)))
      if (o.kind !== 'run') break
      console.assert(testOff(o.run).join() !== testOff(b).join(), 'a test never repeats the one before', b, o.run)
      b = o.run
    }
  }
  console.assert(duplicates([{ path: 'a.bak_repak', enabled: false }, { path: 'a.pak_disabled', enabled: false }, { path: 'b.pak', enabled: true }], ['a.pak', 'b.pak']).join() === 'a',
    'an on copy and an off copy of one mod are refused')
  console.assert(duplicates([{ path: 'a.pak', enabled: true }, { path: 'b.pak_disabled', enabled: false }], ['a.pak']).length === 0, 'one file per mod is fine')
  const b = firstTest(['a.pak', 'zz.pak'])
  console.assert(drift([{ path: 'a.pak', enabled: true }], b) === '1 of the tested mods is gone.', 'a removed mod is drift')
  console.assert(drift([{ path: 'a.pak_disabled', enabled: false }, { path: 'zz.pak', enabled: true }, { path: 'new.pak', enabled: true }], b) === '1 other mod was turned on.', 'a new mod turned on is drift, a switched one is not')
}
