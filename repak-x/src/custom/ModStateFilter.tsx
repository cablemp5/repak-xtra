// repakxtra: All / Enabled / Disabled switch next to the list title.
export type ModState = 'all' | 'enabled' | 'disabled'

export const matchesState = (state: ModState) => (mod: { enabled?: boolean }) =>
  state === 'all' || (state === 'enabled') === Boolean(mod.enabled)

type Props = {
  value: ModState
  onChange: (state: ModState) => void
  mods: { enabled?: boolean }[]
}

export default function ModStateFilter({ value, onChange, mods }: Props) {
  const enabled = mods.filter(m => m.enabled).length
  const options: [ModState, string, number][] = [
    ['all', 'All', mods.length],
    ['enabled', 'Enabled', enabled],
    ['disabled', 'Disabled', mods.length - enabled],
  ]
  return (
    <div className="mod-state-filter" role="group" aria-label="Show mods">
      {options.map(([state, label, count]) => (
        <button
          key={state}
          type="button"
          aria-pressed={value === state}
          onClick={() => onChange(state)}
        >
          {label}
          <span className="mod-state-count">{count}</span>
        </button>
      ))}
    </div>
  )
}
