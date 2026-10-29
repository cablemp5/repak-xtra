// repakxtra: the Nexus Mods tab, beside Loadouts and Library: Marvel Rivals mods on Nexus Mods from its public API
// (adult mods left out), once an account is saved (nexus.tsx). Search, a hero, a type, a time window and a sort, then
// pages of cards. Install gets the mod's main file (nexus.tsx installFromNexus), Update replaces the copy you have, and the
// picture or name opens the mod's page in the app's Nexus window. Stays mounted while hidden, so the search and the cards
// are still there on the way back.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { ArrowUpCircle, Check, ChevronLeft, ChevronRight, Download, Heart, Loader2, Search, X } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import { NexusSignIn, gql, getNexusFile, installFromNexus, openNexusPage, plain, updateOf, useNexusAccount, useNexusPending, useNexusReady, useNexusUpdates } from './nexus'
import { sourceOf, useNexusVersion } from './nexusSource'
import { useView } from './loadoutStore'
import { HeroFilter, heroInTitle, useHeroNames, useHeroPortrait } from './heroFilter'

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
// Nexus's top categories for Marvel Rivals, each in its own color on the cards (hero mods are Characters or a hero's own
// category, which a card shows as the hero's portrait in the Characters color)
const TYPE_COLOR: Record<string, string> = {
  Characters: '#5cc8ff', Audio: '#9d7bff', 'User Interface': '#ff7ad9', Visuals: '#3ecf6e', Gameplay: '#f5d342', Miscellaneous: '#a7a7a7',
}
const TYPES = [{ value: 'all', label: 'All types' }, ...Object.keys(TYPE_COLOR).map(t => ({ value: t, label: t }))]
// where a Nexus category name differs from the game's hero name
const CATEGORY_OF: Record<string, string> = { 'Doctor Strange': 'Dr. Strange', Deadpool: 'DeadPool' }
const HERO_OF = Object.fromEntries(Object.entries(CATEGORY_OF).map(([hero, category]) => [category, hero]))
type Look = { portrait: ReturnType<typeof useHeroPortrait>; heroes: string[] }
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

  // Top this week: the three most endorsed mods uploaded in the last 7 days, over the grid while nothing narrows it
  const [top, setTop] = useState<Card[]>([])
  useEffect(() => {
    if (!live || top.length) return
    gql<Page>(QUERY, { f: filterOf('', '', 'all', '7', 'endorsements'), s: [{ endorsements: { direction: 'DESC' } }], o: 0, c: 3 })
      .then(d => setTop(d.mods.nodes), () => undefined) // no spotlight then, the grid still shows
  }, [live, top.length])
  const portrait = useHeroPortrait()
  const look = useMemo(() => ({ portrait, heroes }), [portrait, heroes.join()]) // eslint-disable-line react-hooks/exhaustive-deps

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
        <div className="nx-titles">
          <div className="nx-title">
            <h2>Nexus Mods</h2>
            <span className="nx-total" role="status">{state === 'ok' ? `${total.toLocaleString()} ${total === 1 ? 'mod' : 'mods'}` : ''}</span>
          </div>
          {!account.premium && <p className="nx-sub">Install opens the mod's file in the Nexus window. Click Slow download there and it installs here.</p>}
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
        {!narrowed && top.length === 3 && (
          <section className="nx-spot" aria-label="Top this week">
            <h3 className="nx-spot-title">Top this week</h3>
            <div className="nx-spot-grid">{top.map(c => <NexusCard key={c.modId} c={c} path={installed.get(c.modId)} look={look} />)}</div>
          </section>
        )}
        {!narrowed && top.length === 3 && <h3 className="nx-spot-title">All mods</h3>}
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
              : cards.map(c => <NexusCard key={c.modId} c={c} path={installed.get(c.modId)} look={look} />)}
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

