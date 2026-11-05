// repakxtra: the Mod Updater's and the Encrypter's list while the mods folder is read: rows shaped like the real ones
// (transitions.dev Skeleton loader, skeletons.css), with no words over them (screen readers still hear what is
// happening). Laws of UX: the shape of what is coming shows at once (Doherty Threshold).
import './skeletons.css'

const WIDTHS = [62, 48, 70, 55, 40, 66, 52, 58] // name lengths, so the rows read as a list rather than a block

export default function ModRowsSkeleton() {
  return (
    <div className="sk-rows" role="status" aria-label="Reading the mods folder">
      <ul className="mod-rows vf-rows is-skeleton" aria-hidden="true">
        {WIDTHS.map((w, i) => (
          <li key={i} className="mod-row vf-row sk-row"><span className="sk-box" /><span className="sk-line" style={{ width: `${w}%` }} /></li>
        ))}
      </ul>
    </div>
  )
}
