// repakxtra: saved loadouts, shared by the sidebar list (Loadouts.tsx) and the cards screen
// (LoadoutsScreen.tsx). A loadout is a set of mods: On switches them on, Off switches them off, nothing else is touched.
// It also remembers the mods shown when it was saved (its scope), unused for now. Stored in localStorage.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { sweepOrphanMedia } from './loadoutMedia'
import { savedItem } from './storageCarryOver'
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

const STORAGE = 'repakxtra.loadouts'
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const notify = () => listeners.forEach(l => l())

/** A label that is not a string (a hand-edited or imported file) reads as no group, so grouping never sees an object. */
const decode = (json: string): Loadout[] =>
  (JSON.parse(json) as Loadout[]).map(l => (typeof l.label === 'string' ? l : { ...l, label: OTHER }))
export const readLoadouts = (): Loadout[] => decode(savedItem(STORAGE) || '[]')
/** Every id written this session: the startup media sweep keeps their media (a deleted one may still come back by Undo). */
const sessionIds = new Set<string>()
/** Throws when localStorage is full (large images). */
export const writeLoadouts = (list: Loadout[]) => {
  localStorage.setItem(STORAGE, JSON.stringify(list))
  list.forEach(l => sessionIds.add(l.id))
  notify()
}
export const patchLoadout = (id: string, patch: Partial<Loadout>) =>
  writeLoadouts(readLoadouts().map(l => (l.id === id ? { ...l, ...patch } : l)))
/** Removes the loadout and returns a function that puts it back in the same spot. Its image or video stays stored
 *  for the rest of the session; sweepMediaOnce drops it at the next start. */
export const deleteLoadout = (id: string) => {
  const list = readLoadouts()
  const at = list.findIndex(l => l.id === id)
  if (at < 0) return () => undefined
  const removed = list[at]
  writeLoadouts(list.filter(l => l.id !== id))
  return () => {
    const now = readLoadouts()
    if (now.some(l => l.id === id)) return
    now.splice(Math.min(at, now.length), 0, removed)
    writeLoadouts(now)
  }
}

export const useLoadouts = (): Loadout[] =>
  decode(useSyncExternalStore(subscribe, () => savedItem(STORAGE) || '[]'))

let swept = false
/** Once per start, from Home (the main window only): deletes stored media whose loadout no longer exists. The ids are
 *  read before anything is awaited and the set stays live, so loadouts made or deleted meanwhile keep their media.
 *  Anything unreadable skips the cleanup rather than counting as "no loadouts". */
export function sweepMediaOnce() {
  if (swept) return
  swept = true
  try {
    const list: unknown = JSON.parse(savedItem(STORAGE) || '[]')
    if (!Array.isArray(list) || !list.every(l => typeof l?.id === 'string' && l.id)) return
    list.forEach(l => sessionIds.add(l.id))
  } catch {
    return
  }
  sweepOrphanMedia(sessionIds).catch(e => console.warn('Loadout media sweep skipped:', e))
}

/** Strips the _9999999_P priority suffix so a key survives priority changes (same as the backend's tag key). */
const normKey = (key: string) => key.replace(/(_\d+_P)+$/i, '')

/** Same mod across enable/disable and priority renames: file name without extension or priority suffix. */
export const modKey = (path: string) =>
  normKey((path.split(/[/\\]/).pop() || path).replace(/(\.pak)?(\.bak_repak|\.pak_disabled)?$/i, '').replace(/_disabled$/i, ''))

/** Mods a loadout may hold: not the Project Galacta loader, which every Galacta mod needs on (a loadout switching it
 *  off would break all the others). */
export const loadoutable = (key: string) => !/^!?projectgalacta$/i.test(normKey(key))

/** Stored keys normalized, so loadouts saved before the suffix was dropped still match. */
const keySet = (keys: string[]) => new Set(keys.map(normKey))

export const snapshotLoadout = (base: Pick<Loadout, 'id' | 'name'> & Partial<Loadout>, scopeMods: Mod[], label = 'Other'): Loadout => ({
  ...base,
  label: base.label ?? label, // overwriting keeps the group; the filter text ("all mods") is not a group name
  scope: scopeMods.map(m => modKey(m.path)).filter(loadoutable),
  on: scopeMods.filter(m => m.enabled).map(m => modKey(m.path)).filter(loadoutable),
})

/** Mods to switch so the loadout is on: its own mods that are off. Nothing else changes: other mods and other loadouts
 *  stay as they are (the scope is still saved, unused while loadouts are independent). */
export const changesToTurnOn = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  return mods.filter(m => on.has(modKey(m.path)) && loadoutable(modKey(m.path)) && !m.enabled)
}

/** Mods to flip so the loadout is off: its own mods that are currently on. */
export const changesToTurnOff = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  return mods.filter(m => on.has(modKey(m.path)) && loadoutable(modKey(m.path)) && m.enabled)
}

