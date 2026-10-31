// repakxtra: upstream renders some controls as clickable divs. Make them reachable with Tab and
// activatable with Enter/Space without touching the upstream components.
const SELECTOR = '.filter-section-header, .folder-tree .node-content'

// Chromium reveals the last mouse-clicked control's focus ring on any letter shortcut, even without moving focus.
let pointerFocus: HTMLElement | null = null
const clearPointerFocus = () => { pointerFocus?.removeAttribute('data-pointer-focus'); pointerFocus = null }
document.addEventListener('pointerdown', e => {
  clearPointerFocus()
  const control = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a[href], [tabindex], [role="button"]') : null
  if (!control || control.matches('input, textarea, select, [contenteditable="true"]')) return
  pointerFocus = control
  control.setAttribute('data-pointer-focus', '')
}, true)
document.addEventListener('focusout', e => { if (e.target === pointerFocus) clearPointerFocus() }, true)
document.addEventListener('keydown', e => {
  if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(e.key)) clearPointerFocus()
}, true)

let queued = false
const markAll = () => {
  queued = false
  document.querySelectorAll<HTMLElement>(SELECTOR).forEach(el => {
    if (el.hasAttribute('tabindex')) return
    el.tabIndex = 0
    el.setAttribute('role', 'button')
  })
}

new MutationObserver(() => {
  if (!queued) {
    queued = true
    requestAnimationFrame(markAll)
  }
}).observe(document.body, { childList: true, subtree: true })

document.addEventListener('keydown', e => {
  const el = e.target as HTMLElement | null
  if ((e.key === 'Enter' || e.key === ' ') && el?.matches?.(SELECTOR)) {
    e.preventDefault()
    e.stopPropagation() // keep App's global Enter (open details) from also firing
    el.click()
  }
})
