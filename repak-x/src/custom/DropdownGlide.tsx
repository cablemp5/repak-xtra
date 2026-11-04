import { useLayoutEffect, useRef } from 'react'

/** One moving highlight follows the existing options, including their real sizes and scroll position. */
export default function DropdownGlide() {
  const pill = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const el = pill.current, menu = el?.parentElement
    if (!el || !menu) return
    let active: HTMLElement | null = null
    const show = (row: HTMLElement | null) => {
      if (!row || row.classList.contains('add-new')) return
      if (!active) el.style.transition = 'none'
      el.style.transform = `translateY(${row.offsetTop}px)`
      el.style.height = `${row.offsetHeight}px`
      el.style.left = `${row.offsetLeft}px`
      el.style.width = `${row.offsetWidth}px`
      el.style.background = row.getAttribute('aria-selected') === 'true' ? 'var(--quiet-active)' : 'var(--quiet-hover)'
      el.style.opacity = '1'
      menu.dataset.glide = 'on'
      if (!active) { void el.offsetHeight; el.style.transition = '' }
      active = row
    }
    const follow = (event: Event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null
      if (row && menu.contains(row)) show(row)
    }
    show(menu.querySelector('[aria-selected="true"]'))
    menu.addEventListener('pointerover', follow)
    menu.addEventListener('focusin', follow)
    const resize = new ResizeObserver(() => {
      if (active?.isConnected) show(active)
      else { active = null; el.style.opacity = '0'; delete menu.dataset.glide }
    })
    resize.observe(menu)
    return () => {
      menu.removeEventListener('pointerover', follow)
      menu.removeEventListener('focusin', follow)
      resize.disconnect()
      delete menu.dataset.glide
    }
  }, [])
  return <span ref={pill} className="dropdown-glide" aria-hidden="true" />
}
