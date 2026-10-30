// repakxtra: the Encrypt window (route encrypt), built like the VFX Updater's (custom/vfx/VfxUpdaterWindow.tsx) from the same
// parts: search, hero filter and sort over folding groups of ticked rows, and a footer with what the button does. Each ticked
// mod is encrypted in turn (xtra_encrypt.rs), so its row shows when it is running and how it ended. A mod keeps its name and
// its on or off state, and its original goes to encryption-backups. The main window hands mods over (openEncrypt: the
// Library's right-click Encrypt), and hears mods_dir_changed after a run.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { open as choose } from '@tauri-apps/plugin-dialog'
import { AlertTriangle, ChevronRight, FilePlus, Lock, Search, X } from 'lucide-react'
import TitleBar from '../components/TitleBar'
import Checkbox from '../components/ui/Checkbox'
import { useGlobalTooltips } from '../hooks/useGlobalTooltips'
import { HeroFilter, heroOfName } from './heroFilter'
import { canonKey } from './loadoutIdentity'
import { loadoutable, modKey, useLoadouts } from './loadoutStore'
import { plural } from './modName'
import { Num } from './motion'
import { openLoadoutInMain } from './vfx/handoff'
import './vfx/vfx.css'
import './support.css'

type Mod = { path: string; name: string; enabled: boolean; hero: string; modified: number; encrypted: boolean }
type Listed = { path: string; customName?: string | null; enabled: boolean; hero?: string | null; modified: number; encrypted: boolean }
type Run = { status: 'waiting' | 'running' | 'done' | 'failed'; error?: string }
type Result = { Ok: { path: string; backup: string } } | { Err: string }

const KEY = 'repakxtra-encrypt:queue' // not a repakxtra.* key: devStorage would copy it to the shared file
const SORT = 'repakxtra.encrypt.sort'
const FOLDED = 'repakxtra.encrypt.folded'
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const bare = (p: string) => fileName(p).replace(/\.[^.]+$/, '').replace(/\.pak$/i, '').replace(/(_\d+)?_P$/i, '')
const chosen = (path: string): Mod => ({ path, name: bare(path), enabled: !/\.(bak_repak|pak_disabled)$/i.test(path), hero: '', modified: Date.now(), encrypted: false }) // read as not encrypted until the list reads it

/** Opens the Encrypt window, or brings it forward. */
async function openWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existing = await WebviewWindow.getByLabel('encrypt')
  if (existing) { await existing.unminimize().catch(() => {}); await existing.setFocus(); return }
  const w = new WebviewWindow('encrypt', { url: '/encrypt', title: 'Encrypt', width: 760, height: 820, minWidth: 600, minHeight: 560, center: true, resizable: true, decorations: false })
  w.once('tauri://error', e => console.error('[Encrypt] Failed to create window:', e))
}

/** Opens the Encrypt window with these mods ticked (none: just opens it). */
export async function openEncrypt(paths: string[] = []) {
  if (paths.length) localStorage.setItem(KEY, JSON.stringify({ paths, at: Date.now() }))
  await openWindow()
}

function takeHandoff(): string[] {
  const raw = localStorage.getItem(KEY)
  if (!raw) return []
  localStorage.removeItem(KEY)
  try { const h = JSON.parse(raw); return Array.isArray(h?.paths) ? h.paths.filter((p: unknown) => typeof p === 'string') : [] } catch { return [] }
}

