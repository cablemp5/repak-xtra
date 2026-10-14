// caleb fork: Home's "New this week" strip. Mods added or changed in the last 7 days that no loadout turns on, newest
// first (older loose mods live in the Library), each with an on/off
// switch and "Add to loadout". When a loadout holds an older version of the same mod (same name, lower _vN) the row
// offers "Replace v10 in <loadout>": one click swaps it in that loadout (and turns the old file off and the new one on
// when the old one was on), with Undo.
import { useRef, useState } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import type { LoadoutProps } from './Loadouts'
import { ModRow } from './loadoutBits'
import { Num } from './motion'
import {
  type Loadout, type Mod, addModToLoadout, displayName, flipMods, modKey, olderVersionIn, patchLoadout, readLoadouts,
  replaceInLoadout, useLoadouts, versionOf,
} from './loadoutStore'

const SHOWN = 6
const WEEK = 7 * 24 * 3600
/** modified_date in seconds (the backend) or milliseconds (older fixtures). */
const ageSeconds = (m: Mod) => { const t = m.modified_date ?? 0; return Date.now() / 1000 - (t > 1e12 ? t / 1000 : t) }

export default function NewStrip(p: LoadoutProps) {
  const loadouts = useLoadouts()
  const [all, setAll] = useState(false)
  const latest = useRef(p.mods)
  latest.current = p.mods

  const inAny = new Set(loadouts.flatMap(l => l.on.map(displayName)))
  const seen = new Set<string>()
  const fresh = [...p.mods]
    .sort((a, b) => (b.modified_date ?? 0) - (a.modified_date ?? 0))
    .filter(m => { const k = modKey(m.path); if (ageSeconds(m) > WEEK || inAny.has(k) || seen.has(k)) return false; seen.add(k); return true })
  if (fresh.length === 0) return null
  const shown = all ? fresh : fresh.slice(0, SHOWN)

  const replace = async (l: Loadout, oldKey: string, mod: Mod) => {
    const newKey = modKey(mod.path)
    const before = { on: l.on, scope: l.scope }
    const oldMod = latest.current.find(m => modKey(m.path) === oldKey)
    replaceInLoadout(l, oldKey, newKey)
    // Keep the loadout's state: if the old version was on, the new one takes its place
    const swap = oldMod?.enabled && !p.blocked ? [oldMod, ...(mod.enabled ? [] : [mod])] : []
    if (swap.length) { await flipMods(swap); await p.reload() }
    const was = { [oldKey]: Boolean(oldMod?.enabled), [newKey]: Boolean(mod.enabled) }
    const oldV = `v${versionOf(oldKey)?.n}`, newV = `v${versionOf(newKey)?.n}`
    const id = p.alert.info(`${l.name}: ${oldV} → ${newV}`,
      swap.length ? `${newV} is on, ${oldV} is off.` : oldMod?.enabled ? 'The game is running, so no files were switched.' : 'Both stay off until you turn the loadout on.', {
        duration: 10000,
        action: {
          label: 'Undo', onClick: async () => {
            p.alert.dismissAlert(id)
            const now = readLoadouts().find(x => x.id === l.id)
            if (now) patchLoadout(l.id, before)
            const back = latest.current.filter(m => modKey(m.path) in was && Boolean(m.enabled) !== was[modKey(m.path)])
            if (back.length && !p.blocked) { await flipMods(back); await p.reload() }
          },
        },
      })
  }

  return (
    <section className="new-strip" aria-label="New mods not in a loadout">
      <h3 className="lo-group-head" title="Added or changed in the last 7 days, and not in any loadout yet">
        New this week · not in a loadout<span className="lo-group-count"><Num id="new-strip" value={fresh.length} /></span>
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
