// repakxtra: Setup, what the game needs to load mods (backend: xtra_setup.rs). The UTOC signature bypass ships inside
// repakxtra; Project Galacta comes from its GitHub releases, with an update check and the release notes. Its steps
// (BypassStep, GalactaStep, PreviewsStep, in Step rows) are the welcome screen's too (FirstRun.tsx): one design, Setup
// showing each step's extra detail (`full`).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { Check, ChevronRight, Copy, ExternalLink, ShieldCheck, Wrench } from 'lucide-react'
import { open as pickFile } from '@tauri-apps/plugin-dialog'
import { type Doctor, type KitProgress, isNewerKit, progressShare, progressText, usePreviewKit } from './previewKit'
import Checkbox from '../components/ui/Checkbox'
import CustomDropdown from '../components/CustomDropdown'
import type { useAlert } from '../components/AlertHandler'
import { savedItem } from './storageCarryOver'
import { MatrixLoader } from './motion'
import CopySetupReport from './CopySetupReport'
import { noteGalactaCheck } from './setupReport'
import { useDialogFocus } from './dialogFocus'

type Alert = ReturnType<typeof useAlert>
type FileCheck = { name: string; place: string; size: number; sha256: string; found: 'missing' | 'same' | 'other' }
type Bypass = { state: 'installed' | 'disabled' | 'partial' | 'other' | 'missing'; files: FileCheck[]; license: string; sigeon_on: boolean }
type Galacta = { installed: string | null; disabled: boolean; latest: string | null; published: string | null; notes: string | null; url: string | null; up_to_date: boolean | null }

const AUTO_KEY = 'repakxtra.setup.autoCheck'
const autoCheck = () => savedItem(AUTO_KEY) !== '0'
const FOLDER_KEY = 'repakxtra.setup.galactaFolder'
const HERE = '__here'   // install where Galacta already is, or the mods folder itself
const NEXUS = 'https://www.nexusmods.com/marvelrivals/mods/2940'
const LOADER = 'https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases/tag/v7.7.0'
const VIRUSTOTAL = 'https://www.virustotal.com/gui/file/251d2830ec8c1f3ed804ce4d8340705264642435cd3218308d18c7ee314db776'
const GALACTA = 'https://github.com/0xSaturno/ProjectGalacta'

const open = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')

