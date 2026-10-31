import { LOADER_NAME, LOADER_PAK, APP_NAME } from './edition'
// repakxtra: the first-launch flow, one page at a time, shown once per user (repakxtra.onboarded2) and again from
// Setup > Guided setup. PAGES is the one ordered list: what loadouts are (WelcomeIntro.tsx), "Got mods already?"
// (always asked, the mods already installed named in it), then either the guided steps (game, bypass, loader) and the first mod, or a
// background setup that installs only what is missing, then the first loadout, then Make it yours (previews, Discord,
// the shortcut, sounds). Finish lands on Loadouts home, where the Getting started checklist (GettingStarted.tsx) picks
// up whatever was skipped. Mods dropped on the window hide the flow for the install, and it comes back after.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as pick } from '@tauri-apps/plugin-dialog'
import { motion } from 'framer-motion'
import { ArrowRight, Check, ChevronDown, CopyPlus, ExternalLink, FileArchive, FileCode, FolderOpen, LoaderCircle, Package, Plus, ShieldCheck, Upload, Volume2, VolumeX } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import Switch from '../components/ui/Switch'
import { DoctorProblems } from './SetupPanel'
import { BypassTrack, GalactaTrack, InstallTrack, KitTrack, useFinished } from './installTrack'
import { isKitZip, usePreviewKit } from './previewKit'
import { OFF_EXT } from './offFiles'
import WelcomeIntro, { MiniCard } from './WelcomeIntro'
import catboy from './covers/welcome/catboy.webp'
import ultimate from './covers/welcome/ultimate.webp'
import godspeed from './covers/welcome/godspeed.webp'
import jiraSnow from './covers/welcome/jira-snow.webp'
import esuBlack from './covers/welcome/esu-black.webp'
import silhouette from './covers/silhouettes/1011.webp'
import { ShortcutButton, useShortcut } from './shortcut'
import { ownsTop, useDialogFocus } from './dialogFocus'
import { createFromMods } from './Loadouts'
import { type Mod, modKey, openLoadout, setView, useLoadouts } from './loadoutStore'
import { plural } from './modName'
import { SOUND_PACKS, type SoundName, cue, tryCue } from './sounds'
import { setSoundChoice, useSoundChoice } from './uiPrefs'
import { ONBOARDED, markOnboarded, realMods } from './GettingStarted'
import './onboarding.css'

type Alert = ReturnType<typeof useAlert>
type Bypass = { state: 'installed' | 'disabled' | 'partial' | 'other' | 'missing' }
type Galacta = { installed: string | null; disabled: boolean }
type Pending = 'smart' | 'empty' | string | null // what Finish opens on Loadouts home, picked on the first loadout page (a string: that loadout's id)
type Auto = 'checking' | 'game-open' | 'no-game' | 'working' | 'failed' | 'done'

const NEXUS = 'https://www.nexusmods.com/marvelrivals/mods'
const openUrl = (url: string) => import('@tauri-apps/plugin-shell').then(m => m.open(url)).catch(() => window.open(url, '_blank'))
const firstLaunch = () => !localStorage.getItem(ONBOARDED)

/** Everything a page reads and does: the flow's state lives in FirstRun, so Back and Next keep it. */
export type Flow = {
  alert: Alert; gamePath: string; hasMods: boolean; installedCount: number; newMods: string[]; made?: { id: string; name: string } // the loadout the install saved them as
  busy: string | null; finished: string | null; bypass: Bypass | null; bypassError: string | null; galacta: Galacta | null
  auto: Auto; setAuto: (a: Auto) => void
  checkStatus: () => void; run: (what: string, f: () => Promise<void>) => Promise<void>
  installBypass: () => void; installGalacta: () => void; setUpAll: () => Promise<void>; setUpMissing: () => Promise<string[] | null>
  onAutoDetect: () => Promise<void>; onBrowse: () => Promise<void>; addFiles: () => void
  kit: ReturnType<typeof usePreviewKit>; shortcut: ReturnType<typeof useShortcut>
  enableDrp: boolean; onSetDrp: (on: boolean) => void
  finish: (p?: Pending) => void
  answer: (yes: boolean) => void; next: () => void; back: () => void; close: () => void
}
/** Which pages apply: guided (no mods on hand, or "Not yet") or the background setup, and whether mods are installed. */
export type Branch = { guided: boolean; hasMods: boolean }
/** A page: `when` leaves it out of the sequence, a `choice` page moves on by a pick (its footer offers Skip, not Next). */
export type Page = { id: string; title: string; sub?: (f: Flow) => React.ReactNode | undefined; choice?: boolean; when?: (b: Branch) => boolean; body: (f: Flow) => React.ReactNode }
/** The ids of the pages that apply, in order. Pure. */
export const sequence = (pages: Page[], b: Branch) => pages.filter(p => !p.when || p.when(b)).map(p => p.id)

