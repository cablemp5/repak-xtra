import { APP_NAME } from '../edition'
// repakxtra: the VFX Updater window (route vfx-updater), in place of the upstream VFX Updater's panel. It works on the mods
// folder's own VFX mods (xtra_vfx_mods): one list, like a loadout's Add mods, with the mods that need an update first and
// already ticked, so after a game update the whole job is one press of Update (pipeline.ts). Each ticked mod shows its step
// and a progress bar while it runs, then a pill that opens its report: what was rebuilt, what was kept and why. The update
// takes the mod's name and the original is renamed <name>_BROKEN and turned off, so loadouts and tags keep working.
// Everything else (naming, turning originals off, USMAP, Color names, Log) is under Advanced, folded unless the USMAP is
// missing. Cancel waits for the step in flight (UAssetTool cannot be interrupted) and says so. The main window hands mods
// over (handoff.ts: they are ticked, and updated at once from the Library's notice).
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { AlertTriangle, Archive, Check, CheckCheck, ChevronDown, ChevronRight, Copy, Eye, Info, PackageCheck, Undo2, FilePlus, Map as MapIcon, Palette, RefreshCw, RotateCcw, ScrollText, Search, Tag, X } from 'lucide-react'
import TitleBar from '../../components/TitleBar'
import { useGlobalTooltips } from '../../hooks/useGlobalTooltips'
import Checkbox from '../../components/ui/Checkbox'
import { Num, SwapText } from '../motion'
import { cue } from '../sounds'
import { DEFAULT_FILTER, parseWords, readFilter, resetFilter, writeFilter, type ColorFilter } from './filter'
import { canonKey } from '../loadoutIdentity'
import { modKey, useLoadouts } from '../loadoutStore'
import { FIXED_EVENT, onHandoff, openLoadoutInMain, onReport, takeHandoff, takeReport, utocOf, type Fixed } from './handoff'
import { ASK_REVIEW, CHECK_RUN, KEEP_NAME, ORIGINALS, REPAIR_POLICY, SAFE_OFF, claimRun, newRunToken, onRunChange, readAskReview, readNaming, readOriginals, readRepairPolicy, readSafety, releaseRun, retireUnsafe, runLock, type Naming, type Originals, type RunLock, type Safety } from './prefs'
import { STEPS, fixVfxMod, repairOutcome, type AssetKind, type VfxReport } from './pipeline'
import { needsUpdater, rescanForced, skipsUpdater, verdictLabel, verdictsChanged } from '../brokenMods'
import { SCAN_DONE, progressLine, type ScanStep } from '../scanProgress'
import { HeroFilter, heroOfName } from '../heroFilter'
import './vfx.css'
import ModRowsSkeleton from '../ModRowsSkeleton'

type Status = 'waiting' | 'running' | 'review' | 'fixed' | 'nothing' | 'failed' | 'cancelled' | 'declined'
type Run = { status: Status; step?: number; sub?: string; report?: VfxReport }
type Mod = { path: string; utoc: string; enabled: boolean; name: string; hero?: string | null; modified?: number; niagara?: boolean; materials?: boolean; ui?: boolean
  /** A May crash mod the updater cannot rebuild (not a VFX or material mod), with why: Update turns it off */
  risky?: string }
type ModList = { mods: Mod[]; problems: string[] }
type PakFile = { path: string; utoc_path?: string | null; enabled: boolean; custom_name?: string | null; character_name?: string | null; modified_date?: number }
type Verdict = { path: string; kind: string; reason: string; staleNiagara?: number; usmapWait?: number; offOnly?: boolean }
type Log = { time: string; text: string; type: string }
type Usmap = { updated: boolean; upToDate: boolean; skipped: boolean; localPath?: string | null; filename?: string | null; version?: string | null; buildNumber?: number | null; commitDate?: string | null; message: string }
type GameBuild = { updated: number; cl?: number | null }
/** xtra_usmap_diff.rs: what the newest game build on disk moved, and of that what nothing here handles yet */
type LayoutNews = { newest?: { build: number; from: number; structs: string[] } | null; notHandled: string[] }

// How long updates took on this PC, the last 12 of each kind (with Niagara effects, without), for the time left. Its
// own key since 0.20.0: runs from before the speed work (one of 409 s read as 110 minutes for 20 mods) never count
const TIMES = 'repakxtra.vfx.times.v2'
type Times = { n: number[]; p: number[] }
const readTimes = (): Times => { try { const t = JSON.parse(localStorage.getItem(TIMES) ?? ''); return { n: Array.isArray(t.n) ? t.n : [], p: Array.isArray(t.p) ? t.p : [] } } catch { return { n: [], p: [] } } }
/** The middle run, once there are 3: one slow run (a cold cache, a busy PC) never sets the estimate alone. */
const median = (xs: number[]) => (xs.length < 3 ? undefined : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)])
function rememberTime(niagara: boolean, ms: number) {
  if (import.meta.env.DEV) return // the dev copy is a debug build, several times slower than the app
  const t = readTimes(), k = niagara ? 'n' : 'p'
  t[k] = [...t[k], ms].slice(-12)
  localStorage.setItem(TIMES, JSON.stringify(t))
}
// before this PC has updated any: the 2026-10-24 benchmark's averages (release build, 5 mods of each kind, after the
// speed work in docs/VFX-SPEED-2026-10-24.md)
const START = { n: 30_000, p: 12_000 }
/** One mod's expected time: its kind's median on this PC (3 runs or more), else the benchmark's. */
const expected = (t: Times, niagara?: boolean) => median(niagara ? t.n : t.p) ?? (niagara ? START.n : START.p)
const timeLeft = (ms: number) => (ms < 60_000 ? 'under a minute' : `about ${plural(Math.round(ms / 60_000), 'minute')}`)

const NAMING_NOTE: Record<Naming, string> = {
  broken: 'Loadouts and tags stay on the update. The original is renamed to end in _BROKEN.',
  updated: 'The update ends in _UPDATED, and loadouts move to it. Updating it again makes _UPDATED_V2, then V3.',
}
// a partial update always keeps its original (it is what a full update starts from later), whatever is picked here
const PARTIAL_KEEPS = 'A partial update keeps its original, off, as _ORIGINAL, for a full update later.'
const ORIGINALS_NOTE: Record<Originals, string> = {
  off: `Kept in the mods folder, turned off, so only the update loads. ${PARTIAL_KEEPS}`,
  trash: `Turned off and moved to Recently deleted. Restore it in Settings within 7 days. ${PARTIAL_KEEPS}`,
  keep: `Left as they are. If one is on, turn it or its update off before playing. ${PARTIAL_KEEPS}`,
}
/** A rivals-depot USMAP's release, from its file name (5.3.2-3939753+++depot_marvel+S10.5_release-Marvel.usmap). */
const usmapRelease = (name?: string | null) => name?.match(/\+([^+]+?)-Marvel\.usmap$/i)?.[1]?.replace(/_/g, ' ') ?? null
// every group and Advanced start folded each time the window opens: a run unfolds what it works on, and that is not kept
const GROUP_IDS = ['added', 'needs', 'unknown', 'rest', 'ui', 'materials', 'updated']
const SORT = 'repakxtra.vfx.sort2' // A to Z or Newest (the default since 0.17.1, so a new key), as a loadout's Add mods
const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p
const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`
/** A folded panel's content: out of reach of Tab and screen readers (the React 18 types this app uses lack inert). */
const folded = (hidden: boolean) => (hidden ? { inert: true } : {}) as object
const usmapCl = (name?: string | null) => Number(name?.match(/-(\d{6,})\+/)?.[1]) || null
const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
/** A mod chosen by its .utoc (Add .utoc, Send to VFX Updater): its main file (the .pak beside it unless named), named as the list names mods. */
const chosenMod = (utoc: string, path = utoc.replace(/\.utoc$/i, '.pak')): Mod =>
  ({ path, utoc, enabled: !/\.bak_repak$/i.test(path), name: fileName(utoc).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '') })
const isDone = (s?: Status) => s === 'fixed' || s === 'nothing'

/** A mod not marked as needing an update, on hover: what ticking it does */
const NO_NEED = "Not marked as needing an update. Updating it rebuilds it on the game's current files anyway."
const STATUS: Record<Status, string> = { waiting: 'Queued', running: 'Updating', review: 'Needs your review', fixed: 'Updated', nothing: 'Nothing to update', failed: 'Failed', cancelled: 'Cancelled', declined: 'Original kept' }
const KIND_ORDER: AssetKind[] = ['failed', 'left', 'unreadable', 'added', 'updated', 'same', 'passed']
const KIND_LABEL: Record<AssetKind, string> = { updated: 'Rebuilt', same: 'Match the game', added: 'The mod\'s own', passed: 'Kept as they were', left: 'Left out', unreadable: 'Could not be read', failed: 'Not updated' }
/** An update that left out Niagara files made for an older game build: it works, without those effects' colors */
const isPartial = (r?: VfxReport) => r?.status === 'fixed' && (r.counts.left + r.counts.ownGame + r.counts.unreadable > 0 || r.assets.some(a => a.kind === 'failed'))
const statusText = (r: VfxReport) => (isPartial(r) ? 'Partially updated'
  : r.turnedOff && r.status !== 'fixed' ? `${r.status === 'failed' ? 'Failed' : r.counts.relaid ? 'Not updated' : 'May crash'}, ${r.trashed ? 'in Recently deleted' : 'turned off'}` : r.status === 'fixed' || r.status === 'failed' ? repairOutcome(r) : STATUS[r.status])
const leftText = (r: VfxReport) => `Left out ${plural(r.counts.left, 'effect file')} made for an older game build, so the game uses its own and ${r.counts.left === 1 ? 'that effect shows' : 'those effects show'} their usual colors.`
/** Niagara files the update could not carry with today's USMAP: the game's own effect, for good (a partial repair). */
const ownText = (r: VfxReport) => (r.counts.ownGame ? `${plural(r.counts.ownGame, 'asset')} could not be carried, so ${r.counts.ownGame === 1 ? 'that effect shows' : 'those effects show'} the game's own colors.` : '')
/** A run's length, read at a glance: 42 s, 1 min 24 s */
const took = (ms: number) => {
  const sec = Math.max(1, Math.round(ms / 1000)), min = Math.floor(sec / 60), rest = sec % 60
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  return min ? `${unit(min, 'minute')}${rest ? ` ${unit(rest, 'second')}` : ''}` : unit(sec, 'second')
}
const bare = (path: string) => fileName(path).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, '') // a mod's name, no priority suffix

