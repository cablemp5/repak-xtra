// repakxtra: loadouts and UI settings saved by repakxtra 0.2 and older sit under an older key prefix. They are copied
// once to their repakxtra.* names, only where nothing is saved under the new name yet, and the old entries stay so an
// older build still finds its own. Imported first in main.tsx, before any module reads its settings; it never throws.
const OWN = /^(?!repakxtra\.)[a-z]+\.(loadouts|groups|view|loadoutsHeight|loadoutGroupBy|setup\.autoCheck|setup\.galactaFolder|uiScale|hideTags|sound|motion|show\.[\w-]+)$/

/** [new key, old key, value] for the old-prefix keys whose repakxtra.* name is not saved yet. Pure. */
export const carryOver = (saved: Record<string, string>) =>
  Object.entries(saved).flatMap(([k, v]) => {
    const name = k.match(OWN)?.[1]
    return name && !(`repakxtra.${name}` in saved) ? [[`repakxtra.${name}`, k, v] as const] : []
  })

/** New key -> old key, for an entry that could not be carried over at all: read from the old one. */
const fallback = new Map<string, string>()

/** Copies, or when localStorage is too full for a second copy (old inline loadout images), moves the entry: the old
 *  copy's space makes room, and if even that fails the old entry is put back and read from (`fallback`). The value
 *  is in memory throughout, so nothing is lost. Exported for the self-check. */
export function carryOverInto(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, entries: ReturnType<typeof carryOver>, missing = fallback) {
  for (const [k, old, v] of entries) {
    try {
      store.setItem(k, v)
    } catch {
      try {
        store.removeItem(old)
        store.setItem(k, v)
      } catch (e) {
        try { if (store.getItem(old) === null) store.setItem(old, v) } catch { /* it still fit a moment ago */ }
        missing.set(k, old)
        console.warn(`Could not carry over ${old}:`, e)
      }
    }
  }
}

try {
  carryOverInto(localStorage, carryOver({ ...localStorage }))
} catch (e) {
  console.warn('Settings were not carried over:', e)
}

/** localStorage.getItem for a repakxtra.* key; an entry that could not be carried over is read from its old name. */
export const savedItem = (key: string) => localStorage.getItem(key) ?? (fallback.has(key) ? localStorage.getItem(fallback.get(key)!) : null)

if (import.meta.env.DEV) {
  const out = carryOver({ 'old.loadouts': '[1]', 'old.show.tags': '0', 'old.view': 'home', 'repakxtra.view': 'library',
    'mock.kit': '1', hasSeenOnboarding: 'true' })
  console.assert(JSON.stringify(out) === JSON.stringify([['repakxtra.loadouts', 'old.loadouts', '[1]'], ['repakxtra.show.tags', 'old.show.tags', '0']]),
    `carryOver copies only unsaved old keys: ${JSON.stringify(out)}`)
  // A store with room for 2 entries: the first copy fits, the second moves, the third fails and keeps its old entry
  const fake = (room: number) => {
    const m = new Map<string, string>()
    return { m, getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => { if (!m.has(k) && m.size >= room) throw new Error('full'); m.set(k, v) } }
  }
  const s = fake(3)
  s.m.set('old.view', 'library'); s.m.set('old.groups', '["A"]')
  const missing = new Map<string, string>()
  carryOverInto(s, [['repakxtra.view', 'old.view', 'library'], ['repakxtra.groups', 'old.groups', '["A"]']], missing)
  console.assert(s.m.get('repakxtra.view') === 'library' && s.m.get('old.view') === 'library', 'carryOverInto copies when it fits')
  console.assert(s.m.get('repakxtra.groups') === '["A"]' && !s.m.has('old.groups'), 'carryOverInto moves when full')
  const t = fake(1)
  t.m.set('old.loadouts', '[1]')
  carryOverInto({ ...t, setItem: (k, v) => { if (k.startsWith('repakxtra.')) throw new Error('full'); t.setItem(k, v) } }, [['repakxtra.loadouts', 'old.loadouts', '[1]']], missing)
  console.assert(t.m.get('old.loadouts') === '[1]' && missing.get('repakxtra.loadouts') === 'old.loadouts', 'carryOverInto keeps the old entry and reads it')
}
