// repakxtra: the built-in mods (xtra_builtins.rs, custom/BuiltinMods.tsx) as rows of the Library's list, with a blue
// Built-in badge. Their switch turns the built-in on or off. They are not real library entries: never selected,
// renamed, deleted, given a priority or put in loadouts, so App.tsx and ModsList.tsx check isBuiltin before those.
import { useEffect, useMemo } from 'react'
import { type Builtin, builtinAbout, loadBuiltins, useBuiltins } from './BuiltinMods'
import { useUiPref } from './uiPrefs'

/** A built-in's file (its .pak under ~mods/.repakxtra-builtin), by path. */
export const isBuiltin = (path: string) => /[\\/]\.repakxtra-builtin[\\/]/i.test(path)

const listOf = (names: string[]) => names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`

/** What it is and, for Force default skin, the heroes it leaves alone: "Force default skin (Except Black Panther)". */
export function builtinName(b: Pick<Builtin, 'id' | 'excluded'>, heroName: (id: string) => string | undefined) {
  const base = builtinAbout(b.id)?.name ?? b.id
  if (b.id !== 'force-default-skin' || !b.excluded.length) return base
  return `${base} (Except ${listOf(b.excluded.map(id => heroName(id) ?? `hero ${id}`).sort())})`
}

/** The Library's rows for the built-ins, shaped like mod records. */
export function useBuiltinRows(heroName: (id: string) => string | undefined) {
  const { list } = useBuiltins()
  const shown = useUiPref('builtins') // Settings > Library > Hide built-in mods
  useEffect(() => { if (!list.length) void loadBuiltins() }, [list.length])
  return useMemo(() => !shown ? [] : list.map(b => ({
    path: b.path, custom_name: builtinName(b, heroName), enabled: b.on, file_size: b.size, priority: 0, builtin: b.id,
  })), [list, heroName, shown])
}

if (import.meta.env.DEV) {
  console.assert(isBuiltin('C:/G/Paks/~mods/.repakxtra-builtin/repakxtra-skip-intro-movies_9999999_P.pak') && !isBuiltin('C:/G/Paks/~mods/a.pak'), 'built-in paths')
  console.assert(listOf(['A', 'B', 'C', 'D']) === 'A, B and 2 more' && listOf(['A', 'B']) === 'A and B', 'excluded heroes in the name')
}
