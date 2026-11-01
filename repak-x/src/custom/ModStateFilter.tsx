// repakxtra: All / On / Off switch next to the list title, plus Problems (Broken and May crash) while any mod will not work in the
// installed game version or may crash (custom/brokenMods.ts). When the tabs would not fit beside the title (a filter
// lengthens it, or the sidebar or details panel narrows the header) they fold into one menu, like the view buttons, so
// the header keeps to one row. The tabs stay in the page unseen then: the 1/2/3 keys still click them, and their width
// says when they fit again.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useBrokenVersion, verdictOf } from './brokenMods'
import { useUiPref } from './uiPrefs'

export type ModState = 'all' | 'enabled' | 'disabled' | 'broken' | 'encrypted'

/** `encrypted`: whether a mod is encrypted (its details' is_encrypted), for the Encrypted tab. */
export const matchesState = (state: ModState, encrypted?: (path: string) => boolean) => (mod: { path: string; enabled?: boolean }) =>
  state === 'all' || (state === 'broken' ? Boolean(verdictOf(mod.path)) : state === 'encrypted' ? Boolean(encrypted?.(mod.path)) : (state === 'enabled') === Boolean(mod.enabled))

type Props = {
  value: ModState
  onChange: (state: ModState) => void
  mods: { path: string; enabled?: boolean }[]
  encrypted?: (path: string) => boolean // repakxtra: the Encrypted tab, shown while any mod is encrypted
}

const BROKEN_TITLE = 'Mods marked Broken (will not work in this game version), Needs update or May crash. Hover a badge for why'

/** Whether the tabs fit beside the header's title and buttons, measured live. */
function useFolded(tabs: React.RefObject<HTMLDivElement | null>) {
  const [folded, setFolded] = useState(false)
  useLayoutEffect(() => {
    const head = tabs.current?.closest<HTMLElement>('.center-header')
    if (!head) return
    const title = head.querySelector<HTMLElement>('.header-title h2')
    const actions = head.querySelector<HTMLElement>('.header-actions')
    let frame = 0
    // The title reads narrower folded (73px) than unfolded (113px), more than the 24px of slack below: at some widths that
    // flipped the tabs every frame. So its width is the widest it has measured for these words, the same in both states.
    const seen = { text: '', width: 0 }
    const measure = () => {
      frame = 0
      const pad = parseFloat(getComputedStyle(head).paddingLeft) + parseFloat(getComputedStyle(head).paddingRight)
      if (title && title.textContent !== seen.text) { seen.text = title.textContent ?? ''; seen.width = 0 }
      seen.width = Math.max(seen.width, title?.scrollWidth ?? 0)
      // title (its full text, not squeezed) + 14px gap + tabs + 12px before the buttons
      // the view buttons opened by hover push the buttons wider for a moment: measure them as they rest (one view)
      const sw = actions?.querySelector<HTMLElement>('.view-switcher-slot .view-switcher')
      const opened = sw && sw.matches(':hover, :focus-within') ? sw.offsetWidth - (sw.querySelector<HTMLElement>('.active')?.offsetWidth ?? sw.offsetWidth) - 4 : 0
      const room = head.clientWidth - pad - seen.width - 14 - ((actions?.offsetWidth ?? 0) - Math.max(0, opened)) - 12
      const need = tabs.current?.scrollWidth ?? 0
      // 24px of slack before unfolding, so a panel sliding open or shut flips it once, not back and forth
      setFolded(was => (was ? room < need + 24 : room < need))
    }
    const check = () => { if (!frame) frame = requestAnimationFrame(measure) } // at most once a frame while a panel animates
    const ro = new ResizeObserver(check)
    for (const el of [head, title, actions]) if (el) ro.observe(el)
    const mo = title ? new MutationObserver(check) : null // the title's words change with the filters, its box may not
    mo?.observe(title!, { childList: true, subtree: true, characterData: true })
    measure()
    return () => { ro.disconnect(); mo?.disconnect(); cancelAnimationFrame(frame) }
  }, [tabs])
  return folded
}

export default function ModStateFilter({ value, onChange, mods, encrypted }: Props) {
  useBrokenVersion()
  const enabled = mods.filter(m => m.enabled).length
  const shown = useUiPref('broken') // Settings can hide the Problems tab and badges
  const broken = shown ? mods.filter(m => verdictOf(m.path)).length : 0
  const locked = useUiPref('encrypted') && encrypted ? mods.filter(m => encrypted(m.path)).length : 0 // Settings hides the lock and this tab
  // the last broken (or encrypted) mod fixed or removed: back to every mod rather than an empty list
  useEffect(() => { if ((value === 'broken' && broken === 0) || (value === 'encrypted' && locked === 0)) onChange('all') }, [value, broken, locked]) // eslint-disable-line react-hooks/exhaustive-deps
  const options: [ModState, string, number][] = [
    ['all', 'All', mods.length],
    ['enabled', 'On', enabled],
    ['disabled', 'Off', mods.length - enabled],
    ...(broken ? [['broken', 'Problems', broken] as [ModState, string, number]] : []),
    ...(locked ? [['encrypted', 'Encrypted', locked] as [ModState, string, number]] : []),
  ]
  const tabs = useRef<HTMLDivElement>(null)
  const folded = useFolded(tabs)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', esc, true) }
  }, [open])
  useEffect(() => { if (!folded) setOpen(false) }, [folded])
  const [, label, count] = options.find(([s]) => s === value) ?? options[0]

  return (
    <div className={`mod-state${folded ? ' is-folded' : ''}`} ref={wrap} data-tour="mod-state">
      <div className="mod-state-filter" role="group" aria-label="Show mods" ref={tabs} aria-hidden={folded || undefined}>
        {options.map(([state, label, count]) => (
          <button key={state} type="button" aria-pressed={value === state} onClick={() => onChange(state)} tabIndex={folded ? -1 : undefined}
            className={state === 'broken' ? 'is-broken' : undefined} title={state === 'broken' ? BROKEN_TITLE : undefined}>
            {label}
            <span className="mod-state-count">{count.toLocaleString()}</span>
          </button>
        ))}
      </div>
      {folded && (
        <>
          <button type="button" className={`btn-ghost mod-state-btn${value === 'broken' ? ' is-broken' : ''}`} aria-haspopup="menu" aria-expanded={open}
            onClick={() => setOpen(v => !v)} title={`Show: ${label}`}>
            {label}<span className="mod-state-count">{count.toLocaleString()}</span><ChevronDown size={13} aria-hidden="true" />
          </button>
          {open && (
            <div className="sigeon-menu mod-state-menu" role="menu" aria-label="Show mods">
              {options.map(([state, label, count]) => (
                <button key={state} type="button" role="menuitemradio" aria-checked={value === state}
                  className={`sigeon-item${state === 'broken' ? ' is-broken' : ''}`} onClick={() => { onChange(state); setOpen(false) }}
                  title={state === 'broken' ? BROKEN_TITLE : undefined}>
                  {label}<span className="mod-state-count">{count.toLocaleString()}</span>{value === state && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
