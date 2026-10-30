// repakxtra: Home's "Built-in" section (the Library lists them as rows too, custom/builtinRows.ts): the mods repakxtra makes itself from the game's own tables (xtra_builtins.rs),
// Skip startup logos. Each row has the same switch as a loadout card. The app rebuilds them
// after a game update on its own (refreshBuiltins at start, from App.tsx, and again here once the game closes), so the
// rows only show where each one stands. The switch is the saved choice, the blue icon and the count mean a working build.
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronDown, ChevronRight, RotateCcw, TriangleAlert } from 'lucide-react'
import Switch from '../components/ui/Switch'
import type { LoadoutProps } from './Loadouts'
import { Num, SwapText } from './motion'
import { savedItem } from './storageCarryOver'
import { setView } from './loadoutStore'
import { ClapperboardIcon, type BuiltinIconComponent } from './PixelIcon'
import { cue } from './sounds'

export type Builtin = { id: string; on: boolean; current: boolean; active: boolean; builtAt?: number; summary?: string; error?: string; path: string; size: number
  gaveUp?: boolean
  /** In the game but partly built: these many game files the last patch changed wait for its USMAP (xtra_builtins.rs) */
  partial?: number }

// icon: a pixel-grid drawing (PixelIcon.tsx), sharp at any display scale. A new built-in adds its drawing there
const ABOUT: Record<string, { name: string; what: string; icon: BuiltinIconComponent }> = {
  'skip-intro-movies': { name: 'Skip startup logos', what: 'The game opens faster, without the Marvel, NetEase, and Unreal Engine logo videos that play each time it starts', icon: ClapperboardIcon },
}
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
  const Icon = ABOUT[id]?.icon ?? ClapperboardIcon
  const b = useStore().list.find(x => x.id === id)
  // blue on the same terms as its Loadouts screen icon (.bi-item.is-on): a working build, else the quiet gray
  const on = Boolean(b && (b.active || (b.current && b.on)))
  return <span className={`mod-hero-icon-inline builtin-icon${on ? ' is-on' : ''}`} aria-hidden="true"><Icon size={16} /></span>
}
/** Turns one on or off (the Library's switch). */
export const toggleBuiltin = (id: string, on: boolean, alert: LoadoutProps['alert']) => change(id, { on }, alert)

// The Library's Built-in badge: Home opens on that row, unfolded
let reveal: string | null = null
export function revealBuiltin(id: string) {
  reveal = id
  setView('home')
  emit()
}
const load = () => invoke<Builtin[]>('xtra_builtins_list').then(v => { list = v.filter(b => Boolean(ABOUT[b.id])); emit() }).catch(e => console.warn('[builtins]', e))

/** Rebuild the ones that are on but not current (a game update). Skipped while the game runs (its files are locked): at
 *  start from App.tsx, and from the section once the game closes. A build that failed for this game in this run waits
 *  for Try again (gaveUp), not for the next focus. */
