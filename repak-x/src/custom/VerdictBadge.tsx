// repakxtra: a mod's Broken, Needs VFX update or May crash badge (custom/brokenMods.ts). Needs VFX update is a button
// that opens the VFX Updater with that mod ticked. A partial update the Mod Updater made reads Partly updated (the new
// USMAP can finish it). Updated tags live in the Mod Updater's own list.
import type { Verdict } from './brokenMods'
import { useMade, verdictLabel } from './brokenMods'
import { fixInVfxWindow } from './vfx/handoff'

export function VerdictBadge({ path, verdict }: { path: string; verdict: Verdict }) {
  const made = useMade(path)
  const cls = `mod-type-badge broken-badge is-${verdict.kind}`
  // Safety unknown: what it means in plain words first, the check's own finding after
  const why = verdict.kind === 'unknown' ? `We checked this mod but couldn't tell if it's safe with this game version. If the game crashes, turn it off first.

${verdict.reason}` : verdict.reason
  if (verdict.kind !== 'vfx') return <span className={cls} title={why}>{verdictLabel(verdict.kind)}</span>
  // waits for the USMAP of this game build: still opens the VFX Updater, which says why. A partial update reads Partly
  // updated (the new USMAP can finish it), any other one Needs update like every mod
  const label = verdict.usmapWait ? 'Waiting' : made?.partial ? 'Partly updated' : verdictLabel(verdict.kind)
  return (
    <button type="button" className={`${cls} is-action${verdict.usmapWait ? ' is-waiting' : ''}`} title={`${verdict.reason} Click to open it in the Mod Updater.`}
      onClick={e => { e.stopPropagation(); void fixInVfxWindow([path], false) }}>
      {label}
    </button>
  )
}
