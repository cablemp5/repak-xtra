// repakxtra: puts nexus-theme.css on every Nexus page in the app's Nexus window (xtra_nexus_api.rs theme_script fills in
// __CSS__, __ICONS__ and __GEIST__). It runs before the page's own scripts: the page gets the style once it has a root
// element, and each web component (Nexus draws its buttons and banners in shadow roots, which page styles never reach)
// gets its own copy as it is made. It also brings the app's Geist font in under Nexus's "Inter" name, and swaps the
// icons it knows for the app's Lucide ones.
(() => {
  const css = __CSS__
  const LUCIDE = __ICONS__ // name: the icon's SVG children (resources/nexus-icons.json, scripts/nexus-icons.mjs)

  // Nexus's icons and the Lucide icon drawn in their place. Material Icons are words in an icon font, the sprite is
  // Nexus's own icons.svg, inline ones are its web components' Material Design paths, matched by how they start.
  // ICONS START
  const MATERIAL = {
    close: 'x', add: 'plus', cloud_upload: 'cloud-upload', cloud_download: 'cloud-download', image: 'image', video_call: 'video',
    email: 'mail', add_photo_alternate: 'image-plus', error_outline: 'circle-alert', refresh: 'refresh-cw', notifications: 'bell',
    notifications_off: 'bell-off', account_circle: 'circle-user', account_balance_wallet: 'wallet', history: 'history', settings: 'settings',
    tune: 'sliders-horizontal', exit_to_app: 'log-out', menu: 'menu', person: 'user', chevron_right: 'chevron-right', chevron_left: 'chevron-left',
    arrow_forward: 'arrow-right', arrow_back: 'arrow-left', expand_more: 'chevron-down', expand_less: 'chevron-up', search: 'search',
    favorite: 'heart', delete: 'trash-2', edit: 'pencil', check: 'check', info: 'info', warning: 'triangle-alert', more_vert: 'ellipsis-vertical',
    more_horiz: 'ellipsis', download: 'download', visibility: 'eye', thumb_up: 'thumbs-up', star: 'star', share: 'share-2', flag: 'flag',
  }
  const SPRITE = {
    'icon-stat-endorsements': 'thumbs-up', 'icon-stat-uniquedl': 'download', 'icon-stat-totaldl': 'chart-column', 'icon-stat-totalviews': 'eye',
    'icon-stat-version': 'file-text', 'icon-media': 'image', 'icon-arrow': 'chevron-down', 'icon-track': 'bell', 'icon-endorse': 'thumbs-up',
    'icon-vote': 'award', 'icon-fullscreen': 'maximize', 'icon-ticksafe': 'circle-check', 'icon-tick-blue': 'circle-check', 'icon-tickunsafe': 'circle-x',
    'icon-tag': 'tag', 'icon-share': 'share-2', 'icon-report': 'flag', 'icon-exclamation': 'circle-alert', 'icon-monitor-arrow-down': 'monitor-down',
    'icon-download': 'download',
  }
  const INLINE = [
    ['M9.5,3A6.5,6.5', 'search'], ['M9,16V10H5L12,3', 'upload'], ['M19,6.41L17.59,5', 'x'], ['M5,20H19V18H5M19,9', 'download'],
    ['M8.59,16.58L13.17,12', 'chevron-right'], ['M15.41,16.58L10.83,12', 'chevron-left'], ['M7.41,8.58L12,13.17', 'chevron-down'],
    ['M7.41,15.41L12,10.83', 'chevron-up'], ['M21,19V20H3V19', 'bell'], ['M20,8L12,13L4,8', 'mail'], ['M3,6H21V8H3', 'menu'],
    ['M12,4A4,4 0 0,1 16,8', 'user'], ['M6,13H18V11H6', 'list-filter'], ['M21,7L9,19L3.5,13.5', 'check'], ['M21,5L9,17L3.5,11.5', 'check'],
    ['M7,10L12,15L17,10H7Z', 'chevron-down'], ['M12,18.17L8.83,15', 'chevrons-up-down'], ['M18 21L14 17H17V7', 'arrow-up-down'],
    ['M16,12A2,2 0 0,1 18,10', 'ellipsis'], ['M12,16A2,2 0 0,1 14,18', 'ellipsis-vertical'], ['M21,10.12H14.22', 'refresh-cw'],
    ['M23,10C23,8.89', 'thumbs-up'], ['M4.90625 10.6887', 'hard-drive'], ['M14,7L9,12L14,17V7Z', 'chevron-left'], ['M10,17L15,12L10,7V17Z', 'chevron-right'],
    ['M17.5101 3.8701', 'arrow-left'], ['M16,9H19L14,16', 'gem'], ['M13 11H11V5H13', 'message-square-warning'], ['M5 6C5 5.44772', 'layout-grid'],
    ['M11.4231 14.3496', 'zap'],
  ]
  const FONT_AWESOME = { 'fa-chevron-down': 'chevron-down', 'fa-chevron-up': 'chevron-up', 'fa-chevron-right': 'chevron-right', 'fa-chevron-left': 'chevron-left', 'fa-trophy': 'trophy' }
  // ICONS END

  const draw = (svg, name) => {
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.style.fill = 'none'
    svg.innerHTML = LUCIDE[name]
    svg.dataset.rx = name
  }
  const fresh = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '1em'); svg.setAttribute('height', '1em'); svg.setAttribute('class', 'rx-icon')
    draw(svg, name)
    return svg
  }
  const swap = (root) => {
    for (const use of root.querySelectorAll('svg:not([data-rx]) use')) {
      const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || ''
      const name = SPRITE[ref.split('#')[1]]
      if (name && LUCIDE[name]) draw(use.ownerSVGElement, name)
    }
    for (const svg of root.querySelectorAll('svg:not([data-rx])')) {
      const d = svg.querySelector('path')?.getAttribute('d') ?? ''
      const hit = INLINE.find(([start]) => d.startsWith(start))
      if (hit && LUCIDE[hit[1]]) draw(svg, hit[1])
    }
    for (const el of root.querySelectorAll('.material-icons:not([data-rx]), .material-icons-outlined:not([data-rx]), [class*="material-symbols"]:not([data-rx])')) {
      const name = MATERIAL[el.textContent.trim()]
      if (name && LUCIDE[name]) { el.dataset.rx = name; el.replaceChildren(fresh(name)) }
    }
    for (const el of root.querySelectorAll('[class*="fa-"]:not([data-rx])')) {
      const name = [...el.classList].map(c => FONT_AWESOME[c]).find(Boolean)
      if (name && LUCIDE[name]) { el.dataset.rx = name; el.classList.add('rx-fa'); el.replaceChildren(fresh(name)) }
    }
  }
  // each root is looked at again on the next frame after it changes (Nexus draws parts of its pages late)
  const watch = (root) => {
    let queued = false
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; swap(root) }) } }
    new MutationObserver(later).observe(root, { childList: true, subtree: true })
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

  // Geist under the name every Nexus page asks for, added after the page's own faces so it wins
  try {
    const bytes = Uint8Array.from(atob(__GEIST__), c => c.charCodeAt(0))
    for (const family of ['Inter', 'Geist']) document.fonts.add(new FontFace(family, bytes, { weight: '100 900' }))
  } catch { /* Nexus's own font stays */ }

  document.addEventListener('DOMContentLoaded', page)
  page()
})()
