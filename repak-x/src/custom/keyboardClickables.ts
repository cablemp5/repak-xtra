// repakxtra: upstream renders some controls as clickable divs. Make them reachable with Tab and
// activatable with Enter/Space without touching the upstream components.
// Folder pickers in the install, extension, drop, and VFX dialogs: Enter picks the folder, Right and Left open and close it.
const FOLDER_ROW = '.drop-folder-item, .ext-folder-item, .imp-folder-item'
const SELECTOR = `.filter-section-header, .folder-tree .node-content, ${FOLDER_ROW}`

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
/** Focus the app moves on its own (a deleted row's place goes to the next): no ring until a navigation key, as after a click. */
export function quietFocus(el: HTMLElement) {
  el.focus({ preventScroll: true })
  clearPointerFocus()
  pointerFocus = el
  el.setAttribute('data-pointer-focus', '')
}
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
  if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && el?.matches?.(FOLDER_ROW)) {
    const toggle = el.querySelector<HTMLElement>('.folder-toggle')
    if (!toggle?.querySelector('svg')) return // no subfolders
    const open = Boolean(el.nextElementSibling) // the children list renders right after the row while open
    if (open === (e.key === 'ArrowLeft')) toggle.click()
    e.preventDefault()
  }
})
