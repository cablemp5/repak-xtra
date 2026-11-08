// repakxtra: the mod checks' progress in the header (scanProgress.ts), their only sign (no toast). Shown only while a run
// reads mods, or after one stopped with mods left. Click: a menu like the
// Loadouts screen's Generate previews one, with the check and mod it is on, Pause and Cancel (or Resume once paused), what
// stopping risks, and how to run the checks again.
// Laws of UX: the work in progress stays in view (Doherty Threshold), and the count shows how far along it is
// (Goal-Gradient Effect). A paused run stays listed until it is done (Zeigarnik Effect).
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Pause } from 'lucide-react'
import { rescanVerdicts } from './brokenMods'
import { holdScan, progressLine, useScanRun } from './scanProgress'
import { APP_NAME } from './edition'

export default function ScanStatus() {
  const r = useScanRun()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const shown = r.shown || r.paused || (r.running && r.held !== null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc, true)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc, true) }
  }, [open])
  useEffect(() => { if (!shown) setOpen(false) }, [shown])
  if (!shown) return null
  const stopping = r.running && r.held !== null // Pause or Cancel pressed: the mod being read finishes first
  const status = stopping ? `${r.held === 'cancelled' ? 'Cancelling' : 'Pausing'} after the mod being read`
    : r.running ? (r.last ? progressLine(r.last) : 'Getting ready')
    : r.held === 'paused' ? 'Paused by you, with mods left to read'
    : 'Stopped with mods left to read (the game ran, or the Mod Updater needed the tools)'
  return (
    <div className="lo-gen scan-gen" ref={ref}>
      <button type="button" className="btn-ghost scan-status" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}
        title={r.running ? 'Show the mod checks: pause or cancel them' : 'The mod checks are paused: resume or cancel them'}>
        {/* running: only its words, shimmering */}
        {r.running
          ? <span className="scan-status-in t-shimmer">{stopping ? (r.held === 'paused' ? 'Pausing checks' : 'Stopping checks') : 'Checking mods'}</span>
          : <span className="scan-status-in"><Pause viewBox="0 3 24 18" fill="currentColor" stroke="none" aria-hidden="true" />Checks paused</span>}
      </button>
      {open && (
        <div className="sigeon-menu lo-gen-menu scan-menu" role="menu">
          <div className="lo-gen-status" role="status">
            <b>{r.running ? 'Checking mods for this game version' : 'Mod checks paused'}</b>
            <span>{status}</span>
          </div>
          {r.running
            ? <>
                <button type="button" role="menuitem" className="sigeon-item" disabled={stopping} onClick={() => { setOpen(false); void holdScan('paused') }}
                  title="Stop after the mod being read. Resume picks up where it stopped">
                  <span className="lo-gen-stop"><Pause viewBox="0 3 24 18" fill="currentColor" stroke="none" aria-hidden="true" />Pause</span></button>
                <button type="button" role="menuitem" className="sigeon-item run-stop-btn" disabled={stopping && r.held === 'cancelled'} onClick={() => { setOpen(false); void holdScan('cancelled') }}
                  title="Stop after the mod being read, and hide this until the checks run again">
                  <span className="lo-gen-stop"><span className="stop-glyph" aria-hidden="true" />Cancel</span></button>
              </>
            : <>
                <button type="button" role="menuitem" className="sigeon-item" onClick={() => { setOpen(false); void rescanVerdicts() }}
                  title="Check the mods left to read now">
                  <span className="lo-gen-stop"><span className="play-glyph" aria-hidden="true" />Resume</span></button>
                <button type="button" role="menuitem" className="sigeon-item run-stop-btn" onClick={() => { setOpen(false); void holdScan('cancelled') }}
                  title="Leave the rest unchecked and hide this until the checks run again">
                  <span className="lo-gen-stop"><span className="stop-glyph" aria-hidden="true" />Cancel</span></button>
              </>}
          <p className="scan-menu-warn"><AlertTriangle size={14} aria-hidden="true" />
            <span>Mods not checked yet get no Broken or May crash warning, and can crash the game. Refresh list (Ctrl+Shift+R) runs the checks again, and so does the next start of {APP_NAME}.</span></p>
        </div>
      )}
    </div>
  )
}
