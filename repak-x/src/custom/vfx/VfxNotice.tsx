// repakxtra: after a game update, a strip above Home and the Library while VFX mods were made for the game files it
// changed (xtra_broken.rs "vfx" verdicts, the Needs VFX update badge). Update mods hands them all to the Mod Updater ticked,
// its Update button ready (the user starts it). While the updater runs the strip stays, its count falling by one for each
// mod done, and its button brings the updater forward. Not now hides the mods already shown, until the game
// changes or a waiting repair becomes available. A newly flagged mod brings the strip back. It also listens for each
// fix the VFX window makes and swaps the original for the fix in every loadout, so a loadout turns on the fixed mod.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { needsUpdater, useBrokenVersion, verdictOf } from '../brokenMods'
import { modKey, nameKey, openLoadout, renameModKey } from '../loadoutStore'
import { renameSource } from '../nexusSource'
import { useUiPref } from '../uiPrefs'
import { useScanRun } from '../scanProgress'
import { FIXED_EVENT, OPEN_LOADOUT_EVENT, fixInVfxWindow, openVfxWindow, utocOf, type Fixed } from './handoff'
import { onRunChange, runLock } from './prefs'
import { Num } from '../motion'
import './vfx.css'

type Mod = { path: string; utoc_path?: string | null; modified_date?: number; file_size?: number }
// The game build and mod versions already shown. Old build-only dismissals resurface once because they list no mods.
const DISMISSED = 'repakxtra.vfxNotice'

const noticeModKey = (m: Mod, waiting: boolean) => JSON.stringify([modKey(m.path), m.modified_date ?? 0, m.file_size ?? 0, waiting])
/** Removing or fixing a dismissed mod stays quiet. New mods, file versions, or repair readiness show the notice. */
export function noticeDismissed(saved: string | null, updated: number, keys: string[]): boolean {
  if (!saved) return false
  try {
    const value: unknown = JSON.parse(saved)
    return Array.isArray(value) && value[0] === updated && keys.every(k => value.includes(k))
  } catch { return false }
}

/** The yellow dot on the header's VFX Updater button while any mod needs a VFX update (hidden with the problem badges). */
export function VfxDot({ mods }: { mods: Mod[] }) {
  useBrokenVersion()
  const shown = useUiPref('broken')
  const n = mods.filter(m => needsUpdater(m.path, verdictOf(m.path))).length
  return shown && n ? <span className="vfx-dot" role="img" aria-label={`${n} VFX ${n === 1 ? 'mod needs' : 'mods need'} an update`} /> : null
}

/** The strip's headline: the risk, then which update. */
export const noticeHead = (n: number, when: string) =>
  `${n === 1 ? '1 mod may' : `${n} mods may`} crash the game or not load correctly after the ${when} update`
/** Its second line: what can be done now, and what waits for the game's new USMAP. */
export const noticeDetail = (n: number, ready: number, waiting: number, off = 0) => (!waiting
  ? `${n === 1 ? 'It was' : 'They were'} made for game files this update changed. Update rebuilds ${n === 1 ? 'it' : 'them'} on the new ones.`
  : `${ready ? `${ready} can be updated now. ` : ''}${waiting === n ? (n === 1 ? 'It waits' : 'They all wait') : `${waiting} wait`} for the game's new USMAP before ${waiting === 1 ? 'it' : 'they'} can be updated.`)
  + (off ? ` ${off === n ? (n === 1 ? 'It' : 'They') : off} cannot be rebuilt here, so Update turns ${off === 1 ? 'it' : 'them'} off.` : '')

