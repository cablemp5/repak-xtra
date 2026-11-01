// repakxtra: the Galacta Converter's welcome card (GalactaWindow.tsx): what Project Galacta is and what converting does.
// It shows each time the window opens until "Don't show this again". The very first time it stays up 5 seconds before
// it can be closed, so it gets read once. Its picture is Galacta's in-game Skin Swapper (a placeholder screenshot).
import { useEffect, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'
import { GalactaLogo } from './GalactaMods'
import swapperShot from '../assets/tools/galacta-swapper.webp'

const HIDE = 'repakxtra.galacta.welcomeHidden' // '1': Don't show this again
const SEEN = 'repakxtra.galacta.welcomeSeen'   // '1': closed once, so no wait any more
const WAIT = 5

/** Whether the card shows when the window opens. */
export const welcomeOnOpen = () => localStorage.getItem(HIDE) !== '1'

const STEPS = [
  { title: 'Convert', text: 'Each mod gets a copy that adds files and replaces nothing.' },
  { title: 'Swap', text: 'The copy goes on, the original off, and it joins Galacta’s list.' },
  { title: 'Pick in game', text: 'Select the skin, press P, and choose the look.' },
]

export default function GalactaWelcome({ onClose }: { onClose: () => void }) {
  const [left, setLeft] = useState(() => (localStorage.getItem(SEEN) === '1' ? 0 : WAIT))
  const [hide, setHide] = useState(() => localStorage.getItem(HIDE) === '1')
  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft(n => n - 1), 1000)
    return () => clearTimeout(t)
  }, [left])
  const close = () => {
    if (left > 0) return
    localStorage.setItem(SEEN, '1')
    localStorage.setItem(HIDE, hide ? '1' : '0')
    onClose()
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  return (
    // tabIndex -1: the app's dialog focus (dialogFocus.ts) then rests focus on the card itself, never its close X
    <div className="gal-welcome" role="dialog" aria-modal="true" aria-labelledby="gal-welcome-title" tabIndex={-1}>
      <div className="gal-welcome-card">
        <header className="gal-welcome-head">
          <div>
            <h2 id="gal-welcome-title"><GalactaLogo size={22} />Galacta Converter</h2>
            <p className="gal-welcome-lead">Project Galacta, by 0xSaturno, lets one skin hold many mod looks, and you pick which one to wear in game.</p>
          </div>
          <button type="button" className="lo-icon" disabled={left > 0} onClick={close} aria-label="Close" title={left > 0 ? `You can close this in ${left} s` : 'Close'}><X size={16} /></button>
        </header>
        {/* the middle scrolls on a short window, the title and Got it stay put */}
        <div className="gal-welcome-body">
          <img className="gal-welcome-shot" src={swapperShot} alt="Project Galacta's Skin Swapper in game, listing Default and two mod skins for one hero skin" />
          <ol className="gal-welcome-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <b><span className="gal-step-n" aria-hidden="true">{i + 1}</span>{s.title}</b>
                <span>{s.text}</span>
              </li>
            ))}
          </ol>
          <p className="setting-warn gal-welcome-note"><TriangleAlert size={14} aria-hidden="true" /><span>Project Galacta itself has to be on. Setup installs it.</span></p>
        </div>
        <footer className="gal-welcome-foot">
          <Checkbox size="sm" checked={hide} onChange={(v: boolean) => setHide(v)}>Don’t show this again</Checkbox>
          <button type="button" className="btn-primary" disabled={left > 0} onClick={close}>{left > 0 ? `Got it (${left})` : 'Got it'}</button>
        </footer>
      </div>
    </div>
  )
}
