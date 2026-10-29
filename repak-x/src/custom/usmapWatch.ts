// repakxtra: the USMAP for a new game build is often out days after the patch. Built-ins and VFX updates wait for it
// (xtra_niagara.rs usmap_behind), and so do the mod checks that read the game's files. So while the saved one is older
// than the game, a look for a newer one (an ETag check) runs 5 s after start and on focus, every 10 minutes at most. Once
// one is saved, every mod check runs again and the built-ins that waited build, in this run and not only at the next start.
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
    const check = async () => {
      if (busy || Date.now() - last < EVERY) return
      last = Date.now()
      busy = true
      try {
        if (await invoke<boolean>('xtra_usmap_waiting')) { waited = true; return }
        if (!waited) return // it matched all along: the launch's own checks already used it
        waited = false
        rescanVerdicts()
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
