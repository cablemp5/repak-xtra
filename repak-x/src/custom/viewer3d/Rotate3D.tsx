// repakxtra: Rotate in 3D. A button beside Regenerate preview (the mod details panel, a loadout page's preview corner)
// swaps the preview for the model in 3D in the same frame (cable's overnight pick B, docs\rivalsfps\overnight). The first
// time for a mod the preview kit exports it (--viewer, xtra_viewer.rs, 5 to 15 s) while the kit's step shows; after that
// it opens at once. States: loading, ready (the lobby idle plays, drag turns, scroll zooms, double click resets), the
// game's own model wins (the kit found the mod's mesh loses to the game's by pak order), nothing to show, and error.
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Image as ImageIcon, LoaderCircle, RotateCcw, Rotate3d, TriangleAlert, X } from 'lucide-react'
import { cue } from '../sounds'
import { stepText } from '../previewStages'
import { createViewer, type Viewer } from './scene'

type Phase = 'checking' | 'making' | 'loading' | 'ready' | 'overridden' | 'none' | 'failed'

/** The button for the preview bar or a loadout page's corner: one look with Regenerate (same class). */
export function Rotate3DButton({ on, hasImage, onClick, className }: { on: boolean; hasImage: boolean; onClick: () => void; className: string }) {
  return (
    <button type="button" className={className} onClick={onClick}
      title={on ? 'Back to the preview image' : 'Turn the model in 3D, with its lobby idle (the first time takes a few seconds)'}>
      {on ? (hasImage ? <ImageIcon size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />) : <Rotate3d size={14} aria-hidden="true" />}
      {on ? (hasImage ? 'Back to image' : 'Close 3D') : 'Rotate in 3D'}
    </button>
  )
}

/** The 3D view of one preview key (a mod, or a loadout's combined render with `set`), filling its parent. */
export function Viewer3D({ viewKey, paths, set }: { viewKey: string; paths: string[]; set?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('checking')
  const [step, setStep] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const args = useRef(paths)
  args.current = paths
  const pathsSig = paths.join('|')

  useEffect(() => {
    let live = true, viewer: Viewer | null = null
    // an unknown step word (a newer kit) shows the line's default, not the preview card's wording
    const stopStage = listen<string>('mod-viewer-stage', e => { if (live) setStep(stepText(e.payload) === stepText(undefined) ? '' : stepText(e.payload)) })
    const open = async () => {
      setPhase('loading')
      viewer = await createViewer(host.current!, viewKey, document.documentElement.getAttribute('data-motion') === 'off', () => live)
      if (!live) { viewer.dispose(); return }
      setPhase('ready')
    }
    ;(async () => {
      const paths = args.current
      const state = await invoke<string>('viewer_state', { key: viewKey, paths })
      if (!live) return
      if (state === 'ready' && attempt === 0) return open() // Try again makes the files anew
      if (state === 'overridden' && attempt === 0) { setPhase('overridden'); return }
      setPhase('making')
      const made = await invoke<string>('generate_mod_viewer', { paths, set: set ?? null })
      if (!live) return
      if (made === 'ready') return open()
      if (made === 'failed') { setError('The full error is in Logs.'); setPhase('failed'); return }
      setPhase(made === 'overridden' ? 'overridden' : 'none')
    })().catch(e => {
      if (!live) return
      console.warn('[viewer3d]', e)
      // a string is the backend's own sentence (busy, no kit); anything else broke while opening the files here (the
      // detail stays in the console: the app's Logs take backend lines only)
      setError(typeof e === 'string' ? e : 'The 3D files could not be opened. Try again makes them anew.')
      setPhase('failed')
    })
    return () => { live = false; stopStage.then(f => f()).catch(() => undefined); viewer?.dispose() }
  }, [viewKey, set, attempt, pathsSig])

  useEffect(() => { if (phase === 'ready') cue('ready') }, [phase])

  const busy = phase === 'checking' || phase === 'making' || phase === 'loading'
  return (
    <div className={`v3d is-${phase}`} aria-busy={busy}>
      <div ref={host} className="v3d-host" aria-label={phase === 'ready' ? 'Model in 3D: drag to turn, scroll to zoom, double click to reset' : undefined} />
      {busy && (
        <div className="v3d-state" role="status">
          <LoaderCircle size={20} className="scan-status-spin" aria-hidden="true" />
          <b>Preparing the 3D model</b>
          <span className="t-shimmer">{phase === 'loading' ? 'Loading the model' : step || (phase === 'making' ? 'Starting the preview kit' : 'Looking for the 3D files')}</span>
        </div>
      )}
      {phase === 'overridden' && (
        <div className="v3d-state">
          <TriangleAlert size={20} aria-hidden="true" />
          <b>The game loads its own model</b>
          <p>This mod&apos;s file name gives it a lower priority than the game&apos;s own files, so the game shows the original model. Previews show what the game loads.</p>
        </div>
      )}
      {phase === 'none' && (
        <div className="v3d-state">
          <b>Nothing to show in 3D</b>
          <p>3D covers skins, meshes, and textures on a hero.</p>
        </div>
      )}
      {phase === 'failed' && (
        <div className="v3d-state">
          <TriangleAlert size={20} aria-hidden="true" />
          <b>The 3D model did not load</b>
          <p>{error}</p>
          <button type="button" className="mod-preview-btn" onClick={() => setAttempt(a => a + 1)}><RotateCcw size={14} aria-hidden="true" />Try again</button>
        </div>
      )}
      {phase === 'ready' && <span className="v3d-hint" aria-hidden="true">Drag to turn. Scroll to zoom.</span>}
    </div>
  )
}

/** Whether Rotate in 3D can show anything for this key (viewer_state is not "none": the kit found a VFX, UI, sound or
 *  animation mod), asked again whenever previews change (`rev`). */
export function use3dPossible(key: string, rev: number) {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    let live = true
    invoke<string>('viewer_state', { key, paths: [] }).then(s => { if (live) setOk(s !== 'none') }).catch(() => undefined)
    return () => { live = false }
  }, [key, rev])
  return ok
}
