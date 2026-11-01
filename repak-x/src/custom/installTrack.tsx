// repakxtra: install progress for Setup and the guided setup (FirstRun.tsx), one look for every install: the signature
// bypass, Project Galacta, the preview kit and Blender. The VFX Updater's look (cable's pick, 2026-10-25, in place of a
// spinner): what is happening now in shimmer text (three words at most, longer is cut off in a card), how much has
// downloaded ("38.0/108 MB"), and a thin bar under it with a light running along it. A finished install says so for a moment
// in green before the card's own state takes over.
import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Check } from 'lucide-react'
import type { KitProgress } from './previewKit'
import { SwapText } from './motion'

const DONE_MS = 2400
const MB = (n: number) => (n >= 100 * 1048576 ? `${Math.round(n / 1048576)} MB` : `${(n / 1048576).toFixed(1)} MB`)
const amountOf = (done: number, total: number) => (total ? `${MB(done).replace(' MB', '')}/${MB(total)}` : done ? MB(done) : undefined)

/** An install's status line: what is happening (`text`), how far ("38.0/108 MB", `share` 0 to 1, the bar), which of the
 *  `steps` it is on (`at`, the bar while the size is unknown), or `done` (the finished line). */
export function InstallTrack({ steps = [], at = 0, text, amount, share, done }: {
  steps?: string[]; at?: number; text: string; amount?: string; share: number | null; done?: string
}) {
  const pct = share === null ? null : Math.round(Math.min(1, Math.max(0, share)) * 100)
  // the bar: the share when it is known, else the middle of the current step (the VFX Updater's), else full while it sweeps
  const width = pct ?? (steps.length > 1 ? ((at + 0.5) / steps.length) * 100 : 100)
  return (
    <div className={`su-track${done ? ' is-done' : ''}`} role="status" aria-live="polite">
      <div className="su-track-line">
        {done && <Check size={14} strokeWidth={2.75} aria-hidden="true" />}
        {/* transitions.dev: Text states swap (each new step rises in) inside the Shimmer sweep */}
        <span className="su-track-text">{done ? <SwapText text={done} /> : <span className="t-shimmer"><SwapText text={text} /></span>}</span>
        {!done && amount && <span className="su-track-amount">{amount}</span>}
      </div>
      {!done && <div className="su-bar" aria-hidden="true"><i style={{ width: `${width}%` }} /></div>}
    </div>
  )
}

/** The name of an action that just finished well, for DONE_MS: call finish(name) when it succeeds. */
export function useFinished() {
  const [finished, setFinished] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const finish = (what: string) => {
    clearTimeout(timer.current)
    setFinished(what)
    timer.current = setTimeout(() => setFinished(null), DONE_MS)
  }
  return { finished, finish }
}

/** The bypass going in: two small files copied into the game, done in a moment, so its finished line is what shows. */
export function BypassTrack({ on, done }: { on: boolean; done?: string }) {
  if (!on && !done) return null
  return <InstallTrack text="Copying the bypass" share={null} done={on ? undefined : done} />
}

export type GalactaStep = { stage: 'check' | 'download' | 'install'; done: number; total: number }
const GALACTA_STEPS = ['Find release', 'Download', 'Install']
/** What Project Galacta's install is doing, in two words (the setup page's Install button shows these too). */
export const galactaWords = (p: GalactaStep | null) => !p || p.stage === 'check' ? 'Finding release' : p.stage === 'download' ? 'Downloading' : 'Installing'
/** Project Galacta's install progress (xtra_setup.rs galacta-progress) while `on`. */
export function useGalactaStep(on: boolean) {
  const [p, setP] = useState<GalactaStep | null>(null)
  useEffect(() => {
    if (!on) return
    setP(null)
    const off = listen<GalactaStep>('galacta-progress', e => setP(e.payload))
    return () => { off.then(f => f()).catch(() => undefined) }
  }, [on])
  return p
}
/** Project Galacta installing: finding the newest release, the download, the files. */
export function GalactaTrack({ on, done }: { on: boolean; done?: string }) {
  const p = useGalactaStep(on)
  if (!on && !done) return null
  const at = !p ? 0 : GALACTA_STEPS.indexOf(p.stage === 'check' ? 'Find release' : p.stage === 'download' ? 'Download' : 'Install')
  const text = galactaWords(p)
  return (
    <InstallTrack steps={GALACTA_STEPS} at={at} text={text} done={on ? undefined : done}
      amount={p?.stage === 'download' ? amountOf(p.done, p.total) : undefined}
      share={p?.stage === 'download' && p.total ? p.done / p.total : null} />
  )
}

const KIT_STEP: Record<KitProgress['stage'], string> = { download: 'Download', unpack: 'Unpack', blender: 'Blender', check: 'Check' }
/** The preview kit or Blender installing (previewKit.tsx): the steps this run planned, then the current one. */
export function KitTrack({ plan, p, done }: { plan: string[] | null; p: KitProgress | null; done?: string }) {
  if (!plan && !done) return null
  const steps = plan ?? []
  const at = p ? Math.max(0, steps.indexOf(KIT_STEP[p.stage])) : 0
  const stage = p?.stage ?? (steps[0] === 'Blender' ? 'blender' : steps[0] === 'Unpack' ? 'unpack' : 'download')
  const text = stage === 'download' ? 'Downloading the kit' : stage === 'unpack' ? 'Unpacking the kit'
    : stage === 'check' ? 'Checking this PC' : p?.total ? 'Downloading Blender' : 'Installing Blender'   // winget's own words run long
  const share = !p || !p.total || p.stage === 'unpack' || p.stage === 'check' ? null : p.total === 100 ? p.done / 100 : p.done / p.total
  return (
    <InstallTrack steps={steps} at={at} text={text} done={plan ? undefined : done} share={share}
      amount={p && p.total && p.total !== 100 && (p.stage === 'download' || p.stage === 'blender') ? amountOf(p.done, p.total) : undefined} />
  )
}
