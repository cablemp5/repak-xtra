// repakxtra: a mod's Broken, Needs VFX update or May crash badge (custom/brokenMods.ts). Needs VFX update is a button
// that opens the VFX Updater with that mod ticked.
import type { Verdict } from './brokenMods'
import { verdictLabel } from './brokenMods'
import { fixInVfxWindow } from './vfx/handoff'

export function VerdictBadge({ path, verdict }: { path: string; verdict: Verdict }) {
  const cls = `mod-type-badge broken-badge is-${verdict.kind}`
  if (verdict.kind !== 'vfx') return <span className={cls} title={verdict.reason}>{verdictLabel(verdict.kind)}</span>
  // waits for the USMAP of this game build: still opens the VFX Updater, which says why
  return (
    <button type="button" className={`${cls} is-action${verdict.usmapWait ? ' is-waiting' : ''}`} title={`${verdict.reason} Click to open it in the VFX Updater.`}
      onClick={e => { e.stopPropagation(); void fixInVfxWindow([path], false) }}>
      {verdict.usmapWait ? 'Waiting' : verdictLabel(verdict.kind)}
    </button>
  )
}
