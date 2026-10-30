// repakxtra: the Nexus Mods tab, beside Loadouts and Library: Marvel Rivals mods on Nexus Mods from its public API
// (adult mods left out), once an account is saved (nexus.tsx). Search, a hero, a type, a time window and a sort, then
// pages of cards. Install gets the mod's main file (nexus.tsx installFromNexus), Update replaces the copy you have, and the
// picture or name opens the mod's page in the app's Nexus window. Stays mounted while hidden, so the search and the cards
// are still there on the way back.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { ArrowDownWideNarrow, ArrowUpCircle, Check, ChevronLeft, ChevronRight, Clock, Download, Gamepad2, Heart, Images, LayoutGrid, Music, Palette, RotateCw, Search, SlidersHorizontal, Tag, User, X, type LucideIcon } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import { NexusSignIn, gql, getNexusFile, installFromNexus, openNexusPage, plain, updateOf, useNexusAccount, useNexusInstalling, useNexusPending, useNexusReady, useNexusUpdates } from './nexus'
import { sourceOf, useNexusVersion } from './nexusSource'
import { useView } from './loadoutStore'
import { ownsTop, useDialogFocus } from './dialogFocus'
import { HeroFilter, heroInTitle, useHeroNames, useHeroPortrait } from './heroFilter'

type Card = {
  modId: number; name: string; author: string; endorsements: number; downloads: number
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
// Nexus's own time windows (its All time menu), saying what they count: uploads, or updates under Recently updated
const SPANS = [['1', '24 hours'], ['7', '7 days'], ['14', '14 days'], ['28', '28 days'], ['365', '1 year']]
const windowsFor = (period: string) => [{ value: 'all', label: `${period} any time` }, ...SPANS.map(([value, span]) => ({ value, label: `${period} in ${span}` }))]
// Nexus's top categories for Marvel Rivals, each in its own color on the cards (hero mods are Characters or a hero's own
// category, which a card shows as the hero's portrait in the Characters color)
const TYPE_COLOR: Record<string, string> = {
  Characters: '#5cc8ff', Audio: '#9d7bff', 'User Interface': '#ff7ad9', Visuals: '#3ecf6e', Gameplay: '#f5d342', Miscellaneous: '#2dd4bf',
}
// and its icon, before the type's name on a card without a hero (another category: a tag)
const TYPE_ICON: Record<string, LucideIcon> = {
  Characters: User, Audio: Music, 'User Interface': LayoutGrid, Visuals: Palette, Gameplay: Gamepad2, Miscellaneous: SlidersHorizontal,
}
// the type filter shows each type's color as a dot, the one the cards use (Similarity)
const TYPES = [{ value: 'all', label: 'All types', glyph: <span className="nx-type-dot is-all" /> },
  ...Object.entries(TYPE_COLOR).map(([t, color]) => ({ value: t, label: t, glyph: <span className="nx-type-dot" style={{ background: color }} /> }))]
// where a Nexus category name differs from the game's hero name
const CATEGORY_OF: Record<string, string> = { 'Doctor Strange': 'Dr. Strange', Deadpool: 'DeadPool' }
const HERO_OF = Object.fromEntries(Object.entries(CATEGORY_OF).map(([hero, category]) => [category, hero]))
type Look = { portrait: ReturnType<typeof useHeroPortrait>; heroes: string[]; pick: Pick; onShow: (path: string) => void }
/** A card's hero, type, or author narrows the list to it (Fitts: the filter is where the eye already is) */
type Pick = { hero: (h: string) => void; type: (t: string) => void; author: (a: string) => void; active: { hero: string; type: string; author: string } }
const PAGE = 24
/** Pages load as the list nears its end up to this many cards (the last whole page under it: 96), then Show more asks
 *  first, so a long scroll never pulls thousands */
const AUTO_UNTIL = 100
const QUERY = `query($f: ModsFilter, $s: [ModsSort!], $o: Int, $c: Int) {
  mods(filter: $f, sort: $s, offset: $o, count: $c) { totalCount nodes { modId name author endorsements downloads thumbnailLargeUrl updatedAt modCategory { name } } } }`

const count = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'always', style: 'short' }) // "1 yr. ago" beside "2 yr. ago", never "last yr."
const ago = (iso: string) => {
  const s = (Date.parse(iso) - Date.now()) / 1000
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600]] as const) {
    if (Math.abs(s) >= n) return rel.format(Math.round(s / n), unit)
  }
  return rel.format(Math.round(s / 60), 'minute')
}

