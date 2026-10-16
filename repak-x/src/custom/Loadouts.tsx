// repakxtra: sidebar list of saved loadouts (state lives in loadoutStore.ts). The dot or check turns a loadout on or
// off (as does Ctrl+1..9), the name opens its page on Home; drag rows to reorder them, which also reorders Ctrl+1..9.
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react'
import { Check, Layers, Plus, Trash2 } from 'lucide-react'
import Switch from '../components/ui/Switch'
import CustomDropdown from '../components/CustomDropdown'
import type { useAlert } from '../components/AlertHandler'
import {
  type Loadout, type Mod, changesToTurnOff, changesToTurnOn, deleteLoadout, flipMods, isActive, modKey, moveLoadout,
  nextLoadoutName, openLoadout, patchLoadout, readLoadouts, snapshotLoadout, useLoadouts, withMods, writeLoadouts,
} from './loadoutStore'
import { isTyping } from './hotkeys'
import { plural } from './modName'
import { OnDot } from './loadoutBits'
import { savedItem } from './storageCarryOver'

export type LoadoutProps = {
  mods: Mod[]            // every installed mod
  scopeMods: Mod[]       // mods currently shown (folder, hero, type, tag and search filters)
  scopeLabel: string     // what the current filters mean, e.g. "Black Panther"
  blocked: boolean       // game running and the lock is not bypassed
  isBlocked: () => boolean // the same, read live (Undo toasts outlive the component that made them)
  reload: () => Promise<unknown>
  alert: ReturnType<typeof useAlert>
  modDetails?: Record<string, { character_name?: string | null; category?: string | null; additional_categories?: string[]; mod_type?: string } | undefined>
  selected?: string[]    // paths picked in the Library: + makes a loadout of exactly these
}

const HEIGHT_KEY = 'repakxtra.loadoutsHeight'

/** Drag to set the sidebar list's height (same grip as the filters/folders handle); saved across starts. */
function useListHeight() {
  const [height, setHeight] = useState<number | null>(() => Number(savedItem(HEIGHT_KEY)) || null)
  const [dragging, setDragging] = useState(false)
  const start = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = (e.currentTarget.previousElementSibling as HTMLElement).offsetHeight
    let last = startH
    setDragging(true)
    const move = (ev: MouseEvent) => {
      last = Math.max(48, Math.min(window.innerHeight - 260, startH + ev.clientY - startY))
      setHeight(last)
    }
    const end = () => {
      setDragging(false)
      localStorage.setItem(HEIGHT_KEY, String(last))
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', end)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', end)
  }
  return { height, dragging, start }
}

/** A new loadout holding exactly these mods (all of them on), named "Loadout N". */
export function createFromMods(paths: string[], name?: string) {
  const keys = [...new Set(paths.map(modKey))]
  const l: Loadout = { id: crypto.randomUUID(), name: name || nextLoadoutName(readLoadouts().map(x => x.name)), label: 'Other', ...withMods({ on: [], scope: [] }, keys) }
  writeLoadouts([...readLoadouts(), l])
  return l
}

/** Selection bar: add every selected mod to a loadout (it also starts managing them), or start a new one with them. */
export function AddToLoadoutField({ paths, alert }: { paths: string[]; alert: LoadoutProps['alert'] }) {
  const loadouts = useLoadouts()
  return (
    <div className="bulk-field" title="Add the selected mods to a loadout">
      <CustomDropdown
        icon={<Layers size={15} />}
        options={loadouts.map(l => ({ value: l.id, label: l.name }))}
        value=""
        placeholder="Add to loadout"
        disabled={paths.length === 0}
        addNewLabel="+ New loadout"
        onAddNew={() => {
          const l = createFromMods(paths)
          const id = alert.success(`${l.name} created`, `With the ${plural(l.on.length, 'selected mod')}. Rename it on its page.`, {
            action: { label: 'Open', onClick: () => { alert.dismissAlert(id); openLoadout(l.id) } },
          })
        }}
        onChange={(id: string) => {
          const l = readLoadouts().find(x => x.id === id)
          if (!l) return
          const keys = [...new Set(paths.map(modKey))]
          patchLoadout(id, withMods(l, keys)) // one write however many mods
          alert.success(`Added to ${l.name}`, `${keys.length} mod${keys.length === 1 ? '' : 's'}.`)
        }}
      />
    </div>
  )
}

