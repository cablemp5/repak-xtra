// repakxtra: the VFX Updater window (route vfx-updater), in place of the upstream VFX Updater's panel: updates one VFX mod
// or a list of them (pipeline.ts). Built from the Loadout page's parts: group headings with a count pill, mods as rows
// in a hairline list, a dashed empty row that takes dropped .utoc files. One flow from top to bottom: the library's mods
// that need an update (one click adds them all), the list, its one option, then Advanced (USMAP, Color names, Log), which
// stays folded unless the USMAP is missing, and the footer's Update. Each mod shows its step and a progress bar while it runs, then its report:
// what was rebuilt, what was kept and why, and where the update went (beside the original, which goes off). A failed or
// cancelled mod can be tried again. Cancel waits for the step in flight (UAssetTool cannot be interrupted) and says so.
// The main window hands mods over (handoff.ts) and swaps the originals for the updates in loadouts (VfxNotice.tsx).
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import TitleBar from '../../components/TitleBar'
import Checkbox from '../../components/ui/Checkbox'
import { Num, SwapText } from '../motion'
import { cue } from '../sounds'
import { DEFAULT_FILTER, parseWords, readFilter, resetFilter, writeFilter, type ColorFilter } from './filter'
import { FIXED_EVENT, onHandoff, takeHandoff, utocOf, type Fixed } from './handoff'
import { STEPS, fixVfxMod, type AssetKind, type VfxReport } from './pipeline'
import './vfx.css'

type Status = 'waiting' | 'running' | 'fixed' | 'nothing' | 'failed' | 'cancelled'
type Item = { path: string; status: Status; step?: number; sub?: string; report?: VfxReport }
type Log = { time: string; text: string; type: string }
type Usmap = { updated: boolean; upToDate: boolean; skipped: boolean; localPath?: string | null; filename?: string | null; version?: string | null; buildNumber?: number | null; commitDate?: string | null; message: string }
type GameBuild = { updated: number; cl?: number | null }

