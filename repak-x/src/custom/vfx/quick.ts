// repakxtra: Update VFX from a right-click (the Library's menu, a loadout page's rows): the VFX Updater's run for one mod,
// right where it is, with no window to open. A toast follows the steps on a progress bar, then a fresh toast says what
// happened (a fresh one, so closing the progress toast never hides a failure); Show report opens the VFX Updater on the
// whole report. It uses the window's choices (Advanced > Names and Originals) and its USMAP, and takes the backend run
// lock (prefs.ts), so it never runs beside the window or beside another right-click update. When the update gets a new
// name, the loadouts that held the original hold it.
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import type { useAlert } from '../../components/AlertHandler'
import { verdictOf, verdictsChanged } from '../brokenMods'
import { modKey, nameKey, renameModKey } from '../loadoutStore'
import { renameSource } from '../nexusSource'
import { readFilter } from './filter'
import { openVfxWindow, sendReport, utocOf } from './handoff'
import { STEPS, fixVfxMod, type VfxReport } from './pipeline'
import { claimRun, newRunToken, readNaming, readOriginals, releaseRun, runLock } from './prefs'

type Alert = ReturnType<typeof useAlert>
let reserved = false // one right-click update at a time in this window, taken before anything is awaited

// the mod a right-click update is working on (its path without the extension, so on and off match): its name shimmers
// in the Library and on loadout pages while the toast follows the steps
let updating: string | null = null
const watchers = new Set<() => void>()
const fileKey = (p: string) => p.replace(/\\/g, '/').replace(/\.[^./]+$/, '').toLowerCase()
const setUpdating = (path: string | null) => { updating = path && fileKey(path); watchers.forEach(f => f()) }
const watch = (f: () => void) => { watchers.add(f); return () => { watchers.delete(f) } }
/** Whether a right-click update is working on the mod at `path` (any of its files). */
export const useVfxUpdating = (path?: string | null) => useSyncExternalStore(watch, () => Boolean(path && updating === fileKey(path)))
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const nameOf = (p: string) => fileName(p).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '')
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Whether the VFX Updater can update a mod: VFX, or any mod with a material instance (MI_*.uasset) or a KO prompt
 *  (WBP_Battle_Kill_*.uasset), as xtra_vfx.rs `updatable` decides (a skin's glow or shine material sorts as Mesh or Texture).
 *  A Needs VFX update flag counts too: the backend finds material instances by class (a UI material named M_..._Inst). */
export const canUpdateVfx = (d?: { category?: string; files?: string[] } | null, path?: string) =>
  d?.category === 'VFX' || Boolean(d?.files?.some(f => /^(mi_|wbp_battle_kill_).*\.uasset$/i.test(fileName(f)))) || (path !== undefined && verdictOf(path)?.kind === 'vfx')

if (import.meta.env.DEV) {
  console.assert(canUpdateVfx({ category: 'VFX' }) && canUpdateVfx({ category: 'Texture', files: ['Marvel\\Content\\X\\mi_Body_Glow.uasset'] }), 'VFX or a material instance')
  console.assert(!canUpdateVfx({ category: 'Texture', files: ['a/T_Body.uasset', 'a/MI_Body.uexp', 'a/Mission_MI_01.bnk'] }) && !canUpdateVfx(undefined), 'no material instance')
  console.assert(canUpdateVfx({ category: 'UI', files: ['Marvel/Content/Marvel/UI/Blueprints/Battle/Custom/1026/WBP_Battle_Kill_1026_V3.uasset'] }), 'a KO prompt')
}

/** The USMAP in use: the one set in the VFX Updater, or the newest from rivals-depot when it has none yet. */
async function findUsmap(): Promise<string | null> {
  const set = await invoke<{ usmapPath?: string | null }>('vfx_get_settings').then(s => s?.usmapPath ?? null).catch(() => null)
  if (set && await invoke<boolean>('vfx_usmap_exists', { path: set }).catch(() => false)) return set
  const r = await invoke<{ localPath?: string | null; skipped?: boolean }>('vfx_check_usmap_update', { force: false }).catch(() => null)
  return r?.localPath && !r.skipped ? r.localPath : null
}

/** Updates one VFX mod in place, with a toast for progress and one for the result. */
export async function updateVfxModInPlace(mod: { path: string; utoc_path?: string | null }, alert: Alert, reload: () => unknown) {
  const name = nameOf(mod.path)
  const open = { label: 'Open VFX Updater', onClick: () => { void openVfxWindow() } }
  const busy = (what?: string | null) => alert.warning(`${name} was not updated`, `${what ? `${what} is` : 'Another mod is'} updating. Try again when it is done.`, { action: open })
  if (reserved) { busy(); return }
  reserved = true // before the first await: a second click finds it taken
  const token = newRunToken()
  let id: number | null = null
  try {
    const paks = await invoke<string | null>('get_game_path').then(d => (d ? d.replace(/[\\/][^\\/]*$/, '') : null)).catch(() => null)
    const usmap = await findUsmap()
    if (!paks || !usmap) {
      alert.warning(`${name} was not updated`, !paks ? 'Set the game folder in Setup first.' : 'There is no USMAP yet. Open the VFX Updater to get one.', { action: open })
      return
    }
    if (!(await claimRun(token, name))) { busy((await runLock())?.name); return }
    setUpdating(mod.path)
    id = alert.showAlert({ color: 'default', title: `Updating ${name}`, description: `${STEPS[0]}…`, isLoading: true, duration: 0, progressValue: 0 })
    const originals = readOriginals(), naming = readNaming()
    const r = await fixVfxMod({
      modPath: mod.utoc_path || utocOf(mod.path), usmapPath: usmap, gamePaksPath: paks, filter: readFilter(),
      keepName: naming === 'broken', turnOffOriginal: originals !== 'keep', trashOriginal: originals === 'trash',
      onStep: s => { if (id !== null) alert.updateToast(id, { description: `Step ${s.step} of ${STEPS.length}: ${s.title}`, progressValue: ((s.step - 0.5) / STEPS.length) * 100 }) },
    })
    if (r.status === 'fixed' && r.placed) {
      // a new name (_UPDATED) moves the loadouts that held the original; with the name kept they already hold the update
      renameModKey(modKey(r.placed.source), modKey(r.placed.fixed))
      renameSource(nameKey(r.placed.source), nameKey(r.placed.fixed), nameKey(r.placed.original)) // its Nexus source on the update and the kept original
      await emit('mods_dir_changed').catch(() => {})
      await reload()
    }
    if (r.status === 'nothing') await verdictsChanged() // its Needs VFX update flag goes (xtra_broken.rs)
    if (id !== null) alert.dismissAlert(id)
    id = null
    resultToast(r, name, alert)
  } finally {
    setUpdating(null)
    if (id !== null) alert.dismissAlert(id)
    await releaseRun(token)
    reserved = false
  }
}

/** The result, as a new toast: Show report keeps every warning and asset one click away (the VFX Updater shows it). */
function resultToast(r: VfxReport, name: string, alert: Alert) {
  const show = { label: 'Show report', onClick: () => { sendReport(r); void openVfxWindow() } }
  if (r.status === 'fixed' && r.placed) {
    const warned = r.warnings.length, left = r.counts.left
    const where = left ? 'The original is off and kept for a full update later.' : r.placed.trashed ? 'The original is in Recently deleted.' : r.placed.turnedOff ? 'The original is off.' : ''
    alert.showAlert({
      color: warned || left ? 'warning' : 'success', duration: warned || left ? 0 : 6000, title: `${left ? 'Partially updated' : 'Updated'} ${name}`, action: show,
      description: [
        r.counts.updated ? `Rebuilt ${plural(r.counts.updated, 'asset')}.` : '',
        left ? `Left out ${plural(left, 'Niagara file')} made for an older game build, so those effects show their usual colors.` : '',
        r.counts.ownGame ? `${plural(r.counts.ownGame, 'Niagara file')} could not be carried and ${r.counts.ownGame === 1 ? 'shows' : 'show'} the game's own colors.` : '',
        where, warned ? `${plural(warned, 'warning')} in the report.` : '',
      ].filter(Boolean).join(' '),
    })
  } else if (r.status === 'nothing') {
    alert.showAlert({ color: 'default', duration: 6000, title: `${name} needs no update`, description: r.error ?? '' })
  } else {
    // a problem is yellow, never red
    alert.showAlert({ color: 'warning', duration: 0, title: `${name} was not updated`, description: r.error ?? 'Something went wrong.', action: show })
  }
}

/** What Check for VFX update found (xtra_vfx_check.rs): the mod's material instances by the game version they were built for. */
export type VfxCheck = { verdict: 'outdated' | 'current' | 'unknown' | 'none'; outdated: string[]; current: string[]; unknown: string[]; oldLayout?: string[]; why?: 'empty' | 'unreadable' | 'elsewhere' | null }

/** Why a check could not tell, for one material and for several, in words that never guess past what it saw. */
const WHY = {
  empty: ['carries no shader data of its own to compare', 'carry no shader data of their own to compare'],
  unreadable: ["could not be compared, since the game's older files could not be read", "could not be compared, since the game's older files could not be read"],
  elsewhere: ['matches no game version (the modder built it)', 'match no game version (the modder built them)'],
} as const

/** Checks one mod's materials against this game version and the earlier ones still in the game (its flag follows). */
export async function checkVfxMod(path: string): Promise<VfxCheck> {
  const usmap = await findUsmap()
  if (!usmap) throw new Error('There is no USMAP yet. Open the VFX Updater to get one.')
  return invoke<VfxCheck>('xtra_vfx_check', { modPath: path, usmapPath: usmap })
}

/** What a check means, in words: a toast's title and text (the VFX Updater's log uses them too). */
export function checkWords(c: VfxCheck, name: string): { title: string; text: string; color: 'warning' | 'success' | 'default' } {
  const all = c.outdated.length + c.current.length + c.unknown.length
  const some = (n: number) => (n === all ? (all === 1 ? 'Its material is' : `All ${all} of its materials are`) : `${n} of its ${all} materials ${n === 1 ? 'is' : 'are'}`)
  const layout = c.oldLayout?.length ?? 0
  if (c.verdict === 'outdated' && layout) return { color: 'warning', title: `${name} needs a VFX update`, text: `${some(layout)} stored in an older game build's layout, which can crash the game. The update rewrites ${layout === 1 ? 'it' : 'them'}.` }
  if (c.verdict === 'outdated') return { color: 'warning', title: `${name} needs a VFX update`, text: `${some(c.outdated.length)} still built for an earlier game version.` }
  if (c.verdict === 'current') return { color: 'success', title: `${name} is up to date`, text: `${all === 1 ? 'Its material is' : `All ${all} of its materials are`} built for this game version.` }
  if (c.verdict === 'unknown') {
    const one = c.unknown.length === 1
    return { color: 'default', title: `Not known if ${name} needs an update`, text: `${one ? 'Its material' : `${c.unknown.length} of its materials`} ${WHY[c.why ?? 'elsewhere'][one ? 0 : 1]}, so its date decides as before.` }
  }
  return { color: 'default', title: `${name} has nothing to check`, text: 'It has no material instances of the game\'s.' }
}

/** Right-click > Check for VFX update: one mod, with a toast while it runs and one for what it found. */
export async function checkVfxModInPlace(mod: { path: string; utoc_path?: string | null }, alert: Alert, reload: () => unknown) {
  const name = nameOf(mod.path)
  const id = alert.showAlert({ color: 'default', title: `Checking ${name}`, description: 'Comparing its materials with this game version and the earlier ones.', isLoading: true, duration: 0 })
  try {
    const c = await checkVfxMod(mod.path)
    alert.dismissAlert(id)
    const w = checkWords(c, name)
    const update = { label: 'Update VFX', onClick: () => { void updateVfxModInPlace(mod, alert, reload) } }
    alert.showAlert({ color: w.color, duration: c.verdict === 'outdated' ? 0 : 6000, title: w.title, description: w.text, action: c.verdict === 'outdated' ? update : undefined })
    await verdictsChanged() // its Needs VFX update flag follows the check
  } catch (e) {
    alert.dismissAlert(id)
    alert.warning(`${name} was not checked`, String(e instanceof Error ? e.message : e))
  }
}

if (import.meta.env.DEV) {
  const said = (unknown: string[], why: VfxCheck['why']) => checkWords({ verdict: 'unknown', outdated: [], current: [], unknown, why }, 'A').text
  console.assert(said(['e'], 'empty') === 'Its material carries no shader data of its own to compare, so its date decides as before.', 'one, no shader data')
  console.assert(said(['a', 'b'], 'elsewhere').startsWith('2 of its materials match no game version (the modder built them)'), 'several, built by the modder')
}
