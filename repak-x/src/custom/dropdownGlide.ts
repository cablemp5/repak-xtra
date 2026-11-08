import './dropdownGlide.css'

// Like segSlide, this reaches menus in every window, including portals and nested scrolling lists.
const MENUS = '[role="menu"], .custom-dropdown-menu, .context-menu, .submenu, .scrollable-menu-list, .sl-menu-items, .lp-more-view, .ae-export-menu, .ae-mod-menu, .ae-mod-menu-list'
const ROWS = '[role^="menuitem"], [role="option"], .context-menu-item, .custom-dropdown-item, .xtra-item, .ae-export-menu > button, .ae-mod-menu-item, .ae-mod-menu-clear'
const SELECTED = '[aria-selected="true"], [aria-checked="true"], .selected'
const DISABLED = ':disabled, [aria-disabled="true"], .disabled, .is-disabled'
const menus = new Map<HTMLElement, HTMLElement | null>()

/** A row in a sticky footer (the install card's "+ New loadout"): its opaque backing would hide a highlight drawn
 *  under the rows, so the highlight goes over it, as for the add-new footer. */
function pinned(menu: HTMLElement, row: HTMLElement) {
  for (let e: HTMLElement | null = row; e && e !== menu; e = e.parentElement) if (getComputedStyle(e).position === 'sticky') return true
  return false
}

function place(menu: HTMLElement, row: HTMLElement) {
  if (row.matches(DISABLED) || !row.isConnected || !row.getClientRects().length) return
  const box = menu.getBoundingClientRect(), rect = row.getBoundingClientRect()
  if (!box.width || !rect.width) return
  const scale = box.width / menu.offsetWidth
  const first = !menus.get(menu)
  if (first) menu.setAttribute('data-glide-instant', '')
  menu.style.setProperty('--dg-x', `${(rect.left - box.left) / scale + menu.scrollLeft - menu.clientLeft}px`)
  menu.style.setProperty('--dg-y', `${(rect.top - box.top) / scale + menu.scrollTop - menu.clientTop}px`)
  menu.style.setProperty('--dg-w', `${rect.width / scale}px`)
  menu.style.setProperty('--dg-h', `${rect.height / scale}px`)
  menu.style.setProperty('--dg-radius', getComputedStyle(row).borderRadius)
  menu.toggleAttribute('data-glide-footer', row.classList.contains('add-new') || pinned(menu, row))
  menu.style.setProperty('--dg-color', row.matches('.danger, .is-danger') ? 'rgba(242, 85, 90, 0.1)'
    : menu.matches('.ae-export-menu') ? 'color-mix(in srgb, var(--accent-primary), transparent 88%)'
    : menu.matches('.ae-mod-menu-list') ? 'var(--bg-light)'
    : row.matches(SELECTED) ? 'var(--quiet-active)' : 'var(--quiet-hover)')
  menu.setAttribute('data-glide-live', '')
  if (first) {
    // Commit the first position before enabling transitions, so opening never flies in from (0, 0).
    void getComputedStyle(menu, '::before').transform
    menu.removeAttribute('data-glide-instant')
  }
  menus.set(menu, row)
}

function refresh(menu: HTMLElement) {
  if (!menus.has(menu)) {
    menus.set(menu, null)
    if (getComputedStyle(menu).position === 'static') menu.setAttribute('data-glide-static', '')
    menu.setAttribute('data-glide-menu', '')
    sized.observe(menu)
  }
  const rows = [...menu.querySelectorAll<HTMLElement>(ROWS)].filter(row => row.parentElement?.closest(MENUS) === menu)
  for (const row of rows) row.setAttribute('data-glide-row', '')
  const active = menus.get(menu)
  if (active && rows.includes(active) && !active.matches(DISABLED)) place(menu, active)
  else {
    menus.set(menu, null)
    menu.removeAttribute('data-glide-live')
    const selected = rows.find(row => row.matches(SELECTED) && !row.matches(DISABLED))
    if (selected) place(menu, selected)
  }
}

