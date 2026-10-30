// repakxtra: Smart loadouts, a page on the Loadouts screen. The mods that are in no loadout, grouped by the words that
// name them (smartGroups.ts): a list of proposed loadouts beside the one picked, which shows its name, one line on why its
// mods are together, its tools in sight (merge, heroes, the looks it took in) and its mods with the words that grouped them
// highlighted. A mod moves with Move to. Rules bend the grouping (a word to ignore or group by, a merge, a look kept apart,
// heroes together), sit in their own bar and are saved with moves and names (repakxtra.smartRules); leaving out a loadout
// or a mod is for this run only. Create makes the ticked loadouts, each in a collection named for its hero, and queues
// their previews.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Hand, Merge, Pencil, Plus, RotateCcw, Shapes, Split, Users, X } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import type { LoadoutProps } from './Loadouts'
import { canonKey } from './loadoutIdentity'
import { OTHER, addGroup, groupKey, listGroups, loadoutable, memberName, modKey, readLoadouts, useLoadouts, withMods, writeLoadouts } from './loadoutStore'
import { plural } from './modName'
import { Num } from './motion'
import { generateAllLoadouts, openPreviewSetup, usePreviewsAvailable } from './previews'
import { isTyping } from './hotkeys'
import { modalOpen } from './dialogFocus'
import { cue } from './sounds'
import { heroOfName, useHeroPortrait } from './heroFilter'
import { type Candidate, NO_RULES, type Rules, carryOff, lookKey, marks, ownKey, propose, readRules, rekey, ruleWords } from './smartGroups'
import './smartLoadouts.css'

const RULES = 'repakxtra.smartRules'
const ADVANCED = 'repakxtra.smartAdvanced' // '1': the page opens on Advanced (the full editor), as it was last left
/** An older copy a VFX update leaves beside its update: never a loadout member. */
const LEFTOVER = /_(BROKEN|ORIGINAL)(_V\d+)?$/i
/** A hero's collection: the one that exists, else a new one. */
const collectionFor = (hero: string) => (hero ? listGroups().find(g => groupKey(g) === groupKey(hero)) ?? addGroup(hero) : OTHER)
/** A look key in words: "rainbow flow@Black Panther" -> Rainbow Flow, a mod's own -> its name. */
const lookLabel = (key: string) => key.startsWith('mod:') ? memberName(key.slice(4))
  : key.slice(0, key.lastIndexOf('@')).split(' ').map(w => (w[0]?.toUpperCase() ?? '') + w.slice(1)).join(' ')

/** pinned: shown first and never filtered out by the search (A loadout of its own, Back to where its words put it) */
type MenuItem = { label: string; hint?: string; onClick: () => void; pinned?: boolean }
type MenuAt = { x: number; y: number; title?: string; items: MenuItem[]; anchor: HTMLElement }
/** A list this long gets a search field: with 60 loadouts, scrolling for one is slow (Hick's law) */
const SEARCH_AT = 9

/** A small menu on the page itself (inside a scrolling pane it would be cut off): Esc, an outside click or a pick closes
 *  it, arrow keys move through it. The button that opened it says it is open, and gets focus back on Esc or a pick (or,
 *  when a pick removed it, the picked loadout in the list does). */
