// repakxtra: the ban risk check (backend: xtra_safety.rs). Marvel Rivals' anti-cheat notice names two .asi files
// that trip the anti-cheat and mod kinds that give an edge. Mods get a Ban risk or Check rules badge, a button that
// opens Why isn't it working? with the reason and a Turn off, and the Library gains a Ban risk tab while any are
// flagged. Setup lists the plugins beside the game exe with Remove for the flagged ones. Nothing is turned off by
// itself: the player decides.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { openWhy } from './WhyNotWorking'

type Alert = ReturnType<typeof useAlert>
export type Risk = { path: string; level: 'ban' | 'check'; reason: string }
type Plugin = { name: string; place: string; kind: 'banned' | 'unknown' | 'bundled' }

export const NOTICE = 'Marvel Rivals says mods that remove recoil, screen shake, or hit effects, change footsteps, change maps so players see differently, or enlarge enemies can get an account banned.'
export const RISK_TAB_TITLE = 'Mods marked Ban risk (they match what Marvel Rivals bans) or Check rules (they might). Click a badge for why and to turn it off'

const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')
/** `state`: null before the first check finishes, 'failed' when it could not run, else 'done'. */
let store: { risks: Map<string, Risk>; state: null | 'done' | 'failed' } = { risks: new Map(), state: null }
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const set = (next: typeof store) => { store = next; listeners.forEach(l => l()) }

export const riskOf = (path: string) => store.risks.get(norm(path))
export const useRisk = (path: string) => useSyncExternalStore(subscribe, () => store.risks.get(norm(path)))
export const useRisks = () => useSyncExternalStore(subscribe, () => store.risks)
const useRiskState = () => useSyncExternalStore(subscribe, () => store.state)

/** Checks again a moment after mods are added, removed, or replaced (names only, so it is quick once details are cached). */
export function useSafetyWatch(mods: { path: string; modified_date?: number; file_size?: number }[]) {
  const key = mods.map(m => `${norm(m.path)}|${m.modified_date ?? ''}|${m.file_size ?? ''}`).sort().join('\n')
  useEffect(() => {
    if (!key) return
    let live = true
    const t = setTimeout(() => {
      invoke<Risk[]>('xtra_safety_mods', { modPaths: mods.map(m => m.path) })
        .then(r => { if (live) set({ risks: new Map(r.map(x => [norm(x.path), x])), state: 'done' }) })
        // the badges so far stay, and Setup says the check failed instead of reading clean
        .catch(e => { console.warn('[safety] mod check failed', e); if (live) set({ ...store, state: 'failed' }) })
    }, 1500)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** A button, so the keyboard reaches it and a screen reader says why: it opens Why isn't it working? for the mod. */
export function RiskBadge({ path, risk, name }: { path: string; risk: Risk; name?: string }) {
  const label = risk.level === 'ban' ? 'Ban risk' : 'Check rules'
  return (
    <button type="button" className={`mod-type-badge risk-badge is-${risk.level}`} title={`${risk.reason} Click for what to do.`}
      aria-label={`${label}: ${risk.reason}`} onClick={e => { e.stopPropagation(); openWhy(path, name) }}>{label}</button>
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
  const all = useRisks(), state = useRiskState()
  const ban = [...all.values()].filter(r => r.level === 'ban').length, check = all.size - ban
  const load = () => invoke<Plugin[]>('xtra_safety_plugins').then(p => { setPlugins(p); setFailed(null) }).catch(e => setFailed(String(e)))
  useEffect(() => { void load() }, [])
  const remove = (p: Plugin) => {
    setAsking(null); setBusy(p.name)
    invoke<Plugin[]>('xtra_safety_remove_plugin', { name: p.name, place: p.place })
      .then(ps => { setPlugins(ps); alert.success('Removed', `${p.name} was moved to %APPDATA%\\Repak-X\\removed-plugins. Move it back by hand to undo.`); window.dispatchEvent(new Event('bypass-changed')) })
      .catch(e => alert.warning(`Could not remove ${p.name}`, String(e))).finally(() => setBusy(null))
  }
  const flagged = (plugins ?? []).filter(p => p.kind !== 'bundled')
  const bundled = (plugins ?? []).filter(p => p.kind === 'bundled')
  const banned = flagged.some(p => p.kind === 'banned')
  const chip = failed ? 'Could not check' : !plugins ? 'Checking…' : banned ? 'Remove flagged files' : flagged.length ? 'Unknown plugins' : 'No flagged plugins'
  const mods = state === null ? 'Checking your mods…'
    : state === 'failed' && !all.size ? 'Your mods could not be checked. Scan the Library to try again.'
    : ban + check === 0 ? 'No installed mod matches what the notice describes.'
    : `${ban} mod${ban === 1 ? '' : 's'} marked Ban risk${check ? ` and ${check} marked Check rules` : ''}. The Library's Ban risk tab lists them.`
  return (
    <section className="su-card su-safety-card">
      <div className="su-card-head">
        <div>
          <h3>Ban risk</h3>
          <p>{NOTICE} The notice also names two plugins that trip the anti-cheat.</p>
        </div>
        <span className={`su-chip ${banned ? 'is-danger' : flagged.length ? 'is-warn' : 'is-installed'}`}>{chip}</span>
      </div>
      {failed && <p className="su-note">Could not read the game folder. {failed} <button type="button" className="su-link" onClick={() => void load()}>Try again</button></p>}
      {plugins && (flagged.length > 0 || bundled.length > 0) && <ul className="su-parts">
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
        {/* the bypass is one thing in two files: one calm row, not two alerts (group instead of repeating) */}
        {bundled.length > 0 && <li className="su-part is-bundled">
          <ShieldCheck size={16} className="su-risk-icon" aria-hidden="true" />
          <div className="su-part-text">
            <b>Signature bypass from Setup</b>
            <span>{bundled.map(p => p.name).join(' and ')}. Mods need it to load. It patches the game in memory, and the notice does not name it.</span>
          </div>
        </li>}
      </ul>}
      <p className="su-note">{mods} This check reads file names, so it can miss a mod or flag a plain recolor.</p>
    </section>
  )
}
