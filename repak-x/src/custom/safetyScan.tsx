// repakxtra: the ban risk check (backend: xtra_safety.rs). Marvel Rivals' anti-cheat notice names two .asi files
// that trip the anti-cheat and mod kinds that give an edge. Mods get a Ban risk badge (Settings > Warnings can hide
// it), a button that opens Why isn't it working? with the reason and a Turn off. Setup's Ban risk card lists
// every flagged mod with its reason and Turn off (one or all, with Undo), and the plugins beside the game exe with
// Remove for the flagged ones. Nothing is turned off by itself: the player decides.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChevronRight, ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { openWhy } from './WhyNotWorking'
import { modsBlocked, turnOffWithUndo } from './keepOne'
import { nameKey } from './loadoutIdentity'
import { useUiPref } from './uiPrefs'

type Alert = ReturnType<typeof useAlert>
export type Risk = { path: string; short: string; reason: string }
type Plugin = { name: string; place: string; kind: 'banned' | 'unknown' | 'bundled' }

export const NOTICE = 'Marvel Rivals can ban accounts for mods that remove recoil, screen shake, or hit effects, change footsteps, change maps so players see differently, or enlarge enemies.'
/** NetEase's "Use of Mods and Violation Management" announcement (Oct 15, 2026). */
const NOTICE_URL = 'https://www.marvelrivals.com/20261015/41525_1316797.html'
const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))

const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')
/** `state`: null before the first check finishes, 'failed' when it could not run, else 'done'. `unread`: mods it could
 *  not read, never counted as clean. `tries`: Try again bumps it, so the check runs again on an unchanged library. */
let store: { risks: Map<string, Risk>; unread: string[]; state: null | 'done' | 'failed'; tries: number } = { risks: new Map(), unread: [], state: null, tries: 0 }
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const set = (next: typeof store) => { store = next; listeners.forEach(l => l()) }

let names = new Map<string, string>()
const shownName = (path: string) => names.get(norm(path)) ?? nameKey(path)
export const riskOf = (path: string) => store.risks.get(norm(path))
export const useRisk = (path: string) => useSyncExternalStore(subscribe, () => store.risks.get(norm(path)))
export const useRisks = () => useSyncExternalStore(subscribe, () => store.risks)
const useRiskState = () => useSyncExternalStore(subscribe, () => store.state)
const useUnread = () => useSyncExternalStore(subscribe, () => store.unread)
/** Runs the mods check again now (Setup's Try again). */
export const recheckRisks = () => set({ ...store, state: null, tries: store.tries + 1 })

