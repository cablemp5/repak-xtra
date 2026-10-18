import { motion, AnimatePresence } from 'framer-motion'
import './ShortcutsHelpModal.css'
import { SHORTCUT_GROUPS } from '../custom/hotkeys'

type ShortcutsHelpModalProps = {
    isOpen: boolean
    onClose: () => void
}

// repakxtra: one grouped list shared with the shortcut handlers (custom/hotkeys.ts)

function ShortcutsHelpModal({ isOpen, onClose }: ShortcutsHelpModalProps) {
    if (!isOpen) return null

    return (
        <div className="modal-overlay" onClick={onClose}>
            <motion.div
                className="modal-content shortcuts-modal"
                onClick={(e) => e.stopPropagation()}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.15 }}
            >
                <div className="modal-header">
                    <h2>Keyboard shortcuts</h2>
                    <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className="shortcuts-list">
                    {SHORTCUT_GROUPS.map(group => (
                        <section key={group.title} className="shortcut-group">
                            <h3>{group.title}</h3>
                            {group.items.map((shortcut, index) => (
                                <div key={index} className="shortcut-row">
                                    <div className="shortcut-keys">
                                        {shortcut.keys.map((key, i) => (
                                            <span key={i}>
                                                <kbd>{key}</kbd>
                                                {i < shortcut.keys.length - 1 && <span className="key-separator">+</span>}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="shortcut-action">{shortcut.action}</div>
                                </div>
                            ))}
                        </section>
                    ))}
                </div>
                <div className="shortcuts-footer">
                    Press <kbd>Esc</kbd> to close
                </div>
            </motion.div>
        </div>
    )
}

export default ShortcutsHelpModal
