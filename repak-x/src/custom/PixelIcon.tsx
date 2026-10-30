// repakxtra: the built-in mods' icons, drawn on the screen's own pixels. At display scales like 108% a 24-unit Lucide icon
// lands between pixels and reads blurry. PixelIcon picks an even size in screen pixels, gives the drawing that pixel
// grid (2 px lines centered on whole pixels, so straight edges fill whole pixels) and nudges itself onto the grid
// whenever the layout moves it. Every built-in's icon is one of these: a new built-in adds a drawing below.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** A drawing on an n by n pixel grid (n even). Lines are 2 px: put straight ones on whole numbers. `k` scales a
 *  Lucide shape (24 units) onto the grid, for parts that are not straight anyway. */
type Draw = (n: number, k: number) => ReactNode

// Every icon on screen, snapped together once a frame: all positions read first, then all offsets written, so a scroll
// costs one layout. Snapping one icon at a time (clear its offset, read, write) forced a layout per icon per frame: a
// Loadouts scroll ran at 20 fps.
const icons = new Map<SVGSVGElement, [number, number]>()
let frame = 0
function snapAll() {
  frame = 0
  const d = window.devicePixelRatio || 1
  // the offset in effect is part of the rect, so take it off to get where the layout put the icon
  const moves = [...icons].map(([svg, [x, y]]) => {
    const r = svg.getBoundingClientRect(), left = r.left - x, top = r.top - y
    return [svg, Math.round(left * d) / d - left, Math.round(top * d) / d - top] as const
  })
  for (const [svg, x, y] of moves) {
    const was = icons.get(svg)
    if (!was || (was[0] === x && was[1] === y)) continue
    icons.set(svg, [x, y])
    svg.style.transform = `translate(${x}px, ${y}px)`
  }
}
const later = () => { if (!frame && icons.size) frame = requestAnimationFrame(snapAll) }
// again whenever the layout around them may have moved them by a fraction of a pixel: the list loading or resizing,
// a scroll, a zoom, a row's reveal animation ending
new ResizeObserver(later).observe(document.body)
for (const e of ['resize', 'scroll', 'transitionend', 'animationend']) window.addEventListener(e, later, { capture: true, passive: true })

function PixelIcon({ size, draw }: { size?: number | string; draw: Draw }) {
  const ref = useRef<SVGSVGElement>(null)
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  const n = Math.max(12, 2 * Math.round(((Number(size) || 16) * dpr) / 2))
  useLayoutEffect(() => {
    const svg = ref.current
    if (!svg) return
    svg.style.transform = ''
    icons.set(svg, [0, 0])
    later() // next frame, with every icon that mounts in this one
    // a zoom changes the pixel grid: redraw at the new size
    const zoom = () => { if ((window.devicePixelRatio || 1) !== dpr) setDpr(window.devicePixelRatio || 1) }
    window.addEventListener('resize', zoom)
    return () => { icons.delete(svg); window.removeEventListener('resize', zoom) }
  }, [dpr, n])
  return (
    <svg ref={ref} width={n / dpr} height={n / dpr} viewBox={`0 0 ${n} ${n}`} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {draw(n, n / 24)}
    </svg>
  )
}

/** A built-in's icon: its drawing at a size in CSS pixels. */
export type BuiltinIconComponent = (props: { size?: number | string }) => ReactNode
const pixelIcon = (draw: Draw): BuiltinIconComponent => ({ size }) => <PixelIcon size={size} draw={draw} />

/** Skip startup logos: Lucide's clapperboard. Both parts are fitted with one scale, so the clapper keeps its size against
 *  the board: Lucide's drawing (x 2 to 21, y 1.6 to 21) fills the grid's 1 px margin. The board's corners are then
 *  rounded onto whole pixels, the tilted clapper keeps Lucide's shape (a slant is never on whole pixels), its line 2 px. */
export const ClapperboardIcon = pixelIcon(n => {
  const s = (n - 2) / 19.4 // the taller side of Lucide's drawing sets the scale
  const ox = (n - 19 * s) / 2 - 2 * s, oy = 1 - 1.6 * s // centered across, top on the margin
  const x = (v: number) => Math.round(ox + v * s), y = (v: number) => Math.round(oy + v * s)
  const [l, r, t, b] = [x(3), x(21), y(11), n - 1]
  const rad = Math.max(1, Math.round(2 * s))
  return <>
    <path d={`M${l} ${t}H${r}V${b - rad}a${rad} ${rad} 0 0 1-${rad} ${rad}H${l + rad}a${rad} ${rad} 0 0 1-${rad}-${rad}Z`} />
    <g transform={`translate(${ox} ${oy}) scale(${s})`} strokeWidth={2 / s}>
      <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
      <path d="m6.2 5.3 3.1 3.9" />
      <path d="m12.4 3.4 3.1 4" />
    </g>
  </>
})
