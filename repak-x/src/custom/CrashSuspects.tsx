// repakxtra: crash suspects. The crash toast's "See suspects" opens a small list of the mods that were on and match the
// crash (xtra_crash.rs xtra_crash_tiers): the ones holding the asset that crashed, then the ones changing the same skin,
// then the same hero. When none match, the hero detection the Library uses (multi-hero mods). Checked ones turn off
// together, with Undo.
import { Fragment, type ReactNode, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import Checkbox from '../components/ui/Checkbox'
import { detectHeroesWithData } from '../utils/heroes'
import { useDialogFocus } from './dialogFocus'
import { type KeepDeps, turnOffWithUndo } from './keepOne'
import { nameKey } from './loadoutStore'
import { ModName, plural } from './modName'
import { type Tier, type Tiered, grouped, ordered, prechecked, reasonFor } from './crashTiers'

type Mod = { path: string; enabled?: boolean }
type Details = { character_id?: string | null; character_name?: string | null; files?: string[] }
type Hero = { id: string; name: string }
export type CrashPayload = { crash_type?: string | null; asset_path?: string | null; character_id?: string | null; crash_folder?: string | null }
export type Suspect = { mod: Mod; reason: string; tier: Tier }

const OPEN = 'repakxtra-crash-suspects'
/** Crash folders the startup check reported (crashes from before the app started): their suspects are the mods on now,
 *  since the report does not say which were on then. Checked when See suspects is clicked, so the order in which the
 *  toast and the check's answer arrive does not matter. */
export const previousCrashes = new Set<string>()

/** The crash toast's buttons: upstream's own action, then See suspects. Short labels: they never break inside a word. */
export function withSuspects(details: { label: string; onClick: () => void }, payload: CrashPayload): ReactNode {
  return (
    <span className="cs-toast-actions">
      <button type="button" className="toast-action-btn is-short" onClick={e => { e.stopPropagation(); details.onClick() }}>{details.label}</button>
      <button type="button" className="toast-action-btn is-short" onClick={e => { e.stopPropagation(); window.dispatchEvent(new CustomEvent(OPEN, { detail: { payload, previous: previousCrashes.has(payload.crash_folder ?? '') } })) }}>See suspects</button>
    </span>
  )
}

/** Hero match: the mod's own hero id, or (multi-hero mods) any hero its files name. */
export function heroSuspects(on: Mod[], details: Record<string, Details | undefined>, heroes: Hero[], id: string): Suspect[] {
  const name = heroes.find(h => h.id === id)?.name
  if (!name) return []
  return on.filter(m => {
    const d = details[m.path]
    return d?.character_id === id || (Array.isArray(d?.files) && detectHeroesWithData(d.files, heroes).includes(name))
  }).map(mod => ({ mod, reason: name, tier: 'hero' as const }))
}

/** The suspects, or 'failed' when the check could not run and nothing else matched (never read as "no match"). */
export async function findSuspects(p: CrashPayload, on: Mod[], details: Record<string, Details | undefined>, heroes: Hero[]): Promise<Suspect[] | 'failed'> {
  let failed = false
  if ((p.asset_path || p.character_id) && on.length) {
    const rows = await invoke<Tiered[]>('xtra_crash_tiers', { assetPath: p.asset_path ?? '', heroId: p.character_id ?? null, modPaths: on.map(m => m.path) })
      .catch(() => { failed = true; return [] as Tiered[] })
    const byPath = new Map(on.map(m => [m.path, m]))
    // the hero the backend matched on (the crashed asset's folder wins over the crash's id)
    const heroName = (r: Tiered) => heroes.find(h => h.id === (r.hero ?? p.character_id))?.name
    const found = ordered(rows).flatMap(r => { const mod = byPath.get(r.path); return mod ? [{ mod, tier: r.tier, reason: reasonFor(r.tier, heroName(r), r.other_skin) }] : [] })
    if (found.length) return found
  }
  const hero = p.character_id ? heroSuspects(on, details, heroes, p.character_id) : []
  return hero.length || !failed ? hero : 'failed'
}

const name = nameKey

/** Mounted once in App: opens on See suspects. */
export default function CrashSuspects({ deps, mods, details, heroes }: {
  deps: KeepDeps; mods: Mod[]; details: Record<string, Details | undefined>; heroes: Hero[]
}) {
  const [crash, setCrash] = useState<{ payload: CrashPayload; previous: boolean } | null>(null)
  const [suspects, setSuspects] = useState<Suspect[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [showFile, setShowFile] = useState(false)
  // focus moves into the dialog, Tab stays in it, and it goes back to the toast's button on close
  const { ref, onKeyDown } = useDialogFocus(Boolean(crash))
  useEffect(() => {
    const open = (e: Event) => { setCrash((e as CustomEvent).detail); setSuspects(null); setFailed(false); setShowFile(false) }
    window.addEventListener(OPEN, open)
    return () => window.removeEventListener(OPEN, open)
  }, [])
  useEffect(() => {
    if (!crash) return
    let live = true
    findSuspects(crash.payload, mods.filter(m => m.enabled), details, heroes).then(found => {
      if (!live) return
      const s = found === 'failed' ? [] : found
      setFailed(found === 'failed')
      setSuspects(s)
      setPicked(new Set(prechecked(s).map(x => x.mod.path)))
    })
    return () => { live = false }
  }, [crash])   // once per opening: the list does not reshuffle while it is open
  useEffect(() => {
    if (!crash) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setCrash(null) } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [crash])
  if (!crash) return null
  const close = () => setCrash(null)
  const turnOff = async () => {
    const chosen = (suspects ?? []).filter(s => picked.has(s.mod.path)).map(s => s.mod)
    setBusy(true)
    const done = await turnOffWithUndo(deps, chosen, 'Suspects off', chosen.length === 1 ? `Turned off ${name(chosen[0].path)}.` : `Turned off ${plural(chosen.length, 'mod')}.`)
    setBusy(false)
    if (done) close()
  }
  const p = crash.payload
  return (
    <div className="modal-overlay" onClick={close}>
      <motion.div className="modal-content cs-modal" role="dialog" aria-modal="true" aria-label="Crash suspects" onClick={e => e.stopPropagation()}
        ref={ref} tabIndex={-1} onKeyDown={onKeyDown}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div>
            <h2>Crash suspects</h2>
            {/* the plain words first, the error and the file for whoever wants them, with Copy (Tesler) */}
            <p className="cs-lead">These mods that are on match the crash, closest first.</p>
            {(p.crash_type || p.asset_path) && (
              <details className="cs-file" onToggle={e => setShowFile(e.currentTarget.open)}>
                <summary>Crash details</summary>
                {showFile && <div className="cs-details">
                  {/* the path may break only before a slash, never inside a folder name */}
                  <p className="cs-sub">{p.crash_type && <>{p.crash_type}<br /></>}{(p.asset_path ?? 'The crash report names no asset.').split('/').map((s, i) => <Fragment key={i}>{i > 0 && <><wbr />/</>}{s}</Fragment>)}</p>
                  <button type="button" className="lo-text-btn" onClick={() => void navigator.clipboard.writeText([p.crash_type, p.asset_path].filter(Boolean).join('\n'))}>Copy</button>
                </div>}
              </details>
            )}
          </div>
          <button className="modal-close" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="modal-body cs-body">
          {crash.previous && <p className="cs-note">This crash happened before repakxtra started, and its report does not say which mods were on. These are the mods that are on now.</p>}
          {suspects === null
            ? <p className="cs-empty">Looking through the mods that are on…</p>
            : suspects.length === 0
              ? <p className="cs-empty">{failed ? 'The mods could not be checked just now. Turn mods off a few at a time to find it, or open this again.' : 'No mod matches this crash. Turn mods off a few at a time to find it.'}</p>
              // one group per match strength, closest first: a heading instead of the same reason on every row (common
              // region, chunking), and a word when only hero matches came up (they are the weakest)
              : <>
                  {suspects.every(s => s.tier === 'hero') && <p className="cs-note">Only hero matches came up. These mods change the hero the crash names, which makes them less likely the cause.</p>}
                  {grouped(suspects).map(g => (
                    <section key={g.title} className="cs-group" aria-label={g.title}>
                      <h3 className="cs-group-title">{g.title}</h3>
                      <ul className="cs-list">{g.rows.map(s => (
                        <li key={s.mod.path}>
                          <Checkbox size="sm" checked={picked.has(s.mod.path)} onChange={(v: boolean) => setPicked(prev => {
                            const next = new Set(prev)
                            if (v) next.add(s.mod.path); else next.delete(s.mod.path)
                            return next
                          })}>
                            <span className="cs-name"><ModName name={name(s.mod.path)} /></span>
                          </Checkbox>
                        </li>
                      ))}</ul>
                    </section>
                  ))}
                </>}
        </div>
        <div className="modal-footer cs-footer">
          {/* the reassurance at the risky click: it can be undone, and the button says how many */}
          {Boolean(suspects?.length) && <span className="cs-undo">You can undo this from the notice that follows.</span>}
          <button type="button" className="lo-text-btn" onClick={close}>{suspects?.length ? 'Cancel' : 'Close'}</button>
          {Boolean(suspects?.length) && (
            <button type="button" className="btn-primary" disabled={busy || picked.size === 0} onClick={turnOff}>
              {busy ? 'Turning off…' : picked.size ? `Turn off ${plural(picked.size, 'mod')}` : 'Turn off'}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  )
}

if (import.meta.env.DEV) {
  const heroes = [{ id: '1026', name: 'Black Panther' }, { id: '1011', name: 'Hulk' }]
  const on = [{ path: 'a.pak', enabled: true }, { path: 'b.pak', enabled: true }, { path: 'c.pak', enabled: true }]
  const details = {
    'a.pak': { character_id: '1026' },
    'b.pak': { character_id: '', files: ['Marvel/Content/Marvel/Characters/1026/1026001/Meshes/SK_1026_1026001.uasset', 'Marvel/Content/Marvel/Characters/1011/1011001/Meshes/SK_1011.uasset'] },
    'c.pak': { character_id: '1011' },
  }
  const s = heroSuspects(on, details, heroes, '1026')
  console.assert(s.map(x => x.mod.path).join() === 'a.pak,b.pak' && s[0].reason === 'Black Panther', 'hero suspects: own id and multi-hero files', s)
  console.assert(heroSuspects(on, details, heroes, '9999').length === 0, 'an unknown hero id names no suspects')
}