/** One numbered step (or an icon's row): its number (a check once done), title, text and its action on the right. */
export function Step({ n, icon, done, title, optional, children, action }: {
  n?: number; icon?: React.ReactNode; done: boolean; title: string; optional?: boolean; children: React.ReactNode; action?: React.ReactNode
}) {
  return (
    <li className={`fr-step${done ? ' is-done' : ''}${icon ? ' is-icon' : ''}`}>
      <span className="fr-num" aria-hidden="true">{done ? <Check size={14} strokeWidth={2.75} /> : icon ?? n}</span>
      <div className="fr-text">
        <h3>{title}{optional && <span className="fr-optional">Optional</span>}</h3>
        {children}
      </div>
      {action && <div className="fr-action">{action}</div>}
    </li>
  )
}

/** A pick with a picture on top, like the welcome page's demos (Jakob: it reads like the loadout cards it leads to). */
function Choice({ stage, title, text, suggested, onClick }: { stage: React.ReactNode; title: string; text: string; suggested?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`ob-choice${suggested ? ' is-suggested' : ''}`} onClick={onClick}>
      <span className="wi-stage ob-stage" aria-hidden="true">{stage}</span>
      <span className="ob-choice-text"><b>{title}</b><span>{text}</span></span>
    </button>
  )
}
const SHOTS: [string, string][] = [['Jira Snow', jiraSnow], ['Godspeed', godspeed], ['ESU Black', esuBlack]]
/** Three loadout cards fanned out, Godspeed in front: mods that became loadouts. */
const Fan = () => <span className="ob-fan">{SHOTS.map(([name, src]) => <MiniCard key={name} name={name} src={src} />)}</span>

type Row = 'done' | 'busy' | 'todo' | 'kept' | 'off'
/** The game folder in miniature, each file lit as it goes in: what setup actually changes, shown, not described. */
function Folder({ f }: { f: Flow }) {
  const b = f.bypass?.state
  const rows: [string, string, Row][] = [
    ['Marvel Rivals', f.gamePath ? 'Found' : 'Not found yet', f.busy === 'find' ? 'busy' : f.gamePath ? 'done' : 'todo'],
    ['dsound.dll', b === 'other' ? 'Your own bypass, kept' : 'The signature bypass, next to the game', f.busy === 'bypass' ? 'busy' : b === 'installed' ? 'done' : b === 'other' ? 'kept' : 'todo'],
    [LOADER_PAK, `${LOADER_NAME}, in ~mods`, f.busy === 'galacta' ? 'busy' : !f.galacta?.installed ? 'todo' : f.galacta.disabled ? 'off' : 'done'],
  ]
  // Option 1, Windows Explorer's navigation pane (cable's pick, 2026-10-31): typed icons, a bar on the row going in
  const row = ([name, note, state]: [string, string, Row], i: number) => (
    <li key={name} className={`is-${state}`} style={{ '--d': i } as React.CSSProperties}>
      {i ? (i === 1 ? <FileCode size={15} className="ob-dll" /> : <Package size={15} className="ob-pak" />)
        : <><ChevronDown size={14} className="ob-caret" /><FolderOpen size={15} className="ob-dir" /></>}
      <span title={name}><b>{name}</b>{i > 0 && <small>{state === 'busy' ? 'Installing' : state === 'off' ? 'Switched off' : note}</small>}</span>
      <i className="ob-end">{state === 'busy' ? <LoaderCircle size={13} className="ob-spin" /> : (state === 'done' || state === 'kept') && <Check size={14} strokeWidth={2.75} />}</i>
    </li>
  )
  return (
    <ul className="ob-tree" aria-hidden="true">
      {row(rows[0], 0)}
      <li className="ob-tree-kids"><ul>{rows.slice(1).map((r, i) => row(r, i + 1))}</ul></li>
    </ul>
  )
}

/** Step 1 of the guided setup, also the fallback when the background setup cannot find the game. */
const findGame = (f: Flow) => {
  const where = '…\\' + f.gamePath.split(/[\\/]/).filter(Boolean).slice(-2).join('\\') // the last two folders, the whole path in its tooltip
  return (
    <Step n={1} done={Boolean(f.gamePath)} title="Find the game"
      action={!f.gamePath && <>
        <button type="button" className="btn-primary" disabled={Boolean(f.busy)} onClick={() => f.run('find', f.onAutoDetect)}>{f.busy === 'find' ? 'Looking…' : 'Find it'}</button>
        <button type="button" className="lo-text-btn" onClick={() => f.onBrowse()}>Browse…</button></>}>
      <p>{!f.gamePath ? 'Not found yet. Find it searches your Steam libraries.' : <>Found. Mods go to <code title={f.gamePath}>{where}</code></>}</p>
    </Step>
  )
}

