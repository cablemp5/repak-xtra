// repakxtra: the header tabs' sliding pill (transitions.dev Tabs sliding) on every segmented bar, in every window
// (main.tsx). One pill sits under the picked button and glides to the next pick. Buttons differ in width (labels,
// counts), so the pill's place and size are measured, not set in CSS as the two equal header tabs are (theme.css).

const BARS = '.mod-state-filter, .ob-seg, .segmented-control'
const PICKED = ':scope > [aria-pressed="true"], :scope > [aria-checked="true"], :scope > .active'

function place(bar: HTMLElement) {
  bar.classList.add('has-seg-pill') // first: the bar holds the pill (position: relative) before offsets are read
  const b = bar.querySelector<HTMLElement>(PICKED)
  const w = b?.offsetWidth ?? 0
  const was = parseFloat(bar.style.getPropertyValue('--seg-w')) || 0
  // the first place (or a bar shown again) lands without gliding in from nowhere
  if (!was || !w) bar.classList.remove('seg-ready')
  bar.style.setProperty('--seg-x', `${b?.offsetLeft ?? 0}px`)
  bar.style.setProperty('--seg-y', `${b?.offsetTop ?? 0}px`)
  bar.style.setProperty('--seg-w', `${w}px`)
  bar.style.setProperty('--seg-h', `${b?.offsetHeight ?? 0}px`)
  if (w && !bar.classList.contains('seg-ready')) requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add('seg-ready')))
}

const sized = new ResizeObserver(entries => { for (const e of entries) place(e.target as HTMLElement) })
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
  dirty.forEach(place)
}).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-checked', 'class'] })
document.querySelectorAll<HTMLElement>(BARS).forEach(bar => { sized.observe(bar); place(bar) })

export {} // a module: its names stay its own