/** Release notes are short Markdown: headings, bullets and paragraphs, drawn as such (no HTML from the web). */
function Notes({ text }: { text: string }) {
  return (
    <div className="su-notes">
      {text.split(/\r?\n/).map((raw, i) => {
        const l = raw.trim().replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
        if (!l) return null
        const h = l.match(/^(#{1,6})\s+(.*)$/)
        if (h) return h[1].length <= 2 ? <h4 key={i}>{h[2]}</h4> : <h5 key={i}>{h[2]}</h5>
        const b = l.match(/^[-*]\s+(.*)$/)
        return b ? <p key={i} className="su-bullet">{b[1]}</p> : <p key={i}>{l}</p>
      })}
    </div>
  )
}

function Changelog({ g, title, onClose, product = 'Project Galacta' }: {
  g: Pick<Galacta, 'latest' | 'published' | 'notes' | 'url'>; title: string; onClose: () => void; product?: string
}) {
  useEffect(() => {   // Esc closes this first; the window under it skips Esc while a changelog is open
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [onClose])
  return (
    <div className="modal-overlay su-changelog-overlay" onClick={e => { e.stopPropagation(); onClose() }}>
      <motion.div className="modal-content su-changelog" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div><h2>{title}</h2><p className="su-sub">{product} {g.latest} · {date(g.published)}</p></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{g.notes?.trim() ? <Notes text={g.notes} /> : <p className="su-sub">This release has no notes.</p>}</div>
        <div className="modal-footer su-footer">
          {g.url && <button type="button" className="lo-text-btn" onClick={() => open(g.url!)}><ExternalLink size={14} /> On GitHub</button>}
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </motion.div>
    </div>
  )
}

const BLENDER = 'https://www.blender.org/download/'

/** The kit's download: the dot loader and how much ("38 MB of 108 MB") over a thin bar. Unpacking and Blender's
 *  install show in their own rows instead (InstallStatus). */
export function KitProgressBar({ p }: { p: KitProgress | null }) {
  if (!p || p.stage === 'unpack' || p.stage === 'blender') return null
  const share = progressShare(p)
  return (
    <div className="su-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share === null ? undefined : Math.round(share * 100)}>
      <span className="su-progress-text"><MatrixLoader size={12} />{progressText(p)}</span>
      <span className="su-progress-track"><i style={share === null ? undefined : { width: `${share * 100}%` }} className={share === null ? 'is-indeterminate' : ''} /></span>
    </div>
  )
}

/** The kit unpacking or Blender installing: the blue dot loader and what is happening ("Unpacking", winget's step and
 *  its percent), in place of that part's state (Setup's Preview kit or Blender row, the guided setup's step action). */
export function InstallStatus({ p }: { p: KitProgress | null }) {
  if (p?.stage !== 'unpack' && p?.stage !== 'blender') return null
  const text = progressText(p)
  return <span className="su-install-status" role="status" title={text}><MatrixLoader size={11} /><span>{text}</span></span>
}

/** A quiet line that opens what it is about under it ("Is it safe? ›"): the bypass's safety facts, the Blender note. A
 *  click, not a hover, so it works from the keyboard and stays put while it is read. */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="su-trust">
      <button type="button" className="su-trust-btn" aria-expanded={shown} onClick={() => setShown(v => !v)}>
        <ShieldCheck size={13} aria-hidden="true" /> {label} <ChevronRight size={13} className="su-caret" aria-hidden="true" />
      </button>
      <div className="t-acc-panel" data-open={shown} ref={el => el?.toggleAttribute('inert', !shown)}>
        <div className="t-acc-panel-inner"><div className="su-trust-body">{children}</div></div>
      </div>
    </div>
  )
}

/** Why Blender is safe to install, where it comes from, and its real download page. */
export function BlenderTrust() {
  return (
    <Disclosure label="Is Blender safe?">
      <p>Blender is free, open-source 3D software from the Blender Foundation. repakxtra installs the official release
        through winget, Windows' own package manager, and Windows asks for admin rights once. <a href={BLENDER} onClick={e => { e.preventDefault(); open(BLENDER) }}>blender.org/download</a></p>
    </Disclosure>
  )
}

/** What the generator's check says is missing on this PC, one sentence each. */
export function DoctorProblems({ d }: { d: Doctor | null }) {
  if (!d || d.ok || !d.problems.length) return null
  return <ul className="su-problems">{d.problems.map(x => <li key={x}>{x}</li>)}</ul>
}

/** One fact under a Setup step, the same row under every step: what it is, its value, and the links that act on it. */
function Detail({ label, children, links }: { label: string; children: React.ReactNode; links?: React.ReactNode }) {
  return (
    <div className="su-detail">
      <span className="su-detail-label">{label}</span>
      <span className="su-detail-value">{children}</span>
      {links && <span className="su-detail-links">{links}</span>}
    </div>
  )
}

/** One setup step, the same row in the welcome screen, Setup and the Sigeon setup: its mark (the welcome's number, an
 *  empty ring in Setup, a check once done), its title, what it is and its state, then its action on the title's line. */
export function Step({ n, done, title, optional, wide, className = '', children, action, more }: {
  n?: number; done: boolean; title: string; optional?: boolean; wide?: boolean; className?: string; children: React.ReactNode; action?: React.ReactNode
  more?: React.ReactNode   // under the title row, the full width past the action (Setup's detail rows)
}) {
  return (
    <li className={`fr-step${done ? ' is-done' : ''}${wide ? ' is-wide' : ''}${n === undefined ? ' is-plain' : ''} ${className}`}>
      <span className="fr-num" aria-hidden="true">{done ? <Check size={14} /> : n}</span>
      <div className="fr-text"><h3>{title}{optional && <span className="fr-optional">Optional</span>}</h3></div>
      {action && <div className="fr-action">{action}</div>}
      {/* Under the title row, the full width past the action: the description, then the details */}
      <div className="fr-text fr-body">{children}</div>
      {more && <div className="fr-more">{more}</div>}
    </li>
  )
}

/** Where a step's action does its work: a Setup failure as a warning, then the busy state cleared. */
const useRun = (alert: Alert) => {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async <T,>(what: string, f: () => Promise<T>) => {
    setBusy(what)
    try { return await f() } catch (e) { alert.warning('Setup', String(e)) } finally { setBusy(null) }
  }
  return { busy, run }
}

/** The signature bypass step. Both screens: what it does in its current state, Install / Repair / Turn on, and "Is it safe?"
 *  with the facts, the files and their hashes, and the loader's license. Setup (`full`) adds Turn off and Remove, which ask
 *  first while Sigeon is on (it loads through the same loader). `blocked`: no game folder yet. */
export function BypassStep({ alert, n, full, blocked }: { alert: Alert; n?: number; full?: boolean; blocked?: boolean }) {
  const [b, setB] = useState<Bypass | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState<'disable' | 'remove' | null>(null)
  const { busy, run } = useRun(alert)
  const load = () => { setError(null); invoke<Bypass>('setup_bypass_status').then(setB, e => setError(String(e))) }
  useEffect(load, [])
  const act = (action: 'install' | 'enable' | 'disable' | 'remove') => run(action, async () => {
    setConfirmOff(null)
    setB(await invoke<Bypass>('setup_bypass', { action }))
    window.dispatchEvent(new Event('bypass-changed')) // the Setup button's dot
    alert.success('Signature bypass', { install: 'Installed. Mods load from the next game launch.', enable: 'On again.',
      disable: 'Off. Mods that need it will not load.', remove: 'Removed.' }[action])
  })
  const fixable = b && b.state !== 'installed'
  const state = error ? `Could not check it: ${error}`
    : !b ? 'Checking…'
    : b.state === 'installed' ? 'Installed. Mods load from the next game launch.'
    : b.state === 'disabled' ? 'Installed but turned off. Mods that need it will not load.'
    : b.state === 'other' ? 'A different loader or bypass is installed. Installing keeps it next to the new one as a .repakxtra-backup file.'
    : b.state === 'partial' ? 'Part of it is missing. Repair puts the missing files back.'
    : null
  // Under the title row, the full width: the Sigeon question when turning it off, then "Is it safe?"
  const more = (<>
      {b?.sigeon_on && confirmOff && (
        <div className="su-confirm" role="alert">
          <span>Sigeon loads through the same loader, so it turns off too.</span>
          <button type="button" className="lo-text-btn" onClick={() => setConfirmOff(null)}>Cancel</button>
          <button type="button" className="lo-text-btn" onClick={() => act(confirmOff)}>{confirmOff === 'remove' ? 'Remove anyway' : 'Turn off anyway'}</button>
        </div>
      )}
      {/* Plain sentences, then the two files one line each (copy a hash to check it yourself), then the loader's license */}
      <Disclosure label="Is it safe?">
        <p>VirusTotal: 0 of 63 engines flagged the release archive (Oct 14, 2026). <a onClick={() => open(VIRUSTOTAL)}>See the report</a></p>
        <p>dsound.dll is ThirteenAG's open-source Ultimate ASI Loader 7.7.0 (MIT), byte for byte the official release. <a onClick={() => open(LOADER)}>See it on GitHub</a></p>
        <p>MarvelRivalsUTOCSignatureBypass.asi only patches the game in memory: it uses Windows memory and thread functions,
          with no internet, file, registry or program-launch calls. It is closed source and unsigned.</p>
        <p>Both files are unchanged from the Nexus Mods release. <a onClick={() => open(NEXUS)}>Open the mod page</a></p>
        {b && b.files.length > 0 && (
          <ul className="su-files">{b.files.map(f => (
            <li key={f.name}>
              <code>{f.name}</code>
              <button type="button" className="su-link su-hash" title={`Copy the SHA-256 of ${f.name}`} onClick={() => { navigator.clipboard.writeText(f.sha256); alert.success('Copied', `${f.name} SHA-256`) }}>
                SHA-256 {f.sha256.slice(0, 8)}… <Copy size={11} aria-hidden="true" /></button>
              <span>{f.place} · {(f.size / 1024).toFixed(0)} KB · {f.found === 'same' ? 'matches here' : f.found === 'other' ? 'a different file here' : 'not here yet'}</span>
            </li>
          ))}</ul>
        )}
        {b?.license && <details className="su-license"><summary>Loader license (MIT)</summary><pre>{b.license}</pre></details>}
      </Disclosure>
  </>)
  return (
    <Step n={n} className="is-req" more={more} done={b?.state === 'installed'} title="Signature bypass"
      action={error ? <button type="button" className="lo-text-btn" onClick={load}>Retry</button> : <>
        {fixable && <button type="button" className="btn-primary" disabled={blocked || Boolean(busy)} onClick={() => act(b.state === 'disabled' ? 'enable' : 'install')}
          title={blocked ? 'Find the game first' : undefined}>
          {busy === 'install' || busy === 'enable' ? 'Working…' : b.state === 'disabled' ? 'Turn on' : b.state === 'missing' ? 'Install' : 'Repair'}</button>}
        {full && b?.state === 'installed' && <button type="button" className="lo-text-btn" disabled={Boolean(busy)}
          onClick={() => (b.sigeon_on ? setConfirmOff('disable') : act('disable'))}>Turn off</button>}
        {full && (b?.state === 'installed' || b?.state === 'disabled') && <button type="button" className="lo-text-btn" disabled={Boolean(busy)}
          onClick={() => (b.sigeon_on ? setConfirmOff('remove') : act('remove'))}>Remove</button>}
      </>}>
      <p>Lets the game load mods that replace its files. Every mod needs it, and it comes with repakxtra.</p>
      {state && <p className="fr-state">{state}</p>}
    </Step>
  )
}

let lastCheck: Galacta | null = null // the newest online Galacta check this run: Setup opens knowing it
const remember = (g: Galacta) => { if (g.latest) { lastCheck = g; noteGalactaCheck(g) } return g }
/** The offline status with the last online check's release info, while Galacta is still where that check found it. */
const withLastCheck = (g: Galacta): Galacta => lastCheck && !g.latest && lastCheck.installed === g.installed
  ? { ...g, latest: lastCheck.latest, published: lastCheck.published, notes: lastCheck.notes, url: lastCheck.url, up_to_date: lastCheck.up_to_date }
  : g

/** The Project Galacta step. Both screens: what it does in its current state and Install (Update when one is out).
 *  Setup (`full`) adds where it is and the newest release with What's new and Check for updates, and which folder an
 *  install or update goes into. */
export function GalactaStep({ alert, n, full, blocked }: { alert: Alert; n?: number; full?: boolean; blocked?: boolean }) {
  const [g, setG] = useState<Galacta | null>(lastCheck)
  const [notes, setNotes] = useState<string | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [folder, setFolder] = useState(savedItem(FOLDER_KEY) || HERE)
  const { busy, run } = useRun(alert)
  useEffect(() => {
    invoke<Galacta>('setup_galacta_status', { online: false }).then(s => setG(withLastCheck(s))).catch(() => {})
    if (full) invoke<{ id: string; depth: number }[]>('get_folders')   // subfolders by their path below ~mods ("A/B")
      .then(fs => setFolders((fs ?? []).filter(f => f.depth > 0).map(f => f.id))).catch(() => {})
  }, [])
  const check = () => run('check', async () => {
    const s = remember(await invoke<Galacta>('setup_galacta_status', { online: true }))
    setG(s)
    if (s.up_to_date === true) alert.success('Project Galacta', `Up to date (${s.latest}).`)
  })
  const install = () => run('install', async () => {
    const was = Boolean(g?.installed)
    const s = remember(await invoke<Galacta>('setup_galacta_install', { folder: full && folder !== HERE ? folder : null }))
    setG(s)
    if (full) setNotes(was ? `Updated to ${s.latest}` : `Installed ${s.latest}`)   // what changed, right away
  })
  const on = Boolean(g?.installed && !g.disabled)
  const offered = Boolean(g && (!g.installed || g.up_to_date === false))
  const where = g?.installed?.replace(/^.*[\\/]~mods/i, '~mods') ?? ''
  const state = !g ? 'Checking…'
    : !g.installed ? null
    : g.up_to_date === false ? `Installed. ${g.latest} is out.`
    : g.disabled ? 'Installed but switched off. Turn it on in the Library.'
    : 'Installed.'
  const details = full && (
        <div className="su-details">
          <Detail label="Location">{!g ? 'Checking…' : g.installed ? <><code>{where}</code>{g.disabled ? ', off in the Library' : ''}</> : 'Not installed'}</Detail>
          <Detail label="Newest release"
            links={<>
              {g?.latest && <button type="button" className="su-link" onClick={() => setNotes("What's new")}>What's new</button>}
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={check} title="Ask GitHub for the newest Project Galacta">
                {busy === 'check' ? 'Checking…' : 'Check for updates'}</button>
            </>}>
            {g?.latest ? `${g.latest}${g.published ? `, ${date(g.published)}` : ''}` : 'Not checked yet'}
          </Detail>
          {offered && (
            <Detail label="Install into">
              <CustomDropdown value={folder} onChange={v => { setFolder(v); localStorage.setItem(FOLDER_KEY, v) }}
                options={[{ value: HERE, label: g?.installed ? 'Where it is now' : 'Mods folder' }, ...folders.map(f => ({ value: f, label: `~mods/${f}` }))]} />
            </Detail>
          )}
        </div>
  )
  return (
    <Step more={details} n={n} className="is-req" done={on && g?.up_to_date !== false} title="Project Galacta"
      action={offered && (
        <button type="button" className="btn-primary" disabled={blocked || Boolean(busy)} onClick={install}
          title={blocked ? 'Find the game first' : 'Downloads the newest release from GitHub'}>
          {busy === 'install' ? 'Installing…' : g?.installed ? `Update${g.latest ? ` to ${g.latest}` : ''}` : 'Install'}</button>)}>
      <p>Needed by most skin mods: loads more types of mods and lets you toggle mods in game. By <a onClick={() => open(GALACTA)}>0xSaturno</a>.</p>
      {state && <p className="fr-state">{state}</p>}
      {notes && g && <Changelog g={g} title={notes} onClose={() => setNotes(null)} />}
    </Step>
  )
}

/** The mod previews step (xtra_kit.rs, shared logic in previewKit.tsx). Both screens: what previews are in their current
 *  state, "Is Blender safe?" while Blender is missing, the download and install progress, and Set up previews. Setup
 *  (`full`) adds the two parts, the kit and Blender, one row each with their state and links, and Check this PC. */
export function PreviewsStep({ alert, n, full }: { alert: Alert; n?: number; full?: boolean }) {
  const k = usePreviewKit(alert)
  const { kit, latest, busy, update } = k
  const [notes, setNotes] = useState<string | null>(null)
  const [armed, setArmed] = useState(false) // Remove asks for a second click
  useEffect(() => { k.peek() }, [])   // the newest kit and its notes, so Set up says what it gets
  const fromFile = async () => {
    const f = await pickFile({ title: 'The preview kit zip', filters: [{ name: 'Preview kit', extensions: ['zip'] }] }).catch(() => null)
    if (typeof f === 'string') k.install(f)
  }
  const pickBlender = async () => {
    const f = await pickFile({ title: 'blender.exe', filters: [{ name: 'Blender', extensions: ['exe'] }] }).catch(() => null)
    if (typeof f === 'string') k.pickBlender(f)
  }
  const ready = Boolean(kit?.version && kit?.blender)
  const from = kit?.source === 'github' ? 'Downloaded from GitHub' : kit?.source === 'file' ? 'Loaded from a file' : null
  const size = latest?.size ? Math.round(latest.size / 1048576) : null
  const blenderName = kit?.blender?.replace(/^.*[\\/](Blender[^\\/]*)[\\/]blender\.exe$/i, '$1')
  const installingBlender = busy === 'blender' || k.progress?.stage === 'blender'
  const working = k.progress?.stage === 'unpack' || k.progress?.stage === 'blender'
  const state = !kit ? 'Checking…'
    : ready ? (update ? `Ready. Kit v${latest!.version} is out.` : 'Ready. A loadout page renders its preview.')
    : null
  const details = full && (
        <div className="su-details">
          <Detail label="Preview kit"
            links={<>
              {latest && <button type="button" className="su-link" onClick={() => setNotes("What's new")}>What's new</button>}
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => k.check()} title="Ask GitHub for the newest preview kit">
                {busy === 'check' ? 'Checking…' : 'Check for updates'}</button>
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={fromFile} title="Install a preview kit zip (or drop one on the window)">Install from file…</button>
              {kit?.version && <button type="button" className="su-link" disabled={Boolean(busy)} onBlur={() => setArmed(false)}
                onClick={() => { if (armed) { setArmed(false); k.remove() } else setArmed(true) }}
                title="Deletes the kit; it downloads again from here">{armed ? 'Click again to remove' : 'Remove'}</button>}
            </>}>
            {k.progress?.stage === 'unpack' ? <InstallStatus p={k.progress} /> : <>
              {!kit ? 'Checking…' : kit.version ? [`v${kit.version}`, from].filter(Boolean).join(', ') : `Not installed${size ? `, ${size} MB on GitHub` : ''}`}
              {/* After Check for updates: what GitHub has, here rather than in a toast (Minimal toasts would hide that) */}
              {k.checked && busy !== 'check' && (latest === null ? ', none on GitHub yet' : kit?.version && latest && !update ? ', up to date' : update ? `, v${latest!.version} is out` : null)}
            </>}
          </Detail>
          <Detail label="Blender"
            links={<>
              {kit && !kit.blender && <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => k.installBlender()} title="Installs Blender with winget">Install</button>}
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={pickBlender} title="Choose the blender.exe previews use">{kit?.blender ? 'Change…' : 'Choose blender.exe…'}</button>
            </>}>
            {k.progress?.stage === 'blender' ? <InstallStatus p={k.progress} /> : kit?.blender ? blenderName : 'Not installed'}
          </Detail>
          <Detail label="This PC"
            links={<button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => k.checkPc()} title="Check that this PC can make previews">
              {busy === 'doctor' ? 'Checking…' : 'Check'}</button>}>
            {k.doctor ? (k.doctor.ok ? 'Can make previews' : 'Something is missing') : 'Not checked yet'}
          </Detail>
        </div>
  )
  return (
    <Step more={<><BlenderTrust />{details}</>} n={n} done={ready && !update && k.doctor?.ok !== false} optional title="Mod previews" className="su-previews"
      action={!full && working ? <InstallStatus p={k.progress} />
        : (!ready || update) && kit && <button type="button" className="lo-text-btn" disabled={Boolean(busy) || (!kit.version && latest === null)} onClick={() => k.setUp()}
          title={latest === null ? 'No kit published yet: drop a kit zip on the window' : update ? 'Downloads the newest kit from GitHub' : 'Downloads the preview kit and installs Blender if it is missing (Windows asks for admin rights once)'}>
          {busy === 'setup' ? (installingBlender ? 'Installing Blender…' : k.progress ? 'Installing kit…' : 'Setting up…') : busy === 'blender' ? 'Installing Blender…' : update ? `Update to v${latest!.version}` : 'Set up previews'}</button>}>
      <p>Renders of your mods and loadouts, and clips of animation mods, made on this PC with the preview kit{size ? ` (a ${size} MB download)` : ''} and
        Blender (installed for you if missing).</p>
      {state && <p className="fr-state">{state}</p>}
      <KitProgressBar p={k.progress} />
      <DoctorProblems d={k.doctor} />
      {notes && latest && <Changelog product="Preview kit" g={{ latest: `v${latest.version}`, published: latest.published, notes: latest.notes, url: latest.url }}
        title={notes} onClose={() => setNotes(null)} />}
    </Step>
  )
}