export async function refreshBuiltins() {
  await load()
  const stale = list.filter(b => b.on && !b.current && !b.gaveUp).map(b => b.id)
  if (!stale.length || busy.size || await invoke<boolean>('check_game_running').catch(() => false)) return
  busy = new Set(stale); emit()
  try { list = (await invoke<Builtin[]>('xtra_builtins_refresh')).filter(b => Boolean(ABOUT[b.id])) } catch (e) { console.warn('[builtins] refresh', e) }
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

async function change(id: string, args: { on?: boolean }, alert: LoadoutProps['alert']) {
  if (args.on !== undefined) wanted.set(id, args.on)
  busy = new Set(busy).add(id); emit()
  const name = ABOUT[id].name
  try {
    const before = list.find(b => b.id === id)?.builtAt
    list = (await invoke<Builtin[]>('xtra_builtins_set', { id, ...args })).filter(b => Boolean(ABOUT[b.id]))
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

const units = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
const ago = (secs?: number) => {
  if (!secs) return ''
  const d = Date.now() / 1000 - secs
  return d < 90 ? 'just now' : d < 5400 ? units(Math.round(d / 60), 'minute') : d < 129600 ? units(Math.round(d / 3600), 'hour') : units(Math.round(d / 86400), 'day')
}

/** A mappings error clears itself once new mappings are out (checked at every start): no Try again for it. Pure. */
export const retryable = (error?: string) => Boolean(error) && !error!.startsWith('Not active yet.')

/** A partly built one's line: what is missing in the game, and that it completes by itself. */
export const partialText = (n: number) =>
  `In the game, but ${n === 1 ? '1 file' : `${n} files`} the last patch changed ${n === 1 ? 'is' : 'are'} left as the game ships ${n === 1 ? 'it' : 'them'} until the game's new USMAP is out. Then it completes by itself`

function status(b: Builtin, building: boolean) {
  if (building) return b.active ? 'Rebuilding from your game files. The last build stays in use' : 'Building from your game files. Not in the game yet'
  if (!b.on) return ABOUT[b.id].what
  if (b.error) return b.active ? `${b.error}. The last build is still in use` : retryable(b.error) ? `${b.error}. Not in the game` : b.error
  if (b.current && b.partial) return partialText(b.partial)
  if (b.current) return [b.summary ?? 'Up to date', b.builtAt ? `Built ${ago(b.builtAt)} for this game version` : ''].filter(Boolean).join('. ')
  return 'Waiting to rebuild for this game version'
}

function Row({ b, building, blocked, alert, revealed }: { b: Builtin; building: boolean; blocked: boolean; alert: LoadoutProps['alert']; revealed: boolean }) {
  const about = ABOUT[b.id]
  const item = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!revealed) return
    const el = item.current
    el?.classList.add('is-flash')
    // after the section has unfolded, so the row lands at the top
    const t = setTimeout(() => el?.scrollIntoView({ block: 'start', behavior: document.documentElement.dataset.motion === 'off' ? 'auto' : 'smooth' }), 300)
    const u = setTimeout(() => el?.classList.remove('is-flash'), 1600)
    return () => { clearTimeout(t); clearTimeout(u) }
  }, [revealed, b.id])
  const Icon = about.icon
  const warn = !building && b.on && Boolean(b.error)
  const text = status(b, building)
  return (
    <li ref={item} className={`bi-item${b.active || (b.current && b.on) ? ' is-on' : ''}`}>
      <div className="bi-row">
        <span className="bi-icon" aria-hidden="true"><Icon size={20} /></span>
        <div className="bi-text">
          <span className="bi-name">{about.name}{b.current && b.partial ? <span className="bi-partial" tabIndex={0} title={`${partialText(b.partial)}. ${b.summary ?? ''}`}>Partly built</span> : null}</span>
          <span className={`bi-status${warn ? ' is-warn' : ''}`} title={text} aria-live="polite">
            {warn && <TriangleAlert size={13} aria-hidden="true" />}
            {building ? <span className="t-shimmer"><SwapText text={text} /></span> : <SwapText text={text} />}
          </span>
        </div>
        {warn && retryable(b.error) && (
          <button type="button" className="lo-text-btn" disabled={blocked} onClick={() => change(b.id, { on: true }, alert)}
            title={blocked ? BLOCKED : 'Build it again'}><RotateCcw size={13} /> Try again</button>
        )}
        <Switch size="sm" checked={wanted.get(b.id) ?? b.on} isDisabled={building || blocked} onChange={on => change(b.id, { on }, alert)}
          aria-label={about.name} title={blocked ? BLOCKED : about.what} />
      </div>
    </li>
  )
}

// memo: Loadouts redraws on every move of a card drag, and this section has nothing to do with it
export default memo(function BuiltinMods({ blocked, alert }: { blocked: boolean; alert: LoadoutProps['alert'] }) {
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
})

if (import.meta.env.DEV) {
  console.assert(!retryable('Not active yet. The game updated and repakxtra waits for the support files for it. It checks for them at every start') && retryable('Could not write the packages') && !retryable(undefined), 'no Try again while waiting for support files')
  console.assert(Object.values(ABOUT).every(a => !/[;\u2014]/.test(a.what)), 'no semicolons or em dashes')
}
