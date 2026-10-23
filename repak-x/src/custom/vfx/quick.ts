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
import { modKey, renameModKey } from '../loadoutStore'
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
      await emit('mods_dir_changed').catch(() => {})
      await reload()
    }
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
      color: warned || left ? 'warning' : 'success', duration: warned || left ? 0 : 6000, title: `${left ? 'Partly updated' : 'Updated'} ${name}`, action: show,
      description: [
        r.counts.updated ? `Rebuilt ${plural(r.counts.updated, 'asset')}.` : '',
        left ? `Left out ${plural(left, 'Niagara file')} made for an older game build, so those effects show their usual colors.` : '',
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
