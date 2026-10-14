// caleb fork: one loadout as a page (Home > card). Header with its image, name, group, on/off, overwrite and delete;
// its mods with switches and Remove; and every other mod, searchable and filterable by type, to add.
import { useEffect, useState } from 'react'
import { ArrowLeft, ImageOff, ImagePlus, Plus, Save, Search, Trash2, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo, overwriteWithUndo } from './Loadouts'
import { CardMedia, ModRow, typeClass } from './loadoutBits'
import { deleteMedia } from './loadoutMedia'
import { type Loadout, addModToLoadout, displayName, isActive, modKey, patchLoadout, removeModFromLoadout } from './loadoutStore'
import { plural, typeCode } from './modName'

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
  useEffect(() => { setName(l.name); setGroup(l.label) }, [l.id, l.name, l.label])

  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const mine = [...new Set(l.on.map(displayName))].sort((a, b) => a.localeCompare(b))
  const inLoadout = new Set(mine)
  const categoryOf = (k: string) => { const m = byKey.get(k); return (m && p.modDetails?.[m.path]?.category) || 'Unknown' }
  const others = [...byKey.keys()].filter(k => !inLoadout.has(k)).sort((a, b) => a.localeCompare(b))
  const types = [...new Set(others.map(categoryOf))].sort()
  const needle = q.trim().toLowerCase()
  const matches = others.filter(k => (!needle || k.toLowerCase().includes(needle)) && (!type || categoryOf(k) === type))
  const active = isActive(l, p.mods)
  const onNow = mine.filter(k => byKey.get(k)?.enabled).length
  const hasMedia = Boolean(l.mediaRev || l.image)

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
        <button type="button" className="lo-card-image lp-media" onClick={onPickMedia}
          title={hasMedia ? 'Change image or video (or paste one)' : 'Add an image, GIF or video (or paste one)'}>
          <CardMedia l={l} />
        </button>
        <div className="lp-info">
          <input className="lp-name" value={name} aria-label="Loadout name" onChange={e => setName(e.target.value)} onBlur={commit}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setName(l.name); (e.target as HTMLInputElement).blur() } }} />
          <label className="lp-group">
            <span>Group</span>
            <input value={group} aria-label="Group" onChange={e => setGroup(e.target.value)} onBlur={commit}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setGroup(l.label); (e.target as HTMLInputElement).blur() } }} />
          </label>
          <p className="lp-meta">{busy ? 'Switching mods…' : `${plural(mine.length, 'mod')} · ${onNow} on now`}</p>
          <div className="lp-actions">
            <label className="lp-switch">
              <Switch size="sm" color="primary" checked={active} disabled={busy} onChange={(on: boolean) => onToggle(on)}
                title={active ? `Turn ${l.name}'s mods off` : `Turn ${l.name}'s mods on`} />
              <span>{active ? 'On' : 'Off'}</span>
            </label>
            <button type="button" className="lo-text-btn" onClick={() => overwriteWithUndo(p, l)}
              title={`Replace this loadout's mods with the ${p.scopeMods.length} mods shown in the Library, as they are now`}>
              <Save size={14} /> Overwrite from Library
            </button>
            <button type="button" className="lo-text-btn" onClick={onPickMedia}><ImagePlus size={14} /> {hasMedia ? 'Change image' : 'Add image'}</button>
            {hasMedia && (
              <button type="button" className="lo-text-btn" onClick={() => { deleteMedia(l.id); patchLoadout(l.id, { image: undefined, mediaRev: undefined, mediaType: undefined }) }}>
                <ImageOff size={14} /> Remove image
              </button>
            )}
            <button type="button" className="lo-text-btn" onClick={() => { deleteWithUndo(p, l); onBack() }}>
              <Trash2 size={14} /> Delete loadout
            </button>
          </div>
        </div>
      </div>

      <section className="lp-section">
        <h3 className="lo-group-head">In this loadout<span className="lo-group-count">{mine.length}</span></h3>
        {mine.length === 0
          ? <p className="lp-empty">No mods yet. Add some from the list below.</p>
          : (
            <ul className="mod-rows">
              {mine.map(k => (
                <ModRow key={k} p={p} k={k} mod={byKey.get(k)} onToggle>
                  <button type="button" className="lo-icon row-remove" title={`Remove ${k} from ${l.name}`} onClick={() => removeModFromLoadout(l, k)}>
                    <X size={14} />
                  </button>
                </ModRow>
              ))}
            </ul>
          )}
      </section>

      <section className="lp-section">
        <h3 className="lo-group-head">Add mods<span className="lo-group-count">{matches.length}</span></h3>
        <div className="lp-filters">
          <label className="lp-search">
            <Search size={14} />
            <input value={q} placeholder="Search mods" aria-label="Search mods to add" onChange={e => { setQ(e.target.value); setLimit(PAGE) }}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setQ('') }} />
          </label>
          <div className="lp-types" role="group" aria-label="Filter by type">
            <button type="button" aria-pressed={type === null} onClick={() => setType(null)}>All</button>
            {types.map(t => (
              <button key={t} type="button" aria-pressed={type === t} className={typeClass(t)} onClick={() => { setType(type === t ? null : t); setLimit(PAGE) }}>
                <span className="type-code">{typeCode(t)}</span>{t}
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
  )
}
