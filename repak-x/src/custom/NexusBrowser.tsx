// repakxtra: the Nexus Mods tab, beside Loadouts and Library: Marvel Rivals mods on Nexus Mods from its public API
// (adult mods left out), once an account is saved (nexus.tsx). Search, a hero, a type, a time window and a sort, then
// pages of cards. Install gets the mod's main file (nexus.tsx installFromNexus), Update replaces the copy you have, and the
// picture or name opens the mod's page in the app's Nexus window. Stays mounted while hidden, so the search and the cards
// are still there on the way back.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { ArrowUpCircle, Check, ChevronLeft, ChevronRight, Download, Heart, Search, X } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import { NexusSignIn, gql, getNexusFile, installFromNexus, openNexusPage, plain, updateOf, useNexusAccount, useNexusReady, useNexusUpdates } from './nexus'
import { sourceOf, useNexusVersion } from './nexusSource'
import { useView } from './loadoutStore'
import { HeroFilter, useHeroNames } from './heroFilter'

type Card = {
  modId: number; name: string; author: string; summary: string; endorsements: number; downloads: number
  thumbnailLargeUrl: string | null; updatedAt: string; modCategory: { name: string } | null
}
type Page = { mods: { totalCount: number; nodes: Card[] } }

const SORTS = [
  { value: 'endorsements', label: 'Most endorsed' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'updatedAt', label: 'Recently updated' },
  { value: 'createdAt', label: 'Newest' },
  { value: 'name', label: 'Name, A to Z' },
  { value: 'relevance', label: 'Best match' },
]
// Nexus's own time windows (its All time menu)
const WINDOWS = [
  { value: 'all', label: 'All time' }, { value: '1', label: '24 hours' }, { value: '7', label: '7 days' },
  { value: '14', label: '14 days' }, { value: '28', label: '28 days' }, { value: '365', label: '1 year' },
]
// Nexus's top categories for Marvel Rivals (hero mods are Characters or a hero's own category)
const TYPES = [{ value: 'all', label: 'All types' }, ...['Characters', 'Audio', 'User Interface', 'Visuals', 'Gameplay', 'Miscellaneous'].map(c => ({ value: c, label: c }))]
// where a Nexus category name differs from the game's hero name
const CATEGORY_OF: Record<string, string> = { 'Doctor Strange': 'Dr. Strange', Deadpool: 'DeadPool' }
const PAGE = 24
const QUERY = `query($f: ModsFilter, $s: [ModsSort!], $o: Int, $c: Int) {
  mods(filter: $f, sort: $s, offset: $o, count: $c) { totalCount nodes { modId name author summary endorsements downloads thumbnailLargeUrl updatedAt modCategory { name } } } }`

const count = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
const ago = (iso: string) => {
  const s = (Date.parse(iso) - Date.now()) / 1000
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600]] as const) {
    if (Math.abs(s) >= n) return rel.format(Math.round(s / n), unit)
  }
  return rel.format(Math.round(s / 60), 'minute')
}

/** The search as a Nexus filter: the game, no adult mods, then each picked part (all must match). A hero matches its
 *  category, or its name in the mod's name or description. */
function filterOf(query: string, hero: string, type: string, days: string, sort: string) {
  const f: Record<string, unknown> = { gameDomainName: [{ value: 'marvelrivals' }], adultContent: [{ value: false }] }
  if (query) f.nameStemmed = [{ value: query, op: 'MATCHES' }]
  if (type !== 'all') f.categoryName = [{ value: type }]
  if (days !== 'all') f[sort === 'updatedAt' ? 'updatedAt' : 'createdAt'] = [{ value: String(Math.floor(Date.now() / 1000) - Number(days) * 86400), op: 'GT' }]
  if (hero) f.filter = [{ op: 'OR', categoryName: [{ value: CATEGORY_OF[hero] ?? hero }], nameStemmed: [{ value: hero, op: 'MATCHES' }], description: [{ value: hero, op: 'MATCHES' }] }]
  return f
}

