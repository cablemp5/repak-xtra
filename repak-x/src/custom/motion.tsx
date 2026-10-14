// caleb fork: tiny wrappers for transitions.dev recipes that need React state (the CSS lives in caleb.css).
import { useEffect, useRef } from 'react'

const seen = new Map<string, string>() // count id -> last value shown, so a count that remounts still knows it changed

/** transitions.dev: Number pop-in. A count that pops in from below when it changes (not on first paint). `id` names
 * the count, so one that unmounts while busy ("Switching mods…") still pops when it comes back different. */
export function Num({ id, value }: { id: string; value: string | number }) {
  const v = String(value)
  const base = useRef(seen.get(id) ?? v)
  useEffect(() => { seen.set(id, v) })
  return <span key={v} className={v !== base.current ? 't-num-pop' : undefined}>{v}</span>
}

/** transitions.dev: Text states swap. A label whose new text rises in with a blur when it changes. */
export function SwapText({ text }: { text: string }) {
  const first = useRef(text)
  const changed = useRef(false)
  if (text !== first.current) changed.current = true
  return <span key={text} className={changed.current ? 't-text-in' : undefined}>{text}</span>
}

/** transitions.dev: Skeleton reveal. Marks an image loaded so caleb.css cross-fades it in from a blur. */
export const revealOnLoad = (e: React.SyntheticEvent<HTMLImageElement>) => e.currentTarget.classList.add('is-loaded')
