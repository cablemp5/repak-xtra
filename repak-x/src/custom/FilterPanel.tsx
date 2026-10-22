// repakxtra: sidebar filters as T3-style rows. Heroes with portrait and count (skins expand under
// their hero), types with a color dot and count, then Nexus (installed from Nexus Mods, nexusSource.tsx) and Project
// Galacta with their logos. Everything is multi-select; one Clear resets both.
import { useMemo, useState } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import { resolveHeroImage, useHeroImages } from '../utils/heroImages'
import { NEXUS_TYPE, sourceOf, useNexusVersion } from './nexusSource'
import { useUiPref } from './uiPrefs'
import { loadoutable, modKey } from './loadoutStore'
import { heroLabel } from './silhouettes'
import { savedItem } from './storageCarryOver'
import nexusLogo from './logos/nexus.png'

type Details = { character_name?: string; category?: string }
type Props = {
  availableCharacters: string[]
  availableCategories: string[]
  selectedCharacters: Set<string>
  selectedCategories: Set<string>
  setSelectedCharacters: (next: Set<string>) => void
  setSelectedCategories: (next: Set<string>) => void
  modDetails: Record<string, Details>
  characterData: { name: string; id: string }[]
}

const COLLAPSED_HEROES = 6
const CLOSED_KEY = 'repakxtra.filters.closed' // the sections folded shut, kept between runs
const GALACTA = 'Project Galacta'   // an additional category the classifier appends ("Skin [Project Galacta]")
const SPECIAL: Record<string, string> = { __multi: 'Multiple heroes', __generic: 'No Hero' }

/** The Library title's filter line: a hero picked whole reads as just the hero; skins show only when picked one by one */
export const filterScope = (chars: Set<string>, cats: Set<string>) =>
  [...[...chars].filter(c => !(c.includes(' - ') && chars.has(c.split(' - ')[0]))).map(c => SPECIAL[c] ?? heroLabel(c)), ...cats].join(', ')

const toggled = (set: Set<string>, ids: string[]) => {
  const next = new Set(set)
  const all = ids.every(id => next.has(id))
  ids.forEach(id => (all ? next.delete(id) : next.add(id)))
  return next
}

