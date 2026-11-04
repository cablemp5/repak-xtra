import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Close a removed row's gap with transforms, without animating heights that the virtual list measures. */
export function useListReflow(wrap: RefObject<HTMLElement | null>, count: number, mode: string, animated: boolean) {
  const previous = useRef({ count, mode, tops: new Map<string, number>() })
  const running = useRef(new Set<Animation>())
  useLayoutEffect(() => {
    const list = wrap.current?.firstElementChild
    const motion = animated && document.documentElement.dataset.motion !== 'off'
    if (!motion || previous.current.mode !== mode) {
      for (const run of running.current) run.cancel()
      running.current.clear()
    }
    if (!list || (mode !== 'list' && mode !== 'list-compact')) {
      previous.current = { count, mode, tops: new Map() }
      return
    }
    const before = previous.current
    const rows = [...list.querySelectorAll<HTMLElement>(':scope > .mod-swipe')].map(row => ({
      row, key: row.querySelector<HTMLElement>('[data-mod-path]')?.dataset.modPath ?? '', top: row.offsetTop,
    }))
    previous.current = { count, mode, tops: new Map(rows.map(({ key, top }) => [key, top])) }
    if (before.mode !== mode || count >= before.count || !motion) return
    for (const { row, key, top } of rows) {
      const oldTop = before.tops.get(key)
      if (oldTop === undefined || oldTop === top) continue
      const run = row.animate([{ transform: `translateY(${oldTop - top}px)` }, { transform: 'translateY(0)' }], {
        id: 'list-reflow', duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      })
      running.current.add(run)
      void run.finished.catch(() => {}).finally(() => running.current.delete(run))
    }
  })
  useLayoutEffect(() => () => { for (const run of running.current) run.cancel() }, [])
}