/** Where the update went, in words: the original's new name, or the update's own when it was named _UPDATED. */
function placedText(r: VfxReport) {
  const p = r.placed
  if (!p) return r.output ? `Saved as ${fileName(r.output)}.` : ''
  const kept = bare(p.original)
  const where = p.trashed ? 'is in Recently deleted' : p.turnedOff ? 'is off' : 'is beside it'
  if (/_ORIGINAL$/i.test(kept)) return `Saved as ${bare(p.fixed)}. The original is off and kept as ${kept}, for a full update later.`
  return (/_BROKEN$/i.test(kept) ? `It kept the mod's name. The original, ${kept}, ${where}.` : `Saved as ${bare(p.fixed)}. The original ${where}.`)
    + (p.replaced ? ' An earlier copy is in Recently deleted.' : '')
}

/** One mod's report as plain text, for Copy report. */
function reportText(r: VfxReport) {
  const lines = [`${r.name}: ${statusText(r)}${r.error ? `. ${r.error}` : ''}`]
  if (r.status === 'fixed') lines.push(`  ${placedText(r)}`)
  if (r.counts.left) lines.push(`  ${leftText(r)}`)
  if (r.counts.ownGame) lines.push(`  ${ownText(r)}`)
  lines.push(`  ${r.counts.updated} rebuilt with ${r.counts.changes} edits, ${r.counts.same} match the game, ${r.counts.added} the mod's own, ${r.counts.passed} kept, ${r.counts.left} left out, ${r.counts.unreadable} unreadable, ${took(r.ms)}`)
  r.warnings.forEach(w => lines.push(`  ! ${w}`))
  for (const k of KIND_ORDER) for (const a of r.assets.filter(x => x.kind === k)) lines.push(`  [${KIND_LABEL[k]}] ${a.name}: ${a.detail}`)
  return lines.join('\n')
}

/** `candidate`: a Best effort build waiting for review, not placed yet: no placement to tell, its counts and warnings
 *  folded with its assets. `actions`: the review's answers, on one line with Show assets. */
function Report({ r, onRetry, onUsmap, busy, candidate = false, actions }: { r: VfxReport; onRetry: () => void; onUsmap: () => void; busy: boolean; candidate?: boolean; actions?: React.ReactNode }) {
  const [assets, setAssets] = useState(false)
  const [allWarnings, setAllWarnings] = useState(false)
  const groups = KIND_ORDER.map(k => [k, r.assets.filter(a => a.kind === k)] as const).filter(([, list]) => list.length)
  const warnings = allWarnings ? r.warnings : r.warnings.slice(0, 4)
  const warningList = r.warnings.length > 0 && <ul className="vf-warnings" aria-label="Warnings">
    {warnings.map((w, i) => <li key={i}>{w}</li>)}
    {r.warnings.length > 4 && <li className="vf-more"><button type="button" className="su-link" onClick={() => setAllWarnings(v => !v)}>{allWarnings ? 'Show fewer' : `Show all ${r.warnings.length}`}</button></li>}
  </ul>
  return (
    <div className="vf-report">
      {candidate ? null : r.status === 'fixed'
        ? <p className="vf-note">{r.counts.updated ? `Rebuilt ${r.counts.updated.toLocaleString()} of ${plural(r.assets.length, 'asset')} with ${plural(r.counts.changes, 'edit')}. ` : ''}{r.counts.left ? `${leftText(r)} ` : ''}{ownText(r) ? `${ownText(r)} ` : ''}{candidate ? '' : placedText(r)}</p>
        // a cancelled run's pill already says so: no "Cancelled." under it. An error that sends the user to the USMAP
        // links to it (Advanced opens on it)
        : r.error && r.status !== 'cancelled' && <p className="vf-note">{r.error}{/USMAP in Advanced/.test(r.error) && <>{' '}<button type="button" className="su-link" onClick={onUsmap}>Open the USMAP setting</button></>}</p>}
      {(r.status === 'failed' || r.status === 'cancelled') && (
        <button type="button" className="row-action" disabled={busy} onClick={onRetry}><RotateCcw size={13} aria-hidden="true" /> Try again</button>
      )}
      {!candidate && warningList}
      {groups.length > 0 && <>
        <div className={actions ? 'vf-review-actions' : 'vf-stats'}>
          {actions}
          <button type="button" className="vf-assets-toggle" aria-expanded={assets} onClick={() => setAssets(v => !v)}>
            {assets ? 'Hide' : 'Show'} {plural(r.assets.length, 'asset')} <ChevronRight size={12} className="vf-assets-caret" aria-hidden="true" />
          </button>
        </div>
        <div className="t-acc-panel" data-open={assets}>
          <div className="t-acc-panel-inner" {...folded(!assets)}>
            {assets && candidate && warningList}
            {assets && <div className="vf-assets">{groups.map(([k, list]) => (
              <div key={k} className="vf-group">
                <h4>{KIND_LABEL[k]} <span>{list.length.toLocaleString()}</span></h4>
                <ul>{list.map(a => <li key={a.path}><span className="vf-asset">{a.name}</span><span className="vf-detail">{a.detail}</span></li>)}</ul>
              </div>
            ))}</div>}
          </div>
        </div>
      </>}
    </div>
  )
}

/** A VFX mod: its tick, name, the loadouts holding it and its On badge, and once it ran its step, progress or result. Why it
 *  needs an update is its tooltip. */
