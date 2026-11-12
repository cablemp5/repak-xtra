// repakxtra: the KO prompt editor's loader (ko.css .ko-load), shared: a title, the blue bar, and the current step under
// it, shimmering, each new step rising in. Used by Rotate in 3D and Merge sounds.
// `pct` fills the bar to that much (`next`: where the step it is on ends, when that step counts nothing itself, so the
// bar keeps moving toward it); without `pct` the bar creeps on its own (the work has no steps to count).
import './progressLoader.css'
import { GlideFill } from './GlideFill'

export function ProgressLoader({ title, step, pct, next }: { title: string; step: string; pct?: number; next?: number }) {
  return (
    <div className="pl" role="status">
      <strong>{title}</strong>
      <div className="pl-bar" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === undefined ? undefined : Math.round(pct)}>
        {pct === undefined ? <span className="is-creep" /> : <GlideFill tag="span" pct={pct} next={next} />}
      </div>
      <span key={step} className="pl-step"><span className="t-shimmer">{step}</span></span>
    </div>
  )
}
