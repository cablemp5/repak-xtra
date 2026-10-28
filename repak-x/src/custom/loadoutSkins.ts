import characters from '../data/character_data.json'
import { canonKey, memberKey } from './loadoutIdentity'
const skinNames = new Map(characters.map(c => [c.skinid, `${c.name} - ${c.skin_name}`.toLowerCase()]))
const skinIds = new Map<string, string | null>()
for (const [id, name] of skinNames) skinIds.set(name, skinIds.has(name) && skinIds.get(name) !== id ? null : id)
export const skinLabel = (id: string) => skinNames.get(id) ?? id.replace(/^name:/, '')

export type SkinDetails = { character_name?: string | null; skin_name?: string | null; files?: string[]; category?: string | null; additional_categories?: string[]; mod_type?: string }

/** A known skin label is a fallback for details without an asset listing, never a guess that a bare hero means Default. */
export function skinLook(d: SkinDetails) {
  const [hero, ...parts] = (d.character_name ?? '').split(' - ')
  const skin = d.skin_name?.trim() || parts.join(' - ').trim()
  return hero && skin && !hero.startsWith('Multiple') ? `${hero.trim()} - ${skin}`.toLowerCase() : null
}

/** Compare every exact skin directory, including material/VFX mods and multi-skin bundles. Filenames never identify a skin. */
export function skinLooks(d: SkinDetails) {
  const skins = new Set<string>()
  for (const file of d.files ?? []) {
    const match = file.replaceAll('\\', '/').match(/(?:^|\/)(?:characters|hero_st|hero)\/(\d{4})\/(\d{7})\//i)
    if (!match || !match[2].startsWith(match[1])) continue
    skins.add(match[2])
  }
  const label = skinLook(d)
  if (!skins.size && label) {
    const id = skinIds.get(label)
    if (id) skins.add(id)
    else if (id === undefined) skins.add(`name:${label}`)
  }
  return skins
}

export function looksOf(mods: { path: string; enabled?: boolean }[], details: Record<string, SkinDetails | undefined>, loadout: { on: string[] }) {
  const on = new Set(loadout.on.map(canonKey))
  const skins = new Set<string>()
  for (const mod of mods) {
    const d = details[mod.path]
    if (mod.enabled && on.has(memberKey(mod.path)) && d) for (const skin of skinLooks(d)) skins.add(skin)
  }
  return skins
}

if (import.meta.env.DEV) {
  const mesh = { character_name: 'Black Panther', files: ['Marvel/Content/Marvel/Characters/1026/1026300/Meshes/SK_panther.uasset'], category: 'Mesh' }
  const material = { character_name: 'Black Panther', files: ['../../../Marvel/Content/Marvel/characters/1026/1026300/Materials/MI_suit.uasset'], category: 'Material' }
  const other = { files: ['Marvel\\Characters\\1026\\1026001\\Textures\\T_suit.uasset'] }
  const overlap = (a: SkinDetails, b: SkinDetails) => [...skinLooks(a)].some(s => skinLooks(b).has(s))
  console.assert(overlap(mesh, material), 'same skin conflicts even with bare hero labels and material category')
  console.assert(!overlap(mesh, other), 'different skins of the same hero do not conflict')
  console.assert(overlap(other, { character_name: 'Black Panther - Default' }), 'explicit Default metadata agrees with real asset paths')
  console.assert(!skinLooks({ character_name: 'Black Panther', files: ['Marvel/Characters/1026/Shared/T_1026300.uasset'] }).size, 'shared paths and filenames never invent a skin')
  console.assert(skinLooks({ files: [...mesh.files, ...other.files] }).size === 2, 'a bundle keeps all targeted skins')
  console.assert(skinLook({ character_name: 'Black Panther' }) === null, 'bare hero names are not Default')
  const a = { path: 'C:/Game/~mods/A.bak_repak', enabled: true }, b = { path: 'C:/Game/~mods/B.pak', enabled: true }
  const details = { [a.path]: mesh, [b.path]: material }
  const first = { on: [memberKey(a.path)] }, second = { on: [memberKey(b.path)] }
  console.assert([...looksOf([a, b], details, first)].some(s => looksOf([a, b], details, second).has(s)), 'real loadout membership and renamed disabled paths retain the same-skin warning')
  console.assert(!looksOf([{ ...a, enabled: false }, b], details, first).size, 'failed or disabled mods do not claim an active conflict')
}
