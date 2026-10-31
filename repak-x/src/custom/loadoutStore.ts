// repakxtra: saved loadouts, shared by the sidebar list (Loadouts.tsx) and the cards screen
// (LoadoutsScreen.tsx). A loadout is a set of mods: On switches them on, Off switches them off, nothing else is touched.
// It also remembers the mods shown when it was saved (its scope), unused for now. Stored in localStorage.
import { blockedReason } from './safeOff'
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { deleteMedia, sweepOrphanMedia } from './loadoutMedia'
import { savedItem } from './storageCarryOver'
import { isTyping } from './hotkeys'
import { modalOpen } from './dialogFocus'
import { canonKey, isMemberKey, keysByName, memberKey, memberName, movesBetween, nameKey, resolveKeys } from './loadoutIdentity'
export { memberName, nameKey } from './loadoutIdentity'

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
  hotkey?: number         // 1 to 9: Ctrl+N toggles it, set in its page's More menu; unpinned loadouts have no hotkey
  muted?: boolean         // its animation previews play without their emote sound on hover (the card's speaker button)
  caption?: string        // words shown big on its card while it has no picture or preview (typed on its page)
  captionIcon?: string    // a Lucide icon above those words (captionStyle.tsx CAPTION_ICONS)
  captionColor?: string   // their color, one of captionStyle.tsx's swatches; white without one
  captionBackgroundRev?: number
  captionBlur?: boolean
  captionDark?: boolean
  captureRev?: number     // an in-game capture, stored apart from its own image (loadoutMedia.ts under captureKey(id))
  cover?: Cover           // which of its pictures its card shows (the page's Cover switch); unset: the first it has
  edited?: number         // when it was made or last changed by hand (ms), for "most recent first" lists; unset: before this existed
}

/** A card's picture sources. Each keeps its own slot, so making one never replaces another: the card shows the one
 *  picked (cover), or the first it has. */
export type Cover = 'preview' | 'capture' | 'image' | 'text'
export const COVERS: Cover[] = ['preview', 'capture', 'image', 'text']
/** The media key of a loadout's in-game capture (its own image is under its id). */
export const captureKey = (id: string) => `${id}#capture`
export const captionBackgroundKey = (id: string) => `${id}#caption-background`
/** Which sources hold something; `preview` comes from previews.tsx (previewMade). Pure. */
export const coverFills = (l: Loadout, preview: boolean): Record<Cover, boolean> =>
  ({ preview, capture: Boolean(l.captureRev), image: Boolean(l.mediaRev || l.image), text: Boolean(l.caption?.trim() || l.captionIcon || l.captionBackgroundRev) })
/** The source a card shows: the picked one while it holds something, else the first that does (own image first, as
 *  before covers existed), or null for an empty card. Pure. */
export const pickCover = (l: Loadout, fills: Record<Cover, boolean>): Cover | null =>
  l.cover && fills[l.cover] ? l.cover : (['image', 'capture', 'preview', 'text'] as Cover[]).find(c => fills[c]) ?? null

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
  // a loadout new to the list is stamped as just made (a key sync rewriting old ones is not an edit, so they keep theirs)
  const had = new Set(readLoadouts().map(l => l.id)), now = Date.now()
  list = list.map(l => (had.has(l.id) || l.edited ? l : { ...l, edited: now }))
  localStorage.setItem(STORAGE, JSON.stringify(list))
  list.forEach(l => sessionIds.add(l.id))
  notify()
}
/** byHand false: the app changed it on its own (a finished preview showing on its card), so its "edited" time stays. */
export const patchLoadout = (id: string, patch: Partial<Loadout>, byHand = true) =>
  writeLoadouts(readLoadouts().map(l => (l.id === id ? { ...l, ...patch, ...(byHand ? { edited: Date.now() } : {}) } : l)))
/** Most recently made or changed first; ones from before stamps keep their order, after the stamped. Pure. */
export const byRecent = (list: Loadout[]) => [...list].sort((a, b) => (b.edited ?? 0) - (a.edited ?? 0))
/** A deleted loadout, kept 7 days like a deleted mod (Settings > Recently deleted): the whole loadout (its media stays
 *  in IndexedDB under its id), when it was deleted and goes for good (ms), and its place in the list. Stored as
 *  {v: 1, items} under DELETED, a repakxtra.* key, so the dev copy shares it (devStorage.ts). */
