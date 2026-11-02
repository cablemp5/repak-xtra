// repakxtra: the beta notice, on the welcome screen's first page and in Settings > Help & Community.
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { TriangleAlert } from 'lucide-react'
import { APP_NAME } from './edition'

export default function BetaNote({ className = '' }: { className?: string }) {
  return (
    <p className={`beta-note${className ? ` ${className}` : ''}`}>
      <TriangleAlert size={15} aria-hidden="true" />
      <span>{APP_NAME} is currently in beta, so unexpected issues may occur. Please report them if they have not been reported yet.
        You can report bugs and suggest features in <button type="button" className="beta-link" onClick={() => void openUrl('https://discord.gg/C7geHdWBP5')}>cable's Discord server</button>.</span>
    </p>
  )
}
