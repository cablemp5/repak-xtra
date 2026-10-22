// repakxtra: the first-launch setup. On the first launch it opens on what loadouts are (WelcomeIntro.tsx), then one
// screen, top to bottom: the game folder, the signature bypass, Project Galacta, the first mods, then under Optional mod
// previews and the desktop shortcut. Setup > Guided setup opens it again on the steps. Closing it, or dropping mods on the window, marks it
// seen; the tour is offered at the end.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { motion } from 'framer-motion'
import { Check, Upload } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { DoctorProblems } from './SetupPanel'
import { BypassTrack, GalactaTrack, KitTrack, useFinished } from './installTrack'
import { isKitZip, usePreviewKit } from './previewKit'
import { OFF_EXT } from './offFiles'
import Wordmark from './Wordmark'
import WelcomeIntro from './WelcomeIntro'
import { ShortcutButton, useShortcut } from './shortcut'
import { ownsTop, useDialogFocus } from './dialogFocus'

type Alert = ReturnType<typeof useAlert>
type Bypass = { state: 'installed' | 'disabled' | 'partial' | 'other' | 'missing' }
type Galacta = { installed: string | null; disabled: boolean }

const SEEN = 'repakxtra.welcomed'
const NEXUS = 'https://www.nexusmods.com/marvelrivals/mods'
const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
/** repakxtra's first launch: this screen was never shown here, whatever is set up already (Repak X's tour, a game
 *  folder, the bypass). Its steps show what is done. */
const firstLaunch = () => !localStorage.getItem(SEEN)

