// repakxtra: Home, the app's first view. Loadouts as cards (image, on/off switch), grouped by collection or hero, with
// the "New this week" strip below them; a card opens its page (LoadoutPage.tsx). The full mod list is the Library
// view (header tabs, or L). On = its mods on, Off = its mods off; other mods and loadouts are never touched.
import { type CSSProperties, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStableCallback } from '../hooks/useStableCallback'
import { ChevronDown, ChevronUp, FolderPlus, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo, runChanges } from './Loadouts'
import LoadoutPage from './LoadoutPage'
import NewStrip from './NewStrip'
import { isTyping } from './hotkeys'
import { CardMedia, OnDot } from './loadoutBits'
import { CardZoomControl, useCardZoom, useWheelZoom } from './cardZoom'
import { type Spot, playFlip, snapshotCards, useCardDrag } from './cardDrag'
import { prepareMedia, putMedia } from './loadoutMedia'
import { plural } from './modName'
import { MatrixLoader, Num } from './motion'
import { PreviewsUnavailable, dismissPreviewSummary, generateAllLoadouts, loadoutHasPreview, stopPreviews, usePreviewFailureToast, usePreviewsAvailable, usePreviewBatch, usePreviewSummary, usePreviewVersion } from './previews'
import {
  type Loadout, type Mod, OTHER, addGroup, changesToTurnOff, changesToTurnOn, deleteGroup, displayName, groupKey,
  inGroup, isActive, modKey, moveGroup, nextLoadoutName, openLoadout, patchLoadout, placeLoadout, placed, readLoadouts, renameGroup,
  setView, snapshotLoadout, sweepMediaOnce, useGroups, useLoadouts, useOpenLoadout, useView, writeLoadouts,
} from './loadoutStore'
import { savedItem } from './storageCarryOver'
import { useUpstreamWatch } from './upstream'

type GroupBy = 'group' | 'hero'
const GROUP_BY_KEY = 'repakxtra.loadoutGroupBy'
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
function GroupHead({ p, name, count, at, total, editing, setEditing }: {
  p: LoadoutProps; name: string; count: number; at: number; total: number; editing: boolean; setEditing: (g: string | null) => void
}) {
  const [draft, setDraft] = useState(name)
  const real = groupKey(name) !== groupKey(OTHER)
  const done = (save: boolean) => { if (save) renameGroup(name, draft); setEditing(null) }
  const remove = () => {
    const undo = deleteGroup(name)
    const id = p.alert.info(`Deleted collection ${name}`, count ? `Its ${plural(count, 'loadout')} moved to Other.` : 'It was empty.', {
      duration: 10000, action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); undo() } },
    })
  }
  return (
    <h3 className="lo-group-head" data-flip={`head:${groupKey(name)}`}>
      {editing && real
        ? <input className="lo-rename lo-group-rename" autoFocus value={draft} aria-label="Collection name"
            onFocus={e => e.target.select()} onChange={e => setDraft(e.target.value)} onBlur={() => done(true)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') { setDraft(name); done(false) } }} />
        : <span className="lo-group-name" onDoubleClick={() => { if (real) { setDraft(name); setEditing(name) } }}
            title={real ? `${name} (double-click to rename)` : 'Loadouts without a collection'}>{name}</span>}
      {real && !editing && (
        <button type="button" className="lo-icon lo-group-pen" aria-label={`Rename ${name}`} title="Rename collection" onClick={() => { setDraft(name); setEditing(name) }}><Pencil size={13} /></button>
      )}
      <span className="lo-group-count"><Num id={`group-${groupKey(name)}`} value={count} /></span>
      {real && !editing && (
        <span className="lo-group-tools">
          <button type="button" className="lo-icon" aria-label={`Move ${name} up`} title="Move up" disabled={at === 0} onClick={() => moveGroup(name, -1)}><ChevronUp size={14} /></button>
          <button type="button" className="lo-icon" aria-label={`Move ${name} down`} title="Move down" disabled={at === total - 1} onClick={() => moveGroup(name, 1)}><ChevronDown size={14} /></button>
          <button type="button" className="lo-icon" aria-label={`Delete collection ${name}`} title="Delete collection (its loadouts move to Other)" onClick={remove}><Trash2 size={13} /></button>
        </span>
      )}
    </h3>
  )
}

/** Home | Library switch for the app header. Its own class: the 1/2/3 hotkeys click the first .mod-state-filter. A tab
 *  always lands on its home: Loadouts on the cards (not a loadout page left open), Library on every mod with no folder,
 *  filter, search or details panel (App.tsx listens). L flips between the two and keeps where each was. */
