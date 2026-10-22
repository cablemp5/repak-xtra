// repakxtra: the header's More menu. Share, Tools, Asset Explorer and VFX Updater are always here, whether or not
// Settings > Header buttons pins them as buttons of their own (uiPrefs.tsx). Keys as the Library's menus (menuKeys.ts):
// it opens on its first item, arrows move, Enter or Space picks, Esc or Tab close, focus goes back to More, and a dialog
// opened from it takes focus (dialogFocus.ts) and gives it back to More when it closes.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ChevronDown, Ellipsis } from 'lucide-react'
import { useMenuKeys } from './menuKeys'

export type MoreItem = { label: string; icon: ReactNode; run: () => void }

export default function HeaderMore({ items }: { items: MoreItem[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } } // the menu only
    document.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])
  return (
    <div className="header-more" ref={wrap}>
      <button type="button" className="btn-settings header-more-btn" aria-haspopup="menu" aria-expanded={open} aria-label="More tools"
        title="More: Share, Tools, Asset Explorer and VFX Updater" onClick={() => setOpen(v => !v)}>
        <Ellipsis size={16} aria-hidden="true" /><span className="header-more-label">More <ChevronDown size={14} aria-hidden="true" /></span>
      </button>
      {open && <MoreMenu items={items} onClose={() => setOpen(false)} />}
    </div>
  )
}

/** Its own component: useMenuKeys focuses the first item when the menu mounts and gives focus back when it goes. */
function MoreMenu({ items, onClose }: { items: MoreItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const onKeyDown = useMenuKeys(ref, onClose, () => undefined)
  return (
    <div ref={ref} className="sigeon-menu view-menu-list" role="menu" aria-label="More tools" onKeyDown={onKeyDown}>
      {items.map(item => (
        <button key={item.label} type="button" role="menuitem" className="sigeon-item" onClick={() => { onClose(); item.run() }}>
          <span className="view-menu-item">{item.icon}{item.label}</span>
        </button>
      ))}
    </div>
  )
}
