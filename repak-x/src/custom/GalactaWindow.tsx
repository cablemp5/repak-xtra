// repakxtra: the Galacta Converter window (route galacta), built like the Encrypt window (EncryptWindow.tsx) from the same
// parts: search, hero filter and sort over folding groups of ticked rows, and a footer with what the button does. Each
// ticked mod gets a second copy, "<name> (Galacta)", that Project Galacta can swap in per skin (xtra_galacta.rs). The
// copy goes beside the mod, off, and the original stays as it is. The main window opens it (GalactaMods.tsx).
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { AlertTriangle, ChevronRight, Info, Search, Square, X } from 'lucide-react'
import TitleBar from '../components/TitleBar'
import Checkbox from '../components/ui/Checkbox'
import { useGlobalTooltips } from '../hooks/useGlobalTooltips'
import { HeroFilter, heroOfName } from './heroFilter'
import { usmapPath } from './ko/load'
import { canonKey } from './loadoutIdentity'
import { modKey, useLoadouts } from './loadoutStore'
import { plural } from './modName'
import { Num } from './motion'
import { openLoadoutInMain } from './vfx/handoff'
import { GalactaLogo } from './GalactaMods'
import GalactaWelcome, { welcomeOnOpen } from './GalactaWelcome'
import './vfx/vfx.css'
import './support.css'

type Mod = { path: string; name: string; enabled: boolean; hero: string; modified: number; kind: 'mesh' | 'texture'; made: boolean }
type Listed = Omit<Mod, 'hero'> & { hero?: string | null }
type Made = { path: string; skins: string[]; leftOut: number; note?: string | null }
type Run = { status: 'waiting' | 'running' | 'done' | 'failed'; error?: string; made?: Made }

const SORT = 'repakxtra.galacta.sort'
const FOLDED = 'repakxtra.galacta.folded'
const SWAP = 'repakxtra.galacta.swap' // on unless switched off: '0'
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()

/** A group of mods that folds to its heading, with Select all and Clear: the Encrypt window's. */
function Group({ title, count, open, onFold, all, none, busy, onPick, done, children }: {
  title: string; count: number; open: boolean; onFold: () => void; all: boolean; none: boolean; busy: boolean; onPick: (on: boolean) => void; done?: boolean; children: React.ReactNode
}) {
  // done: the Converted group, green like the Mod Updater's Updated (vfx.css .vf-grp.is-done)
  return (
    <section className={`vf-grp${done ? ' is-done' : ''}${open ? '' : ' is-folded'}`}>
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
      <div className="t-acc-panel" data-open={open}><div className="t-acc-panel-inner" {...(open ? {} : { inert: true }) as object}>{children}</div></div>
    </section>
  )
}

