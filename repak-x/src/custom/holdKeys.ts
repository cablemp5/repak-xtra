import type { KeyboardEvent } from 'react'

/** Enter and Space on a Delete button. With hold-to-delete on, a held key works like a held pointer. Without it the
 *  button's own click does the delete. Either way App's global Enter (open mod details) never sees the key. */
export function holdKeys(hold: boolean, start: (e: KeyboardEvent<HTMLElement>) => void, cancel: () => void) {
  const on = (down: boolean) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.stopPropagation()
    if (!hold) return
    e.preventDefault()
    if (!down) cancel()
    else if (!e.repeat) start(e)
  }
  return { onKeyDown: on(true), onKeyUp: on(false) }
}
