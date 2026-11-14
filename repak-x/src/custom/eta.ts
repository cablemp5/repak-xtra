// repakxtra: the time left for the mod scan (ScanStatus.tsx) and preview batches (previews.tsx), learned on this PC: the
// last 20 times of each kind, their median once there are 3, blended with the run's own pace as it goes (the run's pace
// takes over by a third of the way in). Laws of UX: a known wait feels shorter than an open one (Doherty Threshold).
import { plural } from './modName'

const KEY = 'repakxtra.eta.v1'
const KEEP = 20

const read = (): Record<string, number[]> => {
  try { const s = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return s && typeof s === 'object' ? s : {} } catch { return {} }
}
/** One finished item's time, for its kind ("scan-unit", "preview", "preview-anim"). */
export function learn(kind: string, ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return
  try {
    const s = read()
    s[kind] = [...(Array.isArray(s[kind]) ? s[kind] : []), Math.round(ms)].slice(-KEEP)
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch { /* storage unavailable: no estimate learned */ }
}
/** The middle of 3 or more, so one slow run (a cold cache, a busy PC) never sets the estimate alone. Pure. */
export const median = (xs: unknown) => (!Array.isArray(xs) || xs.length < 3 ? undefined : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number)
/** This PC's usual time for one item of `kind`, or undefined before 3 are known. */
export const typical = (kind: string) => median(read()[kind])
/** The time left from past runs (`prior`) and from this run's pace (`live`), `share` of the way in (0 to 1). Pure. */
export const blend = (prior: number | undefined, live: number | undefined, share: number) => {
  if (prior === undefined || live === undefined) return live ?? prior
  const w = Math.min(1, Math.max(0, share) / 0.3)
  return live * w + prior * (1 - w)
}
/** "About 4 minutes left". Pure. */
export const leftText = (ms: number) => ms < 10_000 ? 'A few seconds left'
  : ms < 55_000 ? `About ${Math.round(ms / 10_000) * 10} seconds left`
  : ms < 90 * 60_000 ? `About ${plural(Math.max(1, Math.round(ms / 60_000)), 'minute')} left`
  : `About ${Math.round(ms / 1_800_000) / 2} hours left`
/** "about 4 minutes" for a run not started yet. Pure. */
export const forText = (ms: number) => leftText(ms).replace(/^About/, 'about').replace(/^A few/, 'a few').replace(/ left$/, '')

if (import.meta.env.DEV) {
  console.assert(median([5, 1, 9]) === 5 && median([1, 2]) === undefined && median('x') === undefined, 'eta median')
  console.assert(blend(100, 200, 0) === 100 && blend(100, 200, 0.3) === 200 && blend(undefined, 7, 0) === 7 && blend(8, undefined, 1) === 8, 'eta blend')
  console.assert(leftText(5_000) === 'A few seconds left' && leftText(38_000) === 'About 40 seconds left' && leftText(4 * 60_000) === 'About 4 minutes left' && leftText(150 * 60_000) === 'About 2.5 hours left', 'eta text')
  console.assert(forText(4 * 60_000) === 'about 4 minutes', 'eta for text')
}
