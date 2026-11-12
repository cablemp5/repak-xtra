// repakxtra: a loading bar's fill. It eases to the real progress and never steps back while it is on screen (a bar is
// one task: the caller shows a new one, or gives it a new key, for the next). A step that reports nothing while it
// works (a tool run, an export) keeps the fill moving toward that step's end mark, slower the closer it gets and
// never reaching it, so the bar moves while work happens and never says a step is done before it is. The width is set
// on the element directly, ten times a second: no render of the screen around it. Motion off: the real progress only.
import { useEffect, useLayoutEffect, useRef } from 'react'

const TICK = 100

/** Where the fill stands one tick later. `shown`: now. `pct`: the real progress. `next`: the current step's end mark
 *  when the step has no count of its own. `secs`: about how long such a step takes. */
export function glide(shown: number, pct: number, next: number | undefined, secs: number) {
  if (shown < pct) return shown + Math.max((pct - shown) * 0.35, Math.min(0.2, pct - shown)) // catch up with the work
  const cap = next === undefined ? pct : pct + (next - pct) * 0.9
  return cap > shown ? shown + (cap - shown) * (1 - Math.exp(-TICK / 1000 / (secs / 2))) : shown
}

export function GlideFill({ pct, next, secs = 8, tag: Tag = 'i' }: { pct: number; next?: number; secs?: number; tag?: 'i' | 'span' }) {
  const el = useRef<HTMLElement>(null)
  const now = useRef({ pct, next, secs })
  const shown = useRef(pct)
  useEffect(() => { now.current = { pct, next, secs } })
  useLayoutEffect(() => { // before the first paint: the fill never shows empty first
    const draw = () => {
      const still = document.documentElement.dataset.motion === 'off'
      const { pct, next, secs } = now.current
      shown.current = still ? Math.max(shown.current, pct) : glide(shown.current, pct, next, secs)
      if (el.current) el.current.style.width = `${Math.min(100, Math.max(0, shown.current))}%`
    }
    draw()
    const id = setInterval(draw, TICK)
    return () => clearInterval(id)
  }, [])
  // no width here: React would put the real one back on every render. Linear between ticks: the fill's own easing
  // would start over ten times a second
  return <Tag ref={el as never} style={{ transition: `width ${TICK}ms linear` }} />
}

if (import.meta.env.DEV) {
  let at = 0
  for (let i = 0; i < 600; i++) at = glide(at, 20, 40, 8) // a minute into a silent step: most of the way, never at its end
  console.assert(at > 35 && at < 38.01, 'glide: creeps toward the step end, never reaching it', at)
  console.assert(glide(at, 10, undefined, 8) === at, 'glide: never steps back', at)
  let up = 0
  for (let i = 0; i < 30; i++) up = glide(up, 60, undefined, 8)
  console.assert(Math.abs(up - 60) < 0.01, 'glide: reaches the real progress', up)
}
