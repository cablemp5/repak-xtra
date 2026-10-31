import { LOADER_NAME } from './edition'
// repakxtra: the Getting started checklist at the top of Loadouts home, once the first-launch flow (FirstRun.tsx) has
// run. Each row reads what the app already knows (the game folder, the bypass and the loader, mods, loadouts, previews)
// plus small flags under repakxtra.gettingStarted: a loadout once switched on stays ticked, and the Launch button
// marks launched (App.tsx). "N of 7", Dismiss, and it leaves by itself when the core rows are done. The first loadout
// switched on also brings a small celebration and cable's note (founderNote.ts), once.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { Check, PartyPopper, X } from 'lucide-react'
import type { LoadoutProps } from './Loadouts'
import { type Mod, isActive, loadoutable, modKey, openLoadout, readLoadouts, setView, useLoadouts } from './loadoutStore'
import { hasModsRoot } from './loadoutIdentity'
import { isBuiltin } from './builtinRows'
import { openPreviewSetup, usePreviewsAvailable } from './previews'
import { cue } from './sounds'
import { FOUNDER_DISCORD, FOUNDER_NOTE } from './founderNote'
import './onboarding.css'

/** Set once the first-launch flow was finished or closed; Setup > Guided setup opens it again. */
export const ONBOARDED = 'repakxtra.onboarded2'
const KEY = 'repakxtra.gettingStarted'
type Flags = { on?: 1; launched?: 1; dismissed?: 1; noted?: 1 }
const listeners = new Set<() => void>()
const read = (): Flags => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }
const flag = (k: keyof Flags) => {
  if (read()[k]) return
  localStorage.setItem(KEY, JSON.stringify({ ...read(), [k]: 1 }))
  listeners.forEach(l => l())
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const useFlags = (): Flags => JSON.parse(useSyncExternalStore(subscribe, () => localStorage.getItem(KEY) || '{}'))
/** The flow finished or closed (FirstRun.tsx): the celebration waits for it, so it is never spent behind the flow. */
export const markOnboarded = () => { localStorage.setItem(ONBOARDED, '1'); listeners.forEach(l => l()) }
const useOnboarded = () => useSyncExternalStore(subscribe, () => Boolean(localStorage.getItem(ONBOARDED)))
/** The Launch button pressed (App.tsx): the checklist's last row. */
export const markLaunched = () => flag('launched') // shortcut: any Launch press counts, not only one with a loadout on, upgrade if the row misleads
/** Mods a person installed: not the loader pak, not the built-ins. */
export const realMods = (mods: Mod[]) => mods.filter(m => loadoutable(modKey(m.path)) && !isBuiltin(m.path))
const openSetup = () => window.dispatchEvent(new Event('repakxtra-open-setup'))
const openSmart = () => window.dispatchEvent(new Event('repakxtra-smart-loadouts'))
/** The last two steps, done from the checklist: the first loadout's switch, pointed at on Loadouts home (it pulses
 *  until it is pressed or a few seconds pass), and the header's own Launch button. */
const pointAtSwitch = () => {
  openLoadout(null); setView('home')
  const until = performance.now() + 1500 // the view slides in: look for the switch for a moment
  const find = () => {
    // a switch that can turn on (an empty loadout's is disabled), else any
    const sw = document.querySelector<HTMLElement>('[data-loadout] .repakx-switch-control:not(:disabled)') ?? document.querySelector<HTMLElement>('[data-loadout] .repakx-switch-control')
    if (!sw) { if (performance.now() < until) requestAnimationFrame(find); return }
    const card = sw.closest<HTMLElement>('[data-loadout]')!
    card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    card.classList.add('gs-point')
    sw.focus({ preventScroll: true })
    setTimeout(() => card.classList.remove('gs-point'), 4000)
  }
  requestAnimationFrame(find)
}
const launch = () => document.querySelector<HTMLButtonElement>('[data-tour="launch-btn"]')?.click()
const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))

// Someone with loadouts from before this version has had the first-loadout moment: no celebration for them
if (!localStorage.getItem(ONBOARDED) && readLoadouts().length) flag('noted')

