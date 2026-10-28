// repakxtra: Smart loadouts' grouping (SmartLoadouts.tsx). Mods that share the words that name them become one loadout
// ("CatboyPantherMesh", "CatboyPantherIcons", "CatboyPantherKOPrompt" -> Catboy), and a mod with words of its own gets a
// loadout of its own. Words that only say what a file is (mesh, icons, vfx, v2, UPDATED) and the hero's own name are
// ignored, and two heroes never share a loadout. The user's rules bend this (Rules): a word to ignore or to group by,
// two looks merged, a look kept apart, heroes kept together, a mod moved by hand, a name. Every proposal says why it
// formed (Why), so the page can show it. Pure.
import { memberName } from './loadoutIdentity'

export type Candidate = { key: string; hero: string } // hero: '' when the mod names none (or several)

/** The user's saved changes to the grouping. Looks are named by their look key (lookKey). */
export type Rules = {
  ignore: string[]                     // words that never name a look
  keep: string[]                       // words that always do (a type word or a hero's own word that matters here)
  merge: { from: string; into: string }[] // one look's mods go into another
  split: string[]                      // looks never folded into a shorter look they start with
  together: string[]                   // word keys whose heroes share one loadout
  pins: Record<string, string>         // mod key -> the look key it was moved to by hand
  names: Record<string, string>        // look key -> the name given to it
}
export const NO_RULES: Rules = { ignore: [], keep: [], merge: [], split: [], together: [], pins: {}, names: {} }

/** What a word in a mod's name did: named its look, or was dropped (and why). */
export type WordKind = 'look' | 'type' | 'hero' | 'number' | 'ignored'
export type Word = { text: string; word: string; kind: WordKind }

/** How a loadout formed, for the page's Why. */
export type Why = {
  words: string[]       // the words its mods share (empty: a mod with no words of its own)
  hero: string
  together: boolean     // its heroes were kept together by a rule
  splitHeroes: boolean  // the same words also formed a loadout for another hero
  noHero: number        // mods naming no hero that joined it
  absorbed: { key: string; words: string[]; count: number; byRule: boolean }[] // looks folded into it
  pinned: string[]      // mod keys moved here by hand
}
export type Proposal = { id: string; name: string; named: boolean; hero: string; keys: string[]; why: Why }

/** Words that say what a file is or which version it is, not which look it belongs to. */
export const STOP = new Set([
  'mesh', 'meshes', 'icon', 'icons', 'text', 'texts', 'vfx', 'fx', 'ko', 'prompt', 'passive', 'trail', 'trails', 'skin', 'skins', 'mod', 'mods',
  'pack', 'v', 'ver', 'version', 'updated', 'update', 'broken', 'original', 'partial', 'no', 'pg', 'mat', 'swap', 'outline', 'texture', 'textures',
  'audio', 'sfx', 'sound', 'sounds', 'ui', 'hud', 'bp', 'the', 'and', 'of', 'for', 'p', 'colored', 'color', 'new', 'fix', 'fixed',
])
/** Upper-case runs (KO), capitalized words, lower-case words and numbers: "CatboyPantherKOPrompt" -> Catboy Panther KO Prompt. */
const PIECE = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g
/** Typed text as the words a rule can name, cut the way mod names are ("Cat Boy" and "CatBoy" -> cat boy). */
export const ruleWords = (text: string) => [...new Set((text.match(PIECE) ?? []).map(w => w.toLowerCase()))]

/** Every word in a mod's name and what it did. `hero`'s own words, type words and numbers drop out unless kept. */
export function explain(name: string, hero = '', rules: Rules = NO_RULES): Word[] {
  const own = new Set(hero.toLowerCase().split(/\W+/).filter(Boolean))
  return (name.match(PIECE) ?? []).map(text => {
    const word = text.toLowerCase()
    const kind: WordKind = rules.ignore.includes(word) ? 'ignored' : rules.keep.includes(word) ? 'look'
      : /^\d+$/.test(word) ? 'number' : STOP.has(word) ? 'type' : own.has(word) ? 'hero' : 'look'
    return { text, word, kind }
  })
}
/** A mod's name cut into runs, each marked when it is a word that names its look (the page highlights them in place).
 *  Every character of the name is kept. */
