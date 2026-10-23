// repakxtra: Update VFX from a right-click (the Library's menu, a loadout page's rows): the VFX Updater's run for one mod,
// right where it is, with no window to open. A toast follows the steps on a progress bar and ends with what happened.
// It uses the window's choices (Advanced > Names and Originals) and its USMAP, and holds the same lock (prefs.ts), so
// it never runs beside the window. When the update gets a new name, the loadouts that held the original hold it.
import { invoke } from '@tauri-apps/api/core'
import { emit } from '@tauri-apps/api/event'
import type { useAlert } from '../../components/AlertHandler'
import { modKey, renameModKey } from '../loadoutStore'
import { readFilter } from './filter'
import { openVfxWindow, utocOf } from './handoff'
import { STEPS, fixVfxMod } from './pipeline'
import { claimRun, readNaming, readOriginals, releaseRun, runningElsewhere } from './prefs'

type Alert = ReturnType<typeof useAlert>
const OWNER = `main-${Math.random().toString(36).slice(2, 8)}`
const running = new Set<string>() // mods updating from here now
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const nameOf = (p: string) => fileName(p).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '')

/** The USMAP in use: the one set in the VFX Updater, or the newest from rivals-depot when it has none yet. */
async function findUsmap(): Promise<string | null> {
  const set = await invoke<{ usmapPath?: string | null }>('vfx_get_settings').then(s => s?.usmapPath ?? null).catch(() => null)
  if (set && await invoke<boolean>('vfx_usmap_exists', { path: set }).catch(() => false)) return set
  const r = await invoke<{ localPath?: string | null; skipped?: boolean }>('vfx_check_usmap_update', { force: false }).catch(() => null)
  return r?.localPath && !r.skipped ? r.localPath : null
}

/** Updates one VFX mod in place, with a toast for progress and the result. */
export async function updateVfxModInPlace(mod: { path: string; utoc_path?: string | null }, alert: Alert, reload: () => unknown) {
  const name = nameOf(mod.path)
  const utoc = mod.utoc_path || utocOf(mod.path)
  if (running.has(utoc)) return
  const open = { label: 'Open VFX Updater', onClick: () => { void openVfxWindow() } }
  const busy = runningElsewhere(OWNER)
  if (busy || running.size) {
    alert.warning(`${name} was not updated`, `The VFX Updater is updating ${busy?.name ?? 'another mod'}. Try again when it is done.`, { action: open })
    return
  }
  const paks = await invoke<string | null>('get_game_path').then(d => (d ? d.replace(/[\\/][^\\/]*$/, '') : null)).catch(() => null)
  const usmap = await findUsmap()
  if (!paks || !usmap) {
    alert.warning(`${name} was not updated`, !paks ? 'Set the game folder in Setup first.' : 'There is no USMAP yet. Open the VFX Updater to get one.', { action: open })
    return
  }
  if (!claimRun(OWNER, name)) return
  running.add(utoc)
  const id = alert.showAlert({ color: 'default', title: `Updating ${name}`, description: `${STEPS[0]}…`, isLoading: true, duration: 0, progressValue: 0 })
  const originals = readOriginals(), naming = readNaming()
  try {
    const r = await fixVfxMod({
      modPath: utoc, usmapPath: usmap, gamePaksPath: paks, filter: readFilter(),
      keepName: naming === 'broken', turnOffOriginal: originals !== 'keep', trashOriginal: originals === 'trash',
      onStep: s => {
        claimRun(OWNER, name) // renew the lock at each step
        alert.updateToast(id, { description: `Step ${s.step} of ${STEPS.length}: ${s.title}`, progressValue: ((s.step - 0.5) / STEPS.length) * 100 })
      },
    })
    if (r.status === 'fixed' && r.placed) {
      // a new name (_UPDATED) moves the loadouts that held the original; with the name kept they already hold the update
      renameModKey(modKey(r.placed.original), modKey(r.placed.fixed))
      await emit('mods_dir_changed').catch(() => {})
      await reload()
      const where = r.placed.trashed ? 'The original is in Recently deleted.' : r.placed.turnedOff ? 'The original is off.' : ''
      alert.updateToast(id, {
        color: r.warnings.length ? 'warning' : 'success', isLoading: false, progressValue: undefined, duration: 6000,
        title: `Updated ${name}`, description: [`Rebuilt ${r.counts.updated} of its assets.`, where, r.placed.warning ?? ''].filter(Boolean).join(' '),
      })
    } else if (r.status === 'nothing') {
      alert.updateToast(id, { color: 'default', isLoading: false, progressValue: undefined, duration: 6000, title: `${name} needs no update`, description: r.error ?? '' })
    } else {
      // a problem is yellow, never red: Open VFX Updater shows the report
      alert.updateToast(id, { color: 'warning', isLoading: false, progressValue: undefined, duration: 0, title: `${name} was not updated`, description: r.error ?? 'Something went wrong.', action: open })
    }
  } finally {
    running.delete(utoc)
    releaseRun(OWNER)
  }
}
