import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Open or close row gaps with transforms, without animating heights that the virtual list measures. */
export function useListReflow(wrap: RefObject<HTMLElement | null>, paths: string[], mode: string, animated: boolean) {
  const previous = useRef({ paths, mode, tops: new Map<string, number>() })
  const running = useRef(new Set<Animation>())
  useLayoutEffect(() => {
    const list = wrap.current?.firstElementChild
    const motion = animated && document.documentElement.dataset.motion !== 'off'
    if (!motion || previous.current.mode !== mode) {
      for (const run of running.current) run.cancel()
      running.current.clear()
    }
    // Nothing can animate here or on the next change from here: skip the row reads
    if (!motion || !list || (mode !== 'list' && mode !== 'list-compact')) {
      previous.current = { paths, mode, tops: new Map() }
      return
    }
    const before = previous.current
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > .mod-swipe')].map(row => ({
      row, key: row.querySelector<HTMLElement>('[data-mod-path]')?.dataset.modPath ?? '', top: row.offsetTop,
    }))
    previous.current = { paths, mode, tops: new Map(rows.map(({ key, top }) => [key, top])) }
    if (before.mode !== mode || !before.tops.size || !smallChange(before.paths, paths)) return
    const had = new Set(before.paths)
    for (const { row, key, top } of rows) {
      const oldTop = before.tops.get(key)
      // A virtual row mounting while scrolling is not a restored mod.
      const inserted = !had.has(key)
      if (!inserted && (oldTop === undefined || oldTop === top)) continue
      const frames = inserted
        ? [{ transform: `translateX(${-row.offsetWidth}px)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }]
        : [{ transform: `translateY(${(oldTop ?? top) - top}px)` }, { transform: 'translateY(0)' }]
      const run = row.animate(frames, {
        id: inserted ? 'list-insert' : 'list-reflow', duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      })
      running.current.add(run)
      void run.finished.catch(() => {}).finally(() => running.current.delete(run))
    }
  })
  useLayoutEffect(() => () => { for (const run of running.current) run.cancel() }, [])
}

/** A few rows deleted or restored, not a folder switch, search, or filter that swaps the list. */
export function smallChange(before: string[], after: string[]) {
  const [few, many] = before.length < after.length ? [before, after] : [after, before]
  if (many.length - few.length < 1 || many.length - few.length > 3) return false
  const all = new Set(many)
  return few.every(path => all.has(path))
}

if (import.meta.env.DEV) {
  console.assert(smallChange(['a', 'b', 'c'], ['a', 'c']) && smallChange(['a', 'c'], ['a', 'b', 'c']), 'reflow: one row deleted or restored animates')
  console.assert(!smallChange(['a', 'b'], ['a', 'b']) && !smallChange(['a', 'b', 'c'], ['d']) && !smallChange(['a', 'b'], ['c', 'd', 'e']), 'reflow: same count or a swapped list does not')
  console.assert(!smallChange(['a', 'b', 'c', 'd', 'e'], ['a']), 'reflow: more than three rows at once does not')
}
