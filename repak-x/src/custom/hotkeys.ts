// caleb fork: extra keyboard shortcuts plus the full list shown in the F1 help (ShortcutsHelpModal).
// Upstream keys are handled in App.tsx; L in loadoutStore.ts, Ctrl+1-9 in Loadouts.tsx, S in
// SigeonControl.tsx, zoom in uiPrefs.tsx. The ones below drive existing buttons, so they follow
// the same rules (game-running locks, confirmations) as clicking.
import { toggleTags } from './uiPrefs'

export type Shortcut = { keys: string[]; action: string }
export const SHORTCUT_GROUPS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'General',
    items: [
      { keys: ['F1'], action: 'Show this list' },
      { keys: ['Ctrl', 'G'], action: 'Launch the game' },
      { keys: ['Ctrl', 'O'], action: 'Install PAKs or archives' },
      { keys: ['Ctrl', ','], action: 'Open Settings' },
      { keys: ['Ctrl', 'F'], action: 'Search (or press /)' },
      { keys: ['Esc'], action: 'Close panel / deselect' },
      { keys: ['Ctrl', 'Shift', 'R'], action: 'Refresh the mod list' },
      { keys: ['Ctrl', 'R'], action: 'Reload the whole app' },
    ],
  },
  {
    title: 'Mods',
    items: [
      { keys: ['↑', '↓', '←', '→'], action: 'Move through the list' },
      { keys: ['Space'], action: 'Turn the selected mod on/off (or Ctrl+E)' },
      { keys: ['Enter'], action: 'Open mod details' },
      { keys: ['F2'], action: 'Rename mod' },
      { keys: ['Del'], action: 'Delete selected mods (Undo for 10 s)' },
      { keys: ['C'], action: 'Check conflicts' },
      { keys: ['Shift', 'Click'], action: 'Select a range of mods' },
      { keys: ['Shift', 'Ctrl', 'Click'], action: 'Deselect a range of mods' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: ['1'], action: 'Show all mods' },
      { keys: ['2'], action: 'Show enabled mods' },
      { keys: ['3'], action: 'Show disabled mods' },
      { keys: ['V'], action: 'Cycle list / grid / compact grid' },
      { keys: ['X'], action: 'Clear hero and type filters' },
      { keys: ['T'], action: 'Show / hide tags on mods' },
      { keys: ['Ctrl', '+'], action: 'Zoom in' },
      { keys: ['Ctrl', '-'], action: 'Zoom out' },
      { keys: ['Ctrl', '0'], action: 'Reset zoom' },
    ],
  },
  {
    title: 'Loadouts and Sigeon',
    items: [
      { keys: ['L'], action: 'Switch between Loadouts and Library' },
      { keys: ['Ctrl', '1–9'], action: 'Turn loadout 1–9 on/off (sidebar order)' },
      { keys: ['S'], action: 'Cycle Sigeon: Off → Base → High' },
    ],
  },
]

/** True when the key belongs to a text field, so single-letter shortcuts stay out of the way. */
export const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
}

/** A dialog (Settings, Tools, help) is open, or Home is showing: the Library's plain-letter shortcuts pause. */
export const dialogOpen = () => Boolean(document.querySelector('.modal-overlay')) || document.documentElement.dataset.view === 'home'

const VIEWS = ['List View', 'Grid View', 'Compact Grid View']

window.addEventListener('keydown', e => {
  if (e.defaultPrevented || isTyping(e.target)) return
  const click = (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return
    e.preventDefault()
    el.click()
  }
  const key = e.key.toLowerCase()

  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    if (key === 'g') click('[data-tour="launch-btn"]')
    else if (key === 'o') click('[title="Install PAKs or Archives"]')
    return
  }
  if (e.ctrlKey || e.altKey || e.metaKey || dialogOpen()) return

  switch (key) {
    case '/':
      e.preventDefault()
      document.querySelector<HTMLInputElement>('.main-search-input')?.focus()
      break
    case '1': case '2': case '3':
      click(`.mod-state-filter button:nth-child(${key})`)
      break
    case ' ': {
      // A focused control keeps its own Space; the mod name button is the usual focus after a click
      const focused = document.activeElement as HTMLElement | null
      if (focused && focused !== document.body && !focused.classList.contains('mod-name-button')) return
      click('.mod-card.viewing .repakx-switch-control')
      break
    }
    case 'c':
      click('.btn-check-conflicts')
      break
    case 'v': {
      const buttons = VIEWS.map(t => document.querySelector<HTMLElement>(`[title="${t}"]`))
      const current = buttons.findIndex(b => b?.classList.contains('active'))
      e.preventDefault()
      buttons[(current + 1) % VIEWS.length]?.click()
      break
    }
    case 'x':
      click('.fp-clear')
      break
    case 't':
      e.preventDefault()
      toggleTags()
      break
  }
})