export function SetupPanel({ alert, onClose, focus }: { alert: Alert; onClose: () => void; focus?: string | null }) {
  const [auto, setAuto] = useState(autoCheck())
  const trap = useDialogFocus() // focus inside, Tab stays inside, back to the opener on close

  // Opened from a grayed-out Generate button: straight to the Mod previews step (its top, so it can still grow as it loads)
  useEffect(() => { if (focus === 'previews') document.querySelector('.su-previews')?.scrollIntoView({ block: 'start' }) }, [focus])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.su-changelog-overlay')) return   // a changelog closes first, itself
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  })

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div ref={trap.ref} onKeyDown={trap.onKeyDown} tabIndex={-1} className="modal-content su-modal" role="dialog" aria-modal="true" aria-label="Mod setup" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <h2>Mod setup</h2>
          <button type="button" className="lo-text-btn su-guided" onClick={() => { onClose(); window.dispatchEvent(new Event('repakxtra-first-run')) }}
            title="The first-launch setup: game folder, bypass, Project Galacta, previews and your first mods, one screen">Guided setup</button>
          <CopySetupReport alert={alert} className="lo-text-btn su-report" />
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          {/* its own line under the title row, so the header buttons never squeeze it */}
          <p className="su-sub">What Marvel Rivals needs to load mods. Close the game before changing anything here.</p>
        </div>

        {/* The welcome screen's rows, with Setup's extra detail in each */}
        <ol className="modal-body fr-steps">
          <BypassStep alert={alert} full />
          <GalactaStep alert={alert} full />
          <PreviewsStep alert={alert} full />
        </ol>
        {/* One switch for both startup checks (SetupButton: Project Galacta and the preview kit), so it lives under all the steps */}
        <div className="su-modal-foot">
          <Checkbox checked={auto} onChange={(v: boolean) => { setAuto(v); localStorage.setItem(AUTO_KEY, v ? '1' : '0') }}>
            Check for Project Galacta and preview kit updates when repakxtra starts
          </Checkbox>
        </div>
      </motion.div>
    </div>
  )
}

