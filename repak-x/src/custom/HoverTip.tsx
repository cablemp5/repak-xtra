// repakxtra: a tooltip with rich content (hero icons, tag lists) in place of MUI's Tooltip. Nothing is mounted until the
// pointer is over the child, then one fixed node in a portal. The Library rendered a MUI Tooltip (its own popper,
// listeners and transitions) for every row. Plain text tooltips stay `title` (hooks/useGlobalTooltips.ts).
import { cloneElement, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Props = { content: ReactNode; className?: string; placement?: 'top' | 'bottom'; children: ReactElement<{ onMouseEnter?: (e: MouseEvent<HTMLElement>) => void; onMouseLeave?: (e: MouseEvent<HTMLElement>) => void }> }

export default function HoverTip({ content, className = '', placement = 'bottom', children }: Props) {
  const [at, setAt] = useState<DOMRect | null>(null)
  const child = cloneElement(children, {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => { children.props.onMouseEnter?.(e); setAt(e.currentTarget.getBoundingClientRect()) },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => { children.props.onMouseLeave?.(e); setAt(null) },
  })
  return (
    <>
      {child}
      {at && createPortal(
        <div role="tooltip" className={`hover-tip ${className}`} data-placement={placement}
          style={{ left: at.left + at.width / 2, top: placement === 'bottom' ? at.bottom + 8 : at.top - 8 }}>
          {content}
        </div>,
        document.body,
      )}
    </>
  )
}