function NexusCard({ c, path, look }: { c: Card; path?: string; look: Look }) {
  const u = path ? updateOf(sourceOf(path)) : undefined
  const name = plain(c.name)
  const open = () => openNexusPage(c.modId)
  const waiting = useNexusPending(c.modId)
  const picture = useRef<HTMLButtonElement>(null)
  const [peek, setPeek] = useState(false)
  const pictures = c.thumbnailLargeUrl ? `See the pictures of ${name}` : `Open ${name} on Nexus Mods` // no picture: its page
  return (
    <article className="nx-card">
      {peek && <NexusPeek modId={c.modId} name={name} first={c.thumbnailLargeUrl} onOpen={open} onClose={() => { setPeek(false); picture.current?.focus() }} />}
      <button ref={picture} type="button" className="nx-card-image" title={pictures} aria-label={pictures}
        onClick={() => { if (c.thumbnailLargeUrl) setPeek(true); else open() }}>
        {c.thumbnailLargeUrl ? <img src={c.thumbnailLargeUrl} alt="" loading="lazy" /> : <span className="nx-card-noimage" />}
      </button>
      <div className="nx-card-body">
        <button type="button" className="nx-card-name" onClick={open} title={`Open ${name} on Nexus Mods`}>{name}</button>
        <span className="nx-card-by">{plain(c.author)}<span aria-hidden="true"> · </span><span title={new Date(c.updatedAt).toLocaleString()}>updated {ago(c.updatedAt)}</span></span>
        <TypeLine category={c.modCategory?.name ?? ''} title={name} look={look} />
        <p className="nx-card-summary">{plain(c.summary)}</p>
        <div className="nx-card-foot">
          <span className="nx-stat is-endorsed" title={`${c.endorsements.toLocaleString()} endorsements`}><Heart size={12} aria-hidden="true" />{count.format(c.endorsements)}</span>
          <span className="nx-stat is-downloads" title={`${c.downloads.toLocaleString()} downloads`}><Download size={12} aria-hidden="true" />{count.format(c.downloads)}</span>
          {u && path ? (
            <button type="button" className="nx-act is-update" onClick={() => getNexusFile(u.modId, u.fileId, path)} title={`Version ${u.version} is out`} aria-label={`Update ${name} to ${u.version}`}>
              <ArrowUpCircle size={13} aria-hidden="true" /> Update
            </button>
          ) : path ? (
            <span className="nx-act is-installed"><Check size={13} aria-hidden="true" /> Installed</span>
          ) : waiting ? (
            // free account: the mod's Files tab is open in the Nexus window, a click brings it back to the front
            <button type="button" className="nx-act is-waiting" onClick={() => installFromNexus(c.modId)} title="Click Slow download in the Nexus window"
              aria-label={`Waiting for Nexus. Click Slow download in the Nexus window to install ${name}`}><Loader2 size={13} aria-hidden="true" /> Waiting for Nexus</button>
          ) : (
            <button type="button" className="nx-act is-install" onClick={() => installFromNexus(c.modId)} aria-label={`Install ${name}`}><Download size={13} aria-hidden="true" /> Install</button>
          )}
          {waiting && <span className="xtra-sr-only" role="status">Click Slow download in the Nexus window to install {name}.</span>}
        </div>
      </div>
    </article>
  )
}

/** A card's hero, with its portrait in the Characters color: the hero's own category, or the hero its title names (a
 *  Visuals skin too). Otherwise its type, in the type's color. */
function TypeLine({ category, title, look }: { category: string; title: string; look: Look }) {
  const own = HERO_OF[category] ?? category
  const hero = !TYPE_COLOR[category] && look.portrait(own, false) ? own
    : heroInTitle(title, look.heroes)
  const face = hero ? look.portrait(hero) : undefined
  const label = hero || own
  if (!label) return null
  const color = hero ? TYPE_COLOR.Characters : TYPE_COLOR[category]
  return (
    <span className="nx-card-type" style={color ? { '--type': color } as CSSProperties : undefined}>
      {face && <img src={face} alt="" />}{label}
    </span>
  )
}

