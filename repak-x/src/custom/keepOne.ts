// repakxtra: Keep this one (conflicts screen) and crash suspects' Turn off selected. Turns mods off all or none: when a
// switch is refused (the game or Repak X is open) the ones already switched go back. The toast's Undo turns them on
// again.
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'
import { displayName, flipMods, modKey } from './loadoutStore'
import { plural } from './modName'

type Mod = { path: string; enabled?: boolean }
export type KeepDeps = { alert: ReturnType<typeof useAlert>; isBlocked: () => boolean; reload: () => Promise<unknown> }

/** A mod's path without its on/off extension: the same mod before and after a switch. */
const stem = (p: string) => p.replace(/\.(pak|bak_repak|pak_disabled)$/i, '').toLowerCase()
const name = (p: string) => displayName(modKey(p))
export const GAME_RUNNING = ['Game Running', 'Cannot toggle mods while game is running.'] as const

/** Switches every mod in `mods`; if any is refused, switches the done ones back and returns the refusal. */
async function flipAll(mods: Mod[]) {
  const failed = await flipMods(mods)
  if (!failed.length) return null
  // The switched ones have a new extension now: found again by stem in a fresh list
  const done = new Map(mods.filter(m => !failed.includes(m)).map(m => [stem(m.path), m.enabled !== false]))
  if (done.size) {
    const now = await invoke<Mod[]>('get_pak_files').catch(() => [] as Mod[])
    await flipMods(now.filter(m => done.has(stem(m.path)) && (m.enabled !== false) !== done.get(stem(m.path))))
  }
  return failed.reason ?? `Could not switch ${failed.map(m => name(m.path)).join(', ')}. Close anything using those files, then try again.`
}

/** Turns these mods off (all or none) and shows `title` with an Undo that turns them on again. False when nothing
 *  changed (the game is running, or a switch was refused: both are said in a toast). */
export async function turnOffWithUndo(d: KeepDeps, mods: Mod[], title: string, text: string) {
  const off = mods.filter(m => m.enabled !== false)
  if (!off.length) return false
  if (d.isBlocked()) { d.alert.warning(...GAME_RUNNING); return false }
  const refused = await flipAll(off)
  await d.reload()
  if (refused) { d.alert.warning('Nothing changed', refused); return false }
  const stems = new Set(off.map(m => stem(m.path)))
  const id = d.alert.success(title, text, {
    duration: 10000,
    action: {
      label: 'Undo', onClick: async () => {
        if (d.isBlocked()) { d.alert.warning('Game Running', 'Undo waits until the game is closed.'); return }
        let now: Mod[]
        try { now = await invoke<Mod[]>('get_pak_files') } catch (e) { d.alert.warning('Undo not possible yet', `The mod list could not be read: ${String(e)}`); return }
        d.alert.dismissAlert(id)
        const back = now.filter(m => stems.has(stem(m.path)) && !m.enabled)
        if (!back.length) return
        const again = await flipAll(back)
        await d.reload()
        if (again) d.alert.warning('Not undone', again)
      },
    },
  })
  return true
}

export function keepThisOne(d: KeepDeps, keep: string, others: Mod[]) {
  const off = others.filter(m => m.enabled !== false)
  return turnOffWithUndo(d, off, `Kept ${name(keep)}`, `Turned off ${off.length === 1 ? name(off[0].path) : plural(off.length, 'other mod')}.`)
}