export default function GettingStarted({ p }: { p: LoadoutProps }) {
  const flags = useFlags()
  const loadouts = useLoadouts()
  const previews = usePreviewsAvailable()
  const [bypass, setBypass] = useState(false)
  const [loader, setLoader] = useState(false)
  const onboarded = useOnboarded()
  const mods = realMods(p.mods)
  const anyOn = loadouts.some(l => isActive(l, p.mods))
  useEffect(() => { // the bypass and the loader: re-read after an install (the mod list changed) or when Setup says so
    const check = () => {
      invoke<{ state: string }>('setup_bypass_status').then(b => setBypass(b.state === 'installed' || b.state === 'other')).catch(() => undefined) // another bypass is left alone by setup, so it counts
      invoke<{ installed: string | null; disabled: boolean }>('setup_galacta_status', { online: false }).then(g => setLoader(Boolean(g.installed && !g.disabled))).catch(() => undefined)
    }
    check()
    window.addEventListener('bypass-changed', check)
    return () => window.removeEventListener('bypass-changed', check)
  }, [p.mods.length])
  useEffect(() => { if (anyOn) flag('on') }, [anyOn])
  // Shown until its close button: leaving Loadouts home (Smart loadouts, a loadout page) brings it back, never loses it
  const party = Boolean(flags.on) && !flags.noted && onboarded
  useEffect(() => { if (party) cue('ready') }, [party])

  const rows: { label: string; done: boolean; hint?: string; optional?: boolean; action?: [string, () => void] }[] = [
    { label: 'Game found', done: hasModsRoot(), action: ['Open Setup', openSetup] },
    { label: 'Mods can load', hint: `the signature bypass and ${LOADER_NAME}`, done: bypass && loader, action: ['Open Setup', openSetup] },
    { label: 'First mod installed', done: mods.length > 0, action: ['Open the Library', () => setView('library')] },
    { label: 'First loadout made', done: loadouts.length > 0, action: mods.length ? ['Group my mods into loadouts', openSmart] : undefined },
    { label: 'A loadout switched on', done: Boolean(flags.on) || anyOn, action: loadouts.length ? ['Show me the switch', pointAtSwitch] : undefined },
    { label: 'Previews set up', optional: true, done: previews, action: ['Set up previews', openPreviewSetup] },
    { label: 'Launched the game with mods', done: Boolean(flags.launched), action: ['Launch', launch] },
  ]
  const done = rows.filter(r => r.done).length
  const show = !flags.dismissed && rows.some(r => !r.done && !r.optional) // Dismiss is for good
  const next = rows.find(r => !r.done) // one action at a time (Goal-gradient: the next step, not seven buttons)
  if (!show && !party) return null
  return (
    <>
      {party && (
        <motion.div className="gs-party" role="status" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.25 }}>
          <div className="gs-party-head">
            <PartyPopper size={16} aria-hidden="true" /><b>Your first loadout is on.</b><span>Launch the game to see it.</span>
            <button type="button" className="lo-icon" aria-label="Close" onClick={() => flag('noted')}><X size={14} /></button>
          </div>
          <blockquote className="gs-note">
            <p>{FOUNDER_NOTE}</p>
            <footer>cable <button type="button" className="su-link" onClick={() => openUrl(FOUNDER_DISCORD)}>Join the Discord</button></footer>
          </blockquote>
        </motion.div>
      )}
      {show && (
        <section className="gs-card" aria-label="Getting started">
          <header>
            <h3>Getting started</h3><span className="gs-count">{done} of {rows.length}</span>
            <button type="button" className="lo-text-btn" onClick={() => flag('dismissed')}>Dismiss</button>
          </header>
          <ol>
            {rows.map(r => (
              <li key={r.label} className={r.done ? 'is-done' : ''}>
                <span className="gs-mark" aria-hidden="true">{r.done && <Check size={12} strokeWidth={3} />}</span>
                <span className="gs-label">{r.label}{r.optional && <span className="fr-optional">Optional</span>}</span>
                {!r.done && r.hint && <small>{r.hint}</small>}
                {r === next && r.action && <button type="button" className="lo-text-btn" onClick={r.action[1]}>{r.action[0]}</button>}
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  )
}

if (import.meta.env.DEV) {
  const mods = [{ path: 'C:/G/~mods/skin_9999999_P.pak' }, { path: 'C:/G/~mods/!ProjectGalacta_9999999_P.pak' }, { path: 'C:/G/~mods/.repakxtra-builtin/repakxtra-skip-intro-movies_9999999_P.pak' }]
  console.assert(realMods(mods).length === 1 && realMods(mods)[0].path.includes('skin'), 'realMods leaves out the loader and the built-ins')
}