export type DeletedLoadout = { loadout: Loadout; deleted: number; expires: number; at: number }
const DELETED = 'repakxtra.deletedLoadouts'
export const KEEP_DELETED_MS = 7 * 24 * 3600 * 1000
type KV = Pick<Storage, 'getItem' | 'setItem'>
const LIVE: KV = { getItem: savedItem, setItem: (k, v) => localStorage.setItem(k, v) }
/** The stored deleted loadouts. Throws on anything unreadable, so nothing deletes, restores or sweeps over it. Pure. */
export const parseDeleted = (json: string | null): DeletedLoadout[] => {
  if (!json) return []
  const v = JSON.parse(json)
  const ok = v?.v === 1 && Array.isArray(v.items) && v.items.every((r: DeletedLoadout) =>
    typeof r?.loadout?.id === 'string' && r.loadout.id && Array.isArray(r.loadout.on) && typeof r.expires === 'number')
  if (!ok) throw new Error('The deleted loadouts list is unreadable')
  return v.items
}
const putDeleted = (store: KV, items: DeletedLoadout[]) => store.setItem(DELETED, JSON.stringify({ v: 1, items }))

/** Delete: the record is written before the loadout leaves the list. A failure before that keeps it live (the caller
 *  says so); a failure in between leaves both, and the live one wins (reconcileDeleted). Throws on failure. */
export function moveToDeleted(store: KV, id: string, now = Date.now()) {
  const list = decode(store.getItem(STORAGE) || '[]'), items = parseDeleted(store.getItem(DELETED))
  const at = list.findIndex(l => l.id === id)
  if (at < 0) return false
  putDeleted(store, [...items.filter(r => r.loadout.id !== id), { loadout: list[at], deleted: now, expires: now + KEEP_DELETED_MS, at }])
  store.setItem(STORAGE, JSON.stringify(list.filter(l => l.id !== id)))
  return true
}

/** What a restore did: unsorted (its collection is gone), lostHotkey (another loadout holds that Ctrl+N now), already
 *  (a live loadout has its id: kept as it is). */
export type Restored = { name: string; unsorted?: boolean; lostHotkey?: number; already?: boolean }
/** Restore: the loadout is written back (at its old place, mods untouched, so missing ones stay missing) before its
 *  record goes, so a failure in between leaves both and the live one wins. Throws on failure; null when not found. */
export function restoreFromDeleted(store: KV, id: string): Restored | null {
  const list = decode(store.getItem(STORAGE) || '[]'), items = parseDeleted(store.getItem(DELETED))
  const rec = items.find(r => r.loadout.id === id)
  if (!rec) return null
  const out: Restored = { name: rec.loadout.name }
  if (list.some(l => l.id === id)) out.already = true
  else {
    let l = rec.loadout
    const groups: string[] = [...JSON.parse(store.getItem(GROUPS) || '[]'), ...list.map(x => x.label)]
    if (groupKey(l.label) !== groupKey(OTHER) && !groups.some(g => groupKey(g) === groupKey(l.label))) { l = { ...l, label: OTHER }; out.unsorted = true }
    if (l.hotkey && list.some(x => x.hotkey === l.hotkey)) { out.lostHotkey = l.hotkey; l = { ...l, hotkey: undefined } }
    const next = [...list]
    next.splice(Math.min(rec.at, next.length), 0, l)
    store.setItem(STORAGE, JSON.stringify(next))
  }
  putDeleted(store, items.filter(r => r !== rec))
  return out
}

/** Drops expired records and copies of live loadouts (an interrupted delete or restore); returns the records kept.
 *  Writes only when something changed. Throws when unreadable. */
export function reconcileDeleted(store: KV, now = Date.now()) {
  const live = new Set(decode(store.getItem(STORAGE) || '[]').map(l => l.id)), items = parseDeleted(store.getItem(DELETED))
  const kept = items.filter(r => r.expires > now && !live.has(r.loadout.id))
  if (kept.length !== items.length) putDeleted(store, kept)
  return kept
}

/** Removes the loadout, keeping it 7 days in Recently deleted; returns the Undo (the same restore). Throws, leaving
 *  the loadout as it was, when it cannot be kept (storage full, unreadable record list). */
