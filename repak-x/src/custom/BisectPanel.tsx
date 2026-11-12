// repakxtra: the Find the crashing mod panel (crashBisect.ts). One dialog: what will happen (nothing has changed yet),
// the tests (launch, play, answer), and the outcome. Opened from Crash suspects when no mod matches, and again on start
// while a test is saved, so a restart never strands mods off.
import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { ArchiveRestore, ArrowLeftRight, Check, CircleCheck, CircleHelp, CircleX, Gamepad2, ListChecks, Repeat, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react'
import { useDialogFocus } from './dialogFocus'
import { type Bisect, type Outcome, OPEN_BISECT, answerBisect, estimate, gameOpen, gameRunning, readBisect, restoreBisect, resumeBisect, returnTo, roundsLeft, startBisect, suspects, testOff } from './crashBisect'
import { Step } from './FirstRun'
import { type KeepDeps, stem, turnOffWithUndo } from './keepOne'
import { nameKey } from './loadoutStore'
import { ModName, plural } from './modName'
import { cue } from './sounds'

type Mod = { path: string; enabled?: boolean }
type End = Exclude<Outcome, { kind: 'run' }>
/** `resumed`: a saved test reopened (after a restart): its switch is checked and finished first, and the player may have
 *  played it while repakxtra was closed. */
type View = { step: 'intro' } | { step: 'test'; run: Bisect; resumed?: boolean } | { step: 'end'; end: End; last: Bisect }

export default function BisectPanel({ deps, mods }: { deps: KeepDeps; mods: Mod[] }) {
  const [view, setView] = useState<View | null>(() => { const r = readBisect(); return r ? { step: 'test', run: r, resumed: true } : null })
  const [busy, setBusy] = useState(false)
  // what went wrong stays in the dialog, next to the controls it is about, not in a toast behind or over it
  const [note, setNote] = useState<{ title: string; text: string } | null>(null)
  const d: KeepDeps = useMemo(() => {
    const say = (title: string, text?: string) => { cue('warning'); setNote({ title, text: text ?? '' }); return -1 }
    return { ...deps, alert: { ...deps.alert, warning: say, error: say } }
  }, [deps])
  const { ref, onKeyDown } = useDialogFocus(Boolean(view))
  useEffect(() => {
    const open = () => { cue('open'); const r = readBisect(); setView(r ? { step: 'test', run: r, resumed: true } : { step: 'intro' }) }
    window.addEventListener(OPEN_BISECT, open)
    return () => window.removeEventListener(OPEN_BISECT, open)
  }, [])
  if (!view) return null

  const on = suspects(mods)
  const work = async (fn: () => Promise<View | null>) => {
    setBusy(true)
    setNote(null)
    const v = await fn()
    setBusy(false)
    if (v) { setView(v); return }
    // a switch that half failed keeps its test saved: show that test, where Stop and restore mods can put mods back
    const saved = readBisect()
    if (saved && JSON.stringify(saved) !== JSON.stringify(view.step === 'test' ? view.run : null)) setView({ step: 'test', run: saved, resumed: true })
  }
  const close = () => { cue('close'); setNote(null); setView(null) }
  const title = view.step !== 'end' ? 'Find the crashing mod'
    : view.end.kind === 'found' ? (view.end.culprits.length === 1 ? 'Turning this mod off stopped the crash' : 'Turning these mods off stopped the crash') : view.end.kind === 'not-mods' ? 'The crash also happens with all mods off' : 'Could not narrow it to one mod'

  return (
    <div className="modal-overlay bs-overlay">
      <motion.div className="modal-content cs-modal bs-modal" role="dialog" aria-modal="true" aria-labelledby="bs-title"
        ref={ref} tabIndex={-1} onKeyDown={onKeyDown}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div>
            <h2 id="bs-title">{title}</h2>
            {view.step === 'test' && <Progress run={view.run} />}
          </div>
        </div>
        {note && <div className="bs-alert" role="alert"><TriangleAlert size={16} aria-hidden="true" /><p><strong>{note.title}</strong> {note.text}</p></div>}

        {view.step === 'intro' && <>
          <div className="modal-body cs-body bs-body">
            <p className="bs-lead">repakxtra turns half of your mods off and you play. If the game still crashes, the crashing mod is in the half left on. If not, it is in the other half. Each launch halves the mods left, until one remains.</p>
            {/* who does what, side by side: the player's part is three small things (Tesler: the app takes the rest) */}
            <div className="bs-roles">
              <section className="bs-role" aria-label="What you do">
                <h3>You</h3>
                <ol>{([[Gamepad2, 'Launch the game from here'], [Repeat, 'Do what made it crash'], [CircleHelp, 'Say if it crashed']] as const).map(([Icon, t]) =>
                  <li key={t}><Icon size={15} aria-hidden="true" />{t}</li>)}</ol>
              </section>
              <section className="bs-role is-app" aria-label="What repakxtra does">
                <h3>repakxtra</h3>
                <ul>{([[ArrowLeftRight, 'Turns half of your mods off for each launch'], [ListChecks, 'Keeps track of every answer'], [ArchiveRestore, 'Names the mod and puts yours back']] as const).map(([Icon, t]) =>
                  <li key={t}><Icon size={15} aria-hidden="true" />{t}</li>)}</ul>
              </section>
            </div>
            <dl className="bs-facts">
              <div><dt>Launches, at most (with {plural(on.length, 'mod')} enabled)</dt><dd>{estimate({ start: [], candidates: on.map(m => m.path), off: [], phase: 'baseline', tests: 0 })}</dd></div>
            </dl>
            <p className="cs-note">That is when one mod causes the crash. Each other mod that crashes it adds up to {roundsLeft(on.length) + 1} launches.</p>
          </div>
          <div className="modal-footer cs-footer">
            {/* a hint, not a section: the way back is on every step, so it only needs saying once, quietly */}
            <span className="bs-hint">Restore your mods at any time</span>
            <button type="button" className="lo-text-btn" onClick={close}>Not now</button>
            <button type="button" className="btn-primary" disabled={busy || on.length === 0}
              onClick={() => work(async () => { cue('tap'); const r = await startBisect(d, mods); if (r) cue('toggle'); return r && { step: 'test', run: r } })}>
              {busy ? 'Switching mods…' : 'Start testing'}
            </button>
          </div>
        </>}

        {view.step === 'test' && <Test key={`${view.run.tests}-${view.run.phase}`} run={view.run} resumed={Boolean(view.resumed)} busy={busy} deps={d}
          answer={crashed => work(async () => {
            cue('tap')
            const o = await answerBisect(d, view.run, crashed)
            if (!o) return null
            if (o.kind === 'run') { cue('toggle'); return { step: 'test', run: o.run } }
            cue(o.kind === 'found' ? 'success' : 'warning')
            return { step: 'end', end: o, last: view.run }
          })}
          undo={() => work(async () => { cue('navigate'); const p = view.run.prev; const r = p ? await returnTo(d, view.run, p) : null; return r && { step: 'test', run: r } })}
          stop={() => work(async () => {
            if (!(await restoreBisect(d, view.run))) return null
            close()
            deps.alert.success('Mods restored', `Your ${plural(view.run.start.length, 'mod')} are back as they were before the test.`)
            return null
          })} />}

        {view.step === 'end' && <End view={view} busy={busy} close={close}
          undo={() => work(async () => { cue('navigate'); const r = await returnTo(d, null, view.last); return r && { step: 'test', run: r } })}
          turnOff={culprits => work(async () => {
            const off = mods.filter(m => culprits.some(c => stem(c) === stem(m.path)))
            if (await gameOpen(d)) return null
            const text = off.length === 1 ? `Turned off ${nameKey(off[0].path)}.` : `Turned off ${plural(off.length, 'mod')}.`
            if (off.length && await turnOffWithUndo(d, off, off.length === 1 ? 'Crashing mod off' : 'Crashing mods off', text)) setView(null)
            return null
          })} />}
      </motion.div>
    </div>
  )
}

/** One test: launch, play, answer. The answers open once the game was seen running and then closed (a crash closes it
 *  too), or when the player says they already tested (the app was closed while they played). */
function Test({ run, resumed, busy, deps, answer, undo, stop }: {
  run: Bisect; resumed: boolean; busy: boolean; deps: KeepDeps; answer: (crashed: boolean) => void; undo: () => void; stop: () => void
}) {
  const [running, setRunning] = useState(false)
  const [played, setPlayed] = useState(false)
  // launched from here and still not seen 20 s later: a crash at startup can end before a check sees the game, so the
  // player may say so (sooner, the game is usually still starting)
  const [launched, setLaunched] = useState(false)
  // asked to launch, not seen running yet: the game takes a while to start, and mods must not switch under it
  const [starting, setStarting] = useState(false)
  const unseen = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(unseen.current), [])
  // each attempt watches for its own launch and exit: Not sure, test again starts a new one
  const [attempt, setAttempt] = useState(0)
  // a reopened test finishes the switch a restart cut off before Launch opens
  const [ready, setReady] = useState(!resumed)
  // the resume had to switch files: play from before the restart was with other mods, so only a new launch counts
  const [fixed, setFixed] = useState(false)
  const [stuck, setStuck] = useState(false)   // the resume could not set the mods: Check again, or Stop and restore mods
  const [resumeTry, setResumeTry] = useState(0)
  useEffect(() => {
    if (ready) return
    let live = true
    resumeBisect(deps, run).then(r => {
      if (!live) return
      if (r.refused) { setStuck(true); deps.alert.warning('Mods not set for this test', r.refused) }
      else { setStuck(false); setFixed(r.changed); setReady(true) }
    })
    return () => { live = false }
  }, [resumeTry])
  useEffect(() => {
    let live = true
    let seen = false
    const check = async () => {
      const r = await gameRunning().catch(() => false)
      if (!live) return
      setRunning(r)
      if (r) { seen = true; setStarting(false) }
      else if (seen) { seen = false; cue('ready'); setPlayed(true) }
    }
    void check()
    const t = setInterval(check, 1500)
    return () => { live = false; clearInterval(t) }
  }, [attempt])
  const launch = async () => {
    cue('tap')
    // a new launch is a new try: the last one's answer no longer counts
    setPlayed(false)
    setLaunched(false)
    setStarting(true)
    clearTimeout(unseen.current)
    try { await invoke('launch_game'); unseen.current = setTimeout(() => setLaunched(true), 20000) } catch (e) { setStarting(false); deps.alert.error('Game did not launch', String(e)) }
  }
  const offNow = testOff(run)
  const found = run.found ?? []
  const what = run.phase === 'baseline' ? `repakxtra turned off all ${plural(offNow.length, 'mod')} you had on, to check a mod is the cause.`
    : run.phase === 'confirm' ? (found.length ? 'Last check: repakxtra turned every mod back on except this one and the ones found so far.' : 'Last check: repakxtra turned every mod back on except this one.')
    : `repakxtra turned ${run.start.length - offNow.length} of your mods on and ${offNow.length} off for this test. ${plural(run.candidates.length, 'suspect')} left.`
  const live = running || starting
  const state = busy ? 'Switching mods…' : !ready ? 'Checking your mods…' : running ? 'Game running' : starting ? 'Starting the game…' : played ? 'Game closed' : null
  const waiting = busy || live || !played || !ready
  return <>
    <div className="modal-body cs-body bs-body">
      <p className="bs-lead">{resumed && !played && !launched && <span className="bs-resumed">Resuming your saved test. </span>}{what}</p>
      {run.phase === 'confirm' && <div className="bs-mod"><span className="cs-name"><ModName name={nameKey(run.candidates[0])} /></span></div>}
      {found.length > 0 && (
        <p className="bs-found">{found.length === 1 ? <span><ModName name={nameKey(found[0])} /></span> : <span>{plural(found.length, 'mod')}</span>} {found.length === 1 ? 'crashes' : 'crash'} the game, but something else does too. {found.length === 1 ? 'It stays' : 'They stay'} off while repakxtra finds the rest.</p>
      )}
      <ol className="fr-steps bs-steps" data-test={run.tests}>
        <Step n={1} done={running || played} title="Launch the game" action={
          <button type="button" className={played ? 'lo-text-btn bs-launch' : 'btn-primary bs-launch'} disabled={busy || live || !ready} onClick={launch}>
            <Gamepad2 size={15} aria-hidden="true" />{played ? 'Launch again' : 'Launch game'}
          </button>}>
          {state && <p role="status">{state}</p>}
        </Step>
        <Step n={2} done={played} title="Repeat what crashed it before">
          <p>If you get past that point with no crash, close the game normally.</p>
        </Step>
        <Step n={3} done={false} title="Did it crash?" action={
          <span className="bs-answers" role="group" aria-label="Did it crash?">
            <button type="button" className="lo-text-btn bs-ans is-crash" disabled={waiting} onClick={() => answer(true)}><CircleX size={15} aria-hidden="true" />It crashed</button>
            <button type="button" className="lo-text-btn bs-ans is-fine" disabled={waiting} onClick={() => answer(false)}><CircleCheck size={15} aria-hidden="true" />No crash</button>
          </span>}>
          {running && <p>Close the game, then answer.</p>}
        </Step>
      </ol>
      {launched && !played && !running && <button type="button" className="bs-link" onClick={() => { setStarting(false); setPlayed(true) }}>The game closed before repakxtra saw it running</button>}
      {stuck && <button type="button" className="bs-link" onClick={() => { setStuck(false); setResumeTry(n => n + 1) }}>Check again</button>}
      {resumed && ready && !fixed && !launched && !played && !running && <button type="button" className="bs-link" onClick={() => setPlayed(true)}>I already played this test before repakxtra closed</button>}
      {run.phase !== 'confirm' && (
        <details className="bs-off">
          <summary>Which mods are off</summary>
          <ul className="cs-list">{offNow.map(p => <li key={p}><span className="cs-name"><ModName name={nameKey(p)} /></span></li>)}</ul>
        </details>
      )}
    </div>
    <div className="modal-footer cs-footer">
      {run.prev && <button type="button" className="lo-text-btn bs-back" disabled={busy || live || !ready} onClick={undo}><Undo2 size={14} aria-hidden="true" />Undo last answer</button>}
      {played && <button type="button" className="lo-text-btn bs-back" disabled={busy || live || !ready} onClick={() => { cue('navigate'); setPlayed(false); setLaunched(false); setStarting(false); clearTimeout(unseen.current); setAttempt(a => a + 1) }}><CircleHelp size={14} aria-hidden="true" />Not sure, test again</button>}
      {/* the way back, always in the same place */}
      <button type="button" className="lo-text-btn bs-stop" disabled={busy || live || (!ready && !stuck)} onClick={stop}
        title="Ends the test and turns every mod back on or off exactly as before it started"><RotateCcw size={14} aria-hidden="true" />Stop and restore mods</button>
    </div>
  </>
}

