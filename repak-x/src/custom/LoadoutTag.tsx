// repakxtra: the In <loadout> tag on a Library row (Settings > On each mod, off by default), the VFX Updater's tag:
// the first loadout that turns the mod on, +N for the rest (the tooltip names them). A click opens that loadout's page.
import { openLoadout, useLoadoutsHolding } from './loadoutStore'
import { useUiPref } from './uiPrefs'

export function LoadoutTag({ path }: { path: string }) {
  const on = useUiPref('loadout-tag')
  const held = useLoadoutsHolding(path)
  if (!on || !held.length) return null
  const [first, ...rest] = held
  return (
    <button type="button" className="mod-type-badge loadout-badge" onClick={e => { e.stopPropagation(); openLoadout(first.id) }}
      title={`In ${first.name}${rest.length ? `. Also in ${rest.map(l => l.name).join(', ')}` : ''}. Click to open it`}>
      <i>In</i><span>{first.name}</span>{rest.length > 0 && <b>+{rest.length}</b>}
    </button>
  )
}
