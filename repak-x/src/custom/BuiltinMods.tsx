// repakxtra: Home's "Built-in" section (the Library lists them as rows too, custom/builtinRows.ts): the mods repakxtra makes itself from the game's own tables (xtra_builtins.rs),
// Force default skin, Skip startup logos and CustomQuake. Each row has the same switch as a loadout card. Force default
// skin's row folds open into the hero picker (the heroes that keep their own skins), CustomQuake's into its options (the
// colors and two switches), each applied in one rebuild. The app rebuilds them
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
import { flipMods, setView } from './loadoutStore'
import { nameKey } from './loadoutIdentity'
import { ClapperboardIcon, FlatTilesIcon, PortraitCardIcon, type BuiltinIconComponent } from './PixelIcon'
import { cue } from './sounds'
import { ROLES, type Role } from './heroRoles'

/** CustomQuake's options (xtra_quake.rs Options): colors as 6 hex digits */
export type Quake = { base: string; sky: string; hidePlants: boolean; lobby: boolean }
export type Builtin = { id: string; on: boolean; excluded: string[]; current: boolean; active: boolean; builtAt?: number; summary?: string; heroes: string[]; error?: string; path: string; size: number
  quake?: Quake; overlaps?: string[] }

// icon: a pixel-grid drawing (PixelIcon.tsx), sharp at any display scale. A new built-in adds its drawing there
const ABOUT: Record<string, { name: string; what: string; icon: BuiltinIconComponent }> = {
  'force-default-skin': { name: 'Force default skin', what: 'Every hero shows their default skin, in matches and in the lobby', icon: PortraitCardIcon },
  'skip-intro-movies': { name: 'Skip startup logos', what: 'The game opens faster, without the Marvel, NetEase, and Unreal Engine logo videos that play each time it starts', icon: ClapperboardIcon },
  'custom-quake': { name: 'CustomQuake', what: 'Every map texture turns one flat color you pick, the Quake look', icon: FlatTilesIcon },
}
const QUAKE_DEFAULT: Quake = { base: '5d7a80', sky: '82c6ed', hidePlants: false, lobby: true }
/** Whether two CustomQuake option sets make the same files: only a real change rebuilds. Pure. */
export const sameQuake = (a: Quake, b: Quake) =>
  a.base.toLowerCase() === b.base.toLowerCase() && a.sky.toLowerCase() === b.sky.toLowerCase() && a.hidePlants === b.hidePlants && a.lobby === b.lobby
const FOLD_KEY = 'repakxtra.builtins.folded'
const BLOCKED = 'Close Marvel Rivals to change built-in mods'

// one store for every remount: the list, which ones are building, and the switch each was last set to
let list: Builtin[] = []
let busy = new Set<string>()
const wanted = new Map<string, boolean>()
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

async function change(id: string, args: { on?: boolean; excluded?: string[]; quake?: Quake }, alert: LoadoutProps['alert']) {
  if (args.on !== undefined) wanted.set(id, args.on)
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
  wanted.delete(id)
  busy = new Set([...busy].filter(x => x !== id)); emit()
}

/** Stops CustomQuake's build (it saves Off, and the build gives up at its next batch). */
const stopBuild = (id: string, alert: LoadoutProps['alert']) => { wanted.set(id, false); emit(); void invoke<Builtin[]>('xtra_builtins_set', { id, on: false }).then(v => { list = v; emit() }).catch(e => alert.error(`${ABOUT[id].name} not stopped`, String(e))) }

const units = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
const ago = (secs?: number) => {
  if (!secs) return ''
  const d = Date.now() / 1000 - secs
  return d < 90 ? 'just now' : d < 5400 ? units(Math.round(d / 60), 'minute') : d < 129600 ? units(Math.round(d / 3600), 'hour') : units(Math.round(d / 86400), 'day')
}

