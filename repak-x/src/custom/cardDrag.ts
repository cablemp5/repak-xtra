// repakxtra: dragging loadout cards on Home with the pointer. The browser's own drag and drop cannot work here: Tauri
// keeps WebView2's drop handler for installing mods by dropping files (tauri.conf dragDropEnabled, on by default), which
// disables HTML5 drag and drop on Windows. So a card is picked up after a short move: a copy lifts off and follows the
// pointer, the card itself stays in the grid as an empty slot that moves to where it would land (the screen re-renders
// that order live), the other cards slide to their new places (playFlip), and holding the pointer near the top or bottom
// edge scrolls the list. On release the copy glides into the slot; Esc glides it back. Pointer moves are applied once
// per frame. Motion uses the app's transitions.dev tokens (theme.css): the lift settles with the Toggle overshoot, the
// landing and the sliding cards use the Page slide ease. Sounds are cuelume's (sounds.ts cue), off with Sound effects.
import { useRef, useState } from 'react'
import { cue } from './sounds'
import { stopEmoteSound } from './emoteSound'

/** Where a dragged card would land: a collection and its place among that collection's other cards (0 = first), or
 *  a new collection. One spot has one value, so moving within it changes nothing. */
export type Spot = { group: string; index: number }

const START = 6     // px the pointer moves before a press becomes a drag (less stays a click)
const EDGE = 72     // px from the list's top or bottom edge where it scrolls
const SPEED = 16    // px per frame at the very edge (about 1000 px a second)
const LAND = 260    // ms the copy takes to glide into its slot
const FOLLOW = 0.4  // how much of the way to the pointer the copy moves per 60 Hz frame (1 = glued to it)
const TILT = 6      // degrees the copy leans at most when moved sideways fast

// A card's entrance (theme.css t-rise-in) plays once: moving a card in the page re-inserts it, which would replay it
document.addEventListener('animationend', e => {
  if (e.animationName === 't-rise-in' && e.target instanceof HTMLElement && e.target.matches('.lo-card')) e.target.dataset.in = '1'
})

/** What slides when the order changes: every card (by loadout id), each collection's title and the New loadout card
 *  (data-flip), so a collection that grows or shrinks moves the rest smoothly instead of making them jump. */
const movers = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLElement>('.lo-card[data-loadout], [data-flip]') ?? [])]
const keyOf = (el: HTMLElement) => el.dataset.loadout ?? el.dataset.flip!

/** Where everything that slides is on screen. */
export const snapshotCards = (root: HTMLElement | null) => new Map(movers(root).map(el => [keyOf(el), el.getBoundingClientRect()]))

/** FLIP: everything that moved since `before` starts where it was (mid-slide included) and slides to its new place.
 *  All positions are read first and written after, so the page is laid out once, not once per card. Inside the card
 *  grids, screen distances are divided by the cards' CSS zoom (custom/cardZoom.ts) to become the card's own units. */
export function playFlip(root: HTMLElement | null, before: Map<string, DOMRect>, zoom: number) {
  // Slides still running from the last change (a fast drag) stop first, so each card's new place is measured where it
  // rests; measured mid-slide, the old slide's offset would count twice and the card would jump
  const sliding = movers(root).filter(el => el.style.transition)
  for (const el of sliding) el.style.transition = 'none'
  const moves = movers(root).flatMap(el => {
    const was = before.get(keyOf(el))
    if (!was) return []
    const now = el.getBoundingClientRect(), z = el.closest('.lo-grid') ? zoom : 1
    const dx = (was.left - now.left) / z, dy = (was.top - now.top) / z
    return Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 ? [] : [{ el, dx, dy }]
  })
  for (const el of sliding) if (!moves.some(m => m.el === el)) el.style.transition = '' // it was already at rest
  if (!moves.length) return
  for (const { el, dx, dy } of moves) {
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
  }
  void root?.offsetWidth // one layout for the start positions
  for (const { el } of moves) {
    el.style.transition = 'transform var(--drag-slide-dur) var(--drag-slide-ease)'
    el.style.transform = ''
    el.addEventListener('transitionend', () => { el.style.transition = '' }, { once: true }) // its own hover transition again
  }
}

/** A card's resting place on screen: where it is, minus the slide it may be in the middle of (playFlip), so a card
 *  passing under the pointer does not count as being there. */
function restingRect(el: HTMLElement, zoom: number) {
  const r = el.getBoundingClientRect()
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return r
  const m = new DOMMatrixReadOnly(t)
  return new DOMRect(r.left - m.m41 * zoom, r.top - m.m42 * zoom, r.width, r.height)
}

