// repakxtra: the KO prompt editor's loader (ko.css .ko-load), shared: a title, the blue bar with a light running along
// it, and the current step under it, shimmering, each new step rising in. Used by Rotate in 3D and Merge sounds.
// `pct` fills the bar to that much; without it the bar creeps on its own (the work has no steps to count).
import './progressLoader.css'

export function ProgressLoader({ title, step, pct }: { title: string; step: string; pct?: number }) {
  return (
    <div className="pl" role="status">
      <strong>{title}</strong>
      <div className="pl-bar" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct === undefined ? undefined : Math.round(pct)}>
        <span className={pct === undefined ? 'is-creep' : undefined} style={pct === undefined ? undefined : { width: `${pct}%` }} />
      </div>
      <span key={step} className="pl-step"><span className="t-shimmer">{step}</span></span>
    </div>
  )
}
