// repakxtra: a tooltip with rich content (hero icons, tag lists) in place of MUI's Tooltip. Nothing is mounted until the
// pointer is over the child, then one fixed node in a portal. The Library rendered a MUI Tooltip (its own popper,
// listeners and transitions) for every row. Plain text tooltips stay `title` (hooks/useGlobalTooltips.ts).
import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Props = { content: ReactNode; className?: string; placement?: 'top' | 'bottom'; children: ReactElement<{ onMouseEnter?: (e: MouseEvent<HTMLElement>) => void; onMouseLeave?: (e: MouseEvent<HTMLElement>) => void }> }

const GAP = 8 // from the anchor, and the least room kept to the window's edges

/** Pure: where the tip goes. Below (or above) the anchor's middle, flipped when that side has no room, kept inside the window. */
export function placeTip(anchor: { left: number; top: number; bottom: number; width: number }, tip: { width: number; height: number },
  view: { width: number; height: number }, placement: 'top' | 'bottom') {
  const below = anchor.bottom + GAP, above = anchor.top - GAP - tip.height
  const fitsBelow = below + tip.height <= view.height - GAP, fitsAbove = above >= GAP
  const top = placement === 'bottom' ? (fitsBelow || !fitsAbove ? below : above) : (fitsAbove || !fitsBelow ? above : below)
  const centered = anchor.left + anchor.width / 2 - tip.width / 2
  return { left: Math.max(GAP, Math.min(centered, view.width - GAP - tip.width)), top }
}

export default function HoverTip({ content, className = '', placement = 'bottom', children }: Props) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const child = cloneElement(children, {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => { children.props.onMouseEnter?.(e); setPos(null); setAnchor(e.currentTarget.getBoundingClientRect()) },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => { children.props.onMouseLeave?.(e); setAnchor(null) },
  })
  // Measured once it is in the page (hidden until then), so it is placed by its real size
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return
    const { width, height } = tipRef.current.getBoundingClientRect()
    setPos(placeTip(anchor, { width, height }, { width: innerWidth, height: innerHeight }, placement))
  }, [anchor, placement])
  // A scroll or resize moves the anchor away from where the tip was placed: it closes, as it does on Escape
  useEffect(() => {
    if (!anchor) return
    const close = () => setAnchor(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    addEventListener('scroll', close, true)
    addEventListener('resize', close)
    addEventListener('keydown', onKey)
    return () => { removeEventListener('scroll', close, true); removeEventListener('resize', close); removeEventListener('keydown', onKey) }
  }, [anchor])
  return (
    <>
      {child}
      {anchor && createPortal(
        <div ref={tipRef} role="tooltip" className={`hover-tip ${className}`}
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}>
          {content}
        </div>,
        document.body,
      )}
    </>
  )
}

if (import.meta.env.DEV) {
  const view = { width: 1000, height: 800 }, tip = { width: 200, height: 100 }
  console.assert(JSON.stringify(placeTip({ left: 400, top: 100, bottom: 120, width: 20 }, tip, view, 'bottom')) === '{"left":310,"top":128}', 'HoverTip: centered below')
  console.assert(placeTip({ left: 400, top: 700, bottom: 720, width: 20 }, tip, view, 'bottom').top === 592, 'HoverTip: flips above at the bottom edge')
  console.assert(placeTip({ left: 980, top: 100, bottom: 120, width: 20 }, tip, view, 'bottom').left === 792, 'HoverTip: kept inside the right edge')
  console.assert(placeTip({ left: 400, top: 50, bottom: 70, width: 20 }, tip, view, 'top').top === 78, 'HoverTip: top flips below at the top edge')
}
