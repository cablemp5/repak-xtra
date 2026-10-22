// repakxtra: keyboard focus in the Library list. Arrow keys move focus with the viewed mod (App.tsx calls focusRow), so
// Enter, Space and Shift+F10 act on the row on show and the ring shows where you are. When a list change takes the
// focused row away (a filter, a sort, a delete, a view switch remounts the list) focus goes back to the same mod, else
// to the next one still listed, else the empty state's button or the search. relink keeps checked and viewed mods
// pointing at their files after an on/off switch or a change made from Home.
import { useLayoutEffect, useRef } from 'react'

/** A mod's identity across an on/off switch: the file is renamed, its stem stays (ModsList keys its cards the same way). */
export const rowKey = (path: string) => path.replace(/\.(pak|bak_repak|pak_disabled)$/i, '')

/** Pure: the mod to focus once `lost` may be gone: itself when still listed, else the next one after it in the old order
 *  that is still listed, else the nearest one before it, else null (nothing left: the search takes focus). */
export function survivor(prev: string[], next: string[], lost: string): string | null {
  const still = new Set(next)
  if (still.has(lost)) return lost
  const at = prev.indexOf(lost)
  if (at < 0) return null
  for (let i = at + 1; i < prev.length; i++) if (still.has(prev[i])) return prev[i]
  for (let i = at - 1; i >= 0; i--) if (still.has(prev[i])) return prev[i]
  return null
}

/** Pure: `paths` moved to the files they are now (same stem), the ones no longer installed dropped. Null when unchanged. */
export function relink(paths: Iterable<string>, current: string[]): string[] | null {
  const byKey = new Map(current.map(p => [rowKey(p), p]))
  const was = [...paths]
  const now = was.flatMap(p => (byKey.has(rowKey(p)) ? [byKey.get(rowKey(p))!] : []))
  return now.length === was.length && now.every((p, i) => p === was[i]) ? null : now
}

let focused: string | null = null // the row focus is in, or was in when it fell to the page (cleared once anything else takes it)
let wanted: string | null = null // a row to focus as soon as it is in the page (a long list mounts it once scrolled to)
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('focusin', e => {
    const card = e.target instanceof Element ? e.target.closest('.center-panel .mod-card') : null
    focused = card ? rowKey(card.getAttribute('data-mod-path') ?? '') : null
    wanted = null // focus went somewhere: a row still waiting to mount no longer takes it
  })
}

const shown = (el: Element | null | undefined): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0

/** Moves focus to this mod's row (its name button): now when it is in the page, else once it is rendered. */
export function focusRow(path: string) {
  wanted = rowKey(path)
  focusPending()
}

/** Focuses the row waiting for focus once it is mounted. The list calls it after its own renders (virtualRows.ts). */
export function focusPending() {
  if (!wanted) return
  const card = [...document.querySelectorAll('.center-panel .mod-card')].find(c => rowKey(c.getAttribute('data-mod-path') ?? '') === wanted)
  const button = card?.querySelector('.mod-name-button')
  if (shown(button)) { wanted = null; button.focus({ preventScroll: true }) }
}

/** Runs after every Library render. `view` makes the row that takes focus the viewed one when the viewed mod left. */
export function useLibraryFocus<M extends { path: string }>(mods: M[], viewMode: string, viewed: string | null, view: (mod: M) => void) {
  const last = useRef<{ keys: string[]; mode: string }>({ keys: [], mode: viewMode })
  useLayoutEffect(() => {
    const keys = mods.map(m => rowKey(m.path))
    const was = last.current
    last.current = { keys, mode: viewMode }
    const grid = document.querySelector('.center-panel .mod-list-grid')
    if (!shown(grid)) return // Home is showing
    const nameButton = (key: string) => {
      const mod = mods[keys.indexOf(key)]
      return mod ? grid.querySelector<HTMLElement>(`[data-mod-path="${CSS.escape(mod.path)}"] .mod-name-button`) : null
    }
    if (wanted) {
      if (!keys.includes(wanted)) wanted = null
      focusPending()
      return
    }
    const lost = document.activeElement === null || document.activeElement === document.body
    if (!focused || !lost) return
    if (was.mode === viewMode && was.keys.length === keys.length && was.keys.every((k, i) => k === keys[i])) return
    const to = survivor(was.keys, keys, focused)
    if (!to) {
      [...document.querySelectorAll('.center-panel .empty-state button, .main-search-input')].find(shown)?.focus()
      return
    }
    if (to !== focused && (!viewed || rowKey(viewed) === focused)) view(mods[keys.indexOf(to)])
    const button = nameButton(to)
    // after a view switch a long list's first render still holds the last view's slice: its rows move away next render
    const stale = was.mode !== viewMode && grid.querySelector(':scope > .mod-list-spacer')
    if (shown(button) && !stale) {
      button.focus({ preventScroll: true })
      button.scrollIntoView({ block: 'nearest' })
    } else wanted = to // not mounted (a long list, or a view switch started it at the top): focused once it is
  })
}

if (import.meta.env.DEV) {
  const prev = ['a', 'b', 'c', 'd']
  console.assert(survivor(prev, ['d', 'c', 'b', 'a'], 'b') === 'b', 'survivor: a sort keeps focus on the same mod')
  console.assert(survivor(prev, ['a', 'c', 'd'], 'b') === 'c', 'survivor: a deleted row hands focus to the next one')
  console.assert(survivor(prev, ['a', 'd'], 'b') === 'd', 'survivor: the next one still listed, skipping filtered ones')
  console.assert(survivor(prev, ['a', 'b'], 'd') === 'b', 'survivor: the last row gone, the one before it')
  console.assert(survivor(prev, [], 'b') === null, 'survivor: nothing left, the search takes focus')
  console.assert(rowKey('C:/m/Foo_9999999_P.pak_disabled') === rowKey('C:/m/Foo_9999999_P.pak'), 'rowKey: an on/off switch keeps the identity')
  console.assert(relink(['x/A.pak', 'x/B.pak'], ['x/A.pak', 'x/B.pak']) === null, 'relink: nothing changed')
  console.assert(relink(['x/A.pak', 'x/B.pak'], ['x/A.pak_disabled'])?.join() === 'x/A.pak_disabled', 'relink: renamed kept, removed dropped')
}
