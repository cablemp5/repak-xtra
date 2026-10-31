// repakxtra: Replace file (a mod's update), in place of upstream's UpdateModModal (same props). The app's dialog: a title
// naming the mod, the two files in one panel (now, then the new one), one choice for the name with what it changes, the
// obfuscation switch as the install dialog has it, then Cancel and Replace. Loadouts follow a new name (App.tsx
// handleConfirmUpdate).
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { RefreshCw } from 'lucide-react'
import Switch from '../components/ui/Switch'
import { useDialogFocus } from './dialogFocus'
import { nameKey } from './loadoutStore'
import './install.css'
import './updateMod.css'

type Props = {
  isOpen: boolean
  onClose: () => void
  onConfirm: (preserveName: boolean, obfuscate: boolean) => void
  oldMod: { path: string; custom_name?: string } | null
  newSourcePath: string | null
  initialObfuscate?: boolean | null
}

const fileOf = (path: string) => path.split(/[/\\]/).pop() || path

/** The part of each name that differs (the rest is shared), widened to whole _ - . pieces so "v6" -> "v7" reads as such,
 *  not "6" -> "7". [start, end-from-the-right]. Pure. */
export function changed(a: string, b: string): [number, number] {
  if (a === b) return [a.length, 0]
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const sep = /[_\-.\s]/
  while (p > 0 && !sep.test(a[p - 1])) p--
  // the shared end starts on a piece in both names: at a separator, or right after one
  const starts = (x: string) => { const i = x.length - s; return i === 0 || sep.test(x[i]) || sep.test(x[i - 1]) }
  while (s > 0 && !(starts(a) && starts(b))) s--
  return [p, s]
}

/** A file name with its changed part marked */
function Name({ text, at, cls }: { text: string; at: [number, number]; cls: string }) {
  const [p, s] = at, mid = text.slice(p, text.length - s)
  return <>{text.slice(0, p)}{mid && <mark className={cls}>{mid}</mark>}{text.slice(text.length - s)}</>
}

if (import.meta.env.DEV) {
  const show = (a: string, b: string) => { const [p, s] = changed(a, b); return `${a.slice(p, a.length - s)}|${b.slice(p, b.length - s)}` }
  console.assert(show('Mesh_9999999_P.pak', 'Mesh_v7_9999999_P.pak') === '|v7_', 'changed: an added piece')
  console.assert(show('sfx_v6_9999999_P.pak', 'sfx_v7_9999999_P.pak') === 'v6|v7', 'changed: whole pieces, not one digit')
  console.assert(show('a.pak', 'a.pak') === '|', 'changed: nothing')
}

export default function UpdateModDialog(props: Props) {
  if (!props.isOpen || !props.oldMod) return null
  return <Dialog {...props} oldMod={props.oldMod} />
}

function Dialog({ onClose, onConfirm, oldMod, newSourcePath, initialObfuscate }: Props & { oldMod: NonNullable<Props['oldMod']> }) {
  const [keepName, setKeepName] = useState(true)
  const [obfuscate, setObfuscate] = useState(initialObfuscate === true)
  const focus = useDialogFocus()
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', esc, true)
    return () => window.removeEventListener('keydown', esc, true)
  }, [onClose])

  const oldFile = fileOf(oldMod.path).replace(/\.bak_repak$/i, '.pak') // a mod that is off ends in .bak_repak on disk: shown as its .pak
  const newFile = newSourcePath ? fileOf(newSourcePath) : 'the new file'
  const title = oldMod.custom_name || nameKey(oldMod.path)
  const savedAs = `${oldFile.replace(/\.[^.]+$/, '')}.pak`
  const at = changed(oldFile, newFile)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div ref={focus.ref} onKeyDown={focus.onKeyDown} tabIndex={-1} className="modal-content um-modal" role="dialog" aria-modal="true" aria-labelledby="um-title"
        onClick={e => e.stopPropagation()} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}>
        <div className="modal-header">
          <div className="um-head-text">
            {/* named as the menus that open it (Replace file) */}
            <h2 id="um-title">Replace file</h2>
            <p className="um-sub">{title} gets the new file and stays on or off as it is now.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="modal-body um-body">
          {/* the two files as two rows of one table, the part that differs marked in each (it is what the eye looks for) */}
          <div className="um-files" role="list" aria-label="Files">
            <div className="um-file" role="listitem">
              <span className="um-file-label">Now</span>
              <span className="um-file-name is-old" title={oldMod.path}><Name text={oldFile} at={at} cls="um-diff is-old" /></span>
            </div>
            <div className="um-file" role="listitem">
              <span className="um-file-label">New</span>
              <span className="um-file-name" title={newSourcePath ?? undefined}><Name text={newFile} at={at} cls="um-diff" /></span>
            </div>
          </div>

          <div className="um-field">
            <span className="um-field-label" id="um-name">Name after the update</span>
            <div className="mod-state-filter um-seg" role="group" aria-labelledby="um-name">
              <button type="button" aria-pressed={keepName} onClick={() => setKeepName(true)}>Keep the current name</button>
              <button type="button" aria-pressed={!keepName} onClick={() => setKeepName(false)}>Use the new file's name</button>
            </div>
            <p className="um-note">{keepName
              ? <>Saved as <code>{savedAs}</code>. Load order, loadouts, and tags stay as they are.</>
              : <>Saved under the new file's name. Loadouts and tags follow it, but its load order can change.</>}</p>
          </div>

          <div className="ip-switches um-switches">
            <Switch size="sm" color="primary" checked={obfuscate} onChange={(v: boolean) => setObfuscate(v)}
              className={`install-toggle obfuscate-toggle${obfuscate ? ' active' : ''}`} title="Encrypts the IoStore with the game's AES key to block FModel extraction">
              <div className="install-toggle__text">
                <span className="install-toggle__label">Obfuscation</span>
                <span className="install-toggle__hint">{obfuscate ? 'IoStore will be AES encrypted' : 'Encrypt to block FModel extraction'}</span>
              </div>
            </Switch>
          </div>
        </div>

        <div className="modal-footer um-footer">
          <button type="button" className="lo-text-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={() => onConfirm(keepName, obfuscate)} autoFocus>
            <RefreshCw size={14} aria-hidden="true" /> Replace
          </button>
        </div>
      </motion.div>
    </div>
  )
}
