// repakxtra: which installed mod a saved loadout member means. A member key (version 2) is "<folder>|<name>": the
// mod's folder inside the mods folder (lowercase, "/" between parts, "" for the mods folder itself) and its file name
// without the on/off extension, the _9999999_P priority suffix and the "!" priority-zero mark. So one mod keeps its key
// through on/off, priority 1 -> 0 -> 1 and restarts, and same-named mods in two folders stay two mods. "|" cannot be
// in a Windows file name, so a key without it is a legacy (version 1) bare name, which never matches a mod by itself:
// resolveKeys turns it into a member key when exactly one installed mod fits. Preview cache keys stay name-based
// (nameKey, mod_previews.py mod_key). Pure, apart from the mods folder set once by App.
const SEP = '|'
const PRIORITY = /(_\d+_P)+$/i

let root = '' // the mods folder, lowercase with "/"; empty until App knows it
/** App passes its game path (the mods folder) here, so keys are relative to it. */
export const setModsRoot = (path: string) => { root = (path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); keyCache.clear() }
/** File name without on/off extension and priority suffix ("!" kept): the preview cache key, and the name a mod shows.
 *  A member key gives its name. */
export const nameKey = (path: string) => path.includes(SEP)
  ? path.slice(path.lastIndexOf(SEP) + 1)
  : (path.split(/[/\\]/).pop() || path).replace(/(\.pak)?(\.bak_repak|\.pak_disabled)?$/i, '').replace(/_disabled$/i, '').replace(PRIORITY, '')

const bare = (name: string) => name.replace(PRIORITY, '').replace(/^!+/, '')

/** The folder inside the mods folder: from the known mods folder, else from the last "~mods" in the path; a mod outside
 *  it (the game's own Paks) keeps its whole folder. A bare file name is in the mods folder. */
const folderOf = (path: string) => {
  const dir = path.replace(/\\/g, '/').replace(/\/?[^/]*$/, '').toLowerCase()
  if (!dir || dir === root) return ''
  if (root && dir.startsWith(`${root}/`)) return dir.slice(root.length + 1)
  const i = dir.lastIndexOf('/~mods')
  if (i >= 0 && (dir.length === i + 6 || dir[i + 6] === '/')) return dir.slice(i + 7)
  return dir
}

export const isMemberKey = (key: string) => key.includes(SEP)
/** A mod path's member key; a member key comes back in its one spelling. */
// Keys by path, for this mods folder: every card and list asks for every mod's key on each render (a few regexes each)
const keyCache = new Map<string, string>()
export const memberKey = (path: string) => {
  let k = keyCache.get(path)
  if (k !== undefined) return k
  if (!isMemberKey(path)) k = `${folderOf(path)}${SEP}${bare(nameKey(path))}`
  else {
    const at = path.lastIndexOf(SEP)
    k = `${path.slice(0, at).replace(/\\/g, '/').toLowerCase()}${SEP}${bare(path.slice(at + 1))}`
  }
  keyCache.set(path, k)
  return k
}
/** A stored key in its one spelling: member keys normalized, legacy names only without their priority suffix. */
export const canonKey = (key: string) => (isMemberKey(key) ? memberKey(key) : key.replace(PRIORITY, ''))
/** The name to show for a stored key. */
export const memberName = (key: string) => (isMemberKey(key) ? key.slice(key.lastIndexOf(SEP) + 1) : key.replace(PRIORITY, ''))
/** A member key's folder ("" is the mods folder itself), or undefined for a legacy name. */
export const memberFolder = (key: string) => (isMemberKey(key) ? key.slice(0, key.lastIndexOf(SEP)) : undefined)

/** Installed member keys by name, for resolving legacy names and moved mods. Pure. */
export const keysByName = (keys: Iterable<string>) => {
  const out = new Map<string, string[]>()
  for (const k of new Set(keys)) { const n = memberName(k); out.set(n, [...(out.get(n) ?? []), k]) }
  return out
}

/** Mods that moved between two scans of the mods folder: a key that went and one that came with the same name, one
 *  each. A delete, a copy or two same-named moves at once are not moves. Pure. */
export function movesBetween(before: string[], after: string[]) {
  const was = new Set(before), now = new Set(after)
  const gone = keysByName(before.filter(k => !now.has(k))), came = keysByName(after.filter(k => !was.has(k)))
  const moved = new Map<string, string>()
  for (const [n, from] of gone) { const to = came.get(n); if (from.length === 1 && to?.length === 1) moved.set(from[0], to[0]) }
  return moved
}

/** The other installed mods a member might mean: for a legacy name every installed mod of that name (two or more:
 *  the user picks), for a member no longer installed the same name in other folders (moved while the app was closed).
 *  Pure. */
export const candidatesFor = (key: string, byName: Map<string, string[]>) => {
  const hits = byName.get(bare(memberName(key))) ?? []
  return isMemberKey(key) ? hits.filter(k => k !== memberKey(key)) : hits
}

