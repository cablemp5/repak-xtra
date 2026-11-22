// repakxtra: Search on Home. A loadout matches when its name or (Search inside loadouts, Settings > Interface > Search)
// one of its mods matches the search, as one name each: words split across a loadout's name and a mod's never match
// together. The matcher is the Library's (smartSearch.ts). LoadoutsScreen filters with it before
// grouping, so collections and hero groups keep their order and folding.
import { directMatch } from './smartSearch'

/** The names a loadout is searched by: its own, and with Search inside loadouts (`inside`) each of its mods'. Pure. */
export function loadoutNames(l: { name: string }, modNames: string[] = [], inside = true) {
  return inside ? [l.name, ...modNames] : [l.name]
}

/** Pure: whether this loadout shows for `query` (blank shows every one). */
export function matchesLoadout(l: { name: string }, query: string, opts: { exact?: boolean; modNames?: string[]; inside?: boolean } = {}) {
  if (!query.trim()) return true
  return loadoutNames(l, opts.modNames, opts.inside ?? true).some(n => directMatch(n, query, opts.exact))
}

if (import.meta.env.DEV) {
  const l = { name: 'Galactic Claw', label: 'Black Panther' }
  console.assert(matchesLoadout(l, '  '), 'search: a blank query shows every loadout')
  console.assert(matchesLoadout(l, 'CLAW') && matchesLoadout(l, 'lac'), 'search: part of the name, any case')
  console.assert(!matchesLoadout(l, 'panther'), 'search: its collection is not one of its names')
  console.assert(!matchesLoadout(l, 'hulk'), 'search: no match')
  const mods = ['Black Panther \u2014 Purple VFX', 'Hulk Hat']
  console.assert(matchesLoadout(l, 'purple panther', { modNames: mods }) && !matchesLoadout(l, 'purple panther', { inside: false }), 'search inside: one of its mods matches, off: only its own name')
  console.assert(!matchesLoadout(l, 'hulk', { inside: false, modNames: mods }) && matchesLoadout(l, 'claw', { inside: false }), 'off: its own name only')
  console.assert(!matchesLoadout(l, 'claw hulk', { modNames: mods }), 'words split across the loadout and a mod never match together')
  console.assert(matchesLoadout(l, 'purple vfx', { exact: true, modNames: mods }) && !matchesLoadout(l, 'vfx purple', { exact: true, modNames: mods }), 'exact match inside loadouts too')
}
