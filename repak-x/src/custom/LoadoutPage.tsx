// repakxtra: one loadout as a page (Home > card). Its picture beside the name, collection, on/off and actions; below
// them its mods (switch, rename, Remove with Undo), then every other mod, searchable, sortable and filterable by type,
// to add. The two lists stack at every width. Every change saves at once; a quiet "Saved" beside the name says so.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save as pickSavePath } from '@tauri-apps/plugin-dialog'
import { ArrowLeft, Check, Ellipsis, ImagePlus, Pencil, Plus, Search, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo } from './Loadouts'
import { CardMedia, ModRow, OnDot, typeClass } from './loadoutBits'
import { deleteMedia } from './loadoutMedia'
import CustomDropdown from '../components/CustomDropdown'
import {
  type Loadout, type Mod, OTHER, loadoutable, addGroup, addModToLoadout, displayName, duplicateLoadout, groupKey, setLoadoutGroup,
  useGroups, isActive, modKey, openLoadout, patchLoadout, readLoadouts, removeModFromLoadout, renameGroup, renameModKey, repakXOpen, takeFresh,
} from './loadoutStore'
import { plural } from './modName'
import { SwapText } from './motion'
import { GeneratePreviewsButton, previewSetKey } from './previews'
import { CaptureButton } from './CapturePreview'

const PAGE = 60

/** "Saved" with a check, fading in and out after each change to the loadout (not on first paint). */
function SavedNote({ sig }: { sig: string }) {
  const last = useRef(sig)
  const [n, setN] = useState(0)
  useEffect(() => { if (sig !== last.current) { last.current = sig; setN(x => x + 1) } }, [sig])
  return n ? <span key={n} className="lp-saved" role="status"><Check size={12} />Saved</span> : null
}

/** The page's occasional actions in one menu of real buttons: Tab and arrow keys reach them, Esc closes the menu (not the
 *  page), an outside click closes it. */