/** Where the card would land with the pointer here, the way sortable lists do it: in the collection under the pointer,
 *  the slot of the card nearest to it (gaps between cards belong to the nearest card, not to the collection's end).
 *  Within the card's own collection it takes that card's slot (the others shift by one); coming from another, it goes
 *  before or after that card by which half the pointer is on, or after the last one once past it. undefined: over its
 *  own slot or outside every collection, so the spot stays. */
function spotAt(x: number, y: number, dragId: string, zoom: number, ownGroupOnly: boolean): Spot | undefined {
  let section: HTMLElement | null = null
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('.lo-drag-ghost')) continue
    if ((section = el.closest<HTMLElement>('[data-group]'))) break
  }
  if (!section) return undefined
  // Hero view: a card's hero comes from its mods, so it only moves within its own hero's row
  if (ownGroupOnly && !section.querySelector(`.lo-card[data-loadout="${CSS.escape(dragId)}"]`)) return undefined
  const group = section.dataset.group!
  const cards = [...section.querySelectorAll<HTMLElement>('.lo-card[data-loadout]')]
  const others = cards.filter(c => c.dataset.loadout !== dragId)
  if (!others.length) return { group, index: 0 }
  const rects = cards.map(c => restingRect(c, zoom))
  const last = rects[rects.length - 1]
  if (y > last.bottom || (y > last.top && x > last.right)) return { group, index: others.length } // past the last card
  let near = 0
  rects.forEach((r, i) => {
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2))
    const best = rects[near]
    if (d < Math.hypot(x - (best.left + best.width / 2), y - (best.top + best.height / 2))) near = i
  })
  if (cards[near].dataset.loadout === dragId) return undefined
  const i = others.indexOf(cards[near])
  const mine = cards.findIndex(c => c.dataset.loadout === dragId)
  if (mine >= 0) return { group, index: near > mine ? i + 1 : i }
  return { group, index: x > rects[near].left + rects[near].width / 2 ? i + 1 : i }
}

const same = (a: Spot | null, b: Spot | null) => JSON.stringify(a) === JSON.stringify(b)
const motionOff = () => document.documentElement.dataset.motion === 'off' // uiPrefs resolves System from the OS setting

/** onMove: the spot changed (re-render the order); onDrop: released on a spot, or null when cancelled. ownGroupOnly:
 *  a card stays in its own group (the Hero view), reordered there only. */
