import { Lock } from 'lucide-react'

// Here, not in EncryptWindow.tsx, so the main window never loads that window's code (main.tsx lazy-loads it)
export const KEY = 'repakxtra-encrypt:queue' // not a repakxtra.* key: devStorage would copy it to the shared file

/** Opens the Mod Encryptor window, or brings it forward. */
async function openWindow() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existing = await WebviewWindow.getByLabel('encrypt')
  if (existing) { await existing.unminimize().catch(() => {}); await existing.setFocus(); return }
  const w = new WebviewWindow('encrypt', { url: '/encrypt', title: 'Mod Encryptor', width: 760, height: 820, minWidth: 600, minHeight: 560, center: true, resizable: true, decorations: false })
  w.once('tauri://error', e => console.error('[Encrypt] Failed to create window:', e))
}

/** Opens the Mod Encryptor window with these mods ticked (none: just opens it). */
export async function openEncrypt(paths: string[] = []) {
  if (paths.length) localStorage.setItem(KEY, JSON.stringify({ paths, at: Date.now() }))
  await openWindow()
}

/** Header button: opens the Mod Encryptor window (EncryptWindow.tsx). Hidden from Settings > Header buttons like the VFX Updater's. */
export default function EncryptMods() {
  return (
    <button type="button" className="btn-settings" data-tour="encrypt-btn" title="Encrypt mods so they are harder to unpack"
      onClick={() => void openEncrypt().catch(e => console.error('[Encrypt] Window error:', e))}>
      <Lock size={16} aria-hidden="true" /> Mod Encryptor
    </button>
  )
}
