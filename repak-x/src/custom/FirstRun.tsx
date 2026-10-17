// repakxtra: the first-launch setup. One screen, top to bottom: the game folder, the signature bypass, Project Galacta,
// mod previews (optional), then the first mods. It opens once on a fresh install, and again
// from Setup > Guided setup. Closing it, or dropping mods on the window, marks it seen; the tour is offered at the end.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { motion } from 'framer-motion'
import { Check, Upload } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { BlenderTrust, DoctorProblems, InstallStatus, KitProgressBar } from './SetupPanel'
import { isKitZip, usePreviewKit } from './previewKit'
import { OFF_EXT } from './offFiles'
import Wordmark from './Wordmark'
import { ShortcutButton, useShortcut } from './shortcut'

type Alert = ReturnType<typeof useAlert>
type Bypass = { state: 'installed' | 'disabled' | 'partial' | 'other' | 'missing' }
type Galacta = { installed: string | null; disabled: boolean }

const SEEN = 'repakxtra.welcomed'
const NEXUS = 'https://www.nexusmods.com/marvelrivals/mods'
const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
/** A fresh install: neither this screen nor the old tour was ever shown. */
const firstLaunch = () => !localStorage.getItem(SEEN) && !localStorage.getItem('hasSeenOnboarding')

function Step({ n, done, title, optional, wide, children, action }: {
  n: number; done: boolean; title: string; optional?: boolean; wide?: boolean; children: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <li className={`fr-step${done ? ' is-done' : ''}${wide ? ' is-wide' : ''}`}>
      <span className="fr-num" aria-hidden="true">{done ? <Check size={14} /> : n}</span>
      <div className="fr-text">
        <h3>{title}{optional && <span className="fr-optional">Optional</span>}</h3>
        {children}
      </div>
      {action && <div className="fr-action">{action}</div>}
    </li>
  )
}

