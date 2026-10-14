// caleb fork: Home, the app's first view. Loadouts as cards (image, on/off switch), grouped by saved group or hero, with
// the "New this week" strip below them; a card opens its page (LoadoutPage.tsx). The full mod list is the Library
// view (header tabs, or L). On = its mods on, Off = its mods off; other mods and loadouts are never touched.
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, CircleStop, Download, FolderPlus, LoaderCircle, PackagePlus, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo, runChanges } from './Loadouts'
import LoadoutPage from './LoadoutPage'
import NewStrip from './NewStrip'
import { isTyping } from './hotkeys'
import { CardMedia } from './loadoutBits'
import { prepareMedia, putMedia } from './loadoutMedia'
import { plural } from './modName'
import { Num } from './motion'
import { dismissPreviewSummary, generateAllLoadouts, stopPreviews, usePreviewBatch, usePreviewSummary } from './previews'
import {
  type Loadout, type Mod, OTHER, addGroup, changesToTurnOff, changesToTurnOn, deleteGroup, displayName, exportLoadouts, groupKey,
  importLoadouts, inGroup, isActive, modKey, moveGroup, nextLoadoutName, openLoadout, patchLoadout, readLoadouts, renameGroup,
  setLoadoutGroup, setView, snapshotLoadout, sweepMediaOnce, useGroups, useLoadouts, useOpenLoadout, useView, writeLoadouts,
} from './loadoutStore'

type GroupBy = 'group' | 'hero'
const GROUP_BY_KEY = 'caleb.loadoutGroupBy'
const NO_HERO = 'No hero'

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

/** Hero sections, A to Z with "No hero" last. */
function byHero(list: Loadout[], heroOfL: (l: Loadout) => string) {
  const map = new Map<string, Loadout[]>()
  for (const l of list) map.set(heroOfL(l), [...(map.get(heroOfL(l)) ?? []), l])
  return [...map].sort(([a], [b]) => Number(a === NO_HERO) - Number(b === NO_HERO) || a.localeCompare(b))
}

/** A group's header on Home: its name (double-click or the pencil to rename), its count, and on hover or focus
 *  Move up, Move down and Delete (with Undo). Other is not a real group, so it has none of these. */
function GroupHead({ p, name, count, at, total, editing, setEditing }: {
  p: LoadoutProps; name: string; count: number; at: number; total: number; editing: boolean; setEditing: (g: string | null) => void
}) {
  const [draft, setDraft] = useState(name)
  const real = groupKey(name) !== groupKey(OTHER)
  const done = (save: boolean) => { if (save) renameGroup(name, draft); setEditing(null) }
  const remove = () => {
    const undo = deleteGroup(name)
    const id = p.alert.info(`Deleted group ${name}`, count ? `Its ${plural(count, 'loadout')} moved to Other.` : 'It was empty.', {
      duration: 10000, action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); undo() } },
    })
  }
  return (
    <h3 className="lo-group-head">
      {editing && real
        ? <input className="lo-rename lo-group-rename" autoFocus value={draft} aria-label="Group name"
            onFocus={e => e.target.select()} onChange={e => setDraft(e.target.value)} onBlur={() => done(true)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') { setDraft(name); done(false) } }} />
        : <span className="lo-group-name" onDoubleClick={() => { if (real) { setDraft(name); setEditing(name) } }}
            title={real ? `${name} (double-click to rename)` : 'Loadouts without a group'}>{name}</span>}
      <span className="lo-group-count"><Num id={`group-${groupKey(name)}`} value={count} /></span>
      {real && !editing && (
        <span className="lo-group-tools">
          <button type="button" className="lo-icon" aria-label={`Rename ${name}`} title="Rename" onClick={() => { setDraft(name); setEditing(name) }}><Pencil size={13} /></button>
          <button type="button" className="lo-icon" aria-label={`Move ${name} up`} title="Move up" disabled={at === 0} onClick={() => moveGroup(name, -1)}><ChevronUp size={14} /></button>
          <button type="button" className="lo-icon" aria-label={`Move ${name} down`} title="Move down" disabled={at === total - 1} onClick={() => moveGroup(name, 1)}><ChevronDown size={14} /></button>
          <button type="button" className="lo-icon" aria-label={`Delete group ${name}`} title="Delete group (its loadouts move to Other)" onClick={remove}><Trash2 size={13} /></button>
        </span>
      )}
    </h3>
  )
}

