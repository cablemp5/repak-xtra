// repakxtra: opens the Galacta Converter window (GalactaWindow.tsx), from the header button and Tools.

/** Project Galacta's own mark in white (the Library's Galacta badge mask, theme.css .pg-logo), `size` px or any CSS length. */
export const GalactaLogo = ({ size = 16 }: { size?: number | string }) => <i className="pg-logo gal-logo" style={{ width: size, height: size }} aria-hidden="true" />

/** Opens the Galacta Converter window, or brings it forward. */
export async function openGalacta() {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  const existing = await WebviewWindow.getByLabel('galacta')
  if (existing) { await existing.unminimize().catch(() => {}); await existing.setFocus(); return }
  const w = new WebviewWindow('galacta', { url: '/galacta', title: 'Galacta Converter', width: 760, height: 820, minWidth: 600, minHeight: 560, center: true, resizable: true, decorations: false })
  w.once('tauri://error', e => console.error('[Galacta] Failed to create window:', e))
}

/** Header button, hidden until Settings > Header buttons shows it (like Encrypt). */
export default function GalactaMods() {
  return (
    <button type="button" className="btn-settings" data-tour="galacta-btn" title="Make mods Project Galacta compatible"
      onClick={() => void openGalacta().catch(e => console.error('[Galacta] Window error:', e))}>
      <GalactaLogo /> Galacta Converter
    </button>
  )
}
