// repakxtra: keyboard focus and modality for dialogs. useDialogFocus moves focus into a dialog when it opens, keeps Tab
// and Shift+Tab inside it, and gives focus back to its opener on close (or a sensible place when the opener is gone).
// The dialog element needs tabIndex={-1} (theme.css draws no ring on it). Below it, one "a dialog is open" contract
// for every overlay (MODAL): the Library's shortcuts pause, only the top dialog takes Esc, and everything behind it is
// inert, so it can be neither clicked nor focused.
import { useEffect, useRef } from 'react'
import type React from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
/** Every overlay that owns the screen while it shows. Dialogs declare aria-modal; the rest are upstream overlays. */
export const MODAL = '[aria-modal="true"], .modal-overlay, .p2p-overlay, .input-prompt-overlay, .quick-organize-overlay, .extension-overlay'
/** Never inert behind a dialog: the window's own title bar, toasts and their announcements, menus a dialog put on <body>. */
const KEEP = '.titlebar, .toast-container, .xtra-live, body > [role="menu"], body > [role="listbox"]'
/** Where focus goes when a dialog closes and its opener is gone (a menu item, say): the viewed mod, else the search. */
const FALLBACK = '.mod-card.viewing .mod-name-button, .main-search-input'

/** Pure: the top one of `found` (document order). The most recently opened wins, the later one on a tie (a dialog
 *  inside its own overlay, both new at once). */
export function pickTop<T>(found: T[], order: (el: T) => number): T | null {
  let top: T | null = null
  let best = -Infinity
  for (const el of found) { const n = order(el); if (n >= best) { best = n; top = el } }
  return top
}

/** Pure: the branches to make inert so only `keep` stays usable. Never an ancestor of a kept element: those are
 *  walked into instead, and their other children go inert. */
export function background<T extends { children: ArrayLike<T>; contains(other: T): boolean }>(root: T, keep: T[]): T[] {
  const out: T[] = []
  const walk = (parent: T) => {
    for (const child of Array.from(parent.children)) {
      if (keep.includes(child)) continue
      if (keep.some(k => child.contains(k))) walk(child)
      else out.push(child)
    }
  }
  walk(root)
  return out
}

/** Pure: where Tab goes in a dialog. `at` is the focused control's index (-1: the dialog itself or outside it).
 *  Returns the index to focus, -1 for the dialog itself (nothing to tab to), or null for the browser's own move. */
export function tabTarget(at: number, count: number, shift: boolean): number | null {
  if (count === 0) return -1
  if (shift) return at <= 0 ? count - 1 : null
  return at === -1 || at === count - 1 ? 0 : null
}

const opened = new WeakMap<Element, number>()
let seq = 0
/** The dialog on top right now, or null when none is open. */
export function topModal(): HTMLElement | null {
  const found = [...document.querySelectorAll<HTMLElement>(MODAL)]
  for (const el of found) if (!opened.has(el)) opened.set(el, ++seq)
  return pickTop(found, el => opened.get(el) ?? 0)
}
/** A dialog is open: background shortcuts stay quiet. */
export const modalOpen = () => topModal() !== null
/** `el` is the top dialog (or inside it): only the top one takes Esc and Tab. */
export const ownsTop = (el: Element | null) => {
  const top = topModal()
  return Boolean(el && top && (top === el || top.contains(el)))
}

const usable = (el: Element | null | undefined): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && !el.closest('[inert]') && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0
const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(usable)
const focusLost = () => !document.activeElement || document.activeElement === document.body
/** Focus into a dialog: the dialog element when it takes focus, else its first control. */
export function focusInto(top: HTMLElement) {
  const dialog = top.matches('[role="dialog"]') ? top : top.querySelector<HTMLElement>('[role="dialog"]') ?? top
  ;(dialog.hasAttribute('tabindex') ? dialog : focusables(dialog)[0])?.focus()
}

let mine: Element[] = [] // the elements this module made inert (accordions set their own, which stay theirs)
/** Makes everything behind the top dialog inert, and frees it once no dialog is open. With `rescue`, focus left on
 *  <body> (a dialog that does not move it, or the one above closed) goes into the top dialog. */
