// repakxtra: Sigeon V2 setup, opened from the header while Sigeon reads "not configured" (no SigeonLoader.asi in the
// Sigeon folder). Four numbered steps, the welcome screen's and Setup's rows (SetupPanel.tsx Step: a check once done, the action on
// the right, blue while a step still needs it, as there): where to buy it, the signature bypass it loads through (Setup's
// own BypassStep, "Is it safe?" included), the folder its files stay in, then the editor (a config and its license key).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { open as pickFolder } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import type { useAlert } from '../components/AlertHandler'
import { BypassStep, ExtLink, Step } from './SetupPanel'

type Storage = { path: string; default: boolean; loader: boolean }

const STORE = 'https://oinkerhub.com/CABLE'

export default function SigeonSetup({ alert, onClose, onEdit }: { alert: ReturnType<typeof useAlert>; onClose: () => void; onEdit: () => void }) {
  const [storage, setStorage] = useState<Storage | null>(null)

  // again on focus: back from unzipping into Desktop\Sigeon V2 (the default folder), it shows as found
  const check = () => { invoke<Storage>('sigeon_storage').then(setStorage).catch(() => {}) }
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

  const ready = Boolean(storage?.loader)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div className="modal-content su-modal ss-modal" role="dialog" aria-label="Set up Sigeon V2" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <h2>Set up Sigeon V2</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          <p className="su-sub">A performance loader for Marvel Rivals. Once it is set up, repakxtra switches it on and off and edits its configs.</p>
        </div>

        <ol className="modal-body fr-steps ss-steps">
          {/* Having the loader means it was bought: the store link steps aside */}
          <Step n={1} done={ready} title="Get Sigeon V2"
            action={!ready && <button type="button" className="btn-primary" onClick={() => openUrl(STORE).catch(() => window.open(STORE, '_blank'))}>
              Buy Sigeon V2</button>}>
            <p>Sold on Oinker Hub (<ExtLink href={STORE}>oinkerhub.com/CABLE</ExtLink>). You get a download with SigeonLoader.asi in it, and
              your license&nbsp;key&nbsp;by&nbsp;email.</p>
            {ready && <p className="fr-state">Downloaded. Your license key came by email.</p>}
          </Step>

          {/* The bypass every mod loads through; it tells the Setup button itself (bypass-changed) */}
          <BypassStep n={2} alert={alert} />

          <Step n={3} done={ready} title="Sigeon folder"
            action={<button type="button" className={ready ? 'lo-text-btn' : 'btn-primary'} onClick={choose}>
              {ready ? 'Change…' : 'Choose folder'}</button>}>
            <p>Unzip the download into a folder you keep, like Desktop\Sigeon V2, and choose it. Leave the files there:
              repakxtra copies the loader and the config you pick into the game.</p>
            {storage && <p className="fr-state">{ready ? <>Found in <code>{storage.path}</code>.</> : <><code>{storage.path}</code> has no SigeonLoader.asi.</>}</p>}
          </Step>

          <Step n={4} done={false} title="Config and license key"
            action={<button type="button" className="btn-primary" disabled={!ready} onClick={onEdit}>Open the editor</button>}>
            <p>Make a config in the editor, then paste your license key into it in Notepad. Your key stays in that file: repakxtra never shows it.</p>
            {!ready && <p className="fr-state">Choose a folder containing SigeonLoader.asi first.</p>}
          </Step>
        </ol>
      </motion.div>
    </div>
  )
}
