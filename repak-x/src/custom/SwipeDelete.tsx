import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { cue } from './sounds'
import './swipeDelete.css'

const ACTION = 80
export const swipeCommits = (distance: number, width: number) => width > 0 && distance >= Math.max(width * 0.6, ACTION * 1.5)
type Grip = { id: number; startX: number; startY: number; from: number; width: number; scale: number; dragging: boolean; ready: boolean }

/** A deliberate full swipe uses the Library's recoverable delete. Controls inside the row keep their clicks. */
export default function SwipeDelete({ children, disabled, animated, onDelete, label }: {
  children: ReactNode; disabled: boolean; animated: boolean; onDelete: () => Promise<boolean>; label: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const x = useRef(0)
  const animation = useRef<Animation | null>(null)
  const pending = useRef(false)
  const grip = useRef<Grip | null>(null)
  const suppressClick = useRef(false)
  const unwatch = useRef<(() => void) | null>(null)
  const live = useRef({ move: (_e: globalThis.PointerEvent) => {}, up: (_e: globalThis.PointerEvent) => {} })
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const moveTo = (next: number) => {
    x.current = next
    if (surface.current) surface.current.style.transform = `translate3d(${next}px, 0, 0)`
  }
  const stop = () => {
    if (!animation.current || !surface.current) return
    const current = new DOMMatrixReadOnly(getComputedStyle(surface.current).transform).m41
    animation.current.cancel(); animation.current = null
    moveTo(current)
  }
  const settle = async (target: number) => {
    stop()
    const from = x.current
    moveTo(target)
    if (!surface.current || !animated || document.documentElement.dataset.motion === 'off') return true
    const run = surface.current.animate([
      { transform: `translate3d(${from}px, 0, 0)` }, { transform: `translate3d(${target}px, 0, 0)` },
    ], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    animation.current = run
    try { await run.finished; return true } catch { return false }
    finally { if (animation.current === run) animation.current = null }
  }
  const cancel = () => {
    if (pending.current) return
    grip.current = null
    unwatch.current?.(); unwatch.current = null
    root.current?.removeAttribute('data-dragging')
    setReady(false); setOpen(false); void settle(0)
  }
  useEffect(() => { if (disabled) cancel() }, [disabled])
  useEffect(() => () => { animation.current?.cancel(); unwatch.current?.() }, [])
  const remove = async () => {
    if (disabled || pending.current) return
    pending.current = true
    root.current?.setAttribute('data-committing', '')
    root.current?.setAttribute('aria-busy', 'true')
    setReady(false); setOpen(false)
    cue('close')
    try {
      if (!await settle(-(root.current?.clientWidth ?? 0)) || !root.current) return
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
      scale: (root.current?.getBoundingClientRect().width ?? width) / width, dragging: false, ready: false }
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
    }
    e.preventDefault()
    const next = Math.max(-g.width, Math.min(0, g.from + dx / g.scale))
    moveTo(next)
    const nextReady = swipeCommits(-next, g.width)
    if (g.ready !== nextReady) { g.ready = nextReady; setReady(nextReady) }
  }
  const up = (e: globalThis.PointerEvent) => {
    const g = grip.current
    if (!g || g.id !== e.pointerId) return
    grip.current = null
    unwatch.current?.(); unwatch.current = null
    root.current?.removeAttribute('data-dragging')
    if (!g.dragging) return
    if (!disabled && swipeCommits(-x.current, g.width)) { void remove(); return }
    const reveal = -x.current > ACTION / 2
    setOpen(reveal); setReady(false); void settle(reveal ? -ACTION : 0)
  }
  live.current = { move, up }
  return <div ref={root} className="mod-swipe" data-ready={ready || undefined} data-open={open || undefined} tabIndex={-1} role="group" aria-label={label}
    onPointerDownCapture={down}
    onKeyDownCapture={e => { if (e.key === 'Escape' && (open || grip.current)) { e.stopPropagation(); cancel() } }}
    onClickCapture={e => { if (suppressClick.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation() } }}
    onDragStart={e => e.preventDefault()}>
    <button type="button" className="mod-swipe-delete" tabIndex={open ? 0 : -1} disabled={disabled}
      aria-hidden={!open} aria-label={`Delete ${label}`} onClick={remove}>
      <Trash2 size={18} aria-hidden="true" /><span>{ready ? 'Release to delete' : 'Delete'}</span>
    </button>
    <div ref={surface} className="mod-swipe-surface">{children}</div>
    <span className="mod-swipe-status" role="status">{ready ? `Release to delete ${label}` : ''}</span>
  </div>
}

if (import.meta.env.DEV) {
  console.assert(!swipeCommits(79, 400) && !swipeCommits(239, 400) && swipeCommits(240, 400), 'swipe: partial reveals do not delete, a deliberate full swipe does')
  console.assert(!swipeCommits(0, 0) && !swipeCommits(-300, 400) && !swipeCommits(100, 100), 'swipe: hidden, rightward, and too narrow rows never commit')
}