export function syncInert(rescue = true) {
  const top = topModal()
  const next = top
    ? background<Element>(document.body, [top, ...document.querySelectorAll(KEEP)]).filter(el => mine.includes(el) || !el.hasAttribute('inert'))
    : []
  for (const el of mine) if (!next.includes(el)) el.removeAttribute('inert')
  for (const el of next) el.setAttribute('inert', '')
  mine = next
  if (top && rescue && focusLost()) focusInto(top)
}

if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  let queued = false
  new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => { queued = false; syncInert() })
  }).observe(document.body, { childList: true, subtree: true })
}

/** `active`: for a component that stays mounted and shows its dialog only sometimes (FirstRun). */
export function useDialogFocus<T extends HTMLElement = HTMLDivElement>(active = true) {
  const ref = useRef<T>(null)
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!active) return
    const el = ref.current
    const now = document.activeElement as HTMLElement | null
    if (!opener.current && now && now !== document.body && !el?.contains(now)) opener.current = now // Strict Mode remounts: the first opener
    syncInert(false)
    if (el && !el.contains(document.activeElement)) el.focus()
    return () => {
      // After the dialog left the page: the background is freed first, or focusing back into it would do nothing
      requestAnimationFrame(() => {
        if (el?.isConnected) return // still showing (Strict Mode's test remount)
        syncInert(false)
        const back = opener.current
        opener.current = null
        if (!focusLost()) return // focus already went somewhere on purpose
        const top = topModal()
        if (usable(back) && (!top || top.contains(back))) back.focus()
        else if (top) focusInto(top) // a dialog above another closed: back to that one
        else [...document.querySelectorAll(FALLBACK)].find(usable)?.focus()
      })
    }
  }, [active])
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = ref.current
    if (e.key !== 'Tab' || e.defaultPrevented || !el || !ownsTop(el)) return // a dialog opened inside this one traps its own Tab
    const all = focusables(el)
    const to = tabTarget(all.indexOf(document.activeElement as HTMLElement), all.length, e.shiftKey)
    if (to === null) return
    e.preventDefault()
    ;(to === -1 ? el : all[to]).focus()
  }
  return { ref, onKeyDown }
}

if (import.meta.env.DEV) {
  console.assert(pickTop(['a', 'b', 'c'], x => ({ a: 2, b: 1, c: 1 })[x]!) === 'a', 'pickTop: the newest dialog wins over later document order')
  console.assert(pickTop(['overlay', 'dialog'], () => 3) === 'dialog', 'pickTop: a tie goes to the later one (the dialog in its overlay)')
  console.assert(pickTop([], () => 0) === null, 'pickTop: none open')
  type N = { name: string; children: N[]; contains(o: N): boolean }
  const n = (name: string, children: N[] = []): N => ({ name, children, contains(o) { return o === this || children.some(c => c.contains(o)) } })
  const dialog = n('dialog'), toasts = n('toasts'), main = n('main'), header = n('header')
  const app = n('app', [header, main, n('overlay', [dialog])]), body = n('body', [n('root', [app, toasts]), n('splash')])
  const names = (xs: N[]) => xs.map(x => x.name).join()
  console.assert(names(background(body, [dialog, toasts])) === 'header,main,splash', 'background: siblings along the path go inert, kept ones stay')
  console.assert(!background(body, [dialog, toasts]).some(x => x.contains(dialog)), 'background: never an ancestor of the dialog')
  const child = n('child'), parent = n('parent', [n('fields'), child])
  console.assert(names(background(n('b', [n('root', [parent])]), [child])) === 'fields', 'background: a nested dialog makes its parent\'s other parts inert')
  console.assert(tabTarget(2, 3, false) === 0 && tabTarget(0, 3, true) === 2, 'tabTarget: Tab and Shift+Tab wrap at the ends')
  console.assert(tabTarget(-1, 3, false) === 0 && tabTarget(-1, 3, true) === 2, 'tabTarget: from the dialog itself, into its first or last control')
  console.assert(tabTarget(1, 3, false) === null && tabTarget(1, 3, true) === null, 'tabTarget: the middle is the browser\'s own move')
  console.assert(tabTarget(-1, 0, false) === -1 && tabTarget(-1, 0, true) === -1, 'tabTarget: no controls, focus stays on the dialog')
}
