// repakxtra: a loadout card's tools on its page (loadoutBits.tsx CardMedia), behind one small arrow in the card's
// bottom left corner: for an Image cover, change it or take a mod's picture from Nexus, for a Text cover, edit the words,
// pick the icon and color, and the picture behind them. A popover on the card: Esc or a click outside closes it.
import { useEffect, useRef, useState } from 'react'
import { Ban, ChevronDown, ChevronUp, ImagePlus, Pencil } from 'lucide-react'
import { CAPTION_COLORS, CAPTION_ICONS, CaptionIcon } from './captionStyle'
import CaptionBackground from './CaptionBackground'
import { type Loadout, patchLoadout } from './loadoutStore'
import type { LoadoutProps } from './Loadouts'
import nexusLogo from './logos/nexus.png'

export function CardTools({ l, text, alert, onImage, onNexus, onEdit }: {
  l: Loadout; text: boolean; alert: LoadoutProps['alert']; onImage: () => void; onNexus?: () => void; onEdit: () => void
}) {
  const [open, setOpen] = useState(false)
  const [icons, setIcons] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) { setIcons(false); return }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); box.current?.querySelector<HTMLElement>('.ct-btn')?.focus() } }
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('keydown', key, true) // before the loadout page's own Esc
    document.addEventListener('mousedown', out)
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', out) }
  }, [open])
  const run = (f: () => void) => () => { setOpen(false); f() }
  const shown = l.captionColor ?? CAPTION_COLORS[0]
  return (
    <div className={`ct${open ? ' is-open' : ''}`} ref={box}>
      {open && (
        <div className="ct-pop" role="dialog" aria-label="Card options">
          {text ? <>
            <button type="button" className="ct-row" onClick={run(onEdit)}><Pencil aria-hidden="true" /> Edit text</button>
            <div className="ct-field">
              <span>Icon</span>
              <button type="button" className="ct-pick" aria-expanded={icons} onClick={() => setIcons(v => !v)}>
                {l.captionIcon ? <CaptionIcon name={l.captionIcon} /> : <Ban aria-hidden="true" />}{l.captionIcon ? CAPTION_ICONS[l.captionIcon]?.[1] : 'None'}
                {icons ? <ChevronUp className="ct-caret" aria-hidden="true" /> : <ChevronDown className="ct-caret" aria-hidden="true" />}
              </button>
            </div>
            {icons && (
              <div className="cap-icons ct-icons" role="listbox" aria-label="Icon">
                <button type="button" role="option" aria-selected={!l.captionIcon} className="cap-icon-opt" title="No icon" aria-label="No icon"
                  onClick={() => { patchLoadout(l.id, { captionIcon: undefined }); setIcons(false) }}><Ban /></button>
                {Object.entries(CAPTION_ICONS).map(([name, [I, label]]) => (
                  <button key={name} type="button" role="option" aria-selected={l.captionIcon === name} className="cap-icon-opt" title={label} aria-label={label}
                    onClick={() => { patchLoadout(l.id, { captionIcon: name }); setIcons(false) }}><I /></button>
                ))}
              </div>
            )}
            <div className="ct-field">
              <span>Color</span>
              <span className="cap-swatches" role="radiogroup" aria-label="Color">
                {CAPTION_COLORS.map(c => (
                  <button key={c} type="button" role="radio" aria-checked={shown === c} className="cap-swatch" style={{ background: c, '--sw': c } as React.CSSProperties}
                    title={c === CAPTION_COLORS[0] ? 'White' : c} aria-label={`Color ${c}`} onClick={() => patchLoadout(l.id, { captionColor: c === CAPTION_COLORS[0] ? undefined : c })} />
                ))}
              </span>
            </div>
            <div className="ct-field is-stacked">
              <span>Background</span>
              <CaptionBackground l={l} alert={alert} />
            </div>
          </> : <>
            <button type="button" className="ct-row" onClick={run(onImage)}><ImagePlus aria-hidden="true" /> Change image</button>
            {onNexus && <button type="button" className="ct-row" onClick={run(onNexus)}><img src={nexusLogo} alt="" className="nx-btn-logo" /> Picture from Nexus</button>}
          </>}
        </div>
      )}
      <button type="button" className="ct-btn" aria-expanded={open} aria-label="Card options" title="Card options" onClick={() => setOpen(v => !v)}>
        <ChevronUp aria-hidden="true" />
      </button>
    </div>
  )
}