/** "a", "a and b", "a, b, and c" (the Oxford comma). Pure. */
export const listWords = (names: string[]) => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`

/** The other quake mods that are on, said on CustomQuake's row. Pure. */
export const overlapText = (paths: string[]) => paths.length
  ? `${listWords(paths.map(nameKey))} ${paths.length === 1 ? 'changes' : 'change'} the same map textures, so the game shows only one. Turn one of them off`
  : ''

/** Turns the other quake mods off (the overlap warning's button), then checks again. */
async function turnOffOverlaps(paths: string[], alert: LoadoutProps['alert']) {
  const failed = await flipMods(paths.map(path => ({ path, enabled: true })))
  if (failed.length) alert.warning('Not turned off', failed.reason ?? `Close anything using ${listWords(failed.map(m => nameKey(m.path)))}, then try again.`)
  await refreshBuiltins()
}

/** A mappings error clears itself once new mappings are out (checked at every start): no Try again for it. Pure. */
export const retryable = (error?: string) => Boolean(error) && !error!.startsWith('Not active yet.')

function status(b: Builtin, building: boolean) {
  const long = b.id === 'custom-quake' ? ', about 10 minutes' : ''
  if (building && wanted.get(b.id) === false) return 'Stopping the build…'
  if (building) return b.active ? `Rebuilding from your game files${long}. The last build stays in use` : `Building from your game files${long}. Not in the game yet`
  if (!b.on) return ABOUT[b.id].what
  if (b.error) return b.active ? `${b.error}. The last build is still in use` : retryable(b.error) ? `${b.error}. Not in the game` : b.error
  if (b.overlaps?.length) return overlapText(b.overlaps)
  if (b.current) return [b.summary ?? 'Up to date', b.builtAt ? `Built ${ago(b.builtAt)} for this game version` : ''].filter(Boolean).join('. ')
  return 'Waiting to rebuild for this game version'
}

type Hero = { id: string; name: string }

/** A hero's name as the picker shows it: the character data's, without a note in brackets ("Iron Fist (lin Lie)"). Pure. */
export const heroName = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').trim()
/** A placeholder the character data keeps for a hero the game does not have yet ("Hive**"). Pure. */
const unreleased = (name: string) => name.includes('*')

/** The heroes the skin table holds (the ones the build changes), named from the character data; a hero it lacks a name
 *  for still shows by id. Before the first build the table is not read yet, so the character data's released heroes. */
function useHeroes(ids: string[]) {
  const [named, setNamed] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    invoke<{ id: string; name: string }[]>('get_character_data')
      .then(rows => setNamed(Object.fromEntries(rows.filter(r => /^10\d\d$/.test(r.id) && !unreleased(r.name)).map(r => [r.id, heroName(r.name)]))))
      .catch(() => setNamed({}))
  }, [])
  const heroes = useMemo<Hero[]>(() => (ids.length ? ids : Object.keys(named ?? {}))
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
  // a role's heroes, of those listed: all kept, a click lets them go, else it keeps them all
  const inRole = (r: Role) => heroes.filter(h => (ROLES[r] as readonly string[]).includes(h.id)).map(h => h.id)
  const roleKept = (r: Role) => { const ids = inRole(r); return ids.length > 0 && ids.every(i => kept.has(i)) }
  const flipRole = (r: Role) => { const ids = inRole(r), all = roleKept(r); setKept(k => { const n = new Set(k); ids.forEach(i => (all ? n.delete(i) : n.add(i))); return n }) }
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
            {/* a role partly kept shows how many, as 3/23 */}
            <div className="bi-roles" role="group" aria-label="Keep a whole role">
              {(Object.keys(ROLES) as Role[]).map(r => {
                const ids = inRole(r), n = ids.filter(i => kept.has(i)).length
                return (
                  <button key={r} type="button" className="bi-role" aria-pressed={n === ids.length && n > 0 ? true : n > 0 ? 'mixed' : false} disabled={!ids.length}
                    title={roleKept(r) ? `${r} show their default skins again` : `Every one of the ${r.toLowerCase()} keeps their own skins`} onClick={() => flipRole(r)}>
                    {r}{n > 0 && n < ids.length && <span className="bi-role-n">{n}/{ids.length}</span>}
                  </button>
                )
              })}
            </div>
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

/** CustomQuake's options under its row: two colors and two switches, saved while off, applied in one rebuild while on.
 *  The same fold-open panel and foot as the hero picker (Jakob), four choices only (Hick), out of the way until asked for
 *  (Tesler). The whole switch row is the target, its words included (Fitts). */
function QuakeOptions({ id, b, open, building, blocked, onDone, alert }: { id: string; b: Builtin; open: boolean; building: boolean; blocked: boolean; onDone: () => void; alert: LoadoutProps['alert'] }) {
  const saved = b.quake ?? QUAKE_DEFAULT
  const [draft, setDraft] = useState(saved)
  useEffect(() => { if (open) setDraft(saved) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !sameQuake(draft, saved)
  const set = (part: Partial<Quake>) => setDraft(d => ({ ...d, ...part }))
  const apply = () => { onDone(); change(b.id, { quake: draft }, alert) }
  const color = (key: 'base' | 'sky', label: string) => (
    <label className="bq-color">
      <input type="color" value={`#${draft[key]}`} onChange={e => set({ [key]: e.target.value.slice(1).toLowerCase() })} aria-label={label} />
      <span className="bq-color-text"><span>{label}</span>
        {/* typed or pasted too: only a full color is taken */}
        <input className="bq-hex" defaultValue={`#${draft[key].toUpperCase()}`} key={draft[key]} maxLength={7} spellCheck={false} aria-label={`${label}, hex`}
          onChange={e => { const v = e.target.value.trim().replace(/^#/, ''); if (/^[0-9a-f]{6}$/i.test(v)) set({ [key]: v.toLowerCase() }) }}
          onClick={e => e.preventDefault()} /></span>
    </label>
  )
  return (
    <div id={id} className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onDone() } }}>
      <div className="t-acc-panel-inner">
        <div className="bi-picker">
          <div className="bq-grid">
            {color('base', 'Map color')}
            {color('sky', 'Sky color')}
            <Switch size="sm" className="bq-switch" checked={draft.hidePlants} onChange={v => set({ hidePlants: v })} aria-label="Hide plants">Hide plants</Switch>
            <Switch size="sm" className="bq-switch" checked={draft.lobby} onChange={v => set({ lobby: v })} aria-label="Include lobby and showcase scenes">Include lobby and showcase scenes</Switch>
          </div>
          {!draft.lobby && <p className="bi-picker-hint bq-hint">Textures the lobby shares with the maps still change.</p>}
          <div className="bi-picker-foot">
            <span className="bi-foot-gap" />
            {b.on && dirty && <span className="bi-cost">{blocked ? BLOCKED : 'Takes about 10 minutes'}</span>}
            {/* while it builds, Close: this panel never stops the build (the row's Stop building does) */}
            <button type="button" className="lo-text-btn" title={building ? 'Close the options, the build goes on' : 'Cancel, keep the saved options'} onClick={onDone}>{building ? 'Close' : 'Cancel'}</button>
            <button type="button" className="lo-text-btn is-primary" disabled={!dirty || building || (b.on && blocked)} onClick={apply}
              title={!dirty ? 'Nothing changed yet' : b.on && blocked ? BLOCKED : b.on ? 'Rebuild CustomQuake with these options' : 'Save these options for when it is on'}>{b.on ? 'Apply and rebuild' : 'Save options'}</button>
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
  const warn = !building && b.on && Boolean(b.error || b.overlaps?.length)
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
        {b.id === 'custom-quake' && (
          <button type="button" ref={pick} className="lo-text-btn bi-pick" aria-expanded={picking} aria-controls={pickerId} onClick={() => setPicking(v => !v)}
            title="Colors, plants, and the lobby">
            Options
            <ChevronDown size={13} className="bi-chev" aria-hidden="true" />
          </button>
        )}
        {!building && b.on && Boolean(b.overlaps?.length) && (
          <button type="button" className="lo-text-btn" disabled={blocked} onClick={() => void turnOffOverlaps(b.overlaps!, alert)}
            title={blocked ? BLOCKED : 'CustomQuake stays on, the other quake mods go off'}>
            {b.overlaps!.length === 1 ? `Turn off ${nameKey(b.overlaps![0])}` : 'Turn them off'}
          </button>
        )}
        {building && b.id === 'custom-quake' && wanted.get(b.id) !== false && (
          <button type="button" className="lo-text-btn" onClick={() => stopBuild(b.id, alert)} title="Stops within a few seconds, nothing goes into the game">Stop building</button>
        )}
        {warn && retryable(b.error) && (
          <button type="button" className="lo-text-btn" disabled={blocked} onClick={() => change(b.id, { on: true }, alert)}
            title={blocked ? BLOCKED : 'Build it again'}><RotateCcw size={13} /> Try again</button>
        )}
        <Switch size="sm" checked={wanted.get(b.id) ?? b.on} isDisabled={building || blocked} onChange={on => change(b.id, { on }, alert)}
          aria-label={about.name} title={blocked ? BLOCKED : about.what} />
      </div>
      {b.id === 'force-default-skin' && <HeroPicker id={pickerId} b={b} open={picking} building={building} blocked={blocked} onDone={done} alert={alert} />}
      {b.id === 'custom-quake' && <QuakeOptions id={pickerId} b={b} open={picking} building={building} blocked={blocked} onDone={done} alert={alert} />}
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

