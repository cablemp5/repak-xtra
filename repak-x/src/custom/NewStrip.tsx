// repakxtra: Home's "New this week" strip. Mods added or changed in the last 7 days that no loadout turns on, newest
// first (older loose mods live in the Library), each with an on/off
// switch and "Add to loadout". When a loadout holds an older version of the same mod (same name, lower _vN) the row
// offers "Replace v10 in <loadout>": one click swaps it in that loadout (and turns the old file off and the new one on
// when the old one was on), with Undo. The row stays while another loadout still holds an older version.
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ArrowRightLeft } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import type { LoadoutProps } from './Loadouts'
import { ModRow } from './loadoutBits'
import { Num } from './motion'
import {
  type Loadout, type Mod, addModToLoadout, displayName, flipMods, loadoutable, modKey, olderVersionIn, patchLoadout, readLoadouts,
  replaceInLoadout, sameMembership, useLoadouts, versionOf,
} from './loadoutStore'

const SHOWN = 6
const WEEK = 7 * 24 * 3600
/** modified_date in seconds (the backend) or milliseconds (older fixtures). */
const ageSeconds = (m: Mod) => { const t = m.modified_date ?? 0; return Date.now() / 1000 - (t > 1e12 ? t / 1000 : t) }

export default function NewStrip(p: LoadoutProps) {
  const loadouts = useLoadouts()
  const [all, setAll] = useState(false)

  const inAny = new Set(loadouts.flatMap(l => l.on.map(displayName)))
  const seen = new Set<string>()
  const fresh = [...p.mods]
    .sort((a, b) => (b.modified_date ?? 0) - (a.modified_date ?? 0))
    .filter(m => {
      const k = modKey(m.path)
      if (!loadoutable(k) || ageSeconds(m) > WEEK || seen.has(k) || (inAny.has(k) && !loadouts.some(l => olderVersionIn(l, k)))) return false
      seen.add(k)
      return true
    })
  if (fresh.length === 0) return null
  const shown = all ? fresh : fresh.slice(0, SHOWN)

  const replace = async (l: Loadout, oldKey: string, mod: Mod) => {
    const newKey = modKey(mod.path)
    const before = { on: l.on, scope: l.scope }
    const oldMod = p.mods.find(m => modKey(m.path) === oldKey)
    const oldOn = Boolean(oldMod?.enabled), newOn = Boolean(mod.enabled)
    replaceInLoadout(l, oldKey, newKey)
    const after = readLoadouts().find(x => x.id === l.id) // Undo only puts this back while the mods are still as left here
    // Keep the loadout's state: if the old version was on, the new one takes its place. The loadout keeps the new
    // version even when a file could not be switched
    const blocked = p.isBlocked()
    const swap = oldMod && oldOn && !blocked ? [oldMod, ...(newOn ? [] : [mod])] : []
    const failed = swap.length ? await flipMods(swap) : []
    if (swap.length) await p.reload()
    const was = { [oldKey]: oldOn, [newKey]: newOn }
    const oldV = `v${versionOf(oldKey)?.n}`, newV = `v${versionOf(newKey)?.n}`
    const text = failed.length ? `Could not switch ${failed.map(m => modKey(m.path)).join(', ')}; ${l.name} now lists ${newV}.`
      : oldOn && blocked ? `${l.name} now lists ${newV}; the game is running, so no files were switched.`
      : oldOn && newOn ? `${newV} was already on; ${oldV} is off.`
      : oldOn ? `${newV} is on, ${oldV} is off.`
      : newOn ? `${newV} is already on; ${oldV} stays off.`
      : 'Both stay off until you turn the loadout on.'
    const id = (failed.length ? p.alert.warning : p.alert.info)(`${l.name}: ${oldV} → ${newV}`, text, {
      duration: 10000,
      action: {
        // Undo can run after Home opened a loadout page (this strip unmounted): it reads the game lock and the files
        // fresh, and leaves the toast up when it cannot act yet
        label: 'Undo', onClick: async () => {
          const wait = () => p.alert.warning('Game running', 'Undo waits until the game is closed.')
          if (p.isBlocked()) return wait()
          let current: Mod[]
          try {
            current = await invoke<Mod[]>('get_pak_files')
          } catch (e) {
            return p.alert.warning('Undo not possible yet', `The mod list could not be read: ${String(e)}`)
          }
          if (p.isBlocked()) return wait()
          const now = readLoadouts().find(x => x.id === l.id)
          p.alert.dismissAlert(id)
          if (!now || !after) return p.alert.warning('Not undone', `${l.name} was deleted after the swap.`)
          if (!sameMembership(now, after)) return p.alert.warning('Not undone', `${now.name} was edited after the swap.`)
          patchLoadout(l.id, before)
          const back = current.filter(m => modKey(m.path) in was && Boolean(m.enabled) !== was[modKey(m.path)])
          if (!back.length) return
          const stuck = await flipMods(back)
          await p.reload()
          if (stuck.length) p.alert.warning('Undo incomplete', `${l.name} lists ${oldV} again, but ${stuck.map(m => modKey(m.path)).join(', ')} could not be switched back.`)
        },
      },
    })
  }

  return (
    <section className="new-strip" aria-label="New mods and version updates">
      <h3 className="lo-group-head" title="Added or changed in the last 7 days: not in a loadout, or a newer version of one that is">
        New this week<span className="lo-group-count"><Num id="new-strip" value={fresh.length} /></span>
        {fresh.length > SHOWN && (
          <button type="button" className="new-strip-more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${fresh.length}`}</button>
        )}
      </h3>
      <ul className="mod-rows">
        {shown.map(m => {
          const k = modKey(m.path)
          const offers = loadouts.map(l => ({ l, old: olderVersionIn(l, k) })).filter((o): o is { l: Loadout; old: string } => Boolean(o.old))
          return (
            <ModRow key={k} p={p} k={k} mod={m} onToggle>
              {offers.slice(0, 2).map(({ l, old }) => (
                <button key={l.id} type="button" className="row-action is-offer" onClick={() => replace(l, old, m)}
                  title={`Put ${k} in ${l.name} in place of ${old}`}>
                  <ArrowRightLeft size={13} /> Replace v{versionOf(old)?.n} in {l.name}
                </button>
              ))}
              {loadouts.length > 0 && (
                <div className="row-add-to">
                  <CustomDropdown
                    options={loadouts.map(l => ({ value: l.id, label: l.name }))}
                    value=""
                    placeholder="Add to loadout"
                    onChange={(id: string) => { const l = readLoadouts().find(x => x.id === id); if (l) { addModToLoadout(l, k); p.alert.success(`Added to ${l.name}`, k) } }}
                  />
                </div>
              )}
            </ModRow>
          )
        })}
      </ul>
    </section>
  )
}
