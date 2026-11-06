// repakxtra: the one in-place confirm (Setup's removes, Snapshots' Delete, Settings > Storage): one line of what happens,
// then a plain Cancel and the action in red (it removes or deletes something), the same everywhere (Jakob's Law).
// Cancel takes the focus so Enter never deletes by accident, without the keyboard ring a mouse click never asked for.
import { useEffect, useRef } from 'react'

export default function ConfirmRow({ text, yes, onYes, onNo, busy = false, className = '' }:
  { text: React.ReactNode; yes: string; onYes: () => void; onNo: () => void; busy?: boolean; className?: string }) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancel.current?.focus({ focusVisible: false } as FocusOptions) }, [])
  return (
    <div className={`su-confirm ${className}`.trim()} role="alert">
      <span>{text}</span>
      <button ref={cancel} type="button" className="lo-text-btn" disabled={busy} onClick={onNo}>Cancel</button>
      <button type="button" className="lo-text-btn su-confirm-danger" disabled={busy} onClick={onYes}>{yes}</button>
    </div>
  )
}
