import { useLayoutEffect, useRef, useState } from 'react'
import './skeletons.css'

export const skeletonCount = (height: number, row: number, gap: number, columns: number) =>
  Math.max(1, Math.ceil((height + gap) / (row + gap))) * columns

/** Fill the visible list with whole rows, using the actual placeholder and grid sizes. */
export function useSkeletonFill<T extends HTMLElement>(active: boolean, resetKey?: string | null) {
  const ref = useRef<T>(null)
  const [count, setCount] = useState(1)
  useLayoutEffect(() => {
    const list = ref.current
    if (!active || !list) return
    let viewport: HTMLElement | null = list
    while (viewport && !/(auto|scroll)/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement
    const measure = () => {
      const item = list.firstElementChild
      if (!item || !list.clientWidth) return
      const rect = list.getBoundingClientRect()
      const style = getComputedStyle(list)
      const columns = style.display === 'grid' ? style.gridTemplateColumns.split(' ').length : 1
      // capped at the window: a viewport without a fixed height grows with the skeletons and would feed back forever
      const bottom = Math.min(viewport?.getBoundingClientRect().bottom ?? Infinity, window.innerHeight)
      const row = item.getBoundingClientRect().height
      if (row > 0) setCount(skeletonCount(Math.max(0, bottom - rect.top), row, parseFloat(style.rowGap) || 0, columns))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    if (viewport && viewport !== list) observer.observe(viewport)
    measure()
    return () => observer.disconnect()
  }, [active, resetKey])
  return { ref, count }
}

if (import.meta.env.DEV) {
  console.assert(skeletonCount(600, 32, 1, 1) === 19, 'Skeleton rows cover the list bottom')
  console.assert(skeletonCount(750, 300, 16, 4) === 12, 'Skeleton grids fill complete rows')
}
