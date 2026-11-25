// repakxtra: a mod's load priority, one control in the Library, Conflicts, and the old clash list. The stepper is 1 to 7
// (1 is _9999999_P, an install, each step one more nine), below 1 is Unranked (no suffix), and Special (!) is its own
// switch: it adds or removes only the ! before the name.
import NumberInput from '../components/ui/NumberInput'

type Ranked = { path: string; priority?: number }
/** A leading ! in the file name: Special. */
export const isSpecial = (path: string) => (path.split(/[\\/]/).pop() ?? '').startsWith('!')
/** Two mods tie only when both match: a ! mod and an unranked one, or !Skin and Skin, are never tied (xtra_conflicts.rs rank). */
export const rankKey = (m: Ranked) => `${isSpecial(m.path) ? '!' : ''}${m.priority ?? 0}`
/** `a` loads above `b` in an order the app sets: the same ! state, both numbered, more nines (xtra_conflicts.rs ordered). */
export const outranks = (a: Ranked, b: Ranked) =>
  isSpecial(a.path) === isSpecial(b.path) && (b.priority ?? 0) > 0 && (a.priority ?? 0) > (b.priority ?? 0)

const TIP = 'Higher numbers load on top. Special (!) adds a ! prefix for mods that need it.'

/** `onChange(priority, special)`: special is undefined when only the number changes (set_mod_priority keeps the !). */
export function PriorityControl({ path, priority = 0, disabled, onChange }: {
  path: string; priority?: number; disabled?: boolean; onChange: (priority: number, special?: boolean) => void
}) {
  const special = isSpecial(path)
  return (
    <span className="prio" role="group" aria-label={`${special ? 'Special (!), ' : ''}${priority ? `priority ${priority}` : 'Unranked'}`} title={TIP}>
      <NumberInput value={priority} min={0} max={Math.max(7, priority)} placeholder="–" disabled={disabled} onChange={v => onChange(v)} />
      <button type="button" className={`prio-special${special ? ' is-on' : ''}`} aria-pressed={special} aria-label="Special (!)" disabled={disabled}
        title={special ? 'Special (!) is on: the name starts with a !. Click to take it off' : 'Special (!): add a ! before the name, for mods that need it'}
        onClick={e => { e.stopPropagation(); onChange(priority, !special) }}>!</button>
    </span>
  )
}