export function ViewTabs() {
  const view = useView()
  return (
    <div className="view-tabs" role="tablist" aria-label="View" data-tour="view-tabs">
      <button type="button" role="tab" aria-selected={view === 'home'} onClick={() => { openLoadout(null); setView('home') }} title="Loadouts and new mods (L)">Loadouts</button>
      <button type="button" role="tab" aria-selected={view === 'library'} onClick={() => { setView('library'); window.dispatchEvent(new Event('repakxtra-library-home')) }}
        title="Every mod, with filters and folders (L)">Library</button>
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
  const byKey = useMemo(() => new Map(p.mods.map(m => [modKey(m.path), m])), [p.mods])
  const active = isActive(l, p.mods)
  const keys = new Set(l.on.map(displayName))
  const present = [...keys].filter(k => byKey.has(k)).length
  const onNow = [...keys].filter(k => byKey.get(k)?.enabled).length
  const partly = !active && onNow > 0 // some of its mods on: the switch draws a middle state
  const label = present === 0 ? 'No installed mods' : active ? `Turn ${l.name} off` : partly ? `Turn on the rest of ${l.name} (${present - onNow} more)` : `Turn ${l.name} on`
  return (
    <article data-loadout={l.id} className={`lo-card ${active ? 'is-on' : ''}${placeholder ? ' is-placeholder' : ''}`}
      onPointerDown={groupBy === 'group' && !renaming ? e => onPick(e, l.id) : undefined}
      onKeyDown={e => { if (e.key === 'F2' && !isTyping(e.target)) { e.preventDefault(); onStartRename(l) } }}
      onMouseEnter={() => { hovered.current = l.id }} onMouseLeave={() => { if (hovered.current === l.id) hovered.current = null }}>
      <CardMedia p={p} l={l} onClick={() => openLoadout(l.id)} title={`Open ${l.name}`}
        emptyText={canGenerate ? 'No preview yet. Open it to generate one, or hover and paste an image.' : 'No picture yet. Hover and paste an image, or open it to add one.'} />
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
            className={partly ? 'is-partly' : ''} aria-checked={partly ? 'mixed' : active}
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

export default function LoadoutsScreen(p: LoadoutProps) {
  const view = useView()
  const loadouts = useLoadouts()
  const [busy, setBusy] = useState<string | null>(null)
  const openId = useOpenLoadout()
  const setOpenId = openLoadout
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const savedGroups = useGroups()
  const batch = usePreviewBatch()
  const lastRun = usePreviewSummary()
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [groupBy, setGroupByState] = useState<GroupBy>(() => (savedItem(GROUP_BY_KEY) === 'hero' ? 'hero' : 'group'))
  const setGroupBy = (g: GroupBy) => { localStorage.setItem(GROUP_BY_KEY, g); setGroupByState(g) }
  const fileRef = useRef<HTMLInputElement>(null)
  const [genMenu, setGenMenu] = useState(false)
  const canGenerate = usePreviewsAvailable()
  const genRef = useRef<HTMLDivElement>(null)
  const cardZoom = useCardZoom()
  const [cardsEl, setCardsEl] = useState<HTMLDivElement | null>(null)
  useWheelZoom(cardsEl)
  // Dragging a card (Collection view, custom/cardDrag.ts): `spot` is where it would land; the cards show that order
  // live, sliding from where they were (flipFrom, taken just before each change)
  const [spot, setSpot] = useState<Spot | null>(null)
  const flipFrom = useRef<Map<string, DOMRect> | null>(null)
  const drag = useCardDrag({
    zoom: cardZoom, scroller: cardsEl,
    onMove: (_id, s) => { flipFrom.current = snapshotCards(cardsEl); setSpot(s) },
    onDrop: (id, s) => {
      flipFrom.current = snapshotCards(cardsEl)
      setSpot(null)
      if (!s) return
      if ('newCollection' in s) { const name = addGroup(); placeLoadout(id, name); setGroupBy('group'); setEditingGroup(name) }
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

  /** Stores the loadout's picture; false (with the reason shown) when it could not be saved. */
  const setMedia = async (id: string, file: Blob) => {
    try {
      const { blob, type } = await prepareMedia(file)
      await putMedia(id, blob)
      patchLoadout(id, { mediaType: type, mediaRev: Date.now(), image: undefined })
      return true
    } catch (e) {
      p.alert.warning('Media not saved', e instanceof Error ? e.message : String(e))
      return false
    }
  }

  useEffect(sweepMediaOnce, []) // stored media of loadouts deleted in an earlier session

  // The cards' handlers keep one identity, so a card re-renders only when its own data changes (a drag reorders the
  // cards on every step; re-rendering all of them made it stutter)
  const pickCard = useStableCallback((e: React.PointerEvent<HTMLElement>, id: string) => drag.onPointerDown(e, id))
  const toggleCard = useStableCallback((l: Loadout, on: boolean) => toggle(l, on))
  const startRename = useStableCallback((l: Loadout) => { setDraft(l.name); setRenaming(l.id) })
  const commitCard = useStableCallback((l: Loadout) => commitRename(l))
  const cancelRename = useStableCallback(() => setRenaming(null))

  useEffect(() => {
    if (view !== 'home') return
    // Esc on a loadout page goes back to the cards (a text field, an open menu or a dialog takes its own Esc first)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current && !isTyping(e.target) && !document.querySelector('.modal-overlay, [role="menu"], .custom-dropdown-menu')) { e.stopPropagation(); closePage() }
    }
    // Ctrl+V with an image, GIF or video sets the open loadout's media, or the hovered card's
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return
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

  // Generate all previews' choice menu closes on an outside click or Esc (above the early return: hooks run every render)
  useEffect(() => {
    if (!genMenu) return
    const close = (e: MouseEvent) => { if (!genRef.current?.contains(e.target as Node)) setGenMenu(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setGenMenu(false) } }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc, true) }
  }, [genMenu])
  if (view !== 'home') return null

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
  const withPreview = loadouts.filter(l => loadoutHasPreview(l) || l.mediaRev || l.image).length // its own image counts: the menu then offers to keep it
  const generate = async (which: 'missing' | 'all') => {
    setGenMenu(false)
    const { count, error } = await generateAllLoadouts(loadouts, p.mods, which)
    if (error) p.alert.warning('Previews not started', error)
    else if (!count) p.alert.info('Nothing to generate', 'Every loadout with installed mods already has a preview or its own image.')
    else p.alert.success('Previews queued', `${plural(count, 'loadout')}, one after another.`)
  }

  const commitRename = (l: Loadout) => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== l.name) patchLoadout(l.id, { name: trimmed })
    setRenaming(null)
  }

  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
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
  function besideOf(id: string, s: { group: string; index: number }) {
    const members = (grouped(loadouts).find(([g]) => groupKey(g) === groupKey(s.group))?.[1] ?? []).filter(l => l.id !== id)
    return s.index < members.length ? { id: members[s.index].id, after: false } : members.length ? { id: members[members.length - 1].id, after: true } : undefined
  }
  // While a card is dragged, the order it would make if dropped now
  const shown = drag.dragId && spot && 'group' in spot ? placed(loadouts, drag.dragId, spot.group, besideOf(drag.dragId, spot)) : loadouts
  const groups: [string, Loadout[]][] = groupBy === 'hero' ? byHero(loadouts, l => heroOf(l, byKey, p.modDetails)) : grouped(shown)
  const newGroup = () => { setGroupBy('group'); setEditingGroup(addGroup()) }

  const hidden = (
    <>
      <input ref={fileRef} type="file" accept="image/*,video/*" hidden
        onChange={e => { const f = e.target.files?.[0]; if (f && mediaTarget.current) setMedia(mediaTarget.current, f); e.target.value = '' }} />
    </>
  )

  if (open) {
    return (
      <div className="lo-screen" aria-label={`Loadout ${open.name}`}>
        {hidden}
        <div className="lo-body">
          <LoadoutPage p={p} l={open} busy={busy === open.id} onToggle={on => toggle(open, on)} onBack={closePage}
            onPickMedia={() => pickMedia(open.id)} onSetMedia={image => setMedia(open.id, image)} />
        </div>
      </div>
    )
  }

  return (
    <div className="lo-screen" aria-label="Loadouts" style={{ '--lo-card-zoom': cardZoom } as CSSProperties}>
      {hidden}
      <header className="lo-screen-head">
        <div>
          <h2>Loadouts</h2>
          {loadouts.length < 3 && <p>Switch a set of mods on or off together. Other mods stay as they are.</p>}
        </div>
        <div className="lo-head-tools">
          <button type="button" ref={newRef} className="lo-text-btn" data-tour="new-loadout" onClick={createEmpty} title="A new empty loadout, opened to add mods to it">
            <Plus size={14} /> New loadout
          </button>
          {/* Also a drop target: a card dropped here starts a new collection, named right away */}
          <button type="button" className={`lo-text-btn${spot && 'newCollection' in spot ? ' is-drop' : ''}`} data-tour="new-collection" onClick={newGroup}
            data-drop-new title="A new collection: a named shelf for loadouts that belong together (drag cards onto it, or a card onto this button)">
            <FolderPlus size={14} /> {drag.dragId ? 'Drop for a new collection' : 'New collection'}
          </button>
          {!canGenerate && <PreviewsUnavailable className="lo-text-btn" label="Generate all previews" />}
          {canGenerate && <div className="lo-gen" ref={genRef}>
            <button type="button" className="lo-text-btn" disabled={loadouts.length === 0} aria-haspopup={withPreview > 0 ? 'menu' : undefined}
              aria-expanded={withPreview > 0 ? genMenu : undefined}
              title="Render a preview for every loadout, one after another (each card shows its progress)"
              onClick={() => (withPreview > 0 ? setGenMenu(v => !v) : generate('all'))}>
              <Sparkles size={14} /> Generate all previews
            </button>
            {genMenu && (
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
          <CardZoomControl />
          <div className="mod-state-filter lo-groupby" role="group" aria-label="Sort loadouts by">
            <button type="button" aria-pressed={groupBy === 'group'} onClick={() => setGroupBy('group')} title="Your collections">Collection</button>
            <button type="button" aria-pressed={groupBy === 'hero'} onClick={() => setGroupBy('hero')}>Hero</button>
          </div>
        </div>
      </header>
      {batch && (
        <div className="lo-batch" role="status">
          <MatrixLoader />
          <span className="lo-batch-what"><span className="t-shimmer">Generating preview</span><b>{batch.name}</b></span>
          {batch.jobs > 1 && <span className="lo-batch-left">{batch.job} of {batch.jobs}</span>}
          <button type="button" className="lo-text-btn lo-batch-stop run-stop-btn" onClick={stopPreviews} disabled={batch.stopping}
            title={batch.left ? 'Stop now and clear the queue' : 'Stop now'}>
            <span className="stop-glyph" aria-hidden="true" />{batch.stopping ? 'Stopping…' : batch.left ? 'Stop all' : 'Stop'}
          </button>
        </div>
      )}
      {!batch && lastRun && (
        <div className="lo-batch is-summary" role="status">
          <span>Last preview run: {lastRun}</span>
          <button type="button" className="lo-text-btn lo-batch-stop" onClick={dismissPreviewSummary}>Dismiss</button>
        </div>
      )}

      <div className="lo-body" ref={setCardsEl}>

        {loadouts.length === 0 && (
          <div className="lo-first-run">
            <h3>No loadouts yet</h3>
            <p>A loadout is a set of mods you switch on and off together, like one look, one VFX color or one emote wheel.</p>
            <div className="lo-first-actions">
              <button type="button" className="lo-text-btn is-primary" onClick={createFromOn} disabled={!p.mods.some(m => m.enabled)}
                title={p.mods.some(m => m.enabled) ? undefined : 'No mods are on right now'}>
                Make one from the {p.mods.filter(m => m.enabled).length} mods that are on now
              </button>
              <button type="button" className="lo-text-btn" onClick={createEmpty}>Start an empty one</button>
            </div>
          </div>
        )}

        {groups.map(([group, list], gi) => (
          // A collection lights up while a card from another one would land in it
          <section className={`lo-group ${drag.dragId && spot && 'group' in spot && groupKey(spot.group) === groupKey(group) && groupKey(dragFrom ?? '') !== groupKey(group) ? 'is-drop' : ''}`}
            key={groupKey(group)} data-group={groupBy === 'group' ? group : undefined}>
            {groupBy === 'group'
              ? <GroupHead p={p} name={group} count={list.length} at={gi} total={savedGroups.length}
                  editing={editingGroup !== null && groupKey(editingGroup) === groupKey(group)} setEditing={setEditingGroup} />
              : <h3 className="lo-group-head" data-flip={`head:${group}`}><span className="lo-group-name">{group}</span><span className="lo-group-count"><Num id={`hero-${group}`} value={list.length} /></span></h3>}
            {list.length === 0 && <p className="lo-group-empty">Empty. Drag a loadout card here, or pick this collection on a loadout's page.</p>}
            <div className="lo-grid">
              {list.map(l => (
                <LoadoutCard key={l.id} p={p} l={l} groupBy={groupBy} canGenerate={canGenerate} busy={busy === l.id} anyBusy={busy !== null}
                  renaming={renaming === l.id} draft={renaming === l.id ? draft : ''} placeholder={drag.dragId === l.id} hovered={hovered}
                  onPick={pickCard} onToggle={toggleCard} onStartRename={startRename} onDraft={setDraft} onCommit={commitCard} onCancelRename={cancelRename} />
              ))}
            </div>
          </section>
        ))}

        {loadouts.length > 0 && (
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
              <button type="button" className="lo-card-add" onClick={createEmpty}>
                <span className="lo-card-add-icon"><Plus size={20} /></span>
                <span className="lo-card-add-title">New loadout</span>
                <small>Start empty, then add mods to it</small>
              </button>
            </div>
          </div>
        )}

        {/* below the loadouts: Home is for switching them; this is the inbox of recent mods */}
        <NewStrip {...p} />
      </div>
    </div>
  )
}
