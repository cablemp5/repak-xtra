// repakxtra: loadout pieces the Library uses (state lives in loadoutStore.ts): the selection bar's Add to loadout, the
// right-click Add to loadout items, switching with its guards (runChanges), and Ctrl+N for a loadout pinned to N.
import { useEffect, useRef } from 'react'
import { Check, ListPlus } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import type { useAlert } from '../components/AlertHandler'
import {
  type Loadout, type Mod, changesToTurnOff, changesToTurnOn, deleteLoadout, flipMods, hotkeySlots, isActive, modKey,
  nameKey, nextLoadoutName, openLoadout, patchLoadout, readLoadouts, useLoadouts, withMods, writeLoadouts,
} from './loadoutStore'
import { canonKey } from './loadoutIdentity'
import { isTyping } from './hotkeys'
import { modalOpen } from './dialogFocus'
import { plural } from './modName'
import { type Verdict, verdictOf } from './brokenMods'
import { brokenShown } from './uiPrefs'
import { GAME_RUNNING } from './keepOne'

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
  onModContextMenu?: (e: React.MouseEvent, mod: Mod) => void // a mod row's right-click: the Library's menu (Update VFX and the rest)
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
        icon={<ListPlus size={15} />}
        options={loadouts.map(l => ({ value: l.id, label: l.name }))}
        value=""
        placeholder="Add to loadout"
        disabled={paths.length === 0}
        addNewLabel="+ New loadout"
        onAddNew={() => {
          const l = createFromMods(paths)
          const id = alert.success(`${l.name} created`, `With the ${plural(l.on.length, 'selected mod')}. Rename it on its page.`, {
            action: { label: 'Open', onClick: () => { alert.dismissAlert(id); openLoadout(l.id, true) } },
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
      action: { label: 'Open', onClick: () => { alert.dismissAlert(id); openLoadout(l.id, true) } },
    })
    close()
  }
  return (
    <>
      <div className="context-menu-item" onClick={create}>+ New loadout</div>
      {loadouts.length > 0 && <div className="context-menu-separator" />}
      <div className="scrollable-menu-list" style={{ maxHeight: '300px', overflowY: 'auto', paddingRight: '4px' }}>
        {loadouts.map(l => {
          const has = keys.every(k => l.on.some(o => canonKey(o) === k))
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

/** Delete with a 10 s Undo, like deleting a mod: it waits 7 days in Settings > Recently deleted. False when it could
 *  not be kept there (then it is not deleted). */
export function deleteWithUndo(p: LoadoutProps, l: Loadout) {
  let restore: () => unknown
  try { restore = deleteLoadout(l.id) } catch (e) {
    p.alert.warning(`${l.name} not deleted`, `It could not be kept in Recently deleted, so it stays. ${String(e)}`)
    return false
  }
  const id = p.alert.info(`Deleted ${l.name}`, 'Its mods were not changed. Kept for 7 days in Settings > Recently deleted.', {
    duration: 10000,
    action: { label: 'Undo', onClick: () => {
      p.alert.dismissAlert(id)
      try { restore() } catch (e) { p.alert.warning(`${l.name} not restored`, String(e)) }
    } },
  })
  return true
}

let switching = '' // the loadout being switched: one at a time, whether from the sidebar, Ctrl+N, a card or a page

/** Heroes whose look (a Mesh or Texture mod) the loadout changes. */
const looksOf = (p: LoadoutProps, l: Loadout) => {
  const on = new Set(l.on.map(canonKey))
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
    p.alert.warning(...GAME_RUNNING)
    return
  }
  if (switching) {
    p.alert.info('One switch at a time', `${switching} is still switching. Try ${l.name} again in a moment.`)
    return
  }
  if (changes.length === 0) {
    const installed = changesToTurnOn(l, p.mods).length + changesToTurnOff(l, p.mods).length
    p.alert.info('Nothing to switch', installed ? `${l.name}'s mods are already ${verb}.` : `${l.name} has no installed mods.`)
    return
  }
  switching = l.name || 'A loadout'
  try {
    const wasOn = readLoadouts().filter(o => o.id !== l.id && isActive(o, p.mods))
    // Mods that will not work or may crash, read before the switch renames their files
    const flagged = verb === 'on' && brokenShown() ? changes.map(m => verdictOf(m.path)).filter((v): v is Verdict => Boolean(v)) : []
    const failed = await flipMods(changes)
    await p.reload()
    const flipped = new Set(changes.filter(m => !failed.includes(m)).map(m => m.path))
    const after = p.mods.map(m => (flipped.has(m.path) ? { ...m, enabled: !m.enabled } : m))
    if (failed.length) {
      p.alert.warning(`${l.name} partly ${verb}`, failed.reason ?? `Could not switch ${failed.map(m => nameKey(m.path)).join(', ')}. Close anything using those files, then try again.`)
    } else {
      p.alert.success(`${l.name} ${verb}`, `${plural(changes.length, 'mod')} switched.`)
    }
    if (verb === 'off') {
      const alsoOff = wasOn.filter(o => !isActive(o, after))
      if (alsoOff.length) p.alert.info(`${alsoOff.map(o => o.name).join(', ')} also off`, `${alsoOff.length === 1 ? 'It shares' : 'They share'} mods with ${l.name}.`)
      return
    }
    const risky = flagged.filter(v => v.kind === 'risky').map(v => nameKey(v.path))
    const broken = flagged.filter(v => v.kind === 'broken').map(v => nameKey(v.path))
    const vfx = flagged.filter(v => v.kind === 'vfx').map(v => nameKey(v.path))
    if (vfx.length) p.alert.warning('Made for the old game files', `${vfx.join(', ')} ${vfx.length === 1 ? 'is a VFX mod' : 'are VFX mods'} from before the last game update. The VFX Updater (Update VFX mods at the top, or right-click > For modders > Send to VFX Updater) rebuilds ${vfx.length === 1 ? 'it' : 'them'}.`, { duration: 15000 })
    if (risky.length) p.alert.warning('May crash the game', `${risky.join(', ')} ${risky.length === 1 ? 'is a Blueprint mod' : 'are Blueprint mods'} from before the last game update. If the game crashes, turn ${risky.length === 1 ? 'it' : 'them'} off and look for an updated version.`, { duration: 15000 })
    if (broken.length) p.alert.warning('Will not work in this game version', `${broken.join(', ')} ${broken.length === 1 ? 'replaces' : 'replace'} game files an update renamed or removed.`, { duration: 15000 })
    const mine = looksOf(p, l)
    for (const o of wasOn) {
      const both = [...looksOf(p, o)].filter(h => mine.has(h))
      if (!both.length) continue
      const keep = new Set(l.on.map(canonKey))
      const id = p.alert.warning(`${o.name} is also on`, `It changes ${both.join(', ')} too, and the game shows only one look.`, {
        duration: 12000,
        action: {
          label: `Turn ${o.name} off`,
          onClick: () => { p.alert.dismissAlert(id); runChanges(p, o, changesToTurnOff(o, after).filter(m => !keep.has(modKey(m.path))), 'off') },
        },
      })
    }
  } finally {
    switching = ''
  }
}

/** Ctrl+1..9 toggles the loadout pinned to that number (an active loadout turns off, any other turns on). Mounted
 *  once by App, on every view; it draws nothing (the Library's sidebar list it lived in is gone). */
export default function LoadoutHotkeys(p: LoadoutProps) {
  const loadouts = useLoadouts()
  const busy = useRef(false)
  const apply = async (l: Loadout) => {
    busy.current = true
    try {
      if (isActive(l, p.mods)) await runChanges(p, l, changesToTurnOff(l, p.mods), 'off')
      else await runChanges(p, l, changesToTurnOn(l, p.mods), 'on')
    } finally { busy.current = false }
  }
  const latest = useRef({ loadouts, apply })
  latest.current = { loadouts, apply }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key) || isTyping(e.target) || modalOpen()) return
      const l = hotkeySlots(latest.current.loadouts).get(Number(e.key))
      if (!l || busy.current) return
      e.preventDefault()
      latest.current.apply(l)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return null
}
