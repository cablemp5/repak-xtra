// repakxtra: before and after on a loadout's page. A character render comes with <key>.vanilla.png from the preview kit
// (the hero as the game ships it, framed the same way, rendered after the mod's own preview); this lays it over the
// modded picture, cut at a line. Hover-scrub (option C, cable's pick 2026-11-01): the line follows the pointer with no
// click, and leaving the card eases it back so the cover shows the mod again. The rows the picture's own buttons sit in
// (the preview arrows across the middle, Regenerate previews at the bottom, cable 2026-11-01) reset it: there the line
// eases back to the edge, so the picture is plain while you reach for them. Elsewhere it stays right under the pointer.
// It starts only once the pointer rests in one spot for 250 ms with no button held, so dragging across the card leaves it plain.
// The pointer is read on the whole card, since the buttons sit over the picture. No tooltip: one would sit over the
// picture while it scrubs. Both renders are transparent around the hero, so the modded one is cut too (its card gets
// --wipe, theme.css .lo-media.is-wiping): a mod's horns or wider shoulders never show on the vanilla side.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePreviewUrl } from './previews'

const clamp = (n: number) => Math.min(100, Math.max(0, n))
/** How far above and below a button its row reaches, in px. */
const ROW_PAD = 10
/** The pointer rests this long, within DWELL_PX, before the line starts (cable 2026-11-01): a drag across never starts it. */
const DWELL_MS = 250
const DWELL_PX = 8

export default function WipeCompare({ previewKey }: { previewKey: string }) {
  const before = usePreviewUrl(`${previewKey}.vanilla`)
  const [at, setAt] = useState(0) // how far from the left the vanilla picture shows, in percent
  const [inRow, setInRow] = useState(false) // the pointer is in a button's row
  const [easing, setEasing] = useState(false) // onto the picture, back to the edge, and out of a row the line glides
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const card = box.current?.parentElement
    if (!card) return
    card.style.setProperty('--wipe', `${at}%`)
    card.classList.add('is-wiping')
    card.classList.toggle('wipe-ease', easing)
    return () => { card.style.removeProperty('--wipe'); card.classList.remove('is-wiping', 'wipe-ease') }
  }, [at, easing, before])
  useEffect(() => {
    const card = box.current?.parentElement
    if (!before || !card) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let dwell: ReturnType<typeof setTimeout> | undefined
    let anchor: { x: number; y: number } | null = null // where the pointer started resting
    let away = true // off the card or in a button's row: the next move into the picture glides
    /** The next 200 ms glide, then the line follows the pointer at once. */
    const glide = () => { setEasing(true); clearTimeout(timer); timer = setTimeout(() => setEasing(false), 200) }
    const rest = () => { clearTimeout(dwell); anchor = null; if (!away) glide(); away = true; setAt(0) }
    const move = (e: PointerEvent) => {
      if (e.buttons) { rest(); return } // a drag or a press: the picture stays plain

      // a button's row, full width (the card's own buttons, so a single preview has no arrows' row): back to the edge
      const inRow = [...card.querySelectorAll<HTMLElement>('button, a')].some(b => {
        if (b.closest('.wipe, .lo-card-image')) return false
        const r = b.getBoundingClientRect()
        return r.height > 0 && e.clientY > r.top - ROW_PAD && e.clientY < r.bottom + ROW_PAD
      })
      setInRow(inRow) // the ordinary pointer there, not the resize arrows (theme.css .wipe.is-row)
      if (inRow) { rest(); return }
      const r = card.getBoundingClientRect()
      const x = clamp(((e.clientX - r.left) / r.width) * 100)
      if (away) {
        // wait for the pointer to settle: moving more than DWELL_PX starts the wait over
        if (!anchor || Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y) > DWELL_PX) {
          anchor = { x: e.clientX, y: e.clientY }
          clearTimeout(dwell)
          dwell = setTimeout(() => { away = false; anchor = null; glide(); setAt(x) }, DWELL_MS)
        }
        return
      }
      setAt(x)
    }
    card.addEventListener('pointermove', move)
    card.addEventListener('pointerleave', rest)
    card.addEventListener('pointerdown', rest)
    return () => { clearTimeout(timer); clearTimeout(dwell); card.removeEventListener('pointermove', move); card.removeEventListener('pointerleave', rest); card.removeEventListener('pointerdown', rest) }
  }, [before])
  if (!before) return null
  return (
    <div ref={box} className={`wipe${at > 0 ? ' is-open' : ''}${inRow ? ' is-row' : ''}`}>
      <img className="wipe-before" src={before} alt="" draggable={false} />
      <span className="wipe-line" role="slider" tabIndex={0} aria-label="Compare with the unmodded hero" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(at)} aria-valuetext={`${Math.round(at)}% unmodded`}
        onKeyDown={e => {
          const step = e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : e.key === 'Home' ? -100 : e.key === 'End' ? 100 : 0
          if (step) { e.preventDefault(); e.stopPropagation(); setEasing(false); setAt(a => clamp(a + step)) }
        }} />
    </div>
  )
}
