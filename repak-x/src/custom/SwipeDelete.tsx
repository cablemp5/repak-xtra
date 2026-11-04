import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { cue } from './sounds'
import { holdKeys } from './holdKeys'
import './swipeDelete.css'

const ACTION = 80
type Sample = { at: number; distance: number }
export const swipeVelocity = (samples: Sample[], releasedAt: number) => {
  const last = samples[samples.length - 1]
  if (!last || releasedAt - last.at > 80) return 0
  const first = samples.find(sample => sample.at >= releasedAt - 100) ?? samples[0]
  return Math.max(-3, Math.min(3, (last.distance - first.distance) / Math.max(8, releasedAt - first.at)))
}
export const swipeCommits = (distance: number, width: number, velocity = 0) => {
  const threshold = Math.max(width * 0.6, ACTION * 1.5)
  return width >= threshold && (distance >= threshold || (
    distance >= Math.max(ACTION, width * 0.2) && velocity >= 0.6 && distance + velocity * 180 >= threshold
  ))
}
// One region for every row: a status per mounted row floods the accessibility tree of a long Library.
let region: HTMLElement | null = null
const say = (text: string) => {
  if (!region) {
    region = document.createElement('div')
    region.className = 'xtra-sr-only'
    region.setAttribute('role', 'status')
    document.body.append(region)
  }
  region.textContent = text
}
type Grip = { id: number; startX: number; startY: number; from: number; width: number; scale: number; dragging: boolean; ready: boolean; samples: Sample[] }

/** A deliberate full swipe uses the Library's recoverable delete. Controls inside the row keep their clicks.
 *  With Hold to delete on, a swipe only opens the drawer, and its Delete button deletes. */
