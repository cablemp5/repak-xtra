// repakxtra: the Find the crashing mod panel (crashBisect.ts). Opened from Crash suspects when no mod matches, and again
// on start when a run was left open.
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useDialogFocus } from './dialogFocus'
import { type Bisect, OPEN_BISECT, answerBisect, readBisect, restoreBisect, roundsLeft, startBisect } from './crashBisect'
import { type KeepDeps, stem, turnOffWithUndo } from './keepOne'
import { nameKey } from './loadoutStore'
import { ModName, plural } from './modName'

type Mod = { path: string; enabled?: boolean }

export default function BisectPanel({ deps, mods }: { deps: KeepDeps; mods: Mod[] }) {
  const [run, setRun] = useState<Bisect | null>(readBisect)
  const [culprit, setCulprit] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { ref, onKeyDown } = useDialogFocus(Boolean(run || culprit))
  const step = async (work: () => Promise<Bisect | string | null>) => {
    setBusy(true)
    const r = await work()
    setBusy(false)
    if (typeof r === 'string') { setRun(null); setCulprit(r) } else if (r) setRun(r)
  }
  useEffect(() => {
    const open = () => step(() => startBisect(deps, mods))
    window.addEventListener(OPEN_BISECT, open)
    return () => window.removeEventListener(OPEN_BISECT, open)
  }, [deps, mods])
  if (!run && !culprit) return null
  const cancel = async () => {
    if (!run) return
    setBusy(true)
    if (await restoreBisect(deps, run)) setRun(null)
    setBusy(false)
  }
  const turnOffCulprit = async () => {
    const mod = mods.find(m => culprit && stem(m.path) === stem(culprit))
    if (mod && await turnOffWithUndo(deps, [mod], 'Culprit off', `Turned off ${nameKey(mod.path)}.`)) setCulprit(null)
  }
  return (
    <div className="modal-overlay">
      <motion.div className="modal-content cs-modal" role="dialog" aria-modal="true" aria-label="Find the crashing mod"
        ref={ref} tabIndex={-1} onKeyDown={onKeyDown}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div>
            <h2>Find the crashing mod</h2>
            {run && <p className="cs-lead">Round {run.round} of about {run.round + roundsLeft(run.candidates.length - run.off.length)}. {plural(run.off.length, 'mod')} turned off, {plural(run.candidates.length, 'suspect')} left.</p>}
          </div>
        </div>
        <div className="modal-body cs-body">
          {run
            ? <p className="cs-note">Launch the game and do what made it crash. Then say what happened.</p>
            : <p className="cs-note">The crash comes from <ModName name={nameKey(culprit ?? '')} />. Every mod is back as it was.</p>}
        </div>
        <div className="modal-footer cs-footer">
          {run
            ? <>
                <button type="button" className="lo-text-btn" disabled={busy} onClick={cancel}>Cancel</button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => step(() => answerBisect(deps, run, true))}>Still crashes</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => step(() => answerBisect(deps, run, false))}>Fixed</button>
              </>
            : <>
                <button type="button" className="lo-text-btn" onClick={() => setCulprit(null)}>Close</button>
                <button type="button" className="btn-primary" onClick={turnOffCulprit}>Turn off the culprit</button>
              </>}
        </div>
      </motion.div>
    </div>
  )
}
