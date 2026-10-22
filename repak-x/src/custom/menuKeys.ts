import { useEffect, type KeyboardEvent, type RefObject } from 'react'
import { cue } from './sounds'

// Keyboard use for the Library's right-click menu (components/ContextMenu.tsx): it opens with the first item focused,
// arrows move, Right/Enter open a submenu, Left goes back, Enter or Space picks, Tab or Esc close, and focus returns
// to where it was. Applied to the DOM so the menu's markup stays as upstream wrote it.

const ITEM = '.context-menu-item'
const LEVEL = '.context-menu, .submenu'

const levelOf = (el: Element) => el.parentElement?.closest<HTMLElement>(LEVEL) ?? null
const itemsIn = (level: HTMLElement) =>
  [...level.querySelectorAll<HTMLElement>(ITEM)].filter(el => levelOf(el) === level && el.getClientRects().length > 0)

function mark(menu: HTMLElement) {
  menu.setAttribute('role', 'menu')
  for (const sub of menu.querySelectorAll('.submenu')) sub.setAttribute('role', 'menu')
  for (const el of menu.querySelectorAll<HTMLElement>(ITEM)) {
    el.setAttribute('role', 'menuitem')
    el.tabIndex = -1
    if (el.classList.contains('submenu-trigger')) el.setAttribute('aria-haspopup', 'menu')
    if (el.classList.contains('is-disabled')) el.setAttribute('aria-disabled', 'true')
  }
}

/** Returns the onKeyDown for the menu's root element. `place` positions a submenu the way hovering does. */
export function useMenuKeys(ref: RefObject<HTMLElement | null>, onClose: () => void, place: (trigger: HTMLElement) => void) {
  useEffect(() => {
    const menu = ref.current
    if (!menu) return
    const back = document.activeElement as HTMLElement | null
    mark(menu)
    cue('open', { emphasis: 'subtle' }) // a right-click has no click to sound it
    itemsIn(menu)[0]?.focus({ preventScroll: true })
    // Put focus back unless the picked action moved it somewhere on purpose (a rename field, a dialog)
    return () => {
      const now = document.activeElement
      if ((!now || now === document.body) && back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  return (e: KeyboardEvent<HTMLElement>) => {
    const menu = ref.current
    if (!menu || e.key === 'Escape') return // Esc is ContextMenu's own capture listener
    e.stopPropagation() // the Library's arrow, Enter and letter shortcuts stay out of the menu
    mark(menu)
    const current = (e.target as HTMLElement).closest<HTMLElement>(ITEM)
    const level = current ? levelOf(current) ?? menu : menu
    const items = itemsIn(level)
    const at = current ? items.indexOf(current) : -1
    const go = (i: number) => {
      for (const it of items) it.classList.remove('kb-open')
      items[(i + items.length) % items.length]?.focus({ preventScroll: true })
    }
    const openSub = () => {
      if (!current?.classList.contains('submenu-trigger')) return false
      for (const it of items) it.classList.toggle('kb-open', it === current)
      place(current)
      const sub = current.querySelector<HTMLElement>(':scope > .submenu')
      if (sub) itemsIn(sub)[0]?.focus({ preventScroll: true })
      return true
    }

    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(-1)
    else if (e.key === 'ArrowRight') openSub()
    else if (e.key === 'ArrowLeft') {
      const trigger = level.closest<HTMLElement>('.submenu-trigger')
      if (!trigger) return
      trigger.classList.remove('kb-open')
      trigger.focus({ preventScroll: true })
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!openSub()) current?.click()
    } else if (e.key === 'Tab') onClose()
    else return
    e.preventDefault()
  }
}