export const deleteLoadout = (id: string) => {
  try { moveToDeleted(LIVE, id) } finally { notify() }
  return () => restoreLoadout(id)
}
export const restoreLoadout = (id: string) => {
  try { return restoreFromDeleted(LIVE, id) } finally { sessionIds.add(id); notify() }
}
/** Delete for good: the records go, then their media (a live loadout's own media stays). */
export function forgetDeleted(ids: string[]) {
  const items = parseDeleted(LIVE.getItem(DELETED)), live = new Set(readLoadouts().map(l => l.id))
  try { putDeleted(LIVE, items.filter(r => !ids.includes(r.loadout.id))) } finally { notify() }
  for (const id of ids.filter(i => !live.has(i))) { deleteMedia(id); deleteMedia(captureKey(id)); deleteMedia(captionBackgroundKey(id)) }
}
/** Deleted loadouts not expired and not live, newest first; null while the list is unreadable. */
export const useDeletedLoadouts = (): DeletedLoadout[] | null => {
  const json = useSyncExternalStore(subscribe, () => savedItem(DELETED))
  const live = new Set(useLoadouts().map(l => l.id))
  try {
    const now = Date.now()
    return parseDeleted(json).filter(r => r.expires > now && !live.has(r.loadout.id)).sort((a, b) => b.deleted - a.deleted)
  } catch { return null }
}

/** The list decoded once per save, and each loadout the same object while its own data stays the same: every card is a
 *  memo keyed on its loadout, so decoding on each render redrew all of them on every step of a card drag (20 fps). */
let shared: { json: string; list: Loadout[]; each: Map<string, [string, Loadout]> } | null = null
export const useLoadouts = (): Loadout[] => {
  const json = useSyncExternalStore(subscribe, () => savedItem(STORAGE) || '[]')
  if (shared?.json !== json) {
    const each = new Map<string, [string, Loadout]>()
    const list = decode(json).map(l => {
      const text = JSON.stringify(l), was = shared?.each.get(l.id)
      const kept = was && was[0] === text ? was[1] : l
      each.set(l.id, [text, kept])
      return kept
    })
    shared = { json, list, each }
  }
  return shared.list
}

/** The loadouts holding each mod (by canonKey), built once per change of the saved list: every Library row reads it. */
let holders: { json: string; by: Map<string, { id: string; name: string }[]> } | null = null
const NONE: { id: string; name: string }[] = []
/** The loadouts that turn the mod at `path` on, in their saved order. */
export function useLoadoutsHolding(path: string) {
  const json = useSyncExternalStore(subscribe, () => savedItem(STORAGE) || '[]')
  if (holders?.json !== json) {
    const by = new Map<string, { id: string; name: string }[]>()
    for (const l of decode(json)) for (const k of new Set(l.on.map(canonKey))) by.set(k, [...(by.get(k) ?? []), { id: l.id, name: l.name }])
    holders = { json, by }
  }
  return holders.by.get(canonKey(memberKey(path))) ?? NONE
}

let swept = false
/** Once per start, from Home (the main window only): deletes stored media whose loadout no longer exists, live or in
 *  Recently deleted (expired records go first). The ids are read before anything is awaited and the set stays live,
 *  so loadouts made or deleted meanwhile keep their media. Anything unreadable skips the cleanup rather than counting
 *  as "no loadouts". */
export function sweepMediaOnce() {
  if (swept) return
  swept = true
  try {
    const list: unknown = JSON.parse(savedItem(STORAGE) || '[]')
    if (!Array.isArray(list) || !list.every(l => typeof l?.id === 'string' && l.id)) return
    list.forEach(l => sessionIds.add(l.id))
    reconcileDeleted(LIVE).forEach(r => sessionIds.add(r.loadout.id))
  } catch {
    return
  }
  sweepOrphanMedia(sessionIds).catch(e => console.warn('Loadout media sweep skipped:', e))
}

let lastKeys: string[] | null = null
const BACKUP = 'repakxtra.loadouts.backupV1'
const hasLegacy = (l: Loadout) => [...l.on, ...l.scope].some(k => !isMemberKey(k))
/** App calls this with each fresh mod list, before showing it. Saved members (live and deleted loadouts) follow mods
 *  moved to another folder since the last list, and legacy name-only members with exactly one installed match become
 *  member keys (loadoutIdentity.ts resolveKeys). Before the first legacy member changes, the list is copied once to
 *  BACKUP (without inline images, which stay in the list). Data from an older copy (devStorage.ts) is migrated again
 *  on its next list, and that write is the newest save. An empty list (a failed scan) changes nothing. */
