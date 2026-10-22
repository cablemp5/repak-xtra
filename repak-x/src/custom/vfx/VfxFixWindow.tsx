// repakxtra: the VFX window (route vfx-updater), replacing the upstream VFX Updater's panel: Fix VFX mods for one mod or a
// queue of them (pipeline.ts). Each mod shows its step and live progress while it runs, then its report: what was
// rebuilt, what was kept and why, and where the fix went (beside the original, which goes off). A failed or cancelled
// mod can be retried. Cancel waits for the step in flight (UAssetTool cannot be interrupted) and says so. The main
// window hands mods over (handoff.ts) and swaps the originals for the fixes in loadouts (VfxNotice.tsx).
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { AlertTriangle, Check, ChevronDown, Copy, Plus, RotateCcw, X } from 'lucide-react'
import TitleBar from '../../components/TitleBar'
import Checkbox from '../../components/ui/Checkbox'
import { MatrixLoader, Num, SwapText } from '../motion'
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
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const modName = (p: string) => fileName(p).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '')
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`
/** A folded panel's content: out of reach of Tab and screen readers (React 18 types lack inert). */
const folded = (hidden: boolean) => (hidden ? { inert: '' } : {}) as object
const usmapCl = (name?: string | null) => Number(name?.match(/-(\d{6,})\+/)?.[1]) || null

const CHIP: Record<Status, string> = { waiting: 'Waiting', running: 'Working', fixed: 'Fixed', nothing: 'Nothing to fix', failed: 'Failed', cancelled: 'Cancelled' }
const KIND_ORDER: AssetKind[] = ['failed', 'unreadable', 'added', 'updated', 'same', 'passed']
const KIND_LABEL: Record<AssetKind, string> = { updated: 'Rebuilt', same: 'Match the game', added: 'The mod\'s own', passed: 'Kept as they were', unreadable: 'Could not be read', failed: 'Not fixed' }

/** One mod's report as plain text, for Copy report. */
function reportText(r: VfxReport) {
  const lines = [`${r.name}: ${CHIP[r.status as Status] ?? r.status}${r.error ? `. ${r.error}` : ''}`]
  if (r.output) lines.push(`  Saved as ${fileName(r.output)}${r.placed?.turnedOff ? ', the original is off' : ''}${r.placed?.replaced ? ', the previous fix is in Recently deleted' : ''}`)
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
      {r.status === 'fixed' && <p className="vf-line is-ok"><Check size={14} strokeWidth={2.5} aria-hidden="true" />
        Rebuilt {plural(r.counts.updated, 'asset')} with {plural(r.counts.changes, 'edit')}. Saved as {fileName(r.output ?? '')}
        {r.placed ? (r.placed.turnedOff ? ', and the original is off.' : '.') : '.'}{r.placed?.replaced ? ' The previous fix is in Recently deleted.' : ''}</p>}
      {r.status !== 'fixed' && r.error && <p className="vf-line">{r.error}</p>}
      {r.status === 'failed' || r.status === 'cancelled'
        ? <p className="vf-line"><button type="button" className="su-link" disabled={busy} onClick={onRetry}><RotateCcw size={12} aria-hidden="true" /> Try again</button></p>
        : null}
      {r.warnings.length > 0 && <ul className="vf-warnings" aria-label="Warnings">
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
        {r.warnings.length > 4 && <li className="vf-more"><button type="button" className="su-link" onClick={() => setAllWarnings(v => !v)}>{allWarnings ? 'Show fewer' : `Show all ${r.warnings.length}`}</button></li>}
      </ul>}
      {groups.length > 0 && <>
        <p className="vf-line vf-counts">
          {groups.map(([k, list]) => <span key={k} className={`vf-count is-${k}`}>{KIND_LABEL[k]} <b>{list.length.toLocaleString()}</b></span>)}
          <span className="vf-time">{(r.ms / 1000).toFixed(1)} s</span>
          <button type="button" className="su-link vf-assets-toggle" aria-expanded={assets} onClick={() => setAssets(v => !v)}>{assets ? 'Hide assets' : 'Show assets'}</button>
        </p>
        <div className="t-acc-panel" data-open={assets}>
          <div className="t-acc-panel-inner" {...folded(!assets)}>
            {assets && groups.map(([k, list]) => (
              <div key={k} className="vf-group">
                <h4>{KIND_LABEL[k]} <span>{list.length.toLocaleString()}</span></h4>
                <ul>{list.map(a => <li key={a.path}><span className="vf-asset">{a.name}</span><span className="vf-detail">{a.detail}</span></li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </>}
    </div>
  )
}

function Row({ item, open, onToggle, onRemove, onRetry, busy }: { item: Item; open: boolean; onToggle: () => void; onRemove: () => void; onRetry: () => void; busy: boolean }) {
  const running = item.status === 'running'
  return (
    <li className={`vf-item is-${item.status}`}>
      <div className="vf-item-head">
        <button type="button" className="vf-item-name" onClick={onToggle} aria-expanded={open} disabled={!item.report} title={item.path}>
          <span>{modName(item.path)}</span>
          {item.report && <ChevronDown size={14} className="vf-caret" aria-hidden="true" />}
        </button>
        <span className={`su-chip vf-chip is-${item.status}`}>{running && <MatrixLoader size={10} />}<SwapText text={CHIP[item.status]} /></span>
        {!running && !busy && <button type="button" className="vf-remove" onClick={onRemove} aria-label={`Remove ${modName(item.path)} from the list`} title="Remove from the list"><X size={14} /></button>}
      </div>
      {running && item.step ? (
        <div className="vf-progress">
          <div className="vf-track" aria-hidden="true">{STEPS.map((_, i) => <i key={i} className={i + 1 < item.step! ? 'is-done' : i + 1 === item.step ? 'is-on' : ''} />)}</div>
          <p className="vf-step" aria-live="polite"><SwapText text={`Step ${item.step} of ${STEPS.length}: ${STEPS[item.step - 1]}`} />{item.sub ? <span className="vf-sub">{item.sub}</span> : null}</p>
        </div>
      ) : null}
      {item.report && <div className="t-acc-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}><Report r={item.report} onRetry={onRetry} busy={busy} /></div></div>}
    </li>
  )
}

function ColorNames() {
  const [open, setOpen] = useState(false)
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
    <section className="su-card vf-names">
      <button type="button" className="vf-names-head" aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span><h3>Color names</h3><p>Which colors of blueprints and data tables carry over. Material parameters always do, except excluded names.</p></span>
        <span className="vf-names-state">{custom ? 'Custom' : 'Default'}<ChevronDown size={14} className="vf-caret" aria-hidden="true" /></span>
      </button>
      <div className="t-acc-panel" data-open={open}>
        <div className="t-acc-panel-inner vf-names-body" {...folded(!open)}>
          <label>Carry names containing<input value={text.includes} onChange={e => save({ ...text, includes: e.target.value })} spellCheck={false} /></label>
          <label>Never carry names containing<input value={text.excludes} onChange={e => save({ ...text, excludes: e.target.value })} spellCheck={false} /></label>
          <p className="su-meta">Separate words with commas. Case does not matter.{custom && <> <button type="button" className="su-link" onClick={reset}>Reset to defaults</button></>}</p>
        </div>
      </div>
    </section>
  )
}

export function VfxFixPanel() {
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
  const [logs, setLogs] = useState<Log[]>([])
  const [logOpen, setLogOpen] = useState(false)
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

  // Rust steps report inside the step (types read so far, extraction)
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

  const lock = busy ? null : checking ? 'Checking for the latest USMAP…' : !usmap ? 'Choose a USMAP file' : usmapOk === false ? 'The USMAP file is missing. Fetch it or browse for one.' : !paks ? 'Set the game folder in Setup first' : null

  const run = useCallback(async (paths?: string[]) => {
    const todo = (paths ?? itemsRef.current.filter(i => i.status !== 'fixed' && i.status !== 'nothing').map(i => i.path))
    if (!todo.length || !usmap || !paks) return
    setBusy(true); cancel.current = false
    const filter = readFilter()
    let fixed = 0, failed = 0
    for (const path of todo) {
      if (cancel.current) break
      patch(path, { status: 'running', step: 1, sub: undefined, report: undefined })
      addLog(`Fixing ${modName(path)}`)
      const r = await fixVfxMod({
        modPath: path, usmapPath: usmap, gamePaksPath: paks, turnOffOriginal: turnOff, filter,
        log: addLog, cancelled: () => cancel.current,
        onStep: s => patch(path, { step: s.step, sub: undefined }),
        onProgress: (_, __, message) => patch(path, { sub: message }),
      })
      patch(path, { status: r.status, report: r, sub: undefined })
      if (r.status === 'fixed') fixed++
      if (r.status === 'failed') failed++
      if (r.status !== 'fixed' || todo.length === 1) setOpen(o => new Set(o).add(path)) // problems open, a batch's fixes stay folded
      if (r.placed) await emitTo('main', FIXED_EVENT, { from: r.placed.original, to: r.placed.fixed, swap: turnOff } satisfies Fixed).catch(() => {})
    }
    if (fixed) await emit('mods_dir_changed').catch(() => {})
    cue(failed ? 'error' : 'success', { emphasis: 'subtle' })
    setBusy(false); setCancelling(false)
  }, [usmap, paks, turnOff, addLog])

  // the notice's Fix VFX mods starts as soon as the USMAP is ready
  useEffect(() => {
    if (pendingStart.current && !lock && !busy && items.some(i => i.status === 'waiting')) { pendingStart.current = false; void run() }
  }, [lock, busy, items, run])

  const stop = () => { cancel.current = true; setCancelling(true); addLog('Cancelling after the current step…', 'warning') }
  const copy = async (what: 'report' | 'log') => {
    const text = what === 'log' ? logs.map(l => `[${l.time}] ${l.text}`).join('\n') : items.filter(i => i.report).map(i => reportText(i.report!)).join('\n\n')
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(what); setTimeout(() => setCopied(null), 1500)
  }

  const todo = items.filter(i => i.status !== 'fixed' && i.status !== 'nothing').length
  const done = items.filter(i => i.report).length
  const runningAt = items.findIndex(i => i.status === 'running')
  const cl = usmapCl(usmapInfo?.filename ?? (usmap ? fileName(usmap) : null))
  const behind = cl && build?.cl && cl < build.cl

  return (
    <div className="vf-panel">
      <header className="vf-head">
        <div>
          <h1>Fix VFX mods</h1>
          <p className="su-sub">Rebuilds VFX mods on the installed game's files and carries their colors over, so a game update does not break them.</p>
        </div>
      </header>

      <div className="vf-body">
        <section className="su-card">
          <div className="su-card-head">
            <div><h3>USMAP</h3><p>The game's property layout. repakxtra keeps the newest one from rivals-depot.</p></div>
            <span className={`su-chip ${usmapOk ? 'is-installed' : 'is-missing'}`}>{checking ? 'Checking…' : usmapOk ? (usmapInfo?.upToDate || usmapInfo?.updated ? 'Up to date' : 'Ready') : 'Missing'}</span>
          </div>
          <ul className="su-parts">
            <li className="su-part">
              <div className="su-part-text">
                <strong title={usmap ?? undefined}>{usmap ? fileName(usmap) : 'No USMAP chosen'}</strong>
                <span>{[usmapInfo?.version, usmapInfo?.commitDate].filter(Boolean).join(' · ') || 'From rivals-depot or a file'}</span>
              </div>
              <span className="su-part-links">
                <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)} title="Download the newest USMAP from rivals-depot and use it">Fetch latest</button>
                <button type="button" className="su-link" disabled={busy} onClick={browseUsmap}>Browse…</button>
              </span>
            </li>
          </ul>
          {behind ? <p className="su-note vf-behind"><AlertTriangle size={13} aria-hidden="true" /> The newest USMAP ({cl}) is older than the game ({build!.cl}). Fixes usually still work after a small update. If they fail, wait for rivals-depot to publish a newer one.</p> : null}
        </section>

        <section className="su-card">
          <div className="su-card-head">
            <div><h3>Mods</h3><p>{items.length ? `${plural(items.length, 'mod')}${busy && runningAt >= 0 ? `, fixing ${runningAt + 1} of ${items.length}` : done ? `, ${done} done` : ''}` : 'Add .utoc mods, or use Fix VFX mods in the Library after a game update.'}</p></div>
            <button type="button" className="lo-text-btn" disabled={busy} onClick={browseMods}><Plus size={14} /> Add mods</button>
          </div>
          {items.length > 0 && <ul className="vf-list">
            {items.map(item => (
              <Row key={item.path} item={item} busy={busy} open={open.has(item.path)}
                onToggle={() => setOpen(o => { const n = new Set(o); n.has(item.path) ? n.delete(item.path) : n.add(item.path); return n })}
                onRemove={() => setItems(list => list.filter(i => i.path !== item.path))}
                onRetry={() => { patch(item.path, { status: 'waiting', report: undefined }); void run([item.path]) }} />
            ))}
          </ul>}
          <div className="vf-options">
            <Checkbox size="sm" checked={turnOff} isDisabled={busy} disabled={busy} onChange={(v: boolean) => { setTurnOff(v); localStorage.setItem(TURN_OFF, v ? '1' : '0') }}>
              Turn off the originals (loadouts switch to the fixed mods)
            </Checkbox>
          </div>
        </section>

        <ColorNames />

        <section className="su-card vf-log">
          <button type="button" className="vf-names-head" aria-expanded={logOpen} onClick={() => setLogOpen(v => !v)}>
            <span><h3>Log</h3><p>{logs.length ? logs[logs.length - 1].text : 'Nothing yet.'}</p></span>
            <ChevronDown size={14} className="vf-caret" aria-hidden="true" />
          </button>
          <div className="t-acc-panel" data-open={logOpen}>
            <div className="t-acc-panel-inner" {...folded(!logOpen)}>
              <div className="vf-log-lines" role="log">{logs.map((l, i) => <div key={i} className={`is-${l.type}`}><span>{l.time}</span> {l.text}</div>)}</div>
            </div>
          </div>
        </section>
      </div>

      <footer className="vf-foot">
        <button type="button" className="lo-text-btn" disabled={!logs.length} onClick={() => copy('log')}><Copy size={14} /> {copied === 'log' ? 'Copied' : 'Copy log'}</button>
        {done > 0 && <button type="button" className="lo-text-btn" onClick={() => copy('report')}><Copy size={14} /> {copied === 'report' ? 'Copied' : 'Copy report'}</button>}
        <span className="vf-lock" aria-live="polite">{cancelling ? 'Cancelling. The current step finishes first.' : lock}</span>
        {busy
          ? <button type="button" className="lo-text-btn" disabled={cancelling} onClick={stop} aria-label="Cancel fixing">{cancelling ? 'Cancelling…' : 'Cancel'}</button>
          : <button type="button" className="btn-primary" disabled={Boolean(lock) || !todo} onClick={() => run()}>
              {todo ? <>Fix <Num id="vf-todo" value={todo} /> {todo === 1 ? 'mod' : 'mods'}</> : 'Fix'}
            </button>}
      </footer>
    </div>
  )
}

export default function VfxFixWindow() {
  return (
    <div className="vfx-window-container vf-window">
      <TitleBar title="Fix VFX mods" hideMaximize={true} />
      <VfxFixPanel />
    </div>
  )
}
