// repakxtra: a mod's load priority, one control in the Library, Conflicts, and the old clash list. The stepper is the
// nines of _9…_P (1 to 7, an install is 7), below 1 is Unranked, and Special (!) is its own switch above every number.
import NumberInput from '../components/ui/NumberInput'

/** A leading ! in the file name: Special, above every number. */
export const isSpecial = (path: string) => (path.split(/[\\/]/).pop() ?? '').startsWith('!')
/** One number to compare load order by: Special first, then the nines (0 is unranked). The nines never reach 1000. */
export const rankOf = (m: { path: string; priority?: number }) => (isSpecial(m.path) ? 1000 : 0) + (m.priority ?? 0)

const TIP = 'Priority 1 to 7: a higher number wins. Below 1 is Unranked, under every number. Special (!) is above them all.'

/** `onChange(priority, special)`: special is undefined when only the number changes (set_mod_priority keeps the !). */
export function PriorityControl({ path, priority = 0, disabled, onChange }: {
  path: string; priority?: number; disabled?: boolean; onChange: (priority: number, special?: boolean) => void
}) {
  const special = isSpecial(path)
  return (
    <span className="prio" role="group" aria-label={priority ? `Priority ${priority}` : 'Unranked'} title={TIP}>
      <NumberInput value={priority} min={0} max={Math.max(7, priority)} placeholder="–" disabled={disabled} onChange={v => onChange(v)} />
      <button type="button" className={`prio-special${special ? ' is-on' : ''}`} aria-pressed={special} aria-label="Special (!)" disabled={disabled}
        title={special ? 'Special (!) is on: it loads above every number. Click to turn it off' : 'Special (!): load above every number'}
        onClick={e => { e.stopPropagation(); onChange(priority, !special) }}>!</button>
    </span>
  )
}