const welcome: Page = { id: 'welcome', title: 'Welcome', body: () => null } // drawn by WelcomeIntro, below

const ask: Page = {
  id: 'ask', title: 'Got mods already?', choice: true,
  sub: f => f.hasMods ? `Your game folder already has ${plural(f.installedCount, 'mod')}.` : undefined,
  body: f => (
    <div className="ob-choices">
      <Choice suggested={f.hasMods} onClick={() => f.answer(true)} stage={<Fan />}
        title="Yes, I have mods" text="Setup runs by itself, then your mods become loadouts." />
      <Choice onClick={() => f.answer(false)} title="Not yet" text="Three short steps get mods working, then your first mod and loadout."
        stage={<span className="ob-fan ob-ghosts"><i /><i><Plus size={22} /></i><i /></span>} />
    </div>
  ),
}

const setup: Page = {
  id: 'setup', title: 'Get mods working', when: b => b.guided,
  sub: f => {
    const n = [f.gamePath, f.bypass?.state === 'installed', f.galacta?.installed && !f.galacta.disabled].filter(Boolean).length
    return n === 3 ? 'Mods are ready to go.' : <>Three steps, <b className="fr-progress">{n} of 3 done</b>. Close the game first.</>
  },
  body: f => {
    const noGame = !f.gamePath
    const bypassOn = f.bypass?.state === 'installed'
    const galactaOn = Boolean(f.galacta?.installed && !f.galacta.disabled)
    const all = Boolean(f.gamePath && bypassOn && galactaOn)
    const bypassText = bypassOn ? 'Installed. Mods load from the next game launch.'
      : f.bypass?.state === 'disabled' ? 'Installed but turned off. Mods that need it will not load.'
      : f.bypass?.state === 'other' ? 'A different loader or bypass is installed. Installing keeps it next to the new one as a .repakxtra-backup file.'
      : f.bypass?.state === 'partial' ? 'Part of it is missing. Repair puts the missing files back.'
      : 'Lets the game load mods. Every mod needs it, and Setup shows why it is safe.'
    return (
      <div className="ob-split">
        <div className="ob-col">
          <ol className="fr-steps">
            {findGame(f)}
            <Step n={2} done={bypassOn} title="Install the signature bypass"
              action={f.bypassError
                ? <button type="button" className="lo-text-btn" onClick={f.checkStatus}>Retry</button>
                : !bypassOn && <button type="button" className="lo-text-btn" disabled={noGame || !f.bypass || Boolean(f.busy)} onClick={f.installBypass}
                    title={noGame ? 'Find the game first' : undefined}>
                    {f.busy === 'bypass' ? 'Installing…' : f.bypass?.state === 'disabled' ? 'Turn on' : f.bypass?.state === 'partial' ? 'Repair' : 'Install'}</button>}>
              <p>{f.bypassError ? `Could not check it: ${f.bypassError}` : bypassText}</p>
              <BypassTrack on={f.busy === 'bypass'} done={f.finished === 'bypass' ? 'Installed. Mods load from the next game launch.' : undefined} />
            </Step>
            <Step n={3} done={galactaOn} title={`Install ${LOADER_NAME}`}
              action={!f.galacta?.installed && <button type="button" className="lo-text-btn" disabled={noGame || Boolean(f.busy)} onClick={f.installGalacta}
                title={noGame ? 'Find the game first' : 'Downloads the newest release from GitHub'}>{f.busy === 'galacta' ? 'Installing…' : 'Install'}</button>}>
              <p>{f.galacta?.installed && !galactaOn ? 'Installed but switched off. Turn it on in the Library.' : galactaOn ? 'Installed.' : 'Most skin mods need it. It also lets you switch mods in game.'}</p>
              <GalactaTrack on={f.busy === 'galacta'} done={f.finished === 'galacta' ? `${LOADER_NAME} is in your mods folder` : undefined} />
            </Step>
          </ol>
          {/* One click for the three steps, in order, each showing its own progress (cable, 2026-10-21: as frictionless as possible) */}
          {!all && <button type="button" className="btn-primary ob-all" disabled={Boolean(f.busy) || (f.bypass === null && !f.bypassError)} onClick={f.setUpAll}
            title={`Finds the game, installs the signature bypass and ${LOADER_NAME}, one after another`}>{f.busy ? 'Setting up…' : 'Set up all three'}</button>}
        </div>
        <Folder f={f} />
      </div>
    )
  },
}

/** The "yes" path: what is missing goes in by itself with its progress, unless the game is open (wait) or not found
 *  (Find it and Browse). Another loader or bypass (state other) is left alone. */
