// caleb fork: full-window loadouts screen. Each loadout is a card with optional media (image, GIF or
// looping video; upload or paste), an on/off switch and an expandable list of its mods.
// On = its mods on, the rest of its group off, and other loadouts sharing mods off. Off = its mods off.
// Cards are grouped by their saved group (label) or by hero; double-click a name to rename it.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Download, ImageOff, ImagePlus, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, runChanges } from './Loadouts'
import { isTyping } from './hotkeys'
import { hasPreview, usePreviewUrl, usePreviewVersion } from './previews'
import { deleteMedia, prepareMedia, putMedia, useMediaUrl } from './loadoutMedia'
import {
  type Loadout, type Mod, addModToLoadout, changesToTurnOff, removeModFromLoadout, deleteLoadout, displayName, exportLoadouts, importLoadouts, isActive, modKey, patchLoadout, planTurnOn,
  readLoadouts, setLoadoutsScreenOpen, snapshotLoadout, useLoadouts, useLoadoutsScreenOpen, writeLoadouts,
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
    counts.set(hero, (counts.get(hero) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

/** A loadout's hero from its on mods; VFX and texture-only mods often have none, so its scope decides then. */
const heroOf = (l: Loadout, byKey: Map<string, Mod>, details: LoadoutProps['modDetails']) =>
  topHero(l.on, byKey, details) ?? topHero(l.scope, byKey, details) ?? NO_HERO

/** Sections in display order. Saved groups holding a single loadout share one "Other" section. */
export function groupLoadouts(list: Loadout[], keyOf: (l: Loadout) => string, mergeSingles: boolean) {
  const map = new Map<string, Loadout[]>()
  for (const l of list) map.set(keyOf(l), [...(map.get(keyOf(l)) ?? []), l])
  let groups = [...map]
  if (mergeSingles) {
    const singles = groups.filter(([, ls]) => ls.length === 1).flatMap(([, ls]) => ls)
    groups = groups.filter(([, ls]) => ls.length > 1)
    if (singles.length) groups.push(['Other', singles])
  } else {
    groups.sort(([a], [b]) => Number(a === NO_HERO) - Number(b === NO_HERO) || a.localeCompare(b))
  }
  return groups
}

function CardMedia({ l }: { l: Loadout }) {
  const url = useMediaUrl(l.id, l.mediaRev)
  usePreviewVersion()
  const generated = usePreviewUrl(l.on.map(displayName).find(hasPreview)) // no own image: first mod with a generated preview
  const src = url ?? l.image ?? generated
  if (!src) return <span className="lo-card-placeholder"><ImagePlus size={22} /><span>Click to upload, or hover and paste</span></span>
  return l.mediaType === 'video' && url
    ? <video src={url} autoPlay loop muted playsInline />
    : <img src={src} alt="" />
}

export default function LoadoutsScreen(p: LoadoutProps) {
  const open = useLoadoutsScreenOpen()
  const loadouts = useLoadouts()
  const [busy, setBusy] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState<{ id: string; q: string } | null>(null)
  const [groupBy, setGroupByState] = useState<GroupBy>(() => (localStorage.getItem(GROUP_BY_KEY) === 'hero' ? 'hero' : 'group'))
  const setGroupBy = (g: GroupBy) => { localStorage.setItem(GROUP_BY_KEY, g); setGroupByState(g) }
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const mediaTarget = useRef<string | null>(null)
  const hovered = useRef<string | null>(null)

  const setMedia = async (id: string, file: File) => {
    try {
      const { blob, type } = await prepareMedia(file)
      await putMedia(id, blob)
      patchLoadout(id, { mediaType: type, mediaRev: Date.now(), image: undefined })
    } catch (e) {
      p.alert.error('Media not saved', e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!open) return
    // Esc in a text field (rename, new loadout) cancels that field instead of closing the screen
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !isTyping(e.target)) { e.stopPropagation(); setLoadoutsScreenOpen(false) } }
    // Ctrl+V with an image, GIF or video on the clipboard sets the hovered card's media
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find(f => /^(image|video)\//.test(f.type))
      if (!file) return
      e.preventDefault()
      if (hovered.current) setMedia(hovered.current, file)
      else p.alert.info('Hover a card first', 'Point at the loadout card, then paste.')
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('paste', onPaste)
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('paste', onPaste) }
  }, [open])

  if (!open) return null

  const toggle = async (l: Loadout, on: boolean) => {
    setBusy(l.id)
    if (on) {
      const { flips, displaced } = planTurnOn(l, readLoadouts(), p.mods)
      await runChanges(p, l, flips, 'on', displaced)
    } else {
      await runChanges(p, l, changesToTurnOff(l, p.mods), 'off')
    }
    setBusy(null)
  }

  const pickMedia = (id: string) => {
    mediaTarget.current = id
    fileRef.current?.click()
  }

  const create = () => {
    const trimmed = name.trim()
    if (trimmed) writeLoadouts([...readLoadouts(), snapshotLoadout({ id: crypto.randomUUID(), name: trimmed }, p.scopeMods, p.scopeLabel)])
    setNaming(false)
    setName('')
  }

  const exportFile = () => {
    const url = URL.createObjectURL(new Blob([exportLoadouts()], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'repakxcable-loadouts.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const commitRename = (l: Loadout) => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== l.name) patchLoadout(l.id, { name: trimmed })
    setRenaming(null)
  }

  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const groups = groupBy === 'hero'
    ? groupLoadouts(loadouts, l => heroOf(l, byKey, p.modDetails), false)
    : groupLoadouts(loadouts, l => l.label, true)

  const toggleExpanded = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  // Portal: the sidebar that mounts this sits inside animated, overflow-clipped panels
  return createPortal(
    <div className="lo-screen" role="dialog" aria-label="Loadouts">
      <header className="lo-screen-head">
        <div>
          <h2>Loadouts</h2>
          <p>On switches a loadout's mods on, the rest of its group off, and any other loadout sharing its mods off. Off switches its mods off. Press L to open or close.</p>
        </div>
        <div className="lo-head-tools">
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
          <button type="button" className="lo-icon lo-close" title="Close (Esc)" onClick={() => setLoadoutsScreenOpen(false)}>
            <X size={18} />
          </button>
        </div>
      </header>

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

      <div className="lo-body">
      {groups.map(([group, list]) => (
      <section className="lo-group" key={group}>
        <h3 className="lo-group-head">{group}<span className="lo-group-count">{list.length}</span></h3>
        <div className="lo-grid">
        {list.map(l => {
          const active = isActive(l, p.mods)
          const present = new Set(l.scope.map(displayName).filter(k => byKey.has(k))).size
          const isOpen = expanded.has(l.id)
          const hasMedia = Boolean(l.mediaRev || l.image)
          return (
            <article key={l.id} className={`lo-card ${active ? 'is-on' : ''}`}
              onMouseEnter={() => { hovered.current = l.id }} onMouseLeave={() => { if (hovered.current === l.id) hovered.current = null }}>
              <button type="button" className="lo-card-image" onClick={() => pickMedia(l.id)}
                title={hasMedia ? 'Change image or video (or paste one)' : 'Add an image, GIF or video (or paste one)'}>
                <CardMedia l={l} />
              </button>
              <div className="lo-card-body">
                <div className="lo-card-title">
                  {renaming === l.id ? (
                    <input className="lo-rename" autoFocus value={draft} aria-label="Loadout name"
                      onFocus={e => e.target.select()} onChange={e => setDraft(e.target.value)} onBlur={() => commitRename(l)}
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') commitRename(l); if (e.key === 'Escape') setRenaming(null) }} />
                  ) : (
                    <h3 title={`${l.name} (double-click to rename)`} onDoubleClick={() => { setDraft(l.name); setRenaming(l.id) }}>{l.name}</h3>
                  )}
                  <Switch size="sm" color="primary" checked={active} disabled={busy !== null}
                    title={active ? `Turn ${l.name} off` : `Turn ${l.name} on`}
                    onChange={(checked: boolean) => toggle(l, checked)} />
                </div>
                <p className="lo-card-meta">
                  {busy === l.id ? 'Switching mods…' : <>{l.label}<span className="lo-sep">·</span>{l.on.length} of {present} mods on</>}
                </p>
                <div className="lo-card-actions">
                  <button type="button" className="lo-expand" aria-expanded={isOpen} onClick={() => toggleExpanded(l.id)}>
                    {l.on.length} mods <ChevronDown size={14} />
                  </button>
                  <span className="lo-card-tools">
                    <button type="button" className="lo-icon" title={`Overwrite ${l.name} with the shown mods' current state`}
                      onClick={() => { patchLoadout(l.id, snapshotLoadout(l, p.scopeMods, p.scopeLabel)); p.alert.success('Loadout updated', `${l.name} now matches the ${p.scopeMods.length} shown mods.`) }}>
                      <RefreshCw size={14} />
                    </button>
                    {hasMedia && (
                      <button type="button" className="lo-icon" title="Remove image or video"
                        onClick={() => { deleteMedia(l.id); patchLoadout(l.id, { image: undefined, mediaRev: undefined, mediaType: undefined }) }}>
                        <ImageOff size={14} />
                      </button>
                    )}
                    <button type="button" className="lo-icon" title={`Delete ${l.name}`} onClick={() => deleteLoadout(l.id)}>
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
                {isOpen && (() => {
                  const inLoadout = new Set(l.on.map(displayName))
                  const q = adding?.id === l.id ? adding.q.trim().toLowerCase() : ''
                  const matches = q ? [...byKey.keys()].filter(k => !inLoadout.has(k) && k.toLowerCase().includes(q)).sort().slice(0, 8) : []
                  const add = (key: string) => { addModToLoadout(l, key); setAdding({ id: l.id, q: '' }) }
                  return (
                    <>
                      <ul className="lo-mod-list">
                        {l.on.length === 0 && <li className="lo-mod-missing">No mods on in this loadout.</li>}
                        {[...inLoadout].sort((a, b) => a.localeCompare(b)).map(key => {
                          const mod = byKey.get(key)
                          return (
                            <li key={key} className={mod ? (mod.enabled ? 'is-on' : '') : 'lo-mod-missing'}
                              title={mod ? (mod.enabled ? 'On now' : 'Off now') : 'Not installed anymore'}>
                              <span className="lo-mod-dot" />
                              <span className="lo-mod-name">{key}</span>
                              <button type="button" className="lo-icon lo-mod-remove" title={`Remove ${key} from ${l.name}`}
                                onClick={() => removeModFromLoadout(l, key)}>
                                <X size={13} />
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                      <div className="lo-mod-add">
                        <input value={adding?.id === l.id ? adding.q : ''} placeholder="Add a mod…" aria-label={`Add a mod to ${l.name}`}
                          onChange={e => setAdding({ id: l.id, q: e.target.value })}
                          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter' && matches[0]) add(matches[0]); if (e.key === 'Escape') setAdding(null) }} />
                        {matches.length > 0 && (
                          <ul className="lo-mod-matches">
                            {matches.map(k => (
                              <li key={k}><button type="button" onClick={() => add(k)}><Plus size={13} />{k}</button></li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </>
                  )
                })()}
              </div>
            </article>
          )
        })}
        </div>
      </section>
      ))}

        <div className="lo-grid">
        <div className="lo-card lo-card-new">
          {naming ? (
            <div className="lo-new">
              <input autoFocus value={name} placeholder="Loadout name" onChange={e => setName(e.target.value)}
                onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') create(); if (e.key === 'Escape') { setNaming(false); setName('') } }}
                onBlur={create} />
              <p className="lo-hint">Saves which of the {p.scopeMods.length} shown mods ({p.scopeLabel}) are on.</p>
            </div>
          ) : (
            <button type="button" className="lo-card-add" onClick={() => setNaming(true)}>
              <Plus size={20} />
              <span>Save the shown mods as a loadout</span>
              <small>{p.scopeLabel}<span className="lo-sep">·</span>{p.scopeMods.filter(m => m.enabled).length} of {p.scopeMods.length} on</small>
            </button>
          )}
        </div>
        </div>
      </div>
    </div>
  , document.body)
}