/** The search as a Nexus filter: the game, no adult mods, then each picked part (all must match). A hero matches its
 *  category, or its name in the mod's name or description. */
function filterOf(query: string, hero: string, type: string, days: string, sort: string, author = '') {
  const f: Record<string, unknown> = { gameDomainName: [{ value: 'marvelrivals' }], adultContent: [{ value: false }] }
  if (query) f.nameStemmed = [{ value: query, op: 'MATCHES' }]
  if (author) f.author = [{ value: author, op: 'EQUALS' }]
  if (type !== 'all') f.categoryName = [{ value: type }]
  if (days !== 'all') f[sort === 'updatedAt' ? 'updatedAt' : 'createdAt'] = [{ value: String(Math.floor(Date.now() / 1000) - Number(days) * 86400), op: 'GT' }]
  if (hero) f.filter = [{ op: 'OR', categoryName: [{ value: CATEGORY_OF[hero] ?? hero }], nameStemmed: [{ value: hero, op: 'MATCHES' }], description: [{ value: hero, op: 'MATCHES' }] }]
  return f
}

export default function NexusBrowser({ mods, onShow }: { mods: { path: string }[]; onShow: (path: string) => void }) {
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
  const [author, setAuthor] = useState('')
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
  const body = useRef<HTMLDivElement>(null)
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
    const key = JSON.stringify([query, hero, type, days, sort, author, tries])
    const fresh = key !== shown.current
    if (fresh) wanted.current = 0
    else if (wanted.current <= loaded.current) { setState('ok'); return } // back on the tab (or this search again): its pages are here
    const at = wanted.current
    let on = true
    setState('loading')
    // a new search: its placeholders from the top, never the last search's cards under the new filters (Show more keeps them)
    if (fresh) { setCards([]); body.current?.scrollTo({ top: 0 }) }
    const dir = sort === 'name' ? 'ASC' : 'DESC'
    gql<Page>(QUERY, { f: filterOf(query, hero, type, days, sort, author), s: [{ [sort]: { direction: dir } }], o: at * PAGE, c: PAGE })
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
  }, [live, query, hero, type, days, sort, author, tries, more])

  // Top this week: the three most endorsed mods uploaded in the last 7 days, over the grid while nothing narrows it
  const [top, setTop] = useState<Card[]>([])
  useEffect(() => {
    if (!live || top.length) return
    gql<Page>(QUERY, { f: filterOf('', '', 'all', '7', 'endorsements'), s: [{ endorsements: { direction: 'DESC' } }], o: 0, c: 3 })
      .then(d => setTop(d.mods.nodes), () => undefined) // no spotlight then, the grid still shows
  }, [live, top.length])
  const portrait = useHeroPortrait()
  const look = useMemo<Look>(() => ({ portrait, heroes, onShow, pick: { hero: setHero, type: setType, author: setAuthor, active: { hero, type, author } } }),
    [portrait, heroes.join(), onShow, hero, type, author]) // eslint-disable-line react-hooks/exhaustive-deps

  const showMore = () => { wanted.current = loaded.current + 1; setMore(n => n + 1) }
  // the next page starts loading before the list's end is in view, up to AUTO_UNTIL cards (Doherty Threshold)
  const moreRef = useRef<HTMLDivElement>(null)
  const paused = cards.length + PAGE > AUTO_UNTIL
  const auto = state === 'ok' && !done && cards.length > 0 && !paused
  useEffect(() => {
    const el = moreRef.current
    if (!auto || !el) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) showMore() }, { root: body.current, rootMargin: '600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [auto, cards.length])
  const narrowed = Boolean(query || hero || type !== 'all' || days !== 'all' || author)
  const clear = () => { setText(''); setQuery(''); setHero(''); setType('all'); setDays('all'); setAuthor('') }
  // the time window counts uploads, or updates under Recently updated (filterOf)
  const period = sort === 'updatedAt' ? 'Updated' : 'Uploaded'
  const windows = windowsFor(period)
  // each filter that narrows the list, with its own way out (the empty state removes one at a time)
  const parts = [
    query && { label: 'Clear search', off: () => { setText(''); setQuery('') } },
    author && { label: `Remove ${author}`, off: () => setAuthor('') },
    hero && { label: `Remove ${hero}`, off: () => setHero('') },
    type !== 'all' && { label: `Remove ${type}`, off: () => setType('all') },
    days !== 'all' && { label: `Remove ${SPANS.find(([v]) => v === days)?.[1]}`, off: () => setDays('all') },
  ].filter(Boolean) as { label: string; off: () => void }[]
  const spot = !narrowed && top.length === 3

  if (view !== 'nexus') return null
  if (!account) return (
    <div className="lo-screen nx-screen" aria-label="Nexus Mods">
      <div className="nx-signin-wrap">{ready ? <NexusSignIn /> : <p className="nx-checking" role="status">Checking your Nexus Mods account…</p>}</div>
    </div>
  )
  const first = state === 'loading' && !cards.length
  return (
    <div className="lo-screen nx-screen" aria-label="Nexus Mods">
      <header className="nx-head">
        <div className="nx-titles">
          <div className="nx-title">
            <h2>Nexus Mods</h2>
          </div>
        </div>
        <div className="nx-filters" role="search">
          <label className="lp-search nx-search">
            <Search size={14} aria-hidden="true" />
            <input value={text} placeholder="Search mods" aria-label="Search Marvel Rivals mods on Nexus Mods" onChange={e => setText(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setText('') }} />
            {text && <button type="button" className="lo-icon" aria-label="Clear search" title="Clear search" onClick={() => setText('')}><X size={13} /></button>}
          </label>
          <Clearable set={Boolean(hero)} what="hero" onClear={() => setHero('')}><HeroFilter heroes={heroes} value={hero} onChange={setHero} always /></Clearable>
          <Clearable set={type !== 'all'} what="type" onClear={() => setType('all')}><CustomDropdown className="lp-hero nx-type" options={TYPES} value={type} onChange={setType} ariaLabel="Mod type" /></Clearable>
          <Clearable set={days !== 'all'} what="time" onClear={() => setDays('all')}>
            <CustomDropdown className="lp-hero nx-window" options={windows} value={days} onChange={setDays} ariaLabel="Time" icon={<Clock size={14} />} /></Clearable>
          {author && <button type="button" className="nx-chip" onClick={() => setAuthor('')} title="Show mods by everyone" aria-label={`Remove the ${author} filter`}><User size={13} aria-hidden="true" />{author}<X size={13} aria-hidden="true" /></button>}
          {parts.length >= 2 && <button type="button" className="su-link nx-clear" onClick={clear}>Clear filters</button>}
          {/* ordering, not a filter: the same box without its fill (Similarity) */}
          <CustomDropdown className="lp-hero nx-sort" options={query ? SORTS : SORTS.slice(0, -1)} value={sort} onChange={setSort} ariaLabel="Sort" icon={<ArrowDownWideNarrow size={14} />} />
        </div>
      </header>
      <div className="lo-body nx-body" ref={body}>
        {/* each heading with its own cards (Proximity), the two sections apart */}
        {spot && (
          <section className="nx-section nx-spot" aria-labelledby="nx-top-title">
            <div className="nx-section-head"><h3 id="nx-top-title" className="nx-section-title">Top this week</h3><span className="nx-section-note">Most endorsed uploads of the last 7 days</span></div>
            <div className="nx-spot-grid">{top.map((c, i) => <NexusCard key={c.modId} c={c} path={installed.get(c.modId)} look={look} rank={i + 1} />)}</div>
          </section>
        )}
        <section className="nx-section" aria-labelledby="nx-all-title">
          {/* the count beside the heading it counts: All mods, or Results while filters narrow it. The last count stays,
              dimmed, while the next loads, so the heading never jumps */}
          <div className="nx-section-head">
            <h3 id="nx-all-title" className="nx-section-title">{narrowed ? 'Results' : 'All mods'}</h3>
            <span className={`nx-total${state === 'loading' ? ' is-stale' : ''}`} role="status">
              {state === 'loading' && <span className="xtra-sr-only">Updating results</span>}
              <span aria-hidden={state === 'loading'}>{total || state === 'ok' ? `${total.toLocaleString()} ${total === 1 ? 'mod' : 'mods'}` : ''}</span>
            </span>
          </div>
          {state === 'error' && !cards.length ? (
            <div className="nx-empty" role="alert"><p>Nexus Mods could not be reached.</p><small>{narrowed ? 'Check your connection. Your filters are kept.' : 'Check your connection, then try again.'}</small>
              <button type="button" className="lo-text-btn" onClick={() => setTries(t => t + 1)}><RotateCw size={13} aria-hidden="true" /> Try again</button>
              <ErrorDetails error={error} /></div>
          ) : state === 'ok' && !cards.length ? (
            <div className="nx-empty"><p>No mods match these filters.</p>
              {hero && type !== 'all' && <small>Some authors file hero skins under Visuals, or name the hero only in the title.</small>}
              {/* one filter at a time, so the hero you came for can stay (Postel's Law) */}
              <div className="nx-empty-parts">
                {parts.map(x => <button key={x.label} type="button" className="nx-chip" onClick={x.off}><X size={12} aria-hidden="true" />{x.label}</button>)}
                {parts.length > 1 && <button type="button" className="su-link nx-clear" onClick={clear}>Clear all</button>}
              </div></div>
          ) : (
            <div className={`nx-grid${first ? ' is-loading' : ''}`} aria-busy={state === 'loading'}>
              {first
                ? Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="nx-card is-skeleton" aria-hidden="true"><span className="nx-sk-img" /><span className="nx-sk-line is-wide" /><span className="nx-sk-line" /><span className="nx-sk-line is-short" /></div>
                ))
                : cards.map(c => <NexusCard key={c.modId} c={c} path={installed.get(c.modId)} look={look} />)}
            </div>
          )}
          {cards.length > 0 && !done && (
            <div className="nx-more" ref={moreRef}>
              {paused && state !== 'error' && <small>{cards.length.toLocaleString()} of {total.toLocaleString()} shown</small>}
              {state === 'error' && <small role="alert">More mods did not load. <ErrorDetails error={error} /></small>}
              <button type="button" className="lo-text-btn" disabled={state === 'loading'} onClick={showMore}>
                {state === 'loading' ? 'Loading…' : state === 'error' ? 'Try again' : 'Show more'}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

/** Top this week's medals are hidden for now (cable's call): the code stays, true shows them again. */
const SHOW_MEDALS = false

/** A Top this week card's place: a flat medal (a light rim, a darker disc, the number in the rim's color). */
const Medal = ({ rank }: { rank: number }) => (
  <svg className={`nx-medal is-${rank}`} viewBox="0 0 24 24" role="img" aria-label={`Number ${rank} this week`}>
    <circle className="nx-medal-rim" cx="12" cy="12" r="11.5" />
    <circle className="nx-medal-disc" cx="12" cy="12" r="7.8" />
    <text x="12" y="12" textAnchor="middle" dominantBaseline="central">{rank}</text>
  </svg>
)

/** What Nexus said when it failed, folded away under a short explanation. */
const ErrorDetails = ({ error }: { error: string }) => (
  <details className="nx-details"><summary>Details</summary><code>{error}</code></details>
)

/** rank: its place in Top this week (1 to 3), a gold, silver, or bronze medal in its corner */
function NexusCard({ c, path, look, rank }: { c: Card; path?: string; look: Look; rank?: number }) {
  const u = path ? updateOf(sourceOf(path)) : undefined
  const name = plain(c.name)
  const open = () => openNexusPage(c.modId)
  const waiting = useNexusPending(c.modId)
  const installing = useNexusInstalling(c.modId)
  const picture = useRef<HTMLButtonElement>(null)
  const [peek, setPeek] = useState(false)
  const pictures = c.thumbnailLargeUrl ? `See the pictures of ${name}` : `Open ${name} on Nexus Mods` // no picture: its page
  // Install reads the mod's files first (a second or two): it says so at once
  const [preparing, setPreparing] = useState(false)
  const install = () => { setPreparing(true); void installFromNexus(c.modId).finally(() => setPreparing(false)) }
  const title = <div className="nx-card-title"><button type="button" className="nx-card-name" onClick={open} title={`Open ${name} on Nexus Mods`}>{name}</button></div>
  const by = (
    <span className="nx-card-by">
      <FilterLink className="nx-meta" on={look.pick.active.author === plain(c.author)} what={`mods by ${plain(c.author)}`} pick={() => look.pick.author(plain(c.author))}>
        <User size={12} aria-hidden="true" /><span>{plain(c.author)}</span></FilterLink>
      <span className="nx-meta" title={`Updated ${new Date(c.updatedAt).toLocaleString()}`}><Clock size={12} aria-hidden="true" />{ago(c.updatedAt)}</span>
    </span>
  )
  const stats = <>
    <span className="nx-stat is-endorsed" title={`${c.endorsements.toLocaleString()} endorsements`}><Heart size={13} aria-hidden="true" />{count.format(c.endorsements)}</span>
    <span className="nx-stat is-downloads" title={`${c.downloads.toLocaleString()} downloads`}><Download size={13} aria-hidden="true" />{count.format(c.downloads)}</span>
  </>
  const action = u && path ? (
    <button type="button" className="nx-act is-update" onClick={() => getNexusFile(u.modId, u.fileId, path)} title={`Version ${u.version} is out`} aria-label={`Update ${name} to ${u.version}`}>
      <ArrowUpCircle size={13} aria-hidden="true" /> Update
    </button>
  ) : path ? (
    <button type="button" className="nx-act is-installed" onClick={() => look.onShow(path)} title="Show in Library" aria-label={`${name} is installed. Show it in the Library`}>
      <Check size={13} aria-hidden="true" /> Installed</button>
  ) : installing || preparing ? (
    // working on it: the words shimmer (the app's loading text), no spinner
    <button type="button" className="nx-act is-waiting" disabled aria-label={`${installing ? 'Installing' : 'Preparing to install'} ${name}`}>
      <span className="t-shimmer">{installing ? 'Installing' : 'Preparing'}</span></button>
  ) : waiting ? (
    // free account: the mod's Files tab is open in the Nexus window, a click brings it back to the front
    <button type="button" className="nx-act is-waiting" onClick={install} title="Click Slow download in the Nexus window"
      aria-label={`Waiting for Nexus. Click Slow download in the Nexus window to install ${name}`}><span className="t-shimmer">Waiting for Nexus</span></button>
  ) : (
    <button type="button" className="nx-act is-install" onClick={install} aria-label={`Install ${name}`}><Download size={13} aria-hidden="true" /> Install</button>
  )
  return (
    <article className="nx-card">
      {SHOW_MEDALS && rank && <Medal rank={rank} />}
      {peek && <NexusPeek modId={c.modId} name={name} first={c.thumbnailLargeUrl} onOpen={open} onClose={() => setPeek(false)} />}
      <button ref={picture} type="button" className="nx-card-image" title={pictures} aria-label={pictures}
        onClick={() => { if (c.thumbnailLargeUrl) setPeek(true); else open() }}>
        {c.thumbnailLargeUrl ? <img src={c.thumbnailLargeUrl} alt="" loading="lazy" /> : <span className="nx-card-noimage" />}
        {/* the picture opens a gallery: said on hover, with the count once it is known */}
        {c.thumbnailLargeUrl && <span className="nx-card-pics" aria-hidden="true"><Images size={12} />{galleryCount.get(c.modId) ? `${galleryCount.get(c.modId)} pictures` : 'Pictures'}</span>}
      </button>
      <div className="nx-card-body">
        {rank ? <>
          {/* Top this week: who, when, and the numbers on one line over the title, Install beside the title */}
          <div className="nx-card-facts">{by}{stats}</div>
          <div className="nx-spot-row">{title}{action}</div>
        </> : <>
          {title}
          {/* the hero or type, then who and when */}
          <div className="nx-card-facts">
            <TypeLine category={c.modCategory?.name ?? ''} title={name} look={look} />
            {by}
          </div>
          <div className="nx-card-foot">{stats}{action}</div>
        </>}
        {/* what to do next, on the card it is about (it lived in the page's subtitle) */}
        {waiting && !installing && !path && <p className="nx-card-note" role="status">Click Slow download in the Nexus window.</p>}
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
  // a hero filters by the hero, a top type by the type (another category has no filter of its own)
  const pick = hero ? () => look.pick.hero(hero) : TYPE_COLOR[category] ? () => look.pick.type(category) : undefined
  const on = hero ? look.pick.active.hero === hero : look.pick.active.type === category
  const inner = <>{face ? <img src={face} alt="" /> : <TypeIcon category={category} />}{label}</>
  const style = color ? { '--type': color } as CSSProperties : undefined
  return pick
    ? <FilterLink className="nx-card-type" style={style} on={on} what={`${label} mods`} pick={pick}>{inner}</FilterLink>
    : <span className="nx-card-type" style={style}>{inner}</span>
}

/** A fact on a card that narrows the list to it: looks like the fact, underlines on hover. Already the filter: inert. */
function FilterLink({ className, style, on, what, pick, children }: { className: string; style?: CSSProperties; on: boolean; what: string; pick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`${className} nx-filter-link`} style={style} aria-pressed={on} disabled={on}
      title={on ? `Showing ${what}` : `Show ${what}`} onClick={pick}>{children}</button>
  )
}

/** A filter box that, once set, shows an X in place of its chevron: that filter clears alone (Fitts) */
function Clearable({ set, what, onClear, children }: { set: boolean; what: string; onClear: () => void; children: ReactNode }) {
  return (
    <span className={`nx-filter${set ? ' is-set' : ''}`}>
      {children}
      {set && <button type="button" className="nx-filter-x" aria-label={`Clear the ${what} filter`} title={`Clear the ${what} filter`} onClick={onClear}><X size={13} /></button>}
    </span>
  )
}

const TypeIcon = ({ category }: { category: string }) => { const Icon = TYPE_ICON[category] ?? Tag; return <Icon size={13} aria-hidden="true" /> }

/** Each mod's gallery, read once this session (xtra_nexus_images): a mod whose read came back empty is tried again later. */
const galleries = new Map<number, Promise<string[]>>()
/** How many pictures each mod's gallery has, once read (a card's Pictures pill says the count) */
const galleryCount = new Map<number, number>()
const loadGallery = (modId: number) => {
  let read = galleries.get(modId)
  if (!read) {
    read = invoke<string[]>('xtra_nexus_images', { modId }).catch(() => [] as string[])
    read.then(found => { if (found.length) galleryCount.set(modId, found.length); else galleries.delete(modId) })
    galleries.set(modId, read)
  }
  return read
}

/** A card's gallery, opened by a click on its picture, over the dimmed app: every picture on the mod's Nexus page
 *  (xtra_nexus_images), paged with arrows or the arrow keys. Until they load, or when Nexus turns the request away, the
 *  card's own picture. A click on the picture opens the mod's page, Esc or a click beside it closes it. A dialog: Tab
 *  stays inside, the app behind is inert, focus goes back to the card's picture (useDialogFocus). */
function NexusPeek({ modId, name, first, onOpen, onClose }: { modId: number; name: string; first: string | null; onOpen: () => void; onClose: () => void }) {
  const [urls, setUrls] = useState<string[]>(() => (first ? [first] : []))
  const [loading, setLoading] = useState(true)
  const [at, setAt] = useState(0)
  // the picture on screen stays until the next one has fully loaded: no blank frame between them (and the card's own
  // thumbnail stays until the full-size first picture is in)
  const [onScreen, setOnScreen] = useState(first ?? '')
  const wanted = urls[Math.min(at, urls.length - 1)] ?? ''
  const [failed, setFailed] = useState('') // the picture asked for that did not load (Retry asks again)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!wanted || wanted === onScreen) return
    let on = true
    setFailed('')
    const next = new Image()
    next.onload = () => { if (on) setOnScreen(wanted) }
    next.onerror = () => { if (on) setFailed(wanted) }
    next.src = wanted
    return () => { on = false }
  }, [wanted, retry]) // eslint-disable-line react-hooks/exhaustive-deps
  // the count follows the picture on screen, not the one still loading
  const shownAt = Math.max(0, urls.indexOf(onScreen))
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
  const focus = useDialogFocus()
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!ownsTop(focus.ref.current)) return
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1) }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  // centered in the window, as big as it allows up to 960 wide
  const w = Math.min(960, window.innerWidth - 64, Math.round((window.innerHeight - 64) * 16 / 9)), h = Math.round(w * 9 / 16)
  // the dim layer is the dialog, so a click on it (beside the pictures) closes them and only it stays usable
  return createPortal(
    <div className="nx-peek-layer" ref={focus.ref} onKeyDown={focus.onKeyDown} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Pictures of ${name}`}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
    <div className="nx-peek" style={{ width: w, height: h }}>
      <div className="nx-peek-bar">
        <span className="nx-peek-name">{name}</span>
        <button type="button" className="nx-peek-close" aria-label="Close pictures" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
      </div>
      <button type="button" className="nx-peek-image" onClick={onOpen} aria-label={`Open ${name} on Nexus Mods`}>
        {onScreen && <img src={onScreen} alt={`${name}, picture ${shownAt + 1} of ${urls.length}`} />}
      </button>
      {failed === wanted && wanted && (
        <div className="nx-peek-error" role="alert">
          <span>This picture did not load.</span>
          <button type="button" className="lo-text-btn" onClick={() => setRetry(n => n + 1)}><RotateCw size={13} aria-hidden="true" /> Retry</button>
        </div>
      )}
      {urls.length > 1 && <>
        <button type="button" className="lo-media-arrow is-prev" aria-label="Previous picture" title="Previous picture" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
        <button type="button" className="lo-media-arrow is-next" aria-label="Next picture" title="Next picture" onClick={() => step(1)}><ChevronRight size={16} /></button>
      </>}
      {(urls.length > 1 || loading) && <span className="nx-peek-count" aria-live="polite">{loading && urls.length < 2 ? 'Loading pictures…' : `${shownAt + 1} of ${urls.length}`}</span>}
    </div>
    </div>,
    document.body,
  )
}