function AutoSetup({ f }: { f: Flow }) {
  const { auto: state, setAuto: setState } = f // in FirstRun: the footer's Next waits for it
  const [did, setDid] = useState<string[]>([])
  const [again, setAgain] = useState(0) // Check again, once the game is closed
  const looked = useRef(false) // one search for the game, then the Find it and Browse buttons
  // `live`: only the newest run acts (Strict Mode's first mount, or the run from before the game was found, stops
  // at its next check), so the installs run once
  useEffect(() => {
    let live = true
    ;(async () => {
      const running = await invoke<boolean>('check_game_running').catch(() => false)
      if (!live) return
      if (running) { setState('game-open'); return }
      if (!f.gamePath) {
        if (!looked.current) { looked.current = true; await f.onAutoDetect().catch(() => undefined) } // found: gamePath changes and this runs again
        if (live) setState('no-game')
        return
      }
      setState('working')
      const done = await f.setUpMissing()
      if (!live) return
      if (!done) { setState('failed'); return } // the warning says why: Retry, never a check mark
      setDid(done)
      setState('done')
      if (done.length) cue('success')
    })()
    return () => { live = false }
  }, [f.gamePath, again])
  const other = f.bypass?.state === 'other' ? ' Your own bypass was left as it is.' : ''
  // switched off in the Library on purpose, so it stays off: said, never called set up
  const off = f.galacta?.installed && f.galacta.disabled ? ` ${LOADER_NAME} is switched off. Turn it on in the Library.` : ''
  const status = state === 'checking' ? <InstallTrack text="Checking the game and what is installed" share={null} />
    : state === 'game-open' ? <>
        <p>Marvel Rivals is open. Close it first, setup changes files the game holds.</p>
        <button type="button" className="btn-primary" onClick={() => setAgain(a => a + 1)}>Check again</button></>
    : state === 'no-game' ? <ol className="fr-steps">{findGame(f)}</ol>
    : state === 'failed' ? <>
        <p>Setup did not finish. The message above says why.</p>
        <button type="button" className="btn-primary" onClick={() => setAgain(a => a + 1)}>Retry</button></>
    : state === 'working' ? <>
        <p>Installing only what is missing. Nothing else changes.</p>
        <BypassTrack on={f.busy === 'bypass'} done={f.finished === 'bypass' ? 'Signature bypass installed' : undefined} />
        <GalactaTrack on={f.busy === 'galacta'} done={f.finished === 'galacta' ? `${LOADER_NAME} is in your mods folder` : undefined} /></>
    : <p className="ob-done"><Check size={16} strokeWidth={2.75} aria-hidden="true" />
        <span>{did.length ? `Installed ${did.join(' and ')}.` : off ? '' : 'Everything mods need is already set up.'}{other}{off}
</span></p>
  return <div className="ob-split"><div className="ob-col ob-status" aria-live="polite">{status}</div><Folder f={f} /></div>
}
const auto: Page = { id: 'auto', title: 'Setting up mods', when: b => !b.guided, body: f => <AutoSetup f={f} /> }

const TYPES: [string, typeof Package][] = [['.pak', Package], ['.zip', FileArchive], ['.rar', FileArchive], ['.7z', FileArchive]]
/** Smart loadouts in miniature: loose mods, each dot the color of the look it belongs to, sorted into two loadouts. */
const SMART_ROWS: [string, string, number][] = [['Catboy Mesh', 'Mesh', 0], ['Ultimate Suit', 'Mesh', 1], ['Catboy Trail', 'VFX', 0], ['Ultimate Icons', 'UI', 1]]
const Smart = () => (
  <span className="ob-smart">
    <span className="ob-smart-mods">{SMART_ROWS.map(([name, type, g], i) => <span key={name} className={`is-g${g}`} style={{ '--i': i } as React.CSSProperties}><i />{name}<small>{type}</small></span>)}</span>
    <ArrowRight size={16} className="ob-smart-arrow" />
    <span className="ob-smart-out"><MiniCard name="Catboy" src={catboy} className="is-g0" /><MiniCard name="Ultimate" src={ultimate} className="is-g1" /></span>
  </span>
)

const mods: Page = {
  id: 'mods', title: 'Your first mod', when: b => b.guided || !b.hasMods,
  body: f => (
    <div className="ob-drop">
      {TYPES.map(([ext, Icon], i) => <span key={ext} className="ob-float" style={{ '--i': i } as React.CSSProperties}><Icon size={16} aria-hidden="true" /><b>{ext}</b></span>)}
      <span className="ob-drop-icon" aria-hidden="true"><Upload size={22} /></span>
      <b>Drop mods anywhere on this window</b>
      <span>This screen steps aside for the install and comes back after.</span>
      <span className="ob-drop-actions">
        <button type="button" className="btn-primary" disabled={!f.gamePath} onClick={f.addFiles} title={f.gamePath ? undefined : 'Find the game first'}><Upload size={14} aria-hidden="true" /> Choose files…</button>
        <a className="su-link ob-out" href={NEXUS} onClick={e => { e.preventDefault(); openUrl(NEXUS) }}>Find mods on Nexus Mods <ExternalLink size={13} aria-hidden="true" /></a>
      </span>
      {f.newMods.length > 0 && <p className="ob-done"><Check size={16} strokeWidth={2.75} aria-hidden="true" /><span>{plural(f.newMods.length, 'mod')} installed. Next makes a loadout from them.</span></p>}
    </div>
  ),
}

