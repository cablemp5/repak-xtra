// repakxtra: Why isn't this mod working? (backend: xtra_why.rs). Opened from a mod's right-click menu, its details
// panel, or a Ban risk badge: every reason the app can find, problems first, then what is worth knowing, with the
// Broken, May crash, and Ban risk badges it already has. A finding with a fix carries its button (Turn on, Turn off,
// Open Setup, Load on top) right beside it, so the answer is one click away (Fitts's Law). Two passes: this mod's own
// checks show at once, the other mods that share its files follow (xtra_why_overrides reads every enabled mod).
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CircleAlert, CircleCheck, CircleHelp, Info, LoaderCircle } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { verdictLabel, verdictOf } from './brokenMods'
import { riskOf } from './safetyScan'
import { blockedReason } from './safeOff'
import { GAME_RUNNING, modsBlocked } from './keepOne'
import { useDialogFocus } from './dialogFocus'
import { useShownBusy } from './shownBusy'

type Action = 'turn_on' | 'turn_off' | 'setup' | 'load_on_top'
type Finding = { level: 'problem' | 'info'; title: string; detail: string; action?: Action; priority?: number }
type Target = { path: string; name?: string }
const EVENT = 'repakxtra-why'
const ACTION_LABEL: Record<Action, string> = { turn_on: 'Turn on', turn_off: 'Turn off', setup: 'Open Setup', load_on_top: 'Load on top' }

/** `name`: the name the Library shows, when the caller has it (the file name otherwise). */
export const openWhy = (path: string, name?: string) => window.dispatchEvent(new CustomEvent<Target>(EVENT, { detail: { path, name } }))

/** The details panel's entry: a quiet text button. */
export const WhyButton = ({ path, name }: { path: string; name?: string }) => (
  <button type="button" className="lo-text-btn why-btn" onClick={() => openWhy(path, name)} title="Checks everything that can keep this mod from working in game">
    <CircleHelp size={14} aria-hidden="true" /> Why isn't it working?
  </button>
)

const fileName = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.(pak|bak_repak)$/i, '')
const isOff = (path: string) => /\.bak_repak$/i.test(path)

/** Mounted once in App: listens for openWhy. */
/** `onSetPriority`: the Library's priority change (App.handleSetPriority), which guards a running game, reloads the list,
 *  refreshes the selection a rename left stale, and says when it fails. */
export function WhyNotWorking({ alert, onSetPriority }: { alert: ReturnType<typeof useAlert>; onSetPriority: (modPath: string, priority: number) => Promise<void> }) {
  const [target, setTarget] = useState<Target | null>(null)
  const [found, setFound] = useState<Finding[] | null>(null)
  const [others, setOthers] = useState<Finding[] | null>(null) // the second pass
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const req = useRef(0) // only the newest opening's answers paint: reopening on another mod drops the older ones
  const spinFirst = useShownBusy(Boolean(target) && !found && !error)
  const spinOthers = useShownBusy(Boolean(found) && !others)
  const trap = useDialogFocus(Boolean(target), () => close()) // focus in on each opening, Esc closes, back to the opener
  const path = target?.path ?? null
  const close = () => setTarget(null)
  useEffect(() => {
    const show = (e: Event) => { setTarget((e as CustomEvent<Target>).detail); setFound(null); setOthers(null); setError(null) }
    window.addEventListener(EVENT, show)
    return () => window.removeEventListener(EVENT, show)
  }, [])
  useEffect(() => {
    if (!path) return
    const id = ++req.current
    const live = () => id === req.current
    invoke<Finding[]>('xtra_why_mod', { modPath: path }).then(r => {
      if (!live()) return
      // what the Library's badges already know: Broken and May crash stop it from working, Ban risk is worth knowing
      const v = verdictOf(path), risk = riskOf(path)
      const extra: Finding[] = [
        ...(v ? [{ level: v.kind === 'broken' || v.kind === 'risky' ? 'problem' : 'info', title: `Marked ${verdictLabel(v.kind)}`, detail: v.reason } as Finding] : []),
        ...(risk ? [{ level: 'info', title: 'Marked Ban risk', detail: risk.reason, action: isOff(path) ? undefined : 'turn_off' } as Finding] : []),
      ]
      setFound([...r, ...extra])
    }).catch(e => live() && setError(String(e)))
    // a failed second pass shows nothing extra: the first pass already answered
    invoke<Finding[]>('xtra_why_overrides', { modPath: path }).then(r => live() && setOthers(r), () => live() && setOthers([]))
    return () => { req.current++ }
  }, [target]) // each opening checks again, the same mod too
  if (!target || !path) return null
  const name = target.name || fileName(path)
  const act = async ({ action, priority }: Finding) => {
    if (action === 'setup') { close(); window.dispatchEvent(new Event('repakxtra-open-setup')); return }
    if (modsBlocked()) { alert.warning(...GAME_RUNNING); return } // the Library's own guard: toggle_mod does not check
    if (action === 'load_on_top') { close(); await onSetPriority(path, priority!); return } // its row shows the new number
    setBusy(true)
    try {
      await invoke('toggle_mod', { modPath: path }) // the Library's own switch: the list updates from the folder watcher
      alert.success(action === 'turn_on' ? 'Turned on' : 'Turned off', `${name}. The game loads the change from the next launch.`)
      close()
    } catch (e) {
      alert.warning(`Could not turn ${action === 'turn_on' ? 'it on' : 'it off'}`, blockedReason(e) ?? String(e))
    } finally { setBusy(false) }
  }
  const all = found && [...found, ...(spinOthers ? [] : others ?? [])].sort((a, b) => Number(a.level !== 'problem') - Number(b.level !== 'problem'))
  const problems = all?.filter(f => f.level === 'problem').length ?? 0
  const pending = Boolean(found) && (!others || spinOthers) // a spinner that showed holds its minimum before the answer
  return (
    <div className="modal-overlay" onClick={close}>
      <div ref={trap.ref} onKeyDown={trap.onKeyDown} tabIndex={-1} className="modal-content why-modal" role="dialog" aria-modal="true" aria-labelledby="why-title" onClick={e => e.stopPropagation()}>
        <div className="modal-header why-head">
          <div className="why-head-text">
            <h2 id="why-title">Why isn't it working?</h2>
            <p className="why-name" title={name}>{name}</p>
          </div>
          <button className="modal-close" onClick={close} aria-label="Close">×</button>
        </div>
        <div className="modal-body">
          {error ? <p className="su-note">Could not check this mod. {error}</p> : !all || spinFirst // a spinner that showed stays its minimum time
            ? spinFirst && <p className="su-note why-checking"><LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" /> Checking…</p> : (
            <>
              <ul className="why-list" aria-live="polite">
                {all.map((f, i) => (
                  <li key={`${i}:${f.title}`} className={`why-item is-${f.level}`}>
                    {f.level === 'problem' ? <CircleAlert size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
                    <div><b>{f.title}</b><span>{f.detail}</span></div>
                    {f.action && <button type="button" className="btn-primary why-act" disabled={busy} onClick={() => act(f)}>{ACTION_LABEL[f.action]}</button>}
                  </li>
                ))}
                {spinOthers && <li className="why-item why-more"><LoaderCircle size={16} className="scan-status-spin" aria-hidden="true" />
                  <div><span>Checking other mods that share its files…</span></div></li>}
                {!problems && !pending && <li className="why-item is-ok"><CircleCheck size={16} aria-hidden="true" />
                  <div><b>This mod should be working</b><span>Still not showing? Restart the game: mods load at launch. A mod made for another skin or hero only shows on that one.</span></div></li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
