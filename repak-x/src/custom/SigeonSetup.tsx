// repakxtra: Sigeon V2 setup, opened from the header while Sigeon reads "not configured" (no SigeonLoader.asi in the
// Sigeon folder). Four numbered steps, the guided setup's own rows (FirstRun.tsx Step: a check once done, the action on
// the right): where to buy it, the signature bypass it loads through, the folder its files stay in, then the editor
// (a config and its license key).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { ExternalLink, FolderOpen, SlidersHorizontal } from 'lucide-react'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import type { useAlert } from '../components/AlertHandler'
import { Step } from './FirstRun'

type Storage = { path: string; default: boolean; loader: boolean }
type Bypass = { state: 'installed' | 'disabled' | 'partial' | 'other' | 'missing' }

const STORE = 'https://oinkerhub.com/CABLE'
/** What the bypass step says in each state: the state itself, then what to do */
const BYPASS_TEXT: Record<Bypass['state'], string> = {
  installed: 'Installed. Sigeon loads through it, like every mod.',
  disabled: 'Installed but turned off. Turn it on so Sigeon and your mods load.',
  partial: 'Part of it is missing. Repair puts the missing files back.',
  other: 'A different loader or bypass is installed. Setup shows it and can install the one that comes with repakxtra.',
  missing: 'Sigeon loads through it, like every mod. It comes with repakxtra.',
}

export default function SigeonSetup({ alert, onClose, onEdit }: { alert: ReturnType<typeof useAlert>; onClose: () => void; onEdit: () => void }) {
  const [storage, setStorage] = useState<Storage | null>(null)
  const [bypass, setBypass] = useState<Bypass | string | null>(null)   // a string: why it can't be checked
  const [busy, setBusy] = useState(false)

  // again on focus: back from unzipping into Desktop\Sigeon V2 (the default folder), it shows as found
  const check = () => {
    invoke<Storage>('sigeon_storage').then(setStorage).catch(() => {})
    invoke<Bypass>('setup_bypass_status').then(setBypass).catch(e => setBypass(String(e)))
  }
  useEffect(() => {
    check()
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('focus', check)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('focus', check); window.removeEventListener('keydown', esc, true) }
  }, [])

  const choose = async () => {
    const path = await pickFolder({ directory: true, title: 'The folder you unzipped Sigeon V2 into' }).catch(() => null)
    if (!path) return
    try {
      const s = await invoke<Storage>('sigeon_set_storage', { path })
      setStorage(s)
      window.dispatchEvent(new Event('sigeon-changed'))
      if (!s.loader) alert.warning('SigeonLoader.asi is not there', 'Choose the folder you unzipped the Sigeon V2 download into.')
    } catch (e) { alert.warning('Folder not set', String(e)) }
  }

  const fixBypass = async (action: 'install' | 'enable') => {
    setBusy(true)
    try {
      setBypass(await invoke<Bypass>('setup_bypass', { action }))
      window.dispatchEvent(new Event('bypass-changed'))
    } catch (e) { alert.warning('Signature bypass', String(e)) }
    setBusy(false)
  }

  const b = typeof bypass === 'object' ? bypass : null
  const ready = Boolean(storage?.loader)
  const fixable = b?.state === 'missing' || b?.state === 'partial' || b?.state === 'disabled'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div className="modal-content su-modal ss-modal" role="dialog" aria-label="Set up Sigeon V2" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div>
            <h2>Set up Sigeon V2</h2>
            <p className="su-sub">A performance loader for Marvel Rivals. Once it is set up, repakxtra switches it on and off and edits its configs.</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <ol className="modal-body fr-steps ss-steps">
          {/* Having the loader means it was bought: the store link steps aside */}
          <Step n={1} done={ready} title="Get Sigeon V2"
            action={!ready && <button type="button" className="lo-text-btn" onClick={() => openUrl(STORE).catch(() => window.open(STORE, '_blank'))}>
              <ExternalLink size={14} /> Buy at oinkerhub.com/CABLE</button>}>
            <p>{ready ? 'Downloaded. Your license key came by email.' : 'Sold on Oinker Hub. You get a download with SigeonLoader.asi in it, and your license key by email.'}</p>
          </Step>

          <Step n={2} done={b?.state === 'installed'} title="Signature bypass"
            action={fixable && <button type="button" className="btn-primary" disabled={busy} onClick={() => fixBypass(b!.state === 'disabled' ? 'enable' : 'install')}>
              {busy ? 'Working…' : b!.state === 'disabled' ? 'Turn on' : b!.state === 'partial' ? 'Repair' : 'Install'}</button>}>
            <p>{typeof bypass === 'string' ? `Could not check it: ${bypass}` : b ? BYPASS_TEXT[b.state] : 'Checking…'}</p>
          </Step>

          <Step n={3} done={ready} title="Sigeon folder"
            action={<button type="button" className={ready ? 'lo-text-btn' : 'btn-primary'} onClick={choose}>
              {ready ? 'Change…' : <><FolderOpen size={14} /> Choose folder</>}</button>}>
            {ready
              ? <p>Found in <code>{storage!.path}</code>. Leave the files there: repakxtra copies the loader and the config you pick into the game.</p>
              : <p>Unzip the download into a folder you keep, like Desktop\Sigeon V2, and choose it.
                  {storage && <> <code>{storage.path}</code> has no SigeonLoader.asi.</>}</p>}
          </Step>

          <Step n={4} done={false} title="Config and license key"
            action={<button type="button" className="btn-primary" disabled={!ready} onClick={onEdit}><SlidersHorizontal size={14} /> Open the editor</button>}>
            <p>Make a config in the editor, then paste your license key into it in Notepad. Your key stays in that file: repakxtra never shows it.
              {!ready && ' Choose the Sigeon folder first.'}</p>
          </Step>
        </ol>
      </motion.div>
    </div>
  )
}