/** Checks again a moment after mods are added, removed, or replaced (names only, so it is quick once details are cached). */
export function useSafetyWatch(mods: { path: string; custom_name?: string; modified_date?: number; file_size?: number }[]) {
  // the Library's names for Setup's list (a renamed mod reads as it does there)
  names = new Map(mods.filter(m => m.custom_name).map(m => [norm(m.path), m.custom_name!]))
  // the whole path, .pak or .bak_repak: switching a mod on or off checks again, so the card's on and off stay true
  const key = mods.map(m => `${m.path.toLowerCase()}|${m.modified_date ?? ''}|${m.file_size ?? ''}`).sort().join('\n')
  const tries = useSyncExternalStore(subscribe, () => store.tries)
  useEffect(() => {
    // no mods: nothing to check, and the card says so instead of Checking forever
    if (!key) { set({ ...store, risks: new Map(), unread: [], state: 'done' }); return }
    let live = true
    const t = setTimeout(() => {
      invoke<{ risks: Risk[]; unread: string[] }>('xtra_safety_mods', { modPaths: mods.map(m => m.path) })
        .then(r => { if (live) set({ ...store, risks: new Map(r.risks.map(x => [norm(x.path), x])), unread: r.unread, state: 'done' }) })
        // the badges so far stay, and Setup says the check failed instead of reading clean
        .catch(e => { console.warn('[safety] mod check failed', e); if (live) set({ ...store, state: 'failed' }) })
    }, 1500)
    return () => { live = false; clearTimeout(t) }
  }, [key, tries]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** A button, so the keyboard reaches it and a screen reader says why: it opens Why isn't it working? for the mod. */
export function RiskBadge({ path, risk, name }: { path: string; risk: Risk; name?: string }) {
  if (!useUiPref('ban-risk')) return null
  return (
    <button type="button" className="mod-type-badge risk-badge is-ban" title={`${risk.reason} Click for what to do.`}
      aria-label={`Ban risk: ${risk.reason}`} onClick={e => { e.stopPropagation(); openWhy(path, name) }}>Ban risk</button>
  )
}

let toldAtStart = false
/** At start: a named plugin beside the game exe gets a toast that opens Setup at the Ban risk card (once per app start). */
export function checkBannedPlugins(alert: Alert, openSetup: () => void) {
  if (toldAtStart) return
  toldAtStart = true
  invoke<Plugin[]>('xtra_safety_plugins').then(ps => {
    const bad = ps.filter(p => p.kind === 'banned')
    if (!bad.length) return
    const id = alert.warning('Ban risk', `${bad.map(p => p.name).join(' and ')} ${bad.length === 1 ? 'is' : 'are'} in your game folder. Marvel Rivals' anti-cheat detects ${bad.length === 1 ? 'it' : 'them'}.`, {
      duration: 15000,
      action: { label: 'Review…', onClick: () => { alert.dismissAlert(id); openSetup() } },
    })
  }).catch(() => {})
}

const KIND: Record<'banned' | 'unknown', string> = {
  banned: 'Named in the notice as an anti-cheat trigger. Remove it',
  unknown: 'Not from repakxtra. It loads code into the game, so keep it only if you trust it',
}
const where = (p: Plugin) => p.place ? `Win64\\${p.place}` : 'Win64'

/** Setup's Ban risk card: the plugins beside the game exe, and how many mods carry a badge. */
export function SafetyCard({ alert }: { alert: Alert }) {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [asking, setAsking] = useState<Plugin | null>(null) // Remove asks first, in the plugin's row
  const [showList, setShowList] = useState(false) // the flagged mods' list, folded at first
  const all = useRisks(), state = useRiskState(), unread = useUnread()
  const isOnPath = (p: string) => /\.pak$/i.test(p)
  // switched-on mods first: they are the ones that matter in a match
  const listed = [...all.values()].sort((a, b) => Number(isOnPath(b.path)) - Number(isOnPath(a.path)) || shownName(a.path).localeCompare(shownName(b.path)))
  const on = listed.filter(r => isOnPath(r.path)).map(r => ({ path: r.path, enabled: true }))
  const turnOff = async (mods: typeof on, what: string) => {
    setBusy(what)
    try {
      // the Library's own game guard (its bypass setting too), for the switch and the toast's Undo. The folder watcher
      // reloads the Library and the next check re-keys the badges, so nothing to reload here
      await turnOffWithUndo({ alert, isBlocked: modsBlocked, reload: async () => {} }, mods, 'Ban risk mods off',
        `Turned off ${mods.length === 1 ? shownName(mods[0].path) : `${mods.length} mods`}. The game loads the change from the next launch.`)
    } finally { setBusy(null) }
  }
  const load = () => invoke<Plugin[]>('xtra_safety_plugins').then(p => { setPlugins(p); setFailed(null) }).catch(e => setFailed(String(e)))
  useEffect(() => { void load() }, [])
  const remove = (p: Plugin) => {
    setAsking(null); setBusy(p.name)
    invoke<Plugin[]>('xtra_safety_remove_plugin', { name: p.name, place: p.place })
      .then(ps => { setPlugins(ps); alert.success('Removed', `${p.name} was moved to %APPDATA%\\Repak-X\\removed-plugins. Move it back by hand to undo.`); window.dispatchEvent(new Event('bypass-changed')) })
      .catch(e => alert.warning(`Could not remove ${p.name}`, String(e))).finally(() => setBusy(null))
  }
  const flagged = (plugins ?? []).filter(p => p.kind !== 'bundled')
  const banned = flagged.some(p => p.kind === 'banned')
  // the chip sums up the whole card, mods too: "No flagged plugins" read as all clear while flagged mods were on
  const chip = failed ? 'Could not check' : !plugins ? 'Checking…' : banned ? 'Remove flagged files'
    : on.length ? `${on.length} mod${on.length === 1 ? '' : 's'} on` : flagged.length ? 'Unknown plugins'
    : state === null ? 'Checking…' : state === 'failed' ? 'Could not check' : unread.length ? 'Not all checked'
    : all.size ? 'Flagged mods off' : 'Nothing flagged'
  const found = all.size === 0 ? 'None match what the notice describes.' : `${all.size} marked, ${on.length ? `${on.length} of them on` : 'all off'}.`
  const mods = state === null ? 'Checking your mods…'
    : state === 'failed' ? `Could not be checked${all.size ? `. The last results: ${found}` : '.'}`
    : `${found}${unread.length ? ` ${unread.length} could not be read, so ${unread.length === 1 ? 'it is' : 'they are'} not checked.` : ''}`
  return (
    <section className="su-card su-safety-card">
      <div className="su-card-head">
        <div>
          <h3>Ban risk</h3>
          <p>{NOTICE} It also names two plugins that trip its anti-cheat. This check reads each mod's file name and the names of the files inside it, so it can miss a mod or flag a plain recolor. <a className="su-link ob-out" href={NOTICE_URL}
            onClick={e => { e.preventDefault(); void openUrl(NOTICE_URL) }}>Read the notice<ExternalLink size={13} aria-hidden="true" /></a></p>
        </div>
        <span className={`su-chip ${banned ? 'is-danger' : on.length ? 'is-risk' : flagged.length || state === 'failed' || unread.length ? 'is-warn' : state === 'done' && !all.size ? 'is-installed' : ''}`}>{chip}</span>
      </div>
      {failed && <p className="su-note">Could not read the game folder. {failed} <button type="button" className="su-link" onClick={() => void load()}>Try again</button></p>}
      {/* mods first, as a part row like the plugins below it: the finding a player acts on leads (Serial Position) */}
      <ul className="su-parts">
        <li className={`su-part su-risk-summary${on.length ? ' is-risk' : state === 'done' && !all.size && !unread.length ? ' is-clean' : ''}`}>
          {/* nothing flagged: a green shield with a check, like the bundled plugins' rows */}
          {state === 'done' && !all.size && !unread.length ? <ShieldCheck size={16} className="su-risk-icon" aria-hidden="true" /> : <ShieldAlert size={16} className="su-risk-icon" aria-hidden="true" />}
          <div className="su-part-text">
            <b>Your mods</b>
            <span>{mods}{(state === 'failed' || unread.length > 0) && <> <button type="button" className="su-link" onClick={recheckRisks}>Try again</button></>}</span>
          </div>
          {/* on the row it acts on, like the plugins' Remove (Law of Proximity) */}
          {listed.length > 0 && <span className="su-part-links">
            {/* the list starts folded: the summary and Turn off all are enough most of the time (Progressive Disclosure) */}
            <button type="button" className="su-risk-more" aria-expanded={showList} aria-controls="su-risk-list" onClick={() => setShowList(v => !v)}>
              Show mods <ChevronRight size={14} className="su-caret" aria-hidden="true" />
            </button>
            {on.length > 0 && <button type="button" className="su-link" disabled={Boolean(busy || asking)} onClick={() => void turnOff(on, 'mods')}
              title="Switches them off like the Library does. The toast's Undo turns them back on">
              {busy === 'mods' ? 'Turning off…' : `Turn off all ${on.length}`}</button>}
          </span>}
          {/* the flagged mods nest under their summary, lighter and tighter than a part row, so they read as its items
              and not as more summaries (Common Region, Law of Proximity) */}
          {listed.length > 0 && <div id="su-risk-list" className="t-acc-panel su-risk-fold" data-open={showList} ref={el => el?.toggleAttribute('inert', !showList)}>
          <div className="t-acc-panel-inner"><ul className="su-risk-list" aria-label="Mods marked Ban risk">
            {listed.map(r => {
              const name = shownName(r.path), live = isOnPath(r.path)
              // an off mod needs no "turn it off" advice
              const why = live ? r.reason : r.reason.replace(/ Turn it off before you play online\.$/, '')
              return (
                <li key={r.path} className={`su-risk-mod${live ? ' is-on' : ' is-off'}`}>
                  <div className="su-risk-line">
                    {/* a green dot after the name marks the mods that are on, like the Library's on state */}
                    <span className="su-risk-name" title={name}>{name}{live && <i className="su-risk-on" role="img" aria-label="on" />}</span>
                    {/* the few words, the full reason on hover */}
                    <span className="su-risk-why" title={why}>{r.short}</span>
                    {live && <button type="button" className="su-link su-risk-off" disabled={Boolean(busy || asking)}
                      onClick={() => void turnOff([{ path: r.path, enabled: true }], r.path)} aria-label={`Turn off ${name}`}>
                      {busy === r.path ? 'Turning off…' : 'Turn off'}</button>}
                    {/* an empty cell when off, so the grid's rows stay in step */}
                    {!live && <span className="su-link su-risk-off" aria-hidden="true" style={{ visibility: 'hidden' }}>Turn off</span>}
                  </div>
                </li>
              )
            })}
          </ul></div></div>}
        </li>
        {flagged.map(p => (
          <li key={`${p.place}/${p.name}`} className={`su-part is-${p.kind}`}>
            <ShieldAlert size={16} className="su-risk-icon" aria-hidden="true" />
            <div className="su-part-text">
              <b>{p.name}</b>
              <span>{where(p)} · {KIND[p.kind as 'banned' | 'unknown']}</span>
            </div>
            <span className="su-part-links">
              <button type="button" className="su-link" disabled={Boolean(busy || asking)} onClick={() => setAsking(p)}
                title="Moves it out of the game folder to %APPDATA%\Repak-X\removed-plugins">{busy === p.name ? 'Removing…' : 'Remove'}</button>
            </span>
            {asking === p && <div className="su-confirm su-row-confirm" role="alert">
              <span>Remove {p.name}? It moves to %APPDATA%\Repak-X\removed-plugins{p.kind === 'unknown' ? ', and whatever tool it belongs to stops working' : ''}.</span>
              <button type="button" className="lo-text-btn" autoFocus onClick={() => setAsking(null)}>Cancel</button>
              <button type="button" className="lo-text-btn su-confirm-yes" onClick={() => remove(p)}>Remove</button>
            </div>}
          </li>
        ))}
      </ul>
    </section>
  )
}
