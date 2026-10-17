// repakxtra: Setup, what the game needs to load mods (backend: xtra_setup.rs). The UTOC signature bypass ships inside
// repakxtra; Project Galacta comes from its GitHub releases, with an update check and the release notes.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { Check, ChevronRight, Copy, ExternalLink, MonitorCheck, ShieldCheck, Wrench } from 'lucide-react'
import { open as pickFile } from '@tauri-apps/plugin-dialog'
import { type Doctor, type KitProgress, isNewerKit, progressShare, progressText, usePreviewKit } from './previewKit'
import Checkbox from '../components/ui/Checkbox'
import CustomDropdown from '../components/CustomDropdown'
import type { useAlert } from '../components/AlertHandler'
import { savedItem } from './storageCarryOver'
import { MatrixLoader } from './motion'
import CopySetupReport from './CopySetupReport'
import { noteGalactaCheck } from './setupReport'

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
const BYPASS_LABEL: Record<Bypass['state'], string> = {
  installed: 'Installed', disabled: 'Off', partial: 'Incomplete', other: 'Different version', missing: 'Not installed',
}
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

/** Why Blender is safe to install, where it comes from, and its real download page. */
export function BlenderTrust() {
  return (
    <p className="su-trust">
      <ShieldCheck size={13} aria-hidden="true" />
      <span>Blender is free, open-source 3D software from the Blender Foundation. repakxtra installs the official release
        through winget, Windows' own package manager, and Windows asks for admin rights once. <a href={BLENDER} onClick={e => { e.preventDefault(); open(BLENDER) }}>blender.org/download</a></span>
    </p>
  )
}

/** What the generator's check says is missing on this PC, one sentence each. */
export function DoctorProblems({ d }: { d: Doctor | null }) {
  if (!d || d.ok || !d.problems.length) return null
  return <ul className="su-problems">{d.problems.map(x => <li key={x}>{x}</li>)}</ul>
}

/** A part's state beside its name: a green check when it is there, an empty ring when not. */
const PartMark = ({ ok }: { ok: boolean }) => (
  <span className={`su-part-mark${ok ? ' is-ok' : ''}`} role="img" aria-label={ok ? 'Installed' : 'Not installed'}>{ok && <Check size={14} strokeWidth={2.5} />}</span>
)

/** The preview kit: what this PC needs to render mod previews (xtra_kit.rs, shared logic in previewKit.tsx). Its two
 *  parts, the kit and Blender, are one row each with their state and links; one main button sets up what is missing. */
