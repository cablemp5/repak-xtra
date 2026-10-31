// repakxtra: Home, the app's first view. Loadouts as cards (image, on/off switch), grouped by collection or hero, with
// the "New this week" strip below them; a card opens its page (LoadoutPage.tsx). The full mod list is the Library
// view (header tabs, or L). On = its mods on, Off = its mods off; other mods and loadouts are never touched.
import { type CSSProperties, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStableCallback } from '../hooks/useStableCallback'
import { ChevronDown, ChevronRight, ChevronUp, CopyPlus, FolderPlus, ListChecks, Pencil, Plus, Search, Shapes, Trash2, WandSparkles, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo, runChanges } from './Loadouts'
import LoadoutPage from './LoadoutPage'
import NewStrip from './NewStrip'
import SmartLoadouts from './SmartLoadouts' // repakxtra
import BuiltinMods from './BuiltinMods'
import { matchesLoadout } from './homeSearch'
import { isTyping } from './hotkeys'
import { modalOpen } from './dialogFocus'
import { CardMedia, OnDot } from './loadoutBits'
import { CardZoomControl, useCardZoom, useWheelZoom } from './cardZoom'
import { type Spot, playFlip, snapshotCards, useCardDrag } from './cardDrag'
import { prepareMedia, putMedia } from './loadoutMedia'
import { plural } from './modName'
import { PreviewsUnavailable, dismissPreviewSummary, generateAllLoadouts, loadoutHasPreview, stopPreviews, usePreviewFailureToast, usePreviewsAvailable, usePreviewBatch, usePreviewStage, usePreviewSummary, usePreviewVersion } from './previews'
import {
  type Loadout, type Mod, OTHER, OTHER_LABEL, addGroup, captureKey, changesToTurnOff, changesToTurnOn, deleteGroup, displayName, groupKey,
  inGroup, isActive, modKey, moveGroup, moveLoadout, movedBeside, nextLoadoutName, openLoadout, patchLoadout, placeLoadout, placed, readLoadouts, renameGroup,
  setView, snapshotLoadout, sweepMediaOnce, useGroups, useLoadouts, useOpenLoadout, useView, writeLoadouts, modsByKey,
} from './loadoutStore'
import { savedItem } from './storageCarryOver'
import { useUpstreamWatch } from './upstream'
import { useUiPref } from './uiPrefs'

type GroupBy = 'group' | 'hero'
const GROUP_BY_KEY = 'repakxtra.loadoutGroupBy'
const ONLY_ON_KEY = 'repakxtra.loadoutsOnlyOn' // All or On (loadouts with any of their mods on)
const FOLDED_KEY = 'repakxtra.foldedGroups' // collections and hero groups shown as just their heading ("group:<key>", "hero:<name>")
const readFolded = () => { try { return new Set<string>(JSON.parse(savedItem(FOLDED_KEY) || '[]')) } catch { return new Set<string>() } }