if (import.meta.env.DEV) {
  console.assert(sameQuake(QUAKE_DEFAULT, { ...QUAKE_DEFAULT, base: '5D7A80' }) && !sameQuake(QUAKE_DEFAULT, { ...QUAKE_DEFAULT, hidePlants: true }), 'only a real option change rebuilds')
  console.assert(overlapText(['C:/G/~mods/quakeV6_9999999_P.pak']) === 'quakeV6 changes the same map textures, so the game shows only one. Turn one of them off', 'one overlap, shown by its name', overlapText(['C:/G/~mods/quakeV6_9999999_P.pak']))
  console.assert(overlapText(['a', 'b', 'c']).startsWith('a, b, and c change the same') && overlapText([]) === '', 'several overlaps, Oxford comma')
  console.assert(listWords(['a', 'b']) === 'a and b' && listWords(['a']) === 'a', 'one or two names')
  console.assert(!retryable('Not active yet. The game updated and repakxtra waits for the support files for it. It checks for them at every start') && retryable('Could not write the packages') && !retryable(undefined), 'no Try again while waiting for support files')
  console.assert(Object.values(ABOUT).every(a => !/[;\u2014]/.test(a.what)), 'no semicolons or em dashes')
  console.assert(heroName('Iron Fist (lin Lie)') === 'Iron Fist' && heroName('Cloak & Dagger') === 'Cloak & Dagger', 'a note in brackets goes')
  console.assert(unreleased('Hive**') && !unreleased('Hulk'), 'placeholders are not heroes yet')
}
