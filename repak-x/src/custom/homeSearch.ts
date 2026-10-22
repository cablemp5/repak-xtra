// repakxtra: Search on Home. A loadout matches when its name or its collection holds the typed text, in any case.
// LoadoutsScreen filters with it before grouping, so collections and hero groups keep their order and folding.
import { OTHER, OTHER_LABEL, groupKey } from './loadoutStore'

/** Pure: whether this loadout shows for `query` (blank shows every one). A loadout in no collection matches Unsorted. */
export function matchesLoadout(l: { name: string; label: string }, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const collection = !groupKey(l.label) || groupKey(l.label) === groupKey(OTHER) ? OTHER_LABEL : l.label
  return l.name.toLowerCase().includes(q) || collection.toLowerCase().includes(q)
}

if (import.meta.env.DEV) {
  const l = { name: 'Galactic Claw', label: 'Black Panther' }
  console.assert(matchesLoadout(l, '  '), 'search: a blank query shows every loadout')
  console.assert(matchesLoadout(l, 'CLAW') && matchesLoadout(l, 'lac'), 'search: part of the name, any case')
  console.assert(matchesLoadout(l, 'panther'), 'search: the collection name matches too')
  console.assert(!matchesLoadout(l, 'hulk'), 'search: no match')
  console.assert(matchesLoadout({ name: 'Hats', label: OTHER }, 'unsorted'), 'search: a loadout in no collection matches Unsorted')
}