type Members = { on: string[]; scope: string[] }
/** One loadout's keys brought up to date: member keys normalized and moved ones followed, legacy names with exactly one
 *  installed match turned into its member key. Ambiguous and missing ones stay as they are (shown, never dropped,
 *  never matched). Returns the same object when nothing changes, so a second run is a no-op. Pure. */
export function resolveKeys<T extends Members>(l: T, byName: Map<string, string[]>, moved = new Map<string, string>()): T {
  const fix = (k: string) => {
    if (isMemberKey(k)) { const c = memberKey(k); return moved.get(c) ?? c }
    const hits = byName.get(bare(k)) ?? []
    return hits.length === 1 ? hits[0] : k
  }
  const swap = (keys: string[]) => [...new Set(keys.map(fix))]
  const on = swap(l.on), scope = swap(l.scope)
  return on.join('\n') === l.on.join('\n') && scope.join('\n') === l.scope.join('\n') ? l : { ...l, on, scope }
}

if (import.meta.env.DEV) {
  const was = root
  setModsRoot('C:\\Game\\Paks\\~mods\\')
  const k = (p: string) => memberKey(p)
  // Skin at priority 1, then 0 (the "!" mark), then 1 again: one key throughout, also off and back on
  console.assert(new Set([k('C:/Game/Paks/~mods/Skin_9999999_P.pak'), k('C:/Game/Paks/~mods/!Skin.pak'), k('C:\\Game\\Paks\\~mods\\Skin_9999999_P.bak_repak'), k('C:/Game/Paks/~mods/Skin_99999999_P.pak_disabled')]).size === 1, 'priority 1 -> 0 -> 1 and on/off keep one key')
  console.assert(k('C:/Game/Paks/~mods/Skin_9999999_P.pak') === '|Skin', `root mod key: ${k('C:/Game/Paks/~mods/Skin_9999999_P.pak')}`)
  console.assert(k('C:/Game/Paks/~mods/A/Skin.pak') !== k('C:/Game/Paks/~mods/B/Skin.pak') && k('C:/Game/Paks/~mods/A/Sub/Skin.pak') === 'a/sub|Skin', 'same names in two folders differ')
  console.assert(k('c:/game/paks/~MODS/a/Skin.pak') === k('C:/Game/Paks/~mods/A/Skin.pak'), 'folder case and slashes do not matter')
  console.assert(k('a/sub|!Skin_9999999_P') === 'a/sub|Skin' && canonKey('!Skin_9999999_P') === '!Skin', 'member keys normalize, legacy names only lose the suffix')
  setModsRoot('D:/Mods/Custom')
  console.assert(k('D:/Mods/Custom/X/Y_9999999_P.pak') === 'x|Y' && k('E:/Other/~mods/X/Y.pak') === 'x|Y', 'custom mods folder, and ~mods while it is unknown')
  console.assert(nameKey('C:/m/~mods/!Skin_9999999_P.pak') === '!Skin' && nameKey('a|Skin') === 'Skin', 'nameKey: the preview key keeps "!"')
  setModsRoot(was)
  const by = keysByName(['a|Skin', 'b|Skin', '|Solo'])
  const L = (on: string[], scope = on) => ({ on, scope })
  const unique = resolveKeys(L(['Solo_9999999_P', '!Solo']), by)
  console.assert(unique.on.join() === '|Solo' && unique.scope.join() === '|Solo', `legacy unique migrates (and its "!" copy joins it): ${unique.on}`)
  const amb = resolveKeys(L(['Skin']), by)
  console.assert(amb.on.join() === 'Skin', 'legacy ambiguous stays unresolved, neither mod picked')
  console.assert(candidatesFor('Skin', by).join() === 'a|Skin,b|Skin' && candidatesFor('c|Skin', by).length === 2 && candidatesFor('a|Skin', by).join() === 'b|Skin', 'candidates to pick from')
  const gone = resolveKeys(L(['Gone', 'z|Lost']), by)
  console.assert(gone.on.join() === 'Gone,z|Lost', 'missing members are kept')
  const once = resolveKeys(L(['Solo', 'Skin', 'a|Skin']), by)
  console.assert(resolveKeys(once, by) === once, 'a second migration is a no-op')
  const mv = movesBetween(['a|Skin', 'b|Skin', '|Solo'], ['c|Skin', 'b|Skin', '|Solo'])
  console.assert(mv.get('a|Skin') === 'c|Skin' && mv.size === 1, 'a move is followed')
  console.assert(resolveKeys(L(['a|Skin']), by, mv).on.join() === 'c|Skin', 'moved members follow their mod')
  console.assert(movesBetween(['a|Skin', 'b|Skin'], ['c|Skin', 'd|Skin']).size === 0 && movesBetween(['a|Skin'], []).size === 0, 'two same-named moves, or a delete, are not followed')
}