export function syncLoadoutKeys(mods: Mod[]) {
  const keys = mods.map(m => modKey(m.path))
  const moved = lastKeys ? movesBetween(lastKeys, keys) : new Map<string, string>()
  lastKeys = keys
  if (!keys.length) return
  const byName = keysByName(keys)
  try {
    const list = readLoadouts(), next = list.map(l => resolveKeys(l, byName, moved))
    if (next.some((l, i) => l !== list[i])) {
      if (list.some(hasLegacy) && !localStorage.getItem(BACKUP)) localStorage.setItem(BACKUP, JSON.stringify(list.map(l => ({ ...l, image: undefined }))))
      writeLoadouts(next)
    }
    const items = parseDeleted(LIVE.getItem(DELETED))
    const fixed = items.map(r => { const l = resolveKeys(r.loadout, byName, moved); return l === r.loadout ? r : { ...r, loadout: l } })
    if (fixed.some((r, i) => r !== items[i])) { putDeleted(LIVE, fixed); notify() }
  } catch (e) {
    console.warn('Loadout members not updated:', e) // left as they were; the next list tries again
  }
}

/** A stored key in its one spelling (loadoutIdentity.ts canonKey): what modKey gives for the same mod. */
const normKey = canonKey

/** The loadout member key of a mod path (loadoutIdentity.ts): its folder and name, the same through on/off and every
 *  priority. Display names and preview keys use nameKey. */
export const modKey = memberKey

const byKeyCache = new WeakMap<Mod[], Map<string, Mod>>()
/** The mods by modKey, built once per mods list (each card, slide and page made its own copy on every render). */
export const modsByKey = (mods: Mod[]) => {
  let m = byKeyCache.get(mods)
  if (!m) byKeyCache.set(mods, (m = new Map(mods.map(x => [modKey(x.path), x]))))
  return m
}

/** Mods a loadout may hold: not the Project Galacta loader, which every mod made for it needs on (a loadout switching
 *  it off would break all the others), and which Setup manages. An optional _digits and an optional _P, each on its own.
 *  Other loaders (Project Sigeon) are ordinary mods here. */
export const loadoutable = (key: string) => !/^!?projectgalacta(_\d+)?(_p)?$/i.test(memberName(key))

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

/** On = every one of its installed mods is on (other mods may be on too). A loader saved in an older loadout does not
 *  count: switching the loadout never touches it. */
export const isActive = (l: Loadout, mods: Mod[]) => {
  const on = keySet(l.on)
  const mine = mods.filter(m => on.has(modKey(m.path)) && loadoutable(modKey(m.path)))
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
  if (normKey(oldKey) === normKey(newKey)) return
  writeLoadouts(renameKeyIn(readLoadouts(), oldKey, newKey))
  try { // and in Recently deleted, so a restored loadout still finds it
    const items = parseDeleted(LIVE.getItem(DELETED))
    const moved = renameKeyIn(items.map(r => r.loadout), oldKey, newKey)
    putDeleted(LIVE, items.map((r, i) => ({ ...r, loadout: moved[i] })))
  } catch (e) { console.warn('Deleted loadouts not renamed:', e) }
}
/** The user's pick for a member that is ambiguous or no longer found: that installed mod from now on (on and scope). */
export const pickMember = (l: Loadout, oldKey: string, newKey: string) => {
  const [next] = renameKeyIn([l], oldKey, newKey)
  patchLoadout(l.id, { on: next.on, scope: next.scope })
}

/** Same mods (on and scope), ignoring order, duplicates and priority suffixes. Pure. */
const membersSig = (keys: string[]) => [...keySet(keys)].sort().join('\n')
export const sameMembership = (a: Pick<Loadout, 'on' | 'scope'>, b: Pick<Loadout, 'on' | 'scope'>) =>
  membersSig(a.on) === membersSig(b.on) && membersSig(a.scope) === membersSig(b.scope)

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
  const m = memberName(key).match(/^(.*)_v(\d+)$/i)
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
    on: [...new Set(l.on.map(k => (normKey(k) === normKey(oldKey) ? normKey(newKey) : k)))],
    scope: keySet(l.scope).has(normKey(newKey)) ? l.scope : [...l.scope, normKey(newKey)],
  })

