// repakxtra: "Capture preview in game" on a loadout's page (backend: xtra_capture.rs). Takes a picture of the hero on
// Marvel Rivals' Hero Profile (Overview or Cosmetics), cropped to the character, for the loadout's image: press
// Ctrl+Shift+X in the game, or Capture now here (repakxtra switches to the game, takes it and comes back).
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { motion } from 'framer-motion'
import { Camera, LoaderCircle, RotateCcw } from 'lucide-react'
import type { LoadoutProps } from './Loadouts'
import { type Loadout, displayName, modKey } from './loadoutStore'
import { getAdditionalCategories } from '../utils'
import './capture.css'

type GameStatus = { running: boolean; width: number; height: number }
type Phase = 'listening' | 'capturing' | 'idle' | 'done' | 'saving'
const LISTEN_SECONDS = 600 // then it stops listening; Listen again restarts it
const VISUAL = new Set(['Mesh', 'Static Mesh', 'Texture'])

/** The capture's body (width and height as u32 LE, then RGBA) as a WebP of the same size. */
function toWebp(buf: ArrayBuffer): Promise<Blob> {
  const v = new DataView(buf)
  const w = v.getUint32(0, true)
  const h = v.getUint32(4, true)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0)
  return new Promise((ok, fail) => canvas.toBlob(b => (b ? ok(b) : fail(new Error('Could not encode the picture.'))), 'image/webp', 0.9))
}

function CaptureDialog({ p, l, hero, onUse, onClose }: {
  p: LoadoutProps; l: Loadout; hero?: string; onUse: (blob: Blob) => Promise<boolean>; onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>('listening')
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null)
  const run = useRef(0) // only the latest request's result counts (Capture now replaces a listener, closing drops both)
  const who = hero ?? 'the hero'

  const take = (cmd: 'capture_game_hotkey' | 'capture_game_now') => {
    const id = ++run.current
    setPhase(cmd === 'capture_game_now' ? 'capturing' : 'listening')
    invoke<ArrayBuffer>(cmd, cmd === 'capture_game_hotkey' ? { seconds: LISTEN_SECONDS } : {})
      .then(toWebp)
      .then(blob => {
        if (id !== run.current) return
        setShot({ blob, url: URL.createObjectURL(blob) })
        setPhase('done')
      })
      .catch(e => {
        if (id !== run.current) return
        const m = e instanceof Error ? e.message : String(e)
        if (m !== 'cancelled' && m !== 'timeout') p.alert.warning('Capture', m)
        setPhase('idle')
      })
  }
  useEffect(() => {
    take('capture_game_hotkey')
    return () => { run.current++; invoke('capture_game_cancel').catch(() => {}) }
  }, [])
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url) }, [shot])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  })

  const retake = () => { setShot(null); take('capture_game_hotkey') }
  /** Closes once the picture is saved; a failed save (onUse says why) keeps the shot here to try again. */
  const use = async () => {
    if (!shot) return
    setPhase('saving')
    if (await onUse(shot.blob).catch(() => false)) onClose()
    else setPhase('done')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div className="modal-content cp-modal" role="dialog" aria-label="Capture preview in game" onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div><h2>Capture preview in game</h2><p className="cp-sub">A picture of {who} for {l.name}'s image.</p></div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body cp-body">
          {shot
            ? <div className="cp-shot"><img src={shot.url} alt={`${who} in game`} /></div>
            : (
              <>
                <ol className="cp-steps">
                  <li>In Marvel Rivals, open <b>Heroes</b> and pick <b>{who}</b>.</li>
                  <li>Open the hero's <b>Overview</b> or <b>Cosmetics</b> screen.</li>
                  <li>Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>X</kbd> in the game. Or come back here and press <b>Capture now</b>: repakxtra
                    switches to the game, takes the picture and comes back.</li>
                </ol>
                <p className="cp-status" role="status">
                  {phase === 'listening' && <><i className="cp-dot" aria-hidden="true" />Listening for Ctrl+Shift+X</>}
                  {phase === 'capturing' && <><LoaderCircle size={14} className="su-spin" />Switching to the game…</>}
                  {phase === 'idle' && <>Not listening for Ctrl+Shift+X. <button type="button" className="cp-link" onClick={() => take('capture_game_hotkey')}>Listen again</button></>}
                </p>
              </>
            )}
        </div>
        <div className="modal-footer cp-footer">
          {shot
            ? <>
                <button type="button" className="lo-text-btn" disabled={phase === 'saving'} onClick={retake}><RotateCcw size={14} /> Retake</button>
                <button type="button" className="btn-primary" disabled={phase === 'saving'} onClick={use}>{phase === 'saving' ? 'Saving…' : 'Use as loadout image'}</button>
              </>
            : <>
                <button type="button" className="lo-text-btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn-primary" disabled={phase === 'capturing'} onClick={() => take('capture_game_now')}>
                  <Camera size={14} /> {phase === 'capturing' ? 'Capturing…' : 'Capture now'}
                </button>
              </>}
        </div>
      </motion.div>
    </div>
  )
}

/** The loadout page's button: shown for loadouts with a Mesh or Texture mod, usable while Marvel Rivals runs. */
export function CaptureButton({ p, l, onUse }: { p: LoadoutProps; l: Loadout; onUse: (blob: Blob) => Promise<boolean> }) {
  const byKey = new Map(p.mods.map(m => [modKey(m.path), m]))
  const details = [...new Set(l.on.map(displayName))].map(k => byKey.get(k)).map(m => (m ? p.modDetails?.[m.path] : undefined))
  const visual = details.filter(d => [d?.category, ...getAdditionalCategories(d)].some(c => VISUAL.has(c ?? '')))
  // "Black Panther - Skin" -> "Black Panther", from a skin mod first
  const hero = [...visual, ...details].map(d => d?.character_name?.split(' - ')[0].trim()).find(n => n && !n.startsWith('Multiple'))
  const show = visual.length > 0
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!show) return
    let live = true
    const check = () => invoke<GameStatus | null>('capture_game_status').then(s => { if (live) setRunning(Boolean(s?.running)) }).catch(() => {})
    check()
    const t = setInterval(check, 3000)
    return () => { live = false; clearInterval(t) }
  }, [show])
  if (!show) return null
  return (
    <>
      <button type="button" className="lo-text-btn" disabled={!running} onClick={() => setOpen(true)}
        title={running ? `Take a picture of ${hero ?? 'the hero'} in Marvel Rivals for this loadout's image` : 'Open Marvel Rivals first'}>
        <Camera size={14} /> Capture preview in game
      </button>
      {open && <CaptureDialog p={p} l={l} hero={hero} onUse={onUse} onClose={() => setOpen(false)} />}
    </>
  )
}
