// repakxtra: the conflicts screen (Check Conflicts, and a mod's own conflict check), in place of Repak X's ClashPanel.
// Mods that are on and change the same game files are grouped by exactly which files they share, and each group says
// in words what they replace ("Both replace Black Panther's materials"), with each mod's priority and switch below.
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Check, ChevronRight } from 'lucide-react'
import NumberInput from '../components/ui/NumberInput'
import Switch from '../components/ui/Switch'
import { resolveHeroImage, useHeroImages } from '../utils/heroImages'
import { nameKey } from './loadoutStore'
import { ModName, plural } from './modName'
import { useDialogFocus } from './dialogFocus'

type Clash = { file_path: string; mod_paths: string[]; files?: string[] }
type Mod = { path: string; priority?: number; enabled?: boolean }
/** The app's hero list: a hero's id and name, and per skin its id and name */
type Hero = { name: string; id: string; skinid?: string; skin_name?: string }
export type ConflictGroup = { mods: string[]; files: string[] }

/** A mod's path without its on/off extension: the same mod before and after a switch. */
const stemOf = (p: string) => p.replace(/\.(pak|bak_repak|pak_disabled)$/i, '')
/** The same mod after a switch or a priority change too (its 9s and a leading !): its name alone. */
const sameMod = (p: string) => nameKey(p).replace(/^!/, '').toLowerCase()

/** A group is resolved once no two of its mods that are still on share a priority: one left on, or each at its own. */
export const resolved = (g: ConflictGroup, find: (path: string) => Mod | undefined) => {
  const on = g.mods.map(find).filter((m): m is Mod => Boolean(m && m.enabled !== false))
  return new Set(on.map(m => m.priority ?? 0)).size === on.length
}

/** Mods grouped by exactly the files they share: three mods that all change the same seven materials are one group, not
 *  three pairs. A record without files (a mod's own check, where file_path is the file) counts that one file. Files are
 *  counted per asset (a .uasset and its .uexp are one). */
export function groupConflicts(clashes: Clash[]): ConflictGroup[] {
  const modsOf = new Map<string, Set<string>>() // asset -> mod paths
  const loose: ConflictGroup[] = []
  for (const c of clashes) {
    const files = c.files?.length ? c.files : c.file_path.includes('/') ? [c.file_path] : []
    if (!files.length) { loose.push({ mods: [...new Set(c.mod_paths)], files: [] }); continue }
    for (const f of files) {
      const asset = f.replace(/\.(uasset|uexp|ubulk|uptnl)$/i, '')
      const set = modsOf.get(asset) ?? new Set<string>()
      c.mod_paths.forEach(m => set.add(m))
      modsOf.set(asset, set)
    }
  }
  const groups = new Map<string, ConflictGroup>()
  for (const [asset, set] of modsOf) {
    const mods = [...set].sort((a, b) => a.localeCompare(b))
    const key = mods.map(stemOf).join('|')
    const g = groups.get(key) ?? { mods, files: [] }
    g.files.push(asset)
    groups.set(key, g)
  }
  return [...groups.values(), ...loose].sort((a, b) => b.mods.length - a.mods.length || b.files.length - a.files.length)
}

/** What a game file is, in words, by its folder and name prefix (MI_ material, SK_ mesh, T_ texture...). Effects first:
 *  VFX keeps its own Materials and Textures folders. */
