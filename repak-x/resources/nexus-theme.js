// repakxtra: puts nexus-theme.css on every Nexus page in the app's Nexus window (xtra_nexus_api.rs theme_script fills in
// the CSS). It runs before the page's own scripts: the page itself gets the style once it has a root element, and each
// web component (Nexus draws its download buttons and banners in shadow roots, which page styles never reach) gets its own
// copy as it is made.
(() => {
  const css = __CSS__
  const style = () => { const s = document.createElement('style'); s.className = 'repakxtra-theme'; s.textContent = css; return s }
  const page = () => {
    const root = document.head || document.documentElement
    if (root && !document.getElementById('repakxtra-theme')) root.appendChild(Object.assign(style(), { id: 'repakxtra-theme' }))
  }
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (options) {
    const shadow = attach.call(this, options)
    try { shadow.appendChild(style()) } catch { /* a closed or locked root keeps Nexus's look */ }
    return shadow
  }
  document.addEventListener('DOMContentLoaded', page)
  page()
})()
