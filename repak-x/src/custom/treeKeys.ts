// repakxtra: keyboard model for the Asset Explorer's virtualized rows (modules/asset-explorer/AssetTree.tsx). Rows are
// read through accessors so a six-figure list is never copied per key press. Pure, checked at the bottom.

/** The row list as the tree sees it: `depth` 0 is the top level, `folder` rows can be `open`. */
export type KeyRows = {
  count: number
  depth: (i: number) => number
  key: (i: number) => string
  folder: (i: number) => boolean
  open: (i: number) => boolean
}

/** Where the active row should go: another row, or the same folder opened or closed. */
export type KeyMove = { to: number } | { toggle: number } | null

/** The row above `i` that holds it, or -1 at the top level. */
export function parentOf(rows: KeyRows, i: number): number {
  const d = rows.depth(i)
  for (let j = i - 1; j >= 0; j--) if (rows.depth(j) < d) return j
  return -1
}

/** Up/Down, Home/End, PageUp/PageDown (`page` rows), Right opens a folder or enters it, Left closes it or goes to its
 *  parent. Flat lists have no folders and no depth, so Left and Right do nothing there. */
export function treeKey(rows: KeyRows, at: number, key: string, page = 10): KeyMove {
  const last = rows.count - 1
  if (last < 0) return null
  const to = (i: number) => ({ to: Math.max(0, Math.min(last, i)) })
  switch (key) {
    case 'ArrowDown': return to(at + 1)
    case 'ArrowUp': return to(at - 1)
    case 'Home': return to(0)
    case 'End': return to(last)
    case 'PageDown': return to(at + page)
    case 'PageUp': return to(at - page)
    case 'ArrowRight':
      if (!rows.folder(at)) return null
      if (!rows.open(at)) return { toggle: at }
      return at < last && rows.depth(at + 1) > rows.depth(at) ? { to: at + 1 } : null
    case 'ArrowLeft': {
      if (rows.folder(at) && rows.open(at)) return { toggle: at }
      const p = parentOf(rows, at)
      return p < 0 ? null : { to: p }
    }
  }
  return null
}

/** Keys of row `i` and every folder above it, nearest first: what the active row falls back to when it goes away. */
export function chainAt(rows: KeyRows, i: number): string[] {
  const out = [rows.key(i)]
  for (let p = parentOf(rows, i); p >= 0; p = parentOf(rows, p)) out.push(rows.key(p))
  return out
}

/** Where the active row is now. The same row if it is still listed (checked at its old index first), else its
 *  nearest listed folder (an ancestor was closed or filtered), else the old index kept in range (a refresh or a
 *  removed row). */
export function findActive(rows: KeyRows, active: { chain: string[]; index: number }): number {
  if (rows.count === 0) return -1
  const { chain, index } = active
  if (index < rows.count && rows.key(index) === chain[0]) return index
  const rank = new Map(chain.map((k, r) => [k, r]))
  let best = -1
  let bestRank = Infinity
  for (let i = 0; i < rows.count; i++) {
    const r = rank.get(rows.key(i))
    if (r !== undefined && r < bestRank) { best = i; bestRank = r; if (r === 0) break }
  }
  return best >= 0 ? best : Math.max(0, Math.min(rows.count - 1, index))
}

if (import.meta.env.DEV) {
  // a/        0 folder open
  //   b/      1 folder closed
  //   c.uasset  2
  // d.uasset  3
  const list = [
    { key: 'a', depth: 0, folder: true, open: true },
    { key: 'a/b', depth: 1, folder: true, open: false },
    { key: 'a/c', depth: 1, folder: false, open: false },
    { key: 'd', depth: 0, folder: false, open: false },
  ]
  const of = (l: typeof list): KeyRows => ({
    count: l.length, depth: i => l[i].depth, key: i => l[i].key, folder: i => l[i].folder, open: i => l[i].open,
  })
  const rows = of(list)
  const same = (a: KeyMove, b: KeyMove) => JSON.stringify(a) === JSON.stringify(b)
  console.assert(same(treeKey(rows, 0, 'ArrowDown'), { to: 1 }) && same(treeKey(rows, 3, 'ArrowDown'), { to: 3 }), 'Down moves and stops at the end')
  console.assert(same(treeKey(rows, 0, 'ArrowUp'), { to: 0 }) && same(treeKey(rows, 2, 'Home'), { to: 0 }) && same(treeKey(rows, 0, 'End'), { to: 3 }), 'Up, Home and End stay in range')
  console.assert(same(treeKey(rows, 0, 'PageDown', 10), { to: 3 }), 'PageDown clamps')
  console.assert(same(treeKey(rows, 1, 'ArrowRight'), { toggle: 1 }) && same(treeKey(rows, 0, 'ArrowRight'), { to: 1 }), 'Right opens a closed folder, enters an open one')
  console.assert(treeKey(rows, 2, 'ArrowRight') === null, 'Right on a file does nothing')
  console.assert(same(treeKey(rows, 0, 'ArrowLeft'), { toggle: 0 }) && same(treeKey(rows, 2, 'ArrowLeft'), { to: 0 }), 'Left closes an open folder, or goes to the parent')
  console.assert(treeKey(rows, 3, 'ArrowLeft') === null && treeKey(of([]), 0, 'ArrowDown') === null, 'Left at the top level and keys on no rows do nothing')
  console.assert(JSON.stringify(chainAt(rows, 2)) === '["a/c","a"]', 'the chain lists the row then its folders')
  console.assert(findActive(rows, { chain: ['a/c', 'a'], index: 2 }) === 2, 'an unmoved row stays')
  console.assert(findActive(of([list[0], list[2], list[3]]), { chain: ['a/c', 'a'], index: 2 }) === 1, 'a row that moved is found by key')
  console.assert(findActive(of([{ ...list[0], open: false }, list[3]]), { chain: ['a/c', 'a'], index: 2 }) === 0, 'a closed folder takes over')
  console.assert(findActive(of([list[3]]), { chain: ['a/c', 'a'], index: 2 }) === 0 && findActive(of([]), { chain: ['x'], index: 0 }) === -1, 'otherwise the index is kept in range')
}