function Row({ mod, rowKey, loadouts, run, needs, partial, waits, made, picked, open, busy, onPick, onToggle, onRetry, onUsmap }: {
  mod: Mod; rowKey: string; loadouts: { id: string; name: string }[]; run?: Run; needs?: string; partial?: number; waits?: number
  /** made by this updater for the installed game: whether it left files out (true), or not (false) */
  made?: boolean; picked: boolean; open: boolean; busy: boolean; onPick: (v: boolean) => void; onToggle: () => void; onRetry: () => void; onUsmap: () => void
}) {
  const status = run?.status
  const running = status === 'running'
  const step = run?.step ?? 0
  const whyId = useId()
  return (
    <li className={`mod-row vf-row${status ? ` is-${status}` : ''}${picked ? ' is-picked' : ''}`} title={needs ?? (run ? undefined : NO_NEED)} data-key={rowKey}>
      <Checkbox size="sm" className="vf-pick" checked={picked && !waits} isDisabled={busy || Boolean(waits)} disabled={busy || Boolean(waits)} onChange={onPick} aria-describedby={needs ? whyId : undefined}>
        <span className={`vf-row-name${running ? ' t-shimmer' : ''}`} title={mod.path}>{mod.name}</span>
        {mod.enabled && <span className="on-dot" role="img" aria-label="On now" title="This mod is on now" />}
      </Checkbox>
      {/* the badges take focus, so their explanation (a tooltip, useGlobalTooltips) reaches the keyboard too */}
      {/* why it needs an update, read with its tick (the row's tooltip says it on hover) */}
      {needs && <span id={whyId} className="xtra-sr-only">{needs}</span>}
      {/* a May crash mod Update turns off says so */}
      {waits ? <span className="vf-needs is-waiting" tabIndex={0} title={needs}>Waiting</span>
        : needs && mod.risky && !run && <span className="vf-needs" tabIndex={0} title={`${needs} Update turns it off: nothing here can rebuild it.`}>May crash, turns off</span>}
      {made !== undefined && !run && !needs && <span className={`vf-made${made ? ' is-partial' : ''}`} tabIndex={0} title={made
        ? "Updated here for this game version, without the Niagara files only the game's new USMAP can rebuild. They show the game's usual colors until then."
        : 'Updated here for this game version.'}>{made ? 'Partly updated' : 'Updated'}</span>}
      {mod.niagara && !partial && <span className="vf-niagara" tabIndex={0} title="Has Niagara effects (particle systems). When a game update changes them, the update rebuilds them on the new game files.">Niagara</span>}
      {partial && !run?.report ? (
        <span className="vf-partial" tabIndex={0} title={`${plural(partial, 'Niagara file')} ${partial === 1 ? 'was' : 'were'} made for an older game build. ${partial === 1 ? 'It' : 'They'} will be left out, so ${partial === 1 ? 'that effect shows' : 'those effects show'} the game's usual colors. The rest still updates, and the original is kept, off.`}>Partial</span>
      ) : null}
      {loadouts.length > 0 && (
        <button type="button" className="vf-loadouts" onClick={() => void openLoadoutInMain(loadouts[0].id)}
          title={`Open ${loadouts[0].name} in ${APP_NAME}${loadouts.length > 1 ? `. Also in ${loadouts.slice(1).map(l => l.name).join(', ')}` : ''}`}>
          <i>In</i><span>{loadouts[0].name}</span>{loadouts.length > 1 && <b>{' '}+{loadouts.length - 1}</b>}
        </button>
      )}
      {run?.report
        ? <button type="button" className={`vf-pill is-${isPartial(run.report) ? 'partial' : status}`} aria-expanded={open} onClick={onToggle} title={open ? 'Hide the report' : 'Show the report'}>
            {run.report.status === 'failed' && <AlertTriangle size={12} className="vf-pill-icon" aria-hidden="true" />}
            <span className="vf-pill-label">{statusText(run.report)}{run.report.status === 'fixed' ? ` in ${took(run.report.ms)}` : ''}</span>
            <ChevronDown size={12} className="vf-caret" aria-hidden="true" />
          </button>
        : status && (running && step
          ? <span className="vf-pill is-running"><span className="vf-pill-label"><SwapText text={`Step ${step} of ${STEPS.length}`} /></span></span>
          : <span className={`vf-status is-${status}`}>{STATUS[status]}</span>)}
      {running && step ? (
        <div className="vf-progress">
          <div className="vf-bar" role="progressbar" aria-valuenow={step} aria-valuemin={0} aria-valuemax={STEPS.length} aria-label={`${mod.name} progress`}>
            <i style={{ width: `${((step - 0.5) / STEPS.length) * 100}%` }} />
          </div>
          <p className="vf-step">{/* the footer announces the step: one live region, not two */}<SwapText text={STEPS[step - 1]} />{run?.sub ? <span className="vf-count">{run.sub}</span> : null}{/* plain: it changes many times a second, faster than a swap-in finishes */}</p>
        </div>
      ) : null}
      {run?.report && <div className="t-acc-panel vf-row-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}><Report r={run.report} onRetry={onRetry} onUsmap={onUsmap} busy={busy} /></div></div>}
    </li>
  )
}

/** A group of mods that folds away to its heading, as a collection does on the Loadouts screen. Its heading holds the
 *  fold, the name and count, and Select all / Clear for the group. */
function Group({ title, count, tone, open, onFold, all, none, busy, onPick, children }: {
  title: string; count: number; tone?: 'needs' | 'done'; open: boolean; onFold: () => void; all: boolean; none: boolean; busy: boolean; onPick: (on: boolean) => void; children: React.ReactNode
}) {
  return (
    <section className={`vf-grp${tone ? ` is-${tone}` : ''}${open ? '' : ' is-folded'}`}>
      <div className="vf-grp-head">
        <h2 className="vf-grp-title">
          <button type="button" className="vf-grp-fold" aria-expanded={open} onClick={onFold}>
            <ChevronRight size={15} className="vf-grp-caret" aria-hidden="true" />
            <span className="vf-grp-name">{title}</span>
            <span className="vf-grp-count">{count}</span>
          </button>
        </h2>
        <span className="vf-selects">
          <button type="button" className="vf-select" disabled={busy || all} onClick={() => onPick(true)}>Select all</button>
          <button type="button" className="vf-select" disabled={busy || none} onClick={() => onPick(false)}>Clear</button>
        </span>
      </div>
      <div className="t-acc-panel" data-open={open}><div className="t-acc-panel-inner" {...folded(!open)}>{children}</div></div>
    </section>
  )
}

/** One part of Advanced, built like a Settings section: an icon and heading (with its state), what it is for in one
 *  line, then its control. */
function Section({ icon, title, state, about, children }: { icon: React.ReactNode; title: string; state?: React.ReactNode; about?: string; children: React.ReactNode }) {
  return (
    <section className="vf-set">
      <h3>{icon}{title}{state ? <span className="vf-set-state">{state}</span> : null}</h3>
      {about && <p className="vf-set-about">{about}</p>}
      {children}
    </section>
  )
}

/** A choice of a few, the width of the section: Settings' Launcher switch. What the picked one does goes under it. */
function Seg<T extends string>({ label, value, options, disabled, onChange, note }: {
  label: string; value: T; options: [T, string][]; disabled: boolean; onChange: (v: T) => void; note: string
}) {
  return (
    <>
      <div className="mod-state-filter vf-seg" role="group" aria-label={label}>
        {options.map(([v, text]) => <button key={v} type="button" aria-pressed={value === v} disabled={disabled} onClick={() => onChange(v)}>{text}</button>)}
      </div>
      <p className="vf-set-note">{note}</p>
    </>
  )
}

function ColorNames() {
  const [f, setF] = useState<ColorFilter>(readFilter)
  const [text, setText] = useState({ includes: f.includes.join(', '), excludes: f.excludes.join(', ') })
  const save = (next: typeof text) => {
    setText(next)
    const filter = { includes: parseWords(next.includes), excludes: parseWords(next.excludes) }
    setF(filter)
    writeFilter(filter)
  }
  const reset = () => { resetFilter(); setF(DEFAULT_FILTER); setText({ includes: DEFAULT_FILTER.includes.join(', '), excludes: DEFAULT_FILTER.excludes.join(', ') }) }
  const custom = JSON.stringify(f) !== JSON.stringify(DEFAULT_FILTER)
  return (
    <Section icon={<Palette size={15} aria-hidden="true" />} title="Color names" state={custom ? 'Custom' : 'Default'}
      about="Which blueprint and data table colors carry over. Material parameters always do.">
      <div className="vf-names">
        <label>Carry names containing<input value={text.includes} onChange={e => save({ ...text, includes: e.target.value })} spellCheck={false} /></label>
        <label>Never carry names containing<input value={text.excludes} onChange={e => save({ ...text, excludes: e.target.value })} spellCheck={false} /></label>
      </div>
      <p className="vf-set-note">Separate words with commas. Case does not matter.</p>
      {/* the defaults are tuned for the game's materials: a change is easy to make and hard to notice going wrong */}
      <p className="vf-warn">
        <AlertTriangle size={14} aria-hidden="true" />
        <span>Changing these is not advised. A wrong name can leave a mod's colors out of its update.{' '}
          <button type="button" className="su-link" disabled={!custom} onClick={reset} title={custom ? undefined : 'These are the defaults'}>Reset to defaults</button></span>
      </p>
    </Section>
  )
}

/** The oldest Best effort candidate waiting for an answer, pinned over the list: what it is, what each button does, its
 *  report, then the two answers on one line. Further candidates wait behind it (the batch keeps running meanwhile). */
export function ReviewCard({ name, report, more, onAnswer, onApproveAll }: { name: string; report: VfxReport; more: number; onAnswer: (ok: boolean) => void; onApproveAll: () => void }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, [])
  return (
    <section className="vf-review" ref={ref} role="region" aria-label={`Review ${name}`} aria-live="polite">
      <h3><Eye size={15} aria-hidden="true" />Your review: {name}{more > 0 && <span className="vf-review-more">{more} more after this</span>}</h3>
      <p>The Mod Updater rebuilt this mod for the current game version, but it couldn't confirm that every color and effect carried over. Your mod hasn't been changed yet. Use candidate swaps in the rebuilt copy, and Keep original leaves it as it was.</p>
      <Report r={report} busy={true} onRetry={() => {}} onUsmap={() => {}} candidate actions={<>
        <button type="button" className="lo-text-btn is-primary" onClick={() => onAnswer(true)}><PackageCheck size={14} aria-hidden="true" />Use candidate</button>
        <button type="button" className="lo-text-btn" onClick={() => onAnswer(false)} title="Esc"><Undo2 size={14} aria-hidden="true" />Keep original</button>
        <button type="button" className="lo-text-btn" onClick={onApproveAll} title="Use this candidate and every other one in this run"><CheckCheck size={14} aria-hidden="true" />Approve all</button>
      </>} />
    </section>
  )
}

