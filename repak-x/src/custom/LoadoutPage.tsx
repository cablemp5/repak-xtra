// repakxtra: one loadout as a page (Home > card). Its picture beside the name, collection, on/off and actions; below
// them its mods (switch, rename, Remove with Undo), then every other mod, searchable, sortable and filterable by type,
// to add. The two lists stack at every width. Every change saves at once; a quiet "Saved" beside the name says so.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save as pickSavePath } from '@tauri-apps/plugin-dialog'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Ellipsis, Pencil, Plus, Search, X } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { type LoadoutProps, deleteWithUndo } from './Loadouts'
import { CardMedia, ModRow, OnDot, typeClass } from './loadoutBits'
import { deleteMedia } from './loadoutMedia'
import CustomDropdown from '../components/CustomDropdown'
import {
  type Loadout, type Mod, OTHER, OTHER_LABEL, loadoutable, addGroup, captureKey, addModToLoadout, displayName, duplicateLoadout, groupKey, setLoadoutGroup,
  useGroups, hotkeyOf, hotkeySlots, isActive, modKey, openLoadout, patchLoadout, pinHotkey, readLoadouts, removeModFromLoadout,
  renameModKey, repakXOpen, takeFresh, useLoadouts,
} from './loadoutStore'
import { plural } from './modName'
import { SwapText } from './motion'
import { GeneratePreviewsButton, previewSetKey } from './previews'
import { CaptureButton, captureTarget } from './CapturePreview'

const PAGE = 60

/** "Saved" with a check, fading in and out after each change to the loadout (not on first paint). */
function SavedNote({ sig }: { sig: string }) {
  const last = useRef(sig)
  const [n, setN] = useState(0)
  useEffect(() => { if (sig !== last.current) { last.current = sig; setN(x => x + 1) } }, [sig])
  return n ? <span key={n} className="lp-saved" role="status"><Check size={12} />Saved</span> : null
}

type MoreItem = { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }

/** Ctrl+N drawn as two key caps. */
const Keys = ({ n }: { n: number }) => <span className="lp-keys"><kbd>Ctrl</kbd><span className="key-separator">+</span><kbd>{n}</kbd></span>

/** The page's occasional actions in one menu of real buttons: Tab and arrow keys reach them, Esc closes the menu (not the
 *  page), an outside click closes it. Hotkey opens its choices in place of the actions (Esc or Left goes back): None or
 *  Ctrl+1..9, each naming the loadout that holds it now, which loses it when picked here. */
