// repakxtra: zoom for the loadout cards on Home, apart from the app-wide UI scale (uiPrefs.tsx). Applied as CSS zoom on
// the card grids (theme.css .lo-screen .lo-grid), so more or fewer cards fit a row; group headers and the header stay put.
// Steps with the − / + control in the Loadouts header, a plain mouse wheel over that control, or Ctrl + mouse wheel over the cards.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Minus, Plus } from 'lucide-react'
import { currentMonitor } from '@tauri-apps/api/window'
import { cue } from './sounds'
import { savedItem } from './storageCarryOver'

const KEY = 'repakxtra.cardZoom'
const STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5]
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
/** Until the user picks a size: by the screen's physical resolution (its short side), 1080p 90%, 1440p 100%, 4K 115%. */
export const zoomForScreen = (short: number) => (short >= 2160 ? 1.15 : short >= 1440 ? 1 : 0.9)
let unpicked = 1
currentMonitor().then(m => { if (m) { unpicked = zoomForScreen(Math.min(m.size.width, m.size.height)); listeners.forEach(l => l()) } }).catch(() => {})
const get = () => { const z = Number(savedItem(KEY)); return STEPS.includes(z) ? z : unpicked }

/** The next step from `z` in direction `dir` (0 resets to 100%), held to the ends. */
export const stepZoom = (z: number, dir: -1 | 0 | 1) => {
  if (dir === 0) return 1
  const i = STEPS.indexOf(z)
  return STEPS[Math.max(0, Math.min(STEPS.length - 1, (i < 0 ? STEPS.indexOf(1) : i) + dir))]
}
const step = (dir: -1 | 0 | 1) => { localStorage.setItem(KEY, String(stepZoom(get(), dir))); listeners.forEach(l => l()) }

export const useCardZoom = () => useSyncExternalStore(subscribe, get)

/** ms after a wheel step in which more wheel events are the same notch's trail */
const STEP_GAP = 90

/** Ctrl + wheel over `el` zooms the cards (and keeps the webview from zooming the whole app). What is under the pointer
 *  stays under it: the browser's own scroll anchoring is off for the step (it jumped the list hundreds of px). */
export function useWheelZoom(el: HTMLElement | null) {
  useEffect(() => {
    if (!el) return
    let last = -Infinity
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (e.timeStamp - last < STEP_GAP) return // one step per notch (CardZoomControl)
      last = e.timeStamp
      const held = e.target instanceof Element && e.target !== el && el.contains(e.target) ? e.target : null
      const before = held?.getBoundingClientRect().top
      el.style.overflowAnchor = 'none'
      const dir = e.deltaY < 0 ? 1 : -1
      if (stepZoom(get(), dir) !== get()) cue('select')
      step(dir)
      const hold = () => { if (held?.isConnected && before !== undefined) el.scrollTop += held.getBoundingClientRect().top - before }
      // the grid has its new size by the next frame; crossing 80% (data-small) settles one frame later, so hold twice
      requestAnimationFrame(() => { hold(); requestAnimationFrame(() => { hold(); el.style.overflowAnchor = '' }) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el])
}

/** − 100% + in the Loadouts header; the percentage resets to 100%. The wheel over it steps too, up for bigger (a
 *  notch is 100 units, a trackpad's small deltas add up to one step instead of racing through them all). */
export function CardZoomControl() {
  const z = useCardZoom()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    let sum = 0, last = -Infinity
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const d = e.deltaMode === 0 ? e.deltaY : e.deltaY * 100 // lines and pages count as whole notches
      // One step per notch, whatever its size (a notch came as 300 with Windows set to scroll 3 lines, so it jumped
      // 30%), and none for a moment after a step (smooth-scrolling mice trail a notch with more events). A trackpad's
      // small deltas still add up to one step
      sum = Math.abs(d) >= 100 ? d : sum + d
      if (e.timeStamp - last < STEP_GAP) { sum = 0; return }
      if (Math.abs(sum) < 100) return
      const dir = sum < 0 ? 1 : -1
      sum = 0
      last = e.timeStamp
      if (stepZoom(get(), dir) !== get()) cue('select')
      step(dir)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  return (
    <div className="lo-zoom" role="group" aria-label="Card size" ref={box}>
      <button type="button" className="lo-icon" onClick={() => step(-1)} disabled={z === STEPS[0]} title="Smaller cards" data-hotkey="Ctrl+Scroll down" aria-label="Smaller cards"><Minus size={14} /></button>
      <button type="button" className="lo-zoom-value" onClick={() => step(0)} title="Card size (click for 100%, or scroll here)" aria-label={`Card size ${Math.round(z * 100)}%, click to reset`}>{Math.round(z * 100)}%</button>
      <button type="button" className="lo-icon" onClick={() => step(1)} disabled={z === STEPS[STEPS.length - 1]} title="Bigger cards" data-hotkey="Ctrl+Scroll up" aria-label="Bigger cards"><Plus size={14} /></button>
    </div>
  )
}

if (import.meta.env.DEV) {
  console.assert(zoomForScreen(1080) === 0.9 && zoomForScreen(1440) === 1 && zoomForScreen(1600) === 1 && zoomForScreen(2160) === 1.15 && zoomForScreen(768) === 0.9, 'zoomForScreen')
  console.assert(stepZoom(1, 1) === 1.15 && stepZoom(0.5, -1) === 0.5 && stepZoom(1.5, 1) === 1.5 && stepZoom(1.3, 0) === 1 && stepZoom(0.75, 1) === 1.15, 'stepZoom')
}
