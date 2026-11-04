import { useLayoutEffect, type RefObject } from 'react'
import { usePresence, MotionGlobalConfig } from 'framer-motion'

/** Keep the final faded frame until React removes the toast, including during an Undo refresh. */
export function useToastExit(ref: RefObject<HTMLDivElement>) {
  const [present, remove] = usePresence()
  useLayoutEffect(() => {
    if (present) return
    const el = ref.current
    if (!el || MotionGlobalConfig.skipAnimations) { remove?.(); return }
    const run = el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], {
      duration: 180, easing: 'ease-in', fill: 'forwards', id: 'toast-exit',
    })
    void run.finished.then(() => remove?.(), () => {})
    return () => run.cancel()
  }, [present, remove, ref])
  return present
}