/** On = every one of its installed mods is on (other mods may be on too). */
export const isActive = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  const mine = mods.filter(m => on.has(modKey(m.path)))
  return mine.length > 0 && mine.every(m => m.enabled)
}

/** The loadout's on list and scope with these mods added (normalized, each once). Pure. */
export const withMods = (l: Pick<Loadout, 'on' | 'scope'>, keys: string[]) => {
  const add = [...new Set(keys.map(normKey))].filter(loadoutable)
  const on = keySet(l.on), scope = keySet(l.scope)
  return { on: [...l.on, ...add.filter(k => !on.has(k))], scope: [...l.scope, ...add.filter(k => !scope.has(k))] }
}

/** Adds a mod to the loadout's on list (and its scope, so the loadout manages it from now on). */
export const addModToLoadout = (l: Loadout, key: string) => patchLoadout(l.id, withMods(l, [key]))

/** Every loadout with oldKey (on and scope) now holding newKey instead, once. Pure. */
export const renameKeyIn = (list: Loadout[], oldKey: string, newKey: string): Loadout[] => {
  const from = normKey(oldKey), to = normKey(newKey)
  const swap = (keys: string[]) => (keys.some(k => normKey(k) === from)
    ? [...new Map(keys.map(k => (normKey(k) === from ? to : k)).map(k => [normKey(k), k])).values()]
    : keys)
  return list.map(l => ({ ...l, on: swap(l.on), scope: swap(l.scope) }))
}
/** A renamed mod stays in its loadouts. */
export const renameModKey = (oldKey: string, newKey: string) => {
  if (normKey(oldKey) !== normKey(newKey)) writeLoadouts(renameKeyIn(readLoadouts(), oldKey, newKey))
}

/** Same mods (on and scope), ignoring order, duplicates and priority suffixes. Pure. */
const memberKey = (keys: string[]) => [...keySet(keys)].sort().join('\n')
export const sameMembership = (a: Pick<Loadout, 'on' | 'scope'>, b: Pick<Loadout, 'on' | 'scope'>) =>
  memberKey(a.on) === memberKey(b.on) && memberKey(a.scope) === memberKey(b.scope)

