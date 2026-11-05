// repakxtra: a mod's Broken, Needs VFX update or May crash badge (custom/brokenMods.ts). Needs VFX update is a button
// that opens the VFX Updater with that mod ticked. A mod the Mod Updater made for this game says so instead: Updated, or
// Partly updated while it waits for files only the game's new USMAP can rebuild.
import type { Verdict } from './brokenMods'
import { useMade, verdictLabel } from './brokenMods'
import { fixInVfxWindow } from './vfx/handoff'

export function VerdictBadge({ path, verdict }: { path: string; verdict?: Verdict }) {
  const made = useMade(path)
  if (!verdict) return made
    ? <span className={`mod-type-badge made-badge${made.partial ? ' is-partial' : ''}`} title={made.partial
      ? 'Updated by the Mod Updater for this game, without the Niagara files only the game\'s new USMAP can rebuild. They show the game\'s usual colors until then.'
      : 'Updated by the Mod Updater for this game version.'}>{made.partial ? 'Partly updated' : 'Updated'}</span>
    : null
  const cls = `mod-type-badge broken-badge is-${verdict.kind}`
  if (verdict.kind !== 'vfx') return <span className={cls} title={verdict.reason}>{verdictLabel(verdict.kind)}</span>
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