/** A stored key in the spelling modKey gives, for matching (LoadoutsScreen.tsx). Text shows memberName. */
export const displayName = normKey

/** The backend's refusal while Repak X is open (xtra_identity.rs upstream_guard), or null for any other error. */
export const repakXOpen = (e: unknown) => (/^Repak X is open/.test(String(e)) ? String(e) : null)

/** Toggle each mod through the backend; returns the mods that could not be switched, with the reason when Repak X is
 *  open (then the rest are not tried: every one would be refused). */
export const flipMods = async (changes: Mod[]) => {
  const failed: Mod[] & { reason?: string; keptOff?: { path: string; reason: string }[] } = []
  for (const [i, m] of changes.entries()) {
    try { await invoke('toggle_mod', { modPath: m.path }) } catch (e) {
      // turned off because it can crash the game (custom/safeOff.ts): kept off, said apart from the failures
      const why = blockedReason(e)
      if (why) {
        // not switched: a failure to every caller (none reports it switched), its reason kept for Turn on anyway
        (failed.keptOff ??= []).push({ path: m.path, reason: why })
        failed.push(m)
        continue
      }
      failed.push(m)
      failed.reason = repakXOpen(e) ?? undefined
      if (failed.reason) { failed.push(...changes.slice(i + 1)); break }
    }
  }
  return failed
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
/** What the interface calls OTHER, the loadouts in no collection (cable, 2026-10-21). The stored value stays 'Other'. */
export const OTHER_LABEL = 'Unsorted'
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
/** Drag and drop on Home: the list with the loadout moved into `group`, before or after another loadout (`beside`), or
 *  after the group's last one. Pure (placeLoadout writes it). */
export const placed = (list: Loadout[], id: string, group: string, beside?: { id: string; after: boolean }) => {
  const from = list.findIndex(l => l.id === id)
  if (from < 0 || beside?.id === id) return list
  const rest = list.filter(l => l.id !== id)
  const label = group.trim() || OTHER
  // the same object while its collection stays, so its card (memo) does not redraw on every move of a drag
  const moved = list[from].label === label ? list[from] : { ...list[from], label }
  let at = beside ? rest.findIndex(l => l.id === beside.id) : -1
  if (at >= 0) at += beside!.after ? 1 : 0
  else { const last = rest.map(l => inGroup(l, moved.label)).lastIndexOf(true); at = last >= 0 ? last + 1 : rest.length }
  return [...rest.slice(0, at), moved, ...rest.slice(at)]
}
/** The Hero view's drag: the loadout moved before or after another one, its collection kept. Pure. */
export const movedBeside = (list: Loadout[], id: string, beside?: { id: string; after: boolean }) => {
  const from = list.findIndex(l => l.id === id)
  if (from < 0 || !beside || beside.id === id) return list
  const rest = list.filter(l => l.id !== id)
  const at = rest.findIndex(l => l.id === beside.id)
  if (at < 0) return list
  const to = at + (beside.after ? 1 : 0)
  return [...rest.slice(0, to), list[from], ...rest.slice(to)]
}
export const moveLoadout = (id: string, beside?: { id: string; after: boolean }) => {
  const list = readLoadouts(), next = movedBeside(list, id, beside)
  if (next !== list) writeLoadouts(next)
}
export const placeLoadout = (id: string, group: string, beside?: { id: string; after: boolean }) => {
  const list = readLoadouts(), next = placed(list, id, group, beside)
  if (next === list) return
  // dropped into another collection is an edit (a new place in the same one is only arranging)
  const moved = list.find(l => l.id === id)?.label !== next.find(l => l.id === id)?.label
  writeLoadouts(moved ? next.map(l => (l.id === id ? { ...l, edited: Date.now() } : l)) : next)
}

/** Ctrl+1..9: each pinned number to its loadout. Only pins count, wherever the loadout sits. A number two loadouts hold
 *  (a deleted one put back by Undo after its slot was given away) goes to the first. Pure. */
export const hotkeySlots = (list: Loadout[]) => {
  const out = new Map<number, Loadout>()
  for (const l of list) if (l.hotkey && !out.has(l.hotkey)) out.set(l.hotkey, l)
  return out
}
/** The number that toggles this loadout, or undefined. */
export const hotkeyOf = (l: Loadout, list: Loadout[]) => (l.hotkey && hotkeySlots(list).get(l.hotkey)?.id === l.id ? l.hotkey : undefined)
/** The list with the loadout pinned to Ctrl+n (0: no hotkey); a loadout that held n loses it. Pure. */
export const withHotkey = (list: Loadout[], id: string, n: number) =>
  list.map(l => (l.id === id ? { ...l, hotkey: n || undefined } : n && l.hotkey === n ? { ...l, hotkey: undefined } : l))
export const pinHotkey = (id: string, n: number) => writeLoadouts(withHotkey(readLoadouts(), id, n))

// Before pins, Ctrl+N toggled the Nth loadout in the list: once, the first nine keep those numbers as pins
if (!localStorage.getItem('repakxtra.hotkeysPinned')) {
  try {
    const list = readLoadouts()
    if (list.length && !list.some(l => l.hotkey)) writeLoadouts(list.map((l, i) => (i < 9 ? { ...l, hotkey: i + 1 } : l)))
    localStorage.setItem('repakxtra.hotkeysPinned', '1')
  } catch (e) {
    console.warn('Hotkey pins not carried over:', e) // unreadable list: left as it is, tried again next start
  }
}

/** Which main view shows: Home (loadout cards) or Library (the full mod list). Remembered; Home on first start.
 *  Mirrored on <html data-view> so theme.css hides the other view (both stay mounted, keeping their state). */
export type View = 'home' | 'library' | 'nexus'
const savedView = savedItem('repakxtra.view')
let view: View = savedView === 'library' || savedView === 'nexus' ? savedView : 'home'
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
/** The loadout page showing right now, or null (the cards, or the Library). */
export const openLoadoutId = () => (view === 'home' ? openId : null)

// L switches between Home and Library. This module also loads in the Asset Explorer and VFX Updater windows, which
// have no Home: only the window showing the Home | Library tabs reacts
window.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'l' || e.ctrlKey || e.altKey || e.metaKey || isTyping(e.target)) return
  if (!document.querySelector('.view-tabs')) return
  if (modalOpen()) return // Settings, Sharing or another dialog is open
  e.preventDefault()
  setView(view === 'home' ? 'library' : 'home')
})