export function marks(name: string, hero = '', rules: Rules = NO_RULES): { text: string; look: boolean }[] {
  const kinds = explain(name, hero, rules)
  const out: { text: string; look: boolean }[] = []
  let at = 0, i = 0
  for (const m of name.matchAll(PIECE)) {
    if (m.index! > at) out.push({ text: name.slice(at, m.index), look: false })
    out.push({ text: m[0], look: kinds[i++]?.kind === 'look' })
    at = m.index! + m[0].length
  }
  if (at < name.length) out.push({ text: name.slice(at), look: false })
  return out
}

/** The words that name a mod's look, in order. */
export const words = (name: string, hero = '', rules: Rules = NO_RULES) => explain(name, hero, rules).filter(w => w.kind === 'look').map(w => w.word)

/** A look's key: its words and hero ("catboy@Black Panther"), or the mod's own for one with no words of its own. */
export const lookKey = (w: string[], hero: string) => `${w.join(' ')}@${hero}`
export const ownKey = (modKey: string) => `mod:${modKey}`

const title = (w: string[]) => w.map(x => x[0].toUpperCase() + x.slice(1)).join(' ')
const startsWith = (long: string[], short: string[]) => short.length < long.length && short.every((w, i) => long[i] === w)

type Bucket = { key: string; words: string[]; hero: string; keys: string[]; names: string[]; why: Why }
const bucket = (w: string[], hero: string, keys: string[], names: string[], key = lookKey(w, hero)): Bucket =>
  ({ key, words: w, hero, keys, names, why: { words: w, hero, together: false, splitHeroes: false, noHero: 0, absorbed: [], pinned: [] } })
const absorb = (into: Bucket, b: Bucket, byRule: boolean) => {
  into.keys.push(...b.keys)
  into.names.push(...b.names)
  into.why.absorbed.push({ key: b.key, words: b.words, count: b.keys.length, byRule }, ...b.why.absorbed)
  into.why.pinned.push(...b.why.pinned)
  into.why.noHero += b.why.noHero
  if (!into.why.together) into.hero ||= b.hero // a loadout kept across heroes never takes one hero from a look it takes in
}

/** The loadouts to propose for `mods` under `rules`, each with a name not in `taken` (names loadouts already use),
 *  sorted by hero then by size. */
