// repakxtra: Rotate in 3D. A button beside Regenerate preview (the mod details panel, a loadout page's preview corner)
// swaps the preview for the model in 3D in the same frame. The first
// time for a mod the preview kit exports it (--viewer, xtra_viewer.rs, 5 to 15 s) while the kit's step shows; after that
// it opens at once. States: loading, ready (the lobby idle plays, drag turns, middle drag moves, scroll zooms, double
// click resets), the game's own model wins (the kit found the mod's mesh loses to the game's by pak order), nothing to
// show, and error. On a loadout page it opens in a centered window instead (Viewer3DWindow), so the
// model shows bigger. Loading is the KO prompt editor's loader (ProgressLoader): a title, the bar following the kit's
// steps, and the step under it, shimmering.
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Check, Image as ImageIcon, Pause, PenLine, RotateCcw, Rotate3d, Shirt, SlidersHorizontal, Sun, TriangleAlert, Volume2, X } from 'lucide-react'
import { cue } from '../sounds'
import { stepText } from '../previewStages'
import { useDialogFocus } from '../dialogFocus'
import { ProgressLoader } from '../ProgressLoader'
import type { Viewer } from './scene'
import { LOOK_SWITCHES, OUTLINE_EVENT, setViewerLook, viewerLook, type ViewerLook } from '../viewerOutline'

const HINT = 'Drag to turn. Middle drag to move. Scroll to zoom.'
/** How far along the bar is at each of the kit's --viewer steps (mod_previews.py stage), and around them. */
const PCT: Record<string, number> = { checking: 4, making: 8, read: 18, mount: 30, unpack: 34, skins: 40, table: 44, export: 55, materials: 72, pose: 80, loading: 86 }

type Phase = 'checking' | 'making' | 'loading' | 'ready' | 'overridden' | 'none' | 'failed'

/** Whether Rotate in 3D makes sense for mods of these types: a mesh, a retexture, or a material (main or additional
 *  category). Animations, VFX, UI, text, and sounds have no model of their own to turn. */
export const shows3d = (categories: (string | null | undefined)[]) => categories.some(c => c && /^(Mesh|Texture|Material)$/i.test(c))

/** One mod for the 3D gate: its file path and its types (none while its details are not read yet). */
export type Mod3d = { path: string; categories: (string | null | undefined)[] }
/** Whether a loadout has a model to turn. The kit's verdict comes first: the loadout's preview found a character, or
 *  one of its mods has a 3D export or a character preview (a skin table swap the type list calls Animation). Otherwise
 *  a mod the kit has not found to be no character (a VFX, UI, sound or animation mod) that is a mesh, retexture or
 *  material mod, a skin table swap by its file name, or not typed yet. Asked again when previews change (`rev`). */
export function useLoadout3d(setKey: string, mods: Mod3d[], keyOf: (path: string) => string, rev: number) {
  const [ok, setOk] = useState(false)
  const sig = setKey + '|' + mods.map(m => m.path + ':' + m.categories.join(',')).join('|')
  useEffect(() => {
    let live = true
    const state = (key: string) => invoke<string>('viewer_state', { key, paths: [] }).catch(() => 'missing')
    const found = (s: string) => s === 'ready' || s === 'stale' || s === 'character'
    const fits = (m: Mod3d) => !m.categories.some(Boolean) || shows3d(m.categories) || /skin.?table|mat.?swap/i.test(m.path)
    Promise.all([state(setKey), ...mods.map(m => state(keyOf(m.path)))]).then(([own, ...states]) => {
      if (live) setOk(found(own) || states.some((s, i) => found(s) || (s !== 'none' && fits(mods[i]))))
    })
    return () => { live = false }
  }, [sig, rev])
  return ok
}

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

/** The 3D view of one preview key (a mod, or a loadout's combined render with `set`), filling its parent. Once the mod
 *  shows, the game's own skin of its model (Options > Default skin) is exported in the background, and built in a
 *  hidden second view once Options opens, so the swap between the two is quick. */