const TURN_OFF = 'repakxtra.vfx.turnOff'
const ADVANCED = 'repakxtra.vfx.advanced' // Advanced opens the way it was last left, as the install card's
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const modName = (p: string) => fileName(p).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '')
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`
/** A folded panel's content: out of reach of Tab and screen readers (the React 18 types this app uses lack inert). */
const folded = (hidden: boolean) => (hidden ? { inert: true } : {}) as object
const usmapCl = (name?: string | null) => Number(name?.match(/-(\d{6,})\+/)?.[1]) || null
/** Dropped files the updater can take: a mod's .utoc, or its .pak / .bak_repak (the .utoc beside it is read). */
const droppable = (p: string) => /\.(utoc|pak|bak_repak)$/i.test(p)
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()

const STATUS: Record<Status, string> = { waiting: 'Waiting', running: 'Updating', fixed: 'Updated', nothing: 'Nothing to update', failed: 'Failed', cancelled: 'Cancelled' }
const KIND_ORDER: AssetKind[] = ['failed', 'unreadable', 'added', 'updated', 'same', 'passed']
const KIND_LABEL: Record<AssetKind, string> = { updated: 'Rebuilt', same: 'Match the game', added: 'The mod\'s own', passed: 'Kept as they were', unreadable: 'Could not be read', failed: 'Not updated' }

/** One mod's report as plain text, for Copy report. */
function reportText(r: VfxReport) {
  const lines = [`${r.name}: ${STATUS[r.status as Status] ?? r.status}${r.error ? `. ${r.error}` : ''}`]
  if (r.output) lines.push(`  Saved as ${fileName(r.output)}${r.placed?.turnedOff ? ', the original is off' : ''}${r.placed?.replaced ? ', the previous update is in Recently deleted' : ''}`)
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
        ? <p className="vf-note">Rebuilt {plural(r.counts.updated, 'asset')} with {plural(r.counts.changes, 'edit')}. Saved as <code>{fileName(r.output ?? '')}</code>
          {r.placed?.turnedOff ? ', and the original is off.' : '.'}{r.placed?.replaced ? ' The previous update is in Recently deleted.' : ''}</p>
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

function Row({ item, open, onToggle, onRemove, onRetry, busy }: { item: Item; open: boolean; onToggle: () => void; onRemove: () => void; onRetry: () => void; busy: boolean }) {
  const running = item.status === 'running'
  const step = item.step ?? 0
  const name = modName(item.path)
  return (
    <li className={`mod-row vf-row is-${item.status}`}>
      <button type="button" className="vf-row-name" onClick={onToggle} aria-expanded={item.report ? open : undefined} disabled={!item.report} title={item.path}>
        <span>{name}</span>
        {item.report && <ChevronDown size={14} className="vf-caret" aria-hidden="true" />}
      </button>
      {item.status === 'fixed' || item.status === 'nothing' || item.status === 'failed' || item.status === 'cancelled'
        ? <span className={`vf-pill is-${item.status}`}>{item.status === 'fixed' && <Check size={12} strokeWidth={2.5} aria-hidden="true" />}{STATUS[item.status]}</span>
        : <span className={`vf-status is-${item.status}`}><SwapText text={running && step ? `Step ${step} of ${STEPS.length}` : STATUS[item.status]} /></span>}
      {!running && !busy
        ? <button type="button" className="lo-icon row-remove" onClick={onRemove} aria-label={`Remove ${name} from the list`} title="Remove from the list"><X size={14} /></button>
        : <span className="vf-remove-gap" aria-hidden="true" />}
      {running && step ? (
        <div className="vf-progress">
          <div className="vf-bar" role="progressbar" aria-valuenow={step} aria-valuemin={0} aria-valuemax={STEPS.length} aria-label={`${name} progress`}>
            <i style={{ width: `${((step - 0.5) / STEPS.length) * 100}%` }} />
          </div>
          <p className="vf-step" aria-live="polite"><SwapText text={STEPS[step - 1]} />{item.sub ? <span>{item.sub}</span> : null}</p>
        </div>
      ) : null}
      {item.report && <div className="t-acc-panel vf-row-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}><Report r={item.report} onRetry={onRetry} busy={busy} /></div></div>}
    </li>
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

export function VfxUpdaterPanel() {
  const [items, setItems] = useState<Item[]>([])
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [paks, setPaks] = useState<string | null>(null)
  const [build, setBuild] = useState<GameBuild | null>(null)
  const [usmap, setUsmap] = useState<string | null>(null)
  const [usmapInfo, setUsmapInfo] = useState<Usmap | null>(null)
  const [usmapOk, setUsmapOk] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(true)
  const [turnOff, setTurnOff] = useState(() => localStorage.getItem(TURN_OFF) !== '0')
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [over, setOver] = useState(false) // files dragged over the window
  const [logs, setLogs] = useState<Log[]>([])
  const [flagged, setFlagged] = useState<string[]>([]) // the library's mods that need a VFX update (xtra_broken.rs), as .utoc paths
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED) === '1')
  const [copied, setCopied] = useState<string | null>(null)
  const cancel = useRef(false)
  const pendingStart = useRef(false)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const addLog = useCallback((text: string, type = 'info') => setLogs(l => [...l.slice(-999), { time: new Date().toLocaleTimeString(), text, type }]), [])
  const patch = (path: string, p: Partial<Item>) => setItems(list => list.map(i => (i.path === path ? { ...i, ...p } : i)))

  const add = useCallback((paths: string[], replace = false) => {
    const fresh = [...new Set(paths.map(utocOf))]
    setItems(list => {
      const base = replace ? list.filter(i => i.status === 'running') : list
      return [...base, ...fresh.filter(p => !base.some(i => i.path.toLowerCase() === p.toLowerCase())).map(path => ({ path, status: 'waiting' as Status }))]
    })
  }, [])

  // where the game is, its build, the USMAP (checked against rivals-depot once, quietly)
  useEffect(() => {
    invoke<string | null>('get_game_path').then(mods => {
      if (!mods) return
      const cut = Math.max(mods.lastIndexOf('/'), mods.lastIndexOf('\\'))
      setPaks(cut > 0 ? mods.slice(0, cut) : mods)
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

  // mods handed over by the main window
  useEffect(() => {
    const take = (h: { paths: string[]; start: boolean }) => {
      if (!h.paths.length) return
      add(h.paths, h.start)
      if (h.start) pendingStart.current = true
    }
    const h = takeHandoff()
    if (h) take(h)
    return onHandoff(take)
  }, [add])

  // files dropped on the window (Tauri's drag events, as the main window's installs)
  useEffect(() => {
    const uns = [
      listen('tauri://drag-enter', () => setOver(true)),
      listen('tauri://drag-leave', () => setOver(false)),
      listen('tauri://drag-cancelled', () => setOver(false)),
      listen<{ paths?: string[] }>('tauri://drag-drop', e => {
        setOver(false)
        const paths: string[] = Array.isArray(e.payload) ? e.payload : e.payload?.paths ?? []
        const mods = paths.filter(droppable)
        if (mods.length) add(mods)
        if (paths.length > mods.length) addLog(`${plural(paths.length - mods.length, 'dropped file')} skipped: only .utoc mods (or their .pak) can be updated.`, 'warning')
      }),
    ]
    return () => { uns.forEach(u => u.then(f => f())) }
  }, [add, addLog])

  // the library's mods that need a VFX update, so the Library's notice can be dismissed and they are still one click
  // away here. Asked again after each run: a mod with an update beside it no longer needs one.
  useEffect(() => {
    if (busy) return
    let live = true
    invoke<{ path: string; utoc_path?: string | null }[]>('get_pak_files')
      .then(mods => invoke<{ path: string; kind: string }[]>('xtra_broken_mods', { modPaths: mods.map(m => m.path) }).then(v => {
        const vfx = new Set(v.filter(x => x.kind === 'vfx').map(x => norm(x.path)))
        return mods.filter(m => vfx.has(norm(m.path))).map(m => m.utoc_path || utocOf(m.path))
      }))
      .then(p => { if (live) setFlagged(p) })
      .catch(() => {})
    return () => { live = false }
  }, [busy])

  // Rust steps report inside the step (types read so far)
  useEffect(() => {
    const un = listen<{ message: string }>('vfx_progress', e => {
      const run = itemsRef.current.find(i => i.status === 'running')
      if (run && e.payload?.message) patch(run.path, { sub: e.payload.message })
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
    const { open: pick } = await import('@tauri-apps/plugin-dialog')
    const p = await pick({ multiple: false, filters: [{ name: 'USMAP', extensions: ['usmap'] }] })
    if (typeof p !== 'string') return
    setUsmap(p)
    const current = await invoke<Record<string, unknown>>('vfx_get_settings').catch(() => ({}))
    await invoke('vfx_save_settings', { settings: { ...current, usmapPath: p } }).catch(() => {}) // keeps the auto-update bookkeeping
  }

  const browseMods = async () => {
    const { open: pick } = await import('@tauri-apps/plugin-dialog')
    const p = await pick({ multiple: true, filters: [{ name: 'IoStore mod', extensions: ['utoc'] }] })
    if (p) add(Array.isArray(p) ? p : [p])
  }

  const lock = busy ? null : checking ? 'Checking for a newer USMAP…' : !usmap ? 'Choose a USMAP file first' : usmapOk === false ? 'The USMAP file is missing. Fetch it or browse for one.' : !paks ? 'Set the game folder in Setup first' : null

  const run = useCallback(async (paths?: string[]) => {
    const todo = (paths ?? itemsRef.current.filter(i => i.status !== 'fixed' && i.status !== 'nothing').map(i => i.path))
    if (!todo.length || !usmap || !paks) return
    setBusy(true); cancel.current = false
    const filter = readFilter()
    let fixed = 0, failed = 0
    for (const path of todo) {
      if (cancel.current) break
      patch(path, { status: 'running', step: 1, sub: undefined, report: undefined })
      addLog(`Updating ${modName(path)}`)
      const r = await fixVfxMod({
        modPath: path, usmapPath: usmap, gamePaksPath: paks, turnOffOriginal: turnOff, filter,
        log: addLog, cancelled: () => cancel.current,
        onStep: s => patch(path, { step: s.step, sub: undefined }),
        onProgress: (_, __, message) => patch(path, { sub: message }),
      })
      patch(path, { status: r.status, report: r, sub: undefined })
      if (r.status === 'fixed') fixed++
      if (r.status === 'failed') failed++
      if (r.status !== 'fixed' || todo.length === 1) setOpen(o => new Set(o).add(path)) // problems open, a batch's updates stay folded
      if (r.placed) await emitTo('main', FIXED_EVENT, { from: r.placed.original, to: r.placed.fixed, swap: turnOff } satisfies Fixed).catch(() => {})
    }
    if (fixed) await emit('mods_dir_changed').catch(() => {})
    cue(failed ? 'error' : 'success', { emphasis: 'subtle' })
    setBusy(false); setCancelling(false)
  }, [usmap, paks, turnOff, addLog])

  // Update VFX mods in the main window's notice starts as soon as the USMAP is ready
  useEffect(() => {
    if (pendingStart.current && !lock && !busy && items.some(i => i.status === 'waiting')) { pendingStart.current = false; void run() }
  }, [lock, busy, items, run])

  const stop = () => { cancel.current = true; setCancelling(true); addLog('Cancelling after the current step…', 'warning') }
  const copy = async (what: 'report' | 'log') => {
    const text = what === 'log' ? logs.map(l => `[${l.time}] ${l.text}`).join('\n') : items.filter(i => i.report).map(i => reportText(i.report!)).join('\n\n')
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(what); setTimeout(() => setCopied(null), 1500)
  }

  const listed = new Set(items.map(i => norm(i.path)))
  const suggest = flagged.filter(p => !listed.has(norm(p)))
  const usmapMissing = !checking && (!usmap || usmapOk === false)
  const todo = items.filter(i => i.status !== 'fixed' && i.status !== 'nothing').length
  const done = items.filter(i => i.report).length
  const updated = items.filter(i => i.status === 'fixed').length
  const runningAt = items.findIndex(i => i.status === 'running')
  const cl = usmapCl(usmapInfo?.filename ?? (usmap ? fileName(usmap) : null))
  const behind = cl && build?.cl && cl < build.cl
  const usmapState = checking ? 'Checking for a newer one…' : !usmap ? 'None chosen' : usmapOk === false ? 'File missing' : usmapInfo?.upToDate || usmapInfo?.updated ? 'Up to date' : 'Ready'
  const state = cancelling ? 'Cancelling. The current step finishes first.'
    : busy ? `Updating ${runningAt + 1} of ${items.length}…`
      : lock ?? (done ? `${plural(updated, 'mod')} updated${done > updated ? `, ${done - updated} not` : ''}` : '')

  return (
    <div className={`vf-panel${over ? ' is-over' : ''}`}>
      <div className="vf-body">
        {suggest.length > 0 && !busy && (
          <div className="vfx-notice vf-suggest" role="status">
            <Sparkles size={16} className="vfx-notice-icon" aria-hidden="true" />
            <p><strong>{suggest.length === 1 ? '1 VFX mod needs' : `${suggest.length} VFX mods need`} an update.</strong>{' '}
              {build?.updated ? `The game update on ${new Date(build.updated * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'A game update'} changed the files {suggest.length === 1 ? 'it replaces' : 'they replace'}.</p>
            <button type="button" className="lo-text-btn" onClick={() => add(suggest)}><Plus size={14} aria-hidden="true" /> {suggest.length === 1 ? 'Add it' : `Add all ${suggest.length}`}</button>
          </div>
        )}

        <section className="lp-section">
          <h2 className="lo-group-head">Mods<span className="lo-group-count">{items.length}</span>
            {busy && runningAt >= 0 && <span className="lp-head-note">updating {runningAt + 1} of {items.length}</span>}
            <button type="button" className="lo-text-btn vf-head-tool" disabled={busy} onClick={browseMods}><Plus size={14} /> Add mods</button>
          </h2>
          {items.length === 0
            ? <p className="lp-empty vf-drop">Drop a mod's .utoc here, or Add mods.</p>
            : <ul className="mod-rows vf-rows">
              {items.map(item => (
                <Row key={item.path} item={item} busy={busy} open={open.has(item.path)}
                  onToggle={() => setOpen(o => { const n = new Set(o); n.has(item.path) ? n.delete(item.path) : n.add(item.path); return n })}
                  onRemove={() => setItems(list => list.filter(i => i.path !== item.path))}
                  onRetry={() => { patch(item.path, { status: 'waiting', report: undefined }); void run([item.path]) }} />
              ))}
            </ul>}
          <div className="vf-check">
            <Checkbox size="sm" checked={turnOff} isDisabled={busy} disabled={busy} onChange={(v: boolean) => { setTurnOff(v); localStorage.setItem(TURN_OFF, v ? '1' : '0') }}>
              Turn off the originals
            </Checkbox>
            <p className="vf-hint">Each update goes beside its original, on or off like it, and takes its place in your loadouts.</p>
          </div>
        </section>

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
            {!advanced && <span className={`ia-on${behind ? ' is-warn' : ''}`}>{behind ? 'USMAP older than the game' : `USMAP ${usmapState.toLowerCase()}`}{logs.length ? ` · ${plural(logs.length, 'log line')}` : ''}</span>}
          </button>
          <div className="t-acc-panel" data-open={advanced}>
            <div className="t-acc-panel-inner" {...folded(!advanced)}>
              <div className="vf-adv-body">
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
        {done > 0 && !busy && <button type="button" className="lo-text-btn" onClick={() => copy('report')}><Copy size={14} /> {copied === 'report' ? 'Copied' : 'Copy report'}</button>}
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