function Menu({ at, onClose }: { at: MenuAt; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const searchable = at.items.filter(i => !i.pinned).length >= SEARCH_AT
  const needle = q.trim().toLowerCase()
  const shown = [...at.items.filter(i => i.pinned), ...at.items.filter(i => !i.pinned && (!needle || i.label.toLowerCase().includes(needle)))]
  const back = useCallback(() => requestAnimationFrame(() => {
    if (at.anchor.isConnected) at.anchor.focus()
    else document.querySelector<HTMLElement>('.sl-item.is-sel .sl-item-main')?.focus()
  }), [at.anchor])
  useEffect(() => {
    const anchor = at.anchor
    anchor.setAttribute('aria-expanded', 'true')
    ref.current?.querySelector<HTMLElement>(searchable ? 'input' : 'button')?.focus()
    const outside = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); back(); return }
      // focus back on the button that opened it first, so Tab moves on from there (the portaled menu sits at the end of the page)
      if (e.key === 'Tab') { if (at.anchor.isConnected) at.anchor.focus(); onClose(); return }
      if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !ref.current?.contains(document.activeElement)) return
      e.preventDefault()
      const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const i = all.indexOf(document.activeElement as HTMLButtonElement)
      all[i < 0 ? (e.key === 'ArrowDown' ? 0 : all.length - 1) : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('keydown', keys, true)
    return () => { anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); window.removeEventListener('keydown', keys, true) }
  }, [onClose, back, at.anchor, searchable])
  const pick = (it: MenuItem) => { onClose(); it.onClick(); back() }
  // Enter in the search takes the first loadout that matches, never a pinned action (A loadout of its own)
  const firstMatch = shown.find(i => !i.pinned)
  const rows = Math.min(shown.length, 9) + (searchable ? 1 : 0)
  const left = Math.max(8, Math.min(at.x, window.innerWidth - 288))
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 24 - (at.title ? 30 : 0) - rows * 36))
  return createPortal(
    <div ref={ref} className="sigeon-menu sl-menu" role="menu" aria-label={at.title} style={{ position: 'fixed', left, top, right: 'auto' }}>
      {at.title && <div className="sl-menu-title">{at.title}</div>}
      {searchable && (
        <input className="sl-menu-search" value={q} placeholder="Find a loadout" aria-label="Find a loadout" spellCheck={false}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (needle && firstMatch) pick(firstMatch) } }} />
      )}
      <div className="sl-menu-items">
        {shown.map(it => (
          <button key={it.label} type="button" role="menuitem" className={`sigeon-item${it.pinned ? ' is-pinned' : ''}`} title={it.label} onClick={() => pick(it)}>
            {/* a count sits at the right; words say what the pick does, under it */}
            {it.hint && !/^\d+$/.test(it.hint)
              ? <span className="sl-menu-label is-two">{it.label}<small>{it.hint}</small></span>
              : <><span className="sl-menu-label">{it.label}</span>{it.hint && <small>{it.hint}</small>}</>}
          </button>
        ))}
        {needle && !firstMatch && <div className="sl-menu-none">No loadout is called that</div>}
      </div>
    </div>, document.body)
}

