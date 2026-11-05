// repakxtra: the ban risk check (backend: xtra_safety.rs). Marvel Rivals' anti-cheat notice names .asi files that trip
// the anti-cheat and mod kinds that give an edge. Mods get a Ban risk or Check rules badge with the reason, the Library
// gains a Ban risk tab while any are flagged, and Setup lists the plugins beside the game exe with Remove for the named
// ones. Nothing is turned off by itself: the player decides.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ShieldAlert } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'

type Alert = ReturnType<typeof useAlert>
export type Risk = { path: string; level: 'ban' | 'check'; reason: string }
type Plugin = { name: string; place: string; kind: 'banned' | 'unknown' | 'bundled' }

export const NOTICE = 'Marvel Rivals says mods that remove recoil, screen shake, or hit effects, change footsteps, change maps so players see differently, or enlarge enemies can get an account banned.'

const norm = (path: string) => path.replace(/\//g, '\\').toLowerCase().replace(/\.(pak|bak_repak)$/, '')
let risks = new Map<string, Risk>()
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const getRisks = () => risks

export const riskOf = (path: string) => risks.get(norm(path))
export const useRisk = (path: string) => useSyncExternalStore(subscribe, () => risks.get(norm(path)))
export const useRisks = () => useSyncExternalStore(subscribe, getRisks)

/** Checks again a moment after mods are added, removed, or replaced (names only, so it is quick once details are cached). */
export function useSafetyWatch(mods: { path: string; modified_date?: number; file_size?: number }[]) {
  const key = mods.map(m => `${norm(m.path)}|${m.modified_date ?? ''}|${m.file_size ?? ''}`).sort().join('\n')
  useEffect(() => {
    if (!key) return
    let live = true
    const t = setTimeout(() => {
      invoke<Risk[]>('xtra_safety_mods', { modPaths: mods.map(m => m.path) })
        .then(r => { if (live) { risks = new Map(r.map(x => [norm(x.path), x])); listeners.forEach(l => l()) } })
        .catch(e => console.warn('[safety] mod check failed', e))
    }, 1500)
    return () => { live = false; clearTimeout(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function RiskBadge({ risk }: { risk: Risk }) {
  return <span className={`mod-type-badge risk-badge is-${risk.level}`} title={`${risk.reason}\n\n${NOTICE}`}>{risk.level === 'ban' ? 'Ban risk' : 'Check rules'}</span>
}

let toldAtStart = false
/** At start: a named plugin beside the game exe gets a toast that opens Setup (once per app start). */
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

const KIND: Record<Plugin['kind'], string> = {
  banned: 'Named by Marvel Rivals as an anti-cheat trigger. Remove it',
  unknown: 'Not from repakxtra. Loads code into the game, so make sure you trust it',
  bundled: 'The signature bypass from Setup. It patches the game in memory, is needed to load mods, and is not named in the notice',
}

/** Setup's Ban risk card: the plugins beside the game exe, and how many mods carry a badge. */
export function SafetyCard({ alert }: { alert: Alert }) {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const all = useRisks()
  const ban = [...all.values()].filter(r => r.level === 'ban').length, check = all.size - ban
  useEffect(() => { invoke<Plugin[]>('xtra_safety_plugins').then(setPlugins).catch(() => setPlugins([])) }, [])
  const remove = (p: Plugin) => {
    setBusy(p.name)
    invoke<Plugin[]>('xtra_safety_remove_plugin', { name: p.name, place: p.place })
      .then(ps => { setPlugins(ps); alert.success('Removed', `${p.name} was moved to %APPDATA%\\Repak-X\\removed-plugins.`); window.dispatchEvent(new Event('bypass-changed')) })
      .catch(e => alert.warning('Ban risk', String(e))).finally(() => setBusy(null))
  }
  const banned = plugins?.some(p => p.kind === 'banned')
  return (
    <section className="su-card su-safety-card">
      <div className="su-card-head">
        <div>
          <h3>Ban risk</h3>
          <p>{NOTICE} Plugins that inject into the game trip its anti-cheat.</p>
        </div>
        <span className={`su-chip ${banned ? 'is-danger' : 'is-installed'}`}>{!plugins ? 'Checking…' : banned ? 'Remove flagged files' : 'Nothing named found'}</span>
      </div>
      {plugins && plugins.length > 0 && <ul className="su-parts">
        {plugins.map(p => (
          <li key={`${p.place}/${p.name}`} className={`su-part is-${p.kind}`}>
            <ShieldAlert size={16} className="su-risk-icon" aria-hidden="true" />
            <div className="su-part-text">
              <b>{p.name}</b>
              <span>{p.place ? `Win64\\${p.place}` : 'Win64'} · {KIND[p.kind]}</span>
            </div>
            {p.kind !== 'bundled' && <span className="su-part-links">
              <button type="button" className="su-link" disabled={Boolean(busy)} onClick={() => remove(p)}
                title="Moves it out of the game folder to %APPDATA%\Repak-X\removed-plugins">{busy === p.name ? 'Removing…' : 'Remove'}</button>
            </span>}
          </li>
        ))}
      </ul>}
      <p className="su-note">{ban + check === 0 ? 'No installed mod matches what the notice describes.'
        : `${ban} mod${ban === 1 ? '' : 's'} marked Ban risk and ${check} marked Check rules. The Library's Ban risk tab lists them, hover a badge for why.`}
        {' '}The check reads file names only, so it can miss a mod or flag a plain recolor.</p>
    </section>
  )
}