export default function NexusBrowser({ mods }: { mods: { path: string }[] }) {
  const view = useView()
  const account = useNexusAccount()
  const ready = useNexusReady()
  const sources = useNexusVersion()
  useNexusUpdates()
  const heroes = useHeroNames()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [hero, setHero] = useState('')
  const [type, setType] = useState('all')
  const [days, setDays] = useState('all')
  const [pickedSort, setSort] = useState('endorsements')
  const sort = pickedSort === 'relevance' && !query ? 'endorsements' : pickedSort // Best match needs words to match
  const [cards, setCards] = useState<Card[]>([])
  const [total, setTotal] = useState(0)
  const [done, setDone] = useState(false) // every page of this search is in
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState('')
  const [tries, setTries] = useState(0) // Try again after a failed search
  const [more, setMore] = useState(0) // Show more (or its retry) clicks
  const shown = useRef('') // the search the cards are for: a new one starts from page one
  const loaded = useRef(-1) // the last page loaded for it
  const wanted = useRef(0) // the page to load next: one past `loaded` once Show more asks
  // Your copy of each Nexus mod, by mod id (the first one found when there are several)
  const installed = useMemo(() => {
    const byId = new Map<number, string>()
    for (const m of mods) { const s = sourceOf(m.path); if (s && !byId.has(s.id)) byId.set(s.id, m.path) }
    return byId
  }, [mods, sources]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(t) }, [text])

  const live = view === 'nexus' && Boolean(account)
  useEffect(() => {
    if (!live) return
    const key = JSON.stringify([query, hero, type, days, sort, tries])
    const fresh = key !== shown.current
    if (fresh) wanted.current = 0
    else if (wanted.current <= loaded.current) { setState('ok'); return } // back on the tab (or this search again): its pages are here
    const at = wanted.current
    let on = true
    setState('loading')
    const dir = sort === 'name' ? 'ASC' : 'DESC'
    gql<Page>(QUERY, { f: filterOf(query, hero, type, days, sort), s: [{ [sort]: { direction: dir } }], o: at * PAGE, c: PAGE })
      .then(d => {
        if (!on) return
        shown.current = key
        loaded.current = at
        // a mod uploaded between two pages pushes the last one onto the next: each mod once
        setCards(prev => {
          if (fresh) return d.mods.nodes
          const seen = new Set(prev.map(c => c.modId))
          return [...prev, ...d.mods.nodes.filter(c => !seen.has(c.modId))]
        })
        setTotal(d.mods.totalCount)
        setDone((at + 1) * PAGE >= d.mods.totalCount)
        setState('ok')
      })
      .catch(e => {
        if (!on) return
        if (fresh) { setCards([]); shown.current = key; loaded.current = -1 } // never the last search's cards under this one
        setError(String(e))
        setState('error')
      })
    return () => { on = false }
  }, [live, query, hero, type, days, sort, tries, more])

  const showMore = () => { wanted.current = loaded.current + 1; setMore(n => n + 1) }
  const narrowed = Boolean(query || hero || type !== 'all' || days !== 'all')
  const clear = () => { setText(''); setQuery(''); setHero(''); setType('all'); setDays('all') }

  if (view !== 'nexus') return null
  if (!account) return (
    <div className="lo-screen nx-screen" aria-label="Nexus Mods">
      <div className="nx-signin-wrap">{ready && <NexusSignIn />}</div>
    </div>
  )
  const first = state === 'loading' && !cards.length
  return (
    <div className="lo-screen nx-screen" aria-label="Nexus Mods">
      <header className="nx-head">
        <div className="nx-title">
          <h2>Nexus Mods</h2>
          <span className="nx-total" role="status">{state === 'ok' ? `${total.toLocaleString()} ${total === 1 ? 'mod' : 'mods'}` : ''}</span>
          {!account.premium && <span className="nx-how">To install, click <b>Install</b>, then <b>Slow download</b> in the Nexus window.</span>}
        </div>
        <div className="nx-filters" role="search">
          <label className="lp-search nx-search">
            <Search size={14} aria-hidden="true" />
            <input value={text} placeholder="Search mods" aria-label="Search Marvel Rivals mods on Nexus Mods" onChange={e => setText(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setText('') }} />
            {text && <button type="button" className="lo-icon" aria-label="Clear search" title="Clear search" onClick={() => setText('')}><X size={13} /></button>}
          </label>
          <HeroFilter heroes={heroes} value={hero} onChange={setHero} always />
          <CustomDropdown className="lp-hero nx-type" options={TYPES} value={type} onChange={setType} />
          <CustomDropdown className="lp-hero nx-window" options={WINDOWS} value={days} onChange={setDays} />
          {narrowed && <button type="button" className="su-link nx-clear" onClick={clear}>Clear filters</button>}
          <CustomDropdown className="lp-hero nx-sort" options={query ? SORTS : SORTS.slice(0, -1)} value={sort} onChange={setSort} />
        </div>
      </header>
      <div className="lo-body nx-body">
        {state === 'error' && !cards.length ? (
          <div className="nx-empty"><p>Nexus Mods did not answer.</p><small>{error}</small>
            <button type="button" className="lo-text-btn" onClick={() => setTries(t => t + 1)}>Try again</button></div>
        ) : state === 'ok' && !cards.length ? (
          <div className="nx-empty"><p>No mods match these filters.</p>
            <button type="button" className="lo-text-btn" onClick={clear}>Clear filters</button></div>
        ) : (
          <div className={`nx-grid${first ? ' is-loading' : ''}`} aria-busy={state === 'loading'}>
            {first
              ? Array.from({ length: 8 }, (_, i) => <div key={i} className="nx-card is-skeleton" aria-hidden="true" />)
              : cards.map(c => <NexusCard key={c.modId} c={c} path={installed.get(c.modId)} />)}
          </div>
        )}
        {cards.length > 0 && !done && (
          <div className="nx-more">
            {state === 'error' && <small role="alert">More did not load: {error}</small>}
            <button type="button" className="lo-text-btn" disabled={state === 'loading'} onClick={showMore}>
              {state === 'loading' ? 'Loading…' : state === 'error' ? 'Try again' : 'Show more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** How long the pointer rests on a card's picture before its gallery opens, and how long it may be away from both the
 *  picture and the gallery before the gallery closes (time to move from one to the other). */
const PEEK_OPEN_MS = 450
const PEEK_CLOSE_MS = 160

function NexusCard({ c, path }: { c: Card; path?: string }) {
  const u = path ? updateOf(sourceOf(path)) : undefined
  const name = plain(c.name)
  const open = () => openNexusPage(c.modId)
  const picture = useRef<HTMLButtonElement>(null)
  const [peek, setPeek] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const later = (f: () => void, ms: number) => { clearTimeout(timer.current); timer.current = setTimeout(f, ms) }
  useEffect(() => () => clearTimeout(timer.current), [])
  const hover = { onMouseEnter: () => later(() => setPeek(true), peek ? 0 : PEEK_OPEN_MS), onMouseLeave: () => later(() => setPeek(false), PEEK_CLOSE_MS) }
  return (
    <article className="nx-card">
      {peek && picture.current && <NexusPeek modId={c.modId} name={name} first={c.thumbnailLargeUrl} anchor={picture.current} hover={hover} onOpen={open} onClose={() => setPeek(false)} />}
      <button ref={picture} type="button" className="nx-card-image" onClick={open} title={`Open ${name} on Nexus Mods`} tabIndex={-1} {...(c.thumbnailLargeUrl ? hover : {})}>
        {c.thumbnailLargeUrl ? <img src={c.thumbnailLargeUrl} alt="" loading="lazy" /> : <span className="nx-card-noimage" />}
        {c.modCategory && <span className="nx-card-cat">{c.modCategory.name}</span>}
      </button>
      <div className="nx-card-body">
        <button type="button" className="nx-card-name" onClick={open} title={`Open ${name} on Nexus Mods`}>{name}</button>
        <span className="nx-card-by">{plain(c.author)}<span aria-hidden="true"> · </span><span title={new Date(c.updatedAt).toLocaleString()}>updated {ago(c.updatedAt)}</span></span>
        <p className="nx-card-summary">{plain(c.summary)}</p>
        <div className="nx-card-foot">
          <span className="nx-stat" title={`${c.endorsements.toLocaleString()} endorsements`}><Heart size={12} aria-hidden="true" />{count.format(c.endorsements)}</span>
          <span className="nx-stat" title={`${c.downloads.toLocaleString()} downloads`}><Download size={12} aria-hidden="true" />{count.format(c.downloads)}</span>
          {u && path ? (
            <button type="button" className="nx-act is-update" onClick={() => getNexusFile(u.modId, u.fileId, path)} title={`Version ${u.version} is out`} aria-label={`Update ${name} to ${u.version}`}>
              <ArrowUpCircle size={13} aria-hidden="true" /> Update
            </button>
          ) : path ? (
            <span className="nx-act is-installed"><Check size={13} aria-hidden="true" /> Installed</span>
          ) : (
            <button type="button" className="nx-act" onClick={() => installFromNexus(c.modId)} aria-label={`Install ${name}`}><Download size={13} aria-hidden="true" /> Install</button>
          )}
        </div>
      </div>
    </article>
  )
}

const galleries = new Map<number, string[]>() // by mod id, once read this session

/** A card's gallery, larger, over the card while the pointer rests on its picture: every picture on the mod's Nexus page
 *  (xtra_nexus_images), paged with arrows or the arrow keys. Until they load, or when Nexus turns the request away, the
 *  card's own picture. A click on the picture opens the mod's page. */
function NexusPeek({ modId, name, first, anchor, hover, onOpen, onClose }: {
  modId: number; name: string; first: string | null; anchor: HTMLElement
  hover: { onMouseEnter: () => void; onMouseLeave: () => void }; onOpen: () => void; onClose: () => void
}) {
  const [urls, setUrls] = useState<string[]>(() => galleries.get(modId) ?? (first ? [first] : []))
  const [at, setAt] = useState(0)
  useEffect(() => {
    if (galleries.has(modId)) return
    let on = true
    invoke<string[]>('xtra_nexus_images', { modId }).then(found => {
      if (!found.length) return
      galleries.set(modId, found)
      if (on) setUrls(found)
    }, () => undefined)
    return () => { on = false }
  }, [modId])
  const step = (d: number) => setAt(i => (i + d + urls.length) % urls.length)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  if (!urls.length) return null
  // centered on the card's picture, as big as the window allows, never past its edges
  const r = anchor.getBoundingClientRect()
  const w = Math.min(720, window.innerWidth - 32), h = Math.round(w * 9 / 16)
  const left = Math.max(16, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 16))
  const top = Math.max(16, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 16))
  const shown = urls[Math.min(at, urls.length - 1)]
  return createPortal(
    <div className="nx-peek" style={{ left, top, width: w, height: h }} role="dialog" aria-label={`Pictures of ${name}`} {...hover}>
      <button type="button" className="nx-peek-image" onClick={onOpen} aria-label={`Open ${name} on Nexus Mods`}>
        <img key={shown} src={shown} alt={`${name}, picture ${at + 1} of ${urls.length}`} />
      </button>
      {urls.length > 1 && <>
        <button type="button" className="lo-media-arrow is-prev" aria-label="Previous picture" title="Previous picture" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button type="button" className="lo-media-arrow is-next" aria-label="Next picture" title="Next picture" onClick={() => step(1)}><ChevronRight size={16} /></button>
        <span className="nx-peek-count" aria-live="polite">{at + 1} / {urls.length}</span>
      </>}
    </div>,
    document.body,
  )
}
