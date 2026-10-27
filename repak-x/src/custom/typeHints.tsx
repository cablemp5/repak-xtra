import { EXTENDED } from './edition'
// repakxtra: one quiet line per mod type for the two things that make working mods look broken: sounds tied to
// cooldowns in the practice range, and icon mods under Sigeon. Shown in mod details and as the type badge's tooltip.
import { useEffect, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'

let sigeonOn = false
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const refresh = () => invoke<{ state: string }>('sigeon_status')
  .then(s => { const on = Boolean(s?.state) && s.state !== 'off'; if (on !== sigeonOn) { sigeonOn = on; listeners.forEach(l => l()) } })
  .catch(() => undefined)

let watching = false
/** Whether a Sigeon config is on, kept current the way the header's Sigeon button is (start, focus, any switch). */
export function useSigeonOn() {
  useEffect(() => {
    if (!EXTENDED || watching) return
    watching = true
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('sigeon-changed', refresh)
  }, [])
  return useSyncExternalStore(subscribe, () => sigeonOn)
}

export function typeHint(category: string | null | undefined, sigeon: boolean) {
  if (category === 'Audio') return 'In the practice range, sounds tied to cooldowns (like dash resets) stay silent while no-cooldowns is on.'
  if (EXTENDED && category === 'UI' && sigeon) return 'Sigeon is on: icon mods can show as grey squares, with no fix known yet. Turn Sigeon off (S cycles it) to check.'
  return undefined
}

/** The hint for this type, or undefined: for the type badge's title. */
export const useTypeHint = (category: string | null | undefined) => typeHint(category, useSigeonOn())

/** ModDetailsPanel's line under the type badges. */
export function TypeHint({ category }: { category?: string | null }) {
  const hint = useTypeHint(category)
  return hint ? <p className="type-hint">{hint}</p> : null
}

if (import.meta.env.DEV) {
  console.assert(typeHint('Audio', false)?.startsWith('In the practice range') && !typeHint('UI', false) && (EXTENDED ? typeHint('UI', true)?.startsWith('Sigeon is on') : !typeHint('UI', true)) && !typeHint('Mesh', true), 'type hints')
}
