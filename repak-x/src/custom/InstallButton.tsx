import { useEffect, useRef, useState } from 'react'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { GrInstall } from 'react-icons/gr'
import { ChevronDown, FolderPlus } from 'lucide-react'
import { OFF_EXT } from './offFiles'

/** The Library's install control, in place of upstream's PAK | Folder pair: Install picks mod files (Ctrl+O), the arrow
 *  beside it holds Install a folder for raw or uasset mods. Dropping files or folders on the window still works. */
export default function InstallButton({ onAddFiles, onAddFolder }: { onAddFiles: (files: string[]) => void; onAddFolder: (folders: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc, true) }
  }, [open])

  const choose = async (directory: boolean) => {
    setOpen(false)
    const got = await pick(directory
      ? { directory: true, multiple: true, title: 'Select Folder(s) to Install' }
      : { multiple: true, title: 'Select Mods to Install', filters: [{ name: 'Mod Files', extensions: ['pak', 'zip', 'rar', '7z', OFF_EXT] }] }
    ).catch(() => null)
    const paths = Array.isArray(got) ? got : got ? [got] : []
    if (paths.length) (directory ? onAddFolder : onAddFiles)(paths)
  }

  return (
    <div className="install-btn" ref={wrap} data-tour="add-mod-btn">
      <button type="button" className="install-btn-main" data-tour="install-btn" onClick={() => choose(false)}
        title="Install mods (Ctrl+O). You can also drop .pak, .zip, .rar or .7z files anywhere on the window">
        <GrInstall size={16} /> Install
      </button>
      <button type="button" className="install-btn-more" aria-haspopup="menu" aria-expanded={open} aria-label="More ways to install"
        title="More ways to install" onClick={() => setOpen(v => !v)}>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="sigeon-menu install-btn-menu" role="menu" aria-label="More ways to install">
          <button type="button" role="menuitem" className="sigeon-item" onClick={() => choose(true)}>
            <FolderPlus size={14} /> Install a folder <small>raw or uasset files</small>
          </button>
        </div>
      )}
    </div>
  )
}
