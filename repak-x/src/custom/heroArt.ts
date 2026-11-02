// repakxtra: a hero's logo and signature (the game's own art, white on clear) as faint backdrops on the Loadouts screen
// and a loadout's page (theme.css .has-hero). A loadout's hero is the one most of its mods are for.
import characters from '../data/character_data.json'
import type { Mod } from './loadoutStore'
import { displayName } from './loadoutStore'

const logos = import.meta.glob('./heroart/logo/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const signs = import.meta.glob('./heroart/sign/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const norm = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
const idOf = new Map(characters.map(c => [norm(c.name), c.id]))

/** The logo and signature variables for a hero's name, or undefined when the game has no art for it. Spread into `style`. */
export function heroArt(hero?: string): Record<string, string> | undefined {
  const id = hero ? idOf.get(norm(hero)) : undefined
  const logo = id && logos[`./heroart/logo/${id}.webp`]
  const sign = id && signs[`./heroart/sign/${id}.webp`]
  return logo ? { '--hero-logo': `url(${logo})`, ...(sign ? { '--hero-sign': `url(${sign})` } : null) } : undefined
}

/** The hero most of the given mods belong to, or undefined when none has a detected hero. */
export function topHero(keys: string[], byKey: Map<string, Mod>, details: Record<string, { character_name?: string | null } | undefined> | undefined) {
  const counts = new Map<string, number>()
  for (const key of keys) {
    const mod = byKey.get(displayName(key))
    let hero = mod && details?.[mod.path]?.character_name
    if (!hero) continue
    if (hero.startsWith('Multiple Heroes')) hero = 'Multiple heroes'
    hero = hero.split(' - ')[0] // the backend names skin-specific mods "Hero - Skin"; group by the hero
    counts.set(hero, (counts.get(hero) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}
