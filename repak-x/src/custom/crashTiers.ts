// repakxtra: how close a mod is to a crash (xtra_crash.rs xtra_crash_tiers): it holds the crashed asset, changes the same
// hero's same skin, or the same hero. The pure rules the Crash suspects dialog and the setup report share.

export type Tier = 'asset' | 'skin' | 'hero'
/** `hero`: the hero the crash points at, as the backend resolved it (the asset's folders first, then the crash's id) */
export type Tiered = { path: string; tier: Tier; other_skin?: boolean; hero?: string }

const RANK: Record<Tier, number> = { asset: 0, skin: 1, hero: 2 }
/** Closest first: asset, then skin, then hero, keeping the given order within a tier. */
export const ordered = <T extends { tier: Tier }>(rows: T[]): T[] => [...rows].sort((a, b) => RANK[a.tier] - RANK[b.tier])

/** The reason shown beside a suspect. `hero` is the hero's name when known, `otherSkin` when the crash names a skin. */
export function reasonFor(tier: Tier, hero?: string, otherSkin = false): string {
  if (tier === 'asset') return 'contains the asset that crashed'
  if (tier === 'skin') return hero ? `changes the same ${hero} skin` : 'changes the same skin'
  return `changes ${hero ?? 'the same hero'}${otherSkin ? ', another skin' : ''}`
}

/** Rows checked when the dialog opens: asset and skin rows, or the hero rows when nothing closer matched. */
export function prechecked<T extends { tier: Tier }>(rows: T[]): T[] {
  const close = rows.filter(r => r.tier !== 'hero')
  return close.length ? close : rows
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
  console.assert(reasonFor('asset', 'Black Panther') === 'contains the asset that crashed', 'asset reason')
  console.assert(reasonFor('skin', 'Black Panther') === 'changes the same Black Panther skin', 'skin reason')
  console.assert(reasonFor('hero', 'Black Panther', true) === 'changes Black Panther, another skin', 'hero reason')
  console.assert(reasonFor('hero', 'Black Panther') === 'changes Black Panther', 'hero reason when the crash names no skin')
  console.assert(reasonFor('hero', undefined, true) === 'changes the same hero, another skin', 'hero reason without a name')
  const mixed: Tiered[] = [{ path: 'h1', tier: 'hero' }, { path: 's', tier: 'skin' }, { path: 'a', tier: 'asset' }, { path: 'h2', tier: 'hero' }]
  console.assert(ordered(mixed).map(r => r.path).join() === 'a,s,h1,h2', 'asset, then skin, then hero, same order within a tier', ordered(mixed))
  const rows: Tiered[] = [{ path: 'a', tier: 'asset' }, { path: 's', tier: 'skin' }, { path: 'h', tier: 'hero' }]
  console.assert(prechecked(rows).map(r => r.path).join() === 'a,s', 'asset and skin rows are checked, hero rows are not')
  console.assert(prechecked(rows.filter(r => r.tier === 'hero')).map(r => r.path).join() === 'h', 'hero rows alone: checked')
  console.assert(prechecked([]).length === 0, 'nothing to check')
  console.assert(tierLines(rows, p => p.toUpperCase()).join('|') === 'mods holding that asset: A|mods for that skin: S|mods for that hero: H', 'all three report lines', tierLines(rows, p => p))
  console.assert(tierLines([{ path: 'h', tier: 'hero' }], p => p).join('|') === 'no mod that is on holds that asset|mods for that hero: h', 'no asset, no skin line')
  console.assert(tierLines(undefined, p => p)[0] === 'mods holding that asset: could not check', 'a failed check says so')
}
