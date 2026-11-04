// repakxtra: the Library sidebar's mod count per folder in one pass over the mods, instead of filtering every mod for
// every folder on each render. With subfolders shown, a mod also counts toward each folder above its own.
export function folderCounts(mods: { folder_id?: string | null }[], withSubfolders: boolean): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of mods) {
    let id = m.folder_id
    while (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      const cut = id.lastIndexOf('/')
      id = withSubfolders && cut > 0 ? id.slice(0, cut) : ''
    }
  }
  return counts
}

if (import.meta.env.DEV) {
  const mods = [{ folder_id: 'a' }, { folder_id: 'a/b' }, { folder_id: 'a/b/c' }, { folder_id: 'ab' }, { folder_id: null }, {}]
  const deep = folderCounts(mods, true), flat = folderCounts(mods, false)
  console.assert(deep.get('a') === 3 && deep.get('a/b') === 2 && deep.get('a/b/c') === 1 && deep.get('ab') === 1, 'folderCounts: parents count their subfolders, a/ab stay apart')
  console.assert(flat.get('a') === 1 && flat.get('a/b') === 1 && flat.get('ab') === 1 && flat.size === 4, 'folderCounts: own folder only')
}
