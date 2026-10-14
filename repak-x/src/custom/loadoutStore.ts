// caleb fork: saved loadouts, shared by the sidebar list (Loadouts.tsx) and the cards screen
// (LoadoutsScreen.tsx). A loadout is a set of mods: On switches them on, Off switches them off, nothing else is touched.
// It also remembers the mods shown when it was saved (its scope), unused for now. Stored in localStorage.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { deleteMedia } from './loadoutMedia'
import { isTyping } from './hotkeys'

export type Mod = { path: string; enabled?: boolean; modified_date?: number }
export type Loadout = {
  id: string
  name: string
  label: string
  scope: string[]
  on: string[]
  image?: string          // legacy: small data URL kept in localStorage
  mediaType?: 'image' | 'video'
  mediaRev?: number       // set when a file is stored in IndexedDB (loadoutMedia.ts); bumps on change
}

const STORAGE = 'caleb.loadouts'
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const notify = () => listeners.forEach(l => l())

export const readLoadouts = (): Loadout[] => JSON.parse(localStorage.getItem(STORAGE) || '[]')
/** Throws when localStorage is full (large images). */
export const writeLoadouts = (list: Loadout[]) => {
  localStorage.setItem(STORAGE, JSON.stringify(list))
  notify()
}
export const patchLoadout = (id: string, patch: Partial<Loadout>) =>
  writeLoadouts(readLoadouts().map(l => (l.id === id ? { ...l, ...patch } : l)))
/** Removes the loadout and returns a function that puts it back in the same spot. Its image or video stays stored
 *  until the undo window closes. shortcut: closing the app inside that window leaves the media blob behind (harmless,
 *  a few MB in IndexedDB); sweep orphans at startup if that ever matters. */
export const deleteLoadout = (id: string, undoMs = 10000) => {
  const list = readLoadouts()
  const at = list.findIndex(l => l.id === id)
  if (at < 0) return () => undefined
  const removed = list[at]
  writeLoadouts(list.filter(l => l.id !== id))
  let restored = false
  const timer = setTimeout(() => { if (!restored) deleteMedia(id) }, undoMs + 1000)
  return () => {
    restored = true
    clearTimeout(timer)
    const now = readLoadouts()
    if (now.some(l => l.id === id)) return
    now.splice(Math.min(at, now.length), 0, removed)
    writeLoadouts(now)
  }
}

export const useLoadouts = (): Loadout[] =>
  JSON.parse(useSyncExternalStore(subscribe, () => localStorage.getItem(STORAGE) || '[]'))

/** Strips the _9999999_P priority suffix so a key survives priority changes (same as the backend's tag key). */
const normKey = (key: string) => key.replace(/(_\d+_P)+$/i, '')

/** Same mod across enable/disable and priority renames: file name without extension or priority suffix. */
export const modKey = (path: string) =>
  normKey((path.split(/[/\\]/).pop() || path).replace(/(\.pak)?(\.bak_repak|\.pak_disabled)?$/i, '').replace(/_disabled$/i, ''))

/** Stored keys normalized, so loadouts saved before the suffix was dropped still match. */
const keySet = (keys: string[]) => new Set(keys.map(normKey))

export const snapshotLoadout = (base: Pick<Loadout, 'id' | 'name'> & Partial<Loadout>, scopeMods: Mod[], label = 'Other'): Loadout => ({
  ...base,
  label: base.label ?? label, // overwriting keeps the group; the filter text ("all mods") is not a group name
  scope: scopeMods.map(m => modKey(m.path)),
  on: scopeMods.filter(m => m.enabled).map(m => modKey(m.path)),
})

/** Mods to switch so the loadout is on: its own mods that are off. Nothing else changes: other mods and other loadouts
 *  stay as they are (Caleb, 2026-10-14; the scope is still saved, unused while loadouts are independent). */
export const changesToTurnOn = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  return mods.filter(m => on.has(modKey(m.path)) && !m.enabled)
}

/** Mods to flip so the loadout is off: its own mods that are currently on. */
export const changesToTurnOff = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  return mods.filter(m => on.has(modKey(m.path)) && m.enabled)
}

/** On = every one of its installed mods is on (other mods may be on too). */
export const isActive = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  const mine = mods.filter(m => on.has(modKey(m.path)))
  return mine.length > 0 && mine.every(m => m.enabled)
}

/** Adds a mod to the loadout's on list (and its scope, so the loadout manages it from now on). */
export const addModToLoadout = (l: Loadout, key: string) => {
  const k = normKey(key)
  patchLoadout(l.id, {
    on: keySet(l.on).has(k) ? l.on : [...l.on, k],
    scope: keySet(l.scope).has(k) ? l.scope : [...l.scope, k],
  })
}

/** Takes a mod off the loadout's on list. It stays in scope, so turning the loadout on switches it off. */
export const removeModFromLoadout = (l: Loadout, key: string) =>
  patchLoadout(l.id, { on: l.on.filter(x => normKey(x) !== normKey(key)) })

/** "slug_type_..._v10" -> { base: "slug_type_...", n: 10 }; undefined without a trailing _vN. */
export const versionOf = (key: string) => {
  const m = normKey(key).match(/^(.*)_v(\d+)$/i)
  return m ? { base: m[1], n: Number(m[2]) } : undefined
}

