// repakxtra: the Library list mounts only the rows near the viewport once it is long (ModsList.tsx). Measured at 2,000
// mods every row mounted made a search or an on/off switch take 130 to 290 ms. The rest of the list is two spacers
// whose heights stand in for the rows above and below, in the list's own flow (flex column or CSS grid), so the
// cards keep their normal layout. Unlike the Asset Explorer (AssetTree.tsx) no row height is assumed: the step between
// visual rows, the columns and the padding are read from the rows on screen after each render, and grid views count
// visual rows (a whole row of cards at a time). Rows being renamed stay mounted, and the viewed mod is scrolled into
// the mounted slice when it changes (arrow keys, a reveal from the Asset Explorer), so focus can land on it.
import { type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { focusPending } from './libraryFocus'

/** Below this many mods every row is mounted, as before (small libraries pay nothing). */
export const WINDOW_FROM = 150
const OVERSCAN = 6 // visual rows above and below the viewport
const FIRST = 60 // rows mounted before the first measurement

export type Metrics = { cols: number; pitch: number; gap: number; offset: number; viewport: number }

/** Pure: the mounted slice [start, end) of `count` items and the spacer heights above and below it. `pins` are item
 *  indices that must stay mounted (the slice grows to include them). */
export function rowWindow(count: number, m: Metrics, scrollTop: number, pins: number[] = []) {
  const rows = Math.ceil(count / m.cols)
  let first = Math.max(0, Math.floor((scrollTop - m.offset) / m.pitch) - OVERSCAN)
  let last = Math.min(rows, Math.ceil((scrollTop - m.offset + m.viewport) / m.pitch) + OVERSCAN)
  for (const i of pins) {
    if (i < 0 || i >= count) continue
    first = Math.min(first, Math.floor(i / m.cols))
    last = Math.max(last, Math.floor(i / m.cols) + 1)
  }
  first = Math.min(first, Math.max(0, rows - 1)) // scrolled past a list that just got shorter: its last row still mounts
  last = Math.max(last, Math.min(rows, first + 1))
  // a spacer is itself an item of the flow: it takes one gap after it, so it is one gap shorter than its rows
  const space = (n: number) => (n > 0 ? n * m.pitch - m.gap : 0)
  return { start: first * m.cols, end: Math.min(count, last * m.cols), top: space(first), bottom: space(rows - last) }
}

/** Pure: the scrollTop that brings item `i` fully into view (nearest edge), or null when it is in view already. */
export function scrollToShow(i: number, m: Metrics, scrollTop: number): number | null {
  const top = m.offset + Math.floor(i / m.cols) * m.pitch
  const bottom = top + m.pitch - m.gap
  if (top < scrollTop) return top - m.offset
  if (bottom > scrollTop + m.viewport) return bottom - m.viewport + m.offset
  return null
}

/** Reads the layout from the rows on screen: columns from the grid template, the step between visual rows from the
 *  first and last mounted card. Null while hidden (Home is showing) or with too few rows to tell. */
function measure(el: HTMLElement): Metrics | null {
  if (!el.clientHeight) return null
  const cards = el.querySelectorAll<HTMLElement>(':scope > .mod-card')
  if (cards.length < 2) return null
  const cs = getComputedStyle(el)
  const cols = cs.display === 'grid' ? Math.max(1, cs.gridTemplateColumns.split(' ').filter(Boolean).length) : 1
  const a = cards[0], b = cards[cards.length - 1]
  const rowsBetween = Math.floor((cards.length - 1) / cols) // the slice starts on a whole visual row
  if (rowsBetween < 1 || b.offsetTop <= a.offsetTop) return null
  const pitch = (b.offsetTop - a.offsetTop) / rowsBetween
  return { cols, pitch, gap: parseFloat(cs.rowGap) || 0, offset: parseFloat(cs.paddingTop) || 0, viewport: el.clientHeight }
}

const same = (a: Metrics | null, b: Metrics | null) =>
  a === b || Boolean(a && b && a.cols === b.cols && Math.abs(a.pitch - b.pitch) < 0.5 && a.gap === b.gap && a.offset === b.offset && a.viewport === b.viewport)

/** The mounted slice for the list in `wrap` (its first child scrolls). The viewed mod (`viewedId`, at index `viewed`)
 *  is scrolled into the slice when it changes or the view switches, not when a filter or sort moves it. `pins` stay
 *  mounted. */
export function useRowWindow(wrap: RefObject<HTMLElement | null>, count: number, mode: string, viewed: number, viewedId: string, pins: number[]) {
  const on = count >= WINDOW_FROM
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const lastViewed = useRef('')
  const scroller = () => wrap.current?.firstElementChild as HTMLElement | null | undefined

  // After every render: the layout may have changed (a resize, the UI scale, the details panel, a view switch)
  useLayoutEffect(() => {
    focusPending() // a row that was to take focus may be mounted now
    const el = scroller()
    if (!on || !el) return
    const next = measure(el)
    if (next && !same(next, metrics)) setMetrics(next)
  })
  useLayoutEffect(() => {
    const el = scroller()
    if (!on || !el) return
    setScrollTop(el.scrollTop)
    let queued = 0
    const onScroll = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; setScrollTop(el.scrollTop) }) }
    const ro = new ResizeObserver(() => { const next = measure(el); if (next) setMetrics(prev => (same(prev, next) ? prev : next)) })
    el.addEventListener('scroll', onScroll, { passive: true })
    ro.observe(el)
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); cancelAnimationFrame(queued) }
  }, [on, mode]) // the list element is remounted per view mode
  // A newly viewed mod, or the viewed one after a view switch (the list starts at the top again), outside the slice:
  // scroll to it, the next render mounts it. Measured here: the state may still hold the last view's layout.
  useLayoutEffect(() => {
    const el = scroller()
    const key = `${mode}:${viewedId}`
    if (key === lastViewed.current) return
    if (!on || !el || viewed < 0) { lastViewed.current = key; return }
    const m = measure(el)
    if (!m) return // hidden (Home is showing) or not laid out yet: the next render tries again
    lastViewed.current = key
    const to = scrollToShow(viewed, m, el.scrollTop)
    if (to !== null) { el.scrollTop = to; setScrollTop(el.scrollTop) }
  })

  if (!on) return { start: 0, end: count, top: 0, bottom: 0 }
  if (!metrics) return { start: 0, end: Math.min(count, Math.max(FIRST, ...pins.map(i => i + 1))), top: 0, bottom: 0 }
  return rowWindow(count, metrics, scrollTop, pins)
}