export function propose(mods: Candidate[], taken: string[] = [], rules: Rules = NO_RULES): Proposal[] {
  const buckets: Bucket[] = []
  const byWords = new Map<string, { hero: string; key: string; name: string }[]>()
  const nameOf = new Map<string, string>()
  for (const m of mods) {
    const name = memberName(m.key)
    nameOf.set(m.key, name)
    const w = words(name, m.hero, rules)
    if (!w.length) { buckets.push(bucket([], m.hero, [m.key], [name], ownKey(m.key))); continue }
    byWords.set(w.join(' '), [...(byWords.get(w.join(' ')) ?? []), { hero: m.hero, key: m.key, name }])
  }
  // the same words: one loadout per hero (or one for all with Heroes together), and a mod with no hero joins the
  // biggest of them, else makes its own
  for (const [key, list] of byWords) {
    const w = key.split(' ')
    if (rules.together.includes(key)) {
      const heroes = [...new Set(list.map(x => x.hero).filter(Boolean))]
      const b = bucket(w, heroes.length === 1 ? heroes[0] : '', list.map(x => x.key), list.map(x => x.name), lookKey(w, '*'))
      b.why.together = true
      buckets.push(b)
      continue
    }
    const heroed = new Map<string, typeof list>()
    for (const m of list.filter(x => x.hero)) heroed.set(m.hero, [...(heroed.get(m.hero) ?? []), m])
    const homeless = list.filter(x => !x.hero)
    const biggest = [...heroed].sort((a, b) => b[1].length - a[1].length)[0]?.[0]
    for (const [hero, ms] of heroed) {
      const all = hero === biggest ? [...ms, ...homeless] : ms
      const b = bucket(w, hero, all.map(x => x.key), all.map(x => x.name))
      b.why.splitHeroes = heroed.size > 1
      if (hero === biggest) b.why.noHero = homeless.length
      buckets.push(b)
    }
    if (!heroed.size) buckets.push(bucket(w, '', homeless.map(x => x.key), homeless.map(x => x.name)))
  }
  // "rainbow flow" and "rainbow lines" fold into "rainbow" when it is a loadout of the same hero (or of no hero yet),
  // unless kept apart
  buckets.sort((a, b) => a.words.length - b.words.length)
  let kept: Bucket[] = []
  for (const b of buckets) {
    // a look the user merged somewhere goes there, not into the look its words start with
    const into = b.words.length && !rules.split.includes(b.key) && !rules.merge.some(m => m.from === b.key)
      ? kept.find(k => k.words.length && startsWith(b.words, k.words) && (!k.hero || !b.hero || k.hero === b.hero || k.why.together))
      : undefined
    if (into) absorb(into, b, false)
    else kept.push(b)
  }
  // moves by hand, then merges the user asked for: a mod moved to a loadout of its own makes that loadout first, so it can
  // be merged like any other (and a moved mod goes along with the loadout it was moved to)
  const find = (key: string) => kept.find(k => k.key === key || k.why.absorbed.some(a => a.key === key))
  for (const [mod, to] of Object.entries(rules.pins)) {
    const at = kept.find(k => k.keys.includes(mod))
    if (!at || at.key === to) continue
    const target = to === ownKey(mod) ? undefined : find(to)
    if (!target && to !== ownKey(mod)) continue // the look it went to is gone: the mod stays where its words put it
    const i = at.keys.indexOf(mod)
    at.keys.splice(i, 1)
    at.names.splice(i, 1)
    const dest = target ?? kept[kept.push(bucket([], at.hero, [], [], ownKey(mod))) - 1]
    dest.keys.push(mod)
    dest.names.push(nameOf.get(mod) ?? mod)
    dest.why.pinned.push(mod)
  }
  for (const { from, into } of rules.merge) {
    const a = kept.find(k => k.key === from), b = find(into)
    if (!a || !b || a === b) continue
    absorb(b, a, true)
    kept = kept.filter(k => k !== a)
  }
  kept = kept.filter(k => k.keys.length)

  // heroes kept together across several heroes: no one hero (its portrait and collection would name the first one found)
  const heroOf = (b: Bucket) => b.why.together ? b.hero : b.hero || mods.find(m => b.keys.includes(m.key) && m.hero)?.hero || ''
  const used = new Set(taken.map(n => n.trim().toLowerCase()))
  const unique = (name: string) => {
    let n = name, i = 2
    while (used.has(n.toLowerCase())) n = `${name} ${i++}`
    used.add(n.toLowerCase())
    return n
  }
  return kept
    .map(b => ({ b, hero: heroOf(b) }))
    .sort((x, y) => (x.hero ? 0 : 1) - (y.hero ? 0 : 1) || x.hero.localeCompare(y.hero) || y.b.keys.length - x.b.keys.length || x.b.names[0].localeCompare(y.b.names[0]))
    .map(({ b, hero }) => {
      const given = rules.names[b.key]?.trim()
      return { id: b.key, name: unique(given || (b.words.length ? title(b.words) : b.names[0])), named: Boolean(given), hero, keys: b.keys, why: { ...b.why, hero } }
    })
}

