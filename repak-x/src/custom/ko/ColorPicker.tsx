/** repakxtra: the KO Editor's color picker, in the app's own look. The OS picker is a foreign window: this is a small
 *  popover by its swatch with a saturation and brightness square, a hue bar, and a row of suggested colors. Values are 6
 *  lowercase hex digits without the #. No dependency: the math is a dozen lines. */
import { type CSSProperties, type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cue } from '../sounds'

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n))

/** "5d7a80" to hue (0 to 360), saturation and brightness (0 to 1). Pure. */
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, max === 0 ? 0 : d / max, max]
}

/** Hue (0 to 360), saturation and brightness (0 to 1) to "5d7a80". Pure. */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return [f(5), f(3), f(1)].map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')
}

if (import.meta.env?.DEV) {
  console.assert(hsvToHex(...hexToHsv('ff0000')) === 'ff0000' && hsvToHex(...hexToHsv('5d7a80')) === '5d7a80' && hsvToHex(...hexToHsv('000000')) === '000000', 'color math round trip')
}

const WIDTH = 248 // nine 18px dots with room for the picked one's ring between them
const HEIGHT = 224

/** The swatch, and its popover while open. `presets` are suggested colors (hex), the first one the game's own. */
export default function ColorPicker({ value, onChange, label, presets, disabled }: {
  value: string; onChange: (hex: string) => void; label: string; presets: string[]; disabled?: boolean
}) {
  const [open, setOpenState] = useState(false)
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [at, setAt] = useState<{ left: number; top: number }>()
  const button = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const square = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [h, s, v] = hsv
  const setOpen = (o: boolean) => { if (o !== open) cue(o ? 'open' : 'close'); setOpenState(o) }
  // a color set from outside (a suggestion, typed hex, the hue shift) moves the handles. Dragging keeps its own hue: a gray has none
  useEffect(() => { if (hsvToHex(...hsv) !== value) setHsv(hexToHsv(value)) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (disabled) setOpen(false) }, [disabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // beside the swatch, or above it when the window ends first. It follows the swatch through a scroll or resize, and a
  // click outside or Escape closes it
  const place = () => {
    if (!button.current) return
    const r = button.current.getBoundingClientRect()
    const below = r.bottom + 8 + HEIGHT <= window.innerHeight
    setAt({ left: clamp(r.left, 8, window.innerWidth - WIDTH - 8), top: below ? r.bottom + 8 : Math.max(8, r.top - 8 - HEIGHT) })
  }
  useLayoutEffect(() => { if (open) place() }, [open])
  useEffect(() => {
    if (!open) return
    const away = (e: Event) => { if (!pop.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', away, true)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    square.current?.focus()
    return () => { document.removeEventListener('pointerdown', away, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: [number, number, number]) => { setHsv(next); onChange(hsvToHex(...next)) }
  const drag = (e: PointerEvent, move: (x: number, y: number) => void, el: HTMLElement | null) => {
    if (!el || (e.type === 'pointermove' && e.buttons !== 1)) return
    if (e.type === 'pointerdown') el.setPointerCapture(e.pointerId)
    const r = el.getBoundingClientRect()
    move(clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height))
  }
  const step = (e: KeyboardEvent, move: (dx: number, dy: number) => void) => {
    const d = e.shiftKey ? 0.1 : 0.01
    const by: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }
    if (!by[e.key]) return
    e.preventDefault()
    move(...by[e.key])
  }
  const shown = `#${value.toUpperCase()}`

  return (
    <>
      <button type="button" ref={button} className="kcp-swatch" aria-label={`${label}, ${shown}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
        title="Pick a color" onClick={() => setOpen(!open)}>
        <span className="kcp-fill" style={{ background: `#${value}` }} />
      </button>
      {open && at && createPortal(
        <div ref={pop} className="kcp-pop" role="dialog" aria-label={label} style={{ left: at.left, top: at.top, width: WIDTH }}
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); button.current?.focus() } }}>
          <div ref={square} className="kcp-sv" role="slider" tabIndex={0} aria-label="Saturation and brightness" aria-valuetext={`Saturation ${Math.round(s * 100)} percent, brightness ${Math.round(v * 100)} percent`}
            style={{ '--hue': `hsl(${h} 100% 50%)` } as CSSProperties}
            onPointerDown={e => drag(e, (x, y) => set([h, x, 1 - y]), square.current)} onPointerMove={e => drag(e, (x, y) => set([h, x, 1 - y]), square.current)}
            onKeyDown={e => step(e, (dx, dy) => set([h, clamp(s + dx), clamp(v - dy)]))}>
            <span className="kcp-dot" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: `#${value}` }} />
          </div>
          <div ref={bar} className="kcp-hue" role="slider" tabIndex={0} aria-label="Hue" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(h)}
            onPointerDown={e => drag(e, x => set([x * 360, s, v]), bar.current)} onPointerMove={e => drag(e, x => set([x * 360, s, v]), bar.current)}
            onKeyDown={e => step(e, dx => set([clamp(h / 360 + dx) * 360, s, v]))}>
            <span className="kcp-dot" style={{ left: `${(h / 360) * 100}%`, top: '50%', background: `hsl(${h} 100% 50%)` }} />
          </div>
          <div className="kcp-presets" role="radiogroup" aria-label="Suggested colors">
            {presets.map((c, i) => (
              <button key={c} type="button" role="radio" aria-checked={value === c} className="kcp-preset" style={{ background: `#${c}`, '--sw': `#${c}` } as CSSProperties}
                title={i === 0 ? `The game's #${c.toUpperCase()}` : `#${c.toUpperCase()}`} aria-label={i === 0 ? 'The game\'s color' : `#${c.toUpperCase()}`}
                onClick={() => { setHsv(hexToHsv(c)); onChange(c); cue('tap') }} />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
