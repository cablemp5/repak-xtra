// repakxtra: when a busy state shows its spinner. A check that lands within 300 ms never flashes one, and a spinner
// that did show stays at least 400 ms, so a check that lands just after the wait does not blink (Doherty threshold).
import { useEffect, useRef, useState } from 'react'

export const SPIN_WAIT = 300
export const SPIN_MIN_ON = 400

export function useShownBusy(busy: boolean) {
  const [shown, setShown] = useState(false)
  const since = useRef(0)
  useEffect(() => {
    if (busy) {
      if (shown) return
      const t = setTimeout(() => { since.current = performance.now(); setShown(true) }, SPIN_WAIT)
      return () => clearTimeout(t)
    }
    if (!shown) return
    const t = setTimeout(() => setShown(false), Math.max(0, SPIN_MIN_ON - (performance.now() - since.current)))
    return () => clearTimeout(t)
  }, [busy, shown])
  return shown
}