/** Rules saved under the look keys `moves` picks, saved under `to` instead (a loadout's key changed, as Join other
 *  heroes does): its name (`prefer`'s first), merges, a kept-apart look, and mods moved to it. Pure. */
export function rekey(rules: Rules, moves: (key: string) => boolean, to: string, prefer?: string): Rules {
  const m = (k: string) => (moves(k) ? to : k)
  const named = Object.keys(rules.names).filter(moves)
  const name = rules.names[to] ?? rules.names[prefer && moves(prefer) ? prefer : named[0]]
  const names = Object.fromEntries(Object.entries(rules.names).filter(([k]) => !moves(k)))
  if (name !== undefined && named.length) names[to] = name
  const merge = [...new Map(rules.merge.map(x => ({ from: m(x.from), into: m(x.into) })).filter(x => x.from !== x.into).map(x => [x.from, x])).values()]
  return { ...rules, names, merge, split: [...new Set(rules.split.map(m))], pins: Object.fromEntries(Object.entries(rules.pins).map(([k, v]) => [k, m(v)])) }
}

/** Rules read from storage: anything unreadable is no rule. Pure. */
export function readRules(json: string | null): Rules {
  try {
    const v = JSON.parse(json ?? 'null') ?? {}
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
    const map = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).filter((e): e is [string, string] => typeof e[1] === 'string')) : {})
    return {
      ignore: strs(v.ignore), keep: strs(v.keep), split: strs(v.split), together: strs(v.together), pins: map(v.pins), names: map(v.names),
      merge: Array.isArray(v.merge) ? v.merge.filter((m: { from?: unknown; into?: unknown }) => typeof m?.from === 'string' && typeof m?.into === 'string') : [],
    }
  } catch { return NO_RULES }
}

/** Unticked loadouts after a regroup: a new loadout made only of an unticked one's mods stays unticked (a rule renamed it,
 *  split it, or kept one of its looks apart, whether or not the unticked one is still there). One merged into a loadout
 *  that was already shown follows that one. Returns the same set when nothing changed. Pure. */
export function carryOff(off: Set<string>, was: { id: string; keys: string[] }[], now: { id: string; keys: string[] }[]): Set<string> {
  const ids = new Set(now.map(x => x.id)), shown = new Set(was.map(x => x.id))
  const next = new Set([...off].filter(id => ids.has(id)))
  for (const id of off) {
    const old = was.find(x => x.id === id)
    if (!old) continue
    for (const x of now) if (!shown.has(x.id) && x.keys.length && x.keys.every(k => old.keys.includes(k))) next.add(x.id)
  }
  return next.size === off.size && [...next].every(id => off.has(id)) ? off : next
}

