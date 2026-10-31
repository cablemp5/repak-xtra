// repakxtra: a Text cover's tools on its loadout page (loadoutBits.tsx CardMedia), behind one small arrow in a corner of
// the card: the picture behind the words (the icon and color stay in the bar along the card's bottom while typing). An
// Image cover has its own Change image button instead. The arrow sits bottom left, or top left while
// typing, where the bar is not. A popover on the card, after its arrow so Tab goes from one into the other: Esc or a
// click outside closes it.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import CaptionBackground from './CaptionBackground'
import type { Loadout } from './loadoutStore'
import type { LoadoutProps } from './Loadouts'

export function CardTools({ l, top, alert }: { l: Loadout; top: boolean; alert: LoadoutProps['alert'] }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); box.current?.querySelector<HTMLElement>('.ct-btn')?.focus() } }
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', key, true) // before the loadout page's own Esc
    document.addEventListener('mousedown', out)
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', out) }
  }, [open])
  const Arrow = top ? ChevronDown : ChevronUp
  return (
    <div className={`ct${open ? ' is-open' : ''}${top ? ' is-top' : ''}`} ref={box} onMouseDown={e => { if (top) e.preventDefault() }}>
      <button type="button" className="ct-btn" aria-expanded={open} aria-label="Card options" title="Card options" onClick={() => setOpen(v => !v)}>
        <Arrow aria-hidden="true" />
      </button>
      {open && (
        <div className="ct-pop" role="dialog" aria-label="Card options">
          <div className="ct-field is-stacked">
            <span>Background</span>
            <CaptionBackground l={l} alert={alert} />
          </div>
        </div>
      )}
    </div>
  )
}