export function Viewer3D({ viewKey, paths, set, control, hint = true, name, onReady }: {
  viewKey: string; paths: string[]; set?: string; control?: MutableRefObject<Viewer | null>; hint?: boolean; name?: string; onReady?: (ready: boolean) => void
}) {
  const host = useRef<HTMLDivElement>(null), altHost = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('checking')
  const [step, setStep] = useState('')
  const [word, setWord] = useState('') // the kit's step word, for the bar
  const [load, setLoad] = useState<[number, string]>([0, '']) // the model's own loading, once its files are there
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [opened, setOpened] = useState<{ key: string; viewer: Viewer } | null>(null) // the mod's view, once it shows
  // the default skin's view: its phase, its loading, and the view once it is in
  const [alt, setAlt] = useState<{ phase: Phase; load: [number, string]; error: string; viewer: Viewer | null }>({ phase: 'checking', load: [0, ''], error: '', viewer: null })
  const [vanilla, setVanilla] = useState(false) // Options > Default skin: the game's own skin of this model, no mod
  useEffect(() => setVanilla(false), [viewKey])
  const args = useRef(paths)
  args.current = paths
  const pathsSig = paths.join('|')
  const still = () => document.documentElement.getAttribute('data-motion') === 'off'

  useEffect(() => {
    let live = true, viewer: Viewer | null = null
    setWord(''); setStep(''); setLoad([0, '']); setOpened(null) // Try again starts the bar and the step line over
    // an unknown step word (a newer kit) shows the line's default, not the preview card's wording
    const stopStage = listen<string>('mod-viewer-stage', e => { if (!live) return; setWord(e.payload); setStep(stepText(e.payload) === stepText(undefined) ? '' : stepText(e.payload)) })
    const open = async (key = viewKey) => {
      setPhase('loading')
      const { createViewer } = await import('./scene') // three.js is fetched on first use, not at app start
      viewer = await createViewer(host.current!, key, still(), () => live, (d, t) => { if (live) setLoad([d, t]) })
      if (!live) { viewer.dispose(); return }
      void viewer.lost.then(() => { if (live) { setError('The graphics driver reset, so the 3D view stopped. Try again opens it anew.'); setPhase('failed') } })
      setOpened({ key, viewer })
      onReady?.(true)
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
      if (made.startsWith('skin:')) { // a skin table swap: the game skin it puts on, exported like Default skin
        const key = await invoke<string>('generate_default_viewer', { target: made.slice(5) })
        if (live) await open(key)
        return
      }
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
    return () => { live = false; stopStage.then(f => f()).catch(() => undefined); viewer?.dispose(); onReady?.(false) }
  }, [viewKey, set, attempt, pathsSig])

  // the default skin: exported in the background once the mod shows (the kit, 10 to 60 s the first time, nothing on
  // screen waits), then built for the GPU once Options opens or Default skin is picked. Built right away, its first
  // frame (three's shadow, outline and post pipelines, made synchronously) stalled the GPU process about 2 s and froze
  // the mod's view at a random moment. None when the mod's view already is a default skin.
  const own = opened && !opened.key.startsWith('default-') ? opened.key : null
  const [altKey, setAltKey] = useState('')
  const [altWanted, setAltWanted] = useState(false)
  const [altAttempt, setAltAttempt] = useState(0) // Default skin picked again after it failed: asks anew
  const [held, setHeld] = useState(false) // Options > Pause idle, for every view of this window
  useEffect(() => { setAltWanted(false) }, [viewKey])
  useEffect(() => {
    setAltKey('')
    if (!own) return
    let live = true
    setAlt({ phase: 'making', load: [0, ''], error: '', viewer: null })
    ;(async () => {
      const model = JSON.parse(new TextDecoder().decode(await invoke<ArrayBuffer>('get_viewer_file', { key: own, file: 'model.json' }))) as { mesh?: string }
      const key = await invoke<string>('generate_default_viewer', { target: model.mesh ?? '' })
      if (live) setAltKey(key)
    })().catch(e => {
      if (!live) return
      console.warn('[viewer3d] default skin', e)
      // no default for this model (a mesh outside the heroes' folders): the row goes, nothing to retry
      if (typeof e === 'string' && /no default skin/i.test(e)) { setVanilla(false); setAlt(a => ({ ...a, phase: 'none' })); return }
      setAlt(a => ({ ...a, phase: 'failed', error: typeof e === 'string' ? e : 'The default skin could not be opened.' }))
    })
    return () => { live = false }
  }, [own, altAttempt])
  const buildAlt = altKey !== '' && (altWanted || vanilla)
  useEffect(() => {
    if (!buildAlt) return
    let live = true, viewer: Viewer | null = null
    setAlt(a => ({ ...a, phase: 'loading', load: [0, ''] }))
    ;(async () => {
      const { createViewer } = await import('./scene')
      viewer = await createViewer(altHost.current!, altKey, still(), () => live, (d, t) => { if (live) setAlt(a => ({ ...a, load: [d, t] })) })
      if (!live) { viewer.dispose(); return }
      const made = viewer
      void made.lost.then(() => { if (live) setAlt(a => ({ ...a, phase: 'failed', error: 'The graphics driver reset, so the 3D view stopped. Try again opens it anew.', viewer: null })) })
      setAlt(a => ({ ...a, phase: 'ready', viewer: made }))
    })().catch(e => {
      if (!live) return
      console.warn('[viewer3d] default skin', e)
      setAlt(a => ({ ...a, phase: 'failed', error: typeof e === 'string' ? e : 'The default skin could not be opened.' }))
    })
    return () => { live = false; viewer?.dispose(); setAlt(a => ({ ...a, viewer: null })) }
  }, [buildAlt, altKey])

  // what shows: the mod, or the default skin (its own phase while it is still on its way)
  const showAlt = vanilla && Boolean(own)
  const shown = showAlt ? alt.phase : phase
  const active = showAlt ? alt.viewer : opened?.viewer ?? null
  // only the view on screen draws: the other one waits, laid out at full size so it shows at once
  useEffect(() => { opened?.viewer.pause(showAlt); alt.viewer?.pause(!showAlt) }, [showAlt, opened, alt.viewer])
  useEffect(() => { opened?.viewer.hold(held); alt.viewer?.hold(held) }, [held, opened, alt.viewer])
  useEffect(() => {
    if (control) control.current = active
    return () => { if (control) control.current = null }
  }, [active])
  useEffect(() => { if (shown === 'ready') cue('ready') }, [shown])

  const busy = shown === 'checking' || shown === 'making' || shown === 'loading'
  const [done, text] = showAlt ? alt.load : load
  // the bar: the kit's step mark while it makes the files (a step it does not know keeps the last mark: the fill
  // never steps back), then the textures as they load
  const pct = shown === 'loading' ? PCT.loading + (100 - PCT.loading) * done * 0.9 : PCT[shown === 'making' ? (PCT[word] ? word : 'making') : 'checking']
  return (
    <div className={`v3d is-${shown}`} aria-busy={busy}>
      <div ref={host} className={`v3d-host${showAlt ? ' is-waiting' : ''}`} aria-hidden={showAlt || undefined} aria-label={!showAlt && phase === 'ready' ? 'Model in 3D: drag to turn, scroll to zoom, double click to reset' : undefined} />
      <div ref={altHost} className={`v3d-host${showAlt ? '' : ' is-waiting'}`} aria-hidden={!showAlt || undefined} aria-label={showAlt && alt.phase === 'ready' ? 'The default skin in 3D: drag to turn, scroll to zoom, double click to reset' : undefined} />
      {busy && (
        <div className="v3d-loading">
          <ProgressLoader key={showAlt ? 'alt' : 'mod'} title={showAlt ? 'Opening the default skin in 3D' : name ? `Opening ${name} in 3D` : 'Opening the model in 3D'}
            pct={pct} next={shown === 'loading' ? undefined : Math.min(...Object.values(PCT).filter(v => v > pct))}
            step={shown === 'loading' ? text || 'Loading the model' : step || (shown === 'making' ? 'Starting the preview kit' : 'Looking for the 3D files')} />
        </div>
      )}
      {shown === 'overridden' && (
        <div className="v3d-state">
          <TriangleAlert size={20} aria-hidden="true" />
          <b>The game loads its own model</b>
          <p>This mod&apos;s file name gives it a lower priority than the game&apos;s own files, so the game shows the original model. Previews show what the game loads.</p>
        </div>
      )}
      {shown === 'none' && (
        <div className="v3d-state">
          <b>Nothing to show in 3D</b>
          <p>3D covers skins, meshes, and textures on a hero.</p>
        </div>
      )}
      {shown === 'failed' && (
        <div className="v3d-state">
          <TriangleAlert size={20} aria-hidden="true" />
          <b>{showAlt ? 'The default skin did not load' : 'The 3D model did not load'}</b>
          <p>{showAlt ? alt.error : error}</p>
          {!showAlt && <button type="button" className="mod-preview-btn" onClick={() => setAttempt(a => a + 1)}><RotateCcw size={14} aria-hidden="true" />Try again</button>}
        </div>
      )}
      {shown === 'ready' && hint && <span className="v3d-hint" aria-hidden="true">{HINT}</span>}
      {shown === 'ready' && active?.cosmic && (
        <p className="v3d-note"><TriangleAlert size={14} aria-hidden="true" />Cosmic effects are approximate here. They look their best in game.</p>
      )}
      {(phase === 'ready' || showAlt) && <OptionsMenu vanilla={vanilla} held={held} onHeld={setHeld} onOpen={() => setAltWanted(true)}
        onVanilla={own && alt.phase !== 'none' ? on => { if (on && alt.phase === 'failed') setAltAttempt(a => a + 1); setVanilla(on) } : undefined} />}
    </div>
  )
}

/** The viewer's Options menu, top right, in the KO editor's Randomize settings look (an icon and a name per row, a check
 *  when on): Outline, Rim light (hidden while LOOK_SWITCHES is off) and Lobby sounds (shared with every viewer and
 *  Settings > Previews, applied at once), Pause idle (this window's views), then
 *  Default skin, the game's own skin of this model in place of the mod's. Esc or a click outside closes it. */
function OptionsMenu({ vanilla, onVanilla, onOpen, held, onHeld }: { vanilla: boolean; onVanilla?: (on: boolean) => void; onOpen?: () => void; held: boolean; onHeld: (on: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [look, setLook] = useState<ViewerLook>(viewerLook)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sync = () => setLook(viewerLook())
    window.addEventListener(OUTLINE_EVENT, sync)
    return () => window.removeEventListener(OUTLINE_EVENT, sync)
  }, [])
  const close = () => { setOpen(false); wrap.current?.querySelector<HTMLButtonElement>('.mod-preview-btn')?.focus() }
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false) }
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return } // before the window's own Esc
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
      const at = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(at + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus()
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', keys, true)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', keys, true) }
  }, [open])
  const row = (on: boolean, flip: () => void, Icon: typeof Sun, label: string) => (
    <button type="button" className="xtra-item" role="menuitemcheckbox" aria-checked={on} onClick={() => { flip(); cue('toggle') }}>
      <span className="ko-random-option"><Icon size={14} aria-hidden />{label}</span>{on && <Check size={14} aria-hidden />}
    </button>
  )
  return (
    <div className="v3d-look" ref={wrap}>
      <button type="button" className="mod-preview-btn" aria-haspopup="menu" aria-expanded={open} title={LOOK_SWITCHES ? 'Outline, rim light, sounds, pause, and the default skin' : 'Sounds, pause, and the default skin'}
        onClick={() => { if (!open) onOpen?.(); setOpen(v => !v); cue(open ? 'close' : 'open') }}>
        <SlidersHorizontal size={14} aria-hidden="true" />Options
      </button>
      {open && (
        <div className="xtra-menu ko-random-card v3d-look-menu" role="menu" aria-label="Options"
          onMouseDown={e => { if (e.target instanceof Element && !e.target.closest('button')) e.preventDefault() }}>
          {LOOK_SWITCHES && row(look.outline, () => setViewerLook({ outline: !look.outline }), PenLine, 'Outline')}
          {LOOK_SWITCHES && row(look.rim, () => setViewerLook({ rim: !look.rim }), Sun, 'Rim light')}
          {row(look.sound, () => setViewerLook({ sound: !look.sound }), Volume2, 'Lobby sounds')}
          {row(held, () => onHeld(!held), Pause, 'Pause idle')}
          {onVanilla && <div className="ko-random-separator" role="separator" />}
          {onVanilla && row(vanilla, () => onVanilla(!vanilla), Shirt, 'Default skin')}
        </div>
      )}
    </div>
  )
}