if (import.meta.env.DEV) {
  const list: Metrics = { cols: 1, pitch: 40, gap: 0, offset: 6, viewport: 400 }
  const w = rowWindow(2000, list, 0)
  console.assert(w.start === 0 && w.end === 16 && w.top === 0, 'rowWindow: at the top, the viewport (10 rows) plus overscan below')
  console.assert(w.bottom === (2000 - 16) * 40, 'rowWindow: the bottom spacer stands in for every row below')
  const mid = rowWindow(2000, list, 4006)
  console.assert(mid.start === 94 && mid.end === 116 && mid.top === 94 * 40, 'rowWindow: in the middle, overscan both ways')
  const grid: Metrics = { cols: 3, pitch: 128, gap: 8, offset: 12, viewport: 512 }
  const g = rowWindow(500, grid, 1292)
  console.assert(g.start % 3 === 0 && g.top === (g.start / 3) * 128 - 8, 'rowWindow: grids slice whole visual rows, spacer one gap short')
  console.assert(g.top + ((g.end - g.start) / 3) * 128 + 8 + g.bottom === Math.ceil(500 / 3) * 128 - 8, 'rowWindow: spacers, rows and gaps add up to the full height')
  console.assert(rowWindow(2000, list, 0, [1500]).end === 1501, 'rowWindow: a pinned row (a rename) stays mounted')
  console.assert(rowWindow(5, list, 9999).end === 5 && rowWindow(5, list, 9999).start === 4, 'rowWindow: scrolled past a shortened list, the last rows still mount')
  console.assert(scrollToShow(3, list, 0) === null, 'scrollToShow: in view, no scroll')
  console.assert(scrollToShow(50, list, 0) === 6 + 51 * 40 - 400 + 6, 'scrollToShow: below, its bottom edge at the viewport bottom')
  console.assert(scrollToShow(2, list, 400) === 80, 'scrollToShow: above, its top at the viewport top')
}
