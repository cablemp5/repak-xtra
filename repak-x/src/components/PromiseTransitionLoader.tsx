import { AnimatePresence, motion } from 'framer-motion'
import ModularLogo from './ui/ModularLogo'
import './PromiseTransitionLoader.css'

type PromiseTransitionLoaderProps = {
  isVisible: boolean
  message?: string
}

export default function PromiseTransitionLoader({
  isVisible,
  message = 'Working...'
}: PromiseTransitionLoaderProps) {
  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          className="promise-transition-loader"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="promise-transition-loader__card"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <div className="promise-transition-loader__logo-shell" aria-hidden="true">
              <ModularLogo size={32} className="promise-transition-loader__logo" />
            </div>
            <div className="promise-transition-loader__message">{message}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