/** Each mod's gallery, read once this session (xtra_nexus_images): a mod whose read came back empty is tried again later. */
const galleries = new Map<number, Promise<string[]>>()
const loadGallery = (modId: number) => {
  let read = galleries.get(modId)
  if (!read) {
    read = invoke<string[]>('xtra_nexus_images', { modId }).catch(() => [] as string[])
    read.then(found => { if (!found.length) galleries.delete(modId) })
    galleries.set(modId, read)
  }
  return read
}

/** A card's gallery, opened by a click on its picture, over the dimmed app: every picture on the mod's Nexus page
 *  (xtra_nexus_images), paged with arrows or the arrow keys. Until they load, or when Nexus turns the request away, the
 *  card's own picture. A click on the picture opens the mod's page, Esc or a click beside it closes it. */
function NexusPeek({ modId, name, first, onOpen, onClose }: { modId: number; name: string; first: string | null; onOpen: () => void; onClose: () => void }) {
  const [urls, setUrls] = useState<string[]>(() => (first ? [first] : []))
  const [loading, setLoading] = useState(true)
  const [at, setAt] = useState(0)
  // the picture on screen stays until the next one has fully loaded: no blank frame between them (and the card's own
  // thumbnail stays until the full-size first picture is in)
  const [onScreen, setOnScreen] = useState(first ?? '')
  const wanted = urls[Math.min(at, urls.length - 1)] ?? ''
  useEffect(() => {
    if (!wanted || wanted === onScreen) return
    let on = true
    const next = new Image()
    next.onload = () => { if (on) setOnScreen(wanted) }
    next.src = wanted
    return () => { on = false }
  }, [wanted]) // eslint-disable-line react-hooks/exhaustive-deps
  // the others load in the background, so paging shows each at once
  useEffect(() => { urls.slice(0, 24).forEach(u => { new Image().src = u }) }, [urls])
  useEffect(() => {
    let on = true
    loadGallery(modId).then(found => {
      if (!on) return
      if (found.length) setUrls(found)
      setLoading(false)
    })
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
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => close.current?.focus(), []) // keyboard users land in the gallery
  if (!urls.length) return null
  // centered in the window, as big as it allows up to 960 wide
  const w = Math.min(960, window.innerWidth - 64, Math.round((window.innerHeight - 64) * 16 / 9)), h = Math.round(w * 9 / 16)
  return createPortal(<>
    <div className="nx-peek-dim" aria-hidden="true" onClick={onClose} />
    <div className="nx-peek" style={{ left: (window.innerWidth - w) / 2, top: (window.innerHeight - h) / 2, width: w, height: h }} role="dialog" aria-modal="true" aria-label={`Pictures of ${name}`}>
      <div className="nx-peek-bar">
        <span className="nx-peek-name">{name}</span>
        <button ref={close} type="button" className="nx-peek-close" aria-label="Close pictures" title="Close (Esc)" onClick={onClose}><X size={14} /></button>
      </div>
      <button type="button" className="nx-peek-image" onClick={onOpen} aria-label={`Open ${name} on Nexus Mods`}>
        {onScreen && <img src={onScreen} alt={`${name}, picture ${at + 1} of ${urls.length}`} />}
      </button>
      {urls.length > 1 && <>
        <button type="button" className="lo-media-arrow is-prev" aria-label="Previous picture" title="Previous picture" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button type="button" className="lo-media-arrow is-next" aria-label="Next picture" title="Next picture" onClick={() => step(1)}><ChevronRight size={16} /></button>
      </>}
      {(urls.length > 1 || loading) && <span className="nx-peek-count" aria-live="polite">{loading && urls.length < 2 ? 'Loading pictures…' : `${at + 1} of ${urls.length}`}</span>}
    </div>
  </>,
    document.body,
  )
}
