import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Open or close row gaps with transforms, without animating heights that the virtual list measures. */
export function useListReflow(wrap: RefObject<HTMLElement | null>, paths: string[], mode: string, animated: boolean) {
  const previous = useRef({ paths: new Set(paths), mode, tops: new Map<string, number>() })
  const running = useRef(new Set<Animation>())
  useLayoutEffect(() => {
    const list = wrap.current?.firstElementChild
    const motion = animated && document.documentElement.dataset.motion !== 'off'
    if (!motion || previous.current.mode !== mode) {
      for (const run of running.current) run.cancel()
      running.current.clear()
    }
    if (!list || (mode !== 'list' && mode !== 'list-compact')) {
      previous.current = { paths: new Set(paths), mode, tops: new Map() }
      return
    }
    const before = previous.current
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > .mod-swipe')].map(row => ({
      row, key: row.querySelector<HTMLElement>('[data-mod-path]')?.dataset.modPath ?? '', top: row.offsetTop,
    }))
    previous.current = { paths: new Set(paths), mode, tops: new Map(rows.map(({ key, top }) => [key, top])) }
    if (before.mode !== mode || paths.length === before.paths.size || !motion) return
    for (const { row, key, top } of rows) {
      const oldTop = before.tops.get(key)
      // A virtual row mounting while scrolling is not a restored mod.
      const inserted = !before.paths.has(key)
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
