import { APP_NAME } from './edition'
// repakxtra: the welcome screen's first page (FirstRun.tsx shows it on the first launch, and from "Why loadouts?" on
// its setup page). Loadouts in one line and three small looping demos (welcome.css) with real previews the app made
// (covers/welcome): a loadout's preview, one switch for a whole set, and swapping between sets. Kept short on purpose
// (cable, 2026-10-21): a newcomer reads it at a glance. Animations off: each demo shows its finished state.
import { ArrowRight } from 'lucide-react'
import Wordmark from './Wordmark'
import './welcome.css'
import catboy from './covers/welcome/catboy.webp'
import ultimate from './covers/welcome/ultimate.webp'
import godspeed from './covers/welcome/godspeed.webp'

/** A loadout card in miniature: its preview, name and switch. Spans, so it also fits inside the flow's choice buttons. */
export function MiniCard({ name, src, className = '', children }: { name: string; src: string; className?: string; children?: React.ReactNode }) {
  return (
    <span className={`wi-card ${className}`}>
      <span className="wi-card-img"><img className="wi-shot" src={src} alt="" />{children}</span>
      <span className="wi-card-body"><b>{name}</b><i className="wi-switch" /></span>
    </span>
  )
}

const ROWS = [['Catboy Panther mesh', 'Mesh'], ['Body lights and trail', 'VFX'], ['Catboy icons and text', 'UI'], ['Blush texture', 'Texture']]

export default function WelcomeIntro({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="wi">
      <div className="wi-head">
        <h2 className="wi-title">Welcome to <Wordmark height={26} /></h2>
        <p className="wi-lede">Group mods into loadouts. One switch turns a whole look on or off, and you see it before you play.</p>
      </div>

      <div className="wi-demos">
        <figure className="wi-demo">
          <div className="wi-stage">
            <MiniCard name="Catboy" src={catboy} className="wi-reveal">
              <span className="wi-render"><span>Rendering</span></span>
            </MiniCard>
          </div>
          <figcaption><b>See it first</b><span>A preview of the look, made on your PC.</span></figcaption>
        </figure>

        <figure className="wi-demo">
          <div className="wi-stage wi-set">
            <div className="wi-set-head"><b>Catboy</b><i className="wi-switch" /></div>
            <ul>
              {ROWS.map(([name, type], i) => (
                <li key={name} style={{ '--i': i } as React.CSSProperties}><i className="wi-dot" /><span>{name}</span><small>{type}</small></li>
              ))}
            </ul>
          </div>
          <figcaption><b>One switch</b><span>Skin, effects, and icons turn on together.</span></figcaption>
        </figure>

        <figure className="wi-demo">
          <div className="wi-stage wi-swap">
            <MiniCard name="Ultimate" src={ultimate} className="wi-a" />
            <MiniCard name="Godspeed" src={godspeed} className="wi-b" />
          </div>
          <figcaption><b>Swap in a click</b><span>Flip between looks, or pin one to Ctrl+1.</span></figcaption>
        </figure>
      </div>

      <div className="modal-footer fr-foot">
        <button type="button" className="lo-text-btn" onClick={onSkip}>Finish later</button>
        <button type="button" className="btn-primary wi-next" onClick={onNext}>Set up {APP_NAME} <ArrowRight size={15} /></button>
      </div>
    </div>
  )
}
