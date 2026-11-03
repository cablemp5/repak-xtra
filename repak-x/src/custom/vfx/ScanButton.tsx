import { useEffect, useRef, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { cue } from '../sounds'

/** The Library's Install split-button styling, with the menu above the updater footer. */
export default function ScanButton({ scanning, disabled, selected, flagged, onScan }: {
  scanning: boolean; disabled: boolean; selected: number; flagged: number; onScan: (flagged: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const item = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    item.current?.focus()
    const away = (e: PointerEvent) => { if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false) }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); cue('close') }
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])
  return (
    <div className="install-btn vf-scan" ref={wrap} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false) }}>
      <button type="button" className="install-btn-main" disabled={disabled || !selected} onClick={() => onScan(false)}
        title="Check the selected mods' materials without changing files">{scanning ? <span className="t-shimmer">Scanning</span> : 'Scan'}</button>
      <button type="button" className="install-btn-more" ref={trigger} disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} aria-label="More scan options" title="More scan options"
        onClick={() => { setOpen(v => !v); cue(open ? 'close' : 'open') }}
        onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); cue('open') } }}>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && <div className="sigeon-menu install-btn-menu vf-scan-menu" role="menu" aria-label="Scan options">
        <button type="button" role="menuitem" className="sigeon-item" ref={item} disabled={!flagged}
          title="Check all flagged mods' materials, including mods hidden by filters. Mesh and Blueprint-only warnings need their own checks."
          onClick={() => { setOpen(false); onScan(true) }}>
          <RefreshCw size={14} aria-hidden="true" /> Recheck flagged mods <small>{flagged}</small>
        </button>
      </div>}
    </div>
  )
}