export function VfxUpdaterPanel() {
  const [mods, setMods] = useState<Mod[] | null>(null)
  const [needs, setNeeds] = useState<Map<string, string>>(new Map()) // a mod's main file (norm) -> why it needs an update
  const [made, setMade] = useState<Map<string, boolean>>(new Map()) // a mod's main file (norm) this updater made for this game -> partial
  const [repairPolicy, setRepairPolicy] = useState(readRepairPolicy)
  const [askReview, setAskReview] = useState(readAskReview)
  const approveRest = useRef(false) // Approve all: the rest of this run's candidates are used without asking
  // Best effort candidates waiting for Use candidate or Keep original, oldest first: the batch goes on meanwhile
  const [reviews, setReviews] = useState<{ key: string; name: string; report: VfxReport; resolve: (accepted: boolean) => void }[]>([])
  const reviewsRef = useRef(reviews)
  reviewsRef.current = reviews
  const [stale, setStale] = useState<Map<string, number>>(new Map()) // a mod's .utoc (norm) -> its Niagara files an update will leave out
  // a mod's .utoc (norm) -> files it rebuilds that a patch newer than the USMAP changed: it waits for that patch's USMAP
  const [waits, setWaits] = useState<Map<string, number>>(new Map())
  const waitsRef = useRef(waits)
  waitsRef.current = waits
  const [runs, setRuns] = useState<Record<string, Run>>({}) // by norm(utoc)
  const [picked, setPicked] = useState<Set<string>>(new Set()) // norm(utoc)
  const [q, setQ] = useState('')
  const [hero, setHero] = useState('') // '' = every hero (the same filter as a loadout's Add mods)
  const [sort, setSort] = useState<'name' | 'newest'>(() => (localStorage.getItem(SORT) === 'name' ? 'name' : 'newest'))
  const [foldedIds, setFoldedIds] = useState<string[]>(GROUP_IDS)
  const loadouts = useLoadouts()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [paks, setPaks] = useState<string | null>(null)
  const [build, setBuild] = useState<GameBuild | null>(null)
  const [usmap, setUsmap] = useState<string | null>(null)
  const [usmapInfo, setUsmapInfo] = useState<Usmap | null>(null)
  const [usmapOk, setUsmapOk] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(true)
  const [naming, setNaming] = useState<Naming>(readNaming)
  const [originals, setOriginals] = useState<Originals>(readOriginals)
  const [safety, setSafety] = useState<Safety>(readSafety)
  const safeOff = safety !== 'on'
  const [moved, setMoved] = useState<LayoutNews | null>(null)
  useEffect(() => { void invoke<LayoutNews>('xtra_layout_moves').then(setMoved, () => {}) }, [usmapInfo])
  const keepName = naming === 'broken'
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  // the Library's mod checks (brokenMods.ts, the header's Checking mods): Scan starts them, this follows their progress
  const [scan, setScan] = useState<string | null>(null)
  useEffect(() => {
    const step = listen<ScanStep>('mod-scan-progress', e => setScan(progressLine(e.payload)))
    const done = listen(SCAN_DONE, () => { setScan(null); setReload(r => r + 1) })
    return () => { void step.then(f => f()); void done.then(f => f()) }
  }, [])
  const [cancelling, setCancelling] = useState(false)
  const [logs, setLogs] = useState<Log[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [batch, setBatch] = useState<string[]>([]) // the run in progress, in order
  const [lastTook, setLastTook] = useState<number | null>(null) // how long the last batch ran, for its end line
  // the last batch's result, kept in the footer until the ticks change (a failed or cancelled mod stays ticked, so the
  // footer would otherwise go straight back to before the run), with the mods to try again
  const [ended, setEnded] = useState<{ text: string; retry: string[]; edits: number } | null>(null)
  const [pickEdits, setPickEdits] = useState(0) // ticks changed by the user (not by a run)
  const pickEditsRef = useRef(0)
  pickEditsRef.current = pickEdits
  const [reload, setReload] = useState(0)
  // a newer USMAP (Check for updates, the automatic check, or a chosen file) can let waiting mods update: the list and
  // its flags are read again. Not on the first one, which the first read already uses
  const lastUsmap = useRef<string | null>(null)
  useEffect(() => {
    if (lastUsmap.current && usmap && usmap !== lastUsmap.current) setReload(n => n + 1)
    lastUsmap.current = usmap
  }, [usmap])
  const [loadError, setLoadError] = useState<string | null>(null) // the mods folder could not be read (the last list stays)
  const [scanProblems, setScanProblems] = useState<string[]>([]) // folders or mods the last read could not open
  const [held, setHeld] = useState<RunLock | null>(null) // who holds the run lock (prefs.ts), this window or another
  const myToken = useRef<string | null>(null) // this window's run, while it holds the lock
  const busyRef = useRef(false)
  const [uncertain, setUncertain] = useState(new Map<string, string>())
  const [checkError, setCheckError] = useState(false) // which mods need an update could not be checked
  const [, bump] = useState(0)
  const cancel = useRef(false)
  const seeded = useRef(false) // the mods that need an update are ticked once, when the list first arrives
  const handed = useRef<{ paths: string[]; start: boolean } | null>(null) // mods the main window sent, ticked once the list is in
  const autoRun = useRef<string[] | null>(null) // exactly the mods the Library's notice sent, updated as soon as possible
  const groupOf = useRef(new Map<string, string>()) // each shown mod's group, so a run can unfold where it works
  const runsRef = useRef(runs)
  const orderRef = useRef<string[]>([]) // the list's order, top to bottom, for the order a batch runs in
  const modStart = useRef(0) // when the mod updating now started
  const [, tick] = useState(0) // the time left counts down while a batch runs
  runsRef.current = runs
  const modsRef = useRef(mods)
  modsRef.current = mods
  // mods the list does not show (another type, or outside the mods folder), chosen by their .utoc: kept through reloads
  const [added, setAdded] = useState<Mod[]>([])
  const addedRef = useRef(added)
  addedRef.current = added

  useEffect(() => { if (!busy) return; const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t) }, [busy])
  const addLog = useCallback((text: string, type = 'info') => setLogs(l => [...l.slice(-999), { time: new Date().toLocaleTimeString(), text, type }]), [])
  const patch = (key: string, p: Partial<Run>) => setRuns(r => ({ ...r, [key]: { ...(r[key] ?? { status: 'waiting' }), ...p } }))
  const pick = (keys: string[], on: boolean) => setPicked(s => { const n = new Set(s); keys.forEach(k => (on ? n.add(k) : n.delete(k))); return n })
  const userPick = (keys: string[], on: boolean) => { pick(keys, on); setPickEdits(n => n + 1) }

  // where the game is, its build, the USMAP (checked against rivals-depot once, quietly)
  useEffect(() => {
    invoke<string | null>('get_game_path').then(dir => {
      if (!dir) return
      const cut = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'))
      setPaks(cut > 0 ? dir.slice(0, cut) : dir)
    }).catch(() => {})
    invoke<GameBuild>('xtra_game_build').then(setBuild).catch(() => {})
    invoke<{ usmapPath?: string | null }>('vfx_get_settings').then(s => { if (s?.usmapPath) setUsmap(s.usmapPath) }).catch(() => {})
    invoke<Usmap>('vfx_check_usmap_update', { force: false })
      .then(r => { setUsmapInfo(r); if (r.localPath && !r.skipped) setUsmap(r.localPath) })
      .catch(e => addLog(`USMAP check failed: ${e}`, 'warning'))
      .finally(() => setChecking(false))
  }, [addLog])

  // the game's file index loads while the list is read, so the first mod does not wait for it (xtra_vfx.rs xtra_vfx_warm)
  useEffect(() => { if (paks) void invoke('xtra_vfx_warm', { gamePaks: paks }).catch(() => {}) }, [paks])

  useEffect(() => {
    if (!usmap) { setUsmapOk(null); return }
    let live = true
    invoke<boolean>('vfx_usmap_exists', { path: usmap }).catch(() => false).then(ok => { if (live) setUsmapOk(ok) })
    return () => { live = false }
  }, [usmap, usmapInfo])

  // the mods folder's VFX mods and which need an update, again after each run (an updated mod no longer does). A folder
  // that cannot be read keeps the last list and says so with Try again, never an empty "no VFX mods"
  useEffect(() => {
    if (busy) return
    let live = true
    setLoadError(null)
    invoke<ModList>('xtra_vfx_mods')
      .then(async ({ mods: fresh, problems }) => {
        // a read that missed folders or mods keeps the list from before (when there is one), and says so with Try again
        // built-ins and project loaders never: the app that made them keeps them current
        const read = (problems.length && modsRef.current?.length ? modsRef.current : fresh).filter(m => !skipsUpdater(m.path))
        const listed = [...read, ...addedRef.current.filter(a => !read.some(m => norm(m.utoc) === norm(a.utoc)))]
        if (problems.length) addLog(`Part of the mods folder could not be read: ${problems.slice(0, 3).join('. ')}${problems.length > 3 ? ` and ${problems.length - 3} more` : ''}`, 'warning')
        // every other mod too: one that may crash and is on is listed, and Update turns it off (nothing here rebuilds it)
        const all = await invoke<PakFile[]>('get_pak_files').catch(() => [] as PakFile[])
        let verdicts: Verdict[] = [], failed = false
        try { verdicts = await invoke<Verdict[]>('xtra_broken_mods', { modPaths: [...new Set([...listed, ...all].map(m => m.path))] }) } catch (e) { failed = true; addLog(`Could not check which mods need an update: ${e}`, 'warning') }
        const ours = await invoke<{ path: string; partial: boolean; current: boolean }[]>('xtra_made_mods', { modPaths: listed.map(m => m.path) }).catch(() => [])
        if (!live) return
        const inList = new Set(listed.map(m => norm(m.path)))
        const files = new Map(all.map(m => [norm(m.path), m]))
        const risky: Mod[] = verdicts.filter(v => v.kind === 'risky' && !inList.has(norm(v.path)) && /\.pak$/i.test(v.path) && !skipsUpdater(v.path)).map(v => {
          const m = files.get(norm(v.path))
          return { path: v.path, utoc: m?.utoc_path || utocOf(v.path), enabled: true, name: m?.custom_name?.trim() || fileName(v.path).replace(/\.[^.]+$/, '').replace(/(_\d+)?_P$/i, ''),
            hero: m?.character_name ?? null, modified: m?.modified_date, risky: v.reason }
        })
        // a listed mod with a May crash nothing here fixes (a mesh with bones its skeleton lacks): turned off, not rebuilt
        const offOnly = new Map(verdicts.filter(v => v.offOnly).map(v => [norm(v.path), v.reason]))
        // off too: rebuilt, it would come back on (it was turned off to stay safe) with the same mesh
        const list = [...listed.map(m => (offOnly.has(norm(m.path)) ? { ...m, risky: offOnly.get(norm(m.path)) } : m)), ...risky]
        // a VFX or material mod that may crash and is on is rebuilt like one that needs an update (its blueprints on the
        // game's): the same mods the Library's notice counts
        const n = new Map(verdicts.filter(v => needsUpdater(v.path, v)).map(v => [norm(v.path), v.reason]))
        const utocs = new Map(list.map(m => [norm(m.path), norm(m.utoc)]))
        setStale(new Map(verdicts.filter(v => v.kind === 'vfx' && v.staleNiagara && utocs.has(norm(v.path))).map(v => [utocs.get(norm(v.path))!, v.staleNiagara!])))
        setWaits(new Map(verdicts.filter(v => v.kind === 'vfx' && v.usmapWait && utocs.has(norm(v.path))).map(v => [utocs.get(norm(v.path))!, v.usmapWait!])))
        setMods(list)
        setScanProblems(problems)
        setUncertain(new Map(verdicts.filter(v => v.kind === 'unknown').map(v => [norm(v.path), v.reason])))
        setNeeds(n)
        setMade(new Map(ours.filter(x => x.current).map(x => [norm(x.path), x.partial])))
        const present = new Set(list.map(m => norm(m.utoc)))
        setPicked(p => { const kept = [...p].filter(k => present.has(k)); return kept.length === p.size ? p : new Set(kept) }) // an update elsewhere can rename or remove one
        setCheckError(failed)
        if (!seeded.current && !failed) {
          seeded.current = true
          pick(list.filter(m => n.has(norm(m.path))).map(m => norm(m.utoc)), true) // every flagged mod: one Update covers them all
        }
      })
      .catch(e => { if (live) { setLoadError(String(e)); setMods(m => m ?? []); addLog(`Could not read the mods folder: ${e}`, 'error') } })
    return () => { live = false }
  }, [busy, reload, addLog])

  // mods handed over by the main window: ticked (once the list is in), and updated at once from the Library's notice
  useEffect(() => {
    const take = (h: { paths: string[]; start: boolean }) => { if (h.paths.length) handed.current = h }
    const h = takeHandoff()
    if (h) take(h)
    return onHandoff(h => { take(h); bump(n => n + 1) }) // a render, so the effect below sees it
  }, [])
  useEffect(() => {
    const h = handed.current
    if (!h || !mods) return
    handed.current = null
    const want = new Map(h.paths.map(p => [norm(utocOf(p)), p]))
    const listed = new Set(mods.map(m => norm(m.utoc)))
    // a mod the list does not show joins it under Chosen files, as one chosen with Add .utoc
    const fresh = [...want].filter(([k]) => !listed.has(k)).map(([, p]) => chosenMod(utocOf(p), /\.utoc$/i.test(p) ? undefined : p))
    if (fresh.length) { setAdded(a => [...a, ...fresh]); setMods(m => [...(m ?? []), ...fresh]) }
    const keys = [...want.keys()]
    seeded.current = true
    userPick(keys, true)
    if (h.start && keys.length) autoRun.current = [...new Set([...(autoRun.current ?? []), ...keys])] // these, not whatever else is ticked
  })

  // the run lock's holder: a right-click update in the main window makes Update wait (and say so), and its end frees it
  useEffect(() => { void runLock().then(setHeld); return onRunChange(setHeld) }, [])
  busyRef.current = busy

  // an update elsewhere (a right-click update) changed the mods folder: read it again (this window's own runs reload
  // when they end)
  useEffect(() => {
    const un = listen('mods_dir_changed', () => { if (!busyRef.current) setReload(n => n + 1) })
    return () => { un.then(f => f()) }
  }, [])

  // a right-click update's report, opened from its toast (Show report): shown under its mod, open
  useEffect(() => {
    const show = (r: VfxReport) => {
      const key = norm(utocOf(r.placed?.fixed ?? r.mod))
      setRuns(rs => ({ ...rs, [key]: { status: r.status, report: r } }))
      setOpen(o => new Set(o).add(key))
      setFoldedIds(f => (f.includes('needs') ? f.filter(x => x !== 'needs') : f))
      setReload(n => n + 1)
      setTimeout(() => document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 600)
    }
    const r = takeReport()
    if (r) show(r)
    return onReport(show)
  }, [])

  // Rust steps report inside the step (types read so far)
  useEffect(() => {
    const un = listen<{ message: string }>('vfx_progress', e => {
      const key = Object.keys(runsRef.current).find(k => runsRef.current[k].status === 'running')
      if (key && e.payload?.message) patch(key, { sub: e.payload.message })
    })
    return () => { un.then(f => f()) }
  }, [])

  const usmapCheck = async (force: boolean) => {
    setChecking(true)
    try {
      const r = await invoke<Usmap>('vfx_check_usmap_update', { force })
      setUsmapInfo(r)
      if (r.localPath && !r.skipped) setUsmap(r.localPath)
      addLog(r.message, r.updated || r.upToDate ? 'success' : 'warning')
    } catch (e) { addLog(`USMAP fetch failed: ${e}`, 'warning') } finally { setChecking(false) }
  }

  const browseUsmap = async () => {
    const { open: choose } = await import('@tauri-apps/plugin-dialog')
    const p = await choose({ multiple: false, filters: [{ name: 'USMAP', extensions: ['usmap'] }] })
    if (typeof p !== 'string') return
    setUsmapInfo(null) // its version, date and Up to date described the downloaded file, not this one
    setUsmap(p)
    const current = await invoke<Record<string, unknown>>('vfx_get_settings').catch(() => ({}))
    await invoke('vfx_save_settings', { settings: { ...current, usmapPath: p } }).catch(() => {}) // keeps the auto-update bookkeeping
  }

  // any mod by its .utoc, ticked: one in the list is just ticked, any other joins it under Chosen files
  const addUtoc = async () => {
    const { open: choose } = await import('@tauri-apps/plugin-dialog')
    const p = await choose({ multiple: true, filters: [{ name: 'IoStore mod', extensions: ['utoc'] }] })
    const paths = p ? (Array.isArray(p) ? p : [p]) : []
    if (!paths.length) return
    const listed = new Set((modsRef.current ?? []).map(m => norm(m.utoc)))
    const fresh = [...new Map(paths.filter(u => !listed.has(norm(u))).map(u => [norm(u), chosenMod(u)])).values()]
    if (fresh.length) { setAdded(a => [...a, ...fresh]); setMods(m => [...(m ?? []), ...fresh]) }
    setQ('')
    userPick(paths.map(norm), true)
  }

  const elsewhere = busy || !held || held.token === myToken.current ? null : held
  const lock = busy ? null : elsewhere ? `${elsewhere.name === CHECK_RUN ? 'Rechecking mods' : `Updating ${elsewhere.name ?? 'a mod'}`} elsewhere. Update waits for it.` : checking ? 'Checking for a newer USMAP…' : !usmap ? 'Choose a USMAP file in Advanced first' : usmapOk === false ? 'The USMAP file is missing' : !paks ? 'Set the game folder in Setup first' : null

  const run = useCallback(async (keys?: string[]) => {
    const byKey = new Map((modsRef.current ?? []).map(m => [norm(m.utoc), m]))
    const rank = new Map(orderRef.current.map((k, i) => [k, i]))
    const asked = (keys ?? [...picked].filter(k => !isDone(runsRef.current[k]?.status))).filter(k => byKey.has(k))
    const todo = asked.filter(k => !waitsRef.current.has(k))
      .sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity)) // top of the list first
    const skipped = asked.length - todo.length // their update waits for the USMAP of this game build
    if (skipped) addLog(`${plural(skipped, 'mod')} ${skipped === 1 ? 'waits' : 'wait'} for the USMAP of this game build and ${skipped === 1 ? 'was' : 'were'} skipped.`, 'warning')
    if (!todo.length || !usmap || !paks) return
    const token = newRunToken()
    if (!(await claimRun(token, byKey.get(todo[0])?.name))) { addLog('Another update is running. Try again when it is done.', 'warning'); return }
    myToken.current = token
    // the run in view: a search that hides a mod clears, and Needs an update and the groups of the mods it runs unfold
    if (todo.some(k => !groupOf.current.has(k))) setQ('')
    const unfold = new Set(['needs', ...todo.map(k => groupOf.current.get(k) ?? '')])
    setFoldedIds(f => (f.some(id => unfold.has(id)) ? f.filter(id => !unfold.has(id)) : f))
    setBusy(true); setBatch(todo); setLastTook(null); setEnded(null); cancel.current = false; approveRest.current = false
    const startedAt = performance.now()
    todo.forEach(k => patch(k, { status: 'waiting', step: undefined, sub: undefined, report: undefined }))
    setOpen(o => { const n = new Set(o); todo.forEach(k => n.delete(k)); return n }) // a retried mod's new result starts folded too
    const filter = readFilter()
    let fixed = 0, failed = 0, partial = 0, cleared = 0, turnedOff = 0 // cleared: Nothing to update, so no longer flagged
    const retry: string[] = [], stopped: string[] = [], broke: string[] = [], kept: string[] = []
    const parked: Promise<void>[] = [] // updates waiting on a review, finished when it is answered
    // what a finished update changes: its row, the counts and the main window
    const finish = async (key: string, r: VfxReport) => {
      patch(key, { status: r.status, report: r, sub: undefined })
      // its report stays folded under its pill, a problem too: the pill says what happened, a click shows why
      if (r.status !== 'cancelled' && r.ms > 0) rememberTime(r.assets.some(a => /^(NS|NE)_/i.test(a.name)), r.ms)
      if (r.status === 'fixed') { fixed++; pick([key], false) }
      if (r.status === 'nothing') cleared++
      if (r.turnedOff) turnedOff++
      if (r.status === 'failed' || isPartial(r)) failed++ // a partial update is a warning too
      if (isPartial(r)) partial++
      if (r.status === 'failed') { broke.push(key); retry.push(key) }
      if (r.status === 'cancelled') { stopped.push(key); retry.push(key) }
      if (r.status === 'declined') { kept.push(key); pick([key], false) } // the user's choice, not a failure: tick it again to retry
      // the main window reloads and moves loadouts from the original to the update (a no-op when the update kept the name)
      if (r.placed) await emitTo('main', FIXED_EVENT, { from: r.placed.source, to: r.placed.fixed, swap: true, original: r.placed.original } satisfies Fixed).catch(() => {})
      // an update named _UPDATED is a new file and its original leaves the list: its result moves with it
      const moved = r.placed ? norm(utocOf(r.placed.fixed)) : key
      if (moved !== key) {
        setRuns(rs => { const { [key]: v, ...rest } = rs; return v ? { ...rest, [moved]: v } : rs })
        setOpen(o => { if (!o.has(key)) return o; const n = new Set(o); n.delete(key); n.add(moved); return n })
        setBatch(b => b.map(x => (x === key ? moved : x)))
        const fixedFile = r.placed!.fixed
        setAdded(a => a.map(m => (norm(m.utoc) === key ? chosenMod(utocOf(fixedFile), fixedFile) : m))) // a chosen mod's update stays in the list
      }
    }
    for (const key of todo) {
      if (cancel.current) { patch(key, { status: 'cancelled' }); stopped.push(key); retry.push(key); continue }
      const mod = byKey.get(key)!
      void claimRun(token, mod.name) // the lock says which mod, for the other window's message
      if (mod.risky) {
        // nothing here rebuilds it: off (then to Recently deleted, as Safety says), so it cannot crash the game, and its May crash flag says why
        const off = await retireUnsafe(mod.path, `May crash: ${mod.risky}`, safety === 'trash').then(out => ({ ok: true, trashed: out === 'trashed', why: '' }), e => ({ ok: false, trashed: false, why: String(e) }))
        const report: VfxReport = { mod: mod.utoc, name: mod.name, status: off.ok ? 'nothing' : 'failed', turnedOff: off.ok, trashed: off.trashed,
          error: off.ok ? `May crash: ${mod.risky} ${off.trashed ? 'Moved to Recently deleted' : 'Turned off'}, so it cannot crash the game.` : `Could not turn it off: ${off.why}`,
          assets: [], warnings: [], counts: { updated: 0, same: 0, added: 0, passed: 0, left: 0, ownGame: 0, unreadable: 0, changes: 0, relaid: 0 }, ms: 0, steps: [] }
        patch(key, { status: report.status, report })
        addLog(off.ok ? `${off.trashed ? 'Moved' : 'Turned'} ${mod.name} ${off.trashed ? 'to Recently deleted' : 'off'}: it may crash the game.` : `${mod.name}: ${report.error}`, 'warning')
        if (off.ok) { turnedOff++; pick([key], false) } else { failed++; broke.push(key); retry.push(key) }
        continue
      }
      patch(key, { status: 'running', step: 1 })
      modStart.current = performance.now()
      addLog(`Updating ${mod.name}`)
      let asked = () => {}
      const parks = new Promise<null>(r => { asked = () => r(null) })
      const job = fixVfxMod({
        // a candidate joins the review card at the top (with a sound, and the taskbar flashes when the window is behind)
        // and the batch goes on: its update finishes once Use candidate or Keep original is pressed
        // after Cancel, a candidate that finishes packing keeps its original at once: no card waits for an answer
        // with Ask me to review candidates off (the default) the pipeline decides (autoAccept), after Approve all every candidate goes in
        policy: repairPolicy, autoAccept: !askReview, review: report => cancel.current ? Promise.resolve(false) : approveRest.current ? Promise.resolve(true) : new Promise(resolve => {
          asked()
          patch(key, { status: 'review', sub: undefined })
          setReviews(q => [...q, { key, name: mod.name, report, resolve: ok => { if (ok) patch(key, { status: 'running', step: STEPS.length }); resolve(ok) } }])
          addLog(`${mod.name}: a candidate waits for your review at the top.`, 'warning')
          cue('warning')
          void import('@tauri-apps/api/window').then(({ getCurrentWindow, UserAttentionType }) => getCurrentWindow().requestUserAttention(UserAttentionType.Informational)).catch(() => {})
        }),
        modPath: mod.utoc, usmapPath: usmap, gamePaksPath: paks, turnOffOriginal: originals !== 'keep', trashOriginal: originals === 'trash', keepName, filter,
        safeOff: safeOff && needs.has(norm(mod.path)), // only a flagged mod: an unflagged one that fails stays as it was
        trashUnsafe: safety === 'trash',
        log: addLog, cancelled: () => cancel.current,
        onStep: s => patch(key, { step: s.step, sub: undefined }),
        onProgress: (_, __, message) => patch(key, { sub: message }),
      })
      const r = await Promise.race([job, parks])
      if (r) await finish(key, r)
      else parked.push(job.then(done => finish(key, done)))
    }
    await Promise.all(parked) // the batch ends once every review is answered
    if (fixed || turnedOff) await emit('mods_dir_changed').catch(() => {})
    if (cleared || fixed || turnedOff) await verdictsChanged() // the Library reads the flags again
    await releaseRun(token)
    myToken.current = null
    setLastTook(performance.now() - startedAt)
    const parts = [
      `${fixed === todo.length ? plural(fixed, 'mod') : `${fixed} of ${plural(todo.length, 'mod')}`} updated${partial ? ` (${partial === fixed ? (fixed === 1 ? 'partially' : 'all partially') : `${partial} partially`})` : ''}`,
      broke.length ? `${broke.length} failed` : '', turnedOff ? `${turnedOff} taken out of the game so ${turnedOff === 1 ? 'it' : 'they'} cannot crash it` : '', stopped.length ? `${stopped.length} cancelled` : '',
      kept.length ? `${kept.length} kept as ${kept.length === 1 ? 'it was' : 'they were'}` : '',
    ].filter(Boolean)
    setEnded({ text: `${parts.join(', ')}${parts.length > 1 ? ',' : ''} in ${took(performance.now() - startedAt)}.`, retry, edits: pickEditsRef.current })
    cue(failed ? 'warning' : 'success', { emphasis: fixed > 1 ? undefined : 'subtle' }) // a problem is a warning, never an error sound
    setBusy(false); setCancelling(false)
  }, [picked, usmap, paks, originals, keepName, safety, needs, repairPolicy, askReview, addLog])

  // the Library's notice updates exactly the mods it sent, as soon as the list and the USMAP are ready (after a run in
  // progress)
  useEffect(() => {
    if (autoRun.current && mods && !lock && !busy) { const keys = autoRun.current; autoRun.current = null; void run(keys) }
  }, [mods, lock, busy, run])

  const showAdvanced = (on: boolean) => {
    setAdvanced(on)
    if (on) setTimeout(() => document.querySelector('.vf-adv')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
  }

  // the oldest candidate's answer: Escape keeps its original and the batch goes on. Cancel keeps every one's original
  const answer = (ok: boolean) => { const [first, ...rest] = reviewsRef.current; if (!first) return; setReviews(rest); reviewsRef.current = rest; first.resolve(ok); cue(ok ? 'success' : 'tap') }
  const decline = () => answer(false)
  const approveAll = () => { approveRest.current = true; const all = reviewsRef.current; setReviews([]); reviewsRef.current = []; all.forEach(r => r.resolve(true)); cue('success') }
  const stop = (source: 'Cancel button' | 'Escape') => { reviewsRef.current.forEach(r => r.resolve(false)); setReviews([]); reviewsRef.current = []; cancel.current = true; setCancelling(true); addLog(`Cancellation requested by ${source}. Stopping after the current step.`, 'warning') }

  // Scan: the ticked mods' check records go, then the header's run reads them fresh (with every mod not checked yet)
  const scanTicked = async () => {
    const paths = (modsRef.current ?? []).filter(m => picked.has(norm(m.utoc))).map(m => m.path)
    if (!paths.length) return
    setScan('Getting ready')
    cue('select')
    await invoke('xtra_scan_forget', { modPaths: paths }).catch(e => addLog(`Could not clear the earlier checks: ${e}`, 'warning'))
    addLog(`Checking ${plural(paths.length, 'mod')} again. Progress also shows in the main window's header.`)
    await rescanForced(paths)
  }

  // Ctrl+Enter updates the ticked mods. Escape stops repairs only. Scans require the Cancel button.
  const keys = useRef({ go: () => {}, stop: () => {} })
  const updateWidth = useRef(0) // Update's width when pressed: while it runs it keeps it, so Cancel never moves under the pointer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); keys.current.go() }
      else if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && !e.defaultPrevented) keys.current.stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const copy = async (what: 'report' | 'log') => {
    const text = what === 'log' ? logs.map(l => `[${l.time}] ${l.text}`).join('\n') : Object.values(runs).filter(r => r.report).map(r => reportText(r.report!)).join('\n\n')
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(what); setTimeout(() => setCopied(null), 3000)
  }

  // the list: mods that need an update first, then A to Z or newest first
  const needsOf = (m: Mod) => needs.get(norm(m.path))
  const order = (a: Mod, b: Mod) => (sort === 'newest' ? (b.modified ?? 0) - (a.modified ?? 0) : 0) || a.name.localeCompare(b.name)
  const list = [...(mods ?? [])].sort((a, b) => Number(Boolean(needsOf(b))) - Number(Boolean(needsOf(a))) || order(a, b))
  const sortBy = (v: 'name' | 'newest') => { setSort(v); localStorage.setItem(SORT, v) }
  const needle = q.trim().toLowerCase()
  const heroes = [...new Set(list.map(m => heroOfName(m.hero)).filter(Boolean))].sort()
  const shown = list.filter(m => (!needle || m.name.toLowerCase().includes(needle) || (m.hero ?? '').toLowerCase().includes(needle)) && (!hero || heroOfName(m.hero) === hero))
  // ticked mods the search or hero filter hides: Update still takes them, so the footer says so (and shows them in one click)
  const shownKeys = new Set(shown.map(m => norm(m.utoc)))
  const hiddenTicked = needle || hero ? [...picked].filter(k => !shownKeys.has(k)).length : 0
  // three groups: the mods that need an update (with any that ran this session and did not update), the ones updated this
  // session, the rest
  const updatedNow = (m: Mod) => runs[norm(m.utoc)]?.status === 'fixed'
  const addedKeys = new Set(added.map(m => norm(m.utoc)))
  const isAdded = (m: Mod) => !updatedNow(m) && addedKeys.has(norm(m.utoc)) // chosen by hand, above the rest
  // every mod that needs an update, whatever its kind (VFX, UI, material, or May crash to turn off), with any that ran
  // this session and did not update; the rest sorted by kind below
  const first = (m: Mod) => !updatedNow(m) && !isAdded(m) && Boolean(needsOf(m) || runs[norm(m.utoc)])
  const group = (id: string, title: string, ms: Mod[], count = ms.length) => {
    const keys = ms.map(m => norm(m.utoc))
    return { id, title, mods: ms, count, keys, all: keys.length > 0 && keys.every(k => picked.has(k)), none: !keys.some(k => picked.has(k)) }
  }
  const needing = shown.filter(first)
  const done = shown.filter(updatedNow)
  const chosen = shown.filter(isAdded)
  const unknown = shown.filter(m => !first(m) && !isAdded(m) && !updatedNow(m) && uncertain.has(norm(m.path)))
  const others = shown.filter(m => !uncertain.has(norm(m.path)) && !first(m) && !updatedNow(m) && !isAdded(m))
  groupOf.current = new Map(shown.map(m => [norm(m.utoc), updatedNow(m) ? 'updated' : isAdded(m) ? 'added' : first(m) ? 'needs' : uncertain.has(norm(m.path)) ? 'unknown' : m.ui ? 'ui' : m.materials ? 'materials' : 'rest']))
  const groups = [
    group('added', 'Chosen files', chosen),
    group('needs', 'Needs an update', needing, needing.filter(m => needsOf(m) && !isDone(runs[norm(m.utoc)]?.status)).length),
    // the ones that need nothing, by kind
    group('unknown', verdictLabel('unknown'), unknown),
    group('rest', 'VFX mods', others.filter(m => !m.materials)),
    // UI mods listed for their UI materials (a game update rewrote nearly all of them in 3984769)
    group('ui', 'UI mods', others.filter(m => m.ui)),
    // skins listed for their material instances
    group('materials', 'Material mods', others.filter(m => m.materials && !m.ui)),
    group('updated', 'Updated', done), // last: what is done goes below what is left to do
  ]
  const inLoadouts = (m: Mod) => { const k = canonKey(modKey(m.path)); return loadouts.filter(l => l.on.some(x => canonKey(x) === k)).map(l => ({ id: l.id, name: l.name })) }
  const fold = (id: string) => setFoldedIds(f => (f.includes(id) ? f.filter(x => x !== id) : [...f, id]))
  // a ticked mod that waits for the USMAP is skipped by Update, so it is not counted (its tick shows off)
  const todo = [...picked].filter(k => !isDone(runs[k]?.status) && !waits.has(k)).length
  const runningAt = batch.findIndex(k => runs[k]?.status === 'running')
  const reports = Object.values(runs).filter(r => r.report)
  const updated = reports.filter(r => r.status === 'fixed').length
  const partly = reports.filter(r => isPartial(r.report)).length
  const cl = usmapCl(usmap ? fileName(usmap) : null) // the file in use, not the last download
  const behind = cl && build?.cl && cl < build.cl
  // old Niagara files are rebuilt once the USMAP matches the game: only a USMAP older than the game makes an update partial
  const partialTodo = behind ? [...picked].filter(k => !isDone(runs[k]?.status) && stale.has(k)).length : 0
  const usmapState = checking ? 'Checking for a newer one…' : !usmap ? 'None chosen' : usmapOk === false ? 'File missing' : usmapInfo?.upToDate || usmapInfo?.updated ? 'Up to date' : 'Ready'
  const usmapMissing = !checking && (!usmap || usmapOk === false)
  const runningKey = batch.find(k => runs[k]?.status === 'running')
  const runningMod = runningKey ? (mods ?? []).find(m => norm(m.utoc) === runningKey) : undefined
  const rest = list.filter(m => !first(m) && !isAdded(m))
  orderRef.current = [...list.filter(isAdded), ...list.filter(first), ...rest.filter(m => !m.materials), ...rest.filter(m => m.ui), ...rest.filter(m => m.materials && !m.ui)].map(m => norm(m.utoc))
  const byUtoc = new Map((mods ?? []).map(m => [norm(m.utoc), m]))
  const times = readTimes()
  // while a batch runs: the mod in progress (its expected time less the time it has run) and the ones after it
  const left = busy ? (() => {
    const rest = batch.slice(runningAt + 1).map(k => expected(times, byUtoc.get(k)?.niagara))
    const now = runningAt >= 0 ? expected(times, byUtoc.get(batch[runningAt])?.niagara) : 0
    if (now === undefined || rest.some(x => x === undefined)) return undefined
    return Math.max(0, now - (performance.now() - modStart.current)) + rest.reduce<number>((a, b) => a + (b ?? 0), 0)
  })() : undefined
  // before Update: what the ticked mods should take
  const ahead = !busy && todo ? (() => {
    const xs = [...picked].filter(k => !isDone(runs[k]?.status) && !waits.has(k)).map(k => expected(times, byUtoc.get(k)?.niagara))
    return xs.some(x => x === undefined) ? undefined : xs.reduce<number>((a, b) => a + (b ?? 0), 0)
  })() : undefined
  const state = cancelling ? 'Cancelling. The current step finishes first.'
    : busy && runningAt < 0 && reviews.length ? `Waiting for your review of ${plural(reviews.length, 'candidate')} at the top`
    : busy ? `Updating ${runningAt + 1} of ${batch.length}${runningMod ? `: ${runningMod.name}` : '…'}${left !== undefined ? `. ${timeLeft(left).replace(/^./, c => c.toUpperCase())} left` : ''}` // its row shows the step
      : scan ? `Checking mods: ${scan}` : lock ?? (todo ? '' : reports.length ? `${updated === reports.length ? plural(updated, 'mod') : `${updated} of ${plural(reports.length, 'mod')}`} updated${partly ? ` (${partly === updated ? (updated === 1 ? 'partially' : 'all partially') : `${partly} partially`})` : ''}${lastTook ? ` in ${took(lastTook)}` : ''}` : 'Tick the mods to update')

  // the last batch's result, until the ticks change
  const summary = !busy && !scan && !lock && ended && ended.edits === pickEdits ? ended : null
  keys.current = { go: () => { if (!busy && !lock && todo) void run() }, stop: () => { if (reviews.length) decline(); else if (busy && !cancelling) stop('Escape') } }
  const openUsmap = () => showAdvanced(true)

  // what Update will do to the files, beside the button, so a choice made once in Advanced is never a surprise
  const policy = naming === 'broken'
    ? { off: 'Originals get _BROKEN and turn off', trash: 'Originals get _BROKEN and go to Recently deleted', keep: 'Originals get _BROKEN and stay as they are' }[originals]
    : { off: 'Updates get _UPDATED, originals turn off', trash: 'Updates get _UPDATED, originals go to Recently deleted', keep: 'Updates get _UPDATED, originals stay as they are' }[originals]

  return (
    <div className="vf-panel">
      <div className="vf-body">
        {reviews[0] && <ReviewCard key={reviews[0].key} name={reviews[0].name} report={reviews[0].report} more={reviews.length - 1} onAnswer={answer} onApproveAll={approveAll} />}
        <div className="lp-filters vf-filters">
          {/* always there, while the folder is read and while mods update too, so the bar never appears or goes under the pointer */}
          <label className="lp-search vf-search">
            <Search size={15} aria-hidden="true" />
            <input value={q} placeholder="Search mods" aria-label="Search mods" onChange={e => setQ(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setQ('') }} />
            {q && <button type="button" className="lo-icon vf-search-clear" onClick={() => setQ('')} aria-label="Clear the search" title="Clear the search"><X size={14} /></button>}
          </label>
          <HeroFilter heroes={heroes} value={hero} onChange={setHero} always />
          <div className="mod-state-filter lp-sort" role="group" aria-label="Sort mods">
            <button type="button" aria-pressed={sort === 'newest'} onClick={() => sortBy('newest')}>Newest</button>
            <button type="button" aria-pressed={sort === 'name'} onClick={() => sortBy('name')}>A to Z</button>
          </div>
          <button type="button" className="lo-text-btn is-primary vf-add" disabled={busy || mods === null} onClick={() => void addUtoc()}
            title="Update a mod this list does not show: choose its .utoc file"><FilePlus size={14} aria-hidden="true" /> Add .utoc</button>
        </div>
        {loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>The mods folder could not be read{mods?.length ? ', so this is the list from before' : ''}. {loadError.replace(/[.!]?\s*$/, '.')}{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {scanProblems.length > 0 && !loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Part of the mods folder could not be read, so some mods may be missing here. The Log names {scanProblems.length === 1 ? 'it' : `all ${scanProblems.length}`}.{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {checkError && !loadError && (
          <p className="vf-warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Which mods need an update could not be checked, so none are marked.{' '}
              <button type="button" className="su-link" disabled={busy} onClick={() => setReload(n => n + 1)}>Try again</button></span>
          </p>
        )}
        {behind && !usmapMissing && (
          <p className="vf-warn" role="note">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>The USMAP is for game build {cl} and the game is on {build!.cl}. {waits.size
              ? `${plural(waits.size, 'mod')} ${waits.size === 1 ? 'uses' : 'use'} files this update changed and ${waits.size === 1 ? 'waits' : 'wait'} for the new USMAP. Every other mod updates now`
              : 'This update did not change the files any of these mods rebuild, so they all update now'}.{' '}
              <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)}>{checking ? 'Checking…' : 'Check for updates'}</button></span>
          </p>
        )}
        {mods === null
          ? <ModRowsSkeleton />
          : shown.length === 0
            ? (loadError && !needle ? null : <p className="lp-empty">{needle || hero ? `No mods match${needle ? ` “${q.trim()}”` : ''}${hero ? ` for ${hero}` : ''}.` : 'No VFX mods in the mods folder. VFX mods and mods with material instances (MI_ files) appear here. Add .utoc takes any other mod.'}</p>)
            : <div className="vf-groups">{groups.map(g => g.mods.length > 0 && (
              <Group key={g.id} title={g.title} count={g.count} tone={g.id === 'needs' ? 'needs' : g.id === 'updated' ? 'done' : undefined} busy={busy} all={g.all} none={g.none}
                open={Boolean(needle || hero) || !foldedIds.includes(g.id)} onFold={() => fold(g.id)} onPick={on => userPick(g.keys, on)}>
                <ul className="mod-rows vf-rows">
                  {g.mods.map(m => {
                    const key = norm(m.utoc)
                    return (
                      <Row key={key} rowKey={key} mod={m} loadouts={inLoadouts(m)} run={runs[key]} needs={needsOf(m) ?? uncertain.get(norm(m.path))} partial={behind ? stale.get(key) : undefined} waits={waits.get(key)} made={made.get(norm(m.path))} picked={picked.has(key)} open={open.has(key)} busy={busy}
                        onPick={v => userPick([key], v)} onUsmap={openUsmap}
                        onToggle={() => setOpen(o => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n })}
                        onRetry={() => void run([key])} />
                    )
                  })}
                </ul>
              </Group>
            ))}</div>}

        {usmapMissing && (
          <p className="vf-warn">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>{usmap ? 'The USMAP file is missing.' : 'No USMAP yet.'} Updates need the game's property layout.{' '}
              <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)}>Fetch latest</button> or{' '}
              <button type="button" className="su-link" disabled={busy} onClick={browseUsmap}>browse for one</button>.</span>
          </p>
        )}

        <section className={`ia vf-adv${advanced ? ' is-open' : ''}`}>
          <h2 className="vf-adv-title">
            <button type="button" className="ia-toggle" aria-expanded={advanced} onClick={() => showAdvanced(!advanced)}>
              <ChevronRight size={15} className="ia-caret" aria-hidden="true" />
              Advanced
            </button>
          </h2>
          <div className="t-acc-panel" data-open={advanced}>
            <div className="t-acc-panel-inner" {...folded(!advanced)}>
              <div className="vf-adv-body">
                <Section icon={<Check size={15} aria-hidden="true" />} title="Repair policy" about="Which checks must pass before an update can replace the original.">
                  <Seg label="Repair policy" value={repairPolicy} disabled={busy}
                    note={repairPolicy === 'strict' ? 'Strict refuses incomplete output and warnings.' : askReview ? 'Best effort builds a candidate and asks you to review it before it replaces the original.' : "Best effort builds a candidate and uses it in place of the original. Its report lists what could not be proven."}
                    options={[['strict', 'Strict'], ['bestEffort', 'Best effort']]}
                    onChange={v => { setRepairPolicy(v); localStorage.setItem(REPAIR_POLICY, v) }} />
                </Section>

                <Section icon={<Eye size={15} aria-hidden="true" />} title="Ask me to review candidates" about="Whether a Best effort candidate waits for you before it replaces the original.">
                  <Seg label="Ask me to review candidates" value={askReview ? 'on' : 'off'} disabled={busy || repairPolicy === 'strict'}
                    note={repairPolicy === 'strict' ? 'Strict makes no candidates to review.' : askReview ? 'Each candidate waits at the top with Use candidate, Keep original, and Approve all.' : 'Off: candidates are used without asking.'}
                    options={[['off', 'Off'], ['on', 'On']]}
                    onChange={v => { setAskReview(v === 'on'); localStorage.setItem(ASK_REVIEW, v === 'on' ? '1' : '0') }} />
                </Section>

                <Section icon={<Tag size={15} aria-hidden="true" />} title="Names" about="Which copy keeps the mod's name after an update.">
                  <Seg label="Names" value={naming} disabled={busy} note={NAMING_NOTE[naming]}
                    options={[['broken', 'The update keeps it'], ['updated', 'The original keeps it']]}
                    onChange={v => { setNaming(v); localStorage.setItem(KEEP_NAME, v === 'broken' ? '1' : '0') }} />
                </Section>

                <Section icon={<Archive size={15} aria-hidden="true" />} title="Originals" about="What happens to a mod once its update is in.">
                  <Seg label="Originals" value={originals} disabled={busy} note={ORIGINALS_NOTE[originals]}
                    options={[['off', 'Turn off'], ['trash', 'Move to Recently deleted'], ['keep', 'Leave as they are']]}
                    onChange={v => { setOriginals(v); localStorage.setItem(ORIGINALS, v) }} />
                </Section>

                <Section icon={<AlertTriangle size={15} aria-hidden="true" />} title="Safety" about="What happens to a flagged mod an update could not make safe.">
                  <Seg label="Safety" value={safety} disabled={busy}
                    note={{ trash: 'It is turned off and moved to Recently deleted, so it cannot crash the game. Restore it in Settings within 7 days.', off: 'It is turned off, so it cannot crash the game. Its flag stays, and you can update it again later.', on: 'It stays on as it was, and can crash the game.' }[safety]}
                    options={[['trash', 'Move to Recently deleted'], ['off', 'Turn it off'], ['on', 'Leave it on']]}
                    onChange={v => { setSafety(v); localStorage.setItem(SAFE_OFF, v === 'trash' ? 'trash' : v === 'off' ? '1' : '0') }} />
                </Section>

                <Section icon={<MapIcon size={15} aria-hidden="true" />} title="USMAP"
                  about="The game's property layout. Updates read the game's files with it.">
                  <div className="vf-usmap">
                    {/* older than the game: a warning mark, never the green check */}
                    <span className={`su-part-mark${usmapOk && !behind ? ' is-ok' : ''}${usmapOk && behind ? ' is-behind' : ''}`} role="img" aria-label={!usmapOk ? 'Missing' : behind ? 'Older than the game' : 'Ready'}>
                      {usmapOk && (behind ? <AlertTriangle size={13} strokeWidth={2.25} /> : <Check size={14} strokeWidth={2.5} />)}
                    </span>
                    <div className="su-part-text">
                      <b title={usmap ?? undefined}>{usmap ? usmapRelease(fileName(usmap)) ?? fileName(usmap) : 'No USMAP chosen'}</b>
                      <span>{usmap ? [cl && `Build ${cl}`, behind ? `the game is on ${build!.cl}` : usmapInfo?.commitDate].filter(Boolean).join(' · ') || fileName(usmap) : 'Check for updates downloads the newest from rivals-depot'}</span>
                    </div>
                    <span className="su-part-links">
                      <button type="button" className="su-link" disabled={checking || busy} onClick={() => usmapCheck(true)} title="Download the newest USMAP from rivals-depot and use it">
                        {checking ? 'Checking…' : 'Check for updates'}
                      </button>
                      <button type="button" className="su-link" disabled={busy} onClick={browseUsmap} title="Use a .usmap file from this PC">Browse…</button>
                    </span>
                  </div>
                  {behind ? (
                    <div className="vf-behind" role="note">
                      <p className="vf-behind-head"><AlertTriangle size={14} aria-hidden="true" /><span><b>This USMAP does not match the game.</b> It is for build {cl}, and the game updated to build {build!.cl}.</span></p>
                      <p>Until a USMAP for build {build!.cl} is out, VFX mods with Niagara effects can only partially update. Their materials are rebuilt, and Niagara files made for the old build are left out (marked Partial in the list). Those mods need the new USMAP for a full update.</p>
                      <p>rivals-depot usually publishes one soon after a game update. Check for updates gets it.</p>
                    </div>
                  ) : null}
                  {moved?.newest?.structs.length ? (
                    <details className="vf-moved" role="note">
                      <summary><Info size={14} aria-hidden="true" />Build {moved.newest.build} moved {plural(moved.newest.structs.length, 'class layout')}{moved.notHandled.length ? `, ${moved.notHandled.length} not rewritten here` : ''}<span className="vf-moved-more">Details</span></summary>
                      <p>Game build {moved.newest.build} moved the property layout of {plural(moved.newest.structs.length, 'class or struct', 'classes and structs')} since build {moved.newest.from}, read from the USMAPs.</p>
                      {moved.notHandled.length ? <p>The Mod Updater does not rewrite {moved.notHandled.length === 1 ? 'this one' : `${moved.notHandled.length} of them`} itself: {moved.notHandled.slice(0, 4).join(', ')}{moved.notHandled.length > 4 ? `, and ${moved.notHandled.length - 4} more` : ''}. Blueprint mods holding the game's classes get May crash from their class check.</p> : null}
                    </details>
                  ) : null}
                </Section>

                <ColorNames />

                <Section icon={<ScrollText size={15} aria-hidden="true" />} title="Log" state={logs.length ? plural(logs.length, 'line') : undefined}>
                  <div className="vf-log" role="log">{logs.length ? logs.map((l, i) => <div key={i} className={`is-${l.type}`}><span>{l.time}</span> {l.text}</div>) : <span>Each step of an update writes a line here.</span>}</div>
                  {logs.length > 0 && <button type="button" className="row-action vf-copy-log" onClick={() => copy('log')}><Copy size={13} /> {copied === 'log' ? 'Copied' : 'Copy log'}</button>}
                </Section>
              </div>
            </div>
          </div>
        </section>
      </div>

      <footer className="vf-foot">
        {/* the note wraps (never cut off): what Update does to the files is the reassurance before a run */}
        <p className="vf-state">
          {summary
            ? <>{summary.text}{summary.retry.length > 0 && <>{' '}<button type="button" className="su-link" onClick={() => void run(summary.retry)}>Try {plural(summary.retry.length, 'mod')} again</button></>}</>
            : state ? <span className={scan && !busy ? 't-shimmer' : undefined}>{state}</span>
            : <>{/* its own line: the warning and its link stay together, apart from the estimate */}
                {hiddenTicked > 0 && <span className="vf-hidden-line"><b className="vf-hidden-n">{hiddenTicked} ticked {hiddenTicked === 1 ? 'mod is' : 'mods are'} hidden by the filter.</b>{' '}
                  <button type="button" className="su-link" onClick={() => { setQ(''); setHero('') }}>Show {hiddenTicked === 1 ? 'it' : 'them'}</button></span>}
                {ahead !== undefined && <b className="vf-eta">{timeLeft(ahead).replace(/^./, c => c.toUpperCase())} for {plural(todo, 'mod')}. </b>}{policy}.{' '}
                {partialTodo > 0 && <><b className="vf-partial-n">{partialTodo === todo ? (todo === 1 ? 'It' : `All ${todo}`) : `${partialTodo} of ${todo}`}</b> will only partially update, without {partialTodo === 1 ? 'its' : 'their'} old Niagara files, and keep {partialTodo === 1 ? 'its' : 'their'} original, off, as _ORIGINAL.{' '}</>}
                <button type="button" className="su-link" onClick={() => showAdvanced(true)}>Change</button></>}
        </p>
        {/* read out: the run's progress and its result, not every tick's estimate */}
        <span className="xtra-sr-only" aria-live="polite">{summary ? summary.text : busy || scan || cancelling ? state : ''}</span>
        <div className="vf-foot-actions">
          {reports.length > 0 && !busy && <button type="button" className="lo-text-btn" onClick={() => copy('report')}><Copy size={14} /> {copied === 'report' ? 'Copied' : 'Copy report'}</button>}
          {/* Cancel beside the button, never in its place: a double-click on Update must not cancel the run */}
          {busy && <button type="button" className="lo-text-btn" disabled={cancelling} onClick={() => stop('Cancel button')} title="Esc"><X size={14} strokeWidth={2.5} aria-hidden="true" /> {cancelling ? 'Cancelling…' : 'Cancel'}</button>}
          {/* the same checks as the header's Checking mods (Pause and Cancel live there) */}
          {!busy && <button type="button" className="lo-text-btn" disabled={Boolean(scan) || !picked.size} onClick={() => void scanTicked()}
            title="Check the ticked mods again from scratch, without changing files. Progress shows in the main window's header too">
            {scan ? <span className="t-shimmer">Scanning</span> : 'Scan'}</button>}
          <button type="button" className="btn-primary" disabled={busy || Boolean(lock) || !todo} title={busy ? undefined : 'Ctrl+Enter'}
            ref={el => { if (el && !busy) updateWidth.current = el.offsetWidth }} style={busy ? { minWidth: updateWidth.current } : undefined} onClick={() => run()}>
            <RefreshCw size={14} aria-hidden="true" className={busy ? 'vf-spin' : undefined} />{busy ? 'Updating…' : todo ? <>Update <Num id="vf-todo" value={todo} /> {todo === 1 ? 'mod' : 'mods'}</> : 'Update'}
          </button>
        </div>
      </footer>
    </div>
  )
}

