import { useLayoutEffect, useRef, type CSSProperties } from 'react'

type TailInputProps = {
  value: string
  id?: string // repakxtra: for a <label htmlFor>
  placeholder?: string
  className?: string
  title?: string
  style?: CSSProperties
}

// Read-only text input that keeps its scroll position pinned to the end of
// the value, so long paths show their tail (file/folder name) instead of
// getting truncated at the start.
export default function TailInput({ value, id, placeholder, className, title, style }: TailInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  useLayoutEffect(() => {
    const el = inputRef.current
    if (el) {
      el.scrollLeft = el.scrollWidth
    }
  }, [value])

  return (
    <input
      ref={inputRef}
      id={id}
      type="text"
      value={value}
      readOnly
      placeholder={placeholder}
      className={className}
      style={style}
      title={title ?? value ?? undefined}
    />
  )
}
