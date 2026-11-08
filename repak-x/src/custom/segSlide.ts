// repakxtra: the header tabs' sliding pill (transitions.dev Tabs sliding) on every segmented bar, in every window
// (main.tsx). One pill sits under the picked button and glides to the next pick. Buttons differ in width (labels,
// counts), so the pill's place and size are measured, not set in CSS as the two equal header tabs are (theme.css).

const BARS = '.mod-state-filter, .ob-seg, .segmented-control, .ae-view-switch'
const PICKED = ':scope > [aria-pressed="true"], :scope > [aria-checked="true"], :scope > .active'

// repakxtra: several bars at once (a screen mounting) read all offsets first, then write, so they share one layout
// instead of forcing one per bar.
function place(...bars: HTMLElement[]) {
  bars.forEach(bar => bar.classList.add('has-seg-pill')) // first: the bar holds the pill (position: relative) before offsets are read
  const read = bars.map(bar => {
    const b = bar.querySelector<HTMLElement>(PICKED)
    return { bar, x: b?.offsetLeft ?? 0, y: b?.offsetTop ?? 0, w: b?.offsetWidth ?? 0, h: b?.offsetHeight ?? 0 }
  })
  for (const { bar, x, y, w, h } of read) {
    const was = parseFloat(bar.style.getPropertyValue('--seg-w')) || 0
    // the first place (or a bar shown again) lands without gliding in from nowhere
    if (!was || !w) bar.classList.remove('seg-ready')
    bar.style.setProperty('--seg-x', `${x}px`)
    bar.style.setProperty('--seg-y', `${y}px`)
    bar.style.setProperty('--seg-w', `${w}px`)
    bar.style.setProperty('--seg-h', `${h}px`)
    if (w && !bar.classList.contains('seg-ready')) requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('seg-ready')))
  }
}

const sized = new ResizeObserver(entries => place(...entries.map(e => e.target as HTMLElement)))
const barsIn = (n: Node) => n instanceof HTMLElement ? [...(n.matches(BARS) ? [n] : []), ...n.querySelectorAll<HTMLElement>(BARS)] : []

new MutationObserver(list => {
  const dirty = new Set<HTMLElement>()
  for (const m of list) {
    if (m.type === 'attributes') {
      const bar = (m.target as HTMLElement).parentElement
      if (bar?.matches(BARS)) dirty.add(bar)
      continue
    }
    if ((m.target as HTMLElement).matches?.(BARS)) dirty.add(m.target as HTMLElement) // a button came or went
    m.addedNodes.forEach(n => barsIn(n).forEach(bar => { sized.observe(bar); dirty.add(bar) }))
    m.removedNodes.forEach(n => barsIn(n).forEach(bar => sized.unobserve(bar)))
  }
  if (dirty.size) place(...dirty)
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-checked', 'class'] })
const first = [...document.querySelectorAll<HTMLElement>(BARS)]
first.forEach(bar => sized.observe(bar))
if (first.length) place(...first)

export {} // a module: its names stay its own
