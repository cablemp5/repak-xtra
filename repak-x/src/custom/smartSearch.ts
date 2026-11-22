// repakxtra: the Library's and the Loadouts screen's search, one matcher for both. Each typed word must be in the
// name (any case, any order, accents and punctuation ignored, "blackpanther" finds "Black Panther"). Exact match
// (Settings > Interface > Search) wants the typed phrase in order instead. Only when nothing matches directly do close
// matches count: one word of five letters or more may be one letter off (or two letters swapped), every other word must
// match as typed. Short words never guess.

/** Lowercase, no accents, punctuation as spaces, one space between words. Pure. */
export const normText = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** Exact match's own spelling: case and spaces only, the phrase's punctuation counts. Pure. */
const exactText = (s: string) => s.toLowerCase().replace(/[\s_]+/g, ' ').trim() // each _ in a file name is a space

/** Whether `name` matches `query` as typed: every word (in any order), or with `exact` the phrase in order, ignoring
 *  only case and extra spaces. A blank query matches everything, one of punctuation alone is matched as typed. Pure. */
export function directMatch(name: string, query: string, exact = false): boolean {
  if (!query.trim()) return true
  if (exact) { const e = exactText(query); return e ? exactText(name).includes(e) : name.toLowerCase().includes(query.trim().toLowerCase()) } // only _ typed: matched as typed
  const q = normText(query)
  if (!q) return name.toLowerCase().includes(query.trim().toLowerCase())
  const h = normText(name)
  return q.split(' ').every(t => h.includes(t) || joinedFrom(h.split(' '), t))
}

/** Whether `t` reads as words written together from the start of one of `words` ("blackpanther" in "black panther"),
 *  never a run across a word's middle ("thor" is not in "midnight horror"). Pure. */
const joinedFrom = (words: string[], t: string) => words.some((_, i) => words.slice(i).join('').startsWith(t))

/** Whether `a` and `b` are at most one edit apart: one letter changed, added, or dropped, or two neighbors swapped.
 *  Linear, no table: the fallback checks every word of every name. Pure. */
function withinOne(a: string, b: string): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** The shortest word that may be one letter off. */
const MIN_FUZZY = 5

/** 1 when one word of `query` needed a one-letter fix to match `name`, or null when it is not a close match (a short
 *  word that does not match as typed, a word two letters off, two words to fix, or nothing to fix). Pure. */
export function closeMatch(name: string, query: string): number | null {
  return closeNorm(name, normText(query))
}

/** closeMatch for a query normalized once (closeMatches runs it for every name). */
function closeNorm(name: string, q: string): number | null {
  if (!q) return null
  const h = normText(name), words = h.split(' ')
  let fixes = 0
  for (const t of q.split(' ')) {
    if (h.includes(t) || joinedFrom(words, t)) continue
    if ([...t.normalize('NFC')].length < MIN_FUZZY || !words.some(w => withinOne(t, w))) return null // letters, not code units (Korean decomposes)
    if (++fixes > 1) return null // one guess at most: the other words must match as typed
  }
  return fixes || null
}

/** Close matches among `items`, at most `limit`: the ones whose first name matched (a loadout's own) before the ones
 *  matched by a later one (a mod inside it), then by name. Pure. */
export function closeMatches<T>(items: T[], names: (item: T) => string[], query: string, limit = 20): T[] {
  const q = normText(query)
  if (!q) return []
  const scored = items.map(item => { const all = names(item); return { item, name: all[0] ?? '', at: all.findIndex(n => closeNorm(n, q) !== null) } })
  return scored.filter(s => s.at >= 0).sort((a, b) => Math.min(a.at, 1) - Math.min(b.at, 1) || a.name.localeCompare(b.name)).slice(0, limit).map(s => s.item)
}

if (import.meta.env.DEV) {
  const bp = 'Black Panther \u2014 Purple VFX', spidey = 'Purple Spider-Man'
  console.assert(directMatch(bp, 'purple panther') && !directMatch(spidey, 'purple panther'), 'every word, any order')
  console.assert(directMatch(bp, 'blackpanther purple'), 'words typed together find the name written apart')
  console.assert(!directMatch('Midnight Horror', 'thor'), 'never a run across the middle of two words')
  console.assert(!directMatch(bp, 'purpel panther') && closeMatch(bp, 'purpel panther') === 1, 'a swapped pair is one fix, only as a close match')
  console.assert(closeMatch(spidey, 'purpel panther') === null, 'every other word must still match')
  console.assert(closeMatch('Hulk VFX', 'vxf') === null && closeMatch('Thor', 'thro') === null, 'short words never guess')
  console.assert(directMatch(bp, 'purple  vfx', true) && !directMatch('VFX Purple', 'purple vfx', true), 'exact: the phrase in order, extra spaces ignored')
  console.assert(directMatch('Café Mods', 'cafe') && directMatch('Spider-Man', 'spider man'), 'accents and punctuation ignored')
  console.assert(!directMatch('Spider Man', 'spider-man', true) && directMatch('Spider-Man', 'SPIDER-man', true), 'exact: only case and spaces are ignored')
  console.assert(directMatch('Black_Panther_Purple_VFX_9999999_P', 'purple vfx', true), "exact: each _ in a file name is a space")
  console.assert(directMatch('A - B', '-') && !directMatch('AB', '-'), 'a query of punctuation alone matches as typed')
  console.assert(!directMatch('Hulk Hat', '_', true) && directMatch('A_B', '_', true), 'exact: an _ alone matches as typed')
  console.assert(directMatch(bp, '   ') && closeMatch(bp, ' ') === null, 'a blank query matches everything and guesses nothing')
  console.assert(closeMatches([spidey, bp, 'Purple Pnather Mod'], n => [n], 'purpel panther').join() === bp, 'only close matches, ranked')
  console.assert(withinOne('purpel', 'purple') && withinOne('purple', 'purples') && withinOne('purpe', 'purple') && withinOne('purxle', 'purple') && !withinOne('pruple', 'purpel') && !withinOne('abc', 'abcde'), 'one edit: a swap, an extra, a missing, or a changed letter')
}
