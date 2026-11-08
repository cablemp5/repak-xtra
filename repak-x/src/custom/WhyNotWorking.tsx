// repakxtra: Why isn't this mod working? (backend: xtra_why.rs). Opened from a mod's right-click menu, its details
// panel, or a Ban risk badge: every reason the app can find, problems first, then what is worth knowing, with the
// Broken, May crash, and Ban risk badges it already has. A finding with a fix carries its button (Turn on, Turn off,
// Open Setup) right beside it, so the answer is one click away (Fitts's Law).
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CircleAlert, CircleCheck, CircleHelp, Info, LoaderCircle } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { verdictLabel, verdictOf } from './brokenMods'
import { riskOf } from './safetyScan'
import { blockedReason } from './safeOff'
import { GAME_RUNNING, modsBlocked } from './keepOne'
import { useDialogFocus } from './dialogFocus'

type Action = 'turn_on' | 'turn_off' | 'setup'
type Finding = { level: 'problem' | 'info'; title: string; detail: string; action?: Action }
type Target = { path: string; name?: string }
const EVENT = 'repakxtra-why'
const ACTION_LABEL: Record<Action, string> = { turn_on: 'Turn on', turn_off: 'Turn off', setup: 'Open Setup' }

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
export function WhyNotWorking({ alert }: { alert: ReturnType<typeof useAlert> }) {
  const [target, setTarget] = useState<Target | null>(null)
  const [found, setFound] = useState<Finding[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const trap = useDialogFocus(Boolean(target), () => close()) // focus in on each opening, Esc closes, back to the opener
  const path = target?.path ?? null
  const close = () => setTarget(null)
  useEffect(() => {
    const show = (e: Event) => { setTarget((e as CustomEvent<Target>).detail); setFound(null); setError(null) }
    window.addEventListener(EVENT, show)
    return () => window.removeEventListener(EVENT, show)
  }, [])
  useEffect(() => {
    if (!path) return
    let live = true
    invoke<Finding[]>('xtra_why_mod', { modPath: path }).then(r => {
      if (!live) return
      // what the Library's badges already know: Broken and May crash stop it from working, Ban risk is worth knowing
      const v = verdictOf(path), risk = riskOf(path)
      const extra: Finding[] = [
        ...(v ? [{ level: v.kind === 'broken' || v.kind === 'risky' ? 'problem' : 'info', title: `Marked ${verdictLabel(v.kind)}`, detail: v.reason } as Finding] : []),
        ...(risk ? [{ level: 'info', title: 'Marked Ban risk', detail: risk.reason, action: isOff(path) ? undefined : 'turn_off' } as Finding] : []),
      ]
      setFound([...r, ...extra].sort((a, b) => Number(a.level !== 'problem') - Number(b.level !== 'problem')))
    }).catch(e => live && setError(String(e)))
    return () => { live = false }
  }, [path])
  if (!target || !path) return null
  const name = target.name || fileName(path)
  const act = async (action: Action) => {
    if (action === 'setup') { close(); window.dispatchEvent(new Event('repakxtra-open-setup')); return }
    if (modsBlocked()) { alert.warning(...GAME_RUNNING); return } // the Library's own guard: toggle_mod does not check
    setBusy(true)
    try {
      await invoke('toggle_mod', { modPath: path }) // the Library's own switch: the list updates from the folder watcher
      alert.success(action === 'turn_on' ? 'Turned on' : 'Turned off', `${name}. The game loads the change from the next launch.`)
      close()
    } catch (e) {
      alert.warning(`Could not turn ${action === 'turn_on' ? 'it on' : 'it off'}`, blockedReason(e) ?? String(e))
    } finally { setBusy(false) }
  }
  const problems = found?.filter(f => f.level === 'problem').length ?? 0
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
          {error ? <p className="su-note">Could not check this mod. {error}</p> : !found
            ? <p className="su-note why-checking"><LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" /> Checking</p> : (
            <>
              <p className="why-summary" role="status">{problems ? `Found ${problems} thing${problems === 1 ? '' : 's'} that can stop it from working.` : 'These checks found nothing that stops it from loading.'}</p>
              <ul className="why-list">
                {found.map(f => (
                  <li key={f.title} className={`why-item is-${f.level}`}>
                    {f.level === 'problem' ? <CircleAlert size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
                    <div><b>{f.title}</b><span>{f.detail}</span></div>
                    {f.action && <button type="button" className="btn-primary why-act" disabled={busy} onClick={() => act(f.action!)}>{ACTION_LABEL[f.action]}</button>}
                  </li>
                ))}
                {!problems && <li className="why-item is-ok"><CircleCheck size={16} aria-hidden="true" />
                  <div><b>Still not showing?</b><span>Restart the game: mods load at launch. A mod made for another skin or hero only shows on that one.</span></div></li>}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
