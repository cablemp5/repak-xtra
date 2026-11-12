// repakxtra: the Loadouts screen mounts only the cards near the viewport once there are many, the way the Library list
// does (virtualRows.ts). Opening Loadouts with every card mounted took one long frame per open (audit F-81). A card far
// from the viewport is an empty .lo-card of its last measured height in the same grid cell, so the layout, the scroll
// length and drag-and-drop spots stay what they were. Which cards are near is decided before the browser paints, from
// where the cards sit in the scroller, one screen ahead of the view each way: no blank card is painted in view.
import { useLayoutEffect, useRef, useState } from 'react'

/** Below this many cards every card is mounted, as before. */
export const NEAR_FROM = 40
const FIRST = 16 // cards mounted before the first measurement (the rest wait one pre-paint pass)
const REST_MS = 1500 // how long the grid rests after a scroll before the cards far from view are taken out
const KEEP = 150 // a list of up to this many cards ends up with every card mounted
const FILL = 6 // far cards put in per idle moment

/** Pure: the ids of the cards whose box comes within `margin` px of the viewport [top, bottom). */
export function nearIds(boxes: { id: string; top: number; bottom: number }[], top: number, bottom: number, margin: number) {
  return new Set(boxes.filter(b => b.bottom > top - margin && b.top < bottom + margin).map(b => b.id))
}

const same = (a: Set<string> | null, b: Set<string>) => Boolean(a && a.size === b.size && [...b].every(x => a.has(x)))
let lastHeight = 0 // a card's height, kept across opens so the first placeholders already have it

/** For the scroller `root` showing `ids` (in order): the set of card ids to mount (null: mount all) and each placeholder's
 *  height. `pins` stay mounted (the card being renamed or dragged). `layout` changes when cards move without the list
 *  changing (a collection folded, the card size), so the set is picked again. */
export function useNearCards(root: HTMLElement | null, ids: string[], pins: (string | null)[], layout = '') {
  const on = ids.length >= NEAR_FROM
  const [near, setNear] = useState<Set<string> | null>(() => (on ? new Set(ids.slice(0, FIRST)) : null))
  const heights = useRef(new Map<string, number>())
  const width = useRef(0)
  const mountedNow = useRef(new Set<string>()) // the cards mounted as of the last render, for the idle fill
  mountedNow.current = near ?? new Set(ids)
  const key = `${ids.join('|')}#${layout}`
  useLayoutEffect(() => {
    if (!on || !root) { setNear(null); return }
    heights.current.clear() // a new layout (card size, folds): the cards measured from now on set every placeholder's height
    // Where each card sits in the scroller's content (px from its top at scroll 0). Read only when the layout can have
    // changed: here, and when the scroller or its content changes size. A scroll picks from these with no read of the
    // page: reading every card's box on each scrolled frame, and again after each change of the mounted cards, made
    // the browser lay the whole grid out two more times a frame (a hard scroll of 84 cards ran at 30 frames a second)
    let boxes: { id: string; top: number; bottom: number }[] = []
    const measure = () => {
      const view = root.getBoundingClientRect(), at = root.scrollTop
      // a new width changes every card's height (the pictures keep their shape): heights measured before it are stale
      if (root.clientWidth !== width.current) { width.current = root.clientWidth; heights.current.clear() }
      boxes = []
      for (const el of root.querySelectorAll<HTMLElement>('.lo-card[data-loadout]')) {
        const id = el.dataset.loadout!
        const b = el.getBoundingClientRect()
        if (!el.hasAttribute('data-away') && el.offsetHeight) { heights.current.set(id, el.offsetHeight); lastHeight = el.offsetHeight }
        boxes.push({ id, top: b.top - view.top + at, bottom: b.bottom - view.top + at })
      }
    }
    // A card that came near stays mounted: scrolled up and down, every pass took the cards out and put them back, each
    // a new element to style and a picture to decode again (most of what was left of a hard scroll's frames). A list
    // of up to KEEP cards keeps them all, and the far ones are put in a few at a time while the page is idle, so a
    // scroll finds every card already there (the first second of one mounted them, 48 frames instead of 144). A longer
    // list lets the far ones go once the grid has rested (REST_MS).
    // shortcut: a scroll through a very long list holds every card it passed until it rests, cap it if that shows
    const keepAll = ids.length <= KEEP
    let rest = 0, idle = 0
    const choose = (was: number) => {
      const at = root.scrollTop, h = root.clientHeight
      const next = nearIds(boxes, at, at + h, h) // one screen above and below
      setNear(prev => {
        if ((keepAll || rest) && prev) for (const id of prev) next.add(id)
        return same(prev, next) && lastHeight === was ? prev : next // a new card height re-renders the placeholders
      })
    }
    const pick = () => { const was = lastHeight; measure(); choose(was) }
    pick()
    const fill = () => {
      idle = 0
      if (ids.every(id => mountedNow.current.has(id))) return // all in: done
      setNear(prev => {
        if (!prev) return prev
        const next = new Set(prev)
        for (const id of ids) { if (next.size >= prev.size + FILL) break; next.add(id) }
        return next.size === prev.size ? prev : next
      })
      idle = requestIdleCallback(fill, { timeout: 1000 })
    }
    if (keepAll) idle = requestIdleCallback(fill, { timeout: 1000 })
    let queued = 0
    const later = () => {
      clearTimeout(rest)
      rest = window.setTimeout(() => { rest = 0; choose(lastHeight) }, REST_MS)
      if (!queued) queued = requestAnimationFrame(() => { queued = 0; choose(lastHeight) })
    }
    root.addEventListener('scroll', later, { passive: true })
    // a card whose real height is not its placeholder's moves the cards below it, and its section's size with them:
    // measured again then (inside the observer the layout is already done, so the reads cost nothing)
    const ro = new ResizeObserver(pick)
    ro.observe(root)
    for (const child of root.children) ro.observe(child)
    return () => { root.removeEventListener('scroll', later); ro.disconnect(); cancelAnimationFrame(queued); clearTimeout(rest); cancelIdleCallback(idle) }
  }, [on, root, key])
  const mounted = (id: string) => !near || near.has(id) || pins.includes(id)
  const height = (id: string) => heights.current.get(id) ?? lastHeight
  return { mounted, height }
}

if (import.meta.env.DEV) {
  const boxes = [0, 1, 2, 3, 4, 5].map(i => ({ id: String(i), top: i * 400, bottom: i * 400 + 380 }))
  console.assert([...nearIds(boxes, 0, 800, 0)].join() === '0,1', 'nearIds: only the cards in view without a margin')
  console.assert([...nearIds(boxes, 800, 1600, 800)].join() === '0,1,2,3,4,5', 'nearIds: one screen above and below')
  console.assert(nearIds(boxes, 3000, 3800, 100).size === 0, 'nearIds: nothing near a viewport past the last card')
}