const loadout: Page = {
  id: 'loadout', title: 'Your first loadout', choice: true,
  sub: () => 'A set of mods that turn on and off together.',
  body: f => (
    <div className="ob-choices">
      {f.made && (
        <Choice suggested onClick={() => f.finish(f.made!.id)} stage={<MiniCard name={f.made.name} src={silhouette} />}
          title={`Continue with ${f.made.name}`} text="The install saved your new mods as this loadout. Opens it now." />
      )}
      {f.newMods.length > 0 && !f.made && (
        <Choice suggested onClick={() => f.finish(createFromMods(f.newMods).id)} stage={<MiniCard name="New loadout" src={silhouette} />}
          title={`From the ${plural(f.newMods.length, 'mod')} you added`} text="Made now and opened, ready to switch on." />
      )}
      {f.hasMods && (
        <Choice suggested={!f.made && !f.newMods.length} onClick={() => f.finish('smart')} stage={<Smart />}
          title="Group my mods into loadouts" text="Mods that share a look become one loadout, each with a tick to keep." />
      )}
      <Choice onClick={() => f.finish('empty')} title="Start one by hand" text="An empty loadout, named and filled on its page."
        stage={<span className="wi-card ob-empty"><CopyPlus size={30} strokeWidth={1.75} /></span>} />
      {!f.hasMods && f.newMods.length === 0 && <p className="fr-hint">No mods yet. Back adds some first, or the checklist on Loadouts home reminds you later.</p>}
    </div>
  ),
}

