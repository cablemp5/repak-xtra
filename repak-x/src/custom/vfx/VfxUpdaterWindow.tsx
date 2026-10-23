// repakxtra: the VFX Updater window (route vfx-updater), in place of the upstream VFX Updater's panel. It works on the mods
// folder's own VFX mods (xtra_vfx_mods): one list, like a loadout's Add mods, with the mods that need an update first and
// already ticked, so after a game update the whole job is one press of Update (pipeline.ts). Each ticked mod shows its step
// and a progress bar while it runs, then a pill that opens its report: what was rebuilt, what was kept and why. The update
// takes the mod's name and the original is renamed <name>_BROKEN and turned off, so loadouts and tags keep working.
// Everything else (naming, turning originals off, USMAP, Color names, Log) is under Advanced, folded unless the USMAP is
// missing. Cancel waits for the step in flight (UAssetTool cannot be interrupted) and says so. The main window hands mods
// over (handoff.ts: they are ticked, and updated at once from the Library's notice).
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { AlertTriangle, Archive, Check, ChevronDown, ChevronRight, Copy, Map as MapIcon, Palette, RefreshCw, RotateCcw, ScrollText, Search, Tag, X } from 'lucide-react'
import TitleBar from '../../components/TitleBar'
import Checkbox from '../../components/ui/Checkbox'
import { Num, SwapText } from '../motion'
import { cue } from '../sounds'
import { DEFAULT_FILTER, parseWords, readFilter, resetFilter, writeFilter, type ColorFilter } from './filter'
import { canonKey } from '../loadoutIdentity'
import { modKey, useLoadouts } from '../loadoutStore'
import { FIXED_EVENT, onHandoff, takeHandoff, utocOf, type Fixed } from './handoff'
import { STEPS, fixVfxMod, type AssetKind, type VfxReport } from './pipeline'
import './vfx.css'

type Status = 'waiting' | 'running' | 'fixed' | 'nothing' | 'failed' | 'cancelled'
type Run = { status: Status; step?: number; sub?: string; report?: VfxReport }
type Mod = { path: string; utoc: string; enabled: boolean; name: string; hero?: string | null; modified?: number }
type Verdict = { path: string; kind: string; reason: string }
type Log = { time: string; text: string; type: string }
type Usmap = { updated: boolean; upToDate: boolean; skipped: boolean; localPath?: string | null; filename?: string | null; version?: string | null; buildNumber?: number | null; commitDate?: string | null; message: string }
type GameBuild = { updated: number; cl?: number | null }

const TURN_OFF = 'repakxtra.vfx.turnOff' // before Originals had three choices: '0' left them on
const KEEP_NAME = 'repakxtra.vfx.keepName' // '0': updates end in _UPDATED
const ORIGINALS = 'repakxtra.vfx.originals' // what happens to an original: off, trash or keep
type Naming = 'broken' | 'updated'
type Originals = 'off' | 'trash' | 'keep'
const NAMING_NOTE: Record<Naming, string> = {
  broken: 'Loadouts and tags stay on the update. The original is renamed to end in _BROKEN.',
  updated: 'The update ends in _UPDATED, and loadouts move to it.',
}
const ORIGINALS_NOTE: Record<Originals, string> = {
  off: 'Kept in the mods folder, turned off, so only the update loads.',
  trash: 'Turned off and moved to Recently deleted. Restore it in Settings within 7 days.',
  keep: 'Left as they are. If one is on, turn it or its update off before playing.',
}
/** A rivals-depot USMAP's release, from its file name (5.3.2-3939753+++depot_marvel+S10.5_release-Marvel.usmap). */
const usmapRelease = (name?: string | null) => name?.match(/\+([^+]+?)-Marvel\.usmap$/i)?.[1]?.replace(/_/g, ' ') ?? null
const ADVANCED = 'repakxtra.vfx.advanced' // Advanced opens the way it was last left, as the install card's
const FOLDED = 'repakxtra.vfx.folded' // the groups folded away, as a list of ids
const SORT = 'repakxtra.vfx.sort' // A to Z or Newest, as a loadout's Add mods
const SEARCH_FROM = 8 // a search field once the list is longer than a glance
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`
/** A folded panel's content: out of reach of Tab and screen readers (the React 18 types this app uses lack inert). */
const folded = (hidden: boolean) => (hidden ? { inert: true } : {}) as object
const usmapCl = (name?: string | null) => Number(name?.match(/-(\d{6,})\+/)?.[1]) || null
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
const isDone = (s?: Status) => s === 'fixed' || s === 'nothing'

const STATUS: Record<Status, string> = { waiting: 'Waiting', running: 'Updating', fixed: 'Updated', nothing: 'Nothing to update', failed: 'Failed', cancelled: 'Cancelled' }
const KIND_ORDER: AssetKind[] = ['failed', 'unreadable', 'added', 'updated', 'same', 'passed']
const KIND_LABEL: Record<AssetKind, string> = { updated: 'Rebuilt', same: 'Match the game', added: 'The mod\'s own', passed: 'Kept as they were', unreadable: 'Could not be read', failed: 'Not updated' }

/** Where the update went, in words: the original's new name, or the update's own when it was named _UPDATED. */
function placedText(r: VfxReport) {
  const p = r.placed
  if (!p) return r.output ? `Saved as ${fileName(r.output)}.` : ''
  const kept = fileName(p.original).replace(/\.[^.]+$/, '')
  const renamed = /_BROKEN((_\d+)?_P)?$/i.test(kept)
  const gone = p.trashed ? `${kept}, in Recently deleted` : `${kept}${p.turnedOff ? ', off' : ''}`
  return (renamed ? `The update has the mod's name. The original is now ${gone}.` : `Saved as ${fileName(p.fixed)}${p.trashed ? ', and the original is in Recently deleted' : p.turnedOff ? ', and the original is off' : ''}.`)
    + (p.replaced ? ' An earlier copy is in Recently deleted.' : '')
}

