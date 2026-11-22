// repakxtra: what changed before a crash (xtra_activity.rs xtra_crash_timeline), in plain rows: one query and one
// formatter for Settings > Crash reports' What changed? and Copy setup report. Rows say what changed, never what caused
// the crash. A batch (a loadout switch, several mods turned on at once) is one row.
import { invoke } from '@tauri-apps/api/core'

export type ActivityEvent = { t: number; kind: string; ok: string[]; failed: string[]; detail: string }
export type Timeline = { crash: number; from?: number | null; started?: number | null; coverage: 'full' | 'partial' | 'none'; events: ActivityEvent[] }
export type TimelineRow = { t: number; text: string; problem?: boolean }

/** The timeline of one crash, by its report's stable id (never by time). Null when it could not be read. */
export const crashTimeline = (id: string) => invoke<Timeline>('xtra_crash_timeline', { id }).catch(() => null)

/** Records an operation the frontend finished (a loadout switch, a Mod Updater result) for What changed? */
export const recordActivity = (kind: 'loadout' | 'update' | 'update_failed', ok: string[], failed: string[] = [], detail = '') =>
  invoke('xtra_activity_record', { kind, ok, failed, detail }).catch(() => {})

const names = (list: string[], max = 2) => (list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`)
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One event in words: "Installed Purple VFX", "Turned on 12 mods", "Installed 3 of 5 mods (2 failed: A, B)". Pure. */
function words(e: ActivityEvent): string {
  const all = e.ok.length + e.failed.length
  const subject = (list: string[]) => (list.length === 1 ? list[0] : count(list.length, 'mod'))
  const failedPart = e.failed.length ? ` (${e.failed.length} failed: ${names(e.failed)})` : ''
  switch (e.kind) {
    case 'install': return e.ok.length ? `Installed ${e.failed.length ? `${e.ok.length} of ${count(all, 'mod')}` : subject(e.ok)}${failedPart}` : `Install failed for ${subject(e.failed)}`
    case 'enable': return `Turned on ${subject(e.ok)}`
    case 'disable': return `Turned off ${subject(e.ok)}`
    case 'delete': return `Moved ${subject(e.ok)} to Recently deleted`
    case 'update': return `${e.detail === 'partial' ? 'Partly updated' : 'Updated'} ${subject(e.ok)} in the Mod Updater`
    case 'update_failed': return `Mod Updater could not update ${subject(e.failed)}, which stayed as ${e.failed.length === 1 ? 'it was' : 'they were'}`
    case 'loadout': return `Turned ${e.detail || 'a loadout'}${e.ok.length ? ` (${count(e.ok.length, 'mod')} switched)` : ''}${failedPart}`
    case 'app_update': return `repakxtra updated to ${e.detail}`
    case 'game_update': return `The game updated${e.detail ? ` (build ${e.detail})` : ''}`
    default: return e.kind
  }
}

/** The rows, newest first: on and off switches a loadout made fold into its row, and switches of one kind within a minute
 *  of each other are one row. Pure. */
export function timelineRows(t: Timeline): TimelineRow[] {
  const loadouts = t.events.filter(e => e.kind === 'loadout')
  // a loadout's own switches (recorded by each toggle) are its row, not rows of their own
  const own = (e: ActivityEvent) => (e.kind === 'enable' || e.kind === 'disable') && loadouts.some(l => l.t >= e.t && l.t - e.t <= 120 && e.ok.every(n => l.ok.includes(n)))
  const merged: ActivityEvent[] = []
  for (const e of t.events.filter(e => !own(e))) {
    const last = merged[merged.length - 1]
    if (last && (e.kind === 'enable' || e.kind === 'disable' || e.kind === 'delete') && last.kind === e.kind && e.t - last.t <= 60) {
      merged[merged.length - 1] = { ...last, t: e.t, ok: [...last.ok, ...e.ok], failed: [...last.failed, ...e.failed] }
    } else merged.push(e)
  }
  const rows: TimelineRow[] = merged.map(e => ({ t: e.t, text: words(e), problem: e.failed.length > 0 }))
  if (t.started) rows.push({ t: t.started, text: 'Started the game' })
  return rows.sort((a, b) => b.t - a.t)
}

/** What the timeline can say: why it is empty, or how much of the span it covers. Pure. */
export function coverageText(t: Timeline | null, rows: number): string | null {
  if (!t || t.coverage === 'none') return 'No history available for this crash.'
  if (t.coverage === 'partial') return t.from ? 'History only covers part of the time before this crash.' : 'No earlier game launch was recorded, so changes before this one may be missing.'
  return rows === 0 || (rows === 1 && t.started) ? 'No changes recorded.' : null
}

export const whenText = (secs: number) => new Date(secs * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Copy setup report's lines: newest first, the note first. No names beyond mod names. Pure. */
export function timelineLines(t: Timeline | null): string[] {
  const rows = t ? timelineRows(t) : []
  const note = coverageText(t, rows.length)
  return [...(note ? [note] : []), ...rows.filter(r => r.text !== 'Started the game' || rows.length > 1).map(r => `${whenText(r.t)}  ${r.text}`)]
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
  console.assert(rows[0] === 'Started the game' && rows.includes('Installed Purple VFX') && rows.includes('Turned on 2 mods'), 'plain rows, a batch is one row', rows)
  console.assert(rows.includes('Installed 3 of 5 mods (2 failed: F, G)') && rows.includes('Turned Panther looks on (2 mods switched)') && !rows.includes('Turned off X'), 'partial batches stay distinct, a loadout holds its switches', rows)
  console.assert(coverageText({ ...tl, coverage: 'none' }, 0) === 'No history available for this crash.' && coverageText({ ...tl, events: [] }, 1) === 'No changes recorded.', 'empty states')
  console.assert(coverageText({ ...tl, from: null, coverage: 'partial' }, 2)!.startsWith('No earlier game launch'), 'no earlier launch said')
}