/** The Library's right-click "Add to loadout" submenu: a new loadout with these mods, then every loadout. */
export function LoadoutMenuItems({ paths, alert, close }: { paths: string[]; alert: LoadoutProps['alert']; close: () => void }) {
  const loadouts = useLoadouts()
  const keys = [...new Set(paths.map(modKey))]
  const addTo = (l: Loadout) => {
    patchLoadout(l.id, withMods(l, keys))
    alert.success(`Added to ${l.name}`, `${plural(keys.length, 'mod')}.`)
    close()
  }
  const create = () => {
    const l = createFromMods(paths)
    const id = alert.success(`${l.name} created`, `With ${plural(l.on.length, 'mod')}. Rename it on its page.`, {
      action: { label: 'Open', onClick: () => { alert.dismissAlert(id); openLoadout(l.id) } },
    })
    close()
  }
  return (
    <>
      <div className="context-menu-item" onClick={create}>+ New loadout</div>
      {loadouts.length > 0 && <div className="context-menu-separator" />}
      <div className="scrollable-menu-list" style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '4px' }}>
        {loadouts.map(l => {
          const has = keys.every(k => l.on.some(o => modKey(o) === k))
          return (
            <div key={l.id} className={`context-menu-item${has ? ' is-disabled' : ''}`} onClick={() => !has && addTo(l)}
              title={has ? `Already in ${l.name}` : undefined}>
              {l.name}{has && <Check size={13} className="lo-menu-check" />}
            </div>
          )
        })}
      </div>
    </>
  )
}

/** Delete with a 10 s Undo, like deleting a mod. */
export function deleteWithUndo(p: LoadoutProps, l: Loadout) {
  const restore = deleteLoadout(l.id)
  const id = p.alert.info(`Deleted ${l.name}`, 'Its mods were not changed.', {
    duration: 10000,
    action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); restore() } },
  })
}

let switching = false // one loadout switch at a time, whether from the sidebar, Ctrl+N, a card or a page

/** Heroes whose look (a Mesh or Texture mod) the loadout changes. */
const looksOf = (p: LoadoutProps, l: Loadout) => {
  const on = new Set(l.on.map(modKey))
  const heroes = new Set<string>()
  for (const m of p.mods) {
    const d = p.modDetails?.[m.path]
    if (on.has(modKey(m.path)) && (d?.category === 'Mesh' || d?.category === 'Texture') && d.character_name) heroes.add(d.character_name.split(' - ')[0])
  }
  return heroes
}

/** Shared by the sidebar and the cards screen: apply a set of flips with the game-running guard. Loadouts stay
 *  independent, but it says when another loadout that is on also changes the same hero's look (the game shows only
 *  one), and which other loadouts went off because they shared mods with this one. */
export async function runChanges(p: LoadoutProps, l: Loadout, changes: Mod[], verb: 'on' | 'off') {
  if (p.blocked) {
    p.alert.warning('Game running', 'Mods cannot be switched while the game is running.')
    return
  }
  if (switching) return
  if (changes.length === 0) {
    const installed = changesToTurnOn(l, p.mods).length + changesToTurnOff(l, p.mods).length
    p.alert.info('Nothing to switch', installed ? `${l.name}'s mods are already ${verb}.` : `${l.name} has no installed mods.`)
    return
  }
  switching = true
  try {
    const wasOn = readLoadouts().filter(o => o.id !== l.id && isActive(o, p.mods))
    const failed = await flipMods(changes)
    await p.reload()
    const flipped = new Set(changes.filter(m => !failed.includes(m)).map(m => m.path))
    const after = p.mods.map(m => (flipped.has(m.path) ? { ...m, enabled: !m.enabled } : m))
    if (failed.length) {
      p.alert.warning(`${l.name} partly ${verb}`, `Could not switch ${failed.map(m => modKey(m.path)).join(', ')}. Close anything using those files, then try again.`)
    } else {
      p.alert.success(`${l.name} ${verb}`, `${plural(changes.length, 'mod')} switched.`)
    }
    if (verb === 'off') {
      const alsoOff = wasOn.filter(o => !isActive(o, after))
      if (alsoOff.length) p.alert.info(`${alsoOff.map(o => o.name).join(', ')} also off`, `${alsoOff.length === 1 ? 'It shares' : 'They share'} mods with ${l.name}.`)
      return
    }
    const mine = looksOf(p, l)
    for (const o of wasOn) {
      const both = [...looksOf(p, o)].filter(h => mine.has(h))
      if (!both.length) continue
      const keep = new Set(l.on.map(modKey))
      const id = p.alert.warning(`${o.name} is also on`, `It changes ${both.join(', ')} too, and the game shows only one look.`, {
        duration: 12000,
        action: {
          label: `Turn ${o.name} off`,
          onClick: () => { p.alert.dismissAlert(id); runChanges(p, o, changesToTurnOff(o, after).filter(m => !keep.has(modKey(m.path))), 'off') },
        },
      })
    }
  } finally {
    switching = false
  }
}

