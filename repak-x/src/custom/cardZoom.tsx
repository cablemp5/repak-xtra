// repakxtra: zoom for the loadout cards on Home, apart from the app-wide UI scale (uiPrefs.tsx). Applied as CSS zoom on
// the card grids (theme.css .lo-screen .lo-grid), so more or fewer cards fit a row; group headers and the header stay put.
// Steps with the − / + control in the Loadouts header, or Ctrl + mouse wheel over the cards.
import { useEffect, useSyncExternalStore } from 'react'
import { Minus, Plus } from 'lucide-react'
import { savedItem } from './storageCarryOver'

const KEY = 'repakxtra.cardZoom'
const STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5]
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const get = () => { const z = Number(savedItem(KEY)); return STEPS.includes(z) ? z : 1 }

/** The next step from `z` in direction `dir` (0 resets to 100%), held to the ends. */
export const stepZoom = (z: number, dir: -1 | 0 | 1) => {
  if (dir === 0) return 1
  const i = STEPS.indexOf(z)
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, (i < 0 ? STEPS.indexOf(1) : i) + dir))]
}
const step = (dir: -1 | 0 | 1) => { localStorage.setItem(KEY, String(stepZoom(get(), dir))); listeners.forEach(l => l()) }

export const useCardZoom = () => useSyncExternalStore(subscribe, get)

/** Ctrl + wheel over `el` zooms the cards (and keeps the webview from zooming the whole app). */
export function useWheelZoom(el: HTMLElement | null) {
  useEffect(() => {
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      step(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el])
}

/** − 100% + in the Loadouts header; the percentage resets to 100%. */
export function CardZoomControl() {
  const z = useCardZoom()
  return (
    <div className="lo-zoom" role="group" aria-label="Card size">
      <button type="button" className="lo-icon" onClick={() => step(-1)} disabled={z === STEPS[0]} title="Smaller cards (Ctrl + scroll down)" aria-label="Smaller cards"><Minus size={14} /></button>
      <button type="button" className="lo-zoom-value" onClick={() => step(0)} title="Card size (click for 100%)" aria-label={`Card size ${Math.round(z * 100)}%, click to reset`}>{Math.round(z * 100)}%</button>
      <button type="button" className="lo-icon" onClick={() => step(1)} disabled={z === STEPS[STEPS.length - 1]} title="Bigger cards (Ctrl + scroll up)" aria-label="Bigger cards"><Plus size={14} /></button>
    </div>
  )
}

if (import.meta.env.DEV) {
  console.assert(stepZoom(1, 1) === 1.15 && stepZoom(0.5, -1) === 0.5 && stepZoom(1.5, 1) === 1.5 && stepZoom(1.3, 0) === 1 && stepZoom(0.75, 1) === 1.15, 'stepZoom')
}