function End({ view, busy, close, undo, turnOff }: {
  view: Extract<View, { step: 'end' }>; busy: boolean; close: () => void; undo: () => void; turnOff: (culprits: string[]) => void
}) {
  const e = view.end
  const one = e.kind === 'found' && e.culprits.length === 1
  return <>
    <div className="modal-body cs-body bs-body">
      {e.kind === 'found' && <>
        <ul className="bs-culprits">{e.culprits.map(c => <li key={c} className="bs-culprit"><Check size={16} aria-hidden="true" /><span className="cs-name"><ModName name={nameKey(c)} /></span></li>)}</ul>
        <p className="cs-note">{one ? 'The game played fine with only this mod off.' : `Each of these ${e.culprits.length} mods crashes the game, and it played fine with all of them off.`} Every mod is back as it was, {one ? 'this one' : 'these'} included, so turn {one ? 'it' : 'them'} off to play without the crash.</p>
      </>}
      {e.kind === 'not-mods' && <p className="bs-lead">The game crashed with every mod off, so the crash also happens without these mods. They are back on. Verify the game files in Steam, or update your graphics driver.</p>}
      {e.kind === 'unsure' && <>
        <p className="bs-lead">The game kept crashing with <strong><ModName name={nameKey(e.culprit)} /></strong> off, and every other mod tested fine. The crash may not happen every time, or it needs several mods at once.</p>
        <p className="cs-note">Every mod is back as it was. Test again and repeat the same thing each launch, or turn off the mods you added most recently.</p>
      </>}
    </div>
    <div className="modal-footer cs-footer">
      <button type="button" className="lo-text-btn bs-back" disabled={busy} onClick={undo}><Undo2 size={14} aria-hidden="true" />Undo last answer</button>
      {e.kind === 'found'
        ? <>
            <button type="button" className="lo-text-btn" disabled={busy} onClick={close}>{one ? 'Keep it on' : 'Keep them on'}</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => turnOff(e.culprits)}>{one ? 'Turn it off' : `Turn off ${e.culprits.length} mods`}</button>
          </>
        : <button type="button" className="btn-primary" disabled={busy} onClick={close}>Done</button>}
    </div>
  </>
}

/** Test N of up to M: a segment per test, filled once answered. The total can shrink as halves come out uneven, and
 *  grows (without "up to") once a second crashing mod turns up. */
function Progress({ run }: { run: Bisect }) {
  const total = Math.max(estimate(run), run.tests + 1)
  return (
    <div className="bs-progress">
      <span>Test <span key={run.tests} className="t-num-pop">{run.tests + 1}</span>{run.found?.length ? ', looking for the next crashing mod' : ` of up to ${total}`}</span>
      <span className="bs-bar" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i key={i} className={i < run.tests ? 'is-done' : i === run.tests ? 'is-now' : ''} />)}</span>
    </div>
  )
}

