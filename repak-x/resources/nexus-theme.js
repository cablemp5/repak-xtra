// repakxtra: puts nexus-theme.css on every Nexus page in the app's Nexus window (xtra_nexus_api.rs theme_script fills in
// __CSS__ and __APP__). It runs before the page's own scripts: the page itself gets the style once it has a root element,
// and each web component (Nexus draws its download buttons and banners in shadow roots, which page styles never reach)
// gets its own copy as it is made. The buttons that install through the app say so, and copying the API key ends the visit.
// In a one-click Install's hidden window (window.__repakxtraAuto: the mod and file asked for, Settings > Nexus Mods,
// experimental) it also clicks that file's Slow download, once per page, when the button is ready.
(() => {
  const css = __CSS__
  const app = __APP__
  // Nexus's words on the buttons that hand a file to the app, and what they say here instead
  const LABELS = { 'Mod manager download': `Install with ${app}`, 'Slow download': `Slow download, installs in ${app}` }

  const slow = new Set() // the Slow download buttons seen (relabelled, so found again here, not by their words)
  let clickedOn = '' // the page whose Slow download was clicked (a page that changes without loading counts anew)
  const click = () => {
    const ask = window.__repakxtraAuto
    if (!ask || clickedOn === location.href) return
    const file = new URLSearchParams(location.search).get('file_id')
    if (!location.pathname.includes(`/mods/${ask.modId}`) || (file && file !== ask.fileId)) return // only the file asked for
    for (const b of slow) {
      if (!b.isConnected || b.disabled || b.getAttribute('aria-disabled') === 'true') continue // not ready yet: the next change tries again
      clickedOn = location.href
      b.click()
      return
    }
  }
  const relabel = (root) => {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const said = n.nodeValue.trim()
      const button = LABELS[said] && n.parentElement?.closest('a, button')
      if (!button) continue
      n.nodeValue = n.nodeValue.replace(said, LABELS[said])
      if (said === 'Slow download') slow.add(button)
    }
    click()
  }
  // each root is looked at again on the next frame after it changes (Nexus draws parts of its pages late)
  const watch = (root) => {
    let queued = false
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; relabel(root) }) } }
    new MutationObserver(later).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled'] })
    later()
  }

  const style = () => { const s = document.createElement('style'); s.className = 'repakxtra-theme'; s.textContent = css; return s }
  const page = () => {
    const root = document.head || document.documentElement
    if (!root || document.getElementById('repakxtra-theme')) return
    root.appendChild(Object.assign(style(), { id: 'repakxtra-theme' }))
    watch(document.documentElement)
  }
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (options) {
    const shadow = attach.call(this, options)
    try { shadow.appendChild(style()); watch(shadow) } catch { /* a locked root keeps Nexus's look */ }
    return shadow
  }
  // the API keys page's Copy: once the key is on the clipboard the window's work is done (the app closes it and says so)
  document.addEventListener('click', e => {
    if (e.target instanceof Element && e.target.closest('button[aria-label="Copy Api Key"]')) setTimeout(() => { location.href = 'https://repakxtra.invalid/key-copied' }, 250)
  }, true)
  document.addEventListener('DOMContentLoaded', page)
  page()
})()