export default function Loadouts(p: LoadoutProps) {
  const loadouts = useLoadouts()
  const size = useListHeight()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (naming) inputRef.current?.focus() }, [naming])

  const picked = p.selected ?? []
  // Selected mods: exactly those. Nothing selected: the shown mods that are on.
  const save = () => {
    const trimmed = name.trim()
    if (trimmed && picked.length) createFromMods(picked, trimmed)
    else if (trimmed) writeLoadouts([...readLoadouts(), snapshotLoadout({ id: crypto.randomUUID(), name: trimmed }, p.scopeMods)])
    setNaming(false)
    setName('')
  }

  // The switch (and Ctrl+N) toggles: an active loadout turns off, any other turns on
  const apply = async (l: Loadout) => {
    setBusy(l.id)
    if (isActive(l, p.mods)) await runChanges(p, l, changesToTurnOff(l, p.mods), 'off')
    else {
      await runChanges(p, l, changesToTurnOn(l, p.mods), 'on')
    }
    setBusy(null)
  }

  // Ctrl+1..9 toggles the loadout at that position in this list
  const latest = useRef({ loadouts, apply, busy })
  latest.current = { loadouts, apply, busy }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key) || isTyping(e.target) || document.querySelector('.modal-overlay')) return
      const l = latest.current.loadouts[Number(e.key) - 1]
      if (!l || latest.current.busy) return
      e.preventDefault()
      latest.current.apply(l)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
    <div className="loadouts" style={size.height ? { height: size.height, maxHeight: 'none' } : undefined}>
      <div className="fp-head">
        <span className="fp-title">Loadouts</span>
        <span className="lo-head-actions">
          <button type="button" className="lo-icon" aria-label="New loadout" onClick={() => setNaming(true)}
            title={picked.length ? `New loadout from the ${plural(picked.length, 'selected mod')}` : 'New loadout from the mods that are enabled'}>
            <Plus size={15} />
          </button>
        </span>
      </div>

      {loadouts.length === 0 && !naming && (
        <p className="lo-empty">No loadouts yet. Select mods (or turn on the ones you want) and press + to save them as one.</p>
      )}

      {loadouts.map((l, i) => {
        const active = isActive(l, p.mods)
        const hotkey = i < 9 ? ` (Ctrl+${i + 1})` : ''
        const pending = changesToTurnOn(l, p.mods).length
        const onNow = changesToTurnOff(l, p.mods).length // its mods that are on right now
        const none = pending + onNow === 0 // none of its mods is installed
        return (
          <div className={`fp-row-wrap lo-row ${active ? 'is-on' : ''} ${dropOn === l.id ? 'is-drop' : ''}`} key={l.id} draggable
            onDragStart={e => { e.dataTransfer.setData('text/x-loadout', l.id); e.dataTransfer.effectAllowed = 'move' }}
            onDragOver={e => { if (e.dataTransfer.types.includes('text/x-loadout')) { e.preventDefault(); setDropOn(l.id) } }}
            onDragLeave={() => setDropOn(null)}
            onDrop={e => { e.preventDefault(); setDropOn(null); const id = e.dataTransfer.getData('text/x-loadout'); if (id) moveLoadout(id, i) }}>
            {/* Left: how many of its mods are on (green all, yellow some, red none). Right: the switch that turns it on or off */}
            <button type="button" className="fp-row" onClick={() => openLoadout(l.id)} title={`Open ${l.name} in Loadouts (drag to reorder)`}>
              <span className="fp-lead"><OnDot on={onNow} of={onNow + pending} /></span>
              <span className="fp-label">{l.name}</span>
              {/* the number Ctrl+N toggles; rows past 9 have none */}
              <span className="lo-num" title={i < 9 ? `Ctrl+${i + 1} turns it on or off` : undefined}>{i < 9 ? i + 1 : ''}</span>
            </button>
            <Switch size="sm" color="primary" checked={active} isDisabled={none} disabled={busy !== null || none}
              onChange={() => apply(l)} aria-label={none ? 'No installed mods' : active ? `Turn ${l.name} off` : `Turn ${l.name} on`}
              title={none ? 'No installed mods' : active ? `Turn ${l.name}'s mods off${hotkey}` : `Turn ${l.name} on: switches ${pending} of its mods on${hotkey}`} />
            <button type="button" className="lo-icon lo-hover" title={`Delete ${l.name}`} aria-label={`Delete ${l.name}`} onClick={() => deleteWithUndo(p, l)}>
              <Trash2 size={14} />
            </button>
          </div>
        )
      })}

      {naming && (
        <div className="lo-new">
          <input ref={inputRef} value={name} placeholder="Loadout name" onChange={e => setName(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') { setNaming(false); setName('') } }}
            onBlur={save} />
          <p className="lo-hint">{picked.length ? `Holds the ${plural(picked.length, 'selected mod')}.` : `Holds the shown mods that are on (${p.scopeLabel}).`}</p>
        </div>
      )}
    </div>
    <div className={`vertical-resizer lo-resizer ${size.dragging ? 'resizing' : ''}`} onMouseDown={size.start} />
    </>
  )
}