/** A loadout's model in 3D in a centered window, as big as the screen allows: its name and hero on top, the controls
 *  written once at the bottom with Reset view and Done. Esc, Close, or a click outside closes it. */
export function Viewer3DWindow({ title, sub, viewKey, paths, set, onClose }: {
  title: string; sub: string; viewKey: string; paths: string[]; set?: string; onClose: () => void
}) {
  const control = useRef<Viewer | null>(null)
  const [ready, setReady] = useState(false) // Reset view waits for the model
  const trap = useDialogFocus(true, onClose)
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <motion.div ref={trap.ref} onKeyDown={trap.onKeyDown} tabIndex={-1} className="modal-content v3d-window" role="dialog" aria-modal="true"
        aria-label={`${title} in 3D`} onClick={e => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div className="v3d-window-title"><h2>{title}</h2><p className="su-sub">{sub}</p></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="v3d-window-view"><Viewer3D viewKey={viewKey} paths={paths} set={set} control={control} hint={false} name={title} onReady={setReady} /></div>
        <div className="v3d-window-foot">
          <span>{HINT}</span>
          <button type="button" className="lo-text-btn" onClick={() => control.current?.reset()} disabled={!ready}><RotateCcw size={14} aria-hidden="true" />Reset view</button>
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </motion.div>
    </div>,
    document.body,
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
