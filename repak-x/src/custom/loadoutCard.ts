// repakxtra: what a loadout's shareable card says (drawn by loadoutCardDraw.ts): its name, collection, how many mods of
// each kind it holds, up to 8 mod names and the date. Pure, so it can be checked: a mod's name is its file name only, so
// no folder, user name or game path ever reaches the picture.
import { nameKey } from './loadoutIdentity'

export type CardKind = 'character' | 'VFX' | 'UI' | 'sound' | 'animation' | 'other'
/** The kinds in the card's order, each with the mod type whose badge color it takes (loadoutBits.tsx typeClass). */
export const CARD_KINDS: [CardKind, string][] = [['character', 'Mesh'], ['VFX', 'VFX'], ['UI', 'UI'], ['sound', 'Audio'], ['animation', 'Animation'], ['other', 'Unknown']]
const KIND_OF: Record<string, CardKind> = { Mesh: 'character', 'Static Mesh': 'character', Texture: 'character', Retexture: 'character', Material: 'character', VFX: 'VFX', UI: 'UI', Text: 'UI', Audio: 'sound', Animation: 'animation' }

export const MAX_NAMES = 8
const MAX_CHARS = 48

export type CardMod = { key: string; category?: string | null }  // key: a loadout member key or a mod path
export type CardModel = {
  name: string
  label: string
  date: string
  total: number
  counts: { kind: CardKind; type: string; n: number }[]
  names: string[]   // empty when names are hidden
  more: number      // how many mods the list leaves out
}

const clip = (s: string) => { const c = [...s.trim()]; return c.length > MAX_CHARS ? `${c.slice(0, MAX_CHARS - 1).join('').trimEnd()}…` : c.join('') }
/** Only the file's own name: nameKey drops the folder, extension and priority suffix, the split catches anything left. */
const modName = (key: string) => (nameKey(key).split(/[\\/]/).pop() || '').replace(/^!+/, '')

export function cardModel(l: { name: string; label: string }, mods: CardMod[], options: { showNames: boolean }, now: Date): CardModel {
  const counts = CARD_KINDS.map(([kind, type]) => ({ kind, type, n: mods.filter(m => (KIND_OF[m.category ?? ''] ?? 'other') === kind).length })).filter(c => c.n)
  const all = [...new Set(mods.map(m => modName(m.key)).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const names = options.showNames ? all.slice(0, MAX_NAMES).map(clip) : []
  return {
    name: clip(l.name) || 'Loadout',
    label: clip(l.label),
    date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
    total: mods.length,
    counts,
    names,
    more: options.showNames ? Math.max(0, all.length - names.length) : 0,
  }
}

/** "3 character", "1 VFX": a count line of the card. */
export const countText = (c: { kind: CardKind; n: number }) => `${c.n} ${c.kind}`

if (import.meta.env.DEV) {
  const now = new Date(2026, 9, 28, 23, 59)
  const lo = { name: 'Cat girls', label: 'Ranked' }
  const empty = cardModel(lo, [], { showNames: true }, now)
  console.assert(empty.total === 0 && empty.counts.length === 0 && empty.names.length === 0 && empty.more === 0, 'card: empty loadout', empty)
  console.assert(!/\d:\d/.test(empty.date) && empty.date.includes('2026'), 'card: a date without the time', empty.date)
  const three = cardModel(lo, [{ key: 'skins|Psylocke Cat', category: 'Mesh' }, { key: 'C:\\Users\\cable\\Games\\Marvel Rivals\\~mods\\Claw Swipe_9999999_P.pak', category: 'VFX' }, { key: '|Big Hud', category: 'UI' }], { showNames: true }, now)
  console.assert(three.names.join() === 'Big Hud,Claw Swipe,Psylocke Cat' && three.counts.map(countText).join() === '1 character,1 VFX,1 UI', 'card: 3 mods', three)
  const text = JSON.stringify(three)
  console.assert(!/cable|Users|Games|~mods|skins|[\\/]|:\\/.test(text), 'card: no folders, user name or game path', text)
  const forty = cardModel(lo, Array.from({ length: 40 }, (_, i) => ({ key: `|Mod ${String(i).padStart(2, '0')}`, category: i % 2 ? 'Audio' : 'Texture' })), { showNames: true }, now)
  console.assert(forty.names.length === MAX_NAMES && forty.more === 32 && forty.counts.map(countText).join() === '20 character,20 sound', 'card: 40 mods', forty)
  const hidden = cardModel(lo, Array.from({ length: 40 }, (_, i) => ({ key: `|Mod ${i}` })), { showNames: false }, now)
  console.assert(hidden.names.length === 0 && hidden.more === 0 && hidden.counts[0]?.kind === 'other', 'card: names hidden', hidden)
  const long = cardModel({ name: 'N'.repeat(200), label: '' }, [{ key: `|${'Very long mod name '.repeat(10)}` }], { showNames: true }, now)
  console.assert([...long.name].length === MAX_CHARS && long.name.endsWith('…') && [...long.names[0]].length <= MAX_CHARS, 'card: long names are clipped', long)
  const odd = cardModel({ name: 'Wakanda "forever" 🐾', label: "cable's picks" }, [{ key: '|Black Panther 🐾 "Galactic"' }], { showNames: true }, now)
  console.assert(odd.name === 'Wakanda "forever" 🐾' && odd.names[0] === 'Black Panther 🐾 "Galactic"', 'card: emoji and quotes stay as typed', odd)
  const emoji = cardModel({ name: '🐾'.repeat(60), label: '' }, [], { showNames: true }, now)
  console.assert(!emoji.name.includes('\uFFFD') && [...emoji.name].length === MAX_CHARS, 'card: clipping never splits an emoji', emoji)
}