export default function FilterPanel(p: Props) {
  useHeroImages()
  const nexusVersion = useNexusVersion()
  const showNexus = useUiPref('nexus')   // Settings > On each mod hides the Nexus tag, and with it this filter
  const nexusCount = useMemo(() => Object.keys(p.modDetails || {}).filter(path => sourceOf(path)).length, [p.modDetails, nexusVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const [showAllHeroes, setShowAllHeroes] = useState(false)
  const [openHero, setOpenHero] = useState<string | null>(null)
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(savedItem(CLOSED_KEY) || '[]')) } catch { return new Set() } })
  const fold = (id: string) => setClosed(prev => {
    const next = new Set(prev)
    if (!next.delete(id)) next.add(id)
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]))
    return next
  })
  /** A section's label folds it open or shut (transitions.dev Accordion). Shut, it still shows how many of its filters are
   *  on, so a hidden filter is never a surprise. */
  const section = (id: string, label: string, picked: number, body: React.ReactNode) => {
    const open = !closed.has(id)
    return (
      <>
        <button type="button" className="fp-section-label fp-section-btn" aria-expanded={open} onClick={() => fold(id)}>
          {label}{!open && picked > 0 && <span className="fp-section-picked">{picked} on</span>}
          <ChevronRight size={14} className="fp-section-caret" aria-hidden="true" />
        </button>
        <div className="t-acc-panel" data-open={open} ref={el => el?.toggleAttribute('inert', !open)}>
          <div className="t-acc-panel-inner">{body}</div>
        </div>
      </>
    )
  }

  const { heroes, typeCounts } = useMemo(() => {
    const counts: Record<string, number> = {}
    const types: Record<string, number> = {}
    for (const [path, d] of Object.entries(p.modDetails || {})) {
      // the Project Galacta mod itself names the Galacta hero: it alone does not make Galacta a hero to filter by
      if (d?.character_name && loadoutable(modKey(path))) counts[d.character_name] = (counts[d.character_name] || 0) + 1
      // main category plus the additive ones upstream appends as "... [Blueprint, Project Galacta]"
      const extra = (d as { mod_type?: string })?.mod_type?.match(/\[([^\]]+)\]$/)?.[1].split(', ') ?? []
      for (const cat of new Set([d?.category, ...extra])) if (cat) types[cat] = (types[cat] || 0) + 1
    }
    const groups: Record<string, { name: string; skins: string[]; count: number }> = {}
    for (const c of p.availableCharacters) {
      if (SPECIAL[c]) continue
      const base = c.includes(' - ') ? c.split(' - ')[0] : c
      const g = (groups[base] ||= { name: base, skins: [], count: 0 })
      if (c !== base) g.skins.push(c)
      g.count += counts[c] || 0
    }
    const list = Object.values(groups).filter(g => g.count > 0 || g.name !== 'Galacta').sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { heroes: list, typeCounts: types }
  }, [p.availableCharacters, p.modDetails])

  const specials = p.availableCharacters.filter(c => SPECIAL[c])
  const visibleHeroes = showAllHeroes ? heroes : heroes.slice(0, COLLAPSED_HEROES)
  const active = p.selectedCharacters.size + p.selectedCategories.size

  const row = (key: string, label: string, count: number | undefined, pressed: boolean, onClick: () => void, lead: React.ReactNode, trail?: React.ReactNode) => (
    <div className="fp-row-wrap" key={key}>
      <button type="button" className="fp-row" aria-pressed={pressed} onClick={onClick} title={label}>
        <span className="fp-lead">{lead}</span>
        <span className="fp-label">{label}</span>
        {count !== undefined && <span className="fp-count">{count}</span>}
        <Check className="fp-check" size={14} strokeWidth={2} aria-hidden />
      </button>
      {trail}
    </div>
  )

  return (
    <div className="filter-panel">
      <div className="fp-head">
        <span className="fp-title">Filters</span>
        {active > 0 && (
          <button type="button" className="fp-clear" onClick={() => { p.setSelectedCharacters(new Set()); p.setSelectedCategories(new Set()) }}>
            Clear {active}
          </button>
        )}
      </div>

      {section('heroes', 'Heroes', p.selectedCharacters.size, <>
      {visibleHeroes.map(h => {
        const ids = [h.name, ...h.skins]
        const pressed = ids.some(id => p.selectedCharacters.has(id))
        const img = resolveHeroImage(h.name, p.characterData)
        const isOpen = openHero === h.name
        return (
          <div key={h.name}>
            {row(h.name, heroLabel(h.name), h.count, pressed, () => p.setSelectedCharacters(toggled(p.selectedCharacters, ids)),
              img ? <img src={img} alt="" className="fp-avatar" /> : <span className="fp-avatar fp-avatar-empty" />,
              h.skins.length > 0 && (
                <button type="button" className="fp-expand" aria-expanded={isOpen} aria-label={`${heroLabel(h.name)} skins`}
                  onClick={() => setOpenHero(isOpen ? null : h.name)}>
                  <ChevronRight size={14} />
                </button>
              ))}
            {h.skins.length > 0 && (
              // transitions.dev: Accordion. Height grows from 0fr to 1fr, no measuring
              <div className="t-acc-panel fp-skins" data-open={isOpen} ref={el => el?.toggleAttribute("inert", !isOpen)}>
                <div className="t-acc-panel-inner">
                  {h.skins.map(s =>
                    row(s, s.split(' - ')[1], undefined, p.selectedCharacters.has(s),
                      () => p.setSelectedCharacters(toggled(p.selectedCharacters, [s])), <span className="fp-indent" />))}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {heroes.length > COLLAPSED_HEROES && (
        <button type="button" className="fp-more" onClick={() => setShowAllHeroes(v => !v)}>
          {showAllHeroes ? 'Show fewer' : `Show all ${heroes.length}`}
        </button>
      )}
      {specials.map(s => row(s, SPECIAL[s], undefined, p.selectedCharacters.has(s),
        () => p.setSelectedCharacters(toggled(p.selectedCharacters, [s])), <span className="fp-avatar fp-avatar-empty" />))}
      </>)}

      {section('types', 'Types', p.selectedCategories.size, <>
      {p.availableCategories.filter(cat => cat !== GALACTA).map(cat =>
        row(cat, cat, typeCounts[cat], p.selectedCategories.has(cat),
          () => p.setSelectedCategories(toggled(p.selectedCategories, [cat])),
          <span className={`fp-dot ${cat.toLowerCase().replace(/\s+/g, '-')}-badge`} />))}
      {showNexus && nexusCount > 0 && row(NEXUS_TYPE, NEXUS_TYPE, nexusCount, p.selectedCategories.has(NEXUS_TYPE),
        () => p.setSelectedCategories(toggled(p.selectedCategories, [NEXUS_TYPE])), <img src={nexusLogo} alt="" className="fp-logo" />)}
      {p.availableCategories.includes(GALACTA) && row(GALACTA, GALACTA, typeCounts[GALACTA], p.selectedCategories.has(GALACTA),
        () => p.setSelectedCategories(toggled(p.selectedCategories, [GALACTA])), <i className="fp-logo pg-logo" aria-hidden="true" />)}
      </>)}
    </div>
  )
}