let startupChecked = false

/** Header button. Shows a dot when the bypass is missing or Galacta has an update, and checks once at start. */
export default function SetupButton({ alert }: { alert: Alert }) {
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const [attention, setAttention] = useState(false)
  useEffect(() => { // openPreviewSetup (previews.tsx): a Generate button on a PC without the preview kit
    const show = (e: Event) => { setFocus((e as CustomEvent<string>).detail ?? null); setOpen(true) }
    window.addEventListener('repakxtra-open-setup', show)
    return () => window.removeEventListener('repakxtra-open-setup', show)
  }, [])

  const recheck = () => invoke<Bypass>('setup_bypass_status').then(b => setAttention(b.state !== 'installed')).catch(() => {})
  useEffect(() => {   // the Sigeon setup installs the bypass too
    window.addEventListener('bypass-changed', recheck)
    return () => window.removeEventListener('bypass-changed', recheck)
  }, [])
  useEffect(() => {
    invoke<Bypass>('setup_bypass_status').then(b => b.state !== 'installed' && setAttention(true)).catch(() => {})
    if (!autoCheck() || startupChecked) return
    startupChecked = true   // once per app start, even when React mounts this twice
    invoke<Galacta>('setup_galacta_status', { online: true }).then(g => {
      remember(g)
      if (!g.installed || g.up_to_date !== false) return
      setAttention(true)
      const id = alert.info('Project Galacta update', `${g.latest} is out.`, {
        duration: 12000,
        action: { label: 'Update', onClick: () => { alert.dismissAlert(id); setOpen(true) } },
      })
    }).catch(() => {})   // offline: no update check, no noise
    // An installed preview kit with a newer release: the same kind of toast, opening Setup at its card
    Promise.all([invoke<{ version: string | null }>('preview_kit_status'), invoke<{ version: string } | null>('preview_kit_latest')]).then(([k, r]) => {
      if (!k.version || !r || !isNewerKit(r.version, k.version)) return
      setAttention(true)
      const id = alert.info('Preview kit update', `Kit v${r.version} is out (you have v${k.version}).`, {
        duration: 12000,
        action: { label: 'Update', onClick: () => { alert.dismissAlert(id); setOpen(true) } },
      })
    }).catch(() => {})
  }, [])

  return (
    <>
      <button type="button" className="btn-settings su-btn" data-tour="setup-btn" onClick={() => setOpen(true)} title="What the game needs to load mods">
        <Wrench size={16} /> Setup {attention && <i className="su-dot" aria-label="Needs attention" />}
      </button>
      {open && <SetupPanel alert={alert} focus={focus} onClose={() => { setOpen(false); setFocus(null); recheck() }} />}
    </>
  )
}
