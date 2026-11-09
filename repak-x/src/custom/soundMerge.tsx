// repakxtra: the sound mod merger (xtra_soundmerge.rs), off by default until it is confirmed in game. Its Settings switch,
// the rebuild after the mod list changes and before Launch, and the note in a sound mod's details that names the mod
// that plays instead where two change the same sound.
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AudioLines } from 'lucide-react'
import Checkbox from '../components/ui/Checkbox'

type Loss = { loser: string; winner: string; file: string; sounds: number }
type Report = { on: boolean; merged: [string, string[]][]; losses: Loss[]; skipped: [string, string][] }

let last: Report | null = null
const listeners = new Set<(r: Report) => void>()
const publish = (r: Report) => { last = r; listeners.forEach(l => l(r)) }
const enabledPaths = (mods: { path: string; enabled?: boolean }[]) => mods.filter(m => m.enabled !== false && /\.pak$/i.test(m.path)).map(m => m.path)
let current: string[] = []

/** Merges again whenever the enabled mods change (a sound mod switched, installed, or removed), 2 s after the list
 *  settles. The backend skips the work when nothing it reads changed, and refuses while the game runs. */
export function useSoundMergeWatch(mods: { path: string; enabled?: boolean }[]) {
  const paths = enabledPaths(mods)
  const key = paths.slice().sort().join('\n')
  useEffect(() => {
    current = paths
    if (!key) return
    const t = setTimeout(() => {
      invoke<Report>('sound_merge_rebuild', { modPaths: paths }).then(publish).catch(e => console.warn('[soundMerge]', e))
    }, 2000)
    return () => clearTimeout(t)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Before Launch: one more pass, so a change made while the game was open is merged now (cheap when unchanged). */
export const soundMergeBeforeLaunch = async (say?: (text: string) => void) => {
  // always asked: with the setting off it removes a merged pak the game held when it was switched off
  if (await invoke<boolean>('sound_merge_get').catch(() => false)) say?.('Merging sound mods')
  await invoke<Report>('sound_merge_rebuild', { modPaths: current }).then(publish).catch(() => undefined)
}

const name = (p: string) => p.split(/[\\/]/).pop()!.replace(/(_\d+_P)?\.(pak|bak_repak)$/i, '')
const same = (a: string, b: string) => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

/** Settings: the merger on or off. Off by default; off takes the merged pak away again. */
export function SoundMergeSetting() {
  const [on, setOn] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => { invoke<boolean>('sound_merge_get').then(setOn).catch(() => undefined) }, [])
  const change = (next: boolean) => {
    setOn(next)
    invoke('sound_merge_set', { on: next })
      .then(() => { setNote(next ? 'On. Merging your sound mods now.' : 'Off. The merged sound pak is gone.'); if (next) void soundMergeBeforeLaunch() })
      .catch(e => { setNote(String(e)); if (!String(e).startsWith('Saved')) setOn(!next) })
  }
  return (
    <div className="setting-section">
      <h3 className="setting-icon-label"><AudioLines size={18} aria-hidden="true" />Sounds</h3>
      <div className="setting-group">
        <div className="setting-item">
          <Checkbox checked={on} onChange={change}><span>Merge sound mods</span></Checkbox>
          <p className="setting-subtext">Sound mods that change the same sound bank play together: one extra pak holds their sounds, and your mods stay as they are. Off until it is checked in game.</p>
          {note && <p className="setting-subtext" role="status">{note}</p>}
        </div>
      </div>
    </div>
  )
}

/** Mod details: what the merge did for this sound mod (nothing while the merger is off or the mod shares no bank). */
export function SoundMergeNote({ path }: { path: string }) {
  const [report, setReport] = useState<Report | null>(last)
  useEffect(() => {
    listeners.add(setReport)
    invoke<Report>('sound_merge_report').then(setReport).catch(() => undefined)
    return () => { listeners.delete(setReport) }
  }, [])
  if (!report?.on) return null
  const with_ = [...new Set(report.merged.filter(([, mods]) => mods.some(m => same(m, path))).flatMap(([, mods]) => mods).filter(m => !same(m, path)))]
  const lost = report.losses.filter(l => same(l.loser, path))
  const skipped = report.skipped.filter(([m]) => same(m, path))
  if (!with_.length && !skipped.length) return null
  const byWinner = new Map<string, number>()
  lost.forEach(l => byWinner.set(l.winner, (byWinner.get(l.winner) ?? 0) + l.sounds))
  const list = (xs: string[]) => xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`
  return (
    <div className="detail-section sound-merge-note">
      <h3>Sounds</h3>
      {with_.length > 0 && <p>Merged with {list(with_.map(name))} in one sound pak. Their Conflict badge stays until the merge is checked in game.</p>}
      {[...byWinner].map(([w, n]) => <p key={w}>{n === 1 ? '1 of its sounds loses' : `${n} of its sounds lose`} to {name(w)}, which plays instead.</p>)}
      {skipped.map(([, why], i) => <p key={i}>Left out: {why}.</p>)}
    </div>
  )
}
