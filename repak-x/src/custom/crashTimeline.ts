// repakxtra: what changed before a crash (xtra_activity.rs xtra_crash_timeline), in plain rows: one query and one
// formatter for Settings > Crash reports' What changed? and Copy setup report. Rows say what changed, never what caused
// the crash. A batch (a loadout switch, several mods turned on at once) is one row.
import { invoke } from '@tauri-apps/api/core'
import { APP_NAME } from './edition'

/** n_ok, n_failed: the full counts (the names are capped), from: when a batch began */
export type ActivityEvent = { t: number; kind: string; ok: string[]; failed: string[]; detail: string; n_ok?: number; n_failed?: number; from?: number }
export type Timeline = { crash: number; from?: number | null; started?: number | null; coverage: 'full' | 'partial' | 'none'; events: ActivityEvent[] }
export type TimelineRow = { t: number; text: string; problem?: boolean }

/** The timeline of one crash, by its report's stable id (never by time). Null when it could not be read. */
export const crashTimeline = (id: string) => invoke<Timeline>('xtra_crash_timeline', { id }).catch(() => null)
/** What a timeline that could not be read says (the report is gone, or the history file could not be read). */
export const UNREADABLE = "This crash's history could not be read."

/** Records an operation the frontend finished (a loadout switch, a Mod Updater result) for What changed? */
export const recordActivity = (kind: 'loadout' | 'update' | 'update_failed', ok: string[], failed: string[] = [], detail = '', started?: number) =>
  invoke('xtra_activity_record', { kind, ok, failed, detail, started: started ?? null }).catch(() => {})

const names = (list: string[], total = list.length, max = 2) => { const shown = list.slice(0, max); return total <= shown.length ? shown.join(', ') : `${shown.join(', ')} and ${total - shown.length} more` }
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One event in words: "Installed Purple VFX", "Turned on 12 mods", "Installed 3 of 5 mods (2 failed: A, B)". Pure. */
function words(e: ActivityEvent): string {
  const nOk = Math.max(e.n_ok ?? 0, e.ok.length), nFailed = Math.max(e.n_failed ?? 0, e.failed.length)
  // a few are named ("Installed A, B and 1 more"), a big batch is counted
  const subject = (list: string[], n: number) => (list.length && n <= 3 ? names(list, n) : count(n, 'mod'))
  const failedPart = nFailed ? ` (${nFailed} failed: ${names(e.failed, nFailed)})` : ''
  switch (e.kind) {
    case 'install': return nOk ? `Installed ${nFailed ? `${nOk} of ${count(nOk + nFailed, 'mod')}` : subject(e.ok, nOk)}${failedPart}` : `Install failed for ${subject(e.failed, nFailed)}`
    case 'replace': return e.detail === 'kept' ? `Installed a new copy of ${subject(e.ok, nOk)}, but the old copy could not be moved and is still there` : `Replaced ${subject(e.ok, nOk)} with a new copy`
    case 'enable': return `Turned on ${subject(e.ok, nOk)}`
    case 'disable': return `Turned off ${subject(e.ok, nOk)}`
    case 'switch': { const [on, off] = e.detail.split('/').map(Number); return `Turned on ${count(on, 'mod')} and off ${count(off, 'mod')}` }
    case 'delete': return `Moved ${subject(e.ok, nOk)} to Recently deleted`
    case 'update': return `${e.detail === 'partial' ? 'Partly updated' : e.detail === 'decrypted' ? 'Decrypted' : 'Updated'} ${subject(e.ok, nOk)} in the Mod Updater`
    case 'update_failed': return `Mod Updater could not update ${subject(e.failed, nFailed)}, which stayed as ${nFailed === 1 ? 'it was' : 'they were'}`
    case 'loadout': return nOk ? `Turned ${e.detail || 'a loadout'} (${count(nOk, 'mod')} switched)${failedPart}` : `Could not turn ${e.detail || 'a loadout'}${failedPart}`
    case 'app_update': return `${APP_NAME} updated to ${e.detail}`
    case 'game_update': return `The game updated${e.detail ? ` (build ${e.detail})` : ''}`
    default: return e.kind
  }
}

/** The rows, newest first: on and off switches a loadout made fold into its row, and switches of one kind within a minute
 *  of each other are one row. Pure. */
export function timelineRows(t: Timeline): TimelineRow[] {
  const loadouts = t.events.filter(e => e.kind === 'loadout')
  // a loadout's own switches (recorded by each toggle) are its row, not rows of their own
  const own = (e: ActivityEvent) => (e.kind === 'enable' || e.kind === 'disable') && loadouts.some(l => l.t >= e.t && e.t >= (l.from || l.t - 120) && ((l.n_ok ?? 0) > l.ok.length || e.ok.every(n => l.ok.includes(n))))
  const merged: ActivityEvent[] = []
  const flip = (k: string) => k === 'enable' || k === 'disable' || k === 'switch'
  for (const e of t.events.filter(e => !own(e))) {
    const last = merged[merged.length - 1]
    // on and off within a minute of each other (a switch a crash cut short comes mixed): one "Switched" row
    if (last && flip(e.kind) && flip(last.kind) && last.kind !== e.kind && e.t - last.t <= 60) {
      const on = (x: ActivityEvent) => x.kind === 'switch' ? Number(x.detail.split('/')[0]) : x.kind === 'enable' ? Math.max(x.n_ok ?? 0, x.ok.length) : 0
      const off = (x: ActivityEvent) => x.kind === 'switch' ? Number(x.detail.split('/')[1]) : x.kind === 'disable' ? Math.max(x.n_ok ?? 0, x.ok.length) : 0
      merged[merged.length - 1] = { ...last, kind: 'switch', t: e.t, ok: [...last.ok, ...e.ok], failed: [], n_ok: undefined, detail: `${on(last) + on(e)}/${off(last) + off(e)}` }
      continue
    }
    if (last && (e.kind === 'enable' || e.kind === 'disable' || e.kind === 'delete') && last.kind === e.kind && e.t - last.t <= 60) {
      merged[merged.length - 1] = { ...last, t: e.t, ok: [...last.ok, ...e.ok], failed: [...last.failed, ...e.failed],
        n_ok: Math.max(last.n_ok ?? 0, last.ok.length) + Math.max(e.n_ok ?? 0, e.ok.length), n_failed: Math.max(last.n_failed ?? 0, last.failed.length) + Math.max(e.n_failed ?? 0, e.failed.length) }
    } else merged.push(e)
  }
  const rows: TimelineRow[] = merged.map(e => ({ t: e.t, text: words(e), problem: e.failed.length > 0 || (e.n_failed ?? 0) > 0 || e.detail === 'partial' || e.detail === 'kept' }))
  if (t.started) rows.push({ t: t.started, text: 'Started the game' })
  return rows.sort((a, b) => b.t - a.t)
}