function MoreMenu({ items, danger, l, loadouts }: { items: MoreItem[]; danger: MoreItem; l: Loadout; loadouts: Loadout[] }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'actions' | 'keys' | 'back'>('actions') // back: the actions again, after the keys
  const keysView = view === 'keys'
  const wrap = useRef<HTMLDivElement>(null)
  const slots = hotkeySlots(loadouts), mine = hotkeyOf(l, loadouts)
  const close = () => { setOpen(false); setView('actions'); wrap.current?.querySelector<HTMLButtonElement>('.lp-more-btn')?.focus() }
  useEffect(() => {
    if (!open) return
    // Opening a view focuses its first choice; the keys start on the current one, going back on the Hotkey row
    wrap.current?.querySelector<HTMLButtonElement>(keysView ? '[aria-checked="true"]' : view === 'back' ? '.lp-more-sub' : '[role="menuitem"]:not(:disabled)')?.focus()
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) { setOpen(false); setView('actions') } }
    const keys = (e: KeyboardEvent) => {
      if (keysView && (e.key === 'Escape' || e.key === 'ArrowLeft')) { e.stopPropagation(); e.preventDefault(); setView('back'); return }
      if (e.key === 'Escape') { e.stopPropagation(); close(); return }
      if (!keysView && e.key === 'ArrowRight' && document.activeElement?.classList.contains('lp-more-sub')) { e.preventDefault(); setView('keys'); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])]
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', keys, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', keys, true) }
  }, [open, view])
  const pin = (n: number) => { pinHotkey(l.id, n); close() }
  const action = (it: MoreItem) => (
    <button key={it.label} type="button" role="menuitem" className={`sigeon-item${it.danger ? ' is-danger' : ''}`} disabled={it.disabled} onClick={() => { close(); it.onClick() }}>
      {it.label}
    </button>
  )
  return (
    <div className="lp-more" ref={wrap}>
      <button type="button" className="lo-text-btn lp-more-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(v => !v); setView('actions') }} title="More actions">
        <Ellipsis size={15} /> More
      </button>
      {open && (
        <div className="sigeon-menu lp-more-menu" role="menu" aria-label={keysView ? 'Hotkey' : 'More actions'}>
          {!keysView ? (
            <div className={`lp-more-view${view === 'back' ? ' is-back' : ''}`} key="actions">
              {items.map(action)}
              <button type="button" role="menuitem" aria-haspopup="menu" className="sigeon-item lp-more-sub" onClick={() => setView('keys')}
                title={mine ? `Ctrl+${mine} turns ${l.name} on or off` : `Give ${l.name} a Ctrl+1 to 9 hotkey`}>
                Hotkey
                <span className="lp-more-value">{mine ? <Keys n={mine} /> : 'None'}<ChevronRight size={14} /></span>
              </button>
              {action(danger)}
            </div>
          ) : (
            <div className="lp-more-view is-keys" key="keys">
              <button type="button" role="menuitem" className="sigeon-item lp-more-back" onClick={() => setView('back')}>
                <ChevronLeft size={14} />Hotkey
              </button>
              <button type="button" role="menuitemradio" aria-checked={!mine} className="sigeon-item lp-key-row" onClick={() => pin(0)}>
                None{!mine && <Check size={14} />}
              </button>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => {
                const holder = slots.get(n), me = n === mine
                return (
                  <button key={n} type="button" role="menuitemradio" aria-checked={me} className="sigeon-item lp-key-row" onClick={() => pin(n)}
                    title={me ? `${l.name} has Ctrl+${n}` : holder ? `Moves Ctrl+${n} from ${holder.name} to ${l.name}` : `Ctrl+${n} turns ${l.name} on or off`}>
                    <Keys n={n} />
                    {me ? <Check size={14} /> : holder && <span className="lp-key-holder">{holder.name}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Windows file names cannot hold these; the zip is named after the loadout. */
const fileName = (name: string) => name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'loadout'

export default function LoadoutPage({ p, l, busy, onToggle, onBack, onPickMedia, onSetMedia, onSetCapture }: {
  p: LoadoutProps
  l: Loadout
  busy: boolean
  onToggle: (on: boolean) => void
  onBack: () => void
  onPickMedia: () => void
  onSetMedia: (image: Blob) => Promise<boolean>
  onSetCapture: (image: Blob) => Promise<boolean>
}) {
  const [name, setName] = useState(l.name)
  const nameRef = useRef<HTMLInputElement>(null)
  const groups = useGroups()
  const loadouts = useLoadouts()
  const [newGroup, setNewGroup] = useState<string | null>(null) // typing a new collection's name
  const [q, setQ] = useState('')
  const [type, setType] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [sort, setSort] = useState<'name' | 'newest'>('newest')
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
    if (p.isBlocked()) { p.alert.warning('Game Running', 'Cannot rename mods while game is running.'); return }
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
  const removeCapture = () => { deleteMedia(captureKey(l.id)); patchLoadout(l.id, { captureRev: undefined }) }
  const target = captureTarget(p, l)

  const commit = () => {
    const n = name.trim()
    if (n && n !== l.name) patchLoadout(l.id, { name: n })
    else setName(l.name)
  }

  return (
    <div className="lp">
      <button type="button" className="lo-text-btn lp-back" onClick={onBack} title="Back to all loadouts (Esc)">
        <ArrowLeft size={14} /> Loadouts
      </button>

      <div className="lp-top">
        {/* The picture card and its Cover switch: Preview, Capture, Image or Text, each with its own way to fill it */}
        <CardMedia p={p} l={l} className="lp-media" onClick={onPickMedia} onRemoveImage={removeImage} onRemoveCapture={removeCapture}
          title={hasMedia ? 'Change image or video (or paste one)' : 'Add an image, GIF or video (or paste one)'}
          capture={{ ...target, button: (className, label, note) => <CaptureButton p={p} l={l} onUse={onSetCapture} className={className} label={label} note={note} /> }}
          generate={className => <GeneratePreviewsButton className={className} label="Generate previews" set={previewSetKey(l.id)} name={l.name} stopOnly
            paths={mine.map(k => byKey.get(k)?.path).filter((x): x is string => Boolean(x))} />} />
        <div className="lp-info">
          <span className="lp-name-wrap">
            <input ref={nameRef} className="lp-name" value={name} title="Rename" aria-label="Loadout name" onChange={e => setName(e.target.value)} onBlur={commit}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setName(l.name) }} />{/* Esc cancels: blurring here would save the typed text */}
            <button type="button" className="lo-icon lp-pen" title="Rename loadout" aria-label="Rename loadout" onClick={() => { nameRef.current?.focus(); nameRef.current?.select() }}>
              <Pencil size={14} />
            </button>
            {/* Beside the name, where a document says it saved; its mods switching counts too: every change here applies at once */}
            <SavedNote sig={JSON.stringify([l.name, l.label, l.hotkey ?? null, l.on, l.mediaRev ?? null, Boolean(l.image), mine.map(k => (byKey.get(k)?.enabled ? 1 : 0)).join('')])} />
          </span>
          <div className="lp-group">
            <span>Collection</span>
            {newGroup === null
              ? <CustomDropdown
                  options={[...groups.map(g => ({ value: g, label: g })), { value: OTHER, label: OTHER_LABEL }]}
                  value={group ?? OTHER}
                  onChange={(v: string) => setLoadoutGroup(l.id, v)}
                  onAddNew={() => setNewGroup('')} addNewLabel="+ New collection" />
              : <input autoFocus value={newGroup} placeholder="New collection name" aria-label="New collection name" onChange={e => setNewGroup(e.target.value)}
                  onBlur={() => { if (newGroup.trim()) setLoadoutGroup(l.id, addGroup(newGroup.trim())); setNewGroup(null) }}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setNewGroup(null) }} />}
          </div>
          <div className="lp-actions">
            <label className="lp-switch">
              <Switch size="sm" color="primary" checked={active} isDisabled={present === 0} disabled={busy || present === 0}
                onChange={(on: boolean) => onToggle(on)} title={switchTitle} aria-label={switchTitle} />
              {/* On, Off, or how far it is on, each with its dot (green, red, yellow) */}
              <span className="lp-switch-state">
                <SwapText text={busy ? 'Switching…' : active ? 'On' : onNow ? `${onNow}/${present}` : 'Off'} />
                {!busy && present > 0 && <OnDot on={onNow} of={present} />}
              </span>
            </label>
            {/* The rest are occasional: one menu instead of a wrapping row of equal buttons */}
            <MoreMenu items={[
              { label: 'Duplicate', onClick: () => openLoadout(duplicateLoadout(l).id, true) },
              { label: exporting ? 'Exporting…' : 'Export as zip', onClick: exportZip, disabled: exporting },
              ...(missing.length ? [{ label: `Remove ${plural(missing.length, 'missing mod')}`, onClick: dropMissing }] : []),
              ...(hasMedia ? [{ label: 'Remove image', onClick: removeImage }] : []),
            ]} l={l} loadouts={loadouts} danger={{ label: 'Delete', danger: true, onClick: () => { deleteWithUndo(p, l); onBack() } }} />
          </div>
        </div>
      </div>

      <section className="lp-section">
        <h2 className="lo-group-head">In this loadout<span className="lo-group-count">{mine.length}</span>
          {missing.length > 0 && <span className="lp-head-note">{missing.length} not installed</span>}</h2>
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
