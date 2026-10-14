// caleb fork: one loadout as a page (Home > card). Header with its image, name, group, on/off, replace, duplicate and
// delete; its mods with switches and Remove (with Undo); and every other mod, searchable, sortable and filterable by
// type, to add. Wide windows put the two lists side by side.
import { useEffect, useState } from 'react'
import { ArrowLeft, Ellipsis, ImagePlus, Pencil, Plus, Search, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo, overwriteWithUndo } from './Loadouts'
import { CardMedia, ModRow, typeClass } from './loadoutBits'
import { deleteMedia } from './loadoutMedia'
import CustomDropdown from '../components/CustomDropdown'
import { type Loadout, OTHER, addGroup, addModToLoadout, displayName, duplicateLoadout, groupKey, setLoadoutGroup, useGroups, isActive, modKey, openLoadout, patchLoadout, readLoadouts, removeModFromLoadout } from './loadoutStore'
import { plural } from './modName'
import { Num, SwapText } from './motion'
import { GeneratePreviewsButton, previewSetKey } from './previews'

const PAGE = 60

export default function LoadoutPage({ p, l, busy, onToggle, onBack, onPickMedia }: {
  p: LoadoutProps
  l: Loadout
  busy: boolean
  onToggle: (on: boolean) => void
  onBack: () => void
  onPickMedia: () => void
}) {
  const [name, setName] = useState(l.name)
  const groups = useGroups()
  const [newGroup, setNewGroup] = useState<string | null>(null) // typing a new group's name
  const [q, setQ] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [sort, setSort] = useState<'name' | 'newest'>('name')
  useEffect(() => { setName(l.name) }, [l.id, l.name])

  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const mine = [...new Set(l.on.map(displayName))].sort((a, b) => a.localeCompare(b))
  const inLoadout = new Set(mine)
  const categoryOf = (k: string) => { const m = byKey.get(k); return (m && p.modDetails?.[m.path]?.category) || 'Unknown' }
  const age = (k: string) => byKey.get(k)?.modified_date ?? 0
  const others = [...byKey.keys()].filter(k => !inLoadout.has(k))
    .sort((a, b) => (sort === 'newest' ? age(b) - age(a) : 0) || a.localeCompare(b))
  const missing = mine.filter(k => !byKey.has(k))
  const types = [...new Set(others.map(categoryOf))].sort()
  const needle = q.trim().toLowerCase()
  const matches = others.filter(k => (!needle || k.toLowerCase().includes(needle)) && (!type || categoryOf(k) === type))
  const active = isActive(l, p.mods)
  const onNow = mine.filter(k => byKey.get(k)?.enabled).length
  const hasMedia = Boolean(l.mediaRev || l.image)

  /** Undo adds the removed mods back to the loadout as it is now, so mods added meanwhile stay. */
  const addBack = (keys: string[]) => keys.forEach(k => {
    const now = readLoadouts().find(x => x.id === l.id)
    if (now) addModToLoadout(now, k)
  })
  /** Remove one mod, with Undo. */
  const removeWithUndo = (k: string) => {
    removeModFromLoadout(l, k)
    const id = p.alert.info(`Removed from ${l.name}`, k, {
      duration: 10000,
      action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); addBack([k]) } },
    })
  }
  const dropMissing = () => {
    const gone = [...missing]
    const goneSet = new Set(gone)
    patchLoadout(l.id, { on: l.on.filter(k => !goneSet.has(displayName(k))) })
    const id = p.alert.info(`Removed ${gone.length} missing from ${l.name}`, 'They are no longer installed.', {
      duration: 10000,
      action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); addBack(gone) } },
    })
  }

  const commit = () => {
    const n = name.trim()
    if (n && n !== l.name) patchLoadout(l.id, { name: n })
  }

  return (
    <div className="lp">
      <button type="button" className="lo-text-btn lp-back" onClick={onBack} title="Back to all loadouts (Esc)">
        <ArrowLeft size={14} /> Loadouts
      </button>

      <div className="lp-top">
        <CardMedia p={p} l={l} className="lp-media" onClick={onPickMedia}
          title={hasMedia ? 'Change image or video (or paste one)' : 'Add an image, GIF or video (or paste one)'} />
        <div className="lp-info">
          <span className="lp-name-wrap"><Pencil size={14} className="lp-name-pen" aria-hidden="true" />
          <input className="lp-name" value={name} title="Rename" aria-label="Loadout name" onChange={e => setName(e.target.value)} onBlur={commit}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setName(l.name) }} /></span>{/* Esc cancels: blurring here would save the typed text */}
          <div className="lp-group">
            <span>Group</span>
            {newGroup === null
              ? <CustomDropdown
                  options={[...groups.map(g => ({ value: g, label: g })), { value: OTHER, label: 'No group (Other)' }, { value: '__new', label: '+ New group…' }]}
                  value={groups.find(g => groupKey(g) === groupKey(l.label)) ?? OTHER}
                  onChange={(v: string) => (v === '__new' ? setNewGroup('') : setLoadoutGroup(l.id, v))} />
              : <input autoFocus value={newGroup} placeholder="New group name" aria-label="New group name" onChange={e => setNewGroup(e.target.value)}
                  onBlur={() => { if (newGroup.trim()) setLoadoutGroup(l.id, addGroup(newGroup.trim())); setNewGroup(null) }}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setNewGroup(null) }} />}
          </div>
          <p className="lp-meta">{busy ? 'Switching mods…' : <>{plural(mine.length, 'mod')} · <Num id={`page-${l.id}`} value={onNow} /> on now
            {missing.length > 0 && <> · {missing.length} not installed</>}</>}</p>
          <div className="lp-actions">
            <label className="lp-switch">
              <Switch size="sm" color="primary" checked={active} disabled={busy} onChange={(on: boolean) => onToggle(on)}
                title={active ? `Turn ${l.name}'s mods off` : `Turn ${l.name}'s mods on`} />
              <SwapText text={active ? 'On' : 'Off'} />
            </label>
            <GeneratePreviewsButton className="lo-text-btn" label="Generate previews" set={previewSetKey(l.id)} name={l.name}
              paths={mine.map(k => byKey.get(k)?.path).filter((x): x is string => Boolean(x))} />
            <button type="button" className="lo-text-btn" onClick={onPickMedia}><ImagePlus size={14} /> {hasMedia ? 'Change image' : 'Add image'}</button>
            {/* The rest are occasional: one menu instead of a wrapping row of equal buttons */}
            <div className="lp-more" title="More actions">
              <CustomDropdown
                icon={<Ellipsis size={15} />}
                value=""
                placeholder="More"
                options={[
                  { value: 'replace', label: `Replace with Library selection (${p.scopeMods.filter(m => m.enabled).length} on)` },
                  { value: 'duplicate', label: 'Duplicate' },
                  ...(missing.length ? [{ value: 'missing', label: `Remove ${missing.length} missing mod${missing.length === 1 ? '' : 's'}` }] : []),
                  ...(hasMedia ? [{ value: 'unimage', label: 'Remove image' }] : []),
                  { value: 'delete', label: 'Delete loadout' },
                ]}
                onChange={(v: string) => {
                  if (v === 'replace') overwriteWithUndo(p, l)
                  if (v === 'duplicate') openLoadout(duplicateLoadout(l).id)
                  if (v === 'missing') dropMissing()
                  if (v === 'unimage') { deleteMedia(l.id); patchLoadout(l.id, { image: undefined, mediaRev: undefined, mediaType: undefined }) }
                  if (v === 'delete') { deleteWithUndo(p, l); onBack() }
                }} />
            </div>
          </div>
        </div>
      </div>

      <div className="lp-columns">
      <section className="lp-section">
        <h2 className="lo-group-head">In this loadout<span className="lo-group-count">{mine.length}</span></h2>
        {mine.length === 0
          ? <p className="lp-empty">No mods yet. Add some from the list below.</p>
          : (
            <ul className="mod-rows">
              {mine.map(k => (
                <ModRow key={k} p={p} k={k} mod={byKey.get(k)} onToggle>
                  <button type="button" className="lo-icon row-remove" title={`Remove ${k} from ${l.name}`} aria-label={`Remove ${k} from ${l.name}`} onClick={() => removeWithUndo(k)}>
                    <X size={14} />
                  </button>
                </ModRow>
              ))}
            </ul>
          )}
      </section>

      <section className="lp-section">
        <h2 className="lo-group-head">Add mods<span className="lo-group-count">{matches.length}</span></h2>
        <div className="lp-filters">
          <label className="lp-search">
            <Search size={14} />
            <input value={q} placeholder="Search mods" aria-label="Search mods to add" onChange={e => { setQ(e.target.value); setLimit(PAGE) }}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setQ('') }} />
          </label>
          <div className="mod-state-filter lp-sort" role="group" aria-label="Sort mods to add">
            <button type="button" aria-pressed={sort === 'name'} onClick={() => setSort('name')}>A to Z</button>
            <button type="button" aria-pressed={sort === 'newest'} onClick={() => setSort('newest')}>Newest</button>
          </div>
          <div className="lp-types" role="group" aria-label="Filter by type">
            <button type="button" aria-pressed={type === null} onClick={() => setType(null)}>All</button>
            {types.map(t => (
              <button key={t} type="button" aria-pressed={type === t} className={typeClass(t)} onClick={() => { setType(type === t ? null : t); setLimit(PAGE) }}>
                <span className="lo-mod-dot is-filled" />{t}
              </button>
            ))}
          </div>
        </div>
        {matches.length === 0
          ? <p className="lp-empty">No mods match{needle ? ` “${q.trim()}”` : ''}{type ? ` in ${type}` : ''}.</p>
          : (
            <ul className="mod-rows">
              {matches.slice(0, limit).map(k => (
                <ModRow key={k} p={p} k={k} mod={byKey.get(k)}>
                  <button type="button" className="row-action" onClick={() => addModToLoadout(l, k)} title={`Add ${k} to ${l.name}`}>
                    <Plus size={13} /> Add
                  </button>
                </ModRow>
              ))}
            </ul>
          )}
        {matches.length > limit && (
          <button type="button" className="lo-text-btn lp-more" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, matches.length - limit)} more</button>
        )}
      </section>
      </div>
    </div>
  )
}