/** One numbered step: its number (a check once done), title, text and its action on the right. Sigeon's setup uses it too. */
export function Step({ n, done, title, optional, wide, children, action }: {
  n: number; done: boolean; title: string; optional?: boolean; wide?: boolean; children: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <li className={`fr-step${done ? ' is-done' : ''}${wide ? ' is-wide' : ''}`}>
      <span className="fr-num" aria-hidden="true">{done ? <Check size={16} strokeWidth={2.5} /> : n}</span>
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
  const [intro, setIntro] = useState(firstLaunch) // the first page, about loadouts: first launch only, or "Why loadouts?"
  const [bypass, setBypass] = useState<Bypass | null>(null)
  const [bypassError, setBypassError] = useState<string | null>(null)
  const [galacta, setGalacta] = useState<Galacta | null>(null)
  const asked = useRef(0) // the newest status check: answers to an older one (another game folder) are dropped
  const [busy, setBusy] = useState<string | null>(null)
  const { finished, finish } = useFinished() // a step that just installed, said in it for a moment
  const kit = usePreviewKit(alert)
  const shortcut = useShortcut()
  const detected = useRef(false)
  const focus = useDialogFocus(open) // focus inside, Tab stays inside, back to the opener on close

  useEffect(() => {
    const show = () => { setIntro(false); setOpen(true) }
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
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && ownsTop(focus.ref.current)) { e.stopPropagation(); close() } } // a changelog above it takes Esc first
    window.addEventListener('keydown', esc, true)
    return () => { asked.current++; off.then(f => f()).catch(() => undefined); window.removeEventListener('keydown', esc, true) }
  }, [open, gamePath])
  if (!open) return null

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what)
    try { await f(); finish(what) } catch (e) { alert.warning('Setup', String(e)) } finally { setBusy(null) }
  }
  const installBypass = () => run('bypass', async () => {
    setBypass(await invoke<Bypass>('setup_bypass', { action: bypass?.state === 'disabled' ? 'enable' : 'install' }))
    window.dispatchEvent(new Event('bypass-changed')) // the Setup button's dot
  })
  const installGalacta = () => run('galacta', async () => { setGalacta(await invoke<Galacta>('setup_galacta_install', { folder: null })) })
  // One click for the three steps mods need, in order, each step showing its own progress as it goes (cable,
  // 2026-10-21: setup as frictionless as possible). A step already done is skipped
  const setUpAll = async () => {
    try {
      if (!gamePath) { setBusy('find'); await onAutoDetect() }
      if (bypass?.state !== 'installed') {
        setBusy('bypass')
        setBypass(await invoke<Bypass>('setup_bypass', { action: bypass?.state === 'disabled' ? 'enable' : 'install' }))
        window.dispatchEvent(new Event('bypass-changed'))
        finish('bypass')
      }
      if (!galacta?.installed) { setBusy('galacta'); setGalacta(await invoke<Galacta>('setup_galacta_install', { folder: null })); finish('galacta') }
    } catch (e) { alert.warning('Setup', String(e)) } finally { setBusy(null) }
  }
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
    : 'Lets the game load mods. Every mod needs it, and Setup shows why it is safe.'
  const kitReady = Boolean(kit.kit?.version && kit.kit?.blender)
  const noGame = !gamePath
  const coreDone = !noGame && bypassOn && galactaOn
  const coreCount = [!noGame, bypassOn, galactaOn].filter(Boolean).length // the three steps mods need, shown as "1 of 3 done"

  return (
    <div className="modal-overlay fr-overlay" onClick={close}>
      <motion.div ref={focus.ref} onKeyDown={focus.onKeyDown} tabIndex={-1} className="modal-content fr-modal" role="dialog" aria-modal="true" aria-label="Set up repakxtra"
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        {intro ? <>
          <button className="modal-close fr-intro-close" onClick={close} aria-label="Close">×</button>
          <WelcomeIntro onNext={() => setIntro(false)} onSkip={close} />
        </> : <>
        <div className="modal-header fr-head">
          <div>
            <h2 className="fr-welcome">Welcome to <Wordmark height={17} /></h2>
            <p className="su-sub">{coreDone ? 'Mods are ready to go. Add some below.' : <>Three steps get mods working: <b className="fr-progress">{coreCount} of 3 done</b>. Close the game first.</>} <button type="button" className="su-link" onClick={() => setIntro(true)}>Why loadouts?</button></p>
          </div>
          {!coreDone && (
            <button type="button" className="btn-primary fr-all" disabled={Boolean(busy) || (bypass === null && !bypassError)} onClick={setUpAll}
              title="Finds the game, installs the signature bypass and Project Galacta, one after another">
              {busy ? 'Setting up…' : 'Set up mods'}
            </button>
          )}
          <button className="modal-close" onClick={close} aria-label="Close">×</button>
        </div>

        <ol className="modal-body fr-steps">
          <Step n={1} done={!noGame} title="Find the game"
            action={noGame
              ? <><button type="button" className="btn-primary" disabled={Boolean(busy)} onClick={() => run('find', onAutoDetect)}>{busy === 'find' ? 'Looking…' : 'Find it'}</button>
                  <button type="button" className="lo-text-btn" onClick={() => onBrowse()}>Browse…</button></>
              : null /* found: nothing to do here (Settings > General changes the folder) */}>
            <p>{noGame ? 'Not found yet. Find it searches your Steam libraries.' : <>Found. Mods go to <code title={gamePath}>{where}</code></>}</p>
          </Step>

          <Step n={2} done={bypassOn} title="Install the signature bypass"
            action={bypassError
              ? <button type="button" className="lo-text-btn" onClick={checkStatus}>Retry</button>
              : !bypassOn && <button type="button" className="btn-primary" disabled={noGame || !bypass || Boolean(busy)} onClick={installBypass}
                  title={noGame ? 'Find the game first' : undefined}>
                  {busy === 'bypass' ? 'Installing…' : bypass?.state === 'disabled' ? 'Turn on' : bypass?.state === 'partial' ? 'Repair' : 'Install'}</button>}>
            <p>{bypassError ? `Could not check it: ${bypassError}` : bypassText}</p>
            <BypassTrack on={busy === 'bypass'} done={finished === 'bypass' ? 'Installed. Mods load from the next game launch.' : undefined} />
          </Step>

          <Step n={3} done={galactaOn} title="Install Project Galacta"
            action={!galacta?.installed && <button type="button" className="btn-primary" disabled={noGame || Boolean(busy)} onClick={installGalacta}
              title={noGame ? 'Find the game first' : 'Downloads the newest release from GitHub'}>{busy === 'galacta' ? 'Installing…' : 'Install'}</button>}>
            <p>{galacta?.installed && !galactaOn ? 'Installed but switched off. Turn it on in the Library.'
              : galactaOn ? 'Installed.'
              : 'Most skin mods need it. It also lets you switch mods in game.'}</p>
            <GalactaTrack on={busy === 'galacta'} done={finished === 'galacta' ? 'Project Galacta is in your mods folder' : undefined} />
          </Step>

          <Step n={4} done={false} wide title="Add your first mods">
            <div className="fr-drop">
              <span className="fr-drop-text">Drop mod files or zips anywhere on this window. No need to unzip.</span>
              <span className="fr-drop-actions">
                <button type="button" className="lo-text-btn" disabled={noGame} onClick={addFiles}><Upload size={14} aria-hidden="true" /> Choose files…</button>
                <a onClick={() => openUrl(NEXUS)}>Find mods on Nexus Mods</a>
              </span>
            </div>
          </Step>
          {/* the goal (your first mods) right after the three steps it needs, the extras under their own label */}
          <li className="fr-divider" aria-hidden="true">Optional</li>
          <Step n={5} done={kitReady && kit.doctor?.ok !== false} title="Mod previews"
            action={!kitReady && !kit.plan && <button type="button" className="lo-text-btn" disabled={Boolean(kit.busy) || (kit.latest === null && !kit.kit?.version)} onClick={() => kit.setUp()}
              title={kit.latest === null ? 'No kit published yet: drop a kit zip on the window' : 'Downloads the preview kit and installs Blender if it is missing (Windows asks for admin rights once)'}>
              {kit.busy === 'setup' ? 'Setting up…' : 'Set up previews'}</button>}>
            <p>{kitReady ? 'Ready.' : `Pictures of your loadouts, rendered on your PC${kit.latest?.size ? ` (a ${Math.round(kit.latest.size / 1048576)} MB download, plus Blender)` : ''}.`}</p>
            <KitTrack plan={kit.plan} p={kit.progress} done={kit.finished ?? undefined} />
            <DoctorProblems d={kit.doctor} />
          </Step>

          <Step n={6} done={Boolean(shortcut.exists)} title="Desktop shortcut"
            action={!shortcut.exists && <ShortcutButton s={shortcut} />}>
            <p>{shortcut.exists ? 'On your desktop.' : 'Start repakxtra from your desktop.'}</p>
          </Step>

        </ol>

        <div className="modal-footer fr-foot">
          <span className="su-sub">Open this again from Setup &gt; Guided setup.</span>
          <button type="button" className="lo-text-btn" onClick={() => { close(); onStartTour() }}>Take the 1-minute tour</button>
          {/* Done once mods can load. Before that, leaving is "Finish later" and quieter, so it never outshines the steps */}
          <button type="button" className={coreDone ? 'btn-primary' : 'lo-text-btn'} onClick={close}>{coreDone ? 'Done' : 'Finish later'}</button>
        </div>
        </>}
      </motion.div>
    </div>
  )
}
