// repakxtra: the mod checks' progress in the header (scanProgress.ts), their only sign (no toast). Shown only while a run
// reads mods, or after one stopped with mods left. Click: a menu like the
// Loadouts screen's Generate previews one, with the check and mod it is on, Pause and Cancel (or Resume once paused), what
// stopping risks, and how to run the checks again.
// Laws of UX: the work in progress stays in view (Doherty Threshold), and the count shows how far along it is
// (Goal-Gradient Effect). A paused run stays listed until it is done (Zeigarnik Effect).
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Eye } from 'lucide-react'
import { rescanVerdicts } from './brokenMods'
import { holdScan, progressLine, stageEnd, useScanRun } from './scanProgress'
import { GlideFill } from './GlideFill'
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
  const pct = r.pct
  const stopping = r.running && r.held !== null // Pause or Cancel pressed: the mod being read finishes first
  const status = stopping ? `${r.held === 'cancelled' ? 'Cancelling' : 'Pausing'} after the mod being scanned`
    : r.running ? (r.last?.path && r.mods ? progressLine(r.last.path, pct, r.mods) : "Reading the game's files")
    : r.held === 'paused' ? 'Paused by you, with mods left to scan'
    : 'Stopped with mods left to scan (the game ran, or the Mod Updater needed the tools)'
  return (
    <div className="lo-gen scan-gen" ref={ref}>
      <button type="button" className="btn-ghost scan-status" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}
        title={r.running ? 'Show the mod scan: pause or cancel it' : 'The mod scan is paused: resume or cancel it'}>
        {/* running: an eye and its words, shimmering together (t-shimmer-all: an SVG cannot take the text gradient) */}
        {r.running
          ? <span className="scan-status-in t-shimmer-all"><Eye size={14} aria-hidden="true" />{stopping ? (r.held === 'paused' ? 'Pausing scan' : 'Stopping scan') : 'Scanning mods'}</span>
          : <span className="scan-status-in"><span className="pause-glyph" aria-hidden="true" />Scan paused</span>}
      </button>
      {open && (
        <div className="xtra-menu lo-gen-menu scan-menu" role="menu">
          <div className="lo-gen-status" role="status">
            <b>{r.running ? 'Scanning mods for this game version' : 'Mod scan paused'}</b>
            <span>{status}</span>
            {/* the whole run: the stages done and this one's share, never stepping back; a stage with no count yet creeps
                toward its end (GlideFill) */}
            {r.running && <div className="su-bar" aria-hidden="true"><GlideFill pct={pct} next={r.last?.total ? undefined : stageEnd(r.stage, r.weights)} secs={20} /></div>}
          </div>
          {r.running
            ? <>
                <button type="button" role="menuitem" className="xtra-item" disabled={stopping} onClick={() => { setOpen(false); void holdScan('paused') }}
                  title="Stop after the mod being scanned. Resume picks up where it stopped">
                  <span className="lo-gen-stop"><span className="pause-glyph" aria-hidden="true" />Pause</span></button>
                <button type="button" role="menuitem" className="xtra-item run-stop-btn" disabled={stopping && r.held === 'cancelled'} onClick={() => { setOpen(false); void holdScan('cancelled') }}
                  title="Stop after the mod being scanned, and hide this until the scan runs again">
                  <span className="lo-gen-stop"><span className="stop-glyph" aria-hidden="true" />Cancel</span></button>
              </>
            : <>
                <button type="button" role="menuitem" className="xtra-item" onClick={() => { setOpen(false); void rescanVerdicts() }}
                  title="Scan the mods left now">
                  <span className="lo-gen-stop"><span className="play-glyph" aria-hidden="true" />Resume</span></button>
                <button type="button" role="menuitem" className="xtra-item run-stop-btn" onClick={() => { setOpen(false); void holdScan('cancelled') }}
                  title="Leave the rest unscanned and hide this until the scan runs again">
                  <span className="lo-gen-stop"><span className="stop-glyph" aria-hidden="true" />Cancel</span></button>
              </>}
          <p className="scan-menu-warn"><AlertTriangle size={14} aria-hidden="true" />
            <span>Mods the scan has not reached yet show no Broken, May crash, or Needs update tag, even ones that would crash the game. If you stop it, it starts again the next time you open {APP_NAME}. To run it now, press Refresh list in the Library (Ctrl+Shift+R).</span></p>
        </div>
      )}
    </div>
  )
}