const TRY: [SoundName, string][] = [['tap', 'Click'], ['toggle', 'Switch'], ['success', 'Done'], ['error', 'Oops']]
/** One Make it yours setting: a picture of what it does, its words, and its control. */
/** The app's icon, the Geist x (scripts/make-icon.py draws the real one the same way). */
const AppMark = () => <b className="ob-mark">x</b>
function Pref({ stage, title, children, action, wide }: { stage?: React.ReactNode; title: string; children: React.ReactNode; action?: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`ob-pref${wide ? ' is-wide' : ''}`}>
      {stage && <div className="wi-stage ob-stage" aria-hidden="true">{stage}</div>}
      <div className="ob-pref-text"><h3>{title}</h3>{children}</div>
      {action && <div className="ob-pref-action">{action}</div>}
    </section>
  )
}
/** Make it yours: four settings, each already in Settings (previews, Discord, the shortcut, the sound pack), all optional. */
function Yours({ f }: { f: Flow }) {
  const choice = useSoundChoice()
  const kitReady = Boolean(f.kit.kit?.version && f.kit.kit?.blender)
  const size = f.kit.latest?.size ? `${Math.round(f.kit.latest.size / 1048576)} MB, plus Blender` : 'a download, plus Blender'
  return (
    <div className="ob-prefs">
      <Pref title="Pictures of your mods" stage={<MiniCard name="Catboy" src={catboy} className="wi-reveal ob-shot"><span className="wi-render"><span>Rendering</span></span></MiniCard>}
        action={kitReady ? <span className="ob-ok"><Check size={14} strokeWidth={2.75} /> Ready</span>
          : !f.kit.plan && <button type="button" className="btn-primary" disabled={Boolean(f.kit.busy) || (f.kit.latest === null && !f.kit.kit?.version)} onClick={() => f.kit.setUp()}
            title={f.kit.latest === null ? 'No kit published yet: drop a kit zip on the window' : 'Downloads the preview kit and installs Blender if it is missing'}>
            {f.kit.busy === 'setup' ? 'Setting up…' : 'Set up previews'}</button>}>
        <p>Every mod and loadout as a picture of how it looks in game, rendered on your PC ({size}).</p>
        {!kitReady && <p className="fr-admin"><ShieldCheck size={13} aria-hidden="true" /> Windows asks for admin rights once, for Blender.</p>}
        <KitTrack plan={f.kit.plan} p={f.kit.progress} done={f.kit.finished ?? undefined} />
        <DoctorProblems d={f.kit.doctor} />
      </Pref>
      <Pref title="Show it on Discord" stage={<span className="ob-presence"><AppMark /><span><small>Playing</small><b>{APP_NAME}</b><small>Switching loadouts</small></span></span>}
        action={<Switch size="sm" checked={f.enableDrp} onChange={f.onSetDrp} aria-label={`Show ${APP_NAME} in your Discord status`} />}>
        <p>Your Discord status shows {APP_NAME} while it is open. Off keeps it to yourself.</p>
      </Pref>
      <Pref title="Desktop shortcut" stage={<span className="ob-icon"><AppMark /><small>{APP_NAME}</small></span>}
        action={f.shortcut.exists ? <span className="ob-ok"><Check size={14} strokeWidth={2.75} /> On your desktop</span> : <ShortcutButton s={f.shortcut} />}>
        <p>Start {APP_NAME} from your desktop.</p>
      </Pref>
      <Pref wide title="App sounds">
        <p>Small sounds on clicks, switches, and alerts. Try a pack, then pick it.</p>
        {/* .sound-pack: the global click cue stays quiet here, each tile plays its own pack */}
        <div className="fr-tiles sound-pack" role="group" aria-label="App sounds">
          {(['off', ...SOUND_PACKS] as const).map(pack => (
            <div key={pack} className={`fr-tile${choice === pack ? ' is-on' : ''}`}>
              <button type="button" className="fr-tile-pick" aria-pressed={choice === pack} onClick={() => { setSoundChoice(pack); if (pack !== 'off') cue('select') }}>
                {choice === pack ? <Check size={13} strokeWidth={2.75} aria-hidden="true" /> : pack === 'off' ? <VolumeX size={13} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
                {pack === 'off' ? 'Off' : pack[0].toUpperCase() + pack.slice(1)}
              </button>
              {pack === 'off' ? <span className="fr-tile-none">No sounds</span>
                : <span className="fr-tile-try">{TRY.map(([name, label]) => <button key={name} type="button" onClick={() => tryCue(name, pack)} title={`Play ${label.toLowerCase()} in ${pack}`}>{label}</button>)}</span>}
            </div>
          ))}
        </div>
      </Pref>
    </div>
  )
}
const yours: Page = { id: 'yours', title: 'Make it yours', sub: () => 'All optional. Change these later in Setup and Settings.', body: f => <Yours f={f} /> }

/** The flow, in order. Another edition's pages go on the line below yours, before the first loadout (always last: a
 *  pick there finishes the flow). */
export const PAGES: Page[] = [
  welcome,
  ask,
  setup,
  auto,
  mods,
  yours,
  loadout,
]

export default function FirstRun({ alert, gamePath, mods: allMods, installing, enableDrp, onSetDrp, onAutoDetect, onBrowse, onAddFiles, onStartTour }: {
  alert: Alert
  installing: boolean // App's install panel is open
  gamePath: string
  mods: Mod[]
  enableDrp: boolean
  onSetDrp: (on: boolean) => void
  onAutoDetect: () => Promise<void>
  onBrowse: () => Promise<void>
  onAddFiles: (paths: string[]) => Promise<void>
  onStartTour: () => void
}) {
  const [open, setOpen] = useState(firstLaunch)
  const [at, setAt] = useState('welcome')
  const [path, setPath] = useState<'yes' | 'no' | null>(null) // the answer; unasked, mods on hand mean yes
  const [bypass, setBypass] = useState<Bypass | null>(null)
  const [bypassError, setBypassError] = useState<string | null>(null)
  const [galacta, setGalacta] = useState<Galacta | null>(null)
  const [auto, setAuto] = useState<Auto>('checking')
  const loadouts = useLoadouts()
  const title = useRef<HTMLHeadingElement>(null)
  const asked = useRef(0) // the newest status check: answers to an older one (another game folder) are dropped
  const [busy, setBusy] = useState<string | null>(null)
  const { finished, finish } = useFinished() // a step that just installed, said in it for a moment
  const kit = usePreviewKit(alert)
  const shortcut = useShortcut()
  const detected = useRef(false)
  const startMods = useRef<Set<string> | null>(null) // the mods there when the flow opened: the rest are "just added"
  const resume = useRef<{ count: number; seen: boolean } | null>(null) // hidden for an install: the mod count then, and whether the install panel opened
  const focus = useDialogFocus(open) // focus inside, Tab stays inside, back to the opener on close

  const installed = realMods(allMods)
  const hasMods = installed.length > 0
  const guided = (path ?? (hasMods ? 'yes' : 'no')) !== 'yes'
  const ids = sequence(PAGES, { guided, hasMods })
  const newMods = startMods.current ? installed.map(m => m.path).filter(p => !startMods.current!.has(p)) : []
  const made = newMods.length ? loadouts.find(l => newMods.every(p => l.scope.includes(modKey(p)))) : undefined
  const begin = () => { startMods.current = new Set(installed.map(m => m.path)) } // leaving the welcome: what is there now is not "just added"
  const page = PAGES.find(p => p.id === at) ?? welcome
  const steps = ids.slice(1) // the rail: every page after the welcome
  const stepAt = steps.indexOf(at)
  const move = (d: 1 | -1, list = ids) => setAt(list[Math.max(0, Math.min(list.length - 1, list.indexOf(at) + d))])

  useEffect(() => {
    const show = () => { begin(); setPath(null); setAt(sequence(PAGES, { guided: !hasMods, hasMods })[1]); setOpen(true) } // Setup > Guided setup
    window.addEventListener('repakxtra-first-run', show)
    return () => window.removeEventListener('repakxtra-first-run', show)
  }, [hasMods])
  const close = () => { markOnboarded(); setOpen(false) }
  /** Out of the way for an install (App's drop handler shows its panel), back when the panel closes, installed or
   *  cancelled. Not marked seen: a restart while hidden shows the flow again. */
  const hide = () => { resume.current = { count: installed.length, seen: false }; setOpen(false) }
  useEffect(() => {
    const r = resume.current
    if (open || !r) return
    if (installing) { r.seen = true; return }
    if (!r.seen && installed.length <= r.count) return // the panel has not opened yet
    resume.current = null
    setOpen(true)
    if (at === 'mods' && installed.length > r.count) setAt('yours') // installed: on to the next page
  }, [installing, installed.length])
  useEffect(() => { if (open && at !== 'welcome') title.current?.focus() }, [open, at]) // a screen reader hears the new page
  const checkStatus = () => {
    const id = ++asked.current
    const mine = () => asked.current === id
    setBypass(null); setBypassError(null); setGalacta(null)
    invoke<Bypass>('setup_bypass_status').then(b => { if (mine()) setBypass(b) }, e => { if (mine()) setBypassError(String(e)) })
    invoke<Galacta>('setup_galacta_status', { online: false }).then(g => { if (mine()) setGalacta(g) }, () => undefined)
  }
  useEffect(() => {
    if (!open) return
    checkStatus()
    kit.peek()
    if (!gamePath && !detected.current) { detected.current = true; onAutoDetect().catch(() => undefined) } // most installs are found, and their mods are known by the question
    // Mods dropped on the window go to the install panel: this screen steps aside for it. A kit zip installs as the
    // kit (App's drop handler), so the screen stays and the previews row updates
    const off = listen<{ paths?: string[] } | string[]>('tauri://drag-drop', e => {
      const paths = Array.isArray(e.payload) ? e.payload : e.payload?.paths ?? []
      if (!(paths.length === 1 && isKitZip(paths[0]))) hide()
    })
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing && ownsTop(focus.ref.current)) { e.stopPropagation(); close() } } // a changelog above it takes Esc first
    window.addEventListener('keydown', esc, true)
    return () => { asked.current++; off.then(f => f()).catch(() => undefined); window.removeEventListener('keydown', esc, true) }
  }, [open, gamePath])
  if (!open) return null

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what)
    try { await f(); finish(what) } catch (e) { alert.warning('Setup', String(e)) } finally { setBusy(null) }
  }
  const installBypass = () => run('bypass', async () => {
    setBypass(await invoke<Bypass>('setup_bypass', { action: bypass?.state === 'disabled' ? 'enable' : 'install' }))
    window.dispatchEvent(new Event('bypass-changed')) // the Setup button's dot
  })
  const installGalacta = () => run('galacta', async () => { setGalacta(await invoke<Galacta>('setup_galacta_install', { folder: null })) })
  /** The bypass and the loader, each only when missing, in order with its own progress. Names what went in. Another
   *  loader or bypass (state other) is left alone: its row's Install is the one way to replace it. */
  const setUpMissing = async (): Promise<string[] | null> => {
    const did: string[] = []
    try {
      const b = await invoke<Bypass>('setup_bypass_status')
      setBypass(b)
      if (b.state !== 'installed' && b.state !== 'other') {
        setBusy('bypass')
        setBypass(await invoke<Bypass>('setup_bypass', { action: b.state === 'disabled' ? 'enable' : 'install' }))
        window.dispatchEvent(new Event('bypass-changed'))
        finish('bypass')
        did.push('the signature bypass')
      }
      const g = await invoke<Galacta>('setup_galacta_status', { online: false })
      setGalacta(g)
      if (!g.installed) { setBusy('galacta'); setGalacta(await invoke<Galacta>('setup_galacta_install', { folder: null })); finish('galacta'); did.push(LOADER_NAME) }
    } catch (e) { alert.warning('Setup', String(e)); return null } finally { setBusy(null) }
    return did
  }
  const setUpAll = async () => {
    if (!gamePath) { setBusy('find'); await onAutoDetect().catch(() => undefined) }
    await setUpMissing()
  }
  const addFiles = async () => {
    const got = await pick({ multiple: true, title: 'Mods to install', filters: [{ name: 'Mod files', extensions: ['pak', 'zip', 'rar', '7z', OFF_EXT] }] }).catch(() => null)
    const paths = Array.isArray(got) ? got : got ? [got] : []
    if (!paths.length) return
    hide()
    await onAddFiles(paths)
    if (resume.current && !resume.current.seen) { resume.current = null; setOpen(true) } // nothing to install: the panel never opened
  }
  /** Done: Loadouts home, plus what the first loadout page picked. */
  const finishFlow = (pending: Pending = null) => {
    close()
    setView('home')
    if (pending === 'smart') window.dispatchEvent(new Event('repakxtra-smart-loadouts'))
    else if (pending === 'empty') openLoadout(createFromMods([]).id, true)
    else if (pending) openLoadout(pending)
  }
  const answer = (yes: boolean) => { const p = yes ? 'yes' : 'no'; setPath(p); move(1, sequence(PAGES, { guided: !yes, hasMods })) }

  const f: Flow = {
    alert, gamePath, hasMods, installedCount: installed.length, newMods, made, auto, setAuto, busy, finished, bypass, bypassError, galacta, checkStatus, run, installBypass, installGalacta,
    setUpAll, setUpMissing, onAutoDetect, onBrowse, addFiles, kit, shortcut, enableDrp, onSetDrp, finish: finishFlow, answer,
    next: () => move(1), back: () => move(-1), close,
  }
  const last = at === ids[ids.length - 1]
  const coreDone = Boolean(gamePath && bypass?.state === 'installed' && galacta?.installed && !galacta.disabled)
  // Next waits while something runs. With setup unfinished, moving on is a quiet Skip for now, so it never reads as done
  const working = Boolean(busy) || (at === 'auto' && (auto === 'checking' || auto === 'working'))
  const unfinished = (at === 'setup' && !coreDone) || (at === 'auto' && auto !== 'done' && !working)

  return (
    <div className="modal-overlay fr-overlay" onClick={close}>
      <motion.div ref={focus.ref} onKeyDown={focus.onKeyDown} tabIndex={-1} className="modal-content fr-modal" role="dialog" aria-modal="true"
        {...(at === 'welcome' ? { 'aria-label': `Set up ${APP_NAME}` } : { 'aria-labelledby': 'fr-title' })}
        onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        {at === 'welcome' ? <>
          <button className="modal-close fr-intro-close" onClick={close} aria-label="Close">×</button>
          <WelcomeIntro onNext={() => { begin(); move(1) }} onSkip={close} />
        </> : <>
        <button className="modal-close fr-intro-close" onClick={close} aria-label="Close">×</button>
        <div className="wi-head ob-head">
          <h2 className="wi-title fr-welcome" id="fr-title" ref={title} tabIndex={-1}>{page.title}</h2>
          {page.sub?.(f) && <p className="wi-lede">{page.sub(f)}</p>}
        </div>
        {/* transitions.dev: each page rises in; the key remounts it so Back and Next both play it */}
        <div key={at} className="modal-body fr-body t-rise-in">{page.body(f)}</div>
        <div className="modal-footer fr-foot">
          <span className="fr-rail" role="status" aria-label={`Step ${stepAt + 1} of ${steps.length}`}>
            {steps.map((id, i) => <i key={id} className={i < stepAt ? 'is-done' : i === stepAt ? 'is-now' : ''} />)}
            <span>Step {stepAt + 1} of {steps.length}</span>
          </span>
          {/* leaving early is quiet, so it never outshines the page; the checklist on Loadouts home picks up the rest */}
          {last
            ? <button type="button" className="lo-text-btn" onClick={() => { finishFlow(); onStartTour() }}>Finish and take the 1-minute tour</button>
            : <button type="button" className="lo-text-btn" onClick={close}>Finish later</button>}
          <button type="button" className="lo-text-btn" onClick={() => move(-1)}>Back</button>
          {(page.choice || unfinished) && !last
            ? <button type="button" className="lo-text-btn" disabled={working} onClick={() => move(1)}>{unfinished ? 'Skip for now' : 'Skip'}</button>
            : <button type="button" className="btn-primary ob-next" disabled={working} onClick={last ? () => finishFlow() : () => move(1)}>{last ? <>Finish <Check size={15} aria-hidden="true" /></> : <>Next <ArrowRight size={15} aria-hidden="true" /></>}</button>}
        </div>
        </>}
      </motion.div>
    </div>
  )
}

if (import.meta.env.DEV) {
  console.assert(sequence(PAGES, { guided: true, hasMods: false }).join() === 'welcome,ask,setup,mods,yours,loadout', 'no mods, not yet: the guided path')
  console.assert(sequence(PAGES, { guided: false, hasMods: true }).join() === 'welcome,ask,auto,yours,loadout', 'mods installed: still asked, then the background setup')
  console.assert(sequence(PAGES, { guided: false, hasMods: false }).join() === 'welcome,ask,auto,mods,yours,loadout', 'yes but nothing installed: add mods first')
}
