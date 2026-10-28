// repakxtra: loadouts and settings shared between the stable/test copies and the dev copy (dev.ps1). They run from
// different addresses (the app's own, and http://localhost:5180), so each has its own localStorage; every repakxtra.*
// entry also lives in %APPDATA%\Repak-X\webview-storage.json (xtra_storage.rs), and the newest save wins.
//   At start (once per session): a newer file replaces this copy's entries (the old ones go to webview-storage.backup.json
//   first) and the window reloads once so every module reads them. While running: a change here is written to the file.
//   A copy that starts empty with no file to load never writes, so it can't wipe another copy's loadouts.
// The app runs one copy at a time, so two never write at once. Loadout pictures in IndexedDB (loadoutMedia.ts) are not
// shared. Imported in main.tsx; it never throws.
import { invoke } from '@tauri-apps/api/core'

const PREFIX = 'repakxtra.'
const AT = 'repakxtra-sync.at'          // localStorage: when this copy's entries were last saved to, or loaded from, the file
const SESSION = 'repakxtra-sync.mode'   // sessionStorage: this session's decision, kept across its reloads

type Entries = Record<string, string>
type Snap = { at: number; data: Entries }
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly length: number; key(i: number): string | null }

/** Every repakxtra.* entry, sorted, so an unchanged store serializes the same. */
export const collect = (store: Store): Entries => {
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k?.startsWith(PREFIX)) keys.push(k) }
  return Object.fromEntries(keys.sort().map(k => [k, store.getItem(k) ?? '']))
}
const same = (a: Entries, b: Entries) => JSON.stringify(a) === JSON.stringify(Object.fromEntries(Object.entries(b).sort()))

/** The file as {at, data}; the first version wrote the bare entries, which count as saved at 1. */
export const parseSnap = (text: string | null | undefined): Snap | null => {
  if (!text) return null
  const v = JSON.parse(text)
  return typeof v?.at === 'number' && v.data && typeof v.data === 'object' ? { at: v.at, data: v.data } : { at: 1, data: v }
}

/** What a copy does at start. import: take the file. write: this copy is newer (or the file is missing), save it.
 *  idle: already in sync. readonly: empty, with nothing to load, so it must not overwrite anyone. */
export function plan(local: Entries, localAt: number, snap: Snap | null): 'import' | 'write' | 'idle' | 'readonly' {
  const empty = Object.keys(local).length === 0
  if (!snap) return empty ? 'readonly' : 'write'
  if (same(local, snap.data)) return 'idle'
  if (snap.at > localAt) return 'import'
  return empty ? 'readonly' : 'write'
}

/** Makes the store's repakxtra.* entries equal to `data`. Returns whether anything changed. */
export function mirror(store: Store, data: Entries) {
  let changed = false
  for (const k of Object.keys(collect(store))) if (!(k in data)) { store.removeItem(k); changed = true }
  for (const [k, v] of Object.entries(data)) if (k.startsWith(PREFIX) && store.getItem(k) !== v) { store.setItem(k, v); changed = true }
  return changed
}

async function start() {
  let mode = sessionStorage.getItem(SESSION)
  if (!mode) {
    const snap = parseSnap(await invoke<string | null>('xtra_storage_snapshot_read'))
    const local = collect(localStorage)
    const localAt = Number(localStorage.getItem(AT)) || 0
    const step = plan(local, localAt, snap)
    mode = step === 'readonly' ? 'ro' : 'rw'
    sessionStorage.setItem(SESSION, mode)
    if (step === 'idle' && snap) localStorage.setItem(AT, String(Math.max(localAt, snap.at)))
    if (step === 'import' && snap) {
      if (Object.keys(local).length) await invoke('xtra_storage_backup_write', { text: JSON.stringify({ at: localAt, data: local }) })
      const changed = mirror(localStorage, snap.data)
      localStorage.setItem(AT, String(snap.at))
      if (changed) { location.reload(); return }
    }
    if (step === 'write') localStorage.removeItem(AT) // forces the first save below
  }
  if (mode !== 'rw') return
  let last = localStorage.getItem(AT) ? JSON.stringify(collect(localStorage)) : ''
  // Only after a repakxtra.* change (here or in another window): reading and serializing every entry each second cost
  // a slow PC time while nothing changed
  let dirty = true
  const touched = (key: string | null) => { if (key === null || key.startsWith(PREFIX)) dirty = true }
  for (const name of ['setItem', 'removeItem', 'clear'] as const) {
    const original = Storage.prototype[name] as (...args: unknown[]) => unknown
    Storage.prototype[name] = function (this: Storage, ...args: unknown[]) {
      const result = original.apply(this, args)
      if (this === localStorage) touched(name === 'clear' ? null : String(args[0]))
      return result
    } as never
  }
  window.addEventListener('storage', e => touched(e.key))
  const save = () => {
    if (!dirty) return
    dirty = false
    let text: string
    try { text = JSON.stringify(collect(localStorage)) } catch { return }
    if (text === last) return
    last = text
    const at = Date.now()
    localStorage.setItem(AT, String(at))
    invoke('xtra_storage_snapshot_write', { text: JSON.stringify({ at, data: JSON.parse(text) }) })
      .catch(e => { last = ''; dirty = true; console.warn('[devStorage] Could not save the shared copy:', e) })
  }
  setTimeout(save, 1500)
  setInterval(save, 1000) // often: a copy closed right after an edit must not lose it to the other copy
  window.addEventListener('pagehide', save)
}

if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
  start().catch(e => console.warn('[devStorage] Sharing loadouts is off this session:', e))
}

if (import.meta.env.DEV) {
  const a = { 'repakxtra.loadouts': '[1]' }, b = { 'repakxtra.loadouts': '[2]' }
  console.assert(plan({}, 0, null) === 'readonly', 'empty with no file: never writes')
  console.assert(plan({}, 0, { at: 5, data: a }) === 'import', 'empty dev copy takes the file')
  console.assert(plan(a, 0, null) === 'write', 'no file yet: this copy seeds it')
  console.assert(plan(a, 3, { at: 5, data: b }) === 'import', 'newer file wins')
  console.assert(plan(b, 9, { at: 5, data: a }) === 'write', 'this copy is newer')
  console.assert(plan(a, 0, { at: 5, data: a }) === 'idle', 'same entries: nothing to do')
  console.assert(plan({}, 9, { at: 5, data: a }) === 'readonly', 'an emptied newer copy never wipes the file')
  console.assert(parseSnap('{"repakxtra.view":"list"}')?.at === 1 && parseSnap('{"at":7,"data":{}}')?.at === 7, 'parseSnap')
  const m = new Map<string, string>([['repakxtra.view', 'list'], ['repakxtra.old', 'x'], ['other', 'keep']])
  const fake: Store = {
    get length() { return m.size }, key: i => [...m.keys()][i] ?? null,
    getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: k => { m.delete(k) },
  }
  console.assert(mirror(fake, { 'repakxtra.view': 'cards' }) && m.get('repakxtra.view') === 'cards' && !m.has('repakxtra.old') && m.get('other') === 'keep', 'mirror')
  console.assert(!mirror(fake, { 'repakxtra.view': 'cards' }), 'mirror: nothing to change')
}