function PreviewKitCard({ alert }: { alert: Alert }) {
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
  const chip = !kit ? 'Checking…' : ready ? (update ? 'Update available' : 'Ready') : 'Not set up'
  const missing = kit && !ready
  const kitOk = Boolean(kit?.version)
  const from = kit?.source === 'github' ? 'Downloaded from GitHub' : kit?.source === 'file' ? 'Loaded from a file' : null
  const size = latest?.size ? Math.round(latest.size / 1048576) : null
  const blenderName = kit?.blender?.replace(/^.*[\\/](Blender[^\\/]*)[\\/]blender\.exe$/i, '$1')
  const installingBlender = busy === 'blender' || k.progress?.stage === 'blender'
  return (
    <section className="su-card su-previews">
      <div className="su-card-head">
        <div>
          <h3>Mod previews</h3>
          <p>Renders of each mod and loadout, made on this PC. Needs two free parts: the preview kit and Blender.</p>
        </div>
        <span className={`su-chip ${update ? 'is-update' : ready ? 'is-installed' : 'is-missing'}`}>{chip}</span>
      </div>
      <ul className="su-parts">
        <li className="su-part">
          <PartMark ok={kitOk} />
          <div className="su-part-text">
            <b>Preview kit</b>
            {k.progress?.stage === 'unpack' ? <InstallStatus p={k.progress} /> : <span>
              {!kit ? 'Checking…' : kit.version ? [`v${kit.version}`, from].filter(Boolean).join(' · ') : `Not installed${size ? ` · ${size} MB on GitHub` : ''}`}
              {latest && <> · <button type="button" className="su-link" onClick={() => setNotes("What's new")}>{update ? `v${latest.version} on GitHub` : `What's new in v${latest.version}`}</button></>}
              {/* After Check for updates: what GitHub has, here rather than in a toast (Minimal toasts would hide that) */}
              {k.checked && busy !== 'check' && (latest === null ? ' · No kit on GitHub yet' : kit?.version && latest && !update ? <> · <span className="su-ok">Up to date</span></> : null)}
            </span>}
          </div>
          <span className="su-part-links">
            <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => k.check()} title="Ask GitHub for the newest preview kit">
              {busy === 'check' ? 'Checking…' : 'Check for updates'}
            </button>
            <button type="button" className="su-link" disabled={Boolean(busy)} onClick={fromFile} title="Install a preview kit zip (or drop one on the window)">From file…</button>
            {kit?.version && <button type="button" className="su-link" disabled={Boolean(busy)} onBlur={() => setArmed(false)}
              onClick={() => { if (armed) { setArmed(false); k.remove() } else setArmed(true) }}
              title="Deletes the kit; it downloads again from here">{armed ? 'Click again to remove' : 'Remove'}</button>}
          </span>
        </li>
        <li className="su-part">
          <PartMark ok={Boolean(kit?.blender)} />
          <div className="su-part-text">
            <b>Blender</b>
            {k.progress?.stage === 'blender' ? <InstallStatus p={k.progress} /> : <span>{kit?.blender ? blenderName : 'Not installed'}</span>}
          </div>
          <span className="su-part-links">
            {kit && !kit.blender && <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => k.installBlender()} title="Installs Blender with winget">Install</button>}
            <button type="button" className="su-link" disabled={Boolean(busy)} onClick={pickBlender}>{kit?.blender ? 'Change' : 'Pick blender.exe'}</button>
          </span>
        </li>
      </ul>
      {(kit && !kit.blender || installingBlender) && <BlenderTrust />}
      <KitProgressBar p={k.progress} />
      <DoctorProblems d={k.doctor} />
      <div className="su-row">
        <p className="su-meta">{k.doctor?.ok && !busy && <span className="su-ok">This PC can make previews</span>}</p>
        <div className="su-actions">
          {(missing || update) && (
            <button type="button" className="btn-primary su-main" disabled={Boolean(busy) || (!kit?.version && latest === null)} onClick={() => k.setUp()}
              title={update ? 'Downloads the newest kit from GitHub' : 'Installs what is missing: the kit (from GitHub) and Blender (with winget), then checks this PC'}>
              {busy === 'setup' ? (installingBlender ? 'Installing Blender…' : k.progress ? 'Installing kit…' : 'Setting up…') : busy === 'blender' ? 'Installing Blender…' : update ? `Update to v${latest!.version}` : 'Set up previews'}
            </button>
          )}
          <button type="button" className="lo-text-btn" disabled={Boolean(busy)} onClick={() => k.checkPc()} title="Check that this PC can make previews">
            <MonitorCheck size={14} /> {busy === 'doctor' ? 'Checking…' : 'Check this PC'}
          </button>
        </div>
      </div>
      {notes && latest && <Changelog product="Preview kit" g={{ latest: `v${latest.version}`, published: latest.published, notes: latest.notes, url: latest.url }}
        title={notes} onClose={() => setNotes(null)} />}
    </section>
  )
}

let lastCheck: Galacta | null = null // the newest online Galacta check this run: Setup opens knowing it
const remember = (g: Galacta) => { if (g.latest) { lastCheck = g; noteGalactaCheck(g) } return g }
/** The offline status with the last online check's release info, while Galacta is still where that check found it. */
const withLastCheck = (g: Galacta): Galacta => lastCheck && !g.latest && lastCheck.installed === g.installed
  ? { ...g, latest: lastCheck.latest, published: lastCheck.published, notes: lastCheck.notes, url: lastCheck.url, up_to_date: lastCheck.up_to_date }
  : g

