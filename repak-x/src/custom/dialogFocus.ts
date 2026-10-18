// repakxtra: keyboard focus for a modal dialog. Focus moves into the dialog when it opens, Tab and Shift+Tab stay inside
// it, and focus goes back to what opened it on close. The dialog element needs tabIndex={-1} (theme.css draws no ring on it).
import { useEffect, useRef } from 'react'
import type React from 'react'

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export function useDialogFocus<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => { before?.focus?.() }
  }, [])
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return
    const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null)
    if (!all.length) return
    const [first, last] = [all[0], all[all.length - 1]]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus() }
  }
  return { ref, onKeyDown }
}
