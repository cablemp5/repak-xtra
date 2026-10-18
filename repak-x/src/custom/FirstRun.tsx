// repakxtra: the first-launch setup, the welcome screen. One screen, top to bottom: the game folder, the signature
// bypass, Project Galacta, mod previews (optional), a desktop shortcut, then the first mods. Its bypass, Galacta and
// previews steps are Setup's own (SetupPanel.tsx: BypassStep, GalactaStep, PreviewsStep, with their descriptions and
// "Is it safe?"), numbered here; Setup shows the same steps with more detail. It opens once on a fresh install, and
// again from Setup > Guided setup. Closing it, or dropping mods on the window, marks it seen; the tour is offered at the end.
import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { motion } from 'framer-motion'
import { Upload } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { BypassStep, GalactaStep, PreviewsStep, Step } from './SetupPanel'
import { isKitZip } from './previewKit'
import { OFF_EXT } from './offFiles'
import Wordmark from './Wordmark'
import { ShortcutButton, useShortcut } from './shortcut'

type Alert = ReturnType<typeof useAlert>

const SEEN = 'repakxtra.welcomed'
const NEXUS = 'https://www.nexusmods.com/marvelrivals/mods'
const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
/** A fresh install: neither this screen nor the old tour was ever shown. */
const firstLaunch = () => !localStorage.getItem(SEEN) && !localStorage.getItem('hasSeenOnboarding')

export default function FirstRun({ alert, gamePath, onAutoDetect, onBrowse, onAddFiles, onStartTour }: {
  alert: Alert
  gamePath: string
  onAutoDetect: () => Promise<void>
  onBrowse: () => Promise<void>
  onAddFiles: (paths: string[]) => void
  onStartTour: () => void
}) {
  const [open, setOpen] = useState(firstLaunch)
  const [finding, setFinding] = useState(false)
  const shortcut = useShortcut()
  const detected = useRef(false)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('repakxtra-first-run', show)
    return () => window.removeEventListener('repakxtra-first-run', show)
  }, [])
  const close = () => { localStorage.setItem(SEEN, '1'); setOpen(false) }
  useEffect(() => {
    if (!open) return
    if (!gamePath && !detected.current) { detected.current = true; onAutoDetect().catch(() => undefined) } // most installs are found
    // Mods dropped on the window go to the install panel: this screen steps aside for it. A kit zip installs as the
    // kit (App's drop handler), so the screen stays and step 4 updates
    const off = listen<{ paths?: string[] } | string[]>('tauri://drag-drop', e => {
      const paths = Array.isArray(e.payload) ? e.payload : e.payload?.paths ?? []
      if (!(paths.length === 1 && isKitZip(paths[0]))) close()
    })
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.su-changelog-overlay')) { e.stopPropagation(); close() } }
    window.addEventListener('keydown', esc, true)
    return () => { off.then(f => f()).catch(() => undefined); window.removeEventListener('keydown', esc, true) }
  }, [open, gamePath])
  if (!open) return null

  const find = async () => {
    setFinding(true)
    try { await onAutoDetect() } catch (e) { alert.warning('Setup', String(e)) } finally { setFinding(false) }
  }
  const addFiles = async () => {
    const got = await pick({ multiple: true, title: 'Mods to install', filters: [{ name: 'Mod files', extensions: ['pak', 'zip', 'rar', '7z', OFF_EXT] }] }).catch(() => null)
    const paths = Array.isArray(got) ? got : got ? [got] : []
    if (!paths.length) return
    close()
    onAddFiles(paths)
  }

  const where = gamePath.replace(/^.*[\\/](MarvelRivals|Marvel Rivals)[\\/]/i, '…\\$1\\')
  const noGame = !gamePath

  return (
    <div className="modal-overlay fr-overlay" onClick={close}>
      <motion.div className="modal-content fr-modal" role="dialog" aria-label="Set up repakxtra" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        <div className="modal-header fr-head">
          <div>
            <h2 className="fr-welcome">Welcome to <Wordmark height={17} /></h2>
            <p className="su-sub">Get Marvel Rivals ready for mods. Steps 1 to 3 make mods work; close the game first.</p>
          </div>
          <button className="modal-close" onClick={close} aria-label="Close">×</button>
        </div>

        <ol className="modal-body fr-steps">
          <Step n={1} done={!noGame} title="Find the game"
            action={noGame
              ? <><button type="button" className="btn-primary" disabled={finding} onClick={find}>{finding ? 'Looking…' : 'Find it'}</button>
                  <button type="button" className="lo-text-btn" onClick={() => onBrowse()}>Browse…</button></>
              : <button type="button" className="lo-text-btn" onClick={() => onBrowse()}>Change…</button>}>
            <p>{noGame ? 'Not found yet. Find it looks in Steam and the usual places; Browse picks the folder yourself.' : <>Mods go to <code title={gamePath}>{where}</code></>}</p>
          </Step>

          {/* Setup's steps; a new game folder checks them again (key) */}
          <BypassStep key={`b${gamePath}`} n={2} alert={alert} blocked={noGame} />
          <GalactaStep key={`g${gamePath}`} n={3} alert={alert} blocked={noGame} />
          <PreviewsStep n={4} alert={alert} />

          <Step n={5} done={Boolean(shortcut.exists)} optional title="Desktop shortcut"
            action={!shortcut.exists && <ShortcutButton s={shortcut} />}>
            <p>{shortcut.exists ? 'On your desktop. Settings > General can make one again later.' : 'Start repakxtra from your desktop. You can also make one later in Settings > General.'}</p>
          </Step>

          <Step n={6} done={false} wide title="Add your first mods">
            <div className="fr-drop">
              {/* the icon on the text's first line, not a line of its own */}
              <span className="fr-drop-text">
                <Upload size={16} aria-hidden="true" />
                <span>Drop .pak, .pak.off, .zip, .rar or .7z files, or mod folders, anywhere on this window. Drop zips as they are: no need to extract.</span>
              </span>
              <span className="fr-drop-actions">
                <button type="button" className="lo-text-btn" disabled={noGame} onClick={addFiles}>Choose files…</button>
                <a onClick={() => openUrl(NEXUS)}>Find mods on Nexus Mods</a>
              </span>
            </div>
          </Step>
        </ol>

        <div className="modal-footer fr-foot">
          <span className="su-sub">Open this again from Setup &gt; Guided setup.</span>
          <button type="button" className="lo-text-btn" onClick={() => { close(); onStartTour() }}>Take the 1-minute tour</button>
          <button type="button" className="btn-primary" onClick={close}>Done</button>
        </div>
      </motion.div>
    </div>
  )
}