/** A group of mods that folds to its heading, with Select all and Clear: the VFX Updater's. */
function Group({ title, count, open, onFold, all, none, busy, onPick, children }: {
  title: string; count: number; open: boolean; onFold: () => void; all: boolean; none: boolean; busy: boolean; onPick: (on: boolean) => void; children: React.ReactNode
}) {
  return (
    <section className={`vf-grp${open ? '' : ' is-folded'}`}>
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

function EncryptPanel() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [added, setAdded] = useState<Mod[]>([])
  const addedRef = useRef(added)
  addedRef.current = added
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scan, setScan] = useState<{ done: number; total: number } | null>(null)
  const [reload, setReload] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [runs, setRuns] = useState<Record<string, Run>>({})
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<string[]>([])
  const [cancelling, setCancelling] = useState(false)
  const [gameOpen, setGameOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hero, setHero] = useState('')
  const [sort, setSort] = useState<'newest' | 'name'>(() => (localStorage.getItem(SORT) === 'name' ? 'name' : 'newest'))
  const [foldedIds, setFoldedIds] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(FOLDED) ?? '[]') } catch { return [] } })
  const stopRef = useRef(false)
  const busyRef = useRef(false)
  busyRef.current = busy
  const loadouts = useLoadouts()

  // mods handed over by the main window are the Library's, so they are only ticked (the list read shows them); files
  // from Add files are listed too, as the Library does not have them
  const take = (paths: string[], files = false) => {
    if (!paths.length) return
    if (files) setAdded(a => [...a, ...paths.filter(p => !a.some(m => norm(m.path) === norm(p))).map(chosen)])
    setPicked(p => new Set([...p, ...paths.map(norm)]))
    setReload(n => n + 1) // the Library's names now: a mod toggled since the last read was renamed
    // a right-click Encrypt opens Not encrypted, where those mods are, even when it was folded
    setFoldedIds(f => { if (!f.includes('plain')) return f; const n = f.filter(id => id !== 'plain'); localStorage.setItem(FOLDED, JSON.stringify(n)); return n })
  }
  useEffect(() => {
    take(takeHandoff())
    const listener = (e: StorageEvent) => { if (e.key === KEY && e.newValue) take(takeHandoff()) }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }, [])

  // a mod toggled, installed or removed anywhere: read the list again, as the VFX Updater does (a run reads it after)
  useEffect(() => {
    const un = listen('mods_dir_changed', () => { if (!busyRef.current) setReload(n => n + 1) })
    return () => { void un.then(off => off()) }
  }, [])

  // the Library's mods (Project Galacta and the Sigeon loader left out, as the Library leaves them out), again after a run
  useEffect(() => {
    if (busy) return
    let live = true
    setLoadError(null)
    const progress = listen<{ done: number; total: number }>('encrypt_list_progress', e => { if (live) setScan(e.payload) })
    invoke<Listed[]>('xtra_encrypt_list')
      .then(list => {
        if (!live) return
        const fresh = list.filter(m => loadoutable(modKey(m.path))).map(m => ({
          path: m.path, name: m.customName || bare(m.path), enabled: m.enabled, hero: heroOfName(m.hero), modified: m.modified, encrypted: m.encrypted,
        }))
        setMods(fresh)
        // the files as they are now: ticks on renamed or removed files go, and an Encrypted result whose file is no
        // longer encrypted (replaced since) goes, so it can be ticked and encrypted again
        const now = new Map(fresh.map(m => [norm(m.path), m]))
        const outside = new Set(addedRef.current.map(m => norm(m.path)))
        setPicked(p => new Set([...p].filter(k => now.has(k) || outside.has(k))))
        setRuns(r => Object.fromEntries(Object.entries(r).filter(([k, v]) => v.status !== 'done' || now.get(k)?.encrypted !== false)))
      })
      .catch(e => { if (live) { setLoadError(String(e)); setMods(m => m ?? []) } })
    invoke<boolean>('check_game_running').then(v => { if (live) setGameOpen(v) }).catch(() => {})
    return () => { live = false; void progress.then(off => off()) }
  }, [busy, reload])

  const all = [...(mods ?? []), ...added.filter(a => !(mods ?? []).some(m => norm(m.path) === norm(a.path)))]
  const needle = q.trim().toLowerCase()
  const order = (a: Mod, b: Mod) => (sort === 'newest' ? b.modified - a.modified : 0) || a.name.localeCompare(b.name)
  const heroes = [...new Set(all.map(m => m.hero).filter(Boolean))].sort()
  const shown = all.filter(m => (!needle || m.name.toLowerCase().includes(needle) || m.hero.toLowerCase().includes(needle)) && (!hero || m.hero === hero)).sort(order)
  // two groups, not encrypted first (what there is to do), then encrypted (cable's pick, 2026-10-28), as the files say
  const groups = [
    { id: 'plain', title: 'Not encrypted', mods: shown.filter(m => !m.encrypted) },
    { id: 'encrypted', title: 'Encrypted', mods: shown.filter(m => m.encrypted) },
  ]
  const fold = (id: string) => setFoldedIds(f => { const n = f.includes(id) ? f.filter(x => x !== id) : [...f, id]; localStorage.setItem(FOLDED, JSON.stringify(n)); return n })
  const pick = (keys: string[], on: boolean) => setPicked(p => { const n = new Set(p); keys.forEach(k => (on ? n.add(k) : n.delete(k))); return n })
  const inLoadouts = (m: Mod) => { const k = canonKey(modKey(m.path)); return loadouts.filter(l => l.on.some(x => canonKey(x) === k)).map(l => ({ id: l.id, name: l.name })) }
  const byKey = new Map(all.map(m => [norm(m.path), m]))
  const todo = [...picked].filter(k => byKey.has(k))
  const hiddenTicked = todo.filter(k => !shown.some(m => norm(m.path) === k)).length

  const addFiles = async () => {
    const files = await choose({ multiple: true, filters: [{ name: 'Mod files', extensions: ['pak', 'utoc', 'bak_repak', 'pak_disabled'] }] }).catch(() => null)
    if (files) take(typeof files === 'string' ? [files] : files, true)
  }

  // one mod at a time, so each row shows its own state and Cancel stops after the one in flight
  const run = async (keys = todo) => {
    if (busy || !keys.length) return
    if (await invoke<boolean>('check_game_running').catch(() => false)) { setGameOpen(true); return }
    setGameOpen(false)
    stopRef.current = false
    setBatch(keys)
    setBusy(true)
    setRuns(r => ({ ...r, ...Object.fromEntries(keys.map(k => [k, { status: 'waiting' } as Run])) }))
    let changed = false
    for (const k of keys) {
      if (stopRef.current) { setRuns(r => { const n = { ...r }; keys.filter(x => n[x]?.status === 'waiting').forEach(x => delete n[x]); return n }); break }
      setRuns(r => ({ ...r, [k]: { status: 'running' } }))
      try {
        const [res] = await invoke<Result[]>('xtra_encrypt_mods', { paths: [byKey.get(k)!.path] })
        const ok = res && 'Ok' in res
        changed ||= ok
        setRuns(r => ({ ...r, [k]: ok ? { status: 'done' } : { status: 'failed', error: res && 'Err' in res ? res.Err : 'Nothing came back' } }))
        if (ok) {
          setPicked(p => { const n = new Set(p); n.delete(k); return n })
          setAdded(a => a.map(m => (norm(m.path) === k ? { ...m, encrypted: true } : m)))
        }
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
  const state = cancelling ? 'Cancelling. The mod in progress finishes first.'
    : busy ? `Encrypting ${runningAt + 1} of ${batch.length}${running ? `: ${running.name}` : '…'}`
    : gameOpen ? 'Close Marvel Rivals to encrypt mods.'
    : ''

  return (
    <div className="vf-panel">
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
          <button type="button" className="lo-text-btn is-primary vf-add" disabled={busy || mods === null} onClick={() => void addFiles()}
            title="Encrypt a mod this list does not show: choose its .pak or .utoc"><FilePlus size={14} aria-hidden="true" /> Add files</button>
        </div>
        {loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>The mods folder could not be read. {loadError.replace(/[.!]?\s*$/, '.')}{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {mods === null
          ? <p className="lp-empty" aria-live="polite">Reading the mods folder{scan ? `: ${scan.done} of ${plural(scan.total, 'mod')}` : '…'}</p>
          : shown.length === 0
            ? <p className="lp-empty">{needle || hero ? `No mods match${needle ? ` “${q.trim()}”` : ''}${hero ? ` for ${hero}` : ''}.` : 'No mods in the mods folder. Add files takes a mod from anywhere.'}</p>
            : <div className="vf-groups">{groups.map(g => {
                const keys = g.mods.map(m => norm(m.path))
                return g.mods.length > 0 && (
                  <Group key={g.id} title={g.title} count={g.mods.length} busy={busy}
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
                            {r?.status === 'running' && <span className="vf-pill is-running enc-pill">Encrypting</span>}
                            {r?.status === 'waiting' && <span className="vf-status">Waiting</span>}
                            {r?.status === 'done' && <span className="vf-pill is-fixed enc-pill">Encrypted</span>}
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
            ? <>{done ? `${plural(done, 'mod')} encrypted. The originals are in encryption-backups.` : ''}{failed.length > 0 && <>{done ? ' ' : ''}{plural(failed.length, 'mod')} failed.{' '}
                <button type="button" className="su-link" onClick={() => void run(failed)}>Try again</button></>}</>
            : <>
                {hiddenTicked > 0 && <span className="vf-hidden-line"><b className="vf-hidden-n">{hiddenTicked} ticked {hiddenTicked === 1 ? 'mod is' : 'mods are'} hidden by the filter.</b>{' '}
                  <button type="button" className="su-link" onClick={() => { setQ(''); setHero('') }}>Show {hiddenTicked === 1 ? 'it' : 'them'}</button></span>}
                {todo.length ? 'Each mod keeps its name and its on or off state, and is harder for others to unpack. Originals go to encryption-backups.' : 'Tick the mods to encrypt'}
              </>)}
        </p>
        <span className="xtra-sr-only" aria-live="polite">{busy || cancelling ? state : ''}</span>
        <div className="vf-foot-actions">
          {busy && <button type="button" className="lo-text-btn" disabled={cancelling} onClick={stop}>{cancelling ? 'Cancelling…' : 'Cancel'}</button>}
          <button type="button" className="btn-primary" disabled={busy || !todo.length} onClick={() => void run()}>
            <Lock size={14} aria-hidden="true" />{busy ? 'Encrypting…' : todo.length ? <>Encrypt <Num id="enc-todo" value={todo.length} /> {todo.length === 1 ? 'mod' : 'mods'}</> : 'Encrypt'}
          </button>
        </div>
      </footer>
    </div>
  )
}

export default function EncryptWindow() {
  useGlobalTooltips()
  return (
    <div className="vfx-window-container vf-window">
      <TitleBar title="Encrypt" hideMaximize={true} />
      <EncryptPanel />
    </div>
  )
}
