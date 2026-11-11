// repakxtra: the Loadouts screen mounts only the cards near the viewport once there are many, the way the Library list
// does (virtualRows.ts). Opening Loadouts with every card mounted took one long frame per open (audit F-81). A card far
// from the viewport is an empty .lo-card of its last measured height in the same grid cell, so the layout, the scroll
// length and drag-and-drop spots stay what they were. Which cards are near is decided in a layout effect, before the
// browser paints, from where the cards are on screen: no blank card is ever painted in view.
import { useLayoutEffect, useRef, useState } from 'react'

/** Below this many cards every card is mounted, as before. */
export const NEAR_FROM = 40
const FIRST = 16 // cards mounted before the first measurement (the rest wait one pre-paint pass)

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
  const pickRef = useRef<(() => void) | null>(null)
  const width = useRef(0)
  const key = `${ids.join('|')}#${layout}`
  useLayoutEffect(() => {
    if (!on || !root) { setNear(null); return }
    heights.current.clear() // a new layout (card size, folds): the cards measured from now on set every placeholder's height
    const pick = () => {
      const view = root.getBoundingClientRect()
      const was = lastHeight
      // a new width changes every card's height (the pictures keep their shape): heights measured before it are stale
      if (root.clientWidth !== width.current) { width.current = root.clientWidth; heights.current.clear() }
      const boxes: { id: string; top: number; bottom: number }[] = []
      for (const el of root.querySelectorAll<HTMLElement>('.lo-card[data-loadout]')) {
        const id = el.dataset.loadout!
        const b = el.getBoundingClientRect()
        if (!el.hasAttribute('data-away') && el.offsetHeight) { heights.current.set(id, el.offsetHeight); lastHeight = el.offsetHeight }
        boxes.push({ id, top: b.top, bottom: b.bottom })
      }
      const next = nearIds(boxes, view.top, view.bottom, root.clientHeight) // one screen above and below
      setNear(prev => (same(prev, next) && lastHeight === was ? prev : next)) // a new card height re-renders the placeholders
    }
    pickRef.current = pick
    pick()
    let queued = 0
    const later = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; pick() }) }
    root.addEventListener('scroll', later, { passive: true })
    const ro = new ResizeObserver(later)
    ro.observe(root)
    return () => { pickRef.current = null; root.removeEventListener('scroll', later); ro.disconnect(); cancelAnimationFrame(queued) }
  }, [on, root, key])
  // one more pass, still before paint, after each render that changed which cards are mounted: their real heights move
  // the cards below them (it stops once the set holds still)
  useLayoutEffect(() => { pickRef.current?.() }, [near])
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
