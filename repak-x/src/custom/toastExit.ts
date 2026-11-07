import { useLayoutEffect, useRef, type RefObject } from 'react'
import { usePresence, MotionGlobalConfig } from 'framer-motion'

/** Keeps a closing toast in place until its leave transition has played, including during an Undo refresh. */
export function useToastExit(ref: RefObject<HTMLDivElement>) {
  const [present, remove] = usePresence()
  // AnimatePresence hands out a new remove on each of its renders: a dependency on it would restart the fade
  const removeRef = useRef(remove)
  removeRef.current = remove
  // Banner stacking: the item takes .is-leaving (AlertHandler) and is removed once --stack-close has played
  useLayoutEffect(() => {
    if (present) return
    if (!ref.current || MotionGlobalConfig.skipAnimations) { removeRef.current?.(); return }
    const close = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stack-close')) || 250
    const t = setTimeout(() => removeRef.current?.(), close + 60)
    return () => clearTimeout(t)
  }, [present])
  return present
}
