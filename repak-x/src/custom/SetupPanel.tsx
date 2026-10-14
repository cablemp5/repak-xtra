// caleb fork: Setup, what the game needs to load mods (backend: caleb_setup.rs). The UTOC signature bypass ships inside
// repakxtra; Project Galacta comes from its GitHub releases, with an update check and the release notes.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { ChevronRight, Copy, ExternalLink, RefreshCw, ShieldCheck, Wrench } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import CustomDropdown from '../components/CustomDropdown'
import type { useAlert } from '../components/AlertHandler'

type Alert = ReturnType<typeof useAlert>
type FileCheck = { name: string; place: string; size: number; sha256: string; found: 'missing' | 'same' | 'other' }
type Bypass = { state: 'installed' | 'disabled' | 'partial' | 'other' | 'missing'; files: FileCheck[]; license: string; sigeon_on: boolean }
type Galacta = { installed: string | null; disabled: boolean; latest: string | null; published: string | null; notes: string | null; url: string | null; up_to_date: boolean | null }

const AUTO_KEY = 'caleb.setup.autoCheck'
const autoCheck = () => localStorage.getItem(AUTO_KEY) !== '0'
const FOLDER_KEY = 'caleb.setup.galactaFolder'
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

function Changelog({ g, title, onClose }: { g: Galacta; title: string; onClose: () => void }) {
  return (
    <div className="modal-overlay su-changelog-overlay" onClick={e => { e.stopPropagation(); onClose() }}>
      <motion.div className="modal-content su-changelog" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div><h2>{title}</h2><p className="su-sub">Project Galacta {g.latest} · {date(g.published)}</p></div>
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

export function SetupPanel({ alert, onClose, start }: { alert: Alert; onClose: () => void; start?: Galacta }) {
  const [bypass, setBypass] = useState<Bypass | null>(null)
  const [galacta, setGalacta] = useState<Galacta | null>(start ?? null)
  const [folders, setFolders] = useState<string[]>([])
  const [folder, setFolder] = useState(localStorage.getItem(FOLDER_KEY) || HERE)
  const [auto, setAuto] = useState(autoCheck())
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmOff, setConfirmOff] = useState<'disable' | 'remove' | null>(null)
  const [safety, setSafety] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)

  useEffect(() => {
    invoke<Bypass>('setup_bypass_status').then(setBypass).catch(e => alert.warning('Setup', String(e)))
    if (!start) invoke<Galacta>('setup_galacta_status', { online: false }).then(setGalacta).catch(() => {})
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
    const g = await invoke<Galacta>('setup_galacta_status', { online: true })
    setGalacta(g)
    if (g.up_to_date === true) alert.success('Project Galacta', `Up to date (${g.latest}).`)
  })
  const install = () => run('install-galacta', async () => {
    const wasInstalled = Boolean(galacta?.installed)
    const g = await invoke<Galacta>('setup_galacta_install', { folder: folder === HERE ? null : folder })
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
      <motion.div className="modal-content su-modal" role="dialog" aria-label="Mod setup" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div><h2>Mod setup</h2><p className="su-sub">What Marvel Rivals needs to load mods. Close the game before changing these.</p></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
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
                <p>The mod loader for Galacta skin mods. From <a onClick={() => open(GALACTA)}>0xSaturno on GitHub</a>.</p>
              </div>
              <span className={`su-chip ${g?.up_to_date === false ? 'is-update' : g?.installed ? 'is-installed' : 'is-missing'}`}>{g ? galactaState : 'Checking…'}</span>
            </div>
            <p className="su-meta">
              {g?.installed ? <>In <code>{where}</code>{g.disabled ? ', switched off in the Library' : ''}</> : 'Not in your mods folder.'}
              {g?.latest && <> · Latest {g.latest}, {date(g.published)} · <a onClick={() => setNotes("What's new")}>What's new</a></>}
            </p>
            <div className="su-actions">
              {(!g?.installed || g.up_to_date === false) && (
                <button type="button" className="btn-primary su-main" disabled={Boolean(busy)} onClick={install}>
                  {busy === 'install-galacta' ? 'Installing…' : g?.installed ? `Update${g.latest ? ` to ${g.latest}` : ''}` : 'Install'}
                </button>
              )}
              <button type="button" className="lo-text-btn" disabled={Boolean(busy)} onClick={check}>
                <RefreshCw size={14} className={busy === 'check' ? 'su-spin' : ''} /> {busy === 'check' ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
            <div className="su-options">
              <div className="su-option">
                <span>Install into</span>
                <CustomDropdown value={folder} onChange={v => { setFolder(v); localStorage.setItem(FOLDER_KEY, v) }}
                  options={[{ value: HERE, label: g?.installed ? 'Where it is now' : 'Mods folder' }, ...folders.map(f => ({ value: f, label: `~mods/${f}` }))]} />
              </div>
              <Checkbox checked={auto} onChange={(v: boolean) => { setAuto(v); localStorage.setItem(AUTO_KEY, v ? '1' : '0') }}>
                Check for updates when repakxtra starts
              </Checkbox>
            </div>
          </section>
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
  const [attention, setAttention] = useState(false)
  const [start, setStart] = useState<Galacta | undefined>()

  useEffect(() => {
    invoke<Bypass>('setup_bypass_status').then(b => b.state !== 'installed' && setAttention(true)).catch(() => {})
    if (!autoCheck() || startupChecked) return
    startupChecked = true   // once per app start, even when React mounts this twice
    invoke<Galacta>('setup_galacta_status', { online: true }).then(g => {
      if (!g.installed || g.up_to_date !== false) return
      setAttention(true)
      const id = alert.info('Project Galacta update', `${g.latest} is out.`, {
        duration: 12000,
        action: { label: 'Update', onClick: () => { alert.dismissAlert(id); setStart(g); setOpen(true) } },
      })
    }).catch(() => {})   // offline: no update check, no noise
  }, [])

  return (
    <>
      <button type="button" className="btn-settings su-btn" onClick={() => { setStart(undefined); setOpen(true) }} title="What the game needs to load mods">
        <Wrench size={16} /> Setup {attention && <i className="su-dot" aria-label="Needs attention" />}
      </button>
      {open && <SetupPanel alert={alert} start={start} onClose={() => {
        setOpen(false)
        invoke<Bypass>('setup_bypass_status').then(b => setAttention(b.state !== 'installed')).catch(() => {})
      }} />}
    </>
  )
}