export default function SmartLoadouts({ p, onBack }: { p: LoadoutProps; onBack: () => void }) {
  const loadouts = useLoadouts()
  const canGenerate = usePreviewsAvailable()
  const portrait = useHeroPortrait()
  const [rules, setRulesState] = useState<Rules>(() => readRules(localStorage.getItem(RULES)))
  const setRules = (fn: (r: Rules) => Rules) => setRulesState(r => { const next = fn(r); localStorage.setItem(RULES, JSON.stringify(next)); return next })
  const [off, setOff] = useState<Set<string>>(new Set())        // loadouts left out, this run
  const [skipped, setSkipped] = useState<Set<string>>(new Set()) // mods left out, this run
  const [sel, setSel] = useState<string | null>(null)
  const [preview, setPreview] = useState(true)
  // Simple: the loadouts it found, a tick each, and Create. Advanced: the editor (moves, merges, word rules)
  const [advanced, setAdvancedState] = useState(() => localStorage.getItem(ADVANCED) === '1')
  const setAdvanced = (on: boolean) => { setAdvancedState(on); localStorage.setItem(ADVANCED, on ? '1' : '0') }
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const [adding, setAdding] = useState<'ignore' | 'keep' | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null) // the simple view's loadout being named in place

  // The mods no loadout holds (built-in mods and the Project Galacta loader are not here), each with the hero it is for
  const free = useMemo(() => {
    const held = new Set(loadouts.flatMap(l => l.on.map(canonKey)))
    const seen = new Set<string>()
    return p.mods.flatMap((m): Candidate[] => {
      const key = modKey(m.path)
      if (seen.has(key) || !loadoutable(key) || held.has(canonKey(key)) || LEFTOVER.test(memberName(key))) return []
      seen.add(key)
      return [{ key, hero: heroOfName(p.modDetails?.[m.path]?.character_name) }]
    })
  }, [p.mods, p.modDetails, loadouts])
  const heroOf = useMemo(() => new Map(free.map(c => [c.key, c.hero])), [free])
  const taken = useMemo(() => loadouts.map(l => l.name), [loadouts])
  // The list keeps the order it first showed in: a move or a rule changes counts, and re-sorting by size would make the
  // rows jump under the pointer. New loadouts go to the end
  const order = useRef(new Map<string, number>())
  const proposals = useMemo(() => {
    const list = propose(free, taken, rules)
    for (const x of list) if (!order.current.has(x.id)) order.current.set(x.id, order.current.size)
    return list.sort((a, b) => order.current.get(a.id)! - order.current.get(b.id)!)
  }, [free, taken, rules])
  const g = proposals.find(x => x.id === sel) ?? proposals[0]
  // a rule that renames or splits an unticked loadout keeps it unticked (before paint, so Create never flashes the old count)
  const shown = useRef(proposals)
  useLayoutEffect(() => {
    const was = shown.current
    shown.current = proposals
    setOff(o => carryOff(o, was, proposals))
  }, [proposals])

  // Esc goes back to the cards, unless a menu or a field takes it first, a dialog is open over the page (Esc is its), or
  // the page is out of sight (the Library is showing)
  const pageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || menu || isTyping(e.target) || modalOpen() || !pageRef.current?.getClientRects().length) return
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [menu, onBack])

  const flip = <T,>(set: Set<T>, v: T) => { const n = new Set(set); if (!n.delete(v)) n.add(v); return n }
  const kept = (keys: string[]) => keys.filter(k => !skipped.has(k))
  const isPicked = (x: { id: string; keys: string[] }) => !off.has(x.id) && kept(x.keys).length > 0
  const togglePick = (x: { id: string; keys: string[] }) => {
    if (isPicked(x)) { setOff(o => flip(o, x.id)); return }
    setOff(o => { const next = new Set(o); next.delete(x.id); return next })
    if (kept(x.keys).length === 0) setSkipped(sk => { const next = new Set(sk); x.keys.forEach(k => next.delete(k)); return next })
  }
  const chosen = proposals.map(x => ({ ...x, keys: kept(x.keys) })).filter(x => !off.has(x.id) && x.keys.length > 0)
  const total = chosen.reduce((n, x) => n + x.keys.length, 0)

  /** A mod moved by hand: remembered, unless it went back to where its words put it. */
  const move = (key: string, to: string) => {
    setRules(r => {
      const { [key]: _, ...pins } = r.pins
      const home = propose(free, taken, { ...r, pins }).find(x => x.keys.includes(key))?.id
      return { ...r, pins: home === to ? pins : { ...pins, [key]: to } }
    })
    cue('select', { emphasis: 'subtle' })
  }
  /** A name typed for a loadout: saved with the rules, so it stays the next time (an empty or unchanged one is no change). */
  const rename = (x: { id: string; name: string }, typed: string) => {
    const v = typed.trim()
    if (v && v !== x.name) setRules(r => ({ ...r, names: { ...r.names, [x.id]: v } }))
  }
  /** Advanced: a loadout's pencil (or a double-click) picks it and puts the cursor in its name above, all selected. */
  const nameIt = (id: string) => {
    setSel(id)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('.sl-detail .sl-name')
      el?.focus()
      el?.select()
    }))
  }
  const unpin = (key: string) => setRules(r => { const { [key]: _, ...pins } = r.pins; return { ...r, pins } })
  const ignore = (w: string) => setRules(r => ({ ...r, ignore: [...new Set([...r.ignore, w])], keep: r.keep.filter(x => x !== w) }))
  /** A typed word rule, one rule per word the text holds as mod names are cut ("Cat Boy" -> cat, boy), so each can match */
  const addWordRule = (typed: string) => {
    const ws = ruleWords(typed)
    if (ws.length && adding === 'ignore') setRules(r => ({ ...r, ignore: [...new Set([...r.ignore, ...ws])], keep: r.keep.filter(x => !ws.includes(x)) }))
    if (ws.length && adding === 'keep') setRules(r => ({ ...r, keep: [...new Set([...r.keep, ...ws])], ignore: r.ignore.filter(x => !ws.includes(x)) }))
    setAdding(null)
    setDraft('')
  }

  const backRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { backRef.current?.focus({ preventScroll: true }) }, [])

  const create = async () => {
    const made = chosen.map(x => ({ id: crypto.randomUUID(), name: x.name, label: collectionFor(x.hero), ...withMods({ on: [], scope: [] }, x.keys) }))
    if (!made.length) return
    writeLoadouts([...readLoadouts(), ...made])
    onBack()
    const queue = preview && canGenerate ? await generateAllLoadouts(made, p.mods, 'all') : null
    if (queue?.error) p.alert.warning(`${plural(made.length, 'loadout')} made`, `Their previews did not start: ${queue.error}`)
    else p.alert.success(`${plural(made.length, 'loadout')} made`, `${plural(total, 'mod')} grouped.${queue ? ' Previews are queued, one after another.' : ''}`)
  }

  const openAt = (anchor: HTMLElement, items: MenuItem[], title?: string) => {
    const r = anchor.getBoundingClientRect()
    setMenu({ x: Math.min(r.left, window.innerWidth - 288), y: r.bottom + 4, items, title, anchor })
  }
  const menuAt = (e: React.MouseEvent<HTMLElement>, items: MenuItem[], title?: string) => openAt(e.currentTarget, items, title)
  const others = (id: string) => proposals.filter(x => x.id !== id)

  // The rules in words, each with its own way back
  const chips: { id: string; text: string; clear: () => void }[] = [
    ...rules.ignore.map(w => ({ id: `i:${w}`, text: `Ignore “${w}”`, clear: () => setRules(r => ({ ...r, ignore: r.ignore.filter(x => x !== w) })) })),
    ...rules.keep.map(w => ({ id: `k:${w}`, text: `Group by “${w}”`, clear: () => setRules(r => ({ ...r, keep: r.keep.filter(x => x !== w) })) })),
    ...rules.merge.map(m => ({ id: `m:${m.from}`, text: `${lookLabel(m.from)} into ${lookLabel(m.into)}`, clear: () => setRules(r => ({ ...r, merge: r.merge.filter(x => x.from !== m.from) })) })),
    ...rules.split.map(k => ({ id: `s:${k}`, text: `${lookLabel(k)} apart`, clear: () => setRules(r => ({ ...r, split: r.split.filter(x => x !== k) })) })),
    ...rules.together.map(w => ({ id: `t:${w}`, text: `${lookLabel(`${w}@`)}, all heroes`, clear: () => setRules(r => ({ ...r, together: r.together.filter(x => x !== w) })) })),
    ...(Object.keys(rules.pins).length ? [{ id: 'pins', text: `${plural(Object.keys(rules.pins).length, 'mod')} moved`, clear: () => setRules(r => ({ ...r, pins: {} })) }] : []),
    ...(Object.keys(rules.names).length ? [{ id: 'names', text: `${plural(Object.keys(rules.names).length, 'name')} given`, clear: () => setRules(r => ({ ...r, names: {} })) }] : []),
  ]
  // a word rule is typed in place of the two buttons that start one
  const wordForm = adding ? (
    <span className="sl-chip-form">
      <span>{adding === 'ignore' ? 'Ignore' : 'Group by'}</span>
      <input autoFocus value={draft} placeholder="a word" aria-label={adding === 'ignore' ? 'Word to ignore' : 'Word to group by'} spellCheck={false}
        onChange={e => setDraft(e.target.value)} onBlur={e => addWordRule(e.currentTarget.value)}
        onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = ''; e.currentTarget.blur() } }} />
    </span>
  ) : (
    <>
      <button type="button" className="lo-text-btn sl-rule-add" onClick={() => setAdding('ignore')} title="A word that should never group mods, like a creator's tag"><Plus size={13} /> Ignore a word</button>
      <button type="button" className="lo-text-btn sl-rule-add" onClick={() => setAdding('keep')} title="A word it skips now that should group mods, like ko or trail"><Plus size={13} /> Group by a word</button>
    </>
  )
  const words = g?.why.words.join(' ') ?? ''
  // the picked loadout's tools, each a labelled button in sight (a hidden menu made them easy to miss)
  const tools = !g ? [] : [
    proposals.length > 1 && (
      <button key="merge" type="button" className="lo-text-btn sl-tool" aria-haspopup="menu" title="Put its mods into another loadout"
        onClick={e => menuAt(e, others(g.id).map(x => ({ label: x.name, hint: String(x.keys.length),
          onClick: () => { setRules(r => ({ ...r, merge: [...r.merge.filter(m => m.from !== g.id), { from: g.id, into: x.id }], split: r.split.filter(s => s !== g.id) })); setSel(x.id) } })), `Merge ${g.name} into`)}>
        <Merge size={14} /> Merge into
      </button>
    ),
    // the loadout's key changes with these (words@Hero <-> words@*): its rules and the selection follow it
    g.why.together
      ? <button key="heroes" type="button" className="lo-text-btn sl-tool" title="One loadout per hero again" onClick={() => {
          const top = [...g.keys.reduce((n, k) => { const h = heroOf.get(k); if (h) n.set(h, (n.get(h) ?? 0) + 1); return n }, new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0]
          const to = top ? lookKey(g.why.words, top) : null
          setRules(r => ({ ...(to ? rekey(r, k => k === g.id, to) : r), together: r.together.filter(w => w !== words) }))
          if (to) setSel(to)
        }}><Split size={14} /> Split by hero</button>
      : g.why.splitHeroes && <button key="heroes" type="button" className="lo-text-btn sl-tool" title={`Every hero's ${words} in one loadout`} onClick={() => {
          const to = lookKey(g.why.words, '*')
          setRules(r => ({ ...rekey(r, k => k !== to && k.includes('@') && k.slice(0, k.lastIndexOf('@')) === words, to, g.id), together: [...r.together, words] }))
          setSel(to)
        }}><Users size={14} /> Join other heroes</button>,
    g.named && <button key="name" type="button" className="lo-text-btn sl-tool" title={`Name it as its words do`} onClick={() => setRules(r => { const { [g.id]: _, ...names } = r.names; return { ...r, names } })}><RotateCcw size={14} /> Use the suggested name</button>,
  ].filter(Boolean)

  return (
    <div className="sl-page" ref={pageRef}>
      {/* back as a loadout's page has it: its own row above the title, named */}
      <header className="sl-top">
        <div className="sl-title">
          <button type="button" ref={backRef} className="lo-text-btn lp-back sl-back" onClick={onBack} title="Back to all loadouts (Esc)"><ArrowLeft size={14} /> Loadouts</button>
          <h2>Smart loadouts</h2>
          <p>{!g ? 'No mods need grouping. Mods you install that are in no loadout show up here.'
            // the point first, for someone new: one look becomes one switch
            : `Found ${plural(proposals.length, 'look')} in the ${plural(free.length, 'mod')} that are in no loadout. Each becomes a loadout, so one switch turns a whole look on or off: its skin, effects, and icons together. Untick any you do not want, then create them.`}</p>
        </div>
        {g && (
          <div className="sl-top-actions">
            {/* one switch between the two views, the app's segmented control (as Collection | Hero). First, so it never moves */}
            <div className="mod-state-filter sl-views" role="group" aria-label="View">
              <button type="button" aria-pressed={!advanced} onClick={() => setAdvanced(false)} title="The loadouts it found: tick the ones to make">Simple</button>
              <button type="button" aria-pressed={advanced} onClick={() => setAdvanced(true)} title="Move mods, merge loadouts, and set word rules">Advanced</button>
            </div>
            {/* beside Create: it says whether Create also renders previews */}
            {canGenerate
              ? <Checkbox checked={preview} onChange={v => setPreview(v)} size="sm" color="primary" className="sl-preview" title="Each new loadout renders a preview, one after another">Generate previews</Checkbox>
              : <button type="button" className="sl-link sl-preview" onClick={openPreviewSetup} title="Previews need the preview kit">Set up previews</button>}
            <button type="button" className="btn-primary sl-create" onClick={create} disabled={chosen.length === 0}
              title={chosen.length ? `${plural(total, 'mod')}, each loadout in a collection named for its hero` : 'Tick a loadout to make it'}>
              <Shapes size={14} aria-hidden="true" />
              {chosen.length ? <span>Create <Num id="sl-create" value={chosen.length} /> {chosen.length === 1 ? 'loadout' : 'loadouts'}</span> : 'Nothing picked'}
            </button>
          </div>
        )}
      </header>

      {/* the rules bend every loadout, so they sit above both panes, always in sight, and are saved for next time */}
      {g && advanced && (
        <div className="sl-rules" role="group" aria-label="Rules, saved for next time">
          <span className="sl-rules-label" title="Rules change how every loadout is grouped. They are saved for next time.">Rules</span>
          {chips.length === 0 && !adding && <span className="sl-rules-none">None yet</span>}
          {chips.map(c => (
            <span key={c.id} className="sl-chip">
              <span className="sl-chip-text">{c.text}</span>
              <button type="button" aria-label={`Remove the rule ${c.text}`} title="Remove this rule" onClick={c.clear}><X size={12} /></button>
            </span>
          ))}
          {wordForm}
          {chips.length > 0 && <button type="button" className="sl-link sl-rules-reset" onClick={() => setRules(() => NO_RULES)} title="Every rule, move, and name">Reset all</button>}
        </div>
      )}

      {!g
        ? <div className="sl-empty"><button type="button" className="lo-text-btn" onClick={onBack}>Back to Loadouts</button></div>
        : !advanced ? (
          // the simple view: every loadout it would make, as a tile to tick, and nothing else
          <div className="sl-simple">
            <div className="sl-list-head sl-simple-head">
              <span className="sl-list-count">{chosen.length} of {proposals.length} picked</span>
              <button type="button" className="sl-link" disabled={off.size === 0 && skipped.size === 0} onClick={() => { setOff(new Set()); setSkipped(new Set()) }}>Select all</button>
              <button type="button" className="sl-link" disabled={chosen.length === 0} onClick={() => setOff(new Set(proposals.map(x => x.id)))}>Clear</button>
            </div>
            <ul className="sl-tiles">
              {proposals.map((x, i) => {
                const n = kept(x.keys).length, ticked = isPicked(x)
                const tick = <span className="sl-tile-tick" aria-hidden="true">{ticked && <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 12 9 17 20 6" /></svg>}</span>
                const face = x.hero ? <img className="sl-face" src={portrait(x.hero)} alt="" /> : <span className="sl-face is-none"><Users size={11} /></span>
                return (
                  <li key={x.id} className={`sl-tile${ticked ? '' : ' is-off'}`}>
                    {renaming === x.id ? (
                      // named in place: Enter or leaving the field saves it, Esc keeps the old name
                      <div className="sl-tile-btn is-editing">
                        {tick}{face}
                        <input className="sl-tile-input" autoFocus defaultValue={x.name} aria-label={`Name for ${x.name}`} spellCheck={false}
                          onFocus={e => e.currentTarget.select()}
                          onBlur={e => { rename(x, e.currentTarget.value); setRenaming(null) }}
                          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = x.name; e.currentTarget.blur() } }} />
                      </div>
                    ) : (
                      <>
                        {/* a click ticks it; a double-click names it (the double-click's first click is taken back) */}
                        <button type="button" role="checkbox" aria-checked={ticked} className="sl-tile-btn" title={x.keys.map(memberName).join(', ')}
                          onClick={e => { if (e.detail < 2) togglePick(x) }}
                          onDoubleClick={() => { togglePick(x); setRenaming(x.id) }}>
                          {tick}{face}
                          <span className="sl-tile-name">{x.name}</span>
                          <span className="sl-pill">{plural(n, 'mod')}</span>
                        </button>
                        <button type="button" className="sl-rename" aria-label={`Rename ${x.name}`} title="Rename (or double-click the row)" onClick={() => setRenaming(x.id)}><Pencil size={13} /></button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <div className="sl-panes">
            <nav className="sl-list" aria-label="Proposed loadouts">
              {/* every proposal at once: tick them all, or none and then the few wanted */}
              <div className="sl-list-head">
                <span className="sl-list-count">{chosen.length} of {proposals.length} picked</span>
                <button type="button" className="sl-link" disabled={off.size === 0 && skipped.size === 0} onClick={() => { setOff(new Set()); setSkipped(new Set()) }}>Select all</button>
                <button type="button" className="sl-link" disabled={chosen.length === 0} onClick={() => setOff(new Set(proposals.map(x => x.id)))}>Clear</button>
              </div>
              <ul>
                {proposals.map((x, i) => {
                  const isOff = !isPicked(x)
                  return (
                    <li key={x.id}
                      className={`sl-item${x.id === g.id ? ' is-sel' : ''}${isOff ? ' is-off' : ''}`}>
                      <Checkbox checked={!isOff} onChange={() => togglePick(x)} size="sm" color="primary" className="sl-tick" aria-label={`Make ${x.name}`} />
                      <button type="button" className="sl-item-main" aria-current={x.id === g.id ? 'true' : undefined} onClick={() => setSel(x.id)} onDoubleClick={() => nameIt(x.id)}>
                        {x.hero ? <img className="sl-face" src={portrait(x.hero)} alt="" /> : <span className="sl-face is-none"><Users size={11} /></span>}
                        <span className="sl-item-name">{x.name}</span>
                        <span className="sl-pill"><Num id={`sl-${x.id}`} value={kept(x.keys).length} /> {kept(x.keys).length === 1 ? 'mod' : 'mods'}</span>
                      </button>
                      <button type="button" className="sl-rename is-shown" aria-label={`Rename ${x.name}`} title="Rename" onClick={() => nameIt(x.id)}><Pencil size={13} /></button>
                    </li>
                  )
                })}
              </ul>
            </nav>

            <section className="sl-detail" key={g.id} aria-label={g.name}>
              <div className="sl-head">
                {/* the portrait says the hero, so the line below does not repeat it */}
                {g.hero ? <img className="sl-face is-big" src={portrait(g.hero)} alt={g.hero} title={g.hero} />
                  : <span className="sl-face is-big is-none" role="img" aria-label={g.why.together ? 'All heroes' : 'No hero'} title={g.why.together ? 'All heroes' : 'No hero'}><Users size={16} /></span>}
                <div className="sl-head-text">
                  {/* the name is its own field: the pencil says so, and a click on it (the label) puts the cursor in it */}
                  <label className="sl-name-wrap">
                    <input className="sl-name" key={g.name} defaultValue={g.name} aria-label="Loadout name" spellCheck={false}
                      onBlur={e => { rename(g, e.target.value); e.target.value = g.name }}
                      onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = g.name; e.currentTarget.blur() } }} />
                    <Pencil size={14} className="sl-name-pencil" aria-hidden="true" />
                  </label>
                  {/* why, in one line: the shared words (a click ignores one), the hero, the heroes rule */}
                  <p className="sl-why">
                    {g.why.words.length
                      ? <>Grouped by {g.why.words.map(w => (
                          <button key={w} type="button" className="sl-word" aria-haspopup="menu" title={`“${w}”: click to stop grouping by it`}
                            onClick={e => menuAt(e, [{ label: `Ignore “${w}” everywhere`, hint: 'regroups these mods without it', onClick: () => ignore(w) }])}>{w}</button>
                        ))}</>
                      : <>No shared words, named after its file</>}
                  </p>
                </div>
              </div>
              {tools.length > 0 && <div className="sl-tools" role="group" aria-label={`Change ${g.name}`}>{tools}</div>}

              {/* the looks it took in, each with its way out: chunked apart from the mods so the reason reads first */}
              {g.why.absorbed.length > 0 && (
                <section className="sl-section" aria-labelledby="sl-looks">
                  <h3 id="sl-looks" className="sl-section-title">Looks taken in <span className="sl-section-n">{g.why.absorbed.length}</span></h3>
                  <ul className="sl-rows">
                    {g.why.absorbed.map(a => (
                      <li key={a.key} className="sl-row">
                        <span className="sl-row-name">{lookLabel(a.key)}</span>
                        <span className="sl-row-meta">{a.byRule ? 'merged by you' : `starts with “${words}”`}, {plural(a.count, 'mod')}</span>
                        {a.byRule
                          ? <button type="button" className="lo-text-btn sl-row-btn" onClick={() => setRules(r => ({ ...r, merge: r.merge.filter(m => m.from !== a.key) }))}>Undo merge</button>
                          : <button type="button" className="lo-text-btn sl-row-btn" title="Make it a loadout of its own" onClick={() => setRules(r => ({ ...r, split: [...new Set([...r.split, a.key])] }))}>Keep apart</button>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="sl-section" aria-labelledby="sl-mods">
                <h3 id="sl-mods" className="sl-section-title">Mods <span className="sl-section-n">{kept(g.keys).length}</span></h3>
                <ul className="sl-mods" aria-label={`Mods in ${g.name}`}>
                {g.keys.map(k => {
                  const pinned = g.why.pinned.includes(k)
                  const name = memberName(k)
                  return (
                    <li key={k} className={`sl-mod${skipped.has(k) ? ' is-off' : ''}`}>
                      <Checkbox checked={!skipped.has(k)} onChange={() => setSkipped(flip(skipped, k))} size="sm" color="primary" className="sl-tick" aria-label={`Include ${name}`} />
                      <span className="sl-mod-name" title={name}>
                        {marks(name, heroOf.get(k) ?? '', rules).map((m, i) => m.look ? <mark key={i}>{m.text}</mark> : <span key={i}>{m.text}</span>)}
                      </span>
                      {pinned && <Hand size={13} className="sl-pin" aria-label="Moved here by you" />}
                      {(() => {
                        const to: MenuItem[] = [
                          ...others(g.id).map(x => ({ label: x.name, hint: String(x.keys.length), onClick: () => move(k, x.id) })),
                          ...(g.id === ownKey(k) ? [] : [{ label: 'A loadout of its own', onClick: () => move(k, ownKey(k)), pinned: true }]),
                          ...(pinned ? [{ label: 'Back to where its words put it', onClick: () => unpin(k), pinned: true }] : []),
                        ]
                        return to.length > 0 && <button type="button" className="lo-text-btn sl-move" aria-haspopup="menu" onClick={e => menuAt(e, to, `Move ${name} to`)}>Move to</button>
                      })()}
                    </li>
                  )
                })}
                </ul>
              </section>
            </section>
          </div>
        )}

      {menu && <Menu at={menu} onClose={closeMenu} />}
    </div>
  )
}