export default function FirstRun({ alert, gamePath, onAutoDetect, onBrowse, onAddFiles, onStartTour }: {
  alert: Alert
  gamePath: string
  onAutoDetect: () => Promise<void>
  onBrowse: () => Promise<void>
  onAddFiles: (paths: string[]) => void
  onStartTour: () => void
}) {
  const [open, setOpen] = useState(firstLaunch)
  const [bypass, setBypass] = useState<Bypass | null>(null)
  const [bypassError, setBypassError] = useState<string | null>(null)
  const [galacta, setGalacta] = useState<Galacta | null>(null)
  const asked = useRef(0) // the newest status check: answers to an older one (another game folder) are dropped
  const [busy, setBusy] = useState<string | null>(null)
  const kit = usePreviewKit(alert)
  const shortcut = useShortcut()
  const detected = useRef(false)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('repakxtra-first-run', show)
    return () => window.removeEventListener('repakxtra-first-run', show)
  }, [])
  const close = () => { localStorage.setItem(SEEN, '1'); setOpen(false) }
  const checkStatus = () => {
    const id = ++asked.current
    const mine = () => asked.current === id
    setBypass(null); setBypassError(null); setGalacta(null)
    invoke<Bypass>('setup_bypass_status').then(b => { if (mine()) setBypass(b) }, e => { if (mine()) setBypassError(String(e)) })
    invoke<Galacta>('setup_galacta_status', { online: false }).then(g => { if (mine()) setGalacta(g) }, () => undefined)
  }
  useEffect(() => {
    if (!open) return
    checkStatus()
    kit.peek()
    if (!gamePath && !detected.current) { detected.current = true; onAutoDetect().catch(() => undefined) } // most installs are found
    // Mods dropped on the window go to the install panel: this screen steps aside for it. A kit zip installs as the
    // kit (App's drop handler), so the screen stays and step 4 updates
    const off = listen<{ paths?: string[] } | string[]>('tauri://drag-drop', e => {
      const paths = Array.isArray(e.payload) ? e.payload : e.payload?.paths ?? []
      if (!(paths.length === 1 && isKitZip(paths[0]))) close()
    })
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.su-changelog-overlay')) { e.stopPropagation(); close() } }
    window.addEventListener('keydown', esc, true)
    return () => { asked.current++; off.then(f => f()).catch(() => undefined); window.removeEventListener('keydown', esc, true) }
  }, [open, gamePath])
  if (!open) return null

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what)
    try { await f() } catch (e) { alert.warning('Setup', String(e)) } finally { setBusy(null) }
  }
  const installBypass = () => run('bypass', async () => {
    setBypass(await invoke<Bypass>('setup_bypass', { action: bypass?.state === 'disabled' ? 'enable' : 'install' }))
    window.dispatchEvent(new Event('bypass-changed')) // the Setup button's dot
  })
  const installGalacta = () => run('galacta', async () => { setGalacta(await invoke<Galacta>('setup_galacta_install', { folder: null })) })
  const addFiles = async () => {
    const got = await pick({ multiple: true, title: 'Mods to install', filters: [{ name: 'Mod files', extensions: ['pak', 'zip', 'rar', '7z', OFF_EXT] }] }).catch(() => null)
    const paths = Array.isArray(got) ? got : got ? [got] : []
    if (!paths.length) return
    close()
    onAddFiles(paths)
  }

  const where = gamePath.replace(/^.*[\\/](MarvelRivals|Marvel Rivals)[\\/]/i, '…\\$1\\')
  const bypassOn = bypass?.state === 'installed'
  const galactaOn = Boolean(galacta?.installed && !galacta.disabled)
  const bypassText = bypassOn ? 'Installed. Mods load from the next game launch.'
    : bypass?.state === 'disabled' ? 'Installed but turned off. Mods that need it will not load.'
    : bypass?.state === 'other' ? 'A different loader or bypass is installed. Installing keeps it next to the new one as a .repakxtra-backup file.'
    : bypass?.state === 'partial' ? 'Part of it is missing. Repair puts the missing files back.'
    : 'Lets the game load mods that replace its files. Every mod needs it. It comes with repakxtra; Setup shows why it is safe.'
  const kitReady = Boolean(kit.kit?.version && kit.kit?.blender)
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
              ? <><button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={() => run('find', onAutoDetect)}>{busy === 'find' ? 'Looking…' : 'Find it'}</button>
                  <button type="button" className="lo-text-btn" onClick={() => onBrowse()}>Browse…</button></>
              : <button type="button" className="lo-text-btn" onClick={() => onBrowse()}>Change</button>}>
            <p>{noGame ? 'Not found yet. Find it looks in Steam and the usual places; Browse picks the folder yourself.' : <>Mods go to <code title={gamePath}>{where}</code></>}</p>
          </Step>

          <Step n={2} done={bypassOn} title="Install the signature bypass"
            action={bypassError
              ? <button type="button" className="lo-text-btn" onClick={checkStatus}>Retry</button>
              : !bypassOn && <button type="button" className="btn-primary" disabled={noGame || !bypass || Boolean(busy)} onClick={installBypass}
                  title={noGame ? 'Find the game first' : undefined}>
                  {busy === 'bypass' ? 'Installing…' : bypass?.state === 'disabled' ? 'Turn on' : bypass?.state === 'partial' ? 'Repair' : 'Install'}</button>}>
            <p>{bypassError ? `Could not check it: ${bypassError}` : bypassText}</p>
          </Step>

          <Step n={3} done={galactaOn} title="Install Project Galacta"
            action={!galacta?.installed && <button type="button" className="btn-primary" disabled={noGame || Boolean(busy)} onClick={installGalacta}
              title={noGame ? 'Find the game first' : 'Downloads the newest release from GitHub'}>{busy === 'galacta' ? 'Installing…' : 'Install'}</button>}>
            <p>{galacta?.installed && !galactaOn ? 'Installed but switched off. Turn it on in the Library.'
              : galactaOn ? 'Installed. Loads more types of mods and lets you toggle mods in game.'
              : 'Needed by most skin mods: loads more types of mods and lets you toggle mods in game.'}</p>
          </Step>

          <Step n={4} done={kitReady && kit.doctor?.ok !== false} optional title="Mod previews"
            action={kit.progress?.stage === 'unpack' || kit.progress?.stage === 'blender' ? <InstallStatus p={kit.progress} /> : !kitReady && <button type="button" className="lo-text-btn" disabled={Boolean(kit.busy) || (kit.latest === null && !kit.kit?.version)} onClick={() => kit.setUp()}
              title={kit.latest === null ? 'No kit published yet: drop a kit zip on the window' : 'Downloads the preview kit and installs Blender if it is missing (Windows asks for admin rights once)'}>
              {kit.busy === 'setup' ? 'Setting up…' : 'Set up previews'}</button>}>
            <p>{kitReady ? 'Ready. A loadout page renders its preview.' : `Renders of your mods and loadouts, and clips of animation mods. Downloads the preview kit${kit.latest?.size ? ` (${Math.round(kit.latest.size / 1048576)} MB)` : ''} and uses Blender (installed for you if missing).`}</p>
            {!kitReady && kit.kit && !kit.kit.blender && <BlenderTrust />}
            <KitProgressBar p={kit.progress} />
            <DoctorProblems d={kit.doctor} />
          </Step>

          <Step n={5} done={Boolean(shortcut.exists)} optional title="Desktop shortcut"
            action={!shortcut.exists && <ShortcutButton s={shortcut} />}>
            <p>{shortcut.exists ? 'On your desktop. Settings > General can make one again later.' : 'Start repakxtra from your desktop. You can also make one later in Settings > General.'}</p>
          </Step>

          <Step n={6} done={false} wide title="Add your first mods">
            <div className="fr-drop">
              <Upload size={18} aria-hidden="true" />
              <span>Drop .pak, .pak.off, .zip, .rar or .7z files, or mod folders, anywhere on this window. Drop zips as they are: no need to extract.</span>
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
