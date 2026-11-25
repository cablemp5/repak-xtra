// repakxtra: Settings search. While it has text, Settings shows its pages at once and hides every row and section whose
// words do not match. Rows are found by their classes (.setting-item, .xs-row), so a new setting is searchable as is.
import { useLayoutEffect, useRef, type RefObject } from 'react'
import { Search, X } from 'lucide-react'

/** Whether every word of the query is in the text. Pure. */
export const matches = (text: string, query: string) => {
  const t = text.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(w => t.includes(w))
}

/** Hides what does not match inside `root`: a section whose title matches shows whole, else only its matching rows (a
 *  section without rows matches on all its text). `.settings-search-empty` shows when nothing is left. `onPages` gets
 *  the pages with a match, in order: a `[data-page]` mark before a page's sections names it. */
export function useSettingsFilter(root: RefObject<HTMLElement | null>, query: string, onPages?: (pages: string[]) => void) {
  const report = useRef(onPages)
  report.current = onPages
  useLayoutEffect(() => {
    const el = root.current
    if (!el || !query.trim()) return
    const filter = () => {
      let shown = 0, page = ''
      const pages: string[] = []
      el.querySelectorAll<HTMLElement>('[data-page], .setting-section').forEach(section => {
        if (section.dataset.page) { page = section.dataset.page; return }
        const title = section.querySelector('h3')?.textContent ?? ''
        const rows = [...section.querySelectorAll<HTMLElement>('.setting-item, .xs-row')]
        const whole = matches(title, query)
        rows.forEach(r => { r.hidden = !whole && !matches(r.textContent ?? '', query) })
        section.hidden = !whole && (rows.length ? rows.every(r => r.hidden) : !matches(section.textContent ?? '', query))
        section.toggleAttribute('data-first-shown', !section.hidden && shown === 0) // no separator above the first one left
        if (!section.hidden) shown++
        if (!section.hidden && page && !pages.includes(page)) pages.push(page)
      })
      report.current?.(pages)
      const empty = el.querySelector<HTMLElement>('.settings-search-empty')
      if (empty) empty.hidden = shown > 0
    }
    filter()
    // Rows a setting adds later (a note that appears with a switch) are filtered too; the hidden flags set here are
    // attribute changes, which this does not watch
    const watch = new MutationObserver(filter)
    watch.observe(el, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [root, query])
}

/** The field at the top of Settings' page list. Escape clears it first, then closes Settings as before. Enter opens the
 *  first page with a match (`onEnter`). */
export function SettingsSearch({ value, onChange, onEnter }: { value: string; onChange: (v: string) => void; onEnter?: () => void }) {
  return (
    <label className="lp-search settings-search">
      <Search aria-hidden="true" />
      <input type="search" value={value} placeholder="Search settings" aria-label="Search settings" spellCheck={false}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape' && value) { e.stopPropagation(); onChange('') } if (e.key === 'Enter' && value.trim()) onEnter?.() }} />
      {value && <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => onChange('')}><X size={14} /></button>}
    </label>
  )
}

if (import.meta.env.DEV) {
  console.assert(matches('Hold to delete (2 s)', 'delete hold') && !matches('Hold to delete', 'delete mods') && matches('Anything', '  '), 'settings search words')
}
