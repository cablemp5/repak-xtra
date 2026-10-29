// repakxtra: the hero filter with portraits (a loadout's Add mods, the VFX Updater). Portraits are found by the hero's
// name in the live character data (get_character_data), so heroes newer than the bundled list (Daredevil, Devil
// Dinosaur) get theirs too, and a note in brackets ("Iron Fist (lin Lie)") never stops the match.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Users } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import bundled from '../data/character_data.json'
import { FALLBACK_HERO_ID, getHeroImageById, initHeroImages, useHeroImages } from '../utils/heroImages'

type Row = { id: string; name: string }
const norm = (name: string) => name.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase()
const idsOf = (rows: Row[]) => new Map(rows.filter(r => /^10\d\d$/.test(r.id)).map(r => [norm(r.name), r.id]))
let live: Map<string, string> | null = null
let pending: Promise<Map<string, string>> | null = null

/** The one hero a mod is for, from its character name ("Black Panther - Catboy" -> Black Panther), or '' for none or
 *  several. A note in brackets is not part of the name. */
export const heroOfName = (c?: string | null) => (c && !c.startsWith('Multiple') ? c.split(' - ')[0].replace(/\s*\(.*\)$/, '').trim() : '')

/** A hero's portrait by name (the placeholder when there is none); re-renders when the character data and portraits land. */
export function useHeroPortrait() {
  useHeroImages()
  const [ids, setIds] = useState(() => live ?? idsOf(bundled as Row[]))
  useEffect(() => {
    void initHeroImages() // once per window: the VFX Updater's own window has no portraits loaded otherwise
    if (live) return
    let on = true
    pending ??= invoke<Row[]>('get_character_data')
      .then(rows => (live = new Map([...idsOf(bundled as Row[]), ...idsOf(rows ?? [])])))
      .catch(() => { pending = null; return idsOf(bundled as Row[]) }) // tried again by the next one to ask
    void pending.then(m => { if (on) setIds(m) })
    return () => { on = false }
  }, [])
  return (name: string) => getHeroImageById(ids.get(norm(name))) ?? getHeroImageById(FALLBACK_HERO_ID)
}

/** Every playable hero's name, A to Z (the bundled list, plus heroes the live character data adds). */
export function useHeroNames() {
  const [rows, setRows] = useState(bundled as Row[])
  useEffect(() => { invoke<Row[]>('get_character_data').then(r => { if (r?.length) setRows([...(bundled as Row[]), ...r]) }, () => undefined) }, [])
  return [...new Set(rows.filter(r => /^10\d\d$/.test(r.id) && !r.name.includes('*')).map(r => heroOfName(r.name)))].sort()
}

/** All heroes, or one: shown when the list holds two or more heroes. */
/** always: shown even with fewer than two heroes (while a list loads, so the bar does not change when it lands) */
export function HeroFilter({ heroes, value, onChange, always }: { heroes: string[]; value: string; onChange: (hero: string) => void; always?: boolean }) {
  const portrait = useHeroPortrait()
  // a picked hero stays in the list while it still filters, even once its last mod is gone, so it can be cleared
  const list = value && !heroes.includes(value) ? [...heroes, value] : heroes
  if (list.length < 2 && !value && !always) return null
  return (
    <CustomDropdown className="lp-hero" options={[{ value: '', label: 'All heroes', glyph: <Users /> }, ...list.map(h => ({ value: h, label: h, image: portrait(h) }))]}
      value={value} onChange={onChange} placeholder="All heroes" />
  )
}

if (import.meta.env.DEV) {
  console.assert(heroOfName('Black Panther - Catboy') === 'Black Panther' && heroOfName('Iron Fist (lin Lie)') === 'Iron Fist', 'the hero, without the skin or a note')
  console.assert(heroOfName('Multiple Heroes (3)') === '' && heroOfName(null) === '', 'several heroes, or none: no hero')
  console.assert(norm('Iron Fist (lin Lie)') === norm('iron fist'), 'a portrait is found with or without the note')
}
