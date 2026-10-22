// repakxtra: the Library's selection bar opens under the header when the first mod is checked and closes with the last,
// pushing the list down or pulling it up by its own room. The list scrolls to make up for it, so the row you just
// clicked stays under the cursor, but never so far that the row slides under the top of the list: near the top the
// list scrolls only as much as keeps that row fully in view.

let watched: HTMLElement | null = null
let lastRoom = 0
let lastShown = false // the Library was on screen at the last change: a view switch is not the bar opening
let clicked: HTMLElement | null = null // the mod row the pointer last pressed (the click that opened or closed the bar)
// The bar opened or closed since the Library was last hidden. Showing the Library again replays the bar's opening,
// which is no checked change: the list kept its place (the Library tab and L keep the scroll) and must not move
let lastActive = false
let toggled = false

const list = () => document.querySelector<HTMLElement>('.center-panel .mod-list-grid')

/** Screen pixels per CSS pixel (1 in the app, more where the page itself is zoomed, as in the browser preview). */
const scale = (el: HTMLElement) => el.getBoundingClientRect().height / (el.offsetHeight || 1) || 1

/** The room the bar takes in the column, in screen pixels: nothing while hidden, else its height and margins. */
const roomOf = (bar: HTMLElement) => {
  const h = bar.getBoundingClientRect().height
  if (!h) return 0
  const cs = getComputedStyle(bar)
  return h + (parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)) * scale(bar)
}

document.addEventListener('pointerdown', e => {
  clicked = e.target instanceof Element ? e.target.closest<HTMLElement>('.center-panel .mod-card') : null
}, true)
// Space or Enter on a focused row checks it with no pointer press: that row is the one to keep in view
document.addEventListener('keydown', e => {
  if (e.key !== ' ' && e.key !== 'Enter') return
  clicked = document.activeElement?.closest<HTMLElement>('.center-panel .mod-card') ?? null
}, true)

const ro = new ResizeObserver(() => {
  if (!watched) return
  const room = roomOf(watched)
  const moved = room - lastRoom
  lastRoom = room
  const el = list()
  const shown = Boolean(el && el.getClientRects().length)
  const active = !watched.classList.contains('inactive')
  if (active !== lastActive) toggled = true
  lastActive = active
  if (!shown) toggled = false
  if (el && moved && shown && lastShown && toggled) {
    let by = moved
    if (moved > 0 && clicked?.isConnected) {
      // scrolling by `by` lifts the row `by` back up: it may go no higher than the list's (new) top edge
      const below = clicked.getBoundingClientRect().top - el.getBoundingClientRect().top
      by = Math.max(0, Math.min(moved, below))
    }
    el.scrollTop += by / scale(el) // scrollTop counts CSS pixels
  }
  lastShown = shown
})

/** Watches the bar once it is in the page (the Library mounts after startup). */
const attach = () => {
  const bar = document.querySelector<HTMLElement>('.bulk-actions-toolbar')
  if (!bar || bar === watched) return
  if (watched) ro.unobserve(watched)
  watched = bar
  lastRoom = roomOf(bar)
  lastActive = !bar.classList.contains('inactive')
  lastShown = Boolean(list()?.getClientRects().length)
  ro.observe(bar)
}
new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true })
attach()
