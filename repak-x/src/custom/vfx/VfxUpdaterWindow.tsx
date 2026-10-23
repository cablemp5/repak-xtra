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
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, RotateCcw, Search, X } from 'lucide-react'
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
type Mod = { path: string; utoc: string; enabled: boolean; name: string; hero?: string | null }
type Verdict = { path: string; kind: string; reason: string }
type Log = { time: string; text: string; type: string }
type Usmap = { updated: boolean; upToDate: boolean; skipped: boolean; localPath?: string | null; filename?: string | null; version?: string | null; buildNumber?: number | null; commitDate?: string | null; message: string }
type GameBuild = { updated: number; cl?: number | null }

const TURN_OFF = 'repakxtra.vfx.turnOff'
const KEEP_NAME = 'repakxtra.vfx.keepName'
const ADVANCED = 'repakxtra.vfx.advanced' // Advanced opens the way it was last left, as the install card's
const FOLDED = 'repakxtra.vfx.folded' // the groups folded away, as a list of ids
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
  return (renamed ? `The update has the mod's name. The original is now ${kept}${p.turnedOff ? ', off' : ''}.` : `Saved as ${fileName(p.fixed)}${p.turnedOff ? ', and the original is off' : ''}.`)
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
function Row({ mod, loadouts, run, needs, picked, open, busy, onPick, onToggle, onRetry }: {
  mod: Mod; loadouts: string[]; run?: Run; needs?: string; picked: boolean; open: boolean; busy: boolean; onPick: (v: boolean) => void; onToggle: () => void; onRetry: () => void
}) {
  const status = run?.status
  const running = status === 'running'
  const step = run?.step ?? 0
  return (
    <li className={`mod-row vf-row${status ? ` is-${status}` : ''}${picked ? ' is-picked' : ''}`} title={needs}>
      <Checkbox size="sm" className="vf-pick" checked={picked} isDisabled={busy} disabled={busy} onChange={onPick} title={mod.path}>
        <span className="vf-row-text">
          <span className="vf-row-name">{mod.name}</span>
          {loadouts.length > 0 && <span className="vf-row-meta" title={`In ${loadouts.join(', ')}`}>In {loadouts.join(', ')}</span>}
        </span>
      </Checkbox>
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
function Group({ title, count, tone, open, onFold, all, busy, onPickAll, children }: {
  title: string; count: number; tone?: 'needs'; open: boolean; onFold: () => void; all: boolean; busy: boolean; onPickAll: () => void; children: React.ReactNode
}) {
  return (
    <section className={`vf-grp${tone ? ` is-${tone}` : ''}${open ? '' : ' is-folded'}`}>
      <div className="vf-grp-head">
        <button type="button" className="vf-grp-fold" aria-expanded={open} onClick={onFold}>
          <ChevronRight size={15} className="vf-grp-caret" aria-hidden="true" />
          <h2>{title}</h2>
          <span className="vf-grp-count">{count}</span>
        </button>
        <button type="button" className="vf-select" disabled={busy} onClick={onPickAll}>{all ? 'Clear' : 'Select all'}</button>
      </div>
      <div className="t-acc-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}>{children}</div></div>
    </section>
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
    <div className="vf-sub">
      <h3>Color names<span>{custom ? 'Custom' : 'Default'}</span></h3>
      <div className="vf-names">
        <p className="vf-hint">Which blueprint and data table colors carry over, by name. Material parameters always do, except excluded names.</p>
        <label>Carry names containing<input value={text.includes} onChange={e => save({ ...text, includes: e.target.value })} spellCheck={false} /></label>
        <label>Never carry names containing<input value={text.excludes} onChange={e => save({ ...text, excludes: e.target.value })} spellCheck={false} /></label>
        <p className="vf-hint">Separate words with commas. Case does not matter.{custom && <> <button type="button" className="su-link" onClick={reset}>Reset to defaults</button></>}</p>
      </div>
    </div>
  )
}

/** A checkbox with its hint under it, for Advanced. */
function Option({ checked, disabled, onChange, label, hint }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="vf-check">
      <Checkbox size="sm" checked={checked} isDisabled={disabled} disabled={disabled} onChange={onChange}>{label}</Checkbox>
      <p className="vf-hint">{hint}</p>
    </div>
  )
}

export function VfxUpdaterPanel() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [needs, setNeeds] = useState<Map<string, string>>(new Map()) // a mod's main file (norm) -> why it needs an update
  const [runs, setRuns] = useState<Record<string, Run>>({}) // by norm(utoc)
  const [picked, setPicked] = useState<Set<string>>(new Set()) // norm(utoc)
  const [q, setQ] = useState('')
  const [foldedIds, setFoldedIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(FOLDED) || '[]') } catch { return [] } })
  const loadouts = useLoadouts()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [paks, setPaks] = useState<string | null>(null)
  const [build, setBuild] = useState<GameBuild | null>(null)
  const [usmap, setUsmap] = useState<string | null>(null)
  const [usmapInfo, setUsmapInfo] = useState<Usmap | null>(null)
  const [usmapOk, setUsmapOk] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(true)
  const [turnOff, setTurnOff] = useState(() => localStorage.getItem(TURN_OFF) !== '0')
  const [keepName, setKeepName] = useState(() => localStorage.getItem(KEEP_NAME) !== '0')
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED) === '1')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [logs, setLogs] = useState<Log[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [batch, setBatch] = useState<string[]>([]) // the run in progress, in order
  const [, bump] = useState(0)
  const cancel = useRef(false)
  const seeded = useRef(false) // the mods that need an update are ticked once, when the list first arrives
  const handed = useRef<{ paths: string[]; start: boolean } | null>(null) // mods the main window sent, ticked once the list is in
  const pendingStart = useRef(false)
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

  // the mods folder's VFX mods and which need an update, again after each run (an updated mod no longer does)
  useEffect(() => {
    if (busy) return
    let live = true
    invoke<Mod[]>('xtra_vfx_mods')
      .then(async list => {
        const verdicts = await invoke<Verdict[]>('xtra_broken_mods', { modPaths: list.map(m => m.path) }).catch(() => [] as Verdict[])
        if (!live) return
        const n = new Map(verdicts.filter(v => v.kind === 'vfx').map(v => [norm(v.path), v.reason]))
        setMods(list)
        setNeeds(n)
        if (!seeded.current) {
          seeded.current = true
          pick(list.filter(m => n.has(norm(m.path))).map(m => norm(m.utoc)), true)
        }
      })
      .catch(e => { if (live) { setMods([]); addLog(`Could not read the mods folder: ${e}`, 'error') } })
    return () => { live = false }
  }, [busy, addLog])

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
    if (h.start && keys.length) pendingStart.current = true
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
    setUsmap(p)
    const current = await invoke<Record<string, unknown>>('vfx_get_settings').catch(() => ({}))
    await invoke('vfx_save_settings', { settings: { ...current, usmapPath: p } }).catch(() => {}) // keeps the auto-update bookkeeping
  }

  const lock = busy ? null : checking ? 'Checking for a newer USMAP…' : !usmap ? 'Choose a USMAP file in Advanced first' : usmapOk === false ? 'The USMAP file is missing' : !paks ? 'Set the game folder in Setup first' : null

  const run = useCallback(async (keys?: string[]) => {
    const byKey = new Map((modsRef.current ?? []).map(m => [norm(m.utoc), m]))
    const todo = (keys ?? [...picked].filter(k => !isDone(runsRef.current[k]?.status))).filter(k => byKey.has(k))
    if (!todo.length || !usmap || !paks) return
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
        modPath: mod.utoc, usmapPath: usmap, gamePaksPath: paks, turnOffOriginal: turnOff, keepName, filter,
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
    }
    if (fixed) await emit('mods_dir_changed').catch(() => {})
    cue(failed ? 'error' : 'success', { emphasis: 'subtle' })
    setBusy(false); setCancelling(false)
  }, [picked, usmap, paks, turnOff, keepName, addLog])

  // the Library's notice starts the update as soon as the list and the USMAP are ready
  useEffect(() => {
    if (pendingStart.current && mods && !lock && !busy && picked.size) { pendingStart.current = false; void run() }
  }, [mods, lock, busy, picked, run])

  const stop = () => { cancel.current = true; setCancelling(true); addLog('Cancelling after the current step…', 'warning') }
  const copy = async (what: 'report' | 'log') => {
    const text = what === 'log' ? logs.map(l => `[${l.time}] ${l.text}`).join('\n') : Object.values(runs).filter(r => r.report).map(r => reportText(r.report!)).join('\n\n')
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(what); setTimeout(() => setCopied(null), 1500)
  }

  // the list: mods that need an update first, then A to Z
  const needsOf = (m: Mod) => needs.get(norm(m.path))
  const list = [...(mods ?? [])].sort((a, b) => Number(Boolean(needsOf(b))) - Number(Boolean(needsOf(a))) || a.name.localeCompare(b.name))
  const needle = q.trim().toLowerCase()
  const shown = needle ? list.filter(m => m.name.toLowerCase().includes(needle) || (m.hero ?? '').toLowerCase().includes(needle)) : list
  // two groups: the mods that need an update (and any updated this session, so a result stays where it was), the rest
  const first = (m: Mod) => Boolean(needsOf(m) || runs[norm(m.utoc)])
  const group = (id: string, title: string, ms: Mod[], count = ms.length) => {
    const keys = ms.map(m => norm(m.utoc))
    return { id, title, mods: ms, count, keys, all: keys.length > 0 && keys.every(k => picked.has(k)) }
  }
  const needing = shown.filter(first)
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
  const cl = usmapCl(usmapInfo?.filename ?? (usmap ? fileName(usmap) : null))
  const behind = cl && build?.cl && cl < build.cl
  const usmapState = checking ? 'Checking for a newer one…' : !usmap ? 'None chosen' : usmapOk === false ? 'File missing' : usmapInfo?.upToDate || usmapInfo?.updated ? 'Up to date' : 'Ready'
  const usmapMissing = !checking && (!usmap || usmapOk === false)
  const state = cancelling ? 'Cancelling. The current step finishes first.'
    : busy ? `Updating ${runningAt + 1} of ${batch.length}…`
      : lock ?? (reports.length ? `${plural(updated, 'mod')} updated${reports.length > updated ? `, ${reports.length - updated} not` : ''}` : todo ? '' : 'Tick the mods to update')

  return (
    <div className="vf-panel">
      <div className="vf-body">
        {list.length > SEARCH_FROM && (
          <label className="lp-search vf-search">
            <Search size={15} aria-hidden="true" />
            <input value={q} placeholder="Search VFX mods" aria-label="Search VFX mods" onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setQ('') }} />
            {q && <button type="button" className="lo-icon vf-search-clear" onClick={() => setQ('')} aria-label="Clear the search" title="Clear the search"><X size={14} /></button>}
          </label>
        )}
        {mods === null
          ? <p className="lp-empty">Reading the mods folder…</p>
          : shown.length === 0
            ? <p className="lp-empty">{needle ? `No VFX mods match “${q.trim()}”.` : 'No VFX mods in the mods folder. Mods the Library shows as VFX appear here.'}</p>
            : groups.map(g => g.mods.length > 0 && (
              <Group key={g.id} title={g.title} count={g.count} tone={g.id === 'needs' ? 'needs' : undefined} busy={busy} all={g.all}
                open={Boolean(needle) || !foldedIds.includes(g.id)} onFold={() => fold(g.id)} onPickAll={() => pick(g.keys, !g.all)}>
                <ul className="mod-rows vf-rows">
                  {g.mods.map(m => {
                    const key = norm(m.utoc)
                    return (
                      <Row key={key} mod={m} loadouts={inLoadouts(m)} run={runs[key]} needs={needsOf(m)} picked={picked.has(key)} open={open.has(key)} busy={busy}
                        onPick={v => pick([key], v)}
                        onToggle={() => setOpen(o => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n })}
                        onRetry={() => void run([key])} />
                    )
                  })}
                </ul>
              </Group>
            ))}

        {usmapMissing && (
          <p className="vf-warn">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{usmap ? 'The USMAP file is missing.' : 'No USMAP yet.'} Updates need the game's property layout.{' '}
              <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)}>Fetch latest</button> or{' '}
              <button type="button" className="su-link" disabled={busy} onClick={browseUsmap}>browse for one</button>.</span>
          </p>
        )}

        <section className={`ia vf-adv${advanced ? ' is-open' : ''}`}>
          <button type="button" className="ia-toggle" aria-expanded={advanced} onClick={() => { setAdvanced(!advanced); localStorage.setItem(ADVANCED, advanced ? '0' : '1') }}>
            <ChevronRight size={14} className="ia-caret" aria-hidden="true" />
            Advanced
          </button>
          <div className="t-acc-panel" data-open={advanced}>
            <div className="t-acc-panel-inner" {...folded(!advanced)}>
              <div className="vf-adv-body">
                <div className="vf-sub">
                  <h3>Updates</h3>
                  <div className="vf-options">
                    <Option checked={keepName} disabled={busy} label="Keep the mod's name on the update"
                      onChange={v => { setKeepName(v); localStorage.setItem(KEEP_NAME, v ? '1' : '0') }}
                      hint={keepName ? 'The original is renamed to end in _BROKEN, so loadouts and tags keep the working copy.' : 'The update is named to end in _UPDATED, and the original keeps its name.'} />
                    <Option checked={turnOff} disabled={busy} label="Turn off the originals"
                      onChange={v => { setTurnOff(v); localStorage.setItem(TURN_OFF, v ? '1' : '0') }}
                      hint="Both copies change the same game files, so only one should be on." />
                  </div>
                </div>

                <div className="vf-sub">
                  <h3>USMAP<span>{usmapState}</span></h3>
                  <ul className="mod-rows">
                    <li className="su-part vf-usmap">
                      <span className={`su-part-mark${usmapOk ? ' is-ok' : ''}`} role="img" aria-label={usmapOk ? 'Ready' : 'Missing'}>{usmapOk && <Check size={14} strokeWidth={2.5} />}</span>
                      <span className="su-part-text">
                        <b title={usmap ?? undefined}>{usmap ? fileName(usmap) : 'No USMAP chosen'}</b>
                        <span>{[usmapInfo?.version, usmapInfo?.commitDate].filter(Boolean).join(' · ') || 'The game\'s property layout, from rivals-depot or a file'}</span>
                      </span>
                      <span className="su-part-links">
                        <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)} title="Download the newest USMAP from rivals-depot and use it">Fetch latest</button>
                        <button type="button" className="su-link" disabled={busy} onClick={browseUsmap}>Browse…</button>
                      </span>
                    </li>
                  </ul>
                  {behind ? <p className="vf-warn"><AlertTriangle size={14} aria-hidden="true" />This USMAP ({cl}) is older than the game ({build!.cl}). Updates usually still work after a small patch. If they fail, wait for rivals-depot to publish a newer one.</p> : null}
                </div>

                <ColorNames />

                <div className="vf-sub">
                  <h3>Log<span>{logs.length ? plural(logs.length, 'line') : 'Nothing yet'}</span></h3>
                  <div className="vf-log" role="log">{logs.length ? logs.map((l, i) => <div key={i} className={`is-${l.type}`}><span>{l.time}</span> {l.text}</div>) : <span>Each step of an update writes a line here.</span>}</div>
                  {logs.length > 0 && <button type="button" className="row-action vf-copy-log" onClick={() => copy('log')}><Copy size={13} /> {copied === 'log' ? 'Copied' : 'Copy log'}</button>}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="vf-foot">
        <span className="vf-state" aria-live="polite">{state}</span>
        {reports.length > 0 && !busy && <button type="button" className="lo-text-btn" onClick={() => copy('report')}><Copy size={14} /> {copied === 'report' ? 'Copied' : 'Copy report'}</button>}
        {busy
          ? <button type="button" className="lo-text-btn" disabled={cancelling} onClick={stop} aria-label="Cancel updating">{cancelling ? 'Cancelling…' : 'Cancel'}</button>
          : <button type="button" className="btn-primary" disabled={Boolean(lock) || !todo} onClick={() => run()}>
              {todo ? <>Update <Num id="vf-todo" value={todo} /> {todo === 1 ? 'mod' : 'mods'}</> : 'Update'}
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