/** "Loadout N" with the lowest N no loadout uses (any case). Pure. */
export const nextLoadoutName = (names: string[]) => {
  const used = new Set(names.map(n => n.trim().toLowerCase()))
  let n = 1
  while (used.has(`loadout ${n}`)) n++
  return `Loadout ${n}`
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

/** The backend's refusal while Repak X is open (xtra_identity.rs upstream_guard), or null for any other error. */
export const repakXOpen = (e: unknown) => (/^Repak X is open/.test(String(e)) ? String(e) : null)

/** Toggle each mod through the backend; returns the mods that could not be switched, with the reason when Repak X is
 *  open (then the rest are not tried: every one would be refused). */
export const flipMods = async (changes: Mod[]) => {
  const failed: Mod[] & { reason?: string } = []
  for (const [i, m] of changes.entries()) {
    try { await invoke('toggle_mod', { modPath: m.path }) } catch (e) {
      failed.push(m)
      failed.reason = repakXOpen(e) ?? undefined
      if (failed.reason) { failed.push(...changes.slice(i + 1)); break }
    }
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
export const groupKey = (label: string) => (label || '').trim().toLowerCase()

/** Loadout groups are their own ordered list (repakxtra.groups), so a group exists before it holds a loadout and keeps its
 *  place. A loadout's label names its group; OTHER means none and always shows last. */
export const OTHER = 'Other'
const GROUPS = 'repakxtra.groups'
const readGroupList = (): string[] => JSON.parse(savedItem(GROUPS) || '[]')
const writeGroupList = (groups: string[]) => { localStorage.setItem(GROUPS, JSON.stringify(groups)); notify() }

/** Every group in order: the saved list, then labels on loadouts the list lacks (older loadouts, imports). */
export const listGroups = (loadouts = readLoadouts()) => {
  const out = new Map<string, string>()
  const add = (g: string) => { const k = groupKey(g); if (k && k !== groupKey(OTHER) && !out.has(k)) out.set(k, g.trim()) }
  readGroupList().forEach(add)
  loadouts.forEach(l => add(l.label))
  return [...out.values()]
}
export const useGroups = () => {
  useSyncExternalStore(subscribe, () => savedItem(GROUPS) || '')
  return listGroups(useLoadouts())
}
export const inGroup = (l: Loadout, group: string) => groupKey(l.label) === groupKey(group)

/** A new empty group at the end ("New collection", "New collection 2", ...); returns its name. Groups are called
 *  collections in the interface. */
export const addGroup = (name = 'New collection') => {
  const groups = listGroups()
  let n = name.trim() || 'New collection'
  for (let i = 2; groups.some(g => groupKey(g) === groupKey(n)); i++) n = `${name} ${i}`
  writeGroupList([...groups, n])
  return n
}
/** Renames a group on every loadout in it. Renaming onto another group's name merges the two. */
export const renameGroup = (from: string, to: string) => {
  const name = to.trim()
  if (!name || groupKey(name) === groupKey(OTHER)) return
  const groups = listGroups().map(g => (groupKey(g) === groupKey(from) ? name : g))
  writeGroupList([...new Map(groups.map(g => [groupKey(g), g])).values()])
  writeLoadouts(readLoadouts().map(l => (inGroup(l, from) ? { ...l, label: name } : l)))
}
/** Deletes a group; its loadouts move to Other. Returns an undo that puts the group back at its old place among the
 *  groups as they are by then, and its loadouts back in it unless they were given another group meanwhile. */
export const deleteGroup = (name: string) => {
  const order = listGroups()
  const at = order.findIndex(g => groupKey(g) === groupKey(name))
  const moved = readLoadouts().filter(l => inGroup(l, name)).map(l => [l.id, l.label] as const)
  writeGroupList(order.filter(g => groupKey(g) !== groupKey(name)))
  writeLoadouts(readLoadouts().map(l => (inGroup(l, name) ? { ...l, label: OTHER } : l)))
  return () => {
    const back = new Map(moved)
    const now = listGroups().filter(g => groupKey(g) !== groupKey(name))
    now.splice(at < 0 ? now.length : Math.min(at, now.length), 0, at < 0 ? name : order[at])
    writeGroupList(now)
    writeLoadouts(readLoadouts().map(l => (back.has(l.id) && inGroup(l, OTHER) ? { ...l, label: back.get(l.id)! } : l)))
  }
}
export const moveGroup = (name: string, by: -1 | 1) => {
  const groups = listGroups()
  const i = groups.findIndex(g => groupKey(g) === groupKey(name))
  const j = i + by
  if (i < 0 || j < 0 || j >= groups.length) return
  ;[groups[i], groups[j]] = [groups[j], groups[i]]
  writeGroupList(groups)
}
export const setLoadoutGroup = (id: string, group: string) => patchLoadout(id, { label: group.trim() || OTHER })

/** Which main view shows: Home (loadout cards) or Library (the full mod list). Remembered; Home on first start.
 *  Mirrored on <html data-view> so theme.css hides the other view (both stay mounted, keeping their state). */
export type View = 'home' | 'library'
let view: View = savedItem('repakxtra.view') === 'library' ? 'library' : 'home'
const applyView = () => { document.documentElement.dataset.view = view }
applyView()
export const setView = (v: View) => { view = v; localStorage.setItem('repakxtra.view', v); applyView(); notify() }
export const useView = () => useSyncExternalStore(subscribe, () => view)

/** The loadout page open on Home (null = the cards). Shared so the Library sidebar can open one too. `fresh`: a loadout
 *  just made, whose page starts with its name selected for typing. */
let openId: string | null = null
let freshId: string | null = null
export const openLoadout = (id: string | null, fresh = false) => {
  openId = id
  freshId = fresh ? id : null
  if (id && view !== 'home') setView('home'); else notify()
}
/** True once for a loadout opened as fresh. */
export const takeFresh = (id: string) => { const was = freshId === id; if (was) freshId = null; return was }
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
  const L = (on: string[], scope = on): Loadout => ({ id: 'a', name: 'A', label: OTHER, on, scope })
  const [r] = renameKeyIn([L(['Old_9999999_P', 'B'])], 'Old', 'New')
  console.assert(r.on.join() === 'New,B' && r.scope.join() === 'New,B', `renameKeyIn rename: ${r.on}`)
  const [d] = renameKeyIn([L(['Old', 'New_9999999_P'])], 'Old', 'New')
  console.assert(d.on.length === 1 && normKey(d.on[0]) === 'New', `renameKeyIn dedupe: ${d.on}`)
  console.assert(nextLoadoutName(['Loadout 1', 'loadout 3']) === 'Loadout 2', 'nextLoadoutName')
  console.assert(nextLoadoutName([]) === 'Loadout 1', 'nextLoadoutName empty')
  const w = withMods(L(['A'], ['A', 'B']), ['B_9999999_P', 'C', 'C', 'A'])
  console.assert(w.on.join() === 'A,B,C' && w.scope.join() === 'A,B,C', `withMods: ${w.on} / ${w.scope}`)
  console.assert(sameMembership(L(['A', 'B_9999999_P', 'A']), L(['B', 'A'])), 'sameMembership order/suffix/duplicates')
  console.assert(!sameMembership(L(['A']), L(['A', 'C'])) && !sameMembership(L(['A'], ['A']), L(['A'], ['A', 'C'])), 'sameMembership differs')
}

if (import.meta.env.DEV) {
  // The Galacta loader never joins a loadout, whichever way it is added
  console.assert(!loadoutable('!ProjectGalacta_9999999_P') && loadoutable('galactic claw mane proj galacta swappable'), 'loadoutable')
  console.assert(withMods({ on: [], scope: [] }, ['!ProjectGalacta', 'A']).on.join() === 'A', 'withMods skips the Galacta loader')
}
