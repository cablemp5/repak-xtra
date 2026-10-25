// repakxtra: Home's "Built-in" section (the Library lists them as rows too, custom/builtinRows.ts): the mods repakxtra makes itself from the game's own tables (xtra_builtins.rs),
// Force default skin and Skip startup logos. Each row has the same switch as a loadout card. Force default skin's row
// folds open into the hero picker (the heroes that keep their own skins), applied in one rebuild. The app rebuilds them
// after a game update on its own (refreshBuiltins at start, from App.tsx, and again here once the game closes), so the
// rows only show where each one stands. The switch is the saved choice, the blue icon and the count mean a working build.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, ChevronDown, ChevronRight, RotateCcw, Search, Shirt, TriangleAlert, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { getHeroImageById, useHeroImages } from '../utils/heroImages'
import type { LoadoutProps } from './Loadouts'
import { Num, SwapText, revealOnLoad } from './motion'
import { savedItem } from './storageCarryOver'
import { setView } from './loadoutStore'
import { ClapperboardIcon, PortraitCardIcon, type BuiltinIconComponent } from './PixelIcon'
import { cue } from './sounds'

export type Builtin = { id: string; on: boolean; excluded: string[]; current: boolean; active: boolean; builtAt?: number; summary?: string; heroes: string[]; error?: string; path: string; size: number }

// icon: a pixel-grid drawing (PixelIcon.tsx), sharp at any display scale. A new built-in adds its drawing there
const ABOUT: Record<string, { name: string; what: string; icon: BuiltinIconComponent }> = {
  'force-default-skin': { name: 'Force default skin', what: 'Every hero shows their default skin, in matches and in the lobby', icon: PortraitCardIcon },
  'skip-intro-movies': { name: 'Skip startup logos', what: 'The game opens faster, without the Marvel, NetEase and Unreal Engine logo videos that play each time it starts', icon: ClapperboardIcon },
}
const FOLD_KEY = 'repakxtra.builtins.folded'
const BLOCKED = 'Close Marvel Rivals to change built-in mods'

// one store for every remount: the list, and which ones are building
let list: Builtin[] = []
let busy = new Set<string>()
const listeners = new Set<() => void>()
let snap = { list, busy }
const emit = () => { snap = { list, busy }; listeners.forEach(l => l()) }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const useStore = () => useSyncExternalStore(subscribe, () => snap)
/** The built-ins and which are building, for the Library's rows. */
export const useBuiltins = useStore
export const loadBuiltins = () => load()
export const builtinAbout = (id: string) => ABOUT[id]
/** Its icon where a mod row shows its hero (the Library's rows). */
export function BuiltinIcon({ id }: { id: string }) {
  const Icon = ABOUT[id]?.icon ?? PortraitCardIcon
  const b = useStore().list.find(x => x.id === id)
  // blue on the same terms as its Loadouts screen icon (.bi-item.is-on): a working build, else the quiet gray
  const on = Boolean(b && (b.active || (b.current && b.on)))
  return <span className={`mod-hero-icon-inline builtin-icon${on ? ' is-on' : ''}`} aria-hidden="true"><Icon size={16} /></span>
}
/** Turns one on or off (the Library's switch). */
export const toggleBuiltin = (id: string, on: boolean, alert: LoadoutProps['alert']) => change(id, { on }, alert)

// The Library's Built-in badge: Home opens on that row, unfolded, with Force default skin's hero picker open
let reveal: string | null = null
export function revealBuiltin(id: string) {
  reveal = id
  setView('home')
  emit()
}
const load = () => invoke<Builtin[]>('xtra_builtins_list').then(v => { list = v; emit() }).catch(e => console.warn('[builtins]', e))

/** Rebuild the ones that are on but not current (a game update, a hero change a failed build left behind). Skipped while
 *  the game runs (its files are locked): at start from App.tsx, and from the section once the game closes. */
export async function refreshBuiltins() {
  await load()
  const stale = list.filter(b => b.on && !b.current).map(b => b.id)
  if (!stale.length || busy.size || await invoke<boolean>('check_game_running').catch(() => false)) return
  busy = new Set(stale); emit()
  try { list = await invoke<Builtin[]>('xtra_builtins_refresh') } catch (e) { console.warn('[builtins] refresh', e) }
  busy = new Set(); emit()
}