/** One mod's report as plain text, for Copy report. */
function reportText(r: VfxReport) {
  const lines = [`${r.name}: ${STATUS[r.status as Status] ?? r.status}${r.error ? `. ${r.error}` : ''}`]
  if (r.status === 'fixed') lines.push(`  ${placedText(r)}`)
  lines.push(`  ${r.counts.updated} rebuilt with ${r.counts.changes} edits, ${r.counts.same} match the game, ${r.counts.added} the mod's own, ${r.counts.passed} kept, ${r.counts.unreadable} unreadable, ${(r.ms / 1000).toFixed(1)} s`)
  r.warnings.forEach(w => lines.push(`  ! ${w}`))
  for (const k of KIND_ORDER) for (const a of r.assets.filter(x => x.kind === k)) lines.push(`  [${KIND_LABEL[k]}] ${a.name}: ${a.detail}`)
  return lines.join('\n')
}

function Report({ r, onRetry, busy }: { r: VfxReport; onRetry: () => void; busy: boolean }) {
  const [assets, setAssets] = useState(false)
  const [allWarnings, setAllWarnings] = useState(false)
  const groups = KIND_ORDER.map(k => [k, r.assets.filter(a => a.kind === k)] as const).filter(([, list]) => list.length)
  const warnings = allWarnings ? r.warnings : r.warnings.slice(0, 4)
  return (
    <div className="vf-report">
      {r.status === 'fixed'
        ? <p className="vf-note">Rebuilt {plural(r.counts.updated, 'asset')} with {plural(r.counts.changes, 'edit')}. {placedText(r)}</p>
        : r.error && <p className="vf-note">{r.error}</p>}
      {(r.status === 'failed' || r.status === 'cancelled') && (
        <button type="button" className="row-action" disabled={busy} onClick={onRetry}><RotateCcw size={13} aria-hidden="true" /> Try again</button>
      )}
      {r.warnings.length > 0 && <ul className="vf-warnings" aria-label="Warnings">
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
        {r.warnings.length > 4 && <li className="vf-more"><button type="button" className="su-link" onClick={() => setAllWarnings(v => !v)}>{allWarnings ? 'Show fewer' : `Show all ${r.warnings.length}`}</button></li>}
      </ul>}
      {groups.length > 0 && <>
        <p className="vf-counts">
          {groups.map(([k, list]) => <span key={k} className={`is-${k}`}>{KIND_LABEL[k]} <b>{list.length.toLocaleString()}</b></span>)}
          <span>{(r.ms / 1000).toFixed(1)} s</span>
          <button type="button" className="cf-files-btn vf-assets-toggle" aria-expanded={assets} onClick={() => setAssets(v => !v)}>
            {plural(r.assets.length, 'asset')} <ChevronRight size={12} className="cf-caret" aria-hidden="true" />
          </button>
        </p>
        <div className="t-acc-panel" data-open={assets}>
          <div className="t-acc-panel-inner" {...folded(!assets)}>
            {assets && <div className="vf-assets">{groups.map(([k, list]) => (
              <div key={k} className="vf-group">
                <h4>{KIND_LABEL[k]} <span>{list.length.toLocaleString()}</span></h4>
                <ul>{list.map(a => <li key={a.path}><span className="vf-asset">{a.name}</span><span className="vf-detail">{a.detail}</span></li>)}</ul>
              </div>
            ))}</div>}
          </div>
        </div>
      </>}
    </div>
  )
}

/** A VFX mod: its tick, name, the loadouts holding it and its On badge, and once it ran its step, progress or result. Why it
 *  needs an update is its tooltip. */
