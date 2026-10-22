// repakxtra: toasts for keyboard and screen reader users (AlertHandler.tsx draws them). A toast's timer holds while
// the pointer is over it or focus is in it, a focused toast that goes hands focus on, and two steady live regions
// announce each result once: politely, or at once for a failure. Countdowns and the stack's motion are never read.
import { useEffect, useRef, useState } from 'react'

/** A toast's dismiss clock: time run so far, and since when it runs (null: held). */
export type ToastClock = { elapsed: number; since: number | null }
export const clockElapsed = (c: ToastClock, now: number) => c.elapsed + (c.since === null ? 0 : now - c.since)
/** Holds or runs the clock. Time already run is kept, so a toast resumes where it stopped instead of starting over. */
export const holdClock = (c: ToastClock, held: boolean, now: number): ToastClock =>
  held ? (c.since === null ? c : { elapsed: clockElapsed(c, now), since: null }) : c.since === null ? { ...c, since: now } : c

type Said = { id: number; title?: string; description?: string; color?: string }
/** What to announce for the toasts showing now: each toast's title and text once, and again only when they change (a
 *  loading toast that finished says its result). Failures are urgent. `said` remembers per toast and is updated. */
export function announcements(said: Map<number, string>, toasts: Said[]) {
  const out: { text: string; urgent: boolean }[] = []
  for (const t of toasts) {
    const text = [t.title, t.description].filter(x => typeof x === 'string' && x).join('. ')
    if (!text || said.get(t.id) === text) continue
    said.set(t.id, text)
    out.push({ text, urgent: t.color === 'danger' })
  }
  const live = new Set(toasts.map(t => t.id))
  for (const id of [...said.keys()]) if (!live.has(id)) said.delete(id)
  return out
}

/** The toast that gets focus when the focused one goes: the one now in its place in the stack, else the last one.
 *  `before` is the stack order (newest first) before it went. Null: no toast is left. */
export function survivor(before: number[], now: number[], gone: number): number | null {
  const left = before.filter(id => id !== gone && now.includes(id))
  if (!left.length) return now[0] ?? null
  return left[Math.min(Math.max(0, before.indexOf(gone)), left.length - 1)]
}

/** The two announcement regions. Always on the page (a region that appears with its text is often not read), and
 *  never inert behind a dialog (dialogFocus.ts keeps .xtra-live). */
export function ToastAnnouncer({ toasts }: { toasts: Said[] }) {
  const said = useRef(new Map<number, string>())
  const [text, setText] = useState({ polite: '', urgent: '' })
  useEffect(() => {
    const news = announcements(said.current, toasts)
    if (!news.length) return
    // The same words twice in a row would not be read again: a trailing space tells them apart
    const next = (urgent: boolean, old: string) => {
      const t = news.filter(n => n.urgent === urgent).map(n => n.text).join('. ')
      return !t ? old : old === t ? `${t} ` : t
    }
    setText(old => ({ polite: next(false, old.polite), urgent: next(true, old.urgent) }))
  }, [toasts])
  return (
    <>
      <div className="xtra-live xtra-sr-only" role="status" aria-live="polite" aria-atomic="true">{text.polite}</div>
      <div className="xtra-live xtra-sr-only" role="alert" aria-live="assertive" aria-atomic="true">{text.urgent}</div>
    </>
  )
}

if (import.meta.env.DEV) {
  let c: ToastClock = { elapsed: 0, since: null }
  c = holdClock(c, false, 0)
  c = holdClock(c, true, 4000) // focus or the pointer arrives after 4 s
  console.assert(clockElapsed(c, 20000) === 4000, 'toast clock: held, no time passes (15 s on a focused Undo)')
  c = holdClock(c, true, 21000) // the other one arrives too: still held
  c = holdClock(c, false, 22000)
  console.assert(clockElapsed(c, 23000) === 5000, 'toast clock: resumes where it stopped, not from zero')
  console.assert(holdClock(c, false, 30000) === c, 'toast clock: running again changes nothing')
  const said = new Map<number, string>()
  const a = announcements(said, [{ id: 1, title: 'Installing', color: 'default' }])
  console.assert(a.length === 1 && a[0].text === 'Installing' && !a[0].urgent, 'announce: a new toast once, politely')
  console.assert(announcements(said, [{ id: 1, title: 'Installing', color: 'default' }]).length === 0, 'announce: a re-render says nothing')
  const done = announcements(said, [{ id: 1, title: 'Installed', description: '2 mods', color: 'success' }])
  console.assert(done.length === 1 && done[0].text === 'Installed. 2 mods', 'announce: loading to success says the result')
  const fail = announcements(said, [{ id: 1, title: 'Installed', description: '2 mods' }, { id: 2, title: 'Not deleted', color: 'danger' }])
  console.assert(fail.length === 1 && fail[0].urgent, 'announce: a failure is urgent, the old toast is not said again')
  announcements(said, [])
  console.assert(said.size === 0, 'announce: dismissed toasts are forgotten')
  console.assert(survivor([3, 2, 1], [3, 1], 2) === 1, 'focus: the toast that took the place of the gone one')
  console.assert(survivor([3, 2, 1], [3, 2], 1) === 2, 'focus: the last one gone, the one before it')
  console.assert(survivor([3], [], 3) === null, 'focus: none left')
}