let watching = false
/** Keeps the built-ins on the installed game build while repakxtra is open: checked at start, whenever the window comes
 *  back into focus (a Steam update while it sat in the background) and once the game closes. Each check only reads file
 *  dates and sizes, and a rebuild runs only when the game changed. */
export function watchBuiltins() {
  void refreshBuiltins()
  if (watching) return
  watching = true
  window.addEventListener('focus', () => { void refreshBuiltins() })
}

async function change(id: string, args: { on?: boolean; excluded?: string[] }, alert: LoadoutProps['alert']) {
  busy = new Set(busy).add(id); emit()
  const name = ABOUT[id].name
  try {
    const before = list.find(b => b.id === id)?.builtAt
    list = await invoke<Builtin[]>('xtra_builtins_set', { id, ...args })
    const after = list.find(b => b.id === id)
    // the done chime only when a build ran: putting kept files back is a plain switch, its click is the sound
    if (after?.current && after.on && after.builtAt !== before) cue('success')
  } catch (e) {
    await load() // a build error is saved on the built-in and shown on its row, anything else (Repak X open) is a toast
    if (list.find(b => b.id === id)?.error !== String(e)) alert.error(`${name} not changed`, String(e))
  }
  busy = new Set([...busy].filter(x => x !== id)); emit()
}

const units = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
const ago = (secs?: number) => {
  if (!secs) return ''
  const d = Date.now() / 1000 - secs
  return d < 90 ? 'just now' : d < 5400 ? units(Math.round(d / 60), 'minute') : d < 129600 ? units(Math.round(d / 3600), 'hour') : units(Math.round(d / 86400), 'day')
}

function status(b: Builtin, building: boolean) {
  if (building) return b.builtAt ? 'Rebuilding from your game files…' : 'Building from your game files…'
  if (!b.on) return ABOUT[b.id].what
  if (b.error) return b.active ? `${b.error}. The last build is still in use` : b.error
  if (b.current) return [b.summary ?? 'Up to date', b.builtAt ? `Built ${ago(b.builtAt)} for this game version` : ''].filter(Boolean).join('. ')
  return 'Waiting to rebuild for this game version'
}

type Hero = { id: string; name: string }

