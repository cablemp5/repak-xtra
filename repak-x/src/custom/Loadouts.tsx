// caleb fork: sidebar list of saved loadouts (state lives in loadoutStore.ts). Click a loadout to
// turn it on; the grid button opens the cards screen with on/off switches and images.
import { type MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check, Layers, LayoutGrid, Plus, Save, X } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import type { useAlert } from '../components/AlertHandler'
import {
  type Loadout, type Mod, addModToLoadout, changesToTurnOff, changesToTurnOn, deleteLoadout, flipMods, importLoadouts, isActive, modKey, readLoadouts,
  setView, snapshotLoadout, useLoadouts, writeLoadouts,
} from './loadoutStore'

export type LoadoutProps = {
  mods: Mod[]            // every installed mod
  scopeMods: Mod[]       // mods currently shown (folder, hero, type, tag and search filters)
  scopeLabel: string     // what the current filters mean, e.g. "Black Panther"
  blocked: boolean       // game running and the lock is not bypassed
  reload: () => Promise<unknown>
  alert: ReturnType<typeof useAlert>
  modDetails?: Record<string, { character_name?: string | null; category?: string | null } | undefined>
}

const HEIGHT_KEY = 'caleb.loadoutsHeight'

/** Drag to set the sidebar list's height (same grip as the filters/folders handle); saved across starts. */
function useListHeight() {
  const [height, setHeight] = useState<number | null>(() => Number(localStorage.getItem(HEIGHT_KEY)) || null)
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

/** Selection bar: add every selected mod to a loadout (it also starts managing them). */
export function AddToLoadoutField({ paths, alert }: { paths: string[]; alert: LoadoutProps['alert'] }) {
  const loadouts = useLoadouts()
  if (loadouts.length === 0) return null
  return (
    <div className="bulk-field" title="Add the selected mods to a loadout">
      <CustomDropdown
        icon={<Layers size={15} />}
        options={loadouts.map(l => ({ value: l.id, label: l.name }))}
        value=""
        placeholder="Add to loadout"
        disabled={paths.length === 0}
        onChange={(id: string) => {
          const l = readLoadouts().find(x => x.id === id)
          if (!l) return
          const keys = [...new Set(paths.map(modKey))]
          keys.forEach(k => addModToLoadout(readLoadouts().find(x => x.id === id)!, k))
          alert.success(`Added to ${l.name}`, `${keys.length} mod${keys.length === 1 ? '' : 's'}.`)
        }}
      />
    </div>
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

/** Overwrite with the shown mods' current state, with Undo back to what it held before. */
export function overwriteWithUndo(p: LoadoutProps, l: Loadout) {
  const before = { label: l.label, scope: l.scope, on: l.on }
  writeLoadouts(readLoadouts().map(x => (x.id === l.id ? snapshotLoadout(x, p.scopeMods) : x)))
  const id = p.alert.info(`Updated ${l.name}`, `It now holds the ${p.scopeMods.length} shown mods as they are now.`, {
    duration: 10000,
    action: { label: 'Undo', onClick: () => { p.alert.dismissAlert(id); writeLoadouts(readLoadouts().map(x => (x.id === l.id ? { ...x, ...before } : x))) } },
  })
}

/** Shared by the sidebar and the cards screen: apply a set of flips with the game-running guard. */
export async function runChanges(p: LoadoutProps, l: Loadout, changes: Mod[], verb: string) {
  if (p.blocked) {
    p.alert.warning('Game Running', 'Cannot toggle mods while game is running.')
    return
  }
  if (changes.length === 0) return
  const failed = await flipMods(changes)
  await p.reload()
  if (failed) p.alert.warning(`${l.name} partly ${verb}`, `${failed} of ${changes.length} mods could not be switched.`)
  else {
    p.alert.success(`${l.name} ${verb}`, `${changes.length} mod${changes.length === 1 ? '' : 's'} switched.`)
  }
}

export default function Loadouts(p: LoadoutProps) {
  const loadouts = useLoadouts()
  const size = useListHeight()
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (naming) inputRef.current?.focus() }, [naming])

  const save = () => {
    const trimmed = name.trim()
    if (trimmed) writeLoadouts([...readLoadouts(), snapshotLoadout({ id: crypto.randomUUID(), name: trimmed }, p.scopeMods)])
    setNaming(false)
    setName('')
  }


  // Click toggles: an active loadout turns off, any other turns on (and displaces overlapping ones)
  const apply = async (l: Loadout) => {
    setBusy(l.id)
    if (isActive(l, p.mods)) await runChanges(p, l, changesToTurnOff(l, p.mods), 'off')
    else {
      await runChanges(p, l, changesToTurnOn(l, p.mods), 'on')
    }
    setBusy(null)
  }

  // A loadouts file waiting in %APPDATA%\Repak-X (from scripts/tags-to-loadouts.py) is merged once
  useEffect(() => {
    invoke<string | null>('take_pending_loadouts').then(text => {
      if (!text) return
      try {
        const { added, skipped } = importLoadouts(text)
        p.alert.success('Loadouts added', `${added} new loadout${added === 1 ? '' : 's'}${skipped ? `, ${skipped} already existed` : ''}.`)
      } catch (e) {
        p.alert.error('Loadouts file not imported', String(e))
      }
    }).catch(() => undefined)
  }, [])

  // Ctrl+1..9 toggles the loadout at that position in this list
  const latest = useRef({ loadouts, apply, busy })
  latest.current = { loadouts, apply, busy }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key)) return
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
          <button type="button" className="lo-icon" title="Open Home (loadout cards)" onClick={() => setView('home')}>
            <LayoutGrid size={15} />
          </button>
          <button type="button" className="lo-icon" title="Save the shown mods' on/off state as a loadout" onClick={() => setNaming(true)}>
            <Plus size={15} />
          </button>
        </span>
      </div>

      {loadouts.length === 0 && !naming && (
        <p className="lo-empty">Filter to a hero, set which mods are on, then save it here to switch back in one click.</p>
      )}

      {loadouts.map((l, i) => {
        const active = isActive(l, p.mods)
        const hotkey = i < 9 ? ` (Ctrl+${i + 1})` : ''
        const pending = changesToTurnOn(l, p.mods).length
        return (
          <div className="fp-row-wrap lo-row" key={l.id}>
            <button type="button" className="fp-row" aria-pressed={active} disabled={busy !== null}
              onClick={() => apply(l)} title={active ? `${l.name} is on. Click to turn its mods off${hotkey}` : `Turn on ${l.name}: switches ${pending} of its mods on${hotkey}`}>
              <span className="fp-lead">{active ? <Check size={15} className="lo-active" /> : <span className="lo-dot" />}</span>
              <span className="fp-label">{l.name}</span>
              <span className="fp-count">{busy === l.id ? '…' : `${l.on.length} on`}</span>
              {/* the number Ctrl+N toggles; rows past 9 have none */}
              <span className="lo-num" aria-hidden="true">{i < 9 ? i + 1 : ''}</span>
            </button>
            <button type="button" className="lo-icon lo-hover" title={`Overwrite ${l.name} with the shown mods' current state`} onClick={() => overwriteWithUndo(p, l)}>
              <Save size={14} />
            </button>
            <button type="button" className="lo-icon lo-hover" title={`Delete ${l.name}`} onClick={() => deleteWithUndo(p, l)}>
              <X size={14} />
            </button>
          </div>
        )
      })}

      {naming && (
        <div className="lo-new">
          <input ref={inputRef} value={name} placeholder="Loadout name" onChange={e => setName(e.target.value)}
            onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') save(); if (e.key === 'Escape') { setNaming(false); setName('') } }}
            onBlur={save} />
          <p className="lo-hint">Saves which of the {p.scopeMods.length} shown mods ({p.scopeLabel}) are on.</p>
        </div>
      )}
    </div>
    <div className={`vertical-resizer lo-resizer ${size.dragging ? 'resizing' : ''}`} onMouseDown={size.start} />
    </>
  )
}
