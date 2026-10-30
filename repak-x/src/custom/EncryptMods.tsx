import { Lock } from 'lucide-react'
import { openEncrypt } from './EncryptWindow'

export { openEncrypt }

/** Header button: opens the Encrypt window (EncryptWindow.tsx). Hidden from Settings > Header buttons like the VFX Updater's. */
export default function EncryptMods() {
  return (
    <button type="button" className="btn-settings" data-tour="encrypt-btn" title="Encrypt mods so they are harder to unpack"
      onClick={() => void openEncrypt().catch(e => console.error('[Encrypt] Window error:', e))}>
      <Lock size={16} aria-hidden="true" /> Encrypt
    </button>
  )
}