export default function SwipeDelete({ children, disabled, animated, onDelete, label, hold }: {
  children: ReactNode; disabled: boolean; animated: boolean; onDelete: () => Promise<boolean>; label: string; hold: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const drawer = useRef<HTMLButtonElement>(null)
  const glyph = useRef<HTMLSpanElement>(null)
  const x = useRef(0)
  const animation = useRef<Animation | null>(null)
  const drawerAnimations = useRef<Animation[]>([])
  const pending = useRef(false)
  const grip = useRef<Grip | null>(null)
  const suppressClick = useRef(false)
  const unwatch = useRef<(() => void) | null>(null)
  const live = useRef({ move: (_e: globalThis.PointerEvent) => {}, up: (_e: globalThis.PointerEvent) => {} })
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [holding, setHolding] = useState(false)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hold to delete: the drawer's Delete needs the same 2 s hold as the Library's other Delete buttons
  const holdStart = (e: { preventDefault: () => void }) => { e.preventDefault(); setHolding(true); holdTimer.current = setTimeout(() => { setHolding(false); void remove() }, 2000) }
  const holdEnd = () => { setHolding(false); if (holdTimer.current) clearTimeout(holdTimer.current); holdTimer.current = null }
  const glyphTransform = (offset: number) => `translate3d(calc(-50% - ${offset / 2}px), 0, 0)`
  const moveTo = (next: number) => {
    x.current = next
    if (surface.current) surface.current.style.transform = `translate3d(${next}px, 0, 0)`
    if (drawer.current) drawer.current.style.transform = `translate3d(${next}px, 0, 0)`
    if (glyph.current) glyph.current.style.transform = glyphTransform(next)
  }
  const stop = () => {
    if (!animation.current || !surface.current) return
    const current = new DOMMatrixReadOnly(getComputedStyle(surface.current).transform).m41
    animation.current.cancel(); animation.current = null
    drawerAnimations.current.forEach(run => run.cancel())
    moveTo(current)
  }
  const settle = async (target: number, velocity = 0) => {
    if (!animation.current && x.current === target) return true
    stop()
    const from = x.current
    moveTo(target)
    if (!surface.current || !animated || document.documentElement.dataset.motion === 'off') return true
    const frames = [
      { transform: `translate3d(${from}px, 0, 0)` }, { transform: `translate3d(${target}px, 0, 0)` },
    ]
    const timing = velocity >= 0.6
      ? { duration: Math.max(100, Math.min(220, Math.abs(target - from) * 2 / velocity)), easing: 'cubic-bezier(0.2, 0.4, 0.4, 1)' }
      : { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' }
    const run = surface.current.animate(frames, timing)
    drawerAnimations.current = []
    if (drawer.current) drawerAnimations.current.push(drawer.current.animate(frames, timing))
    if (glyph.current) drawerAnimations.current.push(glyph.current.animate([
      { transform: glyphTransform(from) }, { transform: glyphTransform(target) },
    ], timing))
    animation.current = run
    try { await run.finished; return true } catch { return false }
    finally { if (animation.current === run) animation.current = null }
  }
  const cancel = () => {
    holdEnd()
    if (pending.current) return
    grip.current = null
    unwatch.current?.(); unwatch.current = null
    root.current?.removeAttribute('data-dragging')
    setReady(false); setOpen(false); void settle(0)
  }
  const wasDisabled = useRef(disabled)
  useEffect(() => { if (disabled && !wasDisabled.current) cancel(); wasDisabled.current = disabled }, [disabled])
  useEffect(() => {
    if (!open) return
    const outside = (e: globalThis.PointerEvent) => { if (!root.current?.contains(e.target as Node)) cancel() }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => () => { animation.current?.cancel(); drawerAnimations.current.forEach(run => run.cancel()); unwatch.current?.(); holdEnd() }, [])
  const remove = async (velocity = 0) => {
    if (disabled || pending.current) return
    pending.current = true
    root.current?.setAttribute('data-committing', '')
    root.current?.setAttribute('aria-busy', 'true')
    setReady(false); setOpen(false)
    cue('close')
    try {
      if (!await settle(-(root.current?.clientWidth ?? 0), velocity) || !root.current) return
      if (!await onDelete()) void settle(0)
    } catch { void settle(0) }
    finally {
      pending.current = false
      root.current?.removeAttribute('data-committing')
      root.current?.removeAttribute('aria-busy')
    }
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (disabled || pending.current || grip.current || !e.isPrimary || e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('input, a, select, textarea, [role="switch"], [role="checkbox"], button:not(.mod-name-button), [contenteditable="true"]')) return
    stop()
    const width = root.current?.clientWidth ?? 0
    if (!width) return
    grip.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, from: x.current, width,
      scale: (root.current?.getBoundingClientRect().width ?? width) / width, dragging: false, ready: false,
      samples: [{ at: e.timeStamp, distance: -x.current }] }
    const onMove = (event: globalThis.PointerEvent) => live.current.move(event)
    const onUp = (event: globalThis.PointerEvent) => live.current.up(event)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    unwatch.current = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel)
    }
  }
  const move = (e: globalThis.PointerEvent) => {
    const g = grip.current
    const el = root.current
    if (!g || !el || g.id !== e.pointerId) return
    const dx = e.clientX - g.startX, dy = e.clientY - g.startY
    if (!g.dragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { cancel(); return }
      if (Math.abs(dx) < 10) return
      g.dragging = true
      suppressClick.current = true
      el.focus({ preventScroll: true })
      el.setAttribute('data-dragging', '')
      say('')
    }
    e.preventDefault()
    const next = Math.max(-g.width, Math.min(0, g.from + dx / g.scale))
    moveTo(next)
    const last = g.samples[g.samples.length - 1], prior = g.samples[g.samples.length - 2]
    if (prior && (last.distance - prior.distance) * (-next - last.distance) < 0) g.samples = [last]
    g.samples.push({ at: e.timeStamp, distance: -next })
    while (g.samples.length > 2 && g.samples[1].at < e.timeStamp - 100) g.samples.shift()
    // the same projection as the release, so a quick flick still shows Release to delete before it deletes
    const nextReady = !hold && swipeCommits(-next, g.width, swipeVelocity(g.samples, e.timeStamp))
    if (g.ready !== nextReady) { g.ready = nextReady; setReady(nextReady); say(nextReady ? `Release to delete ${label}` : '') }
  }
  const up = (e: globalThis.PointerEvent) => {
    const g = grip.current
    if (!g || g.id !== e.pointerId) return
    grip.current = null
    unwatch.current?.(); unwatch.current = null
    root.current?.removeAttribute('data-dragging')
    if (!g.dragging) return
    const velocity = swipeVelocity(g.samples, e.timeStamp)
    if (!disabled && !hold && swipeCommits(-x.current, g.width, velocity)) { void remove(velocity); return }
    const reveal = -x.current > ACTION / 2
    setOpen(reveal); setReady(false); void settle(reveal ? -ACTION : 0)
  }
  live.current = { move, up }
  return <div ref={root} className="mod-swipe" data-ready={ready || undefined} data-open={open || undefined} tabIndex={-1}
    onPointerDownCapture={down}
    onKeyDownCapture={e => { if (e.key === 'Escape' && (open || grip.current)) { e.stopPropagation(); cancel() } }}
    onClickCapture={e => { if (suppressClick.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation() } }}
    onDragStart={e => e.preventDefault()}>
    <button ref={drawer} type="button" className="mod-swipe-delete" tabIndex={open ? 0 : -1} disabled={disabled}
      aria-hidden={!open} aria-label={`Delete ${label}`} onClick={() => { if (!hold) void remove() }}
      {...(hold ? { onPointerDown: holdStart, onPointerUp: holdEnd, onPointerLeave: holdEnd, onPointerCancel: holdEnd, ...holdKeys(true, holdStart, holdEnd) } : {})}>
      <span ref={glyph} className="mod-swipe-glyph"><Trash2 size={18} aria-hidden="true" /><span>{ready ? 'Release to delete' : holding ? 'Hold to delete…' : hold ? 'Hold 2s' : 'Delete'}</span></span>
    </button>
    <div ref={surface} className="mod-swipe-surface">{children}</div>
  </div>
}

if (import.meta.env.DEV) {
  console.assert(!swipeCommits(79, 400) && !swipeCommits(239, 400) && swipeCommits(240, 400), 'swipe: partial reveals do not delete, a deliberate full swipe does')
  console.assert(!swipeCommits(0, 0) && !swipeCommits(-300, 400) && !swipeCommits(100, 100), 'swipe: hidden, rightward, and too narrow rows never commit')
  console.assert(swipeCommits(250, 1000, 2) && !swipeCommits(250, 1000, 0.2), 'swipe: a quick throw carries to delete, the same slow drag only reveals')
  console.assert(!swipeCommits(30, 400, 3) && !swipeCommits(200, 400, -2), 'swipe: a tiny flick or a rightward release below the threshold does not delete')
  const samples = [{ at: 0, distance: 0 }, { at: 50, distance: 100 }, { at: 90, distance: 200 }]
  console.assert(swipeVelocity(samples, 100) === 2 && swipeVelocity(samples, 200) === 0, 'swipe: release uses recent speed, pausing loses momentum')
  console.assert(swipeVelocity([{ at: 0, distance: 200 }, { at: 50, distance: 100 }], 50) === -2, 'swipe: reversing direction reverses momentum')
}
