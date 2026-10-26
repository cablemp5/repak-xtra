// repakxtra: how close a mod is to a crash (xtra_crash.rs xtra_crash_tiers): it holds the crashed asset, changes the same
// hero's same skin, or the same hero. The pure rules the Crash suspects dialog and the setup report share.

export type Tier = 'asset' | 'skin' | 'hero'
/** `hero`: the hero the crash points at, as the backend resolved it (the asset's folders first, then the crash's id) */
export type Tiered = { path: string; tier: Tier; other_skin?: boolean; hero?: string }

const RANK: Record<Tier, number> = { asset: 0, skin: 1, hero: 2 }
/** Closest first: asset, then skin, then hero, keeping the given order within a tier. */
export const ordered = <T extends { tier: Tier }>(rows: T[]): T[] => [...rows].sort((a, b) => RANK[a.tier] - RANK[b.tier])

/** The heading over a group of suspects (one per tier, closest first). `hero` is the hero's name when known,
 *  `otherSkin` when the crash names a skin. Pure. */
export function reasonFor(tier: Tier, hero?: string, otherSkin = false): string {
  if (tier === 'asset') return 'Hold the asset that crashed'
  if (tier === 'skin') return hero ? `Change the same ${hero} skin` : 'Change the same skin'
  return `Change ${hero ?? 'the same hero'}${otherSkin ? ', another skin' : ''}`
}

/** Suspects in groups of one heading each, in the order given (closest first). Pure. */
export function grouped<T extends { reason: string }>(rows: T[]): { title: string; rows: T[] }[] {
  const out: { title: string; rows: T[] }[] = []
  for (const r of rows) {
    const g = out.find(x => x.title === r.reason)
    if (g) g.rows.push(r); else out.push({ title: r.reason, rows: [r] })
  }
  return out
}

/** Rows checked when the dialog opens: the closest tier that matched. A mod holding the crashed asset is the proven
 *  cause, so then only those (a default skin's folder is shared by many emote and swap mods: on a real crash the skin
 *  tier held 9 of 23 mods that were on). Else the skin rows, else the hero rows. */
export function prechecked<T extends { tier: Tier }>(rows: T[]): T[] {
  for (const tier of ['asset', 'skin', 'hero'] as Tier[]) {
    const these = rows.filter(r => r.tier === tier)
    if (these.length) return these
  }
  return []
}

/** The setup report's lines for the newest crash. `tiers` undefined: the check failed. */
export function tierLines(tiers: Tiered[] | undefined, name: (path: string) => string): string[] {
  if (!tiers) return ['mods holding that asset: could not check']
  const of = (t: Tier) => tiers.filter(x => x.tier === t).map(x => name(x.path))
  const asset = of('asset')
  return [
    asset.length ? `mods holding that asset: ${asset.join(', ')}` : 'no mod that is on holds that asset',
    ...(of('skin').length ? [`mods for that skin: ${of('skin').join(', ')}`] : []),
    ...(of('hero').length ? [`mods for that hero: ${of('hero').join(', ')}`] : []),
  ]
}

if (import.meta.env.DEV) {
  console.assert(reasonFor('asset', 'Black Panther') === 'Hold the asset that crashed', 'asset heading')
  console.assert(reasonFor('skin', 'Black Panther') === 'Change the same Black Panther skin', 'skin heading')
  console.assert(reasonFor('hero', 'Black Panther', true) === 'Change Black Panther, another skin', 'hero heading')
  console.assert(reasonFor('hero', 'Black Panther') === 'Change Black Panther', 'hero heading when the crash names no skin')
  console.assert(reasonFor('hero', undefined, true) === 'Change the same hero, another skin', 'hero heading without a name')
  const g = grouped([{ reason: 'A', n: 1 }, { reason: 'A', n: 2 }, { reason: 'B', n: 3 }])
  console.assert(g.map(x => `${x.title}:${x.rows.map(r => r.n).join('')}`).join() === 'A:12,B:3', 'groups keep the order', g)
  const mixed: Tiered[] = [{ path: 'h1', tier: 'hero' }, { path: 's', tier: 'skin' }, { path: 'a', tier: 'asset' }, { path: 'h2', tier: 'hero' }]
  console.assert(ordered(mixed).map(r => r.path).join() === 'a,s,h1,h2', 'asset, then skin, then hero, same order within a tier', ordered(mixed))
  const rows: Tiered[] = [{ path: 'a', tier: 'asset' }, { path: 's', tier: 'skin' }, { path: 'h', tier: 'hero' }]
  console.assert(prechecked(rows).map(r => r.path).join() === 'a', 'an asset row: only asset rows are checked')
  console.assert(prechecked(rows.filter(r => r.tier !== 'asset')).map(r => r.path).join() === 's', 'no asset row: the skin rows')
  console.assert(prechecked(rows.filter(r => r.tier === 'hero')).map(r => r.path).join() === 'h', 'hero rows alone: checked')
  console.assert(prechecked([]).length === 0, 'nothing to check')
  console.assert(tierLines(rows, p => p.toUpperCase()).join('|') === 'mods holding that asset: A|mods for that skin: S|mods for that hero: H', 'all three report lines', tierLines(rows, p => p))
  console.assert(tierLines([{ path: 'h', tier: 'hero' }], p => p).join('|') === 'no mod that is on holds that asset|mods for that hero: h', 'no asset, no skin line')
  console.assert(tierLines(undefined, p => p)[0] === 'mods holding that asset: could not check', 'a failed check says so')
}