const sized = new ResizeObserver(entries => {
  for (const { target } of entries) if (target instanceof HTMLElement) refresh(target)
})
const within = (node: Node) => node instanceof HTMLElement
  ? [...(node.matches(MENUS) ? [node] : []), ...node.querySelectorAll<HTMLElement>(MENUS)] : []

function follow(event: Event) {
  if (!(event.target instanceof Element)) return
  const row = event.target.closest<HTMLElement>(ROWS)
  const menu = row?.parentElement?.closest<HTMLElement>(MENUS)
  if (!row || !menu) return
  if (!menus.has(menu)) refresh(menu)
  if (row.matches(DISABLED)) {
    menu.removeAttribute('data-glide-live')
    menus.set(menu, null)
  } else place(menu, row)
}

// Leaving a menu hands the highlight back to its selected row, or hides it, instead of leaving it on the last hovered one.
function leave(event: PointerEvent) {
  const to = event.relatedTarget instanceof Node ? event.relatedTarget : null
  let menu = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-glide-menu]') : null
  for (; menu && !menu.contains(to); menu = menu.parentElement?.closest<HTMLElement>('[data-glide-menu]') ?? null) {
    const selected = [...menu.querySelectorAll<HTMLElement>(ROWS)]
      .find(row => row.parentElement?.closest(MENUS) === menu && row.matches(SELECTED) && !row.matches(DISABLED))
    if (selected) place(menu, selected)
    else { menu.removeAttribute('data-glide-live'); menus.set(menu, null) }
  }
}

function forget(menu: HTMLElement) {
  sized.unobserve(menu)
  menus.delete(menu)
  for (const attr of ['data-glide-menu', 'data-glide-live', 'data-glide-static', 'data-glide-instant', 'data-glide-footer']) menu.removeAttribute(attr)
  for (const name of ['x', 'y', 'w', 'h', 'radius', 'color']) menu.style.removeProperty(`--dg-${name}`)
  for (const row of menu.querySelectorAll('[data-glide-row]')) row.removeAttribute('data-glide-row')
}

function scroll(event: Event) {
  if (!(event.target instanceof HTMLElement)) return
  const menu = event.target, row = menus.get(menu)
  if (!row) return
  menu.setAttribute('data-glide-instant', '')
  place(menu, row)
  void getComputedStyle(menu, '::before').transform
  menu.removeAttribute('data-glide-instant')
}

const changed = new MutationObserver(records => {
  const dirty = new Set<HTMLElement>()
  // With no menu mounted (the usual case while the Library scrolls) only a newly added menu matters
  const open = menus.size > 0
  for (const record of records) {
    if (open && record.target instanceof Element) {
      const menu = record.target.closest<HTMLElement>(MENUS)
      if (menu) dirty.add(menu)
    }
    record.addedNodes.forEach(node => {
      if (node instanceof HTMLElement && (node.matches(MENUS) || node.querySelector(MENUS))) within(node).forEach(menu => dirty.add(menu))
    })
  }
  if (open) for (const menu of menus.keys()) if (!menu.isConnected) forget(menu)
  for (const menu of dirty) if (menu.isConnected) refresh(menu)
})
changed.observe(document.documentElement, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['aria-selected', 'aria-checked', 'aria-disabled', 'disabled'],
})
document.addEventListener('pointerover', follow)
document.addEventListener('focusin', follow)
document.addEventListener('pointerout', leave)
document.addEventListener('scroll', scroll, true)
document.querySelectorAll<HTMLElement>(MENUS).forEach(refresh)

if (import.meta.hot) import.meta.hot.dispose(() => {
  changed.disconnect()
  sized.disconnect()
  document.removeEventListener('pointerover', follow)
  document.removeEventListener('focusin', follow)
  document.removeEventListener('pointerout', leave)
  document.removeEventListener('scroll', scroll, true)
  for (const menu of menus.keys()) forget(menu)
})