const KINDS: [RegExp, string][] = [
  [/\/(VFX|Effects?|Niagara|Particles?)\/|\/(NS|FX)_[^/]*$/i, 'effects'],
  [/\/(Wwise\w*|Audio|Sounds?)\/|\.(bnk|wem)$/i, 'sounds'],
  [/\/UI\//i, 'UI'],
  [/\/Anim\w*\/|\/(AS|AM|ABP|BS)_[^/]*$/i, 'animations'],
  [/\/Meshe?s?\/|\/(SK|SM)_[^/]*$/i, 'mesh'],
  [/\/Materials?\/|\/MI?_[^/]*$/i, 'materials'],
  [/\/Textures?\/|\/T_[^/]*$/i, 'textures'],
  [/\/Blueprints?\/|\/BP_[^/]*$/i, 'blueprints'],
]
export const kindOf = (file: string) => KINDS.find(([r]) => r.test(`/${file}`))?.[1] ?? 'files'

/** "a", "a and b", "a, b and c" */
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`)

/** A group in words: "Both replace Black Panther's materials", "These 3 mods replace Magik's effects and sounds", "Both
 *  replace the same effects" (shared files, no hero), plus the skin when they all belong to one ("Default skin"). */
export function describe(g: ConflictGroup, heroes: Hero[]) {
  const ids = new Set<string>()
  const skins = new Set<string>()
  const kinds = new Map<string, number>()
  for (const f of g.files) {
    const m = f.match(/\/Characters\/(\d{4})\/(\d{7})?/i)
    if (m) { ids.add(m[1]); if (m[2]) skins.add(m[2]) }
    const k = kindOf(f)
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
  }
  // A hero missing from the app's list keeps its place under its id: never folded into the one that is known
  const names = [...ids].map(id => heroes.find(h => h.id === id)?.name ?? `hero ${id}`)
  const whose = names.length === 1 ? possessive(names[0]) : names.length === 2 ? `${possessive(names[0])} and ${possessive(names[1])}`
    : names.length ? "several heroes'" : 'the same'
  const ranked = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)
  const what = ranked.length ? list(ranked.length > 3 ? [...ranked.slice(0, 3), 'more'] : ranked) : 'files'
  const who = g.mods.length === 2 ? 'Both' : `These ${g.mods.length} mods`
  const skin = skins.size === 1 ? heroes.find(h => h.skinid === [...skins][0])?.skin_name : undefined
  const known = ids.size === 1 ? heroes.find(h => h.id === [...ids][0])?.name : undefined // one hero, in the list: its portrait
  return { title: `${who} replace ${whose} ${what}`, hero: known, skin }
}

function Group({ g, heroes, find, done, onSetPriority, onToggleMod, onKeep }: {
  g: ConflictGroup; heroes: Hero[]; find: (path: string) => Mod | undefined; done: boolean
  onSetPriority?: (path: string, priority: number) => void; onToggleMod?: (path: string) => void
  onKeep?: (keep: string, others: Mod[]) => void
}) {
  const [open, setOpen] = useState(false)
  const d = describe(g, heroes)
  const portrait = d.hero ? resolveHeroImage(d.hero, heroes) : undefined
  return (
    <section className={`cf-group${done ? ' is-resolved' : ''}`}>
      <div className="cf-head">
        {portrait && <img className="cf-hero" src={portrait} alt="" />}
        {done && <span className="cf-resolved" role="status"><Check size={13} strokeWidth={2.5} />Resolved</span>}
        <div className="cf-what">
          <h3>{d.title}</h3>
          <p>
            {d.skin && <>{d.skin} skin · </>}
            {g.files.length
              ? <button type="button" className="cf-files-btn" aria-expanded={open} onClick={() => setOpen(v => !v)}>
                  {plural(g.files.length, 'file')} <ChevronRight size={12} className="cf-caret" />
                </button>
              : 'Same files'}
          </p>
        </div>
      </div>
      {open && <ul className="cf-files">{g.files.map(f => <li key={f}>{f.replace(/^Marvel\/Content\//, '')}</li>)}</ul>}
      <ul className="cf-mods">
        {g.mods.map(path => {
          const mod = find(path)
          const now = mod?.path ?? path
          const on = mod?.enabled !== false
          const name = nameKey(now)
          const othersOn = g.mods.map(find).filter((m): m is Mod => Boolean(m && m !== mod && m.enabled !== false))
          return (
            <li key={stemOf(path)} className={`cf-mod${on ? '' : ' is-off'}`}>
              <span className="cf-mod-name" title={now}><ModName name={name} /></span>
              {mod && on && onKeep && othersOn.length > 0 && (
                <button type="button" className="lo-text-btn cf-keep" onClick={() => onKeep(now, othersOn)}
                  title={`Turn off the other ${othersOn.length === 1 ? 'mod' : `${othersOn.length} mods`} in this group that ${othersOn.length === 1 ? 'is' : 'are'} on`}>
                  Keep this one
                </button>
              )}
              {mod && onSetPriority && (
                <span className="cf-priority" role="group" aria-label={`Priority of ${name}`}
                  title="Priority: a higher number wins; 0 (a ! before the name) is above them all">
                  <NumberInput value={mod.priority || 0} min={0} max={7} onChange={v => onSetPriority(now, v)} />
                </span>
              )}
              {mod && onToggleMod && (
                <Switch size="sm" color="primary" checked={on} title={on ? `Turn ${name} off` : `Turn ${name} on`}
                  aria-label={on ? `Turn ${name} off` : `Turn ${name} on`} onChange={() => onToggleMod(now)} />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default function ConflictsPanel({ clashes, mods = [], characterData = [], onSetPriority, onToggleMod, onKeep, onClose }: {
  clashes: Clash[]; mods?: Mod[]; characterData?: Hero[]
  onSetPriority?: (path: string, priority: number) => void; onToggleMod?: (path: string) => void
  onKeep?: (keep: string, others: Mod[]) => void; onClose: () => void
}) {
  useHeroImages()
  const { ref: dialog, onKeyDown: trap } = useDialogFocus() // focus inside, Tab stays inside, back to the opener on close
  const groups = useMemo(() => groupConflicts(clashes), [clashes])
  // The list is not checked again after a switch or a priority change, so a mod may now have another extension or
  // name suffix: matched by its stem, then by its name alone
  const find = useMemo(() => {
    const byStem = new Map(mods.map(m => [stemOf(m.path), m]))
    const byName = new Map(mods.map(m => [sameMod(m.path), m]))
    return (path: string) => byStem.get(stemOf(path)) ?? byName.get(sameMod(path))
  }, [mods])
  const open = groups.filter(g => !resolved(g, find)).length // still conflicting, as mods are switched here
  const allDone = groups.length > 0 && open === 0
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [onClose])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div ref={dialog} className="modal-content cf-modal" role="dialog" aria-modal="true" aria-label="Conflicts" tabIndex={-1}
        onKeyDown={trap} onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div className="cf-intro">
            <h2>
              Conflicts
              {open > 0 && <span className="cf-count" aria-label={`${open} unresolved`}>{open}</span>}
              {allDone && <span className="cf-count is-done"><Check size={12} strokeWidth={2.5} />All resolved</span>}
            </h2>
            <p className="cf-sub">
              {allDone
                ? 'Every conflict below is resolved: the mods that are still on no longer share files at the same priority.'
                : groups.length
                  ? 'Mods that are on, at the same priority, and change the same game files. Only one version of each file loads: turn off the ones you do not want, or raise the priority of the one that should win.'
                  : 'Mods that are on, at the same priority, and change the same game files show here.'}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body cf-body">
          {groups.length === 0
            ? <p className="cf-empty">No conflicts: no two mods that are on share files at the same priority.</p>
            : groups.map(g => <Group key={g.mods.map(stemOf).join('|')} g={g} heroes={characterData} find={find} done={resolved(g, find)}
                onSetPriority={onSetPriority} onToggleMod={onToggleMod} onKeep={onKeep} />)}
        </div>
        <div className="modal-footer cf-footer">
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </motion.div>
    </div>
  )
}

if (import.meta.env.DEV) {
  const mat = (n: string) => `Marvel/Content/Marvel/Characters/1026/1026001/Materials/MI_1026001_${n}.uasset`
  const groups = groupConflicts([
    { file_path: 'x', mod_paths: ['A.pak', 'B.pak'], files: [mat('Body'), mat('Head'), mat('Body').replace('.uasset', '.uexp')] },
    { file_path: 'x', mod_paths: ['A.pak', 'C.pak'], files: [mat('Body'), mat('Head')] },
    { file_path: 'x', mod_paths: ['B.pak', 'C.pak'], files: [mat('Body'), mat('Head')] },
    { file_path: 'x', mod_paths: ['D.pak', 'E.pak'], files: ['Marvel/Content/Marvel/VFX/Materials/Common/Trail/MI_Trail_1_010.uasset'] },
  ])
  console.assert(groups.length === 2 && groups[0].mods.join() === 'A.pak,B.pak,C.pak' && groups[0].files.length === 2, 'three mods sharing the same files are one group', groups)
  const heroes = [{ name: 'Black Panther', id: '1026', skinid: '1026001', skin_name: 'Default' }]
  const d = describe(groups[0], heroes)
  console.assert(d.title === "These 3 mods replace Black Panther's materials" && d.skin === 'Default', 'a group in words', d)
  console.assert(describe(groups[1], heroes).title === 'Both replace the same effects', 'shared effects, no hero')
  const mixed = describe({ mods: ['A', 'B'], files: [mat('Body'), 'Marvel/Content/Marvel/Characters/1099/1099001/Meshes/SK_1099.uasset'] }, heroes)
  console.assert(mixed.title === "Both replace Black Panther's and hero 1099's materials and mesh" && !mixed.hero, 'an unknown hero is named by id, no single portrait', mixed)
  console.assert(kindOf('Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset') === 'mesh' && kindOf('x/UI/Textures/T_Icon.uasset') === 'UI', 'kinds')
  console.assert(groupConflicts([{ file_path: 'Characters: 1026 - Priority: 1', mod_paths: ['A.pak', 'B.pak'] }])[0].files.length === 0, 'records without files still list their mods')
  const live = (ms: Mod[]) => (p: string) => ms.find(m => m.path === p)
  const g3 = { mods: ['A.pak', 'B.pak', 'C.pak'], files: [] }
  console.assert(!resolved(g3, live([{ path: 'A.pak', priority: 1 }, { path: 'B.pak', priority: 1 }, { path: 'C.pak', priority: 1, enabled: false }])), 'two on at one priority: open')
  console.assert(resolved(g3, live([{ path: 'A.pak', priority: 1 }, { path: 'B.pak', priority: 2 }, { path: 'C.pak', priority: 3 }])), 'each at its own priority: resolved')
  console.assert(resolved(g3, live([{ path: 'A.pak', priority: 1 }, { path: 'B.pak', enabled: false }])), 'one left on (C gone): resolved')
}
