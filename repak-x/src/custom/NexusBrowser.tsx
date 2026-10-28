// repakxtra: the Nexus tab, beside Loadouts and Library: Marvel Rivals mods on Nexus Mods from its public API (no
// account needed to look, adult mods left out). Search, a sort, and pages of cards. Install gets the mod's main file
// (nexus.tsx installFromNexus), Update replaces the copy you have, and the picture or name opens the mod's page in the
// app's Nexus window. Stays mounted while hidden, so the search and the cards are still there on the way back.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpCircle, Check, Download, Heart, Search, X } from 'lucide-react'
import CustomDropdown from '../components/CustomDropdown'
import { gql, getNexusFile, installFromNexus, openNexusPage, plain, updateOf, useNexusUpdates } from './nexus'
import { sourceOf, useNexusVersion } from './nexusSource'
import { useView } from './loadoutStore'

type Card = { modId: number; name: string; author: string; summary: string; endorsements: number; downloads: number; thumbnailLargeUrl: string | null }
type Page = { mods: { totalCount: number; nodes: Card[] } }

const SORTS = [
  { value: 'endorsements', label: 'Most endorsed' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'updatedAt', label: 'Recently updated' },
  { value: 'createdAt', label: 'Newest' },
]
const PAGE = 24
const QUERY = `query($f: ModsFilter, $s: [ModsSort!], $o: Int, $c: Int) {
  mods(filter: $f, sort: $s, offset: $o, count: $c) { totalCount nodes { modId name author summary endorsements downloads thumbnailLargeUrl } } }`

const count = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export default function NexusBrowser({ mods }: { mods: { path: string }[] }) {
  const view = useView()
  const sources = useNexusVersion()
  useNexusUpdates()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('endorsements')
  const [cards, setCards] = useState<Card[]>([])
  const [total, setTotal] = useState(0)
  const [done, setDone] = useState(false) // every page of this search is in
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [error, setError] = useState('')
  const [tries, setTries] = useState(0) // Try again after a failed search
  const [more, setMore] = useState(0) // Show more (or its retry) clicks
  const shown = useRef('') // the search and sort the cards are for: a new one starts from page one
  const loaded = useRef(-1) // the last page loaded for it
  const wanted = useRef(0) // the page to load next: one past `loaded` once Show more asks
  // Your copy of each Nexus mod, by mod id (the first one found when there are several)
  const installed = useMemo(() => {
    const byId = new Map<number, string>()
    for (const m of mods) { const s = sourceOf(m.path); if (s && !byId.has(s.id)) byId.set(s.id, m.path) }
    return byId
  }, [mods, sources]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 300); return () => clearTimeout(t) }, [text])

  useEffect(() => {
    if (view !== 'nexus') return
    const key = `${query}\n${sort}\n${tries}`
    const fresh = key !== shown.current
    if (fresh) wanted.current = 0
    else if (wanted.current <= loaded.current) { setState('ok'); return } // back on the tab (or this search again): its pages are here
    const at = wanted.current
    let live = true
    setState('loading')
    const f = { gameDomainName: [{ value: 'marvelrivals' }], adultContent: [{ value: false }], ...(query ? { nameStemmed: [{ value: query, op: 'MATCHES' }] } : {}) }
    gql<Page>(QUERY, { f, s: [{ [sort]: { direction: 'DESC' } }], o: at * PAGE, c: PAGE })
      .then(d => {
        if (!live) return
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
        if (!live) return
        if (fresh) { setCards([]); shown.current = key; loaded.current = -1 } // never the last search's cards under this one
        setError(String(e))
        setState('error')
      })
    return () => { live = false }
  }, [view, query, sort, tries, more])

  const showMore = () => { wanted.current = loaded.current + 1; setMore(n => n + 1) }

  if (view !== 'nexus') return null
  const first = state === 'loading' && !cards.length
  return (
    <div className="lo-screen nx-screen" aria-label="Nexus Mods">
      <header className="lo-screen-head">
        <div className="lo-head-main"><div className="lo-title-row">
          <h2>Nexus Mods</h2>
          <label className="lp-search lo-search">
            <Search size={14} aria-hidden="true" />
            <input value={text} placeholder="Search Nexus Mods..." aria-label="Search Marvel Rivals mods on Nexus Mods" onChange={e => setText(e.target.value)}
              onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setText('') }} />
            {text && <button type="button" className="lo-icon" aria-label="Clear search" title="Clear search" onClick={() => setText('')}><X size={13} /></button>}
          </label>
          <span className="nx-total" role="status">{state === 'ok' ? `${total.toLocaleString()} mods` : ''}</span>
        </div></div>
        <div className="lo-head-view nx-sort"><CustomDropdown options={SORTS} value={sort} onChange={setSort} /></div>
      </header>
      <div className="lo-body nx-body">
        {state === 'error' && !cards.length ? (
          <div className="nx-empty"><p>Nexus Mods did not answer.</p><small>{error}</small>
            <button type="button" className="lo-text-btn" onClick={() => setTries(t => t + 1)}>Try again</button></div>
        ) : state === 'ok' && !cards.length ? (
          <div className="nx-empty"><p>No mods match "{query}".</p></div>
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

function NexusCard({ c, path }: { c: Card; path?: string }) {
  const u = path ? updateOf(sourceOf(path)) : undefined
  const name = plain(c.name)
  const open = () => openNexusPage(c.modId)
  return (
    <article className="nx-card">
      <button type="button" className="nx-card-image" onClick={open} title={`Open ${name} on Nexus Mods`} tabIndex={-1}>
        {c.thumbnailLargeUrl ? <img src={c.thumbnailLargeUrl} alt="" loading="lazy" /> : <span className="nx-card-noimage" />}
      </button>
      <div className="nx-card-body">
        <button type="button" className="nx-card-name" onClick={open} title={`Open ${name} on Nexus Mods`}>{name}</button>
        <span className="nx-card-by">by {plain(c.author)}</span>
        <p className="nx-card-summary">{plain(c.summary)}</p>
        <div className="nx-card-foot">
          <span className="nx-stat" title={`${c.endorsements.toLocaleString()} endorsements`}><Heart size={12} aria-hidden="true" />{count.format(c.endorsements)}</span>
          <span className="nx-stat" title={`${c.downloads.toLocaleString()} downloads`}><Download size={12} aria-hidden="true" />{count.format(c.downloads)}</span>
          {u && path ? (
            <button type="button" className="lo-text-btn nx-act is-update" onClick={() => getNexusFile(u.modId, u.fileId, path)} title={`Version ${u.version} is out`} aria-label={`Update ${name} to ${u.version}`}>
              <ArrowUpCircle size={13} aria-hidden="true" /> Update
            </button>
          ) : path ? (
            <span className="nx-installed"><Check size={13} aria-hidden="true" /> Installed</span>
          ) : (
            <button type="button" className="lo-text-btn nx-act" onClick={() => installFromNexus(c.modId)} aria-label={`Install ${name}`}><Download size={13} aria-hidden="true" /> Install</button>
          )}
        </div>
      </div>
    </article>
  )
}