function Row({ mod, rowKey, loadouts, run, needs, picked, open, busy, onPick, onToggle, onRetry }: {
  mod: Mod; rowKey: string; loadouts: string[]; run?: Run; needs?: string; picked: boolean; open: boolean; busy: boolean; onPick: (v: boolean) => void; onToggle: () => void; onRetry: () => void
}) {
  const status = run?.status
  const running = status === 'running'
  const step = run?.step ?? 0
  return (
    <li className={`mod-row vf-row${status ? ` is-${status}` : ''}${picked ? ' is-picked' : ''}`} title={needs} data-key={rowKey}>
      <Checkbox size="sm" className="vf-pick" checked={picked} isDisabled={busy} disabled={busy} onChange={onPick} title={mod.path}>
        <span className="vf-row-name">{mod.name}</span>
      </Checkbox>
      {loadouts.length > 0 && (
        <span className="vf-loadouts" title={`In ${loadouts.join(', ')}`}>
          <span>{loadouts[0]}</span>{loadouts.length > 1 && <b>+{loadouts.length - 1}</b>}
        </span>
      )}
      {mod.enabled && <span className="mod-type-badge category-badge on-badge" title="This mod is on now">On</span>}
      {run?.report
        ? <button type="button" className={`vf-pill is-${status}`} aria-expanded={open} onClick={onToggle} title={open ? 'Hide the report' : 'Show the report'}>
            {status === 'fixed' && <Check size={12} strokeWidth={2.5} aria-hidden="true" />}{STATUS[status!]}
            <ChevronDown size={12} className="vf-caret" aria-hidden="true" />
          </button>
        : status && <span className={`vf-status is-${status}`}><SwapText text={running && step ? `Step ${step} of ${STEPS.length}` : STATUS[status]} /></span>}
      {running && step ? (
        <div className="vf-progress">
          <div className="vf-bar" role="progressbar" aria-valuenow={step} aria-valuemin={0} aria-valuemax={STEPS.length} aria-label={`${mod.name} progress`}>
            <i style={{ width: `${((step - 0.5) / STEPS.length) * 100}%` }} />
          </div>
          <p className="vf-step" aria-live="polite"><SwapText text={STEPS[step - 1]} />{run?.sub ? <span>{run.sub}</span> : null}</p>
        </div>
      ) : null}
      {run?.report && <div className="t-acc-panel vf-row-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}><Report r={run.report} onRetry={onRetry} busy={busy} /></div></div>}
    </li>
  )
}

/** A group of mods that folds away to its heading, as a collection does on the Loadouts screen. Its heading holds the
 *  fold, the name and count, and Select all / Clear for the group. */
function Group({ title, count, tone, open, onFold, all, none, busy, onPick, children }: {
  title: string; count: number; tone?: 'needs'; open: boolean; onFold: () => void; all: boolean; none: boolean; busy: boolean; onPick: (on: boolean) => void; children: React.ReactNode
}) {
  return (
    <section className={`vf-grp${tone ? ` is-${tone}` : ''}${open ? '' : ' is-folded'}`}>
      <div className="vf-grp-head">
        <h2 className="vf-grp-title">
          <button type="button" className="vf-grp-fold" aria-expanded={open} onClick={onFold}>
            <ChevronRight size={15} className="vf-grp-caret" aria-hidden="true" />
            <span className="vf-grp-name">{title}</span>
            <span className="vf-grp-count">{count}</span>
          </button>
        </h2>
        <span className="vf-selects">
          <button type="button" className="vf-select" disabled={busy || all} onClick={() => onPick(true)}>Select all</button>
          <button type="button" className="vf-select" disabled={busy || none} onClick={() => onPick(false)}>Clear</button>
        </span>
      </div>
      <div className="t-acc-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}>{children}</div></div>
    </section>
  )
}

/** One part of Advanced, built like a Settings section: an icon and heading (with its state), what it is for in one
 *  line, then its control. */
function Section({ icon, title, state, about, children }: { icon: React.ReactNode; title: string; state?: React.ReactNode; about?: string; children: React.ReactNode }) {
  return (
    <section className="vf-set">
      <h3>{icon}{title}{state ? <span className="vf-set-state">{state}</span> : null}</h3>
      {about && <p className="vf-set-about">{about}</p>}
      {children}
    </section>
  )
}

/** A choice of a few, the width of the section: Settings' Launcher switch. What the picked one does goes under it. */
function Seg<T extends string>({ label, value, options, disabled, onChange, note }: {
  label: string; value: T; options: [T, string][]; disabled: boolean; onChange: (v: T) => void; note: string
}) {
  return (
    <>
      <div className="mod-state-filter vf-seg" role="group" aria-label={label}>
        {options.map(([v, text]) => <button key={v} type="button" aria-pressed={value === v} disabled={disabled} onClick={() => onChange(v)}>{text}</button>)}
      </div>
      <p className="vf-set-note">{note}</p>
    </>
  )
}

function ColorNames() {
  const [f, setF] = useState<ColorFilter>(readFilter)
  const [text, setText] = useState({ includes: f.includes.join(', '), excludes: f.excludes.join(', ') })
  const save = (next: typeof text) => {
    setText(next)
    const filter = { includes: parseWords(next.includes), excludes: parseWords(next.excludes) }
    setF(filter)
    writeFilter(filter)
  }
  const reset = () => { resetFilter(); setF(DEFAULT_FILTER); setText({ includes: DEFAULT_FILTER.includes.join(', '), excludes: DEFAULT_FILTER.excludes.join(', ') }) }
  const custom = JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTER)
  return (
    <Section icon={<Palette size={15} aria-hidden="true" />} title="Color names" state={custom ? 'Custom' : 'Default'}
      about="Which blueprint and data table colors carry over. Material parameters always do.">
      <div className="vf-names">
        <label>Carry names containing<input value={text.includes} onChange={e => save({ ...text, includes: e.target.value })} spellCheck={false} /></label>
        <label>Never carry names containing<input value={text.excludes} onChange={e => save({ ...text, excludes: e.target.value })} spellCheck={false} /></label>
      </div>
      <p className="vf-set-note">Separate words with commas. Case does not matter.{custom && <> <button type="button" className="su-link" onClick={reset}>Reset to defaults</button></>}</p>
    </Section>
  )
}

