// repakxtra: the built-in mods' icons, drawn on the screen's own pixels. At display scales like 108% a 24-unit Lucide icon
// lands between pixels and reads blurry. PixelIcon picks an even size in screen pixels, gives the drawing that pixel
// grid (2 px lines centered on whole pixels, so straight edges fill whole pixels) and nudges itself onto the grid
// whenever the layout moves it. Every built-in's icon is one of these: a new built-in adds a drawing below.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

/** A drawing on an n by n pixel grid (n even). Lines are 2 px: put straight ones on whole numbers. `k` scales a
 *  Lucide shape (24 units) onto the grid, for parts that are not straight anyway. */
type Draw = (n: number, k: number) => ReactNode

function PixelIcon({ size, draw }: { size?: number | string; draw: Draw }) {
  const ref = useRef<SVGSVGElement>(null)
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  const n = Math.max(12, 2 * Math.round(((Number(size) || 16) * dpr) / 2))
  useLayoutEffect(() => {
    let frame = 0
    const snap = () => {
      const svg = ref.current
      if (!svg) return
      const d = window.devicePixelRatio || 1
      if (d !== dpr) { setDpr(d); return }
      svg.style.transform = ''
      const r = svg.getBoundingClientRect()
      svg.style.transform = `translate(${Math.round(r.left * d) / d - r.left}px, ${Math.round(r.top * d) / d - r.top}px)`
    }
    // again whenever the layout around it may have moved it by a fraction of a pixel: the list loading or resizing,
    // a scroll, a zoom, a row's reveal animation ending
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(snap) }
    snap()
    const ro = new ResizeObserver(later)
    ro.observe(document.body)
    const events = ['resize', 'scroll', 'transitionend', 'animationend'] as const
    events.forEach(e => window.addEventListener(e, later, { capture: true, passive: true }))
    return () => { cancelAnimationFrame(frame); ro.disconnect(); events.forEach(e => window.removeEventListener(e, later, { capture: true })) }
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

/** Force default skin: Lucide's square-user-round, a hero framed like a portrait card. */
export const PortraitCardIcon = pixelIcon(n => {
  const cx = n / 2, head = Math.round(n * 0.2), cy = Math.round(n * 0.44), sh = Math.round(n * 0.27)
  return <>
    <rect x={1} y={1} width={n - 2} height={n - 2} rx={Math.round(n * 0.15)} />
    <circle cx={cx} cy={cy} r={head} />
    <path d={`M${cx - sh} ${n - 1}a${sh} ${sh} 0 0 1 ${2 * sh} 0`} />
  </>
})

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

/** CustomQuake: a map flattened to plain tiles, a rounded square split into four. Every line on whole pixels. */
export const FlatTilesIcon = pixelIcon(n => {
  const m = n / 2, r = Math.round(n * 0.15)
  return <>
    <rect x={1} y={1} width={n - 2} height={n - 2} rx={r} />
    <path d={`M${m} 1V${n - 1}M1 ${m}H${n - 1}`} />
  </>
})

export const ImpactIcon = pixelIcon((n, k) => <><path d={`M${3*k} ${3*k}l${18*k} ${18*k}M${12*k} ${2*k}v${4*k}m0 ${12*k}v${4*k}M${2*k} ${12*k}h${4*k}m${12*k} 0h${4*k}`} /><circle cx={n/2} cy={n/2} r={5*k} /></>)
export const TracerIcon = pixelIcon((n, k) => <><path d={`M${3*k} ${5*k}l${18*k} ${14*k}M${3*k} ${12*k}h${5*k}m${3*k} 0h${4*k}m${3*k} 0h${3*k}`} /></>)
export const ShakeIcon = pixelIcon((n, k) => <><path d={`M${7*k} ${7*k}h${10*k}v${10*k}h-${10*k}zM${3*k} ${9*k}v${6*k}M${21*k} ${9*k}v${6*k}M${9*k} ${3*k}h${6*k}M${9*k} ${21*k}h${6*k}`} /></>)
export const FovIcon = pixelIcon((n, k) => <><path d={`M${3*k} ${4*k}v${16*k}l${18*k}-${5*k}v-${6*k}zM${7*k} ${12*k}h${10*k}`} /></>)
