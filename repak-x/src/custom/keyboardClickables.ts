// repakxtra: upstream renders some controls as clickable divs. Make them reachable with Tab and
// activatable with Enter/Space without touching the upstream components.
const SELECTOR = '.filter-section-header, .folder-tree .node-content'

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
