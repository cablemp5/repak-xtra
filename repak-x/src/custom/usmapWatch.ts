// repakxtra: the USMAP for a new game build is often out days after the patch. Built-ins and VFX updates wait for it
// (xtra_broken.rs changed_since_usmap), and so do the mod checks that read the game's files. A look for a newer one (an
// ETag check) runs 5 s after start and on focus, every 10 minutes at most. Once one is saved, every mod check runs again
// and the built-ins that waited build, in this run. The first look of a run also builds the ones that waited for a USMAP
// which came out while repakxtra was closed.
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { rescanVerdicts } from './brokenMods'
import { refreshBuiltins } from './BuiltinMods'

const EVERY = 10 * 60_000

/** Mounted once in App. */
export function useUsmapWatch() {
  useEffect(() => {
    let last = 0
    let busy = false
    let waited = false
    let first = true
    const check = async () => {
      if (busy || Date.now() - last < EVERY) return
      last = Date.now()
      busy = true
      try {
        if (await invoke<boolean>('xtra_usmap_waiting')) { waited = true; first = false; return }
        // The first check of a run also catches a USMAP that came out while repakxtra was closed: the launch's mod
        // checks may have fetched it first, so nothing here looks new, but a built-in that left files out for an older
        // USMAP is out of date by its own record and builds now (a no-op for the rest)
        if (!waited && !first) return
        if (waited) rescanVerdicts() // the launch's checks ran before it: once more with it
        waited = false
        first = false
        await refreshBuiltins()
      } catch (e) {
        console.warn('[usmapWatch] check failed', e)
      } finally {
        busy = false
      }
    }
    const t = setTimeout(() => { void check() }, 5000)
    const focus = () => { void check() }
    window.addEventListener('focus', focus)
    return () => { clearTimeout(t); window.removeEventListener('focus', focus) }
  }, [])
}