export default function VfxUpdaterWindow() {
  useGlobalTooltips() // the app's tooltips, as the main window's: on hover and on keyboard focus, read out with the element
  return (
    <div className="vfx-window-container vf-window">
      <TitleBar title="Mod Updater" hideMaximize={true} />
      <VfxUpdaterPanel />
    </div>
  )
}

if (import.meta.env.DEV) {
  // the estimate: the benchmark until 3 runs, then the middle one (a slow outlier does not move it)
  console.assert(expected({ n: [409_000], p: [] }, true) === START.n && expected({ n: [], p: [] }, false) === START.p, 'under 3 runs: the benchmark')
  console.assert(expected({ n: [20_000, 409_000, 24_000], p: [] }, true) === 24_000, 'the middle run, not the average')
  // an update that kept the name is the same loadout member as the original was, and its _BROKEN copy is not
  const m = '~mods/Lime_9999999_P'
  console.assert(canonKey(modKey(`${m}.bak_repak`)) === canonKey(modKey(`${m}.pak`)), 'loadouts hold the update under the original key')
  console.assert(canonKey(modKey('~mods/Lime_BROKEN_9999999_P.bak_repak')) !== canonKey(modKey(`${m}.pak`)), 'the broken copy leaves its loadouts')
  const on = chosenMod('D:\\x\\Aqua Shine_9999999_P.utoc'), off = chosenMod('D:/x/A_P.utoc', 'D:/x/A_P.bak_repak')
  console.assert(on.name === 'Aqua Shine' && on.path === 'D:\\x\\Aqua Shine_9999999_P.pak' && on.enabled && !off.enabled && off.name === 'A', 'a chosen .utoc reads as the list reads mods')
}