/** The chevron before a group's name: folds its cards away, or shows them again. */
function FoldButton({ name, folded, onFold }: { name: string; folded: boolean; onFold: () => void }) {
  return (
    <button type="button" className="lo-icon lo-group-fold" aria-expanded={!folded} onClick={onFold}
      aria-label={folded ? `Show ${name}` : `Collapse ${name}`} title={folded ? 'Show its loadouts' : 'Collapse'}>
      {folded ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
    </button>
  )
}
const NO_HERO = 'No Hero'

/** The hero most of the given mods belong to, or undefined when none has a detected hero. */
function topHero(keys: string[], byKey: Map<string, Mod>, details: LoadoutProps['modDetails']) {
  const counts = new Map<string, number>()
  for (const key of keys) {
    const mod = byKey.get(displayName(key))
    let hero = mod && details?.[mod.path]?.character_name
    if (!hero) continue
    if (hero.startsWith('Multiple Heroes')) hero = 'Multiple heroes'
    hero = hero.split(' - ')[0] // the backend names skin-specific mods "Hero - Skin"; group by the hero
    counts.set(hero, (counts.get(hero) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** A loadout's hero from its on mods; VFX and texture-only mods often have none, so its scope decides then. */
const heroOf = (l: Loadout, byKey: Map<string, Mod>, details: LoadoutProps['modDetails']) =>
  topHero(l.on, byKey, details) ?? topHero(l.scope, byKey, details) ?? NO_HERO

/** Hero sections, A to Z with "No Hero" last. */
function byHero(list: Loadout[], heroOfL: (l: Loadout) => string) {
  const map = new Map<string, Loadout[]>()
  for (const l of list) map.set(heroOfL(l), [...(map.get(heroOfL(l)) ?? []), l])
  return [...map].sort(([a], [b]) => Number(a === NO_HERO) - Number(b === NO_HERO) || a.localeCompare(b))
}

/** A collection's header on Home (groups are called collections in the interface): its name with an always-visible
 *  pencil (or double-click) to rename, its count, and on hover or focus Move up, Move down and Delete (with Undo). Other
 *  is not a real collection, so it has none of these. */
function GroupHead({ p, name, count, at, total, editing, setEditing, folded, onFold }: {
  p: LoadoutProps; name: string; count: number; at: number; total: number; editing: boolean; setEditing: (g: string | null) => void
  folded: boolean; onFold: () => void
}) {
  const [draft, setDraft] = useState(name)
  const foldTimer = useRef<ReturnType<typeof setTimeout>>()
  const real = groupKey(name) !== groupKey(OTHER)
  const done = (save: boolean) => { if (save) renameGroup(name, draft); setEditing(null) }
  const remove = () => {
    const undo = deleteGroup(name)
    const id = p.alert.info(`Deleted collection ${name}`, count ? `Its ${plural(count, 'loadout')} moved to ${OTHER_LABEL}.` : 'It was empty.', {
      duration: 10000, action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); undo() } },
    })
  }
  return (
    <div className="lo-group-head" data-flip={`head:${groupKey(name)}`}>{/* a div: only the name below is the heading, not its buttons */}
      <FoldButton name={real ? name : OTHER_LABEL} folded={folded} onFold={onFold} />
      {editing && real
        ? <input className="lo-rename lo-group-rename" autoFocus value={draft} aria-label="Collection name"
            onFocus={e => e.target.select()} onChange={e => setDraft(e.target.value)} onBlur={() => done(true)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') { setDraft(name); done(false) } }} />
        : <span className="lo-group-name" role="heading" aria-level={3}
            // a click folds it like the arrow, a double-click renames: the fold waits a moment so a double-click is only the rename
            onClick={() => { clearTimeout(foldTimer.current); if (!real) onFold(); else foldTimer.current = setTimeout(onFold, 220) }}
            onDoubleClick={() => { clearTimeout(foldTimer.current); if (real) { setDraft(name); setEditing(name) } }}
            title={real ? `${name} (click to ${folded ? 'show' : 'collapse'}, double-click to rename)` : `Loadouts in no collection (click to ${folded ? 'show' : 'collapse'})`}>{real ? name : OTHER_LABEL}</span>}
      {real && !editing && (
        <button type="button" className="lo-icon lo-group-pen" aria-label={`Rename ${name}`} title="Rename collection" onClick={() => { setDraft(name); setEditing(name) }}><Pencil size={13} /></button>
      )}
      <span className="lo-group-count">{count}</span>
      {real && !editing && (
        <span className="lo-group-tools">
          <button type="button" className="lo-icon" aria-label={`Move ${name} up`} title="Move up" disabled={at === 0} onClick={() => moveGroup(name, -1)}><ChevronUp size={14} /></button>
          <button type="button" className="lo-icon" aria-label={`Move ${name} down`} title="Move down" disabled={at === total - 1} onClick={() => moveGroup(name, 1)}><ChevronDown size={14} /></button>
          <button type="button" className="lo-icon" aria-label={`Delete collection ${name}`} title={`Delete collection (its loadouts move to ${OTHER_LABEL})`} onClick={remove}><Trash2 size={13} /></button>
        </span>
      )}
    </div>
  )
}

/** Home | Library switch for the app header. Its own class: the 1/2/3 hotkeys click the first .mod-state-filter. The
 *  Loadouts tab lands on the cards (not a loadout page left open). The Library tab and L keep the Library as it was
 *  (search, filters, folder, checked and viewed mods, scroll): its Show all button is the deliberate reset (App.tsx). */
export function ViewTabs() {
  const view = useView()
  useEffect(() => { if (view === 'nexus') setView('library') }, [view]) // a view another edition saved
  return (
    <div className="view-tabs" role="tablist" aria-label="View" data-tour="view-tabs">
      <button type="button" role="tab" aria-selected={view === 'home'} onClick={() => { openLoadout(null); setView('home') }} title="Loadouts and new mods (L)">Loadouts</button>
      <button type="button" role="tab" aria-selected={view === 'library'} onClick={() => setView('library')}
        title="Every mod, with filters and folders (L)">Library</button>
      <button type="button" role="tab" aria-selected={view === 'ko'} onClick={() => setView('ko')} title="Recolor a hero's KO prompt">KO Editor</button>
    </div>
  )
}

type CardProps = {
  p: LoadoutProps; l: Loadout; groupBy: GroupBy; canGenerate: boolean; busy: boolean; anyBusy: boolean; renaming: boolean; draft: string
  placeholder: boolean; hovered: React.MutableRefObject<string | null>
  onPick: (e: React.PointerEvent<HTMLElement>, id: string) => void; onToggle: (l: Loadout, on: boolean) => void
  onStartRename: (l: Loadout) => void; onDraft: (name: string) => void; onCommit: (l: Loadout) => void; onCancelRename: () => void
}

/** One loadout card on Home. Memoized: it re-renders only when its loadout, the mods or its own state change. */
const LoadoutCard = memo(function LoadoutCard({ p, l, groupBy, canGenerate, busy, anyBusy, renaming, draft, placeholder, hovered,
  onPick, onToggle, onStartRename, onDraft, onCommit, onCancelRename }: CardProps) {
  const byKey = modsByKey(p.mods)
  const active = isActive(l, p.mods)
  const keys = new Set(l.on.map(displayName))
  const present = [...keys].filter(k => byKey.has(k)).length
  const onNow = [...keys].filter(k => byKey.get(k)?.enabled).length
  const label = present === 0 ? 'No installed mods' : active ? `Turn ${l.name} off` : `Turn ${l.name} on`
  return (
    <article data-loadout={l.id} className={`lo-card ${active ? 'is-on' : ''}${placeholder ? ' is-placeholder' : ''}`}
      onPointerDown={!renaming ? e => onPick(e, l.id) : undefined}
      onKeyDown={e => { if (e.key === 'F2' && !isTyping(e.target)) { e.preventDefault(); onStartRename(l) } }}
      onMouseEnter={() => { hovered.current = l.id }} onMouseLeave={() => { if (hovered.current === l.id) hovered.current = null }}>
      <CardMedia p={p} l={l} onClick={() => openLoadout(l.id)} title={`Open ${l.name}`}
        emptyText={canGenerate ? 'No preview yet. Open it to generate one or type text, or hover and paste an image.' : 'No picture yet. Hover and paste an image, or open it to add one or type text.'} />
      <div className="lo-card-body">
        <div className="lo-card-title">
          {renaming ? (
            <input className="lo-rename" autoFocus value={draft} aria-label="Loadout name"
              onFocus={e => e.target.select()} onChange={e => onDraft(e.target.value)} onBlur={() => onCommit(l)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') onCommit(l); if (e.key === 'Escape') onCancelRename() }} />
          ) : (
            <span className="lo-card-name">
              <h3 title={`${l.name} (double-click or F2 to rename)`} onDoubleClick={() => onStartRename(l)}>{l.name}</h3>
              <button type="button" className="lo-icon lo-card-pen" title="Rename" aria-label={`Rename ${l.name}`} onClick={() => onStartRename(l)}>
                <Pencil size={12} />
              </button>
            </span>
          )}
          <Switch size="sm" color="primary" checked={active} isDisabled={present === 0} disabled={anyBusy || present === 0}
            title={label} aria-label={label} onChange={(checked: boolean) => onToggle(l, checked)} />
        </div>
        <p className="lo-card-meta">
          {busy ? 'Switching mods…' : p.mods.length === 0 ? 'Loading mods…' : <>
            {groupBy === 'hero' && <>{l.label}<span className="lo-sep">·</span></>}
            {`${onNow}/${l.on.length}`}
            <OnDot on={onNow} of={present} />
            {present < l.on.length && <><span className="lo-sep">·</span>{l.on.length - present} not installed</>}
          </>}
        </p>
        <div className="lo-card-actions">
          <button type="button" className="lo-expand" onClick={() => openLoadout(l.id)}>Edit mods</button>
          <span className="lo-card-tools">
            <button type="button" className="lo-icon" title={`Delete ${l.name}`} aria-label={`Delete ${l.name}`} onClick={() => deleteWithUndo(p, l)}>
              <Trash2 size={14} />
            </button>
          </span>
        </div>
      </div>
    </article>
  )
})

/** Home. Mounted on its first visit and then kept, hidden while another view shows: remounting made every switch back
 *  rebuild each card and decode its picture again (a pause before the cards appeared). */
export default function LoadoutsScreen(p: LoadoutProps) {
  const home = useView() === 'home'
  const [seen, setSeen] = useState(home)
  if (home && !seen) setSeen(true)
  if (!seen) return null
  return <div style={{ display: home ? 'contents' : 'none' }}><LoadoutsHome {...p} /></div>
}

function LoadoutsHome(p: LoadoutProps) {
  const newStrip = useUiPref('new-strip') // Settings > Library > Show New this week, off by default
  const builtins = useUiPref('builtins') // Settings > Library > Hide built-in mods, shown by default
  const view = useView()
  const loadouts = useLoadouts()
  // Search: kept while a loadout's page is open, so Back returns to the same results
  const [query, setQuery] = useState('')
  const q = query.trim()
  // On: loadouts with at least one installed mod on, fully or partly on (the card's dot is not gray)
  const [onlyOn, setOnlyOnState] = useState(() => savedItem(ONLY_ON_KEY) === '1')
  const setOnlyOn = (v: boolean) => { localStorage.setItem(ONLY_ON_KEY, v ? '1' : '0'); setOnlyOnState(v) }
  const enabledKeys = useMemo(() => new Set(p.mods.filter(m => m.enabled).map(m => modKey(m.path))), [p.mods])
  const filtered = Boolean(q) || onlyOn // a narrowed view: groups without a match hide, and cards are not dragged
  const matching = useMemo(() => loadouts.filter(l => (!q || matchesLoadout(l, q)) && (!onlyOn || l.on.some(k => enabledKeys.has(displayName(k))))),
    [loadouts, q, onlyOn, enabledKeys])
  const [said, setSaid] = useState('') // the result count for screen readers, once typing pauses
  useEffect(() => {
    const t = setTimeout(() => setSaid(!q ? '' : matching.length ? `${plural(matching.length, 'loadout')} found` : 'No loadouts found'), 700)
    return () => clearTimeout(t)
  }, [q, matching.length])
  const scrollBefore = useRef(0) // where the cards were before a search, for when it is cleared
  const searchRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const openId = useOpenLoadout()
  const setOpenId = openLoadout
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const savedGroups = useGroups()
  const batch = usePreviewBatch()
  const stage = usePreviewStage(Boolean(batch)) // the generator's step now, in the running Generate button's menu
  const runJobs = useRef(0) // how many loadouts the run that just ended rendered, for its toast
  const lastRun = usePreviewSummary()
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [groupBy, setGroupByState] = useState<GroupBy>(() => (savedItem(GROUP_BY_KEY) === 'hero' ? 'hero' : 'group'))
  const setGroupBy = (g: GroupBy) => { localStorage.setItem(GROUP_BY_KEY, g); setGroupByState(g) }
  const [folded, setFolded] = useState(readFolded)
  const fold = (id: string) => setFolded(prev => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]))
    return next
  })
  const fileRef = useRef<HTMLInputElement>(null)
  const [genMenu, setGenMenu] = useState(false)
  const [smart, setSmart] = useState(false) // repakxtra: the Smart loadouts dialog
  // a loadout opened from elsewhere (an In loadout tag, a toast) shows its page, not the Smart page over it
  useEffect(() => { if (openId) setSmart(false) }, [openId])
  useEffect(() => { // the first-launch flow's "Group my mods into loadouts" (FirstRun.tsx)
    const show = () => { sessionStorage.removeItem('repakxtra.smartPending'); openLoadout(null); setSmart(true) }
    if (sessionStorage.getItem('repakxtra.smartPending')) show() // asked before this screen mounted
    window.addEventListener('repakxtra-smart-loadouts', show)
    return () => window.removeEventListener('repakxtra-smart-loadouts', show)
  }, [])
  const canGenerate = usePreviewsAvailable()
  const genRef = useRef<HTMLDivElement>(null)
  const [newMenu, setNewMenu] = useState(false) // repakxtra: + New's menu (New loadout, Smart loadouts, New collection)
  const newWrap = useRef<HTMLDivElement>(null)
  const cardZoom = useCardZoom()
  const [cardsEl, setCardsEl] = useState<HTMLDivElement | null>(null)
  useWheelZoom(cardsEl)
  // Dragging a card (custom/cardDrag.ts; in the Hero view only within its hero): `spot` is where it would land; the cards show that order
  // live, sliding from where they were (flipFrom, taken just before each change)
  const [spot, setSpot] = useState<Spot | null>(null)
  const flipFrom = useRef<Map<string, DOMRect> | null>(null)
  const drag = useCardDrag({
    zoom: cardZoom, scroller: cardsEl,
    ownGroupOnly: groupBy === 'hero', // a card's hero comes from its mods: reordered within it, never moved to another
    onMove: (_id, s) => { flipFrom.current = snapshotCards(cardsEl); setSpot(s) },
    onDrop: (id, s) => {
      flipFrom.current = snapshotCards(cardsEl)
      setSpot(null)
      if (!s) return
      if (groupBy === 'hero') moveLoadout(id, besideOf(id, s))
      else placeLoadout(id, s.group, besideOf(id, s))
    },
  })
  useLayoutEffect(() => {
    if (!flipFrom.current) return
    playFlip(cardsEl, flipFrom.current, cardZoom)
    flipFrom.current = null
  })
  usePreviewVersion()
  usePreviewFailureToast(p.alert)
  useUpstreamWatch(p.alert) // Repak X open beside it
  const mediaTarget = useRef<string | null>(null)
  const hovered = useRef<string | null>(null)
  const openRef = useRef(openId)
  openRef.current = openId
  const open = loadouts.find(l => l.id === openId)
  // Leaving a loadout page puts focus back on its card's Edit mods (or on New loadout when it was deleted); only then,
  // never on first paint or a Home/Library switch
  const newRef = useRef<HTMLButtonElement>(null)
  const closedId = useRef<string | null>(null)
  const shownPage = useRef(open?.id ?? null)
  const closePage = () => { closedId.current = openRef.current; setOpenId(null) }
  useEffect(() => {
    const was = shownPage.current
    shownPage.current = open?.id ?? null
    if (view !== 'home' || !was || open) return
    const id = closedId.current
    closedId.current = null
    const edit = id && document.querySelector<HTMLElement>(`[data-loadout="${CSS.escape(id)}"] .lo-expand`)
    ;(edit || newRef.current)?.focus()
  })

  /** Stores the loadout's own picture, or its in-game capture (its own slot), and shows it on the card; false (with the
   *  reason shown) when it could not be saved. */
  const setMedia = async (id: string, file: Blob, as: 'image' | 'capture' = 'image') => {
    try {
      const { blob, type } = await prepareMedia(file)
      await putMedia(as === 'capture' ? captureKey(id) : id, blob)
      patchLoadout(id, as === 'capture' ? { captureRev: Date.now(), cover: 'capture' } : { mediaType: type, mediaRev: Date.now(), mediaBeat: undefined, image: undefined, cover: 'image' })
      return true
    } catch (e) {
      p.alert.warning('Media not saved', e instanceof Error ? e.message : String(e))
      return false
    }
  }

  useEffect(sweepMediaOnce, []) // stored media of loadouts deleted in an earlier session

  // The cards' handlers keep one identity, so a card re-renders only when its own data changes (a drag reorders the
  // cards on every step; re-rendering all of them made it stutter)
  // The cards' p changes only with what they show: App passes a new props object on every render of its own (the game
  // lock, mod details, an inline menu handler), and each one re-rendered every card. Its functions read the live props
  const live = useRef(p)
  live.current = p
  const cardP = useMemo<LoadoutProps>(() => ({ ...live.current, reload: () => live.current.reload(), isBlocked: () => live.current.isBlocked(),
    onModContextMenu: (e, m, rename) => live.current.onModContextMenu?.(e, m, rename) }), [p.mods, p.modDetails, p.alert, p.blocked, p.scopeMods, p.scopeLabel])
  const pickCard = useStableCallback((e: React.PointerEvent<HTMLElement>, id: string) => { if (!filtered) drag.onPointerDown(e, id) }) // no reordering a filtered view
  const toggleCard = useStableCallback((l: Loadout, on: boolean) => toggle(l, on))
  const startRename = useStableCallback((l: Loadout) => { setDraft(l.name); setRenaming(l.id) })
  const commitCard = useStableCallback((l: Loadout) => commitRename(l))
  const cancelRename = useStableCallback(() => setRenaming(null))

  useEffect(() => {
    if (view !== 'home') return
    // Stay mounted through mouseup/auxclick so WebView's native back never follows the page close.
    const mouseBack = (e: MouseEvent) => {
      if (e.button !== 3) return
      e.preventDefault()
      e.stopPropagation()
      if (e.type === 'mousedown' && openRef.current && !modalOpen()) closePage()
    }
    const events = ['mousedown', 'mouseup', 'auxclick'] as const
    for (const type of events) window.addEventListener(type, mouseBack, true)
    return () => { for (const type of events) window.removeEventListener(type, mouseBack, true) }
  }, [view])

  useEffect(() => {
    if (view !== 'home') return
    // Esc on a loadout page goes back to the cards (a text field, an open menu or a dialog takes its own Esc first)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current && !isTyping(e.target) && !modalOpen() && !document.querySelector('[role="menu"], .custom-dropdown-menu, .ct-pop')) { e.stopPropagation(); closePage() }
    }
    // Ctrl+V with an image, GIF or video sets the open loadout's media, or the hovered card's
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || modalOpen()) return // a dialog is open: the cards behind it keep their media
      const file = [...(e.clipboardData?.files ?? [])].find(f => /^(image|video)\//.test(f.type))
      if (!file) return
      e.preventDefault()
      const id = openRef.current ?? hovered.current
      if (id) setMedia(id, file)
      else p.alert.info('Hover a card first', 'Point at the loadout card, then paste.')
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('paste', onPaste) }
  }, [view])

  // repakxtra: + New's menu opens on its first item, arrows move while focus is in it, an outside click, Tab or Esc closes
  // it (Esc gives focus back)
  useEffect(() => {
    if (!newMenu) return
    newWrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const close = (e: MouseEvent) => { if (!newWrap.current?.contains(e.target as Node)) setNewMenu(false) }
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setNewMenu(false); newRef.current?.focus(); return }
      // focus back on + New first, so Tab moves on from it (the closed menu's item would leave focus nowhere)
      if (e.key === 'Tab') { if (newWrap.current?.contains(document.activeElement)) newRef.current?.focus(); setNewMenu(false); return }
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !newWrap.current?.contains(document.activeElement)) return
      e.preventDefault()
      const all = [...(newWrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      const i = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', keys, true) }
  }, [newMenu])
  // Generate all previews' choice menu closes on an outside click or Esc (above the early return: hooks run every render)
  useEffect(() => {
    if (!genMenu) return
    const close = (e: MouseEvent) => { if (!genRef.current?.contains(e.target as Node)) setGenMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setGenMenu(false) } }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true) }
  }, [genMenu])
  // A preview run lives in the Generate all previews button (its count, and Stop in its menu), not in a row of its own.
  // Its menu closes when a run starts or ends, so it never shows the other menu's choices by surprise
  useEffect(() => { if (view !== 'home') { setNewMenu(false); setGenMenu(false) } }, [view])
  useEffect(() => setGenMenu(false), [Boolean(batch)]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (batch) runJobs.current = Math.max(runJobs.current, batch.jobs) }, [batch?.jobs]) // eslint-disable-line react-hooks/exhaustive-deps
  // When the whole run has ended: its result as a toast (once), unless a failure toast already said it
  useEffect(() => {
    if (batch || !lastRun) return
    const jobs = runJobs.current
    runJobs.current = 0
    dismissPreviewSummary()
    if (/failed/.test(lastRun)) return
    if (/made/.test(lastRun)) p.alert.success('Previews done', jobs > 1 ? `${plural(jobs, 'loadout')} rendered.` : `${lastRun}.`)
    else p.alert.info(lastRun === 'Stopped' ? 'Previews stopped' : 'Previews', `${lastRun}.`)
  }, [batch, lastRun]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (l: Loadout, on: boolean) => {
    setBusy(l.id)
    await runChanges(p, l, on ? changesToTurnOn(l, p.mods) : changesToTurnOff(l, p.mods), on ? 'on' : 'off')
    setBusy(null)
  }

  const pickMedia = (id: string) => {
    mediaTarget.current = id
    fileRef.current?.click()
  }

  /** A new empty loadout opens straight on its page with its name selected: making one starts with naming it */
  const createEmpty = () => {
    const list = readLoadouts()
    const l: Loadout = { id: crypto.randomUUID(), name: nextLoadoutName(list.map(x => x.name)), label: 'Other', scope: [], on: [] }
    writeLoadouts([...list, l])
    openLoadout(l.id, true)
  }
  /** First-run shortcut: everything that is on right now becomes one loadout */
  const createFromOn = () => {
    const l = snapshotLoadout({ id: crypto.randomUUID(), name: 'What is on now' }, p.mods.filter(m => m.enabled), 'Other')
    writeLoadouts([...readLoadouts(), l])
    openLoadout(l.id, true)
  }

  /** Generate all: with no previews yet it just starts; otherwise it asks whether to redo the ones already made. */
  const withPreview = loadouts.filter(loadoutHasPreview).length
  const generate = async (which: 'missing' | 'all') => {
    setGenMenu(false)
    const { count, error } = await generateAllLoadouts(loadouts, p.mods, which)
    if (error) p.alert.warning('Previews not started', error)
    else if (!count) p.alert.info('Nothing to generate', 'Every loadout with installed mods already has a preview.')
    else p.alert.success('Previews queued', `${plural(count, 'loadout')}, one after another.`)
  }

  const commitRename = (l: Loadout) => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== l.name) patchLoadout(l.id, { name: trimmed })
    setRenaming(null)
  }

  const byKey = modsByKey(p.mods)
  const dragFrom = drag.dragId ? loadouts.find(l => l.id === drag.dragId)?.label : undefined
  // Collection mode: every saved collection in its order (empty ones too, as drop targets), then Other for the rest
  // (kept while its last card is dragged out, so it can go back)
  const keepOther = Boolean(drag.dragId) && !savedGroups.some(g => groupKey(g) === groupKey(dragFrom ?? ''))
  const grouped = (list: Loadout[]): [string, Loadout[]][] => {
    const ungrouped = list.filter(l => !savedGroups.some(g => inGroup(l, g)))
    return [...savedGroups.map(g => [g, list.filter(l => inGroup(l, g))] as [string, Loadout[]]),
            ...(ungrouped.length || keepOther ? [[OTHER, ungrouped] as [string, Loadout[]]] : [])]
  }
  // A spot's place in its collection as the loadout it goes before (or after the last one), in the saved order
  const heroGroups = (list: Loadout[]) => byHero(list, l => heroOf(l, byKey, p.modDetails))
  function besideOf(id: string, s: { group: string; index: number }) {
    const members = ((groupBy === 'hero' ? heroGroups(loadouts) : grouped(loadouts)).find(([g]) => groupKey(g) === groupKey(s.group))?.[1] ?? []).filter(l => l.id !== id)
    return s.index < members.length ? { id: members[s.index].id, after: false } : members.length ? { id: members[members.length - 1].id, after: true } : undefined
  }
  // While a card is dragged, the order it would make if dropped now (a search shows only its matches, and no drag)
  const shown = filtered ? matching : !(drag.dragId && spot && 'group' in spot) ? loadouts
    : groupBy === 'hero' ? movedBeside(loadouts, drag.dragId, besideOf(drag.dragId, spot))
    : placed(loadouts, drag.dragId, spot.group, besideOf(drag.dragId, spot))
  const groups: [string, Loadout[]][] = (groupBy === 'hero' ? heroGroups(shown) : grouped(shown)).filter(([, list]) => !filtered || list.length > 0)
  const search = (v: string) => {
    if (!q && v.trim()) scrollBefore.current = cardsEl?.scrollTop ?? 0
    else if (q && !v.trim()) requestAnimationFrame(() => cardsEl?.scrollTo({ top: scrollBefore.current }))
    setQuery(v)
  }
  const clearSearch = () => { search(''); searchRef.current?.focus() } // its button goes away: focus stays in the search
  const newGroup = () => { setGroupBy('group'); setEditingGroup(addGroup()) }

  const hidden = (
    <>
      <input ref={fileRef} type="file" accept="image/*,video/*" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f && mediaTarget.current) setMedia(mediaTarget.current, f); e.target.value = '' }} />
    </>
  )

  // repakxtra: Smart loadouts, a page of its own (Back or Esc returns to the cards)
  // Hidden behind another view: a loadout page or Smart loadouts is not kept, nor an open menu (their window key
  // handlers would keep taking keys in the Library). Only the cards stay, which is what makes coming back instant
  if (view !== 'home' && (open || smart)) return null
  if (smart) return <div className="lo-screen sl-screen" aria-label="Smart loadouts"><SmartLoadouts p={p} onBack={() => { setSmart(false); requestAnimationFrame(() => newRef.current?.focus()) }} /></div>

  if (open) {
    return (
      <div className="lo-screen" aria-label={`Loadout ${open.name}`}>
        {hidden}
        <div className="lo-body">
          <LoadoutPage p={p} l={open} busy={busy === open.id} onToggle={on => toggle(open, on)} onBack={closePage}
            onPickMedia={() => pickMedia(open.id)} onSetCapture={image => setMedia(open.id, image, 'capture')} />
        </div>
      </div>
    )
  }

  return (
    <div className="lo-screen" aria-label="Loadouts" data-small={cardZoom < 0.8 || undefined} style={{ '--lo-card-zoom': cardZoom } as CSSProperties}>
      {hidden}
      {/* several previews in a row: how far the whole queue is, along the top edge (each card shows its own) */}
      {batch && batch.jobs > 1 && (
        <div className="lo-gen-bar" role="progressbar" aria-label="Generating previews" aria-valuemin={0} aria-valuemax={batch.jobs} aria-valuenow={batch.job - 1}>
          <i style={{ width: `${Math.min(100, ((batch.job - 1 + (batch.total ? batch.done / batch.total : 0)) / batch.jobs) * 100)}%` }} />
        </div>
      )}
      {/* repakxtra: three parts that never collide: the title row and the view controls on top, the actions on their own
          row under the title (one line of nine buttons wrapped unevenly at most window widths) */}
      <header className="lo-screen-head">
        <div className="lo-head-main">
          <div className="lo-title-row">
            <h2>Loadouts</h2>
            {loadouts.length > 0 && (
              <label className="lp-search lo-search">
                <Search size={14} aria-hidden="true" />
                <input ref={searchRef} value={query} placeholder="Search loadouts" aria-label="Search loadouts by name or collection" onChange={e => search(e.target.value)}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') search('') }} />
                {query && <button type="button" className="lo-icon" aria-label="Clear search" title="Clear search" onClick={clearSearch}><X size={13} /></button>}
              </label>
            )}
            {/* beside the search: both narrow which cards show */}
            {loadouts.length > 0 && (
              <div className="mod-state-filter lo-groupby lo-show" role="group" aria-label="Show loadouts">
                <button type="button" aria-pressed={!onlyOn} onClick={() => setOnlyOn(false)} title="Every loadout">All</button>
                <button type="button" aria-pressed={onlyOn} onClick={() => setOnlyOn(true)} title="Only loadouts with mods on, fully or partly">On</button>
              </div>
            )}
            <span className="xtra-sr-only" role="status">{said}</span>
          </div>
        </div>
        <div className="lo-head-view">
          <CardZoomControl />
          <div className="mod-state-filter lo-groupby" role="group" aria-label="Sort loadouts by">
            <button type="button" aria-pressed={groupBy === 'group'} onClick={() => setGroupBy('group')} title="Your collections">Collection</button>
            <button type="button" aria-pressed={groupBy === 'hero'} onClick={() => setGroupBy('hero')}>Hero</button>
          </div>
        </div>
        <div className="lo-head-tools">
          {/* repakxtra: one + New for the three ways to make something, so the head fits one line (Hick's law: the rare ones
              are a click away, not always on screen) */}
          <div className="lo-new" ref={newWrap}>
            <button type="button" ref={newRef} className="lo-text-btn" data-tour="new-loadout" aria-haspopup="menu" aria-expanded={newMenu}
              onClick={() => setNewMenu(v => !v)} title="Make a loadout, group your mods into loadouts, or add a collection">
              <Plus size={14} /> New <ChevronDown size={13} className="lo-new-chev" aria-hidden="true" />
            </button>
            {newMenu && (
              <div className="sigeon-menu lo-gen-menu lo-new-menu" role="menu" aria-label="New">
                <button type="button" role="menuitem" className="sigeon-item" disabled={p.mods.length === 0} onClick={() => { setNewMenu(false); setSmart(true) }}
                  title="Make loadouts from the mods that are in none: mods that share a look become one loadout, a lone mod gets its own">
                  <span><Shapes size={14} /> Smart loadouts</span><small>from your mods</small>
                </button>
                <button type="button" role="menuitem" className="sigeon-item" onClick={() => { setNewMenu(false); createEmpty() }}>
                  <span><Plus size={14} /> New loadout</span><small>empty</small>
                </button>
                <button type="button" role="menuitem" className="sigeon-item" data-tour="new-collection" onClick={() => { setNewMenu(false); newGroup() }}
                  title="A new collection: a named shelf for loadouts that belong together (drag cards onto it)">
                  <span><FolderPlus size={14} /> New collection</span><small>empty</small>
                </button>
              </div>
            )}
          </div>
          {!canGenerate && <PreviewsUnavailable className="lo-text-btn" label="Generate all previews" />}
          {canGenerate && <div className="lo-gen" ref={genRef}>
            {/* While a run goes: how far it is (shimmering), and its menu has the step it is on and Stop */}
            <button type="button" className="lo-text-btn" disabled={loadouts.length === 0 && !batch} aria-haspopup={batch || withPreview > 0 ? 'menu' : undefined}
              aria-expanded={batch || withPreview > 0 ? genMenu : undefined}
              title={batch ? `Generating previews for ${batch.name}` : 'Render a preview for every loadout, one after another (each card shows its progress)'}
              onClick={() => (batch || withPreview > 0 ? setGenMenu(v => !v) : generate('all'))}>
              {batch
                ? <span className="lo-gen-label t-shimmer-all"><WandSparkles size={14} />{batch.jobs > 1 ? `Previews ${batch.job} of ${batch.jobs}` : 'Generating preview'}</span>
                : <><WandSparkles size={14} />Generate all previews</>}
            </button>
            {genMenu && batch && (
              <div className="sigeon-menu lo-gen-menu" role="menu">
                <div className="lo-gen-status" role="status"><b>{batch.name}</b><span>{stage || 'Starting…'}</span></div>
                <button type="button" role="menuitem" className="sigeon-item run-stop-btn" disabled={batch.stopping} onClick={() => { setGenMenu(false); stopPreviews() }}
                  title={batch.left ? 'Stop now and clear the queue' : 'Stop now'}>
                  <span className="lo-gen-stop"><span className="stop-glyph" aria-hidden="true" />{batch.stopping ? 'Stopping…' : batch.left ? 'Stop all' : 'Stop'}</span>
                </button>
              </div>
            )}
            {genMenu && !batch && (
              <div className="sigeon-menu lo-gen-menu" role="menu">
                <button type="button" role="menuitem" className="sigeon-item" disabled={withPreview === loadouts.length} onClick={() => generate('missing')}>
                  <span>Only the ones without a preview</span><small>{loadouts.length - withPreview}</small>
                </button>
                <button type="button" role="menuitem" className="sigeon-item" onClick={() => generate('all')}>
                  <span>Regenerate every loadout</span><small>{loadouts.length}</small>
                </button>
              </div>
            )}
          </div>}
        </div>
      </header>
      <div className="lo-body" ref={setCardsEl}>
        {loadouts.length === 0 && (
          <div className="lo-first-run">
            <h3>No loadouts yet</h3>
            <p>A loadout is a set of mods you switch on and off together, like one look, one VFX color, or one hero's full set of mods.</p>
            <div className="lo-first-actions">
              {/* repakxtra: with mods and no loadouts, Smart loadouts makes them all at once: the first thing to offer */}
              {p.mods.length > 0 && (
                <button type="button" className="lo-text-btn is-primary" onClick={() => setSmart(true)}>
                  <Shapes size={14} /> Group my mods into loadouts
                </button>
              )}
              {/* only when some mods are on: "the 0 mods that are on now" offered a button that could do nothing */}
              {p.mods.some(m => m.enabled) && (
                <button type="button" className="lo-text-btn" onClick={createFromOn}>
                  <ListChecks size={14} /> Make one from the {plural(p.mods.filter(m => m.enabled).length, 'mod')} that {p.mods.filter(m => m.enabled).length === 1 ? 'is' : 'are'} on now
                </button>
              )}
              <button type="button" className={`lo-text-btn${p.mods.length ? '' : ' is-primary'}`} onClick={createEmpty}><Plus size={14} /> Start an empty one</button>
            </div>
          </div>
        )}

        {/* nothing matches the search or On only: a quiet centered note, not the first-run box (cable, 2026-10-30) */}
        {filtered && loadouts.length > 0 && groups.length === 0 && (
          <div className="lo-no-match" role="status">
            <p>{q ? `No ${onlyOn ? 'loadouts that are on' : 'loadouts'} match “${q}”` : 'No loadouts are on'}</p>
            <div className="lo-first-actions">
              {q && <button type="button" className="lo-text-btn" onClick={clearSearch}>Clear search</button>}
              {onlyOn && <button type="button" className="lo-text-btn" onClick={() => setOnlyOn(false)}>Show all loadouts</button>}
            </div>
          </div>
        )}

        {groups.map(([group, list]) => {
          const foldId = groupBy === 'group' ? `group:${groupKey(group)}` : `hero:${group}`
          const isFolded = folded.has(foldId) && drag.dragId === null && !q // a drag or a search opens every group (the saved folding stays)
          return (
          // A collection lights up while a card from another one would land in it
          <section className={`lo-group ${groupBy === 'group' && drag.dragId && spot && 'group' in spot && groupKey(spot.group) === groupKey(group) && groupKey(dragFrom ?? '') !== groupKey(group) ? 'is-drop' : ''}${isFolded ? ' is-folded' : ''}`}
            key={groupKey(group)} data-group={group}>
            {groupBy === 'group'
              ? <GroupHead p={p} name={group} count={list.length} at={savedGroups.findIndex(g => groupKey(g) === groupKey(group))} total={savedGroups.length} folded={isFolded} onFold={() => fold(foldId)}
                  editing={editingGroup !== null && groupKey(editingGroup) === groupKey(group)} setEditing={setEditingGroup} />
              : <div className="lo-group-head" data-flip={`head:${group}`}><FoldButton name={group} folded={isFolded} onFold={() => fold(foldId)} />
                  <span className="lo-group-name" role="heading" aria-level={3} onClick={() => fold(foldId)} title={`Click to ${isFolded ? 'show' : 'collapse'}`}>{group}</span><span className="lo-group-count">{list.length}</span></div>}
            {isFolded ? null : <>
            {list.length === 0 && <p className="lo-group-empty">Empty. Drag a loadout card here, or pick this collection on a loadout's page.</p>}
            <div className="lo-grid">
              {list.map(l => (
                <LoadoutCard key={l.id} p={cardP} l={l} groupBy={groupBy} canGenerate={canGenerate} busy={busy === l.id} anyBusy={busy !== null}
                  renaming={renaming === l.id} draft={renaming === l.id ? draft : ''} placeholder={drag.dragId === l.id} hovered={hovered}
                  onPick={pickCard} onToggle={toggleCard} onStartRename={startRename} onDraft={setDraft} onCommit={commitCard} onCancelRename={cancelRename} />
              ))}
            </div>
            </>}
          </section>
          )
        })}

        {loadouts.length > 0 && !(filtered && groups.length === 0) && (
          <div className="lo-grid">
            {/* A real card's parts, unseen, give it a real card's size at every width; the plus and words sit on top */}
            <div className="lo-card lo-card-new" data-flip="new">
              <div className="lo-card-ghost" aria-hidden="true" ref={el => el?.setAttribute('inert', '')}>
                <div className="lo-card-image" />
                <div className="lo-card-body">
                  <div className="lo-card-title"><h3>&nbsp;</h3><Switch size="sm" checked={false} /></div>
                  <p className="lo-card-meta">&nbsp;</p>
                  <div className="lo-card-actions"><span className="lo-expand">&nbsp;</span></div>
                </div>
              </div>
              {/* laid out like a real card: the plus where a preview goes, the name and status line below it */}
              <button type="button" className="lo-card-add" onClick={createEmpty}>
                <span className="lo-card-add-media"><span className="lo-card-add-icon"><CopyPlus size={20} /></span></span>
                <span className="lo-card-add-body">
                  <span className="lo-card-add-title">New loadout</span>
                  <small className="lo-card-meta">Start empty, add mods later</small>
                </span>
              </button>
            </div>
          </div>
        )}

        {/* below the loadouts: Home is for switching them; this is the inbox of recent mods */}
        {builtins && <BuiltinMods blocked={p.blocked} alert={p.alert} />}
        {newStrip && <NewStrip {...p} />}
      </div>
    </div>
  )
}
