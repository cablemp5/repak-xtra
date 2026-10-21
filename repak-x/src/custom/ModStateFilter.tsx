// repakxtra: All / Enabled / Disabled switch next to the list title, plus Broken while any mod will not work in the
// installed game version or may crash (custom/brokenMods.ts).
import { useEffect } from 'react'
import { useBrokenVersion, verdictOf } from './brokenMods'
import { useUiPref } from './uiPrefs'

export type ModState = 'all' | 'enabled' | 'disabled' | 'broken'

export const matchesState = (state: ModState) => (mod: { path: string; enabled?: boolean }) =>
  state === 'all' || (state === 'broken' ? Boolean(verdictOf(mod.path)) : (state === 'enabled') === Boolean(mod.enabled))

type Props = {
  value: ModState
  onChange: (state: ModState) => void
  mods: { path: string; enabled?: boolean }[]
}

export default function ModStateFilter({ value, onChange, mods }: Props) {
  useBrokenVersion()
  const enabled = mods.filter(m => m.enabled).length
  const shown = useUiPref('broken') // Settings can hide the Broken tab and badges
  const broken = shown ? mods.filter(m => verdictOf(m.path)).length : 0
  // the last broken mod fixed or removed: back to every mod rather than an empty list
  useEffect(() => { if (value === 'broken' && broken === 0) onChange('all') }, [value, broken]) // eslint-disable-line react-hooks/exhaustive-deps
  const options: [ModState, string, number][] = [
    ['all', 'All', mods.length],
    ['enabled', 'Enabled', enabled],
    ['disabled', 'Disabled', mods.length - enabled],
    ...(broken ? [['broken', 'Broken', broken] as [ModState, string, number]] : []),
  ]
  return (
    <div className="mod-state-filter" role="group" aria-label="Show mods" data-tour="mod-state">
      {options.map(([state, label, count]) => (
        <button
          key={state}
          type="button"
          aria-pressed={value === state}
          onClick={() => onChange(state)}
          className={state === 'broken' ? 'is-broken' : undefined}
          title={state === 'broken' ? 'Mods that will not work in this game version, or may crash it. Hover a badge for why' : undefined}
        >
          {label}
          <span className="mod-state-count">{count}</span>
        </button>
      ))}
    </div>
  )
}
