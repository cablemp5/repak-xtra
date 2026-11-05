// repakxtra: Why isn't this mod working? (backend: xtra_why.rs). Opened from a mod's right-click menu or its details
// panel: every reason the app can find, problems first, then what is worth knowing, with the Broken, May crash, and
// Ban risk badges it already has. Its own dialog so the reasons read as one list.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CircleAlert, CircleCheck, Info, Stethoscope } from 'lucide-react'
import { verdictLabel, verdictOf } from './brokenMods'
import { NOTICE, riskOf } from './safetyScan'
import { useDialogFocus } from './dialogFocus'

type Finding = { level: 'problem' | 'info'; title: string; detail: string }
const EVENT = 'repakxtra-why'

export const openWhy = (path: string) => window.dispatchEvent(new CustomEvent(EVENT, { detail: path }))

/** The details panel's entry: a quiet text button. */
export const WhyButton = ({ path }: { path: string }) => (
  <button type="button" className="lo-text-btn why-btn" onClick={() => openWhy(path)} title="Checks everything that can keep this mod from showing in game">
    <Stethoscope size={14} aria-hidden="true" /> Why isn't it working?
  </button>
)

const nameOf = (path: string) => path.split(/[\\/]/).pop()!.replace(/\.(pak|bak_repak)$/i, '')

/** Mounted once in App: listens for openWhy. */
export function WhyNotWorking() {
  const [path, setPath] = useState<string | null>(null)
  const [found, setFound] = useState<Finding[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trap = useDialogFocus()
  useEffect(() => {
    const show = (e: Event) => { setPath((e as CustomEvent<string>).detail); setFound(null); setError(null) }
    window.addEventListener(EVENT, show)
    return () => window.removeEventListener(EVENT, show)
  }, [])
  useEffect(() => {
    if (!path) return
    let live = true
    invoke<Finding[]>('xtra_why_mod', { modPath: path }).then(r => {
      if (!live) return
      // what the Library's badges already know: Broken and May crash count as problems, Ban risk is worth knowing
      const v = verdictOf(path), risk = riskOf(path)
      const extra: Finding[] = [
        ...(v ? [{ level: v.kind === 'broken' || v.kind === 'risky' ? 'problem' : 'info', title: `Marked ${verdictLabel(v.kind)}`, detail: v.reason } as Finding] : []),
        ...(risk ? [{ level: 'info', title: risk.level === 'ban' ? 'Marked Ban risk' : 'Marked Check rules', detail: `${risk.reason} ${NOTICE}` } as Finding] : []),
      ]
      setFound([...r, ...extra].sort((a, b) => Number(a.level !== 'problem') - Number(b.level !== 'problem')))
    }).catch(e => live && setError(String(e)))
    return () => { live = false }
  }, [path])
  useEffect(() => {
    if (!path) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setPath(null) } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [path])
  if (!path) return null
  const problems = found?.filter(f => f.level === 'problem').length ?? 0
  return (
    <div className="modal-overlay" onClick={() => setPath(null)}>
      <div ref={trap.ref} onKeyDown={trap.onKeyDown} tabIndex={-1} className="modal-content why-modal" role="dialog" aria-modal="true" aria-label="Why isn't this mod working?" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Why isn't it working?</h2>
          <button className="modal-close" onClick={() => setPath(null)} aria-label="Close">×</button>
          <p className="su-sub">{nameOf(path)}</p>
        </div>
        <div className="modal-body">
          {error ? <p className="su-note">{error}</p> : !found ? <p className="su-note">Checking…</p> : (
            <>
              <p className="why-summary">{problems ? `${problems} thing${problems === 1 ? '' : 's'} can keep it from showing in game.` : 'Nothing here keeps it from loading.'}</p>
              <ul className="why-list">
                {found.map(f => (
                  <li key={f.title} className={`why-item is-${f.level}`}>
                    {f.level === 'problem' ? <CircleAlert size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
                    <div><b>{f.title}</b><span>{f.detail}</span></div>
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