/** What the timeline can say: why it is empty, or how much of the span it covers. Pure. */
export function coverageText(t: Timeline | null, rows: number): string | null {
  if (!t) return UNREADABLE
  if (t.coverage === 'none') return 'No history available for this crash.'
  if (t.coverage === 'partial') return !t.started ? 'This launch was not seen by the app, so the history may be incomplete.' : t.from ? 'History only covers part of the time before this crash.' : 'No earlier game launch was recorded, so changes before this one may be missing.'
  return rows === 0 || (rows === 1 && t.started) ? 'No changes recorded.' : null
}

/** "Nov 21, 9:42 PM", with the year when it is not this year. */
export const whenText = (secs: number) => { const d = new Date(secs * 1000); return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' }) }

/** Copy setup report's lines: newest first, the note first, at most MAX_LINES rows so the report stays short. No names
 *  beyond mod names. Pure. */
const MAX_LINES = 15
export function timelineLines(t: Timeline | null): string[] {
  const rows = (t ? timelineRows(t) : []).filter((r, _, all) => r.text !== 'Started the game' || all.length > 1)
  const note = coverageText(t, rows.length)
  return [...(note ? [note] : []), ...rows.slice(0, MAX_LINES).map(r => `${whenText(r.t)}  ${r.text}`), ...(rows.length > MAX_LINES ? [`and ${rows.length - MAX_LINES} earlier changes (Settings > Crash reports shows them all)`] : [])]
}

/** The note under the list: a timeline is not a diagnosis. */
export const NOT_A_CAUSE = 'This shows what changed before the crash. It does not mean any of it caused the crash.'

if (import.meta.env.DEV) {
  const e = (t: number, kind: string, ok: string[], failed: string[] = [], detail = ''): ActivityEvent => ({ t, kind, ok, failed, detail })
  const tl: Timeline = { crash: 1000, from: 100, started: 900, coverage: 'full', events: [
    e(200, 'install', ['Purple VFX']), e(300, 'enable', ['A']), e(310, 'enable', ['B']), e(400, 'install', ['C', 'D', 'E'], ['F', 'G']),
    e(500, 'disable', ['X']), e(501, 'enable', ['Y']), e(505, 'loadout', ['X', 'Y'], [], 'Panther looks on'),
  ] }
  const rows = timelineRows(tl).map(r => r.text)
  console.assert(rows[0] === 'Started the game' && rows.includes('Installed Purple VFX') && rows.includes('Turned on A, B'), 'plain rows, a batch is one row (a few named)', rows)
  console.assert(rows.includes('Installed 3 of 5 mods (2 failed: F, G)') && rows.includes('Turned Panther looks on (2 mods switched)') && !rows.includes('Turned off X'), 'partial batches stay distinct, a loadout holds its switches', rows)
  console.assert(coverageText({ ...tl, coverage: 'none' }, 0) === 'No history available for this crash.' && coverageText({ ...tl, events: [] }, 1) === 'No changes recorded.', 'empty states')
  console.assert(coverageText({ ...tl, from: null, coverage: 'partial' }, 2)!.startsWith('No earlier game launch') && coverageText(null, 0) === UNREADABLE, 'no earlier launch said, unreadable apart from no history')
  // a crash during a loadout switch (the loadout row came after it): only the toggles before it, as one row
  const mid = timelineRows({ ...tl, started: null, events: [e(600, 'enable', ['P']), e(601, 'disable', ['Q']), e(602, 'enable', ['R'])] }).map(r => r.text)
  console.assert(mid.length === 1 && mid[0] === 'Turned on 2 mods and off 1 mod', 'a cut-short switch is one row', mid)
  const folded = timelineRows({ ...tl, started: null, events: [e(700, 'enable', ['M']), e(800, 'enable', ['P']), e(801, 'disable', ['Q']), { ...e(805, 'loadout', ['P', 'Q'], [], 'Look on'), from: 799 }] }).map(r => r.text)
  console.assert(folded.includes('Turned on M') && folded.includes('Turned Look on (2 mods switched)') && folded.length === 2, 'a switch folds only its own toggles in its window', folded)
  const capped = timelineRows({ ...tl, started: null, events: [e(10, 'install', ['A', 'B'], ['C'], ''), e(20, 'loadout', [], ['Z'], 'Mine on')].map(x => (x.kind === 'install' ? { ...x, n_ok: 120, n_failed: 3 } : x)) }).map(r => r.text)
  console.assert(capped.includes('Installed 120 of 123 mods (3 failed: C and 2 more)') && capped.includes('Could not turn Mine on (1 failed: Z)'), 'full counts beyond the capped names, a loadout that switched nothing', capped)
}