function MoreMenu({ items }: { items: { label: string; onClick: () => void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); wrap.current?.querySelector<HTMLButtonElement>('.lp-more-btn')?.focus() }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', keys, true) }
  }, [open])
  return (
    <div className="lp-more" ref={wrap}>
      <button type="button" className="lo-text-btn lp-more-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)} title="More actions">
        <Ellipsis size={15} /> More
      </button>
      {open && (
        <div className="sigeon-menu lp-more-menu" role="menu">
          {items.map(it => (
            <button key={it.label} type="button" role="menuitem" className="sigeon-item" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick() }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Windows file names cannot hold these; the zip is named after the loadout. */
const fileName = (name: string) => name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'loadout'

export default function LoadoutPage({ p, l, busy, onToggle, onBack, onPickMedia, onSetMedia }: {
  p: LoadoutProps
  l: Loadout
  busy: boolean
  onToggle: (on: boolean) => void
  onBack: () => void
  onPickMedia: () => void
  onSetMedia: (image: Blob) => Promise<boolean>
}) {
  const [name, setName] = useState(l.name)
  const nameRef = useRef<HTMLInputElement>(null)
  const groups = useGroups()
  const [newGroup, setNewGroup] = useState<string | null>(null) // typing a new collection's name
  const [groupDraft, setGroupDraft] = useState<string | null>(null) // renaming the loadout's collection
  const [q, setQ] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [sort, setSort] = useState<'name' | 'newest'>('name')
  const [exporting, setExporting] = useState(false)
  useEffect(() => { setName(l.name) }, [l.id, l.name])
  // A loadout just made opens with its name selected, so making one starts with naming it
  useEffect(() => { if (takeFresh(l.id)) { nameRef.current?.focus(); nameRef.current?.select() } }, [l.id])

  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const mine = [...new Set(l.on.map(displayName))].sort((a, b) => a.localeCompare(b))
  const inLoadout = new Set(mine)
  const categoryOf = (k: string) => { const m = byKey.get(k); return (m && p.modDetails?.[m.path]?.category) || 'Unknown' }
  const age = (k: string) => byKey.get(k)?.modified_date ?? 0
  const others = [...byKey.keys()].filter(k => !inLoadout.has(k) && loadoutable(k))
    .sort((a, b) => (sort === 'newest' ? age(b) - age(a) : 0) || a.localeCompare(b))
  const missing = mine.filter(k => !byKey.has(k))
  const types = [...new Set(others.map(categoryOf))].sort()
  const needle = q.trim().toLowerCase()
  const matches = others.filter(k => (!needle || k.toLowerCase().includes(needle)) && (!type || categoryOf(k) === type))
  const active = isActive(l, p.mods)
  const onNow = mine.filter(k => byKey.get(k)?.enabled).length
  const present = mine.length - missing.length
  const switchTitle = present === 0 ? 'No installed mods' : active ? `Turn ${l.name}'s mods off` : `Turn ${l.name}'s mods on`
  const hasMedia = Boolean(l.mediaRev || l.image)
  const group = groups.find(g => groupKey(g) === groupKey(l.label))

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

  /** Renames the mod's files (the Library's rename); every loadout holding it follows. rename_mod shows its own error. */
  const renameMod = async (mod: Mod, to: string) => {
    const from = modKey(mod.path)
    const next = to.trim()
    if (!next || next === displayName(from)) return
    if (p.isBlocked()) { p.alert.warning('Game running', 'Mods cannot be renamed while the game is running.'); return }
    try {
      const path = await invoke<string>('rename_mod', { modPath: mod.path, newName: next })
      renameModKey(from, modKey(path))
      await p.reload()
    } catch (e) {
      const why = repakXOpen(e)   // other errors show the backend's own Rename Failed toast
      if (why) p.alert.warning('Not renamed', why); else console.warn('Rename failed:', e)
    }
  }

  /** Every installed mod of the loadout in one zip named after it. */
  const exportZip = async () => {
    const paths = mine.map(k => byKey.get(k)?.path).filter((x): x is string => Boolean(x))
    if (!paths.length) { p.alert.info('Nothing to export', `${l.name} has no installed mods.`); return }
    const dest = await pickSavePath({ title: `Export ${l.name}`, defaultPath: `${fileName(l.name)}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] }).catch(() => null)
    if (!dest) return
    setExporting(true) // one export at a time from this page
    const id = p.alert.showAlert({ title: `Exporting ${l.name}`, description: plural(paths.length, 'mod'), isLoading: true, duration: 0 })
    try {
      await invoke<number>('export_loadout_zip', { paths, dest })
      p.alert.updateToast(id, {
        color: 'success', isLoading: false, duration: 8000, title: `Exported ${l.name}`,
        description: `${plural(paths.length, 'mod')} in ${dest.split(/[/\\]/).pop()}${missing.length ? ` (${missing.length} not installed, left out)` : ''}.`,
        action: { label: 'Show in folder', onClick: () => { p.alert.dismissAlert(id); invoke('open_in_explorer', { path: dest }).catch(() => undefined) } },
      })
    } catch (e) {
      p.alert.updateToast(id, { color: 'warning', isLoading: false, duration: 8000, title: 'Export failed', description: String(e) })
    } finally {
      setExporting(false)
    }
  }

  const removeImage = () => { deleteMedia(l.id); patchLoadout(l.id, { image: undefined, mediaRev: undefined, mediaType: undefined }) }

  const commit = () => {
    const n = name.trim()
    if (n && n !== l.name) patchLoadout(l.id, { name: n })
    else setName(l.name)
  }
  const commitGroup = () => {
    if (group && groupDraft?.trim()) renameGroup(group, groupDraft)
    setGroupDraft(null)
  }

  return (
    <div className="lp">
      <button type="button" className="lo-text-btn lp-back" onClick={onBack} title="Back to all loadouts (Esc)">
        <ArrowLeft size={14} /> Loadouts
      </button>

      <div className="lp-top">
        <CardMedia p={p} l={l} className="lp-media" onClick={onPickMedia} onRemoveImage={removeImage}
          title={hasMedia ? 'Change image or video (or paste one)' : 'Add an image, GIF or video (or paste one)'} />
        <div className="lp-info">
          <span className="lp-name-wrap">
            <input ref={nameRef} className="lp-name" value={name} title="Rename" aria-label="Loadout name" onChange={e => setName(e.target.value)} onBlur={commit}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setName(l.name) }} />{/* Esc cancels: blurring here would save the typed text */}
            <button type="button" className="lo-icon lp-pen" title="Rename loadout" aria-label="Rename loadout" onClick={() => { nameRef.current?.focus(); nameRef.current?.select() }}>
              <Pencil size={14} />
            </button>
            {/* Beside the name, where a document says it saved; its mods switching counts too: every change here applies at once */}
            <SavedNote sig={JSON.stringify([l.name, l.label, l.on, l.mediaRev ?? null, Boolean(l.image), mine.map(k => (byKey.get(k)?.enabled ? 1 : 0)).join('')])} />
          </span>
          <div className="lp-group">
            <span>Collection</span>
            {groupDraft !== null
              ? <input autoFocus value={groupDraft} aria-label="Collection name" onFocus={e => e.target.select()} onChange={e => setGroupDraft(e.target.value)} onBlur={commitGroup}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setGroupDraft(null) }} />
              : newGroup === null
                ? <CustomDropdown
                    options={[...groups.map(g => ({ value: g, label: g })), { value: OTHER, label: 'No collection (Other)' }, { value: '__new', label: '+ New collection…' }]}
                    value={group ?? OTHER}
                    onChange={(v: string) => (v === '__new' ? setNewGroup('') : setLoadoutGroup(l.id, v))} />
                : <input autoFocus value={newGroup} placeholder="New collection name" aria-label="New collection name" onChange={e => setNewGroup(e.target.value)}
                    onBlur={() => { if (newGroup.trim()) setLoadoutGroup(l.id, addGroup(newGroup.trim())); setNewGroup(null) }}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setNewGroup(null) }} />}
            {group && groupDraft === null && newGroup === null && (
              <button type="button" className="lo-icon lp-pen" title={`Rename the ${group} collection (for every loadout in it)`} aria-label={`Rename the ${group} collection`}
                onClick={() => setGroupDraft(group)}>
                <Pencil size={13} />
              </button>
            )}
          </div>
          <p className="lp-meta">
            {busy ? 'Switching mods…' : <>
              <span title={`${onNow} of its ${mine.length} mods are on`}>{onNow}/{mine.length}</span>
              <OnDot on={onNow} of={present} />
              {missing.length > 0 && <><span className="lo-sep">·</span>{missing.length} not installed</>}
            </>}
          </p>
          <div className="lp-actions">
            <label className="lp-switch">
              <Switch size="sm" color="primary" checked={active} isDisabled={present === 0} disabled={busy || present === 0}
                onChange={(on: boolean) => onToggle(on)} title={switchTitle} aria-label={switchTitle} />
              <SwapText text={active ? 'On' : 'Off'} />
            </label>
            <GeneratePreviewsButton className="lo-text-btn" label="Generate previews" set={previewSetKey(l.id)} name={l.name}
              paths={mine.map(k => byKey.get(k)?.path).filter((x): x is string => Boolean(x))} />
            <button type="button" className="lo-text-btn" onClick={onPickMedia}><ImagePlus size={14} /> {hasMedia ? 'Change image' : 'Add image'}</button>
            <CaptureButton p={p} l={l} onUse={onSetMedia} />
            {/* The rest are occasional: one menu instead of a wrapping row of equal buttons */}
            <MoreMenu items={[
              { label: 'Duplicate', onClick: () => openLoadout(duplicateLoadout(l).id, true) },
              { label: exporting ? 'Exporting…' : 'Export as zip', onClick: exportZip, disabled: exporting },
              ...(missing.length ? [{ label: `Remove ${plural(missing.length, 'missing mod')}`, onClick: dropMissing }] : []),
              ...(hasMedia ? [{ label: 'Remove image', onClick: removeImage }] : []),
              { label: 'Delete loadout', onClick: () => { deleteWithUndo(p, l); onBack() } },
            ]} />
          </div>
        </div>
      </div>

      <section className="lp-section">
        <h2 className="lo-group-head">In this loadout<span className="lo-group-count">{mine.length}</span></h2>
        {mine.length === 0
          ? <p className="lp-empty">No mods yet. Add some from the list below.</p>
          : (
            <ul className="mod-rows">
              {mine.map(k => (
                <ModRow key={k} p={p} k={k} mod={byKey.get(k)} onToggle onRename={renameMod}>
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
                <ModRow key={k} p={p} k={k} mod={byKey.get(k)} onRename={renameMod}>
                  <button type="button" className="lo-icon row-add" onClick={() => addModToLoadout(l, k)} title={`Add ${k} to ${l.name}`} aria-label={`Add ${k} to ${l.name}`}>
                    <Plus size={14} />
                  </button>
                </ModRow>
              ))}
            </ul>
          )}
        {matches.length > limit && (
          <button type="button" className="lo-text-btn lp-show-more" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, matches.length - limit)} more</button>
        )}
      </section>
    </div>
  )
}
