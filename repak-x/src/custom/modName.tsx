// caleb fork: mod names that follow the release pattern (slug_type_outline_PG_vN, e.g.
// bp-inferno-king_mesh+matSwap_outline_noPG_v10) render as slug + muted tags + a version chip. When space runs out
// the tags shrink first and the version never does, so near-identical bp-* names stay tell-apart-able.
// Names without a trailing _vN render whole.

export function splitModName(name: string): { slug: string; tags: string[]; version?: string } {
  const parts = name.split('_')
  const last = parts[parts.length - 1]
  if (parts.length < 2 || !/^v\d+$/i.test(last)) return { slug: name, tags: [] }
  const [slug, ...tags] = parts.slice(0, -1)
  return { slug, tags, version: last }
}

if (import.meta.env.DEV) {
  const a = splitModName('bp-inferno-king_mesh+matSwap_outline_noPG_v10')
  console.assert(a.slug === 'bp-inferno-king' && a.tags.join() === 'mesh+matSwap,outline,noPG' && a.version === 'v10', 'splitModName pattern')
  console.assert(splitModName('ElectricBluePantherBPMESH_UPDATED').tags.length === 0, 'splitModName keeps non-pattern names whole')
  console.assert(splitModName('cosmic-panther_sfx_v6').version === 'v6', 'splitModName short pattern')
}

/** Short mono code per mod type, so the type reads without color (the color comes from the *-badge classes). */
const TYPE_CODES: Record<string, string> = {
  Mesh: 'MSH', 'Static Mesh': 'SMH', Animation: 'ANM', Material: 'MAT', Texture: 'TEX', Retexture: 'TEX', VFX: 'VFX',
  UI: 'UI', Audio: 'AUD', Blueprint: 'BP', Data: 'DAT', Movies: 'MOV', 'Project Galacta': 'PG',
}
export const typeCode = (category?: string | null) => (category && TYPE_CODES[category]) || '?'

/** "1 mod", "3 mods" */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function ModName({ name }: { name: string }) {
  const { slug, tags, version } = splitModName(name)
  if (!version) return <span className="mn"><span className="mn-slug">{name}</span></span>
  return (
    <span className="mn">
      <span className="mn-slug">{slug}</span>
      {tags.length > 0 && <span className="mn-tags">{tags.join(' · ')}</span>}
      <span className="mn-ver">{version}</span>
    </span>
  )
}
