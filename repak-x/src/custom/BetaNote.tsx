// repakxtra: the beta notice, on the welcome screen's first page and at the top of Settings > General.
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { APP_NAME } from './edition'
import mark from './beta-mark.png'

const INVITE = 'https://discord.gg/C7geHdWBP5' // the same server as Settings > Help & Community (CableDiscord.tsx)

export default function BetaNote({ className = '' }: { className?: string }) {
  return (
    <p className={`beta-note${className ? ` ${className}` : ''}`}>
      <span className="beta-mark" style={{ maskImage: `url(${mark})`, WebkitMaskImage: `url(${mark})` }} aria-hidden="true" />
      <span>{APP_NAME} is currently in beta, so unexpected issues may occur. Please report them if they have not been reported yet.
        You can report bugs and suggest features in <a href={INVITE} onClick={e => { e.preventDefault(); void openUrl(INVITE) }}>cable's Discord server</a>.</span>
    </p>
  )
}
