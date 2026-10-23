// repakxtra: after a game update, a strip above Home and the Library while VFX mods were made for the game files it
// changed (xtra_broken.rs "vfx" verdicts, the Needs VFX update badge). Update VFX mods hands them all to the VFX Updater, which
// fixes them at once and turns the originals off. Not now hides it until the next game update (the VFX Updater still offers
// them all as one Add). It also listens for each
// fix the VFX window makes and swaps the original for the fix in every loadout, so a loadout turns on the fixed mod.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AlertTriangle } from 'lucide-react'
import { useBrokenVersion, verdictOf } from '../brokenMods'
import { modKey, openLoadout, renameModKey } from '../loadoutStore'
import { useUiPref } from '../uiPrefs'
import { FIXED_EVENT, OPEN_LOADOUT_EVENT, fixInVfxWindow, utocOf, type Fixed } from './handoff'
import './vfx.css'

type Mod = { path: string; utoc_path?: string | null }
const DISMISSED = 'repakxtra.vfxNotice' // the game update (seconds) Not now was pressed for

/** The yellow dot on the header's VFX Updater button while any mod needs a VFX update (hidden with the problem badges). */
export function VfxDot({ mods }: { mods: Mod[] }) {
  useBrokenVersion()
  const shown = useUiPref('broken')
  const n = mods.filter(m => verdictOf(m.path)?.kind === 'vfx').length
  return shown && n ? <span className="vfx-dot" role="img" aria-label={`${n} VFX ${n === 1 ? 'mod needs' : 'mods need'} an update`} /> : null
}

export default function VfxNotice({ mods, reload }: { mods: Mod[]; reload: () => void }) {
  useBrokenVersion()
  const shown = useUiPref('broken') // Settings can hide problem badges, this goes with them
  const [updated, setUpdated] = useState(0)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED))
  const stale = mods.filter(m => verdictOf(m.path)?.kind === 'vfx')
  const reloadRef = useRef(reload)
  reloadRef.current = reload

  useEffect(() => {
    if (stale.length) invoke<{ updated: number }>('xtra_game_build').then(b => setUpdated(b.updated)).catch(() => {})
  }, [stale.length])

  // each fix: the loadouts that held the original hold the fix (only when the original was replaced, not kept beside it)
  useEffect(() => {
    const un = listen<Fixed>(FIXED_EVENT, e => {
      if (e.payload?.swap) renameModKey(modKey(e.payload.from), modKey(e.payload.to))
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

  if (!shown || !stale.length || !updated || dismissed === String(updated)) return null
  const when = new Date(updated * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const n = stale.length
  return (
    <div className="vfx-notice" role="status">
      <AlertTriangle size={16} className="vfx-notice-icon" aria-hidden="true" />
      <p><strong>The game updated on {when}.</strong> {n === 1 ? '1 VFX mod was' : `${n} VFX mods were`} made for the files it changed, so {n === 1 ? 'its' : 'their'} effects may look wrong or crash the game.</p>
      <button type="button" className="lo-text-btn" onClick={() => { localStorage.setItem(DISMISSED, String(updated)); setDismissed(String(updated)) }}>Not now</button>
      <button type="button" className="btn-primary" onClick={() => fixInVfxWindow(stale.map(m => m.utoc_path || utocOf(m.path)), true)}>Update VFX mods</button>
    </div>
  )
}