export function SetupPanel({ alert, onClose, focus }: { alert: Alert; onClose: () => void; focus?: string | null }) {
  const [bypass, setBypass] = useState<Bypass | null>(null)
  const [galacta, setGalacta] = useState<Galacta | null>(lastCheck)
  const [folders, setFolders] = useState<string[]>([])
  const [folder, setFolder] = useState(savedItem(FOLDER_KEY) || HERE)
  const [auto, setAuto] = useState(autoCheck())
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState<'disable' | 'remove' | null>(null)
  const [safety, setSafety] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)

  // Opened from a grayed-out Generate button: straight to the Mod previews card (its top, so it can still grow as it loads)
  useEffect(() => { if (focus === 'previews') document.querySelector('.su-previews')?.scrollIntoView({ block: 'start' }) }, [focus])
  useEffect(() => {
    invoke<Bypass>('setup_bypass_status').then(setBypass).catch(e => alert.warning('Setup', String(e)))
    invoke<Galacta>('setup_galacta_status', { online: false }).then(g => setGalacta(withLastCheck(g))).catch(() => {})
    invoke<{ id: string; depth: number }[]>('get_folders')   // subfolders by their path below ~mods ("A/B")
      .then(fs => setFolders((fs ?? []).filter(f => f.depth > 0).map(f => f.id))).catch(() => {})
  }, [])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (notes) setNotes(null); else onClose()   // the changelog first, then the panel
    }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  })

  const run = async <T,>(what: string, f: () => Promise<T>) => {
    setBusy(what)
    try { return await f() } catch (e) { alert.warning('Setup', String(e)) } finally { setBusy(null) }
  }
  const act = (action: 'install' | 'enable' | 'disable' | 'remove') => run(action, async () => {
    setConfirmOff(null)
    const s = await invoke<Bypass>('setup_bypass', { action })
    setBypass(s)
    alert.success('Signature bypass', { install: 'Installed. Mods load from the next game launch.', enable: 'On again.',
      disable: 'Off. Mods that need it will not load.', remove: 'Removed.' }[action])
  })
  const check = () => run('check', async () => {
    const g = remember(await invoke<Galacta>('setup_galacta_status', { online: true }))
    setGalacta(g)
    if (g.up_to_date === true) alert.success('Project Galacta', `Up to date (${g.latest}).`)
  })
  const install = () => run('install-galacta', async () => {
    const wasInstalled = Boolean(galacta?.installed)
    const g = remember(await invoke<Galacta>('setup_galacta_install', { folder: folder === HERE ? null : folder }))
    setGalacta(g)
    setNotes(wasInstalled ? `Updated to ${g.latest}` : `Installed ${g.latest}`)   // what changed, right away
  })

  const b = bypass
  const g = galacta
  const offWarning = b?.sigeon_on && confirmOff
  const galactaState = !g?.installed ? 'Not installed' : g.up_to_date === false ? 'Update available' : g.up_to_date ? 'Up to date' : g.disabled ? 'Installed, off' : 'Installed'
  const where = g?.installed?.replace(/^.*[\\/]~mods/i, '~mods') ?? ''

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div className="modal-content su-modal" role="dialog" aria-modal="true" aria-label="Mod setup" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div><h2>Mod setup</h2><p className="su-sub">What Marvel Rivals needs to load mods. Close the game before changing these.</p></div>
          <button type="button" className="lo-text-btn su-guided" onClick={() => { onClose(); window.dispatchEvent(new Event('repakxtra-first-run')) }}
            title="The first-launch setup: game folder, bypass, Project Galacta, previews and your first mods, one screen">Guided setup</button>
          <CopySetupReport alert={alert} className="lo-text-btn su-report" />
          <button className="modal-close" onClick={onClose} aria-label="Close" autoFocus>×</button>
        </div>

        <div className="modal-body su-body">
          <section className="su-card">
            <div className="su-card-head">
              <div>
                <h3>Signature bypass</h3>
                <p>Lets the game load mods that replace its files. Every mod needs it. Comes with repakxtra.</p>
              </div>
              <span className={`su-chip is-${b?.state ?? 'missing'}`}>{b ? BYPASS_LABEL[b.state] : 'Checking…'}</span>
            </div>
            {b?.state === 'other' && <p className="su-note">A different loader or bypass is installed. Installing keeps it next to the new one as a .repakxtra-backup file.</p>}
            {offWarning && (
              <div className="su-confirm" role="alert">
                <span>Sigeon loads through the same loader, so it turns off too.</span>
                <button type="button" className="lo-text-btn" onClick={() => setConfirmOff(null)}>Cancel</button>
                <button type="button" className="lo-text-btn" onClick={() => act(confirmOff!)}>{confirmOff === 'remove' ? 'Remove anyway' : 'Turn off anyway'}</button>
              </div>
            )}
            <div className="su-actions">
              {b?.state !== 'installed' && b?.state !== 'disabled' && (
                <button type="button" className="btn-primary su-main" disabled={!b || Boolean(busy)} onClick={() => act('install')}>
                  {busy === 'install' ? 'Installing…' : b?.state === 'missing' ? 'Install' : 'Repair'}
                </button>
              )}
              {b?.state === 'installed' && <button type="button" className="lo-text-btn" disabled={Boolean(busy)}
                onClick={() => (b.sigeon_on ? setConfirmOff('disable') : act('disable'))}>Turn off</button>}
              {b?.state === 'disabled' && <button type="button" className="btn-primary su-main" disabled={Boolean(busy)} onClick={() => act('enable')}>Turn on</button>}
              {(b?.state === 'installed' || b?.state === 'disabled') && <button type="button" className="lo-text-btn" disabled={Boolean(busy)}
                onClick={() => (b.sigeon_on ? setConfirmOff('remove') : act('remove'))}>Remove</button>}
              <button type="button" className="lo-text-btn su-safety-btn" aria-expanded={safety} onClick={() => setSafety(v => !v)}>
                <ShieldCheck size={14} /> Is it safe? <ChevronRight size={14} className="su-caret" />
              </button>
            </div>
            <div className="t-acc-panel" data-open={safety} ref={el => el?.toggleAttribute('inert', !safety)}>
              <div className="t-acc-panel-inner">
                <div className="su-safety">
                  <ul className="su-facts">
                    <li><b>Scanned clean.</b> VirusTotal: 0 of 63 engines flagged the release archive (Oct 14, 2026). <a onClick={() => open(VIRUSTOTAL)}>See the report</a></li>
                    <li><b>The loader is open source.</b> dsound.dll is ThirteenAG's Ultimate ASI Loader 7.7.0 (MIT), byte for byte the official release. <a onClick={() => open(LOADER)}>See it on GitHub</a></li>
                    <li><b>The bypass only patches the game in memory.</b> MarvelRivalsUTOCSignatureBypass.asi uses Windows memory and thread functions only: no internet, file, registry or program-launch calls. It is closed source and unsigned.</li>
                    <li><b>Same files as the original.</b> Unchanged from the Nexus Mods release. <a onClick={() => open(NEXUS)}>Open the mod page</a></li>
                  </ul>
                  <table className="su-files">
                    <thead><tr><th>File</th><th>Goes to</th><th>Size</th><th>SHA-256</th><th>On this PC</th></tr></thead>
                    <tbody>{b?.files.map(f => (
                      <tr key={f.name}>
                        <td><code>{f.name}</code></td><td>{f.place}</td><td>{(f.size / 1024).toFixed(0)} KB</td>
                        <td><button type="button" className="su-hash" title="Copy" onClick={() => { navigator.clipboard.writeText(f.sha256); alert.success('Copied', f.name) }}>
                          <code>{f.sha256.slice(0, 12)}…</code><Copy size={12} /></button></td>
                        <td>{f.found === 'same' ? 'Matches' : f.found === 'other' ? 'Different file' : 'Not there'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                  <details className="su-license"><summary>Loader license (MIT)</summary><pre>{b?.license}</pre></details>
                </div>
              </div>
            </div>
          </section>

          <section className="su-card">
            <div className="su-card-head">
              <div>
                <h3>Project Galacta</h3>
                <p>Loads more types of mods and lets you toggle mods in game. By <a onClick={() => open(GALACTA)}>0xSaturno</a>.</p>
              </div>
              <span className={`su-chip ${g?.up_to_date === false ? 'is-update' : g?.installed ? 'is-installed' : 'is-missing'}`}>{g ? galactaState : 'Checking…'}</span>
            </div>
            <div className="su-row">
            {/* Where it is and what the newest release is, one labelled line each */}
            <dl className="su-dl">
              <dt>Location</dt>
              <dd>{!g ? 'Checking…' : g.installed ? <><code>{where}</code>{g.disabled ? ', off in the Library' : ''}</> : 'Not installed'}</dd>
              <dt>Latest</dt>
              <dd>
                {g?.latest
                  ? <>{g.latest}{g.published ? `, ${date(g.published)}` : ''} · <button type="button" className="su-link" onClick={() => setNotes("What's new")}>What's new</button></>
                  : 'Not checked yet'}
                {/* the same words and look as the preview kit's update check */}
                {' · '}<button type="button" className="su-link" disabled={Boolean(busy)} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check for updates'}</button>
              </dd>
            </dl>
            <div className="su-actions">
              {(!g?.installed || g.up_to_date === false) && (
                <button type="button" className="btn-primary su-main" disabled={Boolean(busy)} onClick={install}>
                  {busy === 'install-galacta' ? 'Installing…' : g?.installed ? `Update${g.latest ? ` to ${g.latest}` : ''}` : 'Install'}
                </button>
              )}
            </div>
            </div>
            <div className="su-options">
              {/* where to install only matters when an install or update is offered */}
              {(!g?.installed || g.up_to_date === false) && (
                <div className="su-option">
                  <span>Install into</span>
                  <CustomDropdown value={folder} onChange={v => { setFolder(v); localStorage.setItem(FOLDER_KEY, v) }}
                    options={[{ value: HERE, label: g?.installed ? 'Where it is now' : 'Mods folder' }, ...folders.map(f => ({ value: f, label: `~mods/${f}` }))]} />
                </div>
              )}
              <Checkbox checked={auto} onChange={(v: boolean) => { setAuto(v); localStorage.setItem(AUTO_KEY, v ? '1' : '0') }}>
                Check for updates at startup
              </Checkbox>
            </div>
          </section>

          <PreviewKitCard alert={alert} />
        </div>
        {notes && g && <Changelog g={g} title={notes} onClose={() => setNotes(null)} />}
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
