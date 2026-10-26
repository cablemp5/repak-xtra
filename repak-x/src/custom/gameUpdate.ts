// repakxtra: says once when the game updated (xtra_game.rs), checked 3 s after the mod list first loads and when the window
// gets focus (at most once a minute), so an update that lands while repakxtra is open is noticed too. It runs every mod
// check again first (brokenMods.ts), then one toast says how many mods the update left flagged, with a way to see them.
// Laws of UX: one toast with the count, not a badge per mod (Von Restorff), a single action that opens the list it
// counts (Hick), and it waits for the checks so the number it shows is the number in the Problems tab (Doherty).
import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { flaggedCount, fullScan } from './brokenMods'
import { setView } from './loadoutStore'
import { plural } from './modName'

type GameUpdate = { updated: number; previous: number }
type Alert = { info: (title: string, text?: string, options?: { color?: 'info'; duration?: number; action?: { label: string; onClick: () => void } }) => number }

/** The toast's text. `updated` is unix seconds. */
export function updateText(updated: number, flagged: number): string {
  const day = new Date(updated * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  const what = flagged === 0 ? 'No mod is flagged.' : `${plural(flagged, 'mod')} ${flagged === 1 ? 'is' : 'are'} flagged Broken, Needs VFX update, or May crash.`
  return `The game updated on ${day}. ${what}`
}

/** Mounted once in App. `loading` and `count` are the mod list's: the check waits for the first load to finish, so a slow
 *  start never reads as an empty library. `showFlagged` opens the Library's Problems filter with every other filter off. */
export function useGameUpdateWatch(alert: Alert, loading: boolean, count: number, showFlagged: () => void) {
  const live = useRef({ alert, count, showFlagged })
  live.current = { alert, count, showFlagged }
  // ready once there are mods, or a load was seen to end with none (the list starts empty and not loading)
  const started = useRef(false)
  if (loading) started.current = true
  const ready = count > 0 || (started.current && !loading)
  const shown = useRef(new Set<number>()) // shown this run: a save that failed is retried, the toast is not repeated
  useEffect(() => {
    if (!ready) return
    let last = 0
    let busy = false
    const check = async () => {
      if (busy || Date.now() - last < 60_000) return
      last = Date.now()
      busy = true
      try {
        const found = await invoke<GameUpdate | null>('xtra_game_update_check')
        if (!found) return
        if (!shown.current.has(found.updated)) {
          if (live.current.count > 0) {
            // the library can change under a scan (a reload), so a scan that did not finish is run again, twice at most
            let done = false
            for (let i = 0; i < 3 && !done; i++) done = (await fullScan()) ?? true
            if (!done) return // the checks failed: no notice with a wrong count, tried again on a later focus
          }
          const flagged = flaggedCount()
          const { alert, showFlagged } = live.current
          // the info color, not primary: Fewer pop-ups skips primary toasts without an action, and this one must show
          // before it is marked seen
          alert.info('Game updated', updateText(found.updated, flagged), {
            color: 'info',
            duration: 15000,
            ...(flagged ? { action: { label: 'Show them', onClick: () => { setView('library'); showFlagged() } } } : {}),
          })
          shown.current.add(found.updated)
        }
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
  }, [ready])
}

if (import.meta.env.DEV) {
  const noon = Date.UTC(2026, 9, 26, 12) / 1000
  console.assert(/^The game updated on .+\. 3 mods are flagged Broken, Needs VFX update, or May crash\.$/.test(updateText(noon, 3)), 'flagged count', updateText(noon, 3))
  console.assert(updateText(noon, 1).endsWith('1 mod is flagged Broken, Needs VFX update, or May crash.'), 'one mod', updateText(noon, 1))
  console.assert(updateText(noon, 0).endsWith('No mod is flagged.'), 'none flagged', updateText(noon, 0))
  console.assert(!/[;—]/.test(updateText(noon, 2)), 'no semicolons or em dashes')
}
