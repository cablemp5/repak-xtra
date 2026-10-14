// caleb fork: saved loadouts, shared by the sidebar list (Loadouts.tsx) and the cards screen
// (LoadoutsScreen.tsx). A loadout remembers which mods were on among the mods shown when it was
// saved (its scope, e.g. everything filtered to Black Panther). Stored in localStorage.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { deleteMedia } from './loadoutMedia'

export type Mod = { path: string; enabled?: boolean }
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
export const deleteLoadout = (id: string) => {
  writeLoadouts(readLoadouts().filter(l => l.id !== id))
  deleteMedia(id)
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

export const snapshotLoadout = (base: Pick<Loadout, 'id' | 'name'> & Partial<Loadout>, scopeMods: Mod[], label: string): Loadout => ({
  ...base,
  label,
  scope: scopeMods.map(m => modKey(m.path)),
  on: scopeMods.filter(m => m.enabled).map(m => modKey(m.path)),
})

/** Mods to flip so the loadout is on: its mods on, the rest of its scope off. */
export const changesToTurnOn = (l: Loadout, mods: Mod[]) => {
  const scope = keySet(l.scope)
  const on = keySet(l.on)
  return mods.filter(m => scope.has(modKey(m.path)) && Boolean(m.enabled) !== on.has(modKey(m.path)))
}

/** Mods to flip so the loadout is off: its own mods that are currently on. */
export const changesToTurnOff = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  return mods.filter(m => on.has(modKey(m.path)) && m.enabled)
}

export const isActive = (l: Loadout, mods: Mod[]) => {
  const scope = keySet(l.scope)
  return mods.some(m => scope.has(modKey(m.path))) && changesToTurnOn(l, mods).length === 0
}

/**
 * Turning a loadout on also turns off every other active loadout that shares mods with it
 * (overlapping scope): their mods go off unless this loadout wants them on.
 * Returns the flips plus the loadouts that end up switched off.
 */
export const planTurnOn = (l: Loadout, all: Loadout[], mods: Mod[]) => {
  const flips = new Map(changesToTurnOn(l, mods).map(m => [m.path, m]))
  const scope = keySet(l.scope)
  const keep = keySet(l.on)
  const displaced: Loadout[] = []
  for (const k of all) {
    if (k.id === l.id || !isActive(k, mods) || !k.scope.some(key => scope.has(normKey(key)))) continue
    displaced.push(k)
    for (const m of changesToTurnOff(k, mods)) if (!keep.has(modKey(m.path))) flips.set(m.path, m)
  }
  return { flips: [...flips.values()], displaced }
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

/** Toggle each mod through the backend; returns how many failed. */
export const flipMods = async (changes: Mod[]) => {
  let failed = 0
  for (const m of changes) {
    try { await invoke('toggle_mod', { modPath: m.path }) } catch { failed++ }
  }
  return failed
}

/** The cards screen open/close state, so any button can open it. */
let screenOpen = false
export const setLoadoutsScreenOpen = (open: boolean) => { screenOpen = open; notify() }
export const useLoadoutsScreenOpen = () => useSyncExternalStore(subscribe, () => screenOpen)

// L opens/closes the loadouts screen (main window only: this module loads with the app)
window.addEventListener('keydown', e => {
  const t = e.target as HTMLElement | null
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  if (e.key.toLowerCase() !== 'l' || e.ctrlKey || e.altKey || e.metaKey || typing) return
  if (document.querySelector('.modal-overlay')) return // Settings or another dialog is open
  e.preventDefault()
  setLoadoutsScreenOpen(!screenOpen)
})