if (import.meta.env.DEV) {
  const BP = 'Black Panther'
  {
    const was = [{ id: 'shiny catboy@BP', keys: ['a', 'b'] }, { id: 'green@BP', keys: ['c'] }]
    const now = [{ id: 'catboy@BP', keys: ['a', 'b'] }, { id: 'green@BP', keys: ['c'] }]
    console.assert([...carryOff(new Set(['shiny catboy@BP']), was, now)].join() === 'catboy@BP', 'a renamed loadout stays unticked')
    const off = new Set(['green@BP'])
    console.assert(carryOff(off, was, now) === off, 'nothing regrouped, same set')
    const merged = [{ id: 'green@BP', keys: ['a', 'b', 'c'] }]
    console.assert(carryOff(new Set(['shiny catboy@BP']), was, merged).size === 0, 'merged into a ticked loadout, it follows that one')
    const apart = [{ id: 'rainbow@BP', keys: ['a'] }, { id: 'rainbow flow@BP', keys: ['b'] }, { id: 'green@BP', keys: ['c'] }]
    const rb = [{ id: 'rainbow@BP', keys: ['a', 'b'] }, { id: 'green@BP', keys: ['c'] }]
    console.assert([...carryOff(new Set(['rainbow@BP']), rb, apart)].sort().join() === 'rainbow flow@BP,rainbow@BP', 'a look kept apart from an unticked loadout stays unticked')
  }
  const m = (name: string, hero = BP): Candidate => ({ key: `${name}_9999999_P`, hero })
  const names = (p: Proposal[]) => p.map(x => `${x.name}:${x.keys.length}`).join()
  const r = (more: Partial<Rules>): Rules => ({ ...NO_RULES, ...more })
  console.assert(words('CatboyPantherKOPrompt', BP).join() === 'catboy', 'type words and the hero are dropped')
  console.assert(explain('CatboyPantherKOPrompt', BP).map(w => w.kind).join() === 'look,hero,type,type', 'each word says what it did')
  console.assert(words('bp-skin800-rainbow-flow_matSwap_outline_noPG_v6').join() === 'rainbow,flow', 'file words, numbers and versions are dropped')
  console.assert(names(propose([m('CatboyPantherMesh'), m('CatboyPantherIcons'), m('CatboyPantherKOPrompt')])) === 'Catboy:3', 'one look, one loadout')
  console.assert(names(propose([m('ElectricBlueMesh'), m('ElectricBlueIcons'), m('ElectricOrangeMesh')])) === 'Electric Blue:2,Electric Orange:1', 'different words stay apart')
  console.assert(names(propose([m('GreenPanther')])) === 'Green:1', 'a lone mod gets its own loadout')
  const rainbow = [m('bp-rainbow-vfx'), m('bp-rainbow-flow'), m('bp-rainbow-lines')]
  const folded = propose(rainbow)
  console.assert(names(folded) === 'Rainbow:3' && folded[0].why.absorbed.length === 2, 'extra words join the loadout their words begin, and it says so')
  console.assert(names(propose(rainbow, [], r({ split: [lookKey(['rainbow', 'flow'], BP)] }))) === 'Rainbow:2,Rainbow Flow:1', 'a look kept apart stays apart')
  console.assert(names(propose([m('CatboyMesh'), m('CatboyIcons', '')])) === 'Catboy:2', 'a mod with no hero joins its look')
  const two = propose([m('CatboyMesh', 'Hulk'), m('CatboyMesh', BP)])
  console.assert(two.length === 2 && two[0].name !== two[1].name && two[0].why.splitHeroes, 'two heroes never share a loadout, and it says so')
  console.assert(names(propose([m('CatboyMesh', 'Hulk'), m('CatboyMesh', BP)], [], r({ together: ['catboy'] }))) === 'Catboy:2', 'heroes kept together')
  const joined = propose([m('CatboyMesh', 'Hulk'), m('CatboyIcons', BP)], [], r({ together: ['catboy'] }))
  console.assert(joined.length === 1 && joined[0].hero === '', 'heroes kept together name no one hero', joined)
  const joinedFold = propose([m('CatboyMesh', 'Hulk'), m('CatboyIcons', BP), m('CatboyGlowRed', 'Hulk')], [], r({ together: ['catboy'] }))
  console.assert(joinedFold.length === 1 && joinedFold[0].hero === '' && joinedFold[0].keys.length === 3, 'a look folded into it does not give it a hero', joinedFold)
  const rainbowFlow = lookKey(['rainbow', 'flow'], BP), greenKey = lookKey(['green'], BP)
  const sent = propose([...rainbow, m('GreenMesh')], [], r({ merge: [{ from: rainbowFlow, into: greenKey }] }))
  console.assert(names(sent) === 'Rainbow:2,Green:2', 'a look merged elsewhere goes there, not into the look its words start with', names(sent))
  console.assert(propose([m('BlackPantherMesh')])[0].name === 'BlackPantherMesh', 'no words of its own: the file name')
  console.assert(propose([m('Catboy')], ['catboy'])[0].name === 'Catboy 2', 'a name a loadout already has is not reused')
  console.assert(names(propose([m('ShinyCatboy'), m('Catboy')], [], r({ ignore: ['shiny'] }))) === 'Catboy:2', 'an ignored word stops naming a look')
  console.assert(names(propose([m('CatboyMesh'), m('CatboyKO')], [], r({ keep: ['ko'] }))) === 'Catboy:2' && propose([m('CatboyKO')], [], r({ keep: ['ko'] }))[0].name === 'Catboy Ko', 'a kept word names the look')
  const cat = lookKey(['catboy'], BP), green = lookKey(['green'], BP)
  console.assert(names(propose([m('CatboyMesh'), m('GreenMesh')], [], r({ merge: [{ from: green, into: cat }] }))) === 'Catboy:2', 'two looks merged')
  const moved = propose([m('CatboyMesh'), m('CatboyIcons'), m('GreenMesh')], [], r({ pins: { CatboyIcons_9999999_P: green } }))
  console.assert(names(moved) === 'Green:2,Catboy:1' && moved.find(p => p.name === 'Green')?.why.pinned.length === 1, 'a mod moved by hand stays moved')
  console.assert(names(propose([m('CatboyMesh'), m('CatboyIcons')], [], r({ pins: { CatboyIcons_9999999_P: ownKey('CatboyIcons_9999999_P') } }))) === 'CatboyIcons:1,Catboy:1', 'a mod moved to a loadout of its own')
  console.assert(names(propose([m('CatboyMesh')], [], r({ pins: { CatboyMesh_9999999_P: 'gone@x' } }))) === 'Catboy:1', 'a move to a look that is gone is dropped')
  {
    const own = ownKey('CatboyIcons_9999999_P'), greenKey = lookKey(['green'], BP)
    const both = propose([m('CatboyMesh'), m('CatboyIcons'), m('GreenMesh')], [], r({ pins: { CatboyIcons_9999999_P: own }, merge: [{ from: own, into: greenKey }] }))
    console.assert(names(both) === 'Green:2,Catboy:1', 'a loadout of its own can be merged', names(both))
  }
  console.assert(propose([m('CatboyMesh')], [], r({ names: { [cat]: 'Kitty' } }))[0].name === 'Kitty', 'a name given is kept')
  console.assert(readRules('{"ignore":["a",1],"pins":{"x":"y","z":2},"merge":[{"from":"a"},{"from":"a","into":"b"}]}').ignore.join() === 'a', 'stored rules are checked')
  console.assert(readRules('garbage').ignore.length === 0, 'unreadable rules are none')
  console.assert(ruleWords('Cat Boy').join() === 'cat,boy' && ruleWords('CatBoy').join() === 'cat,boy' && ruleWords('!!').length === 0, 'a typed rule is cut as names are')
  {
    const hulk = lookKey(['catboy'], 'Hulk'), all = lookKey(['catboy'], '*')
    const moved = rekey(r({ names: { [cat]: 'Kitty', [hulk]: 'Big' }, merge: [{ from: hulk, into: green }], split: [cat], pins: { x: hulk } }),
      k => k.startsWith('catboy@') && k !== all, all, cat)
    console.assert(moved.names[all] === 'Kitty' && !moved.names[cat] && !moved.names[hulk] && moved.merge[0].from === all && moved.split.join() === all && moved.pins.x === all,
      'rekey carries names, merges, splits, and moves to the new key', moved)
    console.assert(rekey(r({ merge: [{ from: hulk, into: cat }] }), k => k === hulk || k === cat, all).merge.length === 0, 'rekey drops a merge into itself')
  }
  const cut = marks('bp-symbiote_matSwap_v3')
  console.assert(cut.map(x => x.text).join('') === 'bp-symbiote_matSwap_v3' && cut.filter(x => x.look).map(x => x.text).join() === 'symbiote', 'a name keeps every character, its look words marked', cut)
}
