// repakxtra: says once when the game updated (xtra_game.rs), checked 3 s after the mod list first loads and when the window
// gets focus (at most once a minute), so an update that lands while repakxtra is open is noticed too. It runs every mod
// check again first (brokenMods.ts), then one toast says how many mods the update left flagged, with a way to see them.
// Laws of UX: one toast with the count, not a badge per mod (Von Restorff), a single action that opens the list it
// counts (Hick), and it waits for the checks so the number it shows is the number in the Problems tab (Doherty).
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { flaggedCount, fullScan, waitingCount } from './brokenMods'
import { setView } from './loadoutStore'
import { plural } from './modName'
import { REPAKXTRA_VERSION } from './version'
import { APP_NAME } from './edition'

type GameUpdate = { updated: number; previous: number }
type Alert = { info: (title: string, text?: string, options?: { color?: 'info'; duration?: number; action?: ReactNode }) => number }

/** The toast's text. `updated` is unix seconds. `waiting`: of the flagged, the ones whose update waits for the game's
 *  new USMAP (the rest can be updated now). */
export function updateText(updated: number, flagged: number, waiting = 0): string {
  const day = new Date(updated * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
  // the count, short: what each one needs is in the Problems view the action opens
  const who = flagged === 0 ? 'No mod needs' : `${plural(flagged, 'mod')} ${flagged === 1 ? 'needs' : 'need'}`
  const wait = waiting ? ` ${plural(waiting, 'mod')} ${waiting === 1 ? 'waits' : 'wait'} for the game's new USMAP before ${waiting === 1 ? 'it' : 'they'} can be updated.` : ''
  return `${who} attention after the ${day} update.${wait}`
}

/** The repakxtra version whose start last checked every mod (the app update notice). */
const SCANNED = 'repakxtra.scannedVersion'

/** The app update toast's text: the same counts as the game update's. */
export const appUpdateText = (flagged: number, waiting = 0) =>
  `This version checked every mod again. ${updateText(0, flagged, waiting).replace(/ after the .+? update\./, '.')}`

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
          alert.info('Game updated', updateText(found.updated, flagged, waitingCount()), {
            color: 'info',
            duration: 15000,
            // a short label on one line (the toast's own action button wraps, for long mod names)
            ...(flagged ? { action: createElement('button', { type: 'button', className: 'toast-action-btn is-short', onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setView('library'); showFlagged() } }, 'Show problems') } : {}),
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
    // the first start of a new repakxtra version checks every mod again, like a game update, since a new version can
    // judge them differently, and says what it found (nothing on the very first start, or when nothing is flagged)
    const appUpdate = async () => {
      const seen = localStorage.getItem(SCANNED)
      if (seen === REPAKXTRA_VERSION) return
      let done = false
      for (let i = 0; i < 3 && !done; i++) done = (await fullScan()) ?? true
      if (!done) return // tried again at the next start
      localStorage.setItem(SCANNED, REPAKXTRA_VERSION)
      const flagged = flaggedCount()
      if (!seen || !flagged) return
      const { alert, showFlagged } = live.current
      alert.info(`Updated to ${APP_NAME} ${REPAKXTRA_VERSION}`, appUpdateText(flagged, waitingCount()), {
        color: 'info',
        duration: 15000,
        action: createElement('button', { type: 'button', className: 'toast-action-btn is-short', onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); setView('library'); showFlagged() } }, 'Show problems'),
      })
    }
    const t = setTimeout(() => { void check().then(appUpdate) }, 3000)
    const focus = () => { void check() }
    window.addEventListener('focus', focus)
    return () => { clearTimeout(t); window.removeEventListener('focus', focus) }
  }, [ready])
}

if (import.meta.env.DEV) {
  const noon = Date.UTC(2026, 9, 26, 12) / 1000
  console.assert(/^3 mods need attention after the .+ update\.$/.test(updateText(noon, 3)), 'flagged count', updateText(noon, 3))
  console.assert(updateText(noon, 1).startsWith('1 mod needs attention after the '), 'one mod', updateText(noon, 1))
  console.assert(appUpdateText(2) === 'This version checked every mod again. 2 mods need attention.', 'app update text', appUpdateText(2))
  console.assert(updateText(noon, 3, 1).endsWith(" update. 1 mod waits for the game's new USMAP before it can be updated."), 'waiting mods', updateText(noon, 3, 1))
  console.assert(updateText(noon, 0).startsWith('No mod needs attention after the '), 'none flagged', updateText(noon, 0))
  console.assert(!/[;\u2014]/.test(updateText(noon, 2)), 'no semicolons or em dashes')
}
