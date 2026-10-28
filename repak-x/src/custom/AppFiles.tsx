// repakxtra: Settings > Updates > App files. Check compares the installed files with this version's release zip
// (xtra_repair.rs) and changes nothing. Repair copies only the missing or different ones, then restarts.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileCheck, Wrench } from 'lucide-react'
import type { useAlert } from '../components/AlertHandler'
import { BUILD, REPAKXTRA_VERSION } from './version'

type Report = { missing: string[]; different: string[]; total: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "All app files match." or "2 files differ: a, b. 1 file is missing: c." */
export function reportText(r: Report) {
  const parts = [
    r.different.length && `${plural(r.different.length, 'file differs', 'files differ')}: ${r.different.join(', ')}.`,
    r.missing.length && `${plural(r.missing.length, 'file is missing', 'files are missing')}: ${r.missing.join(', ')}.`,
  ].filter(Boolean)
  return parts.length ? parts.join(' ') : 'All app files match.'
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(navigator.onLine)
    window.addEventListener('online', on); window.addEventListener('offline', on)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', on) }
  }, [])
  return online
}

export default function AppFiles({ alert }: { alert: ReturnType<typeof useAlert> }) {
  const online = useOnline()
  const [busy, setBusy] = useState<'' | 'check' | 'repair'>('')
  const [report, setReport] = useState<Report | null>(null)
  const release = !BUILD || (window as any).__mockRelease // the browser preview can pretend to be a release
  const reason = !release ? 'This is a dev or test build, not a release, so there is nothing to compare it with.'
    : !online ? 'You are offline. Checking needs the release from GitHub.' : ''
  const off = report ? report.missing.length + report.different.length : 0

  const check = async () => {
    setBusy('check'); setReport(null)
    try {
      const r = await invoke<Report>('xtra_check_app_files')
      setReport(r)
      const text = reportText(r)
      if (r.missing.length + r.different.length) alert.warning('App files', text)
      else alert.success('App files', text)
    } catch (e) {
      alert.warning('Could not check the app files', String(e))
    } finally { setBusy('') }
  }
  const repair = async () => {
    setBusy('repair')
    try { await invoke('xtra_repair_app_files') } // the app closes here and the update script restarts it
    catch (e) { alert.warning('Could not repair', String(e)); setBusy('') }
  }

  return (
    <div className="xs-row xs-app-files">
      <div className="xs-text">
        <span className="xs-label">App files</span>
        <span className="setting-subtext">
          {reason || `Compares repakxtra's files with release v${REPAKXTRA_VERSION} and changes nothing. Your mods, loadouts, and settings are never part of it, and files the release does not hold are left alone.`}
        </span>
        {report && <span className="xs-label xs-app-report">{reportText(report)}</span>}
      </div>
      <div className="xs-buttons">
        {off > 0 && (
          <button type="button" className="action-btn" disabled={!!busy || !!reason} onClick={repair}
            title="Puts back only the missing or different files, then restarts repakxtra. If it does not start, the previous files go back.">
            <Wrench size={14} /> {busy === 'repair' ? 'Repairing…' : 'Repair'}
          </button>
        )}
        <button type="button" className="action-btn" disabled={!!busy || !!reason} onClick={check} title={reason || 'Downloads this version and compares every file. Nothing is changed.'}>
          <FileCheck size={14} /> {busy === 'check' ? 'Checking…' : 'Check app files'}
        </button>
      </div>
    </div>
  )
}
