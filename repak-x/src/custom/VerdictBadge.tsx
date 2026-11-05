// repakxtra: a mod's Broken, Needs VFX update or May crash badge (custom/brokenMods.ts). Needs VFX update is a button
// that opens the VFX Updater with that mod ticked. A mod the Mod Updater made reads Partly updated (the new USMAP can
// finish it) or Update again (the game changed since) instead. Updated tags live in the Mod Updater's own list.
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
  // waits for the USMAP of this game build: still opens the VFX Updater, which says why. One the Mod Updater made never
  // reads Needs update: Partly updated (the new USMAP can finish it) or Update again
  const label = verdict.usmapWait ? 'Waiting' : made ? (made.partial ? 'Partly updated' : 'Update again') : verdictLabel(verdict.kind)
  return (
    <button type="button" className={`${cls} is-action${verdict.usmapWait ? ' is-waiting' : ''}`} title={`${verdict.reason} Click to open it in the Mod Updater.`}
      onClick={e => { e.stopPropagation(); void fixInVfxWindow([path], false) }}>
      {label}
    </button>
  )
}
