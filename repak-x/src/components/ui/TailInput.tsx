import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

type TailInputProps = {
  value: string
  id?: string // repakxtra: for a <label htmlFor>
  placeholder?: string
  className?: string
  title?: string
  style?: CSSProperties
  onCommit?: (next: string) => void | Promise<void> // repakxtra: when set, the path is editable and commits on Enter or blur
}

// Text input that keeps its scroll position pinned to the end of the value
// when not being edited, so long paths show their tail (file/folder name)
// instead of getting truncated at the start.
// repakxtra: data-clipped marks a cut-off start, which fades in (theme.css), the whole path stays in the field
export default function TailInput({ value, id, placeholder, className, title, style, onCommit }: TailInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const canceled = useRef(false)
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const editable = Boolean(onCommit)

  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  const shown = editable ? draft : value

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    if (!editing) el.scrollLeft = el.scrollWidth
    const mark = () => el.toggleAttribute('data-clipped', el.scrollLeft > 1) // repakxtra
    mark()
    el.addEventListener('scroll', mark)
    const resize = new ResizeObserver(mark)
    resize.observe(el)
    return () => { el.removeEventListener('scroll', mark); resize.disconnect() }
  }, [shown, editing])

  const commit = () => {
    setEditing(false)
    if (canceled.current) { canceled.current = false; return }
    if (!onCommit) return
    const next = draft.trim()
    if (!next || next === value) { setDraft(value); return }
    void Promise.resolve(onCommit(next)).catch(() => setDraft(value))
  }

  return (
    <input
      ref={inputRef}
      id={id}
      type="text"
      value={shown}
      readOnly={!editable}
      onFocus={editable ? () => { canceled.current = false; setEditing(true) } : undefined}
      onChange={editable ? e => setDraft(e.target.value) : undefined}
      onBlur={editable ? commit : undefined}
      onKeyDown={editable ? e => {
        if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur() }
        else if (e.key === 'Escape') { e.stopPropagation(); canceled.current = true; setDraft(value); setEditing(false); inputRef.current?.blur() }
      } : undefined}
      placeholder={placeholder}
      className={className}
      style={style}
      title={title ?? shown ?? undefined}
    />
  )
}
