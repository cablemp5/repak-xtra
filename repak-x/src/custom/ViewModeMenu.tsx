// repakxtra: the Library header's view buttons folded into one, for when the header is narrow (the details panel is
// open). theme.css swaps it in for the row of view buttons with a container query on the header (modheader), so the
// title, the state tabs and the buttons stay on one row.
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export type ViewMode = { id: string; label: string; icon: React.ReactNode }

export default function ViewModeMenu({ modes, value, onChange }: { modes: ViewMode[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', esc, true) }
  }, [open])
  const current = modes.find(m => m.id === value) ?? modes[0]
  return (
    <div className="view-menu" ref={wrap}>
      <button type="button" className="btn-ghost view-menu-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}
        aria-label={`View: ${current?.label}`} title={`View: ${current?.label}`}>
        {current?.icon}<ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="sigeon-menu view-menu-list" role="menu" aria-label="View">
          {modes.map(m => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === value} className="sigeon-item"
              onClick={() => { onChange(m.id); setOpen(false) }}>
              <span className="view-menu-item">{m.icon}{m.label}</span>{m.id === value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
