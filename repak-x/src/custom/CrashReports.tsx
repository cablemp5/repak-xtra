// repakxtra: Settings > Crash reports. The game's five newest crashes (xtra_crash.rs xtra_recent_crashes): when, the
// file it crashed loading, and which installed mods replace that file, matched against the mods installed now. Open
// crash reports opens the folder the game writes them to, one UECC folder per crash.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileWarning, FolderOpen } from 'lucide-react'
import { useAlert } from '../components/AlertHandler'
import { nameKey } from './loadoutStore'
import { ModName } from './modName'
import { type RecentCrash, recentCrashes, reportSource } from './setupReport'

const when = (secs: number) => new Date(secs * 1000).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })

export default function CrashReports() {
  const alert = useAlert()
  const [crashes, setCrashes] = useState<RecentCrash[] | null>(null)
  useEffect(() => {
    let live = true
    recentCrashes((reportSource.get?.().mods ?? []).map(m => m.path)).then(c => { if (live) setCrashes(c) })
    return () => { live = false }
  }, [])
  const openFolder = () => invoke<string>('get_crash_log_path')
    .then(path => invoke('open_in_explorer', { path }))
    .catch(e => alert.error('Could not open crash reports', String(e)))

  return (
    <div className="setting-section">
      <div className="crs-head">
        <h3 className="setting-icon-label"><FileWarning size={18} aria-hidden="true" />Crash reports</h3>
        <button type="button" className="lo-text-btn" onClick={openFolder}><FolderOpen size={14} aria-hidden="true" /> Open crash reports</button>
      </div>
      <p className="setting-subtext">Marvel Rivals' crash folder holds each crash as its own UECC folder. Zip the newest one when sharing a crash with support.</p>
      <div className="setting-group">
        {crashes === null
          ? <p className="rd-empty">Loading…</p>
          : crashes.length === 0
            ? <p className="rd-empty">No crashes found.</p>
            : (
              <ul className="rd-list">
                {crashes.map(c => (
                  <li key={c.time} className="rd-row crs-row">
                    <div className="rd-text">
                      <span className="rd-meta crs-time">{when(c.time)}</span>
                      <span className="rd-name">{c.asset ? <>Crashed loading <b>{c.asset}</b></> : `Crashed (${c.type})`}</span>
                      {!c.asset && <span className="rd-meta">The game crashed in its own code and named no file, so no mod can be matched to it.</span>}
                      {c.asset && (
                        <span className="rd-meta">
                          {!c.held ? 'Could not check which mods replace that file.'
                            : !c.held.length ? 'None of your installed mods replace that file.'
                            : <>Replaced by {c.held.map((p, i) => <span key={p}>{i ? ', ' : ''}<ModName name={nameKey(p)} /></span>)}</>}
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
      </div>
      <p className="setting-subtext crs-note">
        Mods are matched against what you have installed now. An older crash may have happened with a different set. A named
        mod is a suspect, not a verdict: the game can crash on a file for its own reasons.
      </p>
    </div>
  )
}
