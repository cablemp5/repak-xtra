// repakxtra: the default shape of each hero (covers/silhouettes/<hero id>.webp), drawn where a picture is still coming:
// the install card's cover tile, and a loadout card while its preview renders.
import bundledHeroes from '../data/character_data.json'
import { modKey } from './loadoutStore'
import { canonKey } from './loadoutIdentity'

const SILHOUETTES = import.meta.glob<string>('./covers/silhouettes/*.webp', { eager: true, query: '?url', import: 'default' })
/** A hero's name as shown: the classifier says "Iron Fist (lin Lie)" (the game's own name in brackets) where the hero list says "Iron Fist" */
export const heroLabel = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()
// Names compare without a bracketed part or case
const norm = (name: string) => heroLabel(name).toLowerCase()
const idOf = new Map((bundledHeroes as { name: string; id: string }[]).map(h => [norm(h.name), h.id]))

/** The silhouette for a hero by name ("Black Panther", "Iron Fist (lin Lie)"), or undefined. */
export const silhouetteOf = (hero?: string | null) => {
  const id = hero ? idOf.get(norm(hero)) : undefined
  return id ? SILHOUETTES[`./covers/silhouettes/${id}.webp`] : undefined
}

/** A loadout's hero: the most common one among its mods ("Hero - Skin" counts as the hero), or undefined. The mod list's
 *  own character name stands in until the details load (a mod installed a moment ago has none yet). */
export function loadoutHero(on: string[], mods: { path: string; character_name?: string | null }[], details?: Record<string, { character_name?: string | null } | undefined>) {
  const want = new Set(on.map(canonKey))
  const counts = new Map<string, number>()
  for (const m of mods) {
    const name = want.has(modKey(m.path)) ? (details?.[m.path]?.character_name || m.character_name)?.split(' - ')[0] : undefined
    if (name && !name.startsWith('Multiple')) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}
