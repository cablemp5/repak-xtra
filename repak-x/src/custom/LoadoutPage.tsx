// caleb fork: one loadout as a page (Home > card). Header with its image, name, group, on/off, replace, duplicate and
// delete; its mods with switches and Remove (with Undo); and every other mod, searchable, sortable and filterable by
// type, to add. Wide windows put the two lists side by side.
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRightLeft, Copy, Eraser, ImageOff, ImagePlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo, overwriteWithUndo } from './Loadouts'
import { CardMedia, ModRow, typeClass } from './loadoutBits'
import { deleteMedia } from './loadoutMedia'
import { type Loadout, addModToLoadout, displayName, duplicateLoadout, groupKey, isActive, modKey, openLoadout, patchLoadout, readLoadouts, removeModFromLoadout } from './loadoutStore'
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
  const [group, setGroup] = useState(l.label)
  const [q, setQ] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [sort, setSort] = useState<'name' | 'newest'>('name')
  useEffect(() => { setName(l.name); setGroup(l.label) }, [l.id, l.name, l.label])

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

  /** Remove one mod, with Undo that puts the loadout back as it was. */
  const removeWithUndo = (k: string) => {
    const before = { on: l.on }
    removeModFromLoadout(l, k)
    const id = p.alert.info(`Removed from ${l.name}`, k, {
      duration: 10000,
      action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); patchLoadout(l.id, before) } },
    })
  }
  const dropMissing = () => {
    const before = { on: l.on }
    const gone = new Set(missing)
    patchLoadout(l.id, { on: l.on.filter(k => !gone.has(displayName(k))) })
    const id = p.alert.info(`Removed ${missing.length} missing from ${l.name}`, 'They are no longer installed.', {
      duration: 10000,
      action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); patchLoadout(l.id, before) } },
    })
  }

  const commit = () => {
    const n = name.trim(), g = group.trim()
    if ((n && n !== l.name) || g !== l.label) patchLoadout(l.id, { name: n || l.name, label: g || l.label })
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
          <label className="lp-group">
            <span>Group</span>
            <input value={group} aria-label="Group" list="lo-group-names" onChange={e => setGroup(e.target.value)} onBlur={commit}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setGroup(l.label) }} />
            <datalist id="lo-group-names">
              {[...new Map(readLoadouts().map(x => [groupKey(x.label), x.label.trim()])).values()].filter(g => groupKey(g) !== groupKey(l.label)).sort().map(g => <option key={g} value={g} />)}
            </datalist>
          </label>
          <p className="lp-meta">{busy ? 'Switching mods…' : <>{plural(mine.length, 'mod')} · <Num id={`page-${l.id}`} value={onNow} /> on now
            {missing.length > 0 && <> · {missing.length} not installed</>}</>}</p>
          <div className="lp-actions">
            <label className="lp-switch">
              <Switch size="sm" color="primary" checked={active} disabled={busy} onChange={(on: boolean) => onToggle(on)}
                title={active ? `Turn ${l.name}'s mods off` : `Turn ${l.name}'s mods on`} />
              <SwapText text={active ? 'On' : 'Off'} />
            </label>
            <button type="button" className="lo-text-btn" onClick={() => overwriteWithUndo(p, l)}
              title={`Replace this loadout's mods with the ${p.scopeMods.length} mods the Library shows (${p.scopeLabel}), as they are now. Undo is offered.`}>
              <ArrowRightLeft size={14} /> Replace with Library selection <span className="bulk-num">{p.scopeMods.filter(m => m.enabled).length}</span>
            </button>
            <GeneratePreviewsButton className="lo-text-btn" label="Generate previews" set={previewSetKey(l.id)} name={l.name}
              paths={mine.map(k => byKey.get(k)?.path).filter((x): x is string => Boolean(x))} />
            <button type="button" className="lo-text-btn" onClick={onPickMedia}><ImagePlus size={14} /> {hasMedia ? 'Change image' : 'Add image'}</button>
            {hasMedia && (
              <button type="button" className="lo-text-btn" onClick={() => { deleteMedia(l.id); patchLoadout(l.id, { image: undefined, mediaRev: undefined, mediaType: undefined }) }}>
                <ImageOff size={14} /> Remove image
              </button>
            )}
            <button type="button" className="lo-text-btn" title="A copy with the same mods and group"
              onClick={() => openLoadout(duplicateLoadout(l).id)}>
              <Copy size={14} /> Duplicate
            </button>
            {missing.length > 0 && (
              <button type="button" className="lo-text-btn" onClick={dropMissing} title={`Remove the ${missing.length} mods that are no longer installed`}>
                <Eraser size={14} /> Remove {missing.length} missing
              </button>
            )}
            <button type="button" className="lo-text-btn lp-delete" onClick={() => { deleteWithUndo(p, l); onBack() }}>
              <Trash2 size={14} /> Delete loadout
            </button>
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
