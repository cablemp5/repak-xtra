// repakxtra: the welcome screen's first page (FirstRun.tsx shows it on the first launch, and from "Why loadouts?" on
// its setup page). What loadouts give over sorting mods with tags, in three small looping demos (welcome.css) with
// real previews the app made (covers/welcome): a loadout's preview, one switch for a whole set, and swapping between
// sets. Animations off: each demo shows its finished state.
import { ArrowRight } from 'lucide-react'
import Wordmark from './Wordmark'
import './welcome.css'
import catboy from './covers/welcome/catboy.webp'
import ultimate from './covers/welcome/ultimate.webp'
import godspeed from './covers/welcome/godspeed.webp'

/** A loadout card in miniature: its preview, name and switch. */
function MiniCard({ name, src, className = '', children }: { name: string; src: string; className?: string; children?: React.ReactNode }) {
  return (
    <div className={`wi-card ${className}`}>
      <div className="wi-card-img"><img className="wi-shot" src={src} alt="" />{children}</div>
      <div className="wi-card-body"><b>{name}</b><i className="wi-switch" /></div>
    </div>
  )
}

const ROWS = [['Catboy Panther mesh', 'Mesh'], ['Body lights and trail', 'VFX'], ['Catboy icons and text', 'UI'], ['Blush texture', 'Texture']]

export default function WelcomeIntro({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="wi">
      <div className="wi-head">
        <h2 className="wi-title">Welcome to <Wordmark height={26} /></h2>
        <p className="wi-lede">Your mods, in loadouts. A loadout is a set of mods that go together, like a skin with its effects, icons and sounds. It has a picture, and one switch turns the whole set on or off.</p>
      </div>

      <div className="wi-demos">
        <figure className="wi-demo">
          <div className="wi-stage">
            <MiniCard name="Catboy" src={catboy} className="wi-reveal">
              <span className="wi-render"><span>Rendering</span></span>
            </MiniCard>
          </div>
          <figcaption><b>See the look first</b><span>Each loadout gets a preview of how it looks in game, made on your PC. Or paste your own picture.</span></figcaption>
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
          <figcaption><b>One switch, the whole set</b><span>Skin, effects, icons and textures turn on together. Every other mod stays as it is.</span></figcaption>
        </figure>

        <figure className="wi-demo">
          <div className="wi-stage wi-swap">
            <MiniCard name="Ultimate" src={ultimate} className="wi-a" />
            <MiniCard name="Godspeed" src={godspeed} className="wi-b" />
          </div>
          <figcaption><b>Swap sets in a click</b><span>Flip from one look to the next. Pin a loadout to Ctrl+1 to switch it without looking.</span></figcaption>
        </figure>
      </div>

      <div className="wi-vs" role="table" aria-label="Tags and loadouts">
        <div role="row"><span role="columnheader" /><span role="columnheader">Tags in Repak X</span><span role="columnheader">Loadouts</span></div>
        <div role="row"><span role="rowheader">What it does</span><span role="cell">Says what a mod is</span><span role="cell">Switches a set of mods</span></div>
        <div role="row"><span role="rowheader">Turning a look on</span><span role="cell">Find and flip each mod</span><span role="cell">One switch</span></div>
        <div role="row"><span role="rowheader">Seeing it</span><span role="cell">A name in a list</span><span role="cell">A preview picture</span></div>
      </div>

      <div className="modal-footer fr-foot">
        <span className="su-sub">Tags still work here too.</span>
        <button type="button" className="lo-text-btn" onClick={onSkip}>Skip setup</button>
        <button type="button" className="btn-primary wi-next" onClick={onNext}>Set up repakxtra <ArrowRight size={15} /></button>
      </div>
    </div>
  )
}
