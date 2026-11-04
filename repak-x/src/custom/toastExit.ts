import { useLayoutEffect, useRef, type RefObject } from 'react'
import { usePresence, MotionGlobalConfig } from 'framer-motion'

/** Keep the final faded frame until React removes the toast, including during an Undo refresh. */
export function useToastExit(ref: RefObject<HTMLDivElement>) {
  const [present, remove] = usePresence()
  // AnimatePresence hands out a new remove on each of its renders: a dependency on it would restart the fade
  const removeRef = useRef(remove)
  removeRef.current = remove
  useLayoutEffect(() => {
    if (present) return
    const el = ref.current
    if (!el || MotionGlobalConfig.skipAnimations) { removeRef.current?.(); return }
    const run = el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], {
      duration: 180, easing: 'ease-in', fill: 'forwards', id: 'toast-exit',
    })
    void run.finished.then(() => removeRef.current?.(), () => {})
    return () => run.cancel()
  }, [present])
  return present
}