/** Home | Library switch for the app header. Its own class: the 1/2/3 hotkeys click the first .mod-state-filter. */
export function ViewTabs() {
  const view = useView()
  return (
    <div className="view-tabs" role="tablist" aria-label="View">
      <button type="button" role="tab" aria-selected={view === 'home'} onClick={() => setView('home')} title="Loadouts and new mods (L)">Home</button>
      <button type="button" role="tab" aria-selected={view === 'library'} onClick={() => setView('library')} title="Every mod, with filters and folders (L)">Library</button>
    </div>
  )
}

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
  const [dropGroup, setDropGroup] = useState<string | null>(null)
  const [groupBy, setGroupByState] = useState<GroupBy>(() => (localStorage.getItem(GROUP_BY_KEY) === 'hero' ? 'hero' : 'group'))
  const setGroupBy = (g: GroupBy) => { localStorage.setItem(GROUP_BY_KEY, g); setGroupByState(g) }
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
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

  const setMedia = async (id: string, file: File) => {
    try {
      const { blob, type } = await prepareMedia(file)
      await putMedia(id, blob)
      patchLoadout(id, { mediaType: type, mediaRev: Date.now(), image: undefined })
    } catch (e) {
      p.alert.error('Media not saved', e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(sweepMediaOnce, []) // stored media of loadouts deleted in an earlier session

  useEffect(() => {
    if (view !== 'home') return
    // Esc on a loadout page goes back to the cards (a text field takes its own Esc first)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current && !isTyping(e.target) && !document.querySelector('.modal-overlay')) { e.stopPropagation(); closePage() }
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

  /** A new empty loadout opens straight on its page, where mods get added */
  const createEmpty = () => {
    const list = readLoadouts()
    const l: Loadout = { id: crypto.randomUUID(), name: nextLoadoutName(list.map(x => x.name)), label: 'Other', scope: [], on: [] }
    writeLoadouts([...list, l])
    setOpenId(l.id)
  }
  /** First-run shortcut: everything that is on right now becomes one loadout */
  const createFromOn = () => {
    const l = snapshotLoadout({ id: crypto.randomUUID(), name: 'What is on now' }, p.mods.filter(m => m.enabled), 'Other')
    writeLoadouts([...readLoadouts(), l])
    setOpenId(l.id)
  }

  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([exportLoadouts()], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'repakxtra-loadouts.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const commitRename = (l: Loadout) => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== l.name) patchLoadout(l.id, { name: trimmed })
    setRenaming(null)
  }

  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  // Group mode: every saved group in its order (empty ones too, as drop targets), then Other for the rest
  const ungrouped = loadouts.filter(l => !savedGroups.some(g => inGroup(l, g)))
  const groups: [string, Loadout[]][] = groupBy === 'hero'
    ? byHero(loadouts, l => heroOf(l, byKey, p.modDetails))
    : [...savedGroups.map(g => [g, loadouts.filter(l => inGroup(l, g))] as [string, Loadout[]]),
       ...(ungrouped.length ? [[OTHER, ungrouped] as [string, Loadout[]]] : [])]
  const newGroup = () => { setGroupBy('group'); setEditingGroup(addGroup()) }

  const hidden = (
    <>
      <input ref={importRef} type="file" accept=".json,application/json" hidden
        onChange={async e => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (!f) return
          try {
            const { added, skipped } = importLoadouts(await f.text())
            p.alert.success('Loadouts imported', `${added} added${skipped ? `, ${skipped} skipped (same name already exists)` : ''}.`)
          } catch (err) {
            p.alert.error('Import failed', err instanceof Error ? err.message : String(err))
          }
        }} />
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
            onPickMedia={() => pickMedia(open.id)} />
        </div>
      </div>
    )
  }

  return (
    <div className="lo-screen" aria-label="Home">
      {hidden}
      <header className="lo-screen-head">
        <div>
          <h2>Loadouts</h2>
          {loadouts.length < 3 && <p>Switch a set of mods on or off together. Other mods stay as they are.</p>}
        </div>
        <div className="lo-head-tools">
          <button type="button" className="lo-text-btn" title="Install PAKs or archives (Ctrl+O)"
            onClick={() => document.querySelector<HTMLElement>('[title="Install PAKs or Archives"]')?.click()}>
            <PackagePlus size={14} /> Install mods
          </button>
          <button type="button" ref={newRef} className="lo-text-btn" onClick={createEmpty} title="A new empty loadout, opened to add mods to it">
            <Plus size={14} /> New loadout
          </button>
          <button type="button" className="lo-text-btn" disabled={loadouts.length === 0}
            title="Render a preview for every loadout, one after another (each card shows its progress)"
            onClick={async () => {
              const { count, error } = await generateAllLoadouts(loadouts, p.mods)
              if (error) p.alert.warning('Previews not started', error)
              else p.alert.success('Previews queued', `${plural(count, 'loadout')}, one after another.`)
            }}>
            <Sparkles size={14} /> Generate all previews
          </button>
          <button type="button" className="lo-text-btn" onClick={newGroup} title="A new group to sort loadouts into (drag cards onto it)">
            <FolderPlus size={14} /> New group
          </button>
          <div className="mod-state-filter lo-groupby" role="group" aria-label="Group loadouts by">
            <button type="button" aria-pressed={groupBy === 'group'} onClick={() => setGroupBy('group')}>Group</button>
            <button type="button" aria-pressed={groupBy === 'hero'} onClick={() => setGroupBy('hero')}>Hero</button>
          </div>
          <button type="button" className="lo-text-btn" title="Add loadouts from a .json file" onClick={() => importRef.current?.click()}>
            <Upload size={14} /> Import
          </button>
          <button type="button" className="lo-text-btn" title="Save all loadouts to a .json file (images stay in the app)" onClick={exportFile}>
            <Download size={14} /> Export
          </button>
        </div>
      </header>
      {batch && (
        <div className="lo-batch" role="status">
          <LoaderCircle size={14} className="run-spin" />
          <span className="t-shimmer" data-text={`Generating ${batch.name} · mod ${batch.done} of ${batch.total}`}>Generating {batch.name} · mod {batch.done} of {batch.total}</span>
          {batch.left > 0 && <span className="lo-batch-left">{batch.leftText} queued after it</span>}
          <button type="button" className="lo-text-btn lo-batch-stop" onClick={stopPreviews} disabled={batch.stopping}
            title="Stop after the mod rendering now and clear the queue">
            <CircleStop size={14} /> {batch.stopping ? 'Stopping…' : batch.left ? 'Stop all' : 'Stop'}
          </button>
        </div>
      )}
      {!batch && lastRun && (
        <div className="lo-batch is-summary" role="status">
          <span>Last preview run: {lastRun}</span>
          <button type="button" className="lo-text-btn lo-batch-stop" onClick={dismissPreviewSummary}>Dismiss</button>
        </div>
      )}

      <div className="lo-body">

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
          <section className={`lo-group ${dropGroup === group ? 'is-drop' : ''}`} key={groupKey(group)}
            onDragOver={e => { if (groupBy === 'group' && e.dataTransfer.types.includes('text/x-loadout-card')) { e.preventDefault(); setDropGroup(group) } }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropGroup(null) }}
            onDrop={e => { e.preventDefault(); setDropGroup(null); const id = e.dataTransfer.getData('text/x-loadout-card'); if (id) setLoadoutGroup(id, group) }}>
            {groupBy === 'group'
              ? <GroupHead p={p} name={group} count={list.length} at={gi} total={savedGroups.length}
                  editing={editingGroup !== null && groupKey(editingGroup) === groupKey(group)} setEditing={setEditingGroup} />
              : <h3 className="lo-group-head"><span className="lo-group-name">{group}</span><span className="lo-group-count"><Num id={`hero-${group}`} value={list.length} /></span></h3>}
            {list.length === 0 && <p className="lo-group-empty">Empty. Drag a loadout card here, or pick this group on a loadout's page.</p>}
            <div className="lo-grid">
              {list.map(l => {
                const active = isActive(l, p.mods)
                const keys = new Set(l.on.map(displayName))
                const present = [...keys].filter(k => byKey.has(k)).length
                const onNow = [...keys].filter(k => byKey.get(k)?.enabled).length
                return (
                  <article key={l.id} data-loadout={l.id} className={`lo-card ${active ? 'is-on' : ''}`} draggable={groupBy === 'group' && renaming !== l.id}
                    onDragStart={e => { e.dataTransfer.setData('text/x-loadout-card', l.id); e.dataTransfer.effectAllowed = 'move' }}
                    onKeyDown={e => { if (e.key === 'F2' && !isTyping(e.target)) { e.preventDefault(); setDraft(l.name); setRenaming(l.id) } }}
                    onMouseEnter={() => { hovered.current = l.id }} onMouseLeave={() => { if (hovered.current === l.id) hovered.current = null }}>
                    <CardMedia p={p} l={l} onClick={() => setOpenId(l.id)} title={`Open ${l.name}`}
                      emptyText="No preview yet. Open it to generate one, or hover and paste an image." />
                    <div className="lo-card-body">
                      <div className="lo-card-title">
                        {renaming === l.id ? (
                          <input className="lo-rename" autoFocus value={draft} aria-label="Loadout name"
                            onFocus={e => e.target.select()} onChange={e => setDraft(e.target.value)} onBlur={() => commitRename(l)}
                            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(l); if (e.key === 'Escape') setRenaming(null) }} />
                        ) : (
                          <h3 title={`${l.name} (double-click or F2 to rename)`} onDoubleClick={() => { setDraft(l.name); setRenaming(l.id) }}>{l.name}</h3>
                        )}
                        <Switch size="sm" color="primary" checked={active} isDisabled={present === 0} disabled={busy !== null || present === 0}
                          title={present === 0 ? 'No installed mods' : active ? `Turn ${l.name} off` : `Turn ${l.name} on`}
                          aria-label={present === 0 ? 'No installed mods' : active ? `Turn ${l.name} off` : `Turn ${l.name} on`}
                          onChange={(checked: boolean) => toggle(l, checked)} />
                      </div>
                      <p className="lo-card-meta">
                        {busy === l.id ? 'Switching mods…' : p.mods.length === 0 ? 'Loading mods…' : <>
                          {groupBy === 'hero' && <>{l.label}<span className="lo-sep">·</span></>}
                          {l.on.length === present ? plural(present, 'mod') : `${present} of ${plural(l.on.length, 'mod')} installed`}
                          {present > 0 && <><span className="lo-sep">·</span>{onNow === present ? 'all on' : `${onNow} on`}</>}
                        </>}
                      </p>
                      <div className="lo-card-actions">
                        <button type="button" className="lo-expand" onClick={() => setOpenId(l.id)}>Edit mods</button>
                        <span className="lo-card-tools">
                          <button type="button" className="lo-icon" title={`Delete ${l.name}`} aria-label={`Delete ${l.name}`} onClick={() => deleteWithUndo(p, l)}>
                            <Trash2 size={14} />
                          </button>
                        </span>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}

        {loadouts.length > 0 && (
          <div className="lo-grid">
            <div className="lo-card lo-card-new">
              <button type="button" className="lo-card-add" onClick={createEmpty}>
                <Plus size={20} />
                <span>New loadout</span>
                <small>Opens empty, then add mods to it</small>
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