/** The older version of this mod that the loadout holds (same name, lower _vN), if any. */
export const olderVersionIn = (l: Loadout, key: string) => {
  const v = versionOf(key)
  if (!v) return undefined
  return l.on.map(normKey).find(k => { const o = versionOf(k); return o !== undefined && o.base === v.base && o.n < v.n })
}

/** Swaps one key for another in the loadout (on list, and scope so the loadout keeps managing it). */
export const replaceInLoadout = (l: Loadout, oldKey: string, newKey: string) =>
  patchLoadout(l.id, {
    on: l.on.map(k => (normKey(k) === normKey(oldKey) ? normKey(newKey) : k)),
    scope: keySet(l.scope).has(normKey(newKey)) ? l.scope : [...l.scope, normKey(newKey)],
  })

/** Readable mod name from its key: drops the _9999999_P priority suffix. */
export const displayName = normKey

/** Loadouts as a JSON file (media stays in this app). Import adds loadouts whose name is new. */
export const exportLoadouts = () =>
  JSON.stringify({
    format: 'repakxcable-loadouts',
    version: 1,
    loadouts: readLoadouts().map(({ image: _i, mediaRev: _r, mediaType: _t, ...l }) => l),
  }, null, 2)

export const importLoadouts = (text: string) => {
  const data = JSON.parse(text)
  const incoming: Loadout[] = Array.isArray(data) ? data : data?.loadouts
  if (!Array.isArray(incoming)) throw new Error('Not a loadouts file.')
  const existing = readLoadouts()
  const names = new Set(existing.map(l => l.name.toLowerCase()))
  const added: Loadout[] = incoming
    .filter(l => l && typeof l.name === 'string' && Array.isArray(l.scope) && Array.isArray(l.on) && !names.has(l.name.toLowerCase()))
    .map(l => ({ id: crypto.randomUUID(), name: l.name, label: l.label || 'imported', scope: l.scope.map(String), on: l.on.map(String) }))
  writeLoadouts([...existing, ...added])
  return { added: added.length, skipped: incoming.length - added.length }
}

/** Toggle each mod through the backend; returns the mods that could not be switched. */
export const flipMods = async (changes: Mod[]) => {
  const failed: Mod[] = []
  for (const m of changes) {
    try { await invoke('toggle_mod', { modPath: m.path }) } catch { failed.push(m) }
  }
  return failed
}

/** Moves a loadout to another position (the sidebar's order is also the Ctrl+1..9 order). */
export const moveLoadout = (id: string, to: number) => {
  const list = readLoadouts()
  const from = list.findIndex(l => l.id === id)
  if (from < 0 || from === to) return
  const [l] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(to, list.length)), 0, l)
  writeLoadouts(list)
}

/** A copy right after the original, "Name copy", same mods and group (its image stays with the original). */
export const duplicateLoadout = (l: Loadout) => {
  const list = readLoadouts()
  const copy: Loadout = { id: crypto.randomUUID(), name: `${l.name} copy`, label: l.label, scope: [...l.scope], on: [...l.on] }
  list.splice(list.findIndex(x => x.id === l.id) + 1, 0, copy)
  writeLoadouts(list)
  return copy
}

/** Groups match without regard to case or spaces, so "Panther looks" and "panther looks " are one group. */
export const groupKey = (label: string) => label.trim().toLowerCase()

/** Which main view shows: Home (loadout cards) or Library (the full mod list). Remembered; Home on first start.
 *  Mirrored on <html data-view> so caleb.css hides the other view (both stay mounted, keeping their state). */
export type View = 'home' | 'library'
let view: View = localStorage.getItem('caleb.view') === 'library' ? 'library' : 'home'
const applyView = () => { document.documentElement.dataset.view = view }
applyView()
export const setView = (v: View) => { view = v; localStorage.setItem('caleb.view', v); applyView(); notify() }
export const useView = () => useSyncExternalStore(subscribe, () => view)

/** The loadout page open on Home (null = the cards). Shared so the Library sidebar can open one too. */
let openId: string | null = null
export const openLoadout = (id: string | null) => { openId = id; if (id && view !== 'home') setView('home'); else notify() }
export const useOpenLoadout = () => useSyncExternalStore(subscribe, () => openId)

// L switches between Home and Library. This module also loads in the Asset Explorer and VFX Updater windows, which
// have no Home: only the window showing the Home | Library tabs reacts
window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'l' || e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target)) return
  if (!document.querySelector('.view-tabs')) return
  if (document.querySelector('.modal-overlay')) return // Settings or another dialog is open
  e.preventDefault()
  setView(view === 'home' ? 'library' : 'home')
})

if (import.meta.env.DEV) {
  // The one rule that ties a loadout to a file, whatever state the file is in (mod_previews.py mod_key must agree)
  for (const [path, key] of [['C:/m/~mods/X_9999999_P.pak', 'X'], ['X_9999999_P.bak_repak', 'X'], ['X_9999999_P.pak.bak_repak', 'X'],
    ['X_9999999_P.pak_disabled', 'X'], ['X_disabled', 'X'], ['bp-lime-vfx_vfx_noPG_v2_9999999_P.pak', 'bp-lime-vfx_vfx_noPG_v2'], ['B_P.pak', 'B_P']])
    console.assert(modKey(path) === key, `modKey(${path}) = ${modKey(path)}, expected ${key}`)
}