export function useCardDrag({ zoom, scroller, onMove, onDrop, ownGroupOnly = false }: {
  zoom: number; scroller: HTMLElement | null; onMove: (id: string, spot: Spot | null) => void; onDrop: (id: string, spot: Spot | null) => void
  ownGroupOnly?: boolean
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const live = useRef({ zoom, scroller, onMove, onDrop, ownGroupOnly })
  live.current = { zoom, scroller, onMove, onDrop, ownGroupOnly }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>, id: string) => {
    // Controls on the card keep their own job; the image and the free parts of the card pick it up
    if (e.button !== 0 || dragId || (e.target as Element).closest('input, textarea, label, .lo-icon, .lo-expand, .lo-media-arrow, .lo-media-mute, [role="switch"]')) return
    const card = e.currentTarget
    const startX = e.clientX, startY = e.clientY
    let x = startX, y = startY, started = false, spot: Spot | null = null, frame = 0, dirty = false
    let ghost: HTMLDivElement | null = null, offX = 0, offY = 0
    // The copy's own position and tilt: it eases toward the pointer each frame (FOLLOW of the way per 60 Hz frame,
    // the same at any refresh rate) and leans into sideways movement, settling upright when the pointer rests
    let gx = 0, gy = 0, tilt = 0, then = 0

    const place = (now: number) => {
      if (!ghost) return
      const dt = then ? Math.min(64, now - then) : 16.7
      then = now
      const k = 1 - Math.pow(1 - FOLLOW, dt / 16.7)
      const px = gx
      gx += (x - offX - gx) * k
      gy += (y - offY - gy) * k
      const lean = Math.max(-TILT, Math.min(TILT, ((gx - px) / dt) * 6))
      tilt += (lean - tilt) * k
      ghost.style.transform = `translate(${gx}px, ${gy}px) rotate(${tilt.toFixed(2)}deg)`
    }
    const track = () => {
      const s = spotAt(x, y, id, live.current.zoom, live.current.ownGroupOnly)
      if (s === undefined || same(s, spot)) return
      const forward = spot && 'index' in spot && 'index' in s && s.group === spot.group ? s.index > spot.index : true
      spot = s
      cue('select', { emphasis: 'subtle', direction: forward ? 'forward' : 'back', volume: 0.6 })
      live.current.onMove(id, spot)
    }
    // Once per frame: the copy follows the pointer, the landing spot is looked up, and near an edge the list scrolls
    // (faster the closer to the edge)
    const tick = (now: number) => {
      const sc = live.current.scroller
      let step = 0
      if (sc) {
        const r = sc.getBoundingClientRect()
        const down = y - (r.bottom - EDGE), up = r.top + EDGE - y
        step = down > 0 ? SPEED * Math.min(1, down / EDGE) : up > 0 ? -SPEED * Math.min(1, up / EDGE) : 0
        if (step) sc.scrollTop += step
      }
      place(now)   // every frame: the copy keeps easing in after the pointer stops
      if (dirty || step) { track(); dirty = false }
      frame = requestAnimationFrame(tick)
    }
    const begin = () => {
      started = true
      const r = card.getBoundingClientRect(), z = live.current.zoom
      offX = startX - r.left
      offY = startY - r.top
      ghost = document.createElement('div')
      ghost.className = 'lo-drag-ghost'
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` })
      const inner = document.createElement('div')
      inner.className = 'lo-drag-ghost-inner'
      Object.assign(inner.style, { zoom: String(z), width: `${r.width / z}px`, height: `${r.height / z}px` })
      // the Home grid's counter zoom for the words (theme.css) reads these, so the copy's text matches the card's
      inner.style.setProperty('--lo-card-zoom', String(z))
      if (card.closest('.lo-screen[data-small]')) inner.dataset.small = ''
      inner.appendChild(card.cloneNode(true))
      ghost.appendChild(inner)
      document.body.appendChild(ghost)
      document.documentElement.classList.add('is-dragging-card')
      gx = r.left
      gy = r.top
      place(performance.now())
      requestAnimationFrame(() => ghost?.classList.add('is-lifted')) // the lift plays from the card's own size
      stopEmoteSound() // a picked-up card is not a hovered preview
      cue('open', { emphasis: 'subtle' })
      setDragId(id)
      frame = requestAnimationFrame(tick)
    }
    /** The copy glides onto the card's slot (where it landed, or back where it was), then the card shows again. */
    const land = (made: Spot | null) => {
      const g = ghost
      let done = false
      const finish = () => {
        if (done) return
        done = true
        // Every card on screen has entered by now: un-hiding them must not start their entrance
        document.querySelectorAll<HTMLElement>('.lo-card').forEach(c => { c.dataset.in = '1' })
        document.documentElement.classList.remove('is-dragging-card')
        setDragId(null)
        // The card shows again first and the copy over it goes once that is on screen: removed in the same frame, a
        // quick drop showed neither for a frame (the flicker)
        requestAnimationFrame(() => requestAnimationFrame(() => g?.remove()))
      }
      if (!g || motionOff()) { finish(); return }
      requestAnimationFrame(() => requestAnimationFrame(() => { // after the new order is on screen
        const slot = document.querySelector<HTMLElement>(`.lo-card[data-loadout="${CSS.escape(id)}"]`)
        if (!slot) { finish(); return }
        // A quick drop finds the (hidden) slot still sliding to its place: it goes there at once, so the copy aims at
        // where the card will rest, not at a point partway that the card would then jump from
        slot.style.transition = 'none'
        slot.style.transform = ''
        const r = slot.getBoundingClientRect()
        slot.style.transition = ''
        g.style.transition = `transform ${LAND}ms var(--drag-slide-ease)`
        g.style.transform = `translate(${r.left}px, ${r.top}px)`
        g.classList.remove('is-lifted')
        g.classList.add(made ? 'is-landing' : 'is-returning')
        // Done when the glide is: a timer of the same length can fire a frame early, with the copy short of the slot
        g.addEventListener('transitionend', e => { if (e.target === g && e.propertyName === 'transform') finish() })
        setTimeout(finish, LAND + 120)
      }))
    }
    const detach = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc, true)
    }
    const end = (drop: boolean) => {
      detach()
      if (!started) return
      cancelAnimationFrame(frame)
      // The release's click must not open the card's page (nor play the click sound)
      const swallow = (ev: MouseEvent) => { ev.stopPropagation(); ev.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
      const made = drop ? spot : null
      if (!made) cue('navigate', { direction: 'back', emphasis: 'subtle' })
      else cue('close', { emphasis: 'subtle' })
      live.current.onDrop(id, made)
      land(made)
    }
    const move = (ev: PointerEvent) => {
      x = ev.clientX
      y = ev.clientY
      if (!started && Math.hypot(x - startX, y - startY) < START) return
      if (!started) begin()
      dirty = true
    }
    const up = () => end(true)
    const cancel = () => end(false)
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && started) { ev.stopPropagation(); end(false) } }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
  }

  return { dragId, onPointerDown }
}
