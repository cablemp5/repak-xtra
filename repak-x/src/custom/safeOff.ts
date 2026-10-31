// repakxtra: a mod the Mod Updater turned off because it can crash the game stays off (xtra_safe_off.rs): toggle_mod
// refuses to turn it on and says why. The Library, its bulk switch and loadouts show that with Turn on anyway.
import { invoke } from '@tauri-apps/api/core'
import type { useAlert } from '../components/AlertHandler'

const MARK = 'SAFE_OFF|'

/** Why toggle_mod kept a mod off, when that is what its error says. */
export const blockedReason = (e: unknown) => {
  const s = String(e instanceof Error ? e.message : e)
  const i = s.indexOf(MARK)
  return i < 0 ? null : s.slice(i + MARK.length)
}

/** Turns the mods at `paths` on although they can crash the game (the user's call). */
export async function turnOnAnyway(paths: string[]) {
  for (const p of paths) {
    await invoke('xtra_safe_off_allow', { modPath: p })
    await invoke('toggle_mod', { modPath: p }).catch(() => {})
  }
}

const nameOf = (p: string) => (p.replace(/\\/g, '/').split('/').pop() ?? p).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '')

/** The toast for mods kept off: why, and Turn on anyway. */
export function showKeptOff(alert: ReturnType<typeof useAlert>, kept: { path: string; reason: string }[], reload: () => unknown) {
  if (!kept.length) return
  const one = kept.length === 1
  alert.showAlert({
    color: 'warning', duration: 0,
    title: one ? `${nameOf(kept[0].path)} stays off` : `${kept.length} mods stay off`,
    description: `${one ? kept[0].reason : kept.map(k => nameOf(k.path)).join(', ')} ${one ? 'It was' : 'They were'} turned off so ${one ? 'it cannot' : 'they cannot'} crash the game. Update ${one ? 'it' : 'them'} in the Mod Updater, or turn ${one ? 'it' : 'them'} on anyway.`,
    action: { label: 'Turn on anyway', onClick: () => { void turnOnAnyway(kept.map(k => k.path)).then(reload) } },
  })
}

if (import.meta.env.DEV) {
  console.assert(blockedReason('SAFE_OFF|May crash: x') === 'May crash: x' && blockedReason('Mod file does not exist') === null, 'reads the block')
}
