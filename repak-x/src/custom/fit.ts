// repakxtra: data-compact on a row whose parts would not fit its width: the app header (App.tsx: the buttons keep only
// their icons, Launch its name too) and the Loadouts head (LoadoutsScreen.tsx: the actions take their own row).
// theme.css styles the compact state. Settings > Header buttons > Icons only stays its own switch (html[data-show-header-icons]).
// Measured with the row in its full state every time, never the compact one, so it cannot flip between the two.

const SLACK = 8 // px of room past the fit before the full row comes back

/** A ref callback (React 19 runs the cleanup it returns). `size`: the width the full row needs. 'max-content' for the
 *  header (the version line, which gives way first, is left out), 'min-content' for a grid whose tracks shrink to floors. */
const fitRow = (size: 'max-content' | 'min-content') => (row: HTMLElement | null) => {
  if (!row) return
  let frame = 0
  const fit = () => {
    frame = 0
    const was = row.hasAttribute('data-compact')
    row.removeAttribute('data-compact')
    row.style.width = size
    const need = row.offsetWidth - (row.querySelector<HTMLElement>('.version')?.offsetWidth ?? 0)
    row.style.width = ''
    row.toggleAttribute('data-compact', need > row.offsetWidth - (was ? SLACK : 0))
  }
  // the window's width, and the parts' own (a button shown or hidden, Launch's words, a count, the font)
  const ro = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(fit) })
  const watch = (el: Element) => getComputedStyle(el).display === 'contents' ? [...el.children].forEach(watch) : ro.observe(el) // a display: contents box never resizes, its parts do
  ro.observe(row)
  for (const el of row.children) watch(el)
  return () => { ro.disconnect(); cancelAnimationFrame(frame) }
}

export const fitHeader = fitRow('max-content')
export const fitGrid = fitRow('min-content')
