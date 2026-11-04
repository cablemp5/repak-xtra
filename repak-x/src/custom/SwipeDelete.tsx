import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { animate, motion, useMotionValue, useReducedMotion } from 'framer-motion'
import { Trash2 } from 'lucide-react'
import { cue } from './sounds'
import './swipeDelete.css'

const ACTION = 80
export const swipeCommits = (distance: number, width: number) => width > 0 && distance >= Math.max(width * 0.6, ACTION * 1.5)
type Grip = { id: number; startX: number; startY: number; from: number; dragging: boolean }

/** A deliberate full swipe uses the Library's recoverable delete. Controls inside the row keep their clicks. */
export default function SwipeDelete({ children, disabled, deleting, animated, onDelete, label }: {
  children: ReactNode; disabled: boolean; deleting: boolean; animated: boolean; onDelete: () => void; label: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const grip = useRef<Grip | null>(null)
  const suppressClick = useRef(false)
  const unwatch = useRef<(() => void) | null>(null)
  const live = useRef({ move: (_e: globalThis.PointerEvent) => {}, up: (_e: globalThis.PointerEvent) => {} })
  const x = useMotionValue(0)
  const reduce = useReducedMotion()
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const settle = (target: number) => animate(x, target, {
    type: 'spring', duration: animated && !reduce && document.documentElement.dataset.motion !== 'off' ? 0.3 : 0, bounce: 0,
  })
  const cancel = () => {
    grip.current = null
    unwatch.current?.(); unwatch.current = null
    root.current?.removeAttribute('data-dragging')
    setReady(false); setOpen(false); void settle(0)
  }
  useEffect(() => { if (disabled && !deleting) cancel() }, [disabled, deleting])
  useEffect(() => { if (!deleting) void settle(0) }, [deleting])
  useEffect(() => () => { x.stop(); unwatch.current?.() }, [x])
  const remove = () => {
    if (disabled) return
    setReady(false); setOpen(false)
    cue('close')
    // The existing handler owns the exit, error recovery, and Undo.
    onDelete()
    void settle(-(root.current?.clientWidth ?? 0))
  }
  const down = (e: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (disabled || grip.current || !e.isPrimary || e.button !== 0) return
    if (e.target instanceof Element && e.target.closest('input, a, select, textarea, [role="switch"], [role="checkbox"], button:not(.mod-name-button), [contenteditable="true"]')) return
    x.stop()
    grip.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, from: x.get(), dragging: false }
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
    const width = el.clientWidth
    const scale = el.getBoundingClientRect().width / width || 1
    const next = Math.max(-width, Math.min(0, g.from + dx / scale))
    x.set(next)
    setReady(swipeCommits(-next, width))
  }
  const up = (e: globalThis.PointerEvent) => {
    const g = grip.current
    if (!g || g.id !== e.pointerId) return
    grip.current = null
    unwatch.current?.(); unwatch.current = null
    root.current?.removeAttribute('data-dragging')
    if (!g.dragging) return
    if (!disabled && swipeCommits(-x.get(), root.current?.clientWidth ?? 0)) { remove(); return }
    const reveal = -x.get() > ACTION / 2
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
    <motion.div className="mod-swipe-surface" style={{ x }}>{children}</motion.div>
    <span className="mod-swipe-status" role="status">{ready ? `Release to delete ${label}` : ''}</span>
  </div>
}

if (import.meta.env.DEV) {
  console.assert(!swipeCommits(79, 400) && !swipeCommits(239, 400) && swipeCommits(240, 400), 'swipe: partial reveals do not delete, a deliberate full swipe does')
  console.assert(!swipeCommits(0, 0) && !swipeCommits(-300, 400) && !swipeCommits(100, 100), 'swipe: hidden, rightward, and too narrow rows never commit')
}