if (import.meta.env.DEV) {
  console.assert(['C:/g/~mods/!ProjectGalacta_9999999_P.pak', 'C:/g/~mods/!ProjectGalacta_9999999_P.bak_repak'].every(x => !loadoutable(modKey(x)))
    && loadoutable(modKey('C:/g/~mods/!ProjectSigeon_9999999_P.pak')) && loadoutable(modKey('C:/g/~mods/ProjectGalactaFan_9999999_P.pak')),
    'loadoutable: not the Galacta loader, other mods and other loaders yes')
  console.assert(['ProjectGalacta_P', 'ProjectGalacta_12', '!ProjectGalacta_3_P'].every(n => !loadoutable(modKey(`C:/g/~mods/${n}.pak`)))
    && loadoutable(modKey('C:/g/~mods/ProjectGalacta_Compat_P.pak')), 'loadoutable: the Galacta loader names only')
  {
    const mod = (name: string, enabled: boolean) => ({ path: `C:/g/~mods/${name}.pak`, enabled }) as Mod
    const old: Loadout = { id: 'x', name: 'x', label: 'Other', scope: [], on: [modKey('C:/g/~mods/!ProjectGalacta_9999999_P.pak'), modKey('C:/g/~mods/Skin.pak')] }
    console.assert(isActive(old, [mod('!ProjectGalacta_9999999_P', false), mod('Skin', true)]), 'isActive: a loader saved in an old loadout does not count')
  }
  const base: Loadout = { id: 'a', name: 'a', label: 'Other', scope: [], on: [] }
  console.assert(byRecent([{ ...base, id: 'old' }, { ...base, id: 'b', edited: 1 }, { ...base, id: 'c', edited: 2 }, { ...base, id: 'old2' }]).map(l => l.id).join() === 'c,b,old,old2',
    'byRecent: newest first, unstamped after in their order')
  console.assert(pickCover({ ...base, cover: 'text', caption: 'Hi', mediaRev: 1 }, coverFills({ ...base, caption: 'Hi', mediaRev: 1 }, true)) === 'text', 'pickCover: the picked source wins')
  console.assert(pickCover({ ...base, cover: 'capture', mediaRev: 1 }, coverFills({ ...base, mediaRev: 1 }, true)) === 'image', 'pickCover: an empty pick falls back, own image first')
  console.assert(pickCover(base, coverFills(base, false)) === null, 'pickCover: nothing to show')
  { const L = (id: string, label = 'Other') => ({ id, name: id, label, scope: [], on: [] })
    const list = [L('a', 'X'), L('b'), L('c', 'Y'), L('d')]
    console.assert(movedBeside(list, 'd', { id: 'b', after: false }).map(l => l.id).join() === 'a,d,b,c', 'hero drag: moves before its neighbour')
    console.assert(movedBeside(list, 'a', { id: 'd', after: true }).map(l => l.label).join() === 'Other,Y,Other,X', 'hero drag: collections kept') }
  { // drag and drop on Home
    const L = (id: string, label: string) => ({ id, name: id, label, scope: [], on: [] }) as Loadout
    const order = (xs: Loadout[]) => xs.map(x => `${x.id}:${x.label}`).join()
    const base = [L('a', 'G'), L('b', 'G'), L('c', 'H'), L('d', 'G')]
    console.assert(order(placed(base, 'd', 'G', { id: 'a', after: false })) === 'd:G,a:G,b:G,c:H', 'reorder before a card')
    console.assert(order(placed(base, 'a', 'H', { id: 'c', after: true })) === 'b:G,c:H,a:H,d:G', 'into another collection after a card')
    console.assert(order(placed(base, 'c', 'G')) === 'a:G,b:G,d:G,c:G', 'dropped on a collection: after its last loadout')
    console.assert(placed(base, 'a', 'G', { id: 'a', after: true }) === base, 'dropped on itself: unchanged')
  }
  { // hotkey pins
    const L = (id: string, hotkey?: number) => ({ id, name: id, label: OTHER, scope: [], on: [], hotkey }) as Loadout
    const pins = (xs: Loadout[]) => xs.map(x => `${x.id}${x.hotkey ?? '-'}`).join()
    const base = [L('a', 3), L('b'), L('c', 1)]
    console.assert(hotkeySlots(base).get(3)?.id === 'a' && !hotkeySlots(base).has(2), 'only pins hold a number, wherever they sit')
    console.assert(pins(withHotkey(base, 'b', 3)) === 'a-,b3,c1', 'pinning a taken number moves it')
    console.assert(pins(withHotkey(base, 'a', 0)) === 'a-,b-,c1', 'unpin')
    const twice = [L('a', 2), L('b', 2)]
    console.assert(hotkeyOf(twice[0], twice) === 2 && hotkeyOf(twice[1], twice) === undefined, 'a doubled number goes to the first')
  }
  // The name rule behind every key, whatever state the file is in (mod_previews.py mod_key must agree with nameKey);
  // the member key adds the folder (here the mods folder itself)
  for (const [path, key] of [['C:/m/~mods/X_9999999_P.pak', 'X'], ['X_9999999_P.bak_repak', 'X'], ['X_9999999_P.pak.bak_repak', 'X'],
    ['X_9999999_P.pak_disabled', 'X'], ['X_disabled', 'X'], ['bp-lime-vfx_vfx_noPG_v2_9999999_P.pak', 'bp-lime-vfx_vfx_noPG_v2'], ['B_P.pak', 'B_P']])
    console.assert(nameKey(path) === key && modKey(path) === `|${key}`, `nameKey(${path}) = ${nameKey(path)}, modKey ${modKey(path)}, expected ${key}`)
  { // a member key survives priority 1 -> 0 -> 1, and same-named mods in two folders are two mods
    const at = (p: string, enabled = true): Mod => ({ path: `C:/G/~mods/${p}`, enabled })
    const lo: Loadout = { id: 's', name: 'S', label: OTHER, ...withMods({ on: [], scope: [] }, [modKey(at('A/Skin_9999999_P.pak').path)]) }
    console.assert(changesToTurnOn(lo, [at('A/!Skin.pak', false), at('B/!Skin.pak', false)]).map(m => m.path).join() === 'C:/G/~mods/A/!Skin.pak', 'priority 0 is the same mod, the other folder is not')
    console.assert(isActive(lo, [at('A/Skin_9999999_P.pak'), at('B/Skin_9999999_P.pak', false)]), 'back at priority 1: still the one mod')
    console.assert(changesToTurnOn({ ...lo, on: ['Skin'] }, [at('A/Skin.pak', false), at('B/Skin.pak', false)]).length === 0, 'an unresolved legacy name switches nothing')
    const picked = renameKeyIn([{ ...lo, on: ['Skin'], scope: ['Skin'] }], 'Skin', 'b|Skin')[0]
    console.assert(picked.on.join() === 'b|Skin' && picked.scope.join() === 'b|Skin', 'picking a member swaps on and scope')
  }
  { // deleted loadouts: write order, failures, expiry and restore collisions, on a stand-in store
    const fake = (data: Record<string, string>, failOn?: string): KV & { data: Record<string, string> } => ({
      data, getItem: k => data[k] ?? null, setItem: (k, v) => { if (k === failOn) throw new Error('full'); data[k] = v },
    })
    const L2 = (id: string, extra: Partial<Loadout> = {}): Loadout => ({ id, name: id, label: OTHER, on: ['|M'], scope: ['|M'], ...extra })
    const ids = (s: KV) => decode(s.getItem(STORAGE) || '[]').map(l => l.id).join()
    const kept = (s: KV) => parseDeleted(s.getItem(DELETED)).map(r => r.loadout.id).join()
    const full = fake({ [STORAGE]: JSON.stringify([L2('a'), L2('b')]) }, DELETED)
    let threw = false
    try { moveToDeleted(full, 'a') } catch { threw = true }
    console.assert(threw && ids(full) === 'a,b', 'no room for the record: the loadout stays live')
    const half = fake({ [STORAGE]: JSON.stringify([L2('a'), L2('b')]) }, STORAGE)
    try { moveToDeleted(half, 'a') } catch { /* the second write failed */ }
    console.assert(ids(half) === 'a,b' && kept(half) === 'a' && reconcileDeleted(half).length === 0 && kept(half) === '', 'interrupted delete: the live one wins, its copy goes')
    const s = fake({ [STORAGE]: JSON.stringify([L2('a', { hotkey: 2, label: 'Gone' }), L2('b'), L2('c')]), [GROUPS]: '["Kept"]' })
    moveToDeleted(s, 'a', 1000)
    console.assert(ids(s) === 'b,c' && kept(s) === 'a', 'delete keeps a record')
    s.setItem(STORAGE, JSON.stringify([L2('b', { hotkey: 2 }), L2('c')]))
    const r = restoreFromDeleted(s, 'a')
    const back = decode(s.getItem(STORAGE)!)
    console.assert(r?.unsorted && r.lostHotkey === 2 && back[0].id === 'a' && back[0].label === OTHER && !back[0].hotkey && back[1].hotkey === 2 && kept(s) === '', 'restore: old place, Unsorted when its collection is gone, no hotkey stealing')
    console.assert(back[0].on.join() === '|M' && restoreFromDeleted(s, 'a') === null, 'members untouched, a second restore is a no-op')
    moveToDeleted(s, 'c', 1000)
    s.setItem(STORAGE, JSON.stringify([...decode(s.getItem(STORAGE)!), L2('c', { name: 'new c' })]))
    const dup = restoreFromDeleted(s, 'c')
    console.assert(dup?.already === true && decode(s.getItem(STORAGE)!).filter(l => l.id === 'c').map(l => l.name).join() === 'new c' && kept(s) === '', 'duplicate id: the live loadout is kept')
    moveToDeleted(s, 'b', 1000)
    console.assert(reconcileDeleted(s, 1000 + KEEP_DELETED_MS - 1).length === 1 && reconcileDeleted(s, 1000 + KEEP_DELETED_MS).length === 0 && kept(s) === '', 'records expire after 7 days')
    const bad = fake({ [STORAGE]: '[]', [DELETED]: '{"v":1,"items":[{}]}' })
    threw = false
    try { reconcileDeleted(bad) } catch { threw = true }
    console.assert(threw, 'an unreadable record list stops the cleanup')
  }
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