function GalactaPanel() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<string[]>([])
  const [cancelling, setCancelling] = useState(false)
  const [q, setQ] = useState('')
  const [hero, setHero] = useState('')
  const [sort, setSort] = useState<'newest' | 'name'>(() => (localStorage.getItem(SORT) === 'name' ? 'name' : 'newest'))
  const [foldedIds, setFoldedIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(FOLDED) ?? '[]') } catch { return [] } })
  const [swap, setSwap] = useState(() => localStorage.getItem(SWAP) !== '0')
  const [welcome, setWelcome] = useState(welcomeOnOpen)
  const stopRef = useRef(false)
  const busyRef = useRef(false)
  busyRef.current = busy
  const loadouts = useLoadouts()

  // a mod toggled, installed or removed anywhere: read the list again (a run reads it after)
  useEffect(() => {
    const un = listen('mods_dir_changed', () => { if (!busyRef.current) setReload(n => n + 1) })
    return () => { void un.then(off => off()) }
  }, [])

  useEffect(() => {
    if (busy) return
    let live = true
    setLoadError(null)
    invoke<Listed[]>('xtra_galacta_list')
      .then(list => {
        if (!live) return
        const fresh = list.map(m => ({ ...m, hero: heroOfName(m.hero ?? '') }))
        setMods(fresh)
        const now = new Set(fresh.map(m => norm(m.path)))
        setPicked(p => new Set([...p].filter(k => now.has(k))))
      })
      .catch(e => { if (live) { setLoadError(String(e)); setMods(m => m ?? []) } })
    return () => { live = false }
  }, [busy, reload])

  const all = mods ?? []
  const needle = q.trim().toLowerCase()
  const order = (a: Mod, b: Mod) => (sort === 'newest' ? b.modified - a.modified : 0) || a.name.localeCompare(b.name)
  const heroes = [...new Set(all.map(m => m.hero).filter(Boolean))].sort()
  const shown = all.filter(m => (!needle || m.name.toLowerCase().includes(needle) || m.hero.toLowerCase().includes(needle)) && (!hero || m.hero === hero)).sort(order)
  // converted mods (their Galacta version is beside them) get their own group, like the Mod Updater's Updated. Rows move
  // there when the list is read again after a run, never in the middle of one
  const groups = [
    { id: 'mesh', title: 'Mesh mods', mods: shown.filter(m => m.kind === 'mesh' && !m.made) },
    { id: 'texture', title: 'Texture mods', mods: shown.filter(m => m.kind === 'texture' && !m.made) },
    { id: 'converted', title: 'Converted', mods: shown.filter(m => m.made) },
  ]
  const fold = (id: string) => setFoldedIds(f => { const n = f.includes(id) ? f.filter(x => x !== id) : [...f, id]; localStorage.setItem(FOLDED, JSON.stringify(n)); return n })
  const pick = (keys: string[], on: boolean) => setPicked(p => { const n = new Set(p); keys.forEach(k => (on ? n.add(k) : n.delete(k))); return n })
  const inLoadouts = (m: Mod) => { const k = canonKey(modKey(m.path)); return loadouts.filter(l => l.on.some(x => canonKey(x) === k)).map(l => ({ id: l.id, name: l.name })) }
  const byKey = new Map(all.map(m => [norm(m.path), m]))
  const todo = [...picked].filter(k => byKey.has(k))
  const hiddenTicked = todo.filter(k => !shown.some(m => norm(m.path) === k)).length

  // one mod at a time, so each row shows its own state and Cancel stops after the one in flight
  const run = async (keys = todo) => {
    if (busy || !keys.length) return
    stopRef.current = false
    setBatch(keys)
    setBusy(true)
    setRuns(r => ({ ...r, ...Object.fromEntries(keys.map(k => [k, { status: 'waiting' } as Run])) }))
    let changed = false
    let usmap: string | null = null
    for (const k of keys) {
      if (stopRef.current) { setRuns(r => { const n = { ...r }; keys.filter(x => n[x]?.status === 'waiting').forEach(x => delete n[x]); return n }); break }
      setRuns(r => ({ ...r, [k]: { status: 'running' } }))
      try {
        usmap ??= await usmapPath()
        const m = byKey.get(k)!
        const made = await invoke<Made>('xtra_galacta_make', { path: m.path, name: m.name, usmapPath: usmap, on: swap })
        changed = true // with swap on, the backend also turned the original off (xtra_galacta.rs)
        setRuns(r => ({ ...r, [k]: { status: 'done', made } }))
        setPicked(p => { const n = new Set(p); n.delete(k); return n })
      } catch (e) { setRuns(r => ({ ...r, [k]: { status: 'failed', error: String(e) } })) }
    }
    if (changed) await emit('mods_dir_changed').catch(() => {})
    setCancelling(false)
    setBusy(false)
  }
  const stop = () => { stopRef.current = true; setCancelling(true) }

  const runsNow = Object.entries(runs)
  const runningAt = batch.findIndex(k => runs[k]?.status === 'running')
  const running = runningAt >= 0 ? byKey.get(batch[runningAt]) : undefined
  const done = runsNow.filter(([, r]) => r.status === 'done').length
  const failed = runsNow.filter(([, r]) => r.status === 'failed').map(([k]) => k)
  const state = cancelling ? 'Stopping. The mod in progress finishes first.'
    : busy ? `Converting ${runningAt + 1} of ${batch.length}${running ? `: ${running.name}` : '…'}`
    : ''

  return (
    <div className="vf-panel gal-panel">
      {welcome && <GalactaWelcome onClose={() => setWelcome(false)} />}
      <div className="vf-body">
        <div className="lp-filters vf-filters">
          <label className="lp-search vf-search">
            <Search size={15} aria-hidden="true" />
            <input value={q} placeholder="Search mods" aria-label="Search mods" onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQ('') }} />
            {q && <button type="button" className="lo-icon vf-search-clear" onClick={() => setQ('')} aria-label="Clear the search" title="Clear the search"><X size={14} /></button>}
          </label>
          <HeroFilter heroes={heroes} value={hero} onChange={setHero} always={mods === null} />
          <div className="mod-state-filter lp-sort" role="group" aria-label="Sort mods">
            <button type="button" aria-pressed={sort === 'newest'} onClick={() => { setSort('newest'); localStorage.setItem(SORT, 'newest') }}>Newest</button>
            <button type="button" aria-pressed={sort === 'name'} onClick={() => { setSort('name'); localStorage.setItem(SORT, 'name') }}>A to Z</button>
          </div>
          <button type="button" className="su-link gal-about" onClick={() => setWelcome(true)} title="What Project Galacta is and what converting does"><Info size={14} aria-hidden="true" />About</button>
        </div>
        {loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>The mods folder could not be read. {loadError.replace(/[.!]?\s*$/, '.')}{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {mods === null
          ? <p className="lp-empty" aria-live="polite">Reading the mods folder…</p>
          : shown.length === 0
            ? <p className="lp-empty">{needle || hero ? `No mods match${needle ? ` “${q.trim()}”` : ''}${hero ? ` for ${hero}` : ''}.` : 'No mesh or texture mods in the mods folder.'}</p>
            : <div className="vf-groups">{groups.map(g => {
                const keys = g.mods.map(m => norm(m.path))
                return g.mods.length > 0 && (
                  <Group key={g.id} title={g.title} count={g.mods.length} busy={busy} done={g.id === 'converted'}
                    all={keys.every(k => picked.has(k))} none={!keys.some(k => picked.has(k))}
                    open={Boolean(needle || hero) || !foldedIds.includes(g.id)} onFold={() => fold(g.id)} onPick={on => pick(keys, on)}>
                    <ul className="mod-rows vf-rows">
                      {g.mods.map(m => {
                        const key = norm(m.path), r = runs[key], lo = inLoadouts(m)
                        return (
                          <li key={key} className={`mod-row vf-row${r ? ` is-${r.status}` : ''}${picked.has(key) ? ' is-picked' : ''}`}>
                            <Checkbox size="sm" className="vf-pick" checked={picked.has(key)} isDisabled={busy} disabled={busy} onChange={(v: boolean) => pick([key], v)}>
                              <span className={`vf-row-name${r?.status === 'running' ? ' t-shimmer' : ''}`} title={m.path}>{m.name}</span>
                              {m.enabled && <span className="on-dot" role="img" aria-label="On now" title="This mod is on now" />}
                            </Checkbox>
                            {lo.length > 0 && (
                              <button type="button" className="vf-loadouts" onClick={() => void openLoadoutInMain(lo[0].id)}
                                title={`Open ${lo[0].name}${lo.length > 1 ? `. Also in ${lo.slice(1).map(l => l.name).join(', ')}` : ''}`}>
                                <i>In</i><span>{lo[0].name}</span>{lo.length > 1 && <b>{' '}+{lo.length - 1}</b>}
                              </button>
                            )}
                            {r?.status === 'running' && <span className="vf-pill is-running enc-pill">Converting</span>}
                            {r?.status === 'waiting' && <span className="vf-status">Queued</span>}
                            {(r?.status === 'done' || (!r && m.made)) && <span className="vf-pill is-fixed enc-pill" title={`${m.name} (Galacta) is beside it in the Library`}>Converted</span>}
                            {r?.made?.note && <p className="setting-warn vf-row-panel gal-note"><AlertTriangle size={14} aria-hidden="true" /><span>{r.made.note}</span></p>}
                            {r?.made && r.made.leftOut > 0 && <p className="vf-note vf-row-panel enc-error">{plural(r.made.leftOut, 'file')} left out: Galacta swaps only the gameplay mesh, so lobby meshes, VFX, sounds, and UI stay in the original.</p>}
                            {r?.status === 'failed' && <>
                              <span className="vf-pill is-failed enc-pill"><AlertTriangle size={12} className="vf-pill-icon" aria-hidden="true" />Failed</span>
                              <p className="vf-note vf-row-panel enc-error">{r.error}</p>
                            </>}
                          </li>
                        )
                      })}
                    </ul>
                  </Group>
                )
              })}</div>}
      </div>

      <footer className="vf-foot">
        <p className="vf-state">
          {state || (runsNow.length && !busy
            ? <>{done ? `${plural(done, 'mod')} converted. ${swap ? 'They are on and in Galacta’s skin list. Pick one in game with P on that skin.' : 'Turn one on, then open the Galacta Companion App so it lists it.'}` : ''}{failed.length > 0 && <>{done ? ' ' : ''}{plural(failed.length, 'mod')} failed.{' '}
                <button type="button" className="su-link" onClick={() => void run(failed)}>Try again</button></>}</>
            : <>
                {hiddenTicked > 0 && <span className="vf-hidden-line"><b className="vf-hidden-n">{hiddenTicked} ticked {hiddenTicked === 1 ? 'mod is' : 'mods are'} hidden by the filter.</b>{' '}
                  <button type="button" className="su-link" onClick={() => { setQ(''); setHero('') }}>Show {hiddenTicked === 1 ? 'it' : 'them'}</button></span>}
                {swap ? 'Each mod gets a copy, “<name> (Galacta)”, turned on in its place. The original is turned off, not changed.' : 'Each mod gets a copy, “<name> (Galacta)”, left off. The original stays as it is.'}
              </>)}
        </p>
        <span className="xtra-sr-only" aria-live="polite">{busy || cancelling ? state : ''}</span>
        <Checkbox size="sm" className="gal-swap" checked={swap} isDisabled={busy} disabled={busy} onChange={(v: boolean) => { setSwap(v); localStorage.setItem(SWAP, v ? '1' : '0') }}>
            <span title="Off: the Galacta version is made off, and the original stays as it is">Turn the original off, the Galacta version on</span>
        </Checkbox>
        <div className="vf-foot-actions">
          {busy && <button type="button" className="lo-text-btn" disabled={cancelling} onClick={stop} title="Stops after the mod in progress"><Square size={12} fill="currentColor" aria-hidden="true" />{cancelling ? 'Stopping' : 'Stop'}</button>}
          {/* while it runs: the Nexus Mods and KO Editor Install buttons' look, quiet with its words shimmering */}
          <button type="button" className={`btn-primary${busy ? ' is-working' : ''}`} disabled={busy || !todo.length} onClick={() => void run()}>
            {busy ? <span className="t-text-in"><span className="t-shimmer">Converting</span></span>
              : <><GalactaLogo size={14} />{todo.length ? <>Convert <Num id="gal-todo" value={todo.length} /> {todo.length === 1 ? 'mod' : 'mods'}</> : 'Convert'}</>}
          </button>
        </div>
      </footer>
    </div>
  )
}

export default function GalactaWindow() {
  useGlobalTooltips()
  // nothing starts focused when the window opens (no ring or tooltip on the first button), Tab still starts at the top
  useEffect(() => { (document.activeElement as HTMLElement | null)?.blur() }, [])
  return (
    <div className="vfx-window-container vf-window">
      <TitleBar title="Galacta Converter" hideMaximize={true} />
      <GalactaPanel />
    </div>
  )
}