export default function VfxNotice({ mods, reload }: { mods: Mod[]; reload: () => void }) {
  const shown = useUiPref('broken') // Settings can hide problem badges, this goes with them
  // a run of the checks can still clear or change a quick check's May crash (a new install's date rule): the strip waits for its end
  const checking = useScanRun().running
  const [updated, setUpdated] = useState(0)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED))
  // the same mods as the Mod Updater's Needs an update: one that may crash and is on counts too (Update turns it off)
  // a run of the Mod Updater, and the originals it fixed meanwhile: they leave the count at once, not at the next check
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState<Set<string>>(new Set())
  const stale = mods.filter(m => needsUpdater(m.path, verdictOf(m.path)) && !done.has(modKey(m.path)))
  const version = useBrokenVersion()
  const clearDone = useRef(false) // the run ended: the next check's answers replace the ones counted down
  useEffect(() => { if (clearDone.current) { clearDone.current = false; setDone(new Set()) } }, [version])
  useEffect(() => {
    void runLock().then(l => setRunning(Boolean(l)))
    return onRunChange(l => { setRunning(Boolean(l)); if (!l) clearDone.current = true })
  }, [])
  const wasShown = useRef(false) // once shown it stays through the checks an update's reloads start
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(() => {
    if (stale.length) invoke<{ updated: number }>('xtra_game_build').then(b => setUpdated(b.updated)).catch(() => {})
  }, [stale.length])

  // each fix: the loadouts that held the original hold the fix (only when the original was replaced, not kept beside it)
  useEffect(() => {
    const un = listen<Fixed>(FIXED_EVENT, e => {
      if (e.payload?.from) { const k = modKey(e.payload.from); setDone(d => new Set(d).add(k)) }
      if (e.payload?.swap) {
        renameModKey(modKey(e.payload.from), modKey(e.payload.to))
        renameSource(nameKey(e.payload.from), nameKey(e.payload.to), nameKey(e.payload.original ?? e.payload.from)) // its Nexus source on both copies
      }
      reloadRef.current()
    })
    return () => { un.then(f => f()) }
  }, [])

  // the VFX Updater's "In <loadout>" tag: that loadout's page, here, in front
  useEffect(() => {
    const un = listen<string>(OPEN_LOADOUT_EVENT, async e => {
      openLoadout(e.payload)
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const w = getCurrentWindow()
      await w.unminimize().catch(() => {}); await w.setFocus().catch(() => {})
    })
    return () => { un.then(f => f()) }
  }, [])

  const n = stale.length
  // the ones whose files the patch itself changed wait for its USMAP (xtra_broken.rs usmap_wait): Update sends the rest
  const ready = stale.filter(m => !verdictOf(m.path)?.usmapWait)
  const waiting = n - ready.length
  const keys = stale.map(m => noticeModKey(m, Boolean(verdictOf(m.path)?.usmapWait)))
  const seen = JSON.stringify([updated, ...keys])
  const hidden = !shown || !n || !updated || noticeDismissed(dismissed, updated, keys)
  if (hidden) wasShown.current = false
  if (hidden || (checking && !running && !wasShown.current)) return null
  wasShown.current = true
  const when = new Date(updated * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <div className="vfx-notice" role="status">
      <AlertTriangle size={20} className="vfx-notice-icon" aria-hidden="true" />
      {/* the risk first as a headline, the counts below it (Von Restorff, progressive disclosure) */}
      <p><strong className="vfx-notice-head"><Num id="vfx-notice-n" value={n} />{noticeHead(n, when).slice(String(n).length)}</strong>{noticeDetail(n, ready.length, waiting, stale.filter(m => verdictOf(m.path)?.kind === 'risky').length)}</p>
      <button type="button" className="lo-text-btn" onClick={() => { localStorage.setItem(DISMISSED, seen); setDismissed(seen) }}
        title="Hide these warnings until another mod needs an update, the game changes, or a waiting repair becomes available">Not now</button>
      {running
        ? <button type="button" className="btn-primary" onClick={() => void openVfxWindow()} title="The Mod Updater is updating mods: bring its window to the front">
            <ExternalLink size={14} aria-hidden="true" />Open Mod Updater</button>
        : ready.length > 0 && <button type="button" className="btn-primary" onClick={() => fixInVfxWindow(ready.map(m => m.utoc_path || utocOf(m.path)), false)}
            title="Open the Mod Updater with these mods ticked, ready to update">
            <RefreshCw size={14} aria-hidden="true" />{waiting ? `Update ${ready.length === 1 ? '1 mod' : `${ready.length} mods`}` : 'Update mods'}</button>}
    </div>
  )
}

if (import.meta.env.DEV) {
  const a = { path: 'C:/Game/~mods/A_9999999_P.pak', modified_date: 10, file_size: 20 }
  const key = noticeModKey(a, false)
  const saved = JSON.stringify([100, key, 'another-mod'])
  console.assert(noticeDismissed(saved, 100, [key]), 'fixing or removing another dismissed mod stays quiet')
  console.assert(!noticeDismissed(saved, 100, [key, 'new-mod']), 'newly flagged mods show a banner on the same build')
  console.assert(!noticeDismissed(saved, 200, [key]), 'a new game build shows the banner again')
  console.assert(!noticeDismissed('100', 100, [key]) && !noticeDismissed('100:waiting', 100, [key]), 'old dismissals do not hide newly installed mods')
  console.assert(!noticeDismissed(JSON.stringify([100, noticeModKey(a, true)]), 100, [key]), 'a waiting repair becoming ready shows the banner')
  console.assert(!noticeDismissed(saved, 100, [noticeModKey({ ...a, modified_date: 11 }, false)]), 'a newly installed version at the same path shows the banner')
  console.assert(noticeDismissed(saved, 100, [noticeModKey({ ...a, path: a.path.replace('.pak', '.bak_repak') }, false)]), 'toggling a mod does not reset dismissal')
  console.assert(!noticeDismissed('{bad', 100, [key]), 'invalid saved data cannot hide a warning')
  console.assert(noticeHead(101, 'Oct 29') === '101 mods may crash the game or not load correctly after the Oct 29 update', 'headline', noticeHead(101, 'Oct 29'))
  console.assert(noticeHead(1, 'Oct 29').startsWith('1 mod may crash'), 'one mod')
  console.assert(noticeDetail(101, 1, 100) === "1 can be updated now. 100 wait for the game's new USMAP before they can be updated.", 'some wait', noticeDetail(101, 1, 100))
  console.assert(noticeDetail(3, 0, 3) === "They all wait for the game's new USMAP before they can be updated.", 'all wait')
  console.assert(noticeDetail(2, 2, 0).startsWith('They were made for game files'), 'none wait')
  console.assert(noticeDetail(3, 3, 0, 1).endsWith(' 1 cannot be rebuilt here, so Update turns it off.'), 'May crash ones turn off', noticeDetail(3, 3, 0, 1))
}
