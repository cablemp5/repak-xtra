// repakxtra: extra keyboard shortcuts plus the full list shown in the F1 help (ShortcutsHelpModal).
// Upstream keys are handled in App.tsx; L in loadoutStore.ts, Ctrl+1-9 in Loadouts.tsx,
// zoom in uiPrefs.tsx. The ones below drive existing buttons, so they follow
// the same rules (game-running locks, confirmations) as clicking.
import { togglePref, toggleTags } from './uiPrefs'
import { modalOpen } from './dialogFocus'

export type Shortcut = { keys: string[]; action: string }
/** The header buttons Settings > Header buttons shows or hides, each on Shift + a letter, in every view. Shift+C stays
 *  the conflict warnings, and a Shift key never also fires its plain letter. */
const HEADER = [
  { key: 'm', pref: 'vfx-updater', name: 'Mod Updater' },
  { key: 'e', pref: 'encrypt', name: 'Encrypt' },
  { key: 'g', pref: 'galacta', name: 'Galacta Converter' },
  { key: 'a', pref: 'asset-explorer', name: 'Asset Explorer' },
  { key: 's', pref: 'share', name: 'Share' },
  { key: 't', pref: 'tools', name: 'Tools' },
]
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
      { keys: ['↑ ↓ ← →'], action: 'Move through the list' },
      { keys: ['Space'], action: 'Turn the selected mod on/off (or Ctrl+E)' },
      { keys: ['Enter'], action: 'Open mod details' },
      { keys: ['F2'], action: 'Rename mod' },
      { keys: ['Del'], action: 'Delete selected mods (Undo for 10 s)' },
      { keys: ['Shift', 'F10'], action: 'Open the right-click menu for the selected mod (or the Menu key)' },
      { keys: ['C'], action: 'Check conflicts' },
      { keys: ['Shift', 'Click'], action: 'Select a range of mods' },
      { keys: ['Shift', 'Ctrl', 'Click'], action: 'Deselect a range of mods' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: ['1'], action: 'Show all mods' },
      { keys: ['2'], action: 'Show mods that are on' },
      { keys: ['3'], action: 'Show mods that are off' },
      { keys: ['V'], action: 'Cycle list / compact list / grid / compact grid' },
      { keys: ['X'], action: 'Clear hero and type filters' },
      { keys: ['T'], action: 'Show / hide tags on mods' },
      { keys: ['P'], action: 'Show / hide the load priority counter' },
      { keys: ['I'], action: 'Show / hide the In loadout tag' },
      { keys: ['E'], action: 'Show / hide the Encrypted tag and the Encrypted tab' },
      { keys: ['B'], action: 'Show / hide Broken and May crash warnings and the Problems tab' },
      { keys: ['Shift', 'C'], action: 'Show / hide conflict warnings' },
      { keys: ['Ctrl', '+'], action: 'Zoom in' },
      { keys: ['Ctrl', '-'], action: 'Zoom out' },
      { keys: ['Ctrl', '0'], action: 'Reset zoom' },
      { keys: ['F3'], action: 'Show / hide the frame rate counter' },
    ],
  },
  {
    title: 'Header buttons',
    items: HEADER.map(h => ({ keys: ['Shift', h.key.toUpperCase()], action: `Show / hide ${h.name}` })),
  },
  {
    title: 'Loadouts',
    items: [
      { keys: ['L'], action: 'Switch between Loadouts and Library' },
      { keys: ['Ctrl', '1–9'], action: 'Turn the loadout pinned to 1–9 on/off (its page: More > Hotkey)' },
      { keys: ['F2'], action: 'Rename the focused loadout card' },
      { keys: ['Ctrl', 'V'], action: 'Paste an image onto the card under the mouse' },
      { keys: ['Ctrl', 'Scroll'], action: 'Change the card size on Loadouts' },
      { keys: ['Esc'], action: "Back from a loadout's page" },
    ],
  },
]

/** True when the key belongs to a text field, so single-letter shortcuts stay out of the way. */
export const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))
}

/** A dialog is open (dialogFocus.ts MODAL: Settings, Sharing, Tools, help...), or Home or Nexus is showing: the
 *  Library's plain-letter shortcuts pause. */
export const dialogOpen = () => modalOpen() || document.documentElement.dataset.view !== 'library'

const VIEWS = ['List View', 'Compact List View', 'Grid View', 'Compact Grid View'] // the four view buttons, in the menu's order

window.addEventListener('keydown', e => {
  // A dialog owns the keyboard, Ctrl+G and Ctrl+O included; an IME finishing a word is not a shortcut
  if (e.defaultPrevented || e.isComposing || isTyping(e.target) || modalOpen()) return
  const click = (selector: string) => {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return
    e.preventDefault()
    el.click()
  }
  const key = e.key.toLowerCase()

  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    if (key === 'g') click('[data-tour="launch-btn"]')
    else if (key === 'o') click('[data-tour="install-btn"]')
    return
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return
  const header = e.shiftKey ? HEADER.find(h => h.key === key) : undefined
  if (header) { e.preventDefault(); togglePref(header.pref, `${header.name} button`); return }
  if (dialogOpen()) return

  // Shift+F10 or the Menu key opens the right-click menu for the selected mod: the browser fires it on the focused
  // element, and arrow keys leave focus on the page, so focus the selected row's name first
  if (key === 'contextmenu' || (key === 'f10' && e.shiftKey)) {
    const row = document.querySelector('.mod-card.viewing')
    if (row && !row.contains(document.activeElement)) row.querySelector<HTMLElement>('.mod-name-button')?.focus()
    return
  }

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
      if (e.shiftKey) { e.preventDefault(); togglePref('conflicts', 'Conflict warnings') }
      else click('.btn-check-conflicts')
      break
    case 'p':
      e.preventDefault()
      togglePref('priority', 'Load priority counter')
      break
    case 'i':
      e.preventDefault()
      togglePref('loadout-tag', 'In loadout tag')
      break
    case 'b':
      e.preventDefault()
      togglePref('broken', 'Broken and May crash warnings')
      break
    case 'e':
      e.preventDefault()
      togglePref('encrypted', 'Encrypted tag')
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