/** The heroes the skin table holds, named from the character data; a hero it lacks a name for still shows by id. */
function useHeroes(ids: string[]) {
  const [named, setNamed] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    invoke<{ id: string; name: string }[]>('get_character_data')
      .then(rows => setNamed(Object.fromEntries(rows.filter(r => /^10\d\d$/.test(r.id)).map(r => [r.id, r.name]))))
      .catch(() => setNamed({}))
  }, [])
  const heroes = useMemo<Hero[]>(() => [...new Set([...ids, ...Object.keys(named ?? {})])]
    .map(id => ({ id, name: named?.[id] ?? `Hero ${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name)), [ids, named])
  return { heroes, loaded: named !== null }
}

/** The hero picker under Force default skin: checked heroes keep their own skins. One tab stop, arrows move between
 *  heroes, Escape clears the search and then closes. Saved while off, applied in one rebuild while on. */
function HeroPicker({ id, b, open, building, blocked, onDone, alert }: { id: string; b: Builtin; open: boolean; building: boolean; blocked: boolean; onDone: () => void; alert: LoadoutProps['alert'] }) {
  useHeroImages()
  const { heroes, loaded } = useHeroes(b.heroes)
  const [kept, setKept] = useState(() => new Set(b.excluded))
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0) // the hero that holds the group's one tab stop
  const grid = useRef<HTMLDivElement>(null)
  // the draft starts from the saved heroes each time it opens: a refresh while it is open (focus, the 10 minute check)
  // keeps the unsaved picks and the search
  useEffect(() => { if (open) { setKept(new Set(b.excluded)); setQuery(''); setAt(0) } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = heroes.filter(h => h.name.toLowerCase().includes(query.trim().toLowerCase()))
  const dirty = kept.size !== b.excluded.length || b.excluded.some(id => !kept.has(id))
  const flip = (id: string) => setKept(k => { const n = new Set(k); if (!n.delete(id)) n.add(id); return n })
  const apply = () => { onDone(); change(b.id, { excluded: [...kept] }, alert) }
  const escape = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (query) setQuery('')
    else onDone()
  }
  const move = (e: React.KeyboardEvent, i: number) => {
    const cols = grid.current ? getComputedStyle(grid.current).gridTemplateColumns.split(' ').length : 1
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: shown.length - 1 - i }[e.key]
    if (step === undefined) return
    e.preventDefault()
    const next = Math.max(0, Math.min(shown.length - 1, i + step))
    setAt(next)
    grid.current?.querySelectorAll<HTMLElement>('.bi-hero')[next]?.focus()
  }
  const applyLabel = b.on ? 'Apply and rebuild' : 'Save selection'
  return (
    <div id={id} className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)} onKeyDown={escape}>
      <div className="t-acc-panel-inner">
        <div className="bi-picker">
          <div className="bi-picker-head">
            <label className="lp-search bi-search">
              <Search size={14} aria-hidden="true" />
              <input value={query} placeholder="Search heroes..." aria-label="Search heroes"
                onChange={e => { setQuery(e.target.value); setAt(0) }} onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation() }} />
              {query && <button type="button" className="lo-icon" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}><X size={13} /></button>}
            </label>
            <p className="bi-picker-hint">Checked heroes keep their own skins. Everyone else shows their default.</p>
          </div>
          <div className="bi-heroes" role="group" aria-label="Heroes that keep their own skins" ref={grid}>
            {shown.map((h, i) => {
              const img = getHeroImageById(h.id)
              const on = kept.has(h.id)
              return (
                <button key={h.id} type="button" role="checkbox" aria-checked={on} className="bi-hero" tabIndex={i === Math.min(at, shown.length - 1) ? 0 : -1}
                  onClick={() => { setAt(i); flip(h.id) }} onKeyDown={e => move(e, i)} title={h.name}>
                  <span className="bi-hero-face">
                    {img ? <img src={img} alt="" onLoad={revealOnLoad} /> : <Shirt size={18} aria-hidden="true" />}
                    {/* checked: the check takes the portrait's place */}
                    <span className="bi-hero-check" aria-hidden="true"><Check size={16} strokeWidth={3} /></span>
                  </span>
                  <span className="bi-hero-name">{h.name}</span>
                </button>
              )
            })}
            {shown.length === 0 && <p className="bi-empty">{!loaded ? 'Loading heroes…' : heroes.length ? `No hero matches "${query}"` : 'Turn on Force default skin once to load the hero list.'}</p>}
          </div>
          <div className="bi-picker-foot">
            <span className="bi-kept"><Num id="bi-kept" value={kept.size} /> {kept.size === 1 ? 'hero keeps' : 'heroes keep'} their skins</span>
            {kept.size > 0 && <button type="button" className="lo-text-btn" title="Clear, every hero shows the default" onClick={() => setKept(new Set())}>Clear</button>}
            <span className="bi-foot-gap" />
            {b.on && dirty && <span className="bi-cost">{blocked ? BLOCKED : 'Takes about 25 seconds'}</span>}
            <button type="button" className="lo-text-btn" title="Cancel, keep the saved heroes" onClick={onDone}>Cancel</button>
            <button type="button" className="lo-text-btn is-primary" disabled={!dirty || building || (b.on && blocked)} onClick={apply}
              title={!dirty ? 'Nothing changed yet' : b.on && blocked ? BLOCKED : b.on ? 'Rebuild Force default skin with these heroes left out' : 'Save these heroes for when it is on'}>{applyLabel}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Row({ b, building, blocked, alert, revealed }: { b: Builtin; building: boolean; blocked: boolean; alert: LoadoutProps['alert']; revealed: boolean }) {
  const about = ABOUT[b.id]
  const [picking, setPicking] = useState(false)
  const item = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!revealed) return
    if (b.id === 'force-default-skin') setPicking(true)
    const el = item.current
    el?.classList.add('is-flash')
    // after the picker has unfolded, so the row lands at the top with the heroes below it
    const t = setTimeout(() => el?.scrollIntoView({ block: 'start', behavior: document.documentElement.dataset.motion === 'off' ? 'auto' : 'smooth' }), 300)
    const u = setTimeout(() => el?.classList.remove('is-flash'), 1600)
    return () => { clearTimeout(t); clearTimeout(u) }
  }, [revealed, b.id])
  const pick = useRef<HTMLButtonElement>(null)
  const Icon = about.icon
  const warn = !building && b.on && Boolean(b.error)
  const text = status(b, building)
  const kept = b.excluded.length
  const pickerId = useId()
  const done = () => { setPicking(false); pick.current?.focus() }
  return (
    <li ref={item} className={`bi-item${b.active || (b.current && b.on) ? ' is-on' : ''}`}>
      <div className="bi-row">
        <span className="bi-icon" aria-hidden="true"><Icon size={20} /></span>
        <div className="bi-text">
          <span className="bi-name">{about.name}</span>
          <span className={`bi-status${warn ? ' is-warn' : ''}`} title={text} aria-live="polite">
            {warn && <TriangleAlert size={13} aria-hidden="true" />}
            {building ? <span className="t-shimmer"><SwapText text={text} /></span> : <SwapText text={text} />}
          </span>
        </div>
        {b.id === 'force-default-skin' && (
          <button type="button" ref={pick} className="lo-text-btn bi-pick" aria-expanded={picking} aria-controls={pickerId} onClick={() => setPicking(v => !v)}
            title="Pick heroes that keep their own skins">
            {kept ? `${kept} ${kept === 1 ? 'hero keeps' : 'heroes keep'} skins` : 'Keep some heroes'}
            <ChevronDown size={13} className="bi-chev" aria-hidden="true" />
          </button>
        )}
        {warn && (
          <button type="button" className="lo-text-btn" disabled={blocked} onClick={() => change(b.id, { on: true }, alert)}
            title={blocked ? BLOCKED : 'Build it again'}><RotateCcw size={13} /> Try again</button>
        )}
        <Switch size="sm" checked={b.on} isDisabled={building || blocked} onChange={on => change(b.id, { on }, alert)}
          aria-label={about.name} title={blocked ? BLOCKED : about.what} />
      </div>
      {b.id === 'force-default-skin' && <HeroPicker id={pickerId} b={b} open={picking} building={building} blocked={blocked} onDone={done} alert={alert} />}
    </li>
  )
}

export default function BuiltinMods({ blocked, alert }: { blocked: boolean; alert: LoadoutProps['alert'] }) {
  const { list, busy } = useStore()
  const foldKey = FOLD_KEY
  const [folded, setFolded] = useState(() => savedItem(foldKey) === '1')
  // opened from the Library's Built-in badge: unfold and point at that row (taken once)
  const [revealed, setRevealed] = useState<string | null>(null)
  useEffect(() => {
    if (!reveal || !list.length) return
    setRevealed(reveal); reveal = null
    setFolded(false)
    const t = setTimeout(() => setRevealed(null), 2000)
    return () => clearTimeout(t)
  }, [list, busy])
  useEffect(() => { if (!list.length) load() }, [list.length])
  useEffect(() => { if (!blocked && list.some(b => b.on && !b.current)) refreshBuiltins() }, [blocked]) // the game closed: catch up
  if (!list.length) return null
  const ready = list.filter(b => b.on && (b.active || b.current)).length
  const fold = () => { localStorage.setItem(foldKey, folded ? '0' : '1'); setFolded(!folded) }
  return (
    <section className={`bi-section${folded ? ' is-folded' : ''}`} aria-label="Built-in mods">
      <div className="lo-group-head">
        <button type="button" className="lo-icon lo-group-fold" aria-expanded={!folded} onClick={fold}
          aria-label={folded ? 'Show Built-in' : 'Collapse Built-in'} title={folded ? 'Show the built-in mods' : 'Collapse'}>
          {folded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
        </button>
        <span className="lo-group-name" role="heading" aria-level={3} onClick={fold}>Built-in</span>
        <span className="lo-group-count" title={`${ready} of ${list.length} working`}><Num id="bi-on" value={`${ready}/${list.length}`} /></span>
        <span className="bi-sub">Made from your game files and rebuilt after game updates. Also in the Library, not part of loadouts</span>
      </div>
      <div className="t-acc-panel" data-open={!folded} ref={el => el?.toggleAttribute('inert', folded)}>
        <div className="t-acc-panel-inner">
          <ul className="mod-rows bi-rows">
            {list.map(b => <Row key={b.id} b={b} building={busy.has(b.id)} blocked={blocked} alert={alert} revealed={revealed === b.id} />)}
          </ul>
        </div>
      </div>
    </section>
  )
}