export function VfxUpdaterPanel() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [needs, setNeeds] = useState<Map<string, string>>(new Map()) // a mod's main file (norm) -> why it needs an update
  const [runs, setRuns] = useState<Record<string, Run>>({}) // by norm(utoc)
  const [picked, setPicked] = useState<Set<string>>(new Set()) // norm(utoc)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'name' | 'newest'>(() => (localStorage.getItem(SORT) === 'newest' ? 'newest' : 'name'))
  const [foldedIds, setFoldedIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(FOLDED) || '[]') } catch { return [] } })
  const loadouts = useLoadouts()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [paks, setPaks] = useState<string | null>(null)
  const [build, setBuild] = useState<GameBuild | null>(null)
  const [usmap, setUsmap] = useState<string | null>(null)
  const [usmapInfo, setUsmapInfo] = useState<Usmap | null>(null)
  const [usmapOk, setUsmapOk] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(true)
  const [naming, setNaming] = useState<Naming>(() => (localStorage.getItem(KEEP_NAME) === '0' ? 'updated' : 'broken'))
  const [originals, setOriginals] = useState<Originals>(() => {
    const v = localStorage.getItem(ORIGINALS)
    return v === 'off' || v === 'trash' || v === 'keep' ? v : localStorage.getItem(TURN_OFF) === '0' ? 'keep' : 'off'
  })
  const keepName = naming === 'broken'
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED) === '1')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [logs, setLogs] = useState<Log[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [batch, setBatch] = useState<string[]>([]) // the run in progress, in order
  const [reload, setReload] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null) // the mods folder could not be read (the last list stays)
  const [checkError, setCheckError] = useState(false) // which mods need an update could not be checked
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null) // the first read, mod by mod
  const [, bump] = useState(0)
  const cancel = useRef(false)
  const seeded = useRef(false) // the mods that need an update are ticked once, when the list first arrives
  const handed = useRef<{ paths: string[]; start: boolean } | null>(null) // mods the main window sent, ticked once the list is in
  const autoRun = useRef<string[] | null>(null) // exactly the mods the Library's notice sent, updated as soon as possible
  const groupOf = useRef(new Map<string, string>()) // each shown mod's group, so a run can unfold where it works
  const runsRef = useRef(runs)
  runsRef.current = runs
  const modsRef = useRef(mods)
  modsRef.current = mods

  const addLog = useCallback((text: string, type = 'info') => setLogs(l => [...l.slice(-999), { time: new Date().toLocaleTimeString(), text, type }]), [])
  const patch = (key: string, p: Partial<Run>) => setRuns(r => ({ ...r, [key]: { ...(r[key] ?? { status: 'waiting' }), ...p } }))
  const pick = (keys: string[], on: boolean) => setPicked(s => { const n = new Set(s); keys.forEach(k => (on ? n.add(k) : n.delete(k))); return n })

  // where the game is, its build, the USMAP (checked against rivals-depot once, quietly)
  useEffect(() => {
    invoke<string | null>('get_game_path').then(dir => {
      if (!dir) return
      const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      setPaks(cut > 0 ? dir.slice(0, cut) : dir)
    }).catch(() => {})
    invoke<GameBuild>('xtra_game_build').then(setBuild).catch(() => {})
    invoke<{ usmapPath?: string | null }>('vfx_get_settings').then(s => { if (s?.usmapPath) setUsmap(s.usmapPath) }).catch(() => {})
    invoke<Usmap>('vfx_check_usmap_update', { force: false })
      .then(r => { setUsmapInfo(r); if (r.localPath && !r.skipped) setUsmap(r.localPath) })
      .catch(e => addLog(`USMAP check failed: ${e}`, 'warning'))
      .finally(() => setChecking(false))
  }, [addLog])

  useEffect(() => {
    if (!usmap) { setUsmapOk(null); return }
    let live = true
    invoke<boolean>('vfx_usmap_exists', { path: usmap }).catch(() => false).then(ok => { if (live) setUsmapOk(ok) })
    return () => { live = false }
  }, [usmap, usmapInfo])

  // the mods folder's VFX mods and which need an update, again after each run (an updated mod no longer does). A folder
  // that cannot be read keeps the last list and says so with Try again, never an empty "no VFX mods"
  useEffect(() => {
    if (busy) return
    let live = true
    setLoadError(null)
    invoke<Mod[]>('xtra_vfx_mods')
      .then(async list => {
        let verdicts: Verdict[] = [], failed = false
        try { verdicts = await invoke<Verdict[]>('xtra_broken_mods', { modPaths: list.map(m => m.path) }) } catch (e) { failed = true; addLog(`Could not check which mods need an update: ${e}`, 'warning') }
        if (!live) return
        const n = new Map(verdicts.filter(v => v.kind === 'vfx').map(v => [norm(v.path), v.reason]))
        setMods(list)
        setNeeds(n)
        setCheckError(failed)
        if (!seeded.current && !failed) {
          seeded.current = true
          pick(list.filter(m => n.has(norm(m.path))).map(m => norm(m.utoc)), true)
        }
      })
      .catch(e => { if (live) { setLoadError(String(e)); setMods(m => m ?? []); addLog(`Could not read the mods folder: ${e}`, 'error') } })
      .finally(() => { if (live) setScan(null) })
    return () => { live = false }
  }, [busy, reload, addLog])
  useEffect(() => {
    const un = listen<{ done: number; total: number }>('vfx_mods_progress', e => setScan(e.payload))
    return () => { un.then(f => f()) }
  }, [])

  // mods handed over by the main window: ticked (once the list is in), and updated at once from the Library's notice
  useEffect(() => {
    const take = (h: { paths: string[]; start: boolean }) => { if (h.paths.length) handed.current = h }
    const h = takeHandoff()
    if (h) take(h)
    return onHandoff(h => { take(h); bump(n => n + 1) }) // a render, so the effect below sees it
  }, [])
  useEffect(() => {
    const h = handed.current
    if (!h || !mods) return
    handed.current = null
    const want = new Set(h.paths.map(p => norm(utocOf(p))))
    const keys = mods.map(m => norm(m.utoc)).filter(k => want.has(k))
    seeded.current = true
    pick(keys, true)
    if (keys.length < want.size) addLog(`${plural(want.size - keys.length, 'mod')} sent here ${want.size - keys.length === 1 ? 'is' : 'are'} not a VFX mod in the mods folder.`, 'warning')
    if (h.start && keys.length) autoRun.current = [...new Set([...(autoRun.current ?? []), ...keys])] // these, not whatever else is ticked
  })

  // Rust steps report inside the step (types read so far)
  useEffect(() => {
    const un = listen<{ message: string }>('vfx_progress', e => {
      const key = Object.keys(runsRef.current).find(k => runsRef.current[k].status === 'running')
      if (key && e.payload?.message) patch(key, { sub: e.payload.message })
    })
    return () => { un.then(f => f()) }
  }, [])

  const usmapCheck = async (force: boolean) => {
    setChecking(true)
    try {
      const r = await invoke<Usmap>('vfx_check_usmap_update', { force })
      setUsmapInfo(r)
      if (r.localPath && !r.skipped) setUsmap(r.localPath)
      addLog(r.message, r.updated || r.upToDate ? 'success' : 'warning')
    } catch (e) { addLog(`USMAP fetch failed: ${e}`, 'warning') } finally { setChecking(false) }
  }

  const browseUsmap = async () => {
    const { open: choose } = await import('@tauri-apps/plugin-dialog')
    const p = await choose({ multiple: false, filters: [{ name: 'USMAP', extensions: ['usmap'] }] })
    if (typeof p !== 'string') return
    setUsmapInfo(null) // its version, date and Up to date described the downloaded file, not this one
    setUsmap(p)
    const current = await invoke<Record<string, unknown>>('vfx_get_settings').catch(() => ({}))
    await invoke('vfx_save_settings', { settings: { ...current, usmapPath: p } }).catch(() => {}) // keeps the auto-update bookkeeping
  }

  const lock = busy ? null : checking ? 'Checking for a newer USMAP…' : !usmap ? 'Choose a USMAP file in Advanced first' : usmapOk === false ? 'The USMAP file is missing' : !paks ? 'Set the game folder in Setup first' : null

  const run = useCallback(async (keys?: string[]) => {
    const byKey = new Map((modsRef.current ?? []).map(m => [norm(m.utoc), m]))
    const todo = (keys ?? [...picked].filter(k => !isDone(runsRef.current[k]?.status))).filter(k => byKey.has(k))
    if (!todo.length || !usmap || !paks) return
    // the run in view: a search that hides a mod clears, and the groups it works in unfold
    const where = new Set(todo.map(k => groupOf.current.get(k)))
    if (where.has(undefined)) setQ('')
    setFoldedIds(f => { const n = f.filter(id => !where.has(id)); if (n.length !== f.length) localStorage.setItem(FOLDED, JSON.stringify(n)); return n })
    setBusy(true); setBatch(todo); cancel.current = false
    todo.forEach(k => patch(k, { status: 'waiting', step: undefined, sub: undefined, report: undefined }))
    const filter = readFilter()
    let fixed = 0, failed = 0
    for (const key of todo) {
      if (cancel.current) { patch(key, { status: 'cancelled' }); continue }
      const mod = byKey.get(key)!
      patch(key, { status: 'running', step: 1 })
      addLog(`Updating ${mod.name}`)
      const r = await fixVfxMod({
        modPath: mod.utoc, usmapPath: usmap, gamePaksPath: paks, turnOffOriginal: originals !== 'keep', trashOriginal: originals === 'trash', keepName, filter,
        log: addLog, cancelled: () => cancel.current,
        onStep: s => patch(key, { step: s.step, sub: undefined }),
        onProgress: (_, __, message) => patch(key, { sub: message }),
      })
      patch(key, { status: r.status, report: r, sub: undefined })
      if (r.status === 'fixed') { fixed++; pick([key], false) }
      if (r.status === 'failed') failed++
      if (r.status !== 'fixed' || todo.length === 1) setOpen(o => new Set(o).add(key)) // problems open, a batch's updates stay folded
      // the main window reloads and moves loadouts from the original to the update (a no-op when the update kept the name)
      if (r.placed) await emitTo('main', FIXED_EVENT, { from: r.placed.original, to: r.placed.fixed, swap: true } satisfies Fixed).catch(() => {})
      // an update named _UPDATED is a new file and its original leaves the list: its result moves with it
      const moved = r.placed ? norm(utocOf(r.placed.fixed)) : key
      if (moved !== key) {
        setRuns(rs => { const { [key]: v, ...rest } = rs; return v ? { ...rest, [moved]: v } : rs })
        setOpen(o => { if (!o.has(key)) return o; const n = new Set(o); n.delete(key); n.add(moved); return n })
        setBatch(b => b.map(x => (x === key ? moved : x)))
      }
    }
    if (fixed) await emit('mods_dir_changed').catch(() => {})
    cue(failed ? 'error' : 'success', { emphasis: 'subtle' })
    setBusy(false); setCancelling(false)
  }, [picked, usmap, paks, originals, keepName, addLog])

  // the Library's notice updates exactly the mods it sent, as soon as the list and the USMAP are ready (after a run in
  // progress)
  useEffect(() => {
    if (autoRun.current && mods && !lock && !busy) { const keys = autoRun.current; autoRun.current = null; void run(keys) }
  }, [mods, lock, busy, run])

  // the mod being updated stays in view
  const runningKey = batch.find(k => runs[k]?.status === 'running')
  useEffect(() => {
    if (runningKey) document.querySelector(`[data-key="${CSS.escape(runningKey)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [runningKey])

  const showAdvanced = (on: boolean) => {
    setAdvanced(on)
    localStorage.setItem(ADVANCED, on ? '1' : '0')
    if (on) setTimeout(() => document.querySelector('.vf-adv')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
  }

  const stop = () => { cancel.current = true; setCancelling(true); addLog('Cancelling after the current step…', 'warning') }
  const copy = async (what: 'report' | 'log') => {
    const text = what === 'log' ? logs.map(l => `[${l.time}] ${l.text}`).join('\n') : Object.values(runs).filter(r => r.report).map(r => reportText(r.report!)).join('\n\n')
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(what); setTimeout(() => setCopied(null), 1500)
  }

  // the list: mods that need an update first, then A to Z or newest first
  const needsOf = (m: Mod) => needs.get(norm(m.path))
  const order = (a: Mod, b: Mod) => (sort === 'newest' ? (b.modified ?? 0) - (a.modified ?? 0) : 0) || a.name.localeCompare(b.name)
  const list = [...(mods ?? [])].sort((a, b) => Number(Boolean(needsOf(b))) - Number(Boolean(needsOf(a))) || order(a, b))
  const sortBy = (v: 'name' | 'newest') => { setSort(v); localStorage.setItem(SORT, v) }
  const needle = q.trim().toLowerCase()
  const shown = needle ? list.filter(m => m.name.toLowerCase().includes(needle) || (m.hero ?? '').toLowerCase().includes(needle)) : list
  // two groups: the mods that need an update (and any updated this session, so a result stays where it was), the rest
  const first = (m: Mod) => Boolean(needsOf(m) || runs[norm(m.utoc)])
  const group = (id: string, title: string, ms: Mod[], count = ms.length) => {
    const keys = ms.map(m => norm(m.utoc))
    return { id, title, mods: ms, count, keys, all: keys.length > 0 && keys.every(k => picked.has(k)), none: !keys.some(k => picked.has(k)) }
  }
  const needing = shown.filter(first)
  groupOf.current = new Map(shown.map(m => [norm(m.utoc), first(m) ? 'needs' : 'rest']))
  const groups = [
    group('needs', 'Needs an update', needing, needing.filter(m => needsOf(m) && !isDone(runs[norm(m.utoc)]?.status)).length),
    group('rest', needing.length ? 'Other VFX mods' : 'VFX mods', shown.filter(m => !first(m))),
  ]
  const inLoadouts = (m: Mod) => { const k = canonKey(modKey(m.path)); return loadouts.filter(l => l.on.some(x => canonKey(x) === k)).map(l => l.name) }
  const fold = (id: string) => setFoldedIds(f => { const n = f.includes(id) ? f.filter(x => x !== id) : [...f, id]; localStorage.setItem(FOLDED, JSON.stringify(n)); return n })
  const todo = [...picked].filter(k => !isDone(runs[k]?.status)).length
  const runningAt = batch.findIndex(k => runs[k]?.status === 'running')
  const reports = Object.values(runs).filter(r => r.report)
  const updated = reports.filter(r => r.status === 'fixed').length
  const cl = usmapCl(usmap ? fileName(usmap) : null) // the file in use, not the last download
  const behind = cl && build?.cl && cl < build.cl
  const usmapState = checking ? 'Checking for a newer one…' : !usmap ? 'None chosen' : usmapOk === false ? 'File missing' : usmapInfo?.upToDate || usmapInfo?.updated ? 'Up to date' : 'Ready'
  const usmapMissing = !checking && (!usmap || usmapOk === false)
  const runningMod = runningKey ? (mods ?? []).find(m => norm(m.utoc) === runningKey) : undefined
  const runningStep = runningKey ? runs[runningKey]?.step : undefined
  const state = cancelling ? 'Cancelling. The current step finishes first.'
    : busy ? `Updating ${runningAt + 1} of ${batch.length}${runningMod ? `: ${runningMod.name}` : ''}${runningStep ? `, step ${runningStep} of ${STEPS.length}` : '…'}`
      : lock ?? (reports.length ? `${plural(updated, 'mod')} updated${reports.length > updated ? `, ${reports.length - updated} not` : ''}` : todo ? '' : 'Tick the mods to update')
  // what Update will do to the files, beside the button, so a choice made once in Advanced is never a surprise
  const policy = naming === 'broken'
    ? { off: 'Originals get _BROKEN and turn off', trash: 'Originals get _BROKEN and go to Recently deleted', keep: 'Originals get _BROKEN and stay as they are' }[originals]
    : { off: 'Updates get _UPDATED, originals turn off', trash: 'Updates get _UPDATED, originals go to Recently deleted', keep: 'Updates get _UPDATED, originals stay as they are' }[originals]

  return (
    <div className="vf-panel">
      <div className="vf-body">
        {list.length > SEARCH_FROM && (
          <div className="lp-filters vf-filters">
            <label className="lp-search vf-search">
              <Search size={15} aria-hidden="true" />
              <input value={q} placeholder="Search VFX mods" aria-label="Search VFX mods" onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') setQ('') }} />
              {q && <button type="button" className="lo-icon vf-search-clear" onClick={() => setQ('')} aria-label="Clear the search" title="Clear the search"><X size={14} /></button>}
            </label>
            <div className="mod-state-filter lp-sort" role="group" aria-label="Sort VFX mods">
              <button type="button" aria-pressed={sort === 'name'} onClick={() => sortBy('name')}>A to Z</button>
              <button type="button" aria-pressed={sort === 'newest'} onClick={() => sortBy('newest')}>Newest</button>
            </div>
          </div>
        )}
        {loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>The mods folder could not be read{mods?.length ? ', so this is the list from before' : ''}. {loadError.replace(/[.!]?\s*$/, '.')}{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {checkError && !loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Which mods need an update could not be checked, so none are marked.{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {mods === null
          ? <p className="lp-empty" aria-live="polite">Reading the mods folder{scan ? `: ${scan.done} of ${plural(scan.total, 'mod')}` : '…'}</p>
          : shown.length === 0
            ? (loadError && !needle ? null : <p className="lp-empty">{needle ? `No VFX mods match “${q.trim()}”.` : 'No VFX mods in the mods folder. Mods the Library shows as VFX appear here.'}</p>)
            : <div className="vf-groups">{groups.map(g => g.mods.length > 0 && (
              <Group key={g.id} title={g.title} count={g.count} tone={g.id === 'needs' ? 'needs' : undefined} busy={busy} all={g.all} none={g.none}
                open={Boolean(needle) || !foldedIds.includes(g.id)} onFold={() => fold(g.id)} onPick={on => pick(g.keys, on)}>
                <ul className="mod-rows vf-rows">
                  {g.mods.map(m => {
                    const key = norm(m.utoc)
                    return (
                      <Row key={key} rowKey={key} mod={m} loadouts={inLoadouts(m)} run={runs[key]} needs={needsOf(m)} picked={picked.has(key)} open={open.has(key)} busy={busy}
                        onPick={v => pick([key], v)}
                        onToggle={() => setOpen(o => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n })}
                        onRetry={() => void run([key])} />
                    )
                  })}
                </ul>
              </Group>
            ))}</div>}

        {usmapMissing && (
          <p className="vf-warn">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{usmap ? 'The USMAP file is missing.' : 'No USMAP yet.'} Updates need the game's property layout.{' '}
              <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)}>Fetch latest</button> or{' '}
              <button type="button" className="su-link" disabled={busy} onClick={browseUsmap}>browse for one</button>.</span>
          </p>
        )}

        <section className={`ia vf-adv${advanced ? ' is-open' : ''}`}>
          <h2 className="vf-adv-title">
            <button type="button" className="ia-toggle" aria-expanded={advanced} onClick={() => showAdvanced(!advanced)}>
              <ChevronRight size={15} className="ia-caret" aria-hidden="true" />
              Advanced
            </button>
          </h2>
          <div className="t-acc-panel" data-open={advanced}>
            <div className="t-acc-panel-inner" {...folded(!advanced)}>
              <div className="vf-adv-body">
                <Section icon={<Tag size={15} aria-hidden="true" />} title="Names" about="Which copy keeps the mod's name after an update.">
                  <Seg label="Names" value={naming} disabled={busy} note={NAMING_NOTE[naming]}
                    options={[['broken', 'The update keeps it'], ['updated', 'The original keeps it']]}
                    onChange={v => { setNaming(v); localStorage.setItem(KEEP_NAME, v === 'broken' ? '1' : '0') }} />
                </Section>

                <Section icon={<Archive size={15} aria-hidden="true" />} title="Originals" about="What happens to a mod once its update is in.">
                  <Seg label="Originals" value={originals} disabled={busy} note={ORIGINALS_NOTE[originals]}
                    options={[['off', 'Turn off'], ['trash', 'Move to Recently deleted'], ['keep', 'Leave as they are']]}
                    onChange={v => { setOriginals(v); localStorage.setItem(ORIGINALS, v) }} />
                </Section>

                <Section icon={<MapIcon size={15} aria-hidden="true" />} title="USMAP"
                  state={<span className={behind && !usmapMissing && !checking ? 'is-warn' : usmapMissing ? 'is-warn' : ''}>{behind && !usmapMissing && !checking ? 'Older than the game' : usmapState}</span>}
                  about="The game's property layout. Updates read the game's files with it.">
                  <div className="vf-usmap">
                    <span className={`su-part-mark${usmapOk ? ' is-ok' : ''}`} role="img" aria-label={usmapOk ? 'Ready' : 'Missing'}>{usmapOk && <Check size={14} strokeWidth={2.5} />}</span>
                    <div className="su-part-text">
                      <b title={usmap ?? undefined}>{usmap ? usmapRelease(fileName(usmap)) ?? fileName(usmap) : 'No USMAP chosen'}</b>
                      <span>{usmap ? [cl && `Build ${cl}`, usmapInfo?.commitDate].filter(Boolean).join(' · ') || fileName(usmap) : 'Check for updates downloads the newest from rivals-depot'}</span>
                    </div>
                    <span className="su-part-links">
                      <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)} title="Download the newest USMAP from rivals-depot and use it">
                        {checking ? 'Checking…' : 'Check for updates'}
                      </button>
                      <button type="button" className="su-link" disabled={busy} onClick={browseUsmap} title="Use a .usmap file from this PC">Browse…</button>
                    </span>
                  </div>
                  {behind ? <p className="vf-warn"><AlertTriangle size={14} aria-hidden="true" /><span>The game is on build {build!.cl}. Updates usually still work after a small patch. If they fail, check for updates again later.</span></p> : null}
                </Section>

                <ColorNames />

                <Section icon={<ScrollText size={15} aria-hidden="true" />} title="Log" state={logs.length ? plural(logs.length, 'line') : undefined}>
                  <div className="vf-log" role="log">{logs.length ? logs.map((l, i) => <div key={i} className={`is-${l.type}`}><span>{l.time}</span> {l.text}</div>) : <span>Each step of an update writes a line here.</span>}</div>
                  {logs.length > 0 && <button type="button" className="row-action vf-copy-log" onClick={() => copy('log')}><Copy size={13} /> {copied === 'log' ? 'Copied' : 'Copy log'}</button>}
                </Section>
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="vf-foot">
        {state
          ? <span className="vf-state" aria-live="polite">{state}</span>
          : <span className="vf-state vf-policy">{policy}. <button type="button" className="su-link" onClick={() => showAdvanced(true)}>Change</button></span>}
        {reports.length > 0 && !busy && <button type="button" className="lo-text-btn" onClick={() => copy('report')}><Copy size={14} /> {copied === 'report' ? 'Copied' : 'Copy report'}</button>}
        {busy
          ? <button type="button" className="lo-text-btn" disabled={cancelling} onClick={stop} aria-label="Cancel updating">{cancelling ? 'Cancelling…' : 'Cancel'}</button>
          : <button type="button" className="btn-primary" disabled={Boolean(lock) || !todo} onClick={() => run()}>
              <RefreshCw size={14} aria-hidden="true" />{todo ? <>Update <Num id="vf-todo" value={todo} /> {todo === 1 ? 'mod' : 'mods'}</> : 'Update'}
            </button>}
      </footer>
    </div>
  )
}

export default function VfxUpdaterWindow() {
  return (
    <div className="vfx-window-container vf-window">
      <TitleBar title="VFX Updater" hideMaximize={true} />
      <VfxUpdaterPanel />
    </div>
  )
}

if (import.meta.env.DEV) {
  // an update that kept the name is the same loadout member as the original was, and its _BROKEN copy is not
  const m = '~mods/Lime_9999999_P'
  console.assert(canonKey(modKey(`${m}.bak_repak`)) === canonKey(modKey(`${m}.pak`)), 'loadouts hold the update under the original key')
  console.assert(canonKey(modKey('~mods/Lime_BROKEN_9999999_P.bak_repak')) !== canonKey(modKey(`${m}.pak`)), 'the broken copy leaves its loadouts')
}
