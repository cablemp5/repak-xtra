// repakxtra: the background mod checks' progress line (brokenMods.ts runs them, each backend scan sends
// `mod-scan-progress` for a mod it is about to read). After a game or app update they can read every mod for many
// minutes, so a loading toast says which check, which mod and how far, and closes when the run ends. Short runs (one
// new mod) stay quiet: it shows only once work has gone on for a moment.
import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { useAlert } from '../components/AlertHandler'

type Progress = { step: 'effects' | 'materials' | 'blueprints' | 'meshes'; at: number; total: number; path: string }
/** brokenMods.ts sends it when a full run of the checks ends (finished, stopped for the game, or failed) */
export const SCAN_DONE = 'repakxtra-scan-done'

const STEP = { effects: 'VFX effects', materials: 'VFX materials', blueprints: 'Blueprints', meshes: 'Meshes' }
/** "C:/x/Cool Mod_9999999_P.bak_repak" is "Cool Mod". Pure. */
export const modLabel = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.(pak|bak_repak|utoc)$/i, '').replace(/_\d+_P$/i, '')
/** "VFX materials · Cool Mod (12 of 216)". Pure. */
export const progressLine = (p: Progress) => `${STEP[p.step] ?? 'Mods'} · ${modLabel(p.path)} (${p.at} of ${p.total})`
const SHOW_AFTER_MS = 1500

export function useScanProgress(alert: ReturnType<typeof useAlert>) {
  useEffect(() => {
    let id: number | null = null
    let last: Progress | null = null
    let checked = 0
    let timer: number | undefined
    const show = () => {
      if (!last) return
      const description = `${progressLine(last)}. Pauses while the game runs.`
      if (id === null) id = alert.showAlert({ color: 'default', title: 'Checking mods', description, isLoading: true, duration: 0 })
      else alert.updateToast(id, { description })
    }
    const off = listen<Progress>('mod-scan-progress', e => {
      last = e.payload
      checked++
      if (id !== null) show()
      else if (timer === undefined) timer = window.setTimeout(show, SHOW_AFTER_MS)
    })
    const done = () => {
      clearTimeout(timer)
      timer = undefined
      if (id !== null) alert.updateToast(id, { color: 'success', title: 'Mods checked', description: `${checked} ${checked === 1 ? 'mod' : 'mods'} read for compatibility.`, isLoading: false, duration: 4000 })
      id = null
      last = null
      checked = 0
    }
    window.addEventListener(SCAN_DONE, done)
    return () => { clearTimeout(timer); off.then(f => f()).catch(() => undefined); window.removeEventListener(SCAN_DONE, done) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}

if (import.meta.env.DEV) {
  console.assert(modLabel('C:\\Paks\\~mods\\Cool Mod_9999999_P.bak_repak') === 'Cool Mod' && modLabel('a/b_P.pak') === 'b_P', 'mod label')
  console.assert(progressLine({ step: 'materials', at: 12, total: 216, path: 'x/Cyan_9999999_P.pak' }) === 'VFX materials · Cyan (12 of 216)', 'progress line')
}
