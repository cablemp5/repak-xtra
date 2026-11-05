// repakxtra: the mod checks' progress in the header (scanProgress.ts), for a run that outlasts its toast or whose toast
// was closed or missed. Shown only while a run reads mods, or after one stopped with mods left. Click: the progress
// toast again while it runs, or the checks again now once paused.
// Laws of UX: the work in progress stays in view (Doherty Threshold), and the count shows how far along it is
// (Goal-Gradient Effect). A paused run stays listed until it is done (Zeigarnik Effect).
import { LoaderCircle, Pause } from 'lucide-react'
import { rescanVerdicts } from './brokenMods'
import { progressLine, showScanToast, useScanRun } from './scanProgress'
import { APP_NAME } from './edition'

export default function ScanStatus() {
  const r = useScanRun()
  if (!r.shown && !r.paused) return null
  const title = r.running
    ? `${r.last ? progressLine(r.last) : 'Getting ready'}. The checks pause while the game runs. Click to show the progress again.`
    : `The mod checks stopped with mods left to read (the game ran, or a Mod Updater run or a check needed the tools). They pick up next time you come back to ${APP_NAME} with the game closed. Click to try now.`
  return (
    <button type="button" className="btn-ghost scan-status" onClick={() => (r.running ? showScanToast() : rescanVerdicts())} title={title}>
      {/* running: the spinner and its words under one shimmer sweep (theme.css t-shimmer-all), how far it is in the tooltip */}
      {r.running
        ? <span className="scan-status-in t-shimmer-all"><LoaderCircle size={14} className="scan-status-spin" aria-hidden="true" />Checking mods</span>
        : <span className="scan-status-in"><Pause size={14} aria-hidden="true" />Checks paused</span>}
    </button>
  )
}
