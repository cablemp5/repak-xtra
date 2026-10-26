// repakxtra: says once when the game updated (xtra_game.rs), checked 3 s after launch and when the window gets focus (at
// most once a minute), so an update that lands while repakxtra is open is noticed too. It runs every mod check again
// first (brokenMods.ts), then one toast says how many mods the update left flagged, with a way to see them.
import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { flaggedCount, rescanVerdicts, scanFinished } from './brokenMods'
import { setView } from './loadoutStore'
import { plural } from './modName'

type GameUpdate = { updated: number; previous: number }
type Alert = { info: (title: string, text?: string, options?: { duration?: number; action?: { label: string; onClick: () => void } }) => number }

/** The toast's text. `updated` is unix seconds. */
export function updateText(updated: number, flagged: number): string {
  const day = new Date(updated * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  const what = flagged === 0 ? 'No mod is flagged.' : `${plural(flagged, 'mod')} ${flagged === 1 ? 'is' : 'are'} flagged Broken, Needs VFX update, or May crash.`
  return `The game updated on ${day}. ${what}`
}

/** Mounted once in App. `hasMods`: no mods means no scan to wait for. `showFlagged` opens the Library's Problems filter. */
export function useGameUpdateWatch(alert: Alert, hasMods: boolean, showFlagged: () => void) {
  const live = useRef({ alert, hasMods, showFlagged })
  live.current = { alert, hasMods, showFlagged }
  useEffect(() => {
    let last = 0
    let busy = false
    const check = async () => {
      if (busy || Date.now() - last < 60_000) return
      last = Date.now()
      busy = true
      try {
        const found = await invoke<GameUpdate | null>('xtra_game_update_check')
        if (!found) return
        if (live.current.hasMods) {
          const done = scanFinished()
          void rescanVerdicts()
          await done
        }
        const flagged = flaggedCount()
        const { alert, showFlagged } = live.current
        alert.info('Game updated', updateText(found.updated, flagged), {
          duration: 15000,
          ...(flagged ? { action: { label: 'Show them', onClick: () => { setView('library'); showFlagged() } } } : {}),
        })
        await invoke('xtra_game_update_seen', { updated: found.updated })
      } catch (e) {
        console.warn('[gameUpdate] check failed', e)
      } finally {
        busy = false
      }
    }
    const t = setTimeout(() => { void check() }, 3000)
    const focus = () => { void check() }
    window.addEventListener('focus', focus)
    return () => { clearTimeout(t); window.removeEventListener('focus', focus) }
  }, [])
}

if (import.meta.env.DEV) {
  const noon = Date.UTC(2026, 9, 26, 12) / 1000
  console.assert(/^The game updated on .+\. 3 mods are flagged Broken, Needs VFX update, or May crash\.$/.test(updateText(noon, 3)), 'flagged count', updateText(noon, 3))
  console.assert(updateText(noon, 1).endsWith('1 mod is flagged Broken, Needs VFX update, or May crash.'), 'one mod', updateText(noon, 1))
  console.assert(updateText(noon, 0).endsWith('No mod is flagged.'), 'none flagged', updateText(noon, 0))
  console.assert(!/[;—]/.test(updateText(noon, 2)), 'no semicolons or em dashes')
}
